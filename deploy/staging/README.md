# Staging runbook — NSAF dev server (ADR-0004)

The Release/Deploy Operator (`/verity:ship`) runs the API and worker as two
systemd services from **one immutable image and one environment file**. PostgreSQL
16 is per-app on the same host. The existing worker owns scheduling and durable
job execution; the API does not start a worker.

Obtain host, tailnet address, deploy user, and key locations through
[the out-of-band access mechanism](../../.verity/deploy-access.README.md).
The real access file is gitignored. Run host commands below on staging, as root
where shown. Keep credentials in that mechanism and record only their locations
in `STATUS.md`. Building these artifacts does not establish a live deployment.

## 0. Preflight: establish runtime truth

Before changing the host, record in the operator's deployment evidence:

- Checkout commit (`git rev-parse HEAD`), stage 13 PR merge commit, proposed
  release tag, and the successful **Release** workflow URL for that exact commit.
  A tag or successful main CI alone is insufficient.
- The full image reference from that run's `release-digests.txt` artifact; confirm
  its manifest digest and both `linux/amd64` and `linux/arm64` platforms with
  `docker buildx imagetools inspect <full-reference>`.
- Current configuration pin, API and worker states, each running container's
  requested image **and actual image ID**, migration names, and HTTP results.
  Missing units, missing containers, and unreachable services are observations;
  they do not establish that the application has never been deployed.

On the host, these commands show identifiers and state without dumping secrets:

```sh
sudo sed -n 's/^IWIK_IMAGE_TAG=/configured image: /p' /etc/i-wish-i-knew/env
sudo systemctl is-active i-wish-i-knew i-wish-i-knew-worker
sudo systemctl show i-wish-i-knew i-wish-i-knew-worker \
  -p ActiveState -p SubState -p Result -p ExecMainStatus -p NRestarts
sudo docker inspect --format '{{.Name}} running={{.State.Running}} image={{.Config.Image}} image_id={{.Image}}' \
  i-wish-i-knew i-wish-i-knew-worker
sudo -u postgres psql -X -d iwik -c 'SELECT name FROM public.pgmigrations ORDER BY name;'
# Local process probe only; browser smoke uses the HTTPS origin below.
export IWIK_BASE_URL=http://127.0.0.1:3000
curl --connect-timeout 2 --max-time 5 -fsS "$IWIK_BASE_URL/readyz"
curl --connect-timeout 2 --max-time 5 -fsS "$IWIK_BASE_URL/healthz"
```

Expected HTTP bodies are `{"ok":true}`. If inaccessible, check tailnet/SSH access,
Docker and PostgreSQL service state, bind address/port, installed unit paths, and
operator-local journals before deciding what to repair. Do not paste complete
container inspection (it includes environment secrets) or unfiltered journals
into handoff evidence. Reconcile mixed or drifted image references before running
`deploy.sh`; it refuses to guess which prior image is authoritative. For a legacy
bare tag, its cached image ID must match the running container before its cached
registry digest is accepted as a rollback reference. Retain that image locally.

### Release selection (from the checkout, not the host)

After the stage 13 PR is reviewed and merged, the Operator selects an unused `v*`
tag on that **exact main commit**, creates it under the ship workflow, and waits
for Release to finish building, publishing, and scanning successfully:

```sh
gh run list --repo seanerama/i-wish-i-knew --workflow release.yml
# Set IWIK_RELEASE_RUN_ID to that specific successful run ID.
gh run view "$IWIK_RELEASE_RUN_ID" --repo seanerama/i-wish-i-knew \
  --json headSha,conclusion,url
gh run download "$IWIK_RELEASE_RUN_ID" --repo seanerama/i-wish-i-knew \
  -n release-digests -D /tmp/iwik-release-digests
cat /tmp/iwik-release-digests/release-digests.txt
```

