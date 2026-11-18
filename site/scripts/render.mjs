// Renders the raster assets with Playwright. Not part of the CI build; run it after visual
// changes and commit the results.
//   npm run build && npm run serve      (in another shell)
//   node scripts/render.mjs [brand] [screens] [api]
//
// brand    favicon-32.png, apple-touch-icon.png, og.png (site/public), assets/brand/icon-512.png,
//          social-preview.png (1280x640) and og-image.png
// screens  assets/screenshots/*.png at 2x: hero demo states, tool matrix, sf terminal sessions
//          (neutral sample data, formatted like bin/sf.js prints it)
// api      assets/screenshots/http-api-docs.png: starts `sf serve --read-only` with a throwaway
//          SAMSUNG_FOOD_HOME and API key (never touches ~/.samsung-food or an account)

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { markInner, COLORS } from './brand.mjs';
import { dishSprite, dish } from './dishes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REPO = path.resolve(ROOT, '..');
const PUB = path.join(ROOT, 'public');
const BRAND = path.join(REPO, 'assets/brand');
const SHOTS = path.join(REPO, 'assets/screenshots');
const SITE = process.env.SITE_URL ?? 'http://127.0.0.1:4327/unofficial-samsung-food-mcp/';
const CSS = SITE + 'site.css'; // served, so the relative font URLs resolve
const TOOLS = JSON.parse(fs.readFileSync(path.join(ROOT, 'src/data/tools.json'), 'utf8'));

const want = new Set(process.argv.slice(2));
if (!want.size) ['brand', 'screens', 'api'].forEach((w) => want.add(w));
for (const d of [BRAND, SHOTS, PUB]) fs.mkdirSync(d, { recursive: true });

const doc = (body, { bg = COLORS.paper } = {}) => `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="${CSS}"><style>html,body{margin:0;background:${bg}}</style></head><body>${dishSprite()}${body}</body></html>`;

const browser = await chromium.launch();
const rel = (f) => path.relative(REPO, f);

async function shoot(html, { width, height, file, scale = 1 }) {
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  await page.setContent(html, { waitUntil: 'load' });
  await page.evaluate(() => document.fonts.ready);
  await page.screenshot({ path: file, clip: { x: 0, y: 0, width, height }, omitBackground: true });
  await page.close();
  console.log('  ' + rel(file));
}

/* ------------------------------------------------------------------ brand rasters */
const iconSvg = (size, { pad = 0 } = {}) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-pad} ${-pad} ${32 + pad * 2} ${32 + pad * 2}" width="${size}" height="${size}" style="display:block">${pad ? `<rect x="${-pad}" y="${-pad}" width="${32 + pad * 2}" height="${32 + pad * 2}" fill="${COLORS.herbDeep}"/>` : ''}${markInner()}</svg>`;

const wordmark = (size, muted = 'text-muted') => `<span class="font-display tracking-[-0.02em]" style="font-size:${size}px"><span class="${muted}">unofficial</span> <span class="font-semibold">Samsung Food MCP</span></span>`;

function socialHtml(w, h) {
  const row = (day, date, id, name, meta) => `<li class="flex items-center gap-4 px-3 py-2.5"><span class="w-10 text-center leading-none"><span class="block text-[13px] font-semibold tracking-wide text-muted uppercase">${day}</span><span class="mt-1 block font-display text-[24px] font-semibold">${date}</span></span>${dish(id, 'size-[58px] shrink-0')}<span><span class="block text-[20px] font-medium">${name}</span><span class="block text-[15px] text-muted">${meta}</span></span></li>`;
  return doc(`
  <div style="width:${w}px;height:${h}px" class="relative overflow-hidden bg-paper">
    <div class="absolute inset-y-0 left-0 flex w-[600px] flex-col justify-between py-[60px] pl-[68px]">
      <div class="flex items-center gap-3.5">${iconSvg(44)}${wordmark(26)}</div>
      <div>
        <h1 class="display text-[64px]">Tell your assistant what you feel like eating.</h1>
        <p class="mt-6 text-[21px] leading-snug text-ink-2">Meal plan, shopping list and pantry for Samsung Food, from Claude, Cursor, VS Code or the terminal.</p>
      </div>
      <p class="text-[16px] text-muted">MCP server · CLI · local API · ${TOOLS.totals.all} tools · MIT · unofficial</p>
    </div>
    <div class="absolute top-[48px] left-[680px] w-[560px] rounded-[16px] bg-stage p-6" style="height:${h - 96}px">
      <div class="card overflow-hidden">
        <div class="flex items-baseline justify-between border-b border-line px-5 py-4"><span class="font-display text-[24px] font-semibold tracking-[-0.02em]">Meal plan</span><span class="text-[15px] text-muted">Dinner · 19–25 Nov</span></div>
        <ol class="p-2">
          ${row('Thu', 19, 'dal', 'Spinach dal', '30 min · uses the spinach')}
          ${row('Fri', 20, 'orzo', 'Lemon orzo with peas', '20 min')}
          ${row('Sat', 21, 'pumpkin', 'Pumpkin soup', 'planned earlier')}
          ${row('Sun', 22, 'chicken', 'Roast chicken thighs', '50 min')}
          ${row('Mon', 23, 'salmon', 'Miso salmon with greens', '25 min')}
        </ol>
      </div>
    </div>
  </div>`);
}

