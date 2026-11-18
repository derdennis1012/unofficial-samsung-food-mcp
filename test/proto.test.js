import test from 'node:test';
import assert from 'node:assert/strict';
import { Codec, WIRE } from '../src/proto.js';

const schema = {
  rpcs: { 'x.A/Get': { request: [{ n: 1, name: 'id', type: 'int64' }], response: [] } },
  messages: {
    'f:Msg': [
      { n: 1, name: 'values', type: 'double', repeated: true },
      { n: 2, name: 'floats', type: 'float', repeated: true },
      { n: 3, name: 'count', type: 'uint32' },
      { n: 4, name: 'big', type: 'int64' },
      { n: 5, name: 'name', type: 'string' },
      { n: 6, name: 'small', type: 'int32' },
    ],
  },
};
const codec = new Codec(schema);
const fields = schema.messages['f:Msg'];

/** Hand-built packed field: tag, length, raw bytes. */
function packed(fieldNo, bytes) {
  return Buffer.concat([Buffer.from([(fieldNo << 3) | WIRE.LEN, bytes.length]), bytes]);
}

test('decodes packed repeated doubles and floats', () => {
  const d = Buffer.alloc(16);
  d.writeDoubleLE(1.5, 0);
  d.writeDoubleLE(-2.25, 8);
  const f = Buffer.alloc(8);
  f.writeFloatLE(0.5, 0);
  f.writeFloatLE(4, 4);
  const out = codec.decodeMessage(fields, Buffer.concat([packed(1, d), packed(2, f)]));
  assert.deepEqual(out.values, [1.5, -2.25]);
  assert.deepEqual(out.floats, [0.5, 4]);
});

test('unpacked repeated doubles still round-trip', () => {
  const buf = codec.encodeMessage(fields, { values: [3.5, 7] });
  assert.deepEqual(codec.decodeMessage(fields, buf).values, [3.5, 7]);
});

test('uint32 above 2^31 decodes as a positive number', () => {
  const buf = codec.encodeMessage(fields, { count: 3000000000 });
  assert.equal(codec.decodeMessage(fields, buf).count, 3000000000);
  // int32 keeps its sign
  assert.equal(codec.decodeMessage(fields, codec.encodeMessage(fields, { small: -5 })).small, -5);
});

test('varint encoding rejects NaN and fractions with the field name, accepts int64 strings exactly', () => {
  assert.throws(() => codec.encodeMessage(fields, { count: Number.NaN }), /count.*integer/);
  assert.throws(() => codec.encodeMessage(fields, { count: 1.5 }), /count.*integer/);
  assert.throws(() => codec.encodeMessage(fields, { big: 'abc' }), /big.*integer/);
  const big = '9007199254740993'; // 2^53 + 1, not representable as a double
  const out = codec.decodeMessage(fields, codec.encodeMessage(fields, { big }));
  assert.equal(out.big, big);
});

test('arrays are rejected for non-repeated fields', () => {
  assert.throws(() => codec.encodeMessage(fields, { name: ['a', 'b'] }), /name is not repeated/);
});

test('LEN reads and skips past the end of the buffer throw', () => {
  // field 5 (string) claims 10 bytes, only 2 follow
  assert.throws(() => codec.decodeMessage(fields, Buffer.from([(5 << 3) | WIRE.LEN, 10, 0x61, 0x62])), /overruns/);
  // unknown field 9 (LEN) claims 50 bytes
  assert.throws(() => codec.decodeMessage(fields, Buffer.from([(9 << 3) | WIRE.LEN, 50, 0x61])), /overruns/);
  // truncated double
  assert.throws(() => codec.decodeMessage(fields, Buffer.from([(1 << 3) | WIRE.I64, 1, 2])), /overruns/);
});

test('method and message lookup ignore prototype members', () => {
  assert.throws(() => codec.rpc('constructor'), /unknown method/);
  assert.throws(() => codec.rpc('toString'), /unknown method/);
  assert.throws(() => codec.fieldsOf('constructor'), /unknown message/);
  assert.ok(codec.rpc('x.A/Get'));
});
