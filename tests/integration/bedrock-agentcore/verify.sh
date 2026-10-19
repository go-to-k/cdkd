#!/usr/bin/env bash
# verify.sh - cdkd bedrock-agentcore integ + removal of Runtime properties (#1160).
#
# Deploys the fixture (a code-asset and a Docker-asset AgentCore Runtime),
# then redeploys with CDKD_TEST_REMOVAL=true, where the code runtime drops
# Description, AuthorizerConfiguration, ProtocolConfiguration,
# LifecycleConfiguration and EnvironmentVariables. A CloudFormation A/B
# (us-east-1) cleared each removed field, the lifecycle back to the service
# defaults 900 / 28800. UpdateAgentRuntime is a full replace, so cdkd omitting
# a field is that reset; this run pins it against a regression to merge
# semantics (filling an absent field from the previous template). Then
# destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
# Requires a running Docker daemon (the Docker-asset runtime is built locally).

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

STACK="BedrockAgentcoreStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CODE_RUNTIME_LOGICAL_ID="CodeRuntime71A3EE1C"
DOCKER_RUNTIME_LOGICAL_ID="DockerRuntime395AC11E"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
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

if ! docker info >/dev/null 2>&1; then
  echo "FAIL: no running Docker daemon (the DockerRuntime asset is built locally)" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# Prints a resource's physical id from the cdkd state record.
physical_id() { # usage: physical_id <logical-id>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg l "$1" '.resources[$l].physicalId // empty'
}

# Waits (bounded) until the runtime settles at READY: create and update are
# asynchronous, and a read while UPDATING can still show the old version.
wait_ready() { # usage: wait_ready <runtime-id>
  local status=""
  for _ in $(seq 1 36); do
    status=$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" \
      --region "${REGION}" --query status --output text) || return 1
    [ "${status}" = "READY" ] && return 0
    sleep 5
  done
  echo "FAIL: runtime $1 did not reach READY within 180s (last status '${status}')" >&2
  exit 1
}

# Prints the code runtime's five #1160 fields as one compact JSON object
# (null for an absent one); the authorizer is reduced to its allowed clients.
runtime_fields() { # usage: runtime_fields <runtime-id>
  aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "$1" --region "${REGION}" \
    --query '{description: description, authorizer: authorizerConfiguration.customJWTAuthorizer.allowedClients, protocol: protocolConfiguration.serverProtocol, lifecycle: lifecycleConfiguration, env: environmentVariables}' \
    --output json | jq -c -S .
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RUNTIME_ID=$(physical_id "${CODE_RUNTIME_LOGICAL_ID}")
DOCKER_RUNTIME_ID=$(physical_id "${DOCKER_RUNTIME_LOGICAL_ID}")
if [ -z "${RUNTIME_ID}" ] || [ -z "${DOCKER_RUNTIME_ID}" ]; then
  echo "FAIL: runtime physical ids missing from state: ${CODE_RUNTIME_LOGICAL_ID}='${RUNTIME_ID}' ${DOCKER_RUNTIME_LOGICAL_ID}='${DOCKER_RUNTIME_ID}'" >&2
  exit 1
fi
wait_ready "${RUNTIME_ID}"
# Issue #1160 baseline: every field holds a non-default value first, so its
# absence afterwards is the removal's doing.
P1_FIELDS=$(runtime_fields "${RUNTIME_ID}")
P1_EXPECTED='{"authorizer":["cdkd-integ-client"],"description":"cdkd integ code runtime","env":{"CDKD_INTEG":"bedrock-agentcore"},"lifecycle":{"idleRuntimeSessionTimeout":600,"maxLifetime":3600},"protocol":"MCP"}'
if [ "${P1_FIELDS}" != "${P1_EXPECTED}" ]; then
  echo "FAIL: code runtime ${RUNTIME_ID} after create: expected ${P1_EXPECTED}, got ${P1_FIELDS}" >&2
  exit 1
fi
echo "    OK: baseline runtime ${RUNTIME_ID} carries all five fields"

# --- Phase 2: REMOVAL drops the five fields (issue #1160) ---------------
echo "==> Phase 2: removal (drop Description, AuthorizerConfiguration, ProtocolConfiguration, LifecycleConfiguration, EnvironmentVariables)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RM_RUNTIME_ID=$(physical_id "${CODE_RUNTIME_LOGICAL_ID}")
if [ "${RM_RUNTIME_ID}" != "${RUNTIME_ID}" ]; then
  echo "FAIL: the code runtime was replaced by the removal (must update in place): '${RUNTIME_ID}' -> '${RM_RUNTIME_ID}'" >&2
  exit 1
fi
wait_ready "${RUNTIME_ID}"
P2_FIELDS=$(runtime_fields "${RUNTIME_ID}")
P2_EXPECTED='{"authorizer":null,"description":null,"env":null,"lifecycle":{"idleRuntimeSessionTimeout":900,"maxLifetime":28800},"protocol":null}'
if [ "${P2_FIELDS}" != "${P2_EXPECTED}" ]; then
  echo "FAIL: the code runtime kept a removed field (issue #1160): expected ${P2_EXPECTED} as CloudFormation leaves it, got ${P2_FIELDS}" >&2
  exit 1
fi
echo "    OK: removed fields cleared and the lifecycle back to 900 / 28800, in place (issue #1160)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
env -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# DeleteAgentRuntime is asynchronous: poll (bounded) until the read says gone.
for RT in "${RUNTIME_ID}" "${DOCKER_RUNTIME_ID}"; do
  gone=false
  for _ in $(seq 1 36); do
    if gone_probe aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${RT}" --region "${REGION}"; then
      gone=true
      break
    fi
    sleep 5
  done
  if [ "${gone}" != true ]; then
    echo "FAIL: runtime '${RT}' still exists 180s after destroy" >&2
    exit 1
  fi
done
echo "    OK: both runtimes are gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> bedrock-agentcore test passed (removed Runtime fields cleared + clean destroy)"
