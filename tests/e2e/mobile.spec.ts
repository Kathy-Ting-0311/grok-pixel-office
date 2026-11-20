import { expect, test, type Page } from '@playwright/test';

// Phone-sized viewport with touch input (iPhone 13 metrics, run in Chromium).
test.use({ viewport: { width: 390, height: 664 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true });

const shots = process.env.SHOT_DIR;
const shot = async (page: Page, name: string) => shots && page.screenshot({ path: `${shots}/${name}.png` });

async function boot(page: Page) {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto('/');
  await expect(page.getByTestId('topbar')).toBeVisible();
  await page.waitForFunction(() => (window as any).__office?.camera?.project);
  await expect(page.getByTestId('feed-label')).toHaveText('SIMULATED');
  return errors;
}

const inViewport = async (page: Page, testId: string) => {
  const box = (await page.getByTestId(testId).boundingBox())!;
  return box.x >= 0 && box.y >= 0 && box.x + box.width <= 390 && box.y + box.height <= 664;
};

test('phone: office fits, panels start closed, controls stay on screen', async ({ page }) => {
  const errors = await boot(page);
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0);
  await expect(page.getByTestId('right-panel')).toHaveCount(0);
  expect(await inViewport(page, 'topbar')).toBe(true);
  expect(await inViewport(page, 'toolbar')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
  // Whole office visible: all four floor corners project inside the screen.
  const corners = await page.evaluate(() => {
    const o = (window as any).__office;
    const l = o.store.getState().layout;
    return [
      [0, 0],
      [l.width, 0],
      [0, l.depth],
      [l.width, l.depth],
    ].map(([x, z]) => o.camera.project(x, 0, z));
  });
  for (const c of corners) {
    expect(c.x).toBeGreaterThanOrEqual(0);
    expect(c.x).toBeLessThanOrEqual(390);
  }
  await shot(page, 'm1-home');
  expect(errors).toEqual([]);
});

test('phone: one side panel at a time, modals fit the screen', async ({ page }) => {
  await boot(page);
  await page.getByRole('button', { name: 'Open sidebar' }).tap();
  await page.getByTestId('roster-mock-review-06').tap();
  await expect(page.getByTestId('right-panel')).toBeVisible();
  await expect(page.getByTestId('left-sidebar')).toHaveCount(0);
  expect(await inViewport(page, 'right-panel')).toBe(true);
  for (const m of ['settings', 'tasks', 'meeting', 'replay', 'achievements', 'customize', 'help']) {
    await page.evaluate((m) => (window as any).__office.store.getState().openModal(m), m);
    const [sw, cw] = await page.locator('[role=dialog] .overflow-auto').first().evaluate((d) => [d.scrollWidth, d.clientWidth]);
    expect(sw, `${m} modal scrolls sideways`).toBeLessThanOrEqual(cw);
  }
});

test('phone: tap a catalog item, then tap the floor to place it', async ({ page }) => {
  await boot(page);
  await page.getByTestId('build-toggle').tap();
  await expect(page.getByTestId('build-panel')).toBeVisible();
  await page.getByTestId('catalog-plant_small').tap();
  // The builder folds away so the floor can be tapped.
  await expect(page.getByTestId('build-panel')).toContainText('tap the floor');
  const count = () => page.evaluate(() => (window as any).__office.store.getState().layout.furniture.length);
  const before = await count();
  const top = (await page.getByTestId('build-panel').boundingBox())!.y;
  let placed = false;
  for (const [x, z] of [
    [6, 5],
    [7, 5],
    [9, 5],
    [10, 5],
    [6, 10],
    [9, 10],
  ]) {
    const p = await page.evaluate(([x, z]) => (window as any).__office.camera.project(x + 0.5, 0, z + 0.5), [x, z]);
    if (p.y > top - 8 || p.y < 60) continue;
    await page.touchscreen.tap(p.x, p.y);
    await page.waitForTimeout(300);
    if ((await count()) > before) {
      placed = true;
      break;
    }
  }
  expect(placed).toBe(true);
  await shot(page, 'm2-placed');
});
