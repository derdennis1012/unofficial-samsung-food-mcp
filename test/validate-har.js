/**
 * Validates schema + codec against real traffic from a HAR capture.
 *
 *   node test/validate-har.js <file.har>
 *
 * Checks per API call:
 *   1. Decode request, re-encode, byte equality against the original
 *   2. Decode response (all frames), semantic re-encode comparison
 */

import fs from 'node:fs';
import { Codec } from '../src/core/proto.js';
import { decodeFrames } from '../src/core/grpc.js';
import { readSchema } from '../src/core/schema-build.js';

const schema = readSchema();
if (!schema) {
  console.error('No schema found. Build it first by running: sf schema update');
  process.exit(2);
}
const codec = new Codec(schema);

/** Stable comparison: field order on the wire is irrelevant. */
function canonical(v) {
  if (Array.isArray(v)) return v.map(canonical);
  if (v && typeof v === 'object') {
    return Object.fromEntries(
      Object.keys(v)
        .sort()
        .map((k) => [k, canonical(v[k])])
    );
  }
  return v;
}
const same = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));

const harPath = process.argv[2];
if (!harPath) {
  console.error('Usage: node test/validate-har.js <file.har>');
  process.exit(2);
}
const har = JSON.parse(fs.readFileSync(harPath, 'utf8'));

let reqOk = 0;
let reqByteMismatch = 0;
let respOk = 0;
const problems = [];
const seenMethods = new Set();

for (const entry of har.log.entries) {
  const url = entry.request.url;
  const marker = '/api/grpc-web/';
  if (!url.includes(marker)) continue;
  const method = url.split(marker)[1];
  seenMethods.add(method);

  if (!schema.rpcs[method]) {
    problems.push(`${method}: not in schema`);
    continue;
  }

  // ---- Request
  const text = entry.request.postData?.text ?? '';
  const raw = Buffer.from(text, 'latin1');
  try {
    for (const frame of decodeFrames(raw)) {
      if (frame.trailer) continue;
      const decoded = codec.decodeResponse
        ? codec.decodeMessage(schema.rpcs[method].request, frame.data)
        : null;
      const reencoded = codec.encodeMessage(schema.rpcs[method].request, decoded);
      if (reencoded.equals(frame.data)) {
        reqOk++;
      } else {
        // Not an error per se: field order or default values may differ.
        // What matters is that a second decode yields the same object.
        const again = codec.decodeMessage(schema.rpcs[method].request, reencoded);
        if (same(again, decoded)) {
          reqByteMismatch++;
        } else {
          problems.push(`${method}: request roundtrip differs semantically`);
        }
      }
    }
  } catch (err) {
    problems.push(`${method}: request decode failed – ${err.message}`);
  }

  // ---- Response
  const content = entry.response.content;
  if (!content?.text) continue;
  const respRaw =
    content.encoding === 'base64'
      ? Buffer.from(content.text, 'base64')
      : Buffer.from(content.text, 'latin1');
  try {
    for (const frame of decodeFrames(respRaw)) {
      if (frame.trailer) continue;
      const decoded = codec.decodeResponse(method, frame.data);
      const again = codec.decodeResponse(method, codec.encodeMessage(schema.rpcs[method].response, decoded));
      if (!same(again, decoded)) {
        problems.push(`${method}: response roundtrip differs semantically`);
      }
      respOk++;
    }
  } catch (err) {
    problems.push(`${method}: response decode failed – ${err.message}`);
  }
}

console.log(`Methods in capture      : ${seenMethods.size}`);
console.log(`Requests byte-identical: ${reqOk}`);
console.log(`Requests semantic only : ${reqByteMismatch}`);
console.log(`Response frames ok    : ${respOk}`);
if (problems.length) {
  console.log(`\nProblems (${problems.length}):`);
  for (const p of [...new Set(problems)]) console.log('  - ' + p);
  process.exit(1);
}
console.log('\nAll clean.');
