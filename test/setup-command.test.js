/**
 * `sf setup` / `unofficial-samsung-food-mcp setup`: client detection per OS, JSON merge with backup,
 * invalid JSON, dry run, --remove and the Claude Code CLI (a fake `claude` that records its argv).
 * Everything runs in temp dirs; login and GetMe are stubbed.
 */

import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectClients, findOnPath, planJsonChange, serverCommand, SERVER_NAME } from '../src/setup/clients.js';
import { runSetup, parseSelection, checkLogin } from '../src/login/setup.js';
import { SamsungFood } from '../src/client.js';
import { saveAuth, clearToken } from '../src/auth.js';
import { fakeSamsung, testSchema, TOKEN_A } from './hosted-helpers.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const win = process.platform === 'win32';
const NPX = { command: 'npx', args: ['-y', 'unofficial-samsung-food-mcp'] };
// what runSetup writes on the current OS (Windows wraps npx in cmd /c)
const HERE = process.platform === 'win32' ? { command: 'cmd', args: ['/c', 'npx', '-y', 'unofficial-samsung-food-mcp'] } : NPX;

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-setup-'));
  const home = path.join(dir, 'home');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(home);
  fs.mkdirSync(bin);
  return { dir, home, bin, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** A fake `claude` on PATH that appends its argv to argv.txt next to it. */
function fakeClaude(bin) {
  if (win) fs.writeFileSync(path.join(bin, 'claude.cmd'), '@echo %*>> "%~dp0argv.txt"\r\n');
  else fs.writeFileSync(path.join(bin, 'claude'), '#!/bin/sh\necho "$*" >> "$(dirname "$0")/argv.txt"\n', { mode: 0o755 });
  const log = path.join(bin, 'argv.txt');
  return () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split(/\r?\n/).map((l) => l.trim()).filter(Boolean) : []);
}

const pathEnv = (bin, extra = {}) => ({ PATH: bin, PATHEXT: '.CMD;.EXE', ...extra });

function collect() {
  const lines = [];
  return { out: (m) => lines.push(m), text: () => lines.join('\n') };
}

const loggedIn = async () => ({ account: 'Anna Test' });
const noLogin = () => {
  throw new Error('login must not run');
};

test('detection: config paths per OS and detection by directory / PATH', () => {
  const s = sandbox();
  try {
    const appdata = path.join(s.dir, 'AppData');
    const xdg = path.join(s.dir, 'xdg');
    const desktopFile = (base) => path.join(base, 'Claude', 'claude_desktop_config.json');

    const mac = detectClients({ platform: 'darwin', home: s.home, env: pathEnv(s.bin) });
    assert.equal(mac.find((c) => c.id === 'claude-desktop').file, desktopFile(path.join(s.home, 'Library', 'Application Support')));
    assert.equal(mac.find((c) => c.id === 'cursor').file, path.join(s.home, '.cursor', 'mcp.json'));
    assert.ok(mac.every((c) => !c.detected), 'nothing installed yet');

    const winC = detectClients({ platform: 'win32', home: s.home, env: pathEnv(s.bin, { APPDATA: appdata }) });
    assert.equal(winC.find((c) => c.id === 'claude-desktop').file, desktopFile(appdata));

    const linux = detectClients({ platform: 'linux', home: s.home, env: pathEnv(s.bin) });
    assert.equal(linux.find((c) => c.id === 'claude-desktop').file, desktopFile(path.join(s.home, '.config')));
    const linuxXdg = detectClients({ platform: 'linux', home: s.home, env: pathEnv(s.bin, { XDG_CONFIG_HOME: xdg }) });
    assert.equal(linuxXdg.find((c) => c.id === 'claude-desktop').file, desktopFile(xdg));

    // Installed = the app's config directory exists, or the CLI is on PATH.
    fs.mkdirSync(path.join(appdata, 'Claude'), { recursive: true });
    fs.mkdirSync(path.join(s.home, '.cursor'));
    fakeClaude(s.bin);
    const found = detectClients({ platform: process.platform, home: s.home, env: pathEnv(s.bin, { APPDATA: appdata, XDG_CONFIG_HOME: appdata }) });
    const byId = Object.fromEntries(found.map((c) => [c.id, c]));
    assert.equal(byId.cursor.detected, true);
    assert.equal(byId['claude-code'].detected, true);
    assert.equal(byId['claude-code'].bin, findOnPath('claude', { env: pathEnv(s.bin) }));
    assert.equal(byId.vscode.detected, false);
    if (process.platform !== 'darwin') assert.equal(byId['claude-desktop'].detected, true);
  } finally {
    s.cleanup();
  }
});

