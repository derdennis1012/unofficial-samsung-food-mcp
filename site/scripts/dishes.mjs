// Original top-down dish illustrations, drawn from simple shapes in a 64x64 box.
// build.mjs inlines them once as an SVG sprite (<symbol id="dish-…">); the page and render.mjs
// reference them with <use href="#dish-…">. No stock photos, no third-party artwork.

const r2 = (n) => Math.round(n * 100) / 100;

/** Deterministic pseudo-random numbers, so every build draws the same plate. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Random point inside a circle. */
const inCircle = (rand, cx, cy, r) => {
  const a = rand() * Math.PI * 2;
  const d = Math.sqrt(rand()) * r;
  return [cx + Math.cos(a) * d, cy + Math.sin(a) * d];
};

const leaf = (x, y, len, w, angle, fill, rib = 'rgba(255,255,255,.35)') =>
  `<g transform="translate(${r2(x)} ${r2(y)}) rotate(${r2(angle)})"><path d="M0 0C${r2(len * 0.3)} ${r2(-w)} ${r2(len * 0.72)} ${r2(-w)} ${r2(len)} 0C${r2(len * 0.72)} ${r2(w)} ${r2(len * 0.3)} ${r2(w)} 0 0Z" fill="${fill}"/><path d="M${r2(len * 0.12)} 0H${r2(len * 0.82)}" stroke="${rib}" stroke-width=".6" stroke-linecap="round"/></g>`;

const plate = `<circle cx="32" cy="32" r="31.5" fill="#FFFFFF"/><circle cx="32" cy="32" r="31" fill="none" stroke="#E4DCCD" stroke-width="1"/><circle cx="32" cy="32" r="25" fill="#F7F2E8"/><circle cx="32" cy="32" r="25" fill="none" stroke="#ECE4D6" stroke-width=".8"/>`;
const bowl = (food, rim = '#FFFFFF') =>
  `<circle cx="32" cy="32" r="31.5" fill="${rim}"/><circle cx="32" cy="32" r="31" fill="none" stroke="#E4DCCD" stroke-width="1"/><circle cx="32" cy="32" r="24.5" fill="${food}"/><circle cx="32" cy="32" r="24" fill="none" stroke="rgba(60,30,0,.14)" stroke-width="2.4"/>`;

const dots = (rand, n, cx, cy, r, size, fill) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = inCircle(rand, cx, cy, r);
    s += `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(size * (0.7 + rand() * 0.6))}" fill="${fill}"/>`;
  }
  return s;
};

const grains = (rand, n, cx, cy, r, fill, stroke, rx = 2.2, ry = 1) => {
  let s = '';
  for (let i = 0; i < n; i++) {
    const [x, y] = inCircle(rand, cx, cy, r);
    s += `<ellipse cx="${r2(x)}" cy="${r2(y)}" rx="${rx}" ry="${ry}" transform="rotate(${Math.round(rand() * 180)} ${r2(x)} ${r2(y)})" fill="${fill}" stroke="${stroke}" stroke-width=".35"/>`;
  }
  return s;
};

function dal() {
  const rand = rng(11);
  let s = bowl('#E3A03A');
  s += `<circle cx="29" cy="29" r="15" fill="#EDB255" opacity=".55"/>`;
  s += dots(rand, 26, 32, 32, 20, 0.5, '#B9791F');
  s += leaf(20, 24, 13, 4.2, 18, '#3B7448') + leaf(22, 41, 12, 3.8, -28, '#4F8D50') + leaf(35, 19, 11, 3.6, 62, '#3B7448') + leaf(40, 38, 12, 4, -150, '#5A9A55');
  s += `<path d="M22 33c3.5 4 11 5 16.5 0.5" fill="none" stroke="#FFFBF1" stroke-width="2.3" stroke-linecap="round"/><path d="M38.5 33.5c1.6-1.4 3.6-1.2 4.4 0.4" fill="none" stroke="#FFFBF1" stroke-width="2" stroke-linecap="round"/>`;
  s += dots(rand, 7, 32, 30, 16, 0.55, '#C2401F');
  return s;
}

