/**
 * `sf serve` / `sf-api`: starts the local HTTP API from parsed CLI flags.
 *
 *   --host 127.0.0.1   bind address (non-loopback only when given explicitly, with a warning)
 *   --port 8787        0 = random free port
 *   --read-only        only read tools
 *   --allow-raw        also expose the raw api_call tool
 *   --cors <origin>    allow browser calls from this origin ("*" for any)
 *   --no-mcp           do not serve MCP over HTTP at /mcp
 *   --show-key         print the API key (creating it if needed) and exit
 *   --quiet            no request log on stderr
 */

import fs from 'node:fs';
import { createApiServer, checkBindHost, parseCorsOrigin, DEFAULT_HOST, DEFAULT_PORT } from './server.js';
import { loadOrCreateApiKey, API_KEY_FILE } from './apikey.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

export const SERVE_HELP = [
  'sf serve - local HTTP API (REST + OpenAPI + MCP over HTTP)',
  '',
  '  sf serve [--host 127.0.0.1] [--port 8787] [--read-only] [--allow-raw]',
  '           [--cors <origin>] [--no-mcp] [--quiet]',
  '  sf serve --show-key              print the API key and exit',
  '',
  `Requests need Authorization: Bearer <key> (stored in ${API_KEY_FILE},`,
  'or set SAMSUNG_FOOD_API_KEY). Docs: http://127.0.0.1:8787/docs',
].join('\n');

const err = (msg) => process.stderr.write(`${msg}\n`);

/** Resolves when the server listens; the process then stays alive until SIGINT/SIGTERM. */
export async function runServe(flags = {}) {
  if (flags.help) {
    console.log(SERVE_HELP);
    return null;
  }
  const { key, source, created } = loadOrCreateApiKey();
  if (flags['show-key']) {
    console.log(key);
    if (source === 'env') err('(from SAMSUNG_FOOD_API_KEY)');
    return null;
  }

  const hostExplicit = typeof flags.host === 'string';
  const host = hostExplicit ? flags.host : DEFAULT_HOST;
  const port = flags.port === undefined ? DEFAULT_PORT : Number(flags.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('--port must be a number between 0 and 65535');
  const warning = checkBindHost(host, { explicit: hostExplicit });
  const cors = parseCorsOrigin(flags.cors === true ? undefined : flags.cors);
  if (flags.cors === true) throw new Error('--cors needs an origin, e.g. --cors http://localhost:3000');

  const server = createApiServer({
    apiKey: key,
    readOnly: Boolean(flags['read-only']),
    allowRaw: Boolean(flags['allow-raw']),
    mcp: !flags['no-mcp'],
    cors,
    version,
    log: flags.quiet ? () => {} : (line) => err(`sf-api: ${line}`),
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  const addr = server.address();
  const shown = addr.family === 'IPv6' ? `[${addr.address}]` : addr.address;
  const base = `http://${shown}:${addr.port}`;

  if (warning) err(warning);
  if (created) err(`Created API key (stored in ${API_KEY_FILE}, shown only now; later: sf serve --show-key):\n  ${key}`);
  err(
    [
      `Samsung Food API listening on ${base}`,
      `  ${server.exposedTools.length} tools${flags['read-only'] ? ' (read-only)' : ''}${flags['allow-raw'] ? ', raw api_call enabled' : ''}${cors ? `, CORS for ${cors}` : ''}`,
      `  docs ${base}/docs  spec ${base}/openapi.json${flags['no-mcp'] ? '' : `  mcp ${base}/mcp`}`,
      `  key from ${source === 'env' ? 'SAMSUNG_FOOD_API_KEY' : API_KEY_FILE}`,
    ].join('\n')
  );

  // A stray rejection or exception must not take the server down.
  process.on('unhandledRejection', (e) => err(`sf-api: unhandled rejection: ${e?.message ?? e}`));
  process.on('uncaughtException', (e) => err(`sf-api: uncaught exception: ${e?.message ?? e}`));

  const stop = () => {
    server.close(() => process.exit(0));
    server.closeAllConnections?.();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  return server;
}

/** Minimal flag parser for the standalone entry (same rules as bin/sf.js). */
export function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) throw new Error(`Unexpected argument: ${a}`);
    const next = args[i + 1];
    if (next === undefined || next.startsWith('--')) flags[a.slice(2)] = true;
    else {
      flags[a.slice(2)] = next;
      i++;
    }
  }
  return flags;
}
