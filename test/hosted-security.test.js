/**
 * Regression tests for the security review of the hosted connector (offline, unit level): CIMD
 * fetch limits, SSRF ranges, rate-limit keys and bounds, fairness toward Samsung Food, client
 * eviction, wrap hygiene, file modes and the secure defaults.
 */

import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSqlite, openStore } from '../src/hosted/store.js';
import { isPublicAddress, safeFetch } from '../src/hosted/fetch.js';
import { BusyError, fairTransports, ipKey, rateLimiter, semaphore } from '../src/hosted/limits.js';
import { cimdResolver, checkRedirectUri, cleanName, OAuthError } from '../src/hosted/oauth.js';
import { KNOWN_CIMD_HOSTS, KNOWN_REDIRECT_HOSTS, loadConfig } from '../src/hosted/config.js';
import { SamsungFood } from '../src/client.js';
import { memoryTokenStore } from '../src/auth.js';
import { GrpcError } from '../src/grpc.js';
import { testSchema, tmpDir } from './hosted-helpers.js';

const skip = loadSqlite() ? false : 'node:sqlite is not available on this Node.js version (needs 22.13+)';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const MASTER_HEX = Buffer.alloc(32, 7).toString('hex');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ------------------------------------------------------------------ H1 */

test('H1: secure defaults for redirect and CIMD hosts; "*" is an explicit opt-in', () => {
  const base = { SF_HOST_PUBLIC_URL: 'https://a.example', SF_HOST_MASTER_KEY: MASTER_HEX };
  const c = loadConfig(base);
  assert.deepEqual(c.redirectHosts, KNOWN_REDIRECT_HOSTS);
  assert.deepEqual(c.cimdHosts, KNOWN_CIMD_HOSTS);
  for (const h of ['chatgpt.com', 'claude.ai', 'claude.com']) assert.ok(c.redirectHosts.includes(h), h);
  assert.deepEqual(loadConfig({ ...base, SF_HOST_REDIRECT_HOSTS: '*' }).redirectHosts, ['*']);
  assert.deepEqual(loadConfig({ ...base, SF_HOST_REDIRECT_HOSTS: '' }).redirectHosts, []);

  const allow = c.redirectHosts;
  assert.equal(checkRedirectUri('https://claude.ai/api/mcp/auth_callback', { allowHosts: allow }), 'https://claude.ai/api/mcp/auth_callback');
  assert.throws(() => checkRedirectUri('https://evil.example/cb', { allowHosts: allow }), /not allowed/);
  // Loopback (Claude Code, desktop clients) is always allowed, even with an empty list.
  assert.ok(checkRedirectUri('http://127.0.0.1/callback', { allowHosts: [] }));
  assert.ok(checkRedirectUri('http://localhost/callback', { allowHosts: [] }));
  assert.throws(() => checkRedirectUri('https://claude.ai/cb', { allowHosts: [] }), /not allowed/);
  assert.ok(checkRedirectUri('https://evil.example/cb', { allowHosts: ['*'] }), 'open mode');
});

test('H1/L4: CIMD documents are held to the redirect host allowlist; names lose control and format characters', async () => {
  const id = 'https://chatgpt.com/oauth/abc/client.json';
  const doc = (redirect, name = 'ChatGPT') => ({ ok: true, status: 200, text: async () => JSON.stringify({ client_id: id, client_name: name, redirect_uris: [redirect] }) });
  const evil = cimdResolver({ hosts: ['chatgpt.com'], redirectHosts: KNOWN_REDIRECT_HOSTS, fetchImpl: async () => doc('https://evil.example/cb') });
  await assert.rejects(evil(id), (e) => e instanceof OAuthError && /not allowed/.test(e.message));
  const ok = cimdResolver({ hosts: ['chatgpt.com'], redirectHosts: KNOWN_REDIRECT_HOSTS, fetchImpl: async () => doc('https://chatgpt.com/cb', 'Chat‮GPT​\u0007') });
  const client = await ok(id);
  assert.equal(client.metadata.client_name, 'ChatGPT');
  assert.equal(cleanName('A⁦b­c\u0000'), 'Abc');
});

/* ------------------------------------------------------------------ M1 */

/** A request function that answers 200 and then drips one byte every 20 ms, forever. */
function drippingRequest() {
  const state = { destroyed: null };
  const request = (_u, _o, cb) => {
    const req = new EventEmitter();
    const res = new EventEmitter();
    res.statusCode = 200;
    const timer = setInterval(() => res.emit('data', Buffer.from(' ')), 20);
    req.destroy = (err) => {
      clearInterval(timer);
      state.destroyed = err;
      req.emit('error', err);
    };
    setImmediate(() => cb(res));
    return req;
  };
  return { request, state };
}

test('M1: safeFetch has a total deadline (slow drip) and honours the abort signal', async () => {
  const slow = drippingRequest();
  const t0 = Date.now();
  await assert.rejects(safeFetch('https://example.com/client.json', { timeoutMs: 150, request: slow.request }), /timeout/);
  assert.ok(Date.now() - t0 < 1500, 'gave up at the deadline, not after an idle period');
  assert.match(slow.state.destroyed.message, /timeout/);

  const aborted = drippingRequest();
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(safeFetch('https://example.com/client.json', { timeoutMs: 10_000, signal: ac.signal, request: aborted.request }), /aborted/);
  assert.match(aborted.state.destroyed.message, /aborted/);
});

