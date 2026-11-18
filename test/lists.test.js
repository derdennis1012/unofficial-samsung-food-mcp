import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { tmpHome } from './setup.js';

const { SamsungFood } = await import('../src/client.js');
const { methods } = await import('../src/api/lists.js');
const { tools } = await import('../src/tools/lists.js');
const { readSchema } = await import('../src/schema-build.js');


/* ------------------------------------------------------------------ tools */

const byName = Object.fromEntries(tools.map((t) => [t.name, t]));
const ok = (name, args) => assert.ok(byName[name].schema.safeParse(args).success, `${name} should accept ${JSON.stringify(args)}`);
const bad = (name, args) => assert.ok(!byName[name].schema.safeParse(args).success, `${name} should reject ${JSON.stringify(args)}`);

const EXPECTED = {
  shopping_list_create: 'write',
  shopping_list_rename: 'update',
  shopping_list_delete: 'destructive',
  shopping_list_copy: 'write',
  shopping_list_set_primary: 'update',
  shopping_list_recent_items: 'read',
  shopping_list_favorites: 'read',
  shopping_list_favorites_modify: 'destructive',
  shopping_list_share_link: 'update',
  collection_get: 'read',
  collection_create: 'write',
  collection_update: 'update',
  collection_delete: 'destructive',
  collection_copy: 'write',
  collection_add_recipes: 'update',
  collection_remove_recipes: 'destructive',
  collection_share_link: 'update',
};

