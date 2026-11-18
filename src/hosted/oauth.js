/**
 * OAuth 2.1 authorization server logic of the hosted connector (no HTTP here; see server.js).
 *
 *   clients:  dynamic registration (RFC 7591, public or confidential) and Client ID Metadata
 *             Documents (draft-ietf-oauth-client-id-metadata-document) from allowlisted hosts
 *   codes:    single use, 5 minutes, PKCE S256 required, bound to client, redirect URI and resource
 *   tokens:   opaque; access tokens short-lived, refresh tokens rotate on every use; reuse of a
 *             rotated refresh token (after a short grace period) or a code revokes the whole grant
 */

import crypto from 'node:crypto';
import { isLoopbackHost } from './config.js';
import { timingSafeEqualStr } from './crypto.js';
import { safeFetch } from './fetch.js';
import { BusyError, semaphore } from './limits.js';

export class OAuthError extends Error {
  constructor(error, description, status = 400) {
    super(description);
    this.error = error;
    this.status = status;
  }
}

export const SCOPE = 'food';
export const CODE_TTL_MS = 5 * 60 * 1000;
const REFRESH_REUSE_GRACE_MS = 10 * 1000;
const MAX_REDIRECT_URIS = 10;
const MAX_URI_LENGTH = 2000;
const MAX_GRANTS_PER_USER = 20;

const isLoopbackUrl = (u) => u.protocol === 'http:' && isLoopbackHost(u.hostname);

/** Client names are chosen by the client: no control or format characters (bidi overrides, zero-width). */
export const cleanName = (v) => (typeof v === 'string' ? v.replace(/[\p{Cc}\p{Cf}]/gu, '').trim().slice(0, 100) : '');

/**
 * Validates one redirect URI for registration (https, or http on loopback; no fragment or
 * credentials). `allowHosts`: exact https host allowlist, `*` = any https host; loopback is always
 * allowed (native clients, RFC 8252).
 */
export function checkRedirectUri(value, { allowHosts = [] } = {}) {
  if (typeof value !== 'string' || value.length > MAX_URI_LENGTH) throw new OAuthError('invalid_redirect_uri', 'redirect_uris must be URL strings');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new OAuthError('invalid_redirect_uri', `Not a URL: ${value.slice(0, 100)}`);
  }
  if (u.hash || u.username || u.password) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must not contain a fragment or credentials');
  if (u.protocol !== 'https:' && !isLoopbackUrl(u)) throw new OAuthError('invalid_redirect_uri', 'Redirect URIs must use https (or http on localhost / 127.0.0.1)');
  if (!isLoopbackUrl(u) && !allowHosts.includes('*') && !allowHosts.includes(u.hostname.toLowerCase())) {
    throw new OAuthError('invalid_redirect_uri', `Redirect host ${u.hostname} is not allowed on this server`);
  }
  return value;
}

/**
 * Exact string match against the registered URIs; for loopback redirects the port is ignored
 * (RFC 8252 section 7.3; native clients such as Claude Code pick a random port).
 */
export function redirectMatches(registered, requested) {
  if (typeof requested !== 'string') return false;
  if (registered.includes(requested)) return true;
  let r;
  try {
    r = new URL(requested);
  } catch {
    return false;
  }
  if (!isLoopbackUrl(r)) return false;
  return registered.some((reg) => {
    try {
      const u = new URL(reg);
      return isLoopbackUrl(u) && u.hostname === r.hostname && u.pathname === r.pathname && u.search === r.search;
    } catch {
      return false;
    }
  });
}

const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : undefined);

