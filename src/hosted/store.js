/**
 * Persistence of the hosted connector: SQLite through node:sqlite (built into Node >= 22.13 without a
 * flag; the Docker image uses Node 24). One file in the data directory, WAL mode, foreign keys on.
 *
 * What is stored (nothing else):
 *   clients   OAuth clients from dynamic registration: id, metadata (name, redirect URIs), secret verifier
 *   invites   invite code HMAC, note, use counter, limits
 *   users     pseudonymous id (HMAC of the Samsung account id), invite used, created / last seen
 *   grants    user + client + scope, the Samsung session encrypted with the grant key, timestamps
 *   creds     codes and tokens: id, verifier (HMAC), the wrapped grant key, expiry, OAuth metadata
 * No names, e-mail addresses, IP addresses, tool arguments or results.
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

/** node:sqlite, or null on Node versions without it (the hosted mode then refuses to start). */
export function loadSqlite() {
  try {
    // Node 22.5-22.12 needs --experimental-sqlite; the require fails there without it.
    return require('node:sqlite');
  } catch {
    return null;
  }
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS clients (
  client_id TEXT PRIMARY KEY,
  secret_verifier TEXT,
  metadata TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code_hash TEXT NOT NULL UNIQUE,
  note TEXT,
  max_uses INTEGER NOT NULL,
  uses INTEGER NOT NULL DEFAULT 0,
  expires_at INTEGER,
  revoked_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS users (
  uid TEXT PRIMARY KEY,
  invite_id TEXT,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS grants (
  gid TEXT PRIMARY KEY,
  uid TEXT NOT NULL REFERENCES users(uid) ON DELETE CASCADE,
  client_id TEXT NOT NULL,
  scope TEXT NOT NULL,
  resource TEXT NOT NULL,
  read_only INTEGER NOT NULL DEFAULT 0,
  session TEXT NOT NULL,
  samsung_expired INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS grants_uid ON grants(uid);
CREATE TABLE IF NOT EXISTS creds (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  gid TEXT NOT NULL REFERENCES grants(gid) ON DELETE CASCADE,
  verifier TEXT NOT NULL,
  wrap TEXT,
  meta TEXT,
  expires_at INTEGER NOT NULL,
  used_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS creds_gid ON creds(gid);
`;

export function openStore(dataDir, { now = Date.now } = {}) {
  const sqlite = loadSqlite();
  if (!sqlite) throw new Error('The hosted connector needs node:sqlite (Node.js 22.13 or newer, 24 recommended).');
  let file = ':memory:';
  if (dataDir !== ':memory:') {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    file = path.join(dataDir, 'connector.db');
  }
  const db = new sqlite.DatabaseSync(file);
  if (file !== ':memory:') fs.chmodSync(file, 0o600);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA secure_delete = ON;');
  db.exec(SCHEMA);
  // The WAL and shared-memory files hold recent pages too (the entry points also set umask 077).
  if (file !== ':memory:') for (const f of [`${file}-wal`, `${file}-shm`]) if (fs.existsSync(f)) fs.chmodSync(f, 0o600);

  const q = (sql) => db.prepare(sql);
  const st = {
    clientGet: q('SELECT * FROM clients WHERE client_id = ?'),
    clientPut: q('INSERT INTO clients (client_id, secret_verifier, metadata, created_at, last_used_at) VALUES (?, ?, ?, ?, ?)'),
    // last_used_at > created_at marks a client that led to a connection at least once.
    clientTouch: q('UPDATE clients SET last_used_at = MAX(?, created_at + 1) WHERE client_id = ?'),
    clientEvict: q(
      'DELETE FROM clients WHERE client_id = (SELECT client_id FROM clients c WHERE c.last_used_at = c.created_at AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.client_id = c.client_id) ORDER BY c.created_at LIMIT 1)'
    ),
    clientCount: q('SELECT COUNT(*) AS n FROM clients'),
    inviteByHash: q('SELECT * FROM invites WHERE code_hash = ?'),
    inviteUse: q('UPDATE invites SET uses = uses + 1 WHERE id = ? AND uses < max_uses AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)'),
    invitePut: q('INSERT INTO invites (id, code_hash, note, max_uses, uses, expires_at, revoked_at, created_at) VALUES (?, ?, ?, ?, 0, ?, NULL, ?)'),
    inviteList: q('SELECT id, note, max_uses, uses, expires_at, revoked_at, created_at FROM invites ORDER BY created_at'),
    inviteRevoke: q('UPDATE invites SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL'),
    userGet: q('SELECT * FROM users WHERE uid = ?'),
    userPut: q('INSERT INTO users (uid, invite_id, created_at, last_seen_at) VALUES (?, ?, ?, ?)'),
    userSeen: q('UPDATE users SET last_seen_at = ? WHERE uid = ?'),
    userDelete: q('DELETE FROM users WHERE uid = ?'),
    userList: q('SELECT u.uid, u.invite_id, u.created_at, u.last_seen_at, (SELECT COUNT(*) FROM grants g WHERE g.uid = u.uid) AS grants FROM users u ORDER BY u.created_at'),
    grantGet: q('SELECT * FROM grants WHERE gid = ?'),
    grantPut: q('INSERT INTO grants (gid, uid, client_id, scope, resource, read_only, session, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    grantSession: q('UPDATE grants SET session = ? WHERE gid = ?'),
    grantTouch: q('UPDATE grants SET last_used_at = ? WHERE gid = ?'),
    grantExpired: q('UPDATE grants SET samsung_expired = 1 WHERE gid = ?'),
    grantDelete: q('DELETE FROM grants WHERE gid = ?'),
    grantsOfUser: q('SELECT gid, created_at FROM grants WHERE uid = ? ORDER BY created_at'),
    credGet: q('SELECT * FROM creds WHERE id = ?'),
    credPut: q('INSERT INTO creds (id, kind, gid, verifier, wrap, meta, expires_at, used_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)'),
    credUse: q('UPDATE creds SET used_at = ?, wrap = NULL WHERE id = ? AND used_at IS NULL'),
    credDelete: q('DELETE FROM creds WHERE id = ?'),
    credDropWrap: q('UPDATE creds SET wrap = NULL WHERE id = ?'),
    grantDropWraps: q('UPDATE creds SET wrap = NULL WHERE gid = ? AND wrap IS NOT NULL'),
    grantDropAccess: q("DELETE FROM creds WHERE gid = ? AND kind = 'access'"),
    expiredWraps: q('UPDATE creds SET wrap = NULL WHERE wrap IS NOT NULL AND expires_at <= ?'),
  };

  const tx = (fn) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const r = fn();
      db.exec('COMMIT');
      return r;
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  };

  return {
    db,
    tx,
    close: () => db.close(),

    getClient: (id) => st.clientGet.get(id) ?? null,
    putClient: (id, secretVerifier, metadata) => {
      const t = now();
      st.clientPut.run(id, secretVerifier, JSON.stringify(metadata), t, t);
    },
    touchClient: (id) => st.clientTouch.run(now(), id),
    clientCount: () => st.clientCount.get().n,
    /** Deletes the oldest registered client that never led to a connection; false if there is none. */
    evictUnusedClient: () => st.clientEvict.run().changes === 1,

    inviteByHash: (h) => st.inviteByHash.get(h) ?? null,
    /** Atomically counts one use; false when the invite is used up, revoked or expired. */
    useInvite: (id) => st.inviteUse.run(id, now()).changes === 1,
    putInvite: (id, hash, note, maxUses, expiresAt) => st.invitePut.run(id, hash, note ?? null, maxUses, expiresAt ?? null, now()),
    listInvites: () => st.inviteList.all(),
    revokeInvite: (id) => st.inviteRevoke.run(now(), id).changes === 1,

    getUser: (uid) => st.userGet.get(uid) ?? null,
    putUser: (uid, inviteId) => st.userPut.run(uid, inviteId ?? null, now(), now()),
    seeUser: (uid) => st.userSeen.run(now(), uid),
    deleteUser: (uid) => st.userDelete.run(uid).changes === 1,
    listUsers: () => st.userList.all(),

    getGrant: (gid) => st.grantGet.get(gid) ?? null,
    putGrant: (g) => st.grantPut.run(g.gid, g.uid, g.clientId, g.scope, g.resource, g.readOnly ? 1 : 0, g.session, now(), now()),
    setGrantSession: (gid, session) => st.grantSession.run(session, gid),
    touchGrant: (gid) => st.grantTouch.run(now(), gid),
    markSamsungExpired: (gid) => st.grantExpired.run(gid),
    deleteGrant: (gid) => st.grantDelete.run(gid).changes === 1,
    grantsOfUser: (uid) => st.grantsOfUser.all(uid),

    getCred: (id) => st.credGet.get(id) ?? null,
    putCred: (c) => st.credPut.run(c.id, c.kind, c.gid, c.verifier, c.wrap, c.meta ? JSON.stringify(c.meta) : null, c.expiresAt, now()),
    /** Marks a code or refresh token as used and drops its wrap; false if it was already used. */
    useCred: (id) => st.credUse.run(now(), id).changes === 1,
    deleteCred: (id) => st.credDelete.run(id),
    dropWrap: (id) => st.credDropWrap.run(id),
    /** After a key rotation: old access tokens are deleted, the remaining credentials lose their wrap. */
    dropGrantWraps: (gid) => {
      st.grantDropAccess.run(gid);
      st.grantDropWraps.run(gid);
    },
    /** Drops the wraps of expired credentials (runs every minute; the rows go with the hourly sweep). */
    dropExpiredWraps: () => st.expiredWraps.run(now()).changes,

    /**
     * Housekeeping: expired credentials, inactive grants, grants without a usable credential, users
     * without grants that were inactive, clients that never led to a connection (after a day) and
     * clients without connections that were idle for a week.
     */
    sweep({ inactivityMs, clientIdleMs = 7 * 86400000, neverUsedClientMs = 86400000, usedGraceMs = 86400000 }) {
      const t = now();
      return tx(() => {
        const creds = db.prepare('DELETE FROM creds WHERE expires_at < ? OR (used_at IS NOT NULL AND used_at < ?)').run(t, t - usedGraceMs).changes;
        const inactive = db.prepare('DELETE FROM grants WHERE last_used_at < ?').run(t - inactivityMs).changes;
        const orphan = db
          .prepare("DELETE FROM grants WHERE created_at < ? AND NOT EXISTS (SELECT 1 FROM creds c WHERE c.gid = grants.gid AND c.wrap IS NOT NULL)")
          .run(t - 3600000).changes;
        const users = db.prepare('DELETE FROM users WHERE last_seen_at < ? AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.uid = users.uid)').run(t - inactivityMs).changes;
        const clients = db
          .prepare('DELETE FROM clients WHERE last_used_at < ? AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.client_id = clients.client_id)')
          .run(t - clientIdleMs).changes +
          db
            .prepare('DELETE FROM clients WHERE last_used_at = created_at AND created_at < ? AND NOT EXISTS (SELECT 1 FROM grants g WHERE g.client_id = clients.client_id)')
            .run(t - neverUsedClientMs).changes;
        return { creds, grants: inactive + orphan, users, clients };
      });
    },
  };
}
