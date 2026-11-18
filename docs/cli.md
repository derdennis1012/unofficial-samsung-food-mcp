# CLI reference

`sf` is the command line tool. Without `npm link`, run it as `node bin/sf.js`. `sf help` (or no
command, or `--help`) prints the usage text without touching the network; an unknown command prints
it and exits with status 1. `sf --version` prints the version. Errors are printed as
`Error: <message>` with exit status 1.

## Conventions

- Options look like `--name value`, `--name=value` or `--flag`. Switches (`--yes`, `--json`,
  `--open`, `--paste`, `--dry`, `--unscheduled`, `--replace`, `--read-only`, `--allow-raw`,
  `--no-mcp`, `--quiet`, `--show-key`, `--help`, `--version`) never take a value, so
  `sf pantry rm --yes <id>` works. Every other option needs a value (`--list` alone is an error).
  Unknown options are an error. `--` ends the options; everything after it is an argument.
- These commands print formatted text, and the raw JSON with `--json`: `whoami`, `plan`,
  `plan again`, `plan templates`, `plan template <id>`, `plan template apply`, `list`, `list all`,
  `search`, `discover`, `recipe`, `import`, `collections`, `pantry`, `pantry add`, `storage`,
  `tools`. All other commands (the remaining writes, `status`, `methods`, `describe`, `call`)
  always print JSON or plain text and ignore `--json`.
- Dates are `YYYY-MM-DD`. `--days`, `--limit` and similar must be positive whole numbers.
- Meal times: `breakfast`, `lunch`, `dinner`, `snack`, `togo`. German aliases are also accepted.
- Storage locations: `fridge`, `freezer`, `pantry`. Aliases such as `refrigerator`, `frozen`,
  `cupboard` and German words (`kühlschrank`, `tiefkühler`, `vorratsschrank`) work too.
- Commands that delete or overwrite data (`plan rm`, `plan clear`, `plan template rm`,
  `plan template apply --replace`, `list rm`, `pantry rm`) ask `[y/N]` in a terminal, before any
  network access. Without a terminal they refuse unless `--yes` is given.
- Anything that needs the API builds the protocol schema first if it is missing.

## Account and setup

| Command | What it does |
|---|---|
| `sf login [--paste] [--no-browser] [--open]` | Log in. In a terminal it opens a local page (127.0.0.1, random port, only for this login) with a one-click bookmark button for app.samsungfood.com and a paste field, waits up to 10 minutes and exits when the session is verified (no more copying cookies by hand). `sf setup` runs the same login. `--paste` reads the session from the terminal instead (SSH). Input order: arguments, then stdin (`--paste` or piped), then the clipboard, then the browser page. A credential given as an argument or `--token <value>` works but prints a warning, because it ends up in your shell history. `--no-browser` prints the page URL instead of opening it; `--open` opens app.samsungfood.com. See [Getting started](getting-started.md). |
| `sf setup [--yes] [--dry-run] [--remove] [--local] [--no-browser]` | One-step setup. Checks the Node version and the login (GetMe) and opens the browser login if needed, then lists the installed clients (Claude Code via `claude mcp add --scope user`, Claude Desktop and Cursor via their JSON config, VS Code as a snippet to paste) and asks which to configure (Enter = all). JSON configs: only the `samsung-food` entry is added or replaced, the rest is kept, the old file is saved as `<file>.bak-YYYYMMDD-HHMMSS`, invalid JSON is left alone and the snippet printed instead. `--yes` configures all detected clients without asking (needed without a terminal), `--dry-run` only prints, `--remove` takes the entries out again, `--local` starts this checkout with the current node instead of `npx -y unofficial-samsung-food-mcp`. Also `npx unofficial-samsung-food-mcp setup` (same options); without `setup` that command is the MCP stdio server. |
| `sf logout` | Remove the stored session (`auth.json`) completely. |
| `sf host ...` | Run and administer the hosted multi-user connector: `sf host help`, [Hosted connector](hosted.md). |
| `sf renew` | Renew the token now. Normally automatic. |
| `sf status` | Token state (logged in, expiry, days left, last renewal, source `file` or `environment`; never the token itself) and schema state. `sf auth` is an alias. |
| `sf whoami` | Account ID, name, language, country, calorie goal. |
| `sf tools [--json]` | All MCP tools with their area and whether they are read-only, write or destructive. Offline. `--json` adds the descriptions. |
| `sf schema update` | Rebuild the protocol schema from the web app. |

## Meal plan

