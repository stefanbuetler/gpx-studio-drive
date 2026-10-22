import { expect, type Page } from '@playwright/test';

const indexMocks = new WeakSet<Page>();
export async function openDriveBrowser(page: Page, mockIndex = true) {
    if (mockIndex && !indexMocks.has(page)) {
        indexMocks.add(page);
        await page.route('https://www.googleapis.com/drive/v3/about?**', (r) =>
            r.fulfill({
                json: {
                    user: {
                        permissionId: 'test-account',
                        displayName: 'Trail Walker',
                        emailAddress: 'walker@example.test',
                    },
                },
            })
        );
        await page.route('https://www.googleapis.com/drive/v3/changes/startPageToken?**', (r) =>
            r.fulfill({ json: { startPageToken: 'initial-cursor' } })
        );
        await page.route('https://www.googleapis.com/drive/v3/changes?**', (r) =>
            r.fulfill({ json: { changes: [], newStartPageToken: 'next-cursor' } })
        );
    }
    const dialog = page.getByRole('dialog', { name: 'Open from GDrive', exact: true });
    await expect(async () => {
        if (await dialog.isVisible()) return;
        await page.keyboard.press('Escape');
        await page.getByRole('menuitem', { name: 'File', exact: true }).press('Enter');
        const entry = page.getByRole('menuitem', { name: 'Open from GDrive', exact: true });
        await expect(entry).toBeVisible({ timeout: 500 });
        await entry.press('Enter');
        await expect(dialog).toBeVisible({ timeout: 500 });
    }).toPass({ timeout: 8000, intervals: [100, 250, 500] });
    await expect(dialog).toBeVisible();
    return dialog;
}

export async function closeDriveBrowser(page: Page) {
    const dialog = page.getByRole('dialog', { name: 'Open from GDrive', exact: true });
    if (await dialog.isVisible())
        await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toBeHidden();
}
