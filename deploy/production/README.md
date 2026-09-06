# Production runbook — Coolify on the EC2 host (ADR-0004)

Written for the Release/Deploy Operator (`/verity:ship`), which drives Coolify
by its API. Production pulls the same multi-arch image staging runs; the EC2
host is Graviton, so the `linux/arm64` entry of the manifest list is what runs.

**Access.** The Coolify URL, its API token location, and the host details are
**not** in this repository. Obtain them as described in
[`.verity/deploy-access.README.md`](../../.verity/deploy-access.README.md).
Promotion to production is confirm-gated (`.verity/config.json`:
`prod_promote: confirm`).

Coolify's API is documented on the instance itself at `<coolify-url>/docs/api`;
field names below follow Coolify v4 and should be checked against that page
before the first run. Every call carries `Authorization: Bearer <token>`.

## 1. Resources to create (once)

### 1.1 PostgreSQL 16 resource

Create a **PostgreSQL** database resource on the EC2 server in the project's
environment (`POST /api/v1/databases/postgresql` or the UI):

| Setting | Value |
|---|---|
| image | `postgres:16-alpine` |
| database name | `iwik` |
| user | `iwik` |
| password | Coolify-generated; never copied anywhere but `DATABASE_URL` |
| public port | **none** (internal only) |

Coolify exposes the internal connection string (`postgres://iwik:…@<internal-host>:5432/iwik`);
use it as `DATABASE_URL`. Backups: enable Coolify's scheduled backup on the
resource (nightly, 30-day retention, to the encrypted S3-compatible target
recorded in the access file) — ADR-0004.

### 1.2 Application: Docker image

Create an application of type **Docker Image**
(`POST /api/v1/applications/dockerimage`) with:

| Setting (API field) | Value |
|---|---|
| image (`docker_registry_image_name`) | `ghcr.io/seanerama/i-wish-i-knew` |
| tag (`docker_registry_image_tag`) | the release tag, e.g. `v0.0.1` (never `latest`) |
| exposed port (`ports_exposes`) | `3000` |
| domain (`domains`) | `https://<production-domain>` (Cloudflare-proxied record → Coolify's traefik) |
| health check (`health_check_enabled`) | `true` |
| health check path (`health_check_path`) | `/readyz` |
| health check port (`health_check_port`) | `3000` |
| health check method / return code | `GET` / `200` |
| health check interval / timeout / retries | `30` / `5` / `3` |
| health check start period | `20` |
| instant deploy | `false` (deploy explicitly in step 2) |

If ghcr package is private, add the registry credential in Coolify
(server → docker registries, or `docker login ghcr.io` as the Coolify user on
the host) with a read-only `read:packages` token whose location is in the
access file.

### 1.3 Environment variables

Names only; values are set in Coolify (`POST /api/v1/applications/{uuid}/envs`
or `/envs/bulk`) and live nowhere else:

| Name | Value source |
|---|---|
| `DATABASE_URL` | the PostgreSQL resource's internal connection string |
| `IWIK_KEK` | 64 hex chars from `openssl rand -hex 32`; generated once, location recorded in `STATUS.md`; losing it makes stored envelopes unreadable |
| `IWIK_FEATURE_INTAKE` | `off` until the operator-exclusion gate (ADR-0002) is decided; `on` to accept runs |
| `PORT` | `3000` |
| `IWIK_SEED_ORG`, `IWIK_SEED_NODE_TOKEN`, `IWIK_SEED_NODE_PUBKEY`, `IWIK_SEED_NODE_ID` | optional pilot seed identity; unset for an empty service |
| `IWIK_LOG_LEVEL` | `info` |

`HOST` is not set (the container listens on `0.0.0.0` inside Coolify's network;
only traefik reaches it).

## 2. Deploy a release tag

Staging must already run the same tag (`deploy/staging/README.md`) and its
smoke (`smoke/console.md`) must have passed.

1. **Migrate first** with the new image, against the production database.
   Preferred: a one-off container on the same Docker network as the database,
   on the host (via the access path):

   ```sh
   docker run --rm --network <coolify-network-of-the-db> \
     -e DATABASE_URL="<production DATABASE_URL>" \
     ghcr.io/seanerama/i-wish-i-knew:<tag> \
     node packages/service/dist/migrate.js
   ```

   Alternative: set the application's **pre-deployment command** to
   `node packages/service/dist/migrate.js` so Coolify runs it in the new
   container before it starts serving — verify on the instance that the
   command runs in the *new* image (Coolify's semantics have changed across
   versions) before relying on it. Migrations are additive-only (ADR-0005), so
   running them ahead of the swap is safe for the version still serving.

2. **Point the application at the tag and deploy:**

   ```sh
   curl -fsS -X PATCH "$COOLIFY_URL/api/v1/applications/$APP_UUID" \
     -H "Authorization: Bearer $COOLIFY_TOKEN" -H 'Content-Type: application/json' \
     -d '{"docker_registry_image_tag":"<tag>"}'
   curl -fsS "$COOLIFY_URL/api/v1/deploy?uuid=$APP_UUID&force=true" \
     -H "Authorization: Bearer $COOLIFY_TOKEN"
   # returns a deployment uuid; poll it:
   curl -fsS "$COOLIFY_URL/api/v1/deployments/<deployment-uuid>" \
     -H "Authorization: Bearer $COOLIFY_TOKEN"
   ```

   Coolify pulls the image, starts the new container, waits for the `/readyz`
   health check, then switches traefik. The variables above are the ones the
   Operator's `deploy.sh` reads from the access file — they are never committed.

3. **Verify:** `curl -fsS https://<production-domain>/readyz` → `{"ok":true}`;
   `smoke/console.md` against the production origin; then update `STATUS.md`
   (environments table, image tag, secret locations, date).

## 3. Rollback

Redeploy the previous tag: `PATCH` `docker_registry_image_tag` to the previous
release and trigger `/api/v1/deploy` again (Coolify's UI "Rollback" does the
same from image history). Do not roll the database back; migrations are
additive and the previous image runs against the newer schema. Record it in
`STATUS.md`.

## 4. Notes for the Operator

- One image tag must reach both environments (ADR-0004); `deploy.sh` targets
  staging (systemd) and production (Coolify API) with the same `<tag>`.
- `IWIK_KEK` rotation is not implemented; treat it as permanent for the pilot.
- The Cloudflare record for the production domain is proxied; Coolify's
  traefik terminates TLS with the origin certificate recorded in the access
  file (or Cloudflare origin CA). No host, address, or credential is written
  in this repository.
