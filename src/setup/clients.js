/**
 * MCP client detection and configuration for `sf setup`: Claude Code (through its `claude` CLI),
 * Claude Desktop and Cursor (JSON config files), VS Code (snippet only: its user-level MCP file
 * differs between harnesses, so we print instead of guessing).
 *
 * JSON configs: only our `samsung-food` entry is added, replaced or removed; everything else stays.
 * Writes are atomic (temp file + rename) with a timestamped backup next to the file. A file that is
 * not valid JSON is never touched.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const SERVER_NAME = 'samsung-food';
export const PACKAGE_NAME = 'unofficial-samsung-food-mcp';
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

/** The command a client should start: npx (default) or this checkout with the current node (`--local`). */
export function serverCommand({ local = false, platform = process.platform } = {}) {
  if (local) return { command: process.execPath, args: [path.join(ROOT, 'src', 'index.js')] };
  // On Windows, npx is a .cmd shim that GUI clients cannot spawn directly.
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'npx', '-y', PACKAGE_NAME] };
  return { command: 'npx', args: ['-y', PACKAGE_NAME] };
}

/** Absolute path of an executable on PATH, or null. */
export function findOnPath(name, { env = process.env, platform = process.platform } = {}) {
  const win = platform === 'win32';
  const dirs = String(env.PATH ?? env.Path ?? '').split(win ? ';' : ':').filter(Boolean);
  const exts = win ? String(env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean) : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.join(dir, name + ext);
      try {
        if (!fs.statSync(file).isFile()) continue;
        if (!win) fs.accessSync(file, fs.constants.X_OK);
        return file;
      } catch {
        // not here
      }
    }
  }
  return null;
}

/** Per-OS base directory for application config (macOS Application Support, %APPDATA%, XDG). */
function appConfigDir({ platform, home, env }) {
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support');
  if (platform === 'win32') return env.APPDATA || path.join(home, 'AppData', 'Roaming');
  return env.XDG_CONFIG_HOME || path.join(home, '.config');
}

/**
 * Known clients and whether they look installed.
 * @returns {Array<{id: string, name: string, kind: 'cli'|'json'|'manual', detected: boolean, bin?: string, file?: string, restart: string}>}
 */
export function detectClients({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  const base = appConfigDir({ platform, home, env });
  const claudeBin = findOnPath('claude', { env, platform });
  const desktop = path.join(base, 'Claude', 'claude_desktop_config.json');
  const cursor = path.join(home, '.cursor', 'mcp.json');
  const vscodeDir = path.join(base, 'Code', 'User');
  return [
    { id: 'claude-code', name: 'Claude Code', kind: 'cli', detected: Boolean(claudeBin), bin: claudeBin ?? undefined, restart: 'start a new Claude Code session' },
    { id: 'claude-desktop', name: 'Claude Desktop', kind: 'json', detected: fs.existsSync(path.dirname(desktop)), file: desktop, restart: 'quit and restart Claude Desktop' },
    { id: 'cursor', name: 'Cursor', kind: 'json', detected: fs.existsSync(path.dirname(cursor)), file: cursor, restart: 'restart Cursor' },
    { id: 'vscode', name: 'VS Code', kind: 'manual', detected: fs.existsSync(vscodeDir) || Boolean(findOnPath('code', { env, platform })), restart: 'reload VS Code' },
  ];
}

/** `{ "mcpServers": { "samsung-food": … } }`, or the VS Code shape (`servers` + `type`). */
export function configSnippet(cmd, { vscode = false } = {}) {
  const doc = vscode ? { servers: { [SERVER_NAME]: { type: 'stdio', ...cmd } } } : { mcpServers: { [SERVER_NAME]: cmd } };
  return JSON.stringify(doc, null, 2);
}

export class ConfigError extends Error {}

/** Parses a client config; a missing or empty file is `{}`. Throws ConfigError on anything we must not touch. */
export function readConfig(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { exists: false, config: {} };
    throw new ConfigError(`cannot read it (${err.code ?? err.message})`);
  }
  if (!text.trim()) return { exists: true, config: {} };
  let config;
  try {
    config = JSON.parse(text);
  } catch (err) {
    throw new ConfigError(`it is not valid JSON (${err.message})`);
  }
  const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(config)) throw new ConfigError('it does not contain a JSON object');
  if (config.mcpServers !== undefined && !isObject(config.mcpServers)) throw new ConfigError('its "mcpServers" is not an object');
  return { exists: true, config };
}

/**
 * Works out the change for one JSON config without writing.
 * @returns {{action: 'add'|'update'|'unchanged'|'remove'|'absent', config: object, exists: boolean, others: number}}
 */
export function planJsonChange(file, { cmd, remove = false }) {
  const { exists, config } = readConfig(file);
  const servers = { ...(config.mcpServers ?? {}) };
  const had = Object.hasOwn(servers, SERVER_NAME);
  const others = Object.keys(servers).filter((k) => k !== SERVER_NAME).length;
  if (remove) {
    if (!had) return { action: 'absent', config, exists, others };
    delete servers[SERVER_NAME];
    return { action: 'remove', config: { ...config, mcpServers: servers }, exists, others };
  }
  if (had && JSON.stringify(servers[SERVER_NAME]) === JSON.stringify(cmd)) return { action: 'unchanged', config, exists, others };
  servers[SERVER_NAME] = cmd;
  return { action: had ? 'update' : 'add', config: { ...config, mcpServers: servers }, exists, others };
}

const stamp = (d) => d.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);

/** Writes `config` to `file` atomically; an existing file is first copied to `<file>.bak-YYYYMMDD-HHMMSS`. */
export function writeJsonConfig(file, config, { now = new Date() } = {}) {
  let backup = null;
  let mode;
  if (fs.existsSync(file)) {
    mode = fs.statSync(file).mode & 0o777;
    backup = `${file}.bak-${stamp(now)}`;
    for (let i = 1; fs.existsSync(backup); i++) backup = `${file}.bak-${stamp(now)}-${i}`;
    fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, mode === undefined ? {} : { mode });
    fs.renameSync(tmp, file);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return { backup };
}

/** Runs the `claude` CLI; .cmd/.bat shims on Windows need a shell. */
function runClaude(bin, args) {
  const shell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
  const quoted = shell ? args.map((a) => (/[\s"&|<>^]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : args;
  const res = spawnSync(bin, quoted, { encoding: 'utf8', shell, timeout: 60_000 });
  return { ok: res.status === 0, output: `${res.stdout ?? ''}${res.stderr ?? ''}`.trim() || res.error?.message || '' };
}

export const claudeAddArgs = (cmd) => ['mcp', 'add', '--scope', 'user', SERVER_NAME, '--', cmd.command, ...cmd.args];
export const claudeRemoveArgs = () => ['mcp', 'remove', '--scope', 'user', SERVER_NAME];

/** Adds (or replaces) the server in Claude Code at user scope. */
export function claudeCodeAdd(bin, cmd) {
  let res = runClaude(bin, claudeAddArgs(cmd));
  if (!res.ok && /already exists/i.test(res.output)) {
    runClaude(bin, claudeRemoveArgs());
    res = runClaude(bin, claudeAddArgs(cmd));
  }
  return res;
}

export const claudeCodeRemove = (bin) => runClaude(bin, claudeRemoveArgs());
