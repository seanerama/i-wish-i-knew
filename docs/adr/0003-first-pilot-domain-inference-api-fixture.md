# 0003. First pilot domain: inference API fixture

- **Status:** Accepted
- **Date:** 2026-09-05

## Context

Brief §9 offers two candidate first domains: an API / inference service, or a
network PoC through NetClaw. It suggests using a small API fixture as an
inexpensive engineering sandbox, then selecting the real-member domain by
partner availability, and including a lightweight second-domain fixture to
prove the schemas are generic. Decision item 1 asks for the first audience,
pilot domain, and the first two measurable questions. Item 6 asks for matching
rules and analysis units.

## Decision

**First domain pack: `inference-api`.** It needs no lab access, no disruptive
activity, and can run entirely against an in-repo fixture server in CI.

First two measurable questions, each a versioned protocol:

| Protocol | Question | Measured |
|---|---|---|
| `inference-api/latency@1` | Under a fixed prompt set, concurrency *c*, and `max_tokens`, what are the client-observed time-to-first-token and total-latency distributions and the error rate of endpoint *E* running model version *V*? | per-request TTFT ms, total ms, HTTP status, error class, tokens returned |
| `inference-api/tool-use@1` | Against fixture set *F*, what fraction of requests yields a schema-valid tool call matching the expected tool and arguments? | per-fixture pass/fail with failure class |

Mandatory context fields for both (missing = explicitly `unknown`, never
defaulted): model identifier as reported by the endpoint, requested model,
concurrency, retry policy, client region, whether caching was disabled, harness
version, protocol digest.

**Fixture server.** `packs/inference-api/fixtures/stub-server` emulates an
OpenAI-compatible chat endpoint with configurable delay, error rate, and tool-call
behaviour. The walking skeleton and CI run against it; no paid calls in CI.

**Analysis unit.** One run = one protocol execution from one runner node.
One contributor = one organization. For cohort thresholds (ADR-0002) many runs
or many agents from one organization count as one contributor. Thousands of
requests inside a run are samples within a run, not independent observations.

**Matching.** Hard compatibility first: same protocol major version, compatible
harness digest per the protocol's compatibility rules, matching required context
fields. Then rank by soft similarity on optional context. Semantic similarity is
never a compatibility test.

**Thresholds belong to the investigation, not the run.** A member's latency
target is stored on the Investigation; runs carry measurements only (R7).

**Second-domain fixture (Phase 5).** `network-failover@1` via a NetClaw adapter
if lab access is available; otherwise `ci-pipeline/duration@1` (timing of a
defined CI job) as the cheaper proof that the envelope is generic.

**First member audience.** Teams choosing between hosted inference endpoints for
agent workloads. Recruitment is a product task, outside this ADR.

## Alternatives considered

- **NetClaw network PoC first.** Higher demonstration value, but needs
  representative lab access and controlled disruption; diagnostic access varies
  by device. Deferred to the second adapter.
- **Hardware endurance.** Long runs and physical access. Deferred.

## Consequences

- Active tests against real providers cost money. The runner enforces a per-plan
  budget from the local policy file (ADR-0006) and refuses to exceed it.
- Caching, retries, and concurrency dominate comparability, so they are
  mandatory context, and a run missing them is `excluded` with reason.
- The stub server must be honest about what it emulates; a run against the stub
  carries `target.kind = fixture` and is never releasable to a cooperative cohort.