/** RFC 7591 registration request -> stored metadata. */
export function validateRegistration(body, { allowHosts, maxRedirectUris = MAX_REDIRECT_URIS }) {
  const uris = body.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > maxRedirectUris) {
    throw new OAuthError('invalid_redirect_uri', `redirect_uris must be an array of 1 to ${maxRedirectUris} URIs`);
  }
  uris.forEach((u) => checkRedirectUri(u, { allowHosts }));
  const authMethod = body.token_endpoint_auth_method ?? 'none';
  if (!['none', 'client_secret_post', 'client_secret_basic'].includes(authMethod)) {
    throw new OAuthError('invalid_client_metadata', 'token_endpoint_auth_method must be none, client_secret_post or client_secret_basic');
  }
  // Grant types we don't offer (e.g. jwt-bearer in ChatGPT's metadata) are dropped, not refused.
  const requested = body.grant_types ?? ['authorization_code', 'refresh_token'];
  if (!Array.isArray(requested) || !requested.includes('authorization_code')) {
    throw new OAuthError('invalid_client_metadata', 'grant_types must include authorization_code');
  }
  const grantTypes = requested.filter((g) => g === 'authorization_code' || g === 'refresh_token');
  const responseTypes = body.response_types ?? ['code'];
  if (!Array.isArray(responseTypes) || responseTypes.length !== 1 || responseTypes[0] !== 'code') {
    throw new OAuthError('invalid_client_metadata', 'response_types must be ["code"]');
  }
  const clientUri = str(body.client_uri, MAX_URI_LENGTH);
  return {
    redirect_uris: [...new Set(uris)],
    token_endpoint_auth_method: authMethod,
    grant_types: grantTypes,
    response_types: ['code'],
    client_name: cleanName(str(body.client_name, 200)) || undefined,
    client_uri: clientUri && /^https:\/\//.test(clientUri) ? clientUri : undefined,
    ...(str(body.software_id, 200) ? { software_id: body.software_id } : {}),
    ...(str(body.software_version, 100) ? { software_version: body.software_version } : {}),
    ...(typeof body.application_type === 'string' && ['web', 'native'].includes(body.application_type) ? { application_type: body.application_type } : {}),
  };
}

/**
 * Client ID Metadata Documents: HTTPS, public addresses only, small, no redirects, cached.
 * `hosts`: ['*'] = any host, otherwise an exact host allowlist for the document URL.
 * `redirectHosts`: the same redirect host allowlist as for dynamic registration (a document on an
 * allowlisted host must not send users anywhere else).
 * At most `concurrency` documents are fetched at once (`maxQueue` more wait), concurrent requests
 * for the same client_id share one fetch, and failures are remembered for `negativeTtlMs`.
 */
