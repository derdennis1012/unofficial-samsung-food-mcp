/**
 * MCP over Streamable HTTP for one authenticated grant (stateless: a fresh Server + transport per
 * request). Tool arguments and results pass through memory only; nothing here logs them.
 */

import { z } from 'zod';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools } from '../server.js';
import { TOOLS } from '../tools/index.js';
import { defineTool } from '../tools/util.js';
import { LOGIN_HINT } from '../auth.js';

/** Not offered by the hosted connector: raw API access and the local login/status tools. */
export const HOSTED_EXCLUDED = /^(api_|auth_)/;

export const INSTRUCTIONS =
  'Unofficial connector for the Samsung Food account of the signed-in user: meal plan, shopping lists, recipes, collections and pantry. ' +
  'Tools marked read-only only read. All others change real data in the account: tell the user what you are about to change and ask first. ' +
  'Dates are YYYY-MM-DD; IDs come from the list, get and search tools.';

/**
 * The hosted tool registry for one grant. A read-only grant may only disconnect itself: deleting
 * the other connections and the registration is a write the grant was not given.
 */
export function hostedTools({ readOnly, disconnect }) {
  const base = TOOLS.filter((t) => !HOSTED_EXCLUDED.test(t.name) && (!readOnly || t.annotations.readOnlyHint === true));
  const own = readOnly
    ? defineTool({
        name: 'connector_disconnect',
        kind: 'destructive',
        needsClient: false,
        description:
          'Disconnects this Samsung Food connector: revokes the access of this app and deletes the stored (encrypted) Samsung session of this connection. Other connections of the account stay (this connection is read-only). Only on the explicit request of the user.',
        schema: z.object({}),
        handler: async () => disconnect(false),
      })
    : defineTool({
        name: 'connector_disconnect',
        kind: 'destructive',
        needsClient: false,
        description:
          'Disconnects this Samsung Food connector: revokes the access of this app and deletes the stored (encrypted) Samsung session. With everything=true, all connections of this account and its registration on the connector are deleted too. Only on the explicit request of the user.',
        schema: z.object({ everything: z.boolean().default(false).describe('Also delete all other connections and the account registration') }),
        handler: async (a) => disconnect(a.everything),
      });
  return [...base, own];
}

/**
 * @param {object} o
 * @param {Array} o.tools
 * @param {{get: () => Promise<any>}} o.holder
 * @param {string} o.version
 * @param {string} o.expiredText     message for a Samsung session that is no longer accepted
 * @param {string} o.challenge       WWW-Authenticate value for the ChatGPT re-link hint
 * @param {() => void} o.onExpired   marks the grant as expired
 */
export async function handleHostedMcp(req, res, body, { tools, holder, version, expiredText, challenge, onExpired, name }) {
  const server = new Server({ name: 'unofficial-samsung-food-mcp', title: name, version }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });
  const listed = listTools(tools);
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listed }));
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const result = await callTool(request.params.name, request.params.arguments, holder, tools);
    if (result.isError && result.content?.[0]?.text?.includes(LOGIN_HINT)) {
      onExpired();
      return { isError: true, content: [{ type: 'text', text: expiredText }], _meta: { 'mcp/www_authenticate': [challenge] } };
    }
    return result;
  });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
