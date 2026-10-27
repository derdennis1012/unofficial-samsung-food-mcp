/**
 * Builds the protocol schema on the user's machine.
 *
 * Samsung Food's web app ships generated gRPC-Web clients inside its public
 * JavaScript bundles. Those clients embed compact message descriptors such as
 * `function tR(){return[[1,"appName","enum",0],...]}` and RPC descriptors such
 * as `{name:"whisk.x.list.v1.ListAPI/GetLists",encode:...,decode:...}`.
 *
 * This module downloads the bundles into memory, scans them as plain text
 * (they are never evaluated), resolves the descriptors into a flat schema and
 * caches the result in the config directory. Nothing from Samsung is shipped
 * with this package.
 *
 * Output: { rpcs: {name: {request: Field[], response: Field[]}}, messages: {"<file>:<ident>": Field[]},
 *           meta: {builtAt, source, bundles} }
 */

import fs from 'node:fs';
import path from 'node:path';
import { CONFIG_DIR } from './auth.js';
import { writeFileAtomic } from './fsutil.js';

export const SCHEMA_FILE = path.join(CONFIG_DIR, 'schema.json');
export const APP_URL = 'https://app.samsungfood.com/';
const BUNDLE_RE = /https:\/\/cdn\.whisk\.com\/[^"]*main-[^"]*\.js/g;
const USER_AGENT = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

/* ------------------------------------------------------------------ Extraction */

/** Index of the `]` that closes the `[` at position i, respecting string literals. */
function matchBracket(s, i) {
  let depth = 0;
  let quote = null;
  for (let j = i; j < s.length; j++) {
    const c = s[j];
    if (quote) {
      if (c === '\\') j++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === '[') {
      depth++;
    } else if (c === ']') {
      depth--;
      if (depth === 0) return j;
    }
  }
  throw new Error('unbalanced brackets');
}

const IDENT = /(?<=[[,])([A-Za-z_$][A-Za-z0-9_$]*)(?=[,\]])/g;

/** Turns a descriptor literal into JSON; bare identifiers become "@ident" references. */
function toJson(text) {
  let prev = null;
  while (prev !== text) {
    prev = text;
    text = text.replace(IDENT, (_, id) => `"@${id}"`);
  }
  return JSON.parse(text);
}

/**
 * Scans one bundle's source text.
 * @param {string} key  bundle name without extension hash, e.g. "main-229eafb5"
 */
