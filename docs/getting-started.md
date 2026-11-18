# Getting started

This page takes you from a fresh checkout to your first working commands.
For the MCP client setup see [MCP clients](mcp-clients.md).

> **Unofficial.** This project is not affiliated with Samsung or Whisk. It uses a private,
> undocumented API and may violate the Samsung Food Terms of Service. Read the
> [FAQ](faq.md) before using it on an account you care about.

## Requirements

- Node.js 20 or newer
- A Samsung Food account (any login method)
- A desktop browser, to copy your session once

## Install

The package is not on npm yet. Install from source:

```bash
git clone https://github.com/derdennis1012/unofficial-samsung-food-mcp.git
cd unofficial-samsung-food-mcp
npm install
npm link          # optional: puts `sf` and `unofficial-samsung-food-mcp` on your PATH
```

Without `npm link`, replace `sf` in all examples with `node bin/sf.js`, and start the MCP server
with `node src/index.js`.

Check that it runs (this needs no login and no network):

```bash
sf help
```

## Log in

Samsung Food signs users in on a separate domain with a captcha and social logins, so this tool
cannot log in by itself. It takes over the session of your browser instead. That works with every
login method (Google, Apple, e-mail, ...).

### What you are copying

The web app keeps a session token in the cookie `whisk.USER_TOKEN`. The token is a bearer token:
anyone who has it can read and change **everything** in your Samsung Food account until it expires
(14 days, see below). Treat it like a password. Do not paste it into issues, chats you do not
control, or shared documents.

### Steps

1. Log in at <https://app.samsungfood.com>. `sf login --open` opens the page for you.
2. Open the browser DevTools console and run:

   ```js
   copy(document.cookie)
   ```

3. Run:

   ```bash
   sf login
   ```

Use the clipboard (`sf login`) or `sf login --paste`. `sf login` takes its input in this order:
arguments on the command line, standard input (with `--paste`, or when input is piped), then the
clipboard. Passing the credential as an argument works but prints a warning: it ends up in your
shell history. The clipboard is only used if its content
looks like a Samsung Food credential. Accepted input:

- the full cookie string (the token is the `whisk.USER_TOKEN` cookie)
- the bare token
- `Bearer <token>`
- an `Authorization` header line
- a "Copy as cURL" command from the DevTools network tab

Clipboard access needs `pbpaste` (macOS), PowerShell `Get-Clipboard` (Windows), or one of
`wl-paste`, `xclip`, `xsel` (Linux). If none is available, run `sf login --paste`, paste the text
and finish with Ctrl-D (Ctrl-Z, Enter on Windows).

### What login does

1. Validates the token by calling `GetMe` and prints the account name.
2. Renews the token once to learn its expiry.
3. Stores it in `auth.json` inside the config directory (`~/.samsung-food`, or
   `$SAMSUNG_FOOD_HOME`), with file mode 600, written atomically.

If you log in with a different account than before, the cached meal plan ID from the old account is
dropped.

### Token lifetime

Tokens last 14 days and renew automatically. Before an API call, if the expiry is unknown or less
than 7 days away, the tool exchanges the current token for a new one. As long as you use the CLI
or MCP server at least about every two weeks, you do not need to log in again. After a longer
break run `sf login` again. Every renewal creates a new session on your account.

```bash
sf status      # token present, expiry, days left, last renewal, schema state
sf renew       # renew now (normally automatic)
sf logout      # remove the token; the cached meal plan ID stays
```

Instead of `auth.json` you can provide the token through the environment variable
`SAMSUNG_FOOD_TOKEN`. It overrides the file and is never written to disk, and it is not renewed
automatically.

## First commands

The protocol schema is built the first time it is needed (a few seconds, one-time, see
[Architecture](architecture.md)).

```bash
sf whoami                 # check the account
sf plan --days 7          # meal plan for the next week
sf list                   # shopping list
sf pantry                 # pantry by storage location
sf search "pumpkin soup"  # your own saved recipes
sf discover --limit 10    # suggestions from the catalog
```

Commands that change data:

```bash
sf list add "2 onions" "500 g flour"
sf plan add <recipeId> --date 2026-09-22 --meal dinner
```

These change your real account, including shared lists and meal plans. Commands that delete or
overwrite data (`sf plan rm`, `sf plan clear`, `sf list rm`, `sf pantry rm`, `sf plan template rm`,
`sf plan template apply --replace`) ask for confirmation, or need `--yes` when not run in a terminal.

Commands that show data print formatted text; add `--json` for the raw JSON. Most write commands
print their JSON result. The full list is in the [CLI reference](cli.md).

## Next steps

- Connect an AI client: [MCP clients](mcp-clients.md)
- All commands: [CLI reference](cli.md)
- All settings: [Configuration](configuration.md)
- Something failed: [Troubleshooting](troubleshooting.md)
