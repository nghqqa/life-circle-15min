import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  workers: 1,
  timeout: 45_000,
  use: { baseURL: 'http://127.0.0.1:4183', viewport: { width: 1440, height: 1000 }, trace: 'retain-on-failure' },
  webServer: {
    command: 'node scripts/serve-browser-tests.mjs',
    url: 'http://127.0.0.1:4183',
    reuseExistingServer: false
  }
});
