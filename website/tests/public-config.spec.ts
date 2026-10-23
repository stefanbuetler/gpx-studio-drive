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
