#!/usr/bin/env bash
#
# End-to-end real-AWS validation for cdkd's CloudFormation intrinsic-function
# resolver. cdkd resolves EVERY intrinsic itself in
# `src/deployment/intrinsic-function-resolver.ts` (unlike the AWS CDK CLI,
# which defers them to CloudFormation), so the less-common intrinsics + deep
# nesting are where cdkd is most likely to diverge.
#
# The fixture computes a real resource property — the Value of an
# AWS::SSM::Parameter — via each harder intrinsic. After `cdkd deploy`, this
# script reads each parameter back from AWS (`aws ssm get-parameter`) and
# asserts it equals an EXPECTED concrete value computed independently here
# from the account / region. A mismatch pinpoints which intrinsic cdkd got
# wrong.
#
# Intrinsics exercised (BEYOND the existing `intrinsic-functions` fixture,
# which covers only Ref / Fn::GetAtt / Fn::Join / Fn::Sub):
#   Fn::Cidr, Fn::FindInMap, Fn::GetAZs + Fn::Select, Fn::Base64,
#   nested Fn::Split + Fn::Select + Fn::Join, deeply-nested two-arg Fn::Sub
#   with a ${Resource.Attr} GetAtt + ${AWS::Region} + a literal var map, and
#   ALL pseudo-parameters (AccountId / Region / Partition / StackName /
#   URLSuffix / NotificationARNs).
#
# BSD/macOS-portable: no `grep -P`, no `date -d`, no `grep -o` PCRE. Real
# exit-code capture (`...; rc=$?`) so a piped/teed harness can't mask a
# failure; prints an explicit "[verify] PASS" only at the very end.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdIntrinsicsTortureExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/intrinsics-torture"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Parameter name prefix matches the stack's `/${id}/...` SSM name scheme.
PFX="/${STACK}"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

FAILURES=0
fail() {
  echo "[verify] FAIL: $*"
  FAILURES=$((FAILURES + 1))
}

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] (exit ${rc}) — attempting cleanup"
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    # Direct cleanup of the SSM parameters in case destroy itself broke.
    for sfx in cidr-select cidr-join findinmap-default findinmap-region first-az \
               base64 split-select-join nested-sub pseudo topic-ref-sub; do
      aws ssm delete-parameter --name "${PFX}/${sfx}" --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  # Always sweep the events sidecar so the integ leaves nothing behind.
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

echo "[verify] step 2: cdkd deploy ${STACK}"
set +e
DEPLOY_OUT="$(${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" 2>&1)"
DEPLOY_RC=$?
set -e
echo "${DEPLOY_OUT}" | sed 's/^/  /'
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "[verify] FAIL: deploy exited ${DEPLOY_RC}. The output above names the failing resource + error;"
  echo "[verify]       a non-zero deploy here most likely means an intrinsic resolved to a value AWS rejected"
  echo "[verify]       (e.g. a malformed CIDR / ARN / AZ from Fn::Cidr / Fn::Sub / Fn::GetAZs)."
  exit 1
fi

# ---- Resolve account info for expected-value computation ----
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
if [ -z "${ACCOUNT_ID}" ] || [ "${ACCOUNT_ID}" = "None" ]; then
  echo "[verify] FAIL: could not resolve AWS account id"
  exit 1
fi
# Partition: aws (commercial), aws-cn (China), aws-us-gov (GovCloud). cdkd's
# resolver hardcodes 'aws' today; derive the EXPECTED partition the same way
# the CLI region implies it so the assertion tracks cdkd's behavior.
case "${REGION}" in
  cn-*) PARTITION="aws-cn" ;;
  us-gov-*) PARTITION="aws-us-gov" ;;
  *) PARTITION="aws" ;;
esac
echo "[verify] account=${ACCOUNT_ID} partition=${PARTITION}"

# Helper: read an SSM parameter value (the resolved intrinsic).
ssm_val() {
  aws ssm get-parameter --name "$1" --region "${REGION}" \
    --query 'Parameter.Value' --output text 2>/dev/null
}

# Helper: assert an SSM parameter value equals an expected string.
assert_param() {
  local label="$1" name="$2" expected="$3" actual
  actual="$(ssm_val "${name}")"
  if [ "${actual}" = "${expected}" ]; then
    echo "[verify]   OK  ${label}: ${actual}"
  else
    fail "${label} (${name}): expected '${expected}' but cdkd resolved '${actual}'"
  fi
}

