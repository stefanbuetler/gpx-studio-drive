import { openDriveBrowser, closeDriveBrowser } from './drive-browser';
import { test, expect, type Page } from '@playwright/test';

const scope = 'https://www.googleapis.com/auth/drive.file';
const xml =
    '<?xml version="1.0"?><gpx version="1.1" creator="test"><metadata><name>Persistent route</name></metadata><trk><trkseg><trkpt lat="47" lon="8"/><trkpt lat="47.01" lon="8.01"/></trkseg></trk></gpx>';
const file = {
    id: 'persistent-file',
    name: 'Persistent.gpx',
    modifiedTime: '2026-10-21T10:00:00Z',
};

async function mockSession(page: Page) {
    const calls = { connect: 0, restore: 0, disconnect: 0, google: 0 };
    let revoked = false;
    await page.route('**/__gpx_services/styles/**', (route) =>
        route.fulfill({ json: { version: 8, sources: {}, layers: [] } })
    );
    await page.route('https://accounts.google.com/gsi/client', (route) =>
        route.fulfill({
            contentType: 'application/javascript',
            body: `window.google = { accounts: { oauth2: { initCodeClient(o) { return { requestCode() { o.callback({ code: 'one-time-code' }); } }; } } } };`,
        })
    );
    await page.route('**/api/drive/**', async (route) => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        if (path.endsWith('/config'))
            return route.fulfill({ json: { persistent: true, clientId: 'session-test-client' } });
        expect(request.headers()['x-gpx-drive-request']).toBe('1');
        expect(request.method()).toBe('POST');
        if (path.endsWith('/connect')) {
            expect(request.postDataJSON()).toEqual({ code: 'one-time-code' });
            calls.connect++;
            revoked = false;
            return route.fulfill({
                headers: {
                    'Set-Cookie':
                        'gpx_mock_session=remember-me; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=2592000',
                },
                json: { access_token: 'initial-token', expires_in: 3600, scope },
            });
        }
        if (path.endsWith('/disconnect')) {
            calls.disconnect++;
            return route.fulfill({
                headers: {
                    'Set-Cookie':
                        'gpx_mock_session=; HttpOnly; SameSite=Lax; Path=/api/drive; Max-Age=0',
                },
                json: { connected: false },
            });
        }
        calls.restore++;
        if (revoked || !request.headers().cookie?.includes('gpx_mock_session=remember-me'))
            return route.fulfill({ status: 401, json: { connected: false } });
        return route.fulfill({ json: { access_token: 'renewed-token', expires_in: 3600, scope } });
    });
    await page.route('https://www.googleapis.com/**', (route) => {
        calls.google++;
        expect(['Bearer initial-token', 'Bearer renewed-token']).toContain(
            route.request().headers().authorization
        );
        const url = new URL(route.request().url());
        if (url.pathname.endsWith('/about'))
            return route.fulfill({
                json: {
                    user: {
                        permissionId: 'test-account',
                        displayName: 'Trail Walker',
                        emailAddress: 'walker@example.test',
                    },
                },
            });
        if (url.searchParams.get('alt') === 'media')
            return route.fulfill({ contentType: 'application/gpx+xml', body: xml });
        return route.fulfill({
            json: url.pathname.endsWith('/persistent-file') ? file : { files: [file] },
        });
    });
    await page.goto('/app');
    await expect(
        page.getByRole('button', { name: 'Plan or edit a route', exact: true })
    ).toBeVisible();
    await page.keyboard.press('Control+l');
    await openDriveBrowser(page);
    const panel = page.getByRole('region', { name: 'GDrive files' });
    await expect(
        panel.getByRole('button', { name: 'Sign in with Google', exact: true })
    ).toBeEnabled();
    return {
        calls,
        panel,
        revoke: () => {
            revoked = true;
        },
    };
}

test('GDrive reconnects after reload and reopening the modal without another sign-in', async ({
    page,
    context,
}) => {
    const { panel, calls } = await mockSession(page);
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    expect(calls.connect).toBe(1);
    await page.reload();
    await openDriveBrowser(page);
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    await expect(panel.getByRole('button', { name: 'Persistent.gpx', exact: true })).toBeVisible();
    expect(calls.connect).toBe(1);
    await closeDriveBrowser(page);
    await expect(panel).toHaveCount(0);
    await page.keyboard.press('Control+l');
    await openDriveBrowser(page);
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    expect(calls.connect).toBe(1);
    const secrets = await page.evaluate(() => ({
        local: { ...localStorage },
        session: { ...sessionStorage },
        cookies: document.cookie,
    }));
    expect(JSON.stringify(secrets)).not.toContain('initial-token');
    expect(JSON.stringify(secrets)).not.toContain('renewed-token');
    expect(secrets.cookies).not.toContain('remember-me');
    expect((await context.cookies()).find((c) => c.name === 'gpx_mock_session')?.httpOnly).toBe(
        true
    );
});

test('expired access refreshes automatically without another sign-in', async ({ page }) => {
    const { panel, calls } = await mockSession(page);
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    const restores = calls.restore;
    await page.clock.setFixedTime(new Date(Date.now() + 2 * 3600 * 1000));
    await panel.getByRole('button', { name: 'Refresh GDrive' }).click();
    await expect(panel.getByRole('button', { name: 'Refresh GDrive' })).toBeEnabled();
    expect(calls.restore).toBe(restores + 1);
    expect(calls.connect).toBe(1);
    await expect(panel.getByRole('button', { name: 'Persistent.gpx', exact: true })).toBeVisible();
});

test('disconnect stops automatic reconnection while keeping the local working copy', async ({
    page,
}) => {
    const { panel, calls } = await mockSession(page);
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    await panel.getByRole('button', { name: 'Persistent.gpx', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('Opened Persistent.gpx');
    await expect(panel.getByRole('button', { name: 'Share', exact: true })).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'Local files' })).toBeVisible();
    await panel.getByRole('button', { name: 'Disconnect', exact: true }).click();
    await expect(
        panel.getByRole('button', { name: 'Sign in with Google', exact: true })
    ).toBeEnabled();
    expect(calls.disconnect).toBe(1);
    await page.reload();
    await openDriveBrowser(page);
    await expect(
        panel.getByRole('button', { name: 'Sign in with Google', exact: true })
    ).toBeEnabled();
    await expect(
        page.getByRole('button', { name: 'Persistent route', exact: true }).last()
    ).toBeVisible();
    expect(calls.connect).toBe(1);
});

test('revoked authorization returns to sign-in without an automatic popup loop', async ({
    page,
}) => {
    const { panel, calls, revoke } = await mockSession(page);
    await panel.getByRole('button', { name: 'Sign in with Google', exact: true }).click();
    await expect(panel.getByRole('status')).toHaveText('GDrive connected');
    revoke();
    await page.clock.setFixedTime(new Date(Date.now() + 2 * 3600 * 1000));
    await panel.getByRole('button', { name: 'Refresh GDrive' }).click();
    await expect(
        panel.getByRole('button', { name: 'Sign in with Google', exact: true })
    ).toBeEnabled();
    await expect(panel.getByRole('alert')).toContainText('expired');
    expect(calls.connect).toBe(1);
});
