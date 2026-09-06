# UI smoke: the cooperative evidence query (stage 9)

Observably-works check for `POST /v1/evidence/query` behind
`IWIK_FEATURE_COOPERATIVE_QUERY`, through `iwik report --cooperative`, the MCP
tool `query_evidence`, and the console receipt page `/receipts/<id>`, against
a deployment (staging per `STATUS.md`, or a local `docker compose up`). Proves
brief §3 step 3 ("answer conditionally"), ADR-0002 thresholds and fixed cohort
releases, ADR-0003 matching, and brief minimum demonstrations 3 (a
contradiction stays visible with no invented cause) and 5 (private records are
absent from other members' answers).

Prerequisites: Node 22, the repository built (`npm ci && npm run build`),
`IWIK_FEATURE_INTAKE=on`, `IWIK_FEATURE_ENROLLMENT=on`, `IWIK_FEATURE_DEDUPE=on`
on the deployment, `IWIK_OPERATOR_TOKEN` set, **three** enrolled organizations
(`smoke/enrollment.md`) each with a node token carrying `query` and `submit`
(`$TOKEN_A`, `$TOKEN_B`, `$TOKEN_C`) and a runner home initialized for each
(`iwik --home $HOME_A init --service <base url> --token-file <file>` and so
on). Use throwaway homes and `alias iwik='node packages/runner/bin/iwik.cjs'`.
Run the stub target from `smoke/mcp.md` step 1 on `127.0.0.1:8089`.

A run against the stub with `--target-kind fixture` is never releasable
(ADR-0003), so every contribution below uses `--target-kind service` and
`--share cooperative`; the stub is the endpoint under test.

## Steps

1. With `IWIK_FEATURE_COOPERATIVE_QUERY` unset (the default), open `/`.
   - Expect **Cooperative query** to read
     `disabled (IWIK_FEATURE_COOPERATIVE_QUERY=off)`.
2. `iwik --home $HOME_A report --cooperative --protocol inference-api/latency@1 --context client_region=smoke`
   - Expect exit 0, stderr `insufficient_evidence: no_cooperative_evidence (receipt <id>)`,
     and stdout starting `# Cooperative evidence: insufficient_evidence` with
     the `Why nothing cooperative was released` section and
     `_Your organization has no runs for this protocol._`. This is the stage 5
     stub answer: the flag is off.
3. Contribute two runs from each organization (six in all), each as a
   service target with cooperative sharing and the same region:
   `iwik --home $HOME_A run --protocol inference-api/latency@1 --target http://127.0.0.1:8089 --target-kind service --share cooperative --context model.requested=stub-model --context concurrency=1 --context cache_disabled=true --context client_region=smoke --planned 12`
   then `iwik --home $HOME_A preview <run_id> --share cooperative && iwik --home $HOME_A submit <run_id>`;
   repeat once more for A and twice each for B and C. Note one of A's run ids (R_A).
   - Expect every receipt to read `"status": "accepted"` and
     `"sharing_policy": "cooperative"`. (Two runs with identical results would
     be a duplicate; the stub's timings differ per run, so they are not.)
4. Set `IWIK_FEATURE_COOPERATIVE_QUERY=on` on the deployment and restart it.
   - Expect `/` to show **Cooperative query** `enabled`.
5. `iwik --home $HOME_A report --cooperative --protocol inference-api/latency@1 --context client_region=smoke`
   - Expect stdout starting `# Cooperative evidence: released`, `Cohort: 3-5
     organizations, 5-10 runs`, sections **Findings**, **Applicability**
     (`client_region` applied; the other five required keys listed as not
     filtered, each known by `5-10` runs), **Distributions** with a table per
     metric (`ttft_ms`, `total_ms`, `error_rate`) whose `n` column reads `5-10`
     and whose numbers are the spread across runs, **Uncertainty** (`Tail
     claims (minimum 20 runs): not supported`), **Freshness** (two dates, no
     timestamps), **Contradictions** (either the fixed sentence ending
     `a controlled comparison under a registered protocol would.` or
     `_No contributing organizations disagree..._`), **Missing-data
     accounting**, **Limitations**, and **Your own evidence** listing exactly
     A's two run ids with `in cohort: yes`.
   - Search the whole output for B's and C's run ids, node ids, and
     organization names: none may appear. No integer between 2 and 10 appears
     outside your own evidence table (counts are bands).
6. Repeat step 5 with `--json`; copy `receipt_id`. Sign in to the console as
   organization A and open `/receipts/<receipt_id>`.
   - Expect the same sections rendered (`Status: released`, cohort `3-5` /
     `5-10`, distribution tables, contradictions, own evidence with A's ids)
     and the receipt JSON at the bottom. `/org` lists the receipt under
     **Answer receipts** with a link.
   - Open the same URL signed in as organization B: expect a 404 page
     `Receipt not found`.
7. Narrow the query: add `--context retry_policy=none` (every run has it).
   - Expect `released` again: the cohort is the same three organizations, a
     repeat, not a differencing attack. Now add `--context concurrency=2`
     instead: expect `insufficient_evidence` with `no_cooperative_evidence`
     (no run matches) and your own evidence listing A's runs with
     `filter_mismatch`.
8. Contribute a seventh run from a fourth organization D (enroll it first)
   in the same region, then query as A again.
   - Expect `suppressed` with `differencing` and cohort `3-5` / `5-10`: the
     cohort would differ from the prior release by one organization. The MCP
     tool says the same: `IWIK_MCP_ENABLED=on iwik --home $HOME_A mcp` and
     call `query_evidence` with `{"protocol_ref":"inference-api/latency@1","context_filters":{"client_region":"smoke"}}`;
     expect `ok: false`, `code: "suppressed"`, a message with `differencing`,
     and a `next_step` that says not to narrow further.
9. Withdraw R_A: `iwik --home $HOME_A withdraw R_A --reason data_error`, then
   `iwik --home $HOME_A receipt <receipt_id from step 6>`.
   - Expect `"status": "stale"` and nothing else changed in the receipt.
     `/receipts/<receipt_id>` reads `Status: stale`.
10. Query again as A with `--as-of <evidence_revision from the step 6 receipt>`.
    - Expect `released` with the same distributions as step 6 (the pinned
      cohort still includes R_A) and own evidence showing R_A `in cohort: yes`;
      without `--as-of`, R_A is listed with `withdrawn` and the cohort answer is
      whatever the current members allow.
11. Set `IWIK_FEATURE_COOPERATIVE_QUERY=off` again and restart.
    - Expect step 2's stub answer to return over the same evidence.

## What must not happen

- A released receipt, the console page, or the CLI output never contains
  another organization's `run_id`, `node_id`, `org_ref`, or name, an exact
  count below 11, a timestamp under freshness, or any free text from a run.
- A contradiction never says why two organizations differ: no "because",
  "caused", "due to".
- A `422` for a filter key outside `required_context` (`--context max_tokens=64`)
  reads `not_indexed` and never echoes the value.
- With the flag off nothing cooperative is ever computed or released.
