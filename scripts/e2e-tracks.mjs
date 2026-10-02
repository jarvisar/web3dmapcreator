// Imported routes in the installed Edge, including storage, sharing, edits
// and every export format. Needs a running dev or preview server.
//   node scripts/e2e-tracks.mjs <url> <out-folder> [--phone]
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';
import { chromium } from 'playwright-core';

const [url = 'http://localhost:5173/', folder = 'out/e2e-tracks'] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const phone = process.argv.includes('--phone');
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext({
  viewport: phone ? { width: 390, height: 844 } : { width: 1440, height: 900 },
  hasTouch: phone,
  isMobile: phone,
  acceptDownloads: true,
  permissions: ['clipboard-read', 'clipboard-write'],
});
const page = await context.newPage();
const errors = [];
page.on('console', (message) => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', (error) => errors.push(String(error)));
page.on('dialog', (dialog) => dialog.accept());
const tracksKey = 'jarvizar-city-model:tracks';
const savedTracks = () => page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), tracksKey);
const shot = (name) => page.screenshot({ path: join(folder, `${name}.png`) });
const routes = page.locator('#section-routes');

async function settings(open) {
  if (!phone) return;
  const button = page.getByRole('button', { name: 'Settings', exact: true });
  if ((await button.getAttribute('aria-expanded') === 'true') !== open) await button.click();
}

async function section(id) {
  await settings(true);
  const header = page.locator(`button[aria-controls="section-${id}"]`);
  if (await header.getAttribute('aria-expanded') !== 'true') await header.click();
}

async function waitTracks(count) {
  await page.waitForFunction(({ key, count }) => JSON.parse(localStorage.getItem(key) ?? '[]').length === count, { key: tracksKey, count });
}

function gpx(name, points) {
  const body = points.map(([lon, lat]) => `<trkpt lon="${lon}" lat="${lat}"/>`).join('');
  return { name: `${name}.gpx`, mimeType: 'application/gpx+xml', buffer: Buffer.from(`<!-- Exported by <planner> --><gpx><trk><name>${name}</name><trkseg>${body}</trkseg></trk></gpx>`) };
}

async function download(label, button = /^Download \./i) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.getByRole('button', { name: button }).first().click()]);
  const path = join(folder, `${label}-${file.suggestedFilename()}`);
  await file.saveAs(path);
  assert(statSync(path).size > 0, `${label} is empty`);
  console.log(`${label}: ${file.suggestedFilename()}`);
  return path;
}

function hasRoutes(path) {
  const files = unzipSync(readFileSync(path), { filter: (file) => /\.(model|config|xml)$/.test(file.name) });
  return Object.values(files).some((bytes) => /(?:name="Routes"|key="name" value="Routes")/.test(strFromU8(bytes)));
}

async function generated() {
  await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 300000, polling: 500 });
  assert.equal(await page.locator('.alert[role="alert"]').count(), 0, await page.locator('.alert[role="alert"]').allTextContents());
  await page.waitForSelector('.viewer-canvas', { timeout: 30000 });
}

