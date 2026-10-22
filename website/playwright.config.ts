import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: './tests',
    workers: 1,
    use: { baseURL: 'http://localhost:5173', viewport: { width: 1440, height: 1000 } },
    webServer: {
        command: 'npm run dev -- --host localhost --port 5173 --strictPort',
        url: 'http://localhost:5173/app',
        reuseExistingServer: !process.env.CI,
        timeout: 60000,
    },
});