echo "[verify] step 3: assert each resolved intrinsic equals its expected concrete value"

# -- 1. Fn::Cidr ('10.0.0.0/16', 8, 8) -> eight /24 blocks --
# subnetPrefix = 32 - cidrBits = 24; subnetSize = 256; base = 10.0.0.x.
CIDR_LIST="10.0.0.0/24,10.0.1.0/24,10.0.2.0/24,10.0.3.0/24,10.0.4.0/24,10.0.5.0/24,10.0.6.0/24,10.0.7.0/24"
assert_param "Fn::Cidr Fn::Select[3]" "${PFX}/cidr-select" "10.0.3.0/24"
assert_param "Fn::Cidr full list (Fn::Join)" "${PFX}/cidr-join" "${CIDR_LIST}"

# -- 2. Fn::FindInMap --
assert_param "Fn::FindInMap DEFAULT.tier" "${PFX}/findinmap-default" "default-prod"
# Region-keyed FindInMap: only mapped rows are deterministic. Assert when the
# run region is a mapped row; otherwise SKIP (the template only carries
# us-east-1 / us-west-2 / ap-northeast-1 + a DEFAULT row not keyed by region).
case "${REGION}" in
  us-east-1) EXPECT_RETENTION="30" ;;
  us-west-2) EXPECT_RETENTION="14" ;;
  ap-northeast-1) EXPECT_RETENTION="7" ;;
  *) EXPECT_RETENTION="" ;;
esac
if [ -n "${EXPECT_RETENTION}" ]; then
  assert_param "Fn::FindInMap [AWS::Region].retentionDays" "${PFX}/findinmap-region" "${EXPECT_RETENTION}"
else
  echo "[verify]   SKIP Fn::FindInMap [AWS::Region]: ${REGION} is not a mapped row (only us-east-1/us-west-2/ap-northeast-1)"
fi

# -- 3. Fn::GetAZs + Fn::Select[0] --
# cdkd sorts the AZ list, so element [0] is the alphabetically-first available
# zone. Compute the same from EC2 and compare.
FIRST_AZ_EXPECTED="$(aws ec2 describe-availability-zones \
  --region "${REGION}" \
  --filters "Name=region-name,Values=${REGION}" "Name=state,Values=available" \
  --query 'AvailabilityZones[].ZoneName' --output text 2>/dev/null \
  | tr '\t' '\n' | sort | head -n 1)"
if [ -z "${FIRST_AZ_EXPECTED}" ]; then
  echo "[verify]   SKIP Fn::GetAZs: could not enumerate AZs for ${REGION}"
else
  assert_param "Fn::Select[0] of Fn::GetAZs" "${PFX}/first-az" "${FIRST_AZ_EXPECTED}"
fi

# -- 4. Fn::Base64 --
assert_param "Fn::Base64('cdkd-intrinsics-torture')" "${PFX}/base64" "Y2RrZC1pbnRyaW5zaWNzLXRvcnR1cmU="

# -- 5. nested Fn::Split + Fn::Select + Fn::Join --
# Split "a-b-c-d-e" on "-", pick [0],[2],[4] -> "a","c","e", join with "|".
assert_param "nested Split/Select/Join" "${PFX}/split-select-join" "a|c|e"

