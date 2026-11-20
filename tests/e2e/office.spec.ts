import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SHOT_DIR;
const shot = async (page: Page, name: string) =>
  shots && page.screenshot({ path: `${shots}/${name}.png` });

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  await page.goto('/');
  await expect(page.getByTestId('topbar')).toBeVisible();
  await page.waitForFunction(() => (window as any).__office?.camera?.project);
  await expect(page.getByTestId('feed-label')).toHaveText(/SIMULATION/);
  return errors;
}

test('first playable scene: roster, labels, simulation labelling', async ({ page }) => {
  const errors = await boot(page);
  for (const id of [
    'mock-chief-01',
    'mock-review-06',
    'mock-execution-04',
    'mock-visual-05',
    'mock-research-02',
    'mock-strategy-03',
  ])
    await expect(page.getByTestId(`roster-${id}`)).toBeVisible();
  // Wait until the simulation has produced some tasks.
  await page.waitForFunction(
    () => Object.keys((window as any).__office.store.getState().live.tasks).length > 0,
    null,
    { timeout: 30000 },
  );
  // No REAL label anywhere while only the simulation provider is active.
  const tasks = await page.evaluate(() =>
    Object.values((window as any).__office.store.getState().live.tasks).map((t: any) => t.source),
  );
  expect(new Set(tasks)).toEqual(new Set(['simulated']));
  await expect(page.locator('.head-stack .bg-emerald-600')).toHaveCount(0);
  // Head labels visible and not heavily overlapping.
  await page.waitForTimeout(1500);
  const boxes = await page
    .locator('.head-stack')
    .evaluateAll((els) =>
      els
        .filter((e) => getComputedStyle(e).opacity !== '0')
        .map((e) => e.getBoundingClientRect().toJSON()),
    );
  expect(boxes.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      expect(ox * oy, 'labels overlap').toBeLessThan(
        0.25 * Math.min(a.width * a.height, b.width * b.height),
      );
    }
  await shot(page, '01-live');
  expect(errors).toEqual([]);
});

/** Bot panel views live in the "..." menu; Chat is the default. */
const view = async (page: Page, v: 'talk' | 'profile' | 'tasks' | 'chat') => {
  await page.getByTestId('bot-menu').click();
  await page.getByTestId(`tab-${v}`).click();
};
/** Select a Bot like the roster does (a "Working" roster row re-renders and is never "stable" to click). */
const pickBot = async (page: Page, id: string) => {
  await page.evaluate(
    (id) => (window as any).__office.store.getState().select({ kind: 'bot', id }),
    id,
  );
  await expect(page.getByTestId('bot-panel')).toBeVisible();
};
/** A finished task opens the completion pop-up over the office; close it before clicking around. */
const closePopup = async (page: Page) => {
  const p = page.getByTestId('completion-popup');
  if (await p.count()) await page.keyboard.press('Escape');
  await expect(p).toHaveCount(0);
};

test('bot selection, profile and conversation', async ({ page }) => {
  await boot(page);
  await page.getByTestId('roster-mock-chief-01').click();
  await expect(page.getByTestId('bot-panel')).toContainText('Coz');
  await expect(page.getByTestId('bot-panel')).toContainText('Chief / Team Leader');
  await expect(page.getByTestId('bot-chat')).toBeVisible(); // Chat is the default view
  await view(page, 'profile');
  await expect(page.getByTestId('bot-panel')).toContainText('Specialty');
  await view(page, 'chat');
  await expect(page.getByTestId('conversation')).toBeVisible();
  await page.getByTestId('bot-menu').click();
  await page.getByRole('menuitem', { name: 'Style' }).click();
  await page.getByRole('button', { name: 'crown' }).isVisible();
  await page.getByRole('button', { name: 'headphones', exact: false }).first().isVisible();
  await page.getByRole('button', { name: 'beanie' }).click();
  await page.getByTestId('save-style').click();
  expect(
    await page.evaluate(
      () => (window as any).__office.store.getState().appearances['mock-chief-01'].hat,
    ),
  ).toBe('beanie');
  // Identity unchanged.
  expect(
    await page.evaluate(
      () => (window as any).__office.store.getState().layout.deskAssignments['mock-chief-01'],
    ),
  ).toBe('chief-desk');
  await shot(page, '02-customize');
});

