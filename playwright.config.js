import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './test/e2e',
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 2 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    baseURL: 'http://127.0.0.1:3100',
    channel: 'chrome',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    video: 'off'
  },
  webServer: {
    command: 'node server.js',
    url: 'http://127.0.0.1:3100/api/status',
    reuseExistingServer: false,
    timeout: 120000,
    env: {
      PORT: '3100',
      NODE_ENV: 'test',
      PHASE5_DATA_DIR: './.e2e-data/control',
      DEFAULT_TENANT_DATABASE_URL: 'sqlite:./.e2e-data/tenant.db',
      JWT_SECRET: 'inventia-e2e-jwt-secret',
      TENANT_MASTER_KEY: 'inventia-e2e-master-key'
    }
  }
});
