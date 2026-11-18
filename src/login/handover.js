/**
 * Samsung session handover: the shared core of `sf login` (local page on 127.0.0.1) and the hosted
 * connector's consent page.
 *
 * A pending login is created when the login page is rendered. It has
 *   - a nonce (32 random bytes): embedded in the page and in the bookmarklet, and sent back in the
 *     URL fragment and the POST body. Fragments never reach the server, so neither the nonce nor the
 *     cookie appear in access logs.
 *   - a browser binding: a random cookie value set on the login page. Only its hash is kept. Every
 *     handover/status request must carry the same cookie, so an attacker cannot make a victim's
 *     browser complete the attacker's pending login (login CSRF / session fixation) or vice versa.
 *   - an expiry (10 minutes) and a small number of attempts.
 * A pending login yields at most one verified session: after `verify` succeeds it can only be
 * read (status) and taken once (take).
 */

import crypto from 'node:crypto';
import { extractToken } from '../core/auth.js';

export const HANDOVER_TTL_MS = 10 * 60 * 1000;
export const MAX_ATTEMPTS = 5;
export const MAX_PENDING = 2000;
export const MAX_PENDING_PER_OWNER = 5;

export class HandoverError extends Error {
  /** @param {'unknown'|'expired'|'browser'|'used'|'no_token'|'rejected'|'failed'|'busy'|'too_many'} code */
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

const sha256 = (v) => crypto.createHash('sha256').update(String(v)).digest();
const sameHash = (a, b) => a.length === b.length && crypto.timingSafeEqual(a, b);
export const randomId = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');

const MESSAGES = {
  unknown: 'This login link is not valid (anymore). Start the login again.',
  expired: 'This login link has expired. Start the login again.',
  browser: 'This login was started in a different browser. Open app.samsungfood.com in the same browser as this page, or paste the value below.',
  used: 'This login link was already used. Start the login again.',
  no_token: 'No Samsung Food session found in the pasted text. Copy it again (see the steps above).',
  failed: 'Too many failed attempts. Start the login again.',
  busy: 'The check is still running. Wait a moment.',
};

/**
 * @param {object} o
 * @param {(token: string, pending: object) => Promise<{account: string}>} o.verify
 *        checks the token with Samsung Food (GetMe); throws on a rejected token. The returned object is
 *        kept as `result` (it may carry more than `account`, e.g. the token for the hosted approval).
 * @param {number} [o.ttlMs]
 * @param {() => number} [o.now]
 * @param {number} [o.maxPending]   pool size; when full, the oldest login nobody has handed a session to yet is dropped
 * @param {number} [o.maxPerOwner]  pending logins per owner (the hosted connector passes the client network)
 */
export function createHandover({ verify, ttlMs = HANDOVER_TTL_MS, now = Date.now, maxAttempts = MAX_ATTEMPTS, maxPending = MAX_PENDING, maxPerOwner = MAX_PENDING_PER_OWNER } = {}) {
  const pending = new Map();

  function sweep() {
    const t = now();
    for (const [k, p] of pending) if (p.expiresAt <= t) pending.delete(k);
  }

  /** Looks up a pending login and checks the browser binding. */
  function lookup(nonce, cookie) {
    const p = typeof nonce === 'string' && nonce.length <= 100 ? pending.get(nonce) : undefined;
    if (!p) throw new HandoverError('unknown', MESSAGES.unknown, 404);
    if (p.expiresAt <= now()) {
      pending.delete(nonce);
      throw new HandoverError('expired', MESSAGES.expired, 410);
    }
    if (typeof cookie !== 'string' || !cookie || !sameHash(sha256(cookie), p.cookieHash)) {
      throw new HandoverError('browser', MESSAGES.browser, 403);
    }
    return p;
  }

  return {
    /**
     * Starts a pending login. Returns { nonce, cookie, expiresAt }; `extra` stays with it (e.g. OAuth
     * parameters). With an `owner`, that owner keeps at most `maxPerOwner` pending logins (its oldest
     * unverified one is replaced). A full pool drops its oldest unverified login instead of refusing
     * everybody; only a pool full of verified logins refuses.
     */
    begin(extra = {}, { owner } = {}) {
      sweep();
      // Map order is creation order, so the first match is the oldest.
      const oldestUnverified = (match = () => true) => {
        for (const [k, p] of pending) if (p.status === 'pending' && match(p)) return k;
        return null;
      };
      if (owner !== undefined) {
        let mine = 0;
        for (const p of pending.values()) if (p.owner === owner) mine++;
        if (mine >= maxPerOwner) {
          const k = oldestUnverified((p) => p.owner === owner);
          if (k === null) throw new HandoverError('too_many', 'Too many logins in progress from your network. Try again in a few minutes.', 429);
          pending.delete(k);
        }
      }
      if (pending.size >= maxPending) {
        const k = oldestUnverified();
        if (k === null) throw new HandoverError('too_many', 'Too many logins in progress. Try again in a few minutes.', 503);
        pending.delete(k);
      }
      const nonce = randomId();
      const cookie = randomId();
      const expiresAt = now() + ttlMs;
      pending.set(nonce, { cookieHash: sha256(cookie), expiresAt, attempts: 0, status: 'pending', extra, result: null, owner });
      return { nonce, cookie, expiresAt };
    },

    /**
     * Receives the pasted text or the bookmarklet's cookie, extracts the token and verifies it.
     * @returns {Promise<{account: string}>}
     */
    async submit(nonce, cookie, credential) {
      const p = lookup(nonce, cookie);
      if (p.status === 'verifying') throw new HandoverError('busy', MESSAGES.busy, 409);
      if (p.status !== 'pending') throw new HandoverError('used', MESSAGES.used, 409);
      if (p.attempts >= maxAttempts) throw new HandoverError('failed', MESSAGES.failed, 429);
      p.attempts++;
      const token = extractToken(credential);
      if (!token) throw new HandoverError('no_token', MESSAGES.no_token, 400);
      p.status = 'verifying';
      try {
        p.result = await verify(token, p);
        p.status = 'verified';
        return { account: p.result.account };
      } catch (err) {
        p.status = p.attempts >= maxAttempts ? 'failed' : 'pending';
        throw err instanceof HandoverError ? err : new HandoverError('rejected', String(err?.message ?? err), 400);
      }
    },

    /** { status: 'pending'|'verifying'|'verified'|'failed', account? } for the page that waits. */
    status(nonce, cookie) {
      const p = lookup(nonce, cookie);
      return { status: p.status, ...(p.status === 'verified' ? { account: p.result.account } : {}), expiresAt: p.expiresAt };
    },

    /** The verified pending login without consuming it (to validate a follow-up form first). */
    peek(nonce, cookie) {
      const p = lookup(nonce, cookie);
      return p;
    },

    /** Removes and returns a pending login (verified or not); single use. */
    take(nonce, cookie) {
      const p = lookup(nonce, cookie);
      pending.delete(nonce);
      return p;
    },

    /** Drops a pending login without checks (cleanup after a failure elsewhere). */
    drop(nonce) {
      pending.delete(nonce);
    },

    get size() {
      return pending.size;
    },
  };
}

/** Cookie that binds a pending login to the browser that opened the login page. */
export const LOGIN_COOKIE = 'sf_login';

export function loginCookieHeader(value, { secure, maxAgeSec = HANDOVER_TTL_MS / 1000 }) {
  // Lax (not Strict): the bookmarklet arrives through a top-level navigation from app.samsungfood.com.
  return `${LOGIN_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.round(maxAgeSec)}${secure ? '; Secure' : ''}`;
}

export function readCookie(header, name = LOGIN_COOKIE) {
  for (const part of String(header ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i !== -1 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}
