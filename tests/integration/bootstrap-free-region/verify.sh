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
#            repo + log groups removed (canonical per-region storage on the
#            dedicated test account; assets are content-addressed and
#            re-publishable — same stance as asset-migration).
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId}), expected
#                  to live in a DIFFERENT region than the target region
# Optional:
#   CDKD_BOOTSTRAP_FREE_REGION - target region (default ca-central-1)

set -euo pipefail

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

cleanup() {
  echo "==> Cleanup: dropping stack state/resources + asset storage + marker"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
  fi
  # Canonical per-region cdkd asset storage on the dedicated test account —
  # objects are content-addressed and re-publishable, so force-remove.
  aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
    --region "${REGION}" --force >/dev/null 2>&1 || true
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null |
    tr '\t' '\n' | while read -r lg; do
      [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
  set -eu
}

trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

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
if aws ssm get-parameter --name "${CDK_SSM_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ${CDK_SSM_PARAM} appeared in ${REGION} during the test" >&2
  exit 1
fi
echo "    OK: ${CDK_SSM_PARAM} still absent — no CDK bootstrap was needed"

# --- Destroy -----------------------------------------------------------------
echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still present after destroy" >&2
  exit 1
fi
FN_COUNT=$(aws lambda list-functions --region "${REGION}" \
  --query "length(Functions[?starts_with(FunctionName, '${STACK}')] || \`[]\`)" --output text)
if [ "${FN_COUNT}" != "0" ]; then
  echo "FAIL: ${FN_COUNT} Lambda function(s) left after destroy" >&2
  exit 1
fi
echo "    OK: destroy clean (state gone, no leftover functions)"

echo "PASS: cdk-bootstrap-free bootstrap + deploy + destroy verified in ${REGION}"