function orzo() {
  const rand = rng(23);
  let s = plate;
  s += `<path d="M14 33c0-10 8-18 18-18s19 7 19 17-9 18-19 18-18-7-18-17Z" fill="#EBD49A"/>`;
  s += grains(rand, 46, 32, 33, 15.5, '#F6E6B8', '#D6BA74');
  for (let i = 0; i < 10; i++) {
    const [x, y] = inCircle(rand, 31, 34, 13.5);
    s += `<circle cx="${r2(x)}" cy="${r2(y)}" r="2.3" fill="#78AC43"/><circle cx="${r2(x - 0.7)}" cy="${r2(y - 0.7)}" r=".7" fill="#B3D77D"/>`;
  }
  s += `<g transform="translate(44 19)"><circle r="7.6" fill="#F4D23E"/><circle r="6.4" fill="#FBE27A"/>`;
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2;
    s += `<path d="M0 0L${r2(Math.cos(a) * 6.2)} ${r2(Math.sin(a) * 6.2)}" stroke="#F4D23E" stroke-width=".7"/>`;
  }
  s += `<circle r="1" fill="#F4D23E"/></g>`;
  s += leaf(17, 24, 7, 2.2, -40, '#4D8A47') + leaf(40, 44, 7, 2.2, 30, '#4D8A47');
  return s;
}

function pumpkin() {
  const rand = rng(5);
  let s = bowl('#DE7027');
  s += `<circle cx="30" cy="30" r="16" fill="#EC8B35" opacity=".7"/>`;
  s += `<path d="M32 32m-1.5 0a1.5 1.5 0 1 1 3 0a4 4 0 1 1 -7 -1a7 7 0 1 1 12 4" fill="none" stroke="#FFF6E6" stroke-width="2" stroke-linecap="round" opacity=".95"/>`;
  for (let i = 0; i < 6; i++) {
    const [x, y] = inCircle(rand, 32, 32, 17);
    s += `<ellipse cx="${r2(x)}" cy="${r2(y)}" rx="2.2" ry="1.1" transform="rotate(${Math.round(rand() * 180)} ${r2(x)} ${r2(y)})" fill="#3F5F2C"/>`;
  }
  s += dots(rand, 12, 32, 32, 19, 0.45, '#5B2C10');
  s += leaf(40, 22, 7, 2.3, -30, '#4C8746');
  return s;
}

function salmon() {
  const rand = rng(41);
  let s = plate;
  s += leaf(13, 41, 22, 7.5, -22, '#6AA04E', 'rgba(230,245,200,.8)') + leaf(16, 47, 20, 6.5, -4, '#5B9443', 'rgba(230,245,200,.8)') + leaf(50, 44, 17, 6, -150, '#77AC57', 'rgba(230,245,200,.8)');
  s += `<g transform="rotate(-16 32 28)"><rect x="17" y="20" width="30" height="16" rx="6" fill="#E9845A"/><rect x="17" y="20" width="30" height="16" rx="6" fill="none" stroke="#B9532C" stroke-width="1.2" opacity=".5"/>`;
  for (let i = 0; i < 5; i++) s += `<path d="M${22 + i * 5} 21.5c-1.6 4-1.6 9 0 13" fill="none" stroke="#F5B693" stroke-width=".9" opacity=".9"/>`;
  s += `<path d="M19 24c8-3 18-3 26 0" fill="none" stroke="#A84A23" stroke-width="2.4" stroke-linecap="round" opacity=".55"/></g>`;
  s += grains(rand, 10, 32, 27, 9, '#FBF4E2', '#E4D6B8', 0.9, 0.5);
  s += grains(rand, 5, 32, 27, 9, '#2A2622', '#2A2622', 0.8, 0.45);
  for (let i = 0; i < 5; i++) {
    const [x, y] = inCircle(rand, 34, 25, 9);
    s += `<circle cx="${r2(x)}" cy="${r2(y)}" r="1.3" fill="none" stroke="#7DB255" stroke-width=".8"/>`;
  }
  return s;
}

function tacos() {
  const rand = rng(77);
  let s = plate;
  const taco = (cx, cy, rot) => {
    let t = `<g transform="rotate(${rot} ${cx} ${cy})"><ellipse cx="${cx}" cy="${cy}" rx="21" ry="8.2" fill="#E8C077"/><ellipse cx="${cx}" cy="${cy}" rx="21" ry="8.2" fill="none" stroke="#CF9E4F" stroke-width=".9"/>`;
    t += `<ellipse cx="${cx}" cy="${cy}" rx="17" ry="4.2" fill="#3A2F28"/>`;
    for (let i = 0; i < 12; i++) t += `<circle cx="${r2(cx - 15 + rand() * 30)}" cy="${r2(cy - 2.6 + rand() * 5.2)}" r="${r2(1 + rand() * 0.6)}" fill="${['#241C18', '#4A3B31', '#D8452A', '#E9CE8A'][i % 4]}"/>`;
    t += `<path d="M${cx - 13} ${cy - 0.5}c4 2 8-2 12 0s8 2 12-0.5" fill="none" stroke="#FFF9EC" stroke-width="1.3" stroke-linecap="round"/>`;
    for (let i = 0; i < 4; i++) t += leaf(cx - 12 + i * 7, cy - 1.5 + (i % 2) * 2, 4, 1.6, rand() * 360, '#4E9447');
    for (let i = 0; i < 6; i++) t += `<circle cx="${r2(cx - 18 + rand() * 36)}" cy="${r2(cy + (rand() > 0.5 ? 6 : -6))}" r=".9" fill="#C08A3C" opacity=".7"/>`;
    return t + '</g>';
  };
  s += taco(31, 23, -12) + taco(33, 41, -12);
  s += `<g transform="translate(51 31) rotate(30)"><path d="M-6 0A6 6 0 0 1 6 0Z" fill="#8FBE45"/><path d="M-4.8 -0.2A4.8 4.8 0 0 1 4.8 -0.2Z" fill="#C9E28A"/></g>`;
  return s;
}

