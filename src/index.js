#!/usr/bin/env node
/**
 * MCP server for Samsung Food (stdio).
 *
 * Meal plan, shopping list, recipes, collections, pantry, nutrition and account as
 * tools, plus raw access to all gRPC methods for everything else.
 * stdout carries the protocol; all logging goes to stderr.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import fs from 'node:fs';
import { listTools, callTool, clientHolder } from './server.js';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8'));

const log = (msg) => process.stderr.write(`samsung-food: ${msg}\n`);

// A stray rejection or exception must never take the stdio server down.
process.on('unhandledRejection', (err) => log(`unhandled rejection: ${err?.message ?? err}`));
process.on('uncaughtException', (err) => log(`uncaught exception: ${err?.message ?? err}`));

const holder = clientHolder();

const server = new Server(
  { name: 'samsung-food', version },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: listTools() }));
server.setRequestHandler(CallToolRequestSchema, async (request) =>
  callTool(request.params.name, request.params.arguments, holder)
);

await server.connect(new StdioServerTransport());
log('MCP server running (stdio).');