# -- 6. deeply-nested two-arg Fn::Sub (literal-map var via Fn::Join + region + GetAtt queue ARN) --
# label var = Fn::Join('-', ['cdkd','torture','sub']) = "cdkd-torture-sub".
# queueArn = ${TortureQueue.Arn}; SQS Queue ARN format:
#   arn:<partition>:sqs:<region>:<account>:<queueName>
# The queue name is CDK-auto-generated; assert the resolvable prefix exactly
# and that the ARN segment is well-formed (not "undefined" / empty).
NESTED_SUB="$(ssm_val "${PFX}/nested-sub")"
NESTED_SUB_EXPECTED_PREFIX="label=cdkd-torture-sub;region=${REGION};queueArn=arn:${PARTITION}:sqs:${REGION}:${ACCOUNT_ID}:"
case "${NESTED_SUB}" in
  "${NESTED_SUB_EXPECTED_PREFIX}"*)
    # Ensure the queue-name tail is non-empty and not a leaked placeholder.
    QTAIL="${NESTED_SUB#${NESTED_SUB_EXPECTED_PREFIX}}"
    if [ -n "${QTAIL}" ] && [ "${QTAIL}" != "undefined" ]; then
      echo "[verify]   OK  nested Fn::Sub (label+region+GetAtt queue ARN): ${NESTED_SUB}"
    else
      fail "nested Fn::Sub: queue-ARN tail empty/placeholder in '${NESTED_SUB}'"
    fi
    ;;
  *)
    fail "nested Fn::Sub: expected prefix '${NESTED_SUB_EXPECTED_PREFIX}' but cdkd resolved '${NESTED_SUB}'"
    ;;
esac

# -- 7. ALL pseudo-parameters via Fn::Sub --
# cdkd has no stack-notification-ARN concept (no CFn notification ARN list in
# cdkd's model), so AWS::NotificationARNs is always an empty list. Matching
# CloudFormation, an empty AWS::NotificationARNs list resolves to an EMPTY
# STRING inside an Fn::Sub body — so `notif=` (nothing after the `=`). A
# regression that left the literal `${AWS::NotificationARNs}` placeholder
# (or crashed) would flip this assertion.
PSEUDO_EXPECTED="account=${ACCOUNT_ID};region=${REGION};partition=${PARTITION};stack=${STACK};urlsuffix=amazonaws.com;notif="
assert_param "all pseudo-parameters (Fn::Sub)" "${PFX}/pseudo" "${PSEUDO_EXPECTED}"

# -- 8. Fn::Sub with pseudo params + a Ref to the SNS topic --
# topicArn = Ref to the SNS topic, whose physical id IS the topic ARN:
#   arn:<partition>:sns:<region>:<account>:<topicName>
TOPIC_REF_SUB="$(ssm_val "${PFX}/topic-ref-sub")"
TOPIC_REF_EXPECTED_PREFIX="arn-prefix=arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID};topicRef=arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID}:"
case "${TOPIC_REF_SUB}" in
  "${TOPIC_REF_EXPECTED_PREFIX}"*)
    TTAIL="${TOPIC_REF_SUB#${TOPIC_REF_EXPECTED_PREFIX}}"
    if [ -n "${TTAIL}" ] && [ "${TTAIL}" != "undefined" ]; then
      echo "[verify]   OK  Fn::Sub pseudo + topic Ref: ${TOPIC_REF_SUB}"
    else
      fail "Fn::Sub topic Ref: topic-name tail empty/placeholder in '${TOPIC_REF_SUB}'"
    fi
    ;;
  *)
    fail "Fn::Sub topic Ref: expected prefix '${TOPIC_REF_EXPECTED_PREFIX}' but cdkd resolved '${TOPIC_REF_SUB}'"
    ;;
esac

if [ "${FAILURES}" -ne 0 ]; then
  echo "[verify] FAIL: ${FAILURES} intrinsic assertion(s) failed (see lines above)"
  exit 1
fi
echo "[verify] step 3 ok: all intrinsic assertions passed"

echo "[verify] step 4: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 5: assert clean — state.json gone + all SSM parameters gone (0 orphans)"
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "[verify] FAIL: state.json still present after destroy"
  exit 1
fi
ORPHANS=0
for sfx in cidr-select cidr-join findinmap-default findinmap-region first-az \
           base64 split-select-join nested-sub pseudo topic-ref-sub; do
  if aws ssm get-parameter --name "${PFX}/${sfx}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] FAIL: SSM parameter ${PFX}/${sfx} still exists after destroy (orphan)"
    ORPHANS=$((ORPHANS + 1))
  fi
done
if [ "${ORPHANS}" -ne 0 ]; then
  echo "[verify] FAIL: ${ORPHANS} orphan SSM parameter(s) remain after destroy"
  exit 1
fi
echo "[verify] step 5 ok: state gone, no orphan SSM parameters"

# Sweep the events sidecar (deliberately survives destroy) so nothing lingers.
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true

trap - EXIT INT TERM
echo "[verify] PASS"
