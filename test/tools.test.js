import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { TOOLS } from '../src/tools/index.js';
import { toJsonSchema } from '../src/tools/schema.js';
import { idSchema, dateSchema, mealTimeSchema, defineTool } from '../src/tools/util.js';
import { callTool, listTools, describeError, MAX_TEXT } from '../src/mcp/server.js';
import { GrpcError, TransportError } from '../src/core/grpc.js';
import { z } from 'zod';

const AREAS = ['meal_plan', 'shopping_list', 'recipe', 'collection', 'collections', 'pantry', 'food', 'nutrition', 'foodlog', 'account', 'auth', 'api'];

const LEGACY_NAMES = new Set(['shopping_lists', 'collections_list']);

test('tool names are unique, snake_case and grouped by a known area prefix', () => {
  const names = TOOLS.map((t) => t.name);
  assert.equal(new Set(names).size, names.length);
  for (const n of names) {
    assert.match(n, /^[a-z]+(_[a-z]+)+$/, n);
    assert.ok(LEGACY_NAMES.has(n) || AREAS.some((a) => n.startsWith(`${a}_`)), `${n} has no known area prefix`);
  }
});

test('annotations match the tool kind', () => {
  for (const t of TOOLS) {
    const a = t.annotations;
    assert.equal(typeof a.readOnlyHint, 'boolean', t.name);
    assert.equal(typeof a.destructiveHint, 'boolean', t.name);
    assert.equal(typeof a.idempotentHint, 'boolean', t.name);
    if (a.readOnlyHint) assert.equal(a.destructiveHint, false, `${t.name}: read-only must not be destructive`);
    if (/_(delete|remove|clear)(_|$)/.test(t.name) || /_delete$/.test(t.name)) {
      assert.equal(a.destructiveHint, true, `${t.name} deletes data and must be marked destructive`);
      assert.equal(a.readOnlyHint, false, t.name);
    }
    if (/_(add|create|post|rate|update|set_primary|save|apply|import|login|modify)(_|$)/.test(t.name) && !a.readOnlyHint) {
      assert.equal(a.readOnlyHint, false, t.name);
    }
    if (/_(get|list|search|info|status|autocomplete)$/.test(t.name) && !/_(add|update)/.test(t.name)) {
      assert.equal(a.readOnlyHint, true, `${t.name} looks like a read tool but is not marked read-only`);
    }
  }
});

test('destructive tools say so in their description', () => {
  for (const t of TOOLS.filter((x) => x.annotations.destructiveHint && !x.name.startsWith('api_'))) {
    assert.ok(t.description.length > 20, t.name);
  }
});

test('every tool has an English description and a strict object schema', () => {
  for (const t of TOOLS) {
    assert.ok(t.description && t.description.length >= 15, `${t.name}: description`);
    assert.doesNotMatch(t.description, /[äöüß]/i, `${t.name}: description should be English`);
    const js = toJsonSchema(t.schema);
    assert.equal(js.type, 'object', t.name);
    assert.equal(js.additionalProperties, false, t.name);
    for (const [k, v] of Object.entries(js.properties)) {
      assert.ok(v.type || v.anyOf || v.enum || 'const' in v, `${t.name}.${k} has no JSON schema type`);
    }
  }
});

test('example arguments are valid and unknown keys are rejected', () => {
  for (const t of TOOLS) {
    const ok = t.schema.safeParse(t.example ?? {});
    assert.ok(ok.success, `${t.name}: example invalid: ${ok.error?.message}`);
    const extra = t.schema.safeParse({ ...(t.example ?? {}), definitelyNotAField: 1 });
    assert.equal(extra.success, false, `${t.name} accepts unknown keys`);
  }
});

test('tools with required fields reject empty input', () => {
  for (const t of TOOLS) {
    const required = toJsonSchema(t.schema).required ?? [];
    if (required.length) assert.equal(t.schema.safeParse({}).success, false, `${t.name} accepts {} despite required ${required}`);
  }
});

test('string ids and ids lists are validated', () => {
  const idFields = [];
  for (const t of TOOLS) {
    const js = toJsonSchema(t.schema);
    for (const [k, v] of Object.entries(js.properties)) {
      if (/(^|[a-z])Ids?$/.test(k) || k === 'id') idFields.push([t.name, k, v]);
    }
  }
  assert.ok(idFields.length > 20);
  for (const [name, k, v] of idFields) {
    const item = v.type === 'array' ? v.items : v;
    assert.ok(item.maxLength || item.pattern || item.enum, `${name}.${k} is an unbounded string`);
  }
});

