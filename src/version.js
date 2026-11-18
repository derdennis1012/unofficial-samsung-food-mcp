/**
 * Package version and the User-Agent sent with every request. An honest UA: a faked browser UA
 * from Node's TLS stack is flagged by Cloudflare (403 "cf-mitigated: challenge").
 */

import fs from 'node:fs';

export const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const USER_AGENT = `unofficial-samsung-food-mcp/${VERSION} (+https://github.com/derdennis1012/unofficial-samsung-food-mcp)`;
