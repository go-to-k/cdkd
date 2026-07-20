#!/usr/bin/env bash
# verify.sh — cdkd CUSTOM-named asset storage + gc lifecycle integ (issue #1026).
#
# Covers, in ONE deploy/destroy cycle, the two live paths that were only
# manually verified when #1011 (custom asset-storage names, PR #1021) and
# #1012 (`cdkd gc`, PR #1022) shipped:
#
#   Phase 1: `cdkd bootstrap --asset-bucket <unique> --container-repo <unique>`
#            -> custom-named asset bucket + ECR repo created; the bootstrap
#            marker at cdkd-bootstrap/{region}.json carries the CUSTOM names.
#   Phase 2: deploy a stack with a real FILE asset (Lambda Code.fromAsset over
#            a multi-file dir) -> the asset object lands in the CUSTOM bucket,
#            the function's Code.S3Bucket/Code.S3Key in cdkd state point at
#            it, and the deployed Lambda actually runs (invoke + marker).
#   Phase 3: seed one unreferenced object into the custom bucket ->
#            `cdkd gc --dry-run --older-than 0.0002h` lists ONLY the seeded
#            garbage (never the deploy-referenced asset) and deletes nothing;
#            `cdkd gc --yes --older-than 0.0002h` deletes the garbage while
#            the referenced asset object survives.
#   Phase 4: `cdkd destroy` the stack (referenced asset object persists by
#            design — content-addressed storage), then
#            `cdkd bootstrap --destroy --yes` (names read from the marker,
#            NO --force: the deployed-stack reference scan must pass clean)
#            -> custom bucket gone, custom repo gone, marker gone, state gone.
#
# SAFETY NOTE: the pre-run / trap cleanup reads the region's bootstrap marker
# and, when one exists AND its assetBucket carries this fixture's
# `cdkd-integ-gc-` prefix, runs `cdkd bootstrap --destroy --force --yes`
# against it — clearing leftovers from a previous crashed run even though
# their unique names are unknown. A marker owned by anything else (the
# region's default-named storage, another test) is left untouched, and the
# pre-run guard fails fast telling you to pick a marker-free region via
# AWS_REGION.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
    echo "FAIL: gone-probe undetermined ($*): ${out}" >&2
    exit 1
  fi
  return 0
}
assert_gone() { # usage: assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdGcCustomAssetNamesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# UNIQUE custom names per run (the S3 bucket namespace is global, and a
# re-run must never collide with a half-deleted previous bucket).
RUN_ID="$(date +%s)"
ASSET_BUCKET="cdkd-integ-gc-${ACCOUNT_ID}-${RUN_ID}"
CONTAINER_REPO="cdkd-integ-gc-repo-${ACCOUNT_ID}-${RUN_ID}"
if [ "${#ASSET_BUCKET}" -gt 63 ]; then
  echo "FAIL: computed asset bucket name '${ASSET_BUCKET}' exceeds 63 chars (${#ASSET_BUCKET})" >&2
  exit 1
fi

GARBAGE_KEY="integ-gc-seeded-garbage.bin"

cleanup() {
  echo "==> Cleanup: dropping stack state/resources + asset storage + marker"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    # Name-agnostic asset-storage teardown: read the region's marker (if
    # any) so leftovers from a PREVIOUS crashed run — whose unique names we
    # cannot recompute — are cleared via `bootstrap --destroy` (names come
    # from the marker). Print what the marker points at before destroying.
    # ONLY markers created by THIS fixture (assetBucket prefixed
    # cdkd-integ-gc-) are auto-destroyed — a default-named or foreign
    # marker means the region's asset storage is genuinely in use, and
    # tearing it down with --force could delete live assets of deployed
    # stacks. Those are left untouched (the pre-run guard below fails
    # fast on them instead).
    MARKER_LEFTOVER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
    if [ -n "${MARKER_LEFTOVER}" ]; then
      LEFTOVER_BUCKET=$(echo "${MARKER_LEFTOVER}" | jq -r '.assetBucket // empty' 2>/dev/null || true)
      echo "    pre-existing bootstrap marker for ${REGION} points at: ${MARKER_LEFTOVER}"
      case "${LEFTOVER_BUCKET}" in
        cdkd-integ-gc-*)
          echo "    destroying the marker's asset storage (leftover from a previous run of this fixture)"
          node "${LOCAL_DIST}" bootstrap --destroy --state-bucket "${STATE_BUCKET}" \
            --region "${REGION}" --force --yes >/dev/null 2>&1
          # Remove the marker key only once its bucket is really gone —
          # on a partial teardown the marker is the only machine-readable
          # record of the previous run's unique names, so keep it for the
          # next attempt instead of orphaning the resources namelessly.
          if [ -n "${LEFTOVER_BUCKET}" ] &&
            ! aws s3api head-bucket --bucket "${LEFTOVER_BUCKET}" >/dev/null 2>&1; then
            aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1
          else
            echo "    WARNING: teardown incomplete; keeping the marker for the next cleanup attempt"
          fi
          ;;
        *)
          echo "    marker is NOT this fixture's (bucket '${LEFTOVER_BUCKET}') — leaving it untouched"
          ;;
      esac
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Belt-and-braces: THIS run's uniquely-named bucket/repo (no-ops when the
  # marker-driven teardown above already removed them).
  aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
    --region "${REGION}" --force >/dev/null 2>&1 || true
  # The Lambda invoke in Phase 2 auto-creates a /aws/lambda/* log group that
  # neither CFn nor cdkd deletes — sweep it (CDK auto-names the function
  # with the stack name as prefix).
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null |
    tr '\t' '\n' | while read -r lg; do
      [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# Fail fast when the region's bootstrap marker belongs to something else
# (default-named storage or another test) — this fixture must own the
# region's marker for its bootstrap/gc/teardown cycle, and destroying a
# foreign marker's storage could delete live assets. Pick another region
# via AWS_REGION instead.
PRE_MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
if [ -n "${PRE_MARKER}" ]; then
  echo "FAIL: region ${REGION} already has a bootstrap marker in use: ${PRE_MARKER}" >&2
  echo "      Run this test in a region without cdkd asset storage (e.g. AWS_REGION=us-west-2)." >&2
  exit 1
fi

# --- Phase 1: bootstrap with CUSTOM names ----------------------------------
echo "==> Phase 1: cdkd bootstrap --asset-bucket ${ASSET_BUCKET} --container-repo ${CONTAINER_REPO}"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --asset-bucket "${ASSET_BUCKET}" --container-repo "${CONTAINER_REPO}"

MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
if [ -z "${MARKER}" ]; then
  echo "FAIL: bootstrap marker missing at s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  exit 1
fi
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.containerRepo')" != "${CONTAINER_REPO}" ]; then
  echo "FAIL: marker does not carry the CUSTOM names: ${MARKER}" >&2
  exit 1
fi
echo "    OK: marker carries the custom assetBucket + containerRepo"

if ! aws s3api head-bucket --bucket "${ASSET_BUCKET}" >/dev/null 2>&1; then
  echo "FAIL: custom asset bucket ${ASSET_BUCKET} was not created" >&2
  exit 1
fi
if ! aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: custom container repo ${CONTAINER_REPO} was not created" >&2
  exit 1
fi
echo "    OK: custom asset bucket + custom ECR repo exist"

# --- Phase 2: deploy — FILE asset must land in the CUSTOM bucket ------------
echo "==> Phase 2: deploy (file asset publish -> custom bucket)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || true)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
CODE_BUCKET=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Bucket] | first')
CODE_KEY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Key] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the Lambda function name from state" >&2
  echo "${STATE}" | jq . >&2
  exit 1
