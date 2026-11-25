import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 120000,
  expect: { timeout: 20000 },
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5193',
    headless: true,
    viewport: { width: 1440, height: 900 },
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-background-timer-throttling', '--disable-renderer-backgrounding'] },
  },
  webServer: {
    command: 'npm run dev',
    // Never a real key or the real task file in browser tests.
    env: { OFFICE_DATABASE: ':memory:', OFFICE_PORT: '4339', OFFICE_FRONTEND_PORT: '5193', XAI_API_KEY: '', MOCK_MODE: 'true', OFFICE_TASKS_FILE: ':memory:', OFFICE_CHAT_FILE: ':memory:', OFFICE_RESULTS_DIR: ':memory:', OFFICE_TOKEN: '', MOCK_DELAY_MS: '250', ENABLE_GROKBOT_LIVE_CONTROL: 'false' },
    url: 'http://127.0.0.1:5193',
    reuseExistingServer: false,
    timeout: 60000,
  },
});
