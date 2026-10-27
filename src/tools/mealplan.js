/** MCP tools: meal plan extras (notes, settings, templates, sharing) and account settings. */

import { z } from 'zod';
import { defineTool, idSchema, dateSchema, shortText } from './util.js';

const NOTE_TEXT = () => z.string().trim().min(1).max(2000).describe('Note text, 1-2000 characters');
const NOTE_ID = () => idSchema('Note ID').describe('Note ID from meal_plan_get (notes[].id) or from meal_plan_note_add');

const WEEK_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
const LINK_MEDIA = ['copy', 'qr', 'native_share', 'email', 'sms', 'whatsapp', 'telegram', 'facebook', 'twitter'];

/** Values of the Samsung Food dictionaries (ProvisionAPI/GetDictionaries, language-independent names). */
const DIETS = [
  'lacto-vegetarian', 'ovo-vegetarian', 'ovo-lacto-vegetarian', 'pescatarian', 'vegan', 'vegetarian',
  'low-carb', 'mediterranean', 'ketogenic', 'paleo', 'dairy-free', 'gluten-free',
];
const AVOIDANCES = [
  'alcohol', 'caffeine', 'celery', 'crustacean', 'egg', 'fish', 'gluten', 'groundnut', 'milk', 'mollusc',
  'mustard', 'sesame', 'soybean', 'sulphites', 'tree-nut', 'wheat', 'lactose', 'yeast',
];
const NUTRITION_PREFS = ['healthy', 'high-protein', 'low-sugars', 'low-energy', 'low-sodium', 'low-fat', 'high-fiber'];
const CUISINES = [
  'african', 'american', 'asian', 'australian', 'british', 'cajun-and-creole', 'canadian', 'caribbean', 'chinese',
  'cuban', 'eastern-european', 'european', 'french', 'german', 'greek', 'indian', 'israeli', 'italian', 'japanese',
  'korean', 'latin-american', 'mediterranean', 'mexican', 'middle-eastern', 'moroccan', 'portuguese', 'southern',
  'spanish', 'tex-mex', 'thai', 'vietnamese', 'world-cuisine',
];
const USAGE_GOALS = ['quick-recipe-ideas', 'meal-planning', 'healthier-eating', 'instant-grocery-lists'];

const enumList = (values, what) =>
  z.array(z.enum(values)).max(values.length).describe(`${what}; allowed: ${values.join(', ')}. The list replaces the current one ([] clears it)`);

const ratio = (what) => z.number().min(0).max(1).describe(`${what} as fraction 0..1; the three ratios should add up to 1`);

