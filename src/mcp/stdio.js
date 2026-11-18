#!/usr/bin/env node
/**
 * MCP server for Samsung Food (stdio).
 *
 * Meal plan, shopping list, recipes, collections, pantry, nutrition and account as
 * tools, plus raw access to all gRPC methods for everything else.
 * stdout carries the protocol; all logging goes to stderr.
 */

import fs from 'node:fs';

// `npx unofficial-samsung-food-mcp setup`: guided login and client configuration instead of the
// server. Without arguments nothing below this branch prints to stdout (it carries the protocol).
if (process.argv[2] === 'setup') {
  const { runSetupCli } = await import('../login/setup.js');
  try {
    await runSetupCli(process.argv.slice(3));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n`);
    process.exitCode = 1;
  }
} else {
  await startServer();
}

async function startServer() {
  const [{ Server }, { StdioServerTransport }, { CallToolRequestSchema, ListToolsRequestSchema }, { listTools, callTool, clientHolder }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/index.js'),
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('@modelcontextprotocol/sdk/types.js'),
    import('./server.js'),
  ]);
  const { version } = JSON.parse(fs.readFileSync(new URL('../../package.json', import.meta.url), 'utf8'));

  const log = (msg) => process.stderr.write(`samsung-food: ${msg}\n`);

  // A stray rejection or exception must never take the stdio server down.
  process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.message ?? err}`));
  process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.message ?? err}`));

  const holder = clientHolder();

  const server = new Server(
    { name: 'unofficial-samsung-food-mcp', version },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
  server.setRequestHandler(CallToolRequestSchema, async (request) =>
    callTool(request.params.name, request.params.arguments, holder)
  );

  await server.connect(new StdioServerTransport());
  log('MCP server running (stdio).');
}