test('setup --yes: merges into JSON configs keeping other servers, makes a backup, calls claude mcp add', async () => {
  const s = sandbox();
  try {
    const argv = fakeClaude(s.bin);
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor));
    const original = JSON.stringify({ theme: 'dark', mcpServers: { other: { command: 'x', args: ['1'] }, [SERVER_NAME]: { command: 'old' } } }, null, 2);
    fs.writeFileSync(cursor, original);
    const desktopDir = path.join(s.dir, 'cfg', 'Claude');
    fs.mkdirSync(desktopDir, { recursive: true });
    const env = pathEnv(s.bin, { APPDATA: path.join(s.dir, 'cfg'), XDG_CONFIG_HOME: path.join(s.dir, 'cfg') });
    const clients = detectClients({ home: s.home, env, platform: process.platform === 'darwin' ? 'linux' : process.platform });

    const o = collect();
    const res = await runSetup({ yes: true, out: o.out, check: loggedIn, login: noLogin, clients, home: s.home, now: new Date('2026-11-18T10:20:30Z') });
    assert.deepEqual(res.configured.sort(), ['claude-code', 'claude-desktop', 'cursor']);
    assert.match(o.text(), /Connected as Anna Test/);
    assert.match(o.text(), /What's on my meal plan this week\?/);
    assert.match(o.text(), /docs\/hosted\.md/);

    const merged = JSON.parse(fs.readFileSync(cursor, 'utf8'));
    assert.equal(merged.theme, 'dark');
    assert.deepEqual(merged.mcpServers.other, { command: 'x', args: ['1'] });
    assert.deepEqual(merged.mcpServers[SERVER_NAME], HERE);
    assert.equal(fs.readFileSync(`${cursor}.bak-20261118-102030`, 'utf8'), original);

    const desktop = JSON.parse(fs.readFileSync(path.join(desktopDir, 'claude_desktop_config.json'), 'utf8'));
    assert.deepEqual(desktop, { mcpServers: { [SERVER_NAME]: HERE } });
    assert.deepEqual(fs.readdirSync(desktopDir), ['claude_desktop_config.json'], 'new file: no backup, no temp file left');

    assert.deepEqual(argv(), [`mcp add --scope user samsung-food -- ${[HERE.command, ...HERE.args].join(' ')}`]);

    // Second run: nothing to do for the JSON files.
    const again = collect();
    await runSetup({ yes: true, out: again.out, check: loggedIn, login: noLogin, clients, home: s.home });
    assert.match(again.text(), /Cursor: already set up/);
  } finally {
    s.cleanup();
  }
});

test('setup: invalid JSON is never touched; the snippet is printed instead', async () => {
  const s = sandbox();
  try {
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor));
    fs.writeFileSync(cursor, '{ "mcpServers": { broken ');
    const clients = detectClients({ home: s.home, env: pathEnv(s.bin), platform: 'linux' });
    const o = collect();
    await runSetup({ yes: true, out: o.out, check: loggedIn, login: noLogin, clients, home: s.home });
    assert.equal(fs.readFileSync(cursor, 'utf8'), '{ "mcpServers": { broken ');
    assert.deepEqual(fs.readdirSync(path.dirname(cursor)), ['mcp.json']);
    assert.match(o.text(), /not valid JSON/);
    assert.match(o.text(), /"samsung-food"/);
    assert.throws(() => planJsonChange(cursor, { cmd: NPX }), /not valid JSON/);
    fs.writeFileSync(cursor, '{"mcpServers": []}');
    assert.throws(() => planJsonChange(cursor, { cmd: NPX }), /not an object/);
  } finally {
    s.cleanup();
  }
});

test('setup --dry-run writes nothing, runs nothing and does not log in', async () => {
  const s = sandbox();
  try {
    const argv = fakeClaude(s.bin);
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor));
    fs.writeFileSync(cursor, '{"mcpServers":{"other":{"command":"x"}}}');
    const clients = detectClients({ home: s.home, env: pathEnv(s.bin), platform: 'linux' });
    const o = collect();
    await runSetup({ dryRun: true, out: o.out, check: async () => null, login: noLogin, clients, home: s.home });
    assert.equal(fs.readFileSync(cursor, 'utf8'), '{"mcpServers":{"other":{"command":"x"}}}');
    assert.deepEqual(fs.readdirSync(path.dirname(cursor)), ['mcp.json']);
    assert.deepEqual(argv(), []);
    assert.match(o.text(), /would open the browser login/);
    assert.match(o.text(), /would add "samsung-food" in ~.*mcp\.json, keeping 1 other server/);
    assert.match(o.text(), /would run {2}claude mcp add --scope user samsung-food/);
  } finally {
    s.cleanup();
  }
});

test('setup: not logged in runs the browser login; no terminal without --yes changes nothing', async () => {
  const s = sandbox();
  try {
    fs.mkdirSync(path.join(s.home, '.cursor'));
    const clients = detectClients({ home: s.home, env: pathEnv(s.bin), platform: 'linux' });
    let opened;
    const o = collect();
    await assert.rejects(
      runSetup({ isTTY: false, out: o.out, check: async () => null, login: async ({ open }) => ((opened = open), { account: 'Ben' }), clients, home: s.home }),
      /--yes/
    );
    assert.equal(opened, true);
    assert.match(o.text(), /Connected as Ben/);
    assert.equal(fs.existsSync(path.join(s.home, '.cursor', 'mcp.json')), false);

    // Interactive: the checklist answer decides; "n" writes nothing.
    const n = collect();
    await runSetup({ isTTY: true, ask: async () => 'n', out: n.out, check: loggedIn, login: noLogin, clients, home: s.home });
    assert.match(n.text(), /Nothing changed/);
    assert.equal(fs.existsSync(path.join(s.home, '.cursor', 'mcp.json')), false);
    await assert.rejects(runSetup({ nodeVersion: '18.19.0', out: () => {}, check: loggedIn, clients }), /Node\.js 20 or newer/);
  } finally {
    s.cleanup();
  }
});

