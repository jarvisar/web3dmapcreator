// Phone-size and dark-mode checks with real generations, in the installed Edge:
// a 3D model on a phone and a desktop in dark mode, then an SVG map on a phone.
// Exits with 1 when one doesn't finish, shows an error or the page logs one.
//   node scripts/e2e-mobile.mjs <url> <out-folder>
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

const [url = 'http://localhost:5173/', folder = 'out/e2e-mobile'] = process.argv.slice(2);
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const errors = [];
const failures = [];

async function checkNoAlert(page, name) {
  const alert = page.locator('.alert[role="alert"]');
  if (await alert.count()) failures.push(`${name}: ${(await alert.first().innerText()).replace(/\s+/g, ' ')}`);
}

async function run(name, viewport, dark) {
  const context = await browser.newContext({ viewport, hasTouch: viewport.width < 600, isMobile: viewport.width < 600 });
  const page = await context.newPage();
  if (dark) await page.emulateMedia({ colorScheme: 'dark' });
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  await page.goto(url);
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(folder, `${name}-1-map.png`) });
  await page.getByRole('button', { name: /generate model/i }).first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(folder, `${name}-2-progress.png`) });
  await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 300000, polling: 1000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(folder, `${name}-3-model.png`) });
  // The progress bar also goes when generating fails.
  await checkNoAlert(page, name);
  if (!(await page.getByRole('button', { name: 'Model details' }).isVisible())) failures.push(`${name}: no model after generating`);
  await context.close();
}

// The settings drawer covers the map on a phone, so the output is picked in it.
async function runSvg(name, viewport) {
  const context = await browser.newContext({ viewport, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  page.on('console', (m) => m.type() === 'error' && errors.push(`${name}: ${m.text()}`));
  page.on('pageerror', (e) => errors.push(`${name}: ${e}`));
  await page.goto(url);
  await page.waitForTimeout(3000);
  const drawer = page.getByRole('button', { name: 'Settings', exact: true });
  await drawer.click();
  await page.getByRole('radio', { name: 'SVG map' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(folder, `${name}-1-drawer.png`) });
  await drawer.click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(folder, `${name}-2-map.png`) });
  await page.getByRole('button', { name: 'Generate SVG' }).click();
  await page.waitForSelector('.svg-preview', { timeout: 300000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(folder, `${name}-3-preview.png`) });
  await checkNoAlert(page, name);
  await context.close();
}

await run('phone', { width: 390, height: 844 }, false);
await run('desktop-dark', { width: 1440, height: 900 }, true);
await runSvg('phone-svg', { width: 390, height: 844 });
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
for (const failure of failures) console.log(`FAILED: ${failure}`);
await browser.close();
process.exit(errors.length || failures.length ? 1 : 0);