test('all list/collection tools exist with the expected kind', () => {
  assert.deepEqual(tools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
  for (const t of tools) {
    const ann = t.annotations;
    const kind = EXPECTED[t.name];
    assert.equal(ann.readOnlyHint, kind === 'read', `${t.name} readOnlyHint`);
    assert.equal(ann.destructiveHint, kind === 'destructive', `${t.name} destructiveHint`);
    assert.ok(t.description.length > 20, `${t.name} has a real description`);
    assert.equal(typeof t.handler, 'function');
  }
});

test('every example parses and unknown keys are rejected', () => {
  for (const t of tools) {
    const r = t.schema.safeParse(t.example);
    assert.ok(r.success, `${t.name} example: ${r.error?.message}`);
    assert.ok(!t.schema.safeParse({ ...t.example, bogus: 1 }).success, `${t.name} must be strict`);
  }
});

test('ID arguments are validated', () => {
  const idTools = [
    ['shopping_list_rename', 'listId', { name: 'x' }],
    ['shopping_list_delete', 'listId', {}],
    ['shopping_list_copy', 'listId', {}],
    ['shopping_list_set_primary', 'listId', {}],
    ['shopping_list_share_link', 'listId', {}],
    ['collection_get', 'collectionId', {}],
    ['collection_update', 'collectionId', { name: 'x' }],
    ['collection_delete', 'collectionId', {}],
    ['collection_copy', 'collectionId', {}],
    ['collection_share_link', 'collectionId', {}],
  ];
  for (const [name, key, rest] of idTools) {
    ok(name, { [key]: '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', ...rest });
    bad(name, { [key]: '', ...rest });
    bad(name, { [key]: 'two words', ...rest });
    bad(name, { ...rest }); // missing
    bad(name, { [key]: 42, ...rest });
  }
});

test('shopping_list_create validation', () => {
  ok('shopping_list_create', { name: 'Party' });
  ok('shopping_list_create', { name: 'Party', items: ['milk'] });
  bad('shopping_list_create', {});
  bad('shopping_list_create', { name: '   ' });
  bad('shopping_list_create', { name: 'Party', items: [''] });
  bad('shopping_list_create', { name: 'Party', items: Array(101).fill('milk') });
  bad('shopping_list_create', { name: 'x'.repeat(201) });
});

test('limit arguments are capped at 100', () => {
  for (const name of ['shopping_list_recent_items', 'shopping_list_favorites']) {
    ok(name, {});
    ok(name, { limit: 100 });
    bad(name, { limit: 0 });
    bad(name, { limit: 101 });
    bad(name, { limit: 2.5 });
  }
});

test('shopping_list_favorites_modify validation', () => {
  const t = 'shopping_list_favorites_modify';
  ok(t, { ops: [{ op: 'create', name: 'milk', quantity: 1, unit: 'l' }] });
  ok(t, { ops: [{ op: 'update', id: 'abc123', name: 'milk' }, { op: 'delete', id: 'abc123' }] });
  bad(t, { ops: [] });
  bad(t, {});
  bad(t, { ops: [{ op: 'merge', name: 'x' }] });
  bad(t, { ops: [{ op: 'create' }] });
  bad(t, { ops: [{ op: 'create', name: 'milk', quantity: -1 }] });
  bad(t, { ops: [{ op: 'update', id: 'abc123' }] }); // update replaces the item, name required
  bad(t, { ops: [{ op: 'update', name: 'milk' }] });
  bad(t, { ops: [{ op: 'delete', id: 'bad id' }] });
  bad(t, { ops: [{ op: 'delete', id: 'abc123', name: 'extra' }] });
  bad(t, { ops: Array(51).fill({ op: 'delete', id: 'abc123' }) });
});

test('collection access modes and names are validated', () => {
  ok('collection_create', { name: 'Soups' });
  ok('collection_create', { name: 'Soups', accessMode: 'public' });
  bad('collection_create', { name: '' });
  bad('collection_create', { name: 'Soups', accessMode: 'secret' });
  bad('collection_create', { name: 'Soups', accessMode: 2 });
  ok('collection_update', { collectionId: '105abc', accessMode: 'public' });
  bad('collection_update', { collectionId: '105abc', accessMode: 'PUBLIC' });
  bad('collection_update', { collectionId: '105abc', name: '' });
});

test('collection_add_recipes / collection_remove_recipes validation', () => {
  for (const t of ['collection_add_recipes', 'collection_remove_recipes']) {
    ok(t, { collectionId: '105abc', recipeIds: ['107abc', '101def'] });
    bad(t, { collectionId: '105abc', recipeIds: [] });
    bad(t, { collectionId: '105abc' });
    bad(t, { collectionId: '105abc', recipeIds: ['bad id'] });
    bad(t, { collectionId: '105abc', recipeIds: [''] });
    bad(t, { collectionId: '105abc', recipeIds: Array(51).fill('107abc') });
    bad(t, { recipeIds: ['107abc'] });
  }
});

/* ----------------------------------------------------------- client methods */

class TestClient extends SamsungFood {}
Object.assign(TestClient.prototype, methods);

/** Mock transport: `responses` maps method suffix → object | function(request) → object. */
function makeClient(responses) {
  const schema = readSchema();
  const calls = [];
  let sf;
  const transport = {
    call: async (method, payload) => {
      const short = method.split('.').slice(-1)[0]; // "ListAPI/CreateList"
      const request = sf.codec.decodeMessage(sf.codec.rpc(method).request, payload);
      calls.push({ method: short, request });
      const handler = responses[short];
      if (handler === undefined) throw new Error(`unexpected call ${short}`);
      const obj = typeof handler === 'function' ? handler(request, calls) : handler;
      return sf.codec.encodeMessage(sf.codec.rpc(method).response, obj);
    },
  };
  sf = new TestClient({ schema, transport, token: 'fake' });
  return { sf, calls };
}
const callsOf = (calls, name) => calls.filter((c) => c.method === name);

const L1 = '10601aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const L2 = '10601bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const C1 = '10501cccccccccccccccccccccccccccccc';
const C2 = '10501dddddddddddddddddddddddddddddd';
const R1 = '10701eeeeeeeeeeeeeeeeeeeeeeeeeeeeee';
const R2 = '10701ffffffffffffffffffffffffffffff';

const getLists = {
  lists: [
    { list: { id: L1, name: 'Home', primary: true }, itemCount: 3 },
    { list: { id: L2, name: 'Party' }, itemCount: 1 },
  ],
};

test('createShoppingList sends name and raw items, returns normalized list', async () => {
  const { sf, calls } = makeClient({
    'ListAPI/CreateList': {
      list: { id: L2, name: 'Party', createdTime: 1700000000 },
      content: {
        items: [
          { id: 'i1', item: { name: 'onions', quantity: 2 }, analysis: { category: { canonicalName: 'FRUITS AND VEGETABLES' } } },
          { id: 'i2', item: { name: 'milk' }, checked: true },
        ],
      },
    },
  });
  const out = await sf.createShoppingList('  Party ', { items: ['2 onions', 'milk'] });
  assert.deepEqual(calls[0].request, {
    name: 'Party',
    items: [{ raw: { text: '2 onions' }, addToRecent: true }, { raw: { text: 'milk' }, addToRecent: true }],
  });
  assert.equal(out.id, L2);
  assert.equal(out.isPrimary, false);
  assert.deepEqual(out.items.map((i) => [i.name, i.quantity, i.checked, i.category]), [
    ['onions', 2, false, 'Fruits and vegetables'],
    ['milk', null, true, null],
  ]);
  await assert.rejects(sf.createShoppingList('  '), /name is required/);
});

test('renameShoppingList', async () => {
  const { sf, calls } = makeClient({ 'ListAPI/UpdateList': { list: { id: L2, name: 'New' } } });
  const out = await sf.renameShoppingList(L2, 'New');
  assert.deepEqual(calls[0].request, { listId: L2, name: 'New' });
  assert.equal(out.name, 'New');
  await assert.rejects(sf.renameShoppingList(L2, ''), /name is required/);
  assert.equal(calls.length, 1);
});

test('deleteShoppingList refuses the primary list and unknown lists, deletes others', async () => {
  const { sf, calls } = makeClient({ 'ListAPI/GetLists': getLists, 'ListAPI/DeleteList': {} });
  await assert.rejects(sf.deleteShoppingList(L1), /primary/);
  await assert.rejects(sf.deleteShoppingList('106zzz'), /not found/);
  assert.equal(callsOf(calls, 'ListAPI/DeleteList').length, 0);
  const out = await sf.deleteShoppingList(L2);
  assert.deepEqual(callsOf(calls, 'ListAPI/DeleteList').map((c) => c.request), [{ listId: L2 }]);
  assert.equal(out.deleted, L2);
  assert.equal(out.name, 'Party');
});

test('copyShoppingList', async () => {
  const { sf, calls } = makeClient({
    'ListAPI/CopyList': { list: { id: L2, name: 'Copy of Home' }, content: { items: [{ id: 'a', item: { name: 'x' } }] } },
  });
  const out = await sf.copyShoppingList(L1);
  assert.deepEqual(calls[0].request, { listId: L1 });
  assert.deepEqual([out.id, out.name, out.itemCount], [L2, 'Copy of Home', 1]);
});

test('setPrimaryShoppingList changes the primary and the in-process list id only when needed', async () => {
  const authFile = path.join(tmpHome, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ accessToken: 'fake' }));
  const { sf, calls } = makeClient({ 'ListAPI/GetLists': getLists, 'ListAPI/SetPrimaryList': {} });

  const same = await sf.setPrimaryShoppingList(L1);
  assert.deepEqual(same, { listId: L1, previousPrimaryId: L1, changed: false });
  assert.equal(callsOf(calls, 'ListAPI/SetPrimaryList').length, 0);

  const changed = await sf.setPrimaryShoppingList(L2);
  assert.deepEqual(changed, { listId: L2, previousPrimaryId: L1, changed: true });
  assert.deepEqual(callsOf(calls, 'ListAPI/SetPrimaryList').map((c) => c.request), [{ listId: L2 }]);
  assert.equal(JSON.parse(fs.readFileSync(authFile, 'utf8')).listId, undefined, 'never persisted');
  assert.equal(await sf.primaryListId(), L2);

  await assert.rejects(sf.setPrimaryShoppingList('106zzz'), /not found/);
  assert.equal(callsOf(calls, 'ListAPI/SetPrimaryList').length, 1);
});

