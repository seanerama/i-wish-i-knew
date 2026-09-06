# UI smoke: enrollment (stage 6)

Observably-works check for organization enrollment, node registration, token
issue, and revocation. Run it against staging after every deploy that has
`IWIK_FEATURE_ENROLLMENT=on`, and against a local `docker compose up` before
opening a release. With the flag off, steps 2-8 must all answer `404`; only
step 1 and the `smoke/console.md` checks apply.

Base URL: the deployment's public origin (staging per `STATUS.md`) or
`http://localhost:3000` under compose. Needs the deployment's operator token
(`IWIK_OPERATOR_TOKEN`; its location is recorded in `STATUS.md`, never its
value) and a machine with the runner (`npx i-wish-i-knew`, stage 3) to act as
the node.

## Steps

1. Open `/`.
   - Expect **Enrollment** to read `enabled` (or `disabled
     (IWIK_FEATURE_ENROLLMENT=off)` matching the deployment's flag; if
     disabled, stop here and confirm `GET /org` is `404`).
   - Expect the link **Sign in with your console password**.
2. Operator creates an invite (from the operator's shell, never from a browser):

   ```sh
   curl -s -X POST "$BASE/v1/admin/organizations" \
     -H "Authorization: Bearer $IWIK_OPERATOR_TOKEN" \
     -H 'content-type: application/json' \
     -d '{"name":"Smoke Org <date>"}'
   ```

   - Expect HTTP `201` with `org_id`, `invite_url`, and `expires_at`.
   - Expect that repeating the call with the same name answers `409 name_taken`.
   - Expect that the call without the header answers `401`.
3. Open the `invite_url` in a browser.
   - Expect the enrollment form: display name prefilled, two password
     fields, three checkboxes (pilot terms, trust-boundary statement,
     reciprocity clause) and the terms version.
   - Submit with one checkbox cleared: expect the form back with an error and
     nothing else changed.
   - Fill everything (password of 12+ characters) and submit.
   - Expect to land on `/org` with "Enrollment complete", the organization
     name in the heading, and the node enrollment instructions.
   - Open the `invite_url` again in a private window: expect `404` "Invite not
     found" (the invite is one-time).
4. On the node machine: `npx i-wish-i-knew init --service $BASE` and copy the
   printed public key.
   - Paste it into **Register a node** on `/org` and submit.
   - Expect "Node registered" and a node card with a 26-character node id and
     the key shown in base64 form (a pasted PEM block is accepted and shown as
     the same base64 key).
   - Paste garbage: expect "could not be parsed" and no new node.
5. Issue a token: tick `query` and `submit` on the node card, click **Issue
   token**.
   - Expect the green token box with the token shown once and its token id.
   - Reload `/org`: expect the token id listed as `active` and the token value
     absent from the page.
   - Save the token on the node: `umask 077 && printf '%s' '<token>' > ~/.iwik/token`.
6. `iwik submit` from the node (or `iwik run` + `iwik submit` per
   `smoke/runner.md` once stage 3 lands): expect an intake receipt (`201`) and
   **Accepted runs** on `/` (signed in as the organization) to read `1`.
7. Revoke: click **Revoke** on that token.
   - Expect "Token revoked" and the row marked `revoked`.
   - `iwik submit` again (or `curl -H "Authorization: Bearer <token>" $BASE/v1/protocols`):
     expect `401` with `error.code = "unauthorized"`.
   - Issue a new token, then **Revoke node**: expect the card marked revoked;
     the new token now answers `401` with `error.code = "node_revoked"`.
8. Sign out, then **Sign in with your console password**:
   - Wrong password 5 times: each answers "not recognized".
   - 6th attempt within the minute (even with the right password): expect
     `429` with a `Retry-After` header.
   - Wait a minute, sign in correctly: expect `/org`.

## Pass criteria

All steps pass. The token value never appears anywhere except the one
response in step 5; the invite URL works exactly once; cross-checks in step 7
answer `401` with the stated codes.
