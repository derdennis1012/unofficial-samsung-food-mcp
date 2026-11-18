/**
 * Offline tests for the "recipes" and "food" areas: tool schemas and examples, and every client
 * method against a mock transport (exact request sent, normalized output).
 * The client tests use the schema fixture in test/fixtures/schema.json.
 */

import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/api/index.js';
import { SamsungFood } from '../src/core/client.js';
import { readSchema } from '../src/core/schema-build.js';
import { tools as recipeTools } from '../src/tools/recipes.js';
import { tools as foodTools } from '../src/tools/food.js';
import { foodLogIdFor } from '../src/api/food.js';

const allTools = [...recipeTools, ...foodTools];
const byName = Object.fromEntries(allTools.map((t) => [t.name, t]));

const EXPECTED = {
  recipe_update: 'update',
  recipe_rate: 'update',
  recipe_review_post: 'update',
  recipe_review_get: 'read',
  recipe_review_delete: 'destructive',
  recipe_autocomplete: 'read',
  recipe_categories: 'read',
  recipe_smart_collection: 'read',
  recipe_recommended: 'read',
  recipe_health_recommend: 'read',
  recipe_health_alternatives: 'read',
  recipe_dish_lookup: 'read',
  recipe_more_from_user: 'read',
  recipe_recent_queries: 'read',
  recipe_recent_query_delete: 'destructive',
  food_search: 'read',
  food_get: 'read',
  food_autocomplete: 'read',
  food_product_search: 'read',
  food_product_get: 'read',
  food_product_popular: 'read',
  nutrition_analyze: 'read',
  foodlog_add_from_meal_plan: 'write',
  foodlog_delete: 'destructive',
};
const ANNOTATION = { read: 'readOnlyHint', destructive: 'destructiveHint' };

/* ------------------------------------------------------------ tool schemas */

test('both areas define exactly the expected tools', () => {
  assert.deepEqual(allTools.map((t) => t.name).sort(), Object.keys(EXPECTED).sort());
});

test('every tool has kind annotations, an English description and a valid example', () => {
  for (const t of allTools) {
    const kind = EXPECTED[t.name];
    if (kind === 'read') assert.equal(t.annotations.readOnlyHint, true, `${t.name} must be read-only`);
    else assert.equal(t.annotations.readOnlyHint, false, `${t.name} must not be read-only`);
    if (kind === 'destructive') assert.equal(t.annotations.destructiveHint, true, t.name);
    else assert.equal(t.annotations.destructiveHint, false, `${t.name} must not be destructive`);
    assert.ok(t.description.length > 40, `${t.name}: description too short`);
    assert.match(t.description, /^[\x20-\x7e]+$/, `${t.name}: description should be plain English ASCII`);
    assert.ok(t.example && typeof t.example === 'object', `${t.name}: example missing`);
    const parsed = t.schema.safeParse(t.example);
    assert.ok(parsed.success, `${t.name}: example does not parse: ${parsed.error?.message}`);
    // unknown keys must be rejected (strict schema)
    assert.equal(t.schema.safeParse({ ...t.example, bogus: 1 }).success, false, `${t.name}: schema must be strict`);
  }
  void ANNOTATION;
});

test('list-returning tools cap limit at 100', () => {
  for (const name of ['recipe_smart_collection', 'recipe_recommended', 'recipe_dish_lookup', 'food_search', 'food_product_search', 'food_product_popular']) {
    const t = byName[name];
    assert.ok(t.schema.safeParse({ ...t.example, limit: 100 }).success, `${name}: limit 100 allowed`);
    assert.equal(t.schema.safeParse({ ...t.example, limit: 101 }).success, false, `${name}: limit 101 rejected`);
    assert.equal(t.schema.safeParse({ ...t.example, limit: 0 }).success, false, `${name}: limit 0 rejected`);
    assert.match(t.description, /nextCursor/, `${name}: description explains how to get more`);
  }
});

test('rating is exactly like or dislike', () => {
  const rate = byName.recipe_rate.schema;
  assert.ok(rate.safeParse({ recipeId: '107abc', rating: 'dislike' }).success);
  for (const bad of [5, 0, 'good', 'LIKE', true, undefined]) {
    assert.equal(rate.safeParse({ recipeId: '107abc', rating: bad }).success, false, `rating ${bad}`);
  }
  assert.equal(byName.recipe_review_post.schema.safeParse({ recipeId: '107abc', rating: 'five' }).success, false);
  assert.match(byName.recipe_rate.description, /"like" or "dislike"/);
});

test('ids must be plain IDs, not empty or containing whitespace', () => {
  for (const [name, key] of [
    ['recipe_update', 'recipeId'],
    ['recipe_rate', 'recipeId'],
    ['recipe_review_delete', 'recipeId'],
    ['recipe_more_from_user', 'recipeId'],
    ['food_get', 'foodId'],
  ]) {
    const t = byName[name];
    for (const bad of ['', '   ', 'a b', 'x\ny', 5, undefined]) {
      assert.equal(t.schema.safeParse({ ...t.example, [key]: bad }).success, false, `${name}.${key} = ${JSON.stringify(bad)}`);
    }
  }
  assert.equal(byName.foodlog_delete.schema.safeParse({ foodLogIds: [] }).success, false);
  assert.equal(byName.foodlog_add_from_meal_plan.schema.safeParse({ mealIds: ['ok', ''] }).success, false);
});

