#!/usr/bin/env bash
# verify.sh — cdkd DynamoDB TTL AttributeName-change actionable-error integ.
#
# Asserts that cdkd's DynamoDBTableProvider.update guard rejects an impossible
# TTL AttributeName change (ttlA -> ttlB) in a single deploy with a clear,
# actionable error BEFORE issuing the doomed UpdateTimeToLive call — instead of
# letting the opaque raw AWS error ("TimeToLive is active on a different
# AttributeName") bubble up.
#
# Phase 1   deploy with TTL enabled on `ttlA`              -> succeeds; AWS
#           DescribeTimeToLive shows AttributeName=ttlA, ENABLED/ENABLING.
# Phase 2   re-deploy (CDKD_TEST_UPDATE=true) requesting   -> MUST FAIL with the
#           TTL on `ttlB` AND StreamViewType                   actionable message;
#           NEW_IMAGE -> NEW_AND_OLD_IMAGES                    AWS TTL must still be
#           on `ttlA` (guard fired before any API call), and (issue #6560) the
#           table's LatestStreamArn unchanged, nothing for the rollback to
#           revert, and the stream's Lambda event source mapping still Enabled
#           on that same stream ARN.
# Phase 2c  re-deploy (CDKD_TEST_TTL=disable) declaring    -> MUST SUCCEED with
#           TimeToLiveSpecification {Enabled:false} with       TTL DISABLED/DISABLING
#           no AttributeName, minutes after the Phase 1         on ttlA (#5447), after
#           enable                                              waiting out DynamoDB's
#           TTL rate-limit interval like CloudFormation (#5451); the wait must
#           be announced. RUNTIME: this phase alone takes about 30 minutes.
# Phase 3   destroy                                        -> table + state gone.
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

STACK="CdkdDynamodbTtlAttrChangeExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TABLE_NAME="cdkd-ttl-attr-change-test"
FUNCTION_NAME="cdkd-ttl-attr-change-stream-consumer"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DEPLOY_OUT:-}" "${DISABLE_OUT:-}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FUNCTION_NAME}" --region "${REGION}" \
    --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FUNCTION_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
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

# Poll DescribeTimeToLive until the status settles, then echo the AttributeName.
ttl_attribute() {
  aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'TimeToLiveDescription.AttributeName' --output text
}
ttl_status() {
  aws dynamodb describe-time-to-live --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text
}

# --- Phase 1: deploy TTL on ttlA --------------------------------------
echo "==> Phase 1: deploy (TTL enabled on ttlA)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if ! aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# TTL enable is async; wait for it to land on ttlA.
TTL_OK=""
for _ in $(seq 1 24); do
  ST=$(ttl_status); ATTR=$(ttl_attribute)
  if { [ "${ST}" = "ENABLED" ] || [ "${ST}" = "ENABLING" ]; } && [ "${ATTR}" = "ttlA" ]; then
    TTL_OK=1
    break
  fi
  sleep 5
done
if [ -z "${TTL_OK}" ]; then
  echo "FAIL: TTL did not settle to AttributeName=ttlA (status=$(ttl_status) attr=$(ttl_attribute)) after deploy" >&2
  exit 1
fi
echo "    OK: TTL enabled on ttlA ($(ttl_status))"

# The stream and its event source mapping (issue #6560), recorded before the
# refused deploy. The mapping is polled to Enabled first, so a later
# non-Enabled state is the refused deploy's doing.
latest_stream_arn() {
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'Table.LatestStreamArn' --output text
}
mapping_field() { # usage: mapping_field <EventSourceArn|State>
  aws lambda list-event-source-mappings --function-name "${FUNCTION_NAME}" --region "${REGION}" \
    --query "EventSourceMappings[0].$1" --output text
}
MAPPING_COUNT=$(aws lambda list-event-source-mappings --function-name "${FUNCTION_NAME}" --region "${REGION}" \
  --query 'length(EventSourceMappings)' --output text)
