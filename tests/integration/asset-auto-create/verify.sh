#!/usr/bin/env bash
# verify.sh - deploy-time asset-storage auto-create integ (issue #1007).
#
# Proves the first `cdkd deploy` into an un-opted-in region auto-creates the
# per-region cdkd asset storage — no `cdkd bootstrap --region <r>` needed:
#
#   Guard:   the target region must have neither the CDK bootstrap SSM
#            parameter nor the CDK bootstrap asset bucket, and none of the
#            cdkd asset storage (marker, bucket, repo) — see the SAFETY NOTE.
#   Phase 1: deploy with --yes and NO prior bootstrap -> the auto-create
#            info line + bucket/repo/marker creation appear in the deploy
#            output; no legacy `cdk gc` notice; Lambda Code.S3Bucket points
#            at cdkd-owned storage and the asset object exists there;
#            destroy cleanly.
#   Phase 2: full storage cleanup, then deploy with --no-auto-asset-storage
#            -> stays legacy (gc notice present, no auto-create line, no
#            marker written). In this cdk-bootstrap-free region the legacy
#            publish then fails (the CDK bootstrap bucket does not exist) —
#            the expected outcome; assert the failure is the legacy publish,
#            not the auto-create path.
#   Phase 3: deploy with --skip-assets -> auto-create must NOT fire (no
#            info line, no marker) — it would rewrite already-published
#            legacy references to a freshly created empty bucket.
#   Cleanup: stack state/resources + asset storage + marker + log groups.
#
# SAFETY NOTE (issue #4063): this fixture creates AND deletes the region's
# default-named cdkd asset storage (marker cdkd-bootstrap/{region}.json,
# bucket cdkd-assets-{account}-{region}, repo cdkd-container-assets-{account}-{region}),
# so it must only run in a region that has none of the three (pick one via
# CDKD_AUTO_CREATE_REGION). `cleanup` deletes that storage only while
# STORAGE_OWNED=1, and the only line setting it sits directly after the ownership
# guard has PASSED: all three probed absent through the tri-state gone_probe,
# so a throttled or denied probe refuses the run instead of reading as
# "absent". Every exit before that point — the guard's own refusal, a missing
# STATE_BUCKET or dist/cli.js, the CDK-bootstrap guard — cleans only
# stack-scoped leftovers.
# The guard cannot see storage another actor creates in the region after it
# passes, so never run a second copy of this fixture, or a deploy that may
# auto-create asset storage, in the same region concurrently.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
# Optional:
#   CDKD_AUTO_CREATE_REGION - target region (default ca-central-1)

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
# The first-arg guard catches a forgotten assert_gone description: without it,
# `assert_gone aws ...` would exec `lambda get-function ...` and the shell's
# "command not found" error would match the signature -- a silent pass.
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  [ "${1:-}" = "aws" ] || { echo "FAIL: gone_probe: probe must start with aws (got: ${1:-<empty>})" >&2; exit 1; }
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
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

STACK="CdkdAssetAutoCreateStack"
REGION="${CDKD_AUTO_CREATE_REGION:-ca-central-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ASSET_BUCKET="cdkd-assets-${ACCOUNT_ID}-${REGION}"
CONTAINER_REPO="cdkd-container-assets-${ACCOUNT_ID}-${REGION}"
CDK_SSM_PARAM="/cdk-bootstrap/hnb659fds/version"

# 1 only once the ownership guard below has passed (see the SAFETY NOTE).
STORAGE_OWNED=0

