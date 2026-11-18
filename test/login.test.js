import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createHandover, HandoverError } from '../src/login/handover.js';
import { bookmarklet, loginPage } from '../src/login/page.js';
import { startLocalLogin } from '../src/login/local.js';
import { browserLogin } from '../src/login/setup.js';
import { SamsungFood } from '../src/client.js';
import { clearToken, AUTH_FILE } from '../src/auth.js';
import { client, fakeSamsung, pageConfig, testSchema, TOKEN_A } from './hosted-helpers.js';

const TOKEN = 'T'.repeat(48);

test('handover: nonce is single use, expires and is bound to the browser', async () => {
  let t = 1_000_000;
  const seen = [];
  const h = createHandover({ now: () => t, verify: async (token) => (seen.push(token), { account: 'Anna' }) });
  const a = h.begin();
  await assert.rejects(h.submit(a.nonce, 'wrong-cookie', TOKEN), (e) => e instanceof HandoverError && e.code === 'browser');
  await assert.rejects(h.submit('unknown', a.cookie, TOKEN), (e) => e.code === 'unknown');
  await assert.rejects(h.submit(a.nonce, a.cookie, 'no token here'), (e) => e.code === 'no_token');
  assert.deepEqual(await h.submit(a.nonce, a.cookie, `foo=1; whisk.USER_TOKEN=${TOKEN}; bar=2`), { account: 'Anna' });
  assert.deepEqual(seen, [TOKEN]);
  await assert.rejects(h.submit(a.nonce, a.cookie, TOKEN), (e) => e.code === 'used');
  assert.equal(h.status(a.nonce, a.cookie).status, 'verified');
  h.take(a.nonce, a.cookie);
  assert.throws(() => h.take(a.nonce, a.cookie), (e) => e.code === 'unknown');

  const b = h.begin();
  t += 10 * 60 * 1000 + 1;
  await assert.rejects(h.submit(b.nonce, b.cookie, TOKEN), (e) => e.code === 'expired');
});

test('handover: a rejected session can be retried a few times, then the login is dead', async () => {
  const h = createHandover({ verify: async () => { throw new Error('Samsung said no'); }, maxAttempts: 2 });
  const a = h.begin();
  await assert.rejects(h.submit(a.nonce, a.cookie, TOKEN), (e) => e.code === 'rejected' && /Samsung said no/.test(e.message));
  await assert.rejects(h.submit(a.nonce, a.cookie, TOKEN), (e) => e.code === 'rejected');
  assert.equal(h.status(a.nonce, a.cookie).status, 'failed');
  await assert.rejects(h.submit(a.nonce, a.cookie, TOKEN), (e) => e.code === 'used');
});

/** Runs the bookmarklet in a sandbox with a fake page. */
function runBookmarklet(href, { hostname, cookie }) {
  const calls = { alert: [], confirm: [], href: null };
  const location = {
    hostname,
    set href(v) {
      calls.href = v;
    },
  };
  vm.runInNewContext(decodeURI(href.slice('javascript:'.length)), {
    location,
    document: { cookie },
    alert: (m) => calls.alert.push(m),
    confirm: (m) => (calls.confirm.push(m), false),
    encodeURIComponent,
  });
  return calls;
}