Use an empty artifact destination for each run. Record the exact commit, run ID,
tag, and artifact reference before deployment; never move or reuse release tags.
The builder cannot name a successful future release before the merge and release
workflow exist. The Operator completes that concrete release record at ship time.
`deploy.sh` accepts the artifact's full `ghcr.io/...:<tag>@sha256:...` line, a
`<tag>@sha256:...` suffix, or a tag it resolves once. Prefer the verified artifact.

## 1. Host prerequisites (once, or reconcile existing installation)

- Docker Engine with `/usr/bin/docker`, Bash, curl, util-linux `flock`, systemd,
  and PostgreSQL 16. Docker must be enabled; containers use host networking.
- A PostgreSQL `iwik` login role and `iwik` database, reachable at
  `127.0.0.1:5432`. Create them only if absent; use a generated password from the
  secret store. Revoke database access from PUBLIC. The role owns the database
  and migrations need no superuser rights. Migration files live in
  `packages/service/migrations/`; `pgmigrations` records applied names.
- If GHCR is private, log in as **root**, the same user that pulls and runs units,
  with a read-only `read:packages` token. Feed it on stdin to
  `sudo docker login ghcr.io -u seanerama --password-stdin`. Record the credential
  location (`/root/.docker/config.json`), never its contents.

### Shared environment

Install [env.example](env.example) only for a new host; preserve existing secrets
and add missing variable names on an existing host:

```sh
sudo install -d -m 0750 /etc/i-wish-i-knew
# New host only:
sudo install -m 0640 deploy/staging/env.example /etc/i-wish-i-knew/env
sudo "${EDITOR:-vi}" /etc/i-wish-i-knew/env
```

Literal, unique `KEY=VALUE` lines only: no quotes, `export`, interpolation, or
shell sourcing. Both units use `EnvironmentFile=` and Docker `--env-file` on this
same root-owned file. The deployment script parses values without executing them.
The image sets production mode; the example makes it explicit.

| Name | Meaning/default |
| --- | --- |
| `IWIK_IMAGE_TAG` | Managed by deploy script; immutable `tag@sha256:...`. Initial placeholder is not runnable. |
| `NODE_ENV` | `production` on staging. |
| `HOST`, `PORT` | `127.0.0.1` behind the local HTTPS proxy; port 3000. Required by the unit probe. |
| `DATABASE_URL` | Required per-app PostgreSQL connection string; percent-encode reserved password characters. |
| `IWIK_KEK` | Required 32 random bytes, hex (64 characters) or base64. Replace the invalid example placeholder; loss makes envelopes unreadable. |
| `IWIK_OPERATOR_TOKEN` | Empty disables operator auth; generated token of at least 16 characters enables bootstrap/challenge administration. It never grants member evidence access. |
| `IWIK_PUBLIC_URL` | Browser-reachable HTTPS origin without path; empty gives path-only invite URLs. Remote HTTP cannot carry the production-mode Secure cookies. |
| `IWIK_TRUST_PROXY` | 0 for direct tailnet, 1 only behind one trusted proxy. |
| `IWIK_WORKER_INTERVAL_MS` | 5000; positive worker poll interval in milliseconds. |
| `IWIK_SEED_ORG`, `IWIK_SEED_NODE_TOKEN`, `IWIK_SEED_NODE_PUBKEY`, `IWIK_SEED_NODE_ID` | Optional legacy seed. First three must be set together; token >=16 characters, Ed25519 key as single-line raw base64, optional ULID node ID. Leave empty for enrollment. |
| `IWIK_INVITE_TTL_MS`, `IWIK_PREVIEW_TTL_MS` | 604800000 and 3600000 milliseconds. |
| `IWIK_QUERY_COHORT_CAP`, `IWIK_MAX_STRING_LENGTH` | 500 and 1024, positive integers. |
| `IWIK_SECRET_PATTERNS` | Additional regex sources as a JSON array; default `[]`. |
| `IWIK_PACKS_DIR`, `IWIK_LOG_LEVEL` | `/app/packs`, `info`; use info during the worker proof so completion events exist. |

### HTTPS browser origin

