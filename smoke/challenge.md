# UI smoke: challenge and outcome ledger (stage 10)

Observably-works check for `POST /v1/challenges`, `POST /v1/outcomes`, the
operator resolve endpoint, the operator console at `/admin/challenges`,
`iwik challenge` / `iwik predict` / `iwik outcome`, and the MCP tools
`challenge_finding`, `register_prediction`, `report_outcome`, against a
deployment (staging per `STATUS.md`, or a local `docker compose up`). Proves
brief R9 and R10: a member challenges a released finding with structured
grounds and the operator resolves it through a recorded process that moves
the evidence revision; a prediction is registered before its outcome and the
observation can never alter it; nothing in the ledger names another
organization's runs, and filing many objections suppresses nothing.

Prerequisites: everything `smoke/query.md` needs (a released cooperative
answer: three enrolled organizations with runs on
`inference-api/latency@1` under the same `client_region`,
`IWIK_FEATURE_COOPERATIVE_QUERY=on`), `IWIK_OPERATOR_TOKEN` set on the
deployment, a token of the first organization carrying `query` and
`publish`, and the runner initialized against it
(`iwik init --service <base url> --token-file <file>`). Use a throwaway
home: `export IWIK_HOME=$(mktemp -d)` and
`alias iwik='node packages/runner/bin/iwik.cjs'`.

## Steps

1. With `IWIK_FEATURE_CHALLENGE` unset (the default), open `/`.
   - Expect **Challenge ledger** to read `disabled (IWIK_FEATURE_CHALLENGE=off)`.
2. `curl -s -o /dev/null -w '%{http_code}\n' -X POST <base>/v1/challenges -H 'content-type: application/json' -d '{}'`
   (no token on purpose), then the same for `/v1/outcomes`, then
   `curl -s -o /dev/null -w '%{http_code}\n' <base>/admin/challenges`.
   - Expect `404` three times; the JSON bodies are
     `{"error":{"code":"feature_disabled",...}}`. The same with a valid
     token, and the operator token on
     `POST /v1/admin/challenges/<any>/resolve`, is still `404`.
3. Set `IWIK_FEATURE_CHALLENGE=on` on the deployment and restart it.
   - Expect `/` to show **Challenge ledger** `enabled` and the service log
     line `service ready` with `"challenge":"enabled"`.
4. Ask the cooperative as the first organization
   (`iwik report --cooperative --protocol inference-api/latency@1 --context client_region=<region> --json`)
   and note the `receipt_id` and, under `result.findings[]`, each
   `claim_id` (new in stage 10, one per released finding). Note the
   **Evidence revision** on `/` (call it R).
   - Expect `status: released` and a `claim_id` on every finding with
     `status: released`; withheld findings have none.
5. **Register a prediction before acting**:
   `iwik predict --receipt <receipt_id> --target latency_distribution.ttft_ms.p95 --below 300 --unit ms --horizon <a date next month> --rule own_measurement --probability 0.7`.
   - Expect stderr `prediction registered at <timestamp>: ... horizon
     <date>, rule own_measurement; it cannot be changed; report the outcome
     later with iwik outcome <prediction id>` and one ULID (the prediction
     id) on stdout. The same command with `--horizon 2020-01-01` exits `5`
     with `validation_failed` naming `/prediction/horizon minimum`.
6. `iwik challenge <receipt_id> --grounds replication_failed --claim latency_distribution --statistic p95 --direction higher --replication-run <one of YOUR run ids> --note "our node measured a higher p95"`.
   - Expect stderr `challenge filed: open, grounds replication_failed,
     target receipt; the operator resolves it ...` and one ULID (the
     challenge id) on stdout. `/` still shows **Evidence revision** `R`:
     filing changes no evidence.
   - Repeat with `--replication-run <a run id of ANOTHER organization>` (ask
     its operator for one): exit `5`, `not_found`, and the response names no
     run id. Repeat with `--note "$(printf 'x%.0s' $(seq 501))"`: exit `2`
     with `/statement/note maxLength`, nothing sent. Repeat with
     `--note "password: hunter22"`: exit `5` with
     `validation_failed` naming `/statement/note secret_pattern` and the
     value nowhere in the response.
