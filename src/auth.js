/**
 * Token management.
 *
 * Samsung Food authenticates with `Authorization: Bearer <accessToken>`.
 * The login itself runs on a separate domain (login.whisk.com) with a captcha,
 * so the session token is taken once from the browser (cookie `whisk.USER_TOKEN`)
 * and then renewed automatically (see session.js).
 *
 * Storage: ~/.samsung-food/auth.json (chmod 600)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { writeFileAtomic } from './fsutil.js';

// An empty value falls back to the default; a relative one is resolved against the working directory.
export const CONFIG_DIR = path.resolve(process.env.SAMSUNG_FOOD_HOME || path.join(os.homedir(), '.samsung-food'));
export const AUTH_FILE = path.join(CONFIG_DIR, 'auth.json');

/** decodeURIComponent that tolerates malformed escapes. */
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

/**
 * Extracts the session token from whatever the user pasted: a cookie string
 * (`document.cookie`), a `-b`/`Cookie:` header of a cURL command, an
 * `Authorization: Bearer` header or cURL `-H`, `Bearer <token>`, or the bare token.
 */
export function extractToken(input) {
  const text = String(input ?? '').trim();
  if (!text) return null;

  const cookie = text.match(/(?:^|[\s;'"])whisk\.USER_TOKEN=([^;\s'"]+)/);
  if (cookie) {
    return safeDecode(cookie[1]);
  }

  const fromHeader = text.match(/authorization:\s*bearer\s+([\w.\-+/=~]+)/i);
  if (fromHeader) return fromHeader[1];

  const bare = text.replace(/^['"]|['"]$/g, '').match(/^(?:Bearer\s+)?([A-Za-z0-9]{40,})$/);
  return bare ? bare[1] : null;
}

/** Whether pasted text looks like a Samsung Food credential (used before trusting the clipboard). */
export function looksLikeCredential(input) {
  const text = String(input ?? '').trim();
  return /whisk\.USER_TOKEN=/.test(text) || /^(?:Bearer\s+)?[A-Za-z0-9]{40,}$/.test(text.replace(/^['"]|['"]$/g, ''));
}

export function loadAuth() {
  try {
    const raw = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
    if (process.env.SAMSUNG_FOOD_TOKEN) raw.accessToken = process.env.SAMSUNG_FOOD_TOKEN;
    return raw;
  } catch {
    if (process.env.SAMSUNG_FOOD_TOKEN) return { accessToken: process.env.SAMSUNG_FOOD_TOKEN };
    return null;
  }
}

/** Atomic write (tmp file + rename), mode 600. */
export function saveAuth(data) {
  writeFileAtomic(AUTH_FILE, JSON.stringify(data, null, 2));
  return AUTH_FILE;
}

export const LOGIN_HINT = 'Samsung Food login missing or expired. Run `sf login` to connect again: it opens a page with a one-click button (see docs/getting-started.md).';

export function requireToken() {
  const auth = loadAuth();
  if (!auth?.accessToken) throw new Error(LOGIN_HINT);
  return auth;
}

/** Cache for context that rarely changes (mealPlanId, primary list, user). */
export function updateAuth(patch) {
  // Read the file itself: an SAMSUNG_FOOD_TOKEN override must never be written to disk.
  const current = readAuthFile() ?? {};
  return saveAuth({ ...current, ...patch });
}

/** Logout: removes the stored session completely (token, expiry, account id and the cached meal plan id). */
export function clearToken() {
  fs.rmSync(AUTH_FILE, { force: true });
}

/** The file content without the SAMSUNG_FOOD_TOKEN override. */
export function readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Token stores. The client and the session code read and write the session through a store, so a
 * client can run with something other than the global auth.json (the hosted connector keeps one
 * encrypted record per user). A store is { load(), update(patch), unset(keys), renewable() }:
 *   load()       the effective session ({ accessToken, expiresAt, mealPlanId, ... }) or null
 *   update(p)    merges p into the persisted session
 *   unset(keys)  removes keys from the persisted session (no write when none of them is present)
 *   renewable()  whether a renewed token can be stored (false for a token from the environment)
 * Optional `key`: renewals of stores with the same key are shared (one renewal at a time).
 */
export const fileTokenStore = {
  load: loadAuth,
  update: updateAuth,
  unset(keys) {
    const file = readAuthFile();
    if (!file || !keys.some((k) => k in file)) return;
    const rest = { ...file };
    for (const k of keys) delete rest[k];
    saveAuth(rest);
  },
  renewable: () => !process.env.SAMSUNG_FOOD_TOKEN,
};

/** A store that keeps the session in memory only; `onChange(data)` is called after every write. */
export function memoryTokenStore(initial = {}, { onChange = () => {}, key } = {}) {
  let data = { ...initial };
  return {
    key,
    load: () => (data.accessToken ? { ...data } : null),
    update(patch) {
      data = { ...data, ...patch };
      onChange({ ...data });
      return data;
    },
    unset(keys) {
      if (!keys.some((k) => k in data)) return;
      data = { ...data };
      for (const k of keys) delete data[k];
      onChange({ ...data });
    },
    renewable: () => true,
  };
}