With `NODE_ENV=production`, session and CSRF cookies carry `Secure`. A successful
HTTP health check or read-only console render does not prove enrollment or login
works. Configure a tailnet-only HTTPS reverse proxy before the browser smoke;
keep production mode and Secure cookies enabled.

On a host with Tailscale HTTPS already enabled, inspect `tailscale serve status
--json` and choose an unused HTTPS port. Preserve existing handlers and Funnel
settings. For example, with port 8443 free:

```sh
tailscale serve --bg --https=8443 http://127.0.0.1:3000
```

Set `HOST=127.0.0.1`, `IWIK_TRUST_PROXY=1`, and `IWIK_PUBLIC_URL` to the exact
HTTPS origin printed by Serve, including its port. Restart both units. Confirm
the new origin is not in `AllowFunnel` and the backend is reachable only on
loopback, so client-supplied proxy headers cannot bypass the trusted proxy.
Record the origin in the private access file and Operator runtime record; use it
as `IWIK_BASE_URL` for every browser check and `verity smoke run --base-url`.
Check that generated invite URLs use that same origin and complete an actual
form submission. Update `.verity/smoke.json` when the configured origin changes.

### Explicit controlled demo configuration

The six flags are independent; enabling one does not enable another. Every flag
is `off` in the example. Intake defaults on only outside production; all other
flags default off everywhere. For stage 14's controlled demo, deliberately set:

```dotenv
IWIK_FEATURE_INTAKE=on
IWIK_FEATURE_ENROLLMENT=on
IWIK_FEATURE_DEDUPE=on
IWIK_FEATURE_COOPERATIVE_QUERY=on
IWIK_FEATURE_CHALLENGE=on
IWIK_FEATURE_WITHDRAWAL=on
```

| Flag | Enabled behavior / disabled behavior |
| --- | --- |
| `INTAKE` | Contribution preview/submission enabled / intake kill switch. |
| `ENROLLMENT` | Organization enrollment and member console identity lifecycle / enrollment disabled. |
| `DEDUPE` | Duplicate/shared-source handling and operator cohort preview / those behaviors disabled; index and ledger writes continue. |
| `COOPERATIVE_QUERY` | Real matching and release policy / existing insufficient-evidence stub. |
| `CHALLENGE` | Challenges, prediction/outcome ledger, resolution console / those endpoints and pages disabled. |
| `WITHDRAWAL` | Withdrawal API, console form, and MCP tool / disabled. |

Stage 13's job proof needs no member evidence. Use operator-owned demo identities
and non-sensitive inputs for console checks. Stage 14's released answers require
genuine non-fixture service measurements; fixture runs remain excluded. ADR-0002's
existing decision gate still applies before a real-member release. Configuring flags does not change
thresholds, organization independence requirements, or the operator trust boundary.
After any flag change, restart **both** units and repeat HTTP/image and worker
checks. Keep the demo flags on only for the agreed demonstration window.

### Install both units and helper artifacts

Use all artifacts from the same reviewed stage 13 checkout:

```sh
sudo install -m 0644 deploy/i-wish-i-knew.service deploy/i-wish-i-knew-worker.service /etc/systemd/system/
sudo install -d -m 0755 /opt/i-wish-i-knew/deploy
sudo install -m 0755 deploy/staging/deploy.sh /opt/i-wish-i-knew/deploy/deploy.sh
sudo install -m 0644 deploy/staging/worker-probe.mjs /opt/i-wish-i-knew/deploy/worker-probe.mjs
sudo systemctl daemon-reload
sudo systemctl enable i-wish-i-knew i-wish-i-knew-worker
```

Do not start a placeholder image. The API readiness gate waits up to 90 seconds;
the worker has no HTTP probe. Both stream stdout/stderr to journald, restart on
failure (five attempts in five minutes), and use Docker init plus SIGTERM with a
20-second graceful stop. Interrupted jobs follow existing stale-lock recovery.

## 2. Deploy the verified release

