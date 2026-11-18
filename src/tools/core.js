/**
 * Core tools: meal plan, shopping list, recipes, collections, pantry, raw API access, account.
 * Further areas live in the sibling files and are assembled in ./index.js.
 */

import { z } from 'zod';
import { today } from '../core/client.js';
import { loginWithCredential, authStatus } from '../core/session.js';
import { defineTool, idSchema, idList, dateSchema, mealTimeSchema, shortText, LOCATIONS } from './util.js';

/**
 * Methods api_call refuses: everything on the login/session service and the methods that change
 * or delete account credentials. Through a raw call they could take over or destroy the account.
 */
const BLOCKED_SERVICE = /(^|\.)AuthAPI\//;
const BLOCKED_METHOD = /\/(Update(Email|Phone|Password)|CreatePassword|\w*ResetPassword\w*|DeleteMe|Delete(User|Account)\w*|ExchangeSamsungAccountCode)$/;

export function assertRawCallAllowed(method) {
  if (BLOCKED_SERVICE.test(method) || BLOCKED_METHOD.test(method)) {
    throw new Error(
      `api_call refuses ${method}: login, session and account-credential methods (e-mail, phone, password, account deletion) are blocked. Use auth_login / auth_status for the session, and the Samsung Food app for account changes.`
    );
  }
}

/** Keys whose values are always secrets. */
const SECRET_KEY = /^(access|refresh|id|auth|session|bearer)?token$|^(access|refresh|id|session)Token$|^authCode$|^(new|old|current)?password$|^(new|old|current)Password$|secret|^apiKey$/i;
/** Context that makes a `code` an auth code rather than e.g. a country or nutrient code. */
const AUTH_CONTEXT = /auth|token|login|session|credential|otp|verif|password|samsungAccount/i;

/**
 * Deep copy with secrets replaced by "[redacted]": token/password-like keys always; a string `code`
 * when it sits in an auth-ish context or looks like an opaque credential (20+ characters).
 */
export function redactSecrets(value, context = '') {
  if (Array.isArray(value)) return value.map((v) => redactSecrets(v, context));
  if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
  const authy = AUTH_CONTEXT.test(context) || Object.keys(value).some((k) => SECRET_KEY.test(k) || /^expiresIn$/.test(k));
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    if (v != null && typeof v !== 'object' && SECRET_KEY.test(k)) out[k] = '[redacted]';
    else if (k === 'code' && typeof v === 'string' && (authy || v.length >= 20)) out[k] = '[redacted]';
    else if (v && typeof v === 'object' && !Buffer.isBuffer(v) && SECRET_KEY.test(k)) out[k] = '[redacted]';
    else out[k] = redactSecrets(v, `${context}.${k}`);
  }
  return out;
}

