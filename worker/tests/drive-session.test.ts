import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleDriveSession, type SessionEnv } from '../drive-session.ts';

const origin = 'https://preview.example.test';
const env: SessionEnv = {
    GOOGLE_CLIENT_ID: 'test-client',
    GOOGLE_CLIENT_SECRET: 'test-client-secret',
    DRIVE_SESSION_SECRET: '12'.repeat(32),
    DRIVE_ALLOWED_ORIGINS: `${origin},https://other.example.test`,
};
const scope = 'https://www.googleapis.com/auth/drive.file';
function req(path: string, cookie?: string, headers: Record<string, string> = {}) {
    return new Request(`${origin}/api/drive/${path}`, {
        method: 'POST',
        headers: {
            Origin: origin,
            'X-GPX-Drive-Request': '1',
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
        },
        body: JSON.stringify({ code: 'test-code' }),
    });
}
const issued = {
    access_token: 'initial-access',
    refresh_token: 'private-refresh-token',
    expires_in: 3600,
    scope,
};
async function connect() {
    const response = await handleDriveSession(req('connect'), env, (async (_url, init) => {
        const params = new URLSearchParams(init!.body as string);
        assert.equal(params.get('redirect_uri'), origin);
        assert.equal(params.get('client_secret'), env.GOOGLE_CLIENT_SECRET);
        assert.equal(params.get('code'), 'test-code');
        return Response.json(issued);
    }) as typeof fetch);
    assert.equal(response.status, 200);
    return response;
}

test('code exchange returns only a short-lived token and sets an encrypted HttpOnly cookie', async () => {
    const response = await connect();
    const cookie = response.headers.get('Set-Cookie')!;
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /SameSite=Lax/);
    assert.match(cookie, /Path=\/api\/drive/);
    assert.match(cookie, /Max-Age=\d+/);
    assert.ok(!cookie.includes(issued.refresh_token));
    assert.ok(!cookie.includes(issued.access_token));
    const body = await response.text();
    assert.ok(!body.includes('refresh_token'));
    assert.ok(!body.includes('test-client-secret'));
    assert.equal(response.headers.get('Cache-Control'), 'no-store');
});

test('a new browser request restores access from the encrypted cookie and rotates it', async () => {
    const first = await connect();
    const response = await handleDriveSession(
        req('session', first.headers.get('Set-Cookie')!),
        env,
        (async (_url, init) => {
            const params = new URLSearchParams(init!.body as string);
            assert.equal(params.get('grant_type'), 'refresh_token');
            assert.equal(params.get('refresh_token'), issued.refresh_token);
            return Response.json({ access_token: 'renewed-access', expires_in: 3600, scope });
        }) as typeof fetch
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as any).access_token, 'renewed-access');
    assert.notEqual(response.headers.get('Set-Cookie'), first.headers.get('Set-Cookie'));
});

test('cross-site requests and requests without the CSRF header never contact Google', async () => {
    const forbiddenFetch = (() => {
        throw new Error('Google should not be called');
    }) as typeof fetch;
    for (const headers of [{ Origin: 'https://attacker.example' }, { 'X-GPX-Drive-Request': '' }]) {
        const response = await handleDriveSession(
            req('connect', undefined, headers),
            env,
            forbiddenFetch
        );
        assert.equal(response.status, 403);
    }
});

test('tampered cookies and cookies copied to another origin cannot restore a session', async () => {
    const first = await connect();
    const cookie = first.headers.get('Set-Cookie')!;
    const tampered = cookie.replace('gpx_drive_session=', 'gpx_drive_session=x');
    const forbiddenFetch = (() => {
        throw new Error('Google should not be called');
    }) as typeof fetch;
    assert.equal(
        (await handleDriveSession(req('session', tampered), env, forbiddenFetch)).status,
        401
    );
    const other = new Request('https://other.example.test/api/drive/session', {
        method: 'POST',
        headers: {
            Origin: 'https://other.example.test',
            'X-GPX-Drive-Request': '1',
            Cookie: cookie,
        },
    });
    assert.equal((await handleDriveSession(other, env, forbiddenFetch)).status, 401);
});

test('revoked Google authorization clears the session, temporary failures preserve it', async () => {
    const first = await connect();
    const cookie = first.headers.get('Set-Cookie')!;
    const revoked = await handleDriveSession(req('session', cookie), env, (async () =>
        Response.json({ error: 'invalid_grant' }, { status: 400 })) as typeof fetch);
    assert.equal(revoked.status, 401);
    assert.match(revoked.headers.get('Set-Cookie')!, /Max-Age=0/);
    const temporary = await handleDriveSession(req('session', cookie), env, (async () =>
        Response.json({ error: 'temporarily_unavailable' }, { status: 503 })) as typeof fetch);
    assert.equal(temporary.status, 502);
    assert.equal(temporary.headers.get('Set-Cookie'), null);
});

test('disconnect revokes the refresh token and removes the browser session', async () => {
    const first = await connect();
    const response = await handleDriveSession(
        req('disconnect', first.headers.get('Set-Cookie')!),
        env,
        (async (url, init) => {
            assert.equal(url, 'https://oauth2.googleapis.com/revoke');
            assert.equal(
                new URLSearchParams(init!.body as string).get('token'),
                issued.refresh_token
            );
            return new Response(null, { status: 200 });
        }) as typeof fetch
    );
    assert.equal(response.status, 200);
    assert.match(response.headers.get('Set-Cookie')!, /Max-Age=0/);
});

test('expired sessions cannot refresh and a new account never inherits the previous refresh token', async () => {
    const first = await connect();
    const cookie = first.headers.get('Set-Cookie')!;
    const noRefresh = await handleDriveSession(req('connect', cookie), env, (async () =>
        Response.json({ access_token: 'another-account-access', scope })) as typeof fetch);
    assert.equal(noRefresh.status, 409);
    const now = Date.now;
    try {
        Date.now = () => now() + 31 * 24 * 3600 * 1000;
        const expired = await handleDriveSession(req('session', cookie), env, (() => {
            throw new Error('No Google request');
        }) as typeof fetch);
        assert.equal(expired.status, 401);
    } finally {
        Date.now = now;
    }
});

test('configuration reveals no secrets and never enables sessions on an unapproved host', async () => {
    const response = await handleDriveSession(new Request(`${origin}/api/drive/config`), env);
    assert.deepEqual(await response.json(), { persistent: true, clientId: 'test-client' });
    const disabled = await handleDriveSession(
        new Request('https://attacker.example/api/drive/config'),
        env
    );
    assert.equal(((await disabled.json()) as any).persistent, false);
});

test('whole-Drive read scope persists when refresh responses omit their scope field', async () => {
    const fullScope = `${scope} https://www.googleapis.com/auth/drive.readonly`;
    const first = await handleDriveSession(req('connect'), env, (async () =>
        Response.json({ ...issued, scope: fullScope })) as typeof fetch);
    assert.equal(first.status, 200);
    const restored = await handleDriveSession(
        req('session', first.headers.get('Set-Cookie')!),
        env,
        (async () =>
            Response.json({
                access_token: 'renewed-full-access',
                expires_in: 3600,
            })) as typeof fetch
    );
    assert.equal(restored.status, 200);
    assert.equal(((await restored.json()) as any).scope, fullScope);
});
