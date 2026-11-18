/**
 * Helpers for the hosted connector tests: a fake Samsung Food transport on the fixture schema,
 * a tiny cookie-keeping HTTP client (fetch is disabled offline) and PKCE.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { readSchema } from '../src/core/schema-build.js';
import { Codec } from '../src/core/proto.js';
import { GrpcError } from '../src/core/grpc.js';

/** Fixture schema plus the two AuthAPI methods used for the token renewal. */
export function testSchema() {
  const s = structuredClone(readSchema());
  s.rpcs['whisk.x.user.v1.AuthAPI/IssueAuthCode'] = { request: [], response: [{ n: 1, name: 'code', type: 'string' }] };
  s.rpcs['whisk.x.user.v1.AuthAPI/UseAuthCode'] = { request: [{ n: 1, name: 'code', type: 'string' }], response: [{ n: 1, name: 'authenticated', type: 'message', ref: 'tAuth' }] };
  s.messages.tAuth = [{ n: 1, name: 'token', type: 'message', ref: 'tTok' }];
  s.messages.tTok = [
    { n: 1, name: 'accessToken', type: 'string' },
    { n: 3, name: 'expiresIn', type: 'int64' },
  ];
  return s;
}

export const TOKEN_A = 'A'.repeat(20) + 'samsungTokenForAnna1234567890';
export const TOKEN_RENEWED = 'R'.repeat(20) + 'renewedSamsungToken0987654321';

/**
 * Fake Samsung Food: valid tokens map to accounts; calls are recorded (method + token).
 * `renew` controls AuthAPI: the renewed token becomes valid for the same account.
 */
export function fakeSamsung(schema, { accounts = { [TOKEN_A]: { id: 'samsung-user-1', settings: { firstName: 'Anna', lastName: 'Test' } } }, renewTo = TOKEN_RENEWED } = {}) {
  const codec = new Codec(schema);
  const calls = [];
  const valid = new Map(Object.entries(accounts));
  const transport = {
    async call(method, payload, opts) {
      calls.push({ method, token: opts.token });
      const user = valid.get(opts.token);
      if (!user) throw new GrpcError(16, 'ERROR_AUTH_TOKEN', 'token rejected');
      let res;
      if (method === 'whisk.x.user.v1.UserAPI/GetMe') res = { user };
      else if (method === 'whisk.x.user.v1.AuthAPI/IssueAuthCode') res = { code: 'auth-code-1' };
      else if (method === 'whisk.x.user.v1.AuthAPI/UseAuthCode') {
        valid.set(renewTo, user);
        res = { authenticated: { token: { accessToken: renewTo, expiresIn: 14 * 86400 } } };
      } else if (method === 'whisk.x.mealplan.v1.MealPlanAPI/GetMealPlan') res = { mealPlanId: 'plan-1' };
      else throw new Error(`unexpected call ${method}`);
      return codec.encodeMessage(codec.rpc(method).response, res);
    },
  };
  return { transport, calls, valid };
}

/** A browser-like client: keeps cookies, sends Origin on POST. */
export function client(base) {
  const jar = new Map();
  const origin = new URL(base).origin;
  function request(method, url, { body, headers = {}, form, json, raw } = {}) {
    const u = new URL(url, base);
    const h = { ...headers };
    if (jar.size && !('cookie' in h)) h.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    let payload;
    if (json !== undefined) {
      payload = JSON.stringify(json);
      h['content-type'] ??= 'application/json';
    } else if (form !== undefined) {
      payload = new URLSearchParams(form).toString();
      h['content-type'] ??= 'application/x-www-form-urlencoded';
    } else if (body !== undefined) payload = body;
    if (method === 'POST' && !('origin' in h)) h.origin = origin;
    for (const k of Object.keys(h)) if (h[k] === null) delete h[k];
    if (payload !== undefined) h['content-length'] = Buffer.byteLength(payload);
    return new Promise((resolve, reject) => {
      const req = http.request({ host: u.hostname, port: u.port, path: u.pathname + u.search, method, headers: h }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          for (const c of [].concat(res.headers['set-cookie'] ?? [])) {
            const [kv] = c.split(';');
            const i = kv.indexOf('=');
            jar.set(kv.slice(0, i), kv.slice(i + 1));
          }
          const text = Buffer.concat(chunks).toString('utf8');
          let data = null;
          if (!raw && /json/.test(res.headers['content-type'] ?? '')) {
            try {
              data = JSON.parse(text);
            } catch {
              data = null;
            }
          }
          resolve({ status: res.statusCode, headers: res.headers, text, data });
        });
      });
      req.on('error', reject);
      if (payload !== undefined) req.write(payload);
      req.end();
    });
  }
  return { request, jar };
}

export function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  return { verifier, challenge: crypto.createHash('sha256').update(verifier).digest('base64url') };
}

/** The JSON settings the login page embeds for its script. */
export function pageConfig(html) {
  const m = /<script type="application\/json" id="cfg">([^<]*)<\/script>/.exec(html);
  return m ? JSON.parse(m[1]) : null;
}

export function tmpDir(prefix = 'sf-host-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
