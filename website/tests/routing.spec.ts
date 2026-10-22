import { test, expect } from '@playwright/test';

test.beforeEach(async ({ page }) => {
    await page.route('**/__gpx_services/styles/**', (route) =>
        route.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
});

test('localhost uses fixed service URLs without proxying unrelated hosts', async ({ page }) => {
    const urls = await page.evaluate(async () => {
        const modulePath = '/src/lib/service-url.ts';
        const { serviceURL } = await import(/* @vite-ignore */ modulePath);
        return [
            serviceURL('https://graphhopper.gpx.studio/route'),
            serviceURL('https://tiles.gpx.studio/mapterhorn/12/1/2.webp'),
            serviceURL('https://styles.gpx.studio/liberty-topo.json'),
            serviceURL('https://www.googleapis.com/drive/v3/files'),
            serviceURL('https://graphhopper.gpx.studio.example.com/route'),
        ];
    });
    expect(urls).toEqual([
        'http://localhost:5173/__gpx_services/graphhopper/route',
        'http://localhost:5173/__gpx_services/tiles/mapterhorn/12/1/2.webp',
        'http://localhost:5173/__gpx_services/styles/liberty-topo.json',
        'https://www.googleapis.com/drive/v3/files',
        'https://graphhopper.gpx.studio.example.com/route',
    ]);
});

test('route edits use the same-origin service and retain routed geometry and elevation', async ({
    page,
}) => {
    let requestBody: Record<string, unknown> | undefined;
    await page.route('**/__gpx_services/graphhopper/route', async (route) => {
        requestBody = route.request().postDataJSON();
        await route.fulfill({
            json: {
                paths: [
                    {
                        points: {
                            coordinates: [
                                [8.54, 47.37, 405],
                                [8.5405, 47.3705, 408],
                                [8.541, 47.371, 410],
                            ],
                        },
                        details: {
                            road_class: [[0, 2, 'path']],
                            surface: [],
                            hike_rating: [],
                            mtb_rating: [],
                        },
                    },
                ],
            },
        });
    });
    const result = await page.evaluate(async () => {
        const modulePath = '/src/lib/components/toolbar/tools/routing/routing.ts';
        const { route } = await import(/* @vite-ignore */ modulePath);
        const points = await route([
            { lon: 8.54, lat: 47.37 },
            { lon: 8.541, lat: 47.371 },
        ]);
        return points.map(
            (point: { getCoordinates(): { lon: number; lat: number }; ele: number }) => ({
                ...point.getCoordinates(),
                ele: point.ele,
            })
        );
    });
    expect(requestBody).toMatchObject({
        points: [
            [8.54, 47.37],
            [8.541, 47.371],
        ],
        profile: 'bike',
        elevation: true,
    });
    expect(result).toEqual([
        { lon: 8.54, lat: 47.37, ele: 405 },
        { lon: 8.5405, lat: 47.3705, ele: 408 },
        { lon: 8.541, lat: 47.371, ele: 410 },
    ]);
});

test('drawing a route in the editor requests routed points through localhost', async ({ page }) => {
    let routed = false;
    await page.route('**/__gpx_services/graphhopper/route', async (intercepted) => {
        const body = intercepted.request().postDataJSON();
        routed = true;
        await intercepted.fulfill({
            json: {
                paths: [
                    {
                        points: {
                            coordinates: body.points.map((point: number[]) => [...point, 400]),
                        },
                        details: { road_class: [], surface: [], hike_rating: [], mtb_rating: [] },
                    },
                ],
            },
        });
    });
    await page.getByRole('button', { name: 'Plan or edit a route', exact: true }).click();
    const canvas = page.locator('canvas.maplibregl-canvas');
    await canvas.click({ position: { x: 500, y: 300 } });
    await canvas.click({ position: { x: 650, y: 300 } });
    await expect.poll(() => routed).toBe(true);
    await expect(page.getByRole('button', { name: 'Distance', exact: true })).not.toContainText(
        '0.00 km'
    );
    await expect(page.getByText('Failed to fetch', { exact: true })).toHaveCount(0);
});