test('M1: CIMD fetches are de-duplicated per client_id, capped globally and failures are cached briefly', async () => {
  let t = 1_000_000;
  let active = 0;
  let peak = 0;
  const fetched = [];
  const gates = [];
  const fetchImpl = async (url) => {
    fetched.push(url);
    active++;
    peak = Math.max(peak, active);
    await new Promise((r) => gates.push(r));
    active--;
    if (url.includes('broken')) return { ok: false, status: 500, text: async () => '' };
    return { ok: true, status: 200, text: async () => JSON.stringify({ client_id: url, client_name: 'X', redirect_uris: ['https://claude.ai/cb'] }) };
  };
  const resolve = cimdResolver({ hosts: ['claude.ai'], redirectHosts: KNOWN_REDIRECT_HOSTS, fetchImpl, now: () => t, concurrency: 4, maxQueue: 3 });

  // Ten parallel lookups of one client_id: one fetch.
  const same = Array.from({ length: 10 }, () => resolve('https://claude.ai/oauth/one'));
  await tick();
  assert.equal(fetched.length, 1);
  gates.shift()();
  for (const c of await Promise.all(same)) assert.equal(c.client_id, 'https://claude.ai/oauth/one');

  // Many different ids: at most 4 in flight, 3 queued, the rest refused as busy.
  const ids = Array.from({ length: 9 }, (_, i) => `https://claude.ai/oauth/c${i}`);
  const many = ids.map((id) => resolve(id).then(() => 'ok', (e) => e.error));
  await tick();
  assert.equal(active, 4);
  while (gates.length || active) {
    gates.splice(0).forEach((g) => g());
    await tick(5);
  }
  const outcomes = await Promise.all(many);
  assert.equal(peak, 4);
  assert.equal(outcomes.filter((o) => o === 'ok').length, 7);
  assert.equal(outcomes.filter((o) => o === 'temporarily_unavailable').length, 2);

  // A failing document is not fetched again for a minute.
  const broken = 'https://claude.ai/oauth/broken';
  const first = resolve(broken);
  await tick();
  gates.shift()();
  await assert.rejects(first, /HTTP 500/);
  const n = fetched.length;
  await assert.rejects(resolve(broken), /HTTP 500/);
  assert.equal(fetched.length, n, 'negative cache hit');
  t += 61_000;
  const again = resolve(broken);
  await tick();
  assert.equal(fetched.length, n + 1, 'retried after the negative TTL');
  gates.shift()();
  await assert.rejects(again);
});

/* ------------------------------------------------------------------ M3 */