function risotto() {
  const rand = rng(91);
  let s = plate;
  s += `<path d="M12 32c0-11 9-19 20-19s20 8 20 19-9 20-20 20-20-9-20-20Z" fill="#E6D2A3"/>`;
  s += grains(rand, 40, 32, 32, 17, '#F3E5C1', '#D9C48F', 1.9, 1.05);
  const shroom = (x, y, rot, k = 1) =>
    `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${k})"><path d="M-6 0C-6 -4.5 -3 -6.5 0 -6.5S6 -4.5 6 0Z" fill="#8F6040"/><path d="M-5 0C-5 -3.2 -2.6 -5 0 -5S5 -3.2 5 0Z" fill="#B8875F"/><path d="M-2 0H2V4.5C2 5.6 1.2 6 0 6S-2 5.6 -2 4.5Z" fill="#D9B78F"/><path d="M-3.5 -.6L-1.6 -3.8M0 -.6V-4.4M3.5 -.6L1.6 -3.8" stroke="#7A4E30" stroke-width=".5"/></g>`;
  s += shroom(25, 26, -20) + shroom(39, 25, 25, 0.9) + shroom(31, 40, 10, 1.05) + shroom(42, 38, -35, 0.85) + shroom(20, 37, 40, 0.8);
  for (let i = 0; i < 7; i++) {
    const [x, y] = inCircle(rand, 32, 32, 15);
    s += `<path d="M${r2(x)} ${r2(y)}l2.6 -.8l-.6 2.4Z" fill="#FBF3DA" stroke="#E6D6AE" stroke-width=".3"/>`;
  }
  s += dots(rand, 14, 32, 32, 16, 0.6, '#4B8B45');
  return s;
}

function chicken() {
  const rand = rng(63);
  let s = plate;
  for (let i = 0; i < 7; i++) {
    const [x, y] = inCircle(rand, 32, 32, 16);
    const k = 5 + rand() * 1.5;
    s += `<rect x="${r2(x - k / 2)}" y="${r2(y - k / 2)}" width="${r2(k)}" height="${r2(k)}" rx="1.8" transform="rotate(${Math.round(rand() * 90)} ${r2(x)} ${r2(y)})" fill="#E4B458" stroke="#BF8530" stroke-width=".8"/>`;
  }
  const thigh = (x, y, rot, k) =>
    `<g transform="translate(${x} ${y}) rotate(${rot}) scale(${k})"><path d="M-9 -1C-9 -6 -4 -8 1 -7.5S9.5 -4 9 1S4 7.5 -1 7S-9 4 -9 -1Z" fill="#B9692A"/><path d="M-7 -2C-6.5 -5.5 -2.5 -6.5 1 -6S7.5 -3 7 0.5S3 5 -1 4.8S-7.2 1.5 -7 -2Z" fill="#D28440"/><ellipse cx="-1.5" cy="-2.8" rx="3.2" ry="1.6" fill="#E9A660" opacity=".9"/><circle cx="3" cy="2" r=".9" fill="#7E3F15"/><circle cx="-4" cy="2.2" r=".7" fill="#7E3F15"/><circle cx="4.6" cy="-2.5" r=".6" fill="#7E3F15"/></g>`;
  s += thigh(25, 26, -15, 1) + thigh(40, 30, 20, 0.95) + thigh(29, 41, 8, 0.9);
  const sprig = (x, y, rot) => {
    let g = `<g transform="translate(${x} ${y}) rotate(${rot})"><path d="M0 0H15" stroke="#55703F" stroke-width=".9" stroke-linecap="round"/>`;
    for (let i = 1; i < 7; i++) g += `<path d="M${i * 2.1} 0l1.4 -2.6M${i * 2.1} 0l1.4 2.6" stroke="#4F7F46" stroke-width="1" stroke-linecap="round"/>`;
    return g + '</g>';
  };
  s += sprig(14, 20, 30) + sprig(36, 50, -20);
  return s;
}

