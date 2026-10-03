// The route editor on the map in the installed Edge: a sample route, dragging
// points and the line, undo, selecting and stepping with the keys, cutting a
// section, trimming, reversing, snapping a wobbly recording, and drawing a
// route along the roads. Needs a running dev or preview server and a
// connection for the roads.
//   node scripts/e2e-route-edit.mjs <url> <out-folder> [--phone]
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

const [url = 'http://localhost:5173/', folder = 'out/e2e-route-edit'] = process.argv.slice(2).filter((arg) => !arg.startsWith('--'));
const phone = process.argv.includes('--phone');
mkdirSync(folder, { recursive: true });
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const context = await browser.newContext(phone ? { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true } : { viewport: { width: 1440, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('console', (message) => message.type() === 'error' && errors.push(message.text()));
page.on('pageerror', (error) => errors.push(String(error)));
const tracksKey = 'jarvizar-city-model:tracks';
const shot = (name) => page.screenshot({ path: join(folder, `${name}.png`) });
const card = page.locator('.track-edit-card');

function decode(text) {
  const out = [];
  let i = 0;
  let lat = 0;
  let lon = 0;
  const next = () => {
    let result = 0;
    let shift = 0;
    let b;
    do {
      b = text.charCodeAt(i++) - 63;
      result |= (b & 0x1f) << shift;
      shift += 5;
    } while (b >= 0x20);
    return result & 1 ? ~(result >> 1) : result >> 1;
  };
  while (i < text.length) {
    lat += next();
    lon += next();
    out.push([lon / 1e6, lat / 1e6]);
  }
  return out;
}

const metres = (a, b) => {
  const k = Math.cos((a[1] * Math.PI) / 180);
  return Math.hypot((b[0] - a[0]) * k, b[1] - a[1]) * 111_320;
};
const lengthOf = (lines) => lines.reduce((sum, line) => sum + line.slice(1).reduce((s, p, i) => s + metres(line[i], p), 0), 0);

async function saved() {
  return page.evaluate((key) => JSON.parse(localStorage.getItem(key) ?? '[]'), tracksKey);
}

async function waitSaved(test, what) {
  for (let i = 0; i < 50; i++) {
    const tracks = await saved();
    if (test(tracks)) return tracks;
    await page.waitForTimeout(100);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function settings(open) {
  if (!phone) return;
  const button = page.getByRole('button', { name: 'Settings', exact: true });
  if ((await button.getAttribute('aria-expanded')) === 'true' !== open) await button.click();
}

async function routesSection() {
  await settings(true);
  const header = page.locator('button[aria-controls="section-routes"]');
  if ((await header.getAttribute('aria-expanded')) !== 'true') await header.click();
}

/** Handles on screen, in page pixels. */
async function handles() {
  const box = await page.locator('.map-host').boundingBox();
  const spots = await page.$$eval('.track-editor .track-handle', (els) =>
    els.map((el) => ({
      x: Number(el.getAttribute('cx') ?? Number(el.getAttribute('x')) + Number(el.getAttribute('width')) / 2),
      y: Number(el.getAttribute('cy') ?? Number(el.getAttribute('y')) + Number(el.getAttribute('height')) / 2),
      cls: el.getAttribute('class'),
    })),
  );
  return spots.map((s) => ({ ...s, x: s.x + box.x, y: s.y + box.y }));
}

/** A test for spots on the map clear of the card and the controls. */
async function inTheOpen() {
  const map = await page.locator('.map-host').boundingBox();
  const panel = await card.boundingBox();
  const margin = 40;
  return (h) =>
      h.x > map.x + margin &&
      h.x < map.x + map.width - 60 &&
      h.y > map.y + 100 &&
      h.y < map.y + map.height - margin &&
      !(panel && h.x > panel.x - 20 && h.x < panel.x + panel.width + 20 && h.y > panel.y - 20 && h.y < panel.y + panel.height + 20);
}

async function clearHandles() {
  return (await handles()).filter(await inTheOpen());
}

/** A handle in the middle of the route that's on screen and clear of the panels. */
async function middleHandle() {
  const spots = (await clearHandles()).filter((h) => !/is-start|is-finish|is-dragged/.test(h.cls));
  assert(spots.length, 'no handle on screen');
  return spots[Math.floor(spots.length / 2)];
}

async function cdp() {
  return context.newCDPSession(page);
}

async function drag(from, to) {
  if (!phone) {
    await page.mouse.move(from.x, from.y);
    await page.mouse.down();
    for (let k = 1; k <= 8; k++) await page.mouse.move(from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
    await page.mouse.up();
    return;
  }
  const session = await cdp();
  const touch = (type, x, y) => session.send('Input.dispatchTouchEvent', { type, touchPoints: type === 'touchEnd' ? [] : [{ x, y }] });
  await touch('touchStart', from.x, from.y);
  for (let k = 1; k <= 8; k++) await touch('touchMove', from.x + ((to.x - from.x) * k) / 8, from.y + ((to.y - from.y) * k) / 8);
  await touch('touchEnd');
  await session.detach();
}

async function tap(x, y) {
  if (phone) await page.touchscreen.tap(x, y);
  else await page.mouse.click(x, y);
}

const undoKeys = process.platform === 'darwin' ? 'Meta+z' : 'Control+z';

try {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.goto(url);
  await page.waitForTimeout(1500);

  // A sample route, then the editor on it from its row.
  await routesSection();
  await page.locator('select[aria-label="Add a sample route"]').selectOption('chicago-riverwalk.gpx');
  const [sample] = await waitSaved((t) => t.length === 1, 'the sample route');
  assert.equal(sample.name, 'Chicago Riverwalk');
  await page.getByRole('button', { name: 'Edit Chicago Riverwalk on the map' }).click();
  await card.waitFor();
  if (phone) assert.equal(await page.getByRole('button', { name: 'Settings', exact: true }).getAttribute('aria-expanded'), 'false', 'the drawer gets out of the way');
  // On a phone the options fold away, roads and all.
  const options = card.getByRole('button', { name: 'Route options' });
  if (phone) await options.click();
  await card.getByRole('button', { name: 'Snap to roads' }).first().waitFor({ timeout: 90_000 });
  if (phone) {
    await shot('1-options');
    await options.click();
  }
  await page.waitForTimeout(800);
  await shot('1-editing');

  // Drag a point: the route changes, and undo puts it back.
  const before = sample.lines;
  const point = await middleHandle();
  await drag(point, { x: point.x + 45, y: point.y + 35 });
  const moved = await waitSaved((t) => t[0] && JSON.stringify(t[0].lines) !== JSON.stringify(before), 'the moved point');
  await shot('2-moved');
  if (!phone) {
    await page.keyboard.press(undoKeys);
    await waitSaved((t) => JSON.stringify(t[0].lines) === JSON.stringify(before), 'undo of the move');
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+y');
    await waitSaved((t) => JSON.stringify(t[0].lines) === JSON.stringify(moved[0].lines), 'redo of the move');
  } else {
    await page.getByRole('button', { name: /^Undo/ }).first().click();
    await waitSaved((t) => JSON.stringify(t[0].lines) === JSON.stringify(before), 'undo of the move');
  }

  // Drag the line between two handles to add a point.
  // A spot on the line itself, in the open and well away from any handle.
  const open = await inTheOpen();
  const spots = await handles();
  const box = await page.locator('.map-host').boundingBox();
  const along = await page.$eval('.track-edit-line', (path) => {
    const total = path.getTotalLength();
    return Array.from({ length: 400 }, (_, i) => {
      const p = path.getPointAtLength((total * (i + 0.5)) / 400);
      return { x: p.x, y: p.y };
    });
  });
  const on = along.map((p) => ({ x: p.x + box.x, y: p.y + box.y })).find((p) => open(p) && spots.every((h) => Math.hypot(h.x - p.x, h.y - p.y) > 20));
  assert(on, 'no stretch of line in the open');
  const pointsBefore = (await saved())[0].lines.reduce((n, line) => n + decode(line).length, 0);
  await drag(on, { x: on.x + 30, y: on.y - 30 });
  await waitSaved((t) => t[0].lines.reduce((n, line) => n + decode(line).length, 0) !== pointsBefore, 'a point added on the line');
  await shot('3-added');

  // Select a point and step through them.
  const pick = await middleHandle();
  await tap(pick.x, pick.y);
  await page.waitForTimeout(300);
  assert.match(await card.innerText(), /The start|The finish|along/, 'the card names the selected point');
  assert.equal(await page.locator('.track-handle.is-selected').count(), 1);
  if (!phone) {
    await page.keyboard.press('.');
    await page.keyboard.press('Shift+.');
    await page.keyboard.press('Shift+.');
    await page.waitForTimeout(200);
    assert.match(await card.innerText(), /Section of/, 'Shift-stepping picks a section');
    await shot('4-section');
    const lines = (await saved())[0].lines.length;
    await card.getByRole('button', { name: 'Cut out' }).click();
    await waitSaved((t) => t[0].lines.length === lines + 1, 'the section cut out leaving a gap');
    await page.keyboard.press(undoKeys);
    await waitSaved((t) => t[0].lines.length === lines, 'undo of the cut');
    // Arrow keys nudge the selected point, Delete takes it out.
    await tap(pick.x, pick.y);
    const nudgeFrom = JSON.stringify((await saved())[0].lines);
    await page.keyboard.press('ArrowRight');
    await page.keyboard.press('ArrowRight');
    await waitSaved((t) => JSON.stringify(t[0].lines) !== nudgeFrom, 'a nudge');
    await page.keyboard.press('Delete');
    await page.waitForTimeout(300);
  }

  // Trim the start and reverse.
  let track = (await saved())[0];
  const length = lengthOf(track.lines.map(decode));
  if (phone) await options.click();
  await card.getByRole('button', { name: 'Trim start' }).click();
  track = (await waitSaved((t) => Math.abs(lengthOf(t[0].lines.map(decode)) - (length - 200)) < 5, 'a 200 m trim'))[0];
  const first = decode(track.lines[0])[0];
  const lastLine = decode(track.lines[track.lines.length - 1]);
  await card.getByRole('button', { name: 'Reverse' }).click();
  track = (await waitSaved((t) => metres(decode(t[0].lines[0])[0], lastLine[lastLine.length - 1]) < 0.5, 'the reversed route'))[0];
  const reversedLast = decode(track.lines[track.lines.length - 1]);
  assert(metres(reversedLast[reversedLast.length - 1], first) < 0.5, 'the start became the finish');
  await shot('5-trimmed');

  // Undo all changes puts back the sample as imported.
  await card.getByRole('button', { name: 'Undo all changes' }).click();
  await waitSaved((t) => JSON.stringify(t[0].lines) === JSON.stringify(before), 'Undo all changes');

  // A wobbly recording of the sample snaps back onto the streets.
  const truth = before.map(decode);
  const wobble = truth.map((line) => {
    const out = [];
    for (let i = 1; i < line.length; i++) {
      const steps = Math.max(1, Math.round(metres(line[i - 1], line[i]) / 8));
      for (let k = i === 1 ? 0 : 1; k <= steps; k++) {
        const t = k / steps;
        const n = Math.sin(out.length * 0.7) * 9e-5;
        out.push([line[i - 1][0] + (line[i][0] - line[i - 1][0]) * t + n, line[i - 1][1] + (line[i][1] - line[i - 1][1]) * t - n * 0.7]);
      }
    }
    return out;
  });
  const body = wobble[0].map(([lon, lat]) => `<trkpt lon="${lon.toFixed(6)}" lat="${lat.toFixed(6)}"/>`).join('');
  await routesSection();
  await page.locator('input[aria-label="Import route files"]').setInputFiles({ name: 'Wobbly Run.gpx', mimeType: 'application/gpx+xml', buffer: Buffer.from(`<gpx><trk><name>Wobbly Run</name><trkseg>${body}</trkseg></trk></gpx>`) });
  await waitSaved((t) => t.length === 2, 'the wobbly import');
  await page.getByRole('button', { name: 'Edit Wobbly Run on the map' }).click();
  await card.waitFor();
  const off = (lines) => {
    // Mean distance from the sample's own line, sampled at the route's points.
    const near = (p) => Math.min(...truth[0].slice(1).map((q, i) => {
      const a = truth[0][i];
      const k = Math.cos((p[1] * Math.PI) / 180);
      const ax = (a[0] - p[0]) * k;
      const ay = a[1] - p[1];
      const bx = (q[0] - p[0]) * k;
      const by = q[1] - p[1];
      const dx = bx - ax;
      const dy = by - ay;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / (dx * dx + dy * dy || 1)));
      return Math.hypot(ax + dx * t, ay + dy * t) * 111_320;
    }));
    const points = lines.flat();
    return points.reduce((sum, p) => sum + near(p), 0) / points.length;
  };
  const wobbly = (await saved())[1];
  const offBefore = off(wobbly.lines.map(decode));
  await card.getByRole('button', { name: 'Snap to roads' }).last().click();
  const snapped = (await waitSaved((t) => JSON.stringify(t[1].lines) !== JSON.stringify(wobbly.lines), 'the snap'))[1];
  const offAfter = off(snapped.lines.map(decode));
  console.log(`wobbly route: ${offBefore.toFixed(1)} m off the street before snapping, ${offAfter.toFixed(1)} m after`);
  assert(offAfter < offBefore / 2, 'snapping brings the route onto the streets');
  await shot('6-snapped');

  // Draw a new route along the roads with three clicks.
  await routesSection();
  await page.getByRole('button', { name: 'Draw a route' }).click();
  await card.waitFor();
  assert.equal(await page.getByRole('button', { name: 'Draw (D)' }).getAttribute('aria-pressed'), 'true');
  // The furthest snap, so clicks in the middle of a block still find a street.
  if (phone && (await options.getAttribute('aria-expanded')) !== 'true') await options.click();
  await card.getByRole('slider', { name: 'Snap distance' }).press('End');
  if (phone) await options.click();
  const map = await page.locator('.map-host').boundingBox();
  const panel = await card.boundingBox();
  // Above the card on a phone, left of it on a desktop.
  const room = phone ? { x: map.x, y: map.y + 110, w: map.width - 60, h: panel.y - map.y - 140 } : { x: map.x + 60, y: map.y + 110, w: panel.x - map.x - 120, h: map.height - 220 };
  const clicks = [
    [0.2, 0.3],
    [0.6, 0.3],
    [0.6, 0.8],
  ];
  for (const [fx, fy] of clicks) {
    await tap(room.x + room.w * fx, room.y + room.h * fy);
    await page.waitForTimeout(400);
  }
  const drawn = (await waitSaved((t) => t.length === 3, 'the drawn route'))[2];
  assert.equal(drawn.name, 'Drawn route');
  const drawnLines = drawn.lines.map(decode);
  const pointsDrawn = drawnLines.flat().length;
  console.log(`drawn route: ${pointsDrawn} points, ${lengthOf(drawnLines).toFixed(0)} m`);
  assert(pointsDrawn > 3, 'the drawn route goes along the roads between the clicks');
  await shot('7-drawn');

  // Esc backs out a step at a time and then closes the editor, and the area can move again.
  if (!phone) {
    for (let i = 0; i < 4 && (await card.count()); i++) await page.keyboard.press('Escape');
    assert.equal(await card.count(), 0, 'Esc closes the editor');
  } else {
    await card.getByRole('button', { name: 'Stop editing routes (Esc)' }).click();
  }
  assert.equal(await page.locator('.area-editor.is-locked').count(), 0, 'the area is unlocked again');
  await shot('8-done');

  // Saved routes come back after a reload.
  await page.reload();
  await page.waitForTimeout(1500);
  assert.equal((await saved()).length, 3);

  assert.deepEqual(errors, [], `console errors: ${errors.join('\n')}`);
  console.log('route editor e2e passed');
} catch (error) {
  await shot('failed').catch(() => {});
  console.error(error);
  process.exitCode = 1;
} finally {
  await browser.close();
}
