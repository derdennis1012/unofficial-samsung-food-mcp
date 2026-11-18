import './setup.js';
import test from 'node:test';
import assert from 'node:assert/strict';
import '../src/api/index.js';
import { SamsungFood } from '../src/core/client.js';
import { readSchema } from '../src/core/schema-build.js';
import { tools } from '../src/tools/mealplan.js';

const schema = readSchema();

const V2 = 'whisk.x.mealplan.v2.MealPlanV2API';
const TPL = 'whisk.x.mealplan.v2.MealPlanTemplateAPI';
const USER = 'whisk.x.user.v1.UserAPI';

const tool = (name) => tools.find((t) => t.name === name);

/** Client with a scripted transport. `responses[method]` is a plain object or a function(request). */
function mockClient(responses = {}) {
  const calls = [];
  const sf = new SamsungFood({
    schema,
    token: 'fake',
    transport: {
      call: async (method, payload, opts) => {
        const request = sf.codec.decodeMessage(sf.codec.rpc(method).request, payload);
        calls.push({ method, request, opts });
        const r = responses[method];
        if (r === undefined) throw new Error(`unexpected call ${method}`);
        const res = typeof r === 'function' ? r(request) : r;
        return sf.codec.encodeMessage(sf.codec.rpc(method).response, res);
      },
    },
  });
  sf._cache.mealPlan = { mealPlanId: 'mp1' }; // avoids GetMealPlan and touching the auth file
  return { sf, calls };
}

/* ------------------------------------------------------------ tool definitions */

test('every tool: example parses, kind/description present', () => {
  assert.ok(tools.length >= 13);
  for (const t of tools) {
    assert.ok(t.description.length > 30, `${t.name} description`);
    assert.ok(t.annotations, `${t.name} annotations`);
    assert.doesNotThrow(() => t.schema.parse(t.example), `${t.name} example`);
    // strict: unknown keys are rejected
    assert.throws(() => t.schema.parse({ ...t.example, bogus: 1 }), `${t.name} strict`);
  }
});

test('read tools are marked read-only, the rest is not', () => {
  const reads = ['meal_plan_settings_get', 'meal_plan_template_list', 'account_settings_get', 'account_usage'];
  for (const t of tools) assert.equal(t.annotations.readOnlyHint, reads.includes(t.name), t.name);
});

test('note tools reject bad dates and empty text', () => {
  const add = tool('meal_plan_note_add').schema;
  assert.throws(() => add.parse({ date: '2027-02-30', text: 'x' }));
  assert.throws(() => add.parse({ date: '15.01.2027', text: 'x' }));
  assert.throws(() => add.parse({ date: '2027-01-15', text: '   ' }));
  assert.throws(() => add.parse({ date: '2027-01-15', text: 'a'.repeat(2001) }));
  assert.throws(() => add.parse({ text: 'x' }));
  const upd = tool('meal_plan_note_update').schema;
  assert.throws(() => upd.parse({ noteId: 'has space', date: '2027-01-15', text: 'x' }));
  assert.throws(() => upd.parse({ noteId: 'abc', text: 'x' }));
  for (const n of ['meal_plan_note_delete', 'meal_plan_note_undelete']) {
    assert.throws(() => tool(n).schema.parse({ noteId: '' }), n);
  }
});

test('enum validators', () => {
  assert.throws(() => tool('meal_plan_settings_update').schema.parse({ weekStart: 'funday' }));
  assert.throws(() => tool('meal_plan_template_list').schema.parse({ key: 'other' }));
  assert.deepEqual(tool('meal_plan_template_list').schema.parse({}), { key: 'onboarding' });
  assert.throws(() => tool('meal_plan_share_link').schema.parse({ medium: 'carrier-pigeon' }));
  assert.throws(() => tool('account_usage').schema.parse({ feature: 'ads_free' }));
  assert.throws(() => tool('meal_plan_meal_update').schema.parse({ contentId: 'abc', isLogged: 'yes' }));
});

test('account_settings_update validators', () => {
  const s = tool('account_settings_update').schema;
  assert.throws(() => s.parse({ diets: ['carnivore'] }));
  assert.throws(() => s.parse({ cookingLevel: 'wizard' }));
  assert.throws(() => s.parse({ country: 'de' }));
  assert.throws(() => s.parse({ language: 'german' }));
  assert.throws(() => s.parse({ height: { value: 180, unit: 'furlong' } }));
  assert.throws(() => s.parse({ weight: { value: 80 } }));
  assert.throws(() => s.parse({ nutritionGoals: { proteinRatio: 1.5 } }));
  assert.throws(() => s.parse({ plannedMeals: ['brunch'] }));
  assert.throws(() => s.parse({ username: 'sneaky' }), 'identity fields are not settable');
  assert.doesNotThrow(() => s.parse({ height: { value: 180, unit: 'cm' }, plannedMeals: ['lunch'], diets: [] }));
});

