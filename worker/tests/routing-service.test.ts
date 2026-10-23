import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleRoutingService } from '../routing-service.ts';
const req = (path: string, method = 'GET') =>
    new Request(`https://gpx.trailexplorer.net/__gpx_services/${path}`, {
        method,
        headers: {
            'Content-Type': 'application/json',
            Cookie: 'session=private',
            Authorization: 'Bearer private',
        },
        ...(method === 'POST'
            ? {
                  body: JSON.stringify({
                      points: [
                          [8.54, 47.37],
                          [8.541, 47.371],
                      ],
                      profile: 'foot',
                  }),
              }
            : {}),
    });
test('production routes and elevation use fixed upstreams without forwarding credentials', async () => {
    const original = globalThis.fetch;
    const targets: string[] = [];
    globalThis.fetch = async (url, options) => {
        targets.push(String(url));
        assert.equal(options?.redirect, 'manual');
        assert.equal(new Headers(options?.headers).get('Cookie'), null);
        assert.equal(new Headers(options?.headers).get('Authorization'), null);
        return Response.json({ paths: [] });
    };
    try {
        assert.equal((await handleRoutingService(req('graphhopper/route', 'POST'))).status, 200);
        const tile = await handleRoutingService(req('tiles/mapterhorn/12/2145/1434.webp'));
        assert.equal(tile.status, 200);
        assert.equal(tile.headers.get('Cache-Control'), 'public, max-age=86400');
        assert.deepEqual(targets, [
            'https://graphhopper.gpx.studio/route',
            'https://tiles.gpx.studio/mapterhorn/12/2145/1434.webp',
        ]);
        assert.equal((await handleRoutingService(req('graphhopper/admin', 'POST'))).status, 404);
        assert.equal(
            (await handleRoutingService(req('tiles/mapterhorn/12/99999/1.webp'))).status,
            400
        );
        assert.equal((await handleRoutingService(req('graphhopper/route'))).status, 405);
        assert.equal(targets.length, 2);
    } finally {
        globalThis.fetch = original;
    }
});
test('upstream failures produce a readable routing error, and preserve valid route errors', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => {
            throw new TypeError('fetch failed');
        };
        const failed = await handleRoutingService(req('graphhopper/route', 'POST'));
        assert.equal(failed.status, 502);
        assert.match((await failed.json()).message, /could not be reached/);
        globalThis.fetch = async () =>
            Response.json({ message: 'Cannot find point 0' }, { status: 400 });
        const response = await handleRoutingService(req('graphhopper/route', 'POST'));
        assert.equal(response.status, 400);
        assert.equal((await response.json()).message, 'Cannot find point 0');
    } finally {
        globalThis.fetch = original;
    }
});

test('redirect responses are rejected without forwarding users to another host', async () => {
    const original = globalThis.fetch;
    try {
        globalThis.fetch = async () => new Response(null, { status: 302, headers: { Location: 'https://other.example.test' } });
        const response = await handleRoutingService(req('graphhopper/route', 'POST'));
        assert.equal(response.status, 502);
        assert.equal(response.headers.get('Location'), null);
    } finally { globalThis.fetch = original; }
});
