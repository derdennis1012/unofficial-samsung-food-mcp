/**
 * Live tests for the core tools: read-only sweep samples plus a pantry roundtrip
 * on a throwaway "mcp-test-*" entry.
 */

const arr = (x) => (Array.isArray(x) ? x : (x?.result ?? []));

/** All pantry entries (including consumed) matching a search, across pages. */
async function pantry(ctx, { search }) {
  const out = [];
  for (let offset = 0; ; ) {
    const page = await ctx.call('pantry_get', { includeConsumed: true, search, limit: 200, offset });
    out.push(...page.items);
    if (page.nextOffset == null) return out;
    offset = page.nextOffset;
  }
}

export const readSkip = {};

export async function readSamples(ctx) {
  const lists = arr(await ctx.call('shopping_lists'));
  const recipes = (await ctx.call('recipe_discover', { limit: 3 })).result ?? [];
  const recipeId = recipes[0]?.id;
  ctx.assert(recipeId, 'recipe_discover returned no recipe');
  const collections = arr(await ctx.call('collections_list', { limit: 5 }));
  return {
    meal_plan_get: { days: 3 },
    meal_plan_templates: {},
    meal_plan_previously_planned: { limit: 5 },
    shopping_list_get: lists[0] ? { listId: lists[0].id } : {},
    shopping_lists: {},
    recipe_search: { query: 'soup', limit: 3 },
    recipe_discover: { limit: 3 },
    recipe_get: { recipeId },
    recipe_similar: { recipeId, limit: 3 },
    collections_list: { limit: 5 },
    collection_recipes: collections[0] ? { collectionId: collections[0].id, limit: 3 } : { collectionId: 'none' },
    pantry_get: { limit: 5 },
    food_storage_info: { name: 'chicken breast' },
    api_methods: { filter: 'ListAPI' },
    api_describe: { method: 'whisk.x.list.v1.ListAPI/GetLists' },
    account_info: {},
    auth_status: {},
  };
}

export async function run(ctx) {
  const name = `${ctx.prefix}-pantry`;
  let ids = [];
  try {
    const added = await ctx.call('pantry_add', { names: [name], location: 'fridge' });
    const item = arr(added)[0];
    ctx.assert(item?.id, `pantry_add returned an item (${JSON.stringify(added).slice(0, 200)})`);
    ids = [item.id];

    await ctx.call('pantry_update', { id: item.id, expiryDate: ctx.futureDate(), location: 'freezer' });
    let mine = (await pantry(ctx, { search: name })).find((i) => i.id === item.id);
    ctx.assert(mine?.expiryDate === ctx.futureDate(), `expiry updated (${mine?.expiryDate})`);

    await ctx.call('pantry_consume', { itemIds: ids, action: 'consume' });
    mine = (await pantry(ctx, { search: name })).find((i) => i.id === item.id);
    ctx.assert(mine?.consumedAt, 'item consumed');
    await ctx.call('pantry_consume', { itemIds: ids, action: 'unconsume' });
    mine = (await pantry(ctx, { search: name })).find((i) => i.id === item.id);
    ctx.assert(!mine?.consumedAt, 'item unconsumed');

    await ctx.call('pantry_consume', { itemIds: ids, action: 'delete' });
    ids = [];
    mine = (await pantry(ctx, { search: name })).find((i) => i.id === item.id);
    ctx.assert(!mine, 'item deleted');
  } finally {
    if (ids.length) await ctx.raw('pantry_consume', { itemIds: ids, action: 'delete' });
  }
}

export async function cleanup(ctx) {
  const leftovers = (await pantry(ctx, { search: 'mcp-test-' })).filter((i) => ctx.isTestName(i.name));
  if (leftovers.length) {
    await ctx.call('pantry_consume', { itemIds: leftovers.map((i) => i.id), action: 'delete' });
  }
  return leftovers.length;
}
