/**
 * gRPC-Web-Transport (application/grpc-web+proto) over fetch.
 *
 * Framing: [1 byte flag][4 byte length big-endian][payload]
 *   Flag 0x00 = data frame, flag 0x80 = trailer (HTTP/1 header syntax)
 * The HTTP status is always 200 - the real status is in the trailer as grpc-status.
 */

import { USER_AGENT } from './version.js';

export const GRPC_STATUS = {
  0: 'OK',
  1: 'CANCELLED',
  2: 'UNKNOWN',
  3: 'INVALID_ARGUMENT',
  4: 'DEADLINE_EXCEEDED',
  5: 'NOT_FOUND',
  6: 'ALREADY_EXISTS',
  7: 'PERMISSION_DENIED',
  8: 'RESOURCE_EXHAUSTED',
  9: 'FAILED_PRECONDITION',
  10: 'ABORTED',
  11: 'OUT_OF_RANGE',
  12: 'UNIMPLEMENTED',
  13: 'INTERNAL',
  14: 'UNAVAILABLE',
  15: 'DATA_LOSS',
  16: 'UNAUTHENTICATED',
};

export class GrpcError extends Error {
  constructor(status, message, method) {
    super(`${GRPC_STATUS[status] ?? status}: ${message || '(no message)'} [${method}]`);
    this.name = 'GrpcError';
    this.status = status;
    this.statusName = GRPC_STATUS[status] ?? String(status);
    this.method = method;
  }
}

/** Wraps a protobuf message in a gRPC-Web data frame. */
export function encodeFrame(payload) {
  const header = Buffer.allocUnsafe(5);
  header.writeUInt8(0, 0);
  header.writeUInt32BE(payload.length, 1);
  return Buffer.concat([header, payload]);
}

/** Splits a gRPC-Web body into its frames. */
export function decodeFrames(buf) {
  const frames = [];
  let i = 0;
  while (i + 5 <= buf.length) {
    const flag = buf.readUInt8(i);
    const len = buf.readUInt32BE(i + 1);
    i += 5;
    if (i + len > buf.length) throw new Error('truncated gRPC-Web frame');
    const data = buf.subarray(i, i + len);
    i += len;
    if (flag & 0x80) {
      const headers = {};
      for (const line of data.toString('latin1').split(/\r\n/)) {
        const idx = line.indexOf(':');
        if (idx > 0) headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
      }
      frames.push({ trailer: true, headers });
    } else {
      frames.push({ trailer: false, data });
    }
  }
  if (i !== buf.length) throw new Error('trailing bytes after the last gRPC-Web frame');
  return frames;
}

const DEFAULT_ORIGIN = 'https://app.samsungfood.com';
/** Fallback; override with SAMSUNG_FOOD_APP_VERSION (the real value lives in a minified bundle module). */
export const DEFAULT_APP_VERSION = process.env.SAMSUNG_FOOD_APP_VERSION || '2.88.0';

const envInt = (name, fallback) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && v >= 0 ? v : fallback;
};

/** Network-level failure (no usable HTTP response). */
export class TransportError extends Error {
  /**
   * @param {boolean} reachedServer false only when the request provably never left the machine
   *   (DNS failure, refused or unreachable connection); a timeout may have been processed.
   */
  constructor(message, { reachedServer, timeout = false, cause } = {}) {
    super(message, { cause });
    this.name = 'TransportError';
    this.reachedServer = reachedServer;
    this.timeout = timeout;
  }
}

/** Retry-After as milliseconds: delta-seconds or an HTTP date. */
export function parseRetryAfter(value, now = Date.now()) {
  if (!value) return 0;
  const secs = Number(value);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(value);
  return Number.isNaN(at) ? 0 : Math.max(0, at - now);
}

const NEVER_SENT = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT']);
const RETRYABLE_GRPC = new Set([4, 8, 10, 14]); // DEADLINE_EXCEEDED, RESOURCE_EXHAUSTED, ABORTED, UNAVAILABLE

/**
 * Whether a failed call may be repeated.
 * Reads are always safe. Writes only when the server provably did not process the request:
 * the request never left the machine, or the server rejected it for rate limiting (HTTP 429,
 * RESOURCE_EXHAUSTED).
 */
export function isRetryable(err, { read }) {
  if (err instanceof TransportError) return read || err.reachedServer === false;
  if (err instanceof GrpcError) {
    if (err.httpStatus === 429 || err.status === 8) return true;
    if (!read) return false;
    if (err.httpStatus) return err.httpStatus >= 500;
    return RETRYABLE_GRPC.has(err.status);
  }
  return false;
}

/**
 * Minimal gRPC-Web client. Only supports unary calls - the app uses nothing else.
 * Each attempt has a timeout; transient failures are retried with exponential backoff and jitter.
 */