export function extractFromSource(key, src, msgs, rpcs) {
  // Message descriptors: function IDENT(){return[...]}
  const msgRe = /function ([A-Za-z_$][A-Za-z0-9_$]*)\(\)\{return(\[)/g;
  for (let m; (m = msgRe.exec(src)); ) {
    const start = m.index + m[0].length - 1;
    let end;
    try {
      end = matchBracket(src, start);
    } catch {
      continue;
    }
    if (src[end + 1] !== '}') continue;
    try {
      msgs[`${key}:${m[1]}`] = toJson(src.slice(start, end + 1));
    } catch {
      // not a descriptor
    }
  }

  // RPC descriptors: encode/decode are either inline functions or identifier references
  const rpcRe = /\{name:"([a-z][\w.]+\.[A-Za-z0-9]+API\/[A-Za-z0-9_]+)",/g;
  const inlineHead = 'function(){return[';
  for (let m; (m = rpcRe.exec(src)); ) {
    let pos = m.index + m[0].length;
    const parts = {};
    for (let n = 0; n < 2; n++) {
      const kw = /(encode|decode):/y;
      kw.lastIndex = pos;
      const mm = kw.exec(src);
      if (!mm) break;
      const which = mm[1];
      pos += mm[0].length;
      if (src.startsWith(inlineHead, pos)) {
        const start = pos + inlineHead.length - 1;
        let end;
        try {
          end = matchBracket(src, start);
        } catch {
          break;
        }
        try {
          parts[which] = toJson(src.slice(start, end + 1));
        } catch {
          parts[which] = null;
        }
        pos = end + 2; // past "]}"
      } else {
        const id = /[A-Za-z_$][A-Za-z0-9_$]*/y;
        id.lastIndex = pos;
        const mi = id.exec(src);
        if (!mi) break;
        parts[which] = ['@ref', mi[0]];
        pos += mi[0].length;
      }
      if (src[pos] === ',') pos++;
    }
    if (Object.keys(parts).length) {
      rpcs[m[1]] = { file: key, request: parts.encode ?? null, response: parts.decode ?? null };
    }
  }
}

/* ------------------------------------------------------------------ Resolution */

/** Resolves raw descriptors ({msgs, rpcs}) into { rpcs, messages }. */
export function resolve(msgs, rpcs) {
  const typ = (file, t) => {
    if (typeof t === 'string') {
      if (t.startsWith('@')) {
        const k = `${file}:${t.slice(1)}`;
        return k in msgs ? ['msg', k] : ['unknown', t.slice(1)];
      }
      return ['scalar', t];
    }
    if (Array.isArray(t) && t.length && ['repeated', 'map', 'wrapper'].includes(t[0])) {
      return [t[0], t.slice(1)];
    }
    return ['?', t];
  };

  const fields = (file, list) => {
    const out = [];
    for (const f of list ?? []) {
      const [num, name, t] = f;
      const repeated = f.length > 3 && f[3] === 1;
      const oneof = f.length > 4 ? f[4] : null;
      const [k, d] = typ(file, t);
      const e = { n: num, name };
      if (k === 'scalar') {
        e.type = d;
      } else if (k === 'msg') {
        e.type = 'message';
        e.ref = d;
      } else if (k === 'repeated') {
        const [k2, d2] = typ(file, d[0]);
        e.repeated = true;
        if (k2 === 'msg') {
          e.type = 'message';
          e.ref = d2;
        } else if (k2 === 'scalar') {
          e.type = d2;
        } else {
          e.type = 'unknown';
          e.raw = d[0];
        }
      } else if (k === 'wrapper') {
        const [k2, d2] = typ(file, d[0]);
        e.type = 'wrapper';
        e.value = k2 === 'scalar' ? d2 : 'message';
        if (k2 === 'msg') e.ref = d2;
      } else if (k === 'map') {
        e.type = 'map';
        e.raw = d;
      } else {
        e.type = 'unknown';
        e.raw = t;
      }
      if (oneof) e.oneof = oneof;
      out.push(e);
    }
    return out;
  };

  const messages = {};
  for (const [k, v] of Object.entries(msgs)) messages[k] = fields(k.split(':')[0], v);

  const side = (file, v) => {
    if (v == null) return [];
    if (Array.isArray(v) && v.length === 2 && v[0] === '@ref') {
      const k = `${file}:${v[1]}`;
      return k in msgs ? fields(file, msgs[k]) : [];
    }
    return fields(file, v);
  };

  const out = {};
  for (const [name, r] of Object.entries(rpcs)) {
    out[name] = { request: side(r.file, r.request), response: side(r.file, r.response) };
  }
  return { rpcs: out, messages };
}

/* ------------------------------------------------------------------ Build + cache */

const FETCH_TIMEOUT_MS = 30000;
const BUILD_BUDGET_MS = 120000;

async function fetchText(url, fetchImpl) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: '*/*' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`GET ${url} failed: HTTP ${res.status}`);
  return res.text();
}

/**
 * Downloads the web app and its bundles, builds the schema and writes it to SCHEMA_FILE.
 * Bundles are treated as data only; they are scanned as text and never executed.
 */
export async function buildSchema({ log = () => {}, fetchImpl = globalThis.fetch, file = SCHEMA_FILE } = {}) {
  fetchImpl ??= globalThis.fetch;
  log(`Fetching ${APP_URL}`);
  const html = await fetchText(APP_URL, fetchImpl);
  const urls = [...new Set(html.match(BUNDLE_RE) ?? [])].sort((a, b) => path.posix.basename(a).localeCompare(path.posix.basename(b)));
  if (!urls.length) {
    throw new Error(`No bundle URLs (cdn.whisk.com/.../main-*.js) found in ${APP_URL}; the web app layout may have changed.`);
  }

  const msgs = {};
  const rpcs = {};
  const deadline = Date.now() + BUILD_BUDGET_MS;
  for (const url of urls) {
    if (Date.now() > deadline) throw new Error('Building the schema took too long; check your connection.');
    const base = path.posix.basename(new URL(url).pathname);
    log(`Fetching ${base}`);
    extractFromSource(base.split('.')[0], await fetchText(url, fetchImpl), msgs, rpcs);
  }

  const schema = resolve(msgs, rpcs);
  if (!Object.keys(schema.rpcs).length) {
    throw new Error('No RPC descriptors found in the downloaded bundles; the bundle format may have changed.');
  }
  schema.meta = { builtAt: new Date().toISOString(), source: APP_URL, bundles: urls.length };

  writeFileAtomic(file, JSON.stringify(schema), 0o644);
  return schema;
}

/** Reads the cached schema, or null if it has not been built yet. */
export function readSchema(file = SCHEMA_FILE) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

const MAX_AGE_MS = 7 * 24 * 3600 * 1000;

/**
 * Returns the cached schema, building it first if it is missing. A cache older than
 * 7 days is refreshed (in the background if `background` is set); if that fails the stale cache is used.
 */
export async function ensureSchema({ log = (m) => process.stderr.write(`${m}\n`), file = SCHEMA_FILE, maxAgeMs = MAX_AGE_MS, background = false, fetchImpl } = {}) {
  const cached = readSchema(file);
  if (cached) {
    const builtAt = cached.meta?.builtAt ? Date.parse(cached.meta.builtAt) : 0;
    if (Date.now() - builtAt <= maxAgeMs) return cached;
    if (background) {
      // Long-running server: keep serving the cached copy, refresh for the next start.
      buildSchema({ log: () => {}, file, fetchImpl }).catch((err) => log(`Could not refresh the protocol schema (${err.message}).`));
      return cached;
    }
    try {
      return await buildSchema({ log: () => {}, file, fetchImpl });
    } catch (err) {
      log(`Could not refresh the protocol schema (${err.message}); using the cached copy.`);
      return cached;
    }
  }
  log(`No protocol schema found at ${file}. Building it once from the public Samsung Food web app (this takes a few seconds)...`);
  return buildSchema({ log: () => {}, file, fetchImpl });
}

/** Summary for `sf status`. */
export function schemaInfo(file = SCHEMA_FILE) {
  const s = readSchema(file);
  if (!s) return null;
  const builtAt = s.meta?.builtAt ? new Date(s.meta.builtAt) : fs.statSync(file).mtime;
  return {
    file,
    builtAt,
    ageDays: Math.floor((Date.now() - builtAt.getTime()) / 86400000),
    rpcs: Object.keys(s.rpcs).length,
    messages: Object.keys(s.messages).length,
  };
}
