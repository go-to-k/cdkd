#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd migrate --from-cfn-stack`.
#
# Flow:
#   1. Resolve AWS account id + cdkd state bucket.
#   2. Create a bare (non-CDK) CFn stack from bare-cfn-template.json:
#      one S3 bucket + one SSM parameter + one SNS topic, each with
#      explicit physical names so concurrent runs do not collide on
#      AWS-globally-unique buckets.
#   3. Run `cdkd migrate --from-cfn-stack <name> --retire-cfn-stack --yes`
#      against the source stack.
#   4. Assert: (a) generated CDK app dir exists under /tmp; (b) cdkd
#      state contains all 3 resources; (c) source CFn stack reached
#      DELETE_COMPLETE (retirement happened); (d) AWS resources still
#      exist (head-bucket / get-parameter / get-topic-attributes).
#   5. Run `cdkd destroy <stack> --force` to clean up the migrated stack
#      and AWS-side resources.
#   6. Assert: all 3 AWS resources are gone (head-bucket / get-parameter
#      / get-topic-attributes all 404); cdkd state record is gone.
#
# Trap cleanup unconditionally tears down whatever state remains on any
# failure path so leftover orphans never persist.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/migrate-from-bare-cfn"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Per-run unique suffix so concurrent / re-runs do not collide.
SUFFIX="$(date +%s%N | tail -c 8)"
SOURCE_STACK="CdkdMigrateIntegSource-${SUFFIX}"
OUTPUT_DIR="/tmp/cdkd-migrate-integ-${SUFFIX}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

# Physical names the bare-CFn template produces (matches Fn::Sub patterns
# in bare-cfn-template.json) so the post-destroy verify can assert AWS
# returns 404 on each one.
BUCKET_NAME="cdkd-migrate-integ-${SUFFIX}-${ACCOUNT_ID}"
PARAM_NAME="/cdkd/migrate-integ/${SUFFIX}/value"
TOPIC_NAME="cdkd-migrate-integ-${SUFFIX}"
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"

echo "[verify] region=${REGION} source-stack=${SOURCE_STACK} state-bucket=${STATE_BUCKET}"
echo "[verify] output-dir=${OUTPUT_DIR}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  # 1. cdkd-managed state path: destroy the migrated cdkd stack so
  #    the underlying AWS resources go away. Best-effort; ignore errors
  #    so the source-CFn fallback below still fires.
  #
  # Guard against the early-failure case where step 1 (build) failed
  # before dist/cli.js was produced — invoking ${CLI} then yields a
  # confusing `node: cannot find module` error that masks the real
  # failure. Skip cdkd-driven destroy and rely on the AWS-direct
  # fallback (step 3 below) which can clean the resources without
  # cdkd.
  if [ ! -f "${REPO_ROOT}/dist/cli.js" ]; then
    echo "[verify] cleanup: skipping cdkd destroy — ${REPO_ROOT}/dist/cli.js not present (build failed); falling back to AWS CLI direct cleanup below"
  elif aws s3api head-object \
      --bucket "${STATE_BUCKET}" \
      --key "cdkd/${SOURCE_STACK}/${REGION}/state.json" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${SOURCE_STACK}"
    ${CLI} destroy "${SOURCE_STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force 2>&1 || true
  fi
  # 2. If the source CFn stack is still alive (migration failed before
  #    retirement), tear it down via raw CFn.
  if aws cloudformation describe-stacks \
      --stack-name "${SOURCE_STACK}" \
      --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${SOURCE_STACK}"
    aws cloudformation delete-stack --stack-name "${SOURCE_STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${SOURCE_STACK}" --region "${REGION}" || true
  fi
  # 3. Belt and braces: if any of the AWS resources still exist
  #    (manual cleanup escape hatch when both 1 and 2 failed) delete
  #    them by direct API call.
  if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws s3 rb s3://${BUCKET_NAME} --force"
    aws s3 rb "s3://${BUCKET_NAME}" --force --region "${REGION}" || true
  fi
  if aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws ssm delete-parameter ${PARAM_NAME}"
    aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" || true
  fi
  if aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws sns delete-topic ${TOPIC_ARN}"
    aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" || true
  fi
  # 4. Generated CDK app dir: rm -rf so /tmp does not accumulate per-run.
  if [ -d "${OUTPUT_DIR}" ]; then
    echo "[verify] cleanup: rm -rf ${OUTPUT_DIR}"
    rm -rf "${OUTPUT_DIR}"
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: create source CFn stack from bare-cfn-template.json"
aws cloudformation create-stack \
  --stack-name "${SOURCE_STACK}" \
  --region "${REGION}" \
  --template-body "file://${TEST_DIR}/bare-cfn-template.json" \
  --parameters "ParameterKey=ResourceSuffix,ParameterValue=${SUFFIX}"
