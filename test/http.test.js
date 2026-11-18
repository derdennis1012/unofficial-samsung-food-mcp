import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createApiServer, checkBindHost, isLoopback, selectTools, parseCorsOrigin, mapError } from '../src/http/server.js';
import { loadOrCreateApiKey, keyMatches, bearerToken } from '../src/http/apikey.js';
import { toolArea } from '../src/http/openapi.js';
import { TOOLS } from '../src/tools/index.js';
import { defineTool } from '../src/tools/util.js';
import { GrpcError, TransportError } from '../src/grpc.js';
import { LOGIN_HINT } from '../src/auth.js';
import { z } from 'zod';

const KEY = 'sfk_test-key-test-key-test-key-0123456789';

/** Fake client: only what the tools used below call. Records calls so tests can assert "never called". */
function fakeHolder() {
  const calls = [];
  return {
    calls,
    get: async () => ({
      methods: (filter) => {
        calls.push(['methods', filter]);
        return ['whisk.x.list.v1.ListAPI/GetLists'];
      },
    }),
  };
}

const extraTools = [
  defineTool({ name: 'test_grpc_not_found', kind: 'read', description: 'test tool that fails upstream', handler: async () => { throw new GrpcError(5, 'ERROR_RECIPE_NOT_FOUND', 'm'); } }),
  defineTool({ name: 'test_login', kind: 'read', description: 'test tool without a login', handler: async () => { throw new Error(LOGIN_HINT); } }),
  defineTool({ name: 'test_transport', kind: 'read', description: 'test tool with a network error', handler: async () => { throw new TransportError('Network error', { reachedServer: false }); } }),
  defineTool({ name: 'test_crash', kind: 'read', description: 'test tool with a bug', handler: async () => { throw new TypeError('x is undefined'); } }),
  defineTool({ name: 'test_array', kind: 'read', description: 'test tool returning an array', schema: z.object({ n: z.number().int().max(5) }), handler: async (a) => Array.from({ length: a.n }, (_, i) => i) }),
  defineTool({ name: 'test_slow', kind: 'write', description: 'test tool that never finishes', handler: () => new Promise(() => {}) }),
];