test('recentListItems and favoriteListItems apply the limit and report the total', async () => {
  const items = [1, 2, 3].map((n) => ({ id: `f${n}`, item: { name: `thing ${n}`, quantity: n, unit: 'kg' } }));
  const { sf } = makeClient({
    'ListAPI/GetRecentItems': { items: items.map(({ item }) => ({ item })) },
    'ListFavoriteAPI/GetFavoriteItems': { items },
  });
  const recent = await sf.recentListItems({ limit: 2 });
  assert.equal(recent.total, 3);
  assert.deepEqual(recent.items.map((i) => i.name), ['thing 1', 'thing 2']);
  assert.ok(!('id' in recent.items[0]));
  const fav = await sf.favoriteListItems({ limit: 5 });
  assert.equal(fav.items.length, 3);
  assert.deepEqual([fav.items[2].id, fav.items[2].quantity, fav.items[2].unit], ['f3', 3, 'kg']);
});

test('modifyFavoriteListItems builds create/update/delete ops', async () => {
  const { sf, calls } = makeClient({
    'ListFavoriteAPI/ModifyFavoriteItems': {
      diff: {
        created: [{ id: 'n1', item: { name: 'oat milk', quantity: 1, unit: 'l' } }],
        updated: [{ id: 'u1', item: { name: 'rice' } }],
        deleted: [{ id: 'd1' }],
      },
    },
  });
  const out = await sf.modifyFavoriteListItems([
    { op: 'create', name: 'oat milk', quantity: 1, unit: 'l' },
    { op: 'update', id: 'u1', name: 'rice', brand: 'X' },
    { op: 'delete', id: 'd1' },
  ]);
  assert.deepEqual(calls[0].request.ops, [
    { create: { item: { name: 'oat milk', quantity: 1, unit: 'l' } } },
    { update: { id: 'u1', item: { name: 'rice', brand: 'X' } } },
    { delete: { id: 'd1' } },
  ]);
  assert.deepEqual([out.created[0].name, out.updated[0].name, out.deleted], ['oat milk', 'rice', ['d1']]);
  await assert.rejects(sf.modifyFavoriteListItems([]), /non-empty/);
  await assert.rejects(sf.modifyFavoriteListItems([{ op: 'update', id: 'u1' }]), /name/);
  await assert.rejects(sf.modifyFavoriteListItems([{ op: 'merge' }]), /unknown op/);
  assert.equal(calls.length, 1);
});