test('text, url and enum validators', () => {
  const upd = byName.recipe_update.schema;
  assert.equal(upd.safeParse({ recipeId: 'r1', name: '' }).success, false, 'empty name');
  assert.equal(upd.safeParse({ recipeId: 'r1', servings: 0 }).success, false, 'servings 0');
  assert.equal(upd.safeParse({ recipeId: 'r1', ingredients: [] }).success, false, 'empty ingredient list');
  assert.equal(upd.safeParse({ recipeId: 'r1', sourceUrl: 'not a url' }).success, false, 'bad url');
  assert.equal(upd.safeParse({ recipeId: 'r1', images: ['nope'] }).success, false, 'bad image url');
  assert.equal(byName.recipe_review_post.schema.safeParse({ recipeId: 'r1', tags: ['Not Valid'] }).success, false, 'tag format');
  assert.equal(byName.recipe_health_recommend.schema.safeParse({ mealTimes: ['brunch'] }).success, false, 'meal time');
  assert.equal(byName.recipe_health_alternatives.schema.safeParse({ date: '2026-02-30', mealTime: 'dinner' }).success, false, 'impossible date');
  assert.equal(byName.recipe_smart_collection.schema.safeParse({ collectionId: 'favorites' }).success, false, 'unknown smart collection');
  assert.equal(byName.recipe_categories.schema.safeParse({ type: 'none' }).success, false, 'category type');
  assert.equal(byName.recipe_dish_lookup.schema.safeParse({ urlPath: '../etc' }).success, false, 'urlPath');
  assert.equal(byName.recipe_recent_query_delete.schema.safeParse({ query: '  ' }).success, false, 'blank query');
  assert.equal(byName.nutrition_analyze.schema.safeParse({ items: [] }).success, false, 'no items');
  assert.equal(byName.nutrition_analyze.schema.safeParse({ items: [''] }).success, false, 'blank item');
  assert.equal(byName.food_search.schema.safeParse({ query: 'x', language: 'english' }).success, false, 'language code');
  assert.equal(byName.food_product_get.schema.safeParse({ productId: '' }).success, false, 'blank product');
});

/* ----------------------------------------------------------- client methods */

const schema = readSchema();

/** Client whose transport answers from `handlers[method](request) -> response object`. */
function mockClient(handlers) {
  const calls = [];
  const sf = new SamsungFood({
    schema,
    token: 'fake',
    locale: 'en-US',
    transport: {
      call: async (method, payload, opts) => {
        const rpc = sf.codec.rpc(method);
        const request = sf.codec.decodeMessage(rpc.request, payload);
        calls.push({ method, request, opts });
        const h = handlers[method];
        if (!h) throw new Error(`unexpected call: ${method}`);
        return sf.codec.encodeMessage(rpc.response, typeof h === 'function' ? h(request) : h);
      },
    },
  });
  // never touch the real meal plan cache in the config dir
  sf._cache.mealPlan = { mealPlanId: 'plan-1' };
  return { sf, calls };
}

const R = 'whisk.x.recipe.v1.';
const date = (y, m, d) => ({ year: y, month: m, day: d });

test('updateRecipe loads the recipe, merges the changes and sends the whole payload', async () => {
  const current = {
    id: '107own',
    name: 'Old name',
    description: 'Old description',
    ingredients: [{ text: '2 eggs', id: '0' }, { text: '100 g flour', group: 'Dough', id: '1' }],
    instructions: { steps: [{ text: 'Mix', group: 'Dough' }, { text: 'Bake' }] },
    images: [{ original: { url: 'https://example.com/o.jpg' }, responsive: { url: 'https://cdn.example.com/r.jpg' } }],
    source: { name: 'example.com', displayName: 'Example', sourceRecipeUrl: 'https://example.com/r' },
    servings: 2,
    durations: { cookTime: 20, prepTime: 5 },
    language: 'en',
    user: { owner: true, value: true },
  };
  const { sf, calls } = mockClient({
    [`${R}RecipeAPI/GetRecipe`]: { recipe: current },
    [`${R}RecipeAPI/UpdateRecipe`]: (req) => ({ recipe: { id: req.recipeId, name: req.payload.name, servings: req.payload.servings } }),
  });
  const out = await sf.updateRecipe('107own', { name: 'New name', servings: 6 });

  assert.deepEqual(calls.map((c) => c.method), [`${R}RecipeAPI/GetRecipe`, `${R}RecipeAPI/UpdateRecipe`]);
  assert.equal(calls[0].request.recipeId, '107own');
  assert.ok(calls[0].request.recipeMask.paths.includes('permissions'));
  const sent = calls[1].request;
  assert.equal(sent.recipeId, '107own');
  assert.deepEqual(sent.updateMask, { paths: ['payload'] });
  assert.equal(sent.payload.name, 'New name');
  assert.equal(sent.payload.servings, 6);
  assert.equal(sent.payload.description, 'Old description');
  assert.deepEqual(sent.payload.ingredients, [{ text: '2 eggs', id: '0' }, { text: '100 g flour', group: 'Dough', id: '1' }], 'ingredient ids are kept');
  assert.deepEqual(sent.payload.instructions, [{ text: 'Mix', group: 'Dough' }, { text: 'Bake' }]);
  assert.deepEqual(sent.payload.images, [{ url: 'https://example.com/o.jpg' }]);
  assert.deepEqual(sent.payload.source, { displayName: 'Example', sourceRecipeUrl: 'https://example.com/r' });
  assert.deepEqual(sent.payload.durations, { cookTime: 20, prepTime: 5 });
  assert.equal(sent.payload.language, 'en');
  assert.deepEqual(out, { updated: ['name', 'servings'], recipe: { id: '107own', name: 'New name', servings: 6 } });
});

