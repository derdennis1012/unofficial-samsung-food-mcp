/**
 * Test environment: a temp SAMSUNG_FOOD_HOME containing a small hand-sized protocol schema
 * fixture (test/fixtures/schema.json), so the offline tests run on a fresh clone without network
 * and never touch the real ~/.samsung-food. Import this module FIRST in every test file that
 * uses the client.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-test-'));
// (Maintainers regenerating the fixture can point SF_FIXTURE_SOURCE at a full cached schema.)
fs.copyFileSync(
  process.env.SF_FIXTURE_SOURCE ?? path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures/schema.json'),
  path.join(tmpHome, 'schema.json')
);
// The offline tests must never reach the network (schema refreshes, food graph, API calls).
globalThis.fetch = async (url) => {
  throw new Error(`network access is disabled in the offline tests (${url})`);
};
process.env.SAMSUNG_FOOD_HOME = tmpHome;
delete process.env.SAMSUNG_FOOD_TOKEN;
process.on('exit', () => fs.rmSync(tmpHome, { recursive: true, force: true }));
