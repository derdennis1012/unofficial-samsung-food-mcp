/** Small node:http helpers shared by the local login server and the hosted connector. */

import { HandoverError, readCookie } from './handover.js';

export class HttpError extends Error {
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/** Common response headers: no caching, no sniffing, no referrer, no framing. */
export function baseHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
  res.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
}

export function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...headers });
  res.end(payload);
}

export function sendHtml(res, status, html, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': Buffer.byteLength(html), ...headers });
  res.end(html);
}

/** Reads the body up to `limit` bytes; larger bodies get a 413. */
export function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      req.resume();
      return reject(new HttpError(413, 'payload_too_large', `Request body larger than ${limit} bytes`));
    }
    const chunks = [];
    let size = 0;
    let done = false;
    req.on('data', (c) => {
      if (done) return;
      size += c.length;
      if (size > limit) {
        done = true;
        req.resume();
        reject(new HttpError(413, 'payload_too_large', `Request body larger than ${limit} bytes`));
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => !done && resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', (err) => !done && reject(err));
  });
}

const mediaType = (req) => String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();

/** JSON body; only application/json (a cross-site form cannot send that without a CORS preflight). */
export async function readJsonBody(req, limit) {
  if (mediaType(req) !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  const raw = await readBody(req, limit);
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('not an object');
    return v;
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not a JSON object');
  }
}

/** application/x-www-form-urlencoded body as a plain object; repeated parameters are an error. */
export async function readFormBody(req, limit) {
  if (mediaType(req) !== 'application/x-www-form-urlencoded') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/x-www-form-urlencoded');
  const params = new URLSearchParams(await readBody(req, limit));
  const out = Object.create(null);
  for (const [k, v] of params) {
    if (k in out) throw new HttpError(400, 'invalid_request', `Parameter ${k} given more than once`);
    out[k] = v;
  }
  return out;
}

/**
 * Rejects state-changing browser requests from another origin. Requests without an Origin header
 * (non-browser clients) pass; browsers always send it on POST fetches and forms.
 */
export function assertSameOrigin(req, origin) {
  const o = req.headers.origin;
  if (o !== undefined && o !== origin) throw new HttpError(403, 'cross_origin', 'Cross-origin request refused');
}

/**
 * POST <prefix>/handover {n, c} and POST <prefix>/status {n}. Returns true when it handled the request.
 * The token arrives only in the POST body; it is never logged or echoed.
 */
export async function handleHandoverApi(req, res, path, { handover, origin, prefix = '/login', onVerified }) {
  if (req.method !== 'POST' || (path !== `${prefix}/handover` && path !== `${prefix}/status`)) return false;
  try {
    assertSameOrigin(req, origin);
    const body = await readJsonBody(req, 64 * 1024);
    const cookie = readCookie(req.headers.cookie);
    if (path === `${prefix}/status`) {
      const st = handover.status(body.n, cookie);
      const pub = st.status === 'verified' ? handover.peek(body.n, cookie).result?.public ?? {} : {};
      sendJson(res, 200, { ok: true, ...st, ...pub });
    } else {
      if (typeof body.c !== 'string' || !body.c.trim()) throw new HandoverError('no_token', 'Nothing was sent. Paste the session first.');
      const r = await handover.submit(body.n, cookie, body.c);
      const p = handover.peek(body.n, cookie);
      sendJson(res, 200, { ok: true, account: r.account, ...(p.result?.public ?? {}) });
      onVerified?.(body.n, p);
    }
  } catch (err) {
    if (err instanceof HandoverError) sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
    else if (err instanceof HttpError) sendJson(res, err.status, { ok: false, error: { code: err.code, message: err.message } });
    else sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'Something went wrong. Try again.' } });
  }
  return true;
}
