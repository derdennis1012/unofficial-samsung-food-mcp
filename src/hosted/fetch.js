/**
 * Outbound fetch for Client ID Metadata Documents: HTTPS GET only, public addresses only (checked on
 * the resolved IP at connect time, so DNS rebinding cannot reach internal hosts), no redirects,
 * small bodies, short timeout.
 */

import dns from 'node:dns';
import https from 'node:https';
import net from 'node:net';

const blocked = new net.BlockList();
for (const [net4, bits] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12],
  ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3],
]) blocked.addSubnet(net4, bits, 'ipv4');
// IPv4-mapped/translated IPv6 ranges are not listed here: BlockList would match every IPv4 address
// against them. Mapped addresses are unwrapped and checked as IPv4 instead. Blocked outright:
// ::/96 (unspecified, loopback and the deprecated IPv4-compatible form such as ::127.0.0.1),
// discard, 64:ff9b:1::/48 (local-use NAT64), Teredo, documentation, 6to4 (2002::/16, it embeds
// an arbitrary IPv4 address), ULA, link-local and multicast.
for (const [net6, bits] of [
  ['::', 96], ['100::', 64], ['64:ff9b:1::', 48], ['2001::', 32], ['2001:db8::', 32], ['2002::', 16], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
]) blocked.addSubnet(net6, bits, 'ipv6');

export function isPublicAddress(ip) {
  const mapped = /^(?:::ffff:|64:ff9b::)(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return isPublicAddress(mapped[1]);
  if (/^(?:::ffff:|64:ff9b::)/i.test(ip)) return false;
  const family = net.isIP(ip);
  if (!family) return false;
  return !blocked.check(ip, family === 4 ? 'ipv4' : 'ipv6');
}

function guardedLookup(hostname, options, callback) {
  dns.lookup(hostname, { all: true, verbatim: true }, (err, addresses) => {
    if (err) return callback(err);
    if (!addresses.length || addresses.some((a) => !isPublicAddress(a.address))) {
      return callback(Object.assign(new Error(`${hostname} resolves to a non-public address`), { code: 'EADDRNOTPUBLIC' }));
    }
    if (options.all) return callback(null, addresses);
    callback(null, addresses[0].address, addresses[0].family);
  });
}

/**
 * fetch-like subset: resolves { ok, status, text() }. `timeoutMs` is the deadline for the whole
 * exchange (connect, headers and body), not an idle timeout, so a slowly dripping server cannot
 * keep the request open; `signal` aborts it as well.
 */
export function safeFetch(url, { timeoutMs = 5000, maxBytes = 10_000, signal, request = https.get } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const u = new URL(url);
    if (u.protocol !== 'https:') return rejectPromise(new Error('https only'));
    const host = u.hostname.replace(/^\[|\]$/g, '');
    if (net.isIP(host) && !isPublicAddress(host)) return rejectPromise(new Error('non-public address'));
    if (signal?.aborted) return rejectPromise(new Error('aborted'));
    let req;
    const deadline = setTimeout(() => req.destroy(new Error('timeout')), timeoutMs);
    const onAbort = () => req.destroy(new Error('aborted'));
    signal?.addEventListener('abort', onAbort, { once: true });
    const settle = (fn) => (v) => {
      clearTimeout(deadline);
      signal?.removeEventListener('abort', onAbort);
      fn(v);
    };
    const resolve = settle(resolvePromise);
    const reject = settle(rejectPromise);
    req = request(u, { lookup: guardedLookup, timeout: timeoutMs, headers: { accept: 'application/json', 'user-agent': 'unofficial-samsung-food-mcp-connector' } }, (res) => {
      const chunks = [];
      let size = 0;
      res.on('data', (c) => {
        size += c.length;
        if (size > maxBytes) {
          req.destroy(new Error('response too large'));
          return;
        }
        chunks.push(c);
      });
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        // Redirects are not followed: a 3xx is simply not ok.
        resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, text: async () => body });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}