test('updateRecipe replaces ingredients, refuses foreign recipes and empty updates', async () => {
  const { sf, calls } = mockClient({
    [`${R}RecipeAPI/GetRecipe`]: (req) => ({ recipe: { id: req.recipeId, name: 'x', servings: 1, user: { owner: req.recipeId === '107own' } } }),
    [`${R}RecipeAPI/UpdateRecipe`]: (req) => ({ recipe: { id: 'newid', name: req.payload.name } }),
  });
  const out = await sf.updateRecipe('107own', { ingredients: ['3 eggs'], instructions: ['Stir'] });
  assert.deepEqual(calls[1].request.payload.ingredients, [{ text: '3 eggs' }]);
  assert.deepEqual(calls[1].request.payload.instructions, [{ text: 'Stir' }]);
  assert.equal(out.previousId, '107own', 'a changed id is reported');
  assert.equal(out.recipe.id, 'newid');

  const before = calls.length;
  await assert.rejects(() => sf.updateRecipe('107foreign', { name: 'Hijack' }), /not your own recipe/);
  assert.equal(calls.length, before + 1, 'only the read happened, no update was sent');
  await assert.rejects(() => sf.updateRecipe('107own', {}), /nothing to update/);
  assert.equal(calls.length, before + 1);
});

test('updateRecipe sends back step images, intents, ingredient links, videos and aiFeatures unchanged', async () => {
  // Schema slice shaped like the live one (the fixture lacks these fields): read and write steps differ.
  const F = (n, name, type, extra = {}) => ({ n, name, type, ...extra });
  const dict = [F(1, 'name', 'string'), F(2, 'displayName', 'string')];
  const big = {
    rpcs: {
      [`${R}RecipeAPI/GetRecipe`]: {
        request: [F(1, 'recipeId', 'string'), F(2, 'recipeMask', 'message', { ref: 'mask' })],
        response: [F(1, 'recipe', 'message', { ref: 'recipe' })],
      },
      [`${R}RecipeAPI/UpdateRecipe`]: {
        request: [F(1, 'recipeId', 'string'), F(2, 'recipeMask', 'message', { ref: 'mask' }), F(3, 'updateMask', 'message', { ref: 'mask' }), F(4, 'payload', 'message', { ref: 'payload' })],
        response: [F(1, 'recipe', 'message', { ref: 'recipe' })],
      },
    },
    messages: {
      mask: [F(1, 'paths', 'string', { repeated: true })],
      dict,
      ing: [F(1, 'text', 'string'), F(2, 'group', 'string'), F(3, 'id', 'string')],
      img: [F(1, 'url', 'string'), F(2, 'width', 'int32'), F(3, 'height', 'int32')],
      ai: [F(1, 'personalized', 'bool'), F(2, 'generatedFromScan', 'bool')],
      video: [F(1, 'youtubeVideo', 'message', { ref: 'yt' })],
      yt: [F(1, 'id', 'string')],
      recipe: [
        F(1, 'id', 'string'), F(2, 'name', 'string'), F(4, 'ingredients', 'message', { ref: 'ing', repeated: true }),
        F(5, 'instructions', 'message', { ref: 'rInstr' }), F(14, 'language', 'string'), F(15, 'user', 'message', { ref: 'user' }),
        F(16, 'nutrition', 'message', { ref: 'img' }), F(29, 'videos', 'message', { ref: 'video', repeated: true }), F(31, 'aiFeatures', 'message', { ref: 'ai' }),
      ],
      user: [F(1, 'owner', 'bool')],
      rInstr: [F(1, 'steps', 'message', { ref: 'rStep', repeated: true })],
      rStep: [F(1, 'text', 'string'), F(2, 'group', 'string'), F(4, 'image', 'message', { ref: 'img' }), F(3, 'analysis', 'message', { ref: 'rAnalysis' })],
      rAnalysis: [F(1, 'intents', 'message', { ref: 'rIntent', repeated: true }), F(2, 'ingredientIds', 'string', { repeated: true })],
      rIntent: [F(1, 'device', 'message', { ref: 'rDevice' }), F(2, 'mode', 'message', { ref: 'dict' }), F(3, 'attributes', 'message', { ref: 'rAttr', repeated: true })],
      rDevice: [F(1, 'name', 'message', { ref: 'dict' })],
      rAttr: [F(1, 'type', 'enum'), F(5, 'name', 'message', { ref: 'dict' }), F(2, 'intValue', 'message', { ref: 'rInt' })],
      rInt: [F(1, 'value', 'int32'), F(2, 'unit', 'message', { ref: 'dict' })],
      payload: [
        F(1, 'name', 'string'), F(3, 'ingredients', 'message', { ref: 'ing', repeated: true }), F(4, 'instructions', 'message', { ref: 'wStep', repeated: true }),
        F(9, 'language', 'string'), F(10, 'videos', 'message', { ref: 'video', repeated: true }), F(11, 'aiFeatures', 'message', { ref: 'ai' }),
      ],
      wStep: [F(1, 'text', 'string'), F(2, 'group', 'string'), F(4, 'image', 'message', { ref: 'img' }), F(3, 'intents', 'message', { ref: 'wIntent', repeated: true }), F(5, 'rawIngredientIds', 'string', { repeated: true })],
      wIntent: [F(1, 'device', 'string'), F(2, 'mode', 'string'), F(3, 'attributes', 'message', { ref: 'wAttr', repeated: true })],
      wAttr: [F(1, 'name', 'string'), F(2, 'type', 'enum'), F(3, 'intValue', 'message', { ref: 'wInt' })],
      wInt: [F(1, 'value', 'int32'), F(2, 'unitName', 'string')],
    },
  };
  const calls = [];
  const sf = new SamsungFood({
    schema: big,
    token: 'fake',
    transport: {
      call: async (method, payload) => {
        const rpc = sf.codec.rpc(method);
        calls.push({ method, request: sf.codec.decodeMessage(rpc.request, payload) });
        const recipe = {
          id: '107own',
          name: 'Soup',
          language: 'en',
          user: { owner: true },
          nutrition: { url: 'read-only' },
          ingredients: [{ id: 'i0', text: '1 onion' }],
          instructions: {
            steps: [
              {
                text: 'Chop',
                image: { url: 'https://img/step.jpg', width: 10, height: 20 },
                analysis: {
                  ingredientIds: ['i0'],
                  intents: [{ device: { name: { name: 'oven' } }, mode: { name: 'bake', displayName: 'Bake' }, attributes: [{ type: 1, name: { name: 'temperature' }, intValue: { value: 180, unit: { name: 'celsius' } } }] }],
                },
              },
            ],
          },
          videos: [{ youtubeVideo: { id: 'yt1' } }],
          aiFeatures: { personalized: true, generatedFromScan: false },
        };
        return sf.codec.encodeMessage(rpc.response, { recipe });
      },
    },
  });
  const out = await sf.updateRecipe('107own', { name: 'Better soup' });
  const sent = calls[1].request.payload;
  assert.equal(sent.name, 'Better soup');
  assert.deepEqual(sent.ingredients, [{ id: 'i0', text: '1 onion' }]);
  assert.deepEqual(sent.instructions, [
    {
      text: 'Chop',
      image: { url: 'https://img/step.jpg', width: 10, height: 20 },
      rawIngredientIds: ['i0'],
      intents: [{ device: 'oven', mode: 'bake', attributes: [{ name: 'temperature', type: 1, intValue: { value: 180, unitName: 'celsius' } }] }],
    },
  ]);
  assert.deepEqual(sent.videos, [{ youtubeVideo: { id: 'yt1' } }]);
  assert.deepEqual(sent.aiFeatures, { personalized: true, generatedFromScan: false });
  assert.equal(sent.nutrition, undefined, 'read-only fields are not sent');
  assert.equal(out.warnings, undefined);
});

