#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Rule target InputTransformer integ.
#
# `RuleTargetInput.fromObject(...)` synthesizes a Targets[].InputTransformer
# (InputPathsMap + InputTemplate). The eventbridge-rule-provider has handling
# code for this shape but no integ fixture exercised it. This verifies the
# transform actually reaches AWS and rewrites the delivered payload.
#
# Phases:
#   1. Deploy. put a matching event, then read the SQS target and assert the
#      delivered body is the TRANSFORMED template ({transformed:true, orderId,
#      src}) — NOT the raw event — and carries no `version` field yet.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (transform gains a `version:2`
#      field). put another event and assert the delivered body now carries
#      version=2 (the InputTransformer change reached AWS as an in-place
#      Rule update).
#   3. Destroy + assert the rule is gone and the cdkd state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdEventbridgeInputTransformerExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
RULE_NAME="cdkd-eb-transform-rule"
QUEUE_NAME="cdkd-eb-transform-q"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

queue_url() {
  aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || true
}

delete_rule() {
  # A rule cannot be deleted while it has targets; remove them first.
  local ids
  ids="$(aws events list-targets-by-rule --rule "${RULE_NAME}" --region "${REGION}" \
    --query 'Targets[].Id' --output text 2>/dev/null || true)"
  if [ -n "${ids}" ] && [ "${ids}" != "None" ]; then
    aws events remove-targets --rule "${RULE_NAME}" --ids ${ids} --region "${REGION}" >/dev/null 2>&1 || true
  fi
  aws events delete-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_rule
  local url
  url="$(queue_url)"
  if [ -n "${url}" ] && [ "${url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# put one matching event, poll the queue until a message arrives, print its body,
# and delete it (so phase 2 does not read a phase 1 message). Echoes the body.
put_and_read() {
  local order_id="$1"
  local url
  url="$(queue_url)"
  aws events put-events --region "${REGION}" --entries \
    "[{\"Source\":\"cdkd.bughunt\",\"DetailType\":\"order\",\"Detail\":\"{\\\"orderId\\\":\\\"${order_id}\\\"}\"}]" \
    >/dev/null
  local i body rh
  for i in 1 2 3 4 5 6 7 8; do
    local msg
    msg="$(aws sqs receive-message --queue-url "${url}" --wait-time-seconds 5 \
      --region "${REGION}" --output json 2>/dev/null || true)"
    body="$(printf '%s' "${msg}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const m=JSON.parse(s);process.stdout.write(m.Messages?m.Messages[0].Body:"")}catch(e){process.stdout.write("")}})')"
    if [ -n "${body}" ]; then
      rh="$(printf '%s' "${msg}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const m=JSON.parse(s);process.stdout.write(m.Messages[0].ReceiptHandle)})')"
      aws sqs delete-message --queue-url "${url}" --receipt-handle "${rh}" --region "${REGION}" >/dev/null 2>&1 || true
      printf '%s' "${body}"
      return 0
    fi
  done
  return 1
}

# --- Phase 1: deploy + assert transformed payload ---------------------
echo "==> Phase 1: deploy + assert InputTransformer rewrites the payload"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BODY1="$(put_and_read ORD-111 || true)"
if [ -z "${BODY1}" ]; then
  echo "FAIL: no transformed message delivered to the SQS target in Phase 1" >&2
  exit 1
fi
echo "    delivered body (P1): ${BODY1}"
echo "${BODY1}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);if(b.transformed!==true||b.orderId!=="ORD-111"||b.src!=="cdkd.bughunt"){console.error("FAIL: body is not the transformed template:",s);process.exit(1)}if("version"in b){console.error("FAIL: unexpected version field present in Phase 1:",s);process.exit(1)}}) '
echo "    payload was transformed (not the raw event), no version field yet"

# --- Phase 2: UPDATE the InputTransformer -----------------------------
echo "==> Phase 2: re-deploy adding version:2 to the transform (in-place Rule update)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BODY2="$(put_and_read ORD-222 || true)"
if [ -z "${BODY2}" ]; then
  echo "FAIL: no transformed message delivered to the SQS target in Phase 2" >&2
  exit 1
fi
echo "    delivered body (P2): ${BODY2}"
echo "${BODY2}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const b=JSON.parse(s);if(b.transformed!==true||b.orderId!=="ORD-222"||b.version!==2){console.error("FAIL: updated transform did not reach AWS (expected version:2):",s);process.exit(1)}}) '
echo "    updated InputTransformer reached AWS (version=2)"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

if aws events describe-rule --name "${RULE_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: rule ${RULE_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    rule deleted"

if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file ${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    cdkd state removed"

echo "[verify] PASS — EventBridge target InputTransformer rewrites the payload, UPDATE applied in place, destroy clean, all 3 phases passed"
