import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { GrpcWebTransport, GrpcError, TransportError, encodeFrame, isRetryable } from '../src/core/grpc.js';
import { SamsungFood, isReadMethod, looksLikeDrift, SchemaDriftError } from '../src/core/client.js';
import { Codec } from '../src/core/proto.js';

/* ---- helpers */

const trailer = (status, message = '') => {
  const body = Buffer.from(`grpc-status: ${status}\r\ngrpc-message: ${message}\r\n`, 'latin1');
  const h = Buffer.alloc(5);
  h.writeUInt8(0x80, 0);
  h.writeUInt32BE(body.length, 1);
  return Buffer.concat([h, body]);
};
const okResponse = (payload = Buffer.alloc(0)) =>
  new Response(Buffer.concat([encodeFrame(payload), trailer(0)]), { status: 200 });
const grpcFail = (code, msg = 'x') => new Response(trailer(code, msg), { status: 200 });
const http = (status) => new Response('', { status, statusText: 'err' });
const connectError = (code) => Object.assign(new TypeError('fetch failed'), { cause: { code, message: code } });

function transportWith(responses, extra = {}) {
  const calls = [];
  const sleeps = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return next;
  };
  const t = new GrpcWebTransport({
    fetchImpl,
    sleep: async (ms) => void sleeps.push(ms),
    random: () => 0.5,
    ...extra,
  });
  return { t, calls, sleeps };
}

/* ---- retry policy */

test('reads retry on 503, network errors and UNAVAILABLE, with growing backoff', async () => {
  const { t, calls, sleeps } = transportWith([http(503), connectError('ECONNRESET'), grpcFail(14), okResponse()]);
  await t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true });
  assert.equal(calls.length, 4);
  assert.equal(sleeps.length, 3);
  assert.ok(sleeps[0] < sleeps[1] && sleeps[1] < sleeps[2], `backoff grows: ${sleeps}`);
});

test('gives up after maxRetries and surfaces the last error', async () => {
  const { t, calls } = transportWith([http(503), http(503), http(503), http(503), http(503)], { maxRetries: 2 });
  await assert.rejects(t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }), /HTTP 503/);
  assert.equal(calls.length, 3);
});

test('writes are NOT retried once the server may have received them', async () => {
  for (const failure of [http(503), http(500), grpcFail(14), grpcFail(4), grpcFail(10), connectError('ECONNRESET')]) {
    const { t, calls } = transportWith([failure, okResponse()]);
    await assert.rejects(t.call('x.y.v1.A/DeleteThing', Buffer.alloc(0), { read: false }));
    assert.equal(calls.length, 1);
  }
});

test('writes ARE retried when the request provably never reached the server', async () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN']) {
    const { t, calls } = transportWith([connectError(code), okResponse()]);
    await t.call('x.y.v1.A/DeleteThing', Buffer.alloc(0), { read: false });
    assert.equal(calls.length, 2, code);
  }
});

test('writes are retried on rate limiting (429 / RESOURCE_EXHAUSTED)', async () => {
  const { t, calls } = transportWith([http(429), grpcFail(8), okResponse()]);
  await t.call('x.y.v1.A/AddThing', Buffer.alloc(0), { read: false });
  assert.equal(calls.length, 3);
});

test('non-transient errors are never retried', async () => {
  for (const failure of [grpcFail(5, 'ERROR_NOT_FOUND'), grpcFail(3), grpcFail(16), http(404), http(400)]) {
    const { t, calls } = transportWith([failure, okResponse()]);
    await assert.rejects(t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }));
    assert.equal(calls.length, 1);
  }
});

test('Retry-After is honoured', async () => {
  const limited = new Response('', { status: 429, headers: { 'retry-after': '3' } });
  const { t, sleeps } = transportWith([limited, okResponse()]);
  await t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true });
  assert.ok(sleeps[0] >= 3000);
});

