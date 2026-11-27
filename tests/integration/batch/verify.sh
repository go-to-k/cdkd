#!/usr/bin/env bash
# verify.sh — cdkd AWS Batch (go-to-k/cdkd#7098).
#
# A Batch compute environment's ComputeResources change that needs an
# infrastructure update replaces the environment unless the template sets
# `ReplaceComputeEnvironment: false`, as CloudFormation does.
#
# Phases:
#   1. Deploy (Fargate environment + job queue + job definition, and an EC2
#      environment with ReplaceComputeEnvironment: false and 0 min vCPUs).
#   2. Re-deploy with CDKD_TEST_UPDATE=true:
#      - the Fargate environment's Type goes FARGATE -> FARGATE_SPOT with no
#        ReplaceComputeEnvironment: assert a NEW environment ARN with the new
#        type, the old environment gone, and the job queue pointing at the new
#        one;
#      - the EC2 environment's InstanceTypes goes optimal -> m5.large: assert
#        the SAME ARN now holds m5.large.
#   3. Destroy + assert cdkd state is gone.
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

STACK="BatchStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}
ce_field() { # usage: ce_field <arn> <jmespath under computeEnvironments[0]>
  aws batch describe-compute-environments --compute-environments "$1" --region "${REGION}" \
    --query "computeEnvironments[0].$2" --output text
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

OLD_FARGATE_ARN="$(output_of ComputeEnvironmentArn)"
EC2_ARN="$(output_of Ec2ComputeEnvironmentArn)"
QUEUE_ARN="$(output_of JobQueueArn)"
for v in OLD_FARGATE_ARN EC2_ARN QUEUE_ARN; do
  if [ -z "${!v}" ]; then
    echo "FAIL: #7098 premise: stack output for ${v} is empty after Phase 1" >&2
    exit 1
  fi
done
# Premises: the changes below are real changes of what AWS holds.
if [ "$(ce_field "${OLD_FARGATE_ARN}" computeResources.type)" != "FARGATE" ]; then
  echo "FAIL: #7098 premise: the Fargate environment is not FARGATE before the update" >&2
  exit 1
fi
if [ "$(ce_field "${EC2_ARN}" 'computeResources.instanceTypes | join(`,`, @)')" != "optimal" ]; then
  echo "FAIL: #7098 premise: the EC2 environment does not hold InstanceTypes [optimal] before the update" >&2
  exit 1
fi
echo "    deployed: Fargate ${OLD_FARGATE_ARN}, EC2 ${EC2_ARN}"

# --- Phase 2: the two ComputeResources changes -------------------------
echo "==> Phase 2: Type FARGATE -> FARGATE_SPOT (replace) and InstanceTypes -> m5.large (in place)"
P2_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${P2_LOG}"
P2_RC=${PIPESTATUS[0]}
set -e
if REFUSED="$(grep -E 'NotUpdatable|is not updatable with parameters provided' "${P2_LOG}")"; then
  echo "FAIL: #7098: a ComputeResources change was sent as an in-place update Batch refused (NotUpdatable) instead of a replacement: ${REFUSED}" >&2
  exit 1
fi
if [ "${P2_RC}" -ne 0 ]; then
  echo "FAIL: #7098: the ComputeResources update deploy exited ${P2_RC}" >&2
  exit 1
fi

NEW_FARGATE_ARN="$(output_of ComputeEnvironmentArn)"
if [ -z "${NEW_FARGATE_ARN}" ] || [ "${NEW_FARGATE_ARN}" = "${OLD_FARGATE_ARN}" ]; then
  echo "FAIL: #7098: the Fargate environment kept ARN ${OLD_FARGATE_ARN} across the Type change (expected a replacement with a NEW ARN)" >&2
  exit 1
fi
if [ "$(ce_field "${NEW_FARGATE_ARN}" computeResources.type)" != "FARGATE_SPOT" ]; then
  echo "FAIL: #7098: the replacement environment ${NEW_FARGATE_ARN} is not FARGATE_SPOT" >&2
  exit 1
fi
# Batch finishes a delete asynchronously: allow it a few minutes to drop out.
OLD_LEFT=""
for _ in $(seq 1 30); do
  OLD_LEFT="$(aws batch describe-compute-environments --compute-environments "${OLD_FARGATE_ARN}" --region "${REGION}" --query "length(computeEnvironments[?status!='DELETED'])" --output text)"
  [ "${OLD_LEFT}" = "0" ] && break
  sleep 10
done
if [ "${OLD_LEFT}" != "0" ]; then
  echo "FAIL: #7098: the replaced Fargate environment ${OLD_FARGATE_ARN} still exists after the update" >&2
  exit 1
fi
QUEUE_CE="$(aws batch describe-job-queues --job-queues "${QUEUE_ARN}" --region "${REGION}" --query 'jobQueues[0].computeEnvironmentOrder[0].computeEnvironment' --output text)"
if [ "${QUEUE_CE}" != "${NEW_FARGATE_ARN}" ]; then
  echo "FAIL: #7098: the job queue points at '${QUEUE_CE}', not the replacement environment ${NEW_FARGATE_ARN}" >&2
  exit 1
fi
if [ "$(output_of Ec2ComputeEnvironmentArn)" != "${EC2_ARN}" ]; then
  echo "FAIL: #7098: the EC2 environment with ReplaceComputeEnvironment: false was replaced (ARN changed from ${EC2_ARN}); it must update in place" >&2
  exit 1
fi
if [ "$(ce_field "${EC2_ARN}" 'computeResources.instanceTypes | join(`,`, @)')" != "m5.large" ]; then
  echo "FAIL: #7098: the EC2 environment ${EC2_ARN} does not hold InstanceTypes [m5.large] after the in-place update" >&2
  exit 1
fi
echo "    Fargate replaced (${OLD_FARGATE_ARN} -> ${NEW_FARGATE_ARN}), queue follows; EC2 updated in place"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for arn in "${NEW_FARGATE_ARN}" "${EC2_ARN}"; do
  LEFT=""
  for _ in $(seq 1 30); do
    LEFT="$(aws batch describe-compute-environments --compute-environments "${arn}" --region "${REGION}" --query "length(computeEnvironments[?status!='DELETED'])" --output text)"
    [ "${LEFT}" = "0" ] && break
    sleep 10
  done
  if [ "${LEFT}" != "0" ]; then
    echo "FAIL: compute environment ${arn} still exists after destroy" >&2
    exit 1
  fi
done
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    destroyed, state removed"

echo "[verify] PASS — a Batch Type change replaces the environment (#7098), ReplaceComputeEnvironment: false updates in place, destroy clean"
