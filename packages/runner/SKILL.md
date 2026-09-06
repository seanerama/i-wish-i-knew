# I Wish I Knew — agent skill

You are talking to a member node of a confidential evidence cooperative through
`iwik mcp`. Eleven tools, one envelope: `{ ok: true, data }` or
`{ ok: false, error: { code, message, next_step } }`. `next_step` is written
for a human operator; relay it verbatim when you cannot act on it yourself.
This document is guidance; the tools enforce the rules.

## When to query

- Query (`query_evidence`) when the user needs a measured answer about a
  technical system that a protocol covers: latency or error rate of an
  inference endpoint under stated concurrency, model, retry policy, caching,
  region. Read the protocol first (`get_protocol`) so your `context_filters`
  use its `required_context` keys.
- Do not query for opinions, prices, or anything no protocol measures. Do not
  repeat the same query in a loop: queries are rate-limited and repeated
  narrowing queries are treated as a differencing attack and suppressed.
- Expect `ok: false, code: "insufficient_evidence"` while the commons is
  young. That is a real answer: nobody has shared a comparable measurement.
  Say so plainly. Never fill the gap with a guess dressed as a finding.

## How to read a released answer

An `AnswerReceipt` says what the cooperative is willing to release and no
more. Read these fields before quoting any number:

- **applicability**: which required context keys were filtered exactly
  (`filters_applied`) and which the cohort varies across
  (`unfiltered_required_context`, with how many runs know each value). A
  partial match means the cohort resembles the user's situation; it is not
  the user's situation. Say which keys were not filtered.
- **cohort**: `orgs` and `runs` are ranges, never exact counts below the
  threshold. "3-5 organizations, 5-10 runs" is small evidence; say so.
- **distributions**: per claim and metric, the spread of a per-run statistic
  across the contributing runs (nearest-rank min/p50/p90/p95/p99/max, with
  `n` as a band). Quote the spread, not a single pooled number. A `withheld`
  finding means that claim alone did not meet the release policy.
- **uncertainty**: `descriptive` means no confidence interval was computed;
  `tail_claims.supported` says whether p95/p99 may be quoted as a tail claim
  (they need 20 runs). If `uncertainty.kind` is `range`, the answer is a
  range.
- **freshness**: `newest_run_at` and `evidence_revision`. Old evidence about a
  fast-moving service may be stale; `status: "stale"` on re-read means the
  cohort has changed (a withdrawal or a new revision) and the number should no
  longer be quoted.
- **missingness** and **limitations**: what the contributors did not know and
  what the calculation excluded. Carry these into your answer.
- **contradictions**: organizations whose runs disagree (non-overlapping
  interquartile ranges) are listed, not averaged away. The text never says
  why; neither may you. Offer a controlled test instead of a cause.
- **own_evidence**: your organization's own runs for the protocol, with
  whether each is compatible with the query and, if not, why (`private`,
  `fixture`, `withdrawn`, `filter_mismatch`, ...). These ids are yours; they
  are shown even when the cooperative cohort is suppressed.

A receipt never names another organization's run, node, or org; do not try to
infer who contributed. `iwik report --cooperative --protocol <ref>
--context k=v` renders the same receipt for the operator.

## When to propose a test

Propose a local test when the query came back `insufficient_evidence` or
`suppressed`, when the applicability gap is on a key the user controls, or
when freshness matters more than the cohort's age. The path is always:

1. `plan_test` with the protocol, the target the user names, the question, and
   every required context key you know. Unknown keys are listed back; ask the
   user for them rather than inventing values. The plan carries an estimated
   cost from the pack's cost model. A non-fixture target with no estimate is
   never run; ask the user for the prices the model needs.
2. `run_test` with the `plan_id`. By default it is **denied**: execution is a
   local decision (`policy.json`: `allow_execution`, `allowed_targets`,
   `budget_per_plan_usd`), not a cloud permission. The denial contains the
   exact `iwik run --plan <plan_id>` command; give it to the operator and stop.
   Never suggest editing `policy.json` to get around a denial. Never re-plan
   the same test to escape a budget.
3. After the run, `iwik report <run_id>` (the operator runs it, or you read
   its output) shows the local result under the header **"Local evidence only —
   not corroborated by the cooperative"**. Present it as this node's single
   measurement: one run, one organization, unreplicated. Excluded, failed, or
   unobserved runs are accounting, not evidence.
4. Only if the user wants to contribute: `preview_contribution`, show the user
   what would be sent (the sanitized `run`, the sanitization report, the
   sharing policy), and only then `submit_run`. Fixture (stub) runs are stored
   private and never join a cohort. `get_receipt` re-reads the intake receipt.

