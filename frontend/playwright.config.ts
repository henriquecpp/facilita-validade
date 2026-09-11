import { defineConfig, devices } from '@playwright/test';
export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 15000 },
  reporter: [['list']],
  use: {
    baseURL: process.env.E2E_WEB_URL ?? 'http://localhost:5174',
    actionTimeout: 15000,
    navigationTimeout: 30000,
    trace: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          ...(process.env.E2E_CHROME_PATH ? { executablePath: process.env.E2E_CHROME_PATH } : {}),
        },
      },
    },
  ],
});
