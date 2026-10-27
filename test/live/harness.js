/**
 * Live test harness: starts the real MCP server over stdio against the account in
 * the config dir and exposes a small `ctx` to the area modules.
 *
 * Safety rules for area modules (enforced by review, not by code):
 *  - only create throwaway objects whose name starts with ctx.prefix ("mcp-test-<timestamp>")
 *  - never modify, check, delete or move pre-existing objects
 *  - clean up in `finally`; `cleanup(ctx)` must also find and remove leftovers of earlier runs
 *    (anything named "mcp-test-*")
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '../..');

export const PREFIX = 'mcp-test-';

export async function startMcp() {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/index.js')],
    env: { ...process.env },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'samsung-food-live-test', version: '0' });
  await client.connect(transport);

  const raw = async (name, args = {}) => {
    const res = await client.callTool({ name, arguments: args });
    const text = res.content?.map((c) => c.text).join('\n') ?? '';
    return { isError: Boolean(res.isError), text, data: res.structuredContent ?? safeJson(text), res };
  };

  const ts = Date.now();
  const ctx = {
    ts,
    prefix: `${PREFIX}${ts}`,
    raw,
    /** Calls a tool and returns its data; throws if the tool reports an error. */
    async call(name, args = {}) {
      const r = await raw(name, args);
      if (r.isError) throw new Error(`${name} failed: ${r.text}`);
      return r.data;
    },
    log: (m) => console.log(`    ${m}`),
    assert(cond, msg) {
      if (!cond) throw new Error(`assertion failed: ${msg}`);
    },
    /** A date roughly one year ahead (+ offset days), YYYY-MM-DD. */
    futureDate(offsetDays = 0) {
      const d = new Date(Date.now() + (365 + offsetDays) * 86400000);
      return d.toISOString().slice(0, 10);
    },
    async tools() {
      return (await client.listTools()).tools;
    },
    isTestName: (n) => typeof n === 'string' && n.startsWith(PREFIX),
  };
  return { ctx, client, close: () => client.close() };
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