test('a hanging request times out (read: retried, write: not)', async () => {
  const hang = (url, init) =>
    new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
  let n = 0;
  const t = new GrpcWebTransport({ fetchImpl: (...a) => (n++, hang(...a)), timeoutMs: 20, maxRetries: 1, sleep: async () => {} });
  await assert.rejects(t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }), /timed out/);
  assert.equal(n, 2);
  n = 0;
  await assert.rejects(t.call('x.y.v1.A/DeleteThing', Buffer.alloc(0), { read: false }), (e) => e instanceof TransportError && e.timeout);
  assert.equal(n, 1);
});

test('isRetryable is conservative for unknown errors', () => {
  assert.equal(isRetryable(new Error('boom'), { read: true }), false);
});

test('read/write inference from method names', () => {
  for (const m of ['a.B/GetLists', 'a.B/SearchProducts', 'a.B/Autocomplete', 'a.B/AnalyzeItems', 'a.B/ExtractRecipe']) assert.equal(isReadMethod(m), true, m);
  for (const m of ['a.B/SyncItems', 'a.B/DeleteList', 'a.B/GenerateListLinks', 'a.B/CreateList']) assert.equal(isReadMethod(m), false, m);
});

/* ---- schema drift */

const mini = (extra = {}) => ({
  rpcs: { 'p.v1.A/GetThing': { request: [{ n: 1, name: 'id', type: 'string' }], response: [{ n: 1, name: 'name', type: 'string' }], ...extra } },
  messages: {},
});
const encodeName = (schema, name) => new Codec(schema).encodeMessage(schema.rpcs['p.v1.A/GetThing'].response, { name });

test('drift: unknown method triggers one schema refresh and a retry', async () => {
  const fresh = mini();
  const old = { rpcs: {}, messages: {} };
  let built = 0;
  const sf = new SamsungFood({
    schema: old,
    token: 'fake',
    transport: { call: async () => encodeName(fresh, 'ok') },
    buildSchema: async () => (built++, fresh),
  });
  const res = await sf.call('p.v1.A/GetThing', { id: '1' });
  assert.equal(res.name, 'ok');
  assert.equal(built, 1);
});

test('drift: refresh that changes nothing does not retry the request', async () => {
  const same = mini();
  let calls = 0;
  const sf = new SamsungFood({
    schema: same,
    token: 'fake',
    transport: { call: async () => (calls++, Buffer.from([0xff, 0xff, 0xff])) },
    buildSchema: async () => structuredClone(same),
  });
  await assert.rejects(sf.call('p.v1.A/GetThing', { id: '1' }), /decode/i);
  assert.equal(calls, 1);
});

test('drift: failed refresh falls back to the cached schema and surfaces the original error', async () => {
  const sf = new SamsungFood({
    schema: { rpcs: {}, messages: {} },
    token: 'fake',
    transport: { call: async () => Buffer.alloc(0) },
    buildSchema: async () => {
      throw new Error('offline');
    },
  });
  await assert.rejects(sf.call('p.v1.A/GetThing', {}), /unknown method/);
});

test('drift: INVALID_ARGUMENT mentioning fields refreshes; a write whose response failed to decode is not resent', () => {
  assert.equal(looksLikeDrift(new GrpcError(3, 'ERROR_INVALID_ARGUMENTS: field x', 'm'), false), true);
  assert.equal(looksLikeDrift(new GrpcError(5, 'ERROR_NOT_FOUND', 'm'), true), false);
  assert.equal(looksLikeDrift(new SchemaDriftError('d', { sent: true }), false), false);
  assert.equal(looksLikeDrift(new SchemaDriftError('d', { sent: true }), true), true);
});

test('auth errors become the login hint', async () => {
  const sf = new SamsungFood({
    schema: mini(),
    token: 'fake',
    transport: { call: async () => { throw new GrpcError(16, 'ERROR_AUTH_TOKEN_NOT_FOUND', 'm'); } },
  });
  await assert.rejects(sf.call('p.v1.A/GetThing', { id: '1' }), /Run `sf login`/);
});

/* ---- codec strictness */

