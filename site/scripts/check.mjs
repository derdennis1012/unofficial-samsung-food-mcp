// Visual and accessibility check. Needs the site served (npm run serve).
//   node scripts/check.mjs [--url http://127.0.0.1:4327/unofficial-samsung-food-mcp/]
//
// Writes to site/.shots/:
//   <width>-js-<n>.png     full page after the hero animation finished and every section was
//                          scrolled into view, cut into slices of at most 1800 px
//   <width>-nojs-<n>.png   the same with JavaScript disabled (what a crawler or a failed script sees)
// and prints console errors, horizontal overflow, axe violations and the transfer size.
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { chromium } from 'playwright';

const require = createRequire(import.meta.url);
const i = process.argv.indexOf('--url');
const URL_ = i > 0 ? process.argv[i + 1] : 'http://127.0.0.1:4327/unofficial-samsung-food-mcp/';
const OUT = new URL('../.shots/', import.meta.url).pathname;
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });
const SLICE = 1800;

const browser = await chromium.launch();
const errors = [];
const report = [];

async function slices(page, name) {
  const h = await page.evaluate(() => document.documentElement.scrollHeight);
  const w = page.viewportSize().width;
  let n = 0;
  for (let y = 0; y < h; y += SLICE, n++) {
    await page.screenshot({ path: `${OUT}${name}-${n}.png`, fullPage: true, clip: { x: 0, y, width: w, height: Math.min(SLICE, h - y) } });
  }
  report.push(`${name}: ${h}px, ${n} slices`);
}

for (const [w, h, mobile] of [[1440, 900, false], [390, 844, true]]) {
  for (const js of [true, false]) {
    const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, javaScriptEnabled: js, isMobile: mobile, hasTouch: mobile });
    const page = await ctx.newPage();
    const tag = `${w}-${js ? 'js' : 'nojs'}`;
    let bytes = 0, fontBytes = 0;
    page.on('response', async (r) => {
      try {
        const len = (await r.body()).length;
        if (r.url().endsWith('.woff2')) fontBytes += len; else bytes += len;
      } catch {}
    });
    page.on('console', (m) => m.type() === 'error' && errors.push(`${tag}: ${m.text()}`));
    page.on('pageerror', (e) => errors.push(`${tag}: ${e.message}`));
    await page.goto(URL_, { waitUntil: 'networkidle' });
    await page.evaluate(() => document.fonts.ready);
    if (js) {
      // Let the hero play to its end, then hold it there with the pause button.
      if (!mobile) await page.mouse.move(w - 2, 80);
      await page.evaluate(() => document.querySelector('#demo').scrollIntoView({ block: 'start', behavior: 'instant' }));
      await page.waitForFunction(() => document.querySelectorAll('.demo .w').length && !document.querySelector('.demo .is-pending, .demo .is-empty'), null, { timeout: 60000, polling: 500 });
      await page.click('[data-demo-toggle]');
      // Scroll like a reader so every on-enter animation has run.
      const total = await page.evaluate(() => document.documentElement.scrollHeight);
      for (let y = 0; y < total; y += Math.round(h * 0.6)) {
        await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), y);
        await page.waitForTimeout(350);
      }
      await page.waitForTimeout(2500);
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await page.waitForTimeout(600);
    }
    const overflow = await page.evaluate(() => {
      const vw = document.documentElement.clientWidth;
      return [...document.querySelectorAll('body *')]
        .filter((el) => { const r = el.getBoundingClientRect(); return r.width && (r.right > vw + 1 || r.left < -1) && !el.closest('pre, .overflow-x-auto, .sr-only, [aria-hidden="true"] svg'); })
        .slice(0, 6)
        .map((el) => `${el.tagName.toLowerCase()}.${String(el.className).slice(0, 50)} right=${Math.round(el.getBoundingClientRect().right)}`);
    });
    const hiddenText = await page.evaluate(() =>
      [...document.querySelectorAll('main p, main li, main h2, main h3')].filter((el) => {
        const s = getComputedStyle(el);
        return el.offsetParent !== null && el.textContent.trim() && (parseFloat(s.opacity) < 0.1 || s.visibility === 'hidden');
      }).length
    );
    report.push(`${tag}: transfer ${(bytes / 1024).toFixed(0)} KB + fonts ${(fontBytes / 1024).toFixed(0)} KB; overflow ${overflow.length ? overflow.join(' | ') : 'none'}; invisible text blocks: ${hiddenText}`);
    await slices(page, tag);
    if (js) {
      await page.addScriptTag({ path: require.resolve('axe-core/axe.min.js') });
      const res = await page.evaluate(async () => (await window.axe.run(document, { resultTypes: ['violations'] })).violations.map((v) => `${v.id} (${v.impact}): ${v.nodes.length}× ${v.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`));
      report.push(`${tag} axe: ${res.length ? '\n  ' + res.join('\n  ') : '0 violations'}`);
    }
    await ctx.close();
  }
}
await browser.close();
console.log(report.join('\n'));
console.log(errors.length ? 'console errors:\n' + errors.join('\n') : 'no console errors');
