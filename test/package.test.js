/** Package contents: what `npm publish` would ship, and that the bin files are runnable. */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

test('npm pack contains only src/, bin/, docs/, README.md, CHANGELOG.md, LICENSE and package.json', () => {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const out = execFileSync(npm, ['pack', '--dry-run', '--json', '--ignore-scripts'], {
    cwd: root,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  const [{ files }] = JSON.parse(out);
  const paths = files.map((f) => f.path);
  assert.ok(paths.length > 0);
  for (const p of paths) {
    assert.ok(
      /^(src|bin|docs)\//.test(p) || ['README.md', 'CHANGELOG.md', 'LICENSE', 'package.json'].includes(p),
      `unexpected file in package: ${p}`
    );
  }
  for (const required of ['README.md', 'LICENSE', 'package.json', 'src/index.js', 'src/core/client.js', 'bin/sf.js']) {
    assert.ok(paths.includes(required), `missing from package: ${required}`);
  }
  assert.ok(!paths.some((p) => p.endsWith('.json') && p !== 'package.json'), 'no schema caches');
});

test('bin files exist and start with a node shebang', () => {
  for (const file of Object.values(pkg.bin)) {
    const first = fs.readFileSync(path.join(root, file), 'utf8').split('\n', 1)[0];
    assert.equal(first.trim(), '#!/usr/bin/env node', `${file}: shebang`);
  }
});

test('library entry point resolves', async () => {
  const lib = await import(pkg.name);
  assert.equal(typeof lib.SamsungFood, 'function');
});
