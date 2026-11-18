/**
 * OpenAPI 3.1 document and the /docs page, both generated from the tool registry.
 */

import crypto from 'node:crypto';
import { toJsonSchema } from '../tools/schema.js';

const AREAS = ['meal_plan', 'shopping_list', 'collection', 'recipe', 'pantry', 'foodlog', 'food', 'nutrition', 'account', 'auth', 'api'];
const LEGACY_AREA = { shopping_lists: 'shopping_list', collections_list: 'collection' };

/** Area of a tool, from its name prefix (used as OpenAPI tag). */
export function toolArea(name) {
  if (LEGACY_AREA[name]) return LEGACY_AREA[name];
  return AREAS.find((a) => name === a || name.startsWith(`${a}_`) || name.startsWith(`${a}s_`)) ?? name.split('_')[0];
}

/** Public view of a tool (no handler). */
export function describeTool(t) {
  return {
    name: t.name,
    area: toolArea(t.name),
    description: t.description,
    annotations: t.annotations,
    inputSchema: toJsonSchema(t.schema),
    example: t.example ?? {},
  };
}

const firstSentence = (s) => {
  const m = /^(.+?[.!?])(\s|$)/.exec(s);
  return (m ? m[1] : s).slice(0, 120);
};

const errorResponse = (description) => ({ description, content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' } } } });

export function buildOpenApi(tools, { version, readOnly = false } = {}) {
  const paths = {
    '/healthz': {
      get: {
        operationId: 'healthz',
        summary: 'Liveness check (no API key, no account access)',
        tags: ['meta'],
        security: [],
        responses: { 200: { description: 'Server is running', content: { 'application/json': { schema: { type: 'object' } } } } },
      },
    },
    '/v1/tools': {
      get: {
        operationId: 'listTools',
        summary: 'Lists the tools this server exposes, with annotations and JSON input schemas',
        tags: ['meta'],
        responses: {
          200: { description: 'Tool list', content: { 'application/json': { schema: { type: 'object', properties: { tools: { type: 'array', items: { $ref: '#/components/schemas/Tool' } } } } } } },
          401: errorResponse('Missing or wrong API key'),
        },
      },
    },
  };
  const usedTags = new Set();
  for (const t of tools) {
    const d = describeTool(t);
    usedTags.add(d.area);
    const a = t.annotations;
    const safe = a.readOnlyHint === true;
    const notes = [safe ? 'Read-only and safe to repeat.' : a.destructiveHint ? 'Destructive: removes or overwrites data.' : 'Changes data.', !safe && a.idempotentHint === false ? 'Not idempotent: repeating the call has a further effect.' : null].filter(Boolean);
    paths[`/v1/tools/${t.name}`] = {
      post: {
        operationId: t.name,
        summary: firstSentence(t.description),
        description: `${t.description}\n\n${notes.join(' ')}`,
        tags: [d.area],
        'x-safe': safe,
        'x-idempotent': a.idempotentHint === true,
        'x-mcp-annotations': a,
        requestBody: {
          required: Boolean(d.inputSchema.required?.length),
          content: { 'application/json': { schema: d.inputSchema, example: d.example } },
        },
        responses: {
          200: { description: 'Tool result', content: { 'application/json': { schema: { $ref: '#/components/schemas/ToolResult' } } } },
          400: errorResponse('Invalid arguments or invalid JSON'),
          401: errorResponse('Missing/wrong API key (code unauthorized) or Samsung Food login missing/expired (code samsung_login_required)'),
          404: errorResponse('Object not found upstream'),
          409: errorResponse('Request rejected by Samsung Food (conflict or invalid state)'),
          413: errorResponse('Request body larger than 1 MB'),
          415: errorResponse('Content-Type is not application/json'),
          502: errorResponse('Samsung Food unreachable or returned an unexpected response'),
          504: errorResponse('The tool call timed out'),
        },
      },
    };
  }
  return {
    openapi: '3.1.0',
    info: {
      title: 'Samsung Food local API (unofficial)',
      version: version ?? '0.0.0',
      description:
        'Local HTTP API generated from the same tool registry as the MCP server. Every tool is POST /v1/tools/{name} with the tool arguments as JSON body.' +
        (readOnly ? ' This server runs in read-only mode: only read tools are listed.' : ''),
    },
    servers: [{ url: '/' }],
    security: [{ bearerAuth: [] }],
    tags: [{ name: 'meta', description: 'Server endpoints' }, ...[...usedTags].sort().map((name) => ({ name }))],
    paths,
    components: {
      securitySchemes: { bearerAuth: { type: 'http', scheme: 'bearer', description: 'API key from `sf serve --show-key` or SAMSUNG_FOOD_API_KEY' } },
      schemas: {
        ToolResult: {
          type: 'object',
          required: ['ok', 'data', 'text'],
          properties: {
            ok: { const: true },
            data: { type: 'object', description: 'Structured result; arrays and scalars are wrapped as { result }' },
            text: { type: 'string', description: 'The same result as pretty JSON, truncated like the MCP text output' },
            truncated: { type: 'boolean' },
          },
        },
        Error: {
          type: 'object',
          required: ['ok', 'error'],
          properties: {
            ok: { const: false },
            error: {
              type: 'object',
              required: ['code', 'message'],
              properties: {
                code: { type: 'string', examples: ['validation_error', 'unauthorized', 'unknown_tool', 'samsung_login_required', 'upstream_error'] },
                message: { type: 'string' },
                issues: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, message: { type: 'string' } } } },
              },
            },
          },
        },
        Tool: {
          type: 'object',
          properties: {
            name: { type: 'string' },
            area: { type: 'string' },
            description: { type: 'string' },
            annotations: { type: 'object' },
            inputSchema: { type: 'object' },
            example: { type: 'object' },
          },
        },
      },
    },
  };
}

