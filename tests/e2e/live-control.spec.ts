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
  await expect(page.getByTestId('chat-source')).toHaveCount(0); // no source selector: xAI chat only
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

    // No send box: sending stays disabled; the reason is shown next to "Open … in Grok Bot".
    await expect(page.getByTestId('live-send-reason')).toContainText(SEND_BLOCKED_REASON);
    await expect(page.getByTestId('live-open-desktop')).toBeEnabled();

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

  test('source selector and "Open in Grok Bot": verified agent link, reading resumes, nothing sent', async ({ page }) => {
    const errors = await openBotMenu(page, ON_URL);
    await page.getByTestId('tab-talk').click(); // the Chat view (default), from the "…" menu
    await expect(page.getByTestId('chat-source-xai')).toHaveAttribute('aria-selected', 'true');
    await page.getByTestId('chat-source-live').click();
    await expect(page.getByTestId('live-tab')).toBeVisible();
    await expect(page.getByTestId('live-state')).toHaveText(/Paused|Live/, { timeout: 30000 });
    if ((await page.getByTestId('live-state').textContent()) === 'Live') {
      await page.getByTestId('live-toggle').click(); // start from paused, as after every server start
      await expect(page.getByTestId('live-state')).toHaveText('Paused');
    }
    // Record the link instead of handing it to the OS (headless Chrome must never launch an app).
    await page.evaluate(() => {
      (window as any).__links = [];
      HTMLAnchorElement.prototype.click = function () {
        (window as any).__links.push(this.href);
      };
    });
    const open = page.getByTestId('live-open-desktop');
    await expect(open).toHaveText(/Open .+ in Grok Bot/, { timeout: 30000 });
    await open.click();
    const links = await page.evaluate(() => (window as any).__links as string[]);
    expect(links).toHaveLength(1);
    expect(links[0]).toMatch(/^grokbot:\/\/app\/v1\/agent\?id=[A-Za-z0-9_-]{1,128}$/);
    await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 30000 });
    await expect(page.getByTestId('live-open-note')).toBeVisible();
    expect(stub.calls().some((a) => a[0] === 'send')).toBe(false);
    await page.getByTestId('chat-source-xai').click();
    await expect(page.getByTestId('live-tab')).toHaveCount(0);
    expect(errors).toEqual([]);
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

  test('Save as Result, Track as Task, link, Mark as Completed, Results source filter and delete', async ({ page }) => {
    const errors = await openBotMenu(page, ON_URL);
    await page.getByTestId('tab-live').click();
    await expect(page.getByTestId('live-state')).toHaveText(/Paused|Live/, { timeout: 30000 });
    if ((await page.getByTestId('live-state').textContent()) === 'Paused') await page.getByTestId('live-toggle').click();
    await expect(page.getByTestId('live-state')).toHaveText('Live', { timeout: 30000 });
    const msgs = page.getByTestId('live-msg');
    const reply = msgs.filter({ hasText: STUB_TEXT });
    const mine = msgs.filter({ hasText: '[stub] Hi Coz' });
    await expect(reply).toHaveCount(1, { timeout: 30000 });
    // The right action under the right message; none under the widget placeholder.
    await expect(reply.getByTestId('live-track-task')).toHaveCount(0);
    await expect(mine.getByTestId('live-save-result')).toHaveCount(0);
    await expect(msgs.filter({ has: page.getByTestId('live-placeholder') }).locator('button')).toHaveCount(0);

    // Save as Result: once; a second save of the same message is reported as a duplicate.
    await reply.getByTestId('live-save-result').click();
    await expect(reply.getByTestId('live-saved')).toHaveText(/Saved as #10000000\d\d/);
    const id = Number((await reply.getByTestId('live-saved').textContent())!.match(/#(\d+)/)![1]);
    const again = await page.evaluate(async (key) => {
      const r = await fetch('/api/live-control/desktop/results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key }),
      });
      return r.json();
    }, `11111111-1111-4111-8111-111111111111:t1s0`);
    expect(again).toEqual({ id, duplicate: true });

    // Track as Task; link the saved result → Result available; Mark as Completed → Completed.
    await mine.getByTestId('live-track-task').click();
    await expect(mine.getByTestId('live-tracked')).toBeVisible();
    const task = page.getByTestId('desktop-task');
    await expect(task).toHaveCount(1);
    // The stub's widget after the request is a real "asks for input" entry, so that is the state shown.
    await expect(task.getByTestId('desktop-task-state')).toHaveText('Waiting for your input');
    await task.getByTestId('desktop-task-link').selectOption(String(id));
    await expect(task.getByTestId('desktop-task-state')).toHaveText('Result available');
    await expect(task).toContainText(`result #${id}`);
    await task.getByTestId('desktop-task-complete').click();
    await expect(task.getByTestId('desktop-task-state')).toHaveText('Completed');

    // Results: Grok Desktop badge and source, source filter, View Original link, no Re-run.
    await page.evaluate(() => {
      (window as any).__links = [];
      HTMLAnchorElement.prototype.click = function () {
        (window as any).__links.push(this.href);
      };
    });
    await page.getByTestId('open-results').click();
    await expect(page.getByTestId('results-board')).toBeVisible();
    const row = page.getByTestId(`result-row-${id}`);
    await page.getByTestId('results-source').selectOption('xai');
    await expect(row).toHaveCount(0);
    await page.getByTestId('results-source').selectOption('grok-desktop');
    await expect(row).toBeVisible();
    await expect(row.getByTestId('desktop-badge')).toHaveText('Grok Desktop');
    await row.click();
    const detail = page.getByTestId('result-detail');
    await expect(detail).toContainText(STUB_TEXT);
    await expect(detail.getByTestId('desktop-source')).toContainText('in Grok Bot Desktop');
    await expect(detail.getByTestId('result-rerun')).toHaveCount(0);
    await expect(detail.getByTestId('result-pin')).toHaveAttribute('aria-pressed', 'true'); // pinned on save
    await detail.getByTestId('desktop-view-original').click();
    expect(await page.evaluate(() => (window as any).__links)).toEqual([
      'grokbot://app/v1/agent?id=11111111-1111-4111-8111-111111111111',
    ]);

    // Delete (existing control): gone from Results, and the task's link is dropped.
    await detail.getByTestId('result-delete').click();
    await page.getByTestId('result-delete-yes').click();
    await expect(row).toHaveCount(0);
    await page.getByTestId('results-close').click();
    await expect(task).not.toContainText(`result #${id}`, { timeout: 20000 });
    await expect(reply.getByTestId('live-save-result')).toBeVisible();
    expect(stub.calls().some((a) => a[0] === 'send')).toBe(false);
    expect(errors).toEqual([]);
  });
});
