// Serves site/dist under the GitHub Pages base path (/unofficial-samsung-food-mcp/), with the
// same 404 behaviour as Pages. No dependencies.
//   node scripts/serve.mjs [--port 4327]
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = fileURLToPath(new URL('../dist/', import.meta.url));
const BASE = '/unofficial-samsung-food-mcp/';
const i = process.argv.indexOf('--port');
const PORT = Number(i > 0 ? process.argv[i + 1] : process.env.PORT ?? 4327);
const TYPES = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript', '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.json': 'application/json', '.txt': 'text/plain', '.xml': 'application/xml' };

http
  .createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/' || url.pathname === BASE.slice(0, -1)) {
      res.writeHead(302, { Location: BASE });
      return res.end();
    }
    let file = null;
    if (url.pathname.startsWith(BASE)) {
      const rel = decodeURIComponent(url.pathname.slice(BASE.length));
      const p = path.join(DIST, rel);
      if (p.startsWith(DIST)) {
        const cand = fs.existsSync(p) && fs.statSync(p).isDirectory() ? path.join(p, 'index.html') : p;
        if (fs.existsSync(cand)) file = cand;
      }
    }
    const status = file ? 200 : 404;
    file ??= path.join(DIST, '404.html');
    res.writeHead(status, { 'Content-Type': TYPES[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  })
  .listen(PORT, '127.0.0.1', () => console.log(`serving site/dist at http://127.0.0.1:${PORT}${BASE}`));
