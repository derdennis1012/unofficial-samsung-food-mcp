import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ensureFreshToken } from '../src/session.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

test('a renewal that settles synchronously does not leave a stale in-flight promise behind', async () => {
  const authFile = path.join(tmpHome, 'auth.json');
  const expiresAt = new Date(Date.now() + 86400000).toISOString(); // 1 day left: renewal due
  fs.writeFileSync(authFile, JSON.stringify({ accessToken: 'tok', expiresAt }));
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const codec = { schema: { rpcs: {} } }; // renewToken fails at once (schema lacks AuthAPI)

  // The inner re-check sees a clock 30 days earlier, so the body returns without awaiting anything.
  const realNow = Date.now;
  let n = 0;
  Date.now = () => (++n >= 3 ? realNow() - 30 * 86400000 : realNow());
  try {
    assert.equal(await ensureFreshToken({ codec, transport: {}, warn }), 'tok');
  } finally {
    Date.now = realNow;
  }
  assert.equal(warnings.length, 0, 'no renewal attempted in the first call');

  // Second call: renewal is due again and must actually be attempted (not answered from a cached promise).
  assert.equal(await ensureFreshToken({ codec, transport: {}, warn }), 'tok');
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /token renewal failed/);
});

test('SAMSUNG_FOOD_HOME: empty falls back to the default, relative is resolved', () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cwd-'));
  const configDir = (value) =>
    execFileSync(process.execPath, ['--input-type=module', '-e', `import(${JSON.stringify(pathToFileURL(path.join(root, 'src/auth.js')).href)}).then((m) => process.stdout.write(m.CONFIG_DIR))`], {
      cwd,
      env: { ...process.env, SAMSUNG_FOOD_HOME: value },
    }).toString();
  try {
    assert.equal(configDir(''), path.join(os.homedir(), '.samsung-food'));
    assert.equal(configDir('rel/dir'), path.join(fs.realpathSync(cwd), 'rel/dir'));
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true });
  }
});