test('rateRecipe, postReview, getReview, deleteReview', async () => {
  const review = (liked) => ({ review: { id: 'rev1', recipeId: '107r', rating: liked ? { liked: true } : {}, user: { isMe: true } } });
  const { sf, calls } = mockClient({
    [`${R}RecipeReviewAPI/PostReviewRating`]: (req) => review(req.rating.liked),
    [`${R}RecipeReviewAPI/PostReview`]: () => ({
      review: { id: 'rev2', recipeId: '107r', rating: { liked: true }, detailed: { comment: { text: 'Great' }, tags: [{ name: 'easy', displayName: 'Easy' }] } },
    }),
    [`${R}RecipeReviewAPI/GetReview`]: () => ({ review: { id: 'rev2', recipeId: '107r', rating: {}, user: { isMe: true } }, recipe: { id: '107r', name: 'Soup' } }),
    [`${R}RecipeAPI/GetRecipe`]: (req) =>
      req.recipeId === '107none'
        ? { recipe: { id: '107none', name: 'No review' } }
        : { recipe: { id: '107r', name: 'Soup', reviews: { myReview: { id: 'rev9', rating: { liked: true }, detailed: { comment: { text: 'Mine' } } } } } },
    [`${R}RecipeReviewAPI/DeleteReview`]: {},
  });

  const liked = await sf.rateRecipe('107r', true);
  assert.deepEqual(calls.at(-1).request, { recipeId: '107r', rating: { liked: true } });
  assert.deepEqual(liked, { id: 'rev1', recipeId: '107r', rating: 'like', comment: null, tags: [], isMine: true });
  const disliked = await sf.rateRecipe('107r', false);
  assert.equal(disliked.rating, 'dislike', 'an empty rating message is a dislike');

  const posted = await sf.postReview('107r', { text: 'Great', tags: ['easy'], liked: true });
  assert.deepEqual(calls.at(-1).request, { recipeId: '107r', payload: { text: 'Great', tags: ['easy'], rating: { liked: true } } });
  assert.equal(posted.comment, 'Great');
  assert.deepEqual(posted.tags, ['easy']);
  await assert.rejects(() => sf.postReview('107r', {}), /needs text, tags or a rating/);

  const byId = await sf.getReview({ reviewId: 'rev2' });
  assert.deepEqual(calls.at(-1).request, { recipeReviewId: 'rev2' });
  assert.equal(byId.review.rating, 'dislike');
  assert.deepEqual(byId.recipe, { id: '107r', name: 'Soup' });

  const mine = await sf.getReview({ recipeId: '107r' });
  assert.deepEqual(calls.at(-1).request, { recipeId: '107r', recipeMask: { paths: ['reviews.my_review'] } });
  assert.equal(mine.review.id, 'rev9');
  assert.equal(mine.review.recipeId, '107r');
  assert.equal(mine.review.comment, 'Mine');
  assert.equal((await sf.getReview({ recipeId: '107none' })).review, null);
  await assert.rejects(() => sf.getReview({}), /reviewId or recipeId/);

  assert.deepEqual(await sf.deleteReview('107r'), { deleted: true, recipeId: '107r' });
  assert.deepEqual(calls.at(-1), { method: `${R}RecipeReviewAPI/DeleteReview`, request: { recipeId: '107r' }, opts: calls.at(-1).opts });
});

