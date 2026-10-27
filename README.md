# samsung-food-mcp — unofficial MCP server and CLI for Samsung Food

> **Disclaimer.** This project is unofficial. It is not affiliated with,
> endorsed by, or supported by Samsung or Whisk. "Samsung Food" is a trademark
> of its owner. It talks to a private, undocumented API that can change or
> break at any time. Using it may violate Samsung Food's Terms of Service and
> could get your account restricted. Use it at your own risk. Write tools
> modify real data in your account, including shared lists and meal plans.

A local client, MCP server and command line tool (`sf`) for **Samsung Food**
(formerly Whisk): meal plan, shopping list, recipes and pantry without the web app.

Samsung Food has no public API. The web app speaks gRPC-Web to
`app.samsungfood.com/api/grpc-web/`. This project encodes and decodes those
calls with a schema-driven protobuf codec, so it needs neither `protoc` nor
`.proto` files.

**The Samsung protocol schema and food graph are not distributed with this repository.** (The only
Samsung-derived material in the repo is the list of RPC method names and a tiny set of field names with
arbitrary numbers in `test/`, used so the offline tests run without network.) On first use,
two things are fetched from Samsung's public web app and CDN onto your own
machine and cached in the config directory (`~/.samsung-food`, or
`$SAMSUNG_FOOD_HOME`):

- the **protocol schema** (`schema.json`), derived by scanning the web app's
  public JavaScript bundles as plain text (they are never executed). Refresh
  it with `sf schema update`.
- the **food graph** (`foodgraph-<locale>.json`), the public shelf-life data
  from `cdn.whisk.com/autocomplete/v1/<locale>/all.json`, refreshed after 30 days.

Protocol details: [`docs/api.md`](docs/api.md)

## Setup

Requires Node.js 20 or newer.

```bash
git clone https://github.com/derdennis1012/samsung-food-mcp.git
cd samsung-food-mcp
npm install
node bin/sf.js status                           # run the CLI directly ...
npm link                                        # ... or install the `sf` and `samsung-food-mcp` commands
```

In the examples below `sf` stands for `node bin/sf.js` (or the linked `sf` command).

Samsung Food authenticates with `Authorization: Bearer <token>`. The login
itself runs on a separate domain with a captcha and social logins, so this tool
does not log in by itself. It takes over your **browser session** instead, which
works with every login method (Google, Apple, e-mail, ...):

