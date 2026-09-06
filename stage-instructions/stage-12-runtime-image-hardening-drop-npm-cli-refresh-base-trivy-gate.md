# Stage 12: Runtime image hardening: drop npm CLI, refresh base, Trivy gate

- **Type:** chore
- **Depends on:** none
- **Milestone:** 0.3 protected cooperative answers
- **Work-item:** https://github.com/seanerama/i-wish-i-knew/issues/18
- **Design refs:** ship pre-flight scan of `v0.0.1` (Trivy 0.69): 1 CRITICAL + 10 HIGH in the npm CLI bundled under `/usr/local/lib/node_modules/npm` (tar, pacote, sigstore, ip-address, brace-expansion, picomatch) and 2 HIGH in Alpine `libssl3`/`libcrypto3` 3.5.7-r0; none in application dependencies. Verity ship process step 3 (build → scan → digests).

## Objectives

Ship an image whose scan is clean at HIGH/CRITICAL, and make the scan a gate
so it stays that way.

## What to build

- `Dockerfile`: runtime stage removes the npm CLI (`rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx`) after install, or switches the runtime stage to a distroless/`node:22-alpine` variant without npm; refresh the pinned base digest to the current `node:22-alpine` (Alpine 3.24.x with fixed OpenSSL) and record the digest; keep non-root, explicit COPY, and the existing `test !` assertions; add `test ! -e /usr/local/bin/npm`.
- `.github/workflows/release.yml`: add a Trivy step (`aquasecurity/trivy-action`, pinned) after build, `severity: HIGH,CRITICAL`, `ignore-unfixed: true`, `exit-code: 1`, scanning the pushed multi-arch reference; emit the digest as a job output and as a `release-digests.txt` artifact for the Operator to pin.
- `.github/workflows/ci.yml`: the `release-dry-run` job scans the amd64 build the same way (no push), so a vulnerable dependency fails the PR, not the tag.
- `deploy/staging/README.md` §0: note the digest artifact; `deploy/staging/deploy.sh` unchanged (already pins by digest).

## Interface contracts

- **Exposes:** scanned image + digest artifact.
- **Consumes:** nothing new.

## Testing requirements

- Local: `docker build` then Trivy HIGH/CRITICAL with `--ignore-unfixed` returns zero findings; `test:deploy` still green; image runs `/readyz` via compose.
- CI: `release-dry-run` shows the scan step passing.

## Acceptance conditions

- [ ] Clear exit-state defined (what "done" means here): a throwaway `v0.0.2-rc.1`-style tag is NOT required; the CI dry-run scan passing plus a local clean scan of the built image is the exit state. The next real tag cut by `/verity:ship` must pass the release scan.
- [ ] Existing suite stays green; CI all-green
- [ ] No existing CI job weakened; scan cannot be skipped.

## Pipeline test: NO
