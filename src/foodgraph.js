/**
 * Shelf lives from Samsung Food's public food graph.
 *
 * When a pantry item is created, Samsung Food only sets an expiry date if the
 * ingredient has exactly one possible storage location in the graph. Chicken
 * breast can be fridge (1-2 days) or freezer (9 months), so the date stays
 * empty. With this data it can be computed once the location is known.
 *
 * The graph is downloaded from https://cdn.whisk.com/autocomplete/v1/<locale>/all.json
 * (public, no token) on first use and cached per locale in the config directory.
 * It is not distributed with this package.
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './auth.js';
import { today, addDays } from './dates.js';
import { writeFileAtomic } from './fsutil.js';
import { USER_AGENT } from './version.js';

const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

/** Storage location enum of the FoodlistAPI. */
export const LOCATION = { fridge: 1, freezer: 2, pantry: 3 };
export const LOCATION_LABEL = { 1: 'Fridge', 2: 'Freezer', 3: 'Pantry' };
const LOCATION_BY_CODE = { 1: 'fridge', 2: 'freezer', 3: 'pantry' };

const ALIASES = {
  fridge: 'fridge', refrigerator: 'fridge', cold: 'fridge',
  freezer: 'freezer', frozen: 'freezer',
  pantry: 'pantry', cupboard: 'pantry', larder: 'pantry',
  // German aliases
  kühlschrank: 'fridge', kuehlschrank: 'fridge', kühl: 'fridge',
  gefrierschrank: 'freezer', tiefkühler: 'freezer', tiefkuehler: 'freezer',
  gefrier: 'freezer', tk: 'freezer',
  vorratsschrank: 'pantry', vorrat: 'pantry', speisekammer: 'pantry',
};

/** "en-US" -> "en-us" (the CDN path is lowercase). */
export const graphLocale = (locale) => String(locale ?? 'en-US').toLowerCase();

const graphFile = (locale) => path.join(CONFIG_DIR, `foodgraph-${graphLocale(locale)}.json`);

/**
 * Converts the raw CDN payload into { locale, products } keyed by lowercase display name.
 * Only storage entries with a numeric duration are kept; products without any are dropped.
 */
export function transformGraph(raw, locale) {
  const products = {};
  for (const p of raw.products ?? []) {
    const { defaultLocation, ...all } = p.metadata?.storing ?? {};
    const storing = Object.fromEntries(Object.entries(all).filter(([, v]) => typeof v?.max === 'number'));
    if (!Object.keys(storing).length) continue;
    const key = String(p.displayName).trim().toLowerCase();
    if (products[key]) continue;
    products[key] = {
      canonicalName: p.name,
      displayName: p.displayName,
      category: p.metadata.category,
      default: defaultLocation?.toLowerCase(),
      storing,
    };
  }
  return { locale: graphLocale(locale), products };
}

let graph = null;

/**
 * Makes the food graph for a locale available (cache first, refreshed after 30 days).
 * A stale cache is used if the refresh fails.
 */