| Command | What it does |
|---|---|
| `sf plan [--from D] [--days 7] [--to D] [--unscheduled]` | Show the meal plan. Default: today plus 7 days. `--to` overrides `--days`. `--unscheduled` lists unscheduled meals. |
| `sf plan add <recipeId> [--date D] [--meal M]` | Schedule a recipe. Defaults: today, `dinner`. |
| `sf plan move <mealId> --meal M [--date D]` | Move a meal. Without `--date` it becomes unscheduled. `--meal` is required. |
| `sf plan rm <mealId> [<mealId> ...] [--yes]` | Delete meals. Asks first. |
| `sf plan clear [--from D] [--days 7] [--to D] [--yes]` | Delete all meals in a range. Asks first. |
| `sf plan clear --unscheduled [--yes]` | Delete **all** unscheduled meals. Asks first. |
| `sf plan again [--limit 30]` | Previously planned meals. |

### Weekly templates

| Command | What it does |
|---|---|
| `sf plan templates` | List your templates. |
| `sf plan template <id>` | Show one template. |
| `sf plan template save --title T [--from D] [--days 7] [--to D]` | Save a range of the plan as a template. |
| `sf plan template apply <id> [--date D] [--replace] [--days N] [--yes]` | Apply a template starting at a date (default today). Existing meals are kept. `--replace` clears the range first and asks before doing so; the template is validated before anything is cleared, and if applying fails afterwards the error lists the removed meals. |
| `sf plan template rm <id> [<id> ...] [--yes]` | Delete templates. Asks first. |

## Shopping lists

All list commands use the primary list unless `--list <listId>` is given.

| Command | What it does |
|---|---|
| `sf list` | Show the list, grouped by category. |
| `sf list all` | All lists, including shared ones, with their IDs. |
| `sf list add "<item>" ...` | Add items as free text, for example `"2 onions"`. |
| `sf list recipe <recipeId> [--servings N]` | Add all ingredients of a recipe, scaled to the servings. |
| `sf list check <itemId> ...` | Check items off. |
| `sf list uncheck <itemId> ...` | Uncheck items. |
| `sf list rm <itemId> ... [--yes]` | Delete items. Asks first. |

## Recipes

| Command | What it does |
|---|---|
| `sf search <query> [--limit 20]` | Search **your own saved recipes**. There is no global catalog search. |
| `sf discover [--limit 20] [--seed N]` | Suggestions from the catalog. |
| `sf recipe <recipeId>` | Show a recipe. |
| `sf import <url> [--dry]` | Scrape a recipe from a website and save it; prints its name and ID. `--dry` only parses and prints it. |
| `sf collections` | Your collections with recipe counts and IDs. |

## Pantry and storage

| Command | What it does |
|---|---|
| `sf pantry` | Pantry by location, with expired items flagged. |
| `sf pantry add "<name>" ... [--location L]` | Add items. With a location, the expiry date is computed from the food graph. Without one, ambiguous items get a warning and no date. Names that only approximately match a food graph product (for example "oat milk" matched to Milk) never get an automatic date; they are printed with the matched product and a warning. |
| `sf pantry move <itemId> --location L [--date D]` | Change the storage location, optionally with a new expiry date. |
| `sf pantry expiry <itemId> --date D` | Set the expiry date. |
| `sf pantry use <itemId> ...` | Mark as consumed (`consume` is an alias). |
| `sf pantry unuse <itemId> ...` | Undo "consumed". |
| `sf pantry rm <itemId> ... [--yes]` | Delete entries. Asks first. |
| `sf storage "<name>"` | Storage locations and shelf life of a food, from the food graph. |

## Raw API access

| Command | What it does |
|---|---|
| `sf methods [filter]` | List all RPC methods in the schema, optionally filtered by substring. |
| `sf describe <method> [--depth 3]` | Show request and response fields of a method. |
| `sf call <method> '<json>'` | Call any method with a JSON request body. Same guard as the MCP tool `api_call`: login/session methods (AuthAPI) and account-credential methods (e-mail, phone, password, account deletion) are refused, and secrets in the result are shown as `[redacted]`. Any other write method changes real data unchecked. Run `sf describe` first. |

```bash
sf methods Community
sf describe whisk.x.list.v1.ListAPI/SyncItems
sf call whisk.x.list.v1.ListAPI/GetLists '{}'
```

## Local HTTP API

| Command | What it does |
|---|---|
| `sf serve [--host H] [--port 8787] [--read-only] [--allow-raw] [--cors ORIGIN] [--no-mcp] [--quiet]` | Start the local HTTP API (REST, OpenAPI, MCP over HTTP). Binds `127.0.0.1` by default. |
| `sf serve --show-key` | Print the API key (creating it if needed) and exit. |

The same server is available as the command `sf-api`. All flags, endpoints and examples are
in the [HTTP API](http-api.md) page.

## Exit status

`0` on success. `1` on any error, unknown command, or when `sf login` finds no credential.