7. `curl -s <base>/v1/challenges/<challenge_id> -H "Authorization: Bearer $TOKEN"`.
   - Expect the challenge (`status: open`, your `grounds`, your
     `statement`). With a token of the **second** organization the same URL
     is `404 not_found`.
8. File four more challenges against the same receipt (any grounds), then a
   sixth.
   - Expect the sixth to exit `5` with `rate_limited: ... (HTTP 429)`; `curl`
     shows a `Retry-After` header of at most `86400`. The first five still
     read `open` at step 7's URL; the second organization can still file.
9. Operator console: open `/admin/login`, submit a wrong token five times,
   then the right one.
   - Expect `That operator token was not recognized.` for the wrong ones, a
     `429` on the sixth attempt from that address within a minute, and
     after waiting a minute the right token lands on `/admin/challenges`
     listing the open challenges with their **grounds** and **target** kind
     (`receipt`) only: no note, no receipt id, no organization name, no run
     id anywhere on the page. Opening `/org` in the same browser still asks
     for a member sign-in: an operator session is not a member session.
10. On the first challenge: click **Acknowledge**; then choose resolution
    `upheld (contradicts)`, rationale `replication_failed`, leave the
    confirmation unticked, **Resolve**.
    - Expect the notice *Challenge acknowledged*, then the error *Tick the
      confirmation box to resolve*. Tick it and resolve again: the notice
      *Challenge resolved ...* and the challenge gone from the list. `/`
      shows **Evidence revision** `R+1`.
11. `iwik receipt <receipt_id from step 4>`.
    - Expect `"status": "stale"` and every other field unchanged (same
      `evidence_revision: R`, same findings and `claim_id`s, nothing naming
      the challenge or what changed). Step 7's URL now shows
      `status: resolved`, `resolution: upheld`, a `relationship_id`, and
      `resolved_revision: R+1`.
12. Resolve the same challenge again through the API:
    `curl -s -X POST <base>/v1/admin/challenges/<challenge_id>/resolve -H "Authorization: Bearer $IWIK_OPERATOR_TOKEN" -H 'content-type: application/json' -d '{"resolution":"rejected","relationship":{"kind":"narrows","rationale":"insufficient_grounds"}}'`.
    - Expect `409 challenge_resolved` and **Evidence revision** unchanged
      at `R+1`. With `"kind":"supersedes"` on an open challenge expect `422`
      naming `/relationship/kind resolution_kind`.
13. `iwik outcome <prediction id from step 5> --result not_met --environment-changed --receipt <receipt_id>`.
    - Expect stderr `outcome recorded: not_met (environment changed);
      prediction registered <timestamp> is unchanged` and one ULID on
      stdout. Run it again with `--result met`: exit `5`, `outcome_exists`.
      Run it with `--receipt <a different receipt id of yours>`: exit `5`,
      `target_mismatch`. Nothing about the prediction changed: the same
      `registered_at`, target, and horizon come back in every response that
      carries it.
14. Attach the MCP adapter (`smoke/mcp.md` step 4) and ask the agent: "Before
    I switch providers, record that I expect the p95 of ttft to stay below
    300 ms for the next month based on receipt <receipt_id>, then challenge
    the receipt on method grounds."
    - Expect the agent to call `register_prediction` first (SKILL.md: before
      acting), returning a `prediction_id`, then `challenge_finding` with
      `grounds.kind: "method"` and a short `rationale`, returning a
      `challenge_id` with `status: open`. A `challenge_finding` with
      `grounds.kind: "vibes"` never reaches the service: `ok: false`,
      `validation_failed`, `next_step` listing the five grounds. With
      `IWIK_FEATURE_CHALLENGE=off` every ledger tool answers `ok: false`,
      `code: feature_disabled`, and a `next_step` naming the flag.
15. Cleanup: `rm -rf $IWIK_HOME`; leave `IWIK_FEATURE_CHALLENGE` as the
    deployment wants it.

## Pass criteria

Steps 1-14 behave as stated. Any run id, node id, `org_ref`, or
organization name of another organization appearing in a challenge, claim,
prediction, or outcome response, on the operator page, or in an error body
is a failure. A challenge that changes a receipt without an operator
resolution, a resolution that does not move the evidence revision or leave
the earlier receipt `stale`, a sixth challenge in a day that is accepted, or
an observation that alters any field of the registered prediction is a
failure.
