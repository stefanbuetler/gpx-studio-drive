// Refresh credentials are encrypted in a host-only, HttpOnly cookie. They are
// never returned to browser JavaScript or included in the static website build.
export interface SessionEnv {
    GOOGLE_CLIENT_ID?: string;
    GOOGLE_CLIENT_SECRET?: string;
    DRIVE_SESSION_SECRET?: string;
    DRIVE_ALLOWED_ORIGINS?: string;
}

const DEFAULT_CLIENT_ID =
    '1029721603429-0h1hv3datbk3guc18kq8ta2od0gevqi4.apps.googleusercontent.com';
const SCOPE = 'https://www.googleapis.com/auth/drive.file';
const COOKIE = 'gpx_drive_session';
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();
type Session = { refreshToken: string; expires: number; refreshExpires?: number; scope?: string };
type GoogleTokens = {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    refresh_token_expires_in?: number;
    scope?: string;
    error?: string;
};

function configured(env: SessionEnv) {
    return !!env.GOOGLE_CLIENT_SECRET && /^[a-fA-F0-9]{64}$/.test(env.DRIVE_SESSION_SECRET ?? '');
}

function clientId(env: SessionEnv) {
    return env.GOOGLE_CLIENT_ID || DEFAULT_CLIENT_ID;
}
function allowedOrigin(origin: string, env: SessionEnv) {
    return (env.DRIVE_ALLOWED_ORIGINS ?? '')
        .split(',')
        .map((s) => s.trim())
        .includes(origin);
}
function json(body: unknown, status = 200, cookie?: string) {
    const headers = new Headers({
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    if (cookie) headers.set('Set-Cookie', cookie);
    return new Response(JSON.stringify(body), { status, headers });
}
function cookieHeader(value: string, origin: string, maxAge: number) {
    return `${COOKIE}=${value}; Path=/api/drive; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${origin.startsWith('https:') ? '; Secure' : ''}`;
}
function encode(bytes: Uint8Array) {
    return btoa(String.fromCharCode(...bytes))
        .replaceAll('+', '-')
        .replaceAll('/', '_')
        .replace(/=+$/, '');
}
function decode(value: string) {
    return Uint8Array.from(atob(value.replaceAll('-', '+').replaceAll('_', '/')), (c) =>
        c.charCodeAt(0)
    );
}
async function key(env: SessionEnv) {
    const raw = Uint8Array.from(env.DRIVE_SESSION_SECRET!.match(/../g)!, (n) => parseInt(n, 16));
    return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);
}
async function seal(session: Session, origin: string, env: SessionEnv) {
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const encrypted = await crypto.subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: encoder.encode(`${origin}|${clientId(env)}`) },
        await key(env),
        encoder.encode(JSON.stringify(session))
    );
    return `${encode(iv)}.${encode(new Uint8Array(encrypted))}`;
}
async function readSession(
    request: Request,
    origin: string,
    env: SessionEnv
): Promise<Session | null> {
    try {
        const value = request.headers
            .get('Cookie')
            ?.split(';')
            .map((s) => s.trim())
            .find((s) => s.startsWith(`${COOKIE}=`))
            ?.slice(COOKIE.length + 1);
        if (!value || value.length > 3800) return null;
        const [iv, encrypted] = value.split('.');
        const data = await crypto.subtle.decrypt(
            {
                name: 'AES-GCM',
                iv: decode(iv),
                additionalData: encoder.encode(`${origin}|${clientId(env)}`),
            },
            await key(env),
            decode(encrypted)
        );
        const session = JSON.parse(new TextDecoder().decode(data)) as Session;
        if (
            typeof session.refreshToken !== 'string' ||
            !Number.isFinite(session.expires) ||
            session.expires <= Date.now() ||
            (session.refreshExpires !== undefined && session.refreshExpires <= Date.now())
        )
            return null;
        return session;
    } catch {
        return null;
    }
}
async function tokens(params: Record<string, string>, env: SessionEnv, fetcher: typeof fetch) {
    return fetcher('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
            client_id: clientId(env),
            client_secret: env.GOOGLE_CLIENT_SECRET!,
            ...params,
        }),
        signal: AbortSignal.timeout(15000),
    });
}

