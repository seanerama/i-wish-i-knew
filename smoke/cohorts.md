# UI smoke: cohort preview and duplicate receipts (stage 8)

Observably-works check for `GET /v1/admin/cohorts` (the operator view, ranges
only), duplicate intake receipts, and the `index_backfill` worker job, against
a deployment (staging per `STATUS.md`, or a local `docker compose up`). Proves
brief §7 and ADR-0002/0003: repeated uploads of one measurement and many nodes
inside one organization do not inflate contributor counts, an operator can see
how a cohort is shaping up without ever seeing exact counts, and nothing in the
operator view names an organization or a run.

Prerequisites: Node 22, the repository built (`npm ci && npm run build`),
`IWIK_FEATURE_INTAKE=on` and `IWIK_FEATURE_ENROLLMENT=on` on the deployment,
`IWIK_OPERATOR_TOKEN` set (its value in `$OPERATOR`), two enrolled
organizations each with a node token carrying `submit` (`smoke/enrollment.md`;
call the tokens `$TOKEN_A` and `$TOKEN_B`), and the runner initialized for org A
(`iwik init --service <base url> --token-file <file>`). Use a throwaway home:
`export IWIK_HOME=$(mktemp -d)` and `alias iwik='node packages/runner/bin/iwik.cjs'`.
Run the stub target from `smoke/mcp.md` step 1 on `127.0.0.1:8089`.

Every `curl` below is `curl -s -H "Authorization: Bearer $OPERATOR" <base>/v1/admin/cohorts?...`
unless it says otherwise.

## Steps

1. With `IWIK_FEATURE_DEDUPE` unset (the default), open `/`.
   - Expect **Dedupe** to read `disabled (IWIK_FEATURE_DEDUPE=off)`.
2. `curl -s -o /dev/null -w '%{http_code}\n' "<base>/v1/admin/cohorts?protocol_ref=inference-api/latency@1"`
   (no token on purpose), then the same with `-H "Authorization: Bearer $OPERATOR"`.
   - Expect `404` both times with body `{"error":{"code":"feature_disabled",...}}`:
     disabled before authentication, so a probe learns nothing.
3. Contribute one run from org A as a **service** target so it can count
   (`iwik run --protocol inference-api/latency@1 --target http://127.0.0.1:8089
   --target-kind service --context model.requested=stub-model --context
   concurrency=1 --context cache_disabled=true --context client_region=local`,
   then `iwik preview <run_id> && iwik submit <run_id>`). Note the run id (R1).
   - Expect the receipt to read `"status": "accepted"`.
4. Set `IWIK_FEATURE_DEDUPE=on` on the deployment and restart it. Start the
   worker if it is not running (`node packages/service/dist/worker.js`; `--once`
   does one pass).
   - Expect `/` to show **Dedupe** `enabled`. The worker's first pass logs
     `job done` with `"kind":"reap_previews"` only: the run from step 3 already
     carries its index projection, so no `index_backfill` job is scheduled.
5. `curl ... "?protocol_ref=inference-api/latency@1&filter.client_region=local"`.
   - Expect `200` and exactly
     `{"protocol_ref":"inference-api/latency@1","filters":{"client_region":"local"},"orgs":"<3","runs":"<5","max_org_share":">50%","evidence_revision":<N>}`.
     No exact number, no organization name or ref, no run id anywhere in the body.
6. Submit the **same** run body again from org A with a fresh id. (`iwik run`
   with identical arguments measures again, and a fresh measurement has a
   different `result`, so it is rightly a new contribution; a duplicate is the
   same measurement uploaded twice.) Copy the vault directory
   `$IWIK_HOME/vault/<R1>` to `$IWIK_HOME/vault/<NEW>` where `<NEW>` is a
   fresh ULID, set `run_id` to `<NEW>` and `attempt_id` to another fresh ULID
   in the copy's `run.draft.json`, then `iwik preview <NEW> && iwik submit <NEW>`
   (preview signs the draft).
   - Expect the receipt to read `"kind": "intake"`, `"status": "duplicate"` and
     `"duplicate_of": "<R1>"`. **Evidence revision** on `/` does not move.
   - Repeat step 5: the body is unchanged (`runs` still `<5`).
7. Submit the same body from org B (`$TOKEN_B`, its own node id in `node_id`,
   signed with B's key: `iwik init` a second home for B and submit the copied
   file from there).
   - Expect `"status": "accepted"` (across organizations it is not a duplicate).
   - Repeat step 5: still `"orgs":"<3"` — a shared source is one contributor,
     not two — and `"runs":"<5"` (both rows count as runs).
8. `curl ... "?protocol_ref=inference-api/latency@1&filter.max_tokens=64"`.
   - Expect `422` with `{"error":{"code":"validation_failed","details":[{"path":"/filter.max_tokens","rule":"not_indexed"}]}}`:
     only `required_context` keys are ever projected, so only they can filter.
     `filter.client_region=AKIA...` style values are never echoed back.
9. `curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN_A" "<base>/v1/admin/cohorts?protocol_ref=inference-api/latency@1"`.
   - Expect `401`: a node token is not an operator.
10. Backfill: with `psql`, `UPDATE evidence.runs SET index_version = NULL WHERE run_id = '<R1>'`
    (simulates a row that predates the migration), then run
    `node packages/service/dist/worker.js --once`.
    - Expect a `job done` line with `"kind":"index_backfill"`, `"projected":1`,
      `"failed":0`, and the row to read `index_version = 1` again with the same
      `measurement_digest` as before. The log line never contains a run body.
11. Set `IWIK_FEATURE_DEDUPE=off` again and restart.
    - Expect step 2's `404` to return, and a further submission of the copied
      body from org A to be `"status": "accepted"` (intake behaves as before),
      while `SELECT index_version, measurement_digest FROM evidence.runs` shows
      the projection still written for the new row.

## What must not happen

- The operator view never contains an exact count, a share as a number, an
  `org_ref`, an organization name, a `run_id`, or a `node_id`.
- `duplicate_of` only ever names a run of the receipt's own organization.
- A `422` never echoes a filter value.
- A fixture run (`--target-kind fixture`, the default in `smoke/runner.md`)
  never changes the cohort view: repeat step 5 after submitting one and the
  body is unchanged.
