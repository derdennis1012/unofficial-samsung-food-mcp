/**
 * MCP tools: recipes (update, reviews, search helpers, smart collections, feeds, health suggestions,
 * dishes, recent searches). The basic recipe tools (search, get, create, delete, ...) live in core.js.
 */

import { z } from 'zod';
import { today } from '../client.js';
import { defineTool, idSchema, dateSchema, mealTimeSchema, shortText, limitSchema } from './util.js';

const cursorSchema = () =>
  z.string().min(1).max(4000).describe('nextCursor of the previous page, to get the next page');

const RECIPE_ID = () => idSchema('recipe ID').describe('Recipe ID from recipe_search, recipe_discover or meal_plan_get');
const REVIEW_TAGS =
  'Tags are short lowercase words such as delicious, easy, fresh, go-to, spicy, moist, under-30-minutes, makes-leftovers.';

export const tools = [
  defineTool({
    name: 'recipe_update',
    kind: 'update',
    description:
      'Changes fields of one of YOUR OWN recipes (created with recipe_create or imported); everything not passed stays as it is. Passing ingredients or instructions replaces the whole list. Recipes of other users are rejected. The returned recipe.id is the one to use from now on (normally unchanged).',
    example: { recipeId: '107abc', name: 'Pumpkin soup', servings: 4, instructions: ['Chop the pumpkin', 'Simmer for 20 minutes'] },
    schema: z.object({
      recipeId: idSchema('recipe ID').describe('ID of your own recipe, from recipe_search or recipe_create'),
      name: shortText('name', 300).optional(),
      description: z.string().max(2000).optional(),
      ingredients: z.array(shortText('ingredient', 300)).min(1).max(200).optional().describe('one ingredient per line, e.g. "400 g hokkaido pumpkin"; replaces the list'),
      instructions: z.array(shortText('step', 2000)).min(1).max(200).optional().describe('replaces the steps'),
      servings: z.number().int().min(1).max(1000).optional(),
      cookTime: z.number().int().min(0).max(100000).optional().describe('Minutes'),
      prepTime: z.number().int().min(0).max(100000).optional().describe('Minutes'),
      images: z.array(z.string().url()).min(1).max(10).optional().describe('replaces the images'),
      sourceName: shortText('source name', 200).optional(),
      sourceUrl: z.string().url().optional(),
    }),
    handler: async ({ recipeId, ...changes }, sf) => sf.updateRecipe(recipeId, changes),
  }),
  defineTool({
    name: 'recipe_rate',
    kind: 'update',
    description:
      'Likes or dislikes a recipe (Samsung Food has a thumbs up/down, no stars). rating is exactly "like" or "dislike"; rating again replaces your previous rating. Only works for public recipes: private recipes (e.g. your own, never shared) are rejected with a moderation error. Returns the review including its ID.',
    example: { recipeId: '107abc', rating: 'like' },
    schema: z.object({ recipeId: RECIPE_ID(), rating: z.enum(['like', 'dislike']).describe('like | dislike') }),
    handler: async (a, sf) => sf.rateRecipe(a.recipeId, a.rating === 'like'),
  }),
  defineTool({
    name: 'recipe_review_post',
    kind: 'update',
    description: `Posts your written review of a recipe with optional tags and a like/dislike. ${REVIEW_TAGS} Public recipes only (private ones are rejected). At least one of text, tags or rating is required. Remove it again with recipe_review_delete.`,
    example: { recipeId: '107abc', text: 'They came out great', tags: ['delicious', 'easy'], rating: 'like' },
    schema: z.object({
      recipeId: RECIPE_ID(),
      text: z.string().trim().min(1).max(2000).optional().describe('Review text'),
      tags: z.array(z.string().trim().min(1).max(60).regex(/^[a-z0-9-]+$/, 'tags are lowercase words with dashes')).max(20).optional(),
      rating: z.enum(['like', 'dislike']).optional().describe('like | dislike'),
    }),
    handler: async (a, sf) => sf.postReview(a.recipeId, { text: a.text, tags: a.tags, liked: a.rating === undefined ? undefined : a.rating === 'like' }),
  }),
  defineTool({
    name: 'recipe_review_get',
    kind: 'read',
    description:
      'Shows a review. With recipeId: YOUR review of that recipe (null if you have none). With reviewId: that review (the id is in the result of recipe_rate / recipe_review_post). rating is like or dislike.',
    example: { recipeId: '107abc' },
    schema: z.object({
      recipeId: idSchema('recipe ID').optional().describe('Recipe ID from recipe_search; returns your own review of it'),
      reviewId: idSchema('review ID').optional().describe('Review ID from recipe_rate or recipe_review_post'),
    }),
    handler: async (a, sf) => sf.getReview(a),
  }),
  defineTool({
    name: 'recipe_review_delete',
    kind: 'destructive',
    description: 'Deletes YOUR review/rating of a recipe (only your own can be deleted). Takes the recipe ID, not the review ID.',
    example: { recipeId: '107abc' },
    schema: z.object({ recipeId: RECIPE_ID() }),
    handler: async (a, sf) => sf.deleteReview(a.recipeId),
  }),
  defineTool({
    name: 'recipe_autocomplete',
    kind: 'read',
    description:
      'Suggests search terms for a prefix, as the search box of the app does. With includeRecent your own recent searches are mixed in (flagged recent=true). Useful terms can be passed to recipe_search (own recipes) or recipe_import_url.',
    example: { query: 'pum', limit: 5 },
    schema: z.object({
      query: z.string().trim().min(1).max(100).describe('Prefix typed so far, e.g. "pum"'),
      limit: limitSchema(10, 50),
      includeRecent: z.boolean().optional(),
    }),
    handler: async (a, sf) => sf.recipeAutocomplete(a.query, { limit: a.limit, includeRecent: a.includeRecent }),
  }),
  defineTool({
    name: 'recipe_categories',
    kind: 'read',
    description:
      'Lists the search categories of the explore page (id, title, image), e.g. chicken, pasta, vegan, under_30_min. type: "featured" = the home grid (default), "all" = the complete list. The titles work as search terms.',
    example: { type: 'featured' },
    schema: z.object({ type: z.enum(['featured', 'all']).optional().describe('featured | all, default featured') }),
    handler: async (a, sf) => sf.recipeCategories(a.type ?? 'featured'),
  }),
  defineTool({
    name: 'recipe_smart_collection',
    kind: 'read',
    description:
      'Smart collections are the automatic recipe lists of the app: made_it, recently_viewed, planned and my_recipes. Without collectionId it lists them (with recipe counts). With collectionId (one of those four ids) it returns the recipes in it, newest first by default, plus the available tags. Use limit and the returned nextCursor (as cursor) for more.',
    example: { collectionId: 'recently_viewed', limit: 10 },
    schema: z.object({
      collectionId: z.enum(['made_it', 'recently_viewed', 'planned', 'my_recipes']).optional().describe('made_it | recently_viewed | planned | my_recipes; omit to list the collections'),
      limit: limitSchema(20, 100),
      cursor: cursorSchema().optional(),
      order: z.enum(['newest', 'oldest']).optional().describe('newest | oldest, default newest'),
      tags: z.array(z.string().trim().min(1).max(100)).max(20).optional().describe('tag names from a previous result, to filter'),
    }),
    handler: async (a, sf) =>
      a.collectionId
        ? sf.smartCollection(a.collectionId, { limit: a.limit, cursor: a.cursor, order: a.order, tags: a.tags })
        : sf.smartCollections(),
  }),
  defineTool({
    name: 'recipe_recommended',
    kind: 'read',
    description:
      'The personalized recommendation feed of the home screen, recipes only (id, name, image, who posted it). Use limit and the returned nextCursor (as cursor) for the next page; seed shuffles the selection.',
    example: { limit: 10 },
    schema: z.object({
      limit: limitSchema(20, 100),
      cursor: cursorSchema().optional(),
      seed: z.number().int().min(1).max(2147483647).optional().describe('shuffles the selection, e.g. a random number'),
    }),
    handler: async (a, sf) => sf.recommendedRecipes(a),
  }),
  defineTool({
    name: 'recipe_health_recommend',
    kind: 'read',
    description:
      'Meal suggestions per day and meal slot that fit the calorie and nutrition goals of the account (see account_info), with the reasons (caloriesMacros, dqsAhei, foodList, mlRerank and their weight). mealTimes: any of breakfast, lunch, dinner, snack, togo (default breakfast, lunch, dinner). Recipe IDs can go to meal_plan_add or recipe_get. For more options for one slot use recipe_health_alternatives.',
    example: { from: '2026-11-02', mealTimes: ['lunch', 'dinner'], limit: 2 },
    schema: z.object({
      from: dateSchema('First day as YYYY-MM-DD, default today').optional(),
      to: dateSchema('Last day as YYYY-MM-DD, default same as from').optional(),
      mealTimes: z.array(mealTimeSchema()).min(1).max(5).optional().describe('breakfast | lunch | dinner | snack | togo, default breakfast, lunch, dinner'),
      limit: limitSchema(3, 10),
    }),
    handler: async (a, sf) => sf.healthRecommend({ from: a.from ?? today(), to: a.to, mealTimes: a.mealTimes, limit: a.limit }),
  }),
  defineTool({
    name: 'recipe_health_alternatives',
    kind: 'read',
    description:
      'More health-based suggestions for ONE meal slot of one day (the "show other options" of the recommendations). mealTime: breakfast | lunch | dinner | snack | togo. Recipe IDs can go to meal_plan_add or recipe_get.',
    example: { date: '2026-11-02', mealTime: 'dinner', limit: 3 },
    schema: z.object({
      date: dateSchema('Day as YYYY-MM-DD'),
      mealTime: mealTimeSchema(),
      limit: limitSchema(5, 20),
    }),
    handler: async (a, sf) => sf.healthAlternatives(a),
  }),
  defineTool({
    name: 'recipe_dish_lookup',
    kind: 'read',
    description:
      'Dish pages: generic dishes (burger, bread, ...) with typical nutrition per 100 g. Without urlPath it lists the top-level dishes with their urlPath (limit/cursor to page: nextCursor). With urlPath (as listed, e.g. "burger/cheeseburger") it returns that dish with the typical serving size in grams and the nutrition per 100 g.',
    example: { urlPath: 'burger/cheeseburger' },
    schema: z.object({
      urlPath: z.string().trim().min(1).max(200).regex(/^[\w\-/]+$/, 'urlPath looks like "burger/cheeseburger"').optional().describe('urlPath from the dish list'),
      limit: limitSchema(20, 100),
      cursor: cursorSchema().optional(),
    }),
    handler: async (a, sf) => sf.dishLookup(a),
  }),
  defineTool({
    name: 'recipe_more_from_user',
    kind: 'read',
    description:
      'Other recipes by the same author as a given recipe. The list is empty when the recipe has no user author (e.g. imported from a website).',
    example: { recipeId: '107abc', limit: 5 },
    schema: z.object({ recipeId: RECIPE_ID(), limit: limitSchema(10, 50) }),
    handler: async (a, sf) => sf.moreFromUser(a.recipeId, a.limit),
  }),
  defineTool({
    name: 'recipe_recent_queries',
    kind: 'read',
    description:
      'Your recent recipe searches, newest first. Samsung Food only keeps the last 5, and every recipe_search registers its term there.',
    example: {},
    schema: z.object({}),
    handler: async (_a, sf) => ({ queries: await sf.recentQueries() }),
  }),
  defineTool({
    name: 'recipe_recent_query_delete',
    kind: 'destructive',
    description: 'Removes one entry from your recent recipe searches (query = the exact text from recipe_recent_queries).',
    example: { query: 'pumpkin soup' },
    schema: z.object({ query: shortText('query', 200) }),
    handler: async (a, sf) => sf.deleteRecentQuery(a.query),
  }),
];
