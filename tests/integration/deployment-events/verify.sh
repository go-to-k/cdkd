#!/usr/bin/env bash
#
# End-to-end real-AWS validation for cdkd structured deployment events
# (issue #808): cdkd persists a JSONL stream of per-run lifecycle events to
# a SEPARATE S3 key family from state.json
# (`cdkd/{stack}/{region}/deployments/{runId}.jsonl` + `deployments/index.json`),
# and the `cdkd events <stack>` command reads them back — the local
# equivalent of CloudFormation's `DescribeStackEvents`.
#
# The point of this test is the EVENTS feature, not the fixture's resources
# (a tiny SNS topic + SSM parameter that deploy/destroy in well under a
# minute, no VPC/NAT). It asserts the full #808 contract end-to-end:
#
#   - deploy writes a `deployments/{runId}.jsonl` + `deployments/index.json`
#   - `cdkd events` lists a `deploy` run as SUCCEEDED
#   - `cdkd events ... --format json` is valid JSON carrying RUN_STARTED /
#     RUN_FINISHED + at least one RESOURCE_* event for the topic/parameter
#   - NO resource properties / secret values appear in the events output
#     (the #808 no-secrets guarantee — properties live only in state.json)
#   - events SURVIVE `cdkd destroy` (state.json is gone, but the
#     `deployments/` sidecar — now also carrying the destroy run — is still
#     readable), so `cdkd events` lists BOTH a deploy and a destroy run
#
# BSD/macOS-portable: no grep -P, no date -d. Integ-exit-code-capture
# pattern (bash ...; rc=$?) so a piped/teed harness can't mask a failure;
# the script prints an explicit "[verify] PASS" only at the very end.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

STACK="CdkdDeploymentEventsExample"
SSM_PARAM_NAME="${STACK}-marker"
TOPIC_NAME="${STACK}-topic"
SECRET_MARKER="events-integ-secret-value"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/deployment-events"
CLI="node ${REPO_ROOT}/dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required"
  exit 1
fi

STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
DEPLOYMENTS_PREFIX="cdkd/${STACK}/${REGION}/deployments/"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
    # Best-effort: destroy the stack if cdkd state still exists.
    if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1; then
      echo "[verify] cleanup: cdkd destroy ${STACK}"
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    fi
    # Direct AWS cleanup in case destroy itself is what broke.
    echo "[verify] cleanup: delete SSM parameter ${SSM_PARAM_NAME} (ignore NotFound)"
    aws ssm delete-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
    # SNS topic (deterministic name): resolve ARN from the account id, then delete.
    echo "[verify] cleanup: delete SNS topic ${TOPIC_NAME} (ignore NotFound)"
    cleanup_acct="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
    if [ -n "${cleanup_acct}" ] && [ "${cleanup_acct}" != "None" ]; then
      aws sns delete-topic \
        --topic-arn "arn:aws:sns:${REGION}:${cleanup_acct}:${TOPIC_NAME}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    fi
  fi
  # ALWAYS remove the events sidecar so the integ leaves nothing behind
  # (events deliberately survive destroy — the test itself must clean them).
  echo "[verify] cleanup: remove events sidecar s3://${STATE_BUCKET}/cdkd/${STACK}/"
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd (root) + fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace
fi

echo "[verify] step 2: cdkd deploy ${STACK}"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

echo "[verify] step 3: assert deploy wrote the events sidecar (jsonl + index.json)"
DEPLOY_KEYS="$(aws s3 ls "s3://${STATE_BUCKET}/${DEPLOYMENTS_PREFIX}" 2>&1 || true)"
echo "${DEPLOY_KEYS}" | sed 's/^/  /'
if ! echo "${DEPLOY_KEYS}" | grep -E -q '[A-Za-z0-9-]+\.jsonl$'; then
  echo "[verify] FAIL: no <runId>.jsonl under s3://${STATE_BUCKET}/${DEPLOYMENTS_PREFIX}"
  exit 1
