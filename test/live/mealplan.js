/**
 * Live tests: meal plan notes, meal content, settings, templates, sharing, account (read-only).
 * Writes only touch throwaway data: notes/meals about one year ahead, templates "mcp-test-*".
 * Account settings are NOT written (only read).
 */

const TPL_PREFIX = 'mcp-test-';

/** Array results arrive wrapped as {result: [...]}. */
const arr = (x) => (Array.isArray(x) ? x : (x?.result ?? []));

const planWindow = (ctx, from, days) => ctx.call('meal_plan_get', { from, days });

export async function readSamples(ctx) {
  const templates = arr(await ctx.call('meal_plan_template_list', { key: 'onboarding' }));
  ctx.assert(templates.length > 0, 'meal_plan_template_list returned no groups');
  return {
    meal_plan_settings_get: {},
    meal_plan_template_list: { key: 'wellness_tips' },
    account_settings_get: {},
    account_usage: { feature: 'mealplan_template_collections' },
  };
}

export const readSkip = {};

/** A throwaway recipe, so the test meal is recognizable ("mcp-test-*") and cleanup never touches real meals. */
async function createTempRecipe(ctx) {
  const r = await ctx.call('recipe_create', {
    name: `${ctx.prefix}-meal`,
    ingredients: ['1 onion'],
    instructions: ['Test only.'],
  });
  ctx.assert(r.id, 'temp recipe created');
  return r.id;
}