export function cimdResolver({
  hosts,
  redirectHosts = ['*'],
  fetchImpl = (url, o) => safeFetch(url, o),
  now = Date.now,
  ttlMs = 3600_000,
  negativeTtlMs = 60_000,
  timeoutMs = 5000,
  maxBytes = 10_000,
  concurrency = 4,
  maxQueue = 32,
  maxCache = 500,
}) {
  const cache = new Map();
  const inflight = new Map();
  const sem = semaphore(concurrency, { maxQueue });

  const remember = (clientId, entry) => {
    cache.delete(clientId);
    for (const k of cache.keys()) {
      if (cache.size < maxCache) break;
      cache.delete(k);
    }
    cache.set(clientId, entry);
  };

  async function load(clientId) {
    let res;
    try {
      res = await fetchImpl(clientId, { redirect: 'error', timeoutMs, maxBytes, signal: AbortSignal.timeout(timeoutMs), headers: { accept: 'application/json' } });
    } catch {
      throw new OAuthError('invalid_client', 'Could not fetch the client metadata document', 401);
    }
    if (!res.ok) throw new OAuthError('invalid_client', `Client metadata document returned HTTP ${res.status}`, 401);
    const text = await res.text();
    if (text.length > maxBytes) throw new OAuthError('invalid_client', 'Client metadata document is too large', 401);
    let doc;
    try {
      doc = JSON.parse(text);
    } catch {
      throw new OAuthError('invalid_client', 'Client metadata document is not JSON', 401);
    }
    if (!doc || doc.client_id !== clientId) throw new OAuthError('invalid_client', 'client_id in the metadata document does not match its URL', 401);
    // This server authenticates CIMD clients as public clients (PKCE). A document that prefers
    // private_key_jwt but also lists "none" (ChatGPT does) is accepted as a public client.
    const methods = [doc.token_endpoint_auth_method ?? 'none', ...(Array.isArray(doc.token_endpoint_auth_methods_supported) ? doc.token_endpoint_auth_methods_supported : [])];
    if (!methods.includes('none')) throw new OAuthError('invalid_client', 'Only public CIMD clients (token_endpoint_auth_method "none") are supported', 401);
    let meta;
    try {
      meta = validateRegistration({ ...doc, token_endpoint_auth_method: 'none' }, { allowHosts: redirectHosts, maxRedirectUris: 50 });
    } catch (err) {
      throw new OAuthError('invalid_client', `Invalid client metadata document: ${err.message}`, 401);
    }
    return { client_id: clientId, secret_verifier: null, metadata: meta, cimd: true };
  }

  return async function resolve(clientId) {
    let u;
    try {
      u = new URL(clientId);
    } catch {
      return null;
    }
    if (u.protocol !== 'https:' || u.pathname === '/' || u.hash || u.username || u.password || u.port) return null;
    if (!hosts.includes('*') && !hosts.includes(u.hostname.toLowerCase())) throw new OAuthError('invalid_client', `Client ID metadata documents from ${u.hostname} are not accepted by this server`, 401);
    const hit = cache.get(clientId);
    if (hit && hit.expires > now()) {
      if (hit.error) throw hit.error;
      return hit.client;
    }
    let p = inflight.get(clientId);
    if (!p) {
      p = sem
        .run(() => load(clientId))
        .then(
          (client) => {
            remember(clientId, { client, expires: now() + ttlMs });
            return client;
          },
          (err) => {
            if (err instanceof BusyError) throw new OAuthError('temporarily_unavailable', 'Too many client metadata lookups right now; try again in a moment', 503);
            if (err instanceof OAuthError) remember(clientId, { error: err, expires: now() + negativeTtlMs });
            throw err;
          }
        )
        .finally(() => inflight.delete(clientId));
      inflight.set(clientId, p);
    }
    // A fresh copy per caller: callers annotate errors (redirect: false).
    return p.catch((err) => {
      throw err instanceof OAuthError ? new OAuthError(err.error, err.message, err.status) : err;
    });
  };
}

export const pkceChallenge = (verifier) => crypto.createHash('sha256').update(verifier).digest('base64url');
const VERIFIER_RE = /^[A-Za-z0-9\-._~]{43,128}$/;
const CHALLENGE_RE = /^[A-Za-z0-9_-]{43}$/;

/**
 * The OAuth core bound to a store and keyring.
 * @param {object} o
 * @param {ReturnType<import('./store.js').openStore>} o.store
 * @param {ReturnType<import('./crypto.js').createKeyring>} o.keyring
 * @param {object} o.config
 */