test('shoppingListShareLink asks for the copy link only', async () => {
  const { sf, calls } = makeClient({
    'ListSharingAPI/GenerateListLinks': { access: { mode: 1, role: 1, links: [{ medium: 1, link: 'https://s.example/abc' }] } },
  });
  const out = await sf.shoppingListShareLink(L2);
  assert.deepEqual(calls[0].request, { listId: L2, links: [{ medium: 1 }] });
  assert.deepEqual(out, { listId: L2, link: 'https://s.example/abc', accessMode: 'private' });
  assert.equal(callsOf(calls, 'ListSharingAPI/SendListLinks').length, 0);
});

test('getCollection normalizes', async () => {
  const { sf, calls } = makeClient({
    'CollectionAPI/GetCollection': { collection: { id: C1, name: 'Soups' }, recipeCount: 4, access: { mode: 2, role: 1 } },
  });
  const out = await sf.getCollection(C1);
  assert.deepEqual(calls[0].request, { collectionId: C1 });
  assert.deepEqual(out, { id: C1, name: 'Soups', recipeCount: 4, accessMode: 'public', role: 'owner', isShoppingList: false });
});

test('createRecipeCollection is private by default', async () => {
  const { sf, calls } = makeClient({
    'CollectionAPI/CreateCollection': { collection: { id: C1, name: 'Soups' }, access: { mode: 1, role: 1 } },
  });
  const out = await sf.createRecipeCollection('Soups');
  assert.deepEqual(calls[0].request, { name: 'Soups', accessMode: 1 });
  assert.deepEqual([out.id, out.accessMode, out.recipeCount], [C1, 'private', 0]);
  await sf.createRecipeCollection('Soups', { accessMode: 'public' });
  assert.equal(calls[1].request.accessMode, 2);
  await assert.rejects(sf.createRecipeCollection('Soups', { accessMode: 'secret' }), /private/);
  await assert.rejects(sf.createRecipeCollection(''), /name is required/);
});

