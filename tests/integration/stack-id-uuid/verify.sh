#!/usr/bin/env bash
# verify.sh — cdkd AWS::StackId per-stack UUID tail (go-to-k/cdkd#6170).
#
# Two stacks name an SSM parameter and an SNS topic from AWS::StackId with the
# common CDK unique-suffix idiom (Fn.select(2, Fn.split('/', STACK_ID)), then
# its first / last `-` group). Asserts:
#   1. both deploy (before the fix the last-group form failed every create with
#      an `{{Fn::Select:4:OutOfBounds}}` name), each record is schema v16 with
#      `stackIdFromInstance`, and each AWS::StackId ends in a UUID -- not
#      `/cdkd` -- that differs between the two stacks;
#   2. the parameter and topic exist on AWS under those per-stack names;
#   3. an UPDATE of the parameter's value keeps every physical id and the
#      stack id (no replacement), and lands on AWS;
#   4. a no-op `cdkd diff --fail` exits 0 after it;
#   5. destroy removes everything, state included.

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

STACKS=(CdkdStackIdUuidA CdkdStackIdUuidB)
REGION="${AWS_REGION:-us-east-1}"
PARAM_PATH="/cdkd-stack-id-uuid/"
TOPIC_PREFIX="cdkd-stack-id-uuid-"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
UUID_RE='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

state_key() { printf 'cdkd/%s/%s/state.json' "$1" "${REGION}"; }

# Sweep what the stacks name, by the fixture's own literal prefixes. Each
# guard refuses an empty or foreign scope before anything is deleted.
sweep() { (
  set +eu
  case "${PARAM_PATH}" in
    /cdkd-stack-id-uuid/?*|/cdkd-stack-id-uuid/) ;;
    *) echo "teardown sweep refused: parameter path '${PARAM_PATH}'" >&2; exit 0 ;;
  esac
  for name in $(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --region "${REGION}" \
      --query 'Parameters[].Name' --output text 2>/dev/null); do
    aws ssm delete-parameter --name "${name}" --region "${REGION}" >/dev/null 2>&1
  done
  case "${TOPIC_PREFIX}" in
    cdkd-stack-id-uuid-?*|cdkd-stack-id-uuid-) ;;
    *) echo "teardown sweep refused: topic prefix '${TOPIC_PREFIX}'" >&2; exit 0 ;;
  esac
  for arn in $(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text 2>/dev/null); do
    case "${arn##*:}" in
      "${TOPIC_PREFIX}"?*) aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done
) }

