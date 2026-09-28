// Screenshot the running dev server with the installed Edge.
//   node scripts/shot.mjs <url> <out.png> [width] [height] [waitMs] [dark]
import { chromium } from 'playwright-core';

const [url, out, width = '1440', height = '900', wait = '6000', dark] = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: Number(width), height: Number(height) } });
if (dark) await page.emulateMedia({ colorScheme: 'dark' });
const errors = [];
page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
page.on('pageerror', (e) => errors.push(String(e)));
await page.goto(url);
await page.waitForTimeout(Number(wait));
await page.screenshot({ path: out });
console.log(errors.length ? `console errors:\n${errors.join('\n')}` : 'no console errors');
await browser.close();