export async function loadGraph(locale = 'en-US', { fetchImpl = globalThis.fetch } = {}) {
  const loc = graphLocale(locale);
  if (graph?.locale === loc) return graph;

  const file = graphFile(loc);
  let cached = null;
  let fresh = false;
  try {
    cached = JSON.parse(fs.readFileSync(file, 'utf8'));
    fresh = Date.now() - fs.statSync(file).mtimeMs < MAX_AGE_MS;
  } catch {
    // not cached yet
  }

  if (!fresh) {
    try {
      const url = `https://cdn.whisk.com/autocomplete/v1/${loc}/all.json`;
      const res = await fetchImpl(url, { headers: { 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
      cached = transformGraph(await res.json(), loc);
      writeFileAtomic(file, JSON.stringify(cached), 0o644);
    } catch (err) {
      if (!cached) {
        throw new Error(`Could not download the food graph for locale "${loc}": ${err.message}`);
      }
    }
  }
  graph = cached;
  return graph;
}


/** "Tiefkühler" | "freezer" | 2 -> "freezer" */
export function normalizeLocation(value) {
  if (value == null) return null;
  if (typeof value === 'number') return LOCATION_BY_CODE[value] ?? null;
  const key = String(value).trim().toLowerCase();
  return ALIASES[key] ?? (LOCATION[key] ? key : null);
}

export function locationCode(value) {
  const loc = normalizeLocation(value);
  return loc ? LOCATION[loc] : null;
}

/** Word tokens with a light singular form ("tomatoes" -> "tomato", "cherries" -> "cherry"). */
const tokensOf = (text) =>
  String(text)
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((t) => {
      if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
      if (t.length > 4 && t.endsWith('oes')) return t.slice(0, -2);
      if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
      return t;
    });

/** Spelling variants of the last word: English plural/singular plus the common German endings. */
function numberVariants(key) {
  const m = /^(.*?)(\p{L}+)$/u.exec(key);
  if (!m) return [];
  const [, head, w] = m;
  const out = new Set([`${w}s`, `${w}es`]);
  if (w.endsWith('ies')) out.add(`${w.slice(0, -3)}y`);
  if (w.endsWith('y')) out.add(`${w.slice(0, -1)}ies`);
  for (const suffix of ['es', 's', 'en', 'er', 'e', 'n']) {
    if (w.length > suffix.length + 2 && w.endsWith(suffix)) out.add(w.slice(0, -suffix.length));
  }
  out.delete(w);
  return [...out].map((v) => head + v);
}

/** Index of i where `needle` occurs as a contiguous run in `hay`, or -1. */
function indexOfRun(hay, needle) {
  outer: for (let i = 0; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (hay[i + j] !== needle[j]) continue outer;
    return i;
  }
  return -1;
}

const tokenIndex = new WeakMap();
function productTokens(g) {
  let idx = tokenIndex.get(g);
  if (!idx) {
    idx = Object.entries(g.products).map(([k, v]) => ({ tokens: tokensOf(k), entry: v }));
    tokenIndex.set(g, idx);
  }
  return idx;
}

/**
 * Looks up an ingredient in the graph.
 * exact: the name itself or a singular/plural spelling of it ("apples" -> Apple).
 * Otherwise whole-word matching (never inside words, so "toilet paper" does not hit Oil):
 * a product whose words all occur in the name ("uht milk" -> Milk, the longest product wins),
 * then a product that contains all words of the name ("chicken" -> Chicken breast, the shortest wins).
 * Those are guesses and come back with exact: false.
 * @returns {{entry: object, exact: boolean}|null}
 */
export function match(name) {
  if (!graph) return null; // not loaded (e.g. offline): callers degrade gracefully
  const { products } = graph;
  const key = String(name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (!key) return null;
  if (Object.hasOwn(products, key)) return { entry: products[key], exact: true };
  for (const v of numberVariants(key)) {
    if (Object.hasOwn(products, v)) return { entry: products[v], exact: true };
  }

  const q = tokensOf(key);
  if (!q.length) return null;
  let best = null;
  for (const p of productTokens(graph)) {
    if (!p.tokens.length) continue;
    if (p.tokens.length === q.length && indexOfRun(q, p.tokens) === 0) return { entry: p.entry, exact: true };
    if (p.tokens.length < q.length && indexOfRun(q, p.tokens) >= 0) {
      if (!best || best.reverse || p.tokens.length > best.size) best = { entry: p.entry, size: p.tokens.length, reverse: false };
    } else if (p.tokens.length > q.length && indexOfRun(p.tokens, q) >= 0) {
      if (!best || (best.reverse && p.tokens.length < best.size)) best = { entry: p.entry, size: p.tokens.length, reverse: true };
    }
  }
  return best ? { entry: best.entry, exact: false } : null;
}

/** The graph entry for an ingredient (exact or best guess), or null. */
export function lookup(name) {
  return match(name)?.entry ?? null;
}

const DAYS_PER = { days: 1, weeks: 7, months: 30, years: 365 };

/** Shelf life in days for a storage location; uses the upper bound. */
export function shelfLifeDays(entry, location) {
  const loc = normalizeLocation(location);
  const s = entry?.storing?.[loc];
  if (!s) return null;
  const per = DAYS_PER[String(s.metric).toLowerCase()];
  if (!per) return null;
  return Math.round(s.max * per);
}

/**
 * Where does the ingredient belong, and how long does it keep there?
 * @returns {{product, locations, suggestedLocation, ambiguous, options}|null}
 */
export function storageInfo(name) {
  const m = match(name);
  if (!m) return null;
  const { entry, exact } = m;
  const locations = Object.keys(entry.storing);
  const suggested = entry.default && entry.storing[entry.default] ? entry.default : locations[0];
  return {
    product: entry.displayName,
    canonicalName: entry.canonicalName,
    category: entry.category,
    locations,
    suggestedLocation: suggested,
    ambiguous: locations.length > 1,
    exact,
    ...(exact
      ? {}
      : { warning: `"${name}" is not in the food graph; closest product is "${entry.displayName}". Check before relying on the shelf life.` }),
    options: Object.fromEntries(
      locations.map((l) => [
        l,
        { label: LOCATION_LABEL[LOCATION[l]], days: shelfLifeDays(entry, l), ...entry.storing[l] },
      ])
    ),
  };
}

/** Expiry date as YYYY-MM-DD for ingredient + location, or null. Only for exact matches: a guess never sets a date. */
export function expiryFor(name, location, from = new Date()) {
  const m = match(name);
  const entry = m?.exact ? m.entry : null;
  const days = shelfLifeDays(entry, location);
  if (days == null) return null;
  return addDays(today(from), days);
}