export const coreTools = [
  defineTool({
    name: 'meal_plan_get',
    kind: 'read',
    description:
      'Shows the meal plan for a date range, including planned calories per day and unscheduled meals. Default: today + 7 days.',
    schema: z.object({
      from: dateSchema().optional().describe('Start date as YYYY-MM-DD, default today'),
      days: z.number().int().min(1).max(60).optional().describe('Number of days, default 7'),
      to: dateSchema().optional().describe('End date as YYYY-MM-DD, overrides days'),
    }),
    handler: async (a, sf) => sf.schedule({ from: a.from ?? today(), days: a.days ?? 7, to: a.to }),
  }),
  defineTool({
    name: 'meal_plan_add',
    example: { recipeId: '101abc', date: '2026-12-24', mealTime: 'dinner' },
    kind: 'write',
    description:
      'Schedules a recipe as a meal. Without a date it goes into the unscheduled pool. mealTime: breakfast, lunch, dinner, snack or togo.',
    schema: z.object({
      recipeId: idSchema().describe('Recipe ID from recipe_search, recipe_discover or meal_plan_get'),
      date: dateSchema().optional().describe('YYYY-MM-DD; omit for unscheduled'),
      mealTime: mealTimeSchema().default('dinner').describe('breakfast | lunch | dinner | snack | togo'),
    }),
    handler: async (a, sf) => sf.addMeal(a),
  }),
  defineTool({
    name: 'meal_plan_remove',
    example: { mealIds: ['abc123'] },
    kind: 'destructive',
    description: 'Removes one or more meals from the meal plan (IDs from meal_plan_get).',
    schema: z.object({ mealIds: idList() }),
    handler: async (a, sf) => sf.deleteMeal(a.mealIds),
  }),
  defineTool({
    name: 'meal_plan_move',
    example: { mealId: 'abc123', date: '2026-12-25', mealTime: 'lunch' },
    kind: 'update',
    description: 'Moves a scheduled meal to a different date or slot.',
    schema: z.object({
      mealId: idSchema(),
      date: dateSchema().optional().describe('YYYY-MM-DD; omit for unscheduled'),
      mealTime: mealTimeSchema(),
    }),
    handler: async (a, sf) => sf.moveMeal(a),
  }),
  defineTool({
    name: 'meal_plan_templates',
    kind: 'read',
    description:
      'Lists your own weekly templates. With templateId the meals per day are loaded as well (orderDay = offset from the start date, 0 = first day).',
    schema: z.object({ templateId: idSchema().optional() }),
    handler: async (a, sf) => (a.templateId ? sf.template(a.templateId) : sf.templates()),
  }),
  defineTool({
    name: 'meal_plan_save_template',
    example: { title: 'Week 1', from: '2026-12-21', days: 7 },
    kind: 'write',
    description:
      'Saves a date range of the meal plan as a weekly template so it can be applied to any week later. Only recipes are copied; day offsets stay relative to the start date.',
    schema: z.object({
      title: shortText('title', 300).describe('Template name'),
      from: dateSchema().optional().describe('YYYY-MM-DD, default today'),
      days: z.number().int().min(1).max(31).optional().describe('Default 7'),
      to: dateSchema().optional(),
      description: z.string().max(2000).optional(),
    }),
    handler: async (a, sf) => sf.saveWeekAsTemplate(a),
  }),
  defineTool({
    name: 'meal_plan_apply_template',
    example: { templateId: 'abc123', startDate: '2026-12-28' },
    kind: 'destructive',
    idempotent: false,
    description:
      'Applies a weekly template to the meal plan from a start date. Existing meals are kept; with replace the range is cleared first (existing meals in it are deleted). The template is validated before anything is cleared; if applying fails after the clear, the error lists the removed meals so they can be re-added. Returns the resulting plan.',
    schema: z.object({
      templateId: idSchema(),
      startDate: dateSchema().optional().describe('YYYY-MM-DD, default today'),
      replace: z.boolean().optional().describe('Clear the range first'),
      days: z.number().int().min(1).max(31).optional(),
    }),
    handler: async (a, sf) =>
      sf.applyTemplate(a.templateId, { startDate: a.startDate, replace: a.replace, days: a.days }),
  }),
  defineTool({
    name: 'meal_plan_delete_template',
    example: { templateIds: ['abc123'] },
    kind: 'destructive',
    description: 'Deletes your own weekly templates.',
    schema: z.object({ templateIds: idList() }),
    handler: async (a, sf) => sf.deleteTemplates(a.templateIds),
  }),
  defineTool({
    name: 'meal_plan_clear',
    kind: 'destructive',
    description:
      'Clears a date range of the meal plan. Without arguments: today + 7 days. With scope "unscheduled" the unscheduled pool is cleared instead - this affects all unscheduled meals at once and cannot be undone.',
    schema: z.object({
      scope: z.enum(['scheduled', 'unscheduled']).optional(),
      from: dateSchema().optional().describe('YYYY-MM-DD'),
      days: z.number().int().min(1).max(60).optional(),
      to: dateSchema().optional(),
    }),
    handler: async (a, sf) =>
      a.scope === 'unscheduled'
        ? sf.clearUnscheduled()
        : sf.clearWeek({ from: a.from, days: a.days, to: a.to }),
  }),
  defineTool({
    name: 'meal_plan_previously_planned',
    kind: 'read',
    description:
      'Shows meals that have been on the plan before - a pool for a new week without having to search again. Returns recipe IDs for meal_plan_add.',
    schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    handler: async (a, sf) => sf.previouslyPlanned({ limit: a.limit ?? 30 }),
  }),
  defineTool({
    name: 'shopping_list_get',
    kind: 'read',
    description: 'Shows the shopping list with open and completed items, grouped by category.',
    schema: z.object({ listId: idSchema().optional().describe('Default: primary list') }),
    handler: async (a, sf) => sf.listItems(a.listId),
  }),
  defineTool({
    name: 'shopping_list_add',
    example: { items: ['2 onions', 'milk'] },
    kind: 'write',
    description:
      'Adds free-text items to the shopping list, e.g. "2 onions". The server detects quantity, unit and category itself.',
    schema: z.object({
      items: z.array(shortText('text')).min(1).max(100).describe('e.g. ["2 onions", "milk", "500 g flour"]'),
      listId: idSchema().optional(),
      addToRecent: z.boolean().optional().describe('Remember the items in "recent items" (default true)'),
    }),
    handler: async (a, sf) => sf.addListItems(a.items, { listId: a.listId, addToRecent: a.addToRecent ?? true }),
  }),
  defineTool({
    name: 'shopping_list_add_recipe',
    example: { recipeId: '101abc', servings: 4 },
    kind: 'write',
    description: 'Copies all ingredients of a recipe to the shopping list and merges quantities.',
    schema: z.object({
      recipeId: idSchema(),
      servings: z.number().positive().max(1000).optional().describe('Servings, scales the quantities'),
      listId: idSchema().optional(),
    }),
    handler: async (a, sf) => sf.addRecipeToList(a.recipeId, { servings: a.servings, listId: a.listId }),
  }),
  defineTool({
    name: 'shopping_list_update',
    example: { itemIds: ['abc123'], action: 'check' },
    kind: 'destructive',
    description: 'Checks items off, undoes that, or deletes them (IDs from shopping_list_get).',
    schema: z.object({
      itemIds: idList(),
      action: z.enum(['check', 'uncheck', 'delete']),
      listId: idSchema().optional(),
    }),
    handler: async (a, sf) => {
      if (a.action === 'delete') return sf.deleteListItems(a.itemIds, { listId: a.listId });
      await sf.checkListItems(a.itemIds, a.action === 'check', { listId: a.listId });
      return { updated: a.itemIds.length, action: a.action };
    },
  }),
  defineTool({
    name: 'shopping_lists',
    kind: 'read',
    description: 'Lists all shopping lists of the account, including shared lists.',
    schema: z.object({}),
    handler: async (_a, sf) => sf.lists(),
  }),
  defineTool({
    name: 'recipe_search',
    example: { query: 'soup' },
    kind: 'read',
    description:
      'Searches your own saved recipes across all collections. Side effect: the term is added to your recent searches (the account keeps the last 5). Restricted to one collection with collectionId. Note: does NOT search the global Samsung Food catalog - there is no API method for that; use recipe_discover to browse or fetch a recipe from a website via recipe_import_url.',
    schema: z.object({
      query: z.string().max(200).describe('Search term, e.g. "pumpkin soup"'),
      limit: z.number().int().min(1).max(50).optional(),
      collectionId: idSchema().optional(),
    }),
    handler: async (a, sf) => sf.searchRecipes(a.query, { limit: a.limit ?? 20, collectionId: a.collectionId ?? '' }),
  }),
  defineTool({
    name: 'recipe_discover',
    kind: 'read',
    description:
      'Returns recipe suggestions from the global catalog for browsing. No search term possible - the API ignores it. Use seed to shuffle the selection.',
    schema: z.object({
      limit: z.number().int().min(1).max(50).optional(),
      seed: z.number().int().min(0).max(2147483647).optional().describe('shuffles the selection, e.g. a random number'),
    }),
    handler: async (a, sf) => sf.popularRecipes({ limit: a.limit ?? 20, seed: a.seed }),
  }),
  defineTool({
    name: 'recipe_get',
    example: { recipeId: '101abc' },
    kind: 'read',
    description: 'Fetches a recipe with ingredients, instructions and nutrition.',
    schema: z.object({ recipeId: idSchema() }),
    handler: async (a, sf) => sf.recipe(a.recipeId),
  }),
  defineTool({
    name: 'recipe_similar',
    example: { recipeId: '101abc' },
    kind: 'read',
    description: 'Finds recipes similar to a given recipe.',
    schema: z.object({ recipeId: idSchema(), limit: z.number().int().min(1).max(100).optional() }),
    handler: async (a, sf) => sf.similarRecipes(a.recipeId, a.limit ?? 12),
  }),
  defineTool({
    name: 'recipe_import_url',
    example: { url: 'https://example.com/recipe', dryRun: true },
    kind: 'write',
    description:
      'Extracts a recipe from any website and saves it to the account. With dryRun it only parses, without saving.',
    schema: z.object({
      url: z.string().url(),
      dryRun: z.boolean().optional(),
      collectionIds: z.array(idSchema()).max(50).optional(),
    }),
    handler: async (a, sf) =>
      a.dryRun ? sf.extractRecipe(a.url) : sf.importRecipe(a.url, { collectionIds: a.collectionIds }),
  }),
  defineTool({
    name: 'recipe_create',
    example: { name: 'Test soup', ingredients: ['1 onion'], instructions: ['Cook.'] },
    kind: 'write',
    description: 'Creates a custom recipe. With recipeId an existing recipe is overwritten.',
    schema: z.object({
      name: shortText('name', 300),
      ingredients: z.array(shortText('ingredient', 300)).min(1).max(200).describe('one ingredient per line, e.g. "400 g hokkaido pumpkin"'),
      instructions: z.array(shortText('step', 2000)).max(200).optional(),
      description: z.string().max(2000).optional(),
      servings: z.number().int().min(1).max(1000).optional(),
      cookTime: z.number().int().min(0).max(100000).optional().describe('Minutes'),
      prepTime: z.number().int().min(0).max(100000).optional().describe('Minutes'),
      images: z.array(z.string().url()).max(10).optional(),
      collectionIds: z.array(idSchema()).max(50).optional(),
      recipeId: idSchema().optional(),
    }),
    handler: async (a, sf) => sf.saveRecipe(a),
  }),
  defineTool({
    name: 'recipe_delete',
    example: { recipeId: '101abc' },
    kind: 'destructive',
    description: 'Deletes a custom recipe.',
    schema: z.object({ recipeId: idSchema() }),
    handler: async (a, sf) => sf.deleteRecipe(a.recipeId),
  }),
  defineTool({
    name: 'collections_list',
    kind: 'read',
    description: 'Lists the recipe collections of the account.',
    schema: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    handler: async (a, sf) => sf.collections({ limit: a.limit ?? 50 }),
  }),
  defineTool({
    name: 'collection_recipes',
    example: { collectionId: 'abc123' },
    kind: 'read',
    description: 'Shows the recipes in a collection.',
    schema: z.object({ collectionId: idSchema(), limit: z.number().int().min(1).max(100).optional() }),
    handler: async (a, sf) => sf.collectionRecipes(a.collectionId, { limit: a.limit ?? 50 }),
  }),
  defineTool({
    name: 'pantry_get',
    kind: 'read',
    description:
      'Shows the pantry with storage location, expiry date and daysLeft (negative = expired). Useful to see what needs to be used up before planning.',
    schema: z.object({
      includeConsumed: z.boolean().optional().describe('Also include consumed entries, default false (there can be hundreds)'),
      limit: z.number().int().min(1).max(200).default(50).describe('Page size, default 50, max 200'),
      offset: z.number().int().min(0).default(0).describe('Entries to skip; use nextOffset from the previous page'),
      search: z.string().max(100).optional().describe('Only entries whose name contains this text'),
    }),
    example: { limit: 10 },
    handler: async (a, sf) => {
      let items = await sf.pantry({ includeConsumed: a.includeConsumed ?? false });
      if (a.search) items = items.filter((i) => (i.name ?? '').toLowerCase().includes(a.search.toLowerCase()));
      const page = items.slice(a.offset, a.offset + a.limit);
      const next = a.offset + page.length;
      return {
        total: items.length,
        offset: a.offset,
        items: page,
        ...(next < items.length ? { nextOffset: next, hint: 'More entries available; pass offset=nextOffset.' } : {}),
      };
    },
  }),
  defineTool({
    name: 'pantry_add',
    example: { names: ['chicken breast'], location: 'freezer' },
    kind: 'write',
    description:
      'Adds entries to the pantry. IMPORTANT: for ingredients that can go in the fridge OR the freezer (meat, fish, butter), Samsung Food does NOT set an expiry date on its own - pass location here and the shelf life is computed from the food graph (chicken breast: fridge 2 days, freezer 9 months). Ask food_storage_info first if the storage location is unclear. Names that only approximately match a food-graph product (e.g. "oat milk" -> Milk) never get an automatic expiry date; those entries come back with matchedProduct and a warning.',
    schema: z.object({
      names: z.array(shortText('text')).min(1).max(100).describe('e.g. ["chicken breast", "basmati rice"]'),
      location: z.enum(LOCATIONS).optional().describe('fridge | freezer | pantry - applies to all listed ingredients'),
    }),
    handler: async (a, sf) => sf.addPantryItems(a.names, { location: a.location }),
  }),
  defineTool({
    name: 'food_storage_info',
    example: { name: 'chicken breast' },
    kind: 'read',
    description:
      'Looks up where an ingredient is stored and how long it keeps there - without creating anything. Returns all possible storage locations with shelf life in days and whether the location is ambiguous. exact: false (with a warning) means the name was matched to the closest product, not found as such. Purely local, no API call.',
    schema: z.object({ name: shortText('name', 300).describe('e.g. "chicken breast"') }),
    handler: async (a, sf) => (await sf.storageFor(a.name)) ?? { found: false, name: a.name },
  }),
  defineTool({
    name: 'pantry_update',
    example: { id: 'abc123', expiryDate: '2026-12-24' },
    kind: 'update',
    description: 'Changes the expiry date, name or storage location of a pantry entry.',
    schema: z.object({
      id: idSchema(),
      expiryDate: dateSchema().optional().describe('YYYY-MM-DD'),
      name: shortText('name', 300).optional(),
      location: z.enum(LOCATIONS).optional().describe('fridge | freezer | pantry'),
    }),
    handler: async (a, sf) => sf.updatePantryItem(a),
  }),
  defineTool({
    name: 'pantry_consume',
    example: { itemIds: ['abc123'], action: 'consume' },
    kind: 'destructive',
    description: 'Marks pantry entries as consumed, undoes that, or deletes them entirely.',
    schema: z.object({
      itemIds: idList(),
      action: z.enum(['consume', 'unconsume', 'delete']),
    }),
    handler: async (a, sf) => {
      if (a.action === 'delete') return sf.deletePantryItems(a.itemIds);
      return sf.consumePantryItems(a.itemIds, { undo: a.action === 'unconsume' });
    },
  }),
  defineTool({
    name: 'api_methods',
    kind: 'read',
    description:
      'Lists the available gRPC methods of the Samsung Food API, optionally filtered by substring. For everything that has no dedicated tool.',
    schema: z.object({ filter: z.string().optional().describe('e.g. "Community" or "MealPlan"') }),
    handler: async (a, sf) => sf.methods(a.filter),
  }),
  defineTool({
    name: 'api_describe',
    example: { method: 'whisk.x.list.v1.ListAPI/GetLists' },
    kind: 'read',
    description: 'Shows the request and response fields of a gRPC method so that api_call can be used correctly.',
    schema: z.object({ method: z.string().regex(/^[\w.]+\/\w+$/, 'expected package.Service/Method'), depth: z.number().int().min(1).max(6).optional() }),
    handler: async (a, sf) => sf.describe(a.method, a.depth ?? 3),
  }),
  defineTool({
    name: 'api_call',
    example: { method: 'whisk.x.list.v1.ListAPI/GetLists', request: {} },
    kind: 'destructive',
    idempotent: false,
    description:
      'Calls any gRPC method directly. Use api_describe first to learn the field names. Write methods change real data. Login/session methods (AuthAPI) and account-credential methods (change e-mail, phone or password, delete the account, Samsung account code exchange) are refused. Secrets in results (tokens, auth codes, passwords) are replaced by "[redacted]".',
    schema: z.object({
      method: z.string().regex(/^[\w.]+\/\w+$/, 'expected package.Service/Method').describe('e.g. "whisk.x.list.v1.ListAPI/GetLists"'),
      request: z.record(z.string(), z.any()).optional(),
    }),
    handler: async (a, sf) => {
      assertRawCallAllowed(a.method);
      return redactSecrets(await sf.call(a.method, a.request ?? {}), a.method);
    },
  }),
  defineTool({
    name: 'account_info',
    kind: 'read',
    description: 'Shows your own account with nutrition goals and settings.',
    schema: z.object({}),
    handler: async (_a, sf) => sf.me(),
  }),
  defineTool({
    name: 'auth_status',
    needsClient: false,
    kind: 'read',
    description:
      'Shows whether a Samsung Food login is stored, when it expires and when it was last renewed. Never returns the token itself.',
    schema: z.object({}),
    handler: async () => authStatus(),
  }),
  defineTool({
    name: 'auth_login',
    example: { token: 'fake-token-fake-token-fake-token' },
    kind: 'update',
    description:
      'Logs in with a browser session: validates the value, renews it to learn the expiry and stores it. Log in at app.samsungfood.com, run copy(document.cookie) in the DevTools console and pass the result. The value is a session secret: it grants full access to the account.',
    schema: z.object({
      token: z
        .string()
        .describe('Cookie string (document.cookie), bare token, "Bearer <token>" or a "Copy as cURL" command'),
    }),
    handler: async (a, sf) => loginWithCredential(sf, a.token),
  }),
];

