#!/usr/bin/env bash
# verify.sh — cdkd EventBridge Pipes (SQS->SNS, CC-API) integ.
# Asserts the pipe reaches AWS (RUNNING) with the SQS source, then destroys
# clean. Confirmed-clean /hunt-bugs pattern; regression guard.

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

STACK="CdkdEventbridgePipesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PIPE="${STACK}-pipe"
SRC="${STACK}-src"
TGT="${STACK}-tgt"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  aws pipes delete-pipe --name "${PIPE}" --region "${REGION}" >/dev/null 2>&1 || true
  Q=$(aws sqs get-queue-url --queue-name "${SRC}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${Q}" ] && [ "${Q}" != "None" ] && aws sqs delete-queue --queue-url "${Q}" --region "${REGION}" >/dev/null 2>&1 || true
  TARN=$(aws sns list-topics --region "${REGION}" --query "Topics[?ends_with(TopicArn, ':${TGT}')].TopicArn | [0]" --output text 2>/dev/null)
  [ -n "${TARN}" ] && [ "${TARN}" != "None" ] && aws sns delete-topic --topic-arn "${TARN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

echo "==> Deploy (base: BatchSize 1)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_SOURCE_SWITCH node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Pipe creation settles async (CREATING -> RUNNING). Accept RUNNING or CREATING
# as proof it reached AWS; assert the SQS source arn was wired.
STATE=""; SRCARN=""
for _ in $(seq 1 24); do
  STATE=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'CurrentState' --output text 2>/dev/null || echo "")
  SRCARN=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'Source' --output text 2>/dev/null || echo "")
  if [ "${STATE}" = "RUNNING" ]; then break; fi
  sleep 5
done
if [ "${STATE}" != "RUNNING" ] && [ "${STATE}" != "CREATING" ]; then
  echo "FAIL: pipe ${PIPE} CurrentState is '${STATE}', expected RUNNING/CREATING" >&2
  exit 1
fi
case "${SRCARN}" in
  *":${SRC}") : ;;
  *) echo "FAIL: pipe Source is '${SRCARN}', expected to end with ':${SRC}'" >&2; exit 1 ;;
esac
echo "    OK: pipe reached AWS (CurrentState=${STATE}, Source=${SRCARN})"

echo "==> UPDATE (BatchSize 1 -> 2) — must be IN-PLACE, not a replacement (issue #960)"
UPDATE_LOG="$(mktemp)"
env -u CDKD_TEST_SOURCE_SWITCH CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  | tee "${UPDATE_LOG}"
if grep -q "Replacing Pipe" "${UPDATE_LOG}"; then
  echo "FAIL: BatchSize change was classified as a REPLACEMENT (issue #960 regression)" >&2
  exit 1
fi
BS=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" \
  --query 'SourceParameters.SqsQueueParameters.BatchSize' --output text 2>/dev/null || true)
[ "${BS}" = "2" ] || { echo "FAIL: BatchSize after update is '${BS}', expected 2" >&2; exit 1; }
echo "    OK: in-place UPDATE reached AWS (BatchSize=${BS})"

echo "==> Named-replacement collision (Source switch on the named pipe) — must FAIL without --replace"
COLLIDE_LOG="$(mktemp)"
set +e
env CDKD_TEST_UPDATE=true CDKD_TEST_SOURCE_SWITCH=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${COLLIDE_LOG}" 2>&1
COLLIDE_RC=$?
set -e
[ "${COLLIDE_RC}" -ne 0 ] || { echo "FAIL: same-name replacement deploy unexpectedly succeeded without --replace" >&2; exit 1; }
grep -q "custom-named resource requires replacing" "${COLLIDE_LOG}" \
  || { echo "FAIL: collision error is not the actionable NAMED_REPLACEMENT_COLLISION message" >&2; tail -20 "${COLLIDE_LOG}" >&2; exit 1; }
SRCARN=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'Source' --output text 2>/dev/null || echo "")
case "${SRCARN}" in
  *":${SRC}") : ;;
  *) echo "FAIL: pipe Source changed despite the refused replacement ('${SRCARN}')" >&2; exit 1 ;;
esac
echo "    OK: refused with the actionable message; AWS unchanged (Source still ${SRC})"

echo "==> Same-name replacement WITH --replace (delete-first fallback)"
env CDKD_TEST_UPDATE=true CDKD_TEST_SOURCE_SWITCH=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --replace
SRCARN=$(aws pipes describe-pipe --name "${PIPE}" --region "${REGION}" --query 'Source' --output text 2>/dev/null || echo "")
case "${SRCARN}" in
  *":${SRC}2") : ;;
  *) echo "FAIL: pipe Source after --replace is '${SRCARN}', expected to end with ':${SRC}2'" >&2; exit 1 ;;
esac
echo "    OK: delete-first replacement succeeded under the SAME pipe name (Source=${SRCARN})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# Pipe delete is async (DELETING -> gone).
PGONE=""
for _ in $(seq 1 24); do
  if gone_probe aws pipes describe-pipe --name "${PIPE}" --region "${REGION}"; then PGONE=1; break; fi
  sleep 5
done
[ -z "${PGONE}" ] && { echo "FAIL: pipe ${PIPE} still exists after destroy" >&2; exit 1; }
echo "    OK: pipe gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> eventbridge-pipes test passed"
