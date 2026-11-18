/**
 * Hosted multi-user connector (`sf host`): an OAuth 2.1 authorization server plus a protected MCP
 * endpoint, so people can add their Samsung Food account to ChatGPT, claude.ai and other remote MCP
 * clients. Plain node:http, meant to run behind a TLS-terminating reverse proxy.
 *
 *   GET  /.well-known/oauth-protected-resource[/mcp]   RFC 9728
 *   GET  /.well-known/oauth-authorization-server       RFC 8414
 *   POST /register                                     RFC 7591 dynamic client registration
 *   GET  /authorize                                    consent page + Samsung session handover
 *   POST /authorize/decision                           approve / deny (JSON, same origin)
 *   POST /token                                        authorization_code, refresh_token
 *   POST /revoke                                       RFC 7009
 *   POST /mcp                                          Streamable HTTP MCP (bearer)
 *   GET  /disconnect, POST /disconnect/decision        self-service: delete everything
 *   GET  /login/landing, POST /login/handover|status   handover (shared with sf login)
 *   GET  /, /reconnect, /privacy, /terms, /imprint, /healthz
 */

import fs from 'node:fs';
import http from 'node:http';
import { SamsungFood } from '../client.js';
import { memoryTokenStore, LOGIN_HINT } from '../auth.js';
import { ensureFreshToken } from '../session.js';
import { GrpcError, GrpcWebTransport } from '../grpc.js';
import { ensureSchema, buildSchema } from '../schema-build.js';
import { VERSION } from '../version.js';
import { createHandover, HandoverError, loginCookieHeader, readCookie } from '../login/handover.js';
import { loginPage, landingPage, messagePage, newScriptNonce, pageCsp, escapeHtml } from '../login/page.js';
import { HttpError, baseHeaders, sendJson, sendHtml, readJsonBody, readFormBody, assertSameOrigin, handleHandoverApi } from '../login/http.js';
import { createKeyring, normalizeInvite } from './crypto.js';
import { createOAuth, cimdResolver, OAuthError, SCOPE } from './oauth.js';
import { rateLimiter, semaphore, fairTransports, ipKey } from './limits.js';
import { hostedTools, handleHostedMcp } from './mcp.js';

const MCP_BODY_LIMIT = 1024 * 1024;
const FORM_LIMIT = 16 * 1024;
const SCHEMA_RECHECK_MS = 6 * 3600 * 1000;

