# FAQ

## Is this official?

No. It is an independent open source project. It is not affiliated with, endorsed by, or supported
by Samsung or Whisk. "Samsung Food" is a trademark of its owner.

## Is it allowed? Can my account be banned?

Samsung Food has no public API. This tool uses the same private API as the web app, with your own
session, and that may violate Samsung Food's Terms of Service. Samsung could restrict an account
for it. There is no guarantee either way. Use it at your own risk, ideally with an account you can
afford to lose. Do not use it for scraping, bulk automation or anything beyond your own account.

## What does it do on my machine?

- Runs as a local process: the CLI `sf`, or an MCP server your AI client starts over stdio.
- Calls the same servers as the web app, with your token.
- Stores a few files in the config directory (see below).
- The MCP server over stdio does not open any network port. The optional HTTP API (`sf serve`) listens on `127.0.0.1` only unless you pass `--host`, and every data route needs its API key.

## What data is fetched, and from where?

| Host | What | When |
|---|---|---|
| `app.samsungfood.com` | The public web app page and its gRPC-Web API (`/api/grpc-web/`): your recipes, plans, lists, pantry | When you use a tool or command |
| `cdn.whisk.com` | The web app's public JavaScript bundles (read as plain text to build the schema), and the public food graph (`/autocomplete/v1/<locale>/all.json`) | First use, then schema every 7 days and food graph every 30 days |
| `login.whisk.com` | Token renewal (`AuthAPI/IssueAuthCode`, `UseAuthCode`) | When the token expires in less than 7 days |

Nothing is sent anywhere else. The project is configured with no other hosts in its code.

## What does it send to Samsung?

API requests carry `Authorization: Bearer <token>`, the web app's `x-whisk-app-name`,
`x-whisk-app-version` and `x-whisk-device-type` headers, and your locale as `accept-language`.
Every request (API, schema build and food graph download) identifies this project honestly with
`User-Agent: unofficial-samsung-food-mcp/<version> (+https://github.com/derdennis1012/unofficial-samsung-food-mcp)`; it
does not pretend to be a browser. Besides your tool arguments, nothing else about you or your
machine is sent. The exact headers are in [Samsung Food API](api.md#headers), `src/grpc.js` and
`src/version.js`.

## What is stored, and where?

In `~/.samsung-food` (or `$SAMSUNG_FOOD_HOME`):

- `auth.json`: your session token, expiry, account ID and the cached meal plan ID (mode 600). The
  primary shopping list ID is not stored: it is looked up again in every process, because the
  primary list can change in the app.
- `api-key`: the API key of the optional [local HTTP API](http-api.md), if you ran `sf serve` (mode 600)
- `schema.json`: the protocol schema built from the web app
- `foodgraph-<locale>.json`: public shelf-life data

Nothing is stored elsewhere. Recipes, plans and lists stay in your Samsung Food account; the tool
does not keep a copy. The Samsung protocol schema, the web app's bundles and the food graph are not
part of this repository; they are built or downloaded on your machine. The source code does contain
factual interface data used to talk to the API: RPC method names, some enum values, field masks and
category names as the web app uses them (see [Architecture](architecture.md#the-schema-build)).

## Is there telemetry?

No. The code contains no analytics, tracking or reporting of any kind, and no network calls other
than the three hosts above. You can verify this: the only hostnames in the source are those listed
in the table.

## Who sees my data when I use it with an AI client?

Whatever a tool returns (recipes, meal plans, pantry, list items) becomes part of the
conversation with your AI client and its model provider. Check their data policies. Do not use
`auth_login` in a chat if you do not want your token in that conversation; use `sf login` in a
terminal.

## Can the AI delete my data?

Write and destructive tools exist and change your real account, including shared lists and meal
plans. Every tool is annotated read-only, write or destructive in MCP, so clients that support
approval prompts can ask before running them. `meal_plan_apply_template` counts as destructive:
with `replace` it clears the range first (it validates the template before clearing, and if applying
fails afterwards the error lists the removed meals). The raw tool `api_call` refuses login and
account-credential methods (AuthAPI, changing e-mail, phone or password, deleting the account) and
redacts tokens and passwords in its results, but any other write method goes through unchecked.
Consider configuring your client to require approval for destructive tools. See the [tool reference](tools.md).

## Why not use the browser login directly?

Samsung Food's login runs on a separate domain with a captcha and social logins. Taking over your
browser session works with every login method and avoids handling passwords. The trade-off: you
copy a token once, and it grants full access to the account. See [Getting started](getting-started.md).

## It broke after a Samsung Food update

Run `sf schema update`. See [Troubleshooting](troubleshooting.md#schema-drift). If that does not
help, open an issue.

## Which features are missing?

See the limitations in the [README](../README.md#limitations) and the [roadmap](../ROADMAP.md).
Anything without a dedicated tool is still reachable through `api_methods`, `api_describe` and
`api_call`.

## Can I use it as a library?

Yes, see [Architecture](architecture.md#library-use). The API is not yet stable before 1.0.

## Can I contribute?

Yes. See [CONTRIBUTING](../CONTRIBUTING.md).
