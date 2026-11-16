#!/usr/bin/env bash
# verify.sh — cdkd deploy names a missing SSM-typed template parameter (#6380).
#
# `ssm.StringParameter.valueForStringParameter` synthesizes an
# `AWS::SSM::Parameter::Value<String>` parameter defaulting to a Parameter
# Store path. SSM answers GetParameter on an absent path with a message-less
# `ParameterNotFound`, which the deploy relayed raw as
# `Failed: stack:<stack>: UnknownError` without naming the path.
#
# Phases:
#   1. With the path absent, deploy fails, naming the path, the template
#      parameter and the region; nothing is created and no state is written.
#   2. Create the path: the deploy succeeds and the topic's display name is
#      the parameter's value.
#   3. Destroy + assert the topic and the state are gone.
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

STACK="CdkdSsmTypedParameterNotFoundExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Must match PARAMETER_PATH in lib/ssm-typed-parameter-not-found-stack.ts.
PARAM_PATH="/cdkd-integ-6380/topic-display-name"
PARAM_VALUE="cdkd-6380-display-name"
DEPLOY_LOG=""

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The topic's generated name starts with the stack name; read the live list.
# A failed list returns non-zero, so it never reads as "no topic".
topics_of_stack() {
  local out
  out="$(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text)" || return 1
  tr '\t' '\n' <<<"${out}" | grep ":${STACK}-" || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  case "${STACK}" in
    CdkdSsmTypedParameterNotFound?*)
      for t in $(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text 2>/dev/null | tr '\t' '\n' | grep ":${STACK}-"); do
        aws sns delete-topic --topic-arn "${t}" --region "${REGION}" >/dev/null 2>&1 || true
      done
      ;;
    *) echo "    WARN: teardown sweep refused a stack scope outside CdkdSsmTypedParameterNotFound*: '${STACK:-<empty>}'" >&2 ;;
  esac
  aws ssm delete-parameter --name "${PARAM_PATH}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  if [ -n "${DEPLOY_LOG:-}" ]; then
    rm -f "${DEPLOY_LOG}"
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
assert_gone "premise: ${PARAM_PATH} still exists before the run" aws ssm get-parameter --name "${PARAM_PATH}" --region "${REGION}"

# --- Phase 1: the path is absent ---------------------------------------
echo "==> Phase 1: deploy with ${PARAM_PATH} absent (must fail, naming it)"
DEPLOY_LOG="$(mktemp)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DEPLOY_LOG}" 2>&1
RC=$?
set -e
cat "${DEPLOY_LOG}"
if [ "${RC}" -eq 0 ]; then
  echo "FAIL: the deploy succeeded with ${PARAM_PATH} absent" >&2
  exit 1
fi
# Sentinel: a failure line exists at all, so a reworded message reads as a
# FAIL below rather than as "the condition did not occur".
if ! grep -q "Failed: stack:${STACK}:" "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy failed without cdkd's 'Failed: stack:${STACK}:' line" >&2
  exit 1
fi
if ! grep -qF "SSM parameter ${PARAM_PATH} (the value of template parameter " "${DEPLOY_LOG}"; then
  echo "FAIL: the failure does not name ${PARAM_PATH} and its template parameter (#6380)" >&2
  exit 1
fi
if ! grep -qF "was not found in region ${REGION}." "${DEPLOY_LOG}"; then
  echo "FAIL: the failure does not name the region ${REGION} (#6380)" >&2
  exit 1
fi
if grep -q 'UnknownError' "${DEPLOY_LOG}"; then
  echo "FAIL: the failure still prints the SDK's UnknownError placeholder (#6380)" >&2
  exit 1
fi
echo "    OK: the failure names ${PARAM_PATH}, its template parameter and ${REGION}"
assert_gone "a state file was written by the failed deploy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
TOPICS="$(topics_of_stack)" || { echo "FAIL: sns list-topics failed; cannot tell whether a topic was created" >&2; exit 1; }
if [ -n "${TOPICS}" ]; then
  echo "FAIL: the failed deploy created a topic: ${TOPICS}" >&2
  exit 1
fi
echo "    OK: nothing was created and no state was written"

# --- Phase 2: the path exists ------------------------------------------
echo "==> Phase 2: create ${PARAM_PATH} and deploy"
aws ssm put-parameter --name "${PARAM_PATH}" --value "${PARAM_VALUE}" --type String \
  --region "${REGION}" >/dev/null
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
TOPIC_ARN="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.outputs.TopicArn // empty')"
if [ -z "${TOPIC_ARN}" ]; then
  echo "FAIL: no TopicArn output recorded after the deploy" >&2
  exit 1
fi
DISPLAY_NAME="$(aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text)"
if [ "${DISPLAY_NAME}" != "${PARAM_VALUE}" ]; then
  echo "FAIL: the topic's DisplayName is '${DISPLAY_NAME}', not the parameter's value '${PARAM_VALUE}'" >&2
  exit 1
fi
echo "    OK: the topic's DisplayName is ${PARAM_VALUE}"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "topic ${TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: topic is gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: cdkd state removed"

aws ssm delete-parameter --name "${PARAM_PATH}" --region "${REGION}" >/dev/null
assert_gone "${PARAM_PATH} still exists after the run" aws ssm get-parameter --name "${PARAM_PATH}" --region "${REGION}"
echo "    OK: ${PARAM_PATH} deleted"

echo "[verify] PASS — a missing SSM-typed template parameter fails the deploy naming its path, template parameter and region, and deploys once the path exists (#6380), all phases passed"