export async function run(ctx) {
  const date = ctx.futureDate();
  const noteIds = [];
  let mealIds = [];
  let templateId = null;
  let tempRecipeId = null;
  try {
    /* ---- notes */
    const text = `${ctx.prefix} note`;
    const note = await ctx.call('meal_plan_note_add', { date, text });
    noteIds.push(note.id);
    ctx.assert(note.id && note.date === date && note.text === text, `note add result ${JSON.stringify(note)}`);
    const notesOn = async () => (await planWindow(ctx, date, 1)).notes.filter((n) => n.date === date);

    let notes = await notesOn();
    ctx.assert(notes.some((n) => n.id === note.id && n.text === text), 'note visible in meal_plan_get');
    await ctx.call('meal_plan_note_update', { noteId: note.id, date, text: `${text} updated` });
    notes = await notesOn();
    ctx.assert(notes.some((n) => n.id === note.id && n.text === `${text} updated`), 'note text updated');
    await ctx.call('meal_plan_note_delete', { noteId: note.id });
    ctx.assert(!(await notesOn()).some((n) => n.id === note.id), 'note gone after delete');
    await ctx.call('meal_plan_note_undelete', { noteId: note.id });
    ctx.assert((await notesOn()).some((n) => n.id === note.id), 'note back after undelete');
    await ctx.call('meal_plan_note_delete', { noteId: note.id });
    ctx.assert(!(await notesOn()).some((n) => n.id === note.id), 'note gone after second delete');
    ctx.log('notes: add/update/delete/undelete ok');

    /* ---- temp meal + meal update */
    const recipeId = (tempRecipeId = await createTempRecipe(ctx));
    const added = await ctx.call('meal_plan_add', { recipeId, date, mealTime: 'dinner' });
    mealIds = arr(added).map((m) => m.id);
    ctx.assert(mealIds.length === 1, 'meal added');
    const day = () => planWindow(ctx, date, 1).then((p) => p.days.find((d) => d.date === date)?.meals ?? []);
    let meal = (await day()).find((m) => m.id === mealIds[0]);
    ctx.assert(meal?.contentId, 'meal exposes contentId in meal_plan_get');
    ctx.assert(meal.isLogged === false, 'new meal is not logged');

    await ctx.call('meal_plan_meal_update', { contentId: meal.contentId, isLogged: true });
    meal = (await day()).find((m) => m.id === mealIds[0]);
    ctx.assert(meal.isLogged === true, 'meal logged');
    await ctx.call('meal_plan_meal_update', { contentId: meal.contentId, isLogged: false });
    meal = (await day()).find((m) => m.id === mealIds[0]);
    ctx.assert(meal.isLogged === false, 'meal unlogged again');
    ctx.log('meal_plan_meal_update: isLogged roundtrip ok');

    /* ---- template from the future day (contains the temp meal) */
    const usageBefore = await ctx.call('account_usage', { feature: 'mealplan_template_collections' });
    const title = `${TPL_PREFIX}${ctx.ts}`;
    const saved = await ctx.call('meal_plan_save_template', { title, from: date, days: 1 });
    templateId = saved.id;
    ctx.assert(templateId, 'template saved');
    const renamed = `${title}-renamed`;
    await ctx.call('meal_plan_template_update', { templateId, title: renamed, description: 'mcp-test description' });
    // meal_plan_templates does not request the description, so read the raw template.
    const raw = await ctx.call('api_call', {
      method: 'whisk.x.mealplan.v2.MealPlanTemplateAPI/GetTemplate',
      request: { id: templateId, responseMask: { paths: ['title', 'description'] } },
    });
    const t = raw.mealPlanTemplate ?? {};
    ctx.assert(t.title === renamed, `template renamed (got ${t.title})`);
    ctx.assert(t.description === 'mcp-test description', 'template description updated');
    await ctx.call('meal_plan_delete_template', { templateIds: [templateId] });
    templateId = null;
    const usageAfter = await ctx.call('account_usage', { feature: 'mealplan_template_collections' });
    ctx.log(`template usage remaining ${usageBefore.remaining} -> ${usageAfter.remaining}`);

    /* ---- remove temp meal */
    await ctx.call('meal_plan_remove', { mealIds });
    mealIds = [];
    ctx.assert(!(await day()).length, 'future day empty again');

    /* ---- settings + share link (nothing is written/sent) */
    const settings = await ctx.call('meal_plan_settings_get', {});
    ctx.assert(settings.weekStart && settings.mealPlanId, 'settings readable');
    if (process.env.SAMSUNG_FOOD_LIVE_SHARE === '1') {
      const share = await ctx.call('meal_plan_share_link', { medium: 'copy' });
      ctx.assert(share.links.some((l) => /^https:\/\//.test(l.url)), 'share link generated');
      const settingsAfter = await ctx.call('meal_plan_settings_get', {});
      ctx.assert(settingsAfter.access.mode === settings.access.mode, 'share link generation kept the access mode');
    } else ctx.log('meal_plan_share_link skipped (opt-in: SAMSUNG_FOOD_LIVE_SHARE=1)');
  } finally {
    if (mealIds.length) await ctx.raw('meal_plan_remove', { mealIds }).catch(() => {});
    if (templateId) await ctx.raw('meal_plan_delete_template', { templateIds: [templateId] }).catch(() => {});
    for (const id of noteIds) await ctx.raw('meal_plan_note_delete', { noteId: id }).catch(() => {});
    if (tempRecipeId) await ctx.raw('recipe_delete', { recipeId: tempRecipeId }).catch(() => {});
  }
}

export async function cleanup(ctx) {
  let removed = 0;
  // Only throwaway objects: notes whose text and meals whose title start with "mcp-test-".
  // The windows are around the test date (~ +1 year); unscheduled meals are checked once.
  let unscheduled = [];
  for (const [a, b] of [[-30, 0], [1, 30]]) {
    const from = ctx.futureDate(a);
    const days = b - a + 1;
    const plan = await planWindow(ctx, from, days);
    unscheduled = plan.unscheduled;
    const noteIds = plan.notes.filter((n) => ctx.isTestName(n.text)).map((n) => n.id);
    for (const id of noteIds) {
      await ctx.call('meal_plan_note_delete', { noteId: id });
      removed++;
    }
    const meals = plan.days.flatMap((d) => d.meals).filter((m) => ctx.isTestName(m.title)).map((m) => m.id);
    if (meals.length) {
      await ctx.call('meal_plan_remove', { mealIds: meals });
      removed += meals.length;
    }
  }
  const stray = unscheduled.filter((m) => ctx.isTestName(m.title)).map((m) => m.id);
  if (stray.length) {
    await ctx.call('meal_plan_remove', { mealIds: stray });
    removed += stray.length;
  }
  const templates = arr(await ctx.call('meal_plan_templates', {}));
  const old = templates.filter((t) => ctx.isTestName(t.title)).map((t) => t.id);
  if (old.length) {
    await ctx.call('meal_plan_delete_template', { templateIds: old });
    removed += old.length;
  }
  return removed;
}
