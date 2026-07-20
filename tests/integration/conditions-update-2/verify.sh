#!/usr/bin/env bash
# verify.sh - cdkd conditions-update-2 integ.
#
# Harder CloudFormation-Conditions-on-UPDATE semantics than the sibling
# `conditions-and-if` fixture (which surfaced bug #840). The #840 fix prunes a
# resource whose `Condition:` flipped true -> false. This fixture asserts the
# UPDATE-time corner cases that flip does NOT cover:
#
#   1a. Resource MOVES conditions: MoverParam gated on IsPhaseA (present in
#       phase a) -> condition-false in phase b -> must be DELETED.
#   1b. Reverse: AppearParam gated on IsPhaseB -> absent in phase a ->
#       CREATED on the phase-b redeploy.
#   2.  Fn::If -> AWS::NoValue removing a NESTED property block on an in-place
#       UPDATE: WorkQueue.RedrivePolicy SET in phase a, GONE in phase b (same
#       physical queue).
#   3.  Condition-gated OUTPUT: MoverParamName output present in cdkd state in
#       phase a, absent in phase b.
#   4.  DependsOn referencing a condition-excluded resource: KeeperParam
#       DependsOn MoverParam; in phase b MoverParam is pruned, so cdkd must
#       drop the dangling DependsOn and still deploy/update KeeperParam.
#   5.  Ref to a condition-excluded resource inside a condition-false resource
#       (RefHolderParam Refs MoverParam, both gated on IsPhaseA): in phase b
#       both are pruned -> no dangling-ref crash.
#
# Two deploys flip the `phase` CDK context (-c phase=a|b), which flips the
# Phase CfnParameter Default at synth time (cdkd has no deploy-time --parameter
# flag; parameters resolve from the template Default).
#
#   Phase A (-c phase=a): MoverParam/RefHolderParam PRESENT, AppearParam
#     ABSENT, WorkQueue RedrivePolicy SET, MoverParamName output PRESENT.
#   Phase B (-c phase=b, redeploy in place): MoverParam/RefHolderParam DELETED,
#     AppearParam CREATED, WorkQueue RedrivePolicy GONE (same queue),
#     MoverParamName output ABSENT, KeeperParam still up (DependsOn dropped).
#   Phase C: destroy + clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
#
# BSD/macOS portable: no `grep -P`, no `date -d`. Real rc + explicit PASS.

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdConditionsUpdate2Example"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

MOVER_PARAM="/cdkd-conditions-update-2/${ACCOUNT_ID}/mover"
APPEAR_PARAM="/cdkd-conditions-update-2/${ACCOUNT_ID}/appear"
KEEPER_PARAM="/cdkd-conditions-update-2/${ACCOUNT_ID}/keeper"
REF_HOLDER_PARAM="/cdkd-conditions-update-2/${ACCOUNT_ID}/ref-holder"
DLQ_NAME="cdkd-conditions-update-2-dlq-${ACCOUNT_ID}"
WORK_QUEUE_NAME="cdkd-conditions-update-2-work-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Captured at deploy time so cleanup / attribute checks can find the queues.
WORK_QUEUE_URL=""

# Resolve a queue URL by name (empty if absent). Never aborts under set -e.
queue_url() {
  local name="$1"
  aws sqs get-queue-url --queue-name "${name}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null || echo ""
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Defensive direct cleanup in case destroy did not run / left orphans.
  aws ssm delete-parameter --name "${MOVER_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${APPEAR_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${KEEPER_PARAM}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${REF_HOLDER_PARAM}" --region "${REGION}" >/dev/null 2>&1
  local du
  du=$(queue_url "${WORK_QUEUE_NAME}")
  [ -n "${du}" ] && aws sqs delete-queue --queue-url "${du}" --region "${REGION}" >/dev/null 2>&1
  du=$(queue_url "${DLQ_NAME}")
  [ -n "${du}" ] && aws sqs delete-queue --queue-url "${du}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Helper: does an SSM parameter exist? rc 0 = yes, 1 = no.
ssm_exists() {
  aws ssm get-parameter --name "$1" --region "${REGION}" >/dev/null 2>&1
}

# Helper: read an SSM parameter Value, or empty. Never aborts under set -e.
ssm_value() {
  aws ssm get-parameter --name "$1" --region "${REGION}" \
    --query 'Parameter.Value' --output text 2>/dev/null || echo ""
}

# Helper: read the WorkQueue RedrivePolicy attribute, or empty when unset.
# SQS omits the attribute key entirely when no redrive policy is configured.
work_queue_redrive_policy() {
  aws sqs get-queue-attributes --queue-url "${WORK_QUEUE_URL}" \
    --attribute-names RedrivePolicy --region "${REGION}" \
    --query 'Attributes.RedrivePolicy' --output text 2>/dev/null || echo ""
}

# Helper: print the cdkd state outputs map keys (one per line), or empty.
state_output_keys() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
    | jq -r '.outputs | keys[]' 2>/dev/null || echo ""
}

