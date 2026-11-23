#!/usr/bin/env bash
# verify.sh — a producer deploy that CHANGES or REMOVES an export a consumer
# still imports via Fn::ImportValue is refused before any resource change, as
# CloudFormation refuses it (go-to-k/cdkd#6088). The same change deployed
# together with the consumer goes through.
#
# Stacks (lib/stacks.ts):
#   CdkdExportInUseProd        SQS queue; CDK auto-exports its ARN and URL.
#   CdkdExportInUseCons        two SSM parameters importing them, and one named
#                              IAM role named after the imported queue name.
#   CdkdExportInUseEmbraceProd SSM parameter, plus (phase 1) an S3 bucket whose
#                              name CDK auto-exports.
#   CdkdExportInUseEmbraceCons SSM parameter importing it (phase 1) or holding
#                              a literal (phase 2) — the "deadly embrace".
#   CdkdExportInUseCrProd      a custom resource with a fresh Timestamp on every
#                              synth, exporting the Value its handler returns
#                              (CDKD_TEST_CR_VALUE, default v1).
#   CdkdExportInUseCrCons      SSM parameter importing that value.
#
# Steps:
#   1. deploy --all (phase 1); the consumer parameters hold q1's ARN / URL.
#   1b. The custom-resource producer ALONE, same value (go-to-k/cdkd#6865):
#      deploys, as CloudFormation does; the handler ran with the new Timestamp.
#   1c. The custom-resource producer ALONE, handler returning v2: exit 1 after
#      the update, rolled back; the handler ran again with the old properties,
#      and the record, the export and the consumer still hold v1.
#   2. Phase 2, the producer ALONE: refused, exit 1, naming the consumer and
#      "change"; q1 still exists and q2 was never created.
#   3. Phase 2, the embrace producer ALONE: refused, exit 1, naming its
#      consumer and "remove"; the bucket still exists.
#   3b. Phase 2 `cdkd diff` of producer + consumer, --fail-on destructive:
#      exit 1, listing the consumer's queue-named parameter as replaced and its
#      two parameters as changed (go-to-k/cdkd#6796); nothing is deployed.
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
CRPROD="CdkdExportInUseCrProd"
CRCONS="CdkdExportInUseCrCons"
P_CR="/cdkd-integ/export-in-use/cr-value"
CR_LOG_GROUPS="/aws/lambda/cdkd-integ-eiu-cr-on-event /aws/lambda/cdkd-integ-eiu-cr-provider"
Q1="cdkd-integ-export-in-use-q1"
Q2="cdkd-integ-export-in-use-q2"
P_ARN="/cdkd-integ/export-in-use/queue-arn"
P_URL="/cdkd-integ/export-in-use/queue-url"
P_EMBRACE="/cdkd-integ/export-in-use/embrace-bucket"
P_KEEP="/cdkd-integ/export-in-use/embrace-keep"
R_NAMED1="cdkd-integ-eiu-${Q1}"
R_NAMED2="cdkd-integ-eiu-${Q2}"

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  for s in "${CONS}" "${ECONS}" "${CRCONS}" "${PROD}" "${EPROD}" "${CRPROD}"; do
    ${CDKD} destroy "${s}" --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  done
  for q in "${Q1}" "${Q2}"; do
    url=$(aws sqs get-queue-url --queue-name "${q}" --region "${AWS_REGION}" --query QueueUrl --output text 2>/dev/null)
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  for p in "${P_ARN}" "${P_URL}" "${P_EMBRACE}" "${P_KEEP}" "${P_CR}"; do
    aws ssm delete-parameter --name "${p}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  for lg in ${CR_LOG_GROUPS}; do
    aws logs delete-log-group --log-group-name "${lg}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  for r in "${R_NAMED1}" "${R_NAMED2}"; do
    aws iam delete-role --role-name "${r}" >/dev/null 2>&1
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

