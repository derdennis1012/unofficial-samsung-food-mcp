import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import { extractToken, looksLikeCredential } from '../src/core/auth.js';

// Fake token: 64 characters, not a real credential.
const TOKEN = 'fake0123456789abcdefFAKE0123456789abcdefFAKE0123456789abcdefAAAA';

test('cookie string from document.cookie', () => {
  assert.equal(extractToken(`_whsk=3; whisk.USER_TOKEN=${TOKEN}`), TOKEN);
  assert.equal(extractToken(`whisk.USER_TOKEN=${TOKEN}; other=1`), TOKEN);
});

test('bare token', () => {
  assert.equal(extractToken(TOKEN), TOKEN);
  assert.equal(extractToken(`  ${TOKEN}\n`), TOKEN);
  assert.equal(extractToken(`"${TOKEN}"`), TOKEN);
});

test('Bearer prefix', () => {
  assert.equal(extractToken(`Bearer ${TOKEN}`), TOKEN);
});

test('Authorization header line', () => {
  assert.equal(extractToken(`Authorization: Bearer ${TOKEN}`), TOKEN);
});

test('cURL with -H authorization', () => {
  const curl = `curl 'https://app.samsungfood.com/api/grpc-web/whisk.x.user.v1.UserAPI/GetMe' -H 'accept: */*' -H 'authorization: Bearer ${TOKEN}' --data-raw ''`;
  assert.equal(extractToken(curl), TOKEN);
});

test('cURL with -b cookie', () => {
  const curl = `curl 'https://app.samsungfood.com/' -b '_whsk=3; whisk.USER_TOKEN=${TOKEN}; x=y'`;
  assert.equal(extractToken(curl), TOKEN);
});

test('cURL with Cookie header', () => {
  const curl = `curl 'https://app.samsungfood.com/' -H 'cookie: a=b; whisk.USER_TOKEN=${TOKEN}'`;
  assert.equal(extractToken(curl), TOKEN);
});

test('no token', () => {
  assert.equal(extractToken(''), null);
  assert.equal(extractToken('hello world'), null);
  assert.equal(extractToken(undefined), null);
});

test('JWT-like strings and short strings are not accepted as tokens', () => {
  assert.equal(extractToken('aaaaaaaaaa.bbbbbbbbbb.cccccccccc'), null);
  assert.equal(extractToken('short'), null);
});

test('malformed percent-escapes in the cookie do not throw', () => {
  assert.equal(extractToken('whisk.USER_TOKEN=abc%ZZdef'), 'abc%ZZdef');
});

test('clipboard guard accepts only credential-shaped text', () => {
  assert.equal(looksLikeCredential(`_whsk=3; whisk.USER_TOKEN=${TOKEN}`), true);
  assert.equal(looksLikeCredential(TOKEN), true);
  assert.equal(looksLikeCredential('my shopping list: milk, eggs'), false);
  assert.equal(looksLikeCredential(''), false);
});
