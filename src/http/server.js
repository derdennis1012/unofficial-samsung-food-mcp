/**
 * Local HTTP API next to the MCP server, generated from the same tool registry.
 *
 *   GET  /healthz            liveness, no API key, no account access
 *   GET  /v1/tools           tool list with annotations and JSON input schemas
 *   GET  /v1/tools/{name}    one tool
 *   POST /v1/tools/{name}    call a tool; JSON body = arguments -> { ok, data, text }
 *   GET  /openapi.json       OpenAPI 3.1, one operation per tool
 *   GET  /docs               static HTML page that renders /openapi.json (asks for the key)
 *   POST /mcp                MCP over Streamable HTTP (stateless), same tools and key
 *
 * Every route except /healthz and the data-free /docs shell needs `Authorization: Bearer <key>`.
 * The Samsung Food token and the API key are never returned or logged.
 */

import http from 'node:http';
import { ZodError } from 'zod';
import { TOOLS } from '../tools/index.js';
import { describeError, MAX_TEXT, clientHolder } from '../server.js';
import { GrpcError, TransportError } from '../grpc.js';
import { SchemaDriftError } from '../client.js';
import { LOGIN_HINT } from '../auth.js';
import { keyMatches, bearerToken } from './apikey.js';
import { buildOpenApi, describeTool, DOCS_HTML, DOCS_CSP } from './openapi.js';

export const MAX_BODY = 1024 * 1024;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_PORT = 8787;
export const RAW_TOOLS = new Set(['api_call']);

/** Whether a bind address only accepts local connections. */
export function isLoopback(host) {
  const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '::1' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h) || h === '::ffff:127.0.0.1';
}

/**
 * Throws unless the host is loopback or was given explicitly. Returns a warning text for an
 * explicit non-loopback host (the caller prints it), otherwise null.
 */
export function checkBindHost(host, { explicit = false } = {}) {
  if (isLoopback(host)) return null;
  if (!explicit) throw new Error(`Refusing to bind to non-loopback address ${host}; pass --host ${host} explicitly to expose the API on the network.`);
  return `WARNING: binding to ${host} exposes your Samsung Food account to the network. Anyone with the API key has full access; use TLS (reverse proxy) and a firewall.`;
}

/** The tools a server with these options exposes. */
export function selectTools(tools = TOOLS, { readOnly = false, allowRaw = false } = {}) {
  return tools.filter((t) => (allowRaw || !RAW_TOOLS.has(t.name)) && (!readOnly || t.annotations.readOnlyHint === true));
}

/** `--cors` value: exact origin (scheme://host[:port]) or "*". */
export function parseCorsOrigin(value) {
  if (value === undefined || value === null || value === false) return null;
  if (value === '*') return '*';
  let u;
  try {
    u = new URL(String(value));
  } catch {
    throw new Error(`--cors must be an origin like http://localhost:3000 or "*", got ${value}`);
  }
  if (!/^https?:$/.test(u.protocol) || u.origin !== String(value).replace(/\/$/, '')) {
    throw new Error(`--cors must be an origin like http://localhost:3000 (no path), got ${value}`);
  }
  return u.origin;
}

class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}

const GRPC_HTTP = { 3: [409, 'upstream_rejected'], 5: [404, 'upstream_not_found'], 6: [409, 'upstream_conflict'], 7: [403, 'upstream_forbidden'], 8: [429, 'upstream_rate_limited'], 9: [409, 'upstream_conflict'], 10: [409, 'upstream_conflict'], 16: [401, 'samsung_login_required'] };

/** HTTP status, error code and message for an error thrown while running a tool. */
export function mapError(err) {
  if (err instanceof HttpError) return { status: err.status, code: err.code, message: err.message, ...err.extra };
  if (err instanceof ZodError) {
    return { status: 400, code: 'validation_error', message: describeError(err), issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) };
  }
  if (err?.message === LOGIN_HINT) return { status: 401, code: 'samsung_login_required', message: LOGIN_HINT };
  if (err instanceof GrpcError) {
    const [status, code] = GRPC_HTTP[err.status] ?? [502, 'upstream_error'];
    return { status, code, message: describeError(err) };
  }
  if (err instanceof TransportError) return { status: err.timeout ? 504 : 502, code: err.timeout ? 'upstream_timeout' : 'upstream_unreachable', message: describeError(err) };
  if (err instanceof SchemaDriftError) return { status: 502, code: 'upstream_schema_drift', message: describeError(err) };
  return { status: 500, code: 'internal_error', message: describeError(err) };
}

/** Runs a tool like the MCP wrapper does, but lets errors through for the status mapping. */
async function runTool(tool, rawArgs, holder, timeoutMs) {
  const args = tool.schema.parse(rawArgs ?? {});
  const sf = tool.needsClient === false ? null : await holder.get();
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new HttpError(504, 'timeout', `The tool call took longer than ${Math.round(timeoutMs / 1000)} s.${tool.annotations.readOnlyHint ? '' : ' It may still complete - check before repeating a write.'}`)), timeoutMs);
  });
  try {
    const result = await Promise.race([tool.handler(args, sf), timeout]);
    const value = result === undefined ? { ok: true } : result;
    const data = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
    let text = JSON.stringify(value, null, 2);
    const truncated = text.length > MAX_TEXT;
    if (truncated) text = `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} characters; the full result is in data]`;
    return { ok: true, data, text, ...(truncated ? { truncated } : {}) };
  } finally {
    clearTimeout(timer);
  }
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const tooLarge = () => new HttpError(413, 'payload_too_large', `Request body larger than ${limit} bytes`);
    const chunks = [];
    let size = 0;
    let done = false;
    const declared = Number(req.headers['content-length']);
    if (Number.isFinite(declared) && declared > limit) {
      done = true;
      reject(tooLarge());
    }
    req.on('data', (c) => {
      size += c.length;
      // Overlong bodies are drained so the client still sees the 413; a sender that keeps going is cut off.
      if (done) {
        if (size > limit * 4) req.destroy();
        return;
      }
      if (size > limit) {
        done = true;
        reject(tooLarge());
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!done) resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', (err) => {
      if (!done) reject(err);
    });
  });
}

