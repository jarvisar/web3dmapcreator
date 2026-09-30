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

  // Undo all picks keeps them aside, and Reset all settings leaves them alone.
  const storedLines = () =>
    page.evaluate(() => {
      const picks = JSON.parse(localStorage.getItem('jarvizar-city-model:picks') ?? '{}');
      return (picks.routes ?? []).reduce((n, r) => n + r.lines.length, 0) + (picks.hiddenLines ?? []).length;
    });
  const card = page.locator('.route-card');
  await card.getByRole('button', { name: 'Undo all picks' }).click();
  await wait(600);
  if (await card.getByText(/are kept aside/).count()) ok('Undo all picks kept them aside');
  else fail('no kept-aside note after Undo all picks');
  await card.getByRole('button', { name: 'Put them back' }).click();
  await wait(600);
  if ((await card.getByRole('button', { name: 'Undo all picks' }).count()) && !(await card.getByText(/are kept aside/).count())) ok('put the picks back');
  else fail('the picks did not come back from the note');
  await wait(1500);
  const lines = await storedLines();
  if (!phone) {
    await page.getByRole('button', { name: 'Reset all settings' }).click();
    await page.getByRole('button', { name: /Click again to reset/ }).click();
    await wait(1500);
    const after = await storedLines();
    if (lines > 0 && after === lines) ok(`Reset all settings kept the ${lines} picked lines`);
    else fail(`Reset all settings left ${after} of ${lines} picked lines`);
  }
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

if (!phone) {
  // Undo all keeps the edits aside, and a share link's edits are added to the
  // ones here, whether it's opened in this tab or another.
  const changes = async () => {
    const text = (await inspector.locator('.inspector-changes span').first().innerText().catch(() => '')).trim();
    return text.startsWith('No changes') ? 0 : Number(text.match(/^(\d+)/)?.[1] ?? NaN);
  };
  const stored = () => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('jarvizar-city-model:edits') ?? '{}').objects ?? {}).length);
  const removeBuilding = async (what) => {
    await page.getByRole('button', { name: 'Reset view' }).click();
    await wait(800);
    if (!(await pressUntil(isBuilding, what))) return;
    await inspector.getByRole('button', { name: 'Remove', exact: true }).click();
    await wait(1200);
    await clearSelection();
  };
  await clearSelection();
  const all = await changes();
  await page.evaluate(() => {
    navigator.clipboard.writeText = async (text) => {
      window.__copied = text;
    };
  });
  await page.getByRole('button', { name: 'Copy share link' }).click();
  await wait(500);
  const link = await page.evaluate(() => window.__copied);
  if (link && /[#&]e=/.test(link)) ok(`the share link carries the ${all} changes`);
  else fail(`the share link has no edits: ${link}`);

  const kept = inspector.getByText(/are kept aside/);
  await inspector.getByRole('button', { name: 'Undo all' }).click();
  await wait(1000);
  if ((await changes()) === 0 && (await kept.count())) ok('Undo all kept the edits aside');
  else fail(`after Undo all: ${await changes()} changes, ${await kept.count()} notes`);
  await inspector.getByRole('button', { name: 'Put them back' }).click();
  await wait(1500);
  if ((await changes()) === all && !(await kept.count())) ok('put the edits back from the note');
  else fail(`putting them back left ${await changes()} changes of ${all}`);

  // Opened over other work in this tab, and taken back out with Undo.
  await inspector.getByRole('button', { name: 'Undo all' }).click();
  await wait(800);
  await removeBuilding('a building to remove');
  const mine = await changes();
  await page.evaluate((hash) => {
    location.hash = hash;
  }, new URL(link).hash);
  await wait(2000);
  const fromLink = page.locator('.toast', { hasText: /from the link/ });
  const merged = await changes();
  if ((await fromLink.count()) && merged > mine) ok(`opened the link over ${mine} changes, now ${merged}: ${await fromLink.first().innerText()}`);
  else fail(`the link left ${merged} changes, had ${mine}`);
  await fromLink.first().locator('.toast-action').click();
  await wait(1500);
  if ((await changes()) === mine) ok('Undo took the link back out');
  else fail(`Undo on the link left ${await changes()} changes, wanted ${mine}`);

  // An idle tab closing doesn't write its old copy over this tab's edits.
  const idle = await context.newPage();
  await idle.goto(url);
  await idle.waitForTimeout(2500);
  await removeBuilding('another building to remove');
  await wait(1500);
  const saved = await stored();
  await idle.close({ runBeforeUnload: true });
  await wait(800);
  if (saved > mine && (await stored()) === saved) ok(`an idle tab closed and left this tab's ${saved} saved edits alone`);
  else fail(`an idle tab closing left ${await stored()} saved edits, this tab had saved ${saved}`);

  // The link in a new tab is added to what's saved, and this tab takes it on.
  const before = await changes();
  const other = await context.newPage();
  await other.goto(link);
  await other.waitForTimeout(3000);
  const otherToast = await other.locator('.toast', { hasText: /from the link/ }).first().innerText().catch(() => '');
  await wait(1500);
  const after = await changes();
  if (otherToast && after > before) ok(`a new tab opened the link (${otherToast.trim()}), and this one took on its edits: ${before} to ${after}`);
  else fail(`a new tab with the link showed "${otherToast}", this tab went from ${before} to ${after} changes`);
  await other.close();
  await wait(500);

  // A building in the custom layer shows, and downloads, with the model's parts hidden.
  await page.getByRole('button', { name: 'Reset view' }).click();
  await wait(800);
  const layered = await pressUntil(isBuilding, 'a building for the layer');
  if (layered) {
    await inspector.getByLabel('Colour', { exact: true }).selectOption({ label: 'Layer 1' });
    await wait(1500);
    await page.getByRole('button', { name: 'Parts', exact: true }).click();
    await wait(400);
    const rows = page.locator('section.parts-card .parts-list li');
    const custom = rows.filter({ has: page.locator('.part-count', { hasText: /^Custom$/ }) });
    for (let i = 0; i < (await rows.count()); i++) {
      const row = rows.nth(i);
      if ((await row.locator('.part-count').innerText()) !== 'Custom') await row.locator('input[type="checkbox"]').uncheck();
    }
    await wait(1500);
    const downloadButton = page.getByRole('button', { name: /^Download/ });
    const note = await page.locator('.result-note').innerText().catch(() => '');
    const withLayer = await viewAt(layered);
    await shot('only-the-layer');
    if (!(await downloadButton.isDisabled()) && /left out of the download/.test(note)) ok(`only the custom layer shown, it still downloads: ${note}`);
    else fail(`only the custom layer shown: download disabled ${await downloadButton.isDisabled()}, note "${note}"`);
    await custom.first().locator('input[type="checkbox"]').uncheck();
    await wait(1500);
    if ((await downloadButton.isDisabled()) && (await page.locator('.viewer-empty').count())) ok('with the layer hidden too, there is nothing to download');
    else fail('with every part hidden, download is still offered');
    await page.addStyleTag({ content: '.viewer-empty { display: none !important; }' });
    const withoutLayer = await viewAt(layered);
    if (withLayer.equals(withoutLayer)) fail('the building in the custom layer went with the hidden buildings');
    else ok('the building in the custom layer showed with the buildings hidden');
    await page.locator('section.parts-card').getByRole('button', { name: 'Show all' }).click();
    await wait(1500);
    await page.getByRole('button', { name: 'Parts', exact: true }).click();
    await wait(400);
  }
}
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