export const tools = [
  /* ------------------------------------------------------------ notes */
  defineTool({
    name: 'meal_plan_note_add',
    kind: 'write',
    description:
      'Adds a free-text note to a day of the meal plan. Returns the note with its id. Notes are listed under notes[] in meal_plan_get.',
    schema: z.object({ date: dateSchema('Day of the note, YYYY-MM-DD'), text: NOTE_TEXT() }),
    example: { date: '2027-01-15', text: 'Guests at 7pm' },
    handler: async (a, sf) => sf.addMealPlanNote(a),
  }),
  defineTool({
    name: 'meal_plan_note_update',
    kind: 'update',
    description:
      'Replaces date and text of an existing note. Both are always sent: pass the current date to keep the note on its day.',
    schema: z.object({ noteId: NOTE_ID(), date: dateSchema('Day of the note, YYYY-MM-DD'), text: NOTE_TEXT() }),
    example: { noteId: '01a0ffffffffffffffffffffffffffff', date: '2027-01-15', text: 'Guests at 8pm' },
    handler: async (a, sf) => sf.updateMealPlanNote({ id: a.noteId, date: a.date, text: a.text }),
  }),
  defineTool({
    name: 'meal_plan_note_delete',
    kind: 'destructive',
    description:
      'Deletes a meal plan note. Can be undone with meal_plan_note_undelete as long as you keep the noteId (deleted notes no longer show up in meal_plan_get).',
    schema: z.object({ noteId: NOTE_ID() }),
    example: { noteId: '01a0ffffffffffffffffffffffffffff' },
    handler: async (a, sf) => sf.deleteMealPlanNote(a.noteId),
  }),
  defineTool({
    name: 'meal_plan_note_undelete',
    kind: 'update',
    description: 'Restores a note deleted with meal_plan_note_delete (use the noteId you deleted).',
    schema: z.object({ noteId: NOTE_ID() }),
    example: { noteId: '01a0ffffffffffffffffffffffffffff' },
    handler: async (a, sf) => sf.undeleteMealPlanNote(a.noteId),
  }),

  /* ------------------------------------------------------------ meal content */
  defineTool({
    name: 'meal_plan_meal_update',
    kind: 'update',
    description:
      'Updates the content entry of a planned meal. The API only supports two things: isLogged (mark the meal as eaten/logged, or undo that) and, for food entries (kind "food", not recipes), the amount. A recipe in a meal cannot be swapped or rescaled here - remove the meal and add a new one. contentId comes from meals[].contentId in meal_plan_get.',
    schema: z.object({
        contentId: idSchema('Content ID').describe('meals[].contentId from meal_plan_get'),
        isLogged: z.boolean().optional().describe('true = logged as eaten, false = not logged'),
        amount: z.number().positive().max(100000).optional().describe('New amount, food entries only'),
        unit: z.string().trim().min(1).max(50).optional().describe('Measure unit name for the amount, e.g. "gram"'),
    }),
    example: { contentId: '01a0ffff-ffff-7fff-bfff-ffffffffffff', isLogged: true },
    handler: async (a, sf) =>
      sf.updateMealContent({ mealContentId: a.contentId, isLogged: a.isLogged, amount: a.amount, unit: a.unit }),
  }),

  /* ------------------------------------------------------------ settings */
  defineTool({
    name: 'meal_plan_settings_get',
    kind: 'read',
    description: 'Shows the settings of the meal plan: first day of the week and sharing mode (private or public) with the number of collaborators.',
    schema: z.object({}),
    example: {},
    handler: async (_a, sf) => sf.mealPlanSettings(),
  }),
  defineTool({
    name: 'meal_plan_settings_update',
    kind: 'update',
    description: `Sets the first day of the week of the meal plan (the only meal plan setting the API has). weekStart: ${WEEK_DAYS.join(' | ')}.`,
    schema: z.object({ weekStart: z.enum(WEEK_DAYS) }),
    example: { weekStart: 'monday' },
    handler: async (a, sf) => sf.updateMealPlanSettings(a),
  }),

  /* ------------------------------------------------------------ templates */
  defineTool({
    name: 'meal_plan_template_list',
    kind: 'read',
    description:
      'Lists the curated public meal plan templates from Samsung Food (not your own - those are in meal_plan_templates). key "onboarding" groups them by diet, "wellness_tips" by wellness area (sleep, stress, ...). The template ids work with meal_plan_templates (templateId) to see the meals and with meal_plan_apply_template.',
    schema: z.object({ key: z.enum(['onboarding', 'wellness_tips']).default('onboarding') }),
    example: { key: 'onboarding' },
    handler: async (a, sf) => sf.templateList({ key: a.key }),
  }),
  defineTool({
    name: 'meal_plan_template_update',
    kind: 'update',
    description:
      'Renames or re-describes one of your own templates (id from meal_plan_templates or meal_plan_save_template). Only the given fields change; the meals stay as they are.',
    schema: z.object({
      templateId: idSchema('Template ID'),
      title: shortText('title', 300).optional().describe('New template name'),
      description: z.string().trim().max(2000).optional().describe('New description'),
    }),
    example: { templateId: '01a0eeeeeeeeeeeeeeeeeeeeeeeeeeee', title: 'Quick weeknights' },
    handler: async (a, sf) => sf.updateTemplate({ id: a.templateId, title: a.title, description: a.description }),
  }),

  /* ------------------------------------------------------------ sharing */
  defineTool({
    name: 'meal_plan_share_link',
    kind: 'write',
    idempotent: true,
    description: `Generates an invite link for the meal plan and returns it. Nothing is sent to anyone - passing the link on is up to you. medium: ${LINK_MEDIA.join(' | ')} (default copy; qr returns a link meant for a QR code). Whoever opens the link can join the meal plan.`,
    schema: z.object({ medium: z.enum(LINK_MEDIA).default('copy') }),
    example: { medium: 'copy' },
    handler: async (a, sf) => sf.mealPlanShareLink({ medium: a.medium }),
  }),

  /* ------------------------------------------------------------ account */
  defineTool({
    name: 'account_settings_get',
    kind: 'read',
    description:
      'Shows the preferences of the account in a readable form: diets, avoidances, cuisines, cooking level, household, units, body data, nutrition goals, meal planning preferences and notification switches. account_info returns the raw account instead.',
    schema: z.object({}),
    example: {},
    handler: async (_a, sf) => sf.accountSettings(),
  }),
  defineTool({
    name: 'account_settings_update',
    kind: 'update',
    description:
      'Changes preferences of the account. Only the given fields change (field mask); list fields replace the whole list. This affects recommendations and nutrition goals of the real account - use account_settings_get first. nutritionGoals and emailNotifications are merged with the current values.',
    schema: z.object({
        diets: enumList(DIETS, 'Diets').optional(),
        avoidances: enumList(AVOIDANCES, 'Allergens/avoidances').optional(),
        nutritionPreferences: enumList(NUTRITION_PREFS, 'Nutrition preferences').optional(),
        favouriteCuisines: enumList(CUISINES, 'Favourite cuisines').optional(),
        dislikedIngredients: z.array(shortText('ingredient', 100)).max(100).optional().describe('Free-text ingredient names; replaces the list'),
        usageGoals: enumList(USAGE_GOALS, 'Usage goals').optional(),
        cookingLevel: z.enum(['beginner', 'intermediate', 'advanced']).optional(),
        householdAdultCount: z.number().int().min(0).max(50).optional(),
        householdChildCount: z.number().int().min(0).max(50).optional(),
        language: z.string().regex(/^[a-z]{2}(-[A-Z]{2})?$/, 'e.g. de-DE or en-US').optional(),
        country: z.string().regex(/^[A-Z]{2}$/, 'ISO 3166 alpha-2, e.g. DE').optional(),
        gender: z.enum(['male', 'female', 'non_binary', 'undisclosed']).optional(),
        yearOfBirth: z.number().int().min(1900).max(new Date().getFullYear()).optional(),
        height: z.object({ value: z.number().positive().max(300), unit: z.enum(['cm', 'inch']) }).strict().optional(),
        weight: z.object({ value: z.number().positive().max(1000), unit: z.enum(['kg', 'pound']) }).strict().optional(),
        activityLevel: z.enum(['very_light', 'light', 'moderate', 'active', 'very_active']).optional(),
        weeklyMeals: z.number().int().min(0).max(35).optional().describe('Planned meals per week'),
        plannedMeals: z
          .array(z.enum(['breakfast', 'lunch', 'dinner', 'snacks', 'takeout']))
          .max(5)
          .optional()
          .describe('Meal slots you plan: breakfast, lunch, dinner, snacks, takeout'),
        nutritionGoals: z
          .object({
            calorieGoal: z.number().min(500).max(10000).optional().describe('kcal per day'),
            fibreGoal: z.number().min(0).max(500).optional().describe('grams per day'),
            proteinRatio: ratio('Protein share').optional(),
            fatRatio: ratio('Fat share').optional(),
            carbohydrateRatio: ratio('Carbohydrate share').optional(),
          })
          .strict()
          .optional(),
        pushNotifications: z.boolean().optional(),
        emailNotifications: z
          .object({
            recipeRecommendation: z.boolean().optional(),
            productUpdates: z.boolean().optional(),
            promotionalUpdates: z.boolean().optional(),
          })
          .strict()
          .optional(),
    }),
    example: { diets: ['vegetarian'], cookingLevel: 'intermediate', nutritionGoals: { calorieGoal: 2000 } },
    handler: async (a, sf) => sf.updateAccountSettings(a),
  }),
  defineTool({
    name: 'account_usage',
    kind: 'read',
    description:
      'Shows how many uses are left of a limited feature: mealplan_template_collections (curated meal plan templates) or hr_tailored_plan (tailored plan). Returns remaining and, when the quota is exhausted, when it is available again.',
    schema: z.object({ feature: z.enum(['mealplan_template_collections', 'hr_tailored_plan']) }),
    example: { feature: 'mealplan_template_collections' },
    handler: async (a, sf) => sf.accountUsage({ feature: a.feature }),
  }),
];