/* ------------------------------------------------------------ client against a mock transport */

test('notes: add / update / delete / undelete requests and output', async () => {
  const { sf, calls } = mockClient({
    [`${V2}/AddMealPlanNote`]: { id: 'n1' },
    [`${V2}/UpdateMealPlanNote`]: {},
    [`${V2}/DeleteMealPlanNote`]: {},
    [`${V2}/UndeleteMealPlanNote`]: {},
  });
  const added = await sf.addMealPlanNote({ date: '2027-01-15', text: 'mcp-test-x' });
  assert.deepEqual(added, { id: 'n1', date: '2027-01-15', text: 'mcp-test-x' });
  assert.deepEqual(calls[0].request, {
    mealPlanId: 'mp1',
    details: { date: { year: 2027, month: 1, day: 15 }, content: 'mcp-test-x' },
  });
  assert.equal(calls[0].opts.read, false);

  const upd = await sf.updateMealPlanNote({ id: 'n1', date: '2027-01-16', text: 'new' });
  assert.deepEqual(upd, { id: 'n1', date: '2027-01-16', text: 'new' });
  assert.deepEqual(calls[1].request, {
    id: 'n1',
    mealPlanId: 'mp1',
    details: { date: { year: 2027, month: 1, day: 16 }, content: 'new' },
  });

  assert.deepEqual(await sf.deleteMealPlanNote('n1'), { deleted: 'n1' });
  assert.deepEqual(calls[2].request, { id: 'n1', mealPlanId: 'mp1' });
  assert.deepEqual(await sf.undeleteMealPlanNote('n1'), { restored: 'n1' });
  assert.deepEqual(calls[3].request, { id: 'n1', mealPlanId: 'mp1' });
});

test('normalizeSchedule shows note ids and meal content ids', () => {
  const { sf } = mockClient();
  const out = sf.normalizeSchedule(
    {
      meals: [
        {
          id: 'm1',
          isLogged: true,
          schedule: { scheduledMeal: { day: { year: 2027, month: 1, day: 15 }, mealTime: 3 } },
          content: [{ recipe: { id: 'r1', name: 'Soup' }, mealContentId: 'c1' }],
        },
      ],
      notes: [{ id: 'n1', date: { year: 2027, month: 1, day: 15 }, content: 'hello' }],
    },
    '2027-01-15',
    '2027-01-15'
  );
  assert.deepEqual(out.notes, [{ id: 'n1', date: '2027-01-15', text: 'hello' }]);
  assert.equal(out.days[0].meals[0].contentId, 'c1');
  assert.equal(out.days[0].meals[0].isLogged, true);
});

test('updateMealContent: isLogged and food amount', async () => {
  const { sf, calls } = mockClient({ [`${V2}/UpdateMealContent`]: {} });
  const out = await sf.updateMealContent({ mealContentId: 'c1', isLogged: true });
  assert.deepEqual(out, { mealContentId: 'c1', isLogged: true });
  assert.deepEqual(calls[0].request, {
    updateMealContent: { mealContentId: 'c1', isLogged: true, updateMask: { paths: ['is_logged'] } },
  });

  await sf.updateMealContent({ mealContentId: 'c2', amount: 150, unit: 'gram' });
  assert.deepEqual(calls[1].request.updateMealContent.food, {
    measureQty: { simple: { amount: 150, unit: { name: 'gram' } } },
  });
  assert.deepEqual(calls[1].request.updateMealContent.updateMask.paths, ['food.measure_qty']);

  await assert.rejects(sf.updateMealContent({ mealContentId: 'c1' }), /nothing to update/);
  await assert.rejects(sf.updateMealContent({ mealContentId: 'c1', unit: 'gram' }), /unit needs amount/);
});

