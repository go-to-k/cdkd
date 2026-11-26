#!/usr/bin/env bash
# verify.sh — a consumer that fails in the same `cdkd deploy` run as its
# producer's export replacement rolls back onto a resource that still exists
# (go-to-k/cdkd#7012).
#
# Stacks (lib/stacks.ts):
#   CdkdXsReplaceRbProd  SQS queue q1 (phase 2: renamed q2, a replacement);
#                        CDK auto-exports its URL and ARN.
#   CdkdXsReplaceRbCons  Lambda function with QURL = the imported queue URL,
#                        an SQS event source mapping and the IAM grant on the
#                        queue; with CDKD_TEST_FAIL=true also a queue AWS
#                        refuses, created after the function.
#
# Steps:
#   1. deploy both (phase 1): the function's QURL is q1's URL.
#   2. deploy both, phase 2 + failure: exit non-zero. The producer replaced q1
#      with q2 but kept q1 (it says so, and its state still records q1); the
#      consumer rolled back, its QURL is q1's URL, that URL resolves, and its
#      event source mapping reads q1.
#   2b. deploy the producer alone (go-to-k/cdkd#7017): q1 survives, still
#      recorded, and a line names the consumer that still uses it.
#   3. deploy both, phase 2 without failure: succeeds; QURL is q2's URL, q1 is
#      gone, and the producer's state records nothing left to delete.
#   4. destroy both; every resource and state record is gone.
#
# Run via: /run-integ cross-stack-replace-consumer-rollback

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
[ -f ../../../dist/cli.js ] || { echo "FAIL: dist/cli.js is missing; run vp run build" >&2; exit 1; }
AWS_REGION="${AWS_REGION:-us-east-1}"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"

PROD="CdkdXsReplaceRbProd"
CONS="CdkdXsReplaceRbCons"
Q1="cdkd-integ-xs-replace-rb-q1"
Q2="cdkd-integ-xs-replace-rb-q2"
QBOOM="cdkd-integ-xs-replace-rb-boom"
FN="cdkd-integ-xs-replace-rb-fn"
ROLE="cdkd-integ-xs-replace-rb-role"

