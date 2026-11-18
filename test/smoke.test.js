/**
 * Smoke tests over the real entry points (offline): the MCP server over stdio and the CLI.
 * Both run as child processes with an isolated SAMSUNG_FOOD_HOME that already holds the schema
 * fixture and no token, so nothing can reach the network or the user's real config.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function isolatedEnv() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-smoke-'));
  fs.copyFileSync(path.join(root, 'test/fixtures/schema.json'), path.join(home, 'schema.json'));
  const env = { ...process.env, SAMSUNG_FOOD_HOME: home };
  delete env.SAMSUNG_FOOD_TOKEN;
  return { home, env };
}

test('MCP server: initialize + tools/list over stdio', async () => {
  const { home, env } = isolatedEnv();
  const client = new Client({ name: 'smoke-test', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(root, 'src/index.js')],
    env,
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert.equal(client.getServerVersion().version, pkg.version);

    const { tools } = await client.listTools();
    assert.ok(tools.length > 0, 'server lists tools');
    assert.equal(new Set(tools.map((t) => t.name)).size, tools.length, 'tool names are unique');
    for (const t of tools) {
      assert.match(t.name, /^[a-z][a-z0-9_]*$/, `${t.name}: name`);
      assert.ok(t.description?.length > 10, `${t.name}: description`);
      assert.equal(t.inputSchema?.type, 'object', `${t.name}: inputSchema`);
      assert.equal(typeof t.annotations?.readOnlyHint, 'boolean', `${t.name}: readOnlyHint`);
      assert.equal(typeof t.annotations?.destructiveHint, 'boolean', `${t.name}: destructiveHint`);
    }
  } finally {
    await client.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('CLI: sf --help and sf help exit 0 without a token or network', () => {
  const { home, env } = isolatedEnv();
  try {
    for (const args of [['--help'], ['help'], []]) {
      const res = spawnSync(process.execPath, [path.join(root, 'bin/sf.js'), ...args], {
        env,
        encoding: 'utf8',
        timeout: 15000,
      });
      assert.equal(res.status, 0, `sf ${args.join(' ')}: ${res.stderr}`);
      assert.match(res.stdout, /sf - Samsung Food CLI/);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