aws cloudformation wait stack-create-complete \
  --stack-name "${SOURCE_STACK}" \
  --region "${REGION}"
echo "[verify] step 2 ok: source CFn stack created"

echo "[verify] step 3: assert AWS resources exist before migration"
aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null
aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null
echo "[verify] step 3 ok: bucket / parameter / topic all live"

echo "[verify] step 4: cdkd migrate --from-cfn-stack ${SOURCE_STACK} --retire-cfn-stack --yes"
${CLI} migrate \
  --from-cfn-stack "${SOURCE_STACK}" \
  --output-dir "${OUTPUT_DIR}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --retire-cfn-stack \
  --yes \
  --verbose
echo "[verify] step 4 ok: migrate command exited 0"

echo "[verify] step 5: assert generated CDK app exists at ${OUTPUT_DIR}/${SOURCE_STACK}"
# `cdk migrate --output-path <X> --stack-name <Y>` writes the generated app
# into the `<X>/<Y>` subdirectory (verified empirically against cdk 2.1112.0
# on 2026-05-22). cdkd's `runMigrateLibrary` returns that subdirectory as
# `libResult.outputDir` and writes the mapping file there too.
GENERATED_APP_DIR="${OUTPUT_DIR}/${SOURCE_STACK}"
if [ ! -d "${GENERATED_APP_DIR}" ]; then
  echo "[verify] FAIL: ${GENERATED_APP_DIR} does not exist"
  exit 1
fi
if [ ! -f "${GENERATED_APP_DIR}/cdk.json" ]; then
  echo "[verify] FAIL: ${GENERATED_APP_DIR}/cdk.json missing — cdk migrate did not generate the app"
  exit 1
fi
if [ ! -f "${GENERATED_APP_DIR}/cdkd-resource-mapping.json" ]; then
  echo "[verify] FAIL: ${GENERATED_APP_DIR}/cdkd-resource-mapping.json missing — mapping audit file not written"
  exit 1
fi
echo "[verify] step 5 ok: generated CDK app + resource-mapping file present"

echo "[verify] step 6: assert cdkd state contains all 3 resources"
STATE_KEY="cdkd/${SOURCE_STACK}/${REGION}/state.json"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
for needed in 'AWS::S3::Bucket' 'AWS::SSM::Parameter' 'AWS::SNS::Topic'; do
  if ! echo "${STATE_JSON}" | grep -q "${needed}"; then
    echo "[verify] FAIL: ${needed} not found in cdkd state"
    echo "${STATE_JSON}" | head -100
    exit 1
  fi
done
echo "[verify] step 6 ok: cdkd state has all 3 resource types"

echo "[verify] step 7: assert source CFn stack is retired"
if aws cloudformation describe-stacks \
    --stack-name "${SOURCE_STACK}" \
    --region "${REGION}" >/dev/null 2>&1; then
  STATUS="$(aws cloudformation describe-stacks --stack-name "${SOURCE_STACK}" --region "${REGION}" \
    --query 'Stacks[0].StackStatus' --output text)"
  if [ "${STATUS}" != "DELETE_COMPLETE" ]; then
    echo "[verify] FAIL: source CFn stack still alive with status ${STATUS}"
    exit 1
  fi
fi
echo "[verify] step 7 ok: source CFn stack retired (DELETE_COMPLETE or absent)"

echo "[verify] step 8: assert AWS resources are STILL alive (Retain policy worked)"
aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null
aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null
echo "[verify] step 8 ok: every AWS resource survived retirement"

echo "[verify] step 9: cdkd destroy ${SOURCE_STACK} --force"
${CLI} destroy "${SOURCE_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  --verbose
echo "[verify] step 9 ok: cdkd destroy exited 0"

echo "[verify] step 10: assert AWS resources are GONE"
if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${BUCKET_NAME} still exists after destroy"
  exit 1
fi
if aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${PARAM_NAME} still exists after destroy"
  exit 1
fi
if aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${TOPIC_NAME} still exists after destroy"
  exit 1
fi
echo "[verify] step 10 ok: bucket / parameter / topic all 404"

echo "[verify] step 11: assert cdkd state is GONE"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}"
  exit 1
fi
echo "[verify] step 11 ok: cdkd state cleared"

trap - EXIT INT TERM
# Tidy the per-run tmpdir on clean exit too.
rm -rf "${OUTPUT_DIR}"
echo "[verify] PASS"
