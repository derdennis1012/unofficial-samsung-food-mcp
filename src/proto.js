/**
 * Schema-driven protobuf codec.
 *
 * The schema is built on the user's machine by `sf schema update`
 * (src/schema-build.js) and cached as schema.json in the config dir
 * (~/.samsung-food or $SAMSUNG_FOOD_HOME). It is extracted from the generated
 * clients in the web app bundle. Per field: { n, name, type, ref?, repeated?, oneof? }
 * There is no .proto and no protoc - encode/decode run directly against the JSON.
 */

const WIRE = { VARINT: 0, I64: 1, LEN: 2, I32: 5 };

const SCALAR_WIRE = {
  string: WIRE.LEN,
  bytes: WIRE.LEN,
  int32: WIRE.VARINT,
  int64: WIRE.VARINT,
  uint32: WIRE.VARINT,
  uint64: WIRE.VARINT,
  bool: WIRE.VARINT,
  enum: WIRE.VARINT,
  double: WIRE.I64,
  float: WIRE.I32,
};

/* ------------------------------------------------------------------ Writer */

class Writer {
  constructor() {
    this.chunks = [];
  }

  varint(v) {
    let n = typeof v === 'bigint' ? v : BigInt(v);
    if (n < 0n) n += 1n << 64n; // negative int32/int64 are encoded as a 10-byte varint
    const out = [];
    do {
      let b = Number(n & 0x7fn);
      n >>= 7n;
      if (n > 0n) b |= 0x80;
      out.push(b);
    } while (n > 0n);
    this.chunks.push(Buffer.from(out));
    return this;
  }

  tag(field, wire) {
    return this.varint(field * 8 + wire);
  }

  bytes(buf) {
    this.varint(buf.length);
    this.chunks.push(buf);
    return this;
  }

  double(v) {
    const b = Buffer.allocUnsafe(8);
    b.writeDoubleLE(Number(v));
    this.chunks.push(b);
    return this;
  }

  float(v) {
    const b = Buffer.allocUnsafe(4);
    b.writeFloatLE(Number(v));
    this.chunks.push(b);
    return this;
  }

  finish() {
    return Buffer.concat(this.chunks);
  }
}

/* ------------------------------------------------------------------ Reader */

class Reader {
  constructor(buf) {
    this.buf = buf;
    this.pos = 0;
  }

  get eof() {
    return this.pos >= this.buf.length;
  }

  /** Advances by n bytes; a length that runs past the end means a corrupt or mismatched message. */
  advance(n) {
    if (!Number.isSafeInteger(n) || n < 0 || this.pos + n > this.buf.length) {
      throw new Error(`length ${n} overruns buffer at offset ${this.pos} (size ${this.buf.length})`);
    }
    const start = this.pos;
    this.pos += n;
    return start;
  }

  varint() {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (this.pos >= this.buf.length) throw new Error('varint overruns buffer');
      const b = this.buf[this.pos++];
      result |= BigInt(b & 0x7f) << shift;
      if (!(b & 0x80)) break;
      shift += 7n;
      if (shift > 70n) throw new Error('varint too long');
    }
    return result;
  }

  skip(wire) {
    switch (wire) {
      case WIRE.VARINT:
        this.varint();
        break;
      case WIRE.I64:
        this.advance(8);
        break;
      case WIRE.LEN:
        this.advance(Number(this.varint()));
        break;
      case WIRE.I32:
        this.advance(4);
        break;
      default:
        throw new Error(`unknown wire type ${wire}`);
    }
  }
}

/**
 * Validates a value for a varint field. Integers (number, bigint, or a decimal string such as an
 * int64 id) pass; NaN, fractions and other strings are rejected with the field name.
 */
