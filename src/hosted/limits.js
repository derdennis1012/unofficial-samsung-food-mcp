/** In-memory rate limits and the concurrency caps toward Samsung Food. */

import net from 'node:net';

/** Expands an IPv6 address into its 8 groups (numbers); null if it is not IPv6. */
function ipv6Groups(ip) {
  if (net.isIP(ip) !== 6) return null;
  let s = ip.replace(/%.*$/, '');
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (v4) {
    const [a, b, c, d] = v4[1].split('.').map(Number);
    s = `${s.slice(0, -v4[1].length)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [head, tail] = s.split('::');
  const h = head ? head.split(':') : [];
  const t = tail !== undefined && tail ? tail.split(':') : [];
  const groups = tail === undefined ? h : [...h, ...Array(8 - h.length - t.length).fill('0'), ...t];
  return groups.map((g) => parseInt(g, 16));
}

/**
 * Rate-limit key of a client address: IPv4 as is (IPv4-mapped IPv6 unwrapped), IPv6 bucketed by
 * its /64 (one subscriber usually gets a whole /64, so per-address limits would not limit anything).
 */
export function ipKey(ip) {
  const s = String(ip ?? 'unknown');
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(s);
  if (mapped) return mapped[1];
  const g = ipv6Groups(s);
  if (!g) return s;
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return `${g[6] >> 8}.${g[6] & 255}.${g[7] >> 8}.${g[7] & 255}`;
  return `${g.slice(0, 4).map((x) => x.toString(16)).join(':')}::/64`;
}

/**
 * Fixed-window counter per key. `hit(key)` returns 0 when allowed, otherwise the seconds until the
 * window resets. The map is bounded: when it grows past `maxKeys`, expired windows are dropped,
 * then the oldest windows are evicted. Counters of active keys are never reset wholesale.
 */
export function rateLimiter({ limit, windowMs, now = Date.now, maxKeys = 50_000 }) {
  const windows = new Map();
  return {
    hit(key) {
      const t = now();
      let w = windows.get(key);
      if (!w || w.reset <= t) {
        // Re-insert so that the Map's order is the order of window starts (oldest first).
        windows.delete(key);
        if (windows.size >= maxKeys) {
          for (const [k, v] of windows) if (v.reset <= t) windows.delete(k);
          for (const k of windows.keys()) {
            if (windows.size < maxKeys) break;
            windows.delete(k);
          }
        }
        w = { count: 0, reset: t + windowMs };
        windows.set(key, w);
      }
      w.count++;
      return w.count > limit ? Math.max(1, Math.ceil((w.reset - t) / 1000)) : 0;
    },
    get size() {
      return windows.size;
    },
  };
}

export class BusyError extends Error {
  constructor(message = 'The connector is busy right now. Try again in a moment.') {
    super(message);
    this.name = 'BusyError';
  }
}

/** Counting semaphore; with `maxQueue`, callers beyond the queue are refused with BusyError. */
export function semaphore(max, { maxQueue = Infinity } = {}) {
  let active = 0;
  const queue = [];
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };
  return {
    async run(fn) {
      if (active >= max) {
        if (queue.length >= maxQueue) throw new BusyError();
        await new Promise((r) => queue.push(r));
      } else active++;
      try {
        return await fn();
      } finally {
        release();
      }
    },
    get active() {
      return active;
    },
    get waiting() {
      return queue.length;
    },
  };
}

/** Wraps a transport so that at most `max` calls run against Samsung Food at once (all users together). */
export function limitTransport(transport, sem) {
  return {
    call: (method, payload, opts) => sem.run(() => transport.call(method, payload, opts)),
  };
}

/**
 * Per-user fairness in front of the global cap: each user may have `perUser` calls running (or
 * waiting for the global semaphore) and `perUserQueue` more queued; nobody can fill the global
 * queue alone. `forUser(key)` returns a transport for one user; idle per-user state is dropped.
 */
export function fairTransports(transport, sem, { perUser = 2, perUserQueue = 8 } = {}) {
  const users = new Map();
  const shared = limitTransport(transport, sem);
  return {
    shared,
    forUser(key) {
      return {
        async call(method, payload, opts) {
          let u = users.get(key);
          if (!u) users.set(key, (u = semaphore(perUser, { maxQueue: perUserQueue })));
          try {
            return await u.run(() => shared.call(method, payload, opts));
          } finally {
            if (u.active === 0 && u.waiting === 0 && users.get(key) === u) users.delete(key);
          }
        },
      };
    },
    get users() {
      return users.size;
    },
  };
}
