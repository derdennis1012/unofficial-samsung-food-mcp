import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadSqlite, openStore } from '../src/hosted/store.js';
import { client, fakeSamsung, pageConfig, pkce, testSchema, tmpDir, TOKEN_A, TOKEN_RENEWED } from './hosted-helpers.js';

const sqlite = loadSqlite();
const skip = sqlite ? false : 'node:sqlite is not available on this Node.js version (needs 22.13+)';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const MASTER = Buffer.alloc(32, 7);

async function setup(over = {}) {
  const { createHostedServer } = await import('../src/hosted/server.js');
  const { createKeyring, generateInvite } = await import('../src/hosted/crypto.js');
  const dataDir = tmpDir();
  const clock = { offset: 0 };
  const now = () => Date.now() + clock.offset;
  const store = openStore(dataDir, { now });
  const schema = testSchema();
  const samsung = fakeSamsung(schema);
  let port;
  const config = {
    publicUrl: 'http://127.0.0.1:0', // replaced after listen
    masterKey: MASTER,
    dataDir,
    trustProxy: 0,
    name: 'Test connector',
    operator: '',
    inviteRequired: true,
    readOnly: false,
    accessTtlSec: 3600,
    refreshTtlDays: 30,
    inactivityDays: 30,
    toolCallsPerMinute: 60,
    upstreamConcurrency: 4,
    maxClients: 100,
    redirectHosts: ['chatgpt.com', 'claude.ai', 'claude.com'],
    cimdHosts: ['chatgpt.com'],
    pages: { privacy: null, terms: null, imprint: null },
    locale: 'en-US',
    ...over.config,
  };
  // The public URL must be known before the server is created: reserve a port first.
  const probe = (await import('node:http')).createServer();
  await new Promise((r) => probe.listen(0, '127.0.0.1', r));
  port = probe.address().port;
  await new Promise((r) => probe.close(r));
  config.publicUrl = `http://127.0.0.1:${port}`;
  const logs = [];
  const server = createHostedServer({ config, store, schema, transport: samsung.transport, now, log: (l) => logs.push(l), fetchImpl: over.fetchImpl });
  await new Promise((r) => server.listen(port, '127.0.0.1', r));
  const base = config.publicUrl;
  const keyring = createKeyring(MASTER);
  const invite = (uses = 1) => {
    const code = generateInvite();
    store.putInvite(`i_${Math.random().toString(16).slice(2)}`, keyring.inviteHash(code), 'test', uses, Date.now() + 86400000);
    return code;
  };
  const close = () =>
    new Promise((r) => {
      server.closeAllConnections();
      server.close(() => {
        store.close();
        fs.rmSync(dataDir, { recursive: true, force: true });
        r();
      });
    });
  return { server, store, base, samsung, clock, invite, logs, close, dataDir, config };
}

async function registerClient(base, body = { redirect_uris: [REDIRECT], client_name: 'Claude' }) {
  const r = await client(base).request('POST', '/register', { json: body });
  assert.equal(r.status, 201, r.text);
  return r.data;
}

function authorizeUrl(clientId, challenge, extra = {}) {
  const q = new URLSearchParams({ response_type: 'code', client_id: clientId, redirect_uri: REDIRECT, code_challenge: challenge, code_challenge_method: 'S256', state: 'st-123', scope: 'food', ...extra });
  return `/authorize?${q}`;
}

/** Browser part: consent page -> session handover -> approve. Returns the redirect URL. */
async function consent(ctx, clientId, challenge, { invite, credential = `whisk.USER_TOKEN=${TOKEN_A}`, readOnly = false } = {}) {
  const browser = client(ctx.base);
  const page = await browser.request('GET', authorizeUrl(clientId, challenge));
  assert.equal(page.status, 200, page.text);
  const cfg = pageConfig(page.text);
  const sent = await browser.request('POST', '/login/handover', { json: { n: cfg.nonce, c: credential } });
  assert.equal(sent.status, 200, sent.text);
  const decided = await browser.request('POST', '/authorize/decision', { json: { n: cfg.nonce, action: 'approve', invite, readOnly } });
  return { browser, cfg, sent, decided };
}

async function tokenRequest(base, form) {
  return client(base).request('POST', '/token', { form });
}

async function fullFlow(ctx, opts = {}) {
  const reg = await registerClient(ctx.base);
  const { verifier, challenge } = pkce();
  const { decided, sent } = await consent(ctx, reg.client_id, challenge, { invite: ctx.invite(), ...opts });
  assert.equal(decided.status, 200, decided.text);
  const code = new URL(decided.data.redirect).searchParams.get('code');
  const tok = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: `${ctx.base}/mcp` });
  assert.equal(tok.status, 200, tok.text);
  return { reg, tokens: tok.data, code, verifier, decided, sent };
}

