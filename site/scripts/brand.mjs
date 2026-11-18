// Brand palette, mark and logo geometry. Imported by build.mjs (inline mark, favicon.svg) and
// render.mjs; run directly (`node scripts/brand.mjs`) to regenerate the SVG masters in
// ../assets/brand/.
//
// The mark: a 2x2 week grid on a deep herb tile. Three cells are open slots, the fourth holds
// a round tomato-red "dish" that a tool call has just planned. Original geometry, no
// third-party shapes, no Samsung colours.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const COLORS = {
  ink: '#1A1915',
  ink2: '#3B3932',
  paper: '#FBF8F2',
  paper2: '#F3EEE4',
  muted: '#6B665B',
  line: '#E3DCCD',
  herb: '#2E6A4B',
  herbDeep: '#12291F',
  mutedOnDark: '#A9B8AE',
  tomato: '#E0482D',
  saffron: '#E8A53A',
  white: '#FFFFFF',
};

const G = { size: 32, r: 7, off: 7, cell: 8, gap: 2, cellR: 1.8, dotR: 4.6 };
const p2 = G.off + G.cell + G.gap;
const dotC = p2 + G.cell / 2;

/** Inner SVG markup of the mark in a 32x32 box. */
export function markInner({ tile = COLORS.herbDeep, cell = COLORS.paper, dot = COLORS.tomato } = {}) {
  const sq = (x, y) => `<rect x="${x}" y="${y}" width="${G.cell}" height="${G.cell}" rx="${G.cellR}" fill="${cell}"/>`;
  return [
    `<rect width="${G.size}" height="${G.size}" rx="${G.r}" fill="${tile}"/>`,
    sq(G.off, G.off),
    sq(p2, G.off),
    sq(G.off, p2),
    `<circle cx="${dotC}" cy="${dotC}" r="${G.dotR}" fill="${dot}"/>`,
  ].join('');
}

/** Single-colour mark: the tile with the cells and dot knocked out (even-odd path). */
export function markMonoInner(color) {
  const { size: s, r, off, cell: c, cellR: cr, dotR } = G;
  const rr = (x, y, w, h, k) =>
    `M${x + k} ${y}H${x + w - k}A${k} ${k} 0 0 1 ${x + w} ${y + k}V${y + h - k}A${k} ${k} 0 0 1 ${x + w - k} ${y + h}H${x + k}A${k} ${k} 0 0 1 ${x} ${y + h - k}V${y + k}A${k} ${k} 0 0 1 ${x + k} ${y}Z`;
  const circle = (cx, cy, k) => `M${cx - k} ${cy}A${k} ${k} 0 1 0 ${cx + k} ${cy}A${k} ${k} 0 1 0 ${cx - k} ${cy}Z`;
  const d = [rr(0, 0, s, s, r), rr(off, off, c, c, cr), rr(p2, off, c, c, cr), rr(off, p2, c, c, cr), circle(dotC, dotC, dotR)].join('');
  return `<path fill="${color}" fill-rule="evenodd" d="${d}"/>`;
}

const svg = (w, h, inner, title) =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}" role="img" aria-label="${title}"><title>${title}</title>${inner}</svg>\n`;

export const markSvg = (opts) => svg(32, 32, markInner(opts), 'Unofficial Samsung Food MCP');

/** Wordmark outlines from Schibsted Grotesk (OFL), so the SVGs need no font.
 *  "unofficial" is set light and muted, a description; "Samsung Food MCP" carries the weight. */
async function wordmarkPaths(size) {
  const opentype = (await import('opentype.js')).default;
  const load = (w) => {
    const f = fileURLToPath(new URL(`../node_modules/@fontsource/schibsted-grotesk/files/schibsted-grotesk-latin-${w}-normal.woff`, import.meta.url));
    const buf = fs.readFileSync(f);
    return opentype.parse(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  };
  const light = load(400);
  const bold = load(600);
  const parts = [
    ['unofficial', light, 0, -0.01],
    ['Samsung Food MCP', bold, 0.26 * size, -0.02],
  ];
  let x = 0;
  const out = [];
  for (const [text, font, before, track] of parts) {
    x += before;
    let d = '';
    for (const ch of text) {
      const glyph = font.charToGlyph(ch);
      d += glyph.getPath(x, 0, size).toPathData(2);
      x += (glyph.advanceWidth / font.unitsPerEm) * size + track * size;
    }
    out.push(d);
  }
  const xHeight = ((bold.tables.os2?.sxHeight ?? 500) / bold.unitsPerEm) * size;
  const capHeight = ((bold.tables.os2?.sCapHeight ?? 700) / bold.unitsPerEm) * size;
  return { paths: out, width: x, xHeight, capHeight };
}

/** Horizontal logo: mark + wordmark. */
export async function logoSvg({ text = COLORS.ink, textMuted = COLORS.muted, mark = {}, mono = null } = {}) {
  const markSize = 40;
  const fontSize = 27;
  const gap = 13;
  const wm = await wordmarkPaths(fontSize);
  // Optically centre the cap height on the mark.
  const baseline = markSize / 2 + wm.capHeight / 2;
  const width = Math.ceil(markSize + gap + wm.width + 2);
  const scale = markSize / 32;
  const markMarkup = mono ? markMonoInner(mono) : markInner(mark);
  const inner =
    `<g transform="scale(${scale})">${markMarkup}</g>` +
    `<g transform="translate(${markSize + gap} ${baseline.toFixed(2)})">` +
    `<path fill="${mono ?? textMuted}" d="${wm.paths[0]}"/>` +
    `<path fill="${mono ?? text}" d="${wm.paths[1]}"/></g>`;
  return svg(width, markSize, inner, 'Unofficial Samsung Food MCP');
}

async function main() {
  const dir = fileURLToPath(new URL('../../assets/brand/', import.meta.url));
  fs.mkdirSync(dir, { recursive: true });
  const onDark = { tile: COLORS.paper, cell: COLORS.herbDeep, dot: COLORS.tomato };
  const light = await logoSvg();
  const files = {
    'mark.svg': markSvg(),
    'mark-on-dark.svg': markSvg(onDark),
    'mark-mono-black.svg': svg(32, 32, markMonoInner('#000000'), 'Unofficial Samsung Food MCP'),
    'mark-mono-white.svg': svg(32, 32, markMonoInner('#FFFFFF'), 'Unofficial Samsung Food MCP'),
    'logo-light.svg': light,
    'logo.svg': light, // README fallback <img>
    'logo-dark.svg': await logoSvg({ text: COLORS.paper, textMuted: COLORS.mutedOnDark, mark: onDark }),
    'logo-mono-black.svg': await logoSvg({ mono: '#000000' }),
    'logo-mono-white.svg': await logoSvg({ mono: '#FFFFFF' }),
  };
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), body);
  fs.writeFileSync(fileURLToPath(new URL('../public/favicon.svg', import.meta.url)), markSvg());
  console.log(`brand: wrote ${Object.keys(files).length} SVGs to assets/brand/ and public/favicon.svg`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();
