# Staging runbook — NSAF dev server (ADR-0004)

Written for the Release/Deploy Operator (`/verity:ship`). Staging runs the
release image under the systemd unit in this directory's parent
(`deploy/i-wish-i-knew.service`), with a per-app PostgreSQL 16 on the same
host, reachable only on the tailnet.

**Access.** Nothing in this repository names the host, its address, a user, a
key file, or a database password. Obtain them as described in
[`.verity/deploy-access.README.md`](../../.verity/deploy-access.README.md)
(the real `.verity/deploy-access.md` is gitignored and shared out-of-band).
Every command below is run *on the host* over that access path unless it says
otherwise. Record secret **locations** (never values) in `STATUS.md`.

## 0. What a release is

- `.github/workflows/release.yml` builds `ghcr.io/seanerama/i-wish-i-knew:<tag>`
  and `:sha-<short>` for `linux/amd64` and `linux/arm64` on every `v*` tag.
- Cut one from a commit on `main` (from a checkout, not the host):

  ```sh
  git tag v0.0.1 <commit-on-main>
  git push origin v0.0.1
  gh run watch --repo seanerama/i-wish-i-knew   # wait for "Release" to finish
  docker buildx imagetools inspect ghcr.io/seanerama/i-wish-i-knew:v0.0.1   # both platforms listed
  ```

- The first push creates the ghcr package **private**. Either make it public
  (package settings on github.com) or give the host a read-only token
  (`read:packages`) — see step 1.3. Release tags are never moved or reused.

## 1. Host prerequisites (once)

### 1.1 Docker

Docker Engine with the `docker` CLI at `/usr/bin/docker` (the unit uses that
path), `docker.service` enabled. The host is amd64 (the image also carries
arm64 for production).

```sh
docker --version && systemctl is-enabled docker
```

### 1.2 PostgreSQL 16, per-app database and role

Install PostgreSQL 16 (distribution package is fine) listening on
`127.0.0.1:5432` (the default). Create the role and database; substitute a
generated password and record only where it is kept:

```sh
sudo -u postgres psql -v ON_ERROR_STOP=1 <<'SQL'
CREATE ROLE iwik LOGIN PASSWORD 'REPLACE_WITH_GENERATED_PASSWORD';
CREATE DATABASE iwik OWNER iwik ENCODING 'UTF8';
REVOKE ALL ON DATABASE iwik FROM PUBLIC;
GRANT ALL PRIVILEGES ON DATABASE iwik TO iwik;
SQL
psql "postgres://iwik:REPLACE_WITH_GENERATED_PASSWORD@127.0.0.1:5432/iwik" -c 'select 1'
```

Migrations create the `evidence` schema and tables as the `iwik` role; no
superuser access is needed after this step. The default `pg_hba.conf` already
allows `127.0.0.1/32` with password auth, which is what the container uses
(host networking).

### 1.3 ghcr login on the host

If the package is private, log in once with a read-only token whose
*location* is in the access file (never paste it into a file in this repo):

```sh
echo "$GHCR_READ_TOKEN" | docker login ghcr.io -u seanerama --password-stdin
```

Docker stores the credential in `/root/.docker/config.json` (for the root
user, which runs the unit). Note that path in `STATUS.md` as the secret location.

### 1.4 Environment file

The unit reads `/etc/i-wish-i-knew/env` and passes the same file to the
container. `deploy/staging/env.example` lists every variable **name**:

| Name | Required | Meaning |
|---|---|---|
| `IWIK_IMAGE_TAG` | yes | release tag to run, e.g. `v0.0.1` |
| `HOST` | yes | listen address inside host networking: the host's tailnet address (tailnet-only), or `127.0.0.1` behind a local proxy |
| `PORT` | yes | listen port, e.g. `3000` |
| `DATABASE_URL` | yes | `postgres://iwik:<password>@127.0.0.1:5432/iwik` |
| `IWIK_KEK` | yes | 64 hex chars (`openssl rand -hex 32`); losing it makes stored envelopes unreadable |
| `IWIK_FEATURE_INTAKE` | no | `off` (default in production) / `on` |
| `IWIK_SEED_ORG`, `IWIK_SEED_NODE_TOKEN`, `IWIK_SEED_NODE_PUBKEY`, `IWIK_SEED_NODE_ID` | no | pilot seed identity (stage 2); empty for an empty service |
| `IWIK_LOG_LEVEL` | no | pino level, default `info` |

