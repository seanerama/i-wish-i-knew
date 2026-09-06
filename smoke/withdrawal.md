# UI smoke: withdrawal and stale receipts (stage 7)

Observably-works check for `POST /v1/withdrawals`, the console withdraw form
on `/org`, `iwik withdraw`, the MCP `withdraw_contribution` tool, and the
worker job loop, against a deployment (staging per `STATUS.md`, or a local
`docker compose up`). Proves ADR-0002 §6: a member withdraws its own runs,
the withdrawal takes effect at the next evidence revision, earlier query
receipts read `stale` without saying what changed, and nobody can withdraw
(or learn about) another organization's runs.

Prerequisites: Node 22, the repository built (`npm ci && npm run build`),
`IWIK_FEATURE_ENROLLMENT=on` and `IWIK_FEATURE_INTAKE=on` on the deployment,
an enrolled organization with a console password (`smoke/enrollment.md`), a
node registered from that console with a token carrying `query`, `submit`,
and `publish`, and the runner initialized against it
(`iwik init --service <base url> --token-file <file>`). Use a throwaway
home: `export IWIK_HOME=$(mktemp -d)` and
`alias iwik='node packages/runner/bin/iwik.cjs'`.

## Steps

1. With `IWIK_FEATURE_WITHDRAWAL` unset (the default), open `/`.
   - Expect **Withdrawal** to read `disabled (IWIK_FEATURE_WITHDRAWAL=off)`.
2. `curl -s -o /dev/null -w '%{http_code}\n' -X POST <base>/v1/withdrawals -H 'content-type: application/json' -d '{}'`
   (no token on purpose).
   - Expect `404`; the body is `{"error":{"code":"feature_disabled",...}}`.
     The same with a valid token is still `404 feature_disabled`.
3. Sign in to `/org` with the console password.
   - Expect a **Runs** section listing the organization's contributed runs
     (run id, protocol, status, sharing, received with its revision,
     withdrawn) and the note `Withdrawal is disabled on this deployment
     (IWIK_FEATURE_WITHDRAWAL=off)`; no checkboxes, no withdraw button.
4. Set `IWIK_FEATURE_WITHDRAWAL=on` on the deployment and restart it. Also
   start the worker if it is not running: `node packages/service/dist/worker.js`
   (in the image: the same image with that command; `--once` does one pass).
   - Expect `/` to show **Withdrawal** `enabled` and the worker's first log
     line `worker started` with `"mode":"loop"`, then `job done` with
     `"kind":"reap_previews"`.
5. Contribute three runs from the runner (each: `iwik run --protocol
   inference-api/latency@1 --target http://127.0.0.1:8089 --target-kind fixture
   --context model.requested=stub-model --context concurrency=1 --context
   cache_disabled=true --context client_region=local` against the stub from
   `smoke/mcp.md` step 1, then `iwik preview <run_id> && iwik submit <run_id>`).
   Note the three run ids and the **Evidence revision** on `/` (call it R).
6. Ask the cooperative a question so a query receipt exists:
   `curl -s -X POST <base>/v1/evidence/query -H "Authorization: Bearer $TOKEN" -H 'content-type: application/json' -d '{"protocol_ref":"inference-api/latency@1","context_filters":{"concurrency":1}}'`.
   - Expect `status: insufficient_evidence` and `evidence_revision: R`. Note
     the `receipt_id`.
7. `iwik withdraw <run_id_1> <run_id_2> --reason member_request`.
   - Expect stderr `withdrawal recorded: 2 run(s), reason member_request,
     effective at evidence revision R+1` and one ULID (the withdrawal id) on
     stdout. Neither run id appears in the service response
     (`iwik withdraw` prints only the count).
   - `/` now shows **Evidence revision** `R+1` (one increment for the set).
8. Run the same command again, ids in the other order.
   - Expect `already withdrawn: 2 run(s) ...` and the same withdrawal id; the
     evidence revision does not move.
9. `iwik receipt <receipt_id from step 6>`.
   - Expect `"status": "stale"` and every other field unchanged (same
     `evidence_revision: R`, same cohort, no list of runs, nothing naming
     what was withdrawn).
10. `curl -s <base>/v1/runs/<run_id_1> -H "Authorization: Bearer $TOKEN"`.
    - Expect `withdrawn_at` and `withdrawn_revision: R+1`; `run_id_3` has
      neither field.
11. Reload `/org`.
    - Expect runs 1 and 2 marked `withdrawn <time> (revision R+1)` with no
      checkbox, run 3 with a checkbox. Tick run 3, choose a reason, leave the
      confirmation box unticked, and submit.
    - Expect the page to come back with the error *Tick the confirmation box
      to withdraw* and run 3 still not withdrawn.
    - Tick the confirmation box and submit again.
    - Expect the notice *Withdrawal recorded* and run 3 marked withdrawn at
      revision `R+2`.
12. With a token of a **second** organization, attempt
    `iwik withdraw <run_id_3> --reason data_error`.
    - Expect exit status `5` and `iwik: api_error: not_found: resource not
      found (HTTP 404)`; nothing about run 3 changes and the error names no
      run id.
13. Attach the MCP adapter (`smoke/mcp.md` step 4) and ask the agent:
    "Withdraw run <a run id contributed by this node> with reason data_error."
    - Expect the agent to confirm first (SKILL.md), then `ok: true` with a
      `withdrawal_id` and `effective_revision`. With
      `IWIK_FEATURE_WITHDRAWAL=off` the same call answers `ok: false`,
      `code: feature_disabled`, and a `next_step` naming the flag; nothing is
      withdrawn.
14. Worker: check the journal (or `docker logs`) of the worker.
    - Expect a `job done` line with `"kind":"withdrawal_apply"` per
      withdrawal (`"marked":0` when the API already marked the runs, and
      `"evicted":0` while `evidence.cache` is empty), and no `job failed`
      lines. Stop the worker with SIGTERM: expect `worker stopping` then
      `worker stopped` and exit status 0.
15. Cleanup: `rm -rf $IWIK_HOME`; leave `IWIK_FEATURE_WITHDRAWAL` as the
    deployment wants it.

## Pass criteria

Steps 1-14 behave as stated. Any run id of another organization, any
`org_ref`, or any hint of *which* run in a rejected set was foreign appearing
in a response is a failure. A withdrawal that takes effect without a revision
increment, or a query receipt from before the withdrawal that does not read
`stale`, is a failure.
