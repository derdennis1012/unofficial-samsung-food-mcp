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