test('codec rejects unknown field names instead of dropping them', () => {
  const c = new Codec(mini());
  assert.throws(() => c.encodeRequest('p.v1.A/GetThing', { idd: '1' }), /Unknown field.*idd/);
  assert.doesNotThrow(() => c.encodeRequest('p.v1.A/GetThing', { id: '1' }));
});

test('codec round-trips scalars, repeated, nested and negative numbers', () => {
  const schema = {
    rpcs: {},
    messages: { 'm:Inner': [{ n: 1, name: 'v', type: 'int32' }] },
  };
  const fields = [
    { n: 1, name: 's', type: 'string' },
    { n: 2, name: 'tags', type: 'string', repeated: true },
    { n: 3, name: 'inner', type: 'message', ref: 'm:Inner' },
    { n: 4, name: 'n', type: 'int64' },
    { n: 5, name: 'ok', type: 'bool' },
    { n: 6, name: 'd', type: 'double' },
  ];
  const c = new Codec(schema);
  const obj = { s: 'héllo', tags: ['a', 'b'], inner: { v: -5 }, n: 123456789, ok: true, d: 1.5 };
  assert.deepEqual(c.decodeMessage(fields, c.encodeMessage(fields, obj)), obj);
});

/* ---- schema cache: staleness, background refresh, atomic writes */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ensureSchema, readSchema } from '../src/core/schema-build.js';
import { writeFileAtomic } from '../src/core/fsutil.js';

const staleSchemaFile = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-schema-'));
  const file = path.join(dir, 'schema.json');
  fs.writeFileSync(file, JSON.stringify({ rpcs: { 'a.B/GetX': { request: [], response: [] } }, messages: {}, meta: { builtAt: '2020-01-01T00:00:00.000Z' } }));
  return { dir, file };
};
const hangingFetch = (url, init) =>
  new Promise((_, reject) => init?.signal?.addEventListener('abort', () => reject(new Error('aborted'))));

test('a stale schema is served immediately in background mode even if the refresh hangs', async () => {
  const { dir, file } = staleSchemaFile();
  const logs = [];
  const started = Date.now();
  const schema = await ensureSchema({ file, background: true, fetchImpl: hangingFetch, log: (m) => logs.push(m) });
  assert.ok(Date.now() - started < 500);
  assert.ok(schema.rpcs['a.B/GetX']);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a failing refresh falls back to the stale cache', async () => {
  const { dir, file } = staleSchemaFile();
  const logs = [];
  const schema = await ensureSchema({ file, fetchImpl: async () => { throw new Error('offline'); }, log: (m) => logs.push(m) });
  assert.ok(schema.rpcs['a.B/GetX']);
  assert.match(logs.join(), /using the cached copy/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a fresh schema is used without any network access', async () => {
  const { dir, file } = staleSchemaFile();
  const fresh = JSON.parse(fs.readFileSync(file, 'utf8'));
  fresh.meta.builtAt = new Date().toISOString();
  fs.writeFileSync(file, JSON.stringify(fresh));
  const schema = await ensureSchema({ file, fetchImpl: async () => { throw new Error('must not be called'); } });
  assert.ok(schema.rpcs['a.B/GetX']);
  assert.ok(readSchema(file));
  fs.rmSync(dir, { recursive: true, force: true });
});

test('writeFileAtomic leaves no temp files and replaces the content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-atomic-'));
  const file = path.join(dir, 'x.json');
  writeFileAtomic(file, '{"a":1}');
  writeFileAtomic(file, '{"a":2}');
  assert.equal(fs.readFileSync(file, 'utf8'), '{"a":2}');
  assert.deepEqual(fs.readdirSync(dir), ['x.json']);
  // POSIX permissions do not exist on Windows
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  fs.rmSync(dir, { recursive: true, force: true });
});

/* ---- response framing and Retry-After */

import { decodeFrames, parseRetryAfter } from '../src/core/grpc.js';

