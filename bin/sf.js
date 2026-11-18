#!/usr/bin/env node
/**
 * sf - CLI for Samsung Food.
 *
 *   sf login [--open]             log in with the browser session (clipboard, argument or stdin)
 *   sf logout / sf renew          remove the stored token / renew it now
 *   sf whoami                     check account
 *   sf plan [--days 7]            show meal plan
 *   sf plan add <recipeId> --date 2026-09-22 --meal dinner
 *   sf plan rm <mealId>
 *   sf list                       show shopping list
 *   sf list add "2 onions" "milk"
 *   sf list recipe <recipeId>     add recipe ingredients to the list
 *   sf list check <itemId>        check off
 *   sf list rm <itemId>
 *   sf search <query>
 *   sf recipe <recipeId>
 *   sf import <url>               import recipe from a website
 *   sf collections
 *   sf methods [filter]           all API methods
 *   sf describe <method>
 *   sf call <method> '<json>'     raw call (same guard and redaction as the MCP api_call)
 *   sf tools [--json]             all MCP tools with area and access
 *   sf status                     token and schema status
 *   sf schema update              rebuild the API schema
 *   sf serve [--port 8787] [--read-only]   local HTTP API (REST, OpenAPI, MCP over HTTP)
 */

import process from 'node:process';
import { spawn, spawnSync } from 'node:child_process';
import { SamsungFood, MEAL_TIME_LABEL, today } from '../src/client.js';
import { extractToken, looksLikeCredential, clearToken, requireToken, AUTH_FILE } from '../src/auth.js';
import { loginWithCredential, renewToken, authStatus } from '../src/session.js';
import { buildSchema, schemaInfo } from '../src/schema-build.js';
import { VERSION } from '../src/version.js';
import { assertRawCallAllowed, redactSecrets } from '../src/tools/core.js';

/** Options that never take a value, so `--yes <id>` keeps <id> as a positional argument. */
const BOOLEAN_FLAGS = new Set(['yes', 'json', 'open', 'paste', 'dry', 'unscheduled', 'replace', 'read-only', 'allow-raw', 'no-mcp', 'quiet', 'show-key', 'help', 'version']);
/** Options that always take a value (`--name value` or `--name=value`). */
const VALUE_FLAGS = new Set(['days', 'from', 'to', 'date', 'meal', 'recipe', 'list', 'limit', 'title', 'servings', 'seed', 'location', 'depth', 'token', 'host', 'port', 'cors']);

/** Split argv into known --options and positional arguments; `--` ends the options. */
function parseArgs(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--') {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    const key = eq === -1 ? a.slice(2) : a.slice(2, eq);
    if (BOOLEAN_FLAGS.has(key)) {
      if (eq !== -1) throw new Error(`--${key} takes no value`);
      flags[key] = true;
    } else if (VALUE_FLAGS.has(key)) {
      const value = eq === -1 ? args[++i] : a.slice(eq + 1);
      if (value === undefined || value === '' || (eq === -1 && value.startsWith('--'))) throw new Error(`--${key} needs a value, e.g. --${key} <value>`);
      flags[key] = value;
    } else {
      throw new Error(`Unknown option --${key}. Run \`sf help\` for the commands and their options.`);
    }
  }
  return { flags, positional };
}

let flags = {};
let command;
let sub;
let rest = [];

const json = (v) => JSON.stringify(v, null, 2);
const out = (v) => console.log(typeof v === 'string' ? v : json(v));

const APP_URL = 'https://app.samsungfood.com';

/** Positive integer flag, or the default; rejects garbage like --days abc. */
function intFlag(name, def) {
  if (flags[name] === undefined) return def;
  const n = Number(flags[name]);
  if (!Number.isInteger(n) || n < 1) throw new Error(`--${name} must be a positive whole number`);
  return n;
}

/** How many things a command removes, for the confirmation prompt. */
const count = (ids, one, many) => (ids.length === 1 ? `${one} ${ids[0]}` : `${ids.length} ${many}`);

/**
 * Prompt text for commands that delete or overwrite data, or null. Commands without their required
 * arguments return null so the usage error comes first.
 */
