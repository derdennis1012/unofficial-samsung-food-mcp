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
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30000) });
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

/** Looks up an ingredient in the graph: exact match first, then substring. */
export function lookup(name) {
  if (!graph) return null; // not loaded (e.g. offline): callers degrade gracefully
  const { products } = graph;
  const key = String(name ?? '').trim().toLowerCase();
  if (!key) return null;
  if (products[key]) return products[key];

  const singular = key.replace(/(en|er|e|n|s)$/u, '');
  if (products[singular]) return products[singular];

  for (const [k, v] of Object.entries(products)) {
    if (k.includes(key) || key.includes(k)) return v;
  }
  return null;
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
  const entry = lookup(name);
  if (!entry) return null;
  const locations = Object.keys(entry.storing);
  const suggested = entry.default && entry.storing[entry.default] ? entry.default : locations[0];
  return {
    product: entry.displayName,
    canonicalName: entry.canonicalName,
    category: entry.category,
    locations,
    suggestedLocation: suggested,
    ambiguous: locations.length > 1,
    options: Object.fromEntries(
      locations.map((l) => [
        l,
        { label: LOCATION_LABEL[LOCATION[l]], days: shelfLifeDays(entry, l), ...entry.storing[l] },
      ])
    ),
  };
}

/** Expiry date as YYYY-MM-DD for ingredient + location, or null. */
export function expiryFor(name, location, from = new Date()) {
  const entry = lookup(name);
  const days = shelfLifeDays(entry, location);
  if (days == null) return null;
  return addDays(today(from), days);
}
