import { expect, test, type Page } from '@playwright/test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createConnection } from 'node:net';
import { SEND_BLOCKED_REASON } from '../../shared/liveControl';
import { makeStubCli, STUB_TEXT } from '../fixtures/grokbot/stubCli';

// Grok Bot Live Control in the browser.
// - Flag off: the suite's own server (playwright.config pins ENABLE_GROKBOT_LIVE_CONTROL=false).
// - Flag on: this spec starts its own isolated server against a STUB CLI (never the real CLI), with
//   in-memory storage and the simulation off. Sending stays disabled (GROKBOT_LIVE_SEND_ENABLED=false).

const ON_API = 4349;
const ON_WEB = 5203;
const ON_URL = `http://127.0.0.1:${ON_WEB}`;

const portBusy = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = createConnection({ port, host: '127.0.0.1' });
    s.once('connect', () => (s.destroy(), resolve(true)));
    s.once('error', () => resolve(false));
  });

async function openBotMenu(page: Page, url: string) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto(url);
  await expect(page.getByTestId('topbar')).toBeVisible();
  await page.waitForFunction(() => (window as any).__office?.camera?.project);
  await page.evaluate(() => (window as any).__office.store.getState().select({ kind: 'bot', id: 'mock-chief-01' }));
  await expect(page.getByTestId('bot-panel')).toBeVisible();
  await page.getByTestId('bot-menu').click();
  return errors;
}

test('Live Control flag off: no Live Grok Bot view and no live-control requests', async ({ page }) => {
  const live: string[] = [];
  page.on('request', (r) => r.url().includes('/api/live-control') && live.push(r.url()));
  const errors = await openBotMenu(page, '/');
  await expect(page.getByTestId('tab-chat')).toBeVisible();
  await expect(page.getByTestId('tab-live')).toHaveCount(0);
  await page.getByTestId('tab-chat').click();
  await expect(page.getByTestId('live-tab')).toHaveCount(0);
  const status = await page.evaluate(async () => (await fetch('/api/live-control/status')).status);
  expect(status).toBe(404);
  expect(live.filter((u) => !u.endsWith('/api/live-control/status'))).toEqual([]); // only our own probe
  expect(errors.filter((e) => !/404/.test(e))).toEqual([]);
});

test.describe('Live Control flag on (stub CLI)', () => {
  let server: ChildProcess | undefined;
  let stub: ReturnType<typeof makeStubCli>;

  test.beforeAll(async () => {
    test.setTimeout(90000);
    // Created here, not at load time: Playwright also loads spec files just to list the tests.
    stub = makeStubCli();
    for (const p of [ON_API, ON_WEB])
      if (await portBusy(p)) throw new Error(`Port ${p} is in use; refusing to start a second server.`);
    server = spawn('npm', ['run', 'dev'], {
      cwd: process.cwd(),
      detached: true, // own process group, so only this server is stopped afterwards
      stdio: 'ignore',
      env: {
        ...process.env,
        OFFICE_DATABASE: ':memory:',
        OFFICE_TASKS_FILE: ':memory:',
        OFFICE_CHAT_FILE: ':memory:',
        OFFICE_RESULTS_DIR: ':memory:',
        OFFICE_PORT: String(ON_API),
        OFFICE_FRONTEND_PORT: String(ON_WEB),
        OFFICE_SIMULATION: '0',
        OFFICE_TOKEN: '',
        XAI_API_KEY: '',
        MOCK_MODE: 'true',
        ...stub.env(),
      },
    });
    const end = Date.now() + 60000;
    while (!((await portBusy(ON_API)) && (await portBusy(ON_WEB)))) {
      if (Date.now() > end) throw new Error('flag-on server did not start');
      await new Promise((r) => setTimeout(r, 300));
    }
  });

  test.afterAll(async () => {
    if (server?.pid) {
      try {
        process.kill(-server.pid, 'SIGTERM');
      } catch {
        /* already gone */
      }
    }
    stub?.cleanup();
  });

  test('read-only Live Grok Bot view: paused at start, real stub transcript, send disabled and refused', async ({
    page,
  }) => {
    const errors = await openBotMenu(page, ON_URL);
    await expect(page.getByTestId('tab-live')).toHaveText('Live Grok Bot');
    await page.getByTestId('tab-live').click();
    await expect(page.getByTestId('live-tab')).toBeVisible();
    // Every server start begins paused; nothing has been read yet, and the view says so.
    await expect(page.getByTestId('live-state')).toHaveText('Paused');
    expect(stub.calls().map((a) => a[0])).not.toContain('bots');

    await page.getByTestId('live-toggle').click();
    await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 30000 });
    const msgs = page.getByTestId('live-msg');
    await expect(msgs.filter({ hasText: STUB_TEXT })).toHaveCount(1, { timeout: 30000 });
    await expect(msgs.filter({ hasText: STUB_TEXT }).getByTestId('live-attr')).toHaveText('thread target');
    await expect(msgs.filter({ hasText: '[stub] Hi Coz' }).getByTestId('live-attr')).toHaveText('you');
    // Non-text entries are placeholders: plain text, nothing clickable.
    const ph = page.getByTestId('live-placeholder');
    await expect(ph).toHaveText('[widget]');
    await expect(ph.locator('a, button, input')).toHaveCount(0);

    await expect(page.getByTestId('live-send-input')).toBeDisabled();
    await expect(page.getByTestId('live-send-button')).toBeDisabled();
    await expect(page.getByTestId('live-send-reason')).toHaveText(SEND_BLOCKED_REASON);

    // A direct POST is refused by the server before the CLI is called.
    const r = await page.evaluate(async () => {
      const res = await fetch('/api/live-control/send', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: '11111111-1111-4111-8111-111111111111', text: 'hi', confirm: true }),
      });
      return { status: res.status, body: await res.json() };
    });
    expect(r).toEqual({ status: 403, body: { ok: false, delivery: 'refused', error: SEND_BLOCKED_REASON } });
    expect(stub.calls().some((a) => a[0] === 'send')).toBe(false);

    // Pause works and is reported.
    await page.getByTestId('live-toggle').click();
    await expect(page.getByTestId('live-state')).toHaveText('Paused');
    expect(errors.filter((e) => !/403/.test(e))).toEqual([]);
  });

  test('a reloaded page keeps live messages in the conversation panel (in-memory buffer)', async ({ page }) => {
    // The previous test read the stub transcript; this is a fresh page load against the same server.
    const errors = await openBotMenu(page, ON_URL);
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('conversation')).toContainText(STUB_TEXT);
    await page.reload();
    await page.waitForFunction(() => (window as any).__office?.camera?.project);
    await page.evaluate(() => (window as any).__office.store.getState().select({ kind: 'bot', id: 'mock-chief-01' }));
    await page.getByTestId('bot-menu').click();
    await page.getByTestId('tab-chat').click();
    await expect(page.getByTestId('conversation')).toContainText(STUB_TEXT);
    expect(errors).toEqual([]);
  });
});