const MCP_HEADERS = { accept: 'application/json, text/event-stream' };
let rpcId = 0;
async function rpc(base, accessToken, method, params = {}) {
  return client(base).request('POST', '/mcp', {
    json: { jsonrpc: '2.0', id: ++rpcId, method, params },
    headers: { ...MCP_HEADERS, ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}), 'mcp-protocol-version': '2025-11-25' },
  });
}
const initParams = { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test', version: '1' } };

test('metadata: protected resource, authorization server, 401 challenge', { skip }, async () => {
  const ctx = await setup();
  try {
    const c = client(ctx.base);
    const prm = await c.request('GET', '/.well-known/oauth-protected-resource/mcp');
    assert.equal(prm.data.resource, `${ctx.base}/mcp`);
    assert.deepEqual(prm.data.authorization_servers, [ctx.base]);
    assert.deepEqual((await c.request('GET', '/.well-known/oauth-protected-resource')).data, prm.data);
    const as = (await c.request('GET', '/.well-known/oauth-authorization-server')).data;
    assert.equal(as.issuer, ctx.base);
    assert.deepEqual(as.code_challenge_methods_supported, ['S256']);
    assert.ok(as.token_endpoint_auth_methods_supported.includes('none'));
    assert.equal(as.authorization_response_iss_parameter_supported, true);
    assert.equal(as.client_id_metadata_document_supported, true);
    assert.equal(as.registration_endpoint, `${ctx.base}/register`);

    const unauth = await rpc(ctx.base, null, 'initialize', initParams);
    assert.equal(unauth.status, 401);
    assert.match(unauth.headers['www-authenticate'], new RegExp(`^Bearer resource_metadata="${ctx.base}/.well-known/oauth-protected-resource/mcp", scope="food"$`));
    const bad = await rpc(ctx.base, 'sfat_xxxxxxxxxxxxxxxxxxxxxx.yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy', 'initialize', initParams);
    assert.equal(bad.status, 401);
    assert.match(bad.headers['www-authenticate'], /error="invalid_token"/);
  } finally {
    await ctx.close();
  }
});

test('full flow: DCR -> consent with invite + session handover -> token -> MCP -> refresh rotation -> revoke', { skip }, async () => {
  const ctx = await setup();
  try {
    const reg = await registerClient(ctx.base);
    assert.match(reg.client_id, /^c_/);
    assert.equal(reg.client_secret, undefined, 'public client');
    const { verifier, challenge } = pkce();

    const browser = client(ctx.base);
    const page = await browser.request('GET', authorizeUrl(reg.client_id, challenge));
    assert.equal(page.status, 200);
    assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
    assert.doesNotMatch(page.headers['content-security-policy'], /unsafe-inline/);
    assert.match(page.text, /Claude/);
    assert.match(page.text, /claude\.ai/, 'shows the redirect host');
    assert.match(page.headers['set-cookie'][0], /sf_login=.*HttpOnly; SameSite=Lax/);
    const cfg = pageConfig(page.text);
    assert.ok(cfg.nonce);

    // Session handover (the bookmarklet sends only the session cookie).
    const sent = await browser.request('POST', '/login/handover', { json: { n: cfg.nonce, c: `whisk.USER_TOKEN=${TOKEN_A}` } });
    assert.equal(sent.status, 200, sent.text);
    assert.equal(sent.data.account, 'Anna Test');
    assert.equal(sent.data.needsInvite, true);
    const st = await browser.request('POST', '/login/status', { json: { n: cfg.nonce } });
    assert.equal(st.data.status, 'verified');

    // Bad invite: refused, the pending login stays usable.
    const badInvite = await browser.request('POST', '/authorize/decision', { json: { n: cfg.nonce, action: 'approve', invite: 'SF-AAAA-BBBB-CCCC' } });
    assert.equal(badInvite.status, 403);
    assert.equal(badInvite.data.error.code, 'invite_invalid');

    const decided = await browser.request('POST', '/authorize/decision', { json: { n: cfg.nonce, action: 'approve', invite: ctx.invite().toLowerCase() } });
    assert.equal(decided.status, 200, decided.text);
    const redirect = new URL(decided.data.redirect);
    assert.equal(redirect.origin + redirect.pathname, REDIRECT);
    assert.equal(redirect.searchParams.get('state'), 'st-123');
    assert.equal(redirect.searchParams.get('iss'), ctx.base);
    const code = redirect.searchParams.get('code');
    assert.match(code, /^sfac_/);

    // The pending login is single use.
    const again = await browser.request('POST', '/authorize/decision', { json: { n: cfg.nonce, action: 'approve' } });
    assert.equal(again.status, 404);

    const tok = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: REDIRECT, resource: `${ctx.base}/mcp` });
    assert.equal(tok.status, 200, tok.text);
    assert.equal(tok.headers['cache-control'], 'no-store');
    assert.equal(tok.data.token_type, 'Bearer');
    assert.equal(tok.data.expires_in, 3600);
    assert.match(tok.data.access_token, /^sfat_/);
    assert.match(tok.data.refresh_token, /^sfrt_/);

    // MCP with the bearer.
    const init = await rpc(ctx.base, tok.data.access_token, 'initialize', initParams);
    assert.equal(init.status, 200, init.text);
    assert.equal(init.data.result.serverInfo.name, 'unofficial-samsung-food-mcp');
    assert.ok(init.data.result.instructions.length > 50);
    const list = await rpc(ctx.base, tok.data.access_token, 'tools/list');
    const names = list.data.result.tools.map((t) => t.name);
    assert.ok(names.includes('meal_plan_get'));
    assert.ok(names.includes('connector_disconnect'));
    assert.ok(!names.includes('api_call') && !names.includes('auth_login') && !names.includes('auth_status'));
    for (const t of list.data.result.tools) assert.equal(typeof t.annotations.readOnlyHint, 'boolean', t.name);
    assert.equal(list.data.result.tools.find((t) => t.name === 'shopping_list_add').annotations.readOnlyHint, false);

    const call = await rpc(ctx.base, tok.data.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.equal(call.status, 200);
    assert.equal(call.data.result.isError, undefined, call.text);
    assert.equal(call.data.result.structuredContent.id, 'samsung-user-1');

    // Refresh rotation: new pair, the old refresh token is dead.
    const r1 = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tok.data.refresh_token, client_id: reg.client_id });
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(r1.data.refresh_token, tok.data.refresh_token);
    const reuse = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tok.data.refresh_token, client_id: reg.client_id });
    assert.equal(reuse.status, 400);
    assert.equal(reuse.data.error, 'invalid_grant');
    // Within the grace period the grant survives (parallel refreshes); new tokens keep working.
    assert.equal((await rpc(ctx.base, r1.data.access_token, 'tools/list')).status, 200);

    // Revoke the refresh token: the whole grant goes, access tokens included.
    const rev = await client(ctx.base).request('POST', '/revoke', { form: { token: r1.data.refresh_token, client_id: reg.client_id } });
    assert.equal(rev.status, 200);
    assert.equal((await rpc(ctx.base, r1.data.access_token, 'tools/list')).status, 401);
    assert.equal((await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: r1.data.refresh_token, client_id: reg.client_id })).data.error, 'invalid_grant');

    // Logs carry paths and status codes only.
    const all = ctx.logs.join('\n');
    for (const secret of [TOKEN_A, TOKEN_RENEWED, code, tok.data.access_token, tok.data.refresh_token]) assert.ok(!all.includes(secret));
    assert.ok(!all.includes('?'), 'no query strings in logs');
  } finally {
    await ctx.close();
  }
});