fi
if ! echo "${DEPLOY_KEYS}" | grep -F -q 'index.json'; then
  echo "[verify] FAIL: no index.json under s3://${STATE_BUCKET}/${DEPLOYMENTS_PREFIX}"
  exit 1
fi
echo "[verify] step 3 ok: deployments/{runId}.jsonl + index.json present"

echo "[verify] step 4: cdkd events ${STACK} lists a SUCCEEDED deploy run"
EVENTS_LIST_OUT="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" 2>&1)"
echo "${EVENTS_LIST_OUT}" | sed 's/^/  /'
# A run line carries the command word ("deploy") and the result ("SUCCEEDED").
if ! echo "${EVENTS_LIST_OUT}" | grep -F -q 'deploy'; then
  echo "[verify] FAIL: 'cdkd events' listing shows no deploy run"
  exit 1
fi
if ! echo "${EVENTS_LIST_OUT}" | grep -F -q 'SUCCEEDED'; then
  echo "[verify] FAIL: 'cdkd events' listing shows no SUCCEEDED result"
  exit 1
fi
echo "[verify] step 4 ok: listing shows a SUCCEEDED deploy run"

echo "[verify] step 4b: cdkd events --format json is valid JSON with RUN_* + RESOURCE_* events"
# The run-listing JSON has shape {stackName, region, runs:[...]}; resolve the
# newest run id from it, then read that run's full event stream as JSON.
EVENTS_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --format json 2>&1)"
# Validate it parses + carries the deploy run.
RUN_ID="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].runId')"
RUN_CMD="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].command')"
RUN_RESULT="$(echo "${EVENTS_JSON}" | jq -r '.runs[0].result')"
if [ -z "${RUN_ID}" ] || [ "${RUN_ID}" = "null" ]; then
  echo "[verify] FAIL: run-listing JSON has no runs[0].runId:"
  echo "${EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
if [ "${RUN_CMD}" != "deploy" ] || [ "${RUN_RESULT}" != "SUCCEEDED" ]; then
  echo "[verify] FAIL: newest run is not a SUCCEEDED deploy (command=${RUN_CMD} result=${RUN_RESULT})"
  exit 1
fi
echo "[verify]   newest deploy run id: ${RUN_ID}"

# The per-run JSON ('--run <id> --format json') is the raw DeploymentEvent[].
RUN_EVENTS_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --run "${RUN_ID}" --format json 2>&1)"
N_STARTED="$(echo "${RUN_EVENTS_JSON}" | jq '[.[] | select(.eventType == "RUN_STARTED")] | length')"
N_FINISHED="$(echo "${RUN_EVENTS_JSON}" | jq '[.[] | select(.eventType == "RUN_FINISHED")] | length')"
N_RESOURCE="$(echo "${RUN_EVENTS_JSON}" | jq '[.[] | select(.eventType | startswith("RESOURCE_"))] | length')"
if [ "${N_STARTED}" -lt 1 ] || [ "${N_FINISHED}" -lt 1 ]; then
  echo "[verify] FAIL: per-run JSON missing RUN_STARTED (${N_STARTED}) / RUN_FINISHED (${N_FINISHED})"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
if [ "${N_RESOURCE}" -lt 1 ]; then
  echo "[verify] FAIL: per-run JSON has no RESOURCE_* event for the topic/parameter"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
# Assert a RESOURCE_* event actually names one of our two resource types.
if ! echo "${RUN_EVENTS_JSON}" | jq -e \
  '[.[] | select(.resourceType == "AWS::SNS::Topic" or .resourceType == "AWS::SSM::Parameter")] | length >= 1' >/dev/null; then
  echo "[verify] FAIL: per-run JSON has no RESOURCE_* event for AWS::SNS::Topic / AWS::SSM::Parameter"
  echo "${RUN_EVENTS_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 4b ok: RUN_STARTED=${N_STARTED} RUN_FINISHED=${N_FINISHED} RESOURCE_*=${N_RESOURCE}"

