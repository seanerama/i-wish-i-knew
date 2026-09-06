# UI smoke: console (stage 2)

Observably-works check for the member console and service readiness. Run it
against staging after every deploy (Release/Deploy Operator) and against a
local `docker compose up` before opening a release.

Base URL: the deployment's public origin (staging per `STATUS.md`) or
`http://localhost:3000` under compose.

## Steps

1. Open `/` in a browser.
   - Expect the page title and heading **I Wish I Knew**.
   - Expect the highlighted trust-boundary statement (ADR-0002), containing the
     words "service operators are inside the trust boundary during the pilot".
   - Expect **Evidence revision** followed by a non-negative integer (fresh
     database: `0`).
   - Expect **Accepted protocols** to list `inference-api/latency@1`.
   - Expect **Intake** to read `enabled` or `disabled (IWIK_FEATURE_INTAKE=off)`
     matching the deployment's flag.
2. `GET /readyz` (for example `curl -s <base>/readyz`).
   - Expect HTTP `200` with body exactly `{"ok":true}`.
   - A `503` with `not_ready` means the database is unreachable or migrations
     are pending: run `node packages/service/dist/migrate.js` in the image.
3. `GET /healthz` returns `{"ok":true}` even when intake is disabled.
4. (Optional, needs a seeded node token) Paste the node token into the
   **Node token** form and sign in.
   - Expect **Accepted runs** with the organization's count and **Last receipt**
     with a receipt id or `(none yet)`.
   - Expect that the token value itself never appears in the page or the
     `iwik_session` cookie (the cookie carries a signed hash).
   - Sign out; the organization section returns to the sign-in form.

## Pass criteria

All of steps 1-3 pass. Step 4 passes when a seed identity is configured.
