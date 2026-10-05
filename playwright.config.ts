import { defineConfig, devices } from '@playwright/test'

/**
 * Every test opens several real edrys-Lite peers that have to connect before
 * anything can be checked, so the budget is well above Playwright's default.
 * Peers of parallel tests would share the signaling server, hence one worker.
 */
export default defineConfig({
  testDir: './modules',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never' }]],
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'] } },
    { name: 'firefox', use: { ...devices['Desktop Firefox'] } },
    { name: 'webkit', use: { ...devices['Desktop Safari'] } },
  ],
})