function destructiveAction() {
  const removes = sub === 'rm' || sub === 'delete';
  if (command === 'plan') {
    if (removes && rest.length) return `delete ${count(rest, 'meal', 'meals')}`;
    if (sub === 'clear') {
      if (flags.unscheduled) return 'delete ALL unscheduled meals';
      const from = flags.from ?? today();
      return `delete all meals ${flags.to ? `from ${from} to ${flags.to}` : `for ${intFlag('days', 7)} day(s) starting ${from}`}`;
    }
    if (sub === 'template' || sub === 'templates') {
      const [action, ...ids] = rest;
      if ((action === 'rm' || action === 'delete') && ids.length) return `delete ${count(ids, 'template', 'templates')}`;
      if (action === 'apply' && ids.length && flags.replace) {
        return `replace the planned meals starting ${flags.date ?? today()} with template ${ids[0]}`;
      }
    }
  }
  if (command === 'list' && removes && rest.length) return `delete ${count(rest, 'shopping list item', 'shopping list items')}`;
  if (command === 'pantry' && removes && rest.length) return `delete ${count(rest, 'pantry entry', 'pantry entries')}`;
  return null;
}

/** Destructive CLI commands need --yes (or an interactive y/N on a terminal). */
async function confirm(what) {
  if (flags.yes) return;
  if (!process.stdin.isTTY) throw new Error(`Refusing to ${what} without confirmation. Pass --yes.`);
  const { createInterface } = await import('node:readline/promises');
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${what}? [y/N] `);
  rl.close();
  if (!/^y(es)?$/i.test(answer.trim())) throw new Error('Cancelled.');
}

/** Text from the system clipboard, or '' when no clipboard tool is available. */
function readClipboard() {
  const tools =
    process.platform === 'darwin'
      ? [['pbpaste']]
      : process.platform === 'win32'
        ? [['powershell', '-NoProfile', '-Command', 'Get-Clipboard']]
        : [['wl-paste', '-n'], ['xclip', '-selection', 'clipboard', '-o'], ['xsel', '-b', '-o']];
  for (const [cmd, ...args] of tools) {
    const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 3000 });
    if (r.status === 0 && r.stdout) return r.stdout;
  }
  return '';
}

function openBrowser(url) {
  const [cmd, ...args] =
    process.platform === 'darwin'
      ? ['open', url]
      : process.platform === 'win32'
        ? ['cmd', '/c', 'start', '', url]
        : ['xdg-open', url];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // no browser launcher available; the URL is printed anyway
  }
}

const LOGIN_HELP = [
  'No token found. To log in:',
  `  1. Log in at ${APP_URL} (any login method works)`,
  '  2. Open the browser DevTools console and run:  copy(document.cookie)',
  '  3. Run  sf login  again (it reads the clipboard), or  sf login --paste  and paste it into the terminal',
  '',
  'Also accepted: the bare token, "Bearer <token>", or a "Copy as cURL" command.',
].join('\n');

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function fmtPlan(plan, showUnscheduled = false) {
  const lines = [`Meal plan ${plan.from} to ${plan.to}`, ''];
  for (const day of plan.days) {
    const wd = new Date(`${day.date}T12:00:00Z`).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
    const kcal = day.nutrition?.kcal ? ` – ${Math.round(day.nutrition.kcal)} kcal` : '';
    lines.push(`${wd} ${day.date}${kcal}`);
    if (!day.meals.length) lines.push('    (nothing planned)');
    for (const m of day.meals) {
      lines.push(`    ${(MEAL_TIME_LABEL[m.mealTime] ?? '?').padEnd(14)} ${m.title}   [${m.id}]`);
    }
    lines.push('');
  }
  if (plan.unscheduled.length) {
    if (showUnscheduled) {
      lines.push(`Unscheduled (${plan.unscheduled.length}):`);
      for (const m of plan.unscheduled) {
        lines.push(`    ${(MEAL_TIME_LABEL[m.mealTime] ?? '?').padEnd(14)} ${m.title}   [${m.id}]`);
      }
    } else {
      lines.push(`${plan.unscheduled.length} unscheduled meals - show with --unscheduled`);
    }
  }
  return lines.join('\n');
}

function fmtRecipe(r) {
  const name = r.name ?? '(no name)';
  const lines = [name, '='.repeat(name.length), ''];
  if (r.description) lines.push(r.description, '');
  if (r.servings) lines.push(`Servings: ${r.servings}`);
  if (r.cookTime) lines.push(`Cooking time: ${r.cookTime} min`);
  lines.push('', 'Ingredients:');
  for (const i of r.ingredients ?? []) lines.push(`  - ${i}`);
  if (r.instructions?.length) {
    lines.push('', 'Instructions:');
    r.instructions.forEach((s, n) => lines.push(`  ${n + 1}. ${s}`));
  }
  if (r.source?.url) lines.push('', `Source: ${r.source.url}`);
  return lines.join('\n');
}

function fmtPantry(items) {
  if (!items.length) return 'Pantry is empty.';
  const active = items.filter((i) => !i.consumedAt);
  const byLoc = {};
  for (const i of active) (byLoc[i.location ?? 'No location'] ||= []).push(i);
  const lines = [`Pantry (${active.length} entries)`, ''];
  for (const [loc, entries] of Object.entries(byLoc)) {
    lines.push(`  ${loc}`);
    entries.sort((a, b) => (a.daysLeft ?? 9999) - (b.daysLeft ?? 9999));
    for (const i of entries) {
      let hint = '';
      if (i.daysLeft != null) {
        if (i.daysLeft < 0) hint = `  EXPIRED ${-i.daysLeft} d ago`;
        else if (i.daysLeft <= 3) hint = `  only ${i.daysLeft} d left`;
        else hint = `  ${i.expiryDate}`;
      }
      lines.push(`    ${i.name}${hint}   [${i.id}]`);
    }
  }
  const used = items.filter((i) => i.consumedAt);
  if (used.length) lines.push('', `  ${used.length} marked as consumed`);
  return lines.join('\n');
}

function fmtList(list) {
  const open = list.items.filter((i) => !i.checked);
  const done = list.items.filter((i) => i.checked);
  const lines = [`${list.name ?? 'Shopping list'} (${open.length} open, ${done.length} done)`, ''];
  const group = {};
  for (const i of open) (group[i.category ?? 'Other'] ||= []).push(i);
  for (const [cat, items] of Object.entries(group)) {
    lines.push(`  ${cat}`);
    for (const i of items) lines.push(`    [ ] ${i.text ?? i.name}   [${i.id}]`);
  }
  if (done.length) {
    lines.push('', '  Done');
    for (const i of done) lines.push(`    [x] ${i.text ?? i.name}   [${i.id}]`);
  }
  return lines.join('\n');
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  flags = parsed.flags;
  [command, sub, ...rest] = parsed.positional;
  if (flags.version) return out(VERSION);
  if (flags.help && command !== 'serve') command = 'help';

  // ---------------------------------------------------------------- login
  if (command === 'login') {
    if (flags.open) {
      openBrowser(APP_URL);
      console.error(`Opened ${APP_URL}.`);
    }
    // Input order: CLI argument, stdin (--paste or piped), clipboard.
    const arg = [flags.token, sub, ...rest].filter((v) => typeof v === 'string').join(' ');
    if (arg) {
      console.error(
        'Warning: a credential passed on the command line ends up in your shell history. Prefer copying it and running `sf login` (reads the clipboard) or `sf login --paste`.'
      );
    }
    let token = extractToken(arg);
    if (!token && (flags.paste || !process.stdin.isTTY)) {
      if (flags.paste && process.stdin.isTTY) console.error('Paste the cookie string, token or cURL command and finish with Ctrl-D:');
      token = extractToken(await readStdin());
    }
    if (!token) {
      const clip = readClipboard();
      if (looksLikeCredential(clip)) token = extractToken(clip);
    }
    if (!token) {
      console.error(LOGIN_HELP);
      process.exit(1);
    }
    const client = await SamsungFood.create();
    const res = await loginWithCredential(client, token);
    return out(
      `Logged in as ${res.account}.\nToken stored in ${AUTH_FILE}` +
        (res.expiresAt ? `\nValid until ${new Date(res.expiresAt).toLocaleString('en-US')} (renews automatically)` : '')
    );
  }

  if (command === 'logout') {
    clearToken();
    return out(`Token removed from ${AUTH_FILE} (the cached meal plan id is kept).`);
  }

  if (command === 'renew') {
    const client = await SamsungFood.create();
    const { expiresAt } = await renewToken({ codec: client.codec, transport: client.transport, token: requireToken().accessToken });
    return out(`Token renewed, valid until ${new Date(expiresAt).toLocaleString('en-US')}.`);
  }

  if (command === 'schema') {
    if (sub !== 'update') throw new Error('Usage: sf schema update');
    const schema = await buildSchema({ log: (m) => console.error(m) });
    return out(
      `Schema written: ${Object.keys(schema.rpcs).length} RPCs, ${Object.keys(schema.messages).length} messages (${schema.meta.bundles} bundles)`
    );
  }

  if (command === 'serve') {
    const { runServe } = await import('../src/http/serve.js');
    await runServe(flags);
    return;
  }

  if (command === 'auth' || command === 'status') {
    const si = schemaInfo();
    const schema = si
      ? { ...si, builtAt: si.builtAt.toISOString() }
      : 'not built yet - run: sf schema update';
    return out({ file: AUTH_FILE, token: authStatus(), schema });
  }

  if (command === 'tools') {
    const { TOOLS, toolArea, toolAccess } = await import('../src/tools/index.js');
    const rows = TOOLS.map((t) => ({ name: t.name, area: toolArea(t.name), access: toolAccess(t), description: t.description }));
    if (flags.json) return out(rows);
    const width = Math.max(...rows.map((r) => r.name.length));
    const lines = [`${rows.length} tools`];
    for (const area of [...new Set(rows.map((r) => r.area))]) {
      lines.push('', area);
      for (const r of rows.filter((x) => x.area === area)) lines.push(`  ${r.name.padEnd(width)}  ${r.access}`);
    }
    return out(lines.join('\n'));
  }

  // Guards that must run before any network access: raw-call blocklist and confirmations.
  if (command === 'call' && sub) assertRawCallAllowed(sub);
  const action = destructiveAction();
  if (action) await confirm(action);

  // Everything below needs a token.
  // No command: print the help text without touching the network.
  // Unknown commands print the help text without any network access.
  const COMMANDS = ['whoami', 'plan', 'list', 'search', 'recipe', 'import', 'discover', 'storage', 'collections', 'pantry', 'methods', 'describe', 'call'];
  const sf = COMMANDS.includes(command) ? await SamsungFood.create() : null;

  switch (command) {
    case 'whoami': {
      const me = await sf.me();
      const info = {
        id: me.id,
        name: [me.settings?.firstName, me.settings?.lastName].filter(Boolean).join(' '),
        language: me.settings?.language,
        country: me.settings?.country,
        calorieGoal: me.settings?.nutritionGoals?.calorieGoal ?? null,
      };
      if (flags.json) return out(info);
      return out(
        [
          `Account       ${info.id}`,
          `Name          ${info.name || '-'}`,
          `Language      ${info.language ?? '-'}`,
          `Country       ${info.country ?? '-'}`,
          `Calorie goal  ${info.calorieGoal ?? '-'}`,
        ].join('\n')
      );
    }

    case 'plan': {
      if (sub === 'add') {
        const recipeId = rest[0] ?? flags.recipe;
        if (!recipeId) throw new Error('Usage: sf plan add <recipeId> --date 2026-09-22 --meal dinner');
        const created = await sf.addMeal({
          recipeId,
          date: flags.date ?? today(),
          mealTime: flags.meal ?? 'dinner',
        });
        return out(created);
      }
      if (sub === 'rm' || sub === 'delete') {
        if (!rest.length) throw new Error('Usage: sf plan rm <mealId> [<mealId> …]');
        return out(await sf.deleteMeal(rest));
      }
      if (sub === 'move') {
        const [mealId] = rest;
        if (!mealId || typeof flags.meal !== 'string') {
          throw new Error('Usage: sf plan move <mealId> --meal dinner [--date 2026-09-23]  (omit --date to unschedule)');
        }
        return out(await sf.moveMeal({ mealId, date: flags.date, mealTime: flags.meal }));
      }
      if (sub === 'clear') {
        if (flags.unscheduled) return out(await sf.clearUnscheduled());
        return out(await sf.clearWeek({ from: flags.from ?? today(), days: intFlag('days', 7), to: flags.to }));
      }
      if (sub === 'again' || sub === 'previously') {
        const prev = await sf.previouslyPlanned({ limit: intFlag('limit', 30) });
        if (flags.json) return out(prev);
        return out(prev.map((p) => `  ${p.title}\n      ${p.recipeId ?? '(no recipe)'}`).join('\n'));
      }
      if (sub === 'template' || sub === 'templates') {
        const action = rest[0];
        if (action === 'save') {
          if (!flags.title) throw new Error('Usage: sf plan template save --title "Week 39" [--from … --days 7]');
          return out(
            await sf.saveWeekAsTemplate({
              title: String(flags.title),
              from: typeof flags.from === 'string' ? flags.from : today(),
              days: intFlag('days', 7),
              to: typeof flags.to === 'string' ? flags.to : undefined,
            })
          );
        }
        if (action === 'apply') {
          const [, templateId] = rest;
          if (!templateId) throw new Error('Usage: sf plan template apply <templateId> --date 2026-10-05');
          const plan = await sf.applyTemplate(templateId, {
            startDate: typeof flags.date === 'string' ? flags.date : today(),
            replace: Boolean(flags.replace),
            days: intFlag('days', undefined),
          });
          return out(flags.json ? plan : fmtPlan(plan));
        }
        if (action === 'rm' || action === 'delete') {
          if (rest.length < 2) throw new Error('Usage: sf plan template rm <templateId> [<templateId> …]');
          return out(await sf.deleteTemplates(rest.slice(1)));
        }
        if (action) {
          const t = await sf.template(action);
          if (flags.json) return out(t);
          const lines = [`${t.title}  (${t.days.length} days)`, ''];
          for (const d of t.days) {
            lines.push(`  Day ${d.orderDay}`);
            for (const m of d.meals) {
              lines.push(`    ${(m.mealTimeLabel ?? '?').padEnd(14)} ${m.title ?? m.recipeId}`);
            }
          }
          return out(lines.join('\n'));
        }
        const list = await sf.templates();
        if (flags.json) return out(list);
        return out(list.map((t) => `  ${t.title}\n      ${t.id}`).join('\n') || 'No custom templates.');
      }
      const plan = await sf.schedule({
        from: typeof flags.from === 'string' ? flags.from : today(),
        days: intFlag('days', 7),
        to: typeof flags.to === 'string' ? flags.to : undefined,
      });
      return out(flags.json ? plan : fmtPlan(plan, Boolean(flags.unscheduled)));
    }

    case 'list': {
      if (sub === 'add') {
        if (!rest.length) throw new Error('Usage: sf list add "2 onions" "milk"');
        return out(await sf.addListItems(rest, { listId: flags.list }));
      }
      if (sub === 'recipe') {
        const [recipeId] = rest;
        if (!recipeId) throw new Error('Usage: sf list recipe <recipeId>');
        return out(
          await sf.addRecipeToList(recipeId, {
            listId: flags.list,
            servings: intFlag('servings', undefined),
          })
        );
      }
      if (sub === 'check' || sub === 'uncheck') {
        if (!rest.length) throw new Error(`Usage: sf list ${sub} <itemId> [<itemId> …]`);
        return out(await sf.checkListItems(rest, sub === 'check', { listId: flags.list }));
      }
      if (sub === 'rm' || sub === 'delete') {
        if (!rest.length) throw new Error('Usage: sf list rm <itemId> [<itemId> …]');
        return out(await sf.deleteListItems(rest, { listId: flags.list }));
      }
      if (sub === 'all') {
        const lists = await sf.lists();
        if (flags.json) return out(lists);
        return out(
          lists
            .map((l) => `  ${l.name ?? '(no name)'}${l.isPrimary ? ' (primary)' : ''}${l.itemCount == null ? '' : `, ${l.itemCount} items`}${l.role ? `, ${l.role}` : ''}\n      ${l.id}`)
            .join('\n') || 'No shopping lists.'
        );
      }
      const list = await sf.listItems(typeof flags.list === 'string' ? flags.list : undefined);
      return out(flags.json ? list : fmtList(list));
    }

    case 'search': {
      const q = [sub, ...rest].filter(Boolean).join(' ');
      const res = await sf.searchRecipes(q, { limit: intFlag('limit', 20) });
      if (flags.json) return out(res);
      const lines = [`${res.totalCount ?? res.recipes.length} results for "${q}"`, ''];
      for (const r of res.recipes) {
        lines.push(`  ${r.name}`);
        lines.push(`      ${r.id}${r.rating ? `  ★ ${r.rating.toFixed(1)}` : ''}${r.source?.name ? `  ${r.source.name}` : ''}`);
      }
      return out(lines.join('\n'));
    }

    case 'recipe': {
      const id = sub;
      if (!id) throw new Error('Usage: sf recipe <recipeId>');
      const r = await sf.recipe(id);
      return out(flags.json ? r : fmtRecipe(r));
    }

    case 'import': {
      const url = sub;
      if (!url) throw new Error('Usage: sf import <url>');
      if (flags.dry) {
        const res = await sf.extractRecipe(url);
        if (flags.json) return out(res);
        if (res.status !== 'ok' || !res.recipe) return out(`Only partially parsed (${res.status}); see --json for the raw result.`);
        return out(fmtRecipe(res.recipe));
      }
      const saved = await sf.importRecipe(url);
      return out(flags.json ? saved : `Imported "${saved.name}"   [${saved.id}]`);
    }

    case 'discover': {
      const recipes = await sf.popularRecipes({
        limit: intFlag('limit', 20),
        seed: intFlag('seed', undefined),
      });
      if (flags.json) return out(recipes);
      return out(recipes.map((r) => `  ${r.name}\n      ${r.id}${r.source?.name ? `  ${r.source.name}` : ''}`).join('\n'));
    }

    case 'storage': {
      const name = [sub, ...rest].filter(Boolean).join(' ');
      if (!name) throw new Error('Usage: sf storage "chicken breast"');
      const info = await sf.storageFor(name);
      if (!info) return out(`"${name}" is not in the food graph.`);
      if (flags.json) return out(info);
      const lines = [`${info.product}  (${info.category})`, ''];
      for (const [loc, o] of Object.entries(info.options)) {
        const mark = loc === info.suggestedLocation ? ' ←  default' : '';
        lines.push(`  ${o.label.padEnd(16)} ${String(o.days).padStart(4)} days   (${o.min}–${o.max} ${o.metric})${mark}`);
      }
      if (info.ambiguous) lines.push('', '  Multiple storage locations - Samsung Food does not set an expiry date on its own here.');
      if (info.warning) lines.push('', `  ${info.warning}`);
      return out(lines.join('\n'));
    }

    case 'collections': {
      const list = await sf.collections();
      if (flags.json) return out(list);
      if (!list.length) return out('No collections.');
      return out(list.map((c) => `  ${c.name ?? '(no name)'}${c.recipeCount == null ? '' : ` (${c.recipeCount} recipes)`}\n      ${c.id}`).join('\n'));
    }

    case 'pantry': {
      if (sub === 'add') {
        if (!rest.length) throw new Error('Usage: sf pantry add "chicken breast" --location freezer');
        const items = await sf.addPantryItems(rest, {
          location: typeof flags.location === 'string' ? flags.location : undefined,
        });
        if (flags.json) return out(items);
        return out(
          items
            .map((i) => {
              const warn = i.warning
                ? `\n      ${i.warning}`
                : !i.expiryDate && i.storage?.ambiguous
                  ? `\n      no expiry date - specify a location: ${Object.entries(i.storage.options)
                      .map(([k, v]) => `--location ${k} (${v.days} d)`)
                      .join(' | ')}`
                  : '';
              return `  ${i.name} → ${i.location ?? '?'}${i.expiryDate ? `, expires ${i.expiryDate}` : ''}   [${i.id}]${warn}`;
            })
            .join('\n')
        );
      }
      if (sub === 'move') {
        const [id] = rest;
        if (!id || !flags.location) throw new Error('Usage: sf pantry move <itemId> --location freezer');
        return out(await sf.updatePantryItem({ id, location: flags.location, ...(flags.date ? { expiryDate: flags.date } : {}) }));
      }
      if (sub === 'rm' || sub === 'delete') {
        if (!rest.length) throw new Error('Usage: sf pantry rm <itemId> [<itemId> …]');
        return out(await sf.deletePantryItems(rest));
      }
      if (['use', 'consume', 'unuse'].includes(sub) && !rest.length) {
        throw new Error(`Usage: sf pantry ${sub} <itemId> [<itemId> …]`);
      }
      if (sub === 'use' || sub === 'consume') {
        return out(await sf.consumePantryItems(rest));
      }
      if (sub === 'unuse') {
        return out(await sf.consumePantryItems(rest, { undo: true }));
      }
      if (sub === 'expiry') {
        const [id] = rest;
        if (!id || !flags.date) throw new Error('Usage: sf pantry expiry <itemId> --date 2026-12-24');
        return out(await sf.updatePantryItem({ id, expiryDate: flags.date }));
      }
      const items = await sf.pantry();
      return out(flags.json ? items : fmtPantry(items));
    }

    case 'methods':
      return out(sf.methods(sub).join('\n'));

    case 'describe':
      if (!sub) throw new Error('Usage: sf describe <method>');
      return out(sf.describe(sub, intFlag('depth', 3)));

    case 'call': {
      if (!sub) throw new Error("Usage: sf call <method> '<json>'");
      let body = {};
      if (rest[0]) {
        try {
          body = JSON.parse(rest[0]);
        } catch {
          throw new Error(`The request body must be JSON, e.g. sf call ${sub} '{}'`);
        }
      }
      return out(redactSecrets(await sf.call(sub, body), sub));
    }

    default:
      if (command && command !== 'help') {
        console.error(`Unknown command: ${command}\n`);
        process.exitCode = 1;
      }
      console.log(
        [
          'sf - Samsung Food CLI',
          '',
          '  sf login [--open]                log in (reads the clipboard; see README)',
          '  sf logout                        remove the stored token',
          '  sf renew                         renew the token now (normally automatic)',
          '  sf status                        token and schema status',
          '  sf whoami                        account',
          '  sf schema update                 rebuild the API schema from the web app',
          '',
          '  sf plan [--days 7] [--from …]    Meal plan',
          '  sf plan add <recipeId> --date 2026-09-22 --meal dinner',
          '  sf plan move <mealId> --date … --meal …',
          '  sf plan rm <mealId>',
          '  sf plan clear [--from … --days 7] [--unscheduled]',
          '  sf plan again                    previously planned meals',
          '  sf plan templates                your weekly templates',
          '  sf plan template save --title "Week 39" [--from … --days 7]',
          '  sf plan template apply <id> --date 2026-10-05 [--replace]',
          '  sf plan template <id>            view template',
          '',
          '  sf list                          Shopping list',
          '  sf list add "2 onions" "milk"',
          '  sf list recipe <recipeId>        add recipe ingredients',
          '  sf list check|rm <itemId>',
          '  sf list all                      all lists',
          '',
          '  sf search <query>                search your own recipes',
          '  sf discover [--limit 20]         suggestions from the catalog',
          '  sf recipe <recipeId>             show recipe',
          '  sf import <url> [--dry]          import a recipe from a website',
          '  sf collections                   collections',
          '  sf pantry                        pantry by storage location',
          '  sf pantry add "chicken breast" --location freezer',
          '  sf pantry move <id> --location freezer',
          '  sf storage "chicken breast"       look up storage locations and shelf life',
          '  sf pantry expiry <id> --date …   correct expiry date',
          '  sf pantry use|unuse|rm <id>      consume / undo / delete',
          '',
          '  sf methods [filter]              all API methods',
          '  sf describe <method>            signature',
          "  sf call <method> '<json>'       raw call (credential methods blocked, secrets redacted)",
          '  sf tools [--json]                all MCP tools: area and read-only / write / destructive',
          '',
          '  sf serve [--host 127.0.0.1] [--port 8787] [--read-only] [--allow-raw] [--cors <origin>]',
          '                                   local HTTP API: /v1/tools, /openapi.json, /docs, /mcp',
          '  sf serve --show-key              print the API key',
          '',
          'Commands that show data print formatted text; add --json for the raw JSON. Most write commands print their JSON result.',
          'Commands that delete or overwrite data ask first; pass --yes to skip the question (required without a terminal).',
          '',
          '  sf --version                     print the version',
        ].join('\n')
      );
  }
}

main().catch((err) => {
  console.error(`Error: ${err.message}`);
  process.exit(1);
});