test('task dashboard filters and focus', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(
    () => Object.keys((window as any).__office.store.getState().live.tasks).length >= 3,
    null,
    { timeout: 40000 },
  );
  await page.getByTestId('open-tasks').click();
  await expect(page.getByText('Completion rate', { exact: true })).toBeVisible();
  await expect(page.locator('tbody tr').first()).toBeVisible();
  await page.getByLabel('Filter by source').selectOption('real');
  await expect(page.getByText('No tasks match.')).toBeVisible();
  await page.getByLabel('Filter by source').selectOption('simulated');
  await shot(page, '03-dashboard');
  await page.locator('tbody tr').first().click();
  await expect(page.getByTestId('bot-panel')).toBeVisible();
});

test('simulated meeting gathers bots into meeting seats', async ({ page }) => {
  await boot(page);
  await page.getByTestId('open-meeting').click();
  await page.getByTestId('start-meeting').click();
  await expect(page.getByTestId('meeting-detail')).toContainText('SIMULATED');
  await page.keyboard.press('Escape');
  await page.waitForFunction(
    () => {
      const o = (window as any).__office;
      const meetings = Object.values(o.store.getState().live.meetings).filter(
        (m: any) => m.state === 'in_progress',
      ) as any[];
      if (!meetings.length) return false;
      return meetings[0].participants.every((p: string) => {
        const b = o.world.brains.get(p);
        return b.state === 'MEETING' && b.pose === 'sit' && !b.moving;
      });
    },
    null,
    { timeout: 45000 },
  );
  await shot(page, '04-meeting');
});

test('build mode: place, collide, undo, expand', async ({ page }) => {
  await boot(page);
  await page.getByTestId('build-toggle').click();
  await expect(page.getByTestId('build-panel')).toBeVisible();
  const count = () =>
    page.evaluate(() => (window as any).__office.store.getState().layout.furniture.length);
  const before = await count();
  await page.getByTestId('catalog-plant_small').click();
  // Free tile (3,10) in the work area.
  const p = await page.evaluate(() => (window as any).__office.camera.project(3.5, 0, 10.5));
  await page.mouse.move(p.x, p.y);
  await page.mouse.click(p.x, p.y);
  await expect.poll(count).toBe(before + 1);
  // Occupied tile (desk at 1,7) is refused.
  const q = await page.evaluate(() => (window as any).__office.camera.project(1.5, 0, 7.5));
  await page.mouse.click(q.x, q.y);
  await expect.poll(count).toBe(before + 1);
  await shot(page, '05-build');
  await page.keyboard.press('Control+z');
  await expect.poll(count).toBe(before);
  await page.getByTestId('expand-east').click();
  await expect
    .poll(() => page.evaluate(() => (window as any).__office.store.getState().layout.width))
    .toBe(17);
  await page.getByTestId('build-toggle').click();
  await expect(page.getByTestId('left-sidebar')).toBeVisible();
});

test('replay demo plays in order and is labelled', async ({ page }) => {
  await boot(page);
  await page.getByTestId('open-replay').click();
  await page.getByTestId('replay-demo').click();
  await expect(page.getByTestId('replay-bar')).toContainText('REPLAYED');
  await expect(page.getByTestId('feed-label')).toHaveText('REPLAY');
  await page.getByRole('button', { name: '4×' }).click();
  await page.getByTestId('replay-play').click();
  await page.waitForFunction(
    () =>
      Object.keys((window as any).__office.store.getState().replay?.state.tasks ?? {}).length > 0,
    null,
    { timeout: 30000 },
  );
  const sources = await page.evaluate(() =>
    Object.values((window as any).__office.store.getState().replay.state.tasks).map(
      (t: any) => t.source,
    ),
  );
  expect(new Set(sources)).toEqual(new Set(['replayed']));
  await shot(page, '06-replay');
  await page.getByRole('button', { name: 'Exit replay' }).click();
  await expect(page.getByTestId('feed-label')).toHaveText(/SIMULATION/);
});