async function start(opts = {}) {
  const holder = opts.holder ?? fakeHolder();
  const logs = [];
  const server = createApiServer({ apiKey: KEY, holder, tools: [...TOOLS, ...extraTools], version: '9.9.9', log: (l) => logs.push(l), ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { server, holder, logs, port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
}

/** Plain node:http request (fetch is disabled in the offline tests). */
function request(port, method, urlPath, { body, headers = {}, key = KEY } = {}) {
  return new Promise((resolve, reject) => {
    const h = { ...headers };
    if (key) h.authorization = `Bearer ${key}`;
    let payload;
    if (body !== undefined) {
      payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
      h['content-type'] ??= 'application/json';
      if (!headers.chunked) h['content-length'] = Buffer.byteLength(payload);
      delete h.chunked;
    }
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers: h }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json;
        try {
          json = JSON.parse(text);
        } catch {
          json = undefined;
        }
        resolve({ status: res.statusCode, headers: res.headers, text, json });
      });
    });
    req.on('error', reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
}

test('API key: created once with mode 600, reused, env override, constant-time compare', () => {
  const file = path.join(tmpHome, 'api-key-test');
  const first = loadOrCreateApiKey({ file, env: {} });
  assert.equal(first.created, true);
  assert.match(first.key, /^sfk_[\w-]{40,}$/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const again = loadOrCreateApiKey({ file, env: {} });
  assert.deepEqual([again.key, again.created], [first.key, false]);
  assert.deepEqual(loadOrCreateApiKey({ file, env: { SAMSUNG_FOOD_API_KEY: KEY } }), { key: KEY, source: 'env', created: false });
  assert.throws(() => loadOrCreateApiKey({ file, env: { SAMSUNG_FOOD_API_KEY: 'short' } }), /at least/);
  assert.ok(keyMatches(KEY, KEY));
  assert.ok(!keyMatches(`${KEY}x`, KEY));
  assert.ok(!keyMatches('', KEY));
  assert.ok(!keyMatches(undefined, KEY));
  assert.equal(bearerToken(`Bearer ${KEY}`), KEY);
  assert.equal(bearerToken(`Basic ${KEY}`), null);
});

test('auth: /healthz without key, everything else needs the right key', async () => {
  const s = await start();
  try {
    const h = await request(s.port, 'GET', '/healthz', { key: null });
    assert.equal(h.status, 200);
    assert.equal(h.json.ok, true);
    assert.equal(h.json.version, '9.9.9');
    assert.equal(s.holder.calls.length, 0, 'healthz must not touch the account');

    for (const [method, p] of [['GET', '/v1/tools'], ['GET', '/openapi.json'], ['POST', '/v1/tools/auth_status'], ['POST', '/mcp'], ['GET', '/nope']]) {
      const missing = await request(s.port, method, p, { key: null });
      assert.equal(missing.status, 401, `${method} ${p} without key`);
      assert.equal(missing.json.error.code, 'unauthorized');
      const wrong = await request(s.port, method, p, { key: 'sfk_wrong-wrong-wrong-wrong' });
      assert.equal(wrong.status, 401, `${method} ${p} wrong key`);
    }
    const right = await request(s.port, 'GET', '/v1/tools');
    assert.equal(right.status, 200);
    // Responses never echo the key; logs carry only method, path, status and duration.
    assert.ok(!s.logs.join('\n').includes(KEY));
    assert.ok(s.logs.some((l) => /^GET \/v1\/tools 200 \d+ms$/.test(l)));
    assert.equal(right.headers['cache-control'], 'no-store');
    assert.equal(right.headers['access-control-allow-origin'], undefined, 'no CORS by default');
  } finally {
    await s.close();
  }
});

test('/v1/tools lists tools with area, annotations and JSON schema; raw tool hidden by default', async () => {
  const s = await start();
  try {
    const { json } = await request(s.port, 'GET', '/v1/tools');
    const names = json.tools.map((t) => t.name);
    assert.ok(names.includes('meal_plan_get') && names.includes('shopping_list_add'));
    assert.ok(!names.includes('api_call'), 'api_call must be excluded without --allow-raw');
    const mp = json.tools.find((t) => t.name === 'meal_plan_get');
    assert.equal(mp.area, 'meal_plan');
    assert.equal(mp.annotations.readOnlyHint, true);
    assert.equal(mp.inputSchema.type, 'object');
    assert.equal(mp.inputSchema.additionalProperties, false);
    assert.ok(!('handler' in mp));
    const one = await request(s.port, 'GET', '/v1/tools/meal_plan_get');
    assert.equal(one.json.name, 'meal_plan_get');
    const raw = await request(s.port, 'POST', '/v1/tools/api_call', { body: { method: 'whisk.x.list.v1.ListAPI/GetLists' } });
    assert.equal(raw.status, 404);
    assert.equal(raw.json.error.code, 'unknown_tool');
  } finally {
    await s.close();
  }
  const raw = await start({ allowRaw: true });
  try {
    const { json } = await request(raw.port, 'GET', '/v1/tools');
    assert.ok(json.tools.some((t) => t.name === 'api_call'));
  } finally {
    await raw.close();
  }
});

test('tool call: success returns { ok, data, text }, arrays wrapped, empty body = {}', async () => {
  const s = await start();
  try {
    const r = await request(s.port, 'POST', '/v1/tools/api_methods', { body: { filter: 'List' } });
    assert.equal(r.status, 200);
    assert.equal(r.json.ok, true);
    assert.deepEqual(r.json.data, { result: ['whisk.x.list.v1.ListAPI/GetLists'] });
    assert.match(r.json.text, /GetLists/);
    assert.deepEqual(s.holder.calls, [['methods', 'List']]);

    const empty = await request(s.port, 'POST', '/v1/tools/api_methods');
    assert.equal(empty.status, 200);

    const status = await request(s.port, 'POST', '/v1/tools/auth_status', { body: {} });
    assert.equal(status.status, 200);
    assert.equal(status.json.data.loggedIn, false);

    const arr = await request(s.port, 'POST', '/v1/tools/test_array', { body: { n: 3 } });
    assert.deepEqual(arr.json.data, { result: [0, 1, 2] });
  } finally {
    await s.close();
  }
});

test('errors: validation 400, unknown 404, bad JSON 400, wrong content type 415, method 405, upstream mapping', async () => {
  const s = await start({ toolTimeoutMs: 100 });
  try {
    const v = await request(s.port, 'POST', '/v1/tools/meal_plan_get', { body: { from: 'yesterday' } });
    assert.equal(v.status, 400);
    assert.equal(v.json.ok, false);
    assert.equal(v.json.error.code, 'validation_error');
    assert.equal(v.json.error.issues[0].path, 'from');
    assert.equal(s.holder.calls.length, 0);

    const extra = await request(s.port, 'POST', '/v1/tools/meal_plan_get', { body: { nope: 1 } });
    assert.equal(extra.status, 400);

    const unknown = await request(s.port, 'POST', '/v1/tools/does_not_exist', { body: {} });
    assert.equal(unknown.status, 404);
    assert.equal(unknown.json.error.code, 'unknown_tool');

    const badJson = await request(s.port, 'POST', '/v1/tools/auth_status', { body: '{nope' });
    assert.equal(badJson.status, 400);
    assert.equal(badJson.json.error.code, 'invalid_json');

    const form = await request(s.port, 'POST', '/v1/tools/auth_status', { body: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
    assert.equal(form.status, 415);

    const put = await request(s.port, 'PUT', '/v1/tools/auth_status', { body: {} });
    assert.equal(put.status, 405);

    const expect = { test_grpc_not_found: [404, 'upstream_not_found'], test_login: [401, 'samsung_login_required'], test_transport: [502, 'upstream_unreachable'], test_crash: [500, 'internal_error'], test_slow: [504, 'timeout'] };
    for (const [name, [status, code]] of Object.entries(expect)) {
      const r = await request(s.port, 'POST', `/v1/tools/${name}`, { body: {} });
      assert.equal(r.status, status, name);
      assert.equal(r.json.error.code, code, name);
      assert.doesNotMatch(r.text, /\n\s+at /, `${name}: no stack trace`);
    }
  } finally {
    await s.close();
  }
  assert.equal(mapError(new GrpcError(16, 'ERROR_AUTH_TOKEN', 'm')).status, 401);
  assert.equal(mapError(new GrpcError(9, 'x', 'm')).status, 409);
  assert.equal(mapError(new GrpcError(13, 'x', 'm')).status, 502);
  assert.equal(mapError(new TransportError('t', { reachedServer: true, timeout: true })).status, 504);
});

test('body larger than 1 MB is refused with 413', async () => {
  const s = await start();
  try {
    const big = JSON.stringify({ filter: 'x'.repeat(1024 * 1024 + 10) });
    const r = await request(s.port, 'POST', '/v1/tools/api_methods', { body: big });
    assert.equal(r.status, 413);
    assert.equal(r.json.error.code, 'payload_too_large');
    // Without Content-Length (chunked), the streamed size is counted.
    const chunked = await request(s.port, 'POST', '/v1/tools/api_methods', { body: big, headers: { chunked: true } });
    assert.equal(chunked.status, 413);
    assert.equal(s.holder.calls.length, 0);
  } finally {
    await s.close();
  }
});

test('read-only mode exposes only read tools', async () => {
  const s = await start({ readOnly: true, allowRaw: true });
  try {
    const { json } = await request(s.port, 'GET', '/v1/tools');
    assert.ok(json.tools.length > 5);
    assert.ok(json.tools.every((t) => t.annotations.readOnlyHint === true));
    assert.ok(!json.tools.some((t) => t.name === 'api_call'));
    const w = await request(s.port, 'POST', '/v1/tools/shopping_list_add', { body: { items: ['milk'] } });
    assert.equal(w.status, 404);
    assert.match(w.json.error.message, /read-only/);
    const spec = await request(s.port, 'GET', '/openapi.json');
    assert.ok(!spec.json.paths['/v1/tools/shopping_list_add']);
    assert.ok(spec.json.paths['/v1/tools/meal_plan_get']);
    assert.equal((await request(s.port, 'GET', '/healthz', { key: null })).json.readOnly, true);
  } finally {
    await s.close();
  }
  assert.ok(selectTools(TOOLS, { readOnly: true }).every((t) => t.annotations.readOnlyHint));
});

test('openapi.json is an OpenAPI 3.1 document with one operation per tool', async () => {
  const s = await start();
  try {
    const { status, json: spec } = await request(s.port, 'GET', '/openapi.json');
    assert.equal(status, 200);
    assert.equal(spec.openapi, '3.1.0');
    assert.ok(spec.info.title && spec.info.version === '9.9.9');
    assert.deepEqual(spec.security, [{ bearerAuth: [] }]);
    assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
    assert.ok(spec.components.schemas.ToolResult && spec.components.schemas.Error);
    assert.deepEqual(spec.paths['/healthz'].get.security, []);
    const ops = Object.entries(spec.paths).filter(([p]) => p.startsWith('/v1/tools/'));
    assert.equal(ops.length, s.server.exposedTools.length);
    const ids = new Set();
    const tags = new Set(spec.tags.map((t) => t.name));
    for (const [p, item] of ops) {
      const op = item.post;
      assert.equal(p, `/v1/tools/${op.operationId}`);
      assert.ok(!ids.has(op.operationId));
      ids.add(op.operationId);
      assert.equal(op.tags.length, 1);
      assert.ok(tags.has(op.tags[0]), `${op.operationId}: tag ${op.tags[0]} declared`);
      assert.equal(op.requestBody.content['application/json'].schema.type, 'object');
      assert.ok(op.responses['200'] && op.responses['400'] && op.responses['401']);
      assert.equal(typeof op['x-safe'], 'boolean');
      const t = s.server.exposedTools.find((x) => x.name === op.operationId);
      assert.equal(op['x-safe'], t.annotations.readOnlyHint);
      // $refs resolve
      for (const r of JSON.stringify(op).match(/#\/components\/schemas\/\w+/g) ?? []) assert.ok(spec.components.schemas[r.split('/').pop()], r);
    }
    assert.equal(spec.paths['/v1/tools/meal_plan_get'].post.tags[0], 'meal_plan');
    assert.equal(spec.paths['/v1/tools/meal_plan_get'].post['x-safe'], true);
  } finally {
    await s.close();
  }
  assert.equal(toolArea('shopping_lists'), 'shopping_list');
  assert.equal(toolArea('collections_list'), 'collection');
  assert.equal(toolArea('collection_recipes'), 'collection');
  assert.equal(toolArea('api_call'), 'api');
});

test('/docs is a self-contained page without data, with a strict CSP', async () => {
  const s = await start();
  try {
    const r = await request(s.port, 'GET', '/docs', { key: null });
    assert.equal(r.status, 200);
    assert.match(r.headers['content-type'], /text\/html/);
    assert.match(r.headers['content-security-policy'], /default-src 'none'/);
    assert.doesNotMatch(r.text, /https?:\/\/(?!localhost)/, 'no external resources');
    assert.doesNotMatch(r.text, /meal_plan_get/, 'the shell contains no tool data');
  } finally {
    await s.close();
  }
});

test('CORS only with an explicit origin', async () => {
  const s = await start({ cors: 'http://localhost:3000' });
  try {
    const pre = await request(s.port, 'OPTIONS', '/v1/tools', { key: null, headers: { origin: 'http://localhost:3000' } });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers['access-control-allow-origin'], 'http://localhost:3000');
    assert.match(pre.headers['access-control-allow-headers'], /Authorization/);
    const r = await request(s.port, 'GET', '/v1/tools');
    assert.equal(r.headers['access-control-allow-origin'], 'http://localhost:3000');
  } finally {
    await s.close();
  }
  assert.equal(parseCorsOrigin('http://localhost:3000'), 'http://localhost:3000');
  assert.equal(parseCorsOrigin('*'), '*');
  assert.equal(parseCorsOrigin(undefined), null);
  assert.throws(() => parseCorsOrigin('http://x.y/path'), /origin/);
  assert.throws(() => parseCorsOrigin('javascript:alert(1)'), /origin/);
});

test('bind host: loopback by default, non-loopback only explicit and with a warning', () => {
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3']) {
    assert.ok(isLoopback(h), h);
    assert.equal(checkBindHost(h), null);
  }
  for (const h of ['0.0.0.0', '::', '192.168.1.10', 'example.com']) {
    assert.ok(!isLoopback(h), h);
    assert.throws(() => checkBindHost(h), /Refusing/);
    assert.match(checkBindHost(h, { explicit: true }), /WARNING/);
  }
  assert.throws(() => createApiServer({}), /apiKey/);
});

test('MCP over Streamable HTTP at /mcp uses the same filtered tools', async () => {
  const s = await start({ readOnly: true });
  const rpc = (body) => request(s.port, 'POST', '/mcp', { body, headers: { accept: 'application/json, text/event-stream' } });
  try {
    const init = await rpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    assert.equal(init.status, 200, init.text);
    assert.equal(init.json.result.serverInfo.name, 'unofficial-samsung-food-mcp');
    const list = await rpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    const names = list.json.result.tools.map((t) => t.name);
    assert.ok(names.includes('meal_plan_get'));
    assert.ok(!names.includes('shopping_list_add'));
    const call = await rpc({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'api_methods', arguments: {} } });
    assert.match(call.json.result.content[0].text, /GetLists/);
    const blocked = await rpc({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'shopping_list_add', arguments: { items: ['x'] } } });
    assert.equal(blocked.json.result.isError, true);
    assert.equal((await request(s.port, 'GET', '/mcp')).status, 405);
  } finally {
    await s.close();
  }
});
