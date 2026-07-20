#!/usr/bin/env bash
# verify.sh — cdkd Lambda SQS ESM ScalingConfig.MaximumConcurrency integ.
# Base phase: asserts maxConcurrency + FilterCriteria reach AWS.
# UPDATE phase (issue #976): removes FilterCriteria + ScalingConfig from the
# template and asserts AWS actually CLEARS both (removal-on-UPDATE, not a
# silent drop). Then destroys clean.

set -euo pipefail

# --- issue #1097 pattern 2: strict gone-probe helpers -----------------------
# A destroy/leak assertion must distinguish "not found" from any other probe
# failure (throttle, auth, network); a blind `if aws ...; then` reads ANY
# failure as "gone" and silently passes the leak check.
# gone_probe returns 0 when the probe fails with a not-found error (resource
# confirmed gone), 1 when the probe succeeds (resource still exists), and
# hard-FAILs the run on any other probe failure (undetermined result).
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdSqsEsmMaxConcurrencyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
QUEUE="${STACK}-queue"
EXPECTED_MAXCONC=5
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
  Q=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)
  [ -n "${Q}" ] && [ "${Q}" != "None" ] && aws sqs delete-queue --queue-url "${Q}" --region "${REGION}" >/dev/null 2>&1 || true
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

# Reads the ESM's ScalingConfig.MaximumConcurrency (or "None" when unset).
esm_maxconc() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query 'EventSourceMappings[0].ScalingConfig.MaximumConcurrency' --output text 2>/dev/null
}
# Reads the ESM's FilterCriteria.Filters count (0 when cleared / unset). The
# `|| ` + backtick-empty-array coalesces a null Filters (the cleared state) to
# `[]` INSIDE JMESPath, so `length()` never receives null — otherwise the AWS
# CLI errors ("invalid type for value: None") with a non-zero exit, and under
# this script's `set -e` a bare `length(... .Filters)` would abort the whole
# run at the `$( )` assignment the instant the filter is (correctly) cleared.
esm_filter_count() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query 'length(EventSourceMappings[0].FilterCriteria.Filters || `[]`)' --output text 2>/dev/null
}

echo "==> Deploy (base: FilterCriteria + ScalingConfig set)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

MAXCONC=$(esm_maxconc)
if [ "${MAXCONC}" != "${EXPECTED_MAXCONC}" ]; then
  echo "FAIL: base ScalingConfig.MaximumConcurrency is '${MAXCONC}', expected '${EXPECTED_MAXCONC}' (silent-drop?)" >&2
  exit 1
fi
echo "    OK: base ScalingConfig.MaximumConcurrency == ${EXPECTED_MAXCONC} on AWS"

FILTERS=$(esm_filter_count)
if [ "${FILTERS}" == "None" ] || [ "${FILTERS}" == "0" ] || [ -z "${FILTERS}" ]; then
  echo "FAIL: base FilterCriteria has no filters ('${FILTERS}'), expected >= 1 (silent-drop?)" >&2
  exit 1
fi
echo "    OK: base FilterCriteria has ${FILTERS} filter(s) on AWS"

echo "==> Deploy (UPDATE: FilterCriteria + ScalingConfig removed from template)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# Removal must CLEAR the cap on AWS — ScalingConfig.MaximumConcurrency gone.
MAXCONC_AFTER=$(esm_maxconc)
if [ "${MAXCONC_AFTER}" != "None" ] && [ -n "${MAXCONC_AFTER}" ]; then
  echo "FAIL: after removal, ScalingConfig.MaximumConcurrency is still '${MAXCONC_AFTER}', expected cleared (None) — removal silently dropped (issue #976)" >&2
  exit 1
fi
echo "    OK: ScalingConfig.MaximumConcurrency CLEARED on AWS after removal"

# Removal must CLEAR the filter on AWS — no Filters remain.
FILTERS_AFTER=$(esm_filter_count)
if [ "${FILTERS_AFTER}" != "None" ] && [ "${FILTERS_AFTER}" != "0" ] && [ -n "${FILTERS_AFTER}" ]; then
  echo "FAIL: after removal, FilterCriteria still has '${FILTERS_AFTER}' filter(s), expected cleared — removal silently dropped (issue #976)" >&2
  exit 1
fi
echo "    OK: FilterCriteria CLEARED on AWS after removal"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
echo ""
echo "==> sqs-esm-max-concurrency test passed"
