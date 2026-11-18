/**
 * Cryptography of the hosted connector.
 *
 * Every grant (one user connecting one MCP client) has a random 256-bit data key K. The Samsung
 * session of the grant is stored encrypted with K (AES-256-GCM). K itself is never stored in usable
 * form: for every live credential the server issued (authorization code, access token, refresh token)
 * the database holds K wrapped with a key-encryption key that is derived from
 *   - the credential's secret part, which only the MCP client has (the database keeps a verifier), and
 *   - the server master key (environment), as HKDF salt.
 * So a copy of the database alone, or the database plus the master key, does not reveal Samsung
 * sessions; it takes a live credential (plus the master key, plus the database). Rotating a refresh
 * token deletes the wrap of the old one.
 *
 * Credential format: <kind>_<id>.<secret>  (id: 16 random bytes, secret: 32 random bytes, base64url)
 */

import crypto from 'node:crypto';

const KINDS = { code: 'sfac', access: 'sfat', refresh: 'sfrt' };
const PREFIX_KIND = Object.fromEntries(Object.entries(KINDS).map(([k, p]) => [p, k]));
const CRED_RE = /^(sfac|sfat|sfrt)_([A-Za-z0-9_-]{22})\.([A-Za-z0-9_-]{43})$/;

export const b64u = (buf) => Buffer.from(buf).toString('base64url');

/** Parses SF_HOST_MASTER_KEY: 32 bytes as base64, base64url or hex. */
export function parseMasterKey(value) {
  const v = String(value ?? '').trim();
  let key = null;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, 'hex');
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) key = Buffer.from(v.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  if (!key || key.length !== 32) throw new Error('The master key must be 32 random bytes as base64 or hex (create one with: sf host keygen)');
  return key;
}

export const generateMasterKey = () => crypto.randomBytes(32).toString('base64url');

/** AES-256-GCM; output base64url(iv | tag | ciphertext). `aad` binds the ciphertext to its row. */
export function seal(key, plaintext, aad) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8')), c.final()]);
  return b64u(Buffer.concat([iv, c.getAuthTag(), ct]));
}

/** Inverse of seal; throws on any tampering or a wrong key. Returns a Buffer. */
export function open(key, blob, aad) {
  const raw = Buffer.from(String(blob), 'base64url');
  if (raw.length < 28) throw new Error('ciphertext too short');
  const d = crypto.createDecipheriv('aes-256-gcm', key, raw.subarray(0, 12));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([d.update(raw.subarray(28)), d.final()]);
}

const hkdf = (ikm, salt, info) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, Buffer.from(info), 32));

export function hmacHex(key, label, value) {
  return crypto.createHmac('sha256', key).update(`${label}\0${value}`).digest('hex');
}

export function timingSafeEqualStr(a, b) {
  const x = crypto.createHash('sha256').update(String(a)).digest();
  const y = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(x, y) && String(a).length === String(b).length;
}

export function createKeyring(masterKey) {
  /** Key for server-only secrets (signed pages, pseudonyms); separate from the wrapping use. */
  const internal = hkdf(masterKey, Buffer.alloc(0), 'sf-host/v1/internal');

  const verifierOf = (kind, id, secret) => hmacHex(internal, `verify:${kind}:${id}`, secret);
  const kekOf = (kind, id, secret) => hkdf(Buffer.from(secret, 'base64url'), masterKey, `sf-host/v1/kek:${kind}:${id}`);
  const wrapAad = (kind, id, gid) => `wrap:${kind}:${id}:${gid}`;

  return {
    /** New credential of `kind`; `wrap` holds the grant key K for this credential. */
    mint(kind, gid, grantKey) {
      const id = b64u(crypto.randomBytes(16));
      const secret = b64u(crypto.randomBytes(32));
      return {
        id,
        value: `${KINDS[kind]}_${id}.${secret}`,
        verifier: verifierOf(kind, id, secret),
        wrap: seal(kekOf(kind, id, secret), grantKey, wrapAad(kind, id, gid)),
      };
    },
    /** { kind, id, secret } or null for anything that is not one of our credentials. */
    parse(value) {
      const m = CRED_RE.exec(typeof value === 'string' ? value : '');
      return m ? { kind: PREFIX_KIND[m[1]], id: m[2], secret: m[3] } : null;
    },
    verify(cred, storedVerifier) {
      return timingSafeEqualStr(verifierOf(cred.kind, cred.id, cred.secret), storedVerifier);
    },
    /** Recovers K from a credential's wrap. */
    unwrap(cred, gid, wrap) {
      return open(kekOf(cred.kind, cred.id, cred.secret), wrap, wrapAad(cred.kind, cred.id, gid));
    },
    newGrantKey: () => crypto.randomBytes(32),
    sealSession: (grantKey, gid, data) => seal(grantKey, JSON.stringify(data), `session:${gid}`),
    openSession: (grantKey, gid, blob) => JSON.parse(open(grantKey, blob, `session:${gid}`).toString('utf8')),
    /** Pseudonymous, stable user id (HMAC of the Samsung account id); the account id is not stored. */
    userId: (samsungUserId) => `u_${hmacHex(internal, 'user', samsungUserId).slice(0, 24)}`,
    inviteHash: (code) => hmacHex(internal, 'invite', normalizeInvite(code)),
    clientSecretVerifier: (clientId, secret) => hmacHex(internal, `client:${clientId}`, secret),
  };
}

/** Invite codes: SF-XXXX-XXXX-XXXX from an unambiguous alphabet (60 bits). Case and dashes don't matter. */
const INVITE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
export function generateInvite() {
  let s = '';
  for (let i = 0; i < 12; i++) s += INVITE_ALPHABET[crypto.randomInt(INVITE_ALPHABET.length)];
  return `SF-${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
}
export function normalizeInvite(code) {
  return String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^SF/, '');
}
