import { test, expect, type Page } from '@playwright/test';
import { openDriveBrowser } from './drive-browser';

const appScope = 'https://www.googleapis.com/auth/drive.file';
const scope = `${appScope} https://www.googleapis.com/auth/drive.readonly`;
const a = { id: 'a', name: 'Alpine.gpx', isAppAuthorized: true };
const b = { id: 'b', name: 'Delete me.gpx' };
const c = { id: 'c', name: 'Trash me.gpx' };
const shared = { id: 's', name: 'Shared.gpx', isAppAuthorized: true };
const added = { id: 'd', name: 'New.GPX' };
const renamed = { ...a, name: 'Renamed.gpx' };
const opened = { ...shared, name: 'Fresh shared.gpx' };

async function setup(page: Page, storageAvailable = true) {
    const state = {
        account: 'account-a',
        scope,
        phase: 0,
        fail: false,
        reset: false,
        membership: false,
        lists: 0,
        changes: 0,
        downloads: 0,
        disconnects: 0,
    };
    let release: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('**/api/drive/**', (r) => {
        if (r.request().url().endsWith('/config')) return r.fulfill({ json: { persistent: true } });
        if (r.request().url().endsWith('/disconnect')) {
            state.disconnects++;
            return r.fulfill({ json: {} });
        }
        return r.fulfill({
            json: { access_token: 'index-test-token', expires_in: 3600, scope: state.scope },
        });
    });
    await page.route('https://www.googleapis.com/**', async (r) => {
        const url = new URL(r.request().url());
        if (url.pathname.endsWith('/about'))
            return r.fulfill({ json: { user: { permissionId: state.account } } });
        if (url.pathname.endsWith('/changes/startPageToken'))
            return r.fulfill({
                json: {
                    startPageToken: url.searchParams.get('driveId') ? 'shared-start' : 'user-start',
                },
            });
        if (url.pathname.endsWith('/drives'))
            return r.fulfill({
                json: { drives: [{ id: state.membership ? 'new-drive' : 'shared-drive' }] },
            });
        if (url.pathname.endsWith('/changes')) {
            state.changes++;
            if (gate) await gate;
            if (state.fail) return r.fulfill({ status: 503, body: 'temporary failure' });
            if (state.reset) {
                state.reset = false;
                return r.fulfill({ status: 410, body: 'invalid cursor' });
            }
            if (!state.phase)
                return r.fulfill({ json: { changes: [], newStartPageToken: 'unchanged' } });
            if (url.searchParams.has('driveId'))
                return r.fulfill({
                    json: {
                        changes: [{ fileId: 's', file: shared }],
                        newStartPageToken: 'shared-next',
                    },
                });
            if (url.searchParams.get('pageToken') === 'user-page-2')
                return r.fulfill({
                    json: {
                        changes: [
                            { fileId: 'c', file: { ...c, trashed: true } },
                            { fileId: 'noise', file: { id: 'noise', name: 'notes.txt' } },
                            {
                                fileId: 'folder',
                                file: {
                                    id: 'folder',
                                    name: 'folder.gpx',
                                    mimeType: 'application/vnd.google-apps.folder',
                                },
                            },
                        ],
                        newStartPageToken: 'user-next',
                    },
                });
            return r.fulfill({
                json: {
                    changes: [
                        { fileId: 'a', file: renamed },
                        { fileId: 'b', removed: true },
                        { fileId: 'd', file: added },
                    ],
                    nextPageToken: 'user-page-2',
                },
            });
        }
        if (url.searchParams.get('alt') === 'media') {
            state.downloads++;
            return r.fulfill({
                contentType: 'application/gpx+xml',
                body: '<gpx version="1.1"><trk><name>Shared route</name><trkseg><trkpt lat="47" lon="8"/><trkpt lat="47.01" lon="8.01"/></trkseg></trk></gpx>',
            });
        }
        if (url.pathname.endsWith('/s')) return r.fulfill({ json: opened });
        state.lists++;
        if (gate && state.account !== 'account-a') await gate;
        const files =
            state.account !== 'account-a' || state.scope === appScope
                ? [{ id: 'private-b', name: 'Other account.gpx' }]
                : url.searchParams.has('driveId')
                  ? state.membership
                      ? [{ id: 'new-shared', name: 'New team.gpx' }]
                      : [shared]
                  : [a, b, c];
        return r.fulfill({ json: { files } });
    });
    await page.goto('/app');
    await openDriveBrowser(page, false);
    const panel = page.getByRole('region', { name: 'GDrive files' });
    await expect(page.getByTestId('drive-index-status')).toHaveText(
        storageAvailable
            ? 'Local index up to date'
            : 'Index ready for this session; browser storage is unavailable.'
    );
    return {
        state,
        panel,
        block() {
            gate = new Promise<void>((resolve) => {
                release = resolve;
            });
        },
        release() {
            release?.();
            gate = undefined;
        },
    };
}

