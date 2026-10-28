import { test, expect } from '@playwright/test';
test('sharing and viewers use deployed public config independently of build-time keys', async ({
    page,
}) => {
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    let requests = 0;
    await page.route('**/api/drive/public-config', (r) => {
        requests++;
        return r.fulfill({ json: { publicApiKey: 'runtime-public-test-key' } });
    });
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    const key = await page.evaluate(async () => {
        const path = '/src/lib/drive/public.ts';
        const api = await import(/* @vite-ignore */ path);
        await Promise.all([
            api.ensurePublicDriveConfiguration(),
            api.ensurePublicDriveConfiguration(),
        ]);
        return new URL(api.publicDriveURL('public-test-route')).searchParams.get('key');
    });
    expect(key).toBe('runtime-public-test-key');
    expect(requests).toBe(1);
});

test('opening a shared route in the full editor waits for runtime public configuration', async ({
    page,
}) => {
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    let configReady = false;
    let downloaded = false;
    await page.route('**/api/drive/public-config', async (r) => {
        await new Promise((resolve) => setTimeout(resolve, 150));
        configReady = true;
        return r.fulfill({ json: { publicApiKey: 'runtime-editor-test-key' } });
    });
    await page.route('https://www.googleapis.com/drive/v3/files/shared-editor-test?**', (r) => {
        expect(configReady).toBe(true);
        const request = r.request();
        expect(new URL(request.url()).searchParams.get('key')).toBe('runtime-editor-test-key');
        expect(request.headers().authorization).toBeUndefined();
        expect(request.headers()['x-goog-drive-resource-keys']).toBe(
            'shared-editor-test/resource-key'
        );
        downloaded = true;
        return r.fulfill({
            contentType: 'application/gpx+xml',
            body: '<gpx version="1.1" creator="test"><metadata><name>Shared editor regression</name></metadata><trk><trkseg><trkpt lat="47" lon="8"><ele>500</ele></trkpt><trkpt lat="47.01" lon="8.01"><ele>600</ele></trkpt></trkseg></trk></gpx>',
        });
    });
    const query = new URLSearchParams({
        ids: JSON.stringify(['shared-editor-test']),
        resourceKeys: JSON.stringify({ 'shared-editor-test': 'resource-key' }),
    });
    await page.goto(`/app?${query}`);
    await expect.poll(() => downloaded).toBe(true);
    await expect(page.getByText('Shared editor regression', { exact: true })).toBeVisible();
    await expect(
        page.getByText('Public sharing is temporarily unavailable. Please try again later.', {
            exact: true,
        })
    ).toHaveCount(0);
});
