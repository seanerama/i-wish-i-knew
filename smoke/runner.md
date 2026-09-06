# UI smoke: runner (stage 3)

Observably-works check for the `iwik` runner against a deployment (staging per
`STATUS.md`, or a local `docker compose up` with a seed identity). Proves the
member half of the spine: `iwik run` against the stub, `iwik preview`,
`iwik submit`, then the console shows one more accepted run.

Prerequisites: Node 22, the repository checked out and built
(`npm ci && npm run build`), a node token for the deployment with `submit` and
`query` scopes and the matching node id (for the seed identity these are
`IWIK_SEED_NODE_TOKEN` and `IWIK_SEED_NODE_ID`; the seed's
`IWIK_SEED_NODE_PUBKEY` must be the key printed by `iwik init` below).
Intake must be enabled on the deployment (`IWIK_FEATURE_INTAKE=on`).

Use a throwaway home so the check never touches a real vault:
`export IWIK_HOME=$(mktemp -d)` and `alias iwik='node packages/runner/bin/iwik.cjs'`.

## Steps

1. Start the stub target: `node packs/inference-api/fixtures/stub-server/index.js --port 8089 --delay-ms 20 --error-rate 0.1`.
   - Expect one line `{"port":8089,"host":"127.0.0.1"}`.
2. `iwik init --service <base url> --token-file <file holding the node token> --node-id <node id>`.
   - Expect stdout to be exactly one base64 line (the public key) and stderr to
     list the home, service, node id, `token: stored`, `signing key: generated`,
     followed by the enrollment instructions `Enroll this node: sign in to the
     console at <base url>/org, then` with the same three steps the console's
     `/org` page shows (register the node with the base64 raw or PEM SPKI key,
     issue a scoped token, revoke when lost).
   - Expect the token value and `PRIVATE KEY` to appear nowhere in the output.
   - `ls -la $IWIK_HOME` shows `drwx------` for the home and `-rw-------` for
     `config.json`, `token`, `key.ed25519`, `policy.json`.
3. `iwik policy show`.
   - Expect `"allow_execution": false` and `"allowed_targets": []`.
4. `iwik run --protocol inference-api/latency@1 --target http://127.0.0.1:8089 --planned 20 --target-kind fixture --context model.requested=stub-model --context concurrency=1 --context cache_disabled=true --context client_region=local`.
   - Expect exit status `3` and exactly one stderr line starting
     `iwik: policy_denied:`. No `vault/<id>` directory appears.
5. `iwik policy set allow_execution true` and `iwik policy allow-target 127.0.0.1:8089`, then repeat the command from step 4.
   - Expect a stderr summary `run <run_id>: succeeded planned=20 attempted=20 ...`
     with `failed` equal to the stub's injected errors
     (`curl -s http://127.0.0.1:8089/__stub/stats` shows `"errors"`), and the
     `run_id` alone on stdout. Capture it: `RUN=<run_id>`.
   - `ls -la $IWIK_HOME/vault/$RUN` shows `run.draft.json`, `vault.json`,
     `input.json`, `stdout`, `stderr`, `attempts.jsonl`, `result.json`,
     `context.json`, all `-rw-------`, in a `drwx------` directory. No `run.json` yet.
6. `iwik submit $RUN`.
   - Expect exit status `6` and one line `iwik: preview_required: ...`.
7. `iwik preview $RUN`.
   - Expect stderr with `preview <id> (expires ...)`, `content digest: sha256:...`,
     a `sanitization:` line listing `secret_pattern` and `string_too_long`, and a
     `would store:` line with `"sharing_policy":"private"` (fixture targets are
     never shared); stdout is the JSON body with `"run"` whose `target` has
     `kind` and `label_digest` only (no URL) and whose `submission.signature`
     is set. `$IWIK_HOME/vault/$RUN/run.json` and `preview.json` now exist.
8. `iwik submit $RUN`.
   - Expect stderr `accepted (201)` and a receipt JSON on stdout with
     `"status": "accepted"` and a `receipt_id`. Capture it: `RECEIPT=<id>`.
9. `iwik submit $RUN` again.
   - Expect stderr `already accepted (200)` and the identical receipt.
10. `iwik receipt $RECEIPT`.
    - Expect the same receipt JSON.
11. Open the console `/`, paste the node token into **Node token**, sign in.
    - Expect **Accepted runs** one higher than before step 8 and **Last receipt**
      equal to `$RECEIPT`; **Evidence revision** one higher than before.
12. Cleanup: stop the stub (Ctrl-C), `rm -rf $IWIK_HOME`.

## Pass criteria

Steps 2-11 behave as stated. Any token or private-key material in any output
is a failure. A `harness_digest_mismatch` at step 5 means the checked-out pack
differs from the deployment's registry: check out the deployed revision.