test('reuse of a rotated refresh token after the grace period revokes the grant', { skip }, async () => {
  const ctx = await setup();
  try {
    const { reg, tokens } = await fullFlow(ctx);
    const r1 = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
    assert.equal(r1.status, 200);
    ctx.clock.offset = 60_000;
    const reuse = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
    assert.equal(reuse.data.error, 'invalid_grant');
    assert.equal((await rpc(ctx.base, r1.data.access_token, 'tools/list')).status, 401, 'grant revoked');
  } finally {
    await ctx.close();
  }
});

test('PKCE, redirect URI, client and code checks', { skip }, async () => {
  const ctx = await setup();
  try {
    const reg = await registerClient(ctx.base);
    const c = client(ctx.base);

    // Unregistered redirect URI: an error page, never a redirect to it.
    const wrong = await c.request('GET', authorizeUrl(reg.client_id, pkce().challenge, { redirect_uri: 'https://evil.example/cb' }));
    assert.equal(wrong.status, 400);
    assert.equal(wrong.headers.location, undefined);
    // Unknown client: error page.
    assert.equal((await c.request('GET', authorizeUrl('c_unknown', pkce().challenge))).status, 400);
    // Missing PKCE / plain method: redirected back with an error.
    const noPkce = await c.request('GET', authorizeUrl(reg.client_id, pkce().challenge, { code_challenge_method: 'plain' }));
    assert.equal(noPkce.status, 302);
    const loc = new URL(noPkce.headers.location);
    assert.equal(loc.searchParams.get('error'), 'invalid_request');
    assert.equal(loc.searchParams.get('state'), 'st-123');
    assert.equal(loc.searchParams.get('iss'), ctx.base);
    // Wrong resource.
    const res = await c.request('GET', authorizeUrl(reg.client_id, pkce().challenge, { resource: 'https://other.example/mcp' }));
    assert.equal(new URL(res.headers.location).searchParams.get('error'), 'invalid_target');

    // Code exchange with a wrong verifier fails; the code is then still unused and works once.
    const { verifier, challenge } = pkce();
    const { decided } = await consent(ctx, reg.client_id, challenge, { invite: ctx.invite() });
    const code = new URL(decided.data.redirect).searchParams.get('code');
    const badVerifier = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: pkce().verifier, client_id: reg.client_id });
    assert.equal(badVerifier.data.error, 'invalid_grant');
    const badRedirect = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id, redirect_uri: 'https://claude.ai/other' });
    assert.equal(badRedirect.data.error, 'invalid_grant');
    const other = await registerClient(ctx.base);
    const otherClient = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: other.client_id });
    assert.equal(otherClient.data.error, 'invalid_grant');
    const ok = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id });
    assert.equal(ok.status, 200);
    // Replayed code: refused, and the tokens issued from it are revoked.
    const replay = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: reg.client_id });
    assert.equal(replay.data.error, 'invalid_grant');
    assert.equal((await rpc(ctx.base, ok.data.access_token, 'tools/list')).status, 401);

    // Token endpoint only takes form bodies.
    const json = await c.request('POST', '/token', { json: { grant_type: 'authorization_code' } });
    assert.equal(json.status, 415);
    const unsupported = await tokenRequest(ctx.base, { grant_type: 'password', client_id: reg.client_id });
    assert.equal(unsupported.data.error, 'unsupported_grant_type');
    assert.equal((await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: 'x', client_id: 'nope' })).status, 401);
  } finally {
    await ctx.close();
  }
});

