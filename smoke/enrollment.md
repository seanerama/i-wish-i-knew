# UI smoke: enrollment (stage 6) and password reset (stage 11)

Observably-works check for organization enrollment, node registration, token
issue, revocation, and the operator re-invite that resets a console password.
Run it against staging after every deploy that has
`IWIK_FEATURE_ENROLLMENT=on`, and against a local `docker compose up` before
opening a release. With the flag off, steps 2-10 must all answer `404`; only
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
   - Expect the green token box with the token shown once and its token id,
     with the note that reloading will not show it again and that submitting
     the form again issues another token.
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
   - Expect the sign-in page to say a lost password needs a **reset invite**
     from the operator (not a new enrollment).
   - Wrong password 5 times: each answers "not recognized".
   - 6th attempt within the minute (even with the right password): expect
     `429` with a `Retry-After` header.
   - From the same address, try a *different* organization name with any
     password inside that minute: expect `429` too (per-address window).
   - Wait a minute, sign in correctly: expect `/org`.
9. Operator re-invites the enrolled organization (stage 11), from the
   operator's shell, using the `org_id` from step 2:

   ```sh
   curl -s -X POST "$BASE/v1/admin/organizations/$ORG_ID/invites" \
     -H "Authorization: Bearer $IWIK_OPERATOR_TOKEN"
   ```

   - Expect HTTP `201` with `kind: "reset"`, `invite_url`, and `expires_at`.
   - Expect that repeating the call answers `409 invite_exists`.
   - Expect that a made-up `org_id` answers `404` and a missing header `401`.
10. Open the reset `invite_url` in a browser (a private window, so no console
    session is attached).
    - Expect the reset form: the organization name shown read-only (no
      editable name field), two new-password fields, and a note that the
      pilot terms agreement stands (no checkboxes: the terms version has not
      changed).
    - Submit with the two fields different: expect the form back with an
      error and the old password still working.
    - Submit a new password of 12+ characters.
    - Expect to land on `/org` with "Console password set", the same
      organization name, and the node card and token rows from steps 4-7
      unchanged.
    - Open the reset `invite_url` again: expect `404` "Invite not found".
    - In the window that was signed in before the reset, reload `/org`:
      expect a redirect to the sign-in page (the old session ended).
    - Sign in with the **old** password: expect "not recognized". Sign in
      with the **new** password: expect `/org`.
    - `curl -H "Authorization: Bearer <token>" $BASE/v1/protocols` with the
      active token from step 7: expect `200` (tokens survive a reset).
    - Repeat the step-9 `curl`: expect `201` again (the consumed invite no
      longer blocks a new one).

## Pass criteria

All steps pass. The token value never appears anywhere except the one
response in step 5; each invite URL (enrollment and reset) works exactly
once; cross-checks in step 7 answer `401` with the stated codes; step 10
leaves exactly one organization with that name and its nodes and tokens
intact.
