#!/usr/bin/env bash
# verify.sh - cdkd deploy-force-quit-rollback integ (go-to-k/cdkd#6894).
#
# A deploy that is force-quit (a second SIGINT, as a cancelled CI job sends)
# or hung up (SIGHUP, a closed terminal) while an operation is in flight used
# to exit with the resources it had already updated left in their new state
# and NO rollback journal, so `cdkd rollback` answered "Nothing to roll back".
#
# Two arms, each from a clean v1 stack:
#
#   int2: deploy v2 in the background; once the three first updates are
#         recorded in state.json (the custom resource's 90 s update is then in
#         flight), send SIGINT twice. Expect exit 130 and a journal whose
#         newest segment is `interrupted`.
#   hup:  the same with ONE SIGHUP. Expect exit 129, an `interrupted` segment
#         that lists the in-flight custom resource as a failed operation.
#
# After each: `cdkd force-unlock`, `cdkd rollback --force`, and the parameter,
# the queue's visibility timeout and the function's environment variable are
# back to v1, with the journal gone. Then destroy and an orphan check.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket
#   AWS_REGION   - defaults to us-east-1

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
# shellcheck source=../cr-log-groups.sh
. ../cr-log-groups.sh

STACK="CdkdDeployForceQuitRollback"
REGION="${AWS_REGION:-us-east-1}"
PREFIX="cdkd/${STACK}/${REGION}"
STATE_KEY="${PREFIX}/state.json"
JOURNAL_KEY="${PREFIX}/rollback-journal.json"

MARKER_NAME="${STACK}-marker"
AFTER_NAME="${STACK}-after"
QUEUE_NAME="${STACK}-queue"
AFTER_QUEUE_NAME="${STACK}-after-queue"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"
DEPLOY_PID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover deploy, lock, stack and state"
  set +eu
  if [ -n "${DEPLOY_PID}" ] && kill -0 "${DEPLOY_PID}" 2>/dev/null; then
    kill -KILL "${DEPLOY_PID}" 2>/dev/null
    wait "${DEPLOY_PID}" 2>/dev/null
  fi
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" force-unlock "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --stack-region "${REGION}" --yes >/dev/null 2>&1
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
        --region "${REGION}" --force >/dev/null 2>&1
    fi
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/${PREFIX}/" --recursive >/dev/null 2>&1
  fi
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  rm -rf "${LOG_DIR}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- readers ------------------------------------------------------------

ssm_value() { # usage: ssm_value <name>
  aws ssm get-parameter --name "$1" --region "${REGION}" --query 'Parameter.Value' --output text
}

queue_visibility() { # usage: queue_visibility <queue name>
  local url
  url="$(aws sqs get-queue-url --queue-name "$1" --region "${REGION}" --query QueueUrl --output text)" || return 1
  aws sqs get-queue-attributes --queue-url "${url}" --region "${REGION}" \
    --attribute-names VisibilityTimeout --query 'Attributes.VisibilityTimeout' --output text
}

state_body() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

# The physical id of the first state record whose logical id starts with $1.
state_physical_id() { # usage: state_physical_id <logical-id prefix> <type>
  state_body | jq -r --arg p "$1" --arg t "$2" \
    '[.resources | to_entries[] | select((.key | startswith($p)) and .value.resourceType == $t) | .value.physicalId] | first'
}

fn_marker() { # usage: fn_marker <function name>
  aws lambda get-function-configuration --function-name "$1" --region "${REGION}" \
    --query 'Environment.Variables.FIXTURE_MARKER' --output text
}

# True once state.json records the v2 values of all three first resources:
# a record is saved only after its operation COMPLETED, so the custom
# resource that depends on them is dispatched next.
first_updates_recorded() {
  local body
  body="$(state_body)" || return 1
  jq -e '
    [.resources | to_entries[]] as $r
    | ([$r[] | select(.key | startswith("Marker")) | .value.properties.Value] | first) == "marker-v2"
      and ([$r[] | select(.key | startswith("Queue")) | .value.properties.VisibilityTimeout | tostring] | first) == "45"
      and ([$r[] | select((.key | startswith("Fn")) and .value.resourceType == "AWS::Lambda::Function")
            | .value.properties.Environment.Variables.FIXTURE_MARKER] | first) == "fn-v2"
  ' <<<"${body}" >/dev/null
}

