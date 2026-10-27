/**
 * Live test runner (opt-in): npm run test:live   (or SAMSUNG_FOOD_LIVE=1 node test/live/run.js)
 *
 * Opt-in extras (off by default because they touch things beyond throwaway objects):
 *   SAMSUNG_FOOD_LIVE_SHARE=1    generate real share links (meal plan, shopping list, collection)
 *   SAMSUNG_FOOD_LIVE_PRIMARY=1  briefly switch the primary shopping list to a temp list (restored in finally)
 *
 *   node test/live/run.js              read-only sweep + write tests on throwaway objects
 *   node test/live/run.js --cleanup    only remove leftover "mcp-test-" objects
 *   node test/live/run.js --area lists limit the write tests to one area
 *
 * Area modules (test/live/<area>.js) export:
 *   readSamples(ctx) -> { toolName: args }   arguments for each read-only tool of the area
 *   run(ctx)                                  write tests (throwaway objects only)
 *   cleanup(ctx) -> number                    removes leftovers, returns how many it removed
 */

import { startMcp } from './harness.js';
import { recent, restoreRecent } from './recipes.js';

if (process.argv.includes('--live')) process.env.SAMSUNG_FOOD_LIVE = '1';
if (process.env.SAMSUNG_FOOD_LIVE !== '1') {
  console.log('Live tests are opt-in. Run with --live or SAMSUNG_FOOD_LIVE=1 (uses the token in the config dir).');
  process.exit(0);
}

const AREAS = ['core', 'lists', 'mealplan', 'recipes', 'food'];
const argv = process.argv.slice(2);
const cleanupOnly = argv.includes('--cleanup');
const only = argv.includes('--area') ? argv[argv.indexOf('--area') + 1] : null;
const areas = only ? [only] : AREAS;

const mods = {};
for (const a of areas) mods[a] = await import(`./${a}.js`).catch(() => ({}));

const { ctx, close } = await startMcp();
let failures = 0;
const fail = (what, err) => {
  failures++;
  console.log(`  FAIL ${what}: ${err.message}`);
};

try {
  if (!cleanupOnly) {
    console.log('== read-only sweep');
    // recipe_search registers its term in the account's last-5 recent searches; put them back afterwards
    const recentBefore = await recent(ctx);
    const samples = {};
    for (const a of areas) {
      try {
        Object.assign(samples, (await mods[a].readSamples?.(ctx)) ?? {});
      } catch (err) {
        fail(`${a}.readSamples`, err);
      }
    }
    const skips = Object.assign({}, ...areas.map((a) => mods[a].readSkip ?? {}));
    const tools = await ctx.tools();
    const reads = tools.filter((t) => t.annotations?.readOnlyHint === true);
    let ok = 0;
    for (const t of reads) {
      if (skips[t.name]) {
        console.log(`  skip ${t.name}: ${skips[t.name]}`);
        continue;
      }
      if (only && !(t.name in samples)) continue;
      if (!(t.name in samples)) {
        fail(t.name, new Error('no sample arguments in any test/live/<area>.js readSamples()'));
        continue;
      }
      const r = await ctx.raw(t.name, samples[t.name]);
      if (r.isError) fail(t.name, new Error(r.text.slice(0, 300)));
      else {
        ok++;
        console.log(`  ok   ${t.name}`);
      }
    }
    console.log(`  ${ok}/${reads.length} read-only tools succeeded`);
    await restoreRecent(ctx, recentBefore).catch((e) => console.log(`  could not restore recent searches: ${e.message}`));

    for (const a of areas) {
      if (!mods[a].run) continue;
      console.log(`== write tests: ${a}`);
      try {
        await mods[a].run(ctx);
        console.log(`  ok   ${a}`);
      } catch (err) {
        fail(a, err);
      } finally {
        try {
          const n = await mods[a].cleanup?.(ctx);
          if (n) console.log(`  cleanup(${a}): removed ${n} object(s)`);
        } catch (err) {
          fail(`${a}.cleanup`, err);
        }
      }
    }
  } else {
    let total = 0;
    for (const a of areas) {
      try {
        const n = (await mods[a].cleanup?.(ctx)) ?? 0;
        console.log(`  ${a}: removed ${n} leftover object(s)`);
        total += n;
      } catch (err) {
        fail(`${a}.cleanup`, err);
      }
    }
    console.log(`Leftovers removed: ${total}`);
  }
} finally {
  await close();
}
console.log(failures ? `\n${failures} failure(s)` : '\nAll live checks passed');
process.exit(failures ? 1 : 0);