if (want.has('brand')) {
  console.log('brand');
  await shoot(doc(iconSvg(32), { bg: 'transparent' }), { width: 32, height: 32, file: path.join(PUB, 'favicon-32.png') });
  await shoot(doc(iconSvg(180, { pad: 4 })), { width: 180, height: 180, file: path.join(PUB, 'apple-touch-icon.png') });
  await shoot(doc(iconSvg(512, { pad: 4 })), { width: 512, height: 512, file: path.join(BRAND, 'icon-512.png') });
  await shoot(socialHtml(1280, 640), { width: 1280, height: 640, file: path.join(BRAND, 'social-preview.png') });
  await shoot(socialHtml(1200, 630), { width: 1200, height: 630, file: path.join(PUB, 'og.png') });
  fs.copyFileSync(path.join(PUB, 'og.png'), path.join(BRAND, 'og-image.png'));
  console.log('  ' + rel(path.join(BRAND, 'og-image.png')));
}

/* ------------------------------------------------------------------ screenshots */
const PAD = 40; // every screenshot: paper background, 40px margin, 2x

async function siteShot(query, selector, file, { width = 1320, prepare } = {}) {
  const page = await browser.newPage({ viewport: { width, height: 1000 }, deviceScaleFactor: 2, reducedMotion: query.includes('final') ? 'reduce' : 'no-preference' });
  await page.goto(SITE + query, { waitUntil: 'networkidle' });
  await page.evaluate(() => document.fonts.ready);
  await page.addStyleTag({ content: 'header[data-nav]{display:none!important}' });
  if (prepare) await prepare(page);
  await page.waitForTimeout(500);
  const el = page.locator(selector);
  await el.scrollIntoViewIfNeeded();
  const box = await el.boundingBox();
  const sy = await page.evaluate(() => window.scrollY);
  await page.screenshot({ path: file, fullPage: true, clip: { x: box.x - PAD, y: box.y + sy - PAD, width: box.width + PAD * 2, height: box.height + PAD * 2 } });
  await page.close();
  console.log('  ' + rel(file));
}

const P = (s) => `<span class="tok-p">${s}</span>`;
const K = (s) => `<span class="tok-k">${s}</span>`;
const prompt = (cmd) => `${P('$')} ${cmd}\n`;
const SESSIONS = {
  'sf-plan': ['sf plan', prompt('sf plan --days 4') + `Meal plan 2026-11-19 to 2026-11-22

${K('Thu 2026-11-19')} ${P('– 640 kcal')}
    Dinner         Spinach dal   ${P('[0193f2a7c4e1]')}

${K('Fri 2026-11-20')} ${P('– 585 kcal')}
    Dinner         Lemon orzo with peas   ${P('[0193f2a7c4e2]')}

${K('Sat 2026-11-21')} ${P('– 410 kcal')}
    Dinner         Pumpkin soup   ${P('[0193e81b02d9]')}

${K('Sun 2026-11-22')} ${P('– 760 kcal')}
    Dinner         Roast chicken thighs   ${P('[0193f2a7c4e3]')}`],
  'sf-list': ['sf list', prompt('sf list') + `Groceries (11 open, 2 done)

  ${K('Produce')}
    [ ] 2 lemons   ${P('[3f9a1c]')}
    [ ] 400 g mushrooms   ${P('[3f9a1d]')}
    [ ] 1 kg potatoes   ${P('[3f9a1e]')}
    [ ] 2 limes   ${P('[3f9a1f]')}
    [ ] coriander   ${P('[3f9a20]')}
  ${K('Fish &amp; meat')}
    [ ] 6 chicken thighs   ${P('[3f9a21]')}
    [ ] 2 salmon fillets   ${P('[3f9a22]')}
  ${K('Dairy')}
    [ ] parmesan   ${P('[3f9a23]')}
    [ ] sour cream   ${P('[3f9a24]')}
  ${K('Pasta &amp; grains')}
    [ ] 300 g orzo   ${P('[3f9a25]')}
    [ ] 300 g arborio rice   ${P('[3f9a26]')}
  ${P('done')}
    [x] olive oil   ${P('[3f9a10]')}
    [x] eggs   ${P('[3f9a11]')}`],
  'sf-pantry': ['sf pantry', prompt('sf pantry') + `Pantry (7 entries)

  ${K('Fridge')}
    crème fraîche<span class="text-term-red">  EXPIRED 1 d ago</span>   ${P('[8c02d1]')}
    spinach<span class="text-term-amber">  only 2 d left</span>   ${P('[8c02d4]')}
    coconut milk  2026-11-27   ${P('[8c02d7]')}
    greek yogurt  2026-12-01   ${P('[8c02d9]')}
  ${K('Freezer')}
    chicken thighs  2027-08-14   ${P('[8c02da]')}
  ${K('Pantry')}
    red lentils  2027-04-12   ${P('[8c02db]')}
    basmati rice  2027-05-30   ${P('[8c02dc]')}`],
  'sf-storage': ['sf storage', prompt('sf storage "chicken breast"') + `Chicken breast  (MEATS AND SEAFOOD)

  Fridge              2 days   (1–2 Days) <span class="text-term-green">←  default</span>
  Freezer           270 days   (9–9 Months)

  ${P('Multiple storage locations - Samsung Food does not set an expiry date on its own here.')}

` + prompt('sf pantry add "chicken breast" --location freezer') + `  chicken breast → Freezer, expires 2027-08-15   ${P('[8c02e0]')}`],
};

