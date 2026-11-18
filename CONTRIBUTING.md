# Contributing

Thanks for helping. This is a small project; issues and pull requests are welcome. By taking part
you agree to the [Code of Conduct](CODE_OF_CONDUCT.md).

> **Never** put tokens, cookies, `auth.json` content or HAR captures into issues, pull requests or
> test fixtures. They give full access to a Samsung Food account. See [SECURITY.md](SECURITY.md).

## Where to start

- Browse issues labelled **good first issue**. They are small and have a clear scope.
- The [ROADMAP](ROADMAP.md) lists candidate work. Items marked "good first issue" there are good
  starting points. Open an issue before starting anything larger, so we can agree on the approach.
- Typos, unclear docs and missing troubleshooting entries are always welcome.
- For questions and ideas use GitHub Discussions; for bugs use the issue templates.

What a good first issue looks like: touches one area, can be tested offline, and does not need
changes to the codec or transport. Examples: a clearer error message, a missing CLI option, a test
for an edge case, a docs fix.

## Setup

Requires Node.js 20 or newer (`.nvmrc` pins the version used for development).

```bash
git clone https://github.com/derdennis1012/unofficial-samsung-food-mcp.git
cd unofficial-samsung-food-mcp
npm install
npm test
```

| Command | What it does |
|---|---|
| `npm test` | Offline tests. No network, no account, no token. |
| `npm run lint` | ESLint. `npm run lint:fix` fixes what it can. |
| `npm run check` | Lint and tests, as CI does. |
| `npm run docs:tools` | Regenerates `docs/tools.md` from the tool definitions. |
| `npm run mcp` | Starts the MCP server over stdio. |

The offline tests use a temporary config directory with a small schema fixture and block all
network access, so they never touch your real `~/.samsung-food`.

Code style: ES modules, two-space indentation, LF line endings (see `.editorconfig`), English in
code, comments and docs.

## Live tests

The live suite runs against a **real Samsung Food account** using the token in your config
directory. It is opt-in and never runs as part of `npm test`.

```bash
npm run test:live            # read-only sweep plus write tests on throwaway objects
npm run test:live:cleanup    # removes leftover "mcp-test-" objects
```

It starts the real MCP server over stdio, calls every read-only tool once, and exercises write
tools only on throwaway objects it creates itself, all named `mcp-test-<timestamp>`: a shopping
list, a collection, a recipe, a pantry entry, a meal plan note and a meal one year in the future,
and a template. Everything is removed in `finally` blocks. It does not modify, check, delete or move
existing objects, and account settings are never written.

Known side effects: the last five recent searches are shifted by `recipe_search` calls (the suite
snapshots and restores them), deleted test recipes can stay listed in the "recently viewed" smart
collection, and creating or deleting test objects can bump counters such as recent items. Share-link
generation and the primary-list switch are off by default; opt in with `SAMSUNG_FOOD_LIVE_SHARE=1` and
`SAMSUNG_FOOD_LIVE_PRIMARY=1`. Run the suite against an account you are comfortable testing on, and
do not make live tests part of a pull request's required checks.

## Checking the codec against real traffic

```bash
node test/validate-har.js path/to/app.samsungfood.com.har
```

It decodes every request in a HAR capture from your own browser, re-encodes it and compares byte
for byte. Never commit the HAR file; it contains your token (`*.har` is in `.gitignore`).

## Adding a new tool

Tools live in `src/tools/<area>.js`; they call methods of the client in `src/api/<area>.js`. As a
walkthrough, this is how `food_autocomplete` is built.

**1. Find the API method.** Use the raw access tools to explore:

```bash
sf methods Autocomplete
sf describe whisk.x.food.v1.FoodAPI/Autocomplete
sf call whisk.x.food.v1.FoodAPI/Autocomplete '{"query":"ban","limit":5,"language":"en"}'
```

[docs/api.md](docs/api.md) describes the protocol and known data models.

**2. Add a client method** in the matching file under `src/api/` (here `src/api/food.js`). Methods
use `this.call(method, request)` and return plain, tidy data, not raw protobuf messages:

