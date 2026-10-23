import { openDriveBrowser, closeDriveBrowser } from './drive-browser';
import { test, expect, type Page } from '@playwright/test';

const gpx =
    '<?xml version="1.0"?><gpx version="1.1" creator="test"><metadata><name>Alpine route</name></metadata><trk><name>Alpine route</name><trkseg><trkpt lat="47" lon="8"><ele>500</ele></trkpt><trkpt lat="47.01" lon="8.01"><ele>600</ele></trkpt></trkseg></trk></gpx>';
const original = {
    id: 'route-1',
    name: 'Alpine.gpx',
    modifiedTime: '2026-10-20T10:00:00Z',
    isAppAuthorized: false,
};
const folderValue = {
    id: 'gpx-folder',
    name: 'GPX Files',
    mimeType: 'application/vnd.google-apps.folder',
    isAppAuthorized: true,
    appProperties: { trailExplorerFolder: '1' },
    capabilities: { canAddChildren: true },
};

test.beforeEach(async ({ page }) => {
    await page.route('**/api/drive/config', (r) => r.fulfill({ json: { persistent: false } }));
});
async function setup(page: Page, mode = 'success') {
    let folder: typeof folderValue | undefined = mode === 'managed' ? folderValue : undefined;
    const source =
        mode === 'managed'
            ? {
                  ...original,
                  isAppAuthorized: true,
                  parents: ['gpx-folder'],
                  appProperties: { trailExplorerRoute: '1' },
              }
            : original;
    let counter = 0;
    const copies = new Map<string, any>();
    if (mode === 'managed') copies.set(source.id, source);
    const writes: { method: string; url: string; body: string; etag?: string }[] = [];
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('https://accounts.google.com/gsi/client', (r) =>
        r.fulfill({
            contentType: 'application/javascript',
            body: `window.google={accounts:{oauth2:{initTokenClient(o){return{requestAccessToken(){${mode === 'cancel' ? "o.error_callback({type:'popup_closed'})" : "o.callback({access_token:'test-token',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'})"}}}},revoke(t,done){done()}}}};`,
        })
    );
    await page.route('https://www.googleapis.com/**', async (r) => {
        const req = r.request(),
            url = new URL(req.url());
        const id = url.pathname.split('/').pop()!;
        const body = req.postData() || '';
        if (mode === 'expired') return r.fulfill({ status: 401, body: '{}' });
        if (url.searchParams.has('key')) {
            expect(req.headers().authorization).toBeUndefined();
            return r.fulfill({ contentType: 'application/gpx+xml', body: gpx });
        }
        expect(req.headers().authorization).toBe('Bearer test-token');
        if (req.method() === 'POST' || req.method() === 'PATCH') {
            writes.push({
                method: req.method(),
                url: req.url(),
                body,
                etag: req.headers()['if-match'],
            });
            if (url.pathname.endsWith('/permissions'))
                return r.fulfill({ json: { id: 'public-reader' } });
            if (
                req.method() === 'POST' &&
                req.headers()['content-type']?.includes('application/json')
            ) {
                expect(req.postDataJSON()).toMatchObject({
                    name: 'GPX Files',
                    mimeType: 'application/vnd.google-apps.folder',
                    appProperties: { trailExplorerFolder: '1' },
                });
                folder = folderValue;
                return r.fulfill({ json: folder });
            }
            if (mode === 'batch-failure' && req.method() === 'POST' && counter > 0)
                return r.fulfill({ status: 403, body: 'Cannot save second route' });
            if (mode === 'race' && req.method() === 'PATCH')
                return r.fulfill({ status: 412, body: '{}' });
            const metadata = body.match(/\r\n\r\n(\{[^\r\n]+\})\r\n/)?.[1];
            const fields = metadata ? JSON.parse(metadata) : {};
            const remoteId = req.method() === 'POST' ? `copy-${++counter}` : id;
            const copy = {
                ...(copies.get(remoteId) || {}),
                ...fields,
                id: remoteId,
                isAppAuthorized: true,
                modifiedTime: `2026-10-21T10:00:${String(++counter).padStart(2, '0')}Z`,
            };
            copies.set(remoteId, copy);
            return r.fulfill({ json: copy });
        }
        if (url.pathname.endsWith('/permissions')) return r.fulfill({ json: { permissions: [] } });
        if (url.searchParams.get('alt') === 'media')
            return r.fulfill({
                contentType: 'application/gpx+xml',
                body: mode === 'invalid' ? '<html>bad</html>' : gpx,
            });
        if (id === 'gpx-folder') return r.fulfill({ json: folderValue });
        if (id === 'route-1') return r.fulfill({ json: copies.get(id) || source });
        if (id.startsWith('copy-'))
            return copies.has(id)
                ? r.fulfill({
                      headers: { ETag: '"version-1"', 'Access-Control-Expose-Headers': 'ETag' },
                      json: copies.get(id),
                  })
                : r.fulfill({ status: 404, body: 'not found' });
        if (url.searchParams.get('q')?.includes('trailExplorerFolder'))
            return r.fulfill({ json: { files: folder ? [folder] : [] } });
        return r.fulfill({
            json: url.searchParams.has('pageToken')
                ? {
                      files: [
                          { id: 'notes', name: 'notes.txt' },
                          { id: 'winter', name: 'Winter.GPX' },
                      ],
                  }
                : { files: [source], nextPageToken: 'page-2' },
        });
    });
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+l');
    await openDriveBrowser(page);
    const panel = page.getByRole('region', { name: 'GDrive files' });
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    if (mode !== 'expired' && mode !== 'cancel')
        await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    return {
        panel,
        writes,
        copies,
        errors,
        changeRemote() {
            const copy = [...copies.values()][0];
            copy.modifiedTime = '2026-10-22T00:00:00Z';
        },
        deleteCopy() {
            copies.clear();
        },
    };
}
async function importRoute(page: Page, panel: any) {
    await panel.getByRole('button', { name: original.name, exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText(`Opened ${original.name}`);
    await closeDriveBrowser(page);
}
async function contextAction(page: Page, action: string | RegExp, name = 'Alpine route') {
    await closeDriveBrowser(page);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('menu')).toHaveCount(0);
    await page.getByRole('button', { name, exact: true }).last().click({ button: 'right' });
    await page
        .getByRole('menuitem', {
            name:
                action === 'Save to GDrive' ? 'Save' : action === 'Share route' ? 'Share…' : action,
            exact: true,
        })
        .click();
}
async function save(page: Page, name = 'Alpine route') {
    await contextAction(page, 'Save to GDrive', name);
    const destination = page.getByRole('dialog', { name: 'Save as', exact: true });
    const savedNotice = page.getByText(new RegExp(`Saved ${name}\\.gpx to `));
    const pendingFolder = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(destination.or(pendingFolder).or(savedNotice)).toBeVisible();
    if (await destination.isVisible())
        await destination.getByRole('button', { name: /^GDrive/ }).click();
    const folderDialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(folderDialog.or(savedNotice)).toBeVisible();
    if (await folderDialog.isVisible()) {
        await folderDialog.getByRole('textbox', { name: 'New folder name' }).fill('GPX Files');
        await folderDialog.getByRole('button', { name: 'Create folder', exact: true }).click();
        await expect(folderDialog.getByText('My Drive / GPX Files', { exact: true })).toBeVisible();
        await folderDialog.getByRole('button', { name: 'Save here', exact: true }).click();
    }
    await expect(
        page.getByText(new RegExp(`Saved ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.gpx to `))
    ).toBeVisible();
}
async function edit(page: Page, name = 'Alpine route', next = 'Edited alpine route') {
    await closeDriveBrowser(page);
    await contextAction(page, /^Info/, name);
    const editor = page
        .locator('[data-slot="popover-content"]')
        .filter({ has: page.locator('#name') });
    await editor.locator('#name').fill(next);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('button', { name: next, exact: true }).last()).toBeVisible();
}

