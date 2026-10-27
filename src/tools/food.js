/**
 * MCP tools: food & nutrition (food graph, Foodpedia products, ingredient analysis, food log).
 * food_storage_info (storage locations / shelf life) lives in core.js.
 */

import { z } from 'zod';
import { defineTool, idSchema, idList, shortText, limitSchema } from './util.js';

const cursorSchema = () => z.string().min(1).max(4000).describe('nextCursor of the previous page, to get the next page');
const languageSchema = () =>
  z.string().regex(/^[a-z]{2}$/, 'two-letter language code such as en or de').optional().describe('Two-letter language code, default: the configured locale');
const PRODUCT_ID = () =>
  z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f]+$/, 'product IDs are canonical names such as "BANANA"').describe('Product ID (canonical name, upper case) from food_product_search or food_product_popular');

export const tools = [
  defineTool({
    name: 'food_search',
    kind: 'read',
    description:
      'Searches the food graph (generic foods and ingredients, not recipes). Returns food IDs for food_get and for meal plan entries. Use limit and the returned nextCursor (as cursor) for more.',
    example: { query: 'banana', limit: 5 },
    schema: z.object({
      query: shortText('query', 200).describe('Search term, e.g. "banana"'),
      limit: limitSchema(20, 100),
      cursor: cursorSchema().optional(),
      language: languageSchema(),
    }),
    handler: async (a, sf) => sf.foodSearch(a.query, a),
  }),
  defineTool({
    name: 'food_get',
    kind: 'read',
    description:
      'Shows one food: its portion sizes (name such as "medium"/"large", grams) and the nutrition per 100 g (Edamam codes like ENERC_KCAL, FAT, CHOCDF, PROCNT). Multiply by grams/100 for a portion. foodId from food_search.',
    example: { foodId: '20271bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' },
    schema: z.object({
      foodId: idSchema('food ID').describe('Food ID from food_search'),
      attributeId: idSchema('attribute ID').optional().describe('attributeId of the search hit, if it had one'),
      nutrition: z.boolean().optional().describe('include nutrition per 100 g, default true'),
      language: languageSchema(),
    }),
    handler: async (a, sf) => sf.foodGet(a.foodId, a),
  }),
  defineTool({
    name: 'food_autocomplete',
    kind: 'read',
    description: 'Suggests food names for a prefix (e.g. "ban" gives banana). The names work as input for food_search.',
    example: { query: 'ban', limit: 5 },
    schema: z.object({
      query: z.string().trim().min(1).max(100).describe('Prefix, e.g. "ban"'),
      limit: limitSchema(10, 50),
      language: languageSchema(),
    }),
    handler: async (a, sf) => ({ suggestions: await sf.foodAutocomplete(a.query, a) }),
  }),
  defineTool({
    name: 'food_product_search',
    kind: 'read',
    description:
      'Searches the Foodpedia product encyclopedia (ingredients incl. packaged products). Results are ordered by relevance (there is no sort option). Returns product IDs (upper-case canonical names) for food_product_get. Use limit and the returned nextCursor (as cursor) for more.',
    example: { query: 'banana', limit: 5 },
    schema: z.object({
      query: shortText('query', 200).describe('Search term, e.g. "banana"'),
      limit: limitSchema(20, 100),
      cursor: cursorSchema().optional(),
    }),
    handler: async (a, sf) => sf.productSearch(a.query, a),
  }),
  defineTool({
    name: 'food_product_get',
    kind: 'read',
    description:
      'Shows a Foodpedia product: category, description, storage location, glycemic index, nutrition per 100 g, grams per unit (piece, slice, ...), suitable diets, tips, substitutes and a few linked recipes. productId from food_product_search or food_product_popular.',
    example: { productId: 'BANANA' },
    schema: z.object({ productId: PRODUCT_ID() }),
    handler: async (a, sf) => sf.productGet(a.productId),
  }),
  defineTool({
    name: 'food_product_popular',
    kind: 'read',
    description: 'Lists popular Foodpedia products (turmeric, ...). Use limit and the returned nextCursor (as cursor) for more.',
    example: { limit: 10 },
    schema: z.object({ limit: limitSchema(20, 100), cursor: cursorSchema().optional() }),
    handler: async (a, sf) => sf.popularProducts(a),
  }),
  defineTool({
    name: 'nutrition_analyze',
    kind: 'read',
    description:
      'Parses free-text ingredient lines such as "2 cups milk" or "400 g hokkaido pumpkin" into the normalized food (canonical name), category, quantity and unit. Nothing is saved. To get the nutrition of a recognised food, look it up with food_product_get using the canonical name as productId.',
    example: { items: ['400 g hokkaido pumpkin', '2 eggs', '1 cup milk'] },
    schema: z.object({
      items: z.array(shortText('ingredient line', 300)).min(1).max(100).describe('one ingredient per entry, e.g. ["2 eggs", "1 cup milk"]'),
      language: languageSchema(),
    }),
    handler: async (a, sf) => ({ items: await sf.analyzeIngredients(a.items, a) }),
  }),
  defineTool({
    name: 'foodlog_add_from_meal_plan',
    kind: 'write',
    description:
      'Logs planned meals as eaten in the food log (so they count towards your nutrition tracking). mealIds come from meal_plan_get. Returns foodLogIds, which foodlog_delete needs to undo it.',
    example: { mealIds: ['01a0aaaabbbbccccddddeeeeeeeeeeee'] },
    schema: z.object({ mealIds: idList('meal IDs', 50).describe('Meal IDs from meal_plan_get') }),
    handler: async (a, sf) => sf.addFoodLogFromMealPlan(a.mealIds),
  }),
  defineTool({
    name: 'foodlog_delete',
    kind: 'destructive',
    description:
      'Removes entries from the food log (the meal stays in the meal plan). foodLogIds as returned by foodlog_add_from_meal_plan; plain meal IDs from meal_plan_get are accepted as well.',
    example: { foodLogIds: ['01a0aaaa-bbbb-cccc-dddd-eeeeeeeeeeee'] },
    schema: z.object({ foodLogIds: idList('food log IDs', 50) }),
    handler: async (a, sf) => sf.deleteFoodLogItems(a.foodLogIds),
  }),
];
