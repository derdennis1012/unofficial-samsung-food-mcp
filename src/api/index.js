/**
 * Installs the area method files onto the SamsungFood client class.
 * Each file exports `methods`: an object of async functions that use `this.call(...)`.
 */

import { SamsungFood } from '../core/client.js';
import { methods as lists } from './lists.js';
import { methods as mealplan } from './mealplan.js';
import { methods as recipes } from './recipes.js';
import { methods as food } from './food.js';

for (const m of [lists, mealplan, recipes, food]) {
  for (const name of Object.keys(m)) {
    if (name in SamsungFood.prototype) throw new Error(`client method ${name} is defined twice`);
  }
  Object.assign(SamsungFood.prototype, m);
}