export function createOAuth({ store, keyring, config, resolveCimd, now = Date.now }) {
  const issuer = config.publicUrl;
  const resource = `${config.publicUrl}/mcp`;
  const accessTtlMs = config.accessTtlSec * 1000;
  const refreshTtlMs = config.refreshTtlDays * 86400000;

  /** Canonical resource for a requested `resource` parameter (absent = the MCP endpoint). */
  function checkResource(value) {
    if (value === undefined || value === '') return resource;
    let u;
    try {
      u = new URL(value);
    } catch {
      throw new OAuthError('invalid_target', 'resource is not a URL');
    }
    const norm = `${u.origin}${u.pathname.replace(/\/+$/, '')}`;
    if (!u.hash && !u.search && (norm === resource || norm === issuer)) return resource;
    throw new OAuthError('invalid_target', `This server only issues tokens for ${resource}`);
  }

  async function getClient(clientId) {
    if (typeof clientId !== 'string' || !clientId || clientId.length > MAX_URI_LENGTH) return null;
    if (/^https:\/\//.test(clientId)) return resolveCimd ? resolveCimd(clientId) : null;
    const row = store.getClient(clientId);
    return row ? { ...row, metadata: JSON.parse(row.metadata) } : null;
  }

  function register(body) {
    const meta = validateRegistration(body, { allowHosts: config.redirectHosts });
    // Full: make room by dropping the oldest registration that never led to a connection.
    if (store.clientCount() >= config.maxClients && !store.evictUnusedClient()) {
      throw new OAuthError('temporarily_unavailable', 'Client registration is full; try again later', 503);
    }
    const clientId = `c_${crypto.randomBytes(16).toString('base64url')}`;
    let secret = null;
    if (meta.token_endpoint_auth_method !== 'none') secret = `cs_${crypto.randomBytes(32).toString('base64url')}`;
    store.putClient(clientId, secret ? keyring.clientSecretVerifier(clientId, secret) : null, meta);
    return {
      client_id: clientId,
      client_id_issued_at: Math.floor(now() / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      ...meta,
    };
  }

  /** Client authentication at /token and /revoke: none for public clients, secret for confidential ones. */
  async function authenticate({ clientId, clientSecret }) {
    const client = await getClient(clientId);
    if (!client) throw new OAuthError('invalid_client', 'Unknown client', 401);
    if (client.secret_verifier) {
      if (typeof clientSecret !== 'string' || !timingSafeEqualStr(keyring.clientSecretVerifier(client.client_id, clientSecret), client.secret_verifier)) {
        throw new OAuthError('invalid_client', 'Client authentication failed', 401);
      }
    } else if (clientSecret !== undefined && clientSecret !== '') {
      throw new OAuthError('invalid_client', 'This client is public and has no secret', 401);
    }
    return client;
  }

  /**
   * Validates an authorization request. Errors that make the redirect target untrustworthy are
   * thrown with `redirect: false` (shown as a page); the rest carry the redirect URI.
   */
  async function checkAuthorizeRequest(q) {
    let client;
    try {
      client = await getClient(q.client_id);
    } catch (err) {
      throw Object.assign(err, { redirect: false });
    }
    if (!client) throw Object.assign(new OAuthError('invalid_client', 'Unknown client. Remove and add the connector again.'), { redirect: false });
    if (!q.redirect_uri || !redirectMatches(client.metadata.redirect_uris, q.redirect_uri)) {
      throw Object.assign(new OAuthError('invalid_request', 'The redirect URI is not registered for this client.'), { redirect: false });
    }
    const fail = (error, description) => Object.assign(new OAuthError(error, description), { redirect: true, redirectUri: q.redirect_uri, state: q.state });
    if (q.response_type !== 'code') throw fail('unsupported_response_type', 'Only response_type=code is supported');
    if (!q.code_challenge || !CHALLENGE_RE.test(q.code_challenge)) throw fail('invalid_request', 'PKCE code_challenge (S256) is required');
    if (q.code_challenge_method !== 'S256') throw fail('invalid_request', 'code_challenge_method must be S256');
    if (q.state !== undefined && q.state.length > 1000) throw fail('invalid_request', 'state is too long');
    let res;
    try {
      res = checkResource(q.resource);
    } catch (err) {
      throw fail(err.error, err.message);
    }
    // The name comes from the client. Only the host of a metadata document URL is verified (we
    // fetched it from there); a dynamically registered name is whatever the registrant typed.
    const name = cleanName(client.metadata.client_name);
    const cimdHost = client.cimd ? new URL(client.client_id).hostname : null;
    return {
      client,
      clientName: cimdHost ? (name && name !== cimdHost ? `${name} (${cimdHost})` : cimdHost) : `${name || 'An MCP client'} (unverified)`,
      verified: Boolean(cimdHost),
      params: { clientId: client.client_id, redirectUri: q.redirect_uri, state: q.state, codeChallenge: q.code_challenge, scope: SCOPE, resource: res },
    };
  }

  /** Redirect URL with the authorization response (RFC 9207 `iss` included). */
  function responseUrl(redirectUri, params) {
    const u = new URL(redirectUri);
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null) u.searchParams.set(k, v);
    u.searchParams.set('iss', issuer);
    return u.href;
  }

  /** Creates the grant and the authorization code after the user approved. */
  function approve({ params, uid, session, readOnly }) {
    const gid = `g_${crypto.randomBytes(16).toString('base64url')}`;
    const key = keyring.newGrantKey();
    const code = keyring.mint('code', gid, key);
    store.tx(() => {
      store.putGrant({ gid, uid, clientId: params.clientId, scope: params.scope, resource: params.resource, readOnly, session: keyring.sealSession(key, gid, session) });
      store.putCred({ id: code.id, kind: 'code', gid, verifier: code.verifier, wrap: code.wrap, expiresAt: now() + CODE_TTL_MS, meta: { clientId: params.clientId, redirectUri: params.redirectUri, codeChallenge: params.codeChallenge, resource: params.resource } });
      store.touchClient(params.clientId);
      const grants = store.grantsOfUser(uid);
      for (const g of grants.slice(0, Math.max(0, grants.length - MAX_GRANTS_PER_USER))) store.deleteGrant(g.gid);
    });
    return responseUrl(params.redirectUri, { code: code.value, state: params.state });
  }

  function issueTokens(gid, key, scope) {
    const access = keyring.mint('access', gid, key);
    const refresh = keyring.mint('refresh', gid, key);
    store.putCred({ id: access.id, kind: 'access', gid, verifier: access.verifier, wrap: access.wrap, expiresAt: now() + accessTtlMs });
    store.putCred({ id: refresh.id, kind: 'refresh', gid, verifier: refresh.verifier, wrap: refresh.wrap, expiresAt: now() + refreshTtlMs });
    return { access_token: access.value, token_type: 'Bearer', expires_in: Math.floor(accessTtlMs / 1000), refresh_token: refresh.value, scope };
  }

  /** Looks up a credential and checks its verifier; null if it is not ours or unknown. */
  function findCred(value, kind) {
    const cred = keyring.parse(value);
    if (!cred || cred.kind !== kind) return null;
    const row = store.getCred(cred.id);
    if (!row || row.kind !== kind || !keyring.verify(cred, row.verifier)) return null;
    // An expired credential must not keep a usable wrap until the next sweep.
    if (row.expires_at <= now() && row.wrap) store.dropWrap(cred.id);
    return { cred, row };
  }

  /** grant_type=authorization_code */
  function exchangeCode(client, form) {
    const found = findCred(form.code, 'code');
    if (!found) throw new OAuthError('invalid_grant', 'Invalid authorization code');
    const { cred, row } = found;
    const meta = JSON.parse(row.meta);
    if (row.used_at !== null) {
      // A second redemption means the code leaked: revoke everything issued from it.
      store.deleteGrant(row.gid);
      throw new OAuthError('invalid_grant', 'Authorization code was already used');
    }
    if (row.expires_at <= now()) throw new OAuthError('invalid_grant', 'Authorization code expired');
    if (meta.clientId !== client.client_id) throw new OAuthError('invalid_grant', 'Authorization code was issued to another client');
    if (form.redirect_uri !== undefined && form.redirect_uri !== meta.redirectUri) throw new OAuthError('invalid_grant', 'redirect_uri does not match the authorization request');
    if (typeof form.code_verifier !== 'string' || !VERIFIER_RE.test(form.code_verifier)) throw new OAuthError('invalid_grant', 'code_verifier is missing or malformed');
    if (!timingSafeEqualStr(pkceChallenge(form.code_verifier), meta.codeChallenge)) throw new OAuthError('invalid_grant', 'PKCE verification failed');
    if (form.resource !== undefined && checkResource(form.resource) !== meta.resource) throw new OAuthError('invalid_target', 'resource does not match the authorization request');
    const grant = store.getGrant(row.gid);
    if (!grant) throw new OAuthError('invalid_grant', 'The authorization was revoked');
    const key = keyring.unwrap(cred, row.gid, row.wrap);
    if (!store.useCred(cred.id)) throw new OAuthError('invalid_grant', 'Authorization code was already used');
    store.touchGrant(row.gid);
    return issueTokens(row.gid, key, grant.scope);
  }

  /** grant_type=refresh_token; returns { body, gid, key } so the caller can renew the Samsung session. */
  function refresh(client, form) {
    const found = findCred(form.refresh_token, 'refresh');
    if (!found) throw new OAuthError('invalid_grant', 'Invalid refresh token');
    const { cred, row } = found;
    const grant = store.getGrant(row.gid);
    if (!grant) throw new OAuthError('invalid_grant', 'The authorization was revoked');
    if (grant.client_id !== client.client_id) throw new OAuthError('invalid_grant', 'Refresh token was issued to another client');
    if (row.used_at !== null) {
      if (now() - row.used_at > REFRESH_REUSE_GRACE_MS) store.deleteGrant(row.gid);
      throw new OAuthError('invalid_grant', 'Refresh token was already used');
    }
    if (row.expires_at <= now()) throw new OAuthError('invalid_grant', 'Refresh token expired');
    if (grant.samsung_expired) {
      store.deleteGrant(row.gid);
      throw new OAuthError('invalid_grant', 'The Samsung Food session expired; connect again');
    }
    if (form.resource !== undefined && checkResource(form.resource) !== grant.resource) throw new OAuthError('invalid_target', 'resource does not match the grant');
    if (!row.wrap) throw new OAuthError('invalid_grant', 'Invalid refresh token');
    const oldKey = keyring.unwrap(cred, row.gid, row.wrap);
    // Rotation also rotates K: the session is re-sealed under a new key and every wrap of the old
    // key is dropped (old access tokens stop working; the used refresh token row stays for reuse
    // detection, without a wrap). A leaked old credential can no longer decrypt anything.
    const key = keyring.newGrantKey();
    const body = store.tx(() => {
      if (!store.useCred(cred.id)) throw new OAuthError('invalid_grant', 'Refresh token was already used');
      const current = store.getGrant(row.gid);
      store.setGrantSession(row.gid, keyring.sealSession(key, row.gid, keyring.openSession(oldKey, row.gid, current.session)));
      store.dropGrantWraps(row.gid);
      return issueTokens(row.gid, key, grant.scope);
    });
    store.touchGrant(row.gid);
    store.seeUser(grant.uid);
    return { body, gid: row.gid, key };
  }

  /** RFC 7009: refresh token -> whole grant, access token -> that token. Unknown tokens are ignored. */
  function revoke(client, token) {
    for (const kind of ['refresh', 'access']) {
      const found = findCred(token, kind);
      if (!found) continue;
      const grant = store.getGrant(found.row.gid);
      if (!grant || grant.client_id !== client.client_id) return;
      if (kind === 'refresh') store.deleteGrant(grant.gid);
      else store.deleteCred(found.cred.id);
      return;
    }
  }

  /**
   * Bearer check for /mcp. Returns { grant, key } or throws OAuthError('invalid_token', ..., 401).
   */
  function authenticateBearer(value) {
    const found = findCred(value, 'access');
    if (!found) throw new OAuthError('invalid_token', 'The access token is invalid', 401);
    const { cred, row } = found;
    if (row.expires_at <= now()) throw new OAuthError('invalid_token', 'The access token expired', 401);
    if (!row.wrap) throw new OAuthError('invalid_token', 'The access token was replaced by a newer one', 401);
    const grant = store.getGrant(row.gid);
    if (!grant) throw new OAuthError('invalid_token', 'The authorization was revoked', 401);
    if (grant.resource !== resource) throw new OAuthError('invalid_token', 'The access token is not valid for this resource', 401);
    if (grant.samsung_expired) throw new OAuthError('invalid_token', 'The Samsung Food session expired; connect again', 401);
    return { grant, key: keyring.unwrap(cred, row.gid, row.wrap) };
  }

  return { issuer, resource, register, authenticate, checkAuthorizeRequest, responseUrl, approve, exchangeCode, refresh, revoke, authenticateBearer, getClient };
}
