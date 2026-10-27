/**
 * MCP server core: tool listing and a call wrapper that turns every outcome into
 * a protocol-level result (text + structuredContent, or an isError result with an
 * actionable message). Nothing here throws to the transport.
 */

import { ZodError } from 'zod';
import { SamsungFood } from './client.js';
import { GrpcError, TransportError } from './grpc.js';
import { TOOLS } from './tools/index.js';
import { toJsonSchema } from './tools/schema.js';

export const MAX_TEXT = 40000;

export function listTools() {
  return TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: toJsonSchema(t.schema),
    annotations: t.annotations,
  }));
}

/** User-facing message for any error; never a stack trace. */
export function describeError(err) {
  if (err instanceof ZodError) {
    const issues = err.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`);
    return `Invalid arguments - ${issues.join('; ')}`;
  }
  if (err instanceof GrpcError) {
    const hint =
      err.status === 5
        ? ' (not found - check the ID)'
        : err.status === 3
          ? ' (the server rejected the request arguments)'
          : err.status === 7
            ? ' (not allowed - e.g. the object belongs to someone else or needs a premium plan)'
            : err.status === 12
              ? ' (method not available; try `sf schema update`)'
              : '';
    return `${err.message}${hint}`;
  }
  if (err instanceof TransportError) {
    return `${err.message}. The request ${err.reachedServer === false ? 'was not sent' : 'may or may not have been processed - check before repeating a write'}.`;
  }
  return String(err?.message ?? err);
}

function packResult(result) {
  const value = result === undefined ? { ok: true } : result;
  const structured = value !== null && typeof value === 'object' && !Array.isArray(value) ? value : { result: value };
  let text = JSON.stringify(value, null, 2);
  const content = [];
  if (text.length > MAX_TEXT) {
    text = `${text.slice(0, MAX_TEXT)}\n... [truncated ${text.length - MAX_TEXT} characters; narrow the request with limit/filters/ids to see the rest]`;
    content.push({ type: 'text', text });
    return { content };
  }
  content.push({ type: 'text', text });
  return { content, structuredContent: structured };
}

/**
 * @param {string} name
 * @param {unknown} rawArgs
 * @param {{get: () => Promise<SamsungFood>}} holder  lazy client factory
 */
export async function callTool(name, rawArgs, holder) {
  const tool = TOOLS.find((t) => t.name === name);
  if (!tool) {
    return { isError: true, content: [{ type: 'text', text: `Unknown tool: ${name}` }] };
  }
  try {
    const args = tool.schema.parse(rawArgs ?? {});
    // Tools that never talk to the API (auth_status) must not wait for the schema.
    const sf = tool.needsClient === false ? null : await holder.get();
    return packResult(await tool.handler(args, sf));
  } catch (err) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${describeError(err)}` }] };
  }
}

/** Lazily creates one shared client (building the schema can take a few seconds). */
export function clientHolder() {
  let promise = null;
  return {
    get() {
      promise ??= SamsungFood.create({ backgroundSchemaRefresh: true }).catch((err) => {
        promise = null;
        throw err;
      });
      return promise;
    },
  };
}