function toInteger(v, f) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number' && Number.isInteger(v)) return v;
  if (typeof v === 'string' && /^-?\d+$/.test(v.trim())) return BigInt(v.trim()); // no precision loss
  throw new Error(`Field ${f.name} (${f.type}) expects an integer, got ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
}

/* ------------------------------------------------------------------ Schema */

export class Codec {
  /** @param {{rpcs:object, messages:object}} schema */
  constructor(schema) {
    this.schema = schema;
  }

  fieldsOf(ref) {
    // Object.hasOwn: names like "constructor" or "toString" must not resolve to prototype members.
    const f = Object.hasOwn(this.schema.messages, ref) ? this.schema.messages[ref] : undefined;
    if (!f) throw new Error(`unknown message: ${ref}`);
    return f;
  }

  rpc(method) {
    const r = Object.hasOwn(this.schema.rpcs, method) ? this.schema.rpcs[method] : undefined;
    if (!r) throw new Error(`unknown method: ${method}`);
    return r;
  }

  /** List of all method names, optionally filtered. */
  methods(filter) {
    const all = Object.keys(this.schema.rpcs).sort();
    if (!filter) return all;
    const q = filter.toLowerCase();
    return all.filter((m) => m.toLowerCase().includes(q));
  }

  /* --------------------------------------------------------------- encode */

  encodeMessage(fields, obj) {
    const w = new Writer();
    if (obj == null) return w.finish();
    // A misspelled field name must fail loudly instead of being silently dropped.
    const known = new Set(fields.map((f) => f.name));
    const unknown = Object.keys(obj).filter((k) => !known.has(k) && obj[k] !== undefined);
    if (unknown.length) {
      throw new Error(`Unknown field(s) ${unknown.join(', ')}; valid fields: ${[...known].join(', ') || '(none)'}`);
    }
    for (const f of fields) {
      const v = obj[f.name];
      if (v === undefined || v === null) continue;
      if (f.repeated) {
        if (!Array.isArray(v)) throw new Error(`Field ${f.name} expects an array`);
        for (const item of v) this.encodeField(w, f, item);
      } else {
        if (Array.isArray(v)) throw new Error(`Field ${f.name} is not repeated and does not accept an array`);
        this.encodeField(w, f, v);
      }
    }
    return w.finish();
  }

  encodeField(w, f, v) {
    switch (f.type) {
      case 'message': {
        const sub = this.encodeMessage(this.fieldsOf(f.ref), v);
        w.tag(f.n, WIRE.LEN).bytes(sub);
        break;
      }
      case 'wrapper': {
        // google.protobuf.XValue: message with a single field 1
        const inner = new Writer();
        this.encodeField(inner, { n: 1, name: f.name, type: f.value }, v);
        w.tag(f.n, WIRE.LEN).bytes(inner.finish());
        break;
      }
      case 'string':
        w.tag(f.n, WIRE.LEN).bytes(Buffer.from(String(v), 'utf8'));
        break;
      case 'bytes':
        w.tag(f.n, WIRE.LEN).bytes(Buffer.isBuffer(v) ? v : Buffer.from(v));
        break;
      case 'bool':
        w.tag(f.n, WIRE.VARINT).varint(v ? 1 : 0);
        break;
      case 'double':
        w.tag(f.n, WIRE.I64).double(v);
        break;
      case 'float':
        w.tag(f.n, WIRE.I32).float(v);
        break;
      case 'int32':
      case 'int64':
      case 'uint32':
      case 'uint64':
      case 'enum':
        w.tag(f.n, WIRE.VARINT).varint(toInteger(v, f));
        break;
      default:
        throw new Error(`cannot encode type ${f.type} (field ${f.name})`);
    }
  }

  /* --------------------------------------------------------------- decode */

  decodeMessage(fields, buf) {
    const byNum = new Map(fields.map((f) => [f.n, f]));
    const out = {};
    const r = new Reader(buf);
    while (!r.eof) {
      const key = Number(r.varint());
      const num = key >>> 3;
      const wire = key & 7;
      const f = byNum.get(num);
      if (!f) {
        // Unknown field: server is newer than the extracted schema.
        r.skip(wire);
        continue;
      }
      const expected = f.type === 'message' || f.type === 'wrapper' ? WIRE.LEN : SCALAR_WIRE[f.type];
      let value;
      if (wire === WIRE.LEN && (expected === WIRE.VARINT || expected === WIRE.I64 || expected === WIRE.I32)) {
        // packed repeated scalars (varints, doubles, floats)
        const len = Number(r.varint());
        const end = r.advance(len) + len;
        const packed = new Reader(r.buf.subarray(end - len, end));
        const items = [];
        while (!packed.eof) items.push(this.readScalar(packed, f.type, expected));
        if (f.repeated) {
          (out[f.name] ||= []).push(...items);
        } else {
          out[f.name] = items[items.length - 1];
        }
        continue;
      }
      if (wire !== expected) {
        r.skip(wire);
        continue;
      }
      if (f.type === 'message') {
        const len = Number(r.varint());
        const sub = this.buf_slice(r, len);
        value = this.decodeMessage(this.fieldsOf(f.ref), sub);
      } else if (f.type === 'wrapper') {
        const len = Number(r.varint());
        const sub = this.buf_slice(r, len);
        const inner = this.decodeMessage([{ n: 1, name: 'value', type: f.value }], sub);
        value = inner.value;
      } else {
        value = this.readScalar(r, f.type, wire);
      }
      if (f.repeated) (out[f.name] ||= []).push(value);
      else out[f.name] = value;
    }
    return out;
  }

  buf_slice(r, len) {
    const start = r.advance(len);
    return r.buf.subarray(start, start + len);
  }

  readScalar(r, type, wire) {
    switch (type) {
      case 'string': {
        const len = Number(r.varint());
        return this.buf_slice(r, len).toString('utf8');
      }
      case 'bytes': {
        const len = Number(r.varint());
        return Buffer.from(this.buf_slice(r, len));
      }
      case 'bool':
        return r.varint() !== 0n;
      case 'double':
        return r.buf.readDoubleLE(r.advance(8));
      case 'float':
        return r.buf.readFloatLE(r.advance(4));
      case 'int64':
      case 'uint64': {
        const v = r.varint();
        // Return a number within Number.MAX_SAFE_INTEGER, otherwise a string.
        return v <= 9007199254740991n ? Number(v) : v.toString();
      }
      case 'uint32':
        // never negative: the low 32 bits as an unsigned number
        return Number(BigInt.asUintN(32, r.varint()));
      case 'int32':
      case 'enum': {
        const v = r.varint();
        // negative int32 is transmitted as a 64-bit varint
        return v > 0x7fffffffn ? Number(BigInt.asIntN(32, v)) : Number(v);
      }
      default:
        r.skip(wire);
        return undefined;
    }
  }

  /* ------------------------------------------------------------ RPC level */

  encodeRequest(method, obj) {
    return this.encodeMessage(this.rpc(method).request, obj ?? {});
  }

  decodeResponse(method, buf) {
    return this.decodeMessage(this.rpc(method).response, buf);
  }

  /** Human-readable signature of a method, for docs and MCP tools. */
  describe(method, depth = 3) {
    const r = this.rpc(method);
    const render = (fields, d, seen) =>
      fields
        .map((f) => {
          const rep = f.repeated ? '[]' : '';
          const oneof = f.oneof ? ` (oneof ${f.oneof})` : '';
          let line = `${'  '.repeat(d)}${f.n} ${f.name}${rep}: ${f.type}${oneof}`;
          if (f.type === 'message' && d < depth && !seen.has(f.ref)) {
            line += '\n' + render(this.fieldsOf(f.ref), d + 1, new Set([...seen, f.ref]));
          }
          return line;
        })
        .join('\n');
    return [
      `${method}`,
      '  request:',
      render(r.request, 2, new Set()) || '    (empty)',
      '  response:',
      render(r.response, 2, new Set()) || '    (empty)',
    ].join('\n');
  }
}

export { WIRE };