export class GrpcWebTransport {
  constructor({
    origin = DEFAULT_ORIGIN,
    appVersion = DEFAULT_APP_VERSION,
    fetchImpl = globalThis.fetch,
    timeoutMs = envInt('SAMSUNG_FOOD_TIMEOUT_MS', 20000),
    maxRetries = envInt('SAMSUNG_FOOD_RETRIES', 3),
    baseDelayMs = 400,
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    random = Math.random,
  } = {}) {
    this.origin = origin.replace(/\/$/, '');
    this.appVersion = appVersion;
    this.fetch = fetchImpl;
    this.timeoutMs = timeoutMs;
    this.maxRetries = maxRetries;
    this.baseDelayMs = baseDelayMs;
    this.sleep = sleep;
    this.random = random;
  }

  /**
   * @param {string} method    e.g. "whisk.x.list.v1.ListAPI/GetLists"
   * @param {Buffer} payload   encoded request message
   * @param {object} opts      { token, path, page, locale, baseUrl, bare, read, timeoutMs }
   *   `read: true` marks a read-only method (always retryable); anything else counts as a write.
   * @returns {Promise<Buffer>} encoded response message
   */
  async call(method, payload, opts = {}) {
    const read = Boolean(opts.read);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.attempt(method, payload, opts);
      } catch (err) {
        if (attempt >= this.maxRetries || !isRetryable(err, { read })) throw err;
        const backoff = this.baseDelayMs * 2 ** attempt;
        const wait = Math.max(err.retryAfterMs ?? 0, backoff * (0.5 + this.random() * 0.5));
        await this.sleep(Math.min(wait, 15000));
      }
    }
  }

  async attempt(method, payload, opts) {
    const path = opts.path ?? '/api/grpc-web';
    const url = `${opts.baseUrl ?? this.origin}${path}/${method}`;

    const headers = {
      'content-type': 'application/grpc-web+proto',
      accept: '*/*',
      'x-grpc-web': '1',
      'x-user-agent': 'grpc-web-ts/1.0',
      'x-whisk-app-name': 'webapp',
      'request-id': randomUuid(),
      'cache-control': 'no-cache, no-store, must-revalidate',
      pragma: 'no-cache',
      origin: this.origin,
      referer: `${this.origin}/`,
      'user-agent': USER_AGENT,
    };
    // The web app sends the login-domain AuthAPI calls without these two headers.
    if (!opts.bare) {
      headers['x-whisk-app-version'] = this.appVersion;
      headers['x-whisk-device-type'] = 'Desktop';
    }
    if (opts.token) headers.authorization = `Bearer ${opts.token}`;
    if (opts.locale) headers['accept-language'] = opts.locale;
    if (opts.page) headers['x-whisk-page'] = Buffer.from(JSON.stringify(opts.page)).toString('base64');

    const timeoutMs = opts.timeoutMs ?? this.timeoutMs;
    const controller = new AbortController();
    const timer = timeoutMs > 0 ? setTimeout(() => controller.abort(), timeoutMs) : null;
    let res;
    let body;
    try {
      res = await this.fetch(url, {
        method: 'POST',
        headers,
        body: encodeFrame(payload),
        signal: controller.signal,
      });
      body = Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (controller.signal.aborted) {
        throw new TransportError(`Request timed out after ${timeoutMs} ms [${method}]`, {
          reachedServer: true,
          timeout: true,
          cause: err,
        });
      }
      const code = err?.cause?.code ?? err?.code;
      throw new TransportError(`Network error: ${err?.cause?.message ?? err?.message ?? err} [${method}]`, {
        reachedServer: !NEVER_SENT.has(code),
        cause: err,
      });
    } finally {
      if (timer) clearTimeout(timer);
    }

    if (res.status !== 200) {
      // 401/403 map to UNAUTHENTICATED/PERMISSION_DENIED so callers can show the login hint.
      const code = { 401: 16, 403: 7, 429: 8 }[res.status] ?? 2;
      const err = new GrpcError(code, `HTTP ${res.status} ${res.statusText}`, method);
      err.httpStatus = res.status;
      const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
      if (retryAfter) err.retryAfterMs = retryAfter;
      throw err;
    }

    // Status may be in the HTTP header OR in the trailer frame.
    let status = res.headers.get('grpc-status');
    let message = res.headers.get('grpc-message');
    let data = null;

    let frames;
    try {
      frames = decodeFrames(body);
    } catch (err) {
      throw new TransportError(`Incomplete response: ${err.message} [${method}]`, { reachedServer: true, cause: err });
    }
    let sawTrailer = false;
    for (const frame of frames) {
      if (frame.trailer) {
        sawTrailer = true;
        if (frame.headers['grpc-status'] != null) status = frame.headers['grpc-status'];
        if (frame.headers['grpc-message'] != null) message = frame.headers['grpc-message'];
      } else if (data === null) {
        data = frame.data;
      }
    }

    if (status == null && !sawTrailer) {
      throw new TransportError(`Incomplete response: no grpc-status received [${method}]`, { reachedServer: true });
    }
    const code = status == null ? 0 : Number(status);
    if (code !== 0) throw new GrpcError(code, safeDecode(message ?? ''), method);

    return data ?? Buffer.alloc(0);
  }
}

/** grpc-message is percent-encoded; a bare "%" must not turn into a URIError. */
function safeDecode(v) {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

function randomUuid() {
  return globalThis.crypto?.randomUUID
    ? globalThis.crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
      });
}
