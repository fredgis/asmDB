// Captures a section of the site into docs/assets as a PNG.
//
// The README embeds screenshots of the pricing tiers and the console. Taking
// them by hand meant they silently aged: the tiers image still showed a row
// ceiling and a per-account cap that had both changed. This script re-takes
// them from the real page, so refreshing a screenshot is a command rather than
// a chore.
//
//   node scripts/capture-site.mjs [baseUrl]
//
// Defaults to the deployed site. Pass a local URL to capture a working copy.

// Playwright is deliberately not a dependency of this repository — asmdb ships
// zero third-party code and a screenshot tool is no reason to change that. It
// is resolved from the global install instead: `npm install -g playwright`.
import { createRequire } from 'node:module';
import { execSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  try {
    return require('playwright');
  } catch {
    const globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
    return createRequire(join(globalRoot, 'noop.js'))('playwright');
  }
}

const { chromium } = loadPlaywright();

const base = process.argv[2] ?? 'https://www.asmdb.cloud';

const shots = [
  { selector: '#tiers', out: 'docs/assets/asmdb-cloud-tiers.png' },
  { selector: 'body',   out: 'docs/assets/asmdb-cloud-home.png', fullPage: true },
];

const browser = await chromium.launch();
const page = await browser.newPage({
  viewport: { width: 1600, height: 1200 },
  deviceScaleFactor: 2,
  colorScheme: 'dark',
});

// Cache-bust: the gateway serves the previous build for a while after a deploy,
// and a screenshot of stale content is worse than no screenshot.
await page.goto(`${base}/?cb=${Date.now()}`, { waitUntil: 'networkidle' });
await page.waitForTimeout(1200);

for (const { selector, out, fullPage } of shots) {
  await mkdir(dirname(out), { recursive: true });
  if (fullPage) {
    await page.screenshot({ path: out, fullPage: true });
  } else {
    const el = page.locator(selector).first();
    await el.scrollIntoViewIfNeeded();
    // The site header is sticky, so scrolling a section into view paints the
    // nav straight over the top of it. Hide anything pinned for the duration of
    // an element shot, then put it back.
    const hidden = await page.evaluate(() => {
      const pinned = [...document.querySelectorAll('body *')].filter((n) => {
        const p = getComputedStyle(n).position;
        return p === 'sticky' || p === 'fixed';
      });
      pinned.forEach((n) => { n.dataset.captureVis = n.style.visibility; n.style.visibility = 'hidden'; });
      return pinned.length;
    });
    await page.waitForTimeout(400);
    await el.screenshot({ path: out });
    await page.evaluate(() => {
      document.querySelectorAll('[data-capture-vis]').forEach((n) => {
        n.style.visibility = n.dataset.captureVis ?? '';
        delete n.dataset.captureVis;
      });
    });
    if (hidden) console.log(`  (hid ${hidden} pinned element(s) for the shot)`);
  }
  console.log(`captured ${selector} -> ${out}`);
}

await browser.close();