test('confidential DCR clients must authenticate; registration validates metadata', { skip }, async () => {
  const ctx = await setup();
  try {
    const conf = await registerClient(ctx.base, { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'client_secret_basic' });
    assert.match(conf.client_secret, /^cs_/);
    const c = client(ctx.base);
    for (const body of [
      { redirect_uris: ['http://example.com/cb'] },
      { redirect_uris: ['https://x.example/cb#frag'] },
      { redirect_uris: [] },
      { redirect_uris: [REDIRECT], grant_types: ['client_credentials'] },
      { redirect_uris: [REDIRECT], token_endpoint_auth_method: 'private_key_jwt' },
    ]) {
      const r = await c.request('POST', '/register', { json: body });
      assert.equal(r.status, 400, JSON.stringify(body));
    }
    // Loopback redirect (Claude Code): any port matches.
    const local = await registerClient(ctx.base, { redirect_uris: ['http://localhost/callback'] });
    const page = await c.request('GET', `/authorize?${new URLSearchParams({ response_type: 'code', client_id: local.client_id, redirect_uri: 'http://localhost:53682/callback', code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`);
    assert.equal(page.status, 200);
    assert.match(page.text, /program on your own computer/);

    const { verifier, challenge } = pkce();
    const { decided } = await consent(ctx, conf.client_id, challenge, { invite: ctx.invite() });
    const code = new URL(decided.data.redirect).searchParams.get('code');
    const noSecret = await tokenRequest(ctx.base, { grant_type: 'authorization_code', code, code_verifier: verifier, client_id: conf.client_id });
    assert.equal(noSecret.status, 401);
    assert.equal(noSecret.data.error, 'invalid_client');
    const basic = Buffer.from(`${conf.client_id}:${conf.client_secret}`).toString('base64');
    const ok = await client(ctx.base).request('POST', '/token', { form: { grant_type: 'authorization_code', code, code_verifier: verifier }, headers: { authorization: `Basic ${basic}` } });
    assert.equal(ok.status, 200, ok.text);
  } finally {
    await ctx.close();
  }
});

