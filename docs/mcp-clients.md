# MCP clients

Shortcut: `npx unofficial-samsung-food-mcp setup` (from a checkout: `node bin/sf.js setup
--local`) logs you in and writes these entries for Claude Code, Claude Desktop and
Cursor, with a backup of each file; for VS Code it prints the snippet. This page is for doing it by
hand or for other clients.

The MCP server speaks stdio. Every client needs the same three things: a command, its arguments,
and optionally environment variables. The server reads the token that `sf login` stored, so log in
first ([Getting started](getting-started.md)).

Two ways to launch it:

| Variant | command | args | Status |
|---|---|---|---|
| Node and a checkout | `node` | `["/absolute/path/to/unofficial-samsung-food-mcp/src/index.js"]` | works today |
| npx | `npx` | `["-y", "unofficial-samsung-food-mcp"]` | **after the npm release** |

Use an absolute path for the checkout. Clients usually start servers with a different working
directory than your shell. If `node` is not found (common with version managers such as nvm), use
the absolute path of the node binary (`which node`, or `where node` on Windows).

`SAMSUNG_FOOD_LOCALE` and the other variables in [Configuration](configuration.md) can go into the
client's `env` block. None are required.

After changing a client configuration, restart the client. The server logs to stderr only; stdout
carries the protocol.

## Claude Desktop

Edit the configuration file (in the Claude menu: Settings, then Developer, then Edit Config opens
it), then quit and restart Claude Desktop completely:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

```json
{
  "mcpServers": {
    "samsung-food": {
      "command": "node",
      "args": ["/absolute/path/to/unofficial-samsung-food-mcp/src/index.js"],
      "env": { "SAMSUNG_FOOD_LOCALE": "en-US" }
    }
  }
}
```

On Windows use escaped backslashes or forward slashes in the path:
`"C:/Users/you/unofficial-samsung-food-mcp/src/index.js"`.

After the npm release:

```json
{
  "mcpServers": {
    "samsung-food": {
      "command": "npx",
      "args": ["-y", "unofficial-samsung-food-mcp"]
    }
  }
}
```

On Windows, if a client cannot launch `npx` directly, use `"command": "cmd"` with
`"args": ["/c", "npx", "-y", "unofficial-samsung-food-mcp"]`.

## Claude Code

```bash
claude mcp add samsung-food -- node /absolute/path/to/unofficial-samsung-food-mcp/src/index.js
```

With an environment variable (`-e` accepts several `KEY=value` pairs, so put it after the name or
follow it with another option; everything after `--` is the server command):

```bash
claude mcp add samsung-food -e SAMSUNG_FOOD_LOCALE=de-DE -- node /absolute/path/to/unofficial-samsung-food-mcp/src/index.js
```

After the npm release:

```bash
claude mcp add samsung-food -- npx -y unofficial-samsung-food-mcp
```

Check with `claude mcp list` (shows `Connected`) or `claude mcp get samsung-food`. The default scope
is `local` (this project, only you); `--scope user` makes it available in all projects, `--scope
project` writes a shared `.mcp.json`. Remove it with `claude mcp remove samsung-food`.

## Cursor

Global: `~/.cursor/mcp.json`. Per project: `.cursor/mcp.json` in the project.

```json
{
  "mcpServers": {
    "samsung-food": {
      "command": "node",
      "args": ["/absolute/path/to/unofficial-samsung-food-mcp/src/index.js"]
    }
  }
}
```

## VS Code

Create `.vscode/mcp.json` in the workspace (or use the command "MCP: Open User Configuration" for
your profile). Note that this file uses the key `servers`, not `mcpServers`, and needs `type`:

```json
{
  "servers": {
    "samsung-food": {
      "type": "stdio",
      "command": "node",
      "args": ["/absolute/path/to/unofficial-samsung-food-mcp/src/index.js"]
    }
  }
}
```

VS Code's newer Copilot agent harness also reads a workspace-root `.mcp.json` with the key
`mcpServers` (same shape as the Cursor example); `.vscode/mcp.json` keeps working for the current
harness.

## Any other client (generic stdio)

Run this command and speak MCP over its standard input and output:

```bash
node /absolute/path/to/unofficial-samsung-food-mcp/src/index.js
```

The server name reported in the handshake is `samsung-food`. It supports the `tools` capability
only (no resources or prompts). With `npm link` the same server is available as the command
`unofficial-samsung-food-mcp`.

To inspect it by hand, the official inspector works:

```bash
npx @modelcontextprotocol/inspector node /absolute/path/to/unofficial-samsung-food-mcp/src/index.js
```

## Logging in from the chat

The tool `auth_login` accepts the same cookie string, token or cURL text as `sf login`. Be aware
that anything you paste into a chat passes through the AI client and the model provider. Prefer
`sf login` in a terminal. `auth_status` shows the login state without revealing the token.

## Tool permissions

Every tool carries MCP annotations (`readOnlyHint`, `destructiveHint`, `idempotentHint`). Clients
that support per-tool approval can auto-approve read-only tools and ask before write and
destructive ones. See the [tool reference](tools.md) for the flag of each tool.
