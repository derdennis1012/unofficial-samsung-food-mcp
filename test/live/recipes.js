/**
 * Live tests, area "recipes" (update, reviews, recent searches, feeds, health suggestions, ...).
 *
 * Safety: only the throwaway recipe "mcp-test-<ts>-recipe" and the recent-search entry
 * "mcp-test-<ts>" are touched. Ratings/reviews are tried on the throwaway recipe only and
 * removed again. Samsung Food keeps just the last 5 recent searches, so searching with the
 * test term pushes real entries out; run() restores the original list afterwards.
 */

import { PREFIX } from './harness.js';

export const readSkip = {};

export async function readSamples(ctx) {
  const discover = await ctx.call('recipe_discover', { limit: 3 });
  const recipeId = (discover.recipes ?? discover.result ?? [])[0]?.id;
  ctx.assert(recipeId, 'recipe_discover returned no recipe to use as sample');
  const mine = await ctx.call('recipe_smart_collection', { collectionId: 'made_it', limit: 1 });
  const day = ctx.futureDate(7);
  return {
    // made_it holds recipes the account owner marked as cooked; reading the own review is harmless
    recipe_review_get: { recipeId: mine.recipes?.[0]?.id ?? recipeId },
    recipe_autocomplete: { query: 'pum', limit: 5, includeRecent: true },
    recipe_categories: { type: 'featured' },
    recipe_smart_collection: { collectionId: 'planned', limit: 5 },
    recipe_recommended: { limit: 5 },
    recipe_health_recommend: { from: day, mealTimes: ['lunch', 'dinner'], limit: 2 },
    recipe_health_alternatives: { date: day, mealTime: 'dinner', limit: 3 },
    recipe_dish_lookup: { urlPath: 'burger/cheeseburger' },
    recipe_more_from_user: { recipeId, limit: 5 },
    recipe_recent_queries: {},
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function recent(ctx) {
  return (await ctx.call('recipe_recent_queries')).queries ?? [];
}

/** Polls until the predicate holds for the recent list (the server is slightly eventually consistent). */
async function waitRecent(ctx, pred) {
  let list = [];
  for (let i = 0; i < 6; i++) {
    list = await recent(ctx);
    if (pred(list)) return list;
    await sleep(700);
  }
  return list;
}

export async function restoreRecent(ctx, original) {
  const now = await recent(ctx);
  if (JSON.stringify(now) === JSON.stringify(original)) return;
  // oldest first, so the original order ends up newest-on-top again
  for (const q of [...original].reverse()) {
    await ctx.call('recipe_search', { query: q, limit: 1 });
    await sleep(300);
  }
  const after = await waitRecent(ctx, (l) => JSON.stringify(l) === JSON.stringify(original));
  if (JSON.stringify(after) !== JSON.stringify(original)) {
    ctx.log(`WARNING: recent searches differ from the original: ${JSON.stringify(original)} -> ${JSON.stringify(after)}`);
  }
}

export async function run(ctx) {
  const name = `${ctx.prefix}-recipe`;
  const originalRecent = await recent(ctx);
  let recipeId;
  let rated = false;
  try {
    // --- create + update + verify
    const created = await ctx.call('recipe_create', {
      name,
      ingredients: ['2 eggs', '200 g flour', '300 ml milk'],
      instructions: ['Whisk everything.', 'Fry in a pan.'],
      description: 'throwaway test recipe',
      servings: 2,
      cookTime: 10,
    });
    recipeId = created.id;
    ctx.assert(recipeId, 'recipe_create returned no id');
    ctx.assert(ctx.isTestName(created.name), 'created recipe has the test prefix');

    const upd = await ctx.call('recipe_update', {
      recipeId,
      name: `${name}-upd`,
      servings: 4,
      instructions: ['Whisk everything well.', 'Fry in a hot pan.', 'Serve.'],
    });
    ctx.assert(upd.updated.includes('name') && upd.updated.includes('servings'), 'update reports the changed fields');
    if (upd.recipe.id !== recipeId) {
      ctx.log(`recipe id changed on update: ${recipeId} -> ${upd.recipe.id}`);
      recipeId = upd.recipe.id;
    }

    const got = await ctx.call('recipe_get', { recipeId });
    ctx.assert(got.name === `${name}-upd`, `name updated (got ${got.name})`);
    ctx.assert(got.servings === 4, `servings updated (got ${got.servings})`);
    ctx.assert(got.instructions.length === 3, 'instructions replaced');
    ctx.assert(got.ingredients.length === 3, 'ingredients untouched by the partial update');
    ctx.assert(got.cookTime === 10, 'cookTime untouched by the partial update');
    ctx.assert(got.description === 'throwaway test recipe', 'description untouched by the partial update');

    // an update without any field is rejected before anything is sent
    const empty = await ctx.raw('recipe_update', { recipeId });
    ctx.assert(empty.isError, 'recipe_update without fields is an error');

    // --- reviews on the throwaway recipe only
    const none = await ctx.call('recipe_review_get', { recipeId });
    ctx.assert(none.review === null, 'no review on a fresh recipe');

    const rate = await ctx.raw('recipe_rate', { recipeId, rating: 'like' });
    if (rate.isError) {
      ctx.log(`rating a private recipe is rejected by the server (expected): ${rate.text.slice(0, 120)}`);
    } else {
      rated = true;
      ctx.assert(rate.data.rating === 'like', 'rating stored');
      const mineNow = await ctx.call('recipe_review_get', { recipeId });
      ctx.assert(mineNow.review?.rating === 'like', 'own review readable');
      const byId = await ctx.call('recipe_review_get', { reviewId: rate.data.id });
      ctx.assert(byId.review?.id === rate.data.id, 'review readable by id');
      const post = await ctx.raw('recipe_review_post', { recipeId, text: `${ctx.prefix} review`, tags: ['easy'], rating: 'like' });
      ctx.assert(!post.isError, `review post: ${post.text.slice(0, 120)}`);
      ctx.assert(post.data.comment?.includes('review') && post.data.tags.includes('easy'), 'review text and tags stored');
      await ctx.call('recipe_review_delete', { recipeId });
      rated = false;
      const gone = await ctx.call('recipe_review_get', { recipeId });
      ctx.assert(gone.review === null, 'review deleted again');
    }

    // --- recent searches: register a test term, find it, delete it again
    const term = ctx.prefix;
    await ctx.call('recipe_search', { query: term, limit: 1 });
    const withTerm = await waitRecent(ctx, (l) => l.includes(term));
    ctx.assert(withTerm.includes(term), 'search term registered in the recent queries');
    await ctx.call('recipe_recent_query_delete', { query: term });
    const without = await waitRecent(ctx, (l) => !l.includes(term));
    ctx.assert(!without.includes(term), 'test term removed from the recent queries');
  } finally {
    if (recipeId) {
      if (rated) await ctx.raw('recipe_review_delete', { recipeId }).catch(() => {});
      await ctx.raw('recipe_review_delete', { recipeId }).catch(() => {});
      const del = await ctx.raw('recipe_delete', { recipeId });
      if (del.isError) ctx.log(`could not delete the test recipe ${recipeId}: ${del.text}`);
    }
    await ctx.raw('recipe_recent_query_delete', { query: ctx.prefix }).catch(() => {});
    await restoreRecent(ctx, originalRecent).catch((e) => ctx.log(`could not restore recent searches: ${e.message}`));
  }
}

/**
 * Deletes leftover test recipes (found by searching the own recipes for the test prefix) and test
 * entries of the recent searches; the real recent searches are restored afterwards.
 */
export async function cleanup(ctx) {
  let removed = 0;
  const snapshot = await recent(ctx);
  const real = snapshot.filter((q) => !q.startsWith(PREFIX));
  try {
    for (let round = 0; round < 6; round++) {
      const res = await ctx.call('recipe_search', { query: PREFIX, limit: 50 });
      const mine = (res.recipes ?? []).filter((r) => ctx.isTestName(r.name));
      if (!mine.length) break;
      for (const r of mine) {
        const del = await ctx.raw('recipe_delete', { recipeId: r.id });
        if (del.isError) ctx.log(`could not delete ${r.id}: ${del.text}`);
        else removed++;
      }
      await sleep(500);
    }
  } finally {
    for (const q of (await recent(ctx)).filter((x) => x.startsWith(PREFIX))) {
      await ctx.raw('recipe_recent_query_delete', { query: q });
    }
    await waitRecent(ctx, (l) => !l.some((q) => q.startsWith(PREFIX)));
    await restoreRecent(ctx, real).catch((e) => ctx.log(`could not restore recent searches: ${e.message}`));
  }
  return removed;
}