/*
 * /docs: a static shell without data. The page asks for the API key, fetches /openapi.json
 * (same origin) and renders it with textContent only, so tool texts can never inject markup.
 */
const DOCS_SCRIPT = `
const $ = (tag, text, cls) => { const e = document.createElement(tag); if (text != null) e.textContent = text; if (cls) e.className = cls; return e; };
async function load(ev) {
  ev.preventDefault();
  const out = document.getElementById('out');
  out.replaceChildren($('p', 'Loading...'));
  const key = document.getElementById('key').value.trim();
  const res = await fetch('openapi.json', { headers: { Authorization: 'Bearer ' + key } });
  if (!res.ok) { out.replaceChildren($('p', 'Error ' + res.status + ': check the API key (sf serve --show-key).', 'err')); return; }
  const spec = await res.json();
  const nodes = [$('h2', spec.info.title + ' ' + spec.info.version), $('p', spec.info.description)];
  const byTag = {};
  for (const [path, ops] of Object.entries(spec.paths)) for (const [method, op] of Object.entries(ops)) (byTag[op.tags[0]] ||= []).push([method, path, op]);
  for (const tag of Object.keys(byTag).sort()) {
    nodes.push($('h3', tag));
    for (const [method, path, op] of byTag[tag]) {
      const d = $('details');
      const s = $('summary');
      s.append($('code', method.toUpperCase() + ' ' + path), ' ', $('span', op['x-safe'] ? 'read-only' : (op['x-mcp-annotations']?.destructiveHint ? 'destructive' : (op['x-mcp-annotations'] ? 'write' : '')), 'badge'), ' ', $('span', op.summary || ''));
      d.append(s);
      if (op.description) d.append($('p', op.description));
      const body = op.requestBody?.content?.['application/json'];
      if (body) { d.append($('h4', 'Request body schema'), $('pre', JSON.stringify(body.schema, null, 2))); d.append($('h4', 'Example'), $('pre', JSON.stringify(body.example ?? {}, null, 2))); }
      d.append($('h4', 'curl'), $('pre', "curl -s -X " + method.toUpperCase() + " -H 'Authorization: Bearer $SF_API_KEY'" + (body ? " -H 'Content-Type: application/json' -d '" + JSON.stringify(body.example ?? {}) + "'" : '') + ' ' + location.origin + path));
      nodes.push(d);
    }
  }
  out.replaceChildren(...nodes);
}
document.getElementById('f').addEventListener('submit', (ev) => load(ev).catch((e) => { document.getElementById('out').replaceChildren($('p', String(e), 'err')); }));
`;

export const DOCS_CSP = `default-src 'none'; script-src 'sha256-${crypto.createHash('sha256').update(DOCS_SCRIPT).digest('base64')}'; style-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'`;

export const DOCS_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Samsung Food local API</title>
<style>
body{font:15px/1.5 system-ui,sans-serif;max-width:60rem;margin:2rem auto;padding:0 1rem;color:#222}
pre{background:#f4f4f4;padding:.6rem;overflow:auto;font-size:13px}
details{border-bottom:1px solid #ddd;padding:.3rem 0}summary{cursor:pointer}
.badge{font-size:12px;background:#e8eefc;border-radius:3px;padding:0 .3rem}.err{color:#b00}
input{width:28rem;max-width:100%;font:inherit}
</style></head><body>
<h1>Samsung Food local API</h1>
<p>Machine-readable spec: <code>GET /openapi.json</code>. Every request except <code>/healthz</code> needs <code>Authorization: Bearer &lt;key&gt;</code>; show the key with <code>sf serve --show-key</code>.</p>
<form id="f"><input id="key" type="password" autocomplete="off" placeholder="API key"> <button>Load</button></form>
<div id="out"></div>
<script>${DOCS_SCRIPT}</script>
</body></html>
`;
