#!/usr/bin/env bash
# verify.sh — the update-failure fallback's same-id re-create brings back the
# children stored inside the resource (issue #4444).
#
# Phases: deploy a fixed-name log group (STANDARD) with a log stream ->
# THE ARM: change only its class, which CloudWatch Logs cannot do in place, so
# the provider refuses the update and `--replace` deletes and re-creates the
# log group under the same name -> premises: the stream diffed NO_CHANGE, the
# log group's creationTime moved and its class is the new one -> the log
# stream is back in the re-created log group and recorded -> destroy.
#
# Before the fix the stream was never dispatched (the diff did not foresee the
# re-create), so it stayed gone while state recorded it.

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

STACK="CdkdFallbackRecreateChildrenExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOG_GROUP="/cdkd-integ/${STACK}/parent"
STREAM_NAME="child-stream"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

state_json() {
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}"
}

# The number of log streams named STREAM_NAME in the log group; a strict
# capture, so a probe failure aborts rather than reading as 0.
streams() {
  aws logs describe-log-streams --log-group-name "${LOG_GROUP}" --log-stream-name-prefix "${STREAM_NAME}" \
    --region "${REGION}" --query "length(logStreams[?logStreamName=='${STREAM_NAME}'])" --output text
}

# The log group's creation time, a witness that it was re-created.
created() {
  aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${REGION}" \
    --query "logGroups[?logGroupName=='${LOG_GROUP}'].creationTime | [0]" --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Phase 1: Deploy (STANDARD class)"
env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
F0=$(streams)
[ "${F0}" = "1" ] || { echo "FAIL: phase 1: ${F0} log stream(s) named ${STREAM_NAME} in ${LOG_GROUP}, expected 1" >&2; exit 1; }
C0=$(created)
[ -n "${C0}" ] && [ "${C0}" != "None" ] || { echo "FAIL: no creationTime for ${LOG_GROUP}" >&2; exit 1; }
STREAM_KEY=$(state_json | jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::Logs::LogStream") | .key' | head -1)
[ -n "${STREAM_KEY}" ] || { echo "FAIL: no AWS::Logs::LogStream record after phase 1" >&2; exit 1; }
echo "    OK: log group ${LOG_GROUP} with its log stream"

echo "==> Phase 2: THE ARM -- change the class; the update-failure fallback re-creates the log group"
# PREMISE: only the class moves, so the stream diffs NO_CHANGE and only the
# fallback's re-create can take it away. `cdkd diff` exits 0 on changes without
# --fail, so a non-zero exit is a failed run; and the plan must name the log
# group, or the negative check below would pass on an empty diff.
PLAN=$(env CDKD_TEST_PHASE=reclass node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1) || {
  printf '%s\n' "${PLAN}" >&2
  echo "FAIL: premise: cdkd diff failed" >&2
  exit 1
}
grep -q "ParentLogGroup" <<<"${PLAN}" || {
  printf '%s\n' "${PLAN}" >&2
  echo "FAIL: premise: the diff does not list ParentLogGroup; the class change is not in the plan" >&2
  exit 1
}
grep -q "${STREAM_KEY}" <<<"${PLAN}" && {
  printf '%s\n' "${PLAN}" >&2
  echo "FAIL: premise: the diff lists ${STREAM_KEY}; it must be NO_CHANGE so only the fallback can lose it" >&2
  exit 1
}
OUT=$(env CDKD_TEST_PHASE=reclass node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace --force-stateful-recreation --yes 2>&1) || {
  printf '%s\n' "${OUT}" >&2
  echo "FAIL: the reclass deploy failed" >&2
  exit 1
}
printf '%s\n' "${OUT}"
# PREMISE: the log group really was deleted and re-created (its class cannot
# change in place).
C1=$(created)
[ -n "${C1}" ] && [ "${C1}" != "None" ] && [ "${C1}" != "${C0}" ] || { echo "FAIL: premise: the log group was not re-created (creationTime ${C0} -> ${C1:-<none>})" >&2; exit 1; }
CLASS=$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${REGION}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP}'].logGroupClass | [0]" --output text)
[ "${CLASS}" = "INFREQUENT_ACCESS" ] || { echo "FAIL: premise: the re-created log group has class ${CLASS}" >&2; exit 1; }
F1=$(streams)
[ "${F1}" = "1" ] || { echo "FAIL: the re-created log group holds ${F1} log stream(s) named ${STREAM_NAME}, expected 1 -- the stream that went with the old log group was not re-created (issue #4444)" >&2; exit 1; }
HELD=$(state_json | jq -r --arg k "${STREAM_KEY}" '.resources | has($k)')
[ "${HELD}" = "true" ] || { echo "FAIL: state no longer records ${STREAM_KEY}" >&2; exit 1; }
echo "    OK: log group re-created under the new class; its log stream is back"

echo "==> Phase 3: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
LEFT=$(aws logs describe-log-groups --log-group-name-prefix "${LOG_GROUP}" --region "${REGION}" \
  --query "length(logGroups[?logGroupName=='${LOG_GROUP}'])" --output text)
[ "${LEFT}" = "0" ] || { echo "FAIL: log group ${LOG_GROUP} survived destroy" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — fallback-recreate-children (a fallback re-create's log stream comes back)"