test('characters never stand inside blocked tiles; camera controls respond', async ({ page }) => {
  await boot(page);
  for (let i = 0; i < 10; i++) {
    await page.waitForTimeout(800);
    const bad = await page.evaluate(() => {
      const o = (window as any).__office;
      return [...o.world.brains.values()]
        .filter(
          (b: any) =>
            o.world.grid.cells[Math.floor(b.z) * o.world.grid.width + Math.floor(b.x)] === 2,
        )
        .map((b: any) => b.id);
    });
    expect(bad).toEqual([]);
  }
  const zoom = () => page.evaluate(() => (window as any).__office.camera.zoomLevel());
  const z0 = await zoom();
  await page.getByRole('button', { name: 'Zoom in' }).click();
  await expect.poll(zoom).toBeGreaterThan(z0 + 1);
  await page.getByTestId('open-settings').click();
  await page.getByTestId('stats-toggle').check();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('stats')).toContainText('Draw calls');
  await page.waitForTimeout(1500);
  await shot(page, '07-stats');
});

test('place a task: inline validation, live thread, Bot works at its desk (MOCK_MODE)', async ({
  page,
}) => {
  const errors = await boot(page);
  page.on('dialog', (d) => errors.push(`dialog: ${d.message()}`));
  await page.getByTestId('roster-mock-research-02').click();
  await view(page, 'chat');
  await expect(page.getByTestId('task-cost')).toContainText('MOCK_MODE');
  await page.getByTestId('task-send').click();
  await expect(page.getByTestId('task-error')).toHaveText('Give the task a title.');
  await page.getByLabel('Task title').fill('Summarise three releases');
  await page.getByLabel('Agent').selectOption('mock-research-02');
  await page.getByLabel('Priority').selectOption('high');
  await page.getByLabel('Task title').press('Enter');
  const status = page.locator('[data-testid^=thread-status-]').first();
  await expect(status).toHaveText('running', { timeout: 10000 });
  // The placed task drives the existing work animation: walking to the desk, then working/thinking there.
  await page.waitForFunction(() =>
    ['WALKING_TO_DESK', 'WORKING', 'THINKING'].includes(
      (window as any).__office.world.brains.get('mock-research-02').state,
    ),
  );
  await expect(status).toHaveText('done', { timeout: 20000 });
  await expect(page.getByTestId('completion-popup')).toBeVisible();
  await closePopup(page);
  const thread = page.locator('[data-testid^=thread-]').first();
  await expect(thread).toContainText('SIMULATED');
  await expect(thread).toContainText('MOCK_MODE');
  await shot(page, '08-placed-task');
  expect(errors).toEqual([]);
});

test('chat with a Bot: streamed reply, places a task, history survives view switch (MOCK_MODE)', async ({
  page,
}) => {
  const errors = await boot(page);
  page.on('dialog', (d) => errors.push(`dialog: ${d.message()}`));
  await pickBot(page, 'mock-execution-04');
  await expect(page.getByTestId('chat-status')).toContainText('SIMULATED');
  await page.getByTestId('chat-input').fill('Hi Lena, how is your day?');
  await page.getByTestId('chat-input').press('Enter');
  await expect(page.getByTestId('chat-user')).toHaveCount(1);
  await expect(page.getByTestId('chat-bot').last()).toContainText("Hi, I'm Lena", {
    timeout: 15000,
  });
  // Shift+Enter adds a line instead of sending.
  await page.getByTestId('chat-input').fill('Please write three captions');
  await page.getByTestId('chat-input').press('Shift+Enter');
  await page.getByTestId('chat-input').type('for Friday');
  await expect(page.getByTestId('chat-input')).toHaveValue(
    'Please write three captions\nfor Friday',
  );
  await page.getByTestId('chat-send').click();
  await expect(page.locator('[data-testid^=task-card-]').first()).toContainText('Please write', {
    timeout: 15000,
  });
  await expect(page.getByTestId('chat-bot')).toHaveCount(2, { timeout: 15000 });
  await expect(page.getByTestId('completion-popup')).toBeVisible({ timeout: 20000 });
  await closePopup(page);
  // History reloads from the server after leaving and returning.
  await view(page, 'profile');
  await page.getByTestId('back-to-chat').click();
  await expect(page.getByTestId('chat-user')).toHaveCount(2);
  await view(page, 'chat');
  await expect(page.getByText('Please write three captions').first()).toBeVisible();
  expect(errors).toEqual([]);
});

