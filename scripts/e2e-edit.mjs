// The 3D editor and SVG route picking in the installed Edge, with the
// downloads opened and checked for the edits. Needs a running server
// (npm run dev or npm run preview).
//   node scripts/e2e-edit.mjs <url> <out-folder>            desktop, every export format
//   node scripts/e2e-edit.mjs <url> <out-folder> --phone    phone size and touch
//   node scripts/e2e-edit.mjs <url> <out-folder> --svg      picking roads for an SVG route
// Exits with 1 when a step fails or the page logs an error.
import { chromium } from 'playwright-core';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { strFromU8, unzipSync } from 'fflate';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const phone = process.argv.includes('--phone');
const svg = process.argv.includes('--svg');
const [url = 'http://localhost:5173/', folder = 'out/e2e-edit'] = args;
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext(
  phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, acceptDownloads: true } : { viewport: { width: 1440, height: 900 }, acceptDownloads: true },
);
const page = await context.newPage();
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));

const failures = [];
const fail = (message) => {
  failures.push(message);
  console.log(`FAILED: ${message}`);
};
const ok = (message) => console.log(`ok: ${message}`);
let shots = 0;
const shot = (name) => page.screenshot({ path: join(folder, `${String(++shots).padStart(2, '0')}-${name}.png`) });
const wait = (ms) => page.waitForTimeout(ms);
const title = () => page.locator('.inspector h3').first().innerText().catch(() => '');

async function finish() {
  console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
  if (errors.length) failures.push('console errors');
  console.log(failures.length ? `${failures.length} failed` : 'all passed');
  await browser.close();
  process.exit(failures.length ? 1 : 0);
}

async function download(label, name = /^download/i) {
  const [file] = await Promise.all([page.waitForEvent('download', { timeout: 300000 }), page.getByRole('button', { name }).first().click()]);
  const target = join(folder, `${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${file.suggestedFilename()}`);
  await file.saveAs(target);
  const size = statSync(target).size;
  console.log(`${label}: ${file.suggestedFilename()} (${(size / 1e6).toFixed(1)} MB)`);
  if (!size) fail(`${label} downloaded an empty file`);
  return target;
}

/** Taps or clicks the canvas at an offset from its middle. */
async function press(dx, dy) {
  const box = await page.locator('.viewer-canvas').boundingBox();
  const x = box.x + box.width / 2 + dx;
  const y = box.y + box.height / 2 + dy;
  if (phone) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
  await wait(500);
}

/** Presses around the middle until the inspector shows something `accept` likes. */
/** Presses around the middle until the inspector shows something `accept` likes. Returns where. */
async function pressUntil(accept, what) {
  for (const [dx, dy] of [[0, -30], [30, -10], [-40, 10], [10, 30], [-20, -50], [60, 20], [-70, -20], [0, 0], [90, -40], [-90, 40]]) {
    await press(dx, dy);
    if (await accept()) return [dx, dy];
  }
  fail(`could not select ${what}`);
  return null;
}

/** The view around an offset from the middle, with no pointer over it and nothing selected. */
async function viewAt([dx, dy]) {
  await clearSelection();
  if (!phone) await page.mouse.move(5, 5);
  await wait(600);
  const box = await page.locator('.viewer-canvas').boundingBox();
  return page.screenshot({ clip: { x: box.x + box.width / 2 + dx - 25, y: box.y + box.height / 2 + dy - 25, width: 50, height: 50 } });
}

const inspector = page.locator('section.inspector');
const isBuilding = () => inspector.getByText(/in real life/).first().isVisible();
// The toolbar, not the keys, which a phone doesn't have.
const tool = (name) => page.getByRole('button', { name: new RegExp(`^${name} \\(`) }).click();
const clearSelection = async () => {
  const close = inspector.getByRole('button', { name: 'Clear the selection (Esc)' });
  if (await close.count()) await close.click();
  await wait(200);
};

await page.goto(url);
await page.evaluate(() => localStorage.clear());
await page.goto(url);
await wait(2500);

