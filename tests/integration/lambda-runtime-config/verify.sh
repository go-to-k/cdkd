#!/usr/bin/env bash
# verify.sh — cdkd Lambda Function RuntimeConfig integ (issue #6352).
#
# `RuntimeConfig` names a customer-managed runtime and one of its aliases.
# Before the backfill the SDK provider did not wire it, so the function
# auto-routed to Cloud Control. This fixture proves the SDK route delivers it,
# changes it in place, and removes it.
#
# The runtime has no CloudFormation type, so this script builds it out of
# band: an ECR repository Lambda may read, a one-file custom-runtime image
# (runtime-image/), and through runtime.mjs (the CLI has no `lambda-core`) a
# runtime with version v1 and aliases a / b. The CDK app reads its ARN from
# CDKD_IT_RUNTIME_ARN.
#
# Phases:
#   1. Deploy: Runtime custom, alias a. Assert RuntimeConfig on AWS, the
#      function routed through the SDK provider (provisionedBy=sdk), the
#      runtime's bootstrap answering an invoke, and `cdkd drift` clean (the
#      readback emits what the create sent).
#   2. CDKD_TEST_UPDATE=alias: alias b. Assert AWS holds b, still SDK-routed.
#   3. CDKD_TEST_REMOVAL=true: Runtime nodejs22.x, no RuntimeConfig. Assert AWS
#      dropped it and the Node.js handler answers.
#   4. Destroy; assert the function and the state file are gone. Then delete
#      the runtime and the repository, and assert the runtime left ACTIVE.
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
# DeleteFunction is acknowledged before GetFunction stops answering.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout-s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s)" >&2
      exit 1
    fi
    sleep 3
  done
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdLambdaRuntimeConfigExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
REPO="cdkd-it-lambda-runtime-config"
# Runtime deletion is asynchronous (minutes in PENDING_DELETION), so each run
# takes a fresh name under one fixed prefix that cleanup sweeps.
RT_PREFIX="cdkditrtcfg"
RT_NAME="${RT_PREFIX}$(date +%s)"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

fncfg() { # -> {"Runtime":..,"RuntimeConfig":..} of the function
  node runtime.mjs fncfg "${FN}" || return 1
}
invoke_payload() { # -> the function's response body
  local out
  out="$(mktemp)"
  aws lambda invoke --function-name "${FN}" --region "${REGION}" --payload '{}' \
    --cli-binary-format raw-in-base64-out "${out}" >/dev/null || { rm -f "${out}"; return 1; }
  cat "${out}"
  rm -f "${out}"
}
state_provisioned_by() { # $1 = physical id -> that resource's routing layer
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${state}" | node -e "
let s='';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const entry = Object.values(JSON.parse(s).resources ?? {}).find(
    (r) => r?.physicalId === process.argv[1]
  );
  process.stdout.write(entry ? (entry.provisionedBy ?? 'sdk') : 'absent');
});
" "$1"
}
assert_sdk_route() {
  local pb
  pb="$(state_provisioned_by "${FN}")"
  if [ "${pb}" != "sdk" ]; then
    echo "FAIL: ${FN} not provisioned by the SDK provider (provisionedBy='${pb}')" >&2
    exit 1
  fi
}
assert_cfg() { # $1 = expected fncfg JSON
  local got
  got="$(fncfg)"
  if [ "${got}" != "$1" ]; then
    echo "FAIL: function configuration: want ${1}, got '${got}'" >&2
    exit 1
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1
  # The runtime sweep runs once the function is gone, so it never races a
  # function that still names the runtime.
  local i out
  for i in $(seq 1 20); do
    out="$(aws lambda get-function --function-name "${FN}" --region "${REGION}" 2>&1)"
    if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then break; fi
    sleep 3
  done
  if [ -d node_modules ]; then
    node runtime.mjs teardown-prefix "${RT_PREFIX}" >/dev/null \
      || echo "WARN: runtime sweep under ${RT_PREFIX} failed; the next run's pre-run cleanup retries it" >&2
  fi
  aws ecr delete-repository --repository-name "${REPO}" --region "${REGION}" --force >/dev/null 2>&1
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
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Prerequisite: the customer-managed runtime ------------------------------
echo "==> Building the customer-managed runtime ${RT_NAME}"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
REGISTRY="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
aws ecr create-repository --repository-name "${REPO}" --region "${REGION}" >/dev/null
aws ecr set-repository-policy --repository-name "${REPO}" --region "${REGION}" --policy-text \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"LambdaRuntimeRead\",\"Effect\":\"Allow\",\"Principal\":{\"Service\":\"lambda.amazonaws.com\"},\"Action\":[\"ecr:BatchGetImage\",\"ecr:GetDownloadUrlForLayer\"],\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"${ACCOUNT}\"}}}]}" >/dev/null
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${REGISTRY}" >/dev/null
docker buildx build --platform linux/arm64 --provenance=false \
  -t "${REGISTRY}/${REPO}:v1" --push runtime-image
RUNTIME_ARN="$(node runtime.mjs setup "${RT_NAME}" "${REGISTRY}/${REPO}:v1")"
case "${RUNTIME_ARN}" in
  arn:aws:lambda:*:runtime/"${RT_NAME}") ;;
  *) echo "FAIL: runtime setup returned '${RUNTIME_ARN}'" >&2; exit 1 ;;
