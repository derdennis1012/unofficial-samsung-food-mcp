/**
 * CLI tests: bin/sf.js as a child process with an isolated SAMSUNG_FOOD_HOME (schema fixture, no
 * token) and fetch disabled, so nothing can reach the network or the user's real config.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { TOOLS } from '../src/tools/index.js';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
// Preloaded into the child; URI-encoded because NODE_OPTIONS splits on spaces.
const NO_NETWORK = `data:text/javascript,${encodeURIComponent('globalThis.fetch = async (u) => { throw new Error(`network disabled in tests: ${u}`); };')}`;

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cli-'));
fs.copyFileSync(path.join(root, 'test/fixtures/schema.json'), path.join(home, 'schema.json'));
const env = { ...process.env, SAMSUNG_FOOD_HOME: home, NODE_OPTIONS: `--import=${NO_NETWORK}` };
delete env.SAMSUNG_FOOD_TOKEN;
process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }));

/** Runs sf without a terminal on stdin (spawnSync pipes it), like a script or CI job would. */
function sf(...args) {
  const res = spawnSync(process.execPath, [path.join(root, 'bin/sf.js'), ...args], { env, encoding: 'utf8', timeout: 15000, input: '' });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

/** Errors from argument parsing; anything else means the command got past it (and then fails offline). */
const ARG_ERROR = /Usage:|needs a value|takes no value|Unknown option/;

test('sf --version prints the package version', () => {
  const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const res = sf('--version');
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), version);
});

test('boolean flags do not swallow the next positional argument', () => {
  // The item ID / text after the flag must stay a positional argument: the command gets past its
  // usage check and only fails later (no login, offline fixture schema).
  for (const args of [
    ['pantry', 'rm', '--yes', 'item1'],
    ['list', 'add', '--json', 'milk'],
    ['plan', 'rm', '--yes', 'meal1'],
  ]) {
    const res = sf(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.doesNotMatch(res.stderr, ARG_ERROR, `sf ${args.join(' ')}: ${res.stderr}`);
  }
});

test('value flags need a value; unknown options are rejected', () => {
  for (const [args, message] of [
    [['list', 'add', 'milk', '--list'], /--list needs a value/],
    [['list', 'add', '--list', '--json', 'milk'], /--list needs a value/],
    [['plan', '--days='], /--days needs a value/],
    [['plan', '--json=yes'], /--json takes no value/],
    [['plan', '--bogus'], /Unknown option --bogus/],
  ]) {
    const res = sf(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, message, `sf ${args.join(' ')}: ${res.stderr}`);
  }
  // --name=value is accepted.
  assert.doesNotMatch(sf('list', 'add', '--list=abc', 'milk').stderr, ARG_ERROR);
});

test('destructive commands refuse without a terminal unless --yes is given', () => {
  for (const args of [
    ['plan', 'rm', 'meal1'],
    ['plan', 'clear'],
    ['plan', 'clear', '--unscheduled'],
    ['list', 'rm', 'item1'],
    ['pantry', 'rm', 'item1', 'item2'],
    ['plan', 'template', 'rm', 'tpl1'],
    ['plan', 'template', 'apply', 'tpl1', '--replace'],
  ]) {
    const res = sf(...args);
    assert.equal(res.status, 1, args.join(' '));
    assert.match(res.stderr, /Refusing to .* without confirmation\. Pass --yes\./, `sf ${args.join(' ')}: ${res.stderr}`);
    const confirmed = sf(...args, '--yes');
    assert.doesNotMatch(confirmed.stderr, /Refusing/, `sf ${args.join(' ')} --yes`);
  }
  // Applying a template without --replace only adds meals: no question.
  assert.doesNotMatch(sf('plan', 'template', 'apply', 'tpl1').stderr, /Refusing/);
  // Missing arguments give the usage error, not a question.
  assert.match(sf('pantry', 'rm').stderr, /Usage: sf pantry rm/);
});

test('sf call uses the api_call guard before any network access', () => {
  for (const method of ['whisk.x.auth.v1.AuthAPI/Login', 'whisk.x.user.v1.UserAPI/DeleteMe']) {
    const res = sf('call', method, '{}');
    assert.equal(res.status, 1);
    assert.match(res.stderr, /refuses .*credential methods/, res.stderr);
  }
  assert.match(sf('call', 'whisk.x.list.v1.ListAPI/GetLists', '{not json').stderr, /must be JSON/);
});

test('sf login with the credential as an argument warns about shell history', () => {
  const res = sf('login', 'not-a-token');
  assert.equal(res.status, 1);
  assert.match(res.stderr, /shell history/);
  assert.doesNotMatch(sf('logout').stderr, /shell history/);
});

test('sf tools lists every tool with area and access, offline', () => {
  const res = sf('tools');
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, new RegExp(`^${TOOLS.length} tools`));
  assert.match(res.stdout, /meal_plan_apply_template\s+destructive/);
  assert.match(res.stdout, /meal_plan_get\s+read-only/);

  const json = sf('tools', '--json');
  assert.equal(json.status, 0, json.stderr);
  const rows = JSON.parse(json.stdout);
  assert.equal(rows.length, TOOLS.length);
  for (const r of rows) {
    assert.ok(r.name && r.area && r.description, JSON.stringify(r));
    assert.ok(['read-only', 'write', 'destructive'].includes(r.access), r.name);
  }
});

test('help mentions --version, tools and the --json rule', () => {
  const res = sf('help');
  assert.equal(res.status, 0);
  assert.match(res.stdout, /sf --version/);
  assert.match(res.stdout, /sf tools/);
  assert.match(res.stdout, /add --json for the raw JSON/);
});
