/**
 * Live tests: shopping lists + recipe collections.
 * Only throwaway objects named "mcp-test-<ts>..." are created, changed and deleted.
 * Existing objects are read only (one existing recipe id is used as read-only input).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const authFile = () => path.join(process.env.SAMSUNG_FOOD_HOME ?? path.join(os.homedir(), '.samsung-food'), 'auth.json');
const cachedListId = () => {
  try {
    return JSON.parse(fs.readFileSync(authFile(), 'utf8')).listId ?? null;
  } catch {
    return null;
  }
};

/** The server prefixes copies ("Copy of ", "Kopie von ", ...); strip that before checking for our prefix. */
const COPY_PREFIX = /^(Copy of|Kopie von|Kopie|Copie de|Copia di|Copia de)\s+/i;
const isOurs = (ctx, name) => ctx.isTestName(name) || (typeof name === 'string' && ctx.isTestName(name.replace(COPY_PREFIX, '')));

/** Array results arrive wrapped as {result: [...]}. */
const arr = (x) => (Array.isArray(x) ? x : x?.result ?? []);

export const readSkip = {};

export async function readSamples(ctx) {
  const lists = arr(await ctx.call('shopping_lists'));
  const collections = arr(await ctx.call('collections_list', {}));
  ctx.assert(collections.length > 0, 'account has at least one collection');
  ctx.assert(lists.length > 0, 'account has at least one shopping list');
  return {
    shopping_list_recent_items: { limit: 5 },
    shopping_list_favorites: { limit: 5 },
    collection_get: { collectionId: collections[0].id },
  };
}

async function anExistingRecipeId(ctx) {
  const cols = await ctx.call('collections_list', {});
  for (const c of arr(cols)) {
    if (!c.recipeCount || ctx.isTestName(c.name)) continue;
    const r = await ctx.call('collection_recipes', { collectionId: c.id, limit: 1 });
    if (r.recipes?.[0]?.id) return r.recipes[0].id;
  }
  return null;
}

export async function run(ctx) {
  await shoppingLists(ctx);
  await collections(ctx);
}

const SHARE = process.env.SAMSUNG_FOOD_LIVE_SHARE === '1';
const PRIMARY = process.env.SAMSUNG_FOOD_LIVE_PRIMARY === '1';

/* ------------------------------------------------------------ Shopping lists */