try {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await section('routes');
  const loop = gpx('QA Loop', [[-87.630, 41.8785], [-87.630, 41.884], [-87.624, 41.884], [-87.624, 41.8785], [-87.630, 41.8785]]);
  const waypoint = { name: 'waypoints.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from('<gpx><wpt lat="41.88" lon="-87.63"/></gpx>') };
  await routes.getByLabel('Import route files').setInputFiles([loop, waypoint]);
  await waitTracks(1);
  assert.match(await routes.innerText(), /only has points or waypoints/);

  const name = routes.getByRole('textbox', { name: 'Route name' });
  await name.fill('.gpx');
  await name.press('Enter');
  assert.equal(await name.inputValue(), 'QA Loop', 'an empty cleaned name should restore the saved name');
  await name.fill('  QA   Route.gpx  ');
  await name.press('Enter');
  assert.equal(await name.inputValue(), 'QA Route');
  const shown = routes.getByRole('checkbox', { name: 'Show QA Route', exact: true });
  await shown.uncheck();
  await page.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? '[]')[0]?.visible === false, tracksKey);
  await page.reload();
  await section('routes');
  assert.equal(await shown.isChecked(), false, 'hidden route comes back hidden');
  await shown.check();
  await routes.getByRole('textbox', { name: 'Width', exact: true }).fill('1.2');
  await routes.getByRole('textbox', { name: 'Width', exact: true }).press('Enter');
  await routes.getByRole('checkbox', { name: 'Start and finish markers', exact: true }).uncheck();
  await routes.getByRole('button', { name: 'Reset route settings' }).click();
  await page.waitForFunction((id) => document.getElementById(id)?.value === '0.6', await routes.getByRole('textbox', { name: 'Width', exact: true }).getAttribute('id'));
  assert.equal(await routes.getByRole('textbox', { name: 'Width', exact: true }).inputValue(), '0.6');
  assert.equal(await routes.getByRole('checkbox', { name: 'Start and finish markers', exact: true }).isChecked(), true);

  const dropped = gpx('QA Trail', [[-87.637, 41.880], [-87.634, 41.881], [-87.637, 41.882]]);
  await page.locator('.app').evaluate((app, file) => {
    const dataTransfer = new DataTransfer();
    dataTransfer.items.add(new File([file.text], file.name, { type: 'application/gpx+xml' }));
    app.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer }));
  }, { name: dropped.name, text: dropped.buffer.toString() });
  await waitTracks(2);
  await routes.getByRole('button', { name: 'Fit and turn', exact: true }).click();
  await shot('1-routes');
  const before = await savedTracks();
  await page.getByRole('radio', { name: 'SVG map', exact: true }).click();
  assert.equal(await page.locator('button[aria-controls="section-routes"]').count(), 0);
  await page.getByRole('radio', { name: '3D model', exact: true }).click();
  assert.deepEqual(await savedTracks(), before, 'switching outputs preserves imported routes');

  await section('area');
  await page.getByRole('button', { name: 'Copy share link', exact: true }).click();
  const shared = await page.evaluate(() => navigator.clipboard.readText());
  assert(new URL(shared).hash.includes('&t='), 'share link includes routes');
  const options = await download('options', 'Export options');
  assert.equal(JSON.parse(readFileSync(options, 'utf8')).map.tracks.length, 2);
  await page.getByLabel('Import options file').setInputFiles(options);
  await page.waitForFunction(() => [...document.querySelectorAll('.toast')].some((toast) => toast.textContent.includes('Options and map area imported')));
  assert.equal((await savedTracks()).length, 2, 'options import does not duplicate routes');
  const recipientContext = await browser.newContext();
  try {
    const recipient = await recipientContext.newPage();
    await recipient.goto(shared);
    await recipient.waitForFunction((key) => JSON.parse(localStorage.getItem(key) ?? '[]').length === 2, tracksKey);
  } finally { await recipientContext.close(); }
  console.log('imports, names, visibility, settings, drop, fitting, sharing and options passed');

  await settings(false);
  await page.getByRole('button', { name: 'Generate model', exact: true }).click();
  await generated();
  await shot('2-model');
  await settings(true);
  await section('export');
  for (const [format, label] of [['Bambu Studio project', 'bambu'], ['PrusaSlicer project', 'prusa'], ['3MF with colours', '3mf'], ['STL, one file per colour', 'stl-zip'], ['Single STL', 'stl']]) {
    await page.getByRole('radio', { name: new RegExp(format, 'i') }).click();
    const path = await download(label);
    if (label === 'stl-zip') {
      const files = unzipSync(readFileSync(path));
      assert(Object.keys(files).some((name) => /Routes.*\.stl$/i.test(name)), 'STL zip includes routes');
      for (const bytes of Object.values(files)) assert.equal(bytes.length, 84 + 50 * new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(80, true));
    } else if (label === 'stl') {
      const bytes = readFileSync(path);
      assert.equal(bytes.length, 84 + 50 * bytes.readUInt32LE(80));
    } else assert(hasRoutes(path), `${label} includes the routes part`);
  }
  await page.getByRole('radio', { name: /3MF with colours/i }).click();
  await settings(false);
  await page.getByRole('button', { name: 'Edit the model (beta)' }).click();
  const find = page.getByRole('searchbox', { name: 'Find a street, building, water or route by name' });
  const inspector = page.locator('section.inspector');
  for (const route of ['QA Route', 'QA Trail']) {
    await find.fill(route);
    await page.locator('.find-result').filter({ hasText: route }).click();
    await inspector.getByRole('button', { name: 'Remove', exact: true }).click();
  }
  await shot('3-removed');
  assert.equal(hasRoutes(await download('removed')), false, 'removing every route removes the export part');
  await page.getByRole('button', { name: /^Undo edit/ }).click();
  assert(hasRoutes(await download('undo')), 'undo restores the route to the export');
  await shot('4-undo');
  assert.deepEqual(errors, [], 'browser console errors');
  console.log('all route exports, editor removal and undo passed; no console errors');
} catch (error) {
  await shot('failure').catch(() => {});
  console.error(error);
  if (errors.length) console.error(`console errors:\n${errors.join('\n')}`);
  process.exitCode = 1;
} finally { await browser.close(); }
