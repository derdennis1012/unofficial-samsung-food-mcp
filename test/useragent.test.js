import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { buildSchema } from '../src/schema-build.js';
import { loadGraph } from '../src/foodgraph.js';
import { GrpcWebTransport, encodeFrame } from '../src/grpc.js';
import { USER_AGENT, VERSION } from '../src/version.js';

const pkg = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
// Honest client UA; a faked Chrome UA gets a Cloudflare challenge (403) from Node's TLS fingerprint.
const UA_SHAPE = /^unofficial-samsung-food-mcp\/\d+\.\d+\.\d+\S* \(\+https:\/\/github\.com\/[\w-]+\/unofficial-samsung-food-mcp\)$/;

const uaOf = (init) => new Headers(init?.headers).get('user-agent');

test('the User-Agent names this package and its version, never a browser', () => {
  assert.equal(VERSION, pkg.version);
  assert.match(USER_AGENT, UA_SHAPE);
  assert.doesNotMatch(USER_AGENT, /Mozilla|Chrome|Safari/);
});

test('schema build, food graph and gRPC calls all send that User-Agent', async () => {
  const seen = [];
  await assert.rejects(
    buildSchema({ file: '/nonexistent/schema.json', fetchImpl: async (url, init) => (seen.push(['schema', uaOf(init)]), new Response('<html></html>')) }),
    /No bundle URLs/
  );
  await loadGraph('xx-ua', {
    fetchImpl: async (url, init) => (seen.push(['graph', uaOf(init)]), Response.json({ products: [] })),
  });
  const trailer = Buffer.from('grpc-status: 0\r\n', 'latin1');
  const head = Buffer.alloc(5);
  head.writeUInt8(0x80, 0);
  head.writeUInt32BE(trailer.length, 1);
  const t = new GrpcWebTransport({
    fetchImpl: async (url, init) => (
      seen.push(['grpc', uaOf(init)]), new Response(Buffer.concat([encodeFrame(Buffer.alloc(0)), head, trailer]), { status: 200 })
    ),
  });
  await t.call('x.y.v1.A/GetThing', Buffer.alloc(0), { read: true });
  assert.deepEqual(seen.map(([k]) => k), ['schema', 'graph', 'grpc']);
  for (const [k, ua] of seen) assert.equal(ua, USER_AGENT, k);
});

test('a Cloudflare 403 while building the schema gives an actionable message', async () => {
  const fetchImpl = async () => new Response('challenge', { status: 403, headers: { 'cf-mitigated': 'challenge' } });
  await assert.rejects(
    buildSchema({ file: '/nonexistent/schema.json', fetchImpl }),
    (e) => /HTTP 403/.test(e.message) && /Cloudflare/.test(e.message) && /sf schema update/.test(e.message)
  );
});
