import { openDriveBrowser, closeDriveBrowser } from './drive-browser';
import { test, expect } from '@playwright/test';

const cases = [
    {
        title: 'keeps a meaningful metadata title',
        metadata: 'My chosen title',
        track: 'Summit circuit',
        filename: 'route.gpx',
        expected: 'My chosen title',
    },
    {
        title: 'uses a track name when metadata is missing',
        metadata: undefined,
        track: 'Summit circuit',
        filename: 'download.gpx',
        expected: 'Summit circuit',
    },
    {
        title: 'replaces a German default with the track name',
        metadata: 'Neue Datei 1',
        track: 'TRE 56k 2026',
        filename: 'download.gpx',
        expected: 'TRE 56k 2026',
    },
    {
        title: 'uses the source filename when all internal names are defaults',
        metadata: 'New file 2',
        track: 'Neue Datei 1',
        filename: 'Ridge.walk.GPX',
        expected: 'Ridge.walk',
    },
    {
        title: 'uses a route name',
        metadata: ' ',
        track: 'Lakeside route',
        filename: 'download.gpx',
        expected: 'Lakeside route',
        route: true,
    },
    {
        title: 'finds a named track after an unnamed track',
        metadata: undefined,
        track: 'Forest loop',
        filename: 'download.gpx',
        expected: 'Forest loop',
        unnamedFirst: true,
    },
];

for (const example of cases) {
    test(example.title, async ({ page }) => {
        await page.route('**/api/drive/config', (r) => r.fulfill({ json: { persistent: true } }));
        await page.route('**/api/drive/session', (r) =>
            r.fulfill({
                json: {
                    access_token: 'test-token',
                    expires_in: 3600,
                    scope: 'https://www.googleapis.com/auth/drive.file',
                },
            })
        );
        await page.route('**/__gpx_services/styles/**', (r) =>
            r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
        );
        const points = '<trkseg><trkpt lat="47" lon="8"/><trkpt lat="47.01" lon="8.01"/></trkseg>';
        const metadata =
            example.metadata === undefined
                ? ''
                : `<metadata><name>${example.metadata}</name></metadata>`;
        const track = example.route
            ? `<rte><name>${example.track}</name><rtept lat="47" lon="8"/><rtept lat="47.01" lon="8.01"/></rte>`
            : `${example.unnamedFirst ? `<trk>${points}</trk>` : ''}<trk><name>${example.track}</name>${points}</trk>`;
        const remote = { id: 'test-route', name: example.filename };
        await page.route('https://www.googleapis.com/**', (r) => {
            const url = new URL(r.request().url());
            if (url.searchParams.get('alt') === 'media')
                return r.fulfill({
                    contentType: 'application/gpx+xml',
                    body: `<gpx version="1.1" creator="test">${metadata}${track}</gpx>`,
                });
            return r.fulfill({
                json: url.pathname.endsWith('/test-route') ? remote : { files: [remote] },
            });
        });
        await page.goto('/app');
        await expect(
            page.getByRole('button', { name: 'Plan or edit a route', exact: true })
        ).toBeVisible();
        await page.keyboard.press('Control+l');
        await openDriveBrowser(page);
        const panel = page.getByRole('region', { name: 'GDrive files' });
        await expect(panel.getByRole('status')).toHaveText('GDrive connected');
        await panel.getByRole('button', { name: example.filename, exact: true }).click();
        await expect(panel.getByRole('status')).toHaveText(`Opened ${example.filename}`);
        await expect(
            page.getByRole('button', { name: example.expected, exact: true }).first()
        ).toBeVisible();
    });
}