# go-to-k/cdkd#6865: the custom-resource producer's record (its Timestamp and
# the Value its handler returned) and published export.
cr_record() { # prints "<Timestamp> <Value> <exported value>"
  aws s3 cp "s3://${STATE_BUCKET}/cdkd/${CRPROD}/${AWS_REGION}/state.json" - \
    | jq -r '"\(.resources.Cr.properties.Timestamp // "") \(.resources.Cr.attributes.Value // "") \(.outputs.CdkdExportInUseCrValue // "")"'
}
read -r CR_TS0 CR_VAL0 CR_EXP0 <<<"$(cr_record)" || true
expect_eq "custom resource value after step 1" "${CR_VAL0:-}" "v1"
expect_eq "custom resource export after step 1" "${CR_EXP0:-}" "v1"
expect_eq "consumer's custom resource value" "$(param "${P_CR}")" "v1"

echo "==> Step 1b: the custom-resource producer alone, same value, deploys (go-to-k/cdkd#6865)"
${CDKD} deploy "${CRPROD}" --exclusively --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
read -r CR_TS1 CR_VAL1 CR_EXP1 <<<"$(cr_record)" || true
if [ -z "${CR_TS1:-}" ] || [ "${CR_TS1}" = "${CR_TS0}" ]; then
  echo "FAIL: the custom resource was not updated (Timestamp '${CR_TS1:-}', was '${CR_TS0}')" >&2
  exit 1
fi
expect_eq "custom resource value after step 1b" "${CR_VAL1:-}" "v1"
expect_eq "custom resource export after step 1b" "${CR_EXP1:-}" "v1"

echo "==> Step 1c: the custom-resource producer alone, value v2, fails after the update and rolls back"
# Only the handler log lines written from here on count: step 1b's forward
# update already logged "REQUEST Update <step-1b Timestamp> v1".
CR_LOG_SINCE_MS=$(( $(date +%s) * 1000 ))
CR_OUT=""
CR_RC=0
CR_OUT=$(CDKD_TEST_CR_VALUE=v2 ${CDKD} deploy "${CRPROD}" --exclusively --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" 2>&1) || CR_RC=$?
echo "${CR_OUT}" | tail -25
expect_eq "exit code of the rolled-back deploy of ${CRPROD}" "${CR_RC}" "1"
if ! grep -q "Cannot deploy stack" <<<"${CR_OUT}"; then
  echo "FAIL: the refusal sentinel 'Cannot deploy stack' is missing" >&2
  exit 1
fi
if ! grep -q "  - ${CRCONS} (${AWS_REGION}): imports export '.*', which this deploy would change" <<<"${CR_OUT}"; then
  echo "FAIL: the refusal does not name ${CRCONS} with 'would change'" >&2
  exit 1
fi
if ! grep -q "so this deploy fails and is rolled back" <<<"${CR_OUT}"; then
  echo "FAIL: the refusal is not worded as after the custom resource update" >&2
  exit 1
fi
read -r CR_TS2 CR_VAL2 CR_EXP2 <<<"$(cr_record)" || true
expect_eq "custom resource Timestamp after the rollback" "${CR_TS2:-}" "${CR_TS1}"
expect_eq "custom resource value after the rollback" "${CR_VAL2:-}" "v1"
expect_eq "custom resource export after the rollback" "${CR_EXP2:-}" "v1"
expect_eq "consumer's custom resource value after the rollback" "$(param "${P_CR}")" "v1"
# The handler ran with v2 (the update), then again with the old properties
# (the rollback), as CloudFormation's rollback re-invokes it.
saw_request() { # usage: saw_request <filter-pattern>; polls the handler's log (delivery lags)
  local n=0 hits
  while [ "${n}" -lt 12 ]; do
    hits=$(aws logs filter-log-events --log-group-name /aws/lambda/cdkd-integ-eiu-cr-on-event \
      --region "${AWS_REGION}" --start-time "${CR_LOG_SINCE_MS}" --filter-pattern "$1" --query 'events[].eventId' --output text) || return 1
    # Event ids, not `length(...)`: --query applies per PAGE, and an empty
    # page prints `None` or nothing.
    [ -n "$(tr '\t ' '\n\n' <<<"${hits}" | grep -v -e '^None$' -e '^$' || true)" ] && return 0
    n=$((n + 1))
    sleep 10
  done
  return 1
}
saw_request "\"REQUEST Update ${CR_TS1} v1\"" \
  || { echo "FAIL: the handler never saw the rollback's Update with Timestamp ${CR_TS1}" >&2; exit 1; }
saw_request '"REQUEST Update" v2' \
  || { echo "FAIL: the handler never saw the deploy's Update returning v2" >&2; exit 1; }

echo "==> Step 2: the producer alone, replacing the exported queue, is refused"
expect_refusal "${PROD}" "${CONS}" "change"
queue_url "${Q1}" >/dev/null
assert_gone "the refused deploy created ${Q2}" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"

echo "==> Step 3: the embrace producer alone, removing the exported bucket, is refused"
expect_refusal "${EPROD}" "${ECONS}" "remove"
aws s3api head-bucket --bucket "${BUCKET}" --region "${AWS_REGION}"

echo "==> Step 3b: phase 2 diff of producer + consumer previews the consumer's changes"
DIFF_RC=0
DIFF_OUT=$(CDKD_TEST_UPDATE=true ${CDKD} diff "${PROD}" "${CONS}" --fail-on destructive \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1) || DIFF_RC=$?
echo "${DIFF_OUT}" | tail -25
expect_eq "exit code of the destructive diff" "${DIFF_RC}" "1"
# Sentinel independent of the parsed rows: the --fail-on summary line.
if ! grep -q "destructive change(s) (--fail-on=destructive)" <<<"${DIFF_OUT}"; then
  echo "FAIL: the --fail-on=destructive summary sentinel is missing" >&2
  exit 1
fi
if ! grep -qE "^  ${CONS}: AWS::IAM::Role .*NamedByQueue.* will be replaced" <<<"${DIFF_OUT}"; then
  echo "FAIL: the diff does not list ${CONS}'s NamedByQueue as replaced" >&2
  exit 1
fi
if grep -q "No changes detected for stack ${CONS}" <<<"${DIFF_OUT}"; then
  echo "FAIL: the diff previews ${CONS} as unchanged" >&2
  exit 1
fi
assert_gone "the diff created ${Q2}" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"
aws iam get-role --role-name "${R_NAMED1}" --query Role.RoleName --output text >/dev/null

echo "==> Step 4: phase 2 deploy --all goes through"
CDKD_TEST_UPDATE=true ${CDKD} deploy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}"
expect_eq "consumer's queue ARN" "$(param "${P_ARN}")" "$(queue_arn "${Q2}")"
expect_eq "consumer's queue URL" "$(param "${P_URL}")" "$(queue_url "${Q2}")"
assert_gone "${Q1} survived its replacement" aws sqs get-queue-url --queue-name "${Q1}" --region "${AWS_REGION}"
aws iam get-role --role-name "${R_NAMED2}" --query Role.RoleName --output text >/dev/null
assert_gone "role ${R_NAMED1} survived its replacement" aws iam get-role --role-name "${R_NAMED1}"
expect_eq "embrace consumer's value" "$(param "${P_EMBRACE}")" "inlined"
assert_gone "bucket ${BUCKET} survived its removal" aws s3api head-bucket --bucket "${BUCKET}" --region "${AWS_REGION}"