async function shoppingLists(ctx) {
  const toDelete = [];
  let favoriteId = null;
  let originalPrimary = null;
  let primaryChanged = false;
  try {
    const before = arr(await ctx.call('shopping_lists'));
    originalPrimary = before.find((l) => l.isPrimary)?.id ?? null;

    const created = await ctx.call('shopping_list_create', { name: `${ctx.prefix}-list`, items: ['2 onions', 'milk'], addToRecent: false });
    toDelete.push(created.id);
    ctx.assert(created.name === `${ctx.prefix}-list`, 'created list has the name');
    ctx.assert(created.isPrimary === false, 'new list is not primary');
    ctx.assert(created.items.length === 2, 'create returns the 2 initial items');
    const listId = created.id;
    ctx.log(`created list ${listId}`);

    ctx.assert(arr(await ctx.call('shopping_lists')).some((l) => l.id === listId), 'shopping_lists shows the new list');

    await ctx.call('shopping_list_add', { items: ['3 apples'], listId, addToRecent: false });
    let got = await ctx.call('shopping_list_get', { listId });
    ctx.assert(got.items.length === 3, `3 items after add (got ${got.items.length})`);

    const recipeId = await anExistingRecipeId(ctx);
    if (recipeId) {
      await ctx.call('shopping_list_add_recipe', { recipeId, listId });
      got = await ctx.call('shopping_list_get', { listId });
      ctx.assert(got.items.length > 3, `recipe ingredients added (items now ${got.items.length})`);
      ctx.log('added ingredients of an existing recipe (read-only input) to the temp list');
    } else ctx.log('no existing recipe found, skipping shopping_list_add_recipe');

    const first = got.items[0].id;
    await ctx.call('shopping_list_update', { itemIds: [first], action: 'check', listId });
    got = await ctx.call('shopping_list_get', { listId });
    ctx.assert(got.items.find((i) => i.id === first)?.checked === true, 'item checked');
    await ctx.call('shopping_list_update', { itemIds: [first], action: 'uncheck', listId });
    got = await ctx.call('shopping_list_get', { listId });
    ctx.assert(got.items.find((i) => i.id === first)?.checked === false, 'item unchecked');
    const n = got.items.length;
    await ctx.call('shopping_list_update', { itemIds: [first], action: 'delete', listId });
    got = await ctx.call('shopping_list_get', { listId });
    ctx.assert(got.items.length === n - 1, 'item deleted');

    const renamed = await ctx.call('shopping_list_rename', { listId, name: `${ctx.prefix}-list-renamed` });
    ctx.assert(renamed.name === `${ctx.prefix}-list-renamed`, 'renamed');
    got = await ctx.call('shopping_list_get', { listId });
    ctx.assert(got.name === `${ctx.prefix}-list-renamed`, 'rename visible in shopping_list_get');

    // favorites round trip (cleaned in finally)
    const fav = await ctx.call('shopping_list_favorites_modify', {
      ops: [{ op: 'create', name: `${ctx.prefix}-fav`, quantity: 2, unit: 'kg' }],
    });
    favoriteId = fav.created[0]?.id;
    ctx.assert(favoriteId, 'favorite created');
    let favs = await ctx.call('shopping_list_favorites', { limit: 100 });
    ctx.assert(favs.items.some((f) => f.id === favoriteId), 'favorite listed');
    const upd = await ctx.call('shopping_list_favorites_modify', {
      ops: [{ op: 'update', id: favoriteId, name: `${ctx.prefix}-fav2`, quantity: 3, unit: 'kg' }],
    });
    ctx.assert(upd.updated[0]?.name === `${ctx.prefix}-fav2`, 'favorite updated');
    const del = await ctx.call('shopping_list_favorites_modify', { ops: [{ op: 'delete', id: favoriteId }] });
    ctx.assert(del.deleted[0] === favoriteId, 'favorite deleted');
    favoriteId = null;
    favs = await ctx.call('shopping_list_favorites', { limit: 100 });
    ctx.assert(!favs.items.some((f) => ctx.isTestName(f.name)), 'no test favorite left');

    const recent = await ctx.call('shopping_list_recent_items', { limit: 5 });
    ctx.assert(typeof recent.total === 'number', 'recent items total');

    if (SHARE) {
      const share = await ctx.call('shopping_list_share_link', { listId });
      ctx.assert(/^https:\/\//.test(share.link ?? ''), `share link generated (${share.link})`);
    } else ctx.log('shopping_list_share_link skipped (opt-in: SAMSUNG_FOOD_LIVE_SHARE=1)');

    // copy of the TEMP list, then delete the copy
    const copy = await ctx.call('shopping_list_copy', { listId });
    toDelete.push(copy.id);
    ctx.log(`copy named "${copy.name}"`);
    ctx.assert(copy.id !== listId, 'copy has its own id');
    await ctx.call('shopping_list_rename', { listId: copy.id, name: `${ctx.prefix}-list-copy` });
    await ctx.call('shopping_list_delete', { listId: copy.id });
    ctx.assert(!arr(await ctx.call('shopping_lists')).some((l) => l.id === copy.id), 'copy deleted');
    toDelete.splice(toDelete.indexOf(copy.id), 1);

    // set primary on the temp list, deleting the primary must be refused, then restore the original
    if (PRIMARY && originalPrimary) {
      primaryChanged = true;
      const sp = await ctx.call('shopping_list_set_primary', { listId });
      ctx.assert(sp.changed === true && sp.previousPrimaryId === originalPrimary, 'primary changed');
      ctx.assert(cachedListId() === listId, 'cached list id follows the new primary');
      const refused = await ctx.raw('shopping_list_delete', { listId });
      ctx.assert(refused.isError && /primary/i.test(refused.text), 'primary list cannot be deleted');
      const noop = await ctx.call('shopping_list_set_primary', { listId });
      ctx.assert(noop.changed === false, 'setting the same primary again is a no-op');
    } else ctx.log('shopping_list_set_primary skipped (opt-in: SAMSUNG_FOOD_LIVE_PRIMARY=1; it briefly changes your real primary list)');
  } finally {
    // Every cleanup step on its own, so one failure cannot skip the rest.
    const steps = [];
    if (primaryChanged && originalPrimary) {
      steps.push(async () => {
        await ctx.call('shopping_list_set_primary', { listId: originalPrimary });
        const after = arr(await ctx.call('shopping_lists'));
        ctx.assert(after.find((l) => l.isPrimary)?.id === originalPrimary, 'original primary list restored');
        ctx.assert(cachedListId() === originalPrimary, 'cached list id restored');
      });
    }
    if (favoriteId) steps.push(() => ctx.call('shopping_list_favorites_modify', { ops: [{ op: 'delete', id: favoriteId }] }));
    for (const id of toDelete) steps.push(() => ctx.call('shopping_list_delete', { listId: id }));
    for (const step of steps) await step().catch((e) => ctx.log(`cleanup step failed: ${e.message}`));
  }
}

/* ------------------------------------------------------------- Collections */

async function collections(ctx) {
  const toDelete = [];
  let recipeId = null;
  try {
    const col = await ctx.call('collection_create', { name: `${ctx.prefix}-col` });
    toDelete.push(col.id);
    ctx.assert(col.accessMode === 'private', 'collection is private by default');
    let got = await ctx.call('collection_get', { collectionId: col.id });
    ctx.assert(got.name === `${ctx.prefix}-col` && got.recipeCount === 0, 'collection_get after create');
    const col2 = await ctx.call('collection_create', { name: `${ctx.prefix}-col2` });
    toDelete.push(col2.id);

    // temp recipe: membership changes only ever touch this one
    const recipe = await ctx.call('recipe_create', {
      name: `${ctx.prefix}-recipe`,
      ingredients: ['1 egg'],
      instructions: ['Boil the egg.'],
    });
    recipeId = recipe.id;

    let r = await ctx.call('collection_add_recipes', { collectionId: col.id, recipeIds: [recipeId] });
    ctx.assert(r.added.length === 1 && !r.failed.length, `recipe added (${JSON.stringify(r)})`);
    r = await ctx.call('collection_add_recipes', { collectionId: col2.id, recipeIds: [recipeId] });
    ctx.assert(r.added.length === 1, 'recipe added to second collection');
    r = await ctx.call('collection_add_recipes', { collectionId: col.id, recipeIds: [recipeId] });
    ctx.assert(r.unchanged.length === 1 && !r.added.length, 'adding twice is unchanged');
    got = await ctx.call('collection_get', { collectionId: col.id });
    ctx.assert(got.recipeCount === 1, 'recipeCount 1');
    const inCol = await ctx.call('collection_recipes', { collectionId: col.id });
    ctx.assert(inCol.recipes.some((x) => x.id === recipeId), 'collection_recipes lists the recipe');

    r = await ctx.call('collection_remove_recipes', { collectionId: col.id, recipeIds: [recipeId] });
    ctx.assert(r.removed.length === 1, 'recipe removed');
    got = await ctx.call('collection_get', { collectionId: col.id });
    ctx.assert(got.recipeCount === 0, 'recipeCount back to 0');
    got = await ctx.call('collection_get', { collectionId: col2.id });
    ctx.assert(got.recipeCount === 1, 'membership of the other collection untouched');
    r = await ctx.call('collection_remove_recipes', { collectionId: col.id, recipeIds: [recipeId] });
    ctx.assert(r.unchanged.length === 1, 'removing twice is unchanged');

    const upd = await ctx.call('collection_update', { collectionId: col.id, name: `${ctx.prefix}-col-renamed`, accessMode: 'public' });
    ctx.assert(upd.name === `${ctx.prefix}-col-renamed` && upd.accessMode === 'public', 'rename + public');

    if (SHARE) {
      const share = await ctx.call('collection_share_link', { collectionId: col.id });
      ctx.assert(/^https:\/\//.test(share.link ?? ''), `share link generated (${share.link})`);
    } else ctx.log('collection_share_link skipped (opt-in: SAMSUNG_FOOD_LIVE_SHARE=1)');

    await ctx.call('collection_add_recipes', { collectionId: col.id, recipeIds: [recipeId] });
    const copy = await ctx.call('collection_copy', { collectionId: col.id });
    toDelete.push(copy.id);
    ctx.log(`copy named "${copy.name}" with ${copy.recipeCount} recipe(s)`);
    ctx.assert(copy.id !== col.id, 'copy has its own id');
    await ctx.call('collection_update', { collectionId: copy.id, name: `${ctx.prefix}-col-copy` });
    await ctx.call('collection_delete', { collectionId: copy.id });
    toDelete.splice(toDelete.indexOf(copy.id), 1);

    // deleting a collection keeps its recipes
    await ctx.call('collection_delete', { collectionId: col.id });
    toDelete.splice(toDelete.indexOf(col.id), 1);
    const still = await ctx.call('recipe_get', { recipeId });
    ctx.assert(still.id === recipeId || still.name === `${ctx.prefix}-recipe`, 'recipe survives collection delete');
    const names = arr(await ctx.call('collections_list', { limit: 100 })).map((c) => c.id);
    ctx.assert(!names.includes(col.id), 'collection gone from collections_list');
  } finally {
    for (const id of toDelete) await ctx.call('collection_delete', { collectionId: id }).catch((e) => ctx.log(`cleanup step failed: ${e.message}`));
    if (recipeId) await ctx.call('recipe_delete', { recipeId }).catch((e) => ctx.log(`cleanup step failed: ${e.message}`));
  }
}

/* ------------------------------------------------------------------ Cleanup */

export async function cleanup(ctx) {
  let removed = 0;

  const lists = await ctx.call('shopping_lists');
  for (const l of arr(lists)) {
    if (!isOurs(ctx, l.name)) continue;
    if (l.isPrimary) {
      ctx.log(`test list ${l.id} is primary; not deleting automatically`);
      continue;
    }
    const r = await ctx.raw('shopping_list_delete', { listId: l.id });
    if (!r.isError) removed++;
  }

  const favs = await ctx.call('shopping_list_favorites', { limit: 100 });
  const ours = (favs.items ?? []).filter((f) => ctx.isTestName(f.name));
  if (ours.length) {
    await ctx.call('shopping_list_favorites_modify', { ops: ours.map((f) => ({ op: 'delete', id: f.id })) });
    removed += ours.length;
  }

  const cols = await ctx.call('collections_list', { limit: 100 });
  for (const c of arr(cols)) {
    if (!isOurs(ctx, c.name)) continue;
    const r = await ctx.raw('collection_delete', { collectionId: c.id });
    if (!r.isError) removed++;
  }

  // temp recipes created by the collection tests
  const found = await ctx.call('recipe_search', { query: `${ctx.prefix.replace(/\d+$/, '')}`, limit: 50 });
  for (const rec of found.recipes ?? []) {
    if (!ctx.isTestName(rec.name)) continue;
    const r = await ctx.raw('recipe_delete', { recipeId: rec.id });
    if (!r.isError) removed++;
  }
  return removed;
}