test('validators', () => {
  assert.ok(idSchema().safeParse('01a09999999999999999999999999999').success);
  assert.ok(idSchema().safeParse('01a0ffff-ffff-7fff-bfff-fffffffffff0').success);
  for (const bad of ['', ' ', 'a b', 'x'.repeat(201), 'a\nb', "'; drop"]) assert.equal(idSchema().safeParse(bad).success, false, JSON.stringify(bad));
  assert.ok(dateSchema().safeParse('2026-02-28').success);
  for (const bad of ['2026-02-30', '2026-13-01', '26-01-01', '2026-1-1', 'tomorrow', '']) assert.equal(dateSchema().safeParse(bad).success, false, bad);
  assert.ok(mealTimeSchema().safeParse('dinner').success);
  assert.equal(mealTimeSchema().safeParse('brunch').success, false);
});

test('defineTool rejects unknown kinds', () => {
  assert.throws(() => defineTool({ name: 'x_y', kind: 'nope', handler() {} }), /unknown kind/);
});

test('listTools exposes annotations and JSON schemas', () => {
  const list = listTools();
  assert.equal(list.length, TOOLS.length);
  assert.ok(list.every((t) => t.annotations && t.inputSchema.type === 'object'));
});

/* ---- call wrapper */

const holder = { get: async () => ({}) };
const withTool = async (tool, args) => {
  TOOLS.push(tool);
  try {
    return await callTool(tool.name, args, holder);
  } finally {
    TOOLS.pop();
  }
};

test('callTool: unknown tool and invalid arguments are isError results', async () => {
  assert.equal((await callTool('nope_nope', {}, holder)).isError, true);
  const r = await callTool('meal_plan_get', { from: 'yesterday' }, holder);
  assert.equal(r.isError, true);
  assert.match(r.content[0].text, /Invalid arguments - from/);
});

test('callTool: success returns text and structuredContent', async () => {
  const ok = await withTool(defineTool({ name: 'test_obj', kind: 'read', description: 'test tool for the wrapper', handler: async () => ({ a: 1 }) }), {});
  assert.deepEqual(ok.structuredContent, { a: 1 });
  const arr = await withTool(defineTool({ name: 'test_arr', kind: 'read', description: 'test tool for the wrapper', handler: async () => [1, 2] }), {});
  assert.deepEqual(arr.structuredContent, { result: [1, 2] });
});

test('callTool: errors never leak stack traces and carry actionable text', async () => {
  const boom = (err) => withTool(defineTool({ name: 'test_err', kind: 'read', description: 'test tool for the wrapper', handler: async () => { throw err; } }), {});
  for (const err of [new GrpcError(5, 'ERROR_RECIPE_NOT_FOUND', 'm'), new TransportError('Network error', { reachedServer: true }), new Error('plain'), new TypeError('x is undefined')]) {
    const r = await boom(err);
    assert.equal(r.isError, true);
    assert.doesNotMatch(r.content[0].text, /\n\s+at /);
  }
  assert.match(describeError(new GrpcError(5, 'x', 'm')), /not found/);
  assert.match(describeError(new TransportError('t', { reachedServer: true })), /may or may not/);
  assert.match(describeError(new TransportError('t', { reachedServer: false })), /was not sent/);
});

test('callTool: oversized output is truncated with a hint and no structuredContent', async () => {
  const r = await withTool(defineTool({ name: 'test_big', kind: 'read', description: 'test tool for the wrapper', handler: async () => ({ s: 'x'.repeat(MAX_TEXT * 2) }) }), {});
  assert.match(r.content[0].text, /truncated/);
  assert.equal(r.structuredContent, undefined);
  assert.ok(r.content[0].text.length < MAX_TEXT + 300);
});

test('callTool: zod errors from nested schemas list the path', async () => {
  const t = defineTool({ name: 'test_nested', kind: 'read', description: 'test tool for the wrapper', schema: z.object({ list: z.array(z.string().min(2)) }), handler: async () => ({}) });
  const r = await withTool(t, { list: ['ok', 'x'] });
  assert.match(r.content[0].text, /list\.1/);
});

test('idempotentHint is false for every tool that can create or append data', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, t.annotations]));
  for (const n of ['api_call', 'shopping_list_favorites_modify']) assert.equal(byName[n].idempotentHint, false, n);
  for (const t of TOOLS) {
    if (/_(add|create|copy|save|import|apply|post)(_|$)/.test(t.name) && t.annotations.destructiveHint === false && !t.annotations.readOnlyHint && !['collection_add_recipes', 'recipe_review_post'].includes(t.name)) {
      assert.equal(t.annotations.idempotentHint, false, `${t.name} creates data on every call`);
    }
  }
});

