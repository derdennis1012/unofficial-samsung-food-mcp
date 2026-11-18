# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project aims to follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html) once it reaches 1.0.

## [Unreleased]

## [0.1.0] - 2026-11-18

Initial release.

### Added

- Hosted multi-user connector `sf host` (also `sf-host`, Docker image): an OAuth 2.1 authorization
  server (PKCE S256, dynamic client registration, client ID metadata documents, refresh token
  rotation, revocation, RFC 9728/8414/9207 metadata) in front of a Streamable HTTP MCP endpoint, so
  Samsung Food can be added to ChatGPT, claude.ai and other remote MCP clients. Closed-beta invite
  codes, read-only option, per-user rate limits, self-service disconnect, admin CLI
  (`sf host invites|users|cleanup|keygen`). Samsung sessions are stored encrypted with a per-connection
  key that only the client's tokens can unwrap. Requires Node.js 22.13+ (`node:sqlite`). See
  [docs/hosted.md](docs/hosted.md).
- Browser login: `sf login` in a terminal opens a local page (127.0.0.1, random port) with a
  one-click bookmark button for app.samsungfood.com and a paste field, and exits once the session is
  verified. The same handover (one-time nonce bound to the browser, session only in the URL
  fragment) is used by the hosted connector's consent page.
- `sf setup` and `npx unofficial-samsung-food-mcp setup`: one command from zero to a working client.
  Checks Node and the login (browser login if needed), detects Claude Code, Claude Desktop, Cursor
  and VS Code and configures the chosen ones: `claude mcp add --scope user`, or a merge of only the
  `samsung-food` entry into the JSON config with a timestamped backup and an atomic write (invalid
  JSON is never touched; VS Code gets a snippet). `--dry-run`, `--yes`, `--remove`, `--local`.
- `SamsungFood` accepts a `tokenStore` option (`fileTokenStore`, `memoryTokenStore` in `auth.js`), so
  a client can keep its session somewhere other than `auth.json`; renewals write back through it.

- `sf tools [--json]` lists all MCP tools with their area and access (read-only, write,
  destructive), offline.
- `sf --version`, and `--name=value` as an alternative option syntax.
- `sf pantry add` and `sf storage` print the food graph warning for names that only approximately
  match a product.

### Changed

- `sf logout` removes `auth.json` completely (before, the cached meal plan ID stayed).
- Every `UNAUTHENTICATED` answer from Samsung Food becomes the login hint, which now explains how to
  reconnect, instead of a raw gRPC error.

- Renamed to `unofficial-samsung-food-mcp` so the name signals that the project is not affiliated with Samsung. Commands: `sf` (CLI), `unofficial-samsung-food-mcp` (MCP stdio server), `sf-api` (HTTP API, was `samsung-food-api`). The MCP server name reported on `initialize` and the User-Agent changed accordingly. Config dir `~/.samsung-food` and `SAMSUNG_FOOD_*` variables are unchanged.
- zod 4 (`^4.6.7`, fixes GHSA-mrhx-c7xc-m3w5 in older zod). Tool input schemas are now converted
  with `z.toJSONSchema` (draft 2020-12, input side) for MCP `tools/list`, `GET /v1/tools` and
  OpenAPI. The schemas are equivalent to before with a few corrections: `.positive()` numbers say
  `exclusiveMinimum: 0` (was `minimum: 0`), URLs carry `format: uri`, the operations of
  `shopping_list_favorites_modify` are described as a `oneOf` of the three operation objects (were
  untyped), and `api_call.request` declares string keys. Validation error messages follow zod 4
  (for example `Invalid input: expected string, received undefined`).
- CLI option parsing: switches such as `--yes` and `--json` no longer swallow the next argument
  (`sf pantry rm --yes <id>`, `sf list add --json milk`); options that need a value (`--list`,
  `--date`, ...) fail with a usage error when it is missing; unknown options are an error instead of
  being ignored.