const terminalFrame = (title, body, width = 820) => doc(`
  <div id="frame" class="inline-block" style="padding:${PAD}px">
    <div class="overflow-hidden rounded-[12px] bg-term shadow-[0_28px_60px_-30px_rgba(26,25,21,.5)]" style="width:${width}px">
      <div class="relative flex h-10 items-center gap-1.5 border-b border-term-line px-4">
        <span class="size-3 rounded-full bg-term-line"></span><span class="size-3 rounded-full bg-term-line"></span><span class="size-3 rounded-full bg-term-line"></span>
        <span class="absolute inset-x-0 text-center font-mono text-[12.5px] text-term-dim">${title}</span>
      </div>
      <pre class="code px-6 py-5 text-[13.5px] whitespace-pre">${body}</pre>
    </div>
  </div>`);

async function termShot(title, body, file, width) {
  const pg = await browser.newPage({ viewport: { width: 1000, height: 900 }, deviceScaleFactor: 2 });
  await pg.setContent(terminalFrame(title, body, width), { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready);
  await pg.locator('#frame').screenshot({ path: file });
  await pg.close();
  console.log('  ' + rel(file));
}

if (want.has('screens')) {
  console.log('screens');
  await siteShot('?demo=final', '#demo', path.join(SHOTS, 'demo-assistant.png'));
  await siteShot('', '#demo', path.join(SHOTS, 'demo-assistant-running.png'), {
    prepare: async (page) => {
      await page.evaluate(() => document.querySelector('#demo').scrollIntoView({ block: 'center', behavior: 'instant' }));
      await page.waitForFunction(() => document.querySelectorAll('[data-slot].is-empty').length === 3, null, { timeout: 30000 });
      await page.click('[data-demo-toggle]'); // hold the frame
      await page.waitForTimeout(600);
    },
  });
  await siteShot('?demo=final', '#safety [data-matrix]', path.join(SHOTS, 'tool-coverage.png'), { width: 1100 });
  for (const [name, [title, body]] of Object.entries(SESSIONS)) await termShot(title, body, path.join(SHOTS, `terminal-${name}.png`));
  await termShot('sf', SESSIONS['sf-plan'][1] + '\n\n' + SESSIONS['sf-pantry'][1], path.join(SHOTS, 'demo-terminal.png'));
  // README fallbacks
  fs.copyFileSync(path.join(SHOTS, 'demo-assistant.png'), path.join(SHOTS, 'mcp-chat.png'));
  fs.copyFileSync(path.join(SHOTS, 'demo-terminal.png'), path.join(SHOTS, 'cli.png'));
  console.log('  assets/screenshots/mcp-chat.png, cli.png (copies)');
}

/* ------------------------------------------------------------------ HTTP API docs */
if (want.has('api')) {
  console.log('api');
  const home = fs.mkdtempSync(path.join(process.env.TMPDIR ?? '/tmp', 'sf-shot-'));
  const key = 'sfk_screenshot_only_' + Math.random().toString(36).slice(2);
  const port = 8799;
  const child = spawn(process.execPath, [path.join(REPO, 'bin/sf.js'), 'serve', '--read-only', '--port', String(port), '--quiet'], {
    env: { ...process.env, SAMSUNG_FOOD_HOME: home, SAMSUNG_FOOD_API_KEY: key, SAMSUNG_FOOD_TOKEN: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let errText = '';
  child.stderr.on('data', (d) => (errText += d));
  try {
    const base = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 50; i++) {
      try {
        if ((await fetch(base + '/healthz')).ok) break;
      } catch {}
      await new Promise((r) => setTimeout(r, 200));
    }
    const page = await browser.newPage({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2 });
    await page.goto(base + '/docs', { waitUntil: 'load' });
    await page.fill('#key', key);
    await page.click('#f button');
    await page.waitForSelector('#out details', { timeout: 15000 });
    await page.evaluate(() => {
      const d = [...document.querySelectorAll('#out details')].find((x) => x.textContent.includes('pantry_get')) ?? document.querySelector('#out details');
      d.open = true;
    });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(SHOTS, 'http-api-docs.png'), clip: { x: 0, y: 0, width: 1200, height: 900 } });
    console.log('  ' + rel(path.join(SHOTS, 'http-api-docs.png')));
    await page.close();
  } catch (e) {
    console.error('api screenshot failed:', e.message, errText.slice(0, 500));
  } finally {
    child.kill();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

await browser.close();
