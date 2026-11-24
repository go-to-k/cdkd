#!/usr/bin/env bash
# verify.sh — cdkd --no-wait and a Bedrock AgentCore runtime endpoint
# (go-to-k/cdkd#6962, rule 3 of #6940).
#
# AWS refuses CreateAgentRuntimeEndpoint while the runtime is CREATING
# (measured: "ConflictException: Agent version 1 must be in READY status.
# Current status: CREATING."). Phase 1 deploys a CodeConfiguration runtime and
# an endpoint on it with --no-wait: the runtime's create returns while it is
# CREATING, so the endpoint's create must first wait for the runtime's skipped
# READY wait. Asserted: the deploy succeeds; it prints the readiness wait for
# the runtime, asked for by the endpoint (the wait runs before the endpoint's
# create call, which AWS would otherwise refuse); the runtime and the endpoint
# are READY. Before #6962 the endpoint's create reached AWS at once and the
# deploy failed with that ConflictException.
#
# Phase 2 destroys and asserts the endpoint, the runtime and the state file
# are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Runtime: ~3 min.

set -euo pipefail

export AWS_PAGER=""

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

STACK="CdkdNoWaitAgentcoreRuntimeEndpointExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG=""

# The names live in the stack file; read them rather than re-typing them.
RUNTIME_NAME="$(grep -oE "RUNTIME_NAME = '[A-Za-z0-9_]+'" lib/no-wait-agentcore-runtime-endpoint-stack.ts | grep -oE "'[^']+'" | tr -d "'" || true)"
ENDPOINT_NAME="$(grep -oE "ENDPOINT_NAME = '[A-Za-z0-9_]+'" lib/no-wait-agentcore-runtime-endpoint-stack.ts | grep -oE "'[^']+'" | tr -d "'" || true)"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_LOG}"
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  # A runtime no state of this run holds, found by its exact name: its
  # endpoint first, then the runtime. The name is a literal of the stack file;
  # an empty one would match nothing here, since the query compares equality.
  case "${RUNTIME_NAME}" in
    cdkdNoWait?*)
      for rt in $(aws bedrock-agentcore-control list-agent-runtimes --region "${REGION}" \
        --query "agentRuntimes[?agentRuntimeName=='${RUNTIME_NAME}'].agentRuntimeId" --output text); do
        aws bedrock-agentcore-control delete-agent-runtime-endpoint --agent-runtime-id "${rt}" \
          --endpoint-name "${ENDPOINT_NAME}" --region "${REGION}" >/dev/null 2>&1
        aws bedrock-agentcore-control delete-agent-runtime --agent-runtime-id "${rt}" --region "${REGION}" >/dev/null 2>&1
      done
      ;;
    *)
      echo "    WARN: teardown sweep refused: runtime name '${RUNTIME_NAME}' is outside this fixture's scope" >&2
      ;;
  esac
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
if [ -z "${RUNTIME_NAME}" ] || [ -z "${ENDPOINT_NAME}" ]; then
  echo "FAIL: could not read RUNTIME_NAME / ENDPOINT_NAME from the stack file" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"; }

# --- Phase 1: deploy with --no-wait ----------------------------------------
echo "==> Phase 1: deploy --no-wait"
DEPLOY_LOG="$(mktemp)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --yes --no-wait 2>&1 | tee "${DEPLOY_LOG}"; then
  echo "FAIL: the --no-wait deploy failed (before #6962: ConflictException, the runtime was still CREATING)" >&2
  exit 1
fi
DEPLOY_OUT="$(cat "${DEPLOY_LOG}")"
if ! grep -qE 'Runtime[0-9A-F]+ \(AWS::BedrockAgentCore::Runtime\), whose readiness wait --no-wait skipped: (RuntimeEndpointlive[0-9A-F]+ is created or updated on it|Fn::GetAtt)' <<<"${DEPLOY_OUT}"; then
  echo "FAIL: the deploy printed no readiness wait for the runtime before its endpoint" >&2
  exit 1
fi
echo "    OK: the endpoint waited for the runtime --no-wait had not waited for"

STATE="$(state_json)"
RUNTIME_ID="$(jq -r '.outputs.RuntimeId // empty' <<<"${STATE}")"
[ -n "${RUNTIME_ID}" ] || { echo "FAIL: no RuntimeId output" >&2; exit 1; }
RUNTIME_STATUS="$(aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${RUNTIME_ID}" \
  --region "${REGION}" --query status --output text)"
[ "${RUNTIME_STATUS}" = "READY" ] || { echo "FAIL: runtime ${RUNTIME_ID} is '${RUNTIME_STATUS}', not READY" >&2; exit 1; }
echo "    OK: runtime ${RUNTIME_ID} is READY"

ENDPOINT_STATUS=""
for _ in $(seq 1 30); do
  ENDPOINT_STATUS="$(aws bedrock-agentcore-control get-agent-runtime-endpoint --agent-runtime-id "${RUNTIME_ID}" \
    --endpoint-name "${ENDPOINT_NAME}" --region "${REGION}" --query status --output text)"
  [ "${ENDPOINT_STATUS}" = "READY" ] && break
  case "${ENDPOINT_STATUS}" in *FAILED*) break ;; esac
  sleep 5
done
[ "${ENDPOINT_STATUS}" = "READY" ] || { echo "FAIL: endpoint ${ENDPOINT_NAME} is '${ENDPOINT_STATUS}', not READY" >&2; exit 1; }
echo "    OK: endpoint ${ENDPOINT_NAME} is READY"

# --- Phase 2: destroy -------------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "endpoint ${ENDPOINT_NAME} of ${RUNTIME_ID} still exists after destroy" \
  aws bedrock-agentcore-control get-agent-runtime-endpoint --agent-runtime-id "${RUNTIME_ID}" \
  --endpoint-name "${ENDPOINT_NAME}" --region "${REGION}"
# A runtime reads DELETING for a while after the delete; poll until it is gone.
RUNTIME_GONE=""
for _ in $(seq 1 60); do
  if gone_probe aws bedrock-agentcore-control get-agent-runtime --agent-runtime-id "${RUNTIME_ID}" --region "${REGION}"; then
    RUNTIME_GONE="yes"
    break
  fi
  sleep 5
done
[ -n "${RUNTIME_GONE}" ] || { echo "FAIL: runtime ${RUNTIME_ID} still exists after destroy" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: endpoint, runtime and state gone"

echo ""
echo "[verify] PASS — no-wait-agentcore-runtime-endpoint: under --no-wait the runtime endpoint waited for its runtime to be READY"