test('CIMD: client metadata documents from allowlisted hosts only', { skip }, async () => {
  const cimdId = 'https://chatgpt.com/oauth/client.json';
  const fetchImpl = async (url, opts) => {
    assert.equal(opts.redirect, 'error');
    assert.equal(url, cimdId);
    // Shape of ChatGPT's real document: prefers private_key_jwt, also supports none, extra grant type.
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({ client_id: cimdId, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'], token_endpoint_auth_method: 'private_key_jwt', token_endpoint_auth_methods_supported: ['none', 'private_key_jwt'], grant_types: ['authorization_code', 'refresh_token', 'urn:ietf:params:oauth:grant-type:jwt-bearer'], response_types: ['code'] }),
    };
  };
  const ctx = await setup({ fetchImpl, config: { cimdHosts: ['chatgpt.com'] } });
  try {
    const c = client(ctx.base);
    const q = (id, redirect) => `/authorize?${new URLSearchParams({ response_type: 'code', client_id: id, redirect_uri: redirect, code_challenge: pkce().challenge, code_challenge_method: 'S256' })}`;
    const ok = await c.request('GET', q(cimdId, 'https://chatgpt.com/connector_platform_oauth_redirect'));
    assert.equal(ok.status, 200, ok.text);
    assert.match(ok.text, /ChatGPT/);
    assert.equal((await c.request('GET', q(cimdId, 'https://chatgpt.com/other'))).status, 400);
    assert.equal((await c.request('GET', q('https://evil.example/client.json', 'https://evil.example/cb'))).status, 400, 'host not allowlisted');
  } finally {
    await ctx.close();
  }
});

test('handover: CSRF, browser binding, wrong credentials and GetMe failure', { skip }, async () => {
  const ctx = await setup();
  try {
    const reg = await registerClient(ctx.base);
    const browser = client(ctx.base);
    const page = await browser.request('GET', authorizeUrl(reg.client_id, pkce().challenge));
    const { nonce } = pageConfig(page.text);

    const crossSite = await browser.request('POST', '/login/handover', { json: { n: nonce, c: TOKEN_A }, headers: { origin: 'https://evil.example' } });
    assert.equal(crossSite.status, 403);
    const asForm = await browser.request('POST', '/login/handover', { form: { n: nonce, c: TOKEN_A } });
    assert.equal(asForm.status, 415, 'no simple cross-site form posts');
    const otherBrowser = await client(ctx.base).request('POST', '/login/handover', { json: { n: nonce, c: TOKEN_A } });
    assert.equal(otherBrowser.status, 403);
    assert.equal(otherBrowser.data.error.code, 'browser');
    const garbage = await browser.request('POST', '/login/handover', { json: { n: nonce, c: 'hello' } });
    assert.equal(garbage.data.error.code, 'no_token');
    const rejected = await browser.request('POST', '/login/handover', { json: { n: nonce, c: 'whisk.USER_TOKEN=' + 'Z'.repeat(48) } });
    assert.equal(rejected.status, 400);
    assert.match(rejected.data.error.message, /did not accept/);
    // Approving before a session was handed over is refused.
    const early = await browser.request('POST', '/authorize/decision', { json: { n: nonce, action: 'approve' } });
    assert.equal(early.status, 409);
    // Deny redirects with access_denied.
    const deny = await browser.request('POST', '/authorize/decision', { json: { n: nonce, action: 'deny' } });
    assert.equal(new URL(deny.data.redirect).searchParams.get('error'), 'access_denied');
  } finally {
    await ctx.close();
  }
});

test('expired access tokens, rate limit and the read-only option', { skip }, async () => {
  const ctx = await setup({ config: { toolCallsPerMinute: 3 } });
  try {
    const { tokens } = await fullFlow(ctx, { readOnly: true });
    const list = await rpc(ctx.base, tokens.access_token, 'tools/list');
    const tools = list.data.result.tools;
    assert.ok(tools.every((t) => t.annotations.readOnlyHint || t.name === 'connector_disconnect'), 'read-only grant lists only read tools');
    for (let i = 0; i < 3; i++) assert.equal((await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} })).status, 200);
    const limited = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.equal(limited.status, 429);
    assert.ok(Number(limited.headers['retry-after']) > 0);

    ctx.clock.offset = 3601_000;
    const expired = await rpc(ctx.base, tokens.access_token, 'tools/list');
    assert.equal(expired.status, 401);
    assert.match(expired.headers['www-authenticate'], /invalid_token/);
  } finally {
    await ctx.close();
  }
});

test('encryption at rest: the database never contains a Samsung token; renewal writes back encrypted', { skip }, async () => {
  const ctx = await setup();
  try {
    const { tokens } = await fullFlow(ctx);
    const dbBytes = () => fs.readdirSync(ctx.dataDir).map((f) => fs.readFileSync(path.join(ctx.dataDir, f)).toString('latin1')).join('');
    let dump = dbBytes();
    assert.ok(dump.length > 1000);
    assert.ok(!dump.includes(TOKEN_A), 'no plaintext Samsung token after the consent');
    assert.ok(!dump.includes(tokens.access_token.split('.')[1]), 'no plaintext access token secret');
    assert.ok(!dump.includes('samsung-user-1'), 'no plaintext Samsung account id');

    // First tool call: the session has no known expiry, so it is renewed (IssueAuthCode/UseAuthCode).
    const call = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.equal(call.status, 200);
    assert.ok(ctx.samsung.calls.some((c) => c.method.endsWith('UseAuthCode')), 'renewed');
    assert.equal(ctx.samsung.calls.at(-1).token, TOKEN_RENEWED, 'the call used the renewed token');
    dump = dbBytes();
    assert.ok(!dump.includes(TOKEN_RENEWED) && !dump.includes(TOKEN_A), 'renewed token stored encrypted');

    // Later calls read the renewed token back from the encrypted record.
    ctx.samsung.valid.delete(TOKEN_A);
    const n = ctx.samsung.calls.length;
    await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.deepEqual(ctx.samsung.calls.slice(n).map((c) => c.token), [TOKEN_RENEWED]);

    // Without a credential's secret, a database copy plus the master key is not enough.
    const { createKeyring, open } = await import('../src/hosted/crypto.js');
    const keyring = createKeyring(MASTER);
    const grant = ctx.store.db.prepare('SELECT * FROM grants').get();
    const cred = ctx.store.db.prepare("SELECT * FROM creds WHERE kind = 'access'").get();
    assert.throws(() => open(MASTER, cred.wrap, `wrap:access:${cred.id}:${grant.gid}`));
    const forged = { kind: 'access', id: cred.id, secret: 'A'.repeat(43) };
    assert.throws(() => keyring.unwrap(forged, grant.gid, cred.wrap));
  } finally {
    await ctx.close();
  }
});