if (svg) {
  if (phone) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('radio', { name: 'SVG map' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
  } else {
    await page.getByRole('radio', { name: 'SVG map' }).click();
  }
  await wait(800);
  await page.getByRole('button', { name: 'Generate SVG' }).click();
  await page.waitForSelector('.svg-preview', { timeout: 300000 });
  await page.waitForFunction(() => !document.querySelector('.svg-preview .spinner'), null, { timeout: 300000, polling: 500 });
  await wait(1000);
  await page.getByRole('button', { name: 'Pick roads for routes' }).click();
  await wait(400);
  const stage = await page.locator('.svg-preview').boundingBox();
  // Clicks add roads, so a few near the middle pick several.
  for (const [dx, dy] of [[0, 0], [25, 10], [-30, -15], [10, 40]]) {
    const x = stage.x + stage.width / 2 + dx;
    const y = stage.y + stage.height / 2 + dy;
    if (phone) await page.touchscreen.tap(x, y);
    else await page.mouse.click(x, y);
    await wait(250);
  }
  const heading = await page.locator('.route-card h3').innerText();
  const picked = Number(heading.match(/^(\d+)/)?.[1] ?? 0);
  if (picked >= 2) ok(`picked ${picked} lines`);
  else fail(`picked ${picked} lines, wanted at least 2 (${heading})`);
  await page.getByRole('button', { name: 'Along the road' }).click();
  await wait(300);
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.waitForFunction(() => !document.querySelector('.svg-preview .spinner'), null, { timeout: 300000, polling: 500 });
  await wait(1500);
  await shot('route');
  const file = await download('route', /download \.svg/i);
  const text = readFileSync(file, 'utf8');
  if (text.includes('id="route-1"')) ok('the SVG has the route as a group of its own');
  else fail('no route-1 group in the SVG');
  await finish();
}

await page.getByRole('button', { name: /generate model/i }).first().click();
await wait(1000);
await page.waitForFunction(() => !document.querySelector('[role="progressbar"]'), null, { timeout: 900000, polling: 1000 });
await wait(2500);
await page.getByRole('button', { name: 'Edit the model (beta)' }).click();
await wait(600);
await shot('edit-mode');

// Find a street by name and give it a layer of its own, wider and raised.
const find = page.getByPlaceholder('Find a street, building or water');
await find.fill('Michigan');
await wait(300);
// The first match that's a road, not a building or water of that name.
const results = page.locator('.find-result').filter({ hasNot: page.locator('.find-detail', { hasText: /building|water|bridge/i }) });
if (await results.count()) {
  const first = (await results.first().innerText()).replace(/\s+/g, ' ');
  await results.first().click();
  await wait(1200);
  ok(`found and selected ${first}: "${await title()}"`);
} else {
  fail('find by name found nothing for Michigan');
  await pressUntil(async () => (await inspector.getByRole('button', { name: 'Whole street' }).count()) > 0, 'a road');
}
await inspector.getByLabel('Colour', { exact: true }).selectOption({ label: 'New layer…' });
await wait(600);
await inspector.getByLabel('Width', { exact: true }).fill('1.6');
await inspector.getByLabel('Width', { exact: true }).press('Enter');
await wait(1500);
await shot('street-layer');
if ((await inspector.getByLabel('Colour', { exact: true }).inputValue()) !== '') ok('the street went into a new layer');
else fail('the street is not in the new layer');
await clearSelection();

// A building: taller, then one of its parts, then removed and back.
const spot = await pressUntil(isBuilding, 'a building');
if (spot) {
  const height = inspector.getByLabel('Height', { exact: true });
  const before = Number(await height.inputValue());
  await height.fill(String(Math.round(before * 2 + 5)));
  await height.press('Enter');
  await wait(1500);
  const hint = await inspector.getByText(/in real life/).first().innerText();
  ok(`building height ${before} mm to ${await height.inputValue()} mm (${hint})`);
  await shot('taller');
  const parts = page.locator('.parts-pick');
  if (await parts.count()) {
    await parts.first().click();
    await wait(600);
    if ((await title()).includes('(part)')) ok('picked a part from the list');
    else fail(`picking a part showed "${await title()}"`);
    await inspector.getByRole('button', { name: 'Select the whole building' }).click();
    await wait(400);
  }
  // Removed, it has to go from the view too.
  const shown = await viewAt(spot);
  await press(...spot);
  await inspector.getByRole('button', { name: 'Remove', exact: true }).click();
  await wait(700);
  const gone = await viewAt(spot);
  if (shown.equals(gone)) fail('the view did not change when the building was removed');
  else ok('the removed building went from the view');
  const undo = page.locator('.toast-action', { hasText: 'Undo' });
  if (await undo.count()) {
    await undo.first().click();
    await wait(800);
    ok('removed a building and put it back with the toast');
  } else {
    fail('no Undo on the removal toast');
  }
}

// Water left out is filled with ground up to its banks, or keeps its hollow.
await clearSelection();
// The Chicago River has no name in Overture, but these do.
const waters = page.locator('.find-result').filter({ has: page.locator('.find-detail', { hasText: /water/i }) });
for (const name of ['Ogden Slip', 'Monroe Harbor', 'Fountain']) {
  await find.fill(name);
  await wait(300);
  if (await waters.count()) break;
}
if (await waters.count()) {
  ok(`found water: ${(await waters.first().innerText()).replace(/s+/g, ' ')}`);
  await waters.first().click();
  await wait(1200);
  await inspector.getByRole('button', { name: 'Look at the selection (F)' }).click();
  await wait(1500);
  await shot('water');
  await inspector.getByRole('button', { name: 'Leave out', exact: true }).click();
  await wait(1500);
  const hollow = inspector.getByLabel('Keep the hollow');
  if (await hollow.count()) {
    ok('left the water out, and it stays selected with the hollow option');
    await shot('water-filled');
    await hollow.check();
    await wait(1500);
    if (await hollow.isChecked()) ok('kept the hollow');
    else fail('the hollow option did not stay on');
    await shot('water-hollow');
    await inspector.getByRole('button', { name: 'Put back' }).click();
    await wait(1200);
    if (!(await hollow.count())) ok('put the water back');
    else fail('the hollow option still shows after putting the water back');
  } else {
    fail('no Keep the hollow option after leaving the water out');
  }
} else {
  fail('find by name found no water');
}

// Select several: each press adds one.
await clearSelection();
await tool('Select several');
await wait(200);
for (const [dx, dy] of [[0, -30], [40, 10], [-40, 20]]) await press(dx, dy);
const several = await title();
if (/\d+ /.test(several)) ok(`select several: ${several}`);
else fail(`select several ended with "${several}"`);
await shot('several');
await clearSelection();

// Text, placed with a press and typed.
await tool('Add text');
await wait(200);
await press(-60, 60);
await wait(800);
const text = inspector.getByLabel('Text', { exact: true });
if (await text.count()) {
  await text.fill('E2E');
  await text.press('Enter');
  await wait(1200);
  ok(`added text: "${await title()}"`);
} else {
  fail('no text field after placing text');
}
await clearSelection();

// A path drawn with the drawing bar, which works without a keyboard.
await tool('Draw a road or path');
await wait(200);
for (const [dx, dy] of [[-80, 40], [0, 70], [80, 40]]) await press(dx, dy);
await shot('drawing');
await page.getByRole('button', { name: 'Finish' }).click();
await wait(1200);
if ((await title()) === 'Drawn road') ok('drew a road with Finish');
else fail(`finishing a path showed "${await title()}"`);
await clearSelection();

// Undo and redo from the toolbar.
await page.getByRole('button', { name: /^Undo/ }).first().click();
await wait(500);
await page.getByRole('button', { name: /^Redo/ }).first().click();
await wait(1500);
await shot('before-export');

// Every format, each checked for the custom layer.
const hasLayer = (file) => {
  if (file.endsWith('.stl')) return readFileSync(file).length > 84;
  const entries = unzipSync(new Uint8Array(readFileSync(file)));
  return Object.entries(entries).some(([name, data]) => /Layer[ -]1/.test(name) || (name.match(/\.(model|config|xml)$/) && strFromU8(data).includes('Layer 1')));
};
const check = (label, file) => (hasLayer(file) ? ok(`${label} has the layer`) : fail(`${label} is missing the layer`));
if (phone) {
  check('Bambu project', await download('bambu'));
} else {
  check('Bambu project', await download('bambu'));
  await page.locator('button[aria-controls="section-export"]').click();
  await wait(300);
  for (const name of ['PrusaSlicer project', '3MF with colours', 'STL, one file per colour', 'Single STL']) {
    await page.getByRole('radio', { name: new RegExp(name, 'i') }).click();
    check(name, await download(name));
  }
  await page.getByRole('radio', { name: /Bambu Studio project/i }).click();
  await page.getByRole('checkbox', { name: /multi-plate/i }).click();
  check('Bambu multi-plate', await download('bambu-sections'));
}
await finish();