test('chat to task to result: 3 /task messages, pop-up queue, Results board (MOCK_MODE)', async ({
  page,
}) => {
  const errors = await boot(page);
  page.on('dialog', (d) => errors.push(`dialog: ${d.message()}`));
  await pickBot(page, 'mock-visual-05');
  const input = page.getByTestId('chat-input');
  for (const t of ['/task Make a picture of the team', '/task Write a code script', '/task Notes'])
    await input.fill(t).then(() => input.press('Enter'));
  // "Make it a task" toggle: the first line is the title, the rest the details.
  await page.getByTestId('make-task').click();
  await input.fill('Weekly summary');
  await input.press('Shift+Enter');
  await input.type('Three bullets');
  await input.press('Enter');
  await expect(page.locator('[data-testid^=task-card-]')).toHaveCount(4);
  const popup = page.getByTestId('completion-popup');
  await expect(popup).toBeVisible({ timeout: 20000 });
  await expect(page.getByTestId('popup-pager')).toContainText('of 4', { timeout: 20000 });
  await expect(popup).toHaveCount(1); // one window, never stacked
  await expect(page.getByTestId('popup-title')).toContainText('Make a picture');
  await expect(popup.locator('img')).toBeVisible();
  await page.getByLabel('Next result').click();
  await expect(page.getByTestId('popup-title')).toContainText('Write a code script');
  await expect(popup.getByTestId('copy-btn').first()).toBeVisible();
  await expect(popup.locator('pre')).toContainText('def main');
  await page.keyboard.press('Escape');
  await expect(popup).toHaveCount(0);
  await expect(page.getByTestId('chat-task-status').filter({ hasText: 'done' })).toHaveCount(4);

  // Results board: live list, filters, search, unread dots, pin, re-run, delete.
  // (Other tests share this server, so everything is scoped to Oom's results.)
  await expect(page.getByTestId('results-unread')).toBeVisible();
  await page.getByTestId('open-results').click();
  await page.getByLabel('Agent filter').selectOption('mock-visual-05');
  const rows = page.locator('[data-testid^=result-row-]');
  const row = (text: string) => rows.filter({ hasText: text });
  await expect(rows).toHaveCount(4);
  await expect(row('Notes').getByTestId('unread-dot')).toBeVisible(); // never opened
  await expect(row('Make a picture').getByTestId('unread-dot')).toHaveCount(0); // seen in the pop-up
  await page.getByTestId('results-search').fill('weekly');
  await expect(rows).toHaveCount(1);
  await rows.first().click();
  await expect(page.getByTestId('result-detail')).toContainText('Three bullets');
  await page.getByTestId('results-search').fill('');
  await page.getByTestId('results-type').selectOption('code');
  await expect(rows).toHaveCount(1);
  await page.getByTestId('results-type').selectOption('');
  await page.getByTestId('results-status').selectOption('failed');
  await expect(rows).toHaveCount(0);
  await page.getByTestId('results-status').selectOption('');
  await row('Notes').click();
  await page.getByTestId('result-pin').click();
  await expect(page.getByTestId('result-pin')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('result-rerun').click();
  await expect(popup).toBeVisible({ timeout: 20000 });
  await page.keyboard.press('Escape'); // closes only the pop-up
  await expect(page.getByTestId('results-board')).toBeVisible();
  await expect(rows).toHaveCount(5);
  await row('Write a code script').click();
  await page.getByTestId('result-delete').click();
  await page.getByTestId('result-delete-yes').click();
  await expect(row('Write a code script')).toHaveCount(0);
  await expect(rows).toHaveCount(4);
  await shot(page, '09-results-board');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('results-board')).toHaveCount(0);
  expect(errors).toEqual([]);
});
