/**
 * Library entry point (`import { SamsungFood } from 'unofficial-samsung-food-mcp'`).
 *
 * client.js defines the class with the core methods; ./api/index.js installs the remaining area
 * methods (createShoppingList, updateRecipe, foodSearch, ...) onto its prototype. The api modules
 * import client.js themselves, and client.js imports none of them, so loading ./api/index.js first
 * evaluates client.js completely before any method is installed: no cycle, no TDZ.
 */

import './api/index.js';

export * from './core/client.js';