test('autocomplete, categories and recent queries', async () => {
  const { sf, calls } = mockClient({
    [`${R}RecipeSearchAPI/GetAutocompleteSuggestions`]: {
      suggestions: [{ entity: { recent: 'soup' }, highlight: { length: 2 } }, { entity: { text: 'soy' } }],
    },
    [`${R}RecipeSearchAPI/GetCategories`]: { categories: [{ id: 'pasta', title: 'Pasta', titleColor: '#fff', imageUrl: 'https://x/p.png' }] },
    [`${R}RecipeAPI/GetRecentRecipeQueries`]: { queries: [{ text: 'soup' }, { text: 'keto' }] },
    [`${R}RecipeAPI/DeleteRecentRecipeQuery`]: {},
  });
  const sugg = await sf.recipeAutocomplete('so', { limit: 5, includeRecent: true });
  assert.deepEqual(calls.at(-1).request, { query: 'so', limit: 5, supportedEntities: [{ recent: {} }] });
  assert.deepEqual(sugg, [{ text: 'soup', recent: true }, { text: 'soy', recent: false }]);
  await sf.recipeAutocomplete('so');
  assert.equal(calls.at(-1).request.supportedEntities, undefined);

  assert.deepEqual(await sf.recipeCategories('all'), [{ id: 'pasta', title: 'Pasta', imageUrl: 'https://x/p.png' }]);
  assert.equal(calls.at(-1).request.categoryType, 2);
  await sf.recipeCategories();
  assert.equal(calls.at(-1).request.categoryType, 1);
  await assert.rejects(() => sf.recipeCategories('nope'), /unknown category type/);

  assert.deepEqual(await sf.recentQueries(), ['soup', 'keto']);
  assert.deepEqual(await sf.deleteRecentQuery('keto'), { deleted: 'keto' });
  assert.deepEqual(calls.at(-1).request, { query: 'keto' });
  assert.equal(calls.at(-1).opts.read, false, 'deleting a recent query is a write');
});

test('smart collections: list, and one with recipes', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.recipe.v1.CollectionAPI/GetCollections': {
      smartCollections: [
        { collection: { id: 'made_it', name: 'Made it', type: 1, recipeCount: 3 } },
        { collection: { id: 'my_recipes', name: 'Mine', type: 4, recipeCount: 9 } },
      ],
    },
    [`${R}SmartCollectionAPI/GetSmartCollection`]: {
      collection: { id: 'planned', name: 'Planned', type: 3, recipeCount: 2 },
      smartTags: [{ value: { name: 'dinner', displayName: 'Dinner' } }],
    },
    [`${R}SmartCollectionAPI/GetSmartCollectionRecipes`]: {
      recipes: [{ recipe: { id: '107a', name: 'A', servings: 2, durations: { cookTime: 10 }, images: [{ original: { url: 'https://o/a.jpg' } }] } }],
      paging: { cursors: { after: 'CUR' } },
    },
  });
  assert.deepEqual(await sf.smartCollections(), [
    { id: 'made_it', name: 'Made it', kind: 'made_it', recipeCount: 3 },
    { id: 'my_recipes', name: 'Mine', kind: 'my_recipes', recipeCount: 9 },
  ]);
  assert.deepEqual(calls.at(-1).request, { paging: { limit: 1 }, withSmartCollections: true });

  const one = await sf.smartCollection('planned', { limit: 7, cursor: 'PREV', order: 'oldest', tags: ['dinner'] });
  const sent = calls.find((c) => c.method.endsWith('GetSmartCollectionRecipes')).request;
  assert.equal(sent.collectionId, 'planned');
  assert.deepEqual(sent.paging, { limit: 7, cursors: { after: 'PREV' } });
  assert.deepEqual(sent.smartTags, ['dinner']);
  assert.deepEqual(sent.sorting, { direction: 1 });
  assert.ok(sent.recipeMask.paths.includes('save_count'));
  assert.deepEqual(one, {
    id: 'planned',
    name: 'Planned',
    kind: 'planned',
    recipeCount: 2,
    tags: [{ name: 'dinner', label: 'Dinner' }],
    recipes: [{ id: '107a', name: 'A', imageUrl: 'https://o/a.jpg', servings: 2, cookTime: 10 }],
    nextCursor: 'CUR',
  });
  await sf.smartCollection('planned');
  assert.equal(calls.at(-1).request.sorting.direction, 2, 'newest first by default');
  await assert.rejects(() => sf.smartCollection('planned', { order: 'random' }), /unknown order/);
});

