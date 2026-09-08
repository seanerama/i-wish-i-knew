#!/bin/bash
# Run as root ON staging; see README.md. PATH commands permit isolated fake-command tests.
# Usage: deploy.sh <tag|tag@sha256:digest|full-image-reference>
# Optional second argument is an isolated test fixture ONLY: installed units
# always read /etc/i-wish-i-knew/env. Do not use it to select a live environment.
set -euo pipefail
ENV_FILE=${2:-/etc/i-wish-i-knew/env}
IMAGE=ghcr.io/seanerama/i-wish-i-knew
REF=${1:?usage: deploy.sh <tag|tag@sha256:digest|full-image-reference> [env-file]}
REF=${REF#"$IMAGE:"}
API=i-wish-i-knew
WORKER=i-wish-i-knew-worker
VERIFY_ATTEMPTS=${IWIK_DEPLOY_VERIFY_ATTEMPTS:-45}
[[ "$VERIFY_ATTEMPTS" =~ ^[1-9][0-9]*$ ]] || { echo 'invalid verification attempt limit' >&2; exit 1; }
[[ "$REF" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*(@sha256:[a-f0-9]{64})?$ ]] || { echo 'invalid image reference' >&2; exit 1; }
[ -f "$ENV_FILE" ] && [ -w "$ENV_FILE" ] || { echo 'environment file must exist and be writable' >&2; exit 1; }
# Serializes migration, replacement and rollback; manual operations must not race this lock.
exec 9>"$ENV_FILE.deploy.lock"
flock -n 9 || { echo 'another deployment holds the lock' >&2; exit 1; }

# Parse literal KEY=VALUE, never source secrets as executable shell input. Duplicate
# keys are rejected because systemd and Docker must consume exactly the same config.
if ! awk 'NF && $0 !~ /^#/ { if ($0 !~ /^[A-Z_][A-Z0-9_]*=/ || seen[substr($0,1,index($0,"=")-1)]++) exit 1 }' "$ENV_FILE"; then
  echo 'environment file needs unique literal KEY=VALUE lines' >&2; exit 1
fi
read_value() { sed -n "s/^$1=//p" "$ENV_FILE"; }
PREV=$(read_value IWIK_IMAGE_TAG)
HOST=$(read_value HOST)
PORT=$(read_value PORT)
[ -n "$HOST" ] && [[ "$PORT" =~ ^[0-9]+$ ]] && [ -n "$(read_value DATABASE_URL)" ] || { echo 'HOST, PORT and DATABASE_URL are required' >&2; exit 1; }
# A legacy tag is allowed as the current config, but resolve it before mutation
# so rollback never follows a mutable tag. Empty/placeholder first-install config
# is treated as no release only when no managed container is running.
PREV_PIN=$PREV
CHANGED=0
PHASE=preflight
TMP=
report_state() {
  echo "configured image: $(read_value IWIK_IMAGE_TAG)"
  for unit in "$API" "$WORKER"; do
    state=$(systemctl is-active "$unit" 2>/dev/null) || :
    echo "$unit: ${state:-unknown}"
    docker inspect --format '{{.Name}} running={{.State.Running}} image={{.Config.Image}} image_id={{.Image}}' "$unit" 2>/dev/null || echo "$unit container: absent or inspect unavailable"
  done
}
write_ref() {
  local ref=$1
  TMP=$(mktemp "$ENV_FILE.XXXXXX") || return 1
  cp -p "$ENV_FILE" "$TMP" || return 1
  awk -v ref="$ref" 'BEGIN { found=0 } /^IWIK_IMAGE_TAG=/ { print "IWIK_IMAGE_TAG=" ref; found=1; next } { print } END { if (!found) print "IWIK_IMAGE_TAG=" ref }' "$ENV_FILE" > "$TMP" || return 1
  mv -f "$TMP" "$ENV_FILE" || return 1
  TMP=
}
verify_pair() {
  local ref=$1 i unit value ok
  for ((i=0; i<VERIFY_ATTEMPTS; i++)); do
    ok=1
    for unit in "$API" "$WORKER"; do
      systemctl is-active --quiet "$unit" || ok=0
      value=$(docker inspect --format '{{.State.Running}} {{.Config.Image}}' "$unit" 2>/dev/null) || value=
      [ "$value" = "true $IMAGE:$ref" ] || ok=0
    done
    for endpoint in readyz healthz; do
      value=$(curl --connect-timeout 2 --max-time 5 -fsS "http://$HOST:$PORT/$endpoint" 2>/dev/null) || value=
      [[ "$value" =~ ^\{\"ok\":true\}$ ]] || ok=0
    done
    [ "$ok" = 1 ] && return 0
    [ "$i" -eq "$((VERIFY_ATTEMPTS-1))" ] || sleep 2
  done
  return 1
}
finish() {
  local code=$? failed=0
  trap - EXIT INT TERM
  set +e
  [ -z "$TMP" ] || rm -f "$TMP"
  if [ "$code" -ne 0 ]; then
    echo "deployment failed during $PHASE" >&2
    if [ "$CHANGED" = 1 ]; then
      if [ -n "$PREV_PIN" ]; then
        echo "restoring previous image: $PREV_PIN" >&2
        if write_ref "$PREV_PIN"; then
          systemctl restart "$API" || failed=1
          systemctl restart "$WORKER" || failed=1
          verify_pair "$PREV_PIN" || failed=1
        else
          failed=1
        fi
        if [ "$failed" = 0 ]; then echo 'paired rollback verified' >&2
        else echo 'ROLLBACK INCOMPLETE: operator intervention required' >&2; fi
      else
        # There is no known usable release to restore. Stop both first-install
        # processes and restore the original empty/placeholder config.
        systemctl stop "$API" || failed=1
        systemctl stop "$WORKER" || failed=1
        write_ref "$PREV" || failed=1
        echo 'no previous release: rollback unavailable; first-deploy cleanup attempted' >&2
        [ "$failed" = 0 ] || echo 'cleanup incomplete: operator intervention required' >&2
      fi
    else
      echo 'image configuration and managed processes were not changed' >&2
    fi
    report_state
  fi
  [ -z "$TMP" ] || rm -f "$TMP"
  exit "$code"
}
trap finish EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# Prefer the actual immutable reference of any running managed container. Refuse
# an already mixed or drifted pair: the operator must reconcile it in preflight.
RUNNING_REF=
for unit in "$API" "$WORKER"; do
  value=$(docker inspect --format '{{.State.Running}} {{.Config.Image}}' "$unit" 2>/dev/null) || value=
  if [[ "$value" = 'true '* ]]; then
    running=${value#"true $IMAGE:"}
    [ "$value" = "true $IMAGE:$running" ] && [ "$running" = "$PREV" ] || { echo 'running image differs from configured image; reconcile preflight first' >&2; exit 1; }
    RUNNING_REF=$running
  fi
done
if [ -z "$PREV" ] || [[ "$PREV" = *-placeholder ]]; then
  [ -z "$RUNNING_REF" ] || { echo 'running service has no usable previous release reference' >&2; exit 1; }
  PREV_PIN=
elif [[ "$PREV" != *@sha256:* ]]; then
  [[ "$PREV" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*$ ]] || { echo 'invalid previous image reference' >&2; exit 1; }
  cached_id=$(docker image inspect --format '{{.Id}}' "$IMAGE:$PREV")
  for unit in "$API" "$WORKER"; do
    value=$(docker inspect --format '{{.State.Running}} {{.Image}}' "$unit" 2>/dev/null) || value=
    if [[ "$value" = 'true '* ]] && [ "$value" != "true $cached_id" ]; then
      echo 'legacy tag cache differs from running image; reconcile preflight first' >&2; exit 1
    fi
  done
  # Resolve the cached image, not a fresh pull of a possibly moved legacy tag.
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:$PREV")
  digest=${digest##*@}
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'previous image has no cached registry digest' >&2; exit 1; }
  PREV_PIN="$PREV@$digest"
elif ! [[ "$PREV" =~ ^[a-zA-Z0-9_][a-zA-Z0-9_.-]*@sha256:[a-f0-9]{64}$ ]]; then
  echo 'invalid previous image reference' >&2; exit 1
fi
PHASE=pull
if [[ "$REF" != *@sha256:* ]]; then
  docker pull "$IMAGE:$REF" >/dev/null
  digest=$(docker image inspect --format '{{index .RepoDigests 0}}' "$IMAGE:$REF")
  digest=${digest##*@}
  [[ "$digest" =~ ^sha256:[a-f0-9]{64}$ ]] || { echo 'registry returned no valid digest' >&2; exit 1; }
  REF="$REF@$digest"
fi
docker pull "$IMAGE:$REF" >/dev/null
echo "image: $IMAGE:$REF"
echo "previous: ${PREV_PIN:-<none>}"
PHASE=migration
# Do not print credentials or put them in process arguments. The env file is
# passed literally, as it is for both systemd units. It still contains PREV.
docker run --rm --network host --env-file "$ENV_FILE" "$IMAGE:$REF" node packages/service/dist/migrate.js
PHASE=pin
# Persist the rollback reference before changing the active configuration.
TMP=$(mktemp "$ENV_FILE.previous-image.XXXXXX")
printf '%s\n' "$PREV_PIN" > "$TMP"
chmod 600 "$TMP"
mv -f "$TMP" "$ENV_FILE.previous-image"
TMP=
# Arm recovery before the atomic rename, including signal failures at this point.
CHANGED=1
write_ref "$REF"
PHASE=api-restart
systemctl restart "$API"
PHASE=worker-restart
systemctl restart "$WORKER"
PHASE=verification
verify_pair "$REF"
report_state
echo "deployed $REF; previous reference saved in $ENV_FILE.previous-image"
echo 'HTTP and paired image checks passed; Operator must complete smoke/staging-readiness.md (including live worker job proof).'