sweep() { # best-effort; called from cleanup and, in a subshell, before the run
  set +eu
  for s in "${CONS}" "${PROD}"; do
    ${CDKD} destroy "${s}" --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
  done
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN}" --region "${AWS_REGION}" \
    --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${AWS_REGION}" >/dev/null 2>&1
  done
  aws lambda delete-function --function-name "${FN}" --region "${AWS_REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${AWS_REGION}" >/dev/null 2>&1
  for q in "${Q1}" "${Q2}" "${QBOOM}"; do
    url=$(aws sqs get-queue-url --queue-name "${q}" --region "${AWS_REGION}" --query QueueUrl --output text 2>/dev/null)
    [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${AWS_REGION}" >/dev/null 2>&1 \
      && SWEPT_QUEUE=1
  done
  for p in $(aws iam list-role-policies --role-name "${ROLE}" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${p}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-role-policies --role-name "${ROLE}" \
    --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${ROLE}" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1
  for s in "${CONS}" "${PROD}"; do
    for k in state.json lock.json; do
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${AWS_REGION}/${k}" >/dev/null 2>&1
    done
  done
  return 0
}

cleanup() {
  local rc=$?
  set +eu
  echo ""
  echo "==> Cleanup (errors during this block are tolerated)"
  sweep
  exit ${rc}
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

queue_url() { # usage: queue_url <name> — prints the queue's URL
  aws sqs get-queue-url --queue-name "$1" --region "${AWS_REGION}" --query QueueUrl --output text
}
fn_qurl() { # prints the function's QURL environment variable
  aws lambda get-function-configuration --function-name "${FN}" --region "${AWS_REGION}" \
    --query 'Environment.Variables.QURL' --output text
}
esm_sources() { # prints the event source ARNs of the function's mappings not being deleted
  # A deleted mapping stays listed as `Deleting` for a while, and cdkd does not
  # wait it out.
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${AWS_REGION}" \
    --query "EventSourceMappings[?State!='Deleting'].EventSourceArn" --output text
}
policy_resources() { # prints every Resource of the role's inline policies, one per line
  local p
  for p in $(aws iam list-role-policies --role-name "${ROLE}" --query 'PolicyNames[]' --output text); do
    aws iam get-role-policy --role-name "${ROLE}" --policy-name "${p}" \
      --query 'PolicyDocument.Statement[].Resource' --output text
  done | tr '\t' '\n'
}
superseded_ids() { # prints the producer state's superseded physical ids, one per line
  aws s3 cp "s3://${STATE_BUCKET}/cdkd/${PROD}/${AWS_REGION}/state.json" - --region "${AWS_REGION}" |
    node -e 'let s="";process.stdin.on("data",(d)=>(s+=d)).on("end",()=>{for(const e of JSON.parse(s).supersededResources??[])console.log(e.state.physicalId)})'
}
expect_eq() { # usage: expect_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: got '$2', expected '$3'" >&2
    exit 1
  fi
}

echo "==> Pre-run sweep"
SWEPT_QUEUE=0
sweep
set -eu
# SQS refuses a queue name deleted less than 60 s ago (QueueDeletedRecently).
if [ "${SWEPT_QUEUE}" = "1" ]; then
  echo "    a leftover queue was deleted; waiting 61 s before re-creating it"
  sleep 61
fi

echo "==> Step 1: deploy both (phase 1)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}"
Q1_URL=$(queue_url "${Q1}")
expect_eq "QURL after phase 1" "$(fn_qurl)" "${Q1_URL}"

echo "==> Step 2: deploy both, phase 2 with the consumer failing"
RC=0
OUT=$(CDKD_TEST_UPDATE=true CDKD_TEST_FAIL=true ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}" 2>&1) || RC=$?
echo "${OUT}"
if [ "${RC}" = "0" ]; then
  echo "FAIL: the deploy with the failing consumer resource exited 0" >&2
  exit 1
fi
# The producer did replace the queue: q2 exists.
queue_url "${Q2}" >/dev/null
assert_gone "the refused queue ${QBOOM} exists" aws sqs get-queue-url --queue-name "${QBOOM}" --region "${AWS_REGION}"
# go-to-k/cdkd#7012: the old queue is kept, and said so.
if gone_probe aws sqs get-queue-url --queue-name "${Q1}" --region "${AWS_REGION}"; then
  echo "FAIL: ${Q1} was deleted although the consumer that imports it failed and rolled back (go-to-k/cdkd#7012)" >&2
  exit 1
fi
if ! grep -q "Keeping the replaced resources of stack ${PROD}" <<<"${OUT}"; then
  echo "FAIL: no line says the producer kept its replaced resources" >&2
  exit 1
fi
if ! grep -qxF "${Q1_URL}" <<<"$(superseded_ids)"; then
  echo "FAIL: the producer's state does not record ${Q1} as still to delete" >&2
  exit 1
fi
# The rolled-back consumer names a live queue.
ROLLED_BACK_URL=$(fn_qurl)
expect_eq "QURL after the rollback" "${ROLLED_BACK_URL}" "${Q1_URL}"
expect_eq "the rolled-back QURL resolves" "$(queue_url "${ROLLED_BACK_URL##*/}")" "${Q1_URL}"
expect_eq "event source after the rollback" "$(esm_sources)" \
  "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${Q1}"
# The IAM grant the rollback restored names the live queue.
POLICY=$(policy_resources)
if ! grep -qxF "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${Q1}" <<<"${POLICY}"; then
  echo "FAIL: the rolled-back role policy does not grant on ${Q1}: ${POLICY}" >&2
  exit 1
fi

echo "==> Step 2b: deploy the producer alone (go-to-k/cdkd#7017)"
OUT=$(env -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true ${CDKD} deploy "${PROD}" --exclusively \
  --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" 2>&1)
echo "${OUT}"
if gone_probe aws sqs get-queue-url --queue-name "${Q1}" --region "${AWS_REGION}"; then
  echo "FAIL: a deploy of the producer alone deleted ${Q1} while the rolled-back consumer still uses it (go-to-k/cdkd#7017)" >&2
  exit 1
fi
if ! grep -q "${CONS} (importing this stack's outputs) still uses it" <<<"${OUT}"; then
  echo "FAIL: no line says the consumer still uses the kept queue" >&2
  exit 1
fi
if ! grep -qxF "${Q1_URL}" <<<"$(superseded_ids)"; then
  echo "FAIL: the producer's state no longer records ${Q1} as still to delete" >&2
  exit 1
fi
expect_eq "QURL after the producer-alone deploy" "$(fn_qurl)" "${Q1_URL}"

echo "==> Step 3: deploy both, phase 2 without the failure"
env -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true ${CDKD} deploy --all --region "${AWS_REGION}" \
  --state-bucket "${STATE_BUCKET}"
Q2_URL=$(queue_url "${Q2}")
expect_eq "QURL after phase 2" "$(fn_qurl)" "${Q2_URL}"
expect_eq "event source after phase 2" "$(esm_sources)" \
  "arn:aws:sqs:${AWS_REGION}:${ACCOUNT_ID}:${Q2}"
assert_gone "${Q1} survived the deploy that moved its consumer off it" \
  aws sqs get-queue-url --queue-name "${Q1}" --region "${AWS_REGION}"
expect_eq "superseded entries left in the producer's state" "$(superseded_ids)" ""

echo "==> Step 4: destroy both"
CDKD_TEST_UPDATE=true ${CDKD} destroy --all --region "${AWS_REGION}" --state-bucket "${STATE_BUCKET}" --force
for s in "${PROD}" "${CONS}"; do
  assert_gone "state of ${s} survived destroy" aws s3api head-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${s}/${AWS_REGION}/state.json"
done
assert_gone "${Q2} survived destroy" aws sqs get-queue-url --queue-name "${Q2}" --region "${AWS_REGION}"
assert_gone "function ${FN} survived destroy" aws lambda get-function --function-name "${FN}" --region "${AWS_REGION}"
assert_gone "role ${ROLE} survived destroy" aws iam get-role --role-name "${ROLE}"
aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${AWS_REGION}" >/dev/null 2>&1 || true

trap - EXIT INT TERM
echo "[verify] PASS — a consumer that fails beside its producer's export replacement rolls back onto a live queue, and the next deploy deletes it"