```sh
sudo install -d -m 0750 /etc/i-wish-i-knew
sudo install -m 0640 deploy/staging/env.example /etc/i-wish-i-knew/env
sudo "${EDITOR:-vi}" /etc/i-wish-i-knew/env     # KEY=VALUE lines only: no quotes, no export
```

### 1.5 Unit

```sh
sudo install -m 0644 deploy/i-wish-i-knew.service /etc/systemd/system/i-wish-i-knew.service
sudo systemctl daemon-reload
sudo systemctl enable i-wish-i-knew
```

## 2. Deploy a tag

Every deploy is: **migrate with the new image, then start the new image.**
Migrations are additive-only (ADR-0005), so running them before the swap is
safe for the still-running old version.

```sh
set -a; . /etc/i-wish-i-knew/env; set +a          # or export IWIK_IMAGE_TAG=v0.0.1 by hand
docker pull ghcr.io/seanerama/i-wish-i-knew:${IWIK_IMAGE_TAG}

# 2.1 migrations (the image's migrate entrypoint; only DATABASE_URL is needed)
docker run --rm --network host \
  -e DATABASE_URL="$DATABASE_URL" \
  ghcr.io/seanerama/i-wish-i-knew:${IWIK_IMAGE_TAG} \
  node packages/service/dist/migrate.js

# 2.2 point the unit at the tag and restart
sudo sed -i "s/^IWIK_IMAGE_TAG=.*/IWIK_IMAGE_TAG=${IWIK_IMAGE_TAG}/" /etc/i-wish-i-knew/env
sudo systemctl restart i-wish-i-knew
sudo systemctl status i-wish-i-knew --no-pager   # active (running) once /readyz answered 200
```

The unit's `ExecStartPost` polls `/readyz` for up to 90 s; a start only
succeeds once the database is reachable and migrations are current.
Otherwise the unit fails and `Restart=on-failure` retries (5 times in 5 min).

## 3. Verify

```sh
curl -fsS "http://${HOST}:${PORT}/readyz"   # {"ok":true}
curl -fsS "http://${HOST}:${PORT}/healthz"  # {"ok":true}
journalctl -u i-wish-i-knew -n 50 --no-pager
docker inspect --format '{{.State.Health.Status}}' i-wish-i-knew   # healthy
```

Then run `smoke/console.md` against `http://<HOST>:<PORT>` from a tailnet
client, and update `STATUS.md` (environments table: tag, URL, date, secret
locations).

## 4. Rollback

Redeploy the previous tag. Migrations are additive, so the previous image runs
against the migrated schema; do not roll the database back.

```sh
sudo sed -i "s/^IWIK_IMAGE_TAG=.*/IWIK_IMAGE_TAG=<previous-tag>/" /etc/i-wish-i-knew/env
sudo systemctl restart i-wish-i-knew
curl -fsS "http://${HOST}:${PORT}/readyz"
```

Record the rollback in `STATUS.md`. If `/readyz` reports migrations not
current after a rollback, the previous image predates a migration that the
newer one applied; that is expected and harmless for additive migrations —
`migrationsCurrent` only checks the files the running image ships.

## 5. Operations

- Logs: `journalctl -u i-wish-i-knew -f` (structured pino JSON; identifiers
  only, never bodies).
- Stop / start: `sudo systemctl stop|start i-wish-i-knew`.
- Backups (ADR-0004): nightly `pg_dump` of `iwik` to encrypted object storage,
  30-day expiry — an SRE stage wires it; not part of this runbook yet.
- Rotating `IWIK_KEK` is **not** supported by re-encryption yet; treat the key
  as permanent for the pilot and keep a copy in the location recorded in
  `STATUS.md`.
- Optional external reachability (agent testing): a `cloudflared` route to
  `http://127.0.0.1:<PORT>` with `HOST=127.0.0.1`; only if needed (ADR-0004).
