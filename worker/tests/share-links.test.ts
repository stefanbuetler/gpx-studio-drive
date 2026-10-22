import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleShareLinks, type ShareDatabase } from '../share-links.ts';
const origin = 'https://feature.example';
const client = '1029721603429-0h1hv3datbk3guc18kq8ta2od0gevqi4.apps.googleusercontent.com';
function setup(options: { aud?: string; public?: boolean } = {}) {
    const rows = new Map<string, string>();
    const db: ShareDatabase = {
        prepare(sql) {
            return {
                bind(...values) {
                    return {
                        async run() {
                            assert.match(sql, /INSERT/);
                            rows.set(String(values[0]), String(values[2]));
                        },
                        async first<T>() {
                            const route = rows.get(String(values[0]));
                            return (route ? { route } : null) as T | null;
                        },
                    };
                },
            };
        },
    };
    const fetcher: typeof fetch = async (input) =>
        String(input).includes('tokeninfo')
            ? Response.json({
                  aud: options.aud || client,
                  scope: 'https://www.googleapis.com/auth/drive.file',
              })
            : Response.json({
                  isAppAuthorized: true,
                  appProperties: { trailExplorerRoute: '1' },
                  permissions: options.public === false ? [] : [{ type: 'anyone', role: 'reader' }],
              });
    return { rows, db, fetcher };
}
function create(body: unknown, requestOrigin = origin) {
    return new Request(`${origin}/api/share`, {
        method: 'POST',
        headers: {
            Origin: requestOrigin,
            Authorization: 'Bearer test-token',
            'Content-Type': 'application/json',
            'X-GPX-Share-Request': '1',
        },
        body: JSON.stringify(body),
    });
}
const view = {
    basemap: 'swisstopoRaster',
    distanceMarkers: true,
    directionMarkers: true,
    overlays: { swisstopoHiking: true },
    elevation: { show: true },
    theme: 'dark',
};
test('short links round-trip presentation and resource keys, stripping non-presentation fields', async () => {
    const { rows, db, fetcher } = setup();
    const response = await handleShareLinks(
        create({
            id: 'public-route',
            resourceKey: 'key-1',
            view: { ...view, files: ['private'], ids: ['private'], key: 'secret' },
        }),
        { SHARE_LINKS: db },
        fetcher
    );
    assert.equal(response.status, 201);
    const { url } = (await response.json()) as { url: string };
    assert.match(url, /^https:\/\/feature.example\/s\/[a-zA-Z0-9_-]{16}$/);
    assert.equal(rows.size, 1);
    assert.ok(![...rows.values()][0].includes('secret'));
    const result = await handleShareLinks(new Request(url), { SHARE_LINKS: db });
    assert.equal(result.status, 302);
    const target = new URL(result.headers.get('Location')!);
    assert.equal(target.pathname, '/share');
    assert.equal(target.searchParams.get('id'), 'public-route');
    assert.equal(target.searchParams.get('resourcekey'), 'key-1');
    assert.deepEqual(JSON.parse(target.searchParams.get('view')!), view);
    const embedded = await handleShareLinks(new Request(url + '?embed=1'), { SHARE_LINKS: db });
    const embed = new URL(embedded.headers.get('Location')!);
    assert.equal(embed.pathname, '/embed');
    assert.equal(embed.searchParams.get('fit'), 'route');
    assert.deepEqual(JSON.parse(embed.searchParams.get('options')!), {
        ...view,
        files: [],
        ids: ['public-route'],
        resourceKeys: { 'public-route': 'key-1' },
    });
    assert.equal(
        (await handleShareLinks(new Request(url, { method: 'HEAD' }), { SHARE_LINKS: db })).status,
        302
    );
});
test('rejects untrusted origins, foreign OAuth clients and private routes without writing', async () => {
    for (const options of [{ aud: 'foreign-client' }, { public: false }, {}]) {
        const { rows, db, fetcher } = setup(options);
        const response = await handleShareLinks(
            create(
                { id: 'route', view },
                Object.keys(options).length ? origin : 'https://attacker.example'
            ),
            { SHARE_LINKS: db },
            fetcher
        );
        assert.equal(response.status, 403);
        assert.equal(rows.size, 0);
    }
});
test('rejects missing authentication, malformed IDs and oversized settings', async () => {
    const { db, fetcher, rows } = setup();
    const missing = create({ id: 'route', view });
    missing.headers.delete('Authorization');
    assert.equal((await handleShareLinks(missing, { SHARE_LINKS: db }, fetcher)).status, 401);
    for (const body of [
        { id: '../private', view },
        { id: 'route', view: { basemap: 'x'.repeat(70000) } },
    ])
        assert.equal(
            (await handleShareLinks(create(body), { SHARE_LINKS: db }, fetcher)).status,
            400
        );
    assert.equal(rows.size, 0);
});
test('unknown short codes return 404 and unavailable storage returns 503', async () => {
    const { db } = setup();
    assert.equal(
        (await handleShareLinks(new Request(origin + '/s/abcdefghijklmnop'), { SHARE_LINKS: db }))
            .status,
        404
    );
    assert.equal(
        (await handleShareLinks(new Request(origin + '/s/abcdefghijklmnop'), {})).status,
        503
    );
});