echo "==> Step 5: destroy --all"
CDKD_TEST_UPDATE=true ${CDKD} destroy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
for s in "${PROD}" "${CONS}" "${EPROD}" "${ECONS}" "${CRPROD}" "${CRCONS}"; do
  assert_gone "state of ${s} survived destroy" aws s3api head-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${s}/${AWS_REGION}/state.json"
done
assert_gone "${Q2} survived destroy" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"
for p in "${P_ARN}" "${P_URL}" "${P_EMBRACE}" "${P_KEEP}" "${P_CR}"; do
  assert_gone "parameter ${p} survived destroy" aws ssm get-parameter --name "${p}" --region "${AWS_REGION}"
done
assert_gone "role ${R_NAMED2} survived destroy" aws iam get-role --role-name "${R_NAMED2}"

# The custom-resource Lambdas' log groups outlive the destroy.
for lg in ${CR_LOG_GROUPS}; do
  out=$(aws logs delete-log-group --log-group-name "${lg}" --region "${AWS_REGION}" 2>&1) \
    || grep -q ResourceNotFoundException <<<"${out}" \
    || { echo "FAIL: could not delete log group ${lg}: ${out}" >&2; exit 1; }
done

trap - EXIT INT TERM
echo ""
echo "PASS: cross-stack-export-in-use"
