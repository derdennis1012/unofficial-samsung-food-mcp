/**
 * Local browser login for `sf login` / `sf setup`: a short-lived server on 127.0.0.1:<random port>
 * serves the handover page, the CLI opens it in the browser and waits until the session arrived and
 * was verified (GetMe), then stores it and exits.
 *
 * Only loopback, only for one login, closed afterwards. Requests whose Host header is not the
 * loopback address and port are refused (DNS rebinding). The URL the CLI opens carries a random
 * secret (`/?k=...`): other local processes can reach the port, but without the secret they cannot
 * start a pending login, so they cannot complete this login with a session of their own.
 */

import crypto from 'node:crypto';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { createHandover, loginCookieHeader, randomId, HANDOVER_TTL_MS } from './handover.js';
import { loginPage, landingPage, messagePage, newScriptNonce, pageCsp } from './page.js';
import { baseHeaders, handleHandoverApi, sendHtml, sendJson } from './http.js';

export const LOGIN_TIMEOUT_MS = HANDOVER_TTL_MS;

/** Opens a URL in the default browser; returns false if no launcher is available. */
export function openInBrowser(url) {
  const [cmd, ...args] =
    process.platform === 'darwin' ? ['open', url] : process.platform === 'win32' ? ['cmd', '/c', 'start', '', url.replace(/&/g, '^&')] : ['xdg-open', url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}

/**
 * Starts the login server.
 * @param {object} o
 * @param {(token: string) => Promise<{account: string}>} o.verify  validates and stores the session
 * @param {number} [o.timeoutMs]
 * @param {number} [o.port]   0 = random free port
 * @returns {Promise<{url: string, port: number, result: Promise<{account: string}>, close: () => void}>}
 */
export async function startLocalLogin({ verify, timeoutMs = LOGIN_TIMEOUT_MS, port = 0, closeDelayMs = 4000 } = {}) {
  const handover = createHandover({
    ttlMs: timeoutMs,
    verify: async (token) => {
      const r = await verify(token);
      return { ...r, public: { account: r.account } };
    },
  });
  let settle;
  const result = new Promise((resolve, reject) => (settle = { resolve, reject }));
  let finished = false;
  let origin;
  const allowedHosts = new Set();
  const secret = randomId();
  const secretHash = crypto.createHash('sha256').update(secret).digest();
  const hasSecret = (k) => typeof k === 'string' && crypto.timingSafeEqual(crypto.createHash('sha256').update(k).digest(), secretHash);

  const server = http.createServer((req, res) => {
    baseHeaders(res);
    const host = String(req.headers.host ?? '');
    if (!allowedHosts.has(host)) {
      res.writeHead(421, { 'Content-Type': 'text/plain' });
      return res.end('Wrong host');
    }
    const reqUrl = new URL(req.url ?? '/', 'http://localhost');
    const path = reqUrl.pathname;
    const reqOrigin = `http://${host}`;
    handleHandoverApi(req, res, path, {
      handover,
      origin: reqOrigin,
      onVerified: (_n, p) => {
        // Only pending logins created through the secret URL can finish the login.
        if (finished || p.extra.secret !== true) return;
        finished = true;
        settle.resolve({ account: p.result.account, ...p.result });
        // Leave the server up for a moment so the waiting page can read the status.
        setTimeout(close, closeDelayMs).unref();
      },
    })
      .then((handled) => {
        if (handled) return;
        const scriptNonce = newScriptNonce();
        const csp = { 'Content-Security-Policy': pageCsp(scriptNonce) };
        if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: { code: 'method_not_allowed', message: 'Method not allowed' } });
        if (path === '/') {
          if (!hasSecret(reqUrl.searchParams.get('k'))) {
            return sendHtml(res, 403, messagePage({ title: 'Link incomplete', html: '<p>Open the full link that <code>sf login</code> printed in the terminal.</p>', scriptNonce }), csp);
          }
          if (finished) return sendHtml(res, 200, messagePage({ title: 'Already connected', html: '<p>You are logged in. You can close this tab.</p>', scriptNonce }), csp);
          const { nonce, cookie } = handover.begin({ secret: true });
          return sendHtml(
            res,
            200,
            loginPage({
              mode: 'local',
              nonce,
              landingUrl: `${reqOrigin}/login/landing`,
              endpoints: { handover: '/login/handover', status: '/login/status' },
              scriptNonce,
              heading: 'Log in to Samsung Food',
              intro: '<p class="muted">This page belongs to <code>sf login</code> on your computer and only runs until you are logged in. Your session stays on this computer.</p>',
              doneHtml: '<p>Done. The session is stored on this computer and renews itself. You can close this tab and go back to the terminal.</p>',
            }),
            { ...csp, 'Set-Cookie': loginCookieHeader(cookie, { secure: false, maxAgeSec: timeoutMs / 1000 }) }
          );
        }
        if (path === '/login/landing') {
          return sendHtml(res, 200, landingPage({ endpoints: { handover: '/login/handover' }, scriptNonce, returnHint: 'You are logged in. You can close this tab; the terminal already knows.' }), csp);
        }
        sendJson(res, 404, { ok: false, error: { code: 'not_found', message: 'Not found' } });
      })
      .catch(() => {
        if (!res.headersSent) sendJson(res, 500, { ok: false, error: { code: 'internal_error', message: 'Internal error' } });
      });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  const actual = server.address().port;
  allowedHosts.add(`127.0.0.1:${actual}`);
  allowedHosts.add(`localhost:${actual}`);
  origin = `http://127.0.0.1:${actual}`;

  const timer = setTimeout(() => {
    if (finished) return;
    finished = true;
    settle.reject(new Error(`No login within ${Math.round(timeoutMs / 60000)} minutes. Run \`sf login\` again (or \`sf login --paste\` to paste the session in the terminal).`));
    close();
  }, timeoutMs);
  timer.unref();

  function close() {
    clearTimeout(timer);
    server.closeAllConnections?.();
    server.close(() => {});
  }

  return {
    url: `${origin}/?k=${secret}`,
    port: actual,
    result,
    close: () => {
      if (!finished) {
        finished = true;
        settle.reject(new Error('Login cancelled.'));
      }
      close();
    },
  };
}