export async function handleDriveSession(
    request: Request,
    env: SessionEnv,
    fetcher: typeof fetch = fetch
): Promise<Response> {
    const url = new URL(request.url);
    const origin = url.origin;
    const route = url.pathname;
    if (route === '/api/drive/config' && request.method === 'GET') {
        return json({
            persistent: configured(env) && allowedOrigin(origin, env),
            clientId: clientId(env),
        });
    }
    if (!['/api/drive/connect', '/api/drive/session', '/api/drive/disconnect'].includes(route))
        return json({ error: 'Not found' }, 404);
    // Custom header + exact Origin check: cross-site forms and fetches cannot
    // exchange an attacker's code, refresh a session, or log a user out.
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    if (
        !allowedOrigin(origin, env) ||
        request.headers.get('Origin') !== origin ||
        request.headers.get('X-GPX-Drive-Request') !== '1'
    )
        return json({ error: 'Invalid request origin' }, 403);
    if (!configured(env))
        return json({ error: 'Persistent Google sign-in is not configured.' }, 503);
    const clear = cookieHeader('', origin, 0);
    try {
        const previous = await readSession(request, origin, env);
        if (route === '/api/drive/disconnect') {
            if (previous) {
                const revoked = await fetcher('https://oauth2.googleapis.com/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({ token: previous.refreshToken }),
                    signal: AbortSignal.timeout(15000),
                });
                if (!revoked.ok && revoked.status !== 400)
                    return json(
                        {
                            error: 'Disconnected in this browser. Google could not confirm revocation; you can also remove this app in your Google Account permissions.',
                        },
                        502,
                        clear
                    );
            }
            return json({ connected: false }, 200, clear);
        }
        let response: Response;
        if (route === '/api/drive/connect') {
            const raw = await request.text();
            if (raw.length > 8192) return json({ error: 'Invalid authorization request' }, 400);
            const { code } = JSON.parse(raw);
            if (typeof code !== 'string' || !code || code.length > 4096)
                return json({ error: 'Invalid authorization code' }, 400);
            response = await tokens(
                { grant_type: 'authorization_code', code, redirect_uri: origin },
                env,
                fetcher
            );
        } else {
            if (!previous) return json({ connected: false }, 401, clear);
            response = await tokens(
                { grant_type: 'refresh_token', refresh_token: previous.refreshToken },
                env,
                fetcher
            );
        }
        const result = (await response.json()) as GoogleTokens;
        if (!response.ok || !result.access_token) {
            if (result.error === 'invalid_grant')
                return json(
                    { error: 'Google authorization expired or was revoked. Sign in again.' },
                    401,
                    clear
                );
            return json({ error: 'Google sign-in could not be renewed. Please try again.' }, 502);
        }
        if (result.scope && !result.scope.split(' ').includes(SCOPE))
            return json({ error: 'GDrive permission was not granted.' }, 403, clear);
        // Do not reuse a previous account's refresh token after a new sign-in.
        const refreshToken =
            result.refresh_token ??
            (route === '/api/drive/session' ? previous?.refreshToken : undefined);
        if (!refreshToken)
            return json(
                {
                    error: 'Google did not grant persistent access. Sign in again and approve Drive access.',
                },
                409,
                clear
            );
        const grantedScope =
            result.scope ?? (route === '/api/drive/session' ? previous?.scope : undefined) ?? SCOPE;
        const now = Date.now();
        const refreshExpires = result.refresh_token_expires_in
            ? now + result.refresh_token_expires_in * 1000
            : route === '/api/drive/session'
              ? previous?.refreshExpires
              : undefined;
        const expires = Math.min(now + SESSION_SECONDS * 1000, refreshExpires ?? Infinity);
        const cookie = cookieHeader(
            await seal({ refreshToken, expires, refreshExpires, scope: grantedScope }, origin, env),
            origin,
            Math.max(0, Math.floor((expires - now) / 1000))
        );
        return json(
            {
                access_token: result.access_token,
                expires_in: result.expires_in ?? 3600,
                scope: grantedScope,
                persistent: true,
            },
            200,
            cookie
        );
    } catch {
        return json(
            { error: 'Google connection is temporarily unavailable. Please try again.' },
            502,
            route === '/api/drive/disconnect' ? clear : undefined
        );
    }
}
