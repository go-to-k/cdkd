#!/usr/bin/env bash
# verify.sh — cdkd Lambda Kinesis ESM FilterCriteria integ.
# Asserts the ESM FilterCriteria reaches AWS, then destroys clean.
# Confirmed-clean /hunt-bugs pattern; regression guard.

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

STACK="CdkdKinesisEsmFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
STREAM="${STACK}-stream"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws kinesis delete-stream --stream-name "${STREAM}" --region "${REGION}" --enforce-consumer-deletion >/dev/null 2>&1 || true
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

echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# FilterCriteria.Filters[0].Pattern must be present AND carry the templated
# filter content (the stack filters on data.type == "order"). Asserting the
# content (not just non-empty) proves the FilterCriteria was not silently
# dropped or replaced with a different/empty pattern.
PATTERN=$(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
  --query 'EventSourceMappings[0].FilterCriteria.Filters[0].Pattern' --output text 2>/dev/null)
if [ -z "${PATTERN}" ] || [ "${PATTERN}" = "None" ]; then
  echo "FAIL: ESM FilterCriteria.Filters[0].Pattern is empty (silent-drop?)" >&2
  exit 1
fi
if ! printf '%s' "${PATTERN}" | grep -q 'order'; then
  echo "FAIL: ESM FilterCriteria pattern does not contain the templated 'order' filter: ${PATTERN}" >&2
  exit 1
fi
echo "    OK: ESM FilterCriteria reached AWS (pattern: ${PATTERN})"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
# Kinesis DeleteStream is async (DELETING -> gone).
SGONE=""
for _ in $(seq 1 18); do
  if gone_probe aws kinesis describe-stream-summary --stream-name "${STREAM}" --region "${REGION}"; then SGONE=1; break; fi
  sleep 5
done
[ -z "${SGONE}" ] && { echo "FAIL: kinesis stream ${STREAM} still exists after destroy" >&2; exit 1; }
echo "    OK: kinesis stream gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> kinesis-esm-filter test passed"
