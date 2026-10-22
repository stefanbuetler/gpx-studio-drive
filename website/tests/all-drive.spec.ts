import { openDriveBrowser, closeDriveBrowser } from './drive-browser';
import { test, expect, type Page } from '@playwright/test';
const appScope = 'https://www.googleapis.com/auth/drive.file';
const allScope = `${appScope} https://www.googleapis.com/auth/drive.readonly`;
const appFile = { id: 'app-file', name: 'App route.gpx', isAppAuthorized: true };
const external = {
    id: 'old-route',
    name: 'Archive hike.gPx',
    mimeType: 'application/xml',
    resourceKey: 'resource-key',
    isAppAuthorized: false,
    capabilities: { canEdit: true, canShare: true },
};
const shared = { id: 'shared-route', name: 'Team route.GPX', isAppAuthorized: false };
const mimeOnly = {
    id: 'mime-only',
    name: 'Route without extension',
    mimeType: 'application/gpx+xml',
    isAppAuthorized: false,
};
const xml =
    '<?xml version="1.0"?><gpx version="1.1" creator="test"><metadata><name>External route</name></metadata><trk><trkseg><trkpt lat="47" lon="8"/><trkpt lat="47.01" lon="8.01"/></trkseg></trk></gpx>';

async function setup(page: Page, grant = true, incomplete = false) {
    let full = false;
    const calls = { userPages: 0, sharedPages: 0, drivePages: 0, writes: 0, downloads: 0 };
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('https://accounts.google.com/gsi/client', (r) =>
        r.fulfill({
            contentType: 'application/javascript',
            body: `window.google={accounts:{oauth2:{initCodeClient(o){window.requestedDriveScope=o.scope;return{requestCode(){o.callback({code:'upgrade-code'})}}}}}};`,
        })
    );
    await page.route('**/api/drive/**', (r) => {
        const path = new URL(r.request().url()).pathname;
        if (path.endsWith('/config')) return r.fulfill({ json: { persistent: true } });
        if (path.endsWith('/connect')) {
            expect(r.request().postDataJSON()).toEqual({ code: 'upgrade-code' });
            full = grant;
        }
        return r.fulfill({
            json: {
                access_token: 'read-token',
                expires_in: 3600,
                scope: full ? allScope : appScope,
            },
        });
    });
    await page.route('https://www.googleapis.com/**', (r) => {
        expect(r.request().headers().authorization).toBe('Bearer read-token');
        if (r.request().method() !== 'GET') {
            calls.writes++;
            return r.fulfill({ status: 403, json: {} });
        }
        const url = new URL(r.request().url());
        if (url.pathname.endsWith('/about'))
            return r.fulfill({
                json: {
                    user: {
                        permissionId: 'test-account',
                        displayName: 'Trail Walker',
                        emailAddress: 'walker@example.test',
                    },
                },
            });
        if (url.pathname === '/drive/v3/drives') {
            calls.drivePages++;
            return r.fulfill({
                json: url.searchParams.has('pageToken')
                    ? { drives: [{ id: 'team-b' }] }
                    : { drives: [{ id: 'team-a' }], nextPageToken: 'drives-2' },
            });
        }
        if (url.pathname.endsWith('/old-route')) {
            expect(r.request().headers()['x-goog-drive-resource-keys']).toBe(
                'old-route/resource-key'
            );
            if (url.searchParams.get('alt') === 'media') {
                calls.downloads++;
                return r.fulfill({ contentType: 'application/gpx+xml', body: xml });
            }
            return r.fulfill({ json: external });
        }
        expect(url.searchParams.get('supportsAllDrives')).toBe('true');
        expect(url.searchParams.get('includeItemsFromAllDrives')).toBe('true');
        expect(url.searchParams.get('q')).not.toContain('name contains');
        expect(url.searchParams.get('q')).toContain('trashed = false');
        if (!full) return r.fulfill({ json: { files: [appFile] } });
        if (url.searchParams.get('corpora') === 'drive') {
            calls.sharedPages++;
            return r.fulfill({
                json: {
                    files: url.searchParams.get('driveId') === 'team-a' ? [shared, appFile] : [],
                },
            });
        }
        calls.userPages++;
        return r.fulfill({
            json: url.searchParams.has('pageToken')
                ? {
                      files: [
                          mimeOnly,
                          { id: 'notes', name: 'notes.txt' },
                          { id: 'backup', name: 'route.gpx.backup' },
                      ],
                  }
                : {
                      files: [appFile, external],
                      nextPageToken: 'files-2',
                      incompleteSearch: incomplete,
                  },
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
    await panel.getByRole('button', { name: 'Search all GDrive', exact: true }).click();
    return { panel, calls };
}

test('searches My Drive and every shared drive page, filters mixed-case GPX and deduplicates files', async ({
    page,
}) => {
    const { panel, calls } = await setup(page);
    await expect(panel.getByRole('status')).toHaveText('4 GPX files found');
    for (const file of [appFile, external, shared, mimeOnly])
        await expect(panel.getByRole('button', { name: file.name, exact: true })).toHaveCount(1);
    await expect(panel.getByText('notes.txt')).toHaveCount(0);
    await expect(panel.getByText('route.gpx.backup')).toHaveCount(0);
    expect(calls).toEqual({ userPages: 2, drivePages: 2, sharedPages: 2, downloads: 0, writes: 0 });
    expect(await page.evaluate(() => (window as any).requestedDriveScope)).toBe(allScope);
    await panel.getByRole('textbox', { name: 'Search GDrive files' }).fill('ARCHIVE');
    await expect(panel.getByRole('button', { name: external.name, exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: shared.name, exact: true })).toHaveCount(0);
    await page.reload();
    await openDriveBrowser(page);
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    await expect(panel.getByRole('button', { name: 'Search all GDrive', exact: true })).toHaveCount(
        0
    );
    await expect(panel.getByRole('button', { name: external.name, exact: true })).toBeVisible();
});

test('opens previously unknown routes using resource keys while keeping their originals read-only', async ({
    page,
}) => {
    const { panel, calls } = await setup(page);
    await expect(panel.getByRole('status')).toHaveText('4 GPX files found');
    await panel.getByRole('button', { name: external.name, exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(`Opened ${external.name}`);
    const row = panel
        .locator('.group')
        .filter({ has: page.getByRole('button', { name: external.name, exact: true }) });
    await expect(row.getByRole('button', { name: 'Save', exact: true })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await closeDriveBrowser(page);
    await page.getByRole('button', { name: 'External route', exact: true }).last().click();
    await page.keyboard.press('Control+i');
    const editor = page
        .locator('[data-slot="popover-content"]')
        .filter({ has: page.locator('#name') });
    await editor.locator('#name').fill('Edited working copy');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(
        page.getByRole('button', { name: 'Edited working copy', exact: true }).last()
    ).toBeVisible();
    expect(calls.downloads).toBe(1);
    expect(calls.writes).toBe(0);
});

test('declining expanded access preserves the existing app-file connection', async ({ page }) => {
    const { panel, calls } = await setup(page, false);
    await expect(panel.getByRole('alert')).toContainText('did not grant access');
    await expect(
        panel.getByRole('button', { name: 'Search all GDrive', exact: true })
    ).toBeEnabled();
    await expect(panel.getByRole('button', { name: appFile.name, exact: true })).toBeVisible();
    expect(calls.drivePages).toBe(0);
});

test('incomplete searches show an error instead of claiming all files were found', async ({
    page,
}) => {
    const { panel } = await setup(page, true, true);
    await expect(panel.getByRole('alert')).toContainText('incomplete GDrive search');
    await expect(panel.getByRole('button', { name: 'Refresh GDrive', exact: true })).toBeEnabled();
    await expect(panel.getByText('4 GPX files found', { exact: true })).toHaveCount(0);
});
