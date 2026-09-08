# Stage 13: Staging readiness for a cooperative investigation

- **Type:** chore
- **Depends on:** 4, 6, 7, 8, 9, 10, 12
- **Milestone:** 0.4 repeatable cooperative investigation
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/25
- **Stage instruction:** `stage-instructions/stage-13-staging-readiness-for-a-cooperative-investigation.md`
- **Design refs:** ADR-0001, ADR-0002, ADR-0004, ADR-0006; brief §9 demonstrations 7–8; `feature-assessments/repeatable-staging-investigation-assessment.md`

## Objectives

Provide a verified staging deployment of the existing API and worker, using
the same immutable image, so stage 14 can exercise a complete investigation.
Establish runtime truth before changing a host: the committed deployment record
is incomplete and the configured health endpoints refused connections at intake.

## What to build

1. Extend `deploy/staging/README.md` with a preflight that records the checked
   commit, successful release workflow and image digest, migrations, API and
   worker process state, and health results. A tag alone does not establish a
   usable release. Investigate an unreachable host/service without assuming it
   has never been deployed. Use the existing out-of-band access mechanism.
2. Add `deploy/i-wish-i-knew-worker.service` to run
   `node packages/service/dist/worker.js` from the same image and environment
   as the API. Give it a distinct container name, journal logs, graceful stop,
   and restart behavior. The existing worker owns the job loop; do not add a
   second scheduler to the API. Document installation and lifecycle commands.
3. Update `deploy/staging/deploy.sh` to migrate and deploy both processes at one
   resolved digest. Preserve the previous reference and handle failures at
   migration, either process restart, and verification. A failed migration must
   not leave the configured image changed while the old process keeps running.
   Rollback restores both image references; additive database migrations remain.
   On a first deployment with no previous image, report failure and the actual
   remaining process state instead of claiming rollback succeeded.
4. Bring `deploy/staging/env.example` and the runbook into agreement with
   `packages/service/src/config.ts`: document intake, enrollment, dedupe,
   cooperative query, challenge, withdrawal, operator token, public URL, and
   worker interval. Keep example feature flags off and secrets as placeholders.
   Provide an explicit demo configuration for the six existing feature flags;
   preserve each flag's independent behavior and existing defaults.
5. Add a staging verification procedure that checks both processes use the
   intended digest, `/readyz` and `/healthz` pass, and the worker completes a
   bounded maintenance/job probe with identifier-only evidence. HTTP readiness
   alone does not prove the worker is running. Include API and worker restart,
   paired rollback, and return-to-demo-configuration checks.
6. Deliver an operator handoff specifying the exact release and checks to run.
   After deployment the Release/Deploy Operator records image, URL, date, worker
   verification, and secret locations in `STATUS.md`. Planning and building
   artifacts must not claim a deployment occurred. Production promotion is out
   of scope.

## Interface contracts

- **Exposes:** staging API and existing worker operationally verified at one
  image digest; deploy/rollback procedure and evidence for stage 14.
- **Consumes:** existing `member-api` health and identity surfaces,
  `evidence-envelope` v1, current job table/worker entrypoint, ADR-0004 systemd
  deployment and release image.
- No public API, schema, protocol, trust-boundary, or threshold changes. The
  second systemd unit implements the worker topology already accepted in
  ADR-0001; it introduces no new architectural decision or frozen contract.

## Testing requirements

- Extend `deploy/test/unit-file.test.sh` to validate both units and environment
  references. Preserve visible reporting if systemd validation is unavailable.
- Add deployment orchestration tests using isolated fake Docker/systemctl/curl
  commands or an equivalent test seam: success pins both processes; migration,
  worker startup, API readiness, and rollback failures exit nonzero and leave
  accurately reported state. Tests must never contact a real host.
- Run the committed `.verity/gates.json` checks and required CI jobs.
- Author `smoke/staging-readiness.md` for the Operator, including console flag
  state, worker completion, restart, paired rollback, and restoration. Existing
  worker/job integration tests remain the reference for queue semantics.

## Acceptance conditions

- [ ] API and worker deployment artifacts, environment documentation, failure
      handling, and operator smoke procedure are complete and reviewed.
- [ ] The Operator has recorded a successful staging execution of the smoke
      procedure, including worker completion and both running image digests.
- [ ] `STATUS.md` reflects verified runtime state, updated by the Operator;
      unavailable access or failed checks are reported as incomplete validation.
- [ ] Existing feature flags remain default off; no extra feature flag is needed
      for this operational chore.
- [ ] Existing suite stays green; CI all-green

## Handoff

`$verity-build` builds and reviews the artifacts. The Release/Deploy Operator
performs the staging deployment and live verification under the existing ship
workflow. Stage 14's live run begins only after the checks above pass.

## Pipeline test: NO