test('File menu opens a searchable picker with no Save or Share actions on source files', async ({
    page,
}) => {
    const { panel, errors } = await setup(page);
    await expect(panel.getByRole('button', { name: original.name, exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Winter.GPX', exact: true })).toBeVisible();
    await expect(panel.getByText('notes.txt')).toHaveCount(0);
    for (const name of ['Save', 'Share', 'Upload GPX'])
        await expect(panel.getByRole('button', { name, exact: true })).toHaveCount(0);
    await panel.getByRole('textbox', { name: 'Search GDrive files' }).fill('WINTER');
    await expect(panel.getByRole('button', { name: original.name, exact: true })).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('first save creates a managed copy in the explicitly chosen folder, then unchanged saves skip writes and edits update that copy', async ({
    page,
}) => {
    const { panel, writes, copies, errors } = await setup(page);
    await importRoute(page, panel);
    expect(writes).toHaveLength(0);
    await save(page);
    expect(writes).toHaveLength(2);
    const copy = [...copies.values()][0];
    expect(copy).toMatchObject({
        name: 'Alpine route.gpx',
        parents: ['gpx-folder'],
        appProperties: { trailExplorerRoute: '1' },
    });
    await contextAction(page, 'Save to GDrive');
    await expect(page.getByText('No changes to save', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
    await edit(page);
    await save(page, 'Edited alpine route');
    expect(writes).toHaveLength(3);
    expect(writes[2]).toMatchObject({ method: 'PATCH', etag: '"version-1"' });
    expect(writes[2].url).toContain(copy.id);
    expect(writes[2].body).toContain('Edited alpine route');
    expect(writes.every((w) => !w.url.includes('/route-1'))).toBe(true);
    expect(errors).toEqual([]);
});

test('saved-copy connection survives reload without creating another copy', async ({ page }) => {
    const { panel, writes, copies } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    const id = [...copies.keys()][0];
    await page.reload();
    await expect(
        page.getByRole('button', { name: 'Alpine route', exact: true }).last()
    ).toBeVisible();
    await edit(page);
    await save(page, 'Edited alpine route');
    expect(copies.size).toBe(1);
    expect(writes.at(-1)!.url).toContain(id);
});

test('protects a saved copy changed outside the app, even after refreshing the browser', async ({
    page,
}) => {
    const { panel, writes, changeRemote } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    await edit(page);
    changeRemote();
    await openDriveBrowser(page);
    await panel.getByRole('button', { name: 'Refresh GDrive', exact: true }).click();
    await contextAction(page, 'Save to GDrive', 'Edited alpine route');
    await expect(page.getByText(/Conflict: the saved copy changed/)).toBeVisible();
    expect(writes).toHaveLength(2);
});

test('retains local edits when Google rejects a concurrent save', async ({ page }) => {
    const { panel } = await setup(page, 'race');
    await importRoute(page, panel);
    await save(page);
    await edit(page);
    await contextAction(page, 'Save to GDrive', 'Edited alpine route');
    await expect(page.getByText(/Conflict:/)).toBeVisible();
    await expect(
        page.getByRole('button', { name: 'Edited alpine route', exact: true }).last()
    ).toBeVisible();
});

test('recreates a deleted managed copy without touching the imported original', async ({
    page,
}) => {
    const { panel, writes, copies, deleteCopy } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    const old = [...copies.keys()][0];
    deleteCopy();
    await save(page);
    await expect.poll(() => [...copies.keys()][0]).toMatch(/^copy-/);
    expect([...copies.keys()][0]).not.toBe(old);
    expect(writes.every((w) => w.method === 'POST')).toBe(true);
});

test('reusing a deleted local file ID cannot overwrite its former Drive copy', async ({ page }) => {
    const { panel, writes, copies } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    await page.getByRole('button', { name: 'Alpine route', exact: true }).last().click();
    await page.keyboard.press('Control+Delete');
    await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(0);
    await openDriveBrowser(page);
    await importRoute(page, panel);
    await save(page);
    await expect.poll(() => copies.size).toBe(2);
    expect(writes.every((w) => w.method === 'POST')).toBe(true);
});

test('Share on a saved cloud copy does not save or publish until confirmed', async ({ page }) => {
    const { panel, writes } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    const before = writes.length;
    await contextAction(page, 'Share route');
    const dialog = page.getByRole('dialog', { name: 'Share route', exact: true });
    await expect(dialog).toContainText('Local edits are not uploaded');
    expect(writes).toHaveLength(before);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
});

test('cancelling Share does not save or publish anything', async ({ page }) => {
    const { panel, writes } = await setup(page);
    await importRoute(page, panel);
    await contextAction(page, 'Share route');
    await page
        .getByRole('dialog', { name: 'Share route', exact: true })
        .getByRole('button', { name: 'Cancel', exact: true })
        .click();
    expect(writes).toHaveLength(0);
});

test('rejects invalid remote GPX before adding a local copy', async ({ page }) => {
    const { panel, writes } = await setup(page, 'invalid');
    await panel.getByRole('button', { name: original.name, exact: true }).click();
    await expect(panel.getByRole('alert')).toContainText('Invalid GPX');
    expect(writes).toHaveLength(0);
});
for (const mode of ['expired', 'cancel'])
    test(`${mode} authentication releases the controls`, async ({ page }) => {
        const { panel } = await setup(page, mode);
        await expect(panel.getByRole('alert')).toContainText(
            mode === 'expired' ? 'expired' : 'cancelled'
        );
        await expect(
            panel.getByRole('button', { name: 'Sign in with Google', exact: true })
        ).toBeEnabled();
    });

test('Drive modal opens independently of the file tree and closes with Done', async ({ page }) => {
    const { panel } = await setup(page);
    await closeDriveBrowser(page);
    await page.keyboard.press('Control+l');
    await expect(page.getByRole('heading', { name: /^Local files/ })).toBeHidden();
    await openDriveBrowser(page);
    await expect(panel.getByRole('button', { name: original.name, exact: true })).toBeVisible();
    await closeDriveBrowser(page);
});

test('opening an existing managed route updates it instead of making another copy', async ({
    page,
}) => {
    const { panel, writes, copies } = await setup(page, 'managed');
    await importRoute(page, panel);
    await edit(page);
    await save(page, 'Edited alpine route');
    expect(copies.size).toBe(1);
    expect(writes).toHaveLength(1);
    expect(writes[0].method).toBe('PATCH');
    expect(writes[0].url).toContain('/route-1?');
});

test('a newly created local file can save without importing a Drive file', async ({ page }) => {
    const { writes, copies } = await setup(page);
    await closeDriveBrowser(page);
    await page.getByRole('menuitem', { name: 'File', exact: true }).press('Enter');
    await page.getByRole('menuitem', { name: /^New/ }).press('Enter');
    await expect(
        page.getByRole('button', { name: 'New file 1', exact: true }).last()
    ).toBeVisible();
    await save(page, 'New file 1');
    expect(writes).toHaveLength(2);
    expect([...copies.values()][0].parents).toEqual(['gpx-folder']);
});

test('saving the same local route under another Google account creates a separate copy', async ({
    page,
}) => {
    const { panel, writes, copies } = await setup(page);
    await importRoute(page, panel);
    await save(page);
    await page.route('https://www.googleapis.com/drive/v3/about?**', (r) =>
        r.fulfill({ json: { user: { permissionId: 'another-account' } } })
    );
    await edit(page);
    await save(page, 'Edited alpine route');
    await expect.poll(() => copies.size).toBe(2);
    expect(writes.every((w) => w.method === 'POST')).toBe(true);
});

for (const mode of ['Duplicate', 'Copy and paste']) {
    test(`${mode} cannot inherit an old destination when a local ID is reused`, async ({
        page,
    }) => {
        const { panel, writes, copies } = await setup(page);
        async function duplicate(name = 'Alpine route') {
            if (mode === 'Duplicate') await contextAction(page, /^Duplicate/, name);
            else {
                await contextAction(page, /^Copy/, name);
                await contextAction(page, /^Paste/, name);
            }
        }
        await importRoute(page, panel);
        await save(page);
        await duplicate();
        await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(
            4
        );
        await edit(page, 'Alpine route', 'Duplicate route');
        await contextAction(page, /^Delete/, 'Alpine route');
        await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(
            0
        );
        await duplicate('Duplicate route');
        await expect(
            page.getByRole('button', { name: 'Duplicate route', exact: true })
        ).toHaveCount(4);
        await edit(page, 'Duplicate route', 'New copy');
        await save(page, 'New copy');
        await expect.poll(() => copies.size).toBe(2);
        expect(writes.every((w) => w.method === 'POST')).toBe(true);
    });
}

test('close all cloud files keeps local files open and supports Undo', async ({
    page,
}) => {
    const { panel, writes, errors } = await setup(page);
    await importRoute(page, panel);
    await contextAction(page, /^Duplicate/);
    await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(4);
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: 'Google account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Disconnect GDrive', exact: true }).click();
    await page.getByRole('button', { name: 'Close all cloud files', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(2);
    expect(writes).toHaveLength(0);
    await expect(page.getByText('Closed 1 file', { exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(4);
    expect(writes).toHaveLength(0);
    expect(errors).toEqual([]);
});

test('File menu Close offers Undo and restores the working copy', async ({ page }) => {
    const { panel, writes, errors } = await setup(page);
    await importRoute(page, panel);
    await page.getByRole('menuitem', { name: 'File', exact: true }).press('Enter');
    await page.getByRole('menuitem', { name: 'Close', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Alpine route', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(
        page.getByRole('button', { name: 'Alpine route', exact: true }).last()
    ).toBeVisible();
    expect(writes).toHaveLength(0);
    expect(errors).toEqual([]);
});