# ====================================================================
# Phase A: deploy with -c phase=a
# ====================================================================
echo ""
echo "==> Phase A: deploy with -c phase=a"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c phase=a \
  --yes

# --- Case 1a: MoverParam (gated on IsPhaseA) PRESENT ------------------
if ! ssm_exists "${MOVER_PARAM}"; then
  echo "FAIL: MoverParam '${MOVER_PARAM}' is ABSENT but should exist in phase a" >&2
  exit 1
fi
echo "    OK: MoverParam (IsPhaseA-gated) PRESENT in phase a"

# --- Case 1b: AppearParam (gated on IsPhaseB) ABSENT -----------------
if ssm_exists "${APPEAR_PARAM}"; then
  echo "FAIL: AppearParam '${APPEAR_PARAM}' EXISTS but should be absent in phase a" >&2
  exit 1
fi
echo "    OK: AppearParam (IsPhaseB-gated) ABSENT in phase a"

# --- Case 5: RefHolderParam (gated on IsPhaseA, Refs MoverParam) ------
# Present in phase a, and its Value resolved to MoverParam's physical name.
if ! ssm_exists "${REF_HOLDER_PARAM}"; then
  echo "FAIL: RefHolderParam '${REF_HOLDER_PARAM}' is ABSENT but should exist in phase a" >&2
  exit 1
fi
REF_VALUE=$(ssm_value "${REF_HOLDER_PARAM}")
if [ "${REF_VALUE}" != "${MOVER_PARAM}" ]; then
  echo "FAIL: RefHolderParam Value is '${REF_VALUE}', expected MoverParam name '${MOVER_PARAM}' (Ref resolution)" >&2
  exit 1
fi
echo "    OK: RefHolderParam PRESENT and Ref to MoverParam resolved correctly"

# --- Case 4: KeeperParam (always present, DependsOn MoverParam) -------
if ! ssm_exists "${KEEPER_PARAM}"; then
  echo "FAIL: KeeperParam '${KEEPER_PARAM}' is ABSENT but should always exist" >&2
  exit 1
fi
KEEPER_VALUE=$(ssm_value "${KEEPER_PARAM}")
if [ "${KEEPER_VALUE}" != "keeper-phase-a" ]; then
  echo "FAIL: KeeperParam Value is '${KEEPER_VALUE}', expected 'keeper-phase-a' (Fn::If a branch)" >&2
  exit 1
fi
echo "    OK: KeeperParam PRESENT with phase-a Fn::If value"

# --- Case 2: WorkQueue RedrivePolicy SET in phase a ------------------
WORK_QUEUE_URL=$(queue_url "${WORK_QUEUE_NAME}")
if [ -z "${WORK_QUEUE_URL}" ]; then
  echo "FAIL: WorkQueue '${WORK_QUEUE_NAME}' not found after phase-a deploy" >&2
  exit 1
fi
RP=$(work_queue_redrive_policy)
if [ -z "${RP}" ] || [ "${RP}" = "None" ]; then
  echo "FAIL: WorkQueue RedrivePolicy is empty in phase a, expected the Fn::If block to be SET" >&2
  exit 1
fi
# Sanity-check the block actually carries maxReceiveCount=3 (the Fn::If body).
RP_MAX=$(echo "${RP}" | jq -r '.maxReceiveCount // empty' 2>/dev/null)
if [ "${RP_MAX}" != "3" ]; then
  echo "FAIL: WorkQueue RedrivePolicy.maxReceiveCount is '${RP_MAX}', expected '3'" >&2
  exit 1
fi
echo "    OK: WorkQueue RedrivePolicy SET in phase a (maxReceiveCount=3)"

# --- Case 3: MoverParamName output (gated on IsPhaseA) PRESENT -------
KEYS=$(state_output_keys)
if ! echo "${KEYS}" | grep -qx "MoverParamName"; then
  echo "FAIL: MoverParamName output is ABSENT from cdkd state outputs but should exist in phase a" >&2
  echo "      state output keys were: ${KEYS}" >&2
  exit 1
fi
echo "    OK: condition-gated output MoverParamName PRESENT in cdkd state (phase a)"

# ====================================================================
# Phase B: redeploy with -c phase=b (conditions flip)
# ====================================================================
echo ""
echo "==> Phase B: redeploy with -c phase=b (conditions flip)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c phase=b \
  --yes

# --- Case 1a: MoverParam now DELETED (condition flipped to false) ----
if ssm_exists "${MOVER_PARAM}"; then
  echo "FAIL: MoverParam '${MOVER_PARAM}' STILL EXISTS but should be DELETED in phase b (#840-class)" >&2
  exit 1
