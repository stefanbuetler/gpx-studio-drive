import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handlePOIs } from '../pois.ts';
const query =
    '[timeout:20][bbox:47.37,8.53,47.38,8.55][out:json];(nwr[amenity=drinking_water];);out center;';
const request = (data = query) =>
    new Request(`https://example.test/api/pois?${new URLSearchParams({ data })}`, {
        headers: { Cookie: 'private=secret', Authorization: 'Bearer private' },
    });
test('POI proxy is read-only, fixed to the upstream, and never forwards credentials', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = async (url, options) => {
        assert.equal(new URL(String(url)).origin, 'https://overpass.gpx.studio');
        assert.equal(new URL(String(url)).searchParams.get('data'), query);
        assert.equal(options?.redirect, 'manual');
        assert.equal(new Headers(options?.headers).get('Cookie'), null);
        assert.equal(new Headers(options?.headers).get('Authorization'), null);
        return Response.json({ elements: [{ id: 1 }] });
    };
    try {
        const response = await handlePOIs(request());
        assert.equal(response.status, 200);
        assert.deepEqual(await response.json(), { elements: [{ id: 1 }] });
        assert.equal((await handlePOIs(request(query.replace('nwr', 'delete')))).status, 400);
        assert.equal(
            (await handlePOIs(new Request('https://example.test/api/pois', { method: 'POST' })))
                .status,
            405
        );
    } finally {
        globalThis.fetch = original;
    }
});
test('Partial and failed upstream responses cannot be cached as empty results', async () => {
    const original = globalThis.fetch;
    try {
        for (const result of [
            Response.json({ elements: [], remark: 'timeout' }),
            new Response('Unavailable', { status: 503 }),
        ]) {
            globalThis.fetch = async () => result;
            const response = await handlePOIs(request());
            assert.equal(response.status, 502);
            assert.equal(response.headers.get('Cache-Control'), null);
        }
    } finally {
        globalThis.fetch = original;
    }
});