- `sf plan rm`, `sf list rm`, `sf pantry rm`, `sf plan template rm` and
  `sf plan template apply --replace` ask for confirmation like `sf plan clear` (or need `--yes`
  without a terminal). The question comes before any network access.
- `sf call` uses the same guard and redaction as the MCP tool `api_call`: AuthAPI and
  account-credential methods are refused, secrets in results are redacted. Invalid JSON gives a
  clear error.
- `sf whoami`, `sf collections`, `sf import` and `sf list all` print formatted text by default and
  JSON with `--json`, like the other read commands.
- `sf login "<token>"` warns that a credential on the command line ends up in the shell history;
  the docs recommend the clipboard or `--paste`.

### Security

- Hosted: redirect hosts default to chatgpt.com, claude.ai, claude.com plus loopback (`SF_HOST_REDIRECT_HOSTS`, `*` = open, unsafe); the allowlist also applies to client ID metadata documents, whose hosts default to the same list.
- Hosted: the consent page shows the verified CIMD host, or "(unverified)" for dynamically registered clients; control and format characters are stripped from client names.
- Hosted: CIMD fetches have a total deadline, a concurrency cap, de-duplication and a negative cache; the SSRF filter also covers ::/96, 64:ff9b:1::/48, 2002::/16, 2001::/32 and 192.88.99.0/24.
- Hosted: rate limits count IPv6 per /64 and are never reset wholesale; at most 5 pending logins per network, the oldest unverified one is evicted; `/disconnect` is rate limited.
- Hosted: the grant key rotates on every refresh, expired key wraps are dropped within a minute, files are created with umask 077 and `/data` is mode 700.
- Hosted: a full client table evicts the oldest never-used registration; never-used DCR clients are deleted after 24 hours.
- Hosted: the upstream queue is bounded with at most 2 concurrent calls per user; renewal failures are logged without upstream text; read-only grants can only disconnect themselves.
- Hosted: the compose example publishes no port and joins a shared proxy network.
- `sf login`: the local login page requires the secret from the link the CLI opens.

### Documentation

- `meal_plan_apply_template` documented as destructive (with `replace` it validates the template
  first and reports removed meals on failure); `api_call` / `sf call` guard and redaction; non-exact
  food graph matches never set an expiry date and return `matchedProduct` and a warning; the primary
  list ID is no longer persisted in `auth.json`.
- Accurate statement on Samsung-derived material: the schema, bundles and food graph are fetched at
  runtime and not distributed; the source contains factual interface data (RPC method names, some
  enum values, field masks, category names).
- FAQ: the User-Agent is `unofficial-samsung-food-mcp/<version> (+https://github.com/derdennis1012/unofficial-samsung-food-mcp)`.
  `x-whisk-app-version` documented as a fixed default with the `SAMSUNG_FOOD_APP_VERSION` override.
- CLI reference: option syntax, which commands honour `--json`, which commands ask for confirmation.

### Added

- MCP server over stdio with 89 tools: meal plan and weekly templates, shopping lists, recipes,
  collections, pantry, food and nutrition, account, and raw API access. Tools carry read-only,
  destructive and idempotent annotations and validate input strictly.
- `sf` command line tool for login, meal plan, shopping lists, recipes, pantry, storage lookup and
  raw API calls.
- Schema-driven protobuf codec and gRPC-Web transport, with no `protoc` or `.proto` files. The
  protocol schema is built on the user's machine from the public web app and is not distributed.
- Login from the browser session (cookie, token, `Authorization` header or cURL command) and
  automatic token renewal.
- Timeouts, retries with backoff for transient failures (writes are only retried when safe), and
  automatic schema refresh on drift.
- Pantry expiry dates computed from the public food graph.
- Local HTTP API (`sf serve`, also `sf-api`): REST/JSON for every tool, OpenAPI 3.1 at
  `/openapi.json`, `/docs` page, API key authentication, `--read-only` mode, CORS opt-in and MCP over
  Streamable HTTP at `/mcp`. Binds to loopback by default.
- Offline test suite and an opt-in live test suite.
- Documentation in `docs/` and a generated tool reference (`docs/tools.md`).