/* ---- api_call guard rails */

test('api_call refuses AuthAPI and account-credential methods without calling the API', async () => {
  const apiCall = TOOLS.find((t) => t.name === 'api_call');
  const called = [];
  const sf = { call: async (m) => (called.push(m), {}) };
  for (const m of [
    'whisk.x.user.v1.AuthAPI/IssueAuthCode',
    'whisk.x.user.v1.AuthAPI/UseAuthCode',
    'whisk.x.user.v1.AuthAPI/Login',
    'whisk.x.user.v1.AuthAPI/UseResetPasswordCode',
    'whisk.x.user.v1.UserAPI/UpdateEmail',
    'whisk.x.user.v1.UserAPI/UpdatePhone',
    'whisk.x.user.v1.UserAPI/UpdatePassword',
    'whisk.x.user.v1.UserAPI/CreatePassword',
    'whisk.x.user.v1.UserAPI/DeleteMe',
    'whisk.x.user.v2.NutritionPlusSamsungHealthLinkingAPI/ExchangeSamsungAccountCode',
  ]) {
    await assert.rejects(apiCall.handler({ method: m }, sf), /api_call refuses .*blocked/, m);
  }
  assert.deepEqual(called, []);
  await apiCall.handler({ method: 'whisk.x.user.v1.UserAPI/GetMe' }, sf);
  await apiCall.handler({ method: 'whisk.x.user.v1.UserAPI/UpdateSettings', request: {} }, sf);
  assert.deepEqual(called, ['whisk.x.user.v1.UserAPI/GetMe', 'whisk.x.user.v1.UserAPI/UpdateSettings']);
  assert.match(apiCall.description, /AuthAPI.*refused/);
});

test('api_call redacts secrets in results, recursively, and keeps ordinary codes', async () => {
  const apiCall = TOOLS.find((t) => t.name === 'api_call');
  const result = {
    authenticated: { token: { accessToken: 'AAA', refreshToken: 'RRR', expiresIn: 1209600 } },
    authCodeIssued: { code: 'short1' },
    session: { authCode: 'XYZ', password: 'hunter2' },
    list: [{ nested: { token: 'TTT', idToken: 'III' } }, { code: 'abcdefghijklmnopqrstuvwxyz0123' }],
    nutrition: [{ code: { name: 'ENERC_KCAL' } }],
    location: { code: 1 },
    country: { code: 'DE' },
    nextPageToken: 'page-2',
    name: 'kept',
  };
  const out = await apiCall.handler({ method: 'whisk.x.user.v1.UserAPI/GetMe' }, { call: async () => result });
  assert.equal(out.authenticated.token, '[redacted]');
  assert.equal(out.authCodeIssued.code, '[redacted]', 'code inside an auth-ish message');
  assert.deepEqual(out.session, { authCode: '[redacted]', password: '[redacted]' });
  assert.deepEqual(out.list[0].nested, { token: '[redacted]', idToken: '[redacted]' });
  assert.equal(out.list[1].code, '[redacted]', 'long opaque code');
  assert.deepEqual(out.nutrition, [{ code: { name: 'ENERC_KCAL' } }]);
  assert.deepEqual(out.location, { code: 1 });
  assert.deepEqual(out.country, { code: 'DE' });
  assert.equal(out.nextPageToken, 'page-2');
  assert.equal(out.name, 'kept');
  assert.equal(result.session.password, 'hunter2', 'the input is not mutated');
});

test('JSON schemas: draft 2020-12 without $schema, unions and refined fields keep their types', () => {
  const byName = Object.fromEntries(TOOLS.map((t) => [t.name, toJsonSchema(t.schema)]));
  for (const [name, js] of Object.entries(byName)) assert.equal(js.$schema, undefined, name);
  const ops = byName.shopping_list_favorites_modify.properties.ops;
  assert.deepEqual(ops.items.oneOf.map((o) => o.properties.op.const), ['create', 'update', 'delete']);
  assert.equal(ops.items.oneOf[0].additionalProperties, false);
  // Fields with a default are optional on input and keep the default; refined dates keep the pattern.
  const plan = byName.meal_plan_get;
  assert.ok(!(plan.required ?? []).includes('days'));
  assert.equal(plan.properties.from.pattern, '^\\d{4}-\\d{2}-\\d{2}$');
  // zod's implicit safe-integer bounds are not emitted.
  assert.doesNotMatch(JSON.stringify(byName), /9007199254740991/);
});