test('bookmarklet: sends only the session cookie, in the URL fragment; refuses other sites', () => {
  const href = bookmarklet('https://food-mcp.example/login/landing', 'nonce123');
  assert.match(href, /^javascript:/);

  const ok = runBookmarklet(href, { hostname: 'app.samsungfood.com', cookie: `_ga=GA1.2; whisk.USER_TOKEN=${TOKEN}; other=x` });
  const target = new URL(ok.href);
  assert.equal(target.origin + target.pathname, 'https://food-mcp.example/login/landing');
  assert.equal(target.search, '', 'nothing in the query string (would reach the server logs)');
  const frag = new URLSearchParams(target.hash.slice(1));
  assert.equal(frag.get('n'), 'nonce123');
  assert.equal(frag.get('c'), `whisk.USER_TOKEN=${TOKEN}`, 'only the session cookie');

  const wrongSite = runBookmarklet(href, { hostname: 'example.com', cookie: `whisk.USER_TOKEN=${TOKEN}` });
  assert.equal(wrongSite.href, null);
  assert.match(wrongSite.confirm[0], /only works on Samsung Food \(app\.samsungfood\.com\).*example\.com/);

  const loggedOut = runBookmarklet(href, { hostname: 'app.samsungfood.com', cookie: '_ga=1' });
  assert.equal(loggedOut.href, null);
  assert.match(loggedOut.alert[0], /not logged in/);
});

test('login page: the page script clears the fragment and posts it; no inline handlers', () => {
  const html = loginPage({ mode: 'local', nonce: 'n1', landingUrl: 'http://127.0.0.1:1/login/landing', endpoints: { handover: '/login/handover', status: '/login/status' }, scriptNonce: 'abc' });
  assert.match(html, /history\.replaceState\(null,'',location\.pathname\)/);
  assert.doesNotMatch(html, /\son(click|load|submit)=/i);
  assert.equal(pageConfig(html).nonce, 'n1');
  assert.match(html, /never in a chat/);
});

async function localLogin(opts = {}) {
  const verified = [];
  const login = await startLocalLogin({
    closeDelayMs: 50,
    verify: async (token) => {
      verified.push(token);
      if (token !== TOKEN) throw new Error('That token was rejected by Samsung Food.');
      return { account: 'Anna Test' };
    },
    ...opts,
  });
  return { login, verified };
}

test('sf login (local page): bookmarklet handover completes the login and the CLI promise', async () => {
  const { login, verified } = await localLogin();
  const browser = client(login.url);
  const page = await browser.request('GET', login.url);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /default-src 'none'/);
  const cfg = pageConfig(page.text);
  // The landing page itself carries no secret and gets none in its URL.
  const landing = await browser.request('GET', '/login/landing');
  assert.equal(landing.status, 200);
  assert.doesNotMatch(landing.text, new RegExp(cfg.nonce));
  // Wrong token first (GetMe fails), then the right one.
  const bad = await browser.request('POST', '/login/handover', { json: { n: cfg.nonce, c: 'whisk.USER_TOKEN=' + 'X'.repeat(48) } });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error.message, /rejected/);
  const ok = await browser.request('POST', '/login/handover', { json: { n: cfg.nonce, c: `whisk.USER_TOKEN=${TOKEN}` } });
  assert.equal(ok.data.account, 'Anna Test');
  assert.deepEqual(await login.result, { account: 'Anna Test', public: { account: 'Anna Test' } });
  assert.equal(verified.at(-1), TOKEN);
});

test('sf login (local page): DNS rebinding, cross-origin and foreign-browser requests are refused', async () => {
  const { login } = await localLogin();
  try {
    const browser = client(login.url);
    const page = await browser.request('GET', login.url);
    const { nonce } = pageConfig(page.text);
    assert.equal((await browser.request('GET', '/', { headers: { host: `evil.example:${login.port}` } })).status, 421);
    assert.equal((await browser.request('POST', '/login/handover', { json: { n: nonce, c: TOKEN }, headers: { origin: 'https://app.samsungfood.com' } })).status, 403);
    assert.equal((await client(login.url).request('POST', '/login/handover', { json: { n: nonce, c: TOKEN } })).data.error.code, 'browser');
  } finally {
    login.close();
    await assert.rejects(login.result, /cancelled/);
  }
});

test('sf login (local page): gives up after the timeout', async () => {
  const { login } = await localLogin({ timeoutMs: 100 });
  await assert.rejects(login.result, /No login within .*sf login --paste/);
});