test('an expired Samsung session: actionable tool error, then 401 so the client reconnects', { skip }, async () => {
  const ctx = await setup();
  try {
    const { tokens, reg } = await fullFlow(ctx);
    ctx.samsung.valid.clear(); // logged out everywhere
    const call = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.equal(call.status, 200);
    assert.equal(call.data.result.isError, true);
    assert.match(call.data.result.content[0].text, /session has expired.*Reconnect.*\/reconnect/);
    assert.doesNotMatch(call.data.result.content[0].text, /ERROR_AUTH_TOKEN|grpc/i);
    assert.match(call.data.result._meta['mcp/www_authenticate'][0], /resource_metadata=.*error="invalid_token"/);
    assert.equal((await rpc(ctx.base, tokens.access_token, 'tools/list')).status, 401);
    const refresh = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
    assert.equal(refresh.data.error, 'invalid_grant');
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0, 'grant deleted');
  } finally {
    await ctx.close();
  }
});

test('self-service disconnect: tool and web page delete the stored session', { skip }, async () => {
  const ctx = await setup();
  try {
    const first = await fullFlow(ctx);
    const res = await rpc(ctx.base, first.tokens.access_token, 'tools/call', { name: 'connector_disconnect', arguments: {} });
    assert.equal(res.data.result.structuredContent.disconnected, true);
    assert.equal((await rpc(ctx.base, first.tokens.access_token, 'tools/list')).status, 401);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'registration kept');

    // Reconnecting a known account needs no invite.
    const reg = await registerClient(ctx.base);
    const { challenge } = pkce();
    const again = await consent(ctx, reg.client_id, challenge, {});
    assert.equal(again.sent.data.needsInvite, false);
    assert.equal(again.decided.status, 200, again.decided.text);

    // Web page: hand over the session, then delete everything.
    const browser = client(ctx.base);
    const page = await browser.request('GET', '/disconnect');
    const { nonce } = pageConfig(page.text);
    const sent = await browser.request('POST', '/login/handover', { json: { n: nonce, c: TOKEN_A } });
    assert.equal(sent.data.hasData, true);
    const del = await browser.request('POST', '/disconnect/decision', { json: { n: nonce, action: 'approve' } });
    assert.equal(del.status, 200, del.text);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 0);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
  } finally {
    await ctx.close();
  }
});

