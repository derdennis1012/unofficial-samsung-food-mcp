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

export const CONFIG_DIR = process.env.SAMSUNG_FOOD_HOME ?? path.join(os.homedir(), '.samsung-food');
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

export const LOGIN_HINT = 'Samsung Food login missing or expired. Run `sf login` (see README).';

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

/** Removes the session fields only; cached ids (mealPlanId, listId) stay. */
export function clearToken() {
  const { accessToken, expiresAt, renewedAt, savedAt, ...rest } = readAuthFile() ?? {};
  saveAuth(rest);
}

/** The file content without the SAMSUNG_FOOD_TOKEN override. */
export function readAuthFile() {
  try {
    return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'));
  } catch {
    return null;
  }
}