test('browserLogin stores the session verified with GetMe; logout removes it', async () => {
  const schema = testSchema();
  const samsung = fakeSamsung(schema);
  const sf = new SamsungFood({ schema, transport: samsung.transport });
  const logs = [];
  const res = await browserLogin({
    open: false,
    log: (m) => logs.push(m),
    client: sf,
    // Drive the page like a browser would, as soon as the server is up.
    start: async (opts) => {
      const login = await startLocalLogin({ ...opts, closeDelayMs: 10 });
      const browser = client(login.url);
      const { nonce } = pageConfig((await browser.request('GET', login.url)).text);
      await browser.request('POST', '/login/handover', { json: { n: nonce, c: `whisk.USER_TOKEN=${TOKEN_A}` } });
      return login;
    },
  });
  assert.equal(res.account, 'Anna Test');
  assert.match(logs[0], /Open this page in your browser: http:\/\/127\.0\.0\.1:\d+\//);
  const stored = JSON.parse(fs.readFileSync(path.join(tmpHome, 'auth.json'), 'utf8'));
  assert.equal(stored.userId, 'samsung-user-1');
  assert.ok(stored.accessToken);
  clearToken();
  assert.equal(fs.existsSync(AUTH_FILE), false, 'logout deletes the whole session file');
});

test('sf login (local page): without the secret from the CLI no other local process can start or finish the login', async () => {
  const { login } = await localLogin();
  try {
    const u = new URL(login.url);
    assert.match(u.searchParams.get('k'), /^[A-Za-z0-9_-]{43}$/);
    const intruder = client(login.url);
    assert.equal((await intruder.request('GET', '/')).status, 403, 'no secret');
    assert.equal((await intruder.request('GET', '/?k=wrong')).status, 403, 'wrong secret');
    assert.equal((await intruder.request('GET', `/?k=${u.searchParams.get('k').slice(0, -1)}A`)).status, 403);
    assert.equal(intruder.jar.size, 0, 'no pending login (cookie) was created');
    const owner = client(login.url);
    const page = await owner.request('GET', login.url);
    assert.equal(page.status, 200);
    assert.ok(pageConfig(page.text).nonce);
  } finally {
    login.close();
    await assert.rejects(login.result, /cancelled/);
  }
});

test('handover: pending logins are capped per owner and a full pool drops the oldest unverified one', async () => {
  const h = createHandover({ verify: async () => ({ account: 'Anna' }), maxPending: 3, maxPerOwner: 2 });
  const a1 = h.begin({}, { owner: 'net-a' });
  const a2 = h.begin({}, { owner: 'net-a' });
  const a3 = h.begin({}, { owner: 'net-a' });
  assert.throws(() => h.status(a1.nonce, a1.cookie), (e) => e.code === 'unknown', 'own oldest replaced');
  assert.equal(h.status(a2.nonce, a2.cookie).status, 'pending');
  assert.equal(h.size, 2);
  // Verified logins are never dropped to make room.
  await h.submit(a2.nonce, a2.cookie, TOKEN);
  const b1 = h.begin({}, { owner: 'net-b' });
  const c1 = h.begin({}, { owner: 'net-c' });
  assert.equal(h.size, 3);
  assert.throws(() => h.status(a3.nonce, a3.cookie), (e) => e.code === 'unknown', 'oldest unverified dropped');
  assert.equal(h.status(a2.nonce, a2.cookie).status, 'verified');
  assert.equal(h.status(b1.nonce, b1.cookie).status, 'pending');
  assert.equal(h.status(c1.nonce, c1.cookie).status, 'pending');
  // A pool full of verified logins refuses instead of evicting them.
  const full = createHandover({ verify: async () => ({ account: 'Anna' }), maxPending: 1 });
  const v = full.begin();
  await full.submit(v.nonce, v.cookie, TOKEN);
  assert.throws(() => full.begin(), (e) => e instanceof HandoverError && e.status === 503);
});