echo "[verify] step 4c: assert NO resource properties / secret values in events output (#808 no-secrets)"
# The SSM parameter's value is the secret marker. Events carry error +
# metadata ONLY — properties live in state.json, never here. Check BOTH the
# run-listing JSON and the per-run event stream.
if echo "${EVENTS_JSON}" | grep -F -q "${SECRET_MARKER}"; then
  echo "[verify] FAIL: secret marker '${SECRET_MARKER}' leaked into the run-listing events JSON (#808 no-secrets regression)"
  exit 1
fi
if echo "${RUN_EVENTS_JSON}" | grep -F -q "${SECRET_MARKER}"; then
  echo "[verify] FAIL: secret marker '${SECRET_MARKER}' leaked into the per-run events JSON (#808 no-secrets regression)"
  exit 1
fi
echo "[verify] step 4c ok: no secret values present in events output"

echo "[verify] step 5: cdkd destroy ${STACK} --force"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 6: assert state.json gone but events sidecar still readable + a destroy run appended"
assert_gone "state.json still present after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
echo "[verify]   ok: SSM parameter ${SSM_PARAM_NAME} is gone"
# Explicitly assert the named SNS topic is NOT-FOUND in AWS too — state-empty
# alone would miss an orphaned topic that carries no stack name. SNS has no
# "get one topic by name" call, so resolve the deterministic ARN and confirm
# get-topic-attributes fails (NotFound). The topic name is `${STACK}-topic`.
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)"
if [ -z "${ACCOUNT_ID}" ] || [ "${ACCOUNT_ID}" = "None" ]; then
  echo "[verify] FAIL: could not resolve account id to build the SNS topic ARN for the not-found assertion"
  exit 1
fi
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"
assert_gone "SNS topic ${TOPIC_ARN} still exists after destroy (orphan)" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "[verify]   ok: SNS topic ${TOPIC_NAME} is gone"
# Events deliberately survive destroy — the deployments/ sidecar must still
# exist and now also carry the destroy run's own {runId}.jsonl.
POST_KEYS="$(aws s3 ls "s3://${STATE_BUCKET}/${DEPLOYMENTS_PREFIX}" 2>&1 || true)"
echo "${POST_KEYS}" | sed 's/^/  /'
N_JSONL="$(echo "${POST_KEYS}" | grep -E -c '[A-Za-z0-9-]+\.jsonl$' || true)"
if [ "${N_JSONL}" -lt 2 ]; then
  echo "[verify] FAIL: expected >=2 {runId}.jsonl (deploy + destroy) after destroy, found ${N_JSONL}"
  exit 1
fi
# `cdkd events` must now list BOTH a deploy and a destroy run.
EVENTS_AFTER_JSON="$(${CLI} events "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --format json 2>&1)"
HAS_DEPLOY="$(echo "${EVENTS_AFTER_JSON}" | jq '[.runs[] | select(.command == "deploy")] | length')"
HAS_DESTROY="$(echo "${EVENTS_AFTER_JSON}" | jq '[.runs[] | select(.command == "destroy")] | length')"
if [ "${HAS_DEPLOY}" -lt 1 ] || [ "${HAS_DESTROY}" -lt 1 ]; then
  echo "[verify] FAIL: post-destroy listing missing a deploy (${HAS_DEPLOY}) or destroy (${HAS_DESTROY}) run"
  echo "${EVENTS_AFTER_JSON}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 6 ok: state gone, events survive destroy, listing shows deploy + destroy runs"

echo "[verify] step 7: cleanup — remove the events sidecar so the integ leaves nothing behind"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
# Confirm gone.
REMAINING="$(aws s3 ls "s3://${STATE_BUCKET}/cdkd/${STACK}/" 2>&1 || true)"
if echo "${REMAINING}" | grep -E -q '\.(jsonl|json)$'; then
  echo "[verify] FAIL: events sidecar not fully removed:"
  echo "${REMAINING}" | sed 's/^/  /'
  exit 1
fi
echo "[verify] step 7 ok: events sidecar removed"

trap - EXIT INT TERM
echo "[verify] PASS"
