import { defineConfig } from 'vitest/config';
// Tests never use a real key or the real task queue file, whatever .env contains.
export default defineConfig({
  test: { include: ['tests/unit/**/*.test.ts'], env: { XAI_API_KEY: '', MOCK_MODE: 'true', OFFICE_TASKS_FILE: ':memory:', OFFICE_CHAT_FILE: ':memory:', OFFICE_RESULTS_DIR: ':memory:', OFFICE_TOKEN: '', ENABLE_GROKBOT_LIVE_CONTROL: 'false' } },
});
