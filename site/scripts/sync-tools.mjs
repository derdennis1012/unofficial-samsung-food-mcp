// Regenerates src/data/tools.json from the real tool definitions in ../src/tools.
// Needs the root package's dependencies (run `npm install` in the repo root once).
// The generated file is committed, so the site build itself does not need them.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const { TOOLS } = await import('../../src/tools/index.js');

const AREAS = [
  ['templates', 'Weekly templates', (n) => /^meal_plan_(templates|template_list|save_template|template_update|apply_template|delete_template)$/.test(n)],
  ['mealplan', 'Meal plan', (n) => n.startsWith('meal_plan_')],
  ['lists', 'Shopping lists', (n) => n.startsWith('shopping_list')],
  ['recipes', 'Recipes', (n) => n.startsWith('recipe_')],
  ['collections', 'Collections', (n) => n.startsWith('collection')],
  ['pantry', 'Pantry', (n) => n.startsWith('pantry_')],
  ['food', 'Food and nutrition', (n) => /^(food_|foodlog_|nutrition_)/.test(n)],
  ['account', 'Account', (n) => /^(account_|auth_)/.test(n)],
  ['raw', 'Raw API access', (n) => n.startsWith('api_')],
];

const firstSentence = (s) => {
  const m = s.match(/^(.+?[.!?])(\s|$)/);
  return (m ? m[1] : s).replace(/\s+/g, ' ').trim();
};

const kindOf = (a) => (a.readOnlyHint ? 'read' : a.destructiveHint ? 'destructive' : 'write');

const areas = AREAS.map(([id, label]) => ({ id, label, tools: [] }));
for (const t of TOOLS) {
  const idx = AREAS.findIndex(([, , test]) => test(t.name));
  if (idx < 0) throw new Error(`no area for ${t.name}`);
  areas[idx].tools.push({ name: t.name, kind: kindOf(t.annotations), idempotent: t.annotations.idempotentHint, summary: firstSentence(t.description) });
}

const totals = { all: TOOLS.length, read: 0, write: 0, destructive: 0 };
for (const t of TOOLS) totals[kindOf(t.annotations)]++;

const ORDER = ['mealplan', 'templates', 'lists', 'recipes', 'collections', 'pantry', 'food', 'account', 'raw'];
areas.sort((a, b) => ORDER.indexOf(a.id) - ORDER.indexOf(b.id));

const out = fileURLToPath(new URL('../src/data/tools.json', import.meta.url));
fs.writeFileSync(out, JSON.stringify({ generatedFrom: 'src/tools/*.js', totals, areas }, null, 2) + '\n');
console.log(`tools.json: ${totals.all} tools (${totals.read} read, ${totals.write} write, ${totals.destructive} destructive)`);
for (const a of areas) console.log(`  ${a.label}: ${a.tools.length}`);
