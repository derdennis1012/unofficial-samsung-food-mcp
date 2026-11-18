import { tmpHome } from './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadGraph, lookup, match, storageInfo, expiryFor } from '../src/core/foodgraph.js';
import { SamsungFood } from '../src/core/client.js';
import { readSchema } from '../src/core/schema-build.js';

const days = (max) => ({ min: 1, max, metric: 'DAYS' });
const product = (displayName, storing, def) => ({ canonicalName: displayName.toUpperCase(), displayName, category: 'X', default: def, storing });
// Small fixture in the transformed cache format, written where loadGraph looks first (fresh mtime: no download).
const fixture = {
  locale: 'en-us',
  products: {
    milk: product('Milk', { fridge: days(7) }),
    oil: product('Oil', { pantry: days(365) }),
    chili: product('Chili', { fridge: days(14) }),
    apple: product('Apple', { fridge: days(28) }),
    tomato: product('Tomato', { fridge: days(7) }),
    'chicken breast': product('Chicken breast', { fridge: days(2), freezer: days(270) }, 'fridge'),
    'chicken breast fillet': product('Chicken breast fillet', { fridge: days(2) }),
  },
};
fs.writeFileSync(path.join(tmpHome, 'foodgraph-en-us.json'), JSON.stringify(fixture));
await loadGraph('en-US');

const name = (q) => lookup(q)?.displayName ?? null;

test('exact and singular/plural matches are exact', () => {
  for (const [q, want] of [['milk', 'Milk'], ['  Milk ', 'Milk'], ['apples', 'Apple'], ['tomatoes', 'Tomato'], ['chicken breasts', 'Chicken breast']]) {
    assert.deepEqual([name(q), match(q).exact], [want, true], q);
  }
});

test('no substring matches inside words', () => {
  assert.equal(name('toilet paper'), null);
  assert.equal(name('coil'), null);
  assert.equal(name('milkshake'), null);
});

test('whole-word matches are guesses (exact: false)', () => {
  for (const [q, want] of [['uht milk', 'Milk'], ['oat milk', 'Milk'], ['dried chili', 'Chili'], ['chicken', 'Chicken breast']]) {
    assert.deepEqual([name(q), match(q).exact], [want, false], q);
  }
  // the longest product contained in the name wins
  assert.equal(name('frozen chicken breast fillet'), 'Chicken breast fillet');
});

test('storageInfo flags guesses with a warning; expiryFor never dates a guess', () => {
  const guess = storageInfo('uht milk');
  assert.equal(guess.product, 'Milk');
  assert.equal(guess.exact, false);
  assert.match(guess.warning, /"uht milk" is not in the food graph.*"Milk"/);
  assert.equal(storageInfo('milk').exact, true);
  assert.equal(storageInfo('milk').warning, undefined);
  const from = new Date(2026, 0, 1);
  assert.equal(expiryFor('milk', 'fridge', from), '2026-01-08');
  assert.equal(expiryFor('uht milk', 'fridge', from), null);
  assert.equal(expiryFor('dried chili', 'fridge', from), null);
});

test('pantry_add: an exact match gets an expiry, a guessed one only matchedProduct + warning', async () => {
  const FL = 'whisk.x.foodlist.v1.FoodlistAPI/';
  let added = false;
  const schema = readSchema();
  let sf;
  const transport = {
    call: async (method) => {
      const res = {
        [FL + 'GetItems']: () => ({
          items: added
            ? [
                { id: 'a', name: 'uht milk', location: { code: 1 } },
                { id: 'b', name: 'apples', location: { code: 1 } },
              ]
            : [],
        }),
        [FL + 'AddItems']: () => ((added = true), {}),
      }[method];
      if (!res) throw new Error(`unexpected call ${method}`);
      return sf.codec.encodeMessage(sf.codec.rpc(method).response, res());
    },
  };
  sf = new SamsungFood({ schema, transport, token: 'fake', locale: 'en-US' });
  const patches = [];
  sf.updatePantryItem = async (patch) => (patches.push(patch), {});

  const out = await sf.addPantryItems(['uht milk', 'apples']);
  assert.deepEqual(patches.map((p) => p.id), ['b'], 'only the exact match is dated');
  assert.ok(patches[0].expiryDate);
  const milk = out.find((i) => i.id === 'a');
  assert.equal(milk.matchedProduct, 'Milk');
  assert.match(milk.warning, /No expiry date was set automatically/);
  const apples = out.find((i) => i.id === 'b');
  assert.equal(apples.warning, undefined);
  assert.equal(apples.matchedProduct, undefined);
});
