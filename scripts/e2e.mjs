// End-to-end check in the installed Edge: generate the default area, look at
// it in 3D and download it in every format. Needs a running server
// (npm run dev or npm run preview).
//   node scripts/e2e.mjs <url> <out-folder> [--all-formats] [--lidar-only [--cut-water]]
// With --lidar-only, give a small area in the URL's share-link hash
// (#a=lon,lat,width,height,rotation,shape): a fresh browser downloads its
// LiDAR in full.
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const allFormats = process.argv.includes('--all-formats');
const lidarOnly = process.argv.includes('--lidar-only');
const [url = 'http://localhost:5173/', folder = 'out/e2e'] = args;
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({
  channel: 'msedge',
  headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const started = Date.now();
await page.goto(url);
await page.waitForTimeout(3000);
await page.screenshot({ path: join(folder, '1-map.png') });

if (lidarOnly) {
  await page.locator('button[aria-controls="section-layers"]').click();
  await page.getByRole('radio', { name: 'LiDAR only' }).click();
  if (process.argv.includes('--cut-water')) await page.getByRole('checkbox', { name: /cut away water/i }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(folder, '1-lidar-only.png') });
}

await page.getByRole('button', { name: /generate model/i }).click();
// Generation is done when the progress bar goes away.
await page.waitForTimeout(1000);
await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 900000, polling: 1000 });
await page.waitForTimeout(3000);
console.log(`generated in ${((Date.now() - started) / 1000).toFixed(1)} s`);
await page.screenshot({ path: join(folder, '2-model.png') });

await page.getByRole('button', { name: 'Model details' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: join(folder, '3-details.png') });
await page.getByRole('button', { name: 'Model details' }).click();

async function download(label) {
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.getByRole('button', { name: /^download/i }).first().click(),
  ]);
  const target = join(folder, file.suggestedFilename());
  await file.saveAs(target);
  console.log(`${label}: ${file.suggestedFilename()} (${(statSync(target).size / 1e6).toFixed(1)} MB)`);
}

await download('default');

if (allFormats) {
  // Open the Export section and try each format, then multi-plate.
  const exportHeader = page.locator('button[aria-controls="section-export"]');
  await exportHeader.click();
  await page.waitForTimeout(300);
  for (const name of ['PrusaSlicer project', '3MF with colours', 'STL, one file per colour', 'Single STL']) {
    await page.getByRole('radio', { name: new RegExp(name, 'i') }).click();
    await download(name);
  }
  await page.getByRole('radio', { name: /Bambu Studio project/i }).click();
  await page.getByRole('checkbox', { name: /multi-plate/i }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(folder, '4-export-panel.png') });
  await download('Bambu multi-plate');
}
await page.screenshot({ path: join(folder, '5-after-export.png') });

console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