test('recommendedRecipes keeps only recipe items of the home feed', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.homefeed.v1.HomefeedAPI/GetRecommendedRecipes': {
      recipes: [
        {
          singleRecipeAdded: { recipe: { recipeDetails: { id: '107f', name: 'Feed recipe', servings: 4 } } },
          postedBy: { id: 'u1', firstName: 'Ada', lastName: 'Lovelace' },
          community: { id: 'c1', name: 'Everyday' },
        },
        { conversation: { id: 'conv', title: 'Not a recipe' } },
      ],
      paging: { cursors: { after: 'NEXT' } },
    },
  });
  const out = await sf.recommendedRecipes({ limit: 5, cursor: 'C0', seed: 42 });
  assert.deepEqual(calls[0].request, { paging: { limit: 5, cursors: { after: 'C0' } }, shufflingSeed: 42 });
  assert.deepEqual(out, {
    recipes: [{ id: '107f', name: 'Feed recipe', servings: 4, postedBy: 'Ada Lovelace', community: 'Everyday' }],
    nextCursor: 'NEXT',
  });
});

test('health recommendations and alternatives', async () => {
  const meal = {
    recommendedFood: [{ recipe: { recipe: { id: '107h', name: 'Healthy', servings: 2 } } }],
    explanationReasons: [{ caloriesMacros: { contributionWeight: 0.5 } }, { dqsAhei: { contributionWeight: 0.5, component: 3 } }],
  };
  const { sf, calls } = mockClient({
    'whisk.x.health.v1.HealthAPI/Recommend': {
      recommendationStatus: 1,
      recommendation: [{ date: date(2026, 11, 2), mealTime: 3, recommendedMeals: [meal] }],
    },
    'whisk.x.health.v1.HealthAPI/GetAlternativeRecommendations': {
      alternativeRecommendedMeals: { date: date(2026, 11, 2), mealTime: 3, recommendedMeals: [meal, { ...meal, isPlanned: true, mealId: 'm1' }] },
    },
  });
  const rec = await sf.healthRecommend({ from: '2026-11-02', mealTimes: ['dinner'], limit: 2 });
  assert.deepEqual(calls[0].request, {
    period: { startDate: date(2026, 11, 2), endDate: date(2026, 11, 2) },
    mealTimes: [3],
    limit: 2,
    responseMask: { paths: ['recipe.name', 'recipe.images', 'recipe.servings', 'recipe.durations'] },
  });
  assert.deepEqual(rec, {
    status: 1,
    slots: [
      {
        date: '2026-11-02',
        mealTime: 'Dinner',
        meals: [
          {
            mealId: null,
            planned: false,
            items: [{ type: 'recipe', id: '107h', name: 'Healthy', servings: 2 }],
            reasons: [{ kind: 'caloriesMacros', weight: 0.5 }, { kind: 'dqsAhei', weight: 0.5 }],
          },
        ],
      },
    ],
  });

  const alt = await sf.healthAlternatives({ date: '2026-11-02', mealTime: 'dinner', limit: 4 });
  assert.deepEqual(calls[1].request, {
    startDate: date(2026, 11, 2),
    mealTime: 3,
    limit: 4,
    responseMask: { paths: ['recipe.name', 'recipe.images', 'recipe.servings', 'recipe.durations'] },
  });
  assert.equal(alt.mealTime, 'Dinner');
  assert.equal(alt.meals.length, 2);
  assert.equal(alt.meals[1].planned, true);
  assert.equal(alt.meals[1].mealId, 'm1');
});

test('dishLookup: top level list and one dish', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.dish.v1.DishAPI/GetTopLevelDishes': {
      dish: [{ parent: { id: 'd1', name: { name: 'BREAD', displayName: 'Bread' }, urlPath: 'bread' }, children: [{ id: 'd2', name: { displayName: 'Baguette' }, urlPath: 'bread/baguette' }] }],
      paging: { cursors: { after: 'DC' } },
    },
    'whisk.x.dish.v1.DishAPI/GetDishByUrl': {
      dish: {
        id: 'd2',
        name: { name: 'BAGUETTE', displayName: 'Baguette' },
        servingSize: 60,
        nutrition: { components: [{ code: { name: 'ENERC_KCAL', displayName: 'Energy' }, value: 270.3333, unit: { name: 'Kcal', displayName: 'kcal' } }] },
      },
    },
  });
  const list = await sf.dishLookup({ limit: 3 });
  assert.deepEqual(calls[0].request, { cursor: { limit: 3 }, withoutChildren: true });
  assert.deepEqual(list, {
    dishes: [{ name: 'Bread', urlPath: 'bread', children: [{ name: 'Baguette', urlPath: 'bread/baguette' }] }],
    nextCursor: 'DC',
  });
  const dish = await sf.dishLookup({ urlPath: 'bread/baguette' });
  assert.deepEqual(calls[1].request, { urlPath: 'bread/baguette' });
  assert.equal(dish.name, 'Baguette');
  assert.equal(dish.servingSizeGrams, 60);
  assert.deepEqual(dish.nutritionPer100g, [{ code: 'ENERC_KCAL', label: 'Energy', value: 270.333, unit: 'kcal' }]);
});