test('setup --remove takes out only our entries (with backup) and calls claude mcp remove', async () => {
  const s = sandbox();
  try {
    const argv = fakeClaude(s.bin);
    const cursor = path.join(s.home, '.cursor', 'mcp.json');
    fs.mkdirSync(path.dirname(cursor));
    fs.writeFileSync(cursor, JSON.stringify({ mcpServers: { other: { command: 'x' }, [SERVER_NAME]: NPX } }));
    const clients = detectClients({ home: s.home, env: pathEnv(s.bin), platform: 'linux' });
    const o = collect();
    await runSetup({ remove: true, yes: true, out: o.out, check: noLogin, login: noLogin, clients, home: s.home });
    assert.deepEqual(JSON.parse(fs.readFileSync(cursor, 'utf8')), { mcpServers: { other: { command: 'x' } } });
    assert.equal(fs.readdirSync(path.dirname(cursor)).filter((f) => f.startsWith('mcp.json.bak-')).length, 1);
    assert.deepEqual(argv(), ['mcp remove --scope user samsung-food']);

    const again = collect();
    await runSetup({ remove: true, yes: true, out: again.out, check: noLogin, login: noLogin, clients, home: s.home });
    assert.match(again.text(), /Cursor: nothing to remove/);
  } finally {
    s.cleanup();
  }
});

test('setup: the login check asks GetMe with the stored session', async () => {
  const schema = testSchema();
  const samsung = fakeSamsung(schema);
  const sf = () => new SamsungFood({ schema, transport: samsung.transport });
  clearToken();
  assert.equal(await checkLogin({ client: sf() }), null, 'no session');
  saveAuth({ accessToken: TOKEN_A, expiresAt: new Date(Date.now() + 13 * 86400e3).toISOString() });
  assert.deepEqual(await checkLogin({ client: sf() }), { account: 'Anna Test' });
  assert.ok(samsung.calls.some((c) => c.method === 'whisk.x.user.v1.UserAPI/GetMe'));
  saveAuth({ accessToken: 'X'.repeat(48), expiresAt: new Date(Date.now() + 13 * 86400e3).toISOString() });
  assert.equal(await checkLogin({ client: sf() }), null, 'rejected session = log in again');
  clearToken();
});

test('setup helpers: checklist answers and --local command', () => {
  assert.deepEqual(parseSelection('', 3), [0, 1, 2]);
  assert.deepEqual(parseSelection('n', 3), []);
  assert.deepEqual(parseSelection('3, 1', 3), [0, 2]);
  assert.throws(() => parseSelection('4', 3), /not one of 1-3/);
  const local = serverCommand({ local: true });
  assert.equal(local.command, process.execPath);
  assert.equal(local.args[0], path.join(root, 'src', 'index.js'));
  assert.deepEqual(serverCommand({ platform: 'linux' }), NPX);
});

test('MCP bin: `setup` runs setup instead of the stdio server', () => {
  const s = sandbox();
  try {
    fs.copyFileSync(path.join(tmpHome, 'schema.json'), path.join(s.dir, 'schema.json'));
    const env = { ...process.env, HOME: s.home, USERPROFILE: s.home, APPDATA: path.join(s.dir, 'none'), XDG_CONFIG_HOME: path.join(s.dir, 'none'), PATH: s.bin, SAMSUNG_FOOD_HOME: s.dir };
    delete env.SAMSUNG_FOOD_TOKEN;
    const res = spawnSync(process.execPath, [path.join(root, 'src/index.js'), 'setup', '--dry-run'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /Dry run/);
    assert.match(res.stdout, /No MCP client found/);
    assert.doesNotMatch(res.stdout, /jsonrpc/);
    assert.doesNotMatch(res.stderr, /MCP server running/);

    const bad = spawnSync(process.execPath, [path.join(root, 'src/index.js'), 'setup', '--nope'], { env, encoding: 'utf8', timeout: 15000 });
    assert.equal(bad.status, 1);
    assert.match(bad.stderr, /Unknown option --nope/);
  } finally {
    s.cleanup();
  }
});

test('serverCommand wraps npx in cmd /c on Windows only', async () => {
  const { serverCommand, PACKAGE_NAME } = await import('../src/setup/clients.js');
  assert.deepEqual(serverCommand({ platform: 'win32' }), { command: 'cmd', args: ['/c', 'npx', '-y', PACKAGE_NAME] });
  assert.deepEqual(serverCommand({ platform: 'darwin' }), { command: 'npx', args: ['-y', PACKAGE_NAME] });
});