/** Client IP for rate limiting: the socket address, or the N-th X-Forwarded-For entry from the right. */
export function clientIp(req, trustProxy) {
  if (trustProxy > 0) {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length >= trustProxy) return hops[hops.length - trustProxy];
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/**
 * @param {object} o
 * @param {object} o.config     loadConfig() result
 * @param {object} o.store      openStore() result
 * @param {object} [o.schema]   protocol schema (default: cached/built on first use)
 * @param {object} [o.transport]  Samsung transport (tests inject a fake)
 * @param {Function} [o.fetchImpl]  for CIMD documents
 * @param {(line: string) => void} [o.log]
 */
export function createHostedServer({ config, store, schema: fixedSchema, transport: rawTransport, fetchImpl, now = Date.now, log = () => {} }) {
  const keyring = createKeyring(config.masterKey);
  const resolveCimd = config.cimdHosts.length ? cimdResolver({ hosts: config.cimdHosts, redirectHosts: config.redirectHosts, fetchImpl, now }) : null;
  const oauth = createOAuth({ store, keyring, config, resolveCimd, now });
  const base = config.publicUrl;
  const secure = base.startsWith('https:');
  const prmUrl = `${base}/.well-known/oauth-protected-resource/mcp`;
  // Global cap toward Samsung Food with a bounded queue; per user at most 2 calls in flight, so one
  // account cannot occupy the whole pool.
  const sem = semaphore(config.upstreamConcurrency, { maxQueue: config.upstreamConcurrency * 8 });
  const transports = fairTransports(rawTransport ?? new GrpcWebTransport(), sem, { perUser: 2, perUserQueue: 8 });
  const transport = transports.shared;
  /** Rate-limit key of a request: client address, IPv6 by /64. */
  const ipOf = (req) => ipKey(clientIp(req, config.trustProxy));

  const limits = {
    login: rateLimiter({ limit: 30, windowMs: 60_000, now }),
    handover: rateLimiter({ limit: 20, windowMs: 60_000, now }),
    invite: rateLimiter({ limit: 10, windowMs: 3600_000, now }),
    register: rateLimiter({ limit: 20, windowMs: 3600_000, now }),
    token: rateLimiter({ limit: 60, windowMs: 60_000, now }),
    tools: rateLimiter({ limit: config.toolCallsPerMinute, windowMs: 60_000, now }),
    mcp: rateLimiter({ limit: config.toolCallsPerMinute * 5, windowMs: 60_000, now }),
  };
  const limit = (lim, key, what) => {
    const wait = lim.hit(key);
    if (wait) throw new HttpError(429, 'rate_limited', `Too many ${what}. Try again in ${wait} s.`, { 'Retry-After': String(wait) });
  };

  /* ------------------------------------------------------------ Samsung client */

  let schemaState = fixedSchema ? { schema: fixedSchema, at: Infinity } : null;
  async function currentSchema() {
    if (!schemaState || now() - schemaState.at > SCHEMA_RECHECK_MS) {
      const s = await ensureSchema({ background: true, log: (m) => log(`schema: ${m}`) });
      schemaState = { schema: s, at: now() };
    }
    return schemaState.schema;
  }
  // Drift refresh shared by all users (each request has its own client).
  let lastBuild = 0;
  let building = null;
  async function sharedBuild() {
    if (fixedSchema) return fixedSchema;
    if (building) return building;
    if (now() - lastBuild < 10 * 60 * 1000) return schemaState.schema;
    lastBuild = now();
    building = buildSchema({ log: () => {} })
      .then((s) => (schemaState = { schema: s, at: now() }).schema)
      .finally(() => (building = null));
    return building;
  }
  // The renewal warning of the library would carry upstream error text; log a neutral event only.
  const makeClient = async ({ token, tokenStore, via = transport }) =>
    new SamsungFood({ schema: await currentSchema(), transport: via, locale: config.locale, token, tokenStore, buildSchema: sharedBuild, warn: () => log('samsung session renewal failed for a grant') });

  /** Token store of one grant: the session lives encrypted in the grants row; K stays in memory. */
  function grantStore(gid, key) {
    const load = () => {
      const g = store.getGrant(gid);
      return g ? keyring.openSession(key, gid, g.session) : null;
    };
    const write = (data) => {
      // K may have been rotated by a refresh meanwhile: never overwrite the session with the old key
      // (check and write are synchronous, so nothing runs in between).
      const g = store.getGrant(gid);
      if (!g) return;
      try {
        keyring.openSession(key, gid, g.session);
      } catch {
        return;
      }
      store.setGrantSession(gid, keyring.sealSession(key, gid, data));
    };
    return {
      key: gid,
      load,
      update: (patch) => write({ ...(load() ?? {}), ...patch }),
      unset(keys) {
        const cur = load();
        if (!cur || !keys.some((k) => k in cur)) return;
        for (const k of keys) delete cur[k];
        write(cur);
      },
      renewable: () => true,
    };
  }

  /** After a token refresh: renew the Samsung session too when it is due (the key is only known now). */
  function renewInBackground(gid, key) {
    const ts = grantStore(gid, key);
    makeClient({ tokenStore: ts })
      .then((sf) => ensureFreshToken({ codec: sf.codec, transport, store: ts, warn: () => log('samsung session renewal failed for a grant') }))
      .catch(() => {});
  }

  /* ------------------------------------------------------------ handover */

  const isAuthError = (err) => (err instanceof GrpcError && err.status === 16) || err?.message === LOGIN_HINT;

  const handover = createHandover({
    now,
    verify: async (token, pending) => {
      const probe = await makeClient({ token, tokenStore: memoryTokenStore({ accessToken: token }) });
      let me;
      try {
        me = await probe.me();
      } catch (err) {
        if (isAuthError(err)) throw new HandoverError('rejected', 'Samsung Food did not accept this session. Log in again on app.samsungfood.com and try once more.');
        throw new HandoverError('rejected', 'Samsung Food could not be reached right now. Try again in a minute.');
      }
      if (!me?.id) throw new HandoverError('rejected', 'Samsung Food returned no account for this session.');
      const uid = keyring.userId(me.id);
      const known = Boolean(store.getUser(uid));
      const account = [me.settings?.firstName, me.settings?.lastName].filter(Boolean).join(' ') || 'your Samsung Food account';
      const pub = pending.extra.mode === 'disconnect' ? { account, hasData: known } : { account, needsInvite: config.inviteRequired && !known };
      return { account, token, samsungUserId: me.id, uid, public: pub };
    },
  });

  /* ------------------------------------------------------------ pages */

  const footer = () => {
    const op = config.operator ? `${escapeHtml(config.operator)} · ` : '';
    return `${op}<a href="/privacy">Privacy</a> · <a href="/terms">Terms</a> · <a href="/imprint">Imprint</a> · <a href="/disconnect">Disconnect and delete my data</a><br>Unofficial connector, not affiliated with Samsung. Open source: <a href="https://github.com/derdennis1012/unofficial-samsung-food-mcp">unofficial-samsung-food-mcp</a>.`;
  };
  const page = (res, status, title, html) => {
    const n = newScriptNonce();
    sendHtml(res, status, messagePage({ title, html, scriptNonce: n, footer: footer() }), { 'Content-Security-Policy': pageCsp(n) });
  };

  const SECURITY_TEXT = `<p class="warn"><strong>What you hand over.</strong> Samsung Food has no way to grant limited access, so the connector needs your Samsung Food session. It can then read and change your meal plan, shopping lists, recipes, collections and pantry, like you can in the app. The session is stored encrypted; it can only be decrypted with a key that the connected app holds. You can disconnect at any time.</p>`;

  function consentPage(res, { nonce, cookie, clientName, verified, redirectUri }) {
    const n = newScriptNonce();
    const host = new URL(redirectUri).host;
    const loopback = /^(localhost|127\.|\[::1\])/.test(new URL(redirectUri).hostname);
    const where = loopback
      ? 'That is a program on your own computer; only continue if you started this from such a program (for example Claude Code).'
      : 'Only continue if that is the app where you started connecting.';
    const unverified = verified ? '' : ' <span class="muted">The app chose this name itself; it is not verified. Rely on the address below.</span>';
    const intro = `<div class="card"><p><strong>${escapeHtml(clientName)}</strong> wants to use your Samsung Food account through ${escapeHtml(config.name)}.${unverified}</p>
<p>Afterwards you are sent back to <strong class="redirect-host">${escapeHtml(host)}</strong>. ${where}</p>${SECURITY_TEXT}</div>`;
    const doneHtml = `<form id="decide-form" autocomplete="off">
<div id="invite-box" class="hidden"><label for="invite">Invite code</label><input type="text" id="invite" name="invite" placeholder="SF-XXXX-XXXX-XXXX" autocapitalize="characters" spellcheck="false"><p class="muted">The connector is in a closed beta. You need the code only the first time.</p></div>
<label><input type="checkbox" id="read_only" name="read_only"> Read only (the app can look, but not change anything)</label>
<p class="muted">By connecting you accept the <a href="/terms" target="_blank">terms</a> and the <a href="/privacy" target="_blank">privacy notice</a>.</p>
<div class="row"><button class="primary" type="submit" value="approve">Allow access</button><button type="submit" value="deny">Cancel</button></div>
<div class="msg" id="decide-msg"></div></form>`;
    const html = loginPage({
      mode: 'connect',
      nonce,
      landingUrl: `${base}/login/landing`,
      endpoints: { handover: '/login/handover', status: '/login/status', decide: '/authorize/decision' },
      scriptNonce: n,
      heading: `Connect Samsung Food`,
      intro,
      doneHtml,
      footer: footer(),
    });
    sendHtml(res, 200, html, { 'Content-Security-Policy': pageCsp(n), 'Set-Cookie': loginCookieHeader(cookie, { secure }) });
  }

  function disconnectPage(req, res) {
    limit(limits.login, ipOf(req), 'login attempts');
    const { nonce, cookie } = handover.begin({ mode: 'disconnect' }, { owner: ipOf(req) });
    const n = newScriptNonce();
    const html = loginPage({
      mode: 'disconnect',
      nonce,
      landingUrl: `${base}/login/landing`,
      endpoints: { handover: '/login/handover', status: '/login/status', decide: '/disconnect/decision' },
      scriptNonce: n,
      heading: 'Disconnect and delete my data',
      intro: `<div class="card"><p>Prove that it is your account by connecting it once more (same steps as when you set it up). Then all connections and the stored session of this account are deleted from ${escapeHtml(config.name)}.</p><p class="muted">Also remove the connector in ChatGPT or Claude. Your data in Samsung Food itself is not touched.</p></div>`,
      doneHtml: '<form id="decide-form"><div class="row"><button class="danger" type="submit" value="approve">Delete all my data on this connector</button></div><div class="msg" id="decide-msg"></div></form>',
      footer: footer(),
    });
    sendHtml(res, 200, html, { 'Content-Security-Policy': pageCsp(n), 'Set-Cookie': loginCookieHeader(cookie, { secure }) });
  }

  const legalCache = new Map();
  function legal(res, name, title) {
    const cfg = config.pages[name];
    if (cfg?.url) {
      res.writeHead(302, { Location: cfg.url });
      return res.end();
    }
    if (cfg?.file) {
      let body = legalCache.get(name);
      if (body === undefined) {
        body = fs.readFileSync(cfg.file, 'utf8');
        legalCache.set(name, body);
      }
      if (/\.html?$/i.test(cfg.file)) {
        return sendHtml(res, 200, body, { 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data: https:; frame-ancestors 'none'" });
      }
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(body);
    }
    return page(res, 200, title, '<p>This page has not been set up by the operator yet.</p>');
  }

  /* ------------------------------------------------------------ OAuth endpoints */

  const asMetadata = () => ({
    issuer: oauth.issuer,
    authorization_endpoint: `${base}/authorize`,
    token_endpoint: `${base}/token`,
    registration_endpoint: `${base}/register`,
    revocation_endpoint: `${base}/revoke`,
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post', 'client_secret_basic'],
    scopes_supported: [SCOPE, 'offline_access'],
    authorization_response_iss_parameter_supported: true,
    client_id_metadata_document_supported: Boolean(resolveCimd),
    service_documentation: 'https://github.com/derdennis1012/unofficial-samsung-food-mcp/blob/main/docs/hosted.md',
    ...(config.pages.privacy ? { op_policy_uri: `${base}/privacy` } : {}),
    ...(config.pages.terms ? { op_tos_uri: `${base}/terms` } : {}),
  });
  const prMetadata = () => ({
    resource: oauth.resource,
    authorization_servers: [oauth.issuer],
    scopes_supported: [SCOPE],
    bearer_methods_supported: ['header'],
    resource_name: config.name,
    resource_documentation: 'https://github.com/derdennis1012/unofficial-samsung-food-mcp/blob/main/docs/hosted.md',
  });

  const oauthError = (res, err) => {
    const headers = err.status === 401 && err.error === 'invalid_client' ? { 'WWW-Authenticate': 'Basic realm="token"' } : {};
    sendJson(res, err.status, { error: err.error, error_description: err.message }, headers);
  };

  /** client_id / client_secret from the body or HTTP Basic (RFC 6749 2.3.1). */
  function clientCredentials(req, form) {
    const m = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(req.headers.authorization ?? '');
    if (m) {
      const raw = Buffer.from(m[1], 'base64').toString('utf8');
      const i = raw.indexOf(':');
      if (i === -1) throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
      const dec = (v) => {
        try {
          return decodeURIComponent(v.replace(/\+/g, ' '));
        } catch {
          throw new OAuthError('invalid_client', 'Malformed Basic credentials', 401);
        }
      };
      const id = dec(raw.slice(0, i));
      if (form.client_id !== undefined && form.client_id !== id) throw new OAuthError('invalid_request', 'client_id differs from the Basic credentials');
      return { clientId: id, clientSecret: dec(raw.slice(i + 1)) };
    }
    return { clientId: form.client_id, clientSecret: form.client_secret };
  }

  async function authorizeGet(req, res, url) {
    limit(limits.login, ipOf(req), 'login attempts');
    const q = {};
    for (const [k, v] of url.searchParams) {
      if (k in q) return page(res, 400, 'Invalid request', `<p>Parameter ${escapeHtml(k)} given twice.</p>`);
      q[k] = v;
    }
    let checked;
    try {
      checked = await oauth.checkAuthorizeRequest(q);
    } catch (err) {
      if (!(err instanceof OAuthError)) throw err;
      if (err.redirect) {
        res.writeHead(302, { Location: oauth.responseUrl(err.redirectUri, { error: err.error, error_description: err.message, state: err.state }) });
        return res.end();
      }
      return page(res, 400, 'This connection request cannot be used', `<p>${escapeHtml(err.message)}</p><p class="muted">Start the connection again from your app.</p>`);
    }
    const { nonce, cookie } = handover.begin({ mode: 'connect', oauth: checked.params, clientName: checked.clientName }, { owner: ipOf(req) });
    consentPage(res, { nonce, cookie, clientName: checked.clientName, verified: checked.verified, redirectUri: checked.params.redirectUri });
  }

  /** Approve or deny after the session handover. */
  async function authorizeDecision(req, res) {
    assertSameOrigin(req, base);
    const ip = ipOf(req);
    limit(limits.login, ip, 'login attempts');
    const body = await readJsonBody(req, FORM_LIMIT);
    const cookie = readCookie(req.headers.cookie);
    const p = handover.peek(body.n, cookie);
    if (p.extra.mode !== 'connect') throw new HandoverError('unknown', 'This login link is not valid here.', 400);
    const params = p.extra.oauth;
    if (body.action === 'deny') {
      handover.take(body.n, cookie);
      return sendJson(res, 200, { ok: true, message: 'Cancelled.', redirect: oauth.responseUrl(params.redirectUri, { error: 'access_denied', error_description: 'The user cancelled', state: params.state }) });
    }
    if (p.status !== 'verified') throw new HandoverError('busy', 'Connect your Samsung Food account first (step above).', 409);
    const r = p.result;
    if (!store.getUser(r.uid)) {
      let inviteId = null;
      if (config.inviteRequired) {
        limit(limits.invite, ip, 'invite code attempts');
        const code = normalizeInvite(body.invite);
        const inv = code.length >= 8 ? store.inviteByHash(keyring.inviteHash(code)) : null;
        if (!inv || inv.revoked_at || (inv.expires_at && inv.expires_at <= now()) || inv.uses >= inv.max_uses || !store.useInvite(inv.id)) {
          throw new HttpError(403, 'invite_invalid', 'This invite code is not valid (or used up). Check it, or ask for a new one.');
        }
        inviteId = inv.id;
      }
      try {
        store.putUser(r.uid, inviteId);
      } catch {
        // created concurrently by another approval of the same account
      }
    }
    store.seeUser(r.uid);
    handover.take(body.n, cookie);
    const redirect = oauth.approve({ params, uid: r.uid, readOnly: body.readOnly === true || config.readOnly, session: { accessToken: r.token, savedAt: new Date(now()).toISOString() } });
    log('grant created');
    sendJson(res, 200, { ok: true, message: `Connected. Returning to ${new URL(params.redirectUri).host}...`, redirect });
  }

  async function disconnectDecision(req, res) {
    assertSameOrigin(req, base);
    limit(limits.login, ipOf(req), 'login attempts');
    const body = await readJsonBody(req, FORM_LIMIT);
    const cookie = readCookie(req.headers.cookie);
    const p = handover.peek(body.n, cookie);
    if (p.extra.mode !== 'disconnect') throw new HandoverError('unknown', 'This login link is not valid here.', 400);
    if (p.status !== 'verified') throw new HandoverError('busy', 'Connect your Samsung Food account first (step above).', 409);
    handover.take(body.n, cookie);
    const existed = store.deleteUser(p.result.uid);
    log('user deleted (self-service)');
    sendJson(res, 200, { ok: true, message: existed ? 'Done. All connections and the stored session of this account were deleted. Also remove the connector in your app.' : 'There was nothing stored for this account.' });
  }

  async function token(req, res) {
    limit(limits.token, ipOf(req), 'token requests');
    const form = await readFormBody(req, FORM_LIMIT);
    try {
      const client = await oauth.authenticate(clientCredentials(req, form));
      if (form.grant_type === 'authorization_code') return sendJson(res, 200, oauth.exchangeCode(client, form));
      if (form.grant_type === 'refresh_token') {
        const r = oauth.refresh(client, form);
        sendJson(res, 200, r.body);
        renewInBackground(r.gid, r.key);
        return;
      }
      throw new OAuthError('unsupported_grant_type', 'grant_type must be authorization_code or refresh_token');
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(res, err);
      throw err;
    }
  }

  async function revoke(req, res) {
    limit(limits.token, ipOf(req), 'token requests');
    const form = await readFormBody(req, FORM_LIMIT);
    try {
      const client = await oauth.authenticate(clientCredentials(req, form));
      if (typeof form.token !== 'string' || !form.token) throw new OAuthError('invalid_request', 'token is required');
      oauth.revoke(client, form.token);
      sendJson(res, 200, {});
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(res, err);
      throw err;
    }
  }

  async function register(req, res) {
    limit(limits.register, ipOf(req), 'client registrations');
    const body = await readJsonBody(req, FORM_LIMIT);
    try {
      sendJson(res, 201, oauth.register(body));
    } catch (err) {
      if (err instanceof OAuthError) return oauthError(res, err);
      throw err;
    }
  }

  /* ------------------------------------------------------------ MCP */

  const challenge = (error, description) =>
    `Bearer resource_metadata="${prmUrl}", scope="${SCOPE}"${error ? `, error="${error}", error_description="${description.replace(/["\\]/g, '')}"` : ''}`;

  async function mcp(req, res) {
    const m = /^Bearer\s+(\S+)\s*$/i.exec(req.headers.authorization ?? '');
    if (!m) {
      return sendJson(res, 401, { error: 'invalid_token', error_description: 'Authorization required' }, { 'WWW-Authenticate': challenge() });
    }
    let auth;
    try {
      auth = oauth.authenticateBearer(m[1]);
    } catch (err) {
      if (err instanceof OAuthError) return sendJson(res, 401, { error: err.error, error_description: err.message }, { 'WWW-Authenticate': challenge(err.error, err.message) });
      throw err;
    }
    if (req.method !== 'POST') {
      res.writeHead(405, { Allow: 'POST', 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32000, message: 'Method not allowed: this MCP endpoint is stateless, use POST' }, id: null }));
    }
    const { grant, key } = auth;
    limit(limits.mcp, grant.uid, 'requests');
    const body = await readJsonBody(req, MCP_BODY_LIMIT).catch((err) => {
      // Batches are arrays; readJsonBody only takes objects.
      if (err.code === 'invalid_json') throw new HttpError(400, 'invalid_json', 'Request body must be a single JSON-RPC message');
      throw err;
    });
    if (body.method === 'tools/call') limit(limits.tools, grant.uid, 'tool calls per minute');
    if (now() - grant.last_used_at > 60_000) {
      store.touchGrant(grant.gid);
      store.seeUser(grant.uid);
    }
    const ts = grantStore(grant.gid, key);
    let client = null;
    const holder = { get: async () => (client ??= await makeClient({ tokenStore: ts, via: transports.forUser(grant.uid) })) };
    const tools = hostedTools({
      readOnly: Boolean(grant.read_only) || config.readOnly,
      disconnect: async (everything) => {
        if (everything) store.deleteUser(grant.uid);
        else store.deleteGrant(grant.gid);
        log(everything ? 'user deleted (tool)' : 'grant deleted (tool)');
        return { disconnected: true, deletedEverything: everything, note: 'Also remove the connector in the app settings.' };
      },
    });
    await handleHostedMcp(req, res, body, {
      tools,
      holder,
      version: VERSION,
      name: config.name,
      challenge: challenge('invalid_token', 'The Samsung Food session expired; connect again'),
      expiredText: `Your Samsung Food session has expired or was signed out, so ${config.name} can no longer reach your account. Reconnect the connector in your app (how: ${base}/reconnect).`,
      onExpired: () => store.markSamsungExpired(grant.gid),
    });
  }

  /* ------------------------------------------------------------ routing */

  const CORS_PATHS = new Set(['/.well-known/oauth-protected-resource', '/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-authorization-server', '/register', '/token', '/revoke', '/mcp']);

  async function route(req, res) {
    const url = new URL(req.url ?? '/', base);
    const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, '') : url.pathname;
    const method = req.method ?? 'GET';

    if (CORS_PATHS.has(path)) {
      // Bearer tokens, no cookies: any origin may call these (browser-based MCP clients, inspectors).
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Expose-Headers', 'WWW-Authenticate, Mcp-Session-Id, Mcp-Protocol-Version');
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version, Mcp-Session-Id, Mcp-Method, Mcp-Name, Last-Event-ID', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
    }

    // Each submitted session costs a GetMe call at Samsung Food; status polling is not limited.
    if (path === '/login/handover' && method === 'POST') limit(limits.handover, ipOf(req), 'login attempts');
    if (await handleHandoverApi(req, res, path, { handover, origin: base })) return;

    const get = method === 'GET' || method === 'HEAD';
    switch (path) {
      case '/healthz':
        return sendJson(res, 200, { ok: true, version: VERSION });
      case '/.well-known/oauth-protected-resource':
      case '/.well-known/oauth-protected-resource/mcp':
        if (get) return sendJson(res, 200, prMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        break;
      case '/.well-known/oauth-authorization-server':
        if (get) return sendJson(res, 200, asMetadata(), { 'Cache-Control': 'public, max-age=3600' });
        break;
      case '/register':
        if (method === 'POST') return register(req, res);
        break;
      case '/authorize':
        if (get) return authorizeGet(req, res, url);
        break;
      case '/authorize/decision':
        if (method === 'POST') return authorizeDecision(req, res);
        break;
      case '/token':
        if (method === 'POST') return token(req, res);
        break;
      case '/revoke':
        if (method === 'POST') return revoke(req, res);
        break;
      case '/mcp':
        return mcp(req, res);
      case '/login/landing':
        if (get) {
          const n = newScriptNonce();
          return sendHtml(res, 200, landingPage({ endpoints: { handover: '/login/handover' }, scriptNonce: n, footer: footer() }), { 'Content-Security-Policy': pageCsp(n) });
        }
        break;
      case '/disconnect':
        if (get) return disconnectPage(req, res);
        break;
      case '/disconnect/decision':
        if (method === 'POST') return disconnectDecision(req, res);
        break;
      case '/privacy':
        if (get) return legal(res, 'privacy', 'Privacy');
        break;
      case '/terms':
        if (get) return legal(res, 'terms', 'Terms');
        break;
      case '/imprint':
        if (get) return legal(res, 'imprint', 'Imprint');
        break;
      case '/reconnect':
        if (get)
          return page(
            res,
            200,
            'Reconnect Samsung Food',
            `<p>Your Samsung Food session ended (for example after a logout on all devices, a password change, or more than 14 days without use). Connect again:</p>
<ul><li><strong>Claude</strong>: Settings → Connectors → ${escapeHtml(config.name)} → Disconnect, then Connect.</li>
<li><strong>ChatGPT</strong>: Settings → Apps (or Plugins) → ${escapeHtml(config.name)} → Disconnect, then connect again.</li></ul>
<p>Both open this connector's login page, where you hand over the session again with one click.</p>`
          );
        break;
      case '/favicon.ico':
        res.writeHead(204);
        return res.end();
      case '/':
        if (get)
          return page(
            res,
            200,
            config.name,
            `<p>Use your Samsung Food account (meal plan, shopping lists, recipes, pantry) in ChatGPT, Claude and other apps that support remote MCP connectors.</p>
<p>Connector URL: <code>${escapeHtml(oauth.resource)}</code></p>
<p class="muted">${config.inviteRequired ? 'Closed beta: you need an invite code the first time you connect.' : ''}</p>`
          );
        break;
      default:
        return sendJson(res, 404, { error: 'not_found', error_description: `No route for ${method} ${path}` });
    }
    res.writeHead(405, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'method_not_allowed', error_description: `${method} is not allowed on ${path}` }));
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    baseHeaders(res);
    if (secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    res.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    res.on('finish', () => {
      const p = (req.url ?? '').split('?')[0];
      if (p !== '/healthz') log(`${req.method} ${p} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      if (err instanceof HandoverError || err instanceof HttpError) {
        return sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } }, err.headers ?? {});
      }
      log(`internal error: ${err?.name ?? 'Error'}`);
      sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'Internal error' } });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;

  const sweep = () => {
    try {
      const r = store.sweep({ inactivityMs: config.inactivityDays * 86400000 });
      if (r.grants || r.users || r.clients) log(`cleanup: ${r.grants} grants, ${r.users} users, ${r.clients} clients removed`);
    } catch (err) {
      log(`cleanup failed: ${err.message}`);
    }
  };
  sweep();
  const timer = setInterval(sweep, 3600_000);
  timer.unref();
  // Expired codes and tokens lose their wrap within a minute, not only at the hourly sweep.
  const wrapTimer = setInterval(() => {
    try {
      store.dropExpiredWraps();
    } catch {
      // the hourly sweep retries
    }
  }, 60_000);
  wrapTimer.unref();
  server.on('close', () => {
    clearInterval(timer);
    clearInterval(wrapTimer);
  });

  server.handover = handover;
  /** Loads (or builds) the protocol schema ahead of the first login. */
  server.warmup = () => currentSchema();
  server.oauth = oauth;
  return server;
}