/** Cast-iron pan with eggs in sauce; the base for shakshuka and its look-alikes. */
function pan({ sauce, sauceDark, seed, eggs = 3, feta = true, herb = '#4E8C46', scrambled = false, beans = false }) {
  const rand = rng(seed);
  let s = `<circle cx="32" cy="32" r="31.5" fill="#2E2C29"/><circle cx="32" cy="32" r="29.5" fill="#3C3935"/><circle cx="32" cy="32" r="26.5" fill="${sauce}"/>`;
  for (let i = 0; i < 9; i++) {
    const [x, y] = inCircle(rand, 32, 32, 20);
    s += `<circle cx="${r2(x)}" cy="${r2(y)}" r="${r2(2 + rand() * 3)}" fill="${sauceDark}" opacity=".55"/>`;
  }
  const spots = [
    [24, 24],
    [41, 27],
    [30, 41],
    [44, 41],
  ].slice(0, eggs);
  for (const [x, y] of spots) {
    if (scrambled) {
      s += `<path d="M${x - 5} ${y}c1-4 6-5 8-2s1 6-3 6-6-1-5-4Z" fill="#F3CC54"/><path d="M${x - 2} ${y - 1}c1-1.5 3-1.6 3.6 0" fill="none" stroke="#FBE7A1" stroke-width="1"/>`;
    } else {
      s += `<path d="M${x - 7} ${y}c0-4.5 3-7 7.5-6.6S${x + 7.5} ${y - 3} ${x + 6.8} ${y + 1.5}S${x + 2} ${y + 7} ${x - 1.5} ${y + 6.4}S${x - 7} ${y + 3.5} ${x - 7} ${y}Z" fill="#FBF6EA"/><circle cx="${x}" cy="${y}" r="3.7" fill="#F2AE1C"/><circle cx="${x - 1.1}" cy="${y - 1.2}" r="1.1" fill="#F9D27A"/>`;
    }
  }
  if (beans) for (let i = 0; i < 12; i++) {
    const [x, y] = inCircle(rand, 32, 32, 20);
    s += `<ellipse cx="${r2(x)}" cy="${r2(y)}" rx="1.9" ry="1.2" transform="rotate(${Math.round(rand() * 180)} ${r2(x)} ${r2(y)})" fill="#F1E6CF"/>`;
  }
  if (feta) for (let i = 0; i < 9; i++) {
    const [x, y] = inCircle(rand, 32, 32, 21);
    s += `<rect x="${r2(x)}" y="${r2(y)}" width="2.4" height="2" rx=".4" transform="rotate(${Math.round(rand() * 90)} ${r2(x)} ${r2(y)})" fill="#FFFDF7"/>`;
  }
  s += dots(rand, 16, 32, 32, 22, 0.55, herb);
  return s;
}

export const DISHES = {
  dal: ['Spinach dal', dal],
  orzo: ['Lemon orzo with peas', orzo],
  pumpkin: ['Pumpkin soup', pumpkin],
  salmon: ['Miso salmon with greens', salmon],
  tacos: ['Black bean tacos', tacos],
  risotto: ['Mushroom risotto', risotto],
  chicken: ['Roast chicken thighs', chicken],
  shakshuka: ['Shakshuka with feta', () => pan({ sauce: '#C7391F', sauceDark: '#9E2A15', seed: 3 })],
  green: ['Green shakshuka', () => pan({ sauce: '#6F9B3E', sauceDark: '#4F7A2B', seed: 8, herb: '#2F5A2A' })],
  menemen: ['Menemen', () => pan({ sauce: '#D4552B', sauceDark: '#A83E1C', seed: 14, scrambled: true, feta: false, eggs: 4 })],
  beans: ['Baked eggs with white beans', () => pan({ sauce: '#B4462A', sauceDark: '#8D3219', seed: 21, eggs: 2, feta: false, beans: true })],
};

/** The sprite: one hidden <svg> with a <symbol> per dish. */
export function dishSprite() {
  const symbols = Object.entries(DISHES)
    .map(([id, [, draw]]) => `<symbol id="dish-${id}" viewBox="0 0 64 64">${draw()}</symbol>`)
    .join('');
  return `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false">${symbols}</svg>`;
}

/** Inline use of a dish; decorative, the dish name is always next to it in text. */
export const dish = (id, cls = 'size-11') => `<svg class="dish ${cls}" viewBox="0 0 64 64" aria-hidden="true" focusable="false"><use href="#dish-${id}"/></svg>`;