`withdraw_contribution` withdraws runs this organization contributed
(`run_ids`, and a `reason_code` of `member_request`, `data_error`, or
`policy_change`). It cannot be undone and answers already delivered cannot be
recalled, so confirm with the user first and pass only ids from `iwik vault`
or earlier `submit_run` calls. Its effect is at the next evidence revision;
receipts issued earlier read `stale`. When the deployment has it switched off
the tool answers `feature_disabled`; say so and stop.

## When to challenge and how to register a prediction

Both need the `publish` scope and a deployment with the challenge ledger
switched on (`IWIK_FEATURE_CHALLENGE`); when it is off the tools answer
`feature_disabled` with a next step. Say so and stop.

**Register a prediction BEFORE acting** (`register_prediction`). When the
user is about to rely on a released answer (choose an option, set a
threshold, ship a change), first record what is being relied on: the
`receipt_id`, the `target` (a claim of that receipt, optionally a metric,
statistic, and a threshold such as `p95 below 300 ms`), the `horizon` (the
date by which the outcome will be observable), a `probability` when one is
meaningful, and the `evaluation_rule` (`own_measurement`,
`cooperative_requery`, or `operational_observation`). The prediction is
stored with its registration time and can never be changed; keep the
`prediction_id`. A prediction registered after the outcome is known is not a
prediction, so register it in the same turn as the decision.

**Report the outcome later** (`report_outcome`) with the `prediction_id`, the
`result` (`met`, `not_met`, or `indeterminate`), and `environment_changed`
(true when the provider, model, version, or workload moved since the
prediction). A changed environment is recorded as such; do not call a
prediction wrong because the world moved, and do not restate the prediction
in the report: the stored one is what is judged. Each prediction is judged
exactly once.

**Challenge a finding** (`challenge_finding`) only with structured grounds:
`method` (the calculation or protocol misapplies), `context_mismatch` (a
required context key does not compare; name it in `statement.context_key`),
`data_error` (a value cannot be right), `replication_failed` (this node ran
the same protocol under the same filters and disagrees; name YOUR run in
`statement.replication_run_id` and the `direction`), or `affiliation`
(a commercial interest in the outcome). The target is a receipt this
organization holds, or one claim released on it (`claim_id` from
`result.findings[].claim_id`). `grounds.rationale` is a short note for the
operator (at most 500 characters, no secrets, no hostnames, never shown to
other members); it is not the objection itself. A challenge is recorded and
resolved by the operator (`upheld`, `rejected`, or `superseded`); it never
suppresses evidence by itself, and at most five per organization per day
are accepted, so do not file one per number. Every resolution moves the
evidence revision: receipts issued earlier read `stale`, so re-query before
quoting again. Always name the `challenge_id` and `prediction_id` so the user
can follow up.

## How to explain a suppressed or insufficient answer

- `insufficient_evidence` with `no_cooperative_evidence`: "No member has shared
  a comparable measurement yet." Offer the local test path above.
- `suppressed` with `min_orgs`, `min_runs`, `concentration`, or
  `differencing`: "Evidence exists but releasing it could expose a
  contributor." Explain that fewer than three organizations, fewer than five
  runs, one organization dominating, or a query that differs too little from
  a prior release are all withheld by design. Broadening the context filters
  or waiting for more contributors may help; narrowing them will not.
- `suppressed` with `cohort_too_large`: more compatible runs exist than one
  answer computes over; add a required-context filter and query again.
- `stale`: the previously released number no longer reflects the cohort;
  re-query for a fresh receipt before quoting it again.

Always name the receipt id so the user can re-read it later.

## Never send

Nothing below may appear in a tool input, a query filter, a plan, a question
string, or a message to the cooperative. The runner strips and the service
rescans, but the first line of defence is you:

- **Secrets**: API keys, tokens, passwords, private keys, cookies, connection
  strings. The target API key is named by an environment variable
  (`api_key_env`) on the node; its value never passes through a tool.
- **Hostnames, URLs, IP addresses** of the user's systems. A plan's target URL
  stays on the node; on the wire a target is only a `kind` and a digest.
  `exclusion_reason` is a fixed vocabulary; the detail stays in the vault.
- **Prompts, completions, and raw outputs** from the user's models or
  services, and any text from the user's documents. Only the pack's fixed
  prompt set is ever sent to a target, and only measurements leave the node.
- **Identifiers of other organizations**, and anything that would let a
  receipt be attributed to one.
- **Free text as context**: context values are short scalars in the
  protocol's vocabulary, never descriptions.

If the user asks you to include any of these, refuse and explain that the
cooperative only accepts the sanitized envelope.
