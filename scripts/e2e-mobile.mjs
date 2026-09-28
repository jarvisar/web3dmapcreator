// Phone-size and dark-mode check with a real generation, in the installed Edge.
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
  await context.close();
}

await run('phone', { width: 390, height: 844 }, false);
await run('desktop-dark', { width: 1440, height: 900 }, true);
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
