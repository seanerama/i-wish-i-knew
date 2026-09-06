#!/bin/sh
# deploy/test/unit-file.test.sh — stage 4 testing requirement.
#
# 1. `systemd-analyze verify` on deploy/i-wish-i-knew.service when systemd is
#    present. When it is absent the test prints a VISIBLE skip notice and
#    exits 0 — never a silent pass.
# 2. Always: every ${VAR} the unit expands from its EnvironmentFile must be a
#    NAME listed in deploy/staging/env.example, and the unit must carry the
#    settings the stage spec requires.
#
# Wired into `npm test` (root package.json "test:deploy"), so the gate runs it.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
unit="$root/deploy/i-wish-i-knew.service"
envfile="$root/deploy/staging/env.example"

fail() {
  echo "unit-file.test: FAIL: $*" >&2
  exit 1
}

[ -f "$unit" ] || fail "missing $unit"
[ -f "$envfile" ] || fail "missing $envfile"

# --- static checks (run everywhere) -----------------------------------------
for needle in \
  'EnvironmentFile=/etc/i-wish-i-knew/env' \
  'Restart=on-failure' \
  '/readyz' \
  'StandardOutput=journal' \
  'ghcr.io/seanerama/i-wish-i-knew:${IWIK_IMAGE_TAG}'; do
  grep -qF -- "$needle" "$unit" || fail "unit lacks required setting: $needle"
done

# ${NAME} references in the unit (systemd expansion) must be documented names.
names=$(grep -o '\${[A-Z_][A-Z0-9_]*}' "$unit" | tr -d '${}' | sort -u)
for n in $names; do
  grep -qE "^$n=" "$envfile" || fail "unit expands \${$n} but deploy/staging/env.example does not list $n"
done

# The example must be names + placeholders only: no real-looking secrets.
if grep -qE 'AKIA[0-9A-Z]{16}|BEGIN (RSA |OPENSSH |EC )?PRIVATE KEY|ghp_[A-Za-z0-9]{20,}' "$envfile"; then
  fail "deploy/staging/env.example contains something that looks like a real secret"
fi
echo "unit-file.test: static checks ok ($(echo "$names" | wc -w | tr -d ' ') env names cross-checked)"

# --- systemd-analyze verify (when available) ---------------------------------
if ! command -v systemd-analyze >/dev/null 2>&1; then
  echo "unit-file.test: SKIP systemd-analyze verify - systemd-analyze not found on this machine (install systemd, or run this on a systemd host / CI ubuntu runner)"
  exit 0
fi

# verify wants the file to carry the unit name; work from a scratch copy.
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t iwik-unit)
trap 'rm -rf "$tmp"' EXIT
cp "$unit" "$tmp/i-wish-i-knew.service"
# --recursive-errors=no: judge THIS unit; a missing docker.service on a
# machine without Docker must not fail the check of our file's syntax.
if ! out=$(systemd-analyze verify --recursive-errors=no "$tmp/i-wish-i-knew.service" 2>&1); then
  echo "$out" >&2
  fail "systemd-analyze verify rejected deploy/i-wish-i-knew.service"
fi
# verify exits 0 on warnings; surface them so they are read, never hidden.
if [ -n "$out" ]; then
  echo "$out" | sed 's/^/unit-file.test: systemd-analyze: /'
fi
echo "unit-file.test: systemd-analyze verify ok ($(systemd-analyze --version | head -1))"