test('updateCollection renames via UpdateCollection and switches access via SwitchCollectionAccess', async () => {
  const { sf, calls } = makeClient({
    'CollectionAPI/UpdateCollection': { collection: { id: C1, name: 'New' } },
    'CollectionSharingAPI/SwitchCollectionAccess': { access: { mode: 2, role: 1 } },
    'CollectionAPI/GetCollection': { collection: { id: C1, name: 'New' }, recipeCount: 0, access: { mode: 2, role: 1 } },
  });
  const out = await sf.updateCollection(C1, { name: ' New ', accessMode: 'public' });
  assert.deepEqual(calls.map((c) => c.method), [
    'CollectionAPI/UpdateCollection',
    'CollectionSharingAPI/SwitchCollectionAccess',
    'CollectionAPI/GetCollection',
  ]);
  assert.deepEqual(calls[0].request, { collectionId: C1, name: 'New' });
  assert.deepEqual(calls[1].request, { collectionId: C1, mode: 2 });
  assert.deepEqual([out.name, out.accessMode], ['New', 'public']);

  const before = calls.length;
  await assert.rejects(sf.updateCollection(C1, {}), /name and\/or accessMode/);
  await assert.rejects(sf.updateCollection(C1, { name: '   ' }), /name/);
  await assert.rejects(sf.updateCollection(C1, { accessMode: 'x' }), /private/);
  assert.equal(calls.length, before, 'invalid input sends nothing');
});

test('deleteCollection', async () => {
  const { sf, calls } = makeClient({
    'CollectionAPI/GetCollection': (req) =>
      req.collectionId === C1
        ? { collection: { id: C1, name: 'Soups' }, recipeCount: 2, access: { mode: 1, role: 1 } }
        : { collection: { id: C2, name: 'Cart', shoppinglist: true }, recipeCount: 0, access: { mode: 1, role: 1 } },
    'CollectionAPI/DeleteCollection': {},
  });
  const out = await sf.deleteCollection(C1);
  assert.deepEqual(callsOf(calls, 'CollectionAPI/DeleteCollection').map((c) => c.request), [{ collectionId: C1 }]);
  assert.deepEqual(out, { deleted: C1, name: 'Soups', recipeCount: 2 });
  await assert.rejects(sf.deleteCollection(C2), /shopping-list/);
  assert.equal(callsOf(calls, 'CollectionAPI/DeleteCollection').length, 1);
});

test('copyCollection and collectionShareLink', async () => {
  const { sf, calls } = makeClient({
    'CollectionAPI/CopyCollection': { collection: { id: C2, name: 'Copy of Soups' }, recipeCount: 2, access: { mode: 1, role: 1 } },
    'CollectionSharingAPI/GenerateCollectionLinks': {
      links: [{ medium: 1, link: 'https://s.example/xyz' }],
      access: { mode: 2, role: 1 },
    },
  });
  const copy = await sf.copyCollection(C1);
  assert.deepEqual(calls[0].request, { collectionId: C1 });
  assert.deepEqual([copy.id, copy.name, copy.recipeCount], [C2, 'Copy of Soups', 2]);
  const link = await sf.collectionShareLink(C1);
  assert.deepEqual(calls[1].request, { collectionId: C1, links: [{ medium: 1 }] });
  assert.deepEqual(link, { collectionId: C1, link: 'https://s.example/xyz', accessMode: 'public' });
});

