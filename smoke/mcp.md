# UI smoke: MCP adapter and local investigation (stage 5)

Observably-works check for `iwik mcp`, `iwik plan`, `iwik run --plan`, and
`iwik report` against a deployment (staging per `STATUS.md`, or a local
`docker compose up` with a seed identity). Proves the first-member story with
an empty commons: an agent asks, is told honestly that no shareable evidence
exists, plans the missing test, is refused execution until the operator
allows it, runs it, and reads a report that states its own limits.

Prerequisites: Node 22, the repository checked out and built
(`npm ci && npm run build`), a node token for the deployment with `query` and
`submit` scopes (for the seed identity `IWIK_SEED_NODE_TOKEN`; the seed's
`IWIK_SEED_NODE_PUBKEY` must be the key printed by `iwik init`), intake enabled
(`IWIK_FEATURE_INTAKE=on`), and an MCP client (Claude Code is used below; any
stdio MCP client works).

Use a throwaway home so the check never touches a real vault:
`export IWIK_HOME=$(mktemp -d)` and `alias iwik='node packages/runner/bin/iwik.cjs'`.

## Steps

1. Start the stub target: `node packs/inference-api/fixtures/stub-server/index.js --port 8089 --delay-ms 20 --error-rate 0.1`.
   - Expect one line `{"port":8089,"host":"127.0.0.1"}`.
2. `iwik init --service <base url> --token-file <file holding the node token>` (no `--node-id`).
   - Expect stderr `node id: <ulid> (from GET /v1/whoami; organization "<name>", scopes query, submit...)`
     and one base64 line on stdout. The token and `PRIVATE KEY` appear nowhere.
3. `iwik mcp`.
   - Expect exit status `3` and one stderr line starting
     `iwik: feature_disabled: iwik mcp is disabled: IWIK_MCP_ENABLED is not set`.
4. Attach the adapter to Claude Code (from the repository root):
   `claude mcp add iwik --env IWIK_MCP_ENABLED=on --env IWIK_HOME=$IWIK_HOME -- node packages/runner/bin/iwik.cjs mcp`,
   then start `claude` and run `/mcp`.
   - Expect the server `iwik` connected with ten tools: `get_protocol`,
     `query_evidence`, `plan_test`, `run_test`, `preview_contribution`,
     `submit_run`, `get_receipt`, `challenge_finding`, `report_outcome`,
     `withdraw_contribution`.
   - Expect the server instructions to begin with `# I Wish I Knew — agent skill`
     (the runner's `SKILL.md`).
5. Ask the agent: "Read protocol inference-api/latency@1 with get_protocol."
   - Expect `ok: true` with `ref`, `required_context` (six keys), and
     `permitted_claims` `latency_distribution`, `error_rate`.
6. Ask: "Query the cooperative for inference-api/latency@1 with concurrency 1 and model.reported stub-model."
   - Expect `ok: false`, `code: insufficient_evidence`, a message naming a
     receipt id and `no_cooperative_evidence`, and a `next_step` that proposes
     `plan_test`. The agent should say plainly that no member has shared a
     comparable measurement, not invent a number.
7. Ask: "Plan a local test of inference-api/latency@1 against http://127.0.0.1:8089 (a fixture) to answer 'how fast is the stub at concurrency 1?', with model.requested stub-model, concurrency 1, cache_disabled true, client_region local, 20 attempts."
   - Expect `ok: true` with a `plan_id`, `estimated_cost.amount` `0`,
     `required_context.unknown` listing `model.reported` and `retry_policy`,
     and `execution.allowed` `false` with `next_step` starting
     `iwik run --plan <plan_id>`. `ls $IWIK_HOME/plans` shows `<plan_id>.json`
     (`-rw-------`). The stub's `/__stub/stats` shows `"requests": 0`.
8. Ask: "Run it with run_test."
   - Expect `ok: false`, `code: policy_denied`, and `next_step`
     `iwik run --plan <plan_id> (the operator runs this on the node after: iwik policy set allow_execution true; iwik policy allow-target 127.0.0.1:8089)`.
     The stub still shows `"requests": 0`. The agent must hand you the command,
     not suggest editing `policy.json`.
9. In a shell: `iwik policy set allow_execution true && iwik policy allow-target 127.0.0.1:8089`, then ask the agent to call `run_test` again.
   - Expect `ok: true` with a `run_id`, `execution_status: succeeded`,
     `accounting.planned` `20`, `failed` equal to the stub's injected errors,
     `estimated_cost_usd` `0`, and `next_step` mentioning `iwik report <run_id>`.
     No local path appears in the output.
10. In a shell: `iwik report <run_id>`.
    - Expect the first line `# Local evidence only — not corroborated by the cooperative`,
      a **Runs** table with one succeeded row, **Claims** sections for
      `latency_distribution` (a p50/p90/p95/p99 table for `ttft_ms` and
      `total_ms`) and `error_rate`, **Missing context** empty, and
      **Limitations** noting the fixture target. `iwik report <run_id> --json`
      prints the same as JSON with `"scope": "local"`.
11. Ask: "Preview the contribution for that run, then submit it, then read the receipt."
    - Expect `preview_contribution` `ok: true` with `would_store.sharing_policy`
      `private` (fixture runs never join a cohort) and a `run` whose `target`
      has `kind` and `label_digest` only; `submit_run` `ok: true` with
      `status: 201`; `get_receipt` returning the same receipt.
12. Ask: "Withdraw that contribution."
    - With `IWIK_FEATURE_WITHDRAWAL` unset on the deployment (the default),
      expect `ok: false`, `code: feature_disabled`, and a `next_step` naming
      `IWIK_FEATURE_WITHDRAWAL`; nothing is withdrawn. With the flag on,
      expect the agent to confirm first, then `ok: true` with a
      `withdrawal_id` and `effective_revision` (`smoke/withdrawal.md`).
13. Cleanup: `claude mcp remove iwik`, stop the stub (Ctrl-C), `rm -rf $IWIK_HOME`.

## Pass criteria

Steps 2-12 behave as stated. Any token, private key, target URL, or local
path in a tool output is a failure. A `run_test` that executes anything
before step 9 is a failure.
