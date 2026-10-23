import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('**/api/pois?**', (r) => r.fulfill({ json: { elements: [] } }));
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
});

test('Water includes drinking fountains and taps, and uses the same-origin API', async ({
    page,
}) => {
    let query = '';
    await page.route('**/api/pois?**', (r) => {
        query = new URL(r.request().url()).searchParams.get('data')!;
        return r.fulfill({
            json: {
                elements: [
                    {
                        type: 'node',
                        id: 90001,
                        lon: 8.53,
                        lat: 47.37,
                        tags: { amenity: 'drinking_water' },
                    },
                    {
                        type: 'node',
                        id: 90002,
                        lon: 8.54,
                        lat: 47.37,
                        tags: { amenity: 'fountain', drinking_water: 'yes' },
                    },
                    {
                        type: 'node',
                        id: 90003,
                        lon: 8.55,
                        lat: 47.37,
                        tags: { natural: 'spring', drinking_water: 'no' },
                    },
                ],
            },
        });
    });
    const result = await page.evaluate(async () => {
        const path = '/src/lib/components/map/layer-control/overpass-layer.ts';
        const { OverpassLayer } = await import(/* @vite-ignore */ path);
        const dbPath = '/src/lib/db.ts';
        const { db } = await import(/* @vite-ignore */ dbPath);
        const layer = new OverpassLayer({ getZoom: () => 8 } as any, {} as any);
        let status: any;
        layer.status.subscribe((value: any) => (status = value));
        layer.queryIfNeeded();
        const zoomRequired = status.zoomRequired;
        await layer.queryTile(2145, 1434, ['water']);
        const points = await db.overpassdata
            .where('query')
            .equals('water')
            .toArray()
            .catch(() => db.overpassdata.toArray());
        return {
            zoomRequired,
            points: points.filter((p: any) => p.id >= 90001).map((p: any) => p.id),
            error: status.error,
        };
    });
    expect(result).toEqual({ zoomRequired: true, points: [90001, 90002], error: '' });
    expect(query).toContain('nwr[drinking_water=yes]');
});

test('Incomplete responses show an error without caching an empty tile; retry works', async ({
    page,
}) => {
    let fail = true;
    await page.route('**/api/pois?**', (r) =>
        r.fulfill({
            json: fail ? { elements: [], remark: 'runtime error: timeout' } : { elements: [] },
        })
    );
    const attempt = () =>
        page.evaluate(async () => {
            const path = '/src/lib/components/map/layer-control/overpass-layer.ts';
            const { OverpassLayer } = await import(/* @vite-ignore */ path);
            const dbPath = '/src/lib/db.ts';
            const { db } = await import(/* @vite-ignore */ dbPath);
            const layer = new OverpassLayer({ getZoom: () => 13 } as any, {} as any);
            let status: any;
            layer.status.subscribe((value: any) => (status = value));
            await layer.queryTile(3000, 1000, ['water']);
            return {
                error: status.error,
                cached: !!(await db.overpasstiles.get(['water-v2', 3000, 1000])),
                active: layer.currentQueries.size,
            };
        });
    expect(await attempt()).toEqual({
        error: 'Could not load points of interest. Please try again.',
        cached: false,
        active: 0,
    });
    fail = false;
    expect(await attempt()).toEqual({ error: '', cached: true, active: 0 });
});

test('All queued tiles load with at most two simultaneous requests', async ({ page }) => {
    let active = 0,
        maximum = 0,
        requests = 0;
    await page.route('**/api/pois?**', async (r) => {
        requests++;
        active++;
        maximum = Math.max(maximum, active);
        await new Promise((resolve) => setTimeout(resolve, 50));
        active--;
        await r.fulfill({ json: { elements: [] } });
    });
    await page.evaluate(async () => {
        const path = '/src/lib/components/map/layer-control/overpass-layer.ts';
        const { OverpassLayer } = await import(/* @vite-ignore */ path);
        const layer = new OverpassLayer({ getZoom: () => 13 } as any, {} as any);
        for (let x = 3000; x < 3008; x++)
            layer.nextQueries.set(`${x},1000`, { x, y: 1000, queries: ['water'] });
        layer.drainQueue();
        await new Promise<void>((resolve) => {
            const stop = layer.status.subscribe((s: any) => {
                if (!s.loading) {
                    queueMicrotask(() => {
                        stop();
                        resolve();
                    });
                }
            });
        });
    });
    expect(requests).toBe(8);
    expect(maximum).toBeLessThanOrEqual(2);
});