test('moreFromUser', async () => {
  const { sf, calls } = mockClient({
    [`${R}RecipeAPI/GetMoreUserRecipes`]: (req) => (req.recipeId === '107has' ? { result: { recipes: [{ id: '107b', name: 'B' }] } } : { result: {} }),
  });
  assert.deepEqual(await sf.moreFromUser('107has', 3), [{ id: '107b', name: 'B' }]);
  assert.equal(calls[0].request.limit, 3);
  assert.ok(calls[0].request.recipeMask.paths.length > 0);
  assert.deepEqual(await sf.moreFromUser('107none'), []);
});

/* ---------------------------------------------------------------- food area */

const F = 'whisk.x.food.v1.FoodAPI/';
const P = 'whisk.x.foodpedia.v1.FoodpediaAPI/';

test('food search, get and autocomplete', async () => {
  const { sf, calls } = mockClient({
    [`${F}Search`]: { hits: [{ foodId: 'f1', title: 'banana', imageUrl: 'https://i/b.jpg' }, { foodId: 'f2', attributeId: 'a2', title: 'red banana' }], paging: { cursors: { after: 'FC' } } },
    [`${F}Get`]: {
      food: {
        id: 'f1',
        title: 'Banana',
        imageUrl: 'https://i/b.jpg',
        measuresQty: {
          measureQty: [
            { simple: { amount: 117.98, unit: { name: 'G', displayName: 'g' }, nutritionCoefficient: 1.1798 }, detailed: { quantity: 1, measure: { name: 'medium', amount: 117.98 } } },
          ],
          measuresQtyWithNutrition: [
            { nutrition: { nutrition: [{ amount: 88.67, unit: { name: 'Kcal', displayName: 'kcal' }, code: { name: 'ENERC_KCAL', displayName: 'Energy' } }, { unit: { displayName: 'g' }, code: { name: 'FAT', displayName: 'Fat' } }] } },
          ],
        },
      },
    },
    [`${F}Autocomplete`]: { suggestions: [{ name: 'banana' }, { name: 'bao' }] },
  });

  const found = await sf.foodSearch('banana', { limit: 2, cursor: 'PREV' });
  assert.deepEqual(calls[0].request, { query: 'banana', language: 'en', paging: { limit: 2, cursors: { after: 'PREV' } } });
  assert.deepEqual(found, {
    foods: [
      { id: 'f1', title: 'banana', imageUrl: 'https://i/b.jpg' },
      { id: 'f2', title: 'red banana', imageUrl: null, attributeId: 'a2' },
    ],
    nextCursor: 'FC',
  });

  const food = await sf.foodGet('f1');
  assert.deepEqual(calls[1].request, { foodId: 'f1', language: 'en', responseMask: { paths: ['measures_qty_with_nutrition'] } });
  assert.deepEqual(food.measures, [{ name: 'medium', quantity: 1, grams: 117.98 }]);
  assert.deepEqual(food.nutritionPer100g, [
    { code: 'ENERC_KCAL', label: 'Energy', value: 88.67, unit: 'kcal' },
    { code: 'FAT', label: 'Fat', value: 0, unit: 'g' },
  ]);
  const bare = await sf.foodGet('f1', { nutrition: false, attributeId: 'a1', language: 'de' });
  assert.equal(bare.nutritionPer100g, undefined);
  assert.equal(calls[2].request.attributeId, 'a1');
  assert.equal(calls[2].request.language, 'de');

  assert.deepEqual(await sf.foodAutocomplete('ba', { limit: 2 }), ['banana', 'bao']);
  assert.deepEqual(calls[3].request, { query: 'ba', limit: 2, language: 'en' });
});

