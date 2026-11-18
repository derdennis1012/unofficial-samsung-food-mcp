# Security policy

## Reporting a vulnerability

Please report security problems **privately** through GitHub private vulnerability reporting:
open the repository's **Security** tab and choose **Report a vulnerability**
(<https://github.com/derdennis1012/unofficial-samsung-food-mcp/security/advisories/new>).

Do not open a public issue for a vulnerability. We will acknowledge the report as soon as we can,
work on a fix, and credit you if you wish. This is a volunteer project, so there is no guaranteed
response time and no bug bounty.

Supported versions: only the latest release (and the `main` branch before the first release).

## What counts

In scope: bugs in this code that could expose a user's token, write it somewhere unsafe, send it to
a host other than Samsung Food's, let untrusted input cause unintended writes or deletions, execute
code, or break the stdio protocol boundary. Problems in Samsung Food itself are out of scope; report
those to Samsung.

## How tokens are handled

- **What the token is.** Login uses the session token from your browser (cookie
  `whisk.USER_TOKEN`). It is a bearer token that grants **full access to the account** until it
  expires (14 days).
- **Where it is stored.** `auth.json` in the config directory (`~/.samsung-food`, or
  `$SAMSUNG_FOOD_HOME`), file mode 600, written atomically. File modes do not protect on Windows.
- **Where it is sent.** Only to `app.samsungfood.com` (API calls) and `login.whisk.com`
  (renewal), as an `Authorization: Bearer` header. Nothing is sent anywhere else and there is no
  telemetry.
- **What is never shown.** `sf status` and the `auth_status` tool report login state, expiry and
  renewal time, never the token itself.
- **Environment override.** A token given in `SAMSUNG_FOOD_TOKEN` is never written to disk.
- **Renewal** creates a new session on your account each time.
- **Chat login.** The `auth_login` tool takes the token as an argument. In an AI client that value
  becomes part of the conversation and is sent to the model provider. Prefer `sf login` in a terminal.
- **Revoking.** `sf logout` removes the stored token locally. To invalidate a session that may have
  leaked, log out of Samsung Food in the browser or change the account's password with Samsung.
  Delete the file `auth.json` if a machine is lost.

## Rules for issues, pull requests and logs

**Never attach or paste:**

- tokens, cookies (`document.cookie` output), `Authorization` headers or cURL commands that contain them
- the content of `auth.json`
- HAR files from your browser, they contain your token and personal data
- screenshots that show any of the above

Redact account details from `sf status` output and error messages before posting them. If you pasted
a token by accident, treat it as leaked: log out in the browser, edit or delete the post, and report
the exposure.

## Safe use

- The write and destructive tools change real data, including shared lists and meal plans. Configure
  your MCP client to ask for approval before running them (tools carry `readOnlyHint` and
  `destructiveHint` annotations).
- `api_call` and `sf call` have no safety net.
- The MCP server starts as a local process with your user rights and listens on no network port.