test('invites: single use, revocation and the admin CLI', { skip }, async () => {
  const { runHostCli } = await import('../src/hosted/cli.js');
  const dataDir = tmpDir();
  const env = { SF_HOST_DATA_DIR: dataDir, SF_HOST_MASTER_KEY: MASTER.toString('base64') };
  const lines = [];
  const out = (m) => lines.push(m);
  try {
    await runHostCli(['invites', 'create', '--uses', '2', '--note', 'friends', '--json'], { env, out });
    const created = JSON.parse(lines.pop());
    assert.match(created.code, /^SF-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    await runHostCli(['invites', 'list', '--json'], { env, out });
    const listed = JSON.parse(lines.pop());
    assert.equal(listed[0].uses, '0/2');
    assert.ok(!JSON.stringify(listed).includes(created.code), 'codes are not stored');
    const store = openStore(dataDir);
    const raw = JSON.stringify(store.db.prepare('SELECT * FROM invites').all());
    assert.ok(!raw.includes(created.code.replace(/-/g, '').slice(2)));
    store.close();
    await runHostCli(['invites', 'revoke', created.id], { env, out });
    assert.match(lines.pop(), /revoked/);
    await runHostCli(['users', 'list'], { env, out });
    assert.equal(lines.pop(), 'No users.');
    await runHostCli(['keygen'], { env, out });
    assert.match(lines.pop(), /^[A-Za-z0-9_-]{43}$/);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('config: public URL and master key validation', async () => {
  const { loadConfig, parsePublicUrl } = await import('../src/hosted/config.js');
  assert.throws(() => parsePublicUrl('http://food.example.com'), /https/);
  assert.throws(() => parsePublicUrl('https://food.example.com/mcp'), /without path/);
  assert.equal(parsePublicUrl('https://Food.example.com/'), 'https://food.example.com');
  assert.equal(parsePublicUrl('http://localhost:8788'), 'http://localhost:8788');
  assert.throws(() => loadConfig({ SF_HOST_PUBLIC_URL: 'https://a.example' }), /MASTER_KEY/);
  assert.throws(() => loadConfig({ SF_HOST_PUBLIC_URL: 'https://a.example', SF_HOST_MASTER_KEY: 'short' }), /32 random bytes/);
  const c = loadConfig({ SF_HOST_PUBLIC_URL: 'https://a.example', SF_HOST_MASTER_KEY: MASTER.toString('hex') });
  assert.equal(c.masterKey.length, 32);
  assert.equal(c.inviteRequired, true);
});

test('CIMD fetch refuses non-public addresses', async () => {
  const { isPublicAddress, safeFetch } = await import('../src/hosted/fetch.js');
  for (const ip of ['10.0.0.1', '127.0.0.1', '169.254.169.254', '192.168.1.1', '172.20.0.1', '100.64.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1', '::ffff:7f00:1']) assert.equal(isPublicAddress(ip), false, ip);
  for (const ip of ['160.79.104.10', '8.8.8.8', '2a00:1450:4001::1', '::ffff:8.8.8.8']) assert.equal(isPublicAddress(ip), true, ip);
  await assert.rejects(safeFetch('https://127.0.0.1/client.json'), /non-public/);
  await assert.rejects(safeFetch('http://example.com/client.json'), /https only/);
});

/* ------------------------------------------------------------ security review regressions */

test('H1: consent page shows verified identity: CIMD host, "(unverified)" for DCR, redirect host prominently', { skip }, async () => {
  const cimdId = 'https://chatgpt.com/oauth/x/client.json';
  const fetchImpl = async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ client_id: cimdId, client_name: 'ChatGPT', redirect_uris: ['https://chatgpt.com/cb'] }) });
  const ctx = await setup({ fetchImpl });
  try {
    const c = client(ctx.base);
    const dcr = await registerClient(ctx.base, { redirect_uris: [REDIRECT], client_name: 'Clau‮de​' });
    assert.equal(dcr.client_name, 'Claude', 'format characters stripped at registration');
    const page = await c.request('GET', authorizeUrl(dcr.client_id, pkce().challenge));
    assert.match(page.text, /<strong>Claude \(unverified\)<\/strong>/);
    assert.match(page.text, /not verified/);
    assert.match(page.text, /<strong class="redirect-host">claude\.ai<\/strong>/);
    const q = new URLSearchParams({ response_type: 'code', client_id: cimdId, redirect_uri: 'https://chatgpt.com/cb', code_challenge: pkce().challenge, code_challenge_method: 'S256' });
    const cimd = await c.request('GET', `/authorize?${q}`);
    assert.equal(cimd.status, 200, cimd.text);
    assert.match(cimd.text, /<strong>ChatGPT \(chatgpt\.com\)<\/strong>/);
    assert.doesNotMatch(cimd.text, /not verified/);
    // A phishing registration with a foreign redirect host is refused under the default allowlist.
    const evil = await c.request('POST', '/register', { json: { redirect_uris: ['https://evil.example/cb'], client_name: 'ChatGPT' } });
    assert.equal(evil.status, 400);
    assert.equal(evil.data.error, 'invalid_redirect_uri');
  } finally {
    await ctx.close();
  }
});

test('M2: /disconnect is rate limited and pending logins are capped per network', { skip }, async () => {
  const ctx = await setup();
  try {
    const reg = await registerClient(ctx.base);
    const browsers = [];
    for (let i = 0; i < 6; i++) {
      const b = client(ctx.base);
      const page = await b.request('GET', authorizeUrl(reg.client_id, pkce().challenge));
      assert.equal(page.status, 200);
      browsers.push({ b, nonce: pageConfig(page.text).nonce });
    }
    assert.equal(ctx.server.handover.size, 5, 'at most 5 pending logins per network');
    const oldest = await browsers[0].b.request('POST', '/login/status', { json: { n: browsers[0].nonce } });
    assert.equal(oldest.data.error.code, 'unknown', 'the oldest one was replaced');
    assert.equal((await browsers[5].b.request('POST', '/login/status', { json: { n: browsers[5].nonce } })).data.status, 'pending');

    let limited = null;
    for (let i = 0; i < 40 && !limited; i++) {
      const r = await client(ctx.base).request('GET', '/disconnect');
      if (r.status === 429) limited = r;
    }
    assert.ok(limited, 'GET /disconnect hits the login rate limit');
    assert.ok(ctx.server.handover.size <= 5);
  } finally {
    await ctx.close();
  }
});

