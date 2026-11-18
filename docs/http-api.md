# Local HTTP API

`sf serve` starts a local HTTP server that exposes the same tools as the [MCP server](mcp-clients.md)
as REST/JSON, with an OpenAPI 3.1 description. Use it from scripts, Home Assistant, n8n, Apple
Shortcuts or anything that can send an HTTP request. The same server also speaks MCP over HTTP at
`/mcp`.

It is generated from the same tool definitions as the MCP server, so the [tool reference](tools.md)
describes every endpoint's arguments and behaviour. It runs on your machine, with your Samsung Food
login, and listens on `127.0.0.1` unless you say otherwise.

> **Security.** The API key lets a caller read and change everything in your Samsung Food account
> (unless you use `--read-only`). Keep the server on loopback, or put TLS and a firewall in front of
> it. See [Security](#security).

## Start it

```bash
sf serve                     # http://127.0.0.1:8787
sf serve --read-only         # only read tools
```

The standalone command `sf-api` accepts the same flags. You must be logged in first
(`sf login`, see [Getting started](getting-started.md)); the server uses the stored token and
renews it like the CLI does.

| Flag | Meaning | Default |
|---|---|---|
| `--host <addr>` | Address to bind. A non-loopback address is only accepted when given explicitly, and prints a warning. | `127.0.0.1` |
| `--port <n>` | Port. `0` picks a free port. | `8787` |
| `--read-only` | Expose only tools annotated read-only. | off |
| `--allow-raw` | Also expose the raw `api_call` tool. It is hidden by default, and never available together with `--read-only`. | off |
| `--cors <origin>` | Allow browser calls from this origin (`http://localhost:3000`, no path) or `*` for any. | off (no CORS headers) |
| `--no-mcp` | Do not serve MCP at `/mcp`. | MCP on |
| `--quiet` | No request log on stderr. | log on |
| `--show-key` | Print the API key (creating it if needed) and exit. | |

On start the server prints the address, the number of exposed tools and the URLs of `/docs`,
`/openapi.json` and `/mcp` on stderr. Stop it with Ctrl-C.

## API key

Every route except `/healthz` and `/docs` needs the header `Authorization: Bearer <key>`.

- On the first start a key is generated (`sfk_` followed by random characters), stored in
  `$SAMSUNG_FOOD_HOME/api-key` (default `~/.samsung-food/api-key`, mode 600) and printed once.
  Show it again with `sf serve --show-key`.
- Set `SAMSUNG_FOOD_API_KEY` to use your own key instead (at least 16 characters). It overrides the
  file and is not written to disk.
- To rotate the key, delete the file and start the server again.
- The key is compared in constant time. The key and your Samsung Food token are never returned in a
  response or written to the request log.

The API key is separate from the Samsung Food session token. It only protects this local server.

## Endpoints

| Method and path | Key | Description |
|---|---|---|
| `GET /healthz` | no | Liveness: `{ ok, version, tools, readOnly }`. Touches no account data. |
| `GET /v1/tools` | yes | All exposed tools: name, area, description, MCP annotations, JSON input schema, example arguments. |
| `GET /v1/tools/{name}` | yes | One tool, same shape. |
| `POST /v1/tools/{name}` | yes | Call a tool. The JSON body is the tool's arguments. |
| `GET /openapi.json` | yes | OpenAPI 3.1 document, one operation per tool; `operationId` is the tool name. |
| `GET /docs` | no | A static page that renders the OpenAPI document. It contains no data and asks for the key in the browser. |
| `POST /mcp` | yes | MCP over Streamable HTTP, see [MCP over HTTP](#mcp-over-http). |

Trailing slashes are ignored. Tool names are the ones in the [tool reference](tools.md). With
`--read-only` or without `--allow-raw`, tools that are not exposed answer `404 unknown_tool`.

### Calling a tool

`POST /v1/tools/{name}` with `Content-Type: application/json` and the arguments as body. An empty
body means no arguments. Successful responses have status 200:

```json
{
  "ok": true,
  "data": { "...": "structured result" },
  "text": "the same result as pretty JSON"
}
```

- `data` is the structured result. If a tool returns an array or a scalar, it is wrapped as
  `{ "result": ... }`.
- `text` is the same result as formatted JSON, truncated to 40000 characters like the MCP text
  output. When truncated, `"truncated": true` is added and `data` still holds the full result.
- Arguments are validated like for MCP: unknown keys, bad dates and oversized lists are rejected.
- A call is cancelled with a 504 after 120 seconds.

The tool's flag (read-only, write, destructive) applies to HTTP as well. The OpenAPI document marks
read-only operations with `x-safe: true`, and carries the MCP annotations in `x-mcp-annotations` and
`x-idempotent`.

## Errors

Errors always have this shape:

```json
{ "ok": false, "error": { "code": "validation_error", "message": "Invalid arguments - ...", "issues": [{ "path": "days", "message": "..." }] } }
```

`issues` is present only for validation errors.

| Status | `code` | Meaning |
|---|---|---|
| 400 | `validation_error` | Arguments do not match the tool's schema. See `issues`. |
| 400 | `invalid_json` | The body is not valid JSON. |
| 401 | `unauthorized` | Missing or wrong API key. |
| 401 | `samsung_login_required` | The Samsung Food login is missing or expired. Run `sf login`. |
| 403 | `upstream_forbidden` | Samsung Food refused (the object belongs to someone else, or needs a premium plan). |
| 404 | `unknown_tool` | No such tool, or not exposed by this server's mode. |
| 404 | `upstream_not_found` | Samsung Food does not know the ID. |
| 404 | `not_found` | No such route. |
| 405 | `method_not_allowed` | Wrong HTTP method for this route. |
| 409 | `upstream_rejected`, `upstream_conflict` | Samsung Food rejected the request (invalid arguments or state). |
| 413 | `payload_too_large` | Body larger than 1 MB. |
| 415 | `unsupported_media_type` | `Content-Type` is not `application/json`. |
| 429 | `upstream_rate_limited` | Samsung Food rate-limited the request, after the client's own retries. |
| 502 | `upstream_unreachable`, `upstream_error`, `upstream_schema_drift` | Samsung Food is unreachable, failed, or the API changed. For schema drift run `sf schema update`. |
| 504 | `upstream_timeout`, `timeout` | The request to Samsung Food or the whole tool call timed out. |
| 500 | `internal_error` | Unexpected error. |

**Writes and timeouts.** For write tools a 504 (and a 502 `upstream_unreachable` that reached the
server) can mean the change was applied anyway. The message says so. Check the result (for example
with the matching read tool) before repeating a write. The same retry rules as in the CLI apply
([Architecture](architecture.md#transport)).

## Examples

Set the key once:

```bash
export SF_KEY="$(sf serve --show-key)"
```

Read-only calls:

```bash
curl -s http://127.0.0.1:8787/healthz

curl -s -H "Authorization: Bearer $SF_KEY" http://127.0.0.1:8787/v1/tools | head

curl -s -X POST http://127.0.0.1:8787/v1/tools/meal_plan_get \
  -H "Authorization: Bearer $SF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"days": 7}'

curl -s -X POST http://127.0.0.1:8787/v1/tools/pantry_get \
  -H "Authorization: Bearer $SF_KEY"
```

A write call (changes your real list):

```bash
curl -s -X POST http://127.0.0.1:8787/v1/tools/shopping_list_add \
  -H "Authorization: Bearer $SF_KEY" \
  -H "Content-Type: application/json" \
  -d '{"items": ["2 onions", "500 g flour"]}'
```

Parameter names of every tool are in `GET /v1/tools/{name}` and in the [tool reference](tools.md).

### Home Assistant

In `configuration.yaml`. Put the complete header value (`Bearer sfk_...`) into `secrets.yaml` as
`samsung_food_auth`:

```yaml
rest_command:
  samsung_food_add_to_list:
    url: "http://127.0.0.1:8787/v1/tools/shopping_list_add"
    method: POST
    headers:
      Authorization: !secret samsung_food_auth
      Content-Type: "application/json"
    payload: '{"items": ["{{ item }}"]}'
```

Call it with `service: rest_command.samsung_food_add_to_list` and `data: { item: "2 onions" }`. If
Home Assistant runs on another machine than the server, the server must be reachable from it, see
[Security](#security).

### n8n

Add an **HTTP Request** node:

- Method: `POST`
- URL: `http://127.0.0.1:8787/v1/tools/meal_plan_get` (use the host that n8n can reach)
- Authentication: Generic Credential Type, **Header Auth**, name `Authorization`, value `Bearer <key>`
- Send Body: on, Content Type `JSON`, body `{"days": 7}`

The result is in `data` of the response.

### Apple Shortcuts

Use the action **Get Contents of URL**:

- URL: `http://<host>:8787/v1/tools/shopping_list_add`
- Method: POST
- Headers: `Authorization` = `Bearer <key>`, `Content-Type` = `application/json`
- Request Body: JSON, with the key `items` as a list that contains your text

On an iPhone the server must be reachable over the network (see [Security](#security)); `127.0.0.1`
only reaches the phone itself.

## MCP over HTTP

`POST /mcp` serves the MCP Streamable HTTP transport, stateless and with JSON responses, with the
same tools and the same API key. Clients must send `Accept: application/json, text/event-stream`
(MCP clients do this on their own). `GET` and other methods on `/mcp` return 405. Disable it with
`--no-mcp`.

Claude Code:

```bash
claude mcp add --transport http samsung-food http://127.0.0.1:8787/mcp \
  --header "Authorization: Bearer $SF_KEY"
```

Cursor (`~/.cursor/mcp.json`):

```json
{
  "mcpServers": {
    "samsung-food": {
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

VS Code (`.vscode/mcp.json`):

```json
{
  "servers": {
    "samsung-food": {
      "type": "http",
      "url": "http://127.0.0.1:8787/mcp",
      "headers": { "Authorization": "Bearer <key>" }
    }
  }
}
```

For local use the stdio server ([MCP clients](mcp-clients.md)) is simpler: no key, no running
server. Use MCP over HTTP when the client cannot start local processes, or when one running server
should serve several clients.

## OpenAPI and `/docs`

`GET /openapi.json` (with the key) returns an OpenAPI 3.1 document. Import it into Postman, Insomnia,
or a code generator. Operation IDs are the tool names. Open `http://127.0.0.1:8787/docs` in a browser
for an interactive page: the page itself contains no data and asks for the key, which stays in your
browser.

## Security

- **Loopback by default.** The server binds `127.0.0.1`. Anything running as any user on your
  machine can still reach it, so the API key is required for every data route.
- **Exposing it on a network.** `--host 0.0.0.0` (or another non-loopback address) is refused unless
  you pass `--host` explicitly, and prints a warning. The server speaks plain HTTP. If you expose it,
  put a reverse proxy with TLS in front, restrict access with a firewall, and prefer `--read-only`.
  Anyone with the key has full access to your Samsung Food account.
- **CORS is off.** Browsers cannot call the API from other origins unless you pass `--cors <origin>`.
  Avoid `--cors "*"` unless you understand the consequence: any web page that knows the key could use it.
- **Read-only mode** removes write and destructive tools from the REST API, the OpenAPI document and `/mcp`.
- **Raw access is off.** `api_call` needs `--allow-raw`. It refuses login and account-credential
  methods and redacts secrets in results, but any other write method goes through unchecked.
- **Limits.** Request bodies are limited to 1 MB; slow requests time out after 30 seconds.
- **Logging.** The request log (stderr) contains method, path (without the query string), status and
  duration. No headers, bodies, keys or tokens.
- Report problems privately, see [SECURITY](../SECURITY.md).
