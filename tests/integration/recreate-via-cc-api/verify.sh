#!/usr/bin/env bash
# verify.sh — cdkd #615 --recreate-via-cc-api integ test
#
# Mid-life SDK→CC migration: a Lambda Function deployed without the
# silent-drop `RecursiveLoop` (= state stamps `provisionedBy: 'sdk'`)
# is destroyed + recreated via Cloud Control API when the next deploy
# adds `RecursiveLoop` AND passes `--recreate-via-cc-api`. The
# assertions confirm:
#
#   - state `provisionedBy` flips 'sdk' → 'cc-api'
#   - the Lambda's `RecursiveLoop` reaches AWS via CC
#   - the physical id changed (recreate produced a NEW Lambda function;
#     the old one was destroyed)
#   - destroy via CC API delete path is clean
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateViaCcApi"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-recreate-via-cc-api-probe"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
BUCKET_NAME="cdkd-recreate-via-cc-api-probe-${ACCOUNT_ID}"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # Empty + delete the S3 probe bucket if it leaked from a prior run.
  if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws s3 rm "s3://${BUCKET_NAME}/" --recursive >/dev/null 2>&1 || true
    aws s3 rb "s3://${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # IAM roles: `starts_with` is precise (CDK auto-names start with the stack id).
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
  set -eu
}

trap cleanup EXIT

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy WITHOUT RecursiveLoop (lands SDK) -----------------
echo "==> Phase 1: deploy ${STACK} WITHOUT RecursiveLoop (baseline → SDK route)"
unset CDKD_INTEG_USE_SILENT_DROP
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_1=$(echo "${STATE_1}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: baseline Lambda has provisionedBy='${PROVISIONED_1}', expected 'sdk' (no silent-drop → SDK)" >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline Lambda provisionedBy == 'sdk'"

# Capture the baseline Lambda's CodeSha256 so the recreate assertion can
# verify a NEW physical resource was created. The user-supplied
# `functionName` is stable across recreates (the destroy+create reuses
# the name), so physical-id alone is not a reliable witness; the
# CodeSha256 / FunctionArn:Version are different between two distinct
# Lambda instances even with the same name.
CODE_SHA_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'CodeSha256' --output text 2>/dev/null)
LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Baseline CodeSha256: ${CODE_SHA_1}  LastModified: ${LAST_MOD_1}"

# Baseline AWS check: RecursiveLoop should NOT be Allow yet (default Terminate).
RL_1=$(aws lambda get-function-recursion-config --function-name "${FN_NAME}" --region "${REGION}" --query 'RecursiveLoop' --output text 2>/dev/null)
if [ "${RL_1}" = "Allow" ]; then
  echo "FAIL: baseline Lambda has RecursiveLoop=Allow — fixture forgot to omit RecursiveLoop" >&2
  exit 1
fi
echo "    OK: baseline Lambda has no RecursiveLoop=Allow on AWS yet (RecursiveLoop='${RL_1}')"

# --- Phase 2: re-deploy WITH RecursiveLoop + --recreate-via-cc-api -----
echo "==> Phase 2: re-deploy ${STACK} WITH RecursiveLoop + --recreate-via-cc-api (destroy+recreate via CC)"
export CDKD_INTEG_USE_SILENT_DROP=true
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api RecreateProbe \
  --yes
unset CDKD_INTEG_USE_SILENT_DROP

STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_2=$(echo "${STATE_2}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: post-recreate Lambda has provisionedBy='${PROVISIONED_2}', expected 'cc-api' (recreate should have routed via CC)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: post-recreate Lambda provisionedBy flipped 'sdk' → 'cc-api'"

# Assert: a NEW Lambda was created (the old one was destroyed and a new one
# took its place). User-supplied `functionName` is stable across the
# recreate (CFn / cdkd reuses the name), so physical-id alone is not a
# witness. Compare LastModified instead — AWS stamps it at create time
# and the two timestamps MUST differ when distinct Lambda instances were
# involved. CodeSha256 is the same (same source code) so we use
# LastModified as the distinguishing signal.
LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Post-recreate LastModified: ${LAST_MOD_2}"
if [ "${LAST_MOD_2}" = "${LAST_MOD_1}" ]; then
  echo "FAIL: Lambda LastModified unchanged after --recreate-via-cc-api (expected destroy+recreate to produce a new Lambda instance with a fresh LastModified)" >&2
  echo "    Both: ${LAST_MOD_1}"
  exit 1
fi
echo "    OK: LastModified updated across recreate (old destroyed, new created)"

# Post-recreate AWS check: RecursiveLoop should now be Allow via CC.
RL_2=$(aws lambda get-function-recursion-config --function-name "${FN_NAME}" --region "${REGION}" --query 'RecursiveLoop' --output text 2>/dev/null)
if [ "${RL_2}" != "Allow" ]; then
  echo "FAIL: post-recreate Lambda has RecursiveLoop='${RL_2}', expected 'Allow' (CC should have forwarded RecursiveLoop)" >&2
  exit 1
fi
echo "    OK: post-recreate RecursiveLoop reached AWS via CC (RecursiveLoop=Allow)"

# --- Phase 3: S3 probe pre-flight refusal (#648) -----------------------
echo "==> Phase 3: pre-flight S3 ListObjectsV2 probe — non-empty bucket must be refused"
# Sanity check: the bucket was deployed empty.
OBJ_COUNT=$(aws s3api list-objects-v2 --bucket "${BUCKET_NAME}" --region "${REGION}" --max-items 1 --query 'KeyCount' --output text 2>/dev/null || echo "0")
echo "    Initial bucket object count: ${OBJ_COUNT}"

# Empty-bucket case: pre-flight should pass (no error block emitted). We
# use --dry-run + --force-stateful-recreation=false to exercise the
# probe without actually recreating the bucket (which would destroy it).
echo "    Sub-3a: empty bucket → pre-flight should pass under --dry-run"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api RecreateProbeBucket \
  --dry-run \
  --yes > /tmp/cdkd-648-empty.log 2>&1; then
  echo "FAIL: empty bucket pre-flight unexpectedly failed; expected --dry-run to clear:" >&2
  cat /tmp/cdkd-648-empty.log >&2
  exit 1
fi
if grep -qE 'has-objects|S3 bucket is non-empty' /tmp/cdkd-648-empty.log; then
  echo "FAIL: empty-bucket pre-flight surfaced has-objects error — probe falsely reported objects" >&2
  cat /tmp/cdkd-648-empty.log >&2
  exit 1
fi
echo "        OK: empty bucket passes pre-flight (no has-objects error)"

# Non-empty bucket case: pre-flight should refuse with has-objects.
echo "    Sub-3b: pre-stage 1 object via aws s3 cp"
echo "cdkd #648 probe payload" | aws s3 cp - "s3://${BUCKET_NAME}/probe-key.txt" --region "${REGION}" >/dev/null
echo "        OK: object placed"

echo "    Sub-3c: non-empty bucket → pre-flight must refuse without --force-stateful-recreation"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api RecreateProbeBucket \
  --dry-run \
  --yes > /tmp/cdkd-648-nonempty.log 2>&1
RC=$?
set -e
if [ ${RC} -eq 0 ]; then
  echo "FAIL: non-empty bucket pre-flight unexpectedly succeeded (expected refusal)" >&2
  cat /tmp/cdkd-648-nonempty.log >&2
  exit 1
fi
if ! grep -q 'RecreateProbeBucket' /tmp/cdkd-648-nonempty.log; then
  echo "FAIL: non-empty bucket pre-flight error did not name 'RecreateProbeBucket'" >&2
  cat /tmp/cdkd-648-nonempty.log >&2
  exit 1
fi
if ! grep -qE 'has-objects|S3 bucket is non-empty' /tmp/cdkd-648-nonempty.log; then
  echo "FAIL: non-empty bucket pre-flight error did not surface 'has-objects' reason" >&2
  cat /tmp/cdkd-648-nonempty.log >&2
  exit 1
fi
echo "        OK: non-empty bucket refused with has-objects reason"

# Empty the bucket so Phase 4 destroy can delete it.
echo "    Sub-3d: empty the bucket so destroy can clear it"
aws s3 rm "s3://${BUCKET_NAME}/" --recursive --region "${REGION}" >/dev/null
echo "        OK: bucket emptied"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy via CC delete path"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Lambda function is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: S3 probe bucket ${BUCKET_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: S3 probe bucket is gone"

# Audit follow-up: assert the IAM role was destroyed too — not just
# relying on the trap.
LEFTOVER_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" \
  --output text 2>/dev/null)
if [ -n "${LEFTOVER_ROLES}" ]; then
  echo "FAIL: IAM role(s) still exist after destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi
echo "    OK: IAM role is gone"

echo ""
echo "==> recreate-via-cc-api test passed (#615 mid-life SDK->CC migration + #648 S3 probe verified end-to-end)"
