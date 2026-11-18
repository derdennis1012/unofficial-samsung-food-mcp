# Configuration

All settings are environment variables. None are required. Set them in your shell for the CLI, or
in the `env` block of your MCP client ([MCP clients](mcp-clients.md)).

| Variable | Meaning | Default |
|---|---|---|
| `SAMSUNG_FOOD_HOME` | Config and cache directory | `~/.samsung-food` (`%USERPROFILE%\.samsung-food` on Windows) |
| `SAMSUNG_FOOD_TOKEN` | Bearer token. Overrides the token in `auth.json`. Never written to disk, never renewed automatically. | unset |
| `SAMSUNG_FOOD_LOCALE` | Locale for requests (`accept-language`), the food graph download and the default language of food searches, for example `de-DE` | `en-US` |
| `SAMSUNG_FOOD_TIMEOUT_MS` | Timeout per request attempt in milliseconds. `0` disables the timeout. | `20000` |
| `SAMSUNG_FOOD_RETRIES` | Retries for transient failures. `0` disables retries. | `3` |
| `SAMSUNG_FOOD_API_KEY` | API key for the [local HTTP API](http-api.md) (`sf serve`), at least 16 characters. Overrides the `api-key` file and is not written to disk. | unset (a key is generated and stored) |
| `SAMSUNG_FOOD_APP_VERSION` | Value of the `x-whisk-app-version` header. The built-in default is a fixed value because the real one is a constant inside a minified bundle; set this if Samsung starts rejecting the default. | `2.88.0` |

The hosted connector (`sf host`) has its own `SF_HOST_*` variables, see [Hosted connector](hosted.md#configuration).

Invalid numbers (not a number, or negative) for the two numeric variables fall back to the default.
The variables are read when the process starts.

## Files in the config directory

| File | Content | Mode |
|---|---|---|
| `auth.json` | Session token and expiry, renewal time, account ID, cached meal plan ID. The primary list ID is not stored (it is looked up per process, because the primary list can change). | 600 |
| `api-key` | API key of the local HTTP API, created on the first `sf serve` | 600 |
| `schema.json` | Protocol schema built from the web app, refreshed when older than 7 days | 644 |
| `foodgraph-<locale>.json` | Public shelf-life data per locale, for example `foodgraph-en-us.json`, refreshed after 30 days | 644 |

`auth.json` and `api-key` are secret. File modes are applied on macOS and Linux; on Windows rely on the
protection of your user profile directory. You can delete `schema.json` and the food graph files at
any time; they are rebuilt. See the [FAQ](faq.md) for what is downloaded from where.

## Notes

- **Using a token from the environment.** `SAMSUNG_FOOD_TOKEN` is useful for containers and CI-like
  setups. Because it is not renewed, it stops working when it expires. For normal use prefer
  `sf login`, which renews tokens automatically.
- **Several accounts.** Point `SAMSUNG_FOOD_HOME` at a different directory per account. Each
  directory has its own token and caches. In the MCP client configuration, add one server entry
  per account, each with its own `env`.
- **Locale.** The locale selects which food graph is downloaded (used for storage locations and
  shelf life) and the language of `food_search` and `food_autocomplete`. The tools also accept a
  per-call `language` where the tool reference lists it.
- **Offline tests.** `npm test` sets up its own temporary directory and does not use your config
  directory or the network.
- **Live tests** use two more variables, `SAMSUNG_FOOD_LIVE=1` (or `npm run test:live`) and the
  opt-ins `SAMSUNG_FOOD_LIVE_SHARE` and `SAMSUNG_FOOD_LIVE_PRIMARY`. See
  [CONTRIBUTING](../CONTRIBUTING.md#live-tests).
