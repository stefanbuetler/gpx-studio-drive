import { openDriveBrowser, closeDriveBrowser } from './drive-browser';
import { test, expect, type Page } from '@playwright/test';

// Keep the session-only regression cases independent of local server secrets.
test.beforeEach(async ({ page }) => {
    await page.route('**/api/drive/config', (route) =>
        route.fulfill({ json: { persistent: false } })
    );
});

const xml =
    '<?xml version="1.0"?><gpx version="1.1" creator="test" xmlns="http://www.topografix.com/GPX/1/1"><metadata><name>Shared alpine route</name></metadata><trk><trkseg><trkpt lat="47" lon="8"><ele>500</ele></trkpt><trkpt lat="47.01" lon="8.01"><ele>600</ele></trkpt></trkseg></trk></gpx>';
const file = {
    id: 'share-test',
    name: 'Shared alpine route.gpx',
    parents: ['gpx-folder'],
    appProperties: { trailExplorerRoute: '1' },
    isAppAuthorized: true,
    modifiedTime: '2026-10-21T10:00:00Z',
    resourceKey: 'resource-key',
};

async function mockPublic(page: Page, status = 200) {
    const anonymous: { authorization?: string; resourceKey?: string }[] = [];
    await page.route('**/__gpx_services/styles/**', (route) =>
        route.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('https://www.googleapis.com/drive/v3/files/share-test?**', async (route) => {
        const request = route.request();
        if (new URL(request.url()).searchParams.get('alt') !== 'media')
            return route.fulfill({ json: file });
        if (!request.headers().authorization)
            anonymous.push({
                authorization: request.headers().authorization,
                resourceKey: request.headers()['x-goog-drive-resource-keys'],
            });
        await route.fulfill({
            status,
            contentType: 'application/gpx+xml',
            body: status === 200 ? xml : '{}',
        });
    });
    return anonymous;
}

async function owner(page: Page, publicAlready = false, permissionStatus = 200) {
    const permissions: unknown[] = [];
    const shortRequests: {
        id: string;
        resourceKey?: string;
        view: Record<string, unknown>;
        preview?: { title: string; description: string; image: string };
    }[] = [];
    await page.route('**/api/share', async (route) => {
        if (route.request().method() === 'POST') shortRequests.push(route.request().postDataJSON());
        await route.fulfill({
            json: { url: new URL('/s/abcdefghijklmnop', route.request().url()).href },
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-GPX-Share-Request',
                'Access-Control-Allow-Methods': 'POST',
            },
        });
    });
    await page.route('**/s/abcdefghijklmnop/image.jpg', (route) =>
        route.fulfill({
            contentType: 'image/jpeg',
            body: Buffer.from(shortRequests[0]?.preview?.image.split(',')[1] || '', 'base64'),
        })
    );
    const reads = await mockPublic(page);
    await page.route('https://accounts.google.com/gsi/client', (route) =>
        route.fulfill({
            contentType: 'application/javascript',
            body: `window.google = { accounts: { oauth2: { initTokenClient(options) { return { requestAccessToken() { options.callback({ access_token: 'owner-token', expires_in: 3600 }); } }; }, revoke(token, done) { done(); } } } };`,
        })
    );
    await page.route('https://www.googleapis.com/drive/v3/files?**', (route) =>
        route.fulfill({
            json: {
                files: new URL(route.request().url()).searchParams
                    .get('q')
                    ?.includes('trailExplorerFolder')
                    ? [
                          {
                              id: 'gpx-folder',
                              name: 'GPX Files',
                              isAppAuthorized: true,
                              appProperties: { trailExplorerFolder: '1' },
                              capabilities: { canAddChildren: true },
                          },
                      ]
                    : [file],
            },
        })
    );
    await page.route(
        'https://www.googleapis.com/drive/v3/files/share-test/permissions?**',
        (route) => {
            expect(route.request().headers().authorization).toBe('Bearer owner-token');
            if (route.request().method() === 'POST') {
                permissions.push(route.request().postDataJSON());
                return route.fulfill({ status: permissionStatus, json: { id: 'anyoneWithLink' } });
            }
            return route.fulfill({
                json: { permissions: publicAlready ? [{ type: 'anyone', role: 'reader' }] : [] },
            });
        }
    );
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+l');
    await openDriveBrowser(page);
    const panel = page.getByRole('region', { name: 'GDrive files' });
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    await panel.getByRole('button', { name: file.name, exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(`Opened ${file.name}`);
    await closeDriveBrowser(page);
    await page
        .getByRole('button', { name: 'Shared alpine route', exact: true })
        .last()
        .click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Share route', exact: true }).click();
    return {
        dialog: page.getByRole('dialog', { name: 'Share route' }),
        permissions,
        reads,
        shortRequests,
    };
}

test('sharing requires confirmation and produces a public viewer URL without tokens or API keys', async ({
    page,
}) => {
    const { dialog, permissions, reads, shortRequests } = await owner(page);
    await expect(dialog).toContainText('Anyone with this link');
    expect(permissions).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Make public and create link' }).click();
    const input = dialog.getByRole('textbox', { name: 'Public route link' });
    await expect(input).toBeVisible({ timeout: 25000 });
    const url = new URL(await input.inputValue());
    expect(url.protocol).toBe('https:');
    expect(url.hostname).not.toBe('localhost');
    expect(url.pathname).toBe('/s/abcdefghijklmnop');
    expect(url.search).toBe('');
    expect(url.searchParams.has('key')).toBe(false);
    expect(url.href).not.toContain('owner-token');
    const preview = shortRequests[0].preview!;
    await (
        await import('node:fs/promises')
    ).writeFile(
        test.info().outputPath('route-preview.jpg'),
        Buffer.from(preview.image.split(',')[1], 'base64')
    );
    expect(preview.title).toBe('Shared alpine route');
    expect(preview.image).toMatch(/^data:image\/jpeg;base64,/);
    const image = dialog.getByRole('img', { name: 'Preview map of Shared alpine route.gpx' });
    await expect(image).toBeVisible();
    await test.info().attach('route-preview', {
        body: Buffer.from(preview.image.split(',')[1], 'base64'),
        contentType: 'image/jpeg',
    });

    expect(permissions).toEqual([{ type: 'anyone', role: 'reader', allowFileDiscovery: false }]);
    expect(reads).toEqual([{ authorization: undefined, resourceKey: 'share-test/resource-key' }]);
});

test('cancelling sharing makes no permission change', async ({ page }) => {
    const { dialog, permissions } = await owner(page);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog).not.toBeVisible();
    expect(permissions).toHaveLength(0);
});

test('reuses existing public viewer permission', async ({ page }) => {
    const { dialog, permissions } = await owner(page, true);
    await dialog.getByRole('button', { name: 'Make public and create link' }).click();
    await expect(dialog.getByRole('textbox', { name: 'Public route link' })).toBeVisible();
    expect(permissions).toHaveLength(0);
});

test('permission failure is visible and produces no misleading link', async ({ page }) => {
    const { dialog } = await owner(page, false, 403);
    await dialog.getByRole('button', { name: 'Make public and create link' }).click();
    await expect(dialog.getByRole('alert')).toContainText('403');
    await expect(dialog.getByRole('textbox', { name: 'Public route link' })).toHaveCount(0);
});

test('signed-out recipient loads the track without an OAuth token or sign-in', async ({ page }) => {
    const reads = await mockPublic(page);
    const oauth: string[] = [];
    page.on('request', (request) => {
        if (request.url().startsWith('https://accounts.google.com')) oauth.push(request.url());
    });
    await page.goto('/share?id=share-test&resourcekey=resource-key');
    await expect(page).toHaveTitle('Shared route — GPX Studio Drive');
    await expect(page.getByRole('button', { name: 'Distance', exact: true })).not.toContainText(
        '0.00 km'
    );
    await expect(page.getByRole('button', { name: 'Sign in with Google' })).toHaveCount(0);
    expect(oauth).toHaveLength(0);
    expect(reads).toEqual([{ authorization: undefined, resourceKey: 'share-test/resource-key' }]);
    await expect(page.getByRole('link', { name: /Open in/ })).toHaveAttribute(
        'href',
        /resourceKeys=/
    );
});

test('revoked or unavailable public route shows an understandable error', async ({ page }) => {
    await mockPublic(page, 403);
    await page.goto('/share?id=share-test');
    await expect(page.getByRole('alert')).toContainText('not publicly available');
});

test('invalid share link is rejected before fetching Drive', async ({ page }) => {
    const reads = await mockPublic(page);
    await page.goto('/share');
    await expect(page.getByRole('alert')).toContainText('incomplete or invalid');
    expect(reads).toHaveLength(0);
});

test('share link and embed code snapshot the current editor presentation', async ({ page }) => {
    const { dialog, shortRequests } = await owner(page, true);
    await page.evaluate(async () => {
        const path = '/src/lib/logic/settings.ts';
        const { settings } = await import(/* @vite-ignore */ path);
        settings.currentBasemap.set('libertySatellite');
        settings.currentOverlays.set({ waymarkedTrailsHiking: true });
        settings.opacities.set({ waymarkedTrailsHiking: 0.35 });
        settings.distanceMarkers.set(true);
        settings.directionMarkers.set(true);
        settings.distanceUnits.set('imperial');
        settings.velocityUnits.set('pace');
        settings.temperatureUnits.set('fahrenheit');
        settings.elevationFill.set('slope');
        settings.additionalDatasets.set(['speed', 'atemp']);
        settings.bottomPanelSize.set(220);
        await new Promise<void>((resolve) => {
            const unsubscribe = settings.distanceUnits.subscribe((value: string) => {
                if (value === 'imperial')
                    queueMicrotask(() => {
                        unsubscribe();
                        resolve();
                    });
            });
        });
    });
    await dialog.getByRole('button', { name: 'Make public and create link' }).click();
    const input = dialog.getByRole('textbox', { name: 'Public route link' });
    await expect(input).toBeVisible({ timeout: 25000 });
    const url = new URL(await input.inputValue());
    const view = shortRequests[0].view;
    expect(view).toMatchObject({
        basemap: 'libertySatellite',
        overlays: { waymarkedTrailsHiking: true },
        opacities: { waymarkedTrailsHiking: 0.35 },
        distanceMarkers: true,
        directionMarkers: true,
        distanceUnits: 'imperial',
        velocityUnits: 'pace',
        temperatureUnits: 'fahrenheit',
        elevation: { height: 220, fill: 'slope', speed: true, temp: true },
    });
    const code = await dialog.getByRole('textbox', { name: 'Embed code' }).inputValue();
    expect(code).toContain('<iframe');
    expect(code).toContain('width="100%"');
    const embedURL = new URL(code.match(/src="([^"]+)"/)![1].replaceAll('&amp;', '&'));
    expect(embedURL.pathname).toBe('/s/abcdefghijklmnop');
    expect(embedURL.searchParams.get('embed')).toBe('1');
    expect(embedURL.hash).toBe('');
    expect(url.hash).toBe('');
    expect(shortRequests[0]).toMatchObject({ id: 'share-test', resourceKey: 'resource-key', view });
    expect(code).not.toContain('owner-token');
});

for (const format of ['share', 'iframe'] as const) {
    test(`${format} restores overlays, markers, units and centers the route in a fresh viewer`, async ({
        page,
    }) => {
        await mockPublic(page);
        await page.route('https://tile.waymarkedtrails.org/**', (route) => route.abort());
        const view = {
            basemap: 'libertySatellite',
            overlays: { waymarkedTrailsHiking: true },
            opacities: { waymarkedTrailsHiking: 0.35 },
            distanceMarkers: true,
            directionMarkers: true,
            distanceUnits: 'imperial',
            velocityUnits: 'pace',
            temperatureUnits: 'fahrenheit',
            elevation: { fill: 'slope', height: 210 },
            defaultWidth: 7,
            defaultOpacity: 0.6,
            pitch: 20,
            bearing: 15,
            theme: 'light',
        };
        const params = new URLSearchParams(
            format === 'share'
                ? { id: 'share-test', view: JSON.stringify(view) }
                : { options: JSON.stringify({ ...view, ids: ['share-test'] }), fit: 'route' }
        );
        const target = `/${format === 'share' ? 'share' : 'embed'}?${params}`;
        let frame = page.mainFrame();
        if (format === 'iframe') {
            await page.route('http://localhost:5173/iframe-test', (route) =>
                route.fulfill({
                    contentType: 'text/html',
                    body: `<iframe title="Route" src="${target.replaceAll('&', '&amp;')}" width="420" height="500"></iframe>`,
                })
            );
            await page.goto('/iframe-test');
            await expect(
                page.frameLocator('iframe').getByRole('button', { name: 'Distance', exact: true })
            ).toContainText('mi');
            frame = page.frames().find((f) => f !== page.mainFrame())!;
        } else {
            await page.goto(target);
            await expect(page.getByRole('button', { name: 'Distance', exact: true })).toContainText(
                'mi'
            );
        }
        await expect
            .poll(() =>
                frame.evaluate(() => {
                    const map = (window as any)._map;
                    if (!map) return false;
                    return (
                        map.getBounds().contains([8, 47]) && map.getBounds().contains([8.01, 47.01])
                    );
                })
            )
            .toBe(true);
        await expect
            .poll(() =>
                frame.evaluate(() => {
                    const map = (window as any)._map;
                    return map?.getLayer('waymarkedTrailsHiking')
                        ? map.getPaintProperty('waymarkedTrailsHiking', 'raster-opacity')
                        : undefined;
                })
            )
            .toBe(0.35);
        const rendered = await frame.evaluate(async () => {
            const path = '/src/lib/logic/settings.ts';
            const { settings } = await import(/* @vite-ignore */ path);
            const utilPath = '/src/lib/components/map/layer-control/utils.ts';
            const { getLayers } = await import(/* @vite-ignore */ utilPath);
            const read = (store: any) => {
                let value;
                store.subscribe((v: any) => (value = v))();
                return value;
            };
            const map = (window as any)._map;
            return {
                basemap: read(settings.currentBasemap),
                overlays: Object.fromEntries(
                    Object.entries(getLayers(read(settings.currentOverlays))).filter(([, on]) => on)
                ),
                opacity: read(settings.opacities),
                distance: read(settings.distanceMarkers),
                direction: read(settings.directionMarkers),
                velocity: read(settings.velocityUnits),
                temperature: read(settings.temperatureUnits),
                width: read(settings.defaultWidth),
                pitch: map.getPitch(),
                bearing: map.getBearing(),
                directionLayer: !!map.getLayer('gpx-0-embed-direction'),
            };
        });
        expect(rendered).toMatchObject({
            basemap: view.basemap,
            overlays: view.overlays,
            opacity: view.opacities,
            distance: true,
            direction: true,
            velocity: 'pace',
            temperature: 'fahrenheit',
            width: 7,
            pitch: 20,
            bearing: 15,
            directionLayer: true,
        });
        await expect(frame.getByText('The app cannot be embedded in an iframe.')).toHaveCount(0);
    });
}

test('Google sign-in fits the narrow Drive modal without overflowing', async ({ page }) => {
    await mockPublic(page);
    await page.setViewportSize({ width: 754, height: 853 });
    await page.goto('/app');
    await page.getByRole('button', { name: 'Plan or edit a route', exact: true }).waitFor();
    await page.keyboard.press('Control+l');
    await openDriveBrowser(page);
    const panel = page.getByRole('region', { name: 'GDrive files' });
    const button = panel.getByRole('button', { name: 'Sign in with Google' });
    await expect(button).toBeVisible();
    const bounds = await button.boundingBox();
    const panelBounds = await panel.boundingBox();
    expect(bounds!.x).toBeGreaterThanOrEqual(panelBounds!.x);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(panelBounds!.x + panelBounds!.width);
    await expect(panel).toContainText('Connects Drive in one step');
});