fi
echo "    OK: MoverParam DELETED in phase b (Condition flipped true -> false)"

# --- Case 5: RefHolderParam ALSO deleted (gated on IsPhaseA) ---------
# The phase-b deploy must NOT crash on the now-dangling Ref to MoverParam
# (both are pruned together). Reaching this assertion already proves no crash.
if ssm_exists "${REF_HOLDER_PARAM}"; then
  echo "FAIL: RefHolderParam '${REF_HOLDER_PARAM}' STILL EXISTS but should be DELETED in phase b" >&2
  exit 1
fi
echo "    OK: RefHolderParam DELETED in phase b; no dangling-Ref crash on the deploy"

# --- Case 1b: AppearParam now CREATED (gated on IsPhaseB) ------------
if ! ssm_exists "${APPEAR_PARAM}"; then
  echo "FAIL: AppearParam '${APPEAR_PARAM}' is ABSENT but should be CREATED in phase b (absent -> present)" >&2
  exit 1
fi
APPEAR_VALUE=$(ssm_value "${APPEAR_PARAM}")
if [ "${APPEAR_VALUE}" != "appears-in-phase-b" ]; then
  echo "FAIL: AppearParam Value is '${APPEAR_VALUE}', expected 'appears-in-phase-b'" >&2
  exit 1
fi
echo "    OK: AppearParam CREATED in phase b (absent -> present)"

# --- Case 4: KeeperParam still up + UPDATED despite dropped DependsOn -
# Its DependsOn target (MoverParam) is condition-false in phase b; cdkd must
# drop the dangling DependsOn and still update KeeperParam in place.
if ! ssm_exists "${KEEPER_PARAM}"; then
  echo "FAIL: KeeperParam '${KEEPER_PARAM}' is ABSENT in phase b but DependsOn-target pruning must not remove it" >&2
  exit 1
fi
KEEPER_VALUE=$(ssm_value "${KEEPER_PARAM}")
if [ "${KEEPER_VALUE}" != "keeper-phase-b" ]; then
  echo "FAIL: KeeperParam Value is '${KEEPER_VALUE}', expected 'keeper-phase-b' (Fn::If b branch; in-place update)" >&2
  exit 1
fi
echo "    OK: KeeperParam still up + UPDATED to phase-b value (dangling DependsOn dropped)"

# --- Case 2: WorkQueue RedrivePolicy GONE (Fn::If -> AWS::NoValue) ----
# Same physical queue (QueueName unchanged); the nested block must be dropped
# by the in-place provider.update(), not by replacing the queue.
WORK_QUEUE_URL=$(queue_url "${WORK_QUEUE_NAME}")
if [ -z "${WORK_QUEUE_URL}" ]; then
  echo "FAIL: WorkQueue '${WORK_QUEUE_NAME}' not found after phase-b deploy (it must NOT be replaced/removed)" >&2
  exit 1
fi
RP=$(work_queue_redrive_policy)
if [ -n "${RP}" ] && [ "${RP}" != "None" ]; then
  echo "FAIL: WorkQueue RedrivePolicy is '${RP}', expected GONE in phase b (Fn::If -> AWS::NoValue on UPDATE)" >&2
  exit 1
fi
echo "    OK: WorkQueue RedrivePolicy nested block REMOVED in place in phase b"

# --- Case 3: MoverParamName output (gated on IsPhaseA) now ABSENT ----
KEYS=$(state_output_keys)
if echo "${KEYS}" | grep -qx "MoverParamName"; then
  echo "FAIL: MoverParamName output STILL in cdkd state outputs but should be absent in phase b" >&2
  echo "      state output keys were: ${KEYS}" >&2
  exit 1
fi
echo "    OK: condition-gated output MoverParamName ABSENT in cdkd state (phase b)"

# ====================================================================
# Phase C: destroy + clean
# ====================================================================
echo ""
echo "==> Phase C: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ssm_exists "${KEEPER_PARAM}"; then
  echo "FAIL: KeeperParam still exists after destroy" >&2
  exit 1
fi
if ssm_exists "${APPEAR_PARAM}"; then
  echo "FAIL: AppearParam still exists after destroy" >&2
  exit 1
fi
if [ -n "$(queue_url "${WORK_QUEUE_NAME}")" ]; then
  echo "FAIL: WorkQueue '${WORK_QUEUE_NAME}' still exists after destroy" >&2
  exit 1
fi
if [ -n "$(queue_url "${DLQ_NAME}")" ]; then
  echo "FAIL: DeadLetterQueue '${DLQ_NAME}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: all AWS resources gone after destroy"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> conditions-update-2 test passed (All 14 assertions passed)"
