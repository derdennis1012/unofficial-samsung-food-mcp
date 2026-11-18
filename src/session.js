/**
 * Session handling: login validation, token renewal and automatic renewal.
 *
 * The web app keeps its session token in the cookie `whisk.USER_TOKEN`. A token
 * lasts 14 days and is renewed through the login origin: AuthAPI/IssueAuthCode
 * returns a single-use code, AuthAPI/UseAuthCode exchanges it for a new token.
 * Both calls carry the current token as bearer and are sent without the
 * X-Whisk-App-Version / X-Whisk-Device-Type headers, like the web app does.
 */

import { loadAuth, readAuthFile, saveAuth, extractToken, fileTokenStore, LOGIN_HINT } from './auth.js';

export const LOGIN_ORIGIN = 'https://login.whisk.com';
const RENEW_BELOW_MS = 7 * 24 * 3600 * 1000;
const RETRY_AFTER_FAILURE_MS = 10 * 60 * 1000;

const ISSUE = 'whisk.x.user.v1.AuthAPI/IssueAuthCode';
const USE = 'whisk.x.user.v1.AuthAPI/UseAuthCode';

/**
 * Exchanges the current token for a fresh one and stores it in `store` (default: auth.json).
 * Returns { expiresAt, renewedAt }.
 */
export async function renewToken({ codec, transport, token, store = fileTokenStore }) {
  for (const m of [ISSUE, USE]) {
    if (!codec.schema.rpcs[m]) {
      throw new Error(`The protocol schema lacks ${m}. Run: sf schema update`);
    }
  }
  const opts = { token, baseUrl: LOGIN_ORIGIN, path: '/api/grpc-web', bare: true };
  const issued = codec.decodeResponse(ISSUE, await transport.call(ISSUE, codec.encodeRequest(ISSUE, {}), opts));
  if (!issued.code) throw new Error('Token renewal failed: no auth code returned.');
  const used = codec.decodeResponse(
    USE,
    await transport.call(USE, codec.encodeRequest(USE, { code: issued.code }), opts)
  );
  const fresh = used.authenticated?.token;
  if (!fresh?.accessToken) throw new Error('Token renewal failed: no token returned.');

  const now = new Date();
  const expiresAt = new Date(now.getTime() + Number(fresh.expiresIn || 14 * 86400) * 1000).toISOString();
  const renewedAt = now.toISOString();
  await store.update({ accessToken: fresh.accessToken, expiresAt, renewedAt });
  return { expiresAt, renewedAt };
}

const needsRenewal = (auth) =>
  !auth.expiresAt || new Date(auth.expiresAt).getTime() - Date.now() < RENEW_BELOW_MS;

/** Renewal state per store (or per store key): the shared in-flight renewal and the last failure. */
const renewalState = new Map();
const stateFor = (store) => {
  const k = store.key ?? store;
  let st = renewalState.get(k);
  if (!st) renewalState.set(k, (st = { inflight: null, lastFailure: 0 }));
  return st;
};

function requireSession(store) {
  const auth = store.load();
  if (!auth?.accessToken) throw new Error(LOGIN_HINT);
  return auth;
}

/**
 * Returns a usable token, renewing it first if its expiry is unknown or less than
 * 7 days away. Concurrent callers share one renewal; the store is re-read before
 * renewing in case another process already did it. A failed renewal only warns.
 */
export async function ensureFreshToken({ codec, transport, warn = (m) => process.stderr.write(`${m}\n`), store = fileTokenStore }) {
  const auth = requireSession(store);
  // A token from the environment cannot be persisted, so it is never renewed.
  if (store.renewable?.() === false || !needsRenewal(auth)) return auth.accessToken;
  const st = stateFor(store);
  if (Date.now() - st.lastFailure < RETRY_AFTER_FAILURE_MS) return auth.accessToken;

  if (st.inflight) return st.inflight;
  // Assign first, then attach the cleanup: if the body finished before the assignment (all of it can
  // run synchronously), a `finally` inside it would reset `inflight` too early and the settled
  // promise would stay cached forever.
  const p = (async () => {
    try {
      const again = requireSession(store);
      if (!needsRenewal(again)) return again.accessToken;
      await renewToken({ codec, transport, token: again.accessToken, store });
      return requireSession(store).accessToken;
    } catch (err) {
      st.lastFailure = Date.now();
      warn(`samsung-food: token renewal failed (${err.message}); continuing with the current token.`);
      return requireSession(store).accessToken;
    }
  })();
  st.inflight = p;
  p.finally(() => {
    if (st.inflight === p) st.inflight = null;
    // Keyed stores (one per hosted user) must not accumulate state after a good renewal.
    if (!st.inflight && !st.lastFailure && store.key !== undefined) renewalState.delete(store.key);
  }).catch(() => {});
  return p;
}

/**
 * Validates pasted credentials (cookie string, token, cURL ...), renews right away to
 * learn the expiry, and stores the result. `client` is a SamsungFood instance.
 * @returns {{account: string, expiresAt: string|null, renewed: boolean}}
 */
export async function loginWithCredential(client, input) {
  const token = extractToken(input);
  if (!token) throw new Error('No token recognized in the input.');

  // Probe with an explicit token so no stored one is used or renewed.
  const probe = new client.constructor({ schema: client.schema, transport: client.transport, locale: client.locale, token });
  let me;
  try {
    me = await probe.me();
  } catch (err) {
    if (/ERROR_AUTH_TOKEN|UNAUTHENTICATED/.test(String(err.cause?.message ?? err.message))) {
      throw new Error('That token was rejected by Samsung Food. Log in again in the browser and copy a fresh one.');
    }
    throw err;
  }

  const previous = readAuthFile() ?? {};
  const sameAccount = !previous.userId || previous.userId === me.id;
  const base = sameAccount ? previous : { ...previous, mealPlanId: undefined, listId: undefined };
  saveAuth({ ...base, accessToken: token, userId: me.id, savedAt: new Date().toISOString() });

  let renewed = false;
  try {
    await renewToken({ codec: client.codec, transport: client.transport, token });
    renewed = true;
  } catch (err) {
    process.stderr.write(`samsung-food: login saved, but the first renewal failed (${err.message}).\n`);
  }
  const stored = loadAuth();
  return {
    account: [me.settings?.firstName, me.settings?.lastName].filter(Boolean).join(' ') || String(me.id ?? ''),
    expiresAt: stored.expiresAt ?? null,
    renewed,
  };
}

/** Token status without any secret. */
export function authStatus(now = new Date()) {
  const auth = loadAuth();
  if (!auth?.accessToken) return { loggedIn: false, hint: LOGIN_HINT };
  const exp = auth.expiresAt ? new Date(auth.expiresAt) : null;
  return {
    loggedIn: true,
    expiresAt: auth.expiresAt ?? null,
    daysLeft: exp ? Math.floor((exp - now) / 86400000) : null,
    expired: exp ? exp < now : null,
    renewedAt: auth.renewedAt ?? null,
    source: process.env.SAMSUNG_FOOD_TOKEN ? 'environment' : 'file',
  };
}