test('M3: a full client table evicts the oldest never-used registration', { skip }, async () => {
  const ctx = await setup({ config: { maxClients: 2 } });
  try {
    const { reg: used } = await fullFlow(ctx);
    const unused = await registerClient(ctx.base);
    const third = await registerClient(ctx.base);
    assert.ok(ctx.store.getClient(used.client_id), 'the client with a connection stays');
    assert.equal(ctx.store.getClient(unused.client_id), null, 'oldest never-used client evicted');
    assert.ok(ctx.store.getClient(third.client_id));
    const fourth = await registerClient(ctx.base);
    assert.equal(ctx.store.getClient(third.client_id), null);
    assert.ok(ctx.store.getClient(fourth.client_id));
  } finally {
    await ctx.close();
  }
});

test('L2: refresh rotates the grant key; old wraps are gone and expired credentials lose their wrap at once', { skip }, async () => {
  const ctx = await setup();
  try {
    const { reg, tokens } = await fullFlow(ctx);
    const gid = ctx.store.db.prepare('SELECT gid FROM grants').get().gid;
    const sessionBefore = ctx.store.getGrant(gid).session;
    const r1 = await tokenRequest(ctx.base, { grant_type: 'refresh_token', refresh_token: tokens.refresh_token, client_id: reg.client_id });
    assert.equal(r1.status, 200, r1.text);
    assert.notEqual(ctx.store.getGrant(gid).session, sessionBefore, 'session re-sealed under a new key');
    const wrapped = ctx.store.db.prepare('SELECT id, kind FROM creds WHERE gid = ? AND wrap IS NOT NULL').all(gid);
    assert.deepEqual(wrapped.map((w) => w.kind).sort(), ['access', 'refresh'], 'only the new pair holds a wrap');
    assert.ok(wrapped.every((w) => r1.data.access_token.includes(w.id) || r1.data.refresh_token.includes(w.id)));
    assert.equal((await rpc(ctx.base, tokens.access_token, 'tools/list')).status, 401, 'old access token is dead');
    const call = await rpc(ctx.base, r1.data.access_token, 'tools/call', { name: 'account_info', arguments: {} });
    assert.equal(call.data.result.structuredContent.id, 'samsung-user-1', 'session readable with the new key');

    // Using an expired access token drops its wrap immediately (not only at the next sweep).
    ctx.clock.offset = 3601_000;
    assert.equal((await rpc(ctx.base, r1.data.access_token, 'tools/list')).status, 401);
    const id = r1.data.access_token.slice(5, 27);
    assert.equal(ctx.store.getCred(id).wrap, null);
  } finally {
    await ctx.close();
  }
});

test('L6: a failed Samsung renewal logs a neutral event without the upstream message', { skip }, async () => {
  const ctx = await setup();
  try {
    const { tokens } = await fullFlow(ctx);
    const original = ctx.samsung.transport.call;
    ctx.samsung.transport.call = async (method, payload, opts) => {
      if (method.endsWith('IssueAuthCode')) throw new Error('upstream-detail-xyz');
      return original(method, payload, opts);
    };
    const write = process.stderr.write;
    const stderr = [];
    process.stderr.write = (m) => (stderr.push(String(m)), true);
    try {
      const call = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'account_info', arguments: {} });
      assert.equal(call.data.result.structuredContent.id, 'samsung-user-1');
    } finally {
      process.stderr.write = write;
    }
    assert.ok(ctx.logs.includes('samsung session renewal failed for a grant'));
    assert.ok(![...ctx.logs, ...stderr].join('\n').includes('upstream-detail-xyz'));
  } finally {
    await ctx.close();
  }
});

test('L7: a read-only grant can only disconnect itself', { skip }, async () => {
  const ctx = await setup();
  try {
    const { tokens } = await fullFlow(ctx, { readOnly: true });
    const list = await rpc(ctx.base, tokens.access_token, 'tools/list');
    const tool = list.data.result.tools.find((t) => t.name === 'connector_disconnect');
    assert.equal(tool.inputSchema.properties?.everything, undefined);
    const all = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'connector_disconnect', arguments: { everything: true } });
    assert.equal(all.data.result.isError, true);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 1, 'nothing deleted');
    const own = await rpc(ctx.base, tokens.access_token, 'tools/call', { name: 'connector_disconnect', arguments: {} });
    assert.equal(own.data.result.structuredContent.deletedEverything, false);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM grants').get().n, 0);
    assert.equal(ctx.store.db.prepare('SELECT COUNT(*) AS n FROM users').get().n, 1, 'registration kept');
  } finally {
    await ctx.close();
  }
});
