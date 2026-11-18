# Troubleshooting

First step for any problem:

```bash
sf status
```

It shows whether a token is stored, when it expires, where it came from (`file` or `environment`),
and the age of the protocol schema. It never prints the token. When posting output in an issue,
redact account details first ([SECURITY](../SECURITY.md)).

## Login missing or expired (UNAUTHENTICATED)

Symptom: `Samsung Food login missing or expired. Run `sf login``, or a gRPC `UNAUTHENTICATED` /
`ERROR_AUTH_TOKEN` error, or "That token was rejected by Samsung Food".

Causes and fixes:

- **Never logged in, or `sf logout` was run.** Run `sf login` ([Getting started](getting-started.md)).
- **Token expired.** Tokens last 14 days and are renewed automatically when you use the tool. After
  a break of more than about two weeks, log in again.
- **The browser session ended.** If you logged out in the browser, or Samsung invalidated the
  session, the copied token no longer works. Log in again in the browser, copy a fresh cookie
  string, run `sf login`.
- **`SAMSUNG_FOOD_TOKEN` is set.** It overrides `auth.json` and is never renewed. Unset it or
  replace it with a fresh token. `sf status` shows `source: environment` in this case.
- **Wrong text copied.** `sf login` accepts the full cookie string, the bare token,
  `Bearer <token>`, an `Authorization` header line or a cURL command. The cookie must be
  `whisk.USER_TOKEN`.
- **Clipboard not read.** On Linux install `wl-paste`, `xclip` or `xsel`, or pass the text as an
  argument or with `sf login --paste`.

If a renewal fails but the token still works, the call goes ahead and a warning is printed on
stderr (`token renewal failed ... continuing with the current token`). Renewal is attempted at most
every 10 minutes after a failure.

## Schema drift

Symptoms: `unknown method`, `Could not decode the response of ...`, `invalid arguments` errors that
name fields, `method not available; try `sf schema update``.

The protocol schema is derived from Samsung Food's web app. When the app changes, the cached copy
can go stale.

```bash
sf schema update
```

This rebuilds `schema.json`. The tool also does it for you: the schema is refreshed automatically
when older than 7 days, and when a call fails in a way that looks like drift it is rebuilt once and
the call repeated, but only when that cannot apply a write twice. If `sf schema update` itself
fails with "No bundle URLs found" or "No RPC descriptors found", the web app layout changed in a way
the schema builder does not handle yet. Please [open an issue](https://github.com/derdennis1012/unofficial-samsung-food-mcp/issues)
with the error message.

## ERROR_RECIPE_SCRAPED_NOTHING

`recipe_import_url` / `sf import` returned `ERROR_RECIPE_SCRAPED_NOTHING`. Samsung Food's scraper
could not read the page. This usually means the site has bot protection or no machine-readable
recipe. Try another URL for the same recipe, or create the recipe by hand with `recipe_create`.
`sf import <url> --dry` parses without saving.

## Rate limits

HTTP 429 or gRPC `RESOURCE_EXHAUSTED` means you are sending too many requests. The client waits
and retries (up to `SAMSUNG_FOOD_RETRIES`, default 3) with exponential backoff, honouring
`Retry-After`. Write requests are retried on rate limiting because the server did not process
them. If it keeps failing, wait a few minutes and avoid loops that call the API many times.

## Timeouts and network errors

- Each request attempt times out after 20 seconds (`SAMSUNG_FOOD_TIMEOUT_MS`).
- Read-only calls are retried on timeouts, network errors and 5xx responses.
- Write calls are **not** retried when the outcome is unknown (timeout, 5xx, dropped
  connection). The error says "may or may not have been processed". Check the result (for example
  with `sf list` or `sf plan`) before repeating the write, or you may create duplicates.
- Errors that prove the request never left your machine (DNS failure, connection refused) are
  retried for writes too, and report "was not sent".
- Schema building and the food graph download have their own 30 second limits per download.
  A slow connection can make the first run fail with "Building the schema took too long"; run
  `sf schema update` again.

## "Protocol schema not found"

Only seen when using the library without `SamsungFood.create()`. Run `sf schema update`, or create
the client with `await SamsungFood.create()`, which builds the schema if needed.

## Food graph: "Could not download the food graph"

Storage and shelf-life lookups (`pantry_add` with a location, `food_storage_info`, `sf storage`)
need the public food graph for your locale. It is downloaded from `cdn.whisk.com`. Check your
connection and that `SAMSUNG_FOOD_LOCALE` is a locale Samsung Food has data for (for example
`en-US`, `de-DE`). A stale cached copy is used if a refresh fails.

## MCP client cannot start the server

- Use absolute paths in the client configuration ([MCP clients](mcp-clients.md)).
- Run the exact command in a terminal. It should print `samsung-food: MCP server running (stdio).`
  on stderr and then wait for input.
- `node` must be version 20 or newer (`node -v`). Clients often use a different `node` than your
  shell. Give the absolute path to the binary as `command`.
- Restart the client after changing its configuration.
- Output on stdout is reserved for the protocol. Look in the client's MCP log for stderr lines
  starting with `samsung-food:`.

## Tool output is cut off

Output over 40000 characters is truncated with a hint. Narrow the request with `limit`, `offset`,
`cursor` or specific IDs.

## Windows notes

- Config directory: `%USERPROFILE%\.samsung-food`.
- Clipboard login uses PowerShell `Get-Clipboard`. If it fails, use `sf login --paste` and paste
  the text, finishing with Ctrl-Z and Enter, or pass the text as a quoted argument.
- In JSON client configurations, write paths with forward slashes
  (`C:/Users/you/unofficial-samsung-food-mcp/src/index.js`) or doubled backslashes.
- If a client cannot start `npx` directly, use `cmd /c npx ...` (see [MCP clients](mcp-clients.md)).
- File mode 600 for `auth.json` has no effect on Windows.
- Quoting in `cmd` and PowerShell differs. For `sf call`, prefer passing JSON from a PowerShell
  single-quoted string, or from a file via PowerShell: `sf call <method> (Get-Content req.json -Raw)`.

## Still stuck

Open an issue with the output of `sf status` (redacted) and the full error message. Never attach
tokens, cookies or HAR files.