```sh
# Set this to the exact verified release artifact line, not a branch name.
export IWIK_RELEASE_IMAGE=ghcr.io/seanerama/i-wish-i-knew:vX.Y.Z@sha256:REPLACE_WITH_VERIFIED_DIGEST
sudo /opt/i-wish-i-knew/deploy/deploy.sh "$IWIK_RELEASE_IMAGE"
```

The script locks the environment, resolves/pulls one digest, migrates with that
image while retaining the old pin, saves the previous reference at
`/etc/i-wish-i-knew/env.previous-image`, atomically changes the shared pin, then
restarts API and worker. It verifies both units are active, both containers run
the requested reference, and both HTTP endpoints return success. Curl has
connection and request timeouts; verification is at most 45 attempts with 2-second
intervals plus request time. `IWIK_DEPLOY_VERIFY_ATTEMPTS` is a positive test/tuning
override; the optional second script argument is for isolated fake-command tests
only, since installed units always read `/etc/i-wish-i-knew/env`.

Pull/migration failures leave the image configuration and managed processes
unchanged (a migration may have applied additive statements). After a pin/restart/
verification failure, the script attempts to restore and verify **both** previous
images and always exits nonzero. Incomplete rollback prints `ROLLBACK INCOMPLETE`
and actual unit/container state. An API-only previous install can acquire its
existing worker during restoration; if that old release cannot run the worker,
paired recovery is incomplete. With no previous release, the script stops both
first-install processes and restores the original placeholder/empty pin, reporting
rollback unavailable and the actual remaining state. Investigate failures before
retrying. Do not remove the lock file while a deployment is active.

## 3. Verify, restart, rollback, and restore

Complete [smoke/staging-readiness.md](../../smoke/staging-readiness.md). HTTP and
active process checks alone are insufficient: the maintenance probe must finish
and its identifier must appear in the **live worker service's** completion journal.

For an intentional paired rollback, retain the desired release reference and copy
the previous reference before another deploy overwrites its history file:

```sh
IWIK_PREVIOUS_IMAGE=$(sudo cat /etc/i-wish-i-knew/env.previous-image)
# Only when nonempty and recorded in preflight:
test -n "$IWIK_PREVIOUS_IMAGE"
sudo /opt/i-wish-i-knew/deploy/deploy.sh "$IWIK_PREVIOUS_IMAGE"
# Re-run HTTP, image, and worker proof, then restore the intended demo release:
sudo /opt/i-wish-i-knew/deploy/deploy.sh "$IWIK_RELEASE_IMAGE"
```

Migrations remain additive; never run down migrations. Rollback verifies health
against the files shipped by the previous image. A readiness failure is a failed
check, not something to dismiss. Rollback does not restore feature settings or
secrets: keep those stable during the drill, then explicitly return to the demo
configuration and repeat verification. If no previous compatible image exists,
record the rollback drill as incomplete until a reviewed compatible baseline has
been deployed and the paired drill can be performed.

Only the Operator updates `STATUS.md` after actual execution: exact commit/tag/
digest, URL, UTC date, both running image IDs, worker probe ID and journal proof,
restart/rollback/restoration results, flag state, and secret **locations**. Link
the successful release workflow and operator evidence. Unavailable access or any
failed check stays explicitly incomplete; stage 14's live run waits for success.

## 4. Operations

- Lifecycle: `sudo systemctl stop|start|restart i-wish-i-knew i-wish-i-knew-worker`.
  A worker-only pause leaves API intake available and work queued.
- Logs: `sudo journalctl -u i-wish-i-knew-worker -f` and the corresponding API unit;
  retain identifier-only excerpts, not secret environment or evidence bodies.
- KEK re-encryption/rotation is not implemented. Preserve its existing secure copy.
- Nightly encrypted `pg_dump` with 30-day expiry and a restore drill remain the
  existing SRE follow-up; this stage does not claim backups are configured.
- Optional external agent testing can use the ADR-0004 cloudflared route to
  loopback. Production promotion is outside this staging handoff.