```js
async foodAutocomplete(query, { limit = 10, language } = {}) {
  const res = await this.call(FOOD_API + 'Autocomplete', {
    query,
    limit,
    language: language ?? this.locale.split('-')[0].toLowerCase(),
  });
  return (res.suggestions ?? []).map((s) => s.name);
},
```

Reads are detected by method name (`Get*`, `Search*`, ...). A read method must be safe to retry.
A write must never be assumed safe to retry; see [Architecture](docs/architecture.md#transport).

**3. Define the tool** in the matching file under `src/tools/` with `defineTool`:

```js
defineTool({
  name: 'food_autocomplete',
  kind: 'read',
  description: 'Suggests food names for a prefix (e.g. "ban" gives banana). The names work as input for food_search.',
  example: { query: 'ban', limit: 5 },
  schema: z.object({
    query: z.string().trim().min(1).max(100).describe('Prefix, e.g. "ban"'),
    limit: limitSchema(10, 50),
    language: languageSchema(),
  }),
  handler: async (a, sf) => ({ suggestions: await sf.foodAutocomplete(a.query, a) }),
}),
```

Rules:

- `name`: snake_case, starting with the area prefix (`meal_plan_`, `shopping_list_`, `recipe_`,
  `collection_`, `pantry_`, `food_`, `account_`, `api_`, ...). Names must be unique.
- `kind`: `read` (reads only), `write` (creates or changes, removes nothing), `update` (same, but
  repeating it has no further effect), `destructive` (removes or overwrites). This sets the MCP
  annotations. Pick the most cautious fit. Set `idempotent` if the default for the kind is wrong.
- `description`: say what it does, where IDs come from, and how to page for more. Write it for the
  model that will read it.
- `schema`: strict zod object. Use the helpers in `src/tools/util.js` (`idSchema`, `dateSchema`,
  `mealTimeSchema`, `limitSchema`, `shortText`, `idList`). Describe every parameter with
  `.describe(...)`, because those texts end up in the tool reference and in the model's prompt.
- `example`: valid sample arguments. Placeholder IDs are fine. Offline tests validate them against
  the schema.
- `handler`: return plain JSON-able data and keep it concise. Cap lists with `limit`.

**4. Register it in the tests.** `test/recipes.test.js` and `test/lists.test.js` hold an
`EXPECTED` map of tool names to kinds for their areas. Add your tool there with its kind (and the
test for the area it belongs to). Add a client-level test with the mock transport in the
matching `test/*.test.js` file when the method does more than pass data through. For live
coverage, add a read sample to `readSamples` (and write tests with throwaway objects) in
`test/live/<area>.js`.

**5. Regenerate the docs** and run everything:

```bash
npm run docs:tools
npm run check
```

Commit the regenerated `docs/tools.md` together with the code; `npm run docs:tools -- --check`
exits 1 if it is stale. Add a line to [CHANGELOG.md](CHANGELOG.md) under
"Unreleased". Also mention the tool in the README only if the area table needs it.

## Adding or changing a CLI command

CLI commands live in `bin/sf.js`. Update both the usage comment at the top and the help text at the
bottom, then [docs/cli.md](docs/cli.md). Destructive commands must go through `confirm()`.

## Documentation

- `docs/tools.md` is generated. Never edit it by hand: `npm run docs:tools`, or
  `node scripts/gen-tools-doc.js --check` to verify it is current.
- Every statement in the docs must match the code. If you change behaviour, change the docs in the
  same pull request.
- Plain, direct English. No marketing language.

## Commit style

- Short imperative subject line, around 70 characters: "Add recipe_rate tool", "Fix retry of
  writes after timeout".
- Explain the why in the body when it is not obvious.
- One logical change per commit and per pull request.
- Conventional Commit prefixes (`feat:`, `fix:`, `docs:`) are fine but not required.

## Pull requests

Fill in the pull request template. Before opening one: `npm run check` passes, the docs are
regenerated, and you have not committed secrets, HAR files or Samsung-derived schema or food graph
data (the repository must not contain them; the only exception is the small fixture in
`test/fixtures/`). If you cannot test against a real account, say so in the description.

## Legal

This is an unofficial project. Do not contribute material taken from Samsung or Whisk (code,
bundles, schemas, data) beyond what the project already does at runtime on the user's machine.
Contributions are licensed under the MIT license of this repository.