test('meal plan settings get / update', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.mealplan.v1.MealPlanAPI/GetMealPlan': {
      mealPlanId: 'mp1',
      settings: { weekStart: 7 },
      access: { mode: 2, role: 1, collaborators: [{ role: 1, collaborator: { userId: 'u1' } }] },
    },
    'whisk.x.mealplan.v1.MealPlanAPI/UpdateMealPlanSettings': {},
  });
  assert.deepEqual(await sf.mealPlanSettings(), {
    mealPlanId: 'mp1',
    weekStart: 'sunday',
    access: { mode: 'public', collaborators: 1 },
  });
  assert.equal(calls[0].opts.read, true);
  assert.deepEqual(await sf.updateMealPlanSettings({ weekStart: 'monday' }), { weekStart: 'monday' });
  assert.deepEqual(calls[1].request, { mealPlanId: 'mp1', settings: { weekStart: 1 } });
  await assert.rejects(sf.updateMealPlanSettings({ weekStart: 'funday' }), /unknown weekStart/);
});

test('templateList groups curated templates', async () => {
  const { sf, calls } = mockClient({
    [`${TPL}/GetTemplateList`]: {
      templateListItems: [
        { templates: [{ id: 't1', title: 'General', labels: { numberOfDays: 7 } }] },
        {
          templates: [{ id: 't2', title: 'Keto week', description: 'd', labels: { diets: [{ name: 'ketogenic', displayName: 'Keto' }], numberOfDays: 7 } }],
          diet: { name: 'ketogenic', displayName: 'Keto' },
        },
        { templates: [{ id: 't3', title: 'Sleep' }], wellnessArea: { wellnessArea: 1, name: { name: 'WELLNESS_AREA_SLEEP' } } },
      ],
    },
  });
  const out = await sf.templateList({ key: 'wellness_tips' });
  assert.equal(calls[0].request.key, 2);
  assert.ok(calls[0].request.responseMask.paths.includes('labels'));
  assert.deepEqual(out.map((g) => g.group), ['general', 'Keto', 'sleep']);
  assert.deepEqual(out[1].templates[0], {
    id: 't2', title: 'Keto week', description: 'd', imageUrl: null, days: 7, diets: ['Keto'],
  });
});

test('updateTemplate sends only the given fields with a mask', async () => {
  const { sf, calls } = mockClient({ [`${TPL}/UpdateTemplate`]: { ok: {} } });
  const out = await sf.updateTemplate({ id: 't1', title: 'mcp-test-new' });
  assert.deepEqual(out, { id: 't1', updated: ['title'] });
  assert.deepEqual(calls[0].request, { id: 't1', update: { title: 'mcp-test-new' }, updateMask: { paths: ['title'] } });
  await sf.updateTemplate({ id: 't1', description: 'd' });
  assert.deepEqual(calls[1].request.updateMask.paths, ['description']);
  await assert.rejects(sf.updateTemplate({ id: 't1' }), /nothing to update/);
});

test('updateTemplate surfaces server-side rejections', async () => {
  const { sf } = mockClient({ [`${TPL}/UpdateTemplate`]: { unknownOrInvalidRecipe: { recipeId: 'rX' } } });
  await assert.rejects(sf.updateTemplate({ id: 't1', title: 'x' }), /unknown recipe: rX/);
});

test('share link only generates', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.mealplan.v1.MealPlanSharingAPI/GenerateMealPlanLinks': {
      access: { mode: 2, links: [{ medium: 12, link: 'https://s.example/abc' }], collaborators: [] },
    },
  });
  const out = await sf.mealPlanShareLink({ medium: 'qr' });
  assert.deepEqual(out, { access: 'public', links: [{ medium: 'qr', url: 'https://s.example/abc' }] });
  assert.deepEqual(calls[0].request, { mealPlanId: 'mp1', links: [{ medium: 12 }] });
  assert.equal(calls.length, 1);
});

const ME = {
  user: {
    id: 'u1',
    settings: {
      firstName: 'Max',
      lastName: 'Mustermann',
      username: 'max',
      language: 'de-DE',
      country: 'DE',
      gender: 2,
      cookingLevel: 3,
      householdAdultCount: 2,
      diets: [{ name: { name: 'vegan', displayName: 'Vegan' } }],
      avoidances: [{ name: { name: 'gluten' } }],
      favouriteCuisines: [{ name: { name: 'german' } }],
      dislikedIngredients: [{ name: 'olives' }],
      height: { value: 188, unit: 1 },
      weight: { value: 80, unit: 2 },
      activityLevel: { code: 4, title: 'Active' },
      yearOfBirth: 1990,
      weekStart: 1,
      plannedMeals: [{ code: 1 }, { code: 3 }],
      nutritionGoals: {
        calorieGoal: 2100,
        fibreGoal: 30,
        macroRatiosWithName: { displayName: 'Keto', macroRatios: { proteinRatio: 0.25, fatRatio: 0.65, carbohydrateRatio: 0.1 } },
      },
      pushNotifications: { default: true },
      emailNotifications: { recipeRecommendation: true, productUpdates: false, promotionalUpdates: true },
    },
  },
};