1. Log in at [app.samsungfood.com](https://app.samsungfood.com)
   (`sf login --open` opens it for you)
2. Open the browser DevTools console and run `copy(document.cookie)`
3. Run:
   ```bash
   sf login
   ```
   It reads the clipboard. Alternatively pass the text yourself
   (`sf login "<paste>"`, or pipe it in with `sf login --paste`). Accepted
   input: the full cookie string (the token is the `whisk.USER_TOKEN` cookie),
   the bare token, `Bearer <token>`, an `Authorization` header line, or a
   "Copy as cURL" command.

`sf login` checks the token with `GetMe`, shows the account name, renews it
once to learn the expiry, and stores everything in `~/.samsung-food/auth.json`
(chmod 600, written atomically).

**Tokens last 14 days and renew automatically.** Before an API call, if the
expiry is unknown or less than 7 days away, the tool trades the current token
for a new one (`AuthAPI/IssueAuthCode` + `UseAuthCode` on `login.whisk.com`).
As long as you use the CLI or MCP server at least about every two weeks you
never need to log in again; after a longer break run `sf login` again. If a
renewal fails but the token still works, the call goes ahead with a warning
on stderr. Note that every renewal creates a new session on your account.

```bash
sf login [--open]        # log in (see above)
sf status                # token present, expiry, days left, last renewal, schema
sf renew                 # renew now (normally automatic)
sf logout                # remove the token; cached list/meal plan ids stay
sf whoami                # check the account
sf schema update         # rebuild the protocol schema
```

The schema is built automatically the first time it is needed.

With the MCP server you can log in from the chat: the `auth_login` tool takes
the same cookie string / token / cURL text (treat it as a secret, it grants
full access to the account), and `auth_status` shows the state without
revealing the token.

### Configuration

| Variable | Meaning | Default |
|---|---|---|
| `SAMSUNG_FOOD_HOME` | config and cache directory | `~/.samsung-food` |
| `SAMSUNG_FOOD_TOKEN` | bearer token, overrides `auth.json` | unset |
| `SAMSUNG_FOOD_LOCALE` | locale for requests and the food graph, e.g. `de-DE` | `en-US` |
| `SAMSUNG_FOOD_TIMEOUT_MS` | per-request timeout | `20000` |
| `SAMSUNG_FOOD_RETRIES` | retries for transient failures | `3` |
| `SAMSUNG_FOOD_APP_VERSION` | value of the `x-whisk-app-version` header | `2.88.0` |

## CLI

```bash
sf plan --days 7                        # meal plan
sf plan add <recipeId> --date 2026-09-22 --meal dinner
sf plan move <mealId> --date 2026-09-23 --meal lunch
sf plan rm <mealId>
sf plan clear [--from … --days 7] [--unscheduled] --yes   # asks (or needs --yes) before deleting
sf plan again                           # meals planned before

sf plan templates                       # your weekly templates
sf plan template save --title "Week 39" --from 2026-09-22 --days 7
sf plan template apply <id> --date 2026-10-05 [--replace]
sf plan template <id>                   # show a template

sf list                                 # shopping list, grouped by category
sf list add "2 onions" "500 g flour"
sf list recipe <recipeId>               # add all ingredients of a recipe
sf list check <itemId>
sf list all                             # all (including shared) lists

sf search "pumpkin soup"                # your saved recipes
sf discover --limit 20                  # suggestions from the catalog
sf recipe <recipeId>
sf import https://example.com/recipe    # scrape a website and save the recipe
sf import <url> --dry                   # parse only, do not save
sf collections

sf pantry                               # pantry by location, EXPIRED flagged
sf pantry add "chicken breast" --location freezer
sf pantry move <itemId> --location freezer
sf pantry expiry <itemId> --date 2026-12-24
sf pantry use|unuse|rm <itemId>
sf storage "chicken breast"             # look up storage locations and shelf life
```

Everything without a dedicated command is reachable through the raw API:

```bash
sf methods Community                    # filter methods
sf describe whisk.x.list.v1.ListAPI/SyncItems
sf call whisk.x.list.v1.ListAPI/GetLists '{}'
```

Every command accepts `--json` for unformatted output.

## MCP server

Add this to the MCP configuration of your client (use the absolute path of
your checkout, or `npx` if you installed the package from a registry):

```jsonc
{
  "mcpServers": {
    "samsung-food": {
      "command": "node",
      "args": ["/path/to/samsung-food-mcp/src/index.js"],
      "env": { "SAMSUNG_FOOD_LOCALE": "en-US" }
    }
  }
}
```

About 90 tools (`sf` and the MCP server list the exact set). `+` = changes data, `*` = can delete or overwrite data (MCP `destructiveHint`);
everything else is read-only. Every tool carries MCP annotations (`readOnlyHint`,
`destructiveHint`, `idempotentHint`), validates its input strictly (IDs, `YYYY-MM-DD`
dates, enums, array sizes) and returns text plus `structuredContent`. Long lists take
`limit` (and `offset` where the data can be long, e.g. `pantry_get`); oversized output
is truncated with a hint instead of flooding the context.

| Area | Tools |
|---|---|
| Meal plan | `meal_plan_get`, `meal_plan_add`+, `meal_plan_move`+, `meal_plan_remove`*, `meal_plan_clear`*, `meal_plan_previously_planned`, `meal_plan_meal_update`+ (mark a meal as eaten / change a food amount), `meal_plan_note_add`+, `meal_plan_note_update`+, `meal_plan_note_delete`*, `meal_plan_note_undelete`+, `meal_plan_settings_get`, `meal_plan_settings_update`+, `meal_plan_share_link`+ |
| Weekly templates | `meal_plan_templates`, `meal_plan_template_list` (curated public templates), `meal_plan_save_template`+, `meal_plan_template_update`+, `meal_plan_apply_template`+, `meal_plan_delete_template`* |
| Shopping lists | `shopping_lists`, `shopping_list_get`, `shopping_list_add`+, `shopping_list_add_recipe`+, `shopping_list_update`* (check / uncheck / delete items), `shopping_list_create`+, `shopping_list_rename`+, `shopping_list_copy`+, `shopping_list_delete`*, `shopping_list_set_primary`+, `shopping_list_recent_items`, `shopping_list_favorites`, `shopping_list_favorites_modify`*, `shopping_list_share_link`+ |
| Recipes | `recipe_search`, `recipe_discover`, `recipe_recommended`, `recipe_get`, `recipe_similar`, `recipe_more_from_user`, `recipe_autocomplete`, `recipe_categories`, `recipe_smart_collection`, `recipe_health_recommend`, `recipe_health_alternatives`, `recipe_dish_lookup`, `recipe_recent_queries`, `recipe_recent_query_delete`*, `recipe_import_url`+, `recipe_create`+, `recipe_update`+, `recipe_delete`*, `recipe_rate`+, `recipe_review_post`+, `recipe_review_get`, `recipe_review_delete`* |
| Collections | `collections_list`, `collection_get`, `collection_recipes`, `collection_create`+, `collection_update`+, `collection_copy`+, `collection_delete`*, `collection_add_recipes`+, `collection_remove_recipes`*, `collection_share_link`+ |
| Pantry | `pantry_get`, `pantry_add`+, `pantry_update`+, `pantry_consume`* (consume / unconsume / delete) |
| Food and nutrition | `food_storage_info`, `food_search`, `food_get`, `food_autocomplete`, `food_product_search`, `food_product_get`, `food_product_popular`, `nutrition_analyze` (parse free-text ingredients), `foodlog_add_from_meal_plan`+, `foodlog_delete`* |
| Account | `account_info`, `account_settings_get`, `account_settings_update`+, `account_usage`, `auth_status`, `auth_login`+ |
| Raw access | `api_methods`, `api_describe`, `api_call`* |

**Deliberately not covered by dedicated tools** (still reachable through
`api_methods` / `api_describe` / `api_call`): community and posts, public profiles
(follow, report), payments and rewards, cart and retailer checkout, authentication and
account changes (e-mail, password, phone, delete account), experimentation, the
product directory, and every "send link to someone" method (the share-link tools only
generate a link).

### Weekly templates

`orderDay` in a template is the **offset from the start date**, not a date. If
a week is saved starting on a day without meals, the template starts at day 1
accordingly; set `from` to the first day that has meals.

## As a library

```js
import { SamsungFood } from './src/client.js';

const sf = await SamsungFood.create();   // builds the schema on first use
const plan = await sf.schedule({ from: '2026-09-21', days: 7 });           // read-only
const pantry = await sf.pantry({ includeConsumed: false });                  // read-only
// writes change your real account:
// await sf.addMeal({ recipeId: '<recipeId>', date: '2026-09-23', mealTime: 'dinner' });
// await sf.addRecipeToList('<recipeId>', { servings: 4 });

// raw access to any RPC method
const items = await sf.call('whisk.x.foodlist.v1.FoodlistAPI/GetItems', {
  mask: { paths: ['name', 'expiry_date'] },
  filters: { presence: [1] },
});
```

## Layout

```
src/schema-build.js       builds the protocol schema from the public web app bundles
src/proto.js              schema-driven protobuf codec (no protoc)
src/grpc.js               gRPC-Web transport (framing, trailers, status codes)
src/client.js             high-level operations
src/auth.js               token storage and parsing
src/session.js            login validation, token renewal
src/foodgraph.js          storage location and shelf-life logic, food graph download
src/index.js              MCP server
bin/sf.js                 CLI
src/tools/                MCP tool definitions per area (zod schemas, annotations)
src/api/                  client methods per area
src/server.js             tool call wrapper (validation, errors, output limits)
test/*.test.js            offline tests (`npm test`); test/live/ holds the opt-in live suite
test/validate-har.js      validates the codec against real traffic
```

### Tests

```bash
npm test                  # offline (no network, no account): parser, codec, retry/backoff, schema drift, tool validation, mock-transport client tests
npm run test:live         # opt-in, hits the real account (see below)
npm run test:live:cleanup # removes leftover "mcp-test-" objects
```

The live suite (`npm run test:live`, equivalent to `SAMSUNG_FOOD_LIVE=1`) uses the token in your
config directory. It starts the real MCP server over stdio, calls every read-only tool
once, and exercises the write tools only on throwaway objects it creates itself, all
named `mcp-test-<timestamp>`: a shopping list, a collection, a recipe, a pantry entry,
a meal plan note and meal one year in the future, and a template. Everything is removed
in `finally` blocks; `test:live:cleanup` finds leftovers of crashed runs. The suite does not
modify, check, delete or move existing objects, and account settings are never written.
Known side effects on a real account: the last five *recent searches* are shifted by `recipe_search` calls
(the suite snapshots and restores them), deleted test recipes can stay listed in the
"recently viewed" smart collection, and creating/deleting test objects bumps counters
such as "recent items" (the suite passes `addToRecent: false`). Share-link generation and the primary-list switch
are off by default: opt in with `SAMSUNG_FOOD_LIVE_SHARE=1` / `SAMSUNG_FOOD_LIVE_PRIMARY=1`.
Run it against an account you are comfortable testing on.

### Checking the codec

Against a HAR capture from your own browser DevTools (never commit it, it
contains your token):

```bash
node test/validate-har.js ~/Downloads/app.samsungfood.com.har
```

The script decodes every request, re-encodes it and compares byte for byte.

## Reliability

- **Timeouts and retries.** Every request has a 20 s timeout (`SAMSUNG_FOOD_TIMEOUT_MS`).
  Network errors, HTTP 429/5xx and gRPC `UNAVAILABLE` / `DEADLINE_EXCEEDED` /
  `RESOURCE_EXHAUSTED` / `ABORTED` are retried up to 3 times (`SAMSUNG_FOOD_RETRIES`)
  with exponential backoff and jitter, honouring `Retry-After`. Read-only methods are
  always retried. Write methods are only retried when the request never left your
  machine (connection refused, DNS failure) or the server rate-limited it (HTTP 429 /
  `RESOURCE_EXHAUSTED`), which keeps retries from duplicating a write. A write whose
  outcome is unknown (timeout, 5xx, dropped connection) is reported as such and not
  repeated; check the result before trying again.
- **Schema drift.** The protocol schema is refreshed automatically when it is older
  than 7 days (the cached copy is used if the refresh fails). If a call fails in a way
  that suggests the API changed (unknown method, undecodable response, invalid-argument
  errors naming fields), the schema is rebuilt once and the call repeated, but only when
  that cannot apply a write twice. The codec rejects misspelled field names instead of
  silently dropping them.
- **Token renewal** is automatic, see [Setup](#setup).
- **MCP server.** Every failure is returned as an `isError` result with an actionable
  message (never a stack trace). Stray exceptions are logged to stderr and cannot crash
  the stdio server; stdout carries only the protocol.
- **App version header.** `x-whisk-app-version` defaults to `2.88.0` and can be
  overridden with `SAMSUNG_FOOD_APP_VERSION`. The web app's real value is a minified
  module constant that cannot be extracted reliably, so it is not auto-detected.

## Limitations

**There is no global recipe search.** `recipe_search` / `sf search` only
searches your own saved recipes. The schema has no method that searches the
Samsung Food catalog by term; `GetPopularRecipes` accepts a `query` but ignores
it on the server. To find new recipes use `recipe_discover` (suggestions),
`recipe_similar` (similar to a known recipe) and `recipe_import_url` (fetch a
recipe from any website).

**Meals cannot be scaled.** `ModifyMealsBatch` stores only the recipe
reference, not a serving count. Scaling happens when transferring to the
shopping list (`shopping_list_add_recipe` with `servings`).

**Pantry: you have to name the location.** When an item is created, Samsung
Food only sets an expiry date if the ingredient has exactly one storage
location in the food graph (coconut milk → fridge, 10 days). For anything that
can go in the fridge *or* the freezer, such as meat, fish or butter, the date
stays empty because the difference is huge (chicken breast: 2 days vs. 9
months). This project fills the gap: `pantry_add` with `location` computes the
date from the food graph, and `food_storage_info` / `sf storage` show the
options. Without a location it does **not guess**, it warns.

**Not every website can be scraped.** `recipe_import_url` fails with
`ERROR_RECIPE_SCRAPED_NOTHING` for sites with bot protection.

**The app version header is fixed.** Requests send `x-whisk-app-version: 2.88.0`.

## Notes

- Input aliases in German (meal times such as `frühstück` / `mittag` / `abend`, storage locations such as
  `kühlschrank` / `tiefkühler` / `vorratsschrank`) are accepted on purpose, next to the English ones.

- Unofficial and unsupported; the API can change without notice. If calls
  start failing, try `sf schema update`.
- Write calls change real data in your account, including shared lists and
  meal plans.
- The raw `api_call` has no safety net. Run `api_describe` first.

## License

MIT, see [LICENSE](LICENSE). This license covers the code in this repository
only; it grants no rights to Samsung Food, its API, data or trademarks.
