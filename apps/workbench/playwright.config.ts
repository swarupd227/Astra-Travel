import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig, devices } from '@playwright/test';

// End-to-end and accessibility tests against a running local stack (Keycloak, API, worker, workbench).
export default defineConfig({
  testDir: './e2e',
  // Outside the Next.js project: the dev server watches its folder, and traces written during a test would reload the page under test.
  outputDir: join(tmpdir(), 'astra-playwright'),
  timeout: 60_000,
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list']],
  use: {
    baseURL: process.env.WORKBENCH_BASE_URL ?? 'http://localhost:3000',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'] } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } },
  ],
});