cleanup() {
  # The asset-storage deletion runs only when the ownership guard has passed
  # (STORAGE_OWNED=1) AND this is not the "prerun" pass; every other call
  # cleans stack-scoped leftovers only.
  echo "==> Cleanup: dropping stack state/resources${1:+ (stack-scoped only)}"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  if [ "${1:-}" != "prerun" ] && [ "${STORAGE_OWNED}" = "1" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
    fi
    # Storage created by THIS run (auto-create) — objects are
    # content-addressed and re-publishable, so force-remove.
    aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
    aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
      --region "${REGION}" --force >/dev/null 2>&1 || true
  fi
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

# --- Guard: the region must be genuinely cdk-bootstrap-free ----------------
if aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${CDK_SSM_PARAM} exists in ${REGION} — the legacy-failure leg of this test" >&2
  echo "      would be vacuous. Pick another region via CDKD_AUTO_CREATE_REGION." >&2
  exit 1
fi
if aws s3api head-bucket --bucket "cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}" >/dev/null 2>&1; then
  echo "FAIL: CDK bootstrap asset bucket exists in ${REGION} — pick another region." >&2
  exit 1
fi
echo "    OK: ${REGION} is cdk-bootstrap-free"

# Ownership guard (issues #1052, #4063): this fixture creates AND deletes the
# region's default-named asset storage, so any of the three existing already
# means it belongs to someone else — never proceed over it. Each probe is
# tri-state: "absent" is only a not-found answer, and any other failure exits
# here, before STORAGE_OWNED is set.
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"; then
  echo "FAIL: region ${REGION} already has a cdkd bootstrap marker (live asset storage)." >&2
  echo "      Pick a marker-free region via CDKD_AUTO_CREATE_REGION." >&2
  echo "      If this is a leftover from a previous crashed run of this fixture, clean it" >&2
  echo "      up first: node dist/cli.js bootstrap --destroy --region ${REGION} --yes" >&2
  exit 1
fi
if ! gone_probe aws s3api head-bucket --bucket "${ASSET_BUCKET}" --region "${REGION}"; then
  echo "FAIL: asset bucket ${ASSET_BUCKET} already exists (no marker) — not this run's to delete." >&2
  echo "      Pick another region via CDKD_AUTO_CREATE_REGION, or remove the bucket by hand" >&2
  echo "      once it is confirmed to be a leftover of this fixture." >&2
  exit 1
fi
if ! gone_probe aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" --region "${REGION}"; then
  echo "FAIL: container repo ${CONTAINER_REPO} already exists (no marker) — not this run's to delete." >&2
  echo "      Pick another region via CDKD_AUTO_CREATE_REGION, or remove the repo by hand" >&2
  echo "      once it is confirmed to be a leftover of this fixture." >&2
  exit 1
fi
STORAGE_OWNED=1

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (stack-scoped only)"
cleanup prerun

GC_NOTICE="may garbage-collect"
AUTO_CREATE_LINE="Creating cdkd asset storage for region '${REGION}'"

# --- Phase 1: first deploy auto-creates the asset storage -------------------
echo "==> Phase 1: deploy with NO prior bootstrap (auto-create expected)"
if ! DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1); then
  echo "FAIL: deploy failed. Output tail:" >&2
  echo "${DEPLOY_OUT}" | tail -15 >&2
  exit 1
fi
echo "${DEPLOY_OUT}" | tail -3

if ! echo "${DEPLOY_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: deploy output lacks the auto-create info line" >&2
  exit 1
fi
if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: auto-create deploy still printed the legacy 'cdk gc' notice" >&2
  exit 1
fi
MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: marker missing/unexpected after auto-create: ${MARKER}" >&2
  exit 1
fi
CODE_BUCKET=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
  jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Bucket')
if [ "${CODE_BUCKET}" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: Lambda Code.S3Bucket is '${CODE_BUCKET}', expected '${ASSET_BUCKET}'" >&2
  exit 1
fi
OBJ_COUNT=$(aws s3api list-objects-v2 --bucket "${ASSET_BUCKET}" --region "${REGION}" \
  --query 'length(Contents || `[]`)' --output text)
case "${OBJ_COUNT}" in
  '' | *[!0-9]*)
    echo "FAIL: could not count asset objects (got '${OBJ_COUNT}')" >&2
    exit 1
    ;;
esac
if [ "${OBJ_COUNT}" -lt 1 ]; then
  echo "FAIL: no asset objects in ${ASSET_BUCKET}" >&2
  exit 1
fi
echo "    OK: auto-create line present, no gc notice, marker + Code.S3Bucket + ${OBJ_COUNT} object(s)"

echo "==> Phase 1 destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
assert_gone "state file still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroy clean"

# --- Phase 2: --no-auto-asset-storage stays legacy ---------------------------
echo "==> Phase 2: cleanup storage, deploy with --no-auto-asset-storage (legacy expected)"
cleanup

set +e
OPTOUT_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-auto-asset-storage \
  --yes 2>&1)
OPTOUT_RC=$?
set -e
echo "${OPTOUT_OUT}" | tail -3

if echo "${OPTOUT_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: --no-auto-asset-storage deploy still printed the auto-create line" >&2
  exit 1
fi
if ! echo "${OPTOUT_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: --no-auto-asset-storage deploy did not print the legacy gc notice" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"; then
  echo "FAIL: bootstrap marker was written despite --no-auto-asset-storage" >&2
  exit 1
fi
# In a cdk-bootstrap-free region the legacy publish has no bucket to target,
# so the deploy is EXPECTED to fail — at the publish step, not before.
if [ "${OPTOUT_RC}" -eq 0 ]; then
  echo "FAIL: legacy deploy unexpectedly succeeded in a cdk-bootstrap-free region" >&2
  exit 1
fi
if ! echo "${OPTOUT_OUT}" | grep -q "asset-publish"; then
  echo "FAIL: opt-out deploy failed somewhere other than the legacy asset publish. Output tail:" >&2
  echo "${OPTOUT_OUT}" | tail -10 >&2
  exit 1
fi
echo "    OK: opt-out stayed legacy (gc notice, no marker) and failed only at the legacy publish"

# --- Phase 3: --skip-assets never auto-creates -------------------------------
# Reviewer catch on PR 1008: auto-create under --skip-assets would rewrite
# already-published legacy references to a freshly created EMPTY bucket.
echo "==> Phase 3: deploy with --skip-assets (no auto-create expected)"
set +e
SKIP_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}"   --state-bucket "${STATE_BUCKET}"   --region "${REGION}"   --skip-assets   --yes 2>&1)
SKIP_RC=$?
set -e
echo "${SKIP_OUT}" | tail -3

if echo "${SKIP_OUT}" | grep -qF "${AUTO_CREATE_LINE}"; then
  echo "FAIL: --skip-assets deploy auto-created asset storage" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"; then
  echo "FAIL: bootstrap marker was written under --skip-assets" >&2
  exit 1
fi
# The deploy itself fails downstream (nothing was ever published in this
# fresh region) — the assertion here is only that auto-create did NOT fire.
if [ "${SKIP_RC}" -eq 0 ]; then
  echo "FAIL: --skip-assets deploy unexpectedly succeeded with never-published assets" >&2
  exit 1
fi
echo "    OK: --skip-assets stayed legacy (no auto-create line, no marker)"

# --- Still no CDK bootstrap anywhere ----------------------------------------
assert_gone "${CDK_SSM_PARAM} appeared in ${REGION} during the test" aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}"

echo "PASS: asset-storage auto-create + opt-out verified in ${REGION}"
