#!/usr/bin/env bash
# verify.sh - cdk-bootstrap-free deploy integ.
#
# Proves cdkd needs NO `cdk bootstrap` at all in a fresh region:
#
#   Guard:   the target region must have neither the CDK bootstrap SSM
#            parameter (/cdk-bootstrap/hnb659fds/version) nor the CDK
#            bootstrap asset bucket — otherwise the test is vacuous.
#   Phase 1: `cdkd bootstrap --region <r>` with the state bucket living in
#            ANOTHER region (us-east-1) — the cross-region upgrade path
#            (state-bucket calls must go through a bucket-region client, not
#            the --region client, or HeadBucket 301s).
#   Phase 2: deploy an asset-bearing stack -> succeeds with no `cdk gc`
#            notice; the template's BootstrapVersion SSM parameter is NOT
#            resolved (a GetParameter would ParameterNotFound here); the
#            Lambda Code.S3Bucket points at cdkd-owned storage and the
#            asset object exists there.
#   Phase 3: assert the CDK bootstrap SSM parameter STILL does not exist —
#            nothing in the flow created or needed it.
#   Destroy + cleanup: stack destroyed cleanly; marker + asset bucket +
#            repo + log groups removed.
#
# SAFETY NOTE (issue #4063): this fixture creates AND deletes the region's
# default-named cdkd asset storage (marker cdkd-bootstrap/{region}.json,
# bucket cdkd-assets-{account}-{region}, repo cdkd-container-assets-{account}-{region}),
# so it must only run in a region that has none of the three (pick one via
# CDKD_BOOTSTRAP_FREE_REGION). `cleanup` deletes that storage only while
# STORAGE_OWNED=1, and the only line setting it sits directly after the ownership
# guard has PASSED: all three probed absent through the tri-state gone_probe,
# so a throttled or denied probe refuses the run instead of reading as
# "absent". Every exit before that point — the guard's own refusal, a missing
# STATE_BUCKET or dist/cli.js, the CDK-bootstrap guard — and the pre-run pass
# clean only stack-scoped leftovers.
# The guard cannot see storage another actor creates in the region after it
# passes, so never run a second copy of this fixture, or a deploy that may
# auto-create asset storage, in the same region concurrently.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId}), expected
#                  to live in a DIFFERENT region than the target region
# Optional:
#   CDKD_BOOTSTRAP_FREE_REGION - target region (default ca-central-1)

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

STACK="CdkdBootstrapFreeStack"
REGION="${CDKD_BOOTSTRAP_FREE_REGION:-ca-central-1}"
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
    # Storage created by THIS run — content-addressed, re-publishable.
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
  echo "FAIL: ${CDK_SSM_PARAM} exists in ${REGION} — this region has been 'cdk bootstrap'ed," >&2
  echo "      so the test would be vacuous. Pick another region via CDKD_BOOTSTRAP_FREE_REGION." >&2
  exit 1
fi
if aws s3api head-bucket --bucket "cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}" >/dev/null 2>&1; then
  echo "FAIL: CDK bootstrap asset bucket exists in ${REGION} — pick another region." >&2
  exit 1
fi
STATE_BUCKET_REGION=$(aws s3api get-bucket-location --bucket "${STATE_BUCKET}" \
  --query 'LocationConstraint' --output text 2>/dev/null)
if [ "${STATE_BUCKET_REGION}" = "None" ] || [ "${STATE_BUCKET_REGION}" = "null" ] || [ -z "${STATE_BUCKET_REGION}" ]; then
  STATE_BUCKET_REGION="us-east-1"
fi
if [ "${STATE_BUCKET_REGION}" = "${REGION}" ]; then
  echo "FAIL: state bucket lives in ${REGION} — the cross-region upgrade-path leg needs it elsewhere." >&2
  exit 1
fi
echo "    OK: ${REGION} is cdk-bootstrap-free; state bucket is in ${STATE_BUCKET_REGION}"

# Ownership guard (issue #4063): this fixture creates AND deletes the region's
# default-named asset storage, so any of the three existing already means it
# belongs to someone else — never proceed over it. Each probe is tri-state:
# "absent" is only a not-found answer, and any other failure exits here,
# before STORAGE_OWNED is set.
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"; then
  echo "FAIL: region ${REGION} already has a cdkd bootstrap marker (live asset storage)." >&2
  echo "      Pick a marker-free region via CDKD_BOOTSTRAP_FREE_REGION." >&2
  echo "      If this is a leftover from a previous crashed run of this fixture, clean it" >&2
  echo "      up first: node dist/cli.js bootstrap --destroy --region ${REGION} --yes" >&2
  exit 1
fi
if ! gone_probe aws s3api head-bucket --bucket "${ASSET_BUCKET}" --region "${REGION}"; then
  echo "FAIL: asset bucket ${ASSET_BUCKET} already exists (no marker) — not this run's to delete." >&2
  echo "      Pick another region via CDKD_BOOTSTRAP_FREE_REGION, or remove the bucket by hand" >&2
  echo "      once it is confirmed to be a leftover of this fixture." >&2
  exit 1
fi
if ! gone_probe aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" --region "${REGION}"; then
  echo "FAIL: container repo ${CONTAINER_REPO} already exists (no marker) — not this run's to delete." >&2
  echo "      Pick another region via CDKD_BOOTSTRAP_FREE_REGION, or remove the repo by hand" >&2
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

# --- Phase 1: cross-region cdkd bootstrap -----------------------------------
echo "==> Phase 1: cdkd bootstrap --region ${REGION} (state bucket in ${STATE_BUCKET_REGION})"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}"

MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)
if [ -z "${MARKER}" ]; then
  echo "FAIL: bootstrap marker missing at s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  exit 1
fi
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: marker body unexpected: ${MARKER}" >&2
  exit 1
fi
echo "    OK: cross-region bootstrap created asset storage + marker"

# --- Phase 2: deploy with zero CDK bootstrap --------------------------------
echo "==> Phase 2: deploy asset-bearing stack into ${REGION}"
if ! DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1); then
  echo "FAIL: deploy failed. Output tail:" >&2
  echo "${DEPLOY_OUT}" | tail -15 >&2
  exit 1
fi
echo "${DEPLOY_OUT}" | tail -3

if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: cdkd-assets-mode deploy printed the legacy 'cdk gc' notice" >&2
  exit 1
fi
echo "    OK: deploy succeeded with no legacy notice"

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
echo "    OK: Code.S3Bucket=${ASSET_BUCKET}, ${OBJ_COUNT} asset object(s) present"

# --- Phase 3: still no CDK bootstrap anywhere -------------------------------
assert_gone "${CDK_SSM_PARAM} appeared in ${REGION} during the test" aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}"
echo "    OK: ${CDK_SSM_PARAM} still absent — no CDK bootstrap was needed"

# --- Destroy -----------------------------------------------------------------
echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "state file still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
FN_COUNT=$(aws lambda list-functions --region "${REGION}" \
  --query "length(Functions[?starts_with(FunctionName, '${STACK}')] || \`[]\`)" --output text)
if [ "${FN_COUNT}" != "0" ]; then
  echo "FAIL: ${FN_COUNT} Lambda function(s) left after destroy" >&2
  exit 1
fi
echo "    OK: destroy clean (state gone, no leftover functions)"

echo "PASS: cdk-bootstrap-free bootstrap + deploy + destroy verified in ${REGION}"
