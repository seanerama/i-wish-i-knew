# I Wish I Knew — agent skill

You are talking to a member node of a confidential evidence cooperative through
`iwik mcp`. Ten tools, one envelope: `{ ok: true, data }` or
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

- **applicability**: how many required context keys matched. A partial match
  means the cohort resembles the user's situation; it is not the user's
  situation. Say which keys did not match.
- **cohort**: `orgs` and `runs` are ranges, never exact counts below the
  threshold. "3-5 organizations, 6-10 runs" is small evidence; say so.
- **uncertainty**: the spread across contributing runs. Quote the spread, not
  a single pooled number. If `uncertainty.kind` is `range`, the answer is a
  range.
- **freshness**: `newest_run_at` and `evidence_revision`. Old evidence about a
  fast-moving service may be stale; `status: "stale"` on re-read means the
  cohort has changed (a withdrawal or a new revision) and the number should no
  longer be quoted.
- **missingness** and **limitations**: what the contributors did not know and
  what the calculation excluded. Carry these into your answer.
- **contradictions**: runs that disagree are listed, not averaged away.

A receipt never names another organization's run, node, or org; do not try to
infer who contributed.

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

`challenge_finding`, `report_outcome`, and `withdraw_contribution` answer
`not_yet_available` until milestone 0.3; do not promise them.

## How to explain a suppressed or insufficient answer

- `insufficient_evidence` with `no_cooperative_evidence`: "No member has shared
  a comparable measurement yet." Offer the local test path above.
- `suppressed` with `min_orgs`, `concentration`, or `differencing`: "Evidence
  exists but releasing it could expose a contributor." Explain that fewer than
  three organizations, one organization dominating, or a query that differs
  too little from a prior release are all withheld by design. Broadening the
  context filters may help; narrowing them will not.
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
