#!/usr/bin/env bash
# verify.sh — cdkd ECS TaskDefinition EnableFaultInjection backfill integ test
# (issue #609).
#
# Asserts that an ECS Fargate TaskDefinition whose template sets
# `EnableFaultInjection: true` has the flag reach AWS after `cdkd deploy`
# — the property was a silent-drop before the #609 backfill. Also
# asserts the destroy path cleans up.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="EcsFargateStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +u` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Assertion: EnableFaultInjection reached AWS ----------------------
# DescribeTaskDefinition returns taskDefinition.enableFaultInjection only
# when set on the registered revision. Seeing `true` proves the
# silent-drop is closed by the #609 backfill.
TD_ARN=$(echo "${STATE}" | jq -r '.outputs.TaskDefinitionArn // "null"')
if [ "${TD_ARN}" = "null" ] || [ -z "${TD_ARN}" ]; then
  echo "FAIL: state.outputs.TaskDefinitionArn is missing after deploy" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi

ACTUAL=$(aws ecs describe-task-definition \
  --task-definition "${TD_ARN}" --region "${REGION}" \
  --query 'taskDefinition.enableFaultInjection' --output json 2>/dev/null)

if [ "${ACTUAL}" != "true" ]; then
  echo "FAIL: taskDefinition.enableFaultInjection is '${ACTUAL}', expected 'true' (silent-drop NOT closed)" >&2
  aws ecs describe-task-definition --task-definition "${TD_ARN}" --region "${REGION}" --query 'taskDefinition' | jq .
  exit 1
fi
echo "    OK: taskDefinition.enableFaultInjection == true on AWS (silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> ecs-fargate test passed (EnableFaultInjection backfill closed + clean destroy)"
