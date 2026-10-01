// End-to-end check in the installed Edge: generate the default area, look at
// it in 3D and download it in every format. Needs a running server
// (npm run dev or npm run preview).
//   node scripts/e2e.mjs <url> <out-folder> [--all-formats] [--lidar-only [--cut-water | --water-layer] [--cell m]]
//   node scripts/e2e.mjs <url> <out-folder> --svg [--all-formats]
// With --lidar-only, give a small area in the URL's share-link hash
// (#a=lon,lat,width,height,rotation,shape): a fresh browser downloads its
// LiDAR in full. With --svg it makes an SVG map of the default area instead,
// and --all-formats downloads it for the plotter and print as well. Exits
// with 1 when a step fails, a download is empty or the page logs an error.
import { chromium } from 'playwright-core';
import { mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cellIndex = process.argv.indexOf('--cell');
const cellM = cellIndex > 0 ? process.argv[cellIndex + 1] : null;
const args = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--cell');
const allFormats = process.argv.includes('--all-formats');
const lidarOnly = process.argv.includes('--lidar-only');
const svg = process.argv.includes('--svg');
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

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.log(`FAILED: ${message}`);
};

// Saved under the label too: several formats are .3mf with the same name.
async function download(label, name = /^download/i) {
  const [file] = await Promise.all([
    page.waitForEvent('download', { timeout: 300000 }),
    page.getByRole('button', { name }).first().click(),
  ]);
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  const target = join(folder, `${slug}-${file.suggestedFilename()}`);
  await file.saveAs(target);
  const size = statSync(target).size;
  console.log(`${label}: ${file.suggestedFilename()} (${(size / 1e6).toFixed(1)} MB)`);
  if (size === 0) fail(`${label} downloaded an empty file`);
}

// An error the app shows, which a finished progress bar says nothing about.
async function checkNoAlert(step) {
  const alert = page.locator('.alert[role="alert"]');
  if (await alert.count()) fail(`${step}: ${(await alert.first().innerText()).replace(/\s+/g, ' ')}`);
}

async function finish() {
  console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
  if (errors.length) failures.push('console errors');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

const started = Date.now();
await page.goto(url);
await page.waitForTimeout(3000);
await page.screenshot({ path: join(folder, '1-map.png') });

if (svg) {
  await page.getByRole('radio', { name: 'SVG map' }).click();
  await page.waitForTimeout(1000);
  await page.screenshot({ path: join(folder, '1-svg-map.png') });
  await page.getByRole('button', { name: 'Generate SVG' }).click();
  // The preview opens when the SVG is done.
  await page.waitForSelector('.svg-preview', { timeout: 300000 });
  await page.waitForTimeout(2000);
  await checkNoAlert('SVG');
  console.log(`generated in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  await page.screenshot({ path: join(folder, '2-svg-preview.png') });
  await page.getByRole('button', { name: 'SVG details' }).click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(folder, '3-svg-details.png') });
  await download('laser', /download \.svg/i);
  if (allFormats) {
    for (const mode of ['Plotter', 'Print']) {
      await page.getByRole('radio', { name: mode, exact: true }).click();
      // The open preview follows the settings, so wait for it to catch up.
      await page.waitForTimeout(1000);
      await page.waitForFunction(() => !document.querySelector('.svg-preview .spinner'), null, { timeout: 300000, polling: 500 });
      await page.screenshot({ path: join(folder, `4-svg-${mode.toLowerCase()}.png`) });
      await checkNoAlert(mode);
      await download(mode.toLowerCase(), /download \.svg/i);
    }
  }
  await finish();
}

if (lidarOnly) {
  await page.locator('button[aria-controls="section-layers"]').click();
  await page.getByRole('radio', { name: 'LiDAR only' }).click();
  const water = process.argv.includes('--cut-water') ? 'Cut away' : process.argv.includes('--water-layer') ? 'Thin layer' : null;
  if (water) await page.getByRole('combobox', { name: /^water$/i }).selectOption({ label: water });
  if (cellM) {
    await page.getByRole('combobox', { name: /^grid cells$/i }).selectOption({ label: 'Metres on the ground' });
    const input = page.getByRole('textbox', { name: /^cell size$/i });
    await input.fill(cellM);
    await input.press('Enter');
  }
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
await checkNoAlert('Generate');
if (!(await page.getByRole('button', { name: 'Model details' }).isVisible())) {
  fail('no model after generating');
  await finish();
}

await page.getByRole('button', { name: 'Model details' }).click();
await page.waitForTimeout(500);
await page.screenshot({ path: join(folder, '3-details.png') });
await page.getByRole('button', { name: 'Model details' }).click();

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

await finish();