test('reload shows the saved index while paginated changes sync without another full scan', async ({
    page,
}) => {
    const env = await setup(page);
    const { state, panel } = env;
    const initial = state.lists;
    state.phase = 1;
    env.block();
    await page.reload();
    await openDriveBrowser(page, false);
    await expect(panel.getByRole('button', { name: a.name, exact: true })).toBeEnabled();
    await expect(page.getByTestId('drive-index-status')).toContainText('checking for changes');
    expect(state.lists).toBe(initial);
    await panel.getByRole('textbox', { name: 'Search GDrive files' }).fill('SHARED');
    await panel.getByRole('button', { name: shared.name, exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(`Opened ${shared.name}`);
    expect(state.downloads).toBe(1);
    env.release();
    await expect(page.getByTestId('drive-index-status')).toHaveText('Local index up to date');
    await panel.getByRole('textbox', { name: 'Search GDrive files' }).fill('');
    await expect(panel.getByRole('button', { name: renamed.name, exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: added.name, exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: opened.name, exact: true })).toBeVisible();
    for (const name of [a.name, b.name, c.name, 'notes.txt', 'folder.gpx'])
        await expect(panel.getByRole('button', { name, exact: true })).toHaveCount(0);
    expect(state.lists).toBe(initial);
    expect(state.changes).toBe(3);
});

for (const reason of ['cursor', 'membership'])
    test(`rebuilds the index when ${reason} changes`, async ({ page }) => {
        const { state, panel } = await setup(page);
        const initial = state.lists;
        state.reset = reason === 'cursor';
        state.membership = reason === 'membership';
        await page.reload();
        await openDriveBrowser(page, false);
        await expect.poll(() => state.lists).toBeGreaterThan(initial);
        await expect(page.getByTestId('drive-index-status')).toHaveText('Local index up to date');
        if (reason === 'membership') {
            await expect(
                panel.getByRole('button', { name: 'New team.gpx', exact: true })
            ).toBeVisible();
            await expect(panel.getByRole('button', { name: shared.name, exact: true })).toHaveCount(
                0
            );
        }
    });

for (const mode of ['account', 'scope'])
    test(`keeps cached files isolated by ${mode}`, async ({ page }) => {
        const env = await setup(page);
        if (mode === 'account') env.state.account = 'account-b';
        else env.state.scope = appScope;
        env.block();
        await page.reload();
        await openDriveBrowser(page, false);
        await expect(env.panel.getByRole('button', { name: a.name, exact: true })).toHaveCount(0);
        env.release();
        await expect(
            env.panel.getByRole('button', { name: 'Other account.gpx', exact: true })
        ).toBeVisible();
        await expect(env.panel.getByRole('button', { name: a.name, exact: true })).toHaveCount(0);
    });

test('failed background updates keep the saved index usable and manual refresh retries', async ({
    page,
}) => {
    const { state, panel } = await setup(page);
    const initial = state.lists;
    state.fail = true;
    await page.reload();
    await openDriveBrowser(page, false);
    await expect(page.getByTestId('drive-index-status')).toContainText('Could not update');
    await expect(panel.getByRole('button', { name: a.name, exact: true })).toBeEnabled();
    state.fail = false;
    state.phase = 1;
    await panel.getByRole('button', { name: 'Refresh GDrive', exact: true }).click();
    await expect(panel.getByRole('button', { name: renamed.name, exact: true })).toBeVisible();
    expect(state.lists).toBe(initial);
});

test('disconnect clears persisted index metadata without storing OAuth credentials', async ({
    page,
}) => {
    const { panel } = await setup(page);
    async function records() {
        return page.evaluate(
            () =>
                new Promise<unknown[]>((resolve, reject) => {
                    const request = indexedDB.open('TrailExplorerDriveIndex');
                    request.onsuccess = () => {
                        const db = request.result;
                        const tx = db.transaction('indexes');
                        const read = tx.objectStore('indexes').getAll();
                        read.onsuccess = () => resolve(read.result);
                        read.onerror = () => reject(read.error);
                        tx.oncomplete = () => db.close();
                    };
                    request.onerror = () => reject(request.error);
                })
        );
    }
    expect((await records()).length).toBe(1);
    expect(JSON.stringify(await records())).not.toContain('index-test-token');
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(
        panel.getByRole('button', { name: 'Sign in with Google', exact: true })
    ).toBeEnabled();
    expect(await records()).toEqual([]);
});

test('unavailable index storage leaves live browsing and this-session indexing usable', async ({
    page,
}) => {
    await page.addInitScript(() => {
        const open = IDBFactory.prototype.open;
        IDBFactory.prototype.open = function (name, version) {
            if (name === 'TrailExplorerDriveIndex')
                throw new DOMException('Storage blocked', 'SecurityError');
            return version === undefined ? open.call(this, name) : open.call(this, name, version);
        };
    });
    const { state, panel } = await setup(page, false);
    const initial = state.lists;
    await expect(panel.getByRole('button', { name: a.name, exact: true })).toBeEnabled();
    await panel.getByRole('button', { name: 'Refresh GDrive', exact: true }).click();
    await expect(panel.getByRole('button', { name: 'Refresh GDrive', exact: true })).toBeEnabled();
    expect(state.lists).toBe(initial);
});

test('a malformed saved index is rebuilt rather than crashing the modal', async ({ page }) => {
    const { state, panel } = await setup(page);
    const initial = state.lists;
    await page.evaluate(
        () =>
            new Promise<void>((resolve, reject) => {
                const request = indexedDB.open('TrailExplorerDriveIndex');
                request.onsuccess = () => {
                    const db = request.result;
                    const tx = db.transaction('indexes', 'readwrite');
                    const store = tx.objectStore('indexes');
                    const read = store.getAll();
                    read.onsuccess = () => {
                        const value = read.result[0];
                        value.files = [null];
                        store.put(value);
                    };
                    tx.oncomplete = () => {
                        db.close();
                        resolve();
                    };
                    tx.onerror = () => reject(tx.error);
                };
                request.onerror = () => reject(request.error);
            })
    );
    await page.reload();
    await openDriveBrowser(page, false);
    await expect.poll(() => state.lists).toBeGreaterThan(initial);
    await expect(page.getByTestId('drive-index-status')).toHaveText('Local index up to date');
    await expect(panel.getByRole('button', { name: a.name, exact: true })).toBeVisible();
});
