/**
 * Configuration of the hosted connector, from environment variables (see docs/hosted.md).
 */

import fs from 'node:fs';
import path from 'node:path';
import { parseMasterKey } from './crypto.js';

const bool = (v, def) => (v === undefined || v === '' ? def : /^(1|true|yes|on)$/i.test(String(v)));
function num(env, name, def, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const v = env[name];
  if (v === undefined || v === '') return def;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${name} must be a number between ${min} and ${max}`);
  return n;
}
const list = (v, def) => (v === undefined ? def : String(v).split(',').map((s) => s.trim().toLowerCase()).filter(Boolean));

/**
 * Redirect hosts of the hosted apps of ChatGPT (chatgpt.com, e.g. the legacy
 * /connector_platform_oauth_redirect) and Claude (claude.ai/api/mcp/auth_callback; claude.com for
 * its newer surfaces). Loopback redirects (Claude Code and other native clients, RFC 8252) are
 * always allowed on top.
 */
export const KNOWN_REDIRECT_HOSTS = ['chatgpt.com', 'claude.ai', 'claude.com'];
/**
 * Hosts of the Client ID Metadata Documents of ChatGPT (https://chatgpt.com/oauth/<id>/client.json)
 * and Claude (https://claude.ai/oauth/claude-code-client-metadata and the claude.ai client).
 */
export const KNOWN_CIMD_HOSTS = ['chatgpt.com', 'claude.ai', 'claude.com'];

/** Whether a host name is a loopback name or address. */
export const isLoopbackHost = (h) => /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])$/i.test(h);

/** Validates SF_HOST_PUBLIC_URL: an origin (no path), https unless loopback. */
export function parsePublicUrl(value) {
  if (!value) throw new Error('SF_HOST_PUBLIC_URL is required, e.g. https://food-mcp.example.com');
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new Error(`SF_HOST_PUBLIC_URL is not a URL: ${value}`);
  }
  if (u.pathname !== '/' || u.search || u.hash || u.username || u.password) throw new Error('SF_HOST_PUBLIC_URL must be an origin without path, e.g. https://food-mcp.example.com');
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && isLoopbackHost(u.hostname))) throw new Error('SF_HOST_PUBLIC_URL must use https (http only for localhost tests)');
  return u.origin;
}

function readKey(env) {
  if (env.SF_HOST_MASTER_KEY) return parseMasterKey(env.SF_HOST_MASTER_KEY);
  if (env.SF_HOST_MASTER_KEY_FILE) return parseMasterKey(fs.readFileSync(env.SF_HOST_MASTER_KEY_FILE, 'utf8'));
  throw new Error('SF_HOST_MASTER_KEY (or SF_HOST_MASTER_KEY_FILE) is required. Create one with: sf host keygen');
}

/** Legal pages: a URL (redirect) or a file (served as HTML if it ends in .html, else as plain text). */
function page(env, name) {
  const url = env[`SF_HOST_${name}_URL`];
  const file = env[`SF_HOST_${name}_FILE`];
  if (url) {
    const u = new URL(url);
    if (!/^https?:$/.test(u.protocol)) throw new Error(`SF_HOST_${name}_URL must be http(s)`);
    return { url: u.href };
  }
  if (file) return { file: path.resolve(file) };
  return null;
}

export function loadConfig(env = process.env) {
  const publicUrl = parsePublicUrl(env.SF_HOST_PUBLIC_URL);
  return {
    publicUrl,
    masterKey: readKey(env),
    dataDir: path.resolve(env.SF_HOST_DATA_DIR || './data'),
    bind: env.SF_HOST_BIND || '127.0.0.1',
    port: num(env, 'SF_HOST_PORT', 8788, { max: 65535 }),
    /** Number of reverse proxies in front whose X-Forwarded-For entries are trusted (0 = ignore the header). */
    trustProxy: num(env, 'SF_HOST_TRUST_PROXY', 0, { max: 5 }),
    name: env.SF_HOST_NAME || 'Samsung Food connector',
    operator: env.SF_HOST_OPERATOR || '',
    inviteRequired: bool(env.SF_HOST_INVITE_REQUIRED, true),
    readOnly: bool(env.SF_HOST_READ_ONLY, false),
    accessTtlSec: num(env, 'SF_HOST_ACCESS_TTL', 3600, { min: 60, max: 86400 }),
    refreshTtlDays: num(env, 'SF_HOST_REFRESH_TTL_DAYS', 30, { min: 1, max: 365 }),
    inactivityDays: num(env, 'SF_HOST_INACTIVITY_DAYS', 30, { min: 1, max: 365 }),
    toolCallsPerMinute: num(env, 'SF_HOST_RATE_PER_MIN', 60, { min: 1, max: 10000 }),
    upstreamConcurrency: num(env, 'SF_HOST_UPSTREAM_CONCURRENCY', 8, { min: 1, max: 256 }),
    maxClients: num(env, 'SF_HOST_MAX_CLIENTS', 10000, { min: 1 }),
    /**
     * Exact https redirect host allowlist for DCR clients and CIMD documents; loopback is always
     * allowed. "*" = any https host (unsafe: anyone can then show any name on the consent page and
     * receive the code), "" = loopback only.
     */
    redirectHosts: list(env.SF_HOST_REDIRECT_HOSTS, KNOWN_REDIRECT_HOSTS),
    /** Hosts whose Client ID Metadata Documents are fetched; "*" = any public host, "" disables CIMD. */
    cimdHosts: list(env.SF_HOST_CIMD_HOSTS, KNOWN_CIMD_HOSTS),
    pages: { privacy: page(env, 'PRIVACY'), terms: page(env, 'TERMS'), imprint: page(env, 'IMPRINT') },
    locale: env.SAMSUNG_FOOD_LOCALE || 'en-US',
  };
}
