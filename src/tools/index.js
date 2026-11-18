/** All tool definitions, assembled from the area files. */

import '../api/index.js';
import { coreTools } from './core.js';
import { tools as lists } from './lists.js';
import { tools as mealplan } from './mealplan.js';
import { tools as recipes } from './recipes.js';
import { tools as food } from './food.js';

export const TOOLS = [...coreTools, ...lists, ...mealplan, ...recipes, ...food];

const seen = new Set();
for (const t of TOOLS) {
  if (seen.has(t.name)) throw new Error(`duplicate tool name: ${t.name}`);
  seen.add(t.name);
}

/** [heading, predicate] in matching order; the first match wins. Used by `sf tools` and docs/tools.md. */
export const TOOL_AREAS = [
  ['Weekly templates', (n) => /^meal_plan_(templates|template_|save_template|apply_template|delete_template)/.test(n)],
  ['Meal plan', (n) => n.startsWith('meal_plan_')],
  ['Shopping lists', (n) => n.startsWith('shopping_list')],
  ['Recipes', (n) => n.startsWith('recipe_')],
  ['Collections', (n) => n.startsWith('collection')],
  ['Pantry', (n) => n.startsWith('pantry_')],
  ['Food and nutrition', (n) => /^(food_|nutrition_|foodlog_)/.test(n)],
  ['Account and login', (n) => /^(account_|auth_)/.test(n)],
  ['Raw API access', (n) => n.startsWith('api_')],
];

/** Area heading of a tool name. */
export function toolArea(name) {
  const area = TOOL_AREAS.find(([, test]) => test(name));
  if (!area) throw new Error(`tool ${name} matches no area; add one to TOOL_AREAS`);
  return area[0];
}

/** 'read-only' | 'write' | 'destructive', from the MCP annotations. */
export function toolAccess(t) {
  if (t.annotations.readOnlyHint) return 'read-only';
  return t.annotations.destructiveHint ? 'destructive' : 'write';
}
