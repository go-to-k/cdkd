#!/usr/bin/env bash
# verify.sh — cdkd Ref of AWS::Logs::LogStream, AWS::Logs::SubscriptionFilter,
# AWS::SSM::MaintenanceWindowTarget, AWS::SSM::MaintenanceWindowTask and
# AWS::CodeDeploy::DeploymentGroup (issue #6293).
#
# Each is Cloud-Control routed with a pipe-joined physical id; CloudFormation's
# Ref is one segment. Asserts every Ref output has no '|' and equals the live
# value AWS reports, then destroys clean and probes that everything is gone.

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

STACK="CdkdRefShapeCompoundCcIdsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    fi
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

assert_eq() { # usage: assert_eq <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 is '$2', expected '$3'" >&2
    exit 1
  fi
  echo "    OK: $1 == $3"
}

assert_refs() {
  local lg stream filter window target task app group live
  lg="$(output_of LogGroupName)" || return 1
  window="$(output_of WindowId)" || return 1
  app="$(output_of AppName)" || return 1
  for k in LogStreamRef FilterRef TargetRef TaskRef DeploymentGroupRef; do
    case "$(output_of "${k}")" in
      '') echo "FAIL: output ${k} missing" >&2; exit 1 ;;
      *'|'*) echo "FAIL: output ${k} is the compound id '$(output_of "${k}")'" >&2; exit 1 ;;
    esac
  done

  stream="$(output_of LogStreamRef)"
  live="$(aws logs describe-log-streams --region "${REGION}" --log-group-name "${lg}" --log-stream-name-prefix "${stream}" --query 'logStreams[0].logStreamName' --output text)" || return 1
  assert_eq "Ref LogStream (stream name)" "${stream}" "${live}"

  filter="$(output_of FilterRef)"
  live="$(aws logs describe-subscription-filters --region "${REGION}" --log-group-name "${lg}" --query 'subscriptionFilters[0].filterName' --output text)" || return 1
  assert_eq "Ref SubscriptionFilter (filter name)" "${filter}" "${live}"

  target="$(output_of TargetRef)"
  live="$(aws ssm describe-maintenance-window-targets --region "${REGION}" --window-id "${window}" --query 'Targets[0].WindowTargetId' --output text)" || return 1
  assert_eq "Ref MaintenanceWindowTarget (target id)" "${target}" "${live}"

  task="$(output_of TaskRef)"
  live="$(aws ssm describe-maintenance-window-tasks --region "${REGION}" --window-id "${window}" --query 'Tasks[0].WindowTaskId' --output text)" || return 1
  assert_eq "Ref MaintenanceWindowTask (task id)" "${task}" "${live}"
  live="$(aws ssm get-maintenance-window-task --region "${REGION}" --window-id "${window}" --window-task-id "${task}" --query 'Targets[0].Values[0]' --output text)" || return 1
  assert_eq "Task Targets value (Ref MaintenanceWindowTarget reached a property)" "${live}" "${target}"

  group="$(output_of DeploymentGroupRef)"
  live="$(aws deploy get-deployment-group --region "${REGION}" --application-name "${app}" --deployment-group-name "${group}" --query 'deploymentGroupInfo.deploymentGroupName' --output text)" || return 1
  assert_eq "Ref DeploymentGroup (group name)" "${group}" "${live}"
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy1.log"
assert_refs
LOG_GROUP="$(output_of LogGroupName)"
WINDOW_ID="$(output_of WindowId)"
APP_NAME="$(output_of AppName)"

echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "log group ${LOG_GROUP} still exists after destroy" aws logs describe-subscription-filters --region "${REGION}" --log-group-name "${LOG_GROUP}"
assert_gone "maintenance window ${WINDOW_ID} still exists after destroy" aws ssm get-maintenance-window --region "${REGION}" --window-id "${WINDOW_ID}"
assert_gone "CodeDeploy application ${APP_NAME} still exists after destroy" aws deploy get-application --region "${REGION}" --application-name "${APP_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: log group, maintenance window, CodeDeploy application and state gone"

echo ""
echo "[verify] PASS — ref-shape-compound-cc-ids: Ref of LogStream, SubscriptionFilter, MaintenanceWindowTarget, MaintenanceWindowTask and DeploymentGroup match CloudFormation"