test('product search, get and popular', async () => {
  const { sf, calls } = mockClient({
    [`${P}SearchProducts`]: {
      food: [{ canonicalName: 'BANANA', imageUrl: 'https://i/b.jpg', localisedTitle: { name: 'BANANA', displayName: 'banane' } }],
      paging: { cursors: { after: 'PC' } },
      total: { exact: 194 },
    },
    [`${P}GetProduct`]: {
      product: {
        productId: 'BANANA',
        title: 'Banane',
        category: 'FRUITS AND VEGETABLES',
        description: 'Yellow',
        storageLocationName: { name: 'Pantry', displayName: 'Pantry' },
        glycemicIndex: { value: 50 },
        defaultMeasure: { unit: { name: 'G', displayName: 'g' }, amount: 88.24 },
        nutrition: { components: [{ code: { name: 'ENERC_KCAL', displayName: 'Energy' }, value: 88.67, unit: { displayName: 'kcal' } }] },
        measuresPerOneGram: { measurePerOneGram: [{ unit: { name: 'piece', displayName: 'piece' }, amount: 0.04 }] },
        dietsAll: [{ name: { name: 'VEGAN', displayName: 'Vegan' }, isSupported: true }, { name: { name: 'KETO', displayName: 'Keto' } }],
        tips: [{ tip: 'Keep cool' }],
        substitutes: [{ type: 4, items: [{ productId: 'GREEN BANANA', displayName: 'Green banana' }] }],
        linkedRecipes: [{ id: '107x', name: 'Banana bread' }],
      },
    },
    [`${P}GetPopularProducts`]: { products: [{ canonicalName: 'TURMERIC', image: { url: 'https://i/t.jpg' }, localisedTitle: { displayName: 'Gelbwurz' } }] },
  });
  const search = await sf.productSearch('banana', { limit: 1 });
  assert.deepEqual(calls[0].request, { query: 'banana', cursor: { limit: 1 } });
  assert.deepEqual(search, {
    total: 194,
    totalIsLowerBound: false,
    products: [{ id: 'BANANA', name: 'banane', imageUrl: 'https://i/b.jpg' }],
    nextCursor: 'PC',
  });

  const p = await sf.productGet('BANANA');
  assert.deepEqual(calls[1].request, { productId: 'BANANA' });
  assert.deepEqual(p, {
    id: 'BANANA',
    name: 'Banane',
    category: 'FRUITS AND VEGETABLES',
    description: 'Yellow',
    storage: 'Pantry',
    glycemicIndex: 50,
    imageUrl: null,
    defaultMeasure: { unit: 'g', amount: 88.24 },
    nutritionPer100g: [{ code: 'ENERC_KCAL', label: 'Energy', value: 88.67, unit: 'kcal' }],
    gramsPerUnit: [{ unit: 'piece', grams: 25 }],
    diets: ['Vegan'],
    tips: ['Keep cool'],
    substitutes: [{ id: 'GREEN BANANA', name: 'Green banana' }],
    linkedRecipes: [{ id: '107x', name: 'Banana bread' }],
  });

  const pop = await sf.popularProducts({ limit: 1, cursor: 'X' });
  assert.deepEqual(calls[2].request, { cursor: { limit: 1, cursors: { after: 'X' } } });
  assert.deepEqual(pop, { products: [{ id: 'TURMERIC', name: 'Gelbwurz', imageUrl: 'https://i/t.jpg' }], nextCursor: null });
});

test('analyzeIngredients normalizes parsed lines', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.analysis.v1.AnalysisAPI/AnalyzeItems': {
      items: [
        { sourceText: '400 g pumpkin', analysis: { product: { canonicalName: 'PUMPKIN', originalName: 'pumpkin' }, category: { canonicalName: 'FRUITS AND VEGETABLES' }, amount: { quantity: 400, unit: 'g' } } },
        { sourceText: 'salt', analysis: { product: { canonicalName: 'SALT', originalName: 'salt' }, comment: 'to taste' } },
      ],
    },
  });
  const out = await sf.analyzeIngredients(['400 g pumpkin', 'salt']);
  assert.deepEqual(calls[0].request, { items: ['400 g pumpkin', 'salt'], language: 'en' });
  assert.deepEqual(out, [
    { text: '400 g pumpkin', food: 'PUMPKIN', localName: 'pumpkin', category: 'FRUITS AND VEGETABLES', quantity: 400, unit: 'g' },
    { text: 'salt', food: 'SALT', localName: 'salt', comment: 'to taste' },
  ]);
  assert.equal(calls[0].opts.read, true, 'AnalyzeItems is a read');
});

test('food log: add from meal plan and delete', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.foodlog.v1.FoodLogAPI/AddFoodLogItemsFromMealPlan': {},
    'whisk.x.foodlog.v1.FoodLogAPI/DeleteFoodLogItems': {},
  });
  const meal = '01a0aaaabbbbccccddddeeeeeeeeeeee';
  const uuid = '01a0aaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  assert.deepEqual(await sf.addFoodLogFromMealPlan([meal]), { logged: 1, foodLogIds: [uuid] });
  assert.deepEqual(calls[0].request, { mealPlanId: 'plan-1', mealIds: [meal] });
  assert.equal(calls[0].opts.read, false);

  assert.deepEqual(await sf.deleteFoodLogItems([meal, uuid]), { deleted: [uuid, uuid] });
  assert.deepEqual(calls[1].request, { foodLogIds: [uuid, uuid] });
  assert.equal(foodLogIdFor('not-a-meal-id'), 'not-a-meal-id');
});

test('tool handlers wire the arguments through to the client', async () => {
  const { sf, calls } = mockClient({
    [`${R}RecipeReviewAPI/PostReviewRating`]: { review: { id: 'r', rating: { liked: true } } },
    [`${R}RecipeReviewAPI/PostReview`]: { review: { id: 'r', rating: {} } },
    [`${R}RecipeAPI/GetRecentRecipeQueries`]: { queries: [{ text: 'a' }] },
    'whisk.x.health.v1.HealthAPI/Recommend': { recommendationStatus: 1 },
  });
  const run = (name, args) => byName[name].handler(byName[name].schema.parse(args), sf);
  await run('recipe_rate', { recipeId: '107r', rating: 'like' });
  assert.deepEqual(calls.at(-1).request, { recipeId: '107r', rating: { liked: true } });
  await run('recipe_review_post', { recipeId: '107r', rating: 'dislike' });
  assert.deepEqual(calls.at(-1).request, { recipeId: '107r', payload: { rating: { liked: false } } });
  assert.deepEqual(await run('recipe_recent_queries', {}), { queries: ['a'] });
  await run('recipe_health_recommend', { from: '2026-11-02' });
  assert.deepEqual(calls.at(-1).request.mealTimes, [1, 2, 3], 'defaults to breakfast, lunch, dinner');
});