/** Mock of the recipe-side membership: recipes map id → saved state. */
function membershipMock(recipes) {
  return {
    'CollectionAPI/GetCollection': { collection: { id: C1, name: 'Soups' }, recipeCount: 0, access: { mode: 1, role: 1 } },
    'RecipeAPI/GetRecipe': (req) => {
      const r = recipes[req.recipeId];
      if (!r) throw new Error('NOT_FOUND');
      return { recipe: { id: req.recipeId, saved: r.saved ? { value: true, owner: r.owner !== false, collections: r.collections.map((id) => ({ id })) } : {} } };
    },
    'RecipeAPI/UpdateRecipe': (req) => {
      // an empty repeated field is not put on the wire, so it arrives as undefined
      const ids = req.collectionIds ?? [];
      recipes[req.recipeId].collections = ids;
      return { recipe: { id: req.recipeId, saved: { value: true, owner: recipes[req.recipeId].owner !== false, collections: ids.map((id) => ({ id })) } } };
    },
  };
}

test('addRecipesToCollection merges into the existing collection list and reports each outcome', async () => {
  const recipes = {
    [R1]: { saved: true, collections: [C2] }, // gets C1 added, keeps C2
    [R2]: { saved: true, collections: [C1] }, // already in
    '107unsaved': { saved: false, collections: [] },
  };
  const { sf, calls } = makeClient(membershipMock(recipes));
  const out = await sf.addRecipesToCollection(C1, [R1, R2, '107unsaved', '107missing', R1]);
  assert.deepEqual(out.added, [R1]);
  assert.deepEqual(out.unchanged, [R2]);
  assert.deepEqual(out.notSaved, ['107unsaved']);
  assert.equal(out.failed.length, 1);
  assert.equal(out.failed[0].recipeId, '107missing');
  const updates = callsOf(calls, 'RecipeAPI/UpdateRecipe');
  assert.equal(updates.length, 1, 'only the recipe that needs a change is written (duplicates ignored)');
  assert.deepEqual(updates[0].request, {
    recipeId: R1,
    updateMask: { paths: ['collection_ids'] },
    collectionIds: [C2, C1],
    recipeMask: { paths: ['saved'] },
  });
  await assert.rejects(sf.addRecipesToCollection(C1, []), /must not be empty/);
});

test('removeRecipesFromCollection keeps the other memberships', async () => {
  const recipes = {
    [R1]: { saved: true, collections: [C1, C2] },
    [R2]: { saved: true, collections: [C2] },
  };
  const { sf, calls } = makeClient(membershipMock(recipes));
  const out = await sf.removeRecipesFromCollection(C1, [R1, R2]);
  assert.deepEqual(out.removed, [R1]);
  assert.deepEqual(out.unchanged, [R2]);
  const updates = callsOf(calls, 'RecipeAPI/UpdateRecipe');
  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0].request.collectionIds, [C2]);

  // removing the only membership sends an empty list (the mask makes that an explicit "no collections")
  recipes[R2].collections = [C1];
  await sf.removeRecipesFromCollection(C1, [R2]);
  const last = callsOf(calls, 'RecipeAPI/UpdateRecipe').at(-1);
  assert.deepEqual(last.request.updateMask, { paths: ['collection_ids'] });
  assert.deepEqual(recipes[R2].collections, []);
});

test('a server that ignores the update is reported as failed', async () => {
  const mock = membershipMock({ [R1]: { saved: true, collections: [] } });
  mock['RecipeAPI/UpdateRecipe'] = () => ({ recipe: { id: R1, saved: { value: true } } });
  const { sf } = makeClient(mock);
  const out = await sf.addRecipesToCollection(C1, [R1]);
  assert.deepEqual(out.added, []);
  assert.equal(out.failed.length, 1);
});


test('removing the last collection of a recipe you do not own is refused', async () => {
  const recipes = { [R1]: { saved: true, owner: false, collections: [C1] } };
  const { sf, calls } = makeClient(membershipMock(recipes));
  const out = await sf.removeRecipesFromCollection(C1, [R1]);
  assert.equal(out.failed.length, 1);
  assert.match(out.failed[0].error, /do not own/);
  assert.equal(callsOf(calls, 'RecipeAPI/UpdateRecipe').length, 0);
});

