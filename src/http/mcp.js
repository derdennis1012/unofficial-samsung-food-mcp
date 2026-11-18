/**
 * MCP over Streamable HTTP (stateless: a fresh Server + transport per request), restricted to
 * the same tool selection as the REST API. Auth, body limits and content type are checked by the caller.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { callTool, listTools } from '../mcp/server.js';

export async function handleMcp(req, res, body, { tools, holder, version }) {
  const allowed = new Set(tools.map((t) => t.name));
  const server = new Server({ name: 'unofficial-samsung-food-mcp', version }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools().filter((t) => allowed.has(t.name)) }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    allowed.has(request.params.name)
      ? callTool(request.params.name, request.params.arguments, holder)
      : { isError: true, content: [{ type: 'text', text: `Unknown or disabled tool: ${request.params.name}` }] }
  );
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => {
    transport.close().catch(() => {});
    server.close().catch(() => {});
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}
