/**
 * Live tests, area "food" (food graph, Foodpedia products, ingredient analysis, food log).
 *
 * The food log is only touched through a throwaway meal: a temp recipe "mcp-test-<ts>-food" is
 * planned on a day about one year ahead, logged, un-logged and removed again. Only the log item
 * of that one meal is ever deleted.
 */

export const readSkip = {};

export async function readSamples(ctx) {
  const found = await ctx.call('food_search', { query: 'banana', limit: 3 });
  const foodId = found.foods?.[0]?.id;
  ctx.assert(foodId, 'food_search found no food to use as sample');
  return {
    food_search: { query: 'banana', limit: 5 },
    food_get: { foodId },
    food_autocomplete: { query: 'ban', limit: 5 },
    food_product_search: { query: 'banana', limit: 5 },
    food_product_get: { productId: 'BANANA' },
    food_product_popular: { limit: 5 },
    nutrition_analyze: { items: ['400 g hokkaido pumpkin', '2 eggs', '1 cup milk'] },
  };
}

/** GetMealSchedule via the raw API, to read isLogged / foodLogItemId which the plan tools do not show. */
async function mealState(ctx, mealId, day) {
  const plan = await ctx.call('api_call', { method: 'whisk.x.mealplan.v1.MealPlanAPI/GetMealPlan', request: { mealPlanId: '' } });
  const [year, month, dayOfMonth] = day.split('-').map(Number);
  const date = { year, month, day: dayOfMonth };
  const sched = await ctx.call('api_call', {
    method: 'whisk.x.mealplan.v2.MealPlanV2API/GetMealSchedule',
    request: {
      mealPlanId: plan.mealPlanId,
      period: { startDate: date, endDate: date },
      mealMask: { paths: ['recipe.name'] },
      responseMask: { paths: ['meals'] },
    },
  });
  return (sched.meals ?? []).find((m) => m.id === mealId) ?? null;
}

export async function run(ctx) {
  // --- reads with assertions
  const parsed = await ctx.call('nutrition_analyze', { items: ['400 g hokkaido pumpkin', '2 cups milk', '3 eggs'] });
  const [pumpkin, milk, eggs] = parsed.items;
  ctx.assert(pumpkin.food === 'HOKKAIDO PUMPKIN' && pumpkin.quantity === 400 && pumpkin.unit === 'g', `pumpkin parsed: ${JSON.stringify(pumpkin)}`);
  ctx.assert(milk.food === 'MILK' && milk.quantity === 2 && /^cups?$/.test(milk.unit), `milk parsed: ${JSON.stringify(milk)}`);
  ctx.assert(eggs.food === 'EGG' && eggs.quantity === 3, `eggs parsed: ${JSON.stringify(eggs)}`);

  const search = await ctx.call('food_search', { query: 'banana', limit: 2 });
  ctx.assert(search.foods.length === 2 && search.nextCursor, 'food_search pages');
  const page2 = await ctx.call('food_search', { query: 'banana', limit: 2, cursor: search.nextCursor });
  ctx.assert(page2.foods[0].id !== search.foods[0].id, 'second page differs from the first');
  const food = await ctx.call('food_get', { foodId: search.foods[0].id });
  const kcal = food.nutritionPer100g?.find((n) => n.code === 'ENERC_KCAL');
  ctx.assert(kcal && kcal.value > 50 && kcal.value < 150, `banana kcal per 100 g plausible (${kcal?.value})`);
  ctx.assert(food.measures.some((m) => m.name === 'medium' && m.grams > 50), 'food_get lists portion sizes');
  const bare = await ctx.call('food_get', { foodId: search.foods[0].id, nutrition: false });
  ctx.assert(!bare.nutritionPer100g && bare.measures.length > 0, 'food_get without nutrition');

  const product = await ctx.call('food_product_get', { productId: 'BANANA' });
  ctx.assert(product.id === 'BANANA' && product.nutritionPer100g.length > 3, 'banana product with nutrition');
  const products = await ctx.call('food_product_search', { query: 'banana', limit: 3 });
  ctx.assert(products.total > 3 && products.products.length === 3, 'product search with total');

  // --- food log on a throwaway meal
  const day = ctx.futureDate(7);
  let recipeId;
  let mealId;
  let logged = false;
  try {
    const recipe = await ctx.call('recipe_create', {
      name: `${ctx.prefix}-food`,
      ingredients: ['1 banana'],
      instructions: ['Eat.'],
      servings: 1,
    });
    recipeId = recipe.id;
    const added = await ctx.call('meal_plan_add', { recipeId, date: day, mealTime: 'dinner' });
    mealId = (added.result ?? added)[0]?.id;
    ctx.assert(mealId, 'temp meal created');
    ctx.assert(!(await mealState(ctx, mealId, day))?.isLogged, 'fresh meal is not logged');

    const log = await ctx.call('foodlog_add_from_meal_plan', { mealIds: [mealId] });
    logged = true;
    ctx.assert(log.logged === 1 && log.foodLogIds.length === 1, 'log reports one item');
    const state = await mealState(ctx, mealId, day);
    ctx.assert(state?.isLogged === true, 'meal is logged');
    ctx.assert(state.foodLogItemId === log.foodLogIds[0], `derived log id matches the server's (${state.foodLogItemId} vs ${log.foodLogIds[0]})`);

    await ctx.call('foodlog_delete', { foodLogIds: log.foodLogIds });
    logged = false;
    ctx.assert(!(await mealState(ctx, mealId, day))?.isLogged, 'meal is no longer logged');
  } finally {
    if (mealId) {
      if (logged) await ctx.raw('foodlog_delete', { foodLogIds: [mealId] }).catch(() => {});
      const rm = await ctx.raw('meal_plan_remove', { mealIds: [mealId] });
      if (rm.isError) ctx.log(`could not remove the test meal ${mealId}: ${rm.text}`);
    }
    if (recipeId) {
      const del = await ctx.raw('recipe_delete', { recipeId });
      if (del.isError) ctx.log(`could not delete the test recipe ${recipeId}: ${del.text}`);
    }
  }
}

/** Leftover test meals around the test day: un-log and remove them (their recipes belong to the recipes area). */
export async function cleanup(ctx) {
  const plan = await ctx.call('meal_plan_get', { from: ctx.futureDate(-3), days: 30 });
  const leftovers = [];
  for (const d of plan.days ?? []) for (const m of d.meals ?? []) if (ctx.isTestName(m.title)) leftovers.push(m.id);
  for (const m of plan.unscheduled ?? []) if (ctx.isTestName(m.title)) leftovers.push(m.id);
  if (!leftovers.length) return 0;
  await ctx.call('foodlog_delete', { foodLogIds: leftovers });
  const rm = await ctx.call('meal_plan_remove', { mealIds: leftovers });
  return rm.deleted?.length ?? leftovers.length;
}
