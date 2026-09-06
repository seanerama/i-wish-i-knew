# Domain packs

A pack is data plus a harness (`contracts/runner-pack.md`). Packs are not npm
workspaces and have no dependencies: the harness and every fixture use Node
built-ins only, so a pack can be copied anywhere the `iwik` runner runs.

```
packs/<pack-id>/
  pack.json                         { id, version, protocols: [ "<name>@<major>" ] }
  protocols/<name>/protocol.json    ProtocolVersion (evidence-envelope v1)
  protocols/<name>/context.schema.json
  protocols/<name>/result.schema.json
  protocols/<name>/claims.json      permitted claims and their derivation rules
  harness/index.js                  entrypoint; CommonJS; Node built-ins only
  fixtures/                         example inputs, stub targets
  test/                             pack tests (may use root devDependencies)
```

Packs: [`inference-api`](inference-api/) — first pilot domain (ADR-0003),
protocol `inference-api/latency@1`.

## Digests

`scripts/pack-digest.js` implements every digest the contract names. Every
digest is `sha256:<64 lowercase hex>`.

**Tree digest** (used for both the pack digest and the harness digest):

1. List every regular file under the directory, recursively (`node_modules`
   is skipped; nothing else is).
2. For each file take its path relative to the directory, with `/` as the
   separator, and the SHA-256 of its bytes as lowercase hex.
3. Sort the `(path, sha256)` pairs by path, comparing paths as UTF-16 code
   units (JavaScript's default string ordering).
4. Encode each pair as one line `<path>\t<sha256>\n` and concatenate the lines
   in that order.
5. The digest is the SHA-256 of the concatenation.

- **Pack digest** = tree digest over `packs/<pack-id>/`.
- **Harness digest** = tree digest over `packs/<pack-id>/harness/` only
  (paths relative to `harness/`). This is `ProtocolVersion.harness_digest`,
  and it must appear in `ProtocolVersion.compatibility.harness_digests` for
  the runner to execute the pack.

**Schema digests.** `context_schema_digest` and `result_schema_digest` are
the SHA-256 of the raw bytes of `context.schema.json` and
`result.schema.json`.

**Protocol digest.** `protocol.json` cannot contain a digest of itself, so
`protocol_digest` is the SHA-256 of the UTF-8 bytes of the RFC 8785 (JCS)
canonical form of the `protocol.json` document **with the `protocol_digest`
member removed**. All other members, including `harness_digest` and the
schema digests, are covered, so any change to the procedure, the harness, or
the pack schemas changes the protocol digest.

### Commands

```
node scripts/pack-digest.js packs/inference-api           # print digests
node scripts/pack-digest.js packs/inference-api --check   # exit 1 if protocol.json is stale
node scripts/pack-digest.js packs/inference-api --write   # rewrite the digest fields
```

Editing anything under `harness/` or a pack schema changes the digests;
run `--write` and commit `protocol.json` with the change. The pack test
(`packs/inference-api/test/pack.test.js`) fails on a stale `protocol.json`.

## Harness invocation

The runner spawns `node harness/index.js` with `IWIK_INPUT`, `IWIK_OUTPUT`,
and `IWIK_ALLOWED_HOSTS` set (contract). The harness writes
`attempts.jsonl`, `result.json` (valid against `result.schema.json`) and
`context.json` (a list of `ContextField` with harness-measured values,
`origin = measured`). Exit codes: `0` completed, `2` protocol violated (first
stderr line is the reason), `3` target unreachable before any attempt, other
= crash.

`input.json` for `inference-api/latency@1` (see
`packs/inference-api/fixtures/input.example.json`):

```jsonc
{
  "plan_id": "01…",
  "protocol_ref": "inference-api/latency@1",
  "target": { "url": "http://127.0.0.1:8089", "model": "…", "api_key": "…" },
  "context": { "model.requested": "…", "concurrency": 1, "retry_policy": "none",
               "cache_disabled": true, "client_region": "local" },
  "budget": { "planned": 20, "max_tokens": 64 },
  "timeout_ms": 30000
}
```

The harness refuses (`exit 2`) any target whose host is not listed in
`IWIK_ALLOWED_HOSTS` (entries may be `host` or `host:port`; an unset variable
denies everything), and any request for `concurrency` other than `1`, which
is all it can honour.

## Stub server

`packs/inference-api/fixtures/stub-server/index.js` emulates an
OpenAI-compatible `POST /v1/chat/completions` (streaming and non-streaming)
with configurable `delay_ms`, `error_rate` (seeded, so deterministic),
and `model_name`, and exposes `GET /__stub/stats`. Run it with
`node packs/inference-api/fixtures/stub-server/index.js --port 8089 --delay-ms 20 --error-rate 0.1`
or use `startStub()` programmatically. A run against the stub carries
`target.kind = fixture` and is never releasable to a cooperative cohort
(ADR-0003).
