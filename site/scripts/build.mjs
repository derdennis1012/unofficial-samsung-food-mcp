// Builds the static site into site/dist.
//   node scripts/build.mjs           one build
//   node scripts/build.mjs --watch   rebuild on changes in src/, public/ and scripts/
//
// No bundler: HTML is assembled from src/*.html with a few generated fragments (dish sprite,
// tool matrix from src/data/tools.json, setup tabs), CSS is compiled with the Tailwind CLI,
// JS is copied as a plain ES module.
//
// Placeholders in the HTML:  {{VAR}}   <!--@fragment-->   <!--@dish:<id>:<classes>-->

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { markInner, markSvg } from './brand.mjs';
import { dishSprite, dish } from './dishes.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = path.join(ROOT, 'src');
const PUB = path.join(ROOT, 'public');
const DIST = path.join(ROOT, 'dist');

export const BASE = '/unofficial-samsung-food-mcp/';
export const SITE_URL = `https://derdennis1012.github.io${BASE}`;
export const REPO = 'https://github.com/derdennis1012/unofficial-samsung-food-mcp';
const DOCS = `${REPO}/blob/main/docs/`;

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/* ------------------------------------------------------------------ tool matrix */
// One square per MCP tool, grouped by annotation. Decorative; the counts are in the text.
function toolMatrix(data) {
  const order = ['read', 'write', 'destructive'];
  const tools = data.areas.flatMap((a) => a.tools).sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  return tools.map((t, i) => `<span class="cell cell-${t.kind}" style="--i:${i}" title="${esc(t.name)}"></span>`).join('');
}

/* ------------------------------------------------------------------ setup tabs */
const json = (v) => JSON.stringify(v, null, 2).replace(/\[\n\s*([^\[\]{}]*?)\n\s*\]/g, (m, inner) => `[${inner.replace(/\n\s*/g, ' ')}]`);
const entry = { command: 'npx', args: ['-y', 'unofficial-samsung-food-mcp'] };

export const CONFIGS = [
  {
    id: 'claude-code',
    label: 'Claude Code',
    where: 'One command. <code>--scope user</code> makes it available in every project.',
    lang: 'sh',
    code: `claude mcp add --scope user samsung-food -- \\\n  npx -y unofficial-samsung-food-mcp`,
  },
  {
    id: 'claude-desktop',
    label: 'Claude Desktop',
    where: 'Settings → Developer → Edit Config. Restart Claude afterwards.',
    lang: 'json',
    code: json({ mcpServers: { 'samsung-food': entry } }),
  },
  {
    id: 'cursor',
    label: 'Cursor',
    where: '<code>~/.cursor/mcp.json</code>, or <code>.cursor/mcp.json</code> in a project.',
    lang: 'json',
    code: json({ mcpServers: { 'samsung-food': entry } }),
  },
  {
    id: 'vscode',
    label: 'VS Code',
    where: 'Command palette: MCP: Open User Configuration, or <code>.vscode/mcp.json</code>. Note the key <code>servers</code> and the <code>type</code>.',
    lang: 'json',
    code: json({ servers: { 'samsung-food': { type: 'stdio', ...entry } } }),
  },
  {
    id: 'terminal',
    label: 'Terminal',
    where: 'After <code>npm link</code> in the checkout, <code>sf</code> is on your path.',
    lang: 'sh',
    code: `sf whoami\nsf plan --days 7\nsf list recipe <recipeId>\nsf pantry add "chicken breast" --location freezer`,
  },
];

