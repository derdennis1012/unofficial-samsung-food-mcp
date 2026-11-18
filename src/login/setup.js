/**
 * Browser login and first-time setup, shared by `sf login`, `sf setup` and
 * `npx unofficial-samsung-food-mcp setup`.
 */

import os from 'node:os';
import { SamsungFood } from '../client.js';
import { loginWithCredential, authStatus } from '../session.js';
import { startLocalLogin, openInBrowser } from './local.js';
import {
  SERVER_NAME,
  ConfigError,
  detectClients,
  serverCommand,
  configSnippet,
  planJsonChange,
  writeJsonConfig,
  claudeAddArgs,
  claudeRemoveArgs,
  claudeCodeAdd,
  claudeCodeRemove,
} from '../setup/clients.js';

const err = (m) => process.stderr.write(`${m}\n`);

/**
 * Logs in through the local browser page and stores the session in auth.json.
 * @param {{open?: boolean, timeoutMs?: number, log?: (m: string) => void, client?: SamsungFood, start?: typeof startLocalLogin}} [o]
 * @returns {Promise<{account: string, expiresAt: string|null}>}
 */
export async function browserLogin({ open = true, timeoutMs, log = err, client, start = startLocalLogin } = {}) {
  const sf = client ?? (await SamsungFood.create());
  const login = await start({
    timeoutMs,
    verify: async (token) => {
      const r = await loginWithCredential(sf, token);
      return { account: r.account, expiresAt: r.expiresAt };
    },
  });
  const opened = open && openInBrowser(login.url);
  log(
    [
      opened ? `Opened ${login.url} in your browser.` : `Open this page in your browser: ${login.url}`,
      'Follow the steps there (one button, or paste). Waiting... (Ctrl-C to cancel)',
      'No browser on this machine (SSH)? Cancel and run: sf login --paste',
    ].join('\n')
  );
  const onSigint = () => login.close();
  process.once('SIGINT', onSigint);
  try {
    return await login.result;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

const HOSTED_DOCS = 'https://github.com/derdennis1012/unofficial-samsung-food-mcp/blob/main/docs/hosted.md';
const CLIENT_DOCS = 'https://github.com/derdennis1012/unofficial-samsung-food-mcp/blob/main/docs/mcp-clients.md';
const isAuthError = (e) => /ERROR_AUTH_TOKEN|UNAUTHENTICATED|PERMISSION_DENIED/.test(String(e?.cause?.message ?? e?.message));

/** GetMe with the stored session: { account } when it works, null when there is no usable session. */
export async function checkLogin({ client } = {}) {
  if (!authStatus().loggedIn) return null;
  const sf = client ?? (await SamsungFood.create());
  try {
    const me = await sf.me();
    return { account: [me.settings?.firstName, me.settings?.lastName].filter(Boolean).join(' ') || String(me.id ?? 'your account') };
  } catch (e) {
    if (isAuthError(e)) return null;
    return { account: null, warning: e.message };
  }
}

async function readlineAsk(question) {
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/** Parses the checklist answer: Enter/"a" = all, "n" = none, "1,3" or "1 3" = those. */
export function parseSelection(answer, count) {
  const a = String(answer ?? '').trim().toLowerCase();
  if (!a || a === 'a' || a === 'all' || a === 'y' || a === 'yes') return [...Array(count).keys()];
  if (a === 'n' || a === 'no' || a === 'none') return [];
  const picked = new Set();
  for (const part of a.split(/[\s,]+/)) {
    const n = Number(part);
    if (!Number.isInteger(n) || n < 1 || n > count) throw new Error(`"${part}" is not one of 1-${count}.`);
    picked.add(n - 1);
  }
  return [...picked].sort();
}

/**
 * `sf setup` / `npx unofficial-samsung-food-mcp setup`: log in if needed, then add (or with
 * `remove` take out) the server in the detected MCP clients. Nothing is written without a yes:
 * the checklist answer, or `yes` for scripts. `dryRun` only prints.
 */
export async function runSetup({
  yes = false,
  dryRun = false,
  remove = false,
  local = false,
  open = true,
  out = (m) => console.log(m),
  ask = readlineAsk,
  isTTY = Boolean(process.stdin.isTTY),
  nodeVersion = process.versions.node,
  login = (o) => browserLogin(o),
  check = () => checkLogin(),
  clients = detectClients(),
  home = os.homedir(),
  now = new Date(),
} = {}) {
  const tilde = (p) => (p && home && p.startsWith(home) ? `~${p.slice(home.length)}` : p);
  if (Number(nodeVersion.split('.')[0]) < 20) {
    throw new Error(`Node.js 20 or newer is needed (this is ${nodeVersion}). Get it from https://nodejs.org`);
  }
  const cmd = serverCommand({ local });
  if (dryRun) out('Dry run: nothing is written.');

  // 1. Login
  if (!remove) {
    const who = await check();
    if (who?.account) out(`Connected as ${who.account}.`);
    else if (who?.warning) out(`Logged in, but Samsung Food could not be reached right now (${who.warning}).`);
    else if (dryRun) out('Not logged in yet: setup would open the browser login now.');
    else {
      out('First, log in to Samsung Food. A page opens in your browser (Samsung has no OAuth, so the page hands your session over with one click).');
      const res = await login({ open });
      out(`Connected as ${res.account}.`);
    }
  }

  // 2. Clients
  const found = clients.filter((c) => c.detected);
  if (!found.length) {
    out(`\nNo MCP client found (Claude Code, Claude Desktop, Cursor, VS Code). Add this to your client's config:\n${configSnippet(cmd)}\nMore clients: ${CLIENT_DOCS}`);
    return { configured: [] };
  }
  const where = (c) => (c.kind === 'cli' ? `claude mcp add --scope user` : c.kind === 'json' ? tilde(c.file) : 'prints the config to paste');
  out(`\n${remove ? 'Remove Samsung Food from' : 'Found'}:`);
  found.forEach((c, i) => out(`  ${i + 1}. ${c.name.padEnd(15)} ${where(c)}`));

  let picked;
  if (yes || dryRun) picked = found;
  else if (!isTTY) throw new Error('Not a terminal, so nothing was changed. Run again with --yes to go ahead with the clients above, or --dry-run to preview.');
  else {
    const answer = await ask(`${remove ? 'Remove from' : 'Configure'} which? [Enter = all, e.g. 1,3, n = none] `);
    picked = parseSelection(answer, found.length).map((i) => found[i]);
  }
  if (!picked.length) {
    out('Nothing changed.');
    return { configured: [] };
  }

  const done = [];
  for (const c of picked) {
    if (c.kind === 'cli') {
      const args = remove ? claudeRemoveArgs() : claudeAddArgs(cmd);
      if (dryRun) {
        out(`- ${c.name}: would run  claude ${args.join(' ')}`);
        continue;
      }
      const res = remove ? claudeCodeRemove(c.bin) : claudeCodeAdd(c.bin, cmd);
      if (res.ok) {
        out(`- ${c.name}: ${remove ? 'removed' : 'added'} (user scope).`);
        done.push(c);
      } else out(`- ${c.name}: \`claude ${args.join(' ')}\` failed${res.output ? `: ${res.output.split('\n')[0]}` : ''}`);
      continue;
    }
    if (c.kind === 'manual') {
      if (remove) out(`- ${c.name}: remove "${SERVER_NAME}" by hand (command palette: "MCP: Open User Configuration").`);
      else out(`- ${c.name}: command palette "MCP: Open User Configuration", then add:\n${configSnippet(cmd, { vscode: true })}`);
      continue;
    }
    let plan;
    try {
      plan = planJsonChange(c.file, { cmd, remove });
    } catch (e) {
      if (!(e instanceof ConfigError)) throw e;
      out(`- ${c.name}: left ${tilde(c.file)} alone, ${e.message}.${remove ? '' : ` Add this by hand:\n${configSnippet(cmd)}`}`);
      continue;
    }
    if (plan.action === 'unchanged') {
      out(`- ${c.name}: already set up.`);
      continue;
    }
    if (plan.action === 'absent') {
      out(`- ${c.name}: nothing to remove.`);
      continue;
    }
    const verb = { add: 'added', update: 'updated', remove: 'removed' }[plan.action];
    const keeps = (v) => (plan.others ? `, ${v} ${plan.others} other server${plan.others === 1 ? '' : 's'}` : '');
    if (dryRun) {
      out(`- ${c.name}: would ${plan.action} "${SERVER_NAME}" in ${tilde(c.file)}${keeps('keeping')}.`);
      continue;
    }
    const { backup } = writeJsonConfig(c.file, plan.config, { now });
    out(`- ${c.name}: ${verb} in ${tilde(c.file)}${keeps('kept')}${backup ? `; backup ${tilde(backup)}` : ''}.`);
    done.push(c);
  }
  if (dryRun && !remove) out(`\nEntry:\n${configSnippet(cmd)}`);

  // 3. Next steps
  if (done.length && !remove) {
    const steps = [...new Set(done.map((c) => c.restart))].join(', then ');
    out(`\nNext: ${steps}, then ask: "What's on my meal plan this week?"`);
  }
  if (!remove) out(`Rather not install anything? Hosted connector (closed beta): ${HOSTED_DOCS}`);
  return { configured: done.map((c) => c.id) };
}

const SETUP_HELP = `Usage: setup [--yes] [--dry-run] [--remove] [--local] [--no-browser]

Logs in to Samsung Food (if needed) and adds the MCP server to Claude Code, Claude Desktop,
Cursor and VS Code.

  --yes         configure every detected client without asking
  --dry-run     only show what would happen
  --remove      take the samsung-food entries out again (backups as usual)
  --local       start this checkout with the current node instead of npx
  --no-browser  print the login page address instead of opening it`;

/** Entry point for `sf setup …` and `unofficial-samsung-food-mcp setup …`. */
export async function runSetupCli(argv) {
  const known = { '--yes': 'yes', '-y': 'yes', '--dry-run': 'dryRun', '--remove': 'remove', '--local': 'local', '--no-browser': 'noBrowser', '--help': 'help', '-h': 'help' };
  const o = {};
  for (const a of argv) {
    if (!known[a]) throw new Error(`Unknown option ${a}.\n\n${SETUP_HELP}`);
    o[known[a]] = true;
  }
  if (o.help) return console.log(SETUP_HELP);
  return runSetup({ yes: o.yes, dryRun: o.dryRun, remove: o.remove, local: o.local, open: !o.noBrowser });
}