cleanup() {
  echo "==> Cleanup"
  set +eu
  for s in "${STACKS[@]}"; do
    [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/$(state_key "${s}")" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/lock.json" >/dev/null 2>&1
    fi
  done
  sweep
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

read_state() { aws s3 cp "s3://${STATE_BUCKET}/$(state_key "$1")" - --region "${REGION}"; }

# The stack id's tail, after checking the record carries the v16 marker.
stack_tail() {
  local s="$1" state version marker stack_id tail
  state="$(read_state "${s}")" || return 1
  version="$(jq -r '.version' <<<"${state}")" || return 1
  marker="$(jq -r '.stackIdFromInstance // "absent"' <<<"${state}")" || return 1
  stack_id="$(jq -r '.outputs.StackIdOut // ""' <<<"${state}")" || return 1
  [ "${version}" = "16" ] || { echo "FAIL: ${s} state version is ${version}, expected 16" >&2; return 1; }
  [ "${marker}" = "true" ] || { echo "FAIL: ${s} state stackIdFromInstance is ${marker}, expected true" >&2; return 1; }
  case "${stack_id}" in
    arn:*:cloudformation:"${REGION}":*:stack/"${s}"/*) ;;
    *) echo "FAIL: ${s} StackIdOut '${stack_id}' is not a stack id ARN for ${s}" >&2; return 1 ;;
  esac
  tail="${stack_id##*/}"
  grep -qE "${UUID_RE}" <<<"${tail}" || { echo "FAIL: ${s} stack id tail '${tail}' is not a UUID (the pre-#6170 tail was 'cdkd')" >&2; return 1; }
  printf '%s' "${tail}"
}

physical_ids() { read_state "$1" | jq -cS '[.resources | to_entries[] | {(.key): .value.physicalId}] | add'; }

echo "==> 1. Deploy both stacks"
node "${LOCAL_DIST}" deploy "${STACKS[@]}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

TAIL_A="$(stack_tail CdkdStackIdUuidA)"
TAIL_B="$(stack_tail CdkdStackIdUuidB)"
[ "${TAIL_A}" != "${TAIL_B}" ] || { echo "FAIL: both stacks resolved the same AWS::StackId tail ${TAIL_A}" >&2; exit 1; }
echo "    OK: both records are v16 with stackIdFromInstance, and each stack id ends in its own UUID"

echo "==> 2. Per-stack names on AWS"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
for t in "${TAIL_A}" "${TAIL_B}"; do
  value="$(aws ssm get-parameter --name "${PARAM_PATH}${t##*-}" --region "${REGION}" --query 'Parameter.Value' --output text)"
  [ "${value}" = "one" ] || { echo "FAIL: parameter ${PARAM_PATH}${t##*-} is '${value}', expected 'one'" >&2; exit 1; }
  aws sns get-topic-attributes --region "${REGION}" \
    --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT}:${TOPIC_PREFIX}${t%%-*}" >/dev/null
done
echo "    OK: each stack's parameter and topic exist under its own suffix"

IDS_A="$(physical_ids CdkdStackIdUuidA)"
IDS_B="$(physical_ids CdkdStackIdUuidB)"

echo "==> 3. UPDATE (parameter value only)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACKS[@]}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(stack_tail CdkdStackIdUuidA)" = "${TAIL_A}" ] || { echo "FAIL: CdkdStackIdUuidA stack id changed on update" >&2; exit 1; }
[ "$(stack_tail CdkdStackIdUuidB)" = "${TAIL_B}" ] || { echo "FAIL: CdkdStackIdUuidB stack id changed on update" >&2; exit 1; }
[ "$(physical_ids CdkdStackIdUuidA)" = "${IDS_A}" ] || { echo "FAIL: CdkdStackIdUuidA physical ids changed (replacement): ${IDS_A} -> $(physical_ids CdkdStackIdUuidA)" >&2; exit 1; }
[ "$(physical_ids CdkdStackIdUuidB)" = "${IDS_B}" ] || { echo "FAIL: CdkdStackIdUuidB physical ids changed (replacement)" >&2; exit 1; }
for t in "${TAIL_A}" "${TAIL_B}"; do
  value="$(aws ssm get-parameter --name "${PARAM_PATH}${t##*-}" --region "${REGION}" --query 'Parameter.Value' --output text)"
  [ "${value}" = "two" ] || { echo "FAIL: parameter ${PARAM_PATH}${t##*-} is '${value}' after update, expected 'two'" >&2; exit 1; }
done
echo "    OK: value updated in place, stack ids and physical ids unchanged"

echo "==> 4. No-op diff"
for s in "${STACKS[@]}"; do
  rc=0
  CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${s}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail >/dev/null 2>&1 || rc=$?
  [ "${rc}" = "0" ] || { echo "FAIL: cdkd diff --fail on ${s} exited ${rc} after the update (expected 0, no changes)" >&2; exit 1; }
done
echo "    OK: diff resolves the same AWS::StackId the deploy wrote"

echo "==> 5. Destroy"
node "${LOCAL_DIST}" destroy "${STACKS[@]}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for s in "${STACKS[@]}"; do
  assert_gone "${s} state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${s}")"
done
for t in "${TAIL_A}" "${TAIL_B}"; do
  assert_gone "parameter ${PARAM_PATH}${t##*-} remains" aws ssm get-parameter --name "${PARAM_PATH}${t##*-}" --region "${REGION}"
done
LEFT="$(aws sns list-topics --region "${REGION}" --query "Topics[?contains(TopicArn, ':${TOPIC_PREFIX}')].TopicArn" --output text)"
[ -z "${LEFT}" ] || { echo "FAIL: topics remain: ${LEFT}" >&2; exit 1; }
echo "    OK: parameters, topics and state gone"

trap - EXIT INT TERM
echo ""
echo "==> stack-id-uuid test passed"