assert_v1() { # usage: assert_v1 <label>
  local marker vis fnm after avis
  marker="$(ssm_value "${MARKER_NAME}")"
  vis="$(queue_visibility "${QUEUE_NAME}")"
  fnm="$(fn_marker "${FN_NAME}")"
  after="$(ssm_value "${AFTER_NAME}")"
  avis="$(queue_visibility "${AFTER_QUEUE_NAME}")"
  if [ "${marker}" != "marker-v1" ] || [ "${vis}" != "30" ] || [ "${fnm}" != "fn-v1" ]; then
    echo "FAIL: $1: expected marker-v1 / 30 / fn-v1, got ${marker} / ${vis} / ${fnm}" >&2
    exit 1
  fi
  # The resources behind the custom resource were never reached.
  if [ "${after}" != "after-v1" ] || [ "${avis}" != "30" ]; then
    echo "FAIL: $1: the resources behind the custom resource changed: ${after} / ${avis}" >&2
    exit 1
  fi
  echo "    OK: $1: parameter, queue and function are at v1"
}

# --- preconditions --------------------------------------------------------

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

# --- Phase 1: deploy v1 ---------------------------------------------------
echo "==> Phase 1: deploy v1"
FIXTURE_VERSION=v1 node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes

FN_NAME="$(state_physical_id Fn AWS::Lambda::Function)"
GATE_FN_NAME="$(state_physical_id GateHandler AWS::Lambda::Function)"
ROLE_NAMES="$(state_body | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role") | .value.physicalId')"
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ] || [ -z "${GATE_FN_NAME}" ] || [ "${GATE_FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the functions from state" >&2
  exit 1
fi
echo "    function: ${FN_NAME}; custom resource handler: ${GATE_FN_NAME}"
assert_v1 "after the v1 deploy"

# --- one interrupted v2 deploy, then the rollback --------------------------
# usage: interrupt_arm <arm> <int2|hup> <expected exit code>
interrupt_arm() {
  local arm="$1" mode="$2" expected="$3"
  local log="${LOG_DIR}/${arm}-deploy.log"
  echo "==> Arm ${arm}: deploy v2 in the background"
  FIXTURE_VERSION=v2 node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --yes >"${log}" 2>&1 &
  DEPLOY_PID=$!

  local waited=0
  until first_updates_recorded; do
    if ! kill -0 "${DEPLOY_PID}" 2>/dev/null; then
      echo "FAIL: ${arm}: the deploy exited before the first updates were recorded" >&2
      cat "${log}" >&2
      exit 1
    fi
    if [ "${waited}" -ge 240 ]; then
      echo "FAIL: ${arm}: the first updates were not recorded within 240 s" >&2
      cat "${log}" >&2
      exit 1
    fi
    sleep 2
    waited=$((waited + 2))
  done
  # The custom resource is dispatched once its three dependencies completed;
  # its handler then sleeps 90 s, so the deploy is mid-operation for that long.
  sleep 5
  if ! kill -0 "${DEPLOY_PID}" 2>/dev/null; then
    echo "FAIL: ${arm}: the deploy finished before it could be interrupted" >&2
    cat "${log}" >&2
    exit 1
  fi

  if [ "${mode}" = "int2" ]; then
    echo "    sending SIGINT twice to ${DEPLOY_PID}"
    kill -INT "${DEPLOY_PID}"
    sleep 0.2
    kill -INT "${DEPLOY_PID}"
  else
    echo "    sending SIGHUP to ${DEPLOY_PID}"
    kill -HUP "${DEPLOY_PID}"
  fi
  local rc=0
  wait "${DEPLOY_PID}" || rc=$?
  DEPLOY_PID=""
  echo "    deploy exited ${rc}; its output:"
  sed 's/^/      | /' "${log}"
  if [ "${rc}" -ne "${expected}" ]; then
    echo "FAIL: ${arm}: the deploy exited ${rc}, expected ${expected}" >&2
    exit 1
  fi

  local journal
  if ! journal="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" - --region "${REGION}")"; then
    echo "FAIL: ${arm}: no rollback journal at ${JOURNAL_KEY} after the interrupted deploy" >&2
    exit 1
  fi
  local reason
  reason="$(jq -r '.segments[-1].reason' <<<"${journal}")"
  if [ "${reason}" != "interrupted" ]; then
    echo "FAIL: ${arm}: the newest journal segment's reason is '${reason}', expected 'interrupted'" >&2
    exit 1
  fi
  if ! jq -e '[.segments[-1].operations[].logicalId] | map(select(startswith("Marker") or startswith("Queue") or startswith("Fn"))) | length == 3' \
    <<<"${journal}" >/dev/null; then
    echo "FAIL: ${arm}: the segment does not list the three completed updates:" >&2
    jq '.segments[-1].operations | map(.logicalId)' <<<"${journal}" >&2
    exit 1
  fi
  if [ "${mode}" = "hup" ]; then
    # A hang-up never drains, so the custom resource was still in flight.
    if ! jq -e '[.segments[-1].failedOperations[]?.logicalId] | any(startswith("Gate") and (startswith("GateHandler") | not))' \
      <<<"${journal}" >/dev/null; then
      echo "FAIL: ${arm}: the in-flight custom resource is not a failed operation in the segment" >&2
      exit 1
    fi
    echo "    OK: ${arm}: the in-flight custom resource is journaled as a failed operation"
  fi
  if ! grep -q "Release with: " "${log}"; then
    echo "FAIL: ${arm}: the force-quit did not print the lock-release command" >&2
    exit 1
  fi
  echo "    OK: ${arm}: exit ${rc}, an interrupted journal segment with the completed updates"

  echo "==> Arm ${arm}: force-unlock, then cdkd rollback --force"
  node "${LOCAL_DIST}" force-unlock "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --yes
  node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --force >"${LOG_DIR}/${arm}-rollback.log" 2>&1 || {
    echo "FAIL: ${arm}: cdkd rollback failed:" >&2
    cat "${LOG_DIR}/${arm}-rollback.log" >&2
    exit 1
  }
  assert_v1 "${arm}: after cdkd rollback"
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"; then
    echo "FAIL: ${arm}: the rollback journal is still present after a clean rollback" >&2
    exit 1
  fi
  echo "    OK: ${arm}: the journal is gone"
}

interrupt_arm int2 int2 130
interrupt_arm hup hup 129

# --- Phase 3: destroy and orphan check ------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "state.json still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for pname in "${MARKER_NAME}" "${AFTER_NAME}"; do
  assert_gone "SSM parameter ${pname} still exists after destroy" \
    aws ssm get-parameter --name "${pname}" --region "${REGION}"
done
for qname in "${QUEUE_NAME}" "${AFTER_QUEUE_NAME}"; do
  assert_gone "SQS queue ${qname} still exists after destroy" \
    aws sqs get-queue-url --queue-name "${qname}" --region "${REGION}"
done
for fname in "${FN_NAME}" "${GATE_FN_NAME}"; do
  assert_gone "Lambda function ${fname} still exists after destroy" \
    aws lambda get-function --function-name "${fname}" --region "${REGION}"
done
while IFS= read -r role; do
  [ -z "${role}" ] && continue
  assert_gone "IAM role ${role} still exists after destroy" aws iam get-role --role-name "${role}"
done <<EOF
${ROLE_NAMES}
EOF
echo "    OK: every resource is gone"

echo ""
echo "[verify] PASS"
