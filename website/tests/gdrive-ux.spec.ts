import { test, expect, type Page } from '@playwright/test';
import { openDriveBrowser, closeDriveBrowser } from './drive-browser';

const gpx =
    '<?xml version="1.0"?><gpx version="1.1" creator="test"><metadata><name>Forest loop</name></metadata><trk><trkseg><trkpt lat="47" lon="8"><ele>500</ele></trkpt><trkpt lat="47.01" lon="8.01"><ele>600</ele></trkpt></trkseg></trk></gpx>';
const folder = {
    id: 'routes-folder',
    name: 'Weekend routes',
    mimeType: 'application/vnd.google-apps.folder',
    capabilities: { canAddChildren: true },
};
const source = {
    id: 'original',
    name: 'Forest.gpx',
    parents: ['original-folder'],
    isAppAuthorized: false,
    capabilities: { canEdit: false, canShare: false },
    modifiedTime: '2026-10-23T09:00:00Z',
};

async function setup(page: Page) {
    const writes: { method: string; url: string; body: string }[] = [];
    const errors: string[] = [];
    let sdkLoads = 0;
    page.on('pageerror', (e) => errors.push(e.message));
    await page.route('**/api/drive/config', (r) => r.fulfill({ json: { persistent: false } }));
    await page.route('**/__gpx_services/styles/**', (r) =>
        r.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('https://accounts.google.com/gsi/client', (r) => {
        sdkLoads++;
        return r.fulfill({
            contentType: 'application/javascript',
            body: `window.google={accounts:{oauth2:{initTokenClient(o){return {requestAccessToken(){o.callback({access_token:'test',expires_in:3600,scope:'https://www.googleapis.com/auth/drive.file'})}}},revoke(t,done){done()}}}};`,
        });
    });
    await page.route('https://www.googleapis.com/drive/v3/about?**', (r) =>
        r.fulfill({ json: { user: { permissionId: 'ux-account', displayName: 'Trail Walker' } } })
    );
    await page.route('https://www.googleapis.com/drive/v3/changes/**', (r) =>
        r.fulfill({ json: { startPageToken: 'cursor', changes: [], newStartPageToken: 'next' } })
    );
    const saved = new Map<string, any>();
    await page.route('https://www.googleapis.com/**/files**', async (r) => {
        const req = r.request(),
            url = new URL(req.url()),
            id = url.pathname.split('/').pop()!;
        if (['POST', 'PATCH'].includes(req.method())) {
            writes.push({ method: req.method(), url: req.url(), body: req.postData() || '' });
            const body = req.postData() || '';
            if (req.headers()['content-type']?.includes('application/json')) {
                const data = req.postDataJSON();
                return r.fulfill({
                    json: {
                        ...folder,
                        id: 'created-folder',
                        name: data.name,
                        parents: data.parents,
                    },
                });
            }
            const metadata = body.match(/\r\n\r\n(\{[^\r\n]+\})\r\n/)?.[1];
            const meta = metadata ? JSON.parse(metadata) : {};
            const fileId = req.method() === 'POST' ? `saved-${saved.size + 1}` : id;
            const file = {
                ...saved.get(fileId),
                ...meta,
                id: fileId,
                isAppAuthorized: true,
                capabilities: { canEdit: true, canShare: true },
                modifiedTime: `2026-10-23T10:0${writes.length}:00Z`,
            };
            saved.set(fileId, file);
            return r.fulfill({ json: file });
        }
        if (url.searchParams.get('alt') === 'media')
            return r.fulfill({ body: gpx, contentType: 'application/gpx+xml' });
        if (id === 'root')
            return r.fulfill({ json: { ...folder, id: 'my-drive', name: 'My Drive' } });
        if (id === folder.id) return r.fulfill({ json: folder });
        if (id === 'created-folder') return r.fulfill({ json: { ...folder, id, name: 'Hiking' } });
        if (id === source.id) return r.fulfill({ json: source });
        if (saved.has(id)) return r.fulfill({ headers: { ETag: '"v1"' }, json: saved.get(id) });
        const q = url.searchParams.get('q') || '';
        return r.fulfill({
            json: {
                files: q.includes("mimeType = 'application/vnd.google-apps.folder'")
                    ? q.includes("'root' in parents")
                        ? [folder]
                        : []
                    : [source],
            },
        });
    });
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+l');
    return { writes, errors, sdkLoads: () => sdkLoads };
}
async function menu(page: Page, name: string) {
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: 'File', exact: true }).press('Enter');
    await page
        .getByRole('menuitem', {
            name: name === 'Open…' ? /^Open…/ : name,
            exact: name !== 'Open…',
        })
        .press('Enter');
}
async function local(page: Page) {
    const chooser = page.waitForEvent('filechooser');
    await menu(page, 'Open…');
    await page
        .getByRole('dialog', { name: 'Open', exact: true })
        .getByRole('button', { name: /^This device/ })
        .click();
    await (
        await chooser
    ).setFiles({ name: 'forest.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
    const row = page
        .getByRole('region', { name: 'Local files', exact: true })
        .getByRole('button', { name: 'Forest loop', exact: true })
        .last();
    await expect(row).toBeVisible();
    await row.click();
}
async function chooseFolder(page: Page) {
    const dialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(dialog).toBeVisible();
    if (!(await dialog.getByText('My Drive / Weekend routes', { exact: true }).isVisible())) {
        await dialog.getByRole('button', { name: 'Change…', exact: true }).click();
        await dialog.getByRole('button', { name: 'Weekend routes', exact: true }).click();
    }
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
}

test('local-only use loads no Google SDK and offers no Share for a local file', async ({
    page,
}) => {
    const { writes, errors, sdkLoads } = await setup(page);
    await local(page);
    await page.getByRole('menuitem', { name: 'File', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Save', exact: true })).toBeEnabled();
    await expect(page.getByRole('menuitem', { name: /Share/ })).toHaveCount(0);
    expect(writes).toEqual([]);
    expect(sdkLoads()).toBe(0);
    expect(errors).toEqual([]);
});

test('cancel first Drive save writes nothing; chosen folder creates a shareable copy and later saves update in place', async ({
    page,
}) => {
    const { writes, errors } = await setup(page);
    await local(page);
    await menu(page, 'Save as…');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(dialog).toBeVisible();
    expect(writes).toHaveLength(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
        page.getByText('Save cancelled. Your file remains in Local files.', { exact: true })
    ).toBeVisible();
    await menu(page, 'Save as…');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    await chooseFolder(page);
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toContain('"parents":["routes-folder"]');
    expect(writes[0].body).not.toContain('GPX Files');
    await menu(page, 'Share…');
    await expect(page.getByRole('dialog', { name: 'Share route' })).toContainText(
        'Local edits are not uploaded'
    );
    expect(writes).toHaveLength(1);
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await menu(page, 'Save');
    if (await page.getByRole('dialog', { name: 'Save as', exact: true }).isVisible())
        await page
            .getByRole('dialog', { name: 'Save as', exact: true })
            .getByRole('button', { name: /^GDrive/ })
            .click();
    await expect(page.getByText('No changes to save', { exact: true })).toBeVisible();
    await expect(page.getByRole('dialog', { name: 'Save to GDrive', exact: true })).toBeHidden();
    expect(writes).toHaveLength(1);
    await page.reload();
    await expect(
        page.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await page.getByRole('menuitem', { name: 'Connect GDrive', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Connect GDrive', exact: true }).last().click();
    await expect(
        page
            .getByRole('region', { name: 'Cloud files', exact: true })
            .getByRole('button', { name: 'Forest loop', exact: true })
            .last()
    ).toBeVisible();
    await expect(
        page
            .getByRole('region', { name: 'Local files', exact: true })
            .getByRole('button', { name: 'Forest loop', exact: true })
    ).toHaveCount(0);
    expect(errors).toEqual([]);
});

test('Drive originals open without writes; saving asks for a chosen folder and never updates the original', async ({
    page,
}) => {
    const { writes, errors } = await setup(page);
    const dialog = await openDriveBrowser(page);
    await dialog.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await dialog.getByRole('button', { name: source.name, exact: true }).click();
    await dialog.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(dialog).toBeHidden();
    await closeDriveBrowser(page);
    expect(writes).toHaveLength(0);
    await expect(
        page
            .getByRole('region', { name: 'Cloud files', exact: true })
            .getByRole('button', { name: 'Forest loop', exact: true })
            .last()
    ).toBeVisible();
    await expect(
        page
            .getByRole('region', { name: 'Local files', exact: true })
            .getByRole('button', { name: 'Forest loop', exact: true })
    ).toHaveCount(0);
    await menu(page, 'Save');
    if (await page.getByRole('dialog', { name: 'Save as', exact: true }).isVisible())
        await page
            .getByRole('dialog', { name: 'Save as', exact: true })
            .getByRole('button', { name: /^GDrive/ })
            .click();
    await chooseFolder(page);
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].method).toBe('POST');
    expect(writes[0].url).not.toContain('/original');
    expect(errors).toEqual([]);
});

test('a user-created folder is the explicit save destination', async ({ page }) => {
    const { writes } = await setup(page);
    await local(page);
    await menu(page, 'Save');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await dialog.getByRole('textbox', { name: 'Filename' }).fill('My hiking route.gpx');
    await dialog.getByRole('button', { name: 'Change…', exact: true }).click();
    await dialog.getByRole('button', { name: 'New folder', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'New folder name' }).fill('Hiking');
    await dialog.getByRole('button', { name: 'Create folder', exact: true }).click();
    await expect(dialog.getByText('My Drive / Hiking', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[0].body).toContain('"name":"Hiking"');
    expect(writes[1].body).toContain('"parents":["created-folder"]');
    expect(writes[1].body).toContain('"name":"My hiking route.gpx"');
    await expect(
        page.getByText('Saved My hiking route.gpx to Hiking', { exact: true })
    ).toBeVisible();
    await menu(page, 'Save');
    await expect(page.getByText('No changes to save', { exact: true })).toBeVisible();
    expect(writes).toHaveLength(2);
});

test('cloud edits show an unsaved marker and Share requires saving; disconnect retains the cloud source', async ({
    page,
}) => {
    const { writes, errors } = await setup(page);
    await local(page);
    await menu(page, 'Save');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    await chooseFolder(page);
    const tree = page.getByRole('region', { name: 'Cloud files', exact: true });
    await expect(
        tree.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await tree
        .getByRole('button', { name: 'Forest loop', exact: true })
        .last()
        .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Info/ }).click();
    const editor = page
        .locator('[data-slot="popover-content"]')
        .filter({ has: page.locator('#name') });
    await editor.locator('#name').fill('Edited forest loop');
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(tree.getByTestId('unsaved-cloud-file')).toBeVisible();
    await menu(page, 'Share…');
    const share = page.getByRole('dialog', { name: 'Share route' });
    await expect(share.getByRole('button', { name: 'Make public and create link' })).toBeDisabled();
    await share.getByRole('button', { name: 'Save changes to GDrive' }).click();
    await expect(share.getByRole('button', { name: 'Make public and create link' })).toBeEnabled();
    expect(writes).toHaveLength(2);
    expect(writes[1].method).toBe('PATCH');
    await share.getByRole('button', { name: 'Cancel', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Google account menu', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Disconnect GDrive', exact: true }).click();
    await expect(page.getByRole('menuitem', { name: 'Connect GDrive', exact: true })).toBeVisible();
    await expect(
        tree.getByRole('button', { name: 'Edited forest loop', exact: true }).last()
    ).toBeVisible();
    expect(errors).toEqual([]);
});

test('section icons open files and close only their own storage group, with concise Undo notices', async ({
    page,
}) => {
    const { writes, errors } = await setup(page);
    await local(page);
    await menu(page, 'Save');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    await chooseFolder(page);
    const cloud = page.getByRole('region', { name: 'Cloud files', exact: true });
    const device = page.getByRole('region', { name: 'Local files', exact: true });
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    const chooser = page.waitForEvent('filechooser');
    await device.getByRole('button', { name: 'Open local file', exact: true }).click();
    await (
        await chooser
    ).setFiles({ name: 'forest.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
    await expect(
        device.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await expect(cloud.getByRole('button', { name: 'Close selected cloud files' })).toBeDisabled();
    await cloud.getByRole('button', { name: 'Open cloud file', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Open from GDrive', exact: true })).toBeVisible();
    await closeDriveBrowser(page);
    await cloud.getByRole('button', { name: 'Forest loop', exact: true }).last().click();
    await cloud.getByRole('button', { name: 'Close selected cloud files', exact: true }).click();
    await expect(cloud.getByRole('button', { name: 'Forest loop', exact: true })).toHaveCount(0);
    await expect(
        device.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await page.getByRole('button', { name: 'Undo', exact: true }).last().click();
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await device.getByRole('button', { name: 'Close all local files', exact: true }).click();
    await expect(device.getByRole('button', { name: 'Forest loop', exact: true })).toHaveCount(0);
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    const notice = page.locator('[data-sonner-toast]').last();
    await expect(notice).toContainText('Closed 1 file');
    await expect(notice).not.toContainText('GDrive');
    expect(writes).toHaveLength(1);
    expect(errors).toEqual([]);
});

test('failed local upload explains that the local file and edits are retained', async ({
    page,
}) => {
    await setup(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await page
        .getByRole('dialog', { name: 'Open', exact: true })
        .getByRole('button', { name: /^This device/ })
        .click();
    await (
        await chooser
    ).setFiles({ name: 'forest.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
    await expect(
        page.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await page.route('https://www.googleapis.com/upload/drive/v3/files?**', (route) =>
        route.fulfill({ status: 403, body: 'Permission denied' })
    );
    await page.keyboard.press('Control+Shift+s');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    await chooseFolder(page);
    await expect(
        page.getByText(
            /Could not complete the save to GDrive\. Your file remains in Local files, with your edits intact\./
        )
    ).toBeVisible();
    await expect(
        page
            .getByRole('region', { name: 'Local files', exact: true })
            .getByRole('button', { name: 'Forest loop', exact: true })
            .last()
    ).toBeVisible();
});

test('My Drive saves without root metadata access; inaccessible folders retain the local file', async ({
    page,
}) => {
    const { writes } = await setup(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await page
        .getByRole('dialog', { name: 'Open', exact: true })
        .getByRole('button', { name: /^This device/ })
        .click();
    await (
        await chooser
    ).setFiles({ name: 'forest.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
    await expect(
        page.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await page.route('https://www.googleapis.com/drive/v3/files/root?**', (route) =>
        route.fulfill({ status: 404, body: 'File not found: root' })
    );
    await page.route('https://www.googleapis.com/drive/v3/files/routes-folder?**', (route) =>
        route.fulfill({ status: 404, body: 'File not found: private-id' })
    );
    await page.keyboard.press('Control+Shift+s');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await dialog.getByRole('button', { name: 'Change…', exact: true }).click();
    await dialog.getByRole('button', { name: 'Weekend routes', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog.getByRole('alert')).toContainText('This folder is unavailable');
    await expect(dialog.getByRole('alert')).not.toContainText('private-id');
    expect(writes).toHaveLength(0);
    await expect(page.getByRole('region', { name: 'Local files', exact: true })).toContainText(
        'Forest loop'
    );
    await dialog.getByRole('button', { name: 'Parent folder', exact: true }).click();
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => writes.length).toBe(1);
    expect(writes[0].body).toContain('"parents":["root"]');
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).toContainText(
        'Forest loop'
    );
});

test('save all keeps cloud files open after a failure and a successful retry', async ({ page }) => {
    const { writes, errors } = await setup(page);
    for (let i = 0; i < 2; i++) {
        await local(page);
        await menu(page, 'Save');
        await page
            .getByRole('dialog', { name: 'Save as', exact: true })
            .getByRole('button', { name: /^GDrive/ })
            .click();
        await chooseFolder(page);
        await expect.poll(() => writes.length).toBe(i + 1);
    }
    const cloud = page.getByRole('region', { name: 'Cloud files', exact: true });
    await expect(cloud.getByRole('button', { name: 'Forest loop', exact: true })).toHaveCount(4);
    await cloud
        .getByRole('button', { name: 'Forest loop', exact: true })
        .nth(1)
        .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Info/ }).click();
    await page.getByRole('textbox', { name: 'Name', exact: true }).fill('Edited first route');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(cloud.getByTestId('unsaved-cloud-file')).toBeVisible();
    const failure = 'https://www.googleapis.com/drive/v3/files/saved-*?**';
    await page.route(failure, (r) => r.fulfill({ status: 403, body: 'Permission denied' }));
    await cloud.getByRole('button', { name: 'Save all cloud files', exact: true }).click();
    await expect(page.getByText(/GDrive error \(403\)/)).toBeVisible();
    await expect(
        cloud.getByRole('button', { name: 'Edited first route', exact: true }).last()
    ).toBeVisible();
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    expect(writes).toHaveLength(2);
    await page.unroute(failure);
    await cloud.getByRole('button', { name: 'Save all cloud files', exact: true }).click();
    await expect(page.getByText('Saved 2 files', { exact: true })).toBeVisible();
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await expect(
        cloud.getByRole('button', { name: 'Edited first route', exact: true }).last()
    ).toBeVisible();
    expect(writes).toHaveLength(3);
    expect(errors).toEqual([]);
});

test('icon tooltips explain their actions and cancelling save all leaves the cloud original open', async ({
    page,
}) => {
    const { writes, errors } = await setup(page);
    const device = page.getByRole('region', { name: 'Local files', exact: true });
    await device.getByRole('button', { name: 'Open local file', exact: true }).hover();
    await expect(page.getByRole('tooltip')).toContainText('Open GPX files from your device.');
    const picker = await openDriveBrowser(page);
    await picker.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await picker.getByRole('button', { name: source.name, exact: true }).click();
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker).toBeHidden();
    await closeDriveBrowser(page);
    const cloud = page.getByRole('region', { name: 'Cloud files', exact: true });
    await cloud.getByRole('button', { name: 'Save all cloud files', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(folderDialog).toBeVisible();
    await folderDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(
        page.getByText('Save cancelled. Files remain open.', { exact: true })
    ).toBeVisible();
    await expect(
        cloud.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    expect(writes).toHaveLength(0);
    expect(errors).toEqual([]);
});

async function savedCloud(page: Page) {
    const context = await setup(page);
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await page
        .getByRole('dialog', { name: 'Open', exact: true })
        .getByRole('button', { name: /^This device/ })
        .click();
    await (
        await chooser
    ).setFiles({ name: 'forest.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(gpx) });
    await expect(
        page.getByRole('button', { name: 'Forest loop', exact: true }).last()
    ).toBeVisible();
    await page.keyboard.press('Control+Shift+s');
    await page
        .getByRole('dialog', { name: 'Save as', exact: true })
        .getByRole('button', { name: /^GDrive/ })
        .click();
    const dialog = page.getByRole('dialog', { name: 'Save to GDrive', exact: true });
    await expect(dialog.getByRole('button', { name: 'Change…', exact: true })).toBeVisible();
    await expect(dialog.getByRole('textbox', { name: 'Filter folders' })).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(() => context.writes.length).toBe(1);
    return context;
}
async function renameCloud(page: Page, previous: string, name: string) {
    await page
        .getByRole('region', { name: 'Cloud files', exact: true })
        .getByRole('button', { name: previous, exact: true })
        .last()
        .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Info/ }).click();
    const editor = page
        .locator('[data-slot="popover-content"]')
        .filter({ has: page.locator('#name') });
    await editor.locator('#name').fill(name);
    await editor.getByRole('button', { name: 'Save', exact: true }).click();
}

test('autosave debounces cloud edits, updates the same file, and shows Saved', async ({ page }) => {
    const { writes, errors } = await savedCloud(page);
    await renameCloud(page, 'Forest loop', 'Autumn route');
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).toContainText(
        'Unsaved changes'
    );
    await renameCloud(page, 'Autumn route', 'Winter route');
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].method).toBe('PATCH');
    expect(writes[1].url).toContain('/saved-1?');
    expect(writes[1].body).toContain('Winter route');
    await expect(
        page.getByRole('region', { name: 'Cloud files', exact: true }).getByRole('status')
    ).toHaveText('Saved');
    expect(errors).toEqual([]);
});

test('autosave failure retains edits, Retry saves, and closing unsaved cloud changes asks first', async ({
    page,
}) => {
    const { writes, errors } = await savedCloud(page);
    const upload = 'https://www.googleapis.com/upload/drive/v3/files/saved-1?**';
    await page.route(upload, (route) =>
        route.fulfill({ status: 503, body: 'Service temporarily unavailable' })
    );
    await renameCloud(page, 'Forest loop', 'Offline route');
    await expect(
        page.getByText('Could not autosave to GDrive. Your edits remain in this browser.', {
            exact: true,
        })
    ).toBeVisible();
    expect(writes).toHaveLength(1);
    await page.getByRole('button', { name: 'Close all cloud files', exact: true }).click();
    const close = page.getByRole('dialog', { name: 'Unsaved cloud changes', exact: true });
    await expect(close).toBeVisible();
    await close.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).toContainText(
        'Offline route'
    );
    await page.unroute(upload);
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(
        page.getByRole('region', { name: 'Cloud files', exact: true }).getByRole('status')
    ).toHaveText('Saved');
    await renameCloud(page, 'Offline route', 'Final route');
    await page.getByRole('button', { name: 'Close all cloud files', exact: true }).click();
    await close.getByRole('button', { name: 'Save and close', exact: true }).click();
    await expect(close).toBeHidden();
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).not.toContainText(
        'Final route'
    );
    expect(writes).toHaveLength(3);
    expect(errors).toEqual([]);
});

test('autosave detects remote conflicts without overwriting and discard closes explicitly', async ({
    page,
}) => {
    const { writes, errors } = await savedCloud(page);
    await page.route('https://www.googleapis.com/drive/v3/files/saved-1?**', (route) =>
        route.fulfill({
            json: {
                id: 'saved-1',
                name: 'Changed elsewhere.gpx',
                modifiedTime: '2026-10-23T18:00:00Z',
                parents: ['root'],
                isAppAuthorized: true,
                appProperties: { trailExplorerRoute: '1' },
                capabilities: { canEdit: true },
            },
        })
    );
    await renameCloud(page, 'Forest loop', 'My edits');
    await expect(
        page.getByText('Could not autosave to GDrive. Your edits remain in this browser.', {
            exact: true,
        })
    ).toBeVisible();
    await expect(page.getByText(/Conflict: the saved copy changed in GDrive/)).toBeVisible();
    expect(writes).toHaveLength(1);
    await page.getByRole('button', { name: 'Close all cloud files', exact: true }).click();
    const close = page.getByRole('dialog', { name: 'Unsaved cloud changes', exact: true });
    await close.getByRole('button', { name: 'Discard changes', exact: true }).click();
    await expect(close).toBeHidden();
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).not.toContainText(
        'My edits'
    );
    expect(writes).toHaveLength(1);
    expect(errors).toEqual([]);
});

test('compact open dialog selects a route before opening it as a cloud file', async ({ page }) => {
    const { writes, errors } = await setup(page);
    const picker = await openDriveBrowser(page);
    await expect(picker.getByRole('button', { name: 'Open', exact: true })).toBeDisabled();
    await picker.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await picker.getByRole('textbox', { name: 'Search GDrive files' }).fill('Forest');
    await picker.getByRole('button', { name: source.name, exact: true }).click();
    await expect(picker).toBeVisible();
    await picker.getByRole('button', { name: 'Open', exact: true }).click();
    await expect(picker).toBeHidden();
    await expect(page.getByRole('region', { name: 'Cloud files', exact: true })).toContainText(
        'Forest loop'
    );
    expect(writes).toHaveLength(0);
    expect(errors).toEqual([]);
});

test('POIs can be copied from a local file into a cloud file and autosaved', async ({ page }) => {
    const { writes, errors } = await savedCloud(page);
    const points = gpx
        .replace('<name>Forest loop</name>', '<name>Local POIs</name>')
        .replace('<trk>', '<wpt lat="47.005" lon="8.005"><name>Water fountain</name></wpt><trk>');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await page
        .getByRole('dialog', { name: 'Open', exact: true })
        .getByRole('button', { name: /^This device/ })
        .click();
    await (
        await chooser
    ).setFiles({
        name: 'points.gpx',
        mimeType: 'application/gpx+xml',
        buffer: Buffer.from(points),
    });
    const localTree = page.getByRole('region', { name: 'Local files', exact: true });
    const row = localTree.getByRole('button', { name: 'Local POIs', exact: true }).first();
    await row.locator('[data-slot="collapsible-trigger"]').click();
    const pois = localTree.getByRole('button', { name: 'Points of interest', exact: true }).first();
    await pois.locator('[data-slot="collapsible-trigger"]').click();
    await localTree
        .getByRole('button', { name: 'Water fountain', exact: true })
        .click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Copy/ }).click();
    const cloud = page.getByRole('region', { name: 'Cloud files', exact: true });
    await cloud
        .getByRole('button', { name: 'Forest loop', exact: true })
        .last()
        .click({ button: 'right' });
    await expect(page.getByRole('menuitem', { name: /^Paste/ })).toBeEnabled();
    await page.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect(cloud.getByRole('button', { name: 'Water fountain', exact: true })).toBeVisible();
    await expect(
        localTree.getByRole('button', { name: 'Water fountain', exact: true })
    ).toBeVisible();
    await expect.poll(() => writes.length).toBe(2);
    expect(writes[1].method).toBe('PATCH');
    expect(writes[1].body).toContain('Water fountain');
    await expect(cloud.getByRole('status')).toHaveText('Saved');
    // Dragging contents across storage sections must also work; only whole-file
    // reordering is confined to a section. Move the copied POI back to the source.
    await expect(page.getByRole('menu')).toHaveCount(0);
    const cloudPoint = cloud.getByRole('button', { name: 'Water fountain', exact: true });
    const sourceRow = cloudPoint.locator('xpath=ancestor::div[@data-id][1]');
    const destination = localTree.locator('.sortable').last();
    const sourceBox = (await sourceRow.boundingBox())!;
    await page.mouse.move(sourceBox.x + 20, sourceBox.y + sourceBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(sourceBox.x + 30, sourceBox.y + sourceBox.height / 2 + 10, { steps: 5 });
    let targetBox = (await destination.boundingBox())!;
    await page.mouse.move(targetBox.x + 20, targetBox.y + targetBox.height - 3, { steps: 20 });
    // Native dragover and Sortable's fallback run on browser frames. Wait for
    // the insertion preview before releasing the pointer, as a person would.
    await expect(async () => {
        await page.mouse.move(targetBox.x + 25, targetBox.y + targetBox.height - 3);
        await expect(destination.locator(':scope > div[data-id]')).toHaveCount(2, { timeout: 200 });
    }).toPass({ timeout: 4000, intervals: [100, 200] });
    await page.mouse.up();
    await expect(cloudPoint).toHaveCount(0);
    await expect(localTree.getByRole('button', { name: 'Water fountain', exact: true })).toHaveCount(2);
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2].method).toBe('PATCH');
    expect(writes[2].body).not.toContain('Water fountain');
    expect(errors).toEqual([]);
});

test('a whole local POI group can be pasted onto an existing cloud POI', async ({ page }) => {
    const { writes, errors } = await savedCloud(page);
    const points = gpx.replace('<name>Forest loop</name>', '<name>Local POIs</name>').replace('<trk>', '<wpt lat="47.005" lon="8.005"><name>Water fountain</name></wpt><trk>');
    const chooser = page.waitForEvent('filechooser');
    await page.keyboard.press('Control+o');
    await page.getByRole('dialog', { name: 'Open', exact: true }).getByRole('button', { name: /^This device/ }).click();
    await (await chooser).setFiles({ name: 'points.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(points) });
    const localTree = page.getByRole('region', { name: 'Local files', exact: true });
    await localTree.getByRole('button', { name: 'Local POIs', exact: true }).first().locator('[data-slot="collapsible-trigger"]').click();
    const group = localTree.getByRole('button', { name: 'Points of interest', exact: true });
    await group.last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Copy/ }).click();
    const cloud = page.getByRole('region', { name: 'Cloud files', exact: true });
    await cloud.getByRole('button', { name: 'Forest loop', exact: true }).last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect.poll(() => writes.length).toBe(2);
    await expect(cloud.getByRole('status')).toHaveText('Saved');
    await group.last().click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Copy/ }).click();
    // The second paste targets a point, rather than the file/group heading.
    await cloud.getByRole('button', { name: 'Points of interest', exact: true }).first().locator('[data-slot="collapsible-trigger"]').click();
    await cloud.getByRole('button', { name: 'Water fountain', exact: true }).click({ button: 'right' });
    await page.getByRole('menuitem', { name: /^Paste/ }).click();
    await expect(cloud.getByRole('button', { name: 'Water fountain', exact: true })).toHaveCount(2);
    await expect.poll(() => writes.length).toBe(3);
    expect(writes[2].body.match(/<wpt /g)).toHaveLength(2);
    expect(writes[2].method).toBe('PATCH');
    await expect(cloud.getByRole('status')).toHaveText('Saved');
    expect(errors).toEqual([]);
});