test('M3: rate-limit keys bucket IPv6 by /64 and unwrap IPv4-mapped addresses', () => {
  assert.equal(ipKey('2001:db8:1:2:3:4:5:6'), ipKey('2001:db8:1:2::9'));
  assert.equal(ipKey('2001:db8:1:2::9'), '2001:db8:1:2::/64');
  assert.notEqual(ipKey('2001:db8:1:2::9'), ipKey('2001:db8:1:3::9'));
  assert.equal(ipKey('::ffff:203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('::ffff:cb00:7107'), '203.0.113.7');
  assert.equal(ipKey('203.0.113.7'), '203.0.113.7');
  assert.equal(ipKey('fe80::1%en0'), 'fe80:0:0:0::/64');
});

test('M3: a full rate limiter evicts the oldest windows instead of resetting everybody', () => {
  const t = 0;
  const lim = rateLimiter({ limit: 1, windowMs: 60_000, now: () => t, maxKeys: 3 });
  for (const k of ['a', 'b', 'c']) assert.equal(lim.hit(k), 0);
  for (const k of ['a', 'b', 'c']) assert.ok(lim.hit(k) > 0, `${k} limited`);
  assert.equal(lim.hit('d'), 0);
  assert.equal(lim.size, 3);
  assert.ok(lim.hit('b') > 0, 'b is still limited (no fail-open)');
  assert.ok(lim.hit('c') > 0);
  assert.equal(lim.hit('a'), 0, 'only the oldest window was dropped');
});

test('M3: clients that never led to a connection are evicted first and swept after a day', { skip }, () => {
  let t = 1_000_000;
  const store = openStore(':memory:', { now: () => t });
  try {
    store.putClient('c_old', null, { redirect_uris: [] });
    t += 10;
    store.putClient('c_used', null, { redirect_uris: [] });
    t += 10;
    store.putClient('c_new', null, { redirect_uris: [] });
    store.touchClient('c_used');
    assert.equal(store.evictUnusedClient(), true);
    assert.equal(store.getClient('c_old'), null, 'oldest never-used client evicted');
    assert.ok(store.getClient('c_used'));
    assert.equal(store.evictUnusedClient(), true);
    assert.equal(store.evictUnusedClient(), false, 'a used client is not evicted');

    store.putClient('c_idle', null, { redirect_uris: [] });
    t += 25 * 3600_000;
    const r = store.sweep({ inactivityMs: 30 * 86400000 });
    assert.equal(r.clients, 1);
    assert.equal(store.getClient('c_idle'), null, 'never-used client gone after ~24 h');
    assert.ok(store.getClient('c_used'), 'used client kept for the 7-day idle window');
  } finally {
    store.close();
  }
});

/* ------------------------------------------------------------------ fairness */

test('upstream: bounded global queue and at most 2 calls per user', async () => {
  const sem1 = semaphore(1, { maxQueue: 1 });
  let release;
  const blocker = sem1.run(() => new Promise((r) => (release = r)));
  const queued = sem1.run(async () => 'queued');
  await assert.rejects(sem1.run(async () => 'x'), BusyError);
  release();
  await blocker;
  assert.equal(await queued, 'queued');

  const running = [];
  const raw = { call: (method) => new Promise((r) => running.push({ method, done: () => r(method) })) };
  const fair = fairTransports(raw, semaphore(4, { maxQueue: 10 }), { perUser: 2, perUserQueue: 1 });
  const a = fair.forUser('u1');
  const calls = [a.call('a1'), a.call('a2'), a.call('a3')];
  await assert.rejects(a.call('a4'), BusyError, 'per-user queue is bounded');
  const b = fair.forUser('u2').call('b1');
  await tick();
  assert.deepEqual(running.map((r) => r.method).sort(), ['a1', 'a2', 'b1'], 'u1 has 2 in flight, u2 is not starved');
  while (running.length) {
    running.shift().done();
    await tick();
  }
  assert.deepEqual(await Promise.all([...calls, b]), ['a1', 'a2', 'a3', 'b1']);
  assert.equal(fair.users, 0, 'idle per-user state is dropped');
});

/* ------------------------------------------------------------------ L2, L5 */

test('L2/L5: wraps of expired credentials are dropped; database, WAL and SHM files are mode 600', { skip }, () => {
  const dir = tmpDir();
  let t = 1_000_000;
  const store = openStore(dir, { now: () => t });
  try {
    store.putUser('u_1', null);
    store.putGrant({ gid: 'g_1', uid: 'u_1', clientId: 'c', scope: 'food', resource: 'r', readOnly: false, session: 'x' });
    store.putCred({ id: 'a1', kind: 'access', gid: 'g_1', verifier: 'v', wrap: 'w1', expiresAt: t + 1000 });
    store.putCred({ id: 'r1', kind: 'refresh', gid: 'g_1', verifier: 'v', wrap: 'w2', expiresAt: t + 86400000 });
    t += 2000;
    assert.equal(store.dropExpiredWraps(), 1);
    assert.equal(store.getCred('a1').wrap, null);
    assert.equal(store.getCred('r1').wrap, 'w2');
    for (const f of ['connector.db', 'connector.db-wal', 'connector.db-shm']) {
      const p = path.join(dir, f);
      if (fs.existsSync(p)) assert.equal(fs.statSync(p).mode & 0o777, 0o600, f);
    }
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
  const dockerfile = fs.readFileSync(path.join(ROOT, 'Dockerfile'), 'utf8');
  assert.match(dockerfile, /install -d -m 700 -o node -g node \/data/);
  assert.match(fs.readFileSync(path.join(ROOT, 'src/hosted/run.js'), 'utf8'), /process\.umask\(0o077\);\s*\n\s*const store = openStore/);
});

/* ------------------------------------------------------------------ L3 */

test('L3: SSRF filter covers IPv4-compatible, local NAT64, 6to4, Teredo and the 6to4 relay range', () => {
  for (const ip of ['::127.0.0.1', '::7f00:1', '::a00:1', '::', '::1', '64:ff9b:1::a00:1', '2002:7f00:1::1', '2002:808:808::1', '2001:0:4136:e378::1', '192.88.99.1', '64:ff9b::7f00:1', '64:ff9b::10.0.0.1']) {
    assert.equal(isPublicAddress(ip), false, ip);
  }
  for (const ip of ['8.8.8.8', '64:ff9b::8.8.8.8', '2606:4700::1111', '2a00:1450:4001::1']) assert.equal(isPublicAddress(ip), true, ip);
});

/* ------------------------------------------------------------------ L6 */

test('L6: the client passes a custom warn to the token renewal (no upstream message on stderr)', async () => {
  const schema = testSchema();
  const transport = {
    async call() {
      throw new GrpcError(14, 'UNAVAILABLE', 'upstream-detail-xyz');
    },
  };
  const warned = [];
  const sf = new SamsungFood({ schema, transport, tokenStore: memoryTokenStore({ accessToken: 'T'.repeat(48) }), warn: (m) => warned.push(m) });
  const write = process.stderr.write;
  const stderr = [];
  process.stderr.write = (m) => (stderr.push(String(m)), true);
  try {
    assert.equal(await sf.freshToken(), 'T'.repeat(48));
  } finally {
    process.stderr.write = write;
  }
  assert.equal(warned.length, 1);
  assert.ok(!stderr.join('').includes('upstream-detail-xyz'));
});