export function highlight(code, lang) {
  const e = esc(code);
  if (lang === 'sh') {
    return e
      .split('\n')
      .map((l) => l.replace(/(--[\w-]+)/g, '<span class="tok-k">$1</span>').replace(/^(\s*)(claude|sf|node|curl|git|npm|npx)\b/, '$1<span class="tok-s">$2</span>').replace(/(&quot;[^&]*?&quot;)/g, '<span class="tok-a">$1</span>'))
      .join('\n');
  }
  return e
    .replace(/(&quot;[^&]*?&quot;)(\s*:)/g, '<span class="tok-k">$1</span>$2')
    .replace(/(:\s*|\[\s*|,\s*)(&quot;[^&]*?&quot;)/g, '$1<span class="tok-s">$2</span>')
    .replace(/([{}[\]])/g, '<span class="tok-p">$1</span>');
}

function setup() {
  const opts = CONFIGS.map(
    (c, i) => `<label class="opt relative shrink-0 px-3 py-3 text-[13.5px] font-medium whitespace-nowrap text-term-dim transition-colors hover:text-term-text has-checked:text-term-text has-checked:after:absolute has-checked:after:inset-x-3 has-checked:after:-bottom-px has-checked:after:h-[2px] has-checked:after:bg-saffron"><input class="sr-only" type="radio" name="client" value="${c.id}"${i === 0 ? ' checked' : ''}>${c.label}</label>`
  ).join('\n            ');
  const panels = CONFIGS.map(
    (c) => `<div data-panel="${c.id}">
            <p class="border-b border-term-line px-5 py-3 text-[13px] leading-relaxed text-term-dim [&_code]:text-term-text">${c.where}</p>
            <div class="relative">
              <button type="button" class="copy-btn" data-copy aria-label="Copy the ${c.label} snippet">Copy</button>
              <pre tabindex="0" class="code overflow-x-auto px-5 pt-4 pb-6 pr-20 max-sm:pt-14 max-sm:pr-5 max-sm:break-words max-sm:whitespace-pre-wrap" data-copy-src><code>${highlight(c.code, c.lang)}</code></pre>
            </div>
          </div>`
  ).join('\n          ');
  const css = CONFIGS.map((c) => `.rtabs:has([value="${c.id}"]:checked) [data-panel="${c.id}"]`).join(',\n');
  return { opts, panels, css: `<style>${css}{display:block}</style>` };
}

/* ------------------------------------------------------------------ build */
function copyDir(from, to) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, entry.name);
    const b = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(a, b);
    else fs.copyFileSync(a, b);
  }
}

const FONTS = [
  ['@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-400-normal.woff2', 'schibsted-400.woff2'],
  ['@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-600-normal.woff2', 'schibsted-600.woff2'],
  ['@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-700-normal.woff2', 'schibsted-700.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-400-normal.woff2', 'instrument-sans-400.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-500-normal.woff2', 'instrument-sans-500.woff2'],
  ['@fontsource/instrument-sans/files/instrument-sans-latin-600-normal.woff2', 'instrument-sans-600.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-400-normal.woff2', 'jetbrains-mono-400.woff2'],
  ['@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2', 'jetbrains-mono-500.woff2'],
];

export function build() {
  const t0 = Date.now();
  fs.rmSync(DIST, { recursive: true, force: true });
  fs.mkdirSync(DIST, { recursive: true });
  copyDir(PUB, DIST);
  fs.writeFileSync(path.join(DIST, 'favicon.svg'), markSvg());

  fs.mkdirSync(path.join(DIST, 'fonts'), { recursive: true });
  for (const [from, to] of FONTS) fs.copyFileSync(path.join(ROOT, 'node_modules', from), path.join(DIST, 'fonts', to));
  for (const f of fs.readdirSync(SRC)) if (f.endsWith('.js')) fs.copyFileSync(path.join(SRC, f), path.join(DIST, f));

  const data = JSON.parse(fs.readFileSync(path.join(SRC, 'data/tools.json'), 'utf8'));
  const { totals } = data;
  const s = setup();
  const vars = { SITE_URL, BASE, REPO, DOCS, BUILD: Date.now().toString(36), TOTAL: totals.all, READ: totals.read, WRITE: totals.write, DESTRUCTIVE: totals.destructive };
  const fragments = {
    'dish-sprite': dishSprite(),
    'tool-matrix': toolMatrix(data),
    'setup-opts': s.opts,
    'setup-panels': s.panels,
    'setup-css': s.css,
    mark: markInner(),
  };
  for (const page of ['index.html', '404.html']) {
    let html = fs.readFileSync(path.join(SRC, page), 'utf8');
    html = html.replace(/<!--@dish:([\w-]+)\s+([^>]*?)-->/g, (m, id, cls) => dish(id, cls.trim()));
    html = html.replace(/<!--@([\w-]+)-->/g, (m, k) => fragments[k] ?? m);
    html = html.replace(/\{\{(\w+)\}\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
    const left = html.match(/\{\{\w+\}\}|<!--@[\w:-]+/);
    if (left) throw new Error(`${page}: unresolved placeholder ${left[0]}`);
    fs.writeFileSync(path.join(DIST, page), html);
  }

  const tw = path.join(ROOT, 'node_modules/.bin/tailwindcss');
  execFileSync(tw, ['-i', path.join(SRC, 'styles.css'), '-o', path.join(DIST, 'site.css'), '--minify'], { stdio: ['ignore', 'ignore', 'inherit'], cwd: ROOT });
  fs.writeFileSync(path.join(DIST, '.nojekyll'), '');
  console.log(`built site/dist in ${Date.now() - t0} ms`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  build();
  if (process.argv.includes('--watch')) {
    let timer;
    const again = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        try {
          build();
        } catch (e) {
          console.error(e.message);
        }
      }, 120);
    };
    for (const d of [SRC, PUB, path.join(ROOT, 'scripts')]) fs.watch(d, { recursive: true }, again);
    console.log('watching src/, public/ and scripts/ …');
  }
}