test('concurrent membership changes of one recipe are serialized and none is lost', async () => {
  const recipes = { [R1]: { saved: true, collections: [] } };
  const { sf } = makeClient(membershipMock(recipes));
  await Promise.all([sf.addRecipesToCollection(C1, [R1]), sf.addRecipesToCollection(C2, [R1])]);
  assert.deepEqual([...recipes[R1].collections].sort(), [C1, C2].sort());
});

test('a lost update is detected and the read-modify-write is repeated once', async () => {
  const recipes = { [R1]: { saved: true, collections: [C2] } };
  const base = membershipMock(recipes);
  let first = true;
  const { sf } = makeClient({
    ...base,
    'RecipeAPI/UpdateRecipe': (req) => {
      if (first) {
        first = false; // another client sneaks in a membership while we write
        recipes[R1].collections = [C2, '10501gggggggggggggggggggggggggggggg'];
        return { recipe: { id: req.recipeId, saved: { value: true, owner: true, collections: [{ id: C2 }] } } };
      }
      return base['RecipeAPI/UpdateRecipe'](req);
    },
  });
  const out = await sf.addRecipesToCollection(C1, [R1]);
  assert.deepEqual(out.added, [R1]);
  assert.ok(recipes[R1].collections.includes(C1) && recipes[R1].collections.includes('10501gggggggggggggggggggggggggggggg'));
});

test('primaryListId: a stale persisted value is ignored and removed, the id is not persisted', async () => {
  const authFile = path.join(tmpHome, 'auth.json');
  fs.writeFileSync(authFile, JSON.stringify({ accessToken: 'fake', mealPlanId: 'mp', listId: '10601stale' }));
  const { sf, calls } = makeClient({ 'ListAPI/GetLists': getLists });
  assert.equal(await sf.primaryListId(), L1);
  assert.equal(callsOf(calls, 'ListAPI/GetLists').length, 1);
  assert.deepEqual(JSON.parse(fs.readFileSync(authFile, 'utf8')), { accessToken: 'fake', mealPlanId: 'mp' });
  assert.equal(await sf.primaryListId(), L1);
  assert.equal(callsOf(calls, 'ListAPI/GetLists').length, 1, 'cached in process');
});

test('a NOT_FOUND for the cached primary list re-fetches the lists once and retries', async () => {
  const { GrpcError } = await import('../src/grpc.js');
  let primary = L1;
  const { sf, calls } = makeClient({
    'ListAPI/GetLists': () => ({ lists: [{ list: { id: primary, name: 'Home', primary: true } }] }),
    'ListAPI/GetList': (req) => {
      if (req.listId !== primary) throw new GrpcError(5, 'ERROR_LIST_NOT_FOUND', 'GetList');
      return { list: { id: primary, name: 'Home' } };
    },
  });
  assert.equal(await sf.primaryListId(), L1);
  primary = L2; // the primary list was replaced elsewhere
  assert.equal((await sf.listItems()).listId, L2);
  assert.deepEqual(callsOf(calls, 'ListAPI/GetList').map((c) => c.request.listId), [L1, L2]);
  assert.equal(callsOf(calls, 'ListAPI/GetLists').length, 2);
  assert.equal(await sf.primaryListId(), L2);

  // NOT_FOUND although the list still exists: surfaced, not retried endlessly
  const { sf: sf2, calls: calls2 } = makeClient({
    'ListAPI/GetLists': getLists,
    'ListAPI/GetList': () => {
      throw new GrpcError(5, 'ERROR_SOMETHING_NOT_FOUND', 'GetList');
    },
  });
  await assert.rejects(sf2.listItems(), /ERROR_SOMETHING_NOT_FOUND/);
  assert.equal(callsOf(calls2, 'ListAPI/GetList').length, 1);
  assert.equal(callsOf(calls2, 'ListAPI/GetLists').length, 2, 're-validated once');
  // an explicit listId is never re-resolved
  await assert.rejects(sf2.listItems(L2), /ERROR_SOMETHING_NOT_FOUND/);
  assert.equal(callsOf(calls2, 'ListAPI/GetList').length, 2);
  assert.equal(callsOf(calls2, 'ListAPI/GetLists').length, 2);
});
