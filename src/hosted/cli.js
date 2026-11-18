/**
 * `sf host ...` / `sf-host ...`: run the hosted connector and administer it.
 *
 *   sf host [serve]                          start the server (configuration from the environment)
 *   sf host keygen                           print a new master key
 *   sf host invites create [--uses 1] [--days 30] [--note text]
 *   sf host invites list
 *   sf host invites revoke <id>
 *   sf host users list
 *   sf host users delete <uid>
 *   sf host cleanup                          remove expired and inactive data now
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { createKeyring, generateInvite, generateMasterKey, parseMasterKey } from './crypto.js';
import { openStore } from './store.js';

export const HOST_HELP = [
  'sf host - hosted multi-user connector for ChatGPT, claude.ai and other remote MCP clients',
  '',
  '  sf host [serve]                               start (configuration: SF_HOST_* environment variables)',
  '  sf host keygen                                print a new master key for SF_HOST_MASTER_KEY',
  '  sf host invites create [--uses 1] [--days 30] [--note "for Anna"]',
  '  sf host invites list',
  '  sf host invites revoke <id>',
  '  sf host users list                            pseudonymous ids, created, last seen, connections',
  '  sf host users delete <uid>                    delete a user with all connections and sessions',
  '  sf host cleanup                               remove expired and inactive data now',
  '',
  'Admin commands need SF_HOST_DATA_DIR and SF_HOST_MASTER_KEY like the server. See docs/hosted.md.',
].join('\n');

function parse(args) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      pos.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (key === 'help' || key === 'json') flags[key] = true;
    else if (['uses', 'days', 'note'].includes(key)) {
      const v = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (v === undefined) throw new Error(`--${key} needs a value`);
      flags[key] = v;
    } else throw new Error(`Unknown option --${key}. Run: sf host help`);
  }
  return { flags, pos };
}

/** Data dir and key without requiring the server-only settings. */
function adminContext(env) {
  const raw = env.SF_HOST_MASTER_KEY || (env.SF_HOST_MASTER_KEY_FILE ? fs.readFileSync(env.SF_HOST_MASTER_KEY_FILE, 'utf8') : null);
  const key = raw ? parseMasterKey(raw) : null;
  process.umask(0o077);
  const store = openStore(path.resolve(env.SF_HOST_DATA_DIR || './data'));
  return { store, keyring: key ? createKeyring(key) : null };
}

const iso = (ms) => (ms ? new Date(ms).toISOString().replace(/\.\d+Z$/, 'Z') : '-');
const posInt = (v, name, def) => {
  if (v === undefined) return def;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
};

export async function runHostCli(args, { env = process.env, out = (m) => console.log(m), err = (m) => process.stderr.write(`${m}\n`) } = {}) {
  const { flags, pos } = parse(args);
  const [cmd = 'serve', sub, arg] = pos;
  if (flags.help || cmd === 'help') return out(HOST_HELP);

  if (cmd === 'keygen') return out(generateMasterKey());

  if (cmd === 'serve') {
    const { runHost } = await import('./run.js');
    return runHost({ env, log: err });
  }

  const { store, keyring } = adminContext(env);
  try {
    if (cmd === 'invites') {
      if (sub === 'create') {
        if (!keyring) throw new Error('SF_HOST_MASTER_KEY is required to create invites');
        const code = generateInvite();
        const id = `i_${crypto.randomBytes(6).toString('hex')}`;
        const uses = posInt(flags.uses, 'uses', 1);
        const days = posInt(flags.days, 'days', 30);
        store.putInvite(id, keyring.inviteHash(code), flags.note ?? null, uses, Date.now() + days * 86400000);
        return out(flags.json ? JSON.stringify({ id, code, uses, expiresAt: iso(Date.now() + days * 86400000) }) : `Invite ${id} (${uses} use${uses === 1 ? '' : 's'}, valid ${days} days). Code, shown only now:\n  ${code}`);
      }
      if (sub === 'list') {
        const rows = store.listInvites().map((r) => ({ id: r.id, note: r.note, uses: `${r.uses}/${r.max_uses}`, expires: iso(r.expires_at), revoked: r.revoked_at ? iso(r.revoked_at) : null, created: iso(r.created_at) }));
        return out(flags.json ? JSON.stringify(rows, null, 2) : rows.length ? rows.map((r) => `${r.id}  ${r.uses.padEnd(7)} expires ${r.expires}${r.revoked ? `  REVOKED ${r.revoked}` : ''}  ${r.note ?? ''}`).join('\n') : 'No invites.');
      }
      if (sub === 'revoke') {
        if (!arg) throw new Error('Usage: sf host invites revoke <id>');
        return out(store.revokeInvite(arg) ? `Invite ${arg} revoked.` : `No active invite ${arg}.`);
      }
      throw new Error('Usage: sf host invites create|list|revoke');
    }
    if (cmd === 'users') {
      if (sub === 'list') {
        const rows = store.listUsers().map((r) => ({ uid: r.uid, invite: r.invite_id, created: iso(r.created_at), lastSeen: iso(r.last_seen_at), connections: r.grants }));
        return out(flags.json ? JSON.stringify(rows, null, 2) : rows.length ? rows.map((r) => `${r.uid}  created ${r.created}  last seen ${r.lastSeen}  ${r.connections} connection(s)`).join('\n') : 'No users.');
      }
      if (sub === 'delete') {
        if (!arg) throw new Error('Usage: sf host users delete <uid>');
        return out(store.deleteUser(arg) ? `User ${arg} deleted with all connections.` : `No user ${arg}.`);
      }
      throw new Error('Usage: sf host users list|delete');
    }
    if (cmd === 'cleanup') {
      const days = Number(env.SF_HOST_INACTIVITY_DAYS) || 30;
      return out(JSON.stringify(store.sweep({ inactivityMs: days * 86400000 })));
    }
    throw new Error(`Unknown command: sf host ${cmd}. Run: sf host help`);
  } finally {
    store.close();
  }
}
