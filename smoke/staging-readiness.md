# Staging readiness — Operator smoke (stage 13)

**Execution status: not run by the builder.** The Release/Deploy Operator completes
this after review/merge, a successful Release workflow, and the staging preflight
in [the runbook](../deploy/staging/README.md). Use operator-owned demo identities and
non-sensitive inputs for console checks; the job proof needs no member evidence.
Stage 14 released answers require genuine non-fixture service measurements;
fixture runs remain excluded. This is a live operational check, separate from green CI. Stage 14 waits for its success.

Keep an operator-local record of the exact checkout/merge commit, release workflow
URL, immutable image artifact, previous reference, UTC start/end, intended API
origin, and secret locations. Do not copy environment files, tokens, invite links,
raw contribution bodies, or full Docker inspection into evidence.

## 1. Preflight and deploy

- [ ] Record current API/worker unit and container states, configured pin, image
      references/IDs, migration names, and `/readyz` plus `/healthz` results. If
      unreachable, investigate access, service, bind/proxy, and database state;
      report observations without assuming no deployment exists.
- [ ] Confirm successful Release run commit equals the intended reviewed main
      commit and its artifact digest matches registry inspection for both platforms.
- [ ] Install both reviewed units plus deploy/probe scripts; preserve existing
      secrets. Confirm `NODE_ENV=production`, all six explicit flag values, operator
      token location, correct browser origin, `IWIK_LOG_LEVEL=info`, and worker
      interval (5000 ms for this smoke). Record the current configuration for later
      restoration without copying secrets into evidence.
- [ ] Run `sudo /opt/i-wish-i-knew/deploy/deploy.sh "$IWIK_RELEASE_IMAGE"` with the
      exact artifact reference. Require exit 0. Record previous reference before
      any drill overwrites `/etc/i-wish-i-knew/env.previous-image`.

## 2. Prove both processes and the live worker

Use the runbook's `IWIK_BASE_URL` and verified `IWIK_RELEASE_IMAGE`:

```sh
sudo systemctl is-active i-wish-i-knew i-wish-i-knew-worker
sudo docker inspect --format '{{.Name}} running={{.State.Running}} image={{.Config.Image}} image_id={{.Image}}' \
  i-wish-i-knew i-wish-i-knew-worker
curl --connect-timeout 2 --max-time 5 -fsS "$IWIK_BASE_URL/readyz"
curl --connect-timeout 2 --max-time 5 -fsS "$IWIK_BASE_URL/healthz"
```

- [ ] Both units active, both containers running with exactly the intended
      `tag@sha256:...`, and identical local image IDs. A multi-platform manifest
      digest differs from the local image ID; record both rather than comparing
      them as if they were the same kind of digest. HTTP bodies `{"ok":true}`.
- [ ] Inspect worker unit logs for a current `worker started` event in `loop` mode.
      Record container ID and start time before probing:

```sh
sudo docker inspect --format '{{.Id}} {{.State.StartedAt}}' i-wish-i-knew-worker
export IWIK_PROBE_SINCE=$(date -u +%Y-%m-%dT%H:%M:%SZ)
sudo timeout --kill-after=5s 75s docker exec -i i-wish-i-knew \
  node --input-type=module < /opt/i-wish-i-knew/deploy/worker-probe.mjs
```

The helper uses the API container's existing image modules and database credentials
to enqueue a uniquely identified `reap_previews` maintenance job with an empty
payload, then polls for at most 60 seconds (database calls also have timeouts).
It executes **no worker or job handler**. This uses the existing maintenance
semantics and can delete already-expired previews; do it within the demo window.
It prints only job ID, kind, state, and attempt count. The outer timeout bounds
unresponsive Docker/process behavior. A timeout or failed job is a failed smoke;
record its ID and inspect the local state without deleting or rewriting job rows.

- [ ] Require exit 0 and `state: done`; copy its exact `job_id` into the next command.

```sh
export IWIK_PROBE_JOB_ID=REPLACE_WITH_PRINTED_JOB_ID
sudo journalctl -u i-wish-i-knew-worker --since "$IWIK_PROBE_SINCE" \
  --no-pager -o cat | rg -F "$IWIK_PROBE_JOB_ID"
sudo docker inspect --format '{{.Id}} {{.State.StartedAt}} running={{.State.Running}} image={{.Config.Image}} image_id={{.Image}}' \
  i-wish-i-knew-worker
```

`rg` (or `grep -F` when unavailable) is only an identifier filter; inspect the
matching event. Require `msg: "job done"`, `kind: "reap_previews"`, and the same
job ID in the **worker unit journal**, plus the same running worker container ID,
start time, and intended image as before the probe. A separate `worker --once`
process, old unrelated completed job, or HTTP readiness is insufficient proof.
`locked_by` is cleared on completion, so it cannot identify the worker afterward.

- [ ] Save only the matching completion event and the identifier/state inspection
      results. No completion event (including log level above info), changed
      container, or mismatch means incomplete verification; diagnose and rerun
      with a fresh probe ID.

## 3. Console and explicit flag states

- [ ] With the example's six flags off, follow [console smoke](console.md)'s
      default-off expectation. Enrollment and challenge surfaces are disabled;
      cooperative query retains its existing insufficient-evidence behavior.
      Confirm flags by reading only `^IWIK_FEATURE_` lines from the environment.
- [ ] Set the six `on` lines from the runbook's controlled demo configuration and
      restart both units. Confirm their flags remain independent; no code default
      has changed. Rerun section 2, including a new worker probe.
- [ ] Follow [enrollment smoke](enrollment.md) for an operator-owned demo organization, log in,
      and view the member console. Confirm enrollment/node management appears,
      contribution preview is available under intake, and the challenge/withdrawal
      surfaces match their enabled flags. Record page/flag outcomes without invite
      tokens or session values. Full contributions, queries, predictions, outcomes,
      and withdrawal cycles belong to stage 14.

## 4. Restarts, paired rollback, return to demo

- [ ] Restart API alone, rerun HTTP and paired image checks, and confirm the worker
      remains available. Restart worker alone; verify both image references and
      use a **fresh** probe plus journal completion to prove its new process works.
- [ ] With the same environment flags/secrets, deploy the recorded previous
      compatible pinned reference through `deploy.sh`. Require exit 0, both old
      image references and matching local image IDs, HTTP success, and a fresh
      worker probe completion in its journal. Migrations remain in place.
- [ ] If no previous usable release exists, record rollback as **incomplete**.
      Establish a reviewed compatible baseline through the ship workflow, then
      perform the paired release/rollback/restoration drill. A successful fresh
      installation does not by itself satisfy rollback validation.
- [ ] Redeploy the intended release from the exact original artifact reference;
      restore the six demo flags, info logging, 5000 ms interval, and intended
      browser URL. Restart both if configuration changed; repeat HTTP/image,
      console, and fresh worker completion checks. Record final state, not just
      the temporary rollback state.

## 5. Operator record and stage 14 handoff

- [ ] Update `STATUS.md` as Operator only after actual execution: commit/tag/digest,
      release workflow URL, staging URL and UTC date, both image IDs, worker probe
      ID and journal evidence location, restart/rollback/restoration outcomes,
      final six flag values, secret locations, and remaining limitations.
- [ ] Mark access failures or failed/unexecuted steps as incomplete; never infer
      successful staging execution from these artifacts, a release tag, or CI.
- [ ] Hand the completed evidence record to stage 14 only when all checks pass.
      Production promotion is outside this smoke.
