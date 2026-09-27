#!/usr/bin/env bash
# verify.sh — cdkd destroy-then-immediate-redeploy of NAMED streams (issue #3872).
#
# Kinesis (`DeleteStream`) and Firehose (`DeleteDeliveryStream`) keep a stream's
# NAME while it is DELETING and refuse a create of that name with the same
# `ResourceInUseException ... already exists` text a live stream gets. Measured
# windows (us-east-1): Kinesis 4-7s, Firehose ~103-107s. cdkd's delete()
# returned the moment the delete call was accepted, so `cdkd destroy` followed
# by `cdkd deploy` failed on the Firehose create; CloudFormation, which reports
# a delete complete only once the stream is gone, converges. The fix polls
# until the stream is gone before delete() returns.
#
# Phases:
#   1. Deploy a named Kinesis stream + a named Firehose delivery stream (S3
#      destination). Assert both are ACTIVE on AWS.
#   2. Destroy. Record whether each stream is ALREADY gone the moment destroy
#      returns (the fix's contract), then IMMEDIATELY redeploy the same stack
#      -- the arm that failed before the fix. Fail if the redeploy failed or if
#      either stream was still present after destroy.
#   3. Assert both streams are ACTIVE again (the redeploy really re-created
#      them under the same names).
#   4. Destroy, assert both streams, both buckets, the role and the cdkd state
#      file are gone -- immediately, with no polling.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

STACK="CdkdStreamDeleteRedeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Unique per run so a leftover from an earlier run (which would itself still be
# DELETING) can never collide with this one; stable across the run's phases so
# the redeploy re-creates the SAME names. The stack reads it via CDKD_SRD_RUN_ID.
RUN_ID="$(date +%s)"
export CDKD_SRD_RUN_ID="${RUN_ID}"
NAME="cdkd-stream-redeploy-${RUN_ID}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_A="cdkd-stream-redeploy-${ACCOUNT}-${RUN_ID}-a"
BUCKET_B="cdkd-stream-redeploy-${ACCOUNT}-${RUN_ID}-b"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws firehose delete-delivery-stream --delivery-stream-name "${NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${NAME}" --enforce-consumer-deletion \
    --region "${REGION}" >/dev/null 2>&1 || true
  for b in "${BUCKET_A}" "${BUCKET_B}"; do
    aws s3 rb "s3://${b}" --force --region "${REGION}" >/dev/null 2>&1 || true
  done
  for p in $(aws iam list-role-policies --role-name "${NAME}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${NAME}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${NAME}" >/dev/null 2>&1 || true
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

firehose_status() {
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}" \
    --query 'DeliveryStreamDescription.DeliveryStreamStatus' --output text
}
kinesis_status() {
  aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}" \
    --query 'StreamDescriptionSummary.StreamStatus' --output text
}
assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}

# --- Phase 1: deploy ----------------------------------------------------
echo "==> Phase 1: deploy named Kinesis stream + Firehose delivery stream (${NAME})"
CDKD_SRD_PHASE=a node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_eq "Firehose status after Phase 1" "ACTIVE" "$(firehose_status)"
assert_eq "Kinesis status after Phase 1" "ACTIVE" "$(kinesis_status)"
echo "    both streams ACTIVE"

# --- Phase 2: destroy, then IMMEDIATELY redeploy -------------------------
echo "==> Phase 2: destroy"
T0="$(date +%s)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
echo "    destroy took $(( $(date +%s) - T0 ))s"

# Recorded, not asserted yet: the redeploy below is the user-visible arm, so a
# pre-fix binary runs it too and the failure message carries BOTH facts.
STILL_PRESENT=""
if ! gone_probe aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}"; then
  STILL_PRESENT="${STILL_PRESENT} firehose($(firehose_status || echo gone-now))"
fi
if ! gone_probe aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}"; then
  STILL_PRESENT="${STILL_PRESENT} kinesis($(kinesis_status || echo gone-now))"
fi
echo "    streams still present right after destroy:${STILL_PRESENT:- none}"

echo "==> Phase 2: immediate redeploy of the same stream names"
if ! CDKD_SRD_PHASE=b node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes; then
  echo "FAIL: the immediate redeploy failed (streams still present right after destroy:${STILL_PRESENT:- none}) — delete() returned before the stream name was released" >&2
  exit 1
fi
if [ -n "${STILL_PRESENT}" ]; then
  echo "FAIL: destroy returned while a stream was still present:${STILL_PRESENT} — delete() did not wait for the stream to disappear" >&2
  exit 1
fi
echo "    streams were gone when destroy returned, and the redeploy succeeded"

# --- Phase 3: the redeploy really re-created both ------------------------
assert_eq "Firehose status after the redeploy" "ACTIVE" "$(firehose_status)"
assert_eq "Kinesis status after the redeploy" "ACTIVE" "$(kinesis_status)"
echo "    both streams ACTIVE again under the same names"

# --- Phase 4: destroy, everything gone at once ---------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# No polling: delete() now returns only once each stream is gone.
assert_gone "Firehose delivery stream ${NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${NAME}" --region "${REGION}"
assert_gone "Kinesis stream ${NAME} still exists after destroy" \
  aws kinesis describe-stream-summary --stream-name "${NAME}" --region "${REGION}"
assert_gone "bucket ${BUCKET_A} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_A}" --region "${REGION}"
assert_gone "bucket ${BUCKET_B} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_B}" --region "${REGION}"
assert_gone "role ${NAME} still exists after destroy" \
  aws iam get-role --role-name "${NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    streams, buckets, role and cdkd state all gone"

echo "[verify] PASS — named Kinesis + Firehose streams are gone when destroy returns, and an immediate redeploy succeeds"
