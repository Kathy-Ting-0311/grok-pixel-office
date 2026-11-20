import { expect, test, type Page } from '@playwright/test';

const shots = process.env.SHOT_DIR;
const shot = async (page: Page, name: string) => shots && page.screenshot({ path: `${shots}/${name}.png` });

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
  for (const id of ['mock-chief-01', 'mock-review-06', 'mock-execution-04', 'mock-visual-05', 'mock-research-02', 'mock-strategy-03'])
    await expect(page.getByTestId(`roster-${id}`)).toBeVisible();
  // Wait until the simulation has produced some tasks.
  await page.waitForFunction(() => Object.keys((window as any).__office.store.getState().live.tasks).length > 0, null, { timeout: 30000 });
  // No REAL label anywhere while only the simulation provider is active.
  const tasks = await page.evaluate(() => Object.values((window as any).__office.store.getState().live.tasks).map((t: any) => t.source));
  expect(new Set(tasks)).toEqual(new Set(['simulated']));
  await expect(page.locator('.head-stack .bg-emerald-600')).toHaveCount(0);
  // Head labels visible and not heavily overlapping.
  await page.waitForTimeout(1500);
  const boxes = await page.locator('.head-stack').evaluateAll((els) =>
    els.filter((e) => getComputedStyle(e).opacity !== '0').map((e) => e.getBoundingClientRect().toJSON()),
  );
  expect(boxes.length).toBeGreaterThanOrEqual(4);
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i];
      const b = boxes[j];
      const ox = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
      const oy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
      expect(ox * oy, 'labels overlap').toBeLessThan(0.25 * Math.min(a.width * a.height, b.width * b.height));
    }
  await shot(page, '01-live');
  expect(errors).toEqual([]);
});

test('bot selection, profile and conversation', async ({ page }) => {
  await boot(page);
  await page.getByTestId('roster-mock-chief-01').click();
  await expect(page.getByTestId('bot-panel')).toContainText('Coz');
  await expect(page.getByTestId('bot-panel')).toContainText('Chief / Team Leader');
  await page.getByRole('button', { name: 'Conversation' }).click();
  await expect(page.getByTestId('conversation')).toBeVisible();
  await page.getByRole('button', { name: 'Style' }).first().click();
  await page.getByRole('button', { name: 'crown' }).isVisible();
  await page.getByRole('button', { name: 'headphones', exact: false }).first().isVisible();
  await page.getByRole('button', { name: 'beanie' }).click();
  await page.getByTestId('save-style').click();
  expect(await page.evaluate(() => (window as any).__office.store.getState().appearances['mock-chief-01'].hat)).toBe('beanie');
  // Identity unchanged.
  expect(await page.evaluate(() => (window as any).__office.store.getState().layout.deskAssignments['mock-chief-01'])).toBe('chief-desk');
  await shot(page, '02-customize');
});

test('task dashboard filters and focus', async ({ page }) => {
  await boot(page);
  await page.waitForFunction(() => Object.keys((window as any).__office.store.getState().live.tasks).length >= 3, null, { timeout: 40000 });
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
      const meetings = Object.values(o.store.getState().live.meetings).filter((m: any) => m.state === 'in_progress') as any[];
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
  const count = () => page.evaluate(() => (window as any).__office.store.getState().layout.furniture.length);
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
  await expect.poll(() => page.evaluate(() => (window as any).__office.store.getState().layout.width)).toBe(17);
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
  await page.waitForFunction(() => Object.keys((window as any).__office.store.getState().replay?.state.tasks ?? {}).length > 0, null, { timeout: 30000 });
  const sources = await page.evaluate(() => Object.values((window as any).__office.store.getState().replay.state.tasks).map((t: any) => t.source));
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
      return [...o.world.brains.values()].filter((b: any) => o.world.grid.cells[Math.floor(b.z) * o.world.grid.width + Math.floor(b.x)] === 2).map((b: any) => b.id);
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
