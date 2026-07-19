#!/usr/bin/env bash
# verify.sh — raw-CFn-template (CfnInclude) diff-vs-deploy parity (issues #1027 / #1028).
#
# A raw CloudFormation template ingested via CfnInclude carries Parameters
# (with defaults), Mappings, and Conditions — notations CDK-synthesized
# templates rarely emit. Pre-fix, `cdkd diff` did not bind parameters or
# evaluate conditions (deploy did), so a no-op diff reported a phantom
# `[requires replacement]` on QueueName, a phantom `to create` for the
# condition-false resource, and spurious value changes; and every deploy
# warned `Failed to resolve output` for the condition-false output.
#
# Phases:
#   1. Deploy baseline (RetentionSeconds=120 via template Default). Assert:
#      queue retention 120, EnvParam resolved (`dev:...`), prod-only resource
#      + output ABSENT, and NO "Failed to resolve output" warn (#1028).
#   2. No-op `cdkd diff --fail` must exit 0 (#1027 — pre-fix it reported
#      1 to create + 2 to update on a freshly deployed stack).
#   3. UPDATE (CDKD_TEST_UPDATE=true inlines RetentionSeconds=600). The diff
#      must show ONLY the real in-place update (no create, no replacement);
#      the deploy must update in place (same QueueUrl) to retention 600.
#   4. Post-update no-op diff --fail exits 0 again.
#   5. Destroy + assert queue/params/state gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdRawCfnCondParamsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
QUEUE_NAME="cdkd-raw-cfn-cond-dev-q"
ENV_PARAM="/cdkd-raw-cfn-cond/env"
PROD_PARAM="/cdkd-raw-cfn-cond/prod-only"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  QURL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${QURL}" ] && [ "${QURL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${QURL}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${ENV_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PROD_PARAM}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (retention 120 via parameter Default) ----
echo "==> Phase 1: deploy baseline (RetentionSeconds default = 120)"
DEPLOY_LOG="$(mktemp)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"

if grep -q "Failed to resolve output" "${DEPLOY_LOG}"; then
  echo "FAIL: deploy warned 'Failed to resolve output' for a condition-false output (#1028)" >&2
  exit 1
fi
echo "    OK: no condition-false output warn (#1028)"

QURL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text)"
RETENTION_P1="$(aws sqs get-queue-attributes --queue-url "${QURL}" \
  --attribute-names MessageRetentionPeriod --region "${REGION}" \
  --query 'Attributes.MessageRetentionPeriod' --output text)"
if [ "${RETENTION_P1}" != "120" ]; then
  echo "FAIL: expected retention 120 after Phase 1, got '${RETENTION_P1}'" >&2
  exit 1
fi
echo "    OK: queue retention == 120 (parameter Default applied)"

ENV_VALUE="$(aws ssm get-parameter --name "${ENV_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${ENV_VALUE}" != "dev:${QUEUE_NAME}:${STACK}" ]; then
  echo "FAIL: expected EnvParam 'dev:${QUEUE_NAME}:${STACK}', got '${ENV_VALUE}'" >&2
  exit 1
fi
echo "    OK: Fn::Sub over parameter + GetAtt resolved (${ENV_VALUE})"

if aws ssm get-parameter --name "${PROD_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: condition-false resource ${PROD_PARAM} was created" >&2
  exit 1
fi
echo "    OK: condition-false resource not created"

if aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -e '.outputs.ProdParamName' >/dev/null 2>&1; then
  echo "FAIL: condition-false output ProdParamName persisted to state outputs (#1028)" >&2
  exit 1
fi
echo "    OK: condition-false output not persisted to state"

# --- Phase 2: no-op diff must be clean (#1027) --------------------------
echo "==> Phase 2: no-op diff --fail (must exit 0 with no changes)"
DIFF_LOG="$(mktemp)"
if ! env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail > "${DIFF_LOG}" 2>&1; then
  echo "FAIL: no-op diff reported changes on a freshly deployed stack (#1027):" >&2
  cat "${DIFF_LOG}" >&2
  exit 1
fi
echo "    OK: no-op diff is clean"

# --- Phase 3: UPDATE (retention 120 -> 600, in place) -------------------
echo "==> Phase 3: diff + deploy with RetentionSeconds=600"
UPDATE_DIFF_LOG="$(mktemp)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" > "${UPDATE_DIFF_LOG}" 2>&1 || true
cat "${UPDATE_DIFF_LOG}"

if grep -q "requires replacement" "${UPDATE_DIFF_LOG}"; then
  echo "FAIL: update diff claims a replacement for an unchanged create-only property (#1027)" >&2
  exit 1
fi
if ! grep -q "0 to create, 1 to update, 0 to delete" "${UPDATE_DIFF_LOG}"; then
  echo "FAIL: update diff should report exactly '0 to create, 1 to update, 0 to delete' (#1027)" >&2
  exit 1
fi
echo "    OK: update diff shows only the real in-place update"

CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

QURL_P3="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text)"
if [ "${QURL_P3}" != "${QURL}" ]; then
  echo "FAIL: queue was replaced (URL changed) instead of updated in place" >&2
  exit 1
fi
RETENTION_P3="$(aws sqs get-queue-attributes --queue-url "${QURL_P3}" \
  --attribute-names MessageRetentionPeriod --region "${REGION}" \
  --query 'Attributes.MessageRetentionPeriod' --output text)"
if [ "${RETENTION_P3}" != "600" ]; then
  echo "FAIL: expected retention 600 after UPDATE, got '${RETENTION_P3}'" >&2
  exit 1
fi
echo "    OK: in-place UPDATE applied (retention 600, same queue)"

# --- Phase 4: post-update no-op diff ------------------------------------
echo "==> Phase 4: post-update no-op diff --fail (must exit 0)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail >/dev/null 2>&1; then
  echo "FAIL: post-update no-op diff reported changes (#1027)" >&2
  exit 1
fi
echo "    OK: post-update no-op diff is clean"

# --- Phase 5: destroy ----------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: queue ${QUEUE_NAME} still exists after destroy" >&2
  exit 1
fi
if aws ssm get-parameter --name "${ENV_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: parameter ${ENV_PARAM} still exists after destroy" >&2
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: queue, parameters, and cdkd state removed"

echo "[verify] PASS — raw-CFn Parameters/Conditions diff-deploy parity (#1027) + condition-false output skip (#1028), all 5 phases passed"