esac
export CDKD_IT_RUNTIME_ARN="${RUNTIME_ARN}"
echo "    runtime ${RUNTIME_ARN} with aliases a, b"

# --- Phase 1: create with RuntimeConfig --------------------------------------
echo "==> Phase 1: deploy with Runtime custom, RuntimeConfig alias a"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_cfg "{\"Runtime\":\"custom\",\"RuntimeConfig\":{\"RuntimeArn\":\"${RUNTIME_ARN}\",\"RuntimeAlias\":\"a\"}}"
assert_sdk_route
PAYLOAD="$(invoke_payload)"
if [ "${PAYLOAD}" != '{"ok":"cdkd-it-runtime"}' ]; then
  echo "FAIL: the customer-managed runtime did not serve the invoke (got '${PAYLOAD}')" >&2; exit 1
fi
echo "    RuntimeConfig live (alias a), provisionedBy=sdk, runtime served the invoke"

env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    cdkd drift clean"

# --- Phase 2: alias change in place -------------------------------------------
echo "==> Phase 2: re-deploy with RuntimeConfig alias b"
CDKD_TEST_UPDATE=alias node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_cfg "{\"Runtime\":\"custom\",\"RuntimeConfig\":{\"RuntimeArn\":\"${RUNTIME_ARN}\",\"RuntimeAlias\":\"b\"}}"
assert_sdk_route
echo "    RuntimeConfig live (alias b), provisionedBy=sdk"

# --- Phase 3: removal by the Runtime switch ------------------------------------
echo "==> Phase 3: re-deploy with Runtime nodejs22.x and no RuntimeConfig"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_cfg '{"Runtime":"nodejs22.x","RuntimeConfig":null}'
assert_sdk_route
PAYLOAD="$(invoke_payload)"
if [ "${PAYLOAD}" != '{"ok":"nodejs"}' ]; then
  echo "FAIL: the Node.js handler did not serve the invoke after the removal (got '${PAYLOAD}')" >&2; exit 1
fi
echo "    RuntimeConfig removed, Node.js runtime served the invoke"

# --- Phase 4: destroy -----------------------------------------------------------
echo "==> Phase 4: destroy"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone_eventually 60 "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    function and cdkd state removed"

echo "==> Deleting the customer-managed runtime and its repository"
SWEPT="$(node runtime.mjs teardown-prefix "${RT_PREFIX}")"
if [ "${SWEPT}" -lt 1 ]; then
  echo "FAIL: the runtime sweep found nothing to delete (want ${RT_NAME})" >&2; exit 1
fi
RT_STATE="$(node runtime.mjs state "${RT_NAME}")"
case "${RT_STATE}" in
  PENDING_DELETION | GONE) ;;
  *) echo "FAIL: runtime ${RT_NAME} not deleting after teardown (State='${RT_STATE}')" >&2; exit 1 ;;
esac
aws ecr delete-repository --repository-name "${REPO}" --region "${REGION}" --force >/dev/null
assert_gone "ECR repository ${REPO} still exists" aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}"
echo "    runtime ${RT_STATE}, repository deleted"

# Both invokes created the function's log group, which destroy does not own.
aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}"
LEFT_LG="$(aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${FN}" \
  --region "${REGION}" --query 'logGroups[].logGroupName' --output text)"
if [ -n "${LEFT_LG}" ]; then
  echo "FAIL: log group(s) left after teardown: ${LEFT_LG}" >&2; exit 1
fi

trap - EXIT INT TERM
echo "[verify] PASS — Lambda Function RuntimeConfig (issue #6352), all 4 phases passed"