test('responses without a trailer, or with truncated frames, are errors (reads retry them)', async () => {
  const noTrailer = () => new Response(encodeFrame(Buffer.from([1, 2, 3])), { status: 200 });
  const truncated = () => new Response(Buffer.concat([encodeFrame(Buffer.from([1, 2, 3])).subarray(0, 6)]), { status: 200 });
  for (const make of [noTrailer, truncated]) {
    const { t, calls } = transportWith([make(), make()], { maxRetries: 1 });
    await assert.rejects(t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }), /Incomplete response/);
    assert.equal(calls.length, 2);
    const w = transportWith([make(), okResponse()]);
    await assert.rejects(w.t.call('x.y.v1.A/DeleteThing', Buffer.alloc(0), { read: false }), /Incomplete response/);
    assert.equal(w.calls.length, 1, 'a write is not repeated');
  }
});

test('a grpc-status in the HTTP headers counts as a trailer', async () => {
  const res = new Response(encodeFrame(Buffer.from([7])), { status: 200, headers: { 'grpc-status': '0' } });
  const { t } = transportWith([res]);
  assert.deepEqual([...(await t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }))], [7]);
});

test('decodeFrames rejects garbage', () => {
  assert.throws(() => decodeFrames(Buffer.from([0, 0, 0, 0, 9, 1])), /truncated/);
  assert.throws(() => decodeFrames(Buffer.from([0, 0, 0])), /trailing/);
});

test('Retry-After accepts seconds and HTTP dates', () => {
  assert.equal(parseRetryAfter('3'), 3000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:05 GMT', Date.parse('Wed, 21 Oct 2026 07:28:00 GMT')), 5000);
  assert.equal(parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT', Date.parse('Thu, 22 Oct 2026 07:28:00 GMT')), 0);
  assert.equal(parseRetryAfter('garbage'), 0);
  assert.equal(parseRetryAfter(null), 0);
});

/* ---- HTTP auth statuses, malformed grpc-message, write decode failures */

test('HTTP 401/403 map to UNAUTHENTICATED/PERMISSION_DENIED; 401 becomes the login hint', async () => {
  const { t } = transportWith([http(401)]);
  const e401 = await t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }).catch((e) => e);
  assert.equal(e401.status, 16);
  assert.equal(e401.statusName, 'UNAUTHENTICATED');
  const { t: t2 } = transportWith([http(403)]);
  const e403 = await t2.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true }).catch((e) => e);
  assert.equal(e403.status, 7);

  const { t: t3 } = transportWith([http(401)]);
  const sf = new SamsungFood({ schema: mini(), token: 'fake', transport: t3 });
  await assert.rejects(sf.call('p.v1.A/GetThing', { id: '1' }), /Run `sf login`.*getting-started/);
});

test('a grpc-message with a bare % does not throw a URIError', async () => {
  const { t } = transportWith([grpcFail(3, '100% wrong%2')]);
  const err = await t.call('x.y.v1.A/AddThing', Buffer.alloc(0), { read: false }).catch((e) => e);
  assert.ok(err instanceof GrpcError, String(err));
  assert.match(err.message, /100% wrong%2/);
});

test('a write whose response cannot be decoded warns that it was probably applied', async () => {
  const schema = {
    rpcs: { 'p.v1.A/AddThing': { request: [], response: [{ n: 1, name: 'name', type: 'string' }] } },
    messages: {},
  };
  // field 1 (LEN) claims 20 bytes, only 1 follows
  const sf = new SamsungFood({ schema, token: 'fake', transport: { call: async () => Buffer.from([0x0a, 20, 0x61]) } });
  sf._lastSchemaRefresh = Date.now(); // no refresh attempt
  await assert.rejects(sf.call('p.v1.A/AddThing', {}), /probably applied; check the current state before retrying/);
  const read = new SamsungFood({ schema: mini(), token: 'fake', transport: { call: async () => Buffer.from([0x0a, 20, 0x61]) } });
  read._lastSchemaRefresh = Date.now();
  await assert.rejects(read.call('p.v1.A/GetThing', {}), (e) => e instanceof SchemaDriftError && !/probably applied/.test(e.message));
});
