import { test, expect, type Page } from '@playwright/test';

// Give the WebGL camera test its own deterministic software renderer.
test.use({ launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] } });

async function camera(page: Page) {
    return page.evaluate(() => {
        // Use the actual map's documented extension entry point. Importing app
        // stores directly can create a second module instance after Vite HMR.
        const value = (window as any)._map;
        return {
            ready: !!value,
            lat: value?.getCenter().lat ?? NaN,
            all:
                !!value &&
                value.getBounds().contains([10, 10]) &&
                value.getBounds().contains([40.01, 40.01]),
        };
    });
}

test('clicking local files centers their tracks, clicking again recenters, and no selection shows all tracks', async ({
    page,
}) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.route('**/api/drive/config', (r) => r.fulfill({ json: { persistent: false } }));
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    await page.evaluate(async () => {
        const actionsPath = '/src/lib/logic/file-actions.ts';
        const { fileActions, loadFile } = await import(/* @vite-ignore */ actionsPath);
        const files = await Promise.all(
            [10, 40].map((coord) =>
                loadFile(
                    new File(
                        [
                            `<gpx version="1.1" creator="test"><metadata><name>Route ${coord}</name></metadata><trk><trkseg><trkpt lat="${coord}" lon="${coord}"/><trkpt lat="${coord + 0.01}" lon="${coord + 0.01}"/></trkseg></trk></gpx>`,
                        ],
                        `route-${coord}.gpx`
                    )
                )
            )
        );
        fileActions.addMultiple(files.filter(Boolean));
    });
    await expect.poll(async () => (await camera(page)).ready, { timeout: 15000 }).toBe(true);
    await page.keyboard.press('Control+l');
    await page.getByRole('button', { name: 'Route 10', exact: true }).last().click();
    await expect.poll(async () => (await camera(page)).lat).toBeCloseTo(10.005, 2);
    await page.getByRole('button', { name: 'Route 40', exact: true }).last().click();
    await expect.poll(async () => (await camera(page)).lat).toBeCloseTo(40.005, 2);
    await page.evaluate(() => (window as any)._map.jumpTo({ center: [0, 0], zoom: 5 }));
    await page.getByRole('button', { name: 'Route 40', exact: true }).last().click();
    await expect.poll(async () => (await camera(page)).lat).toBeCloseTo(40.005, 2);
    const modifier = await page.evaluate(() =>
        navigator.platform.includes('Mac') ? 'Meta' : 'Control'
    );
    await page
        .getByRole('button', { name: 'Route 40', exact: true })
        .last()
        .click({ modifiers: [modifier as 'Meta' | 'Control'] });
    await expect.poll(async () => (await camera(page)).all).toBe(true);
    expect(errors).toEqual([]);
});