fi
if [ "${CODE_BUCKET}" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: state Code.S3Bucket is '${CODE_BUCKET}', expected the CUSTOM bucket '${ASSET_BUCKET}'" >&2
  exit 1
fi
if [ -z "${CODE_KEY}" ] || [ "${CODE_KEY}" = "null" ]; then
  echo "FAIL: state Code.S3Key is empty" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: referenced asset object s3://${ASSET_BUCKET}/${CODE_KEY} does not exist" >&2
  exit 1
fi
echo "    OK: state Code points at s3://${ASSET_BUCKET}/${CODE_KEY} and the object exists"

# Functional assertion: the deployed Lambda actually runs the uploaded asset.
OUT_FILE="$(mktemp)"
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT
trap 'rm -f "${OUT_FILE}"; (exit 130); cleanup; exit 130' INT
trap 'rm -f "${OUT_FILE}"; (exit 143); cleanup; exit 143' TERM
aws lambda invoke \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  "${OUT_FILE}" >/dev/null
RESP_MARKER=$(jq -r '.marker // empty' "${OUT_FILE}")
if [ "${RESP_MARKER}" != "cdkd-gc-custom-asset-names-marker-v1" ]; then
  echo "FAIL: Lambda invoke marker is '${RESP_MARKER}', expected 'cdkd-gc-custom-asset-names-marker-v1'. Raw response:" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi
echo "    OK: Lambda invoke returned the asset marker (uploaded ZIP is the running code)"

# --- Phase 3: gc — seeded garbage deleted, referenced asset kept ------------
echo "==> Phase 3: seed unreferenced object + cdkd gc"
printf 'seeded unreferenced garbage for the cdkd gc integ\n' |
  aws s3 cp - "s3://${ASSET_BUCKET}/${GARBAGE_KEY}"
# --older-than 0.0002h (~0.72s) age guard: sleep so the seeded object is
# strictly older than the cutoff when gc lists the bucket. 5s (not 2s)
# keeps the margin clock-skew-proof — gc compares local Date.now()
# against S3's AWS-stamped LastModified.
sleep 5

if ! DRY_OUT=$(node "${LOCAL_DIST}" gc --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --older-than 0.0002h --dry-run 2>&1); then
  echo "FAIL: gc --dry-run exited non-zero. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
echo "${DRY_OUT}" | tail -5

if ! echo "${DRY_OUT}" | grep -qF "s3://${ASSET_BUCKET}/${GARBAGE_KEY}"; then
  echo "FAIL: gc --dry-run plan does not list the seeded garbage object. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if echo "${DRY_OUT}" | grep -qF "${CODE_KEY}"; then
  echo "FAIL: gc --dry-run plan lists the deploy-referenced asset ${CODE_KEY} — it would delete a live asset. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if ! echo "${DRY_OUT}" | grep -qF "Total: 1 S3 object(s)"; then
  echo "FAIL: gc --dry-run plan should contain exactly 1 S3 candidate (the seeded garbage). Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if ! echo "${DRY_OUT}" | grep -qF "0 ECR image(s)"; then
  echo "FAIL: gc --dry-run plan should contain 0 ECR candidates. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${GARBAGE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: gc --dry-run DELETED the seeded object (dry run must not delete)" >&2
  exit 1
fi
echo "    OK: dry-run plan lists ONLY the seeded garbage (1 S3 object, 0 ECR images) and deleted nothing"

echo "==> Phase 3b: cdkd gc --yes (real deletion)"
node "${LOCAL_DIST}" gc --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --older-than 0.0002h --yes

assert_gone "seeded garbage object still exists after gc --yes" aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${GARBAGE_KEY}"
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: gc deleted the deploy-referenced asset s3://${ASSET_BUCKET}/${CODE_KEY}" >&2
  exit 1
fi
echo "    OK: gc deleted the seeded garbage and kept the referenced asset"

# --- Phase 4: destroy stack, then bootstrap --destroy ------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# Content-addressed asset storage is never deleted on `cdkd destroy` (a
# rollback or another stack may reference the same hash) — the object must
# survive until `bootstrap --destroy` empties the bucket.
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: asset object s3://${ASSET_BUCKET}/${CODE_KEY} vanished on destroy (content-addressed storage must persist)" >&2
  exit 1
fi
echo "    OK: stack + state gone; content-addressed asset object persists (by design)"

echo "==> Phase 4b: cdkd bootstrap --destroy (names read from the marker, no --force)"
node "${LOCAL_DIST}" bootstrap --destroy --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes

assert_gone "custom asset bucket ${ASSET_BUCKET} still exists after bootstrap --destroy" aws s3api head-bucket --bucket "${ASSET_BUCKET}"
assert_gone "custom container repo ${CONTAINER_REPO} still exists after bootstrap --destroy" aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" --region "${REGION}"
assert_gone "bootstrap marker ${MARKER_KEY} still exists after bootstrap --destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"
echo "    OK: custom bucket gone, custom repo gone, marker gone — zero residue"

echo "[verify] PASS — custom-named asset storage bootstrap, publish-to-custom-bucket, gc dry-run/delete precision, and marker-driven teardown all verified"