test('accountSettings returns a readable view', async () => {
  const { sf } = mockClient({ [`${USER}/GetMe`]: ME });
  const s = await sf.accountSettings();
  assert.equal(s.gender, 'male');
  assert.equal(s.cookingLevel, 'intermediate');
  assert.deepEqual(s.diets, ['vegan']);
  assert.deepEqual(s.avoidances, ['gluten']);
  assert.deepEqual(s.dislikedIngredients, ['olives']);
  assert.deepEqual(s.body, {
    height: { value: 188, unit: 'cm' },
    weight: { value: 80, unit: 'pound' },
    activityLevel: 'active',
  });
  assert.deepEqual(s.nutritionGoals, {
    calories: 2100, fibre: 30, macroPlan: 'Keto', protein: 0.25, fat: 0.65, carbohydrate: 0.1,
  });
  assert.deepEqual(s.mealPlanning, { weekStart: 'monday', weeklyMeals: null, plannedMeals: ['breakfast', 'dinner'] });
  assert.equal(s.notifications.emailProductUpdates, false);
});

test('updateAccountSettings builds request and field mask', async () => {
  const { sf, calls } = mockClient({
    [`${USER}/UpdateSettings`]: { settings: ME.user.settings },
    [`${USER}/GetMe`]: ME,
  });
  await sf.updateAccountSettings({
    diets: ['vegan'],
    cookingLevel: 'advanced',
    dislikedIngredients: ['olives'],
    height: { value: 70, unit: 'inch' },
    plannedMeals: ['lunch', 'takeout'],
    activityLevel: 'very_light',
    pushNotifications: false,
  });
  assert.equal(calls.length, 1, 'no GetMe needed without nested merges');
  const { request } = calls[0];
  assert.deepEqual(request.settings, {
    diets: ['vegan'],
    cookingLevel: 4,
    dislikedIngredients: [{ name: 'olives' }],
    height: { value: 70, unit: 2 },
    plannedMeals: [2, 5],
    activityLevel: 1,
    pushNotifications: { default: false },
  });
  assert.deepEqual(request.updateMask.paths, [
    'diets', 'cooking_level', 'disliked_ingredients', 'height', 'planned_meals', 'activity_level', 'push_notifications',
  ]);
});

test('updateAccountSettings merges nested nutrition goals and email switches', async () => {
  const { sf, calls } = mockClient({
    [`${USER}/UpdateSettings`]: { settings: ME.user.settings },
    [`${USER}/GetMe`]: ME,
  });
  await sf.updateAccountSettings({ nutritionGoals: { calorieGoal: 1800 }, emailNotifications: { promotionalUpdates: false } });
  const update = calls.find((c) => c.method === `${USER}/UpdateSettings`).request;
  assert.deepEqual(update.settings.nutritionGoals, {
    calorieGoal: 1800,
    fibreGoal: 30,
    macroRatios: { proteinRatio: 0.25, fatRatio: 0.65, carbohydrateRatio: 0.1 },
  });
  assert.deepEqual(update.settings.emailNotifications, {
    recipeRecommendation: true, productUpdates: false, promotionalUpdates: false,
  });
  assert.deepEqual(update.updateMask.paths, ['nutrition_goals', 'email_notifications']);
  await assert.rejects(sf.updateAccountSettings({}), /nothing to update/);
});

test('accountUsage', async () => {
  const { sf, calls } = mockClient({
    'whisk.x.premium.v1.PremiumAPI/GetRemainingUsage': { data: { v1: { remaining: 0, nextUsageAvailableAt: { seconds: 1800000000 } } } },
  });
  const out = await sf.accountUsage({ feature: 'hr_tailored_plan' });
  assert.equal(calls[0].request.feature, 30);
  assert.deepEqual(out, { feature: 'hr_tailored_plan', remaining: 0, nextUsageAvailableAt: '2027-01-15T08:00:00.000Z' });
  await assert.rejects(sf.accountUsage({ feature: 'nope' }), /unknown feature/);
});

test('tool handlers call the matching client methods', async () => {
  const { sf, calls } = mockClient({ [`${V2}/DeleteMealPlanNote`]: {} });
  const out = await tool('meal_plan_note_delete').handler({ noteId: 'n9' }, sf);
  assert.deepEqual(out, { deleted: 'n9' });
  assert.equal(calls[0].request.id, 'n9');
});
