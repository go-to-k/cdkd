#!/usr/bin/env bash
# verify.sh — a producer deploy that CHANGES or REMOVES an export a consumer
# still imports via Fn::ImportValue is refused before any resource change, as
# CloudFormation refuses it (go-to-k/cdkd#6088). The same change deployed
# together with the consumer goes through.
#
# Stacks (lib/stacks.ts):
#   CdkdExportInUseProd        SQS queue; CDK auto-exports its ARN and URL.
#   CdkdExportInUseCons        two SSM parameters importing them.
#   CdkdExportInUseEmbraceProd SSM parameter, plus (phase 1) an S3 bucket whose
#                              name CDK auto-exports.
#   CdkdExportInUseEmbraceCons SSM parameter importing it (phase 1) or holding
#                              a literal (phase 2) — the "deadly embrace".
#
# Steps:
#   1. deploy --all (phase 1); the consumer parameters hold q1's ARN / URL.
#   2. Phase 2, the producer ALONE: refused, exit 1, naming the consumer and
#      "change"; q1 still exists and q2 was never created.
#   3. Phase 2, the embrace producer ALONE: refused, exit 1, naming its
#      consumer and "remove"; the bucket still exists.
#   4. Phase 2 deploy --all: succeeds; the consumer parameters hold q2's ARN /
#      URL, q1 is gone, the embrace consumer holds the literal and the bucket
#      is gone.
#   5. destroy --all; every state record and resource is gone.
#
# Run via: /run-integ cross-stack-export-in-use

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

CDKD="node ../../../dist/cli.js"
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
BUCKET=""

PROD="CdkdExportInUseProd"
CONS="CdkdExportInUseCons"
EPROD="CdkdExportInUseEmbraceProd"
ECONS="CdkdExportInUseEmbraceCons"
Q1="cdkd-integ-export-in-use-q1"
Q2="cdkd-integ-export-in-use-q2"
P_ARN="/cdkd-integ/export-in-use/queue-arn"
P_URL="/cdkd-integ/export-in-use/queue-url"
P_EMBRACE="/cdkd-integ/export-in-use/embrace-bucket"
P_KEEP="/cdkd-integ/export-in-use/embrace-keep"

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  for s in "${CONS}" "${ECONS}" "${PROD}" "${EPROD}"; do
    ${CDKD} destroy "${s}" --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  done
  for q in "${Q1}" "${Q2}"; do
    url=$(aws sqs get-queue-url --queue-name "${q}" --region "${AWS_REGION}" --query QueueUrl --output text 2>/dev/null)
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  for p in "${P_ARN}" "${P_URL}" "${P_EMBRACE}" "${P_KEEP}"; do
    aws ssm delete-parameter --name "${p}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  # The embrace bucket's name is generated; Step 1 records it.
  case "${BUCKET:-}" in
    cdkdexportinuseembrace?*) aws s3 rb "s3://${BUCKET}" --force --region "${AWS_REGION}" >/dev/null 2>&1 ;;
    "") ;;
    *) echo "teardown sweep refused: unexpected bucket name '${BUCKET}'" >&2 ;;
  esac
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

param() { # usage: param <name> — prints the parameter's value
  aws ssm get-parameter --name "$1" --region "${AWS_REGION}" --query Parameter.Value --output text
}
queue_arn() { # usage: queue_arn <name>
  echo "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:$1"
}
queue_url() { # usage: queue_url <name>
  aws sqs get-queue-url --queue-name "$1" --region "${AWS_REGION}" --query QueueUrl --output text
}
expect_eq() { # usage: expect_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: got '$2', expected '$3'" >&2
    exit 1
  fi
}

# A refused deploy: exit 1 and cdkd's own refusal naming the consumer. The
# sentinel ("Cannot deploy stack") and the parsed marker are independent, so
# a reworded message fails loudly instead of reading as "not refused".
expect_refusal() { # usage: expect_refusal <stack> <consumer> <change|remove>
  local out rc=0
  out=$(CDKD_TEST_UPDATE=true ${CDKD} deploy "$1" --exclusively --region "${AWS_REGION}" \
    --state-bucket "${STATE_BUCKET}" 2>&1) || rc=$?
  echo "${out}" | tail -20
  expect_eq "exit code of the refused deploy of $1" "${rc}" "1"
  if ! grep -q "Cannot deploy stack" <<<"${out}"; then
    echo "FAIL: the refusal sentinel 'Cannot deploy stack' is missing" >&2
    exit 1
  fi
  if ! grep -q "  - $2 (${AWS_REGION}): imports export '.*', which this deploy would $3" <<<"${out}"; then
    echo "FAIL: the refusal does not name $2 with 'would $3'" >&2
    exit 1
  fi
}

echo "==> Step 1: deploy --all (phase 1)"
${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_eq "consumer's queue ARN" "$(param "${P_ARN}")" "$(queue_arn "${Q1}")"
expect_eq "consumer's queue URL" "$(param "${P_URL}")" "$(queue_url "${Q1}")"
BUCKET=$(param "${P_EMBRACE}")
aws s3api head-bucket --bucket "${BUCKET}" --region "${AWS_REGION}"

echo "==> Step 2: the producer alone, replacing the exported queue, is refused"
expect_refusal "${PROD}" "${CONS}" "change"
queue_url "${Q1}" >/dev/null
assert_gone "the refused deploy created ${Q2}" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"

echo "==> Step 3: the embrace producer alone, removing the exported bucket, is refused"
expect_refusal "${EPROD}" "${ECONS}" "remove"
aws s3api head-bucket --bucket "${BUCKET}" --region "${AWS_REGION}"

echo "==> Step 4: phase 2 deploy --all goes through"
CDKD_TEST_UPDATE=true ${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_eq "consumer's queue ARN" "$(param "${P_ARN}")" "$(queue_arn "${Q2}")"
expect_eq "consumer's queue URL" "$(param "${P_URL}")" "$(queue_url "${Q2}")"
assert_gone "${Q1} survived its replacement" aws sqs get-queue-url --queue-name "${Q1}" --region "${AWS_REGION}"
expect_eq "embrace consumer's value" "$(param "${P_EMBRACE}")" "inlined"
assert_gone "bucket ${BUCKET} survived its removal" aws s3api head-bucket --bucket "${BUCKET}" --region "${AWS_REGION}"

echo "==> Step 5: destroy --all"
CDKD_TEST_UPDATE=true ${CDKD} destroy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
for s in "${PROD}" "${CONS}" "${EPROD}" "${ECONS}"; do
  assert_gone "state of ${s} survived destroy" aws s3api head-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${s}/${AWS_REGION}/state.json"
done
assert_gone "${Q2} survived destroy" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"
for p in "${P_ARN}" "${P_URL}" "${P_EMBRACE}" "${P_KEEP}"; do
  assert_gone "parameter ${p} survived destroy" aws ssm get-parameter --name "${p}" --region "${AWS_REGION}"
done

trap - EXIT INT TERM
echo ""
echo "PASS: cross-stack-export-in-use"