async function readJson(req, limit) {
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  const raw = await readBody(req, limit);
  if (!raw.trim()) return undefined;
  if (type !== 'application/json') throw new HttpError(415, 'unsupported_media_type', 'Content-Type must be application/json');
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError(400, 'invalid_json', 'Request body is not valid JSON');
  }
}

/**
 * @param {object} [o]
 * @param {boolean} [o.readOnly]   only tools with readOnlyHint
 * @param {boolean} [o.allowRaw]   also expose the raw api_call tool
 * @param {string}  o.apiKey       required bearer key
 * @param {string|null} [o.cors]   allowed origin ("*" or exact origin), null = no CORS
 * @param {boolean} [o.mcp]        serve MCP over Streamable HTTP at /mcp (default true)
 * @param {{get: () => Promise<any>}} [o.holder]  lazy client factory (tests inject a fake)
 * @param {Array} [o.tools]        registry (default: all tools)
 * @param {number} [o.toolTimeoutMs]
 * @param {(line: string) => void} [o.log]
 * @returns {http.Server}
 */
export function createApiServer({ readOnly = false, allowRaw = false, apiKey, cors = null, mcp = true, holder = clientHolder(), tools: registry = TOOLS, toolTimeoutMs = 120_000, maxBody = MAX_BODY, version = '0.0.0', log = () => {} } = {}) {
  if (!apiKey) throw new Error('createApiServer: apiKey is required');
  const tools = selectTools(registry, { readOnly, allowRaw });
  const byName = new Map(tools.map((t) => [t.name, t]));
  const mode = [readOnly && 'read-only', !allowRaw && 'without api_call'].filter(Boolean).join(', ');
  let openapi;

  const send = (res, status, body, headers = {}) => {
    const isString = typeof body === 'string';
    const payload = isString ? body : JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': isString ? 'text/html; charset=utf-8' : 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(payload), ...headers });
    res.end(payload);
  };
  const sendError = (res, e) => {
    const { status, ...error } = e;
    send(res, status, { ok: false, error });
  };

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method ?? 'GET';

    if (cors) {
      res.setHeader('Access-Control-Allow-Origin', cors);
      res.setHeader('Vary', 'Origin');
      if (method === 'OPTIONS') {
        res.writeHead(204, { 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Allow-Headers': 'Authorization, Content-Type, Mcp-Protocol-Version', 'Access-Control-Max-Age': '600' });
        return res.end();
      }
    }

    if (path === '/healthz' && method === 'GET') return send(res, 200, { ok: true, version, tools: tools.length, readOnly });
    if (path === '/docs' && method === 'GET') return send(res, 200, DOCS_HTML, { 'Content-Security-Policy': DOCS_CSP });

    if (!keyMatches(bearerToken(req.headers.authorization), apiKey)) {
      throw new HttpError(401, 'unauthorized', 'Missing or wrong API key. Send Authorization: Bearer <key> (sf serve --show-key).');
    }

    if (path === '/openapi.json' && method === 'GET') {
      openapi ??= buildOpenApi(tools, { version, readOnly });
      return send(res, 200, openapi);
    }
    if (path === '/v1/tools' && method === 'GET') return send(res, 200, { tools: tools.map(describeTool) });
    if (path === '/mcp' && mcp) {
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'This MCP endpoint is stateless: use POST only');
      const body = await readJson(req, maxBody);
      const { handleMcp } = await import('./mcp.js');
      return handleMcp(req, res, body, { tools, holder, version });
    }

    const m = /^\/v1\/tools\/([^/]+)$/.exec(path);
    if (m) {
      const name = decodeURIComponent(m[1]);
      const tool = byName.get(name);
      if (!tool) throw new HttpError(404, 'unknown_tool', `Unknown or disabled tool: ${name}${mode ? ` (server runs ${mode})` : ''}`);
      if (method === 'GET') return send(res, 200, describeTool(tool));
      if (method !== 'POST') throw new HttpError(405, 'method_not_allowed', 'Use POST to call a tool');
      const args = await readJson(req, maxBody);
      return send(res, 200, await runTool(tool, args, holder, toolTimeoutMs));
    }
    throw new HttpError(404, 'not_found', `No route for ${method} ${path}`);
  }

  const server = http.createServer((req, res) => {
    const started = Date.now();
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.on('finish', () => {
      // Path only: no query string, headers or bodies (they may carry keys or tokens).
      log(`${req.method} ${(req.url ?? '').split('?')[0]} ${res.statusCode} ${Date.now() - started}ms`);
    });
    route(req, res).catch((err) => {
      if (res.headersSent) return res.destroy();
      sendError(res, mapError(err));
    });
  });
  server.requestTimeout = 30_000; // receiving the request (headers + body)
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  server.exposedTools = tools;
  return server;
}