if [ "${MAPPING_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 event source mapping on ${FUNCTION_NAME}, found ${MAPPING_COUNT}" >&2
  exit 1
fi
STREAM_BEFORE=$(latest_stream_arn)
case "${STREAM_BEFORE}" in
  arn:aws:dynamodb:*/stream/*) ;;
  *) echo "FAIL: table ${TABLE_NAME} has no LatestStreamArn after Phase 1 (got '${STREAM_BEFORE}')" >&2; exit 1 ;;
esac
MAPPING_OK=""
for _ in $(seq 1 36); do
  if [ "$(mapping_field State)" = "Enabled" ]; then
    MAPPING_OK=1
    break
  fi
  sleep 5
done
if [ -z "${MAPPING_OK}" ]; then
  echo "FAIL: the event source mapping did not reach Enabled after Phase 1 (state=$(mapping_field State))" >&2
  exit 1
fi
if [ "$(mapping_field EventSourceArn)" != "${STREAM_BEFORE}" ]; then
  echo "FAIL: after Phase 1 the mapping reads $(mapping_field EventSourceArn), not the table's stream ${STREAM_BEFORE}" >&2
  exit 1
fi
echo "    OK: stream ${STREAM_BEFORE} with its mapping Enabled"

# --- Phase 2: re-deploy requesting ttlB -> must FAIL with the guard ----
echo "==> Phase 2: re-deploy requesting TTL on ttlB + StreamViewType NEW_AND_OLD_IMAGES (expected actionable failure)"
DEPLOY_OUT="$(mktemp)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DEPLOY_OUT}" 2>&1
DEPLOY_RC=$?
set -e

if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the ttlA->ttlB TTL AttributeName change deploy SUCCEEDED — the guard did not fire" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi

if ! grep -q "cannot change the TimeToLive AttributeName from 'ttlA' to 'ttlB'" "${DEPLOY_OUT}"; then
  echo "FAIL: deploy failed but NOT with the actionable TTL-attribute-change message" >&2
  echo "----- deploy output -----" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi
# The remediation hint must be present too (two-deploy guidance).
if ! grep -q "two deploys" "${DEPLOY_OUT}"; then
  echo "FAIL: actionable message present but missing the two-deploy remediation hint" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi
# Issue #6560: refused before the stream change, so the rollback has nothing
# of the table's to revert. Before the fix it reverted StreamSpecification.
if grep -q "reverting what the failed UPDATE of TtlTable" "${DEPLOY_OUT}"; then
  echo "FAIL: the rollback reverted a change of the refused table update — the TTL refusal fired after other changes went out (#6560)" >&2
  cat "${DEPLOY_OUT}" >&2
  rm -f "${DEPLOY_OUT}"
  exit 1
fi
rm -f "${DEPLOY_OUT}"
echo "    OK: deploy rejected the TTL AttributeName change with the actionable error (rc=${DEPLOY_RC})"

# --- Phase 2b: AWS TTL must still be on ttlA (guard fired pre-API) -----
ATTR_AFTER=$(ttl_attribute)
if [ "${ATTR_AFTER}" != "ttlA" ]; then
  echo "FAIL: after the rejected deploy, AWS TTL AttributeName is '${ATTR_AFTER}', expected unchanged 'ttlA'" >&2
  exit 1
fi
echo "    OK: AWS TTL still on ttlA — no partial UpdateTimeToLive happened"

# --- Phase 2b': the stream and its mapping are untouched (#6560) --------
STREAM_AFTER=$(latest_stream_arn)
if [ "${STREAM_AFTER}" != "${STREAM_BEFORE}" ]; then
  echo "FAIL: the refused deploy re-minted the table's stream (${STREAM_BEFORE} -> ${STREAM_AFTER}) — the stream change went out before the TTL refusal (#6560)" >&2
  exit 1
fi
MAPPING_ARN_AFTER=$(mapping_field EventSourceArn)
MAPPING_STATE_AFTER=$(mapping_field State)
if [ "${MAPPING_ARN_AFTER}" != "${STREAM_AFTER}" ] || [ "${MAPPING_STATE_AFTER}" != "Enabled" ]; then
  echo "FAIL: after the refused deploy the mapping is ${MAPPING_STATE_AFTER} on ${MAPPING_ARN_AFTER}, expected Enabled on the table's stream ${STREAM_AFTER} (#6560)" >&2
  exit 1
fi
echo "    OK: stream ARN unchanged and its mapping still Enabled on it"

# --- Phase 2c: name-less TTL disable inside the rate-limit window -------
# The disable (#5447) lands minutes after the Phase 1 enable, inside
# DynamoDB's TTL rate-limit interval: AWS refuses it for about half an hour
# (measured), and cdkd must re-send until AWS accepts, like CloudFormation
# (#5451). Before #5451 the deploy failed with the rate-limit report; before
# #5447 it sent nothing and left TTL ENABLED. This phase takes ~30 minutes.
echo "==> Phase 2c: re-deploy declaring TimeToLiveSpecification {Enabled:false} without AttributeName (waits ~30 min)"
DISABLE_OUT="$(mktemp)"
PHASE_START=$(date +%s)
set +e
CDKD_TEST_TTL=disable node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes >"${DISABLE_OUT}" 2>&1
DISABLE_RC=$?
set -e
PHASE_SECS=$(( $(date +%s) - PHASE_START ))
ST_AFTER=$(ttl_status)
if [ "${DISABLE_RC}" -ne 0 ]; then
  echo "FAIL: the {Enabled:false} deploy inside the TTL rate-limit window failed (rc=${DISABLE_RC}, ${PHASE_SECS}s) — cdkd did not wait the interval out (#5451)" >&2
  cat "${DISABLE_OUT}" >&2
  rm -f "${DISABLE_OUT}"
  exit 1
fi
if [ "${ST_AFTER}" != "DISABLED" ] && [ "${ST_AFTER}" != "DISABLING" ]; then
  echo "FAIL: the {Enabled:false} deploy succeeded but AWS TTL is still ${ST_AFTER} on $(ttl_attribute) — the disable was never sent (#5447)" >&2
  cat "${DISABLE_OUT}" >&2
  rm -f "${DISABLE_OUT}"
  exit 1
fi
# Vacuity guard: the deploy must have met the rate limit, or this phase never
# exercised the wait.
if ! grep -q "TimeToLive was changed recently" "${DISABLE_OUT}"; then
  echo "FAIL: the disable succeeded without announcing the rate-limit wait — the phase did not exercise #5451" >&2
  cat "${DISABLE_OUT}" >&2
  rm -f "${DISABLE_OUT}"
  exit 1
fi
rm -f "${DISABLE_OUT}"
echo "    OK: TTL ${ST_AFTER} on the name-less spec after waiting out the rate limit (${PHASE_SECS}s)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

TABLE_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"; then
    TABLE_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${TABLE_GONE}" ]; then
  echo "FAIL: DynamoDB table ${TABLE_NAME} still exists ~2min after destroy" >&2
  exit 1
fi
echo "    OK: DynamoDB table is gone"

assert_gone "Lambda function ${FUNCTION_NAME} still exists after destroy" aws lambda get-function --function-name "${FUNCTION_NAME}" --region "${REGION}"
echo "    OK: stream consumer function is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> dynamodb-ttl-attr-change test passed (TTL AttributeName change rejected with actionable error before any change; AWS TTL, stream and its mapping unchanged; name-less disable reached AWS; clean destroy)"
