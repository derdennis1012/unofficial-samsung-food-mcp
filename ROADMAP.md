# Roadmap

This is a list of candidate work, not a promise or a schedule. It is derived from the known
[limitations](README.md#limitations) and from the areas that have no dedicated tools yet. If you
want to work on something, open an issue first so we can agree on the approach. Items marked
**good first issue** are small and well-bounded.

## Before 1.0

- Publish to npm so `npx -y unofficial-samsung-food-mcp` works, and list the server in the MCP Registry
  (`server.json` is prepared).
- Stabilise the library API of `SamsungFood`; document it as a supported interface.

## Candidate features

| Item | Notes |
|---|---|
| Dedicated tools for community and posts | Currently only through `api_call`. Read-only tools are the safest start. |
| Public profile tools | Read-only first (view a profile and its recipes). Follow and report are writes. |
| Cart and retailer checkout | Reachable through `api_call`. Needs careful design because it can lead to real purchases. |
| Rewards and payments status (read-only) | Read-only status tools only. No payment writes. |
| Product directory | Reachable through `api_call`. |
| Global recipe search | Not possible today: the API has no catalog search method (`GetPopularRecipes` ignores its `query`). Revisit if the API gains one. |
| Scaling a planned meal | Not stored by `ModifyMealsBatch`. Could be offered as a helper that scales at shopping-list time. |
| Auto-detect `x-whisk-app-version` | It is a minified module constant, so it is a fixed default with an environment override. A reliable extraction would remove a point of drift. |
| More robust import diagnostics | Better messages and hints for `ERROR_RECIPE_SCRAPED_NOTHING`. **good first issue** |

Account changes (e-mail, password, phone, delete account) and "send link to someone" methods are
deliberately left out of the dedicated tools, and will stay that way unless there is a strong,
safe use case.

## Quality and tooling

- More offline tests around token parsing and renewal edge cases. **good first issue**
- CLI shell completion (bash, zsh, fish). **good first issue**
- CLI commands for areas that only have MCP tools today (collections beyond listing, notes).
- Docker image for running the MCP server.
- A published JSON Schema or test fixtures for tool outputs, so clients can rely on them.
- Windows test coverage in CI (the CI matrix currently runs on Linux).

## Done

See [CHANGELOG.md](CHANGELOG.md).
