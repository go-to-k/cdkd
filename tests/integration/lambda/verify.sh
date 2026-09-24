#!/usr/bin/env bash
# verify.sh - cdkd lambda integ (broad-set) + RecursiveLoop backfill assertion.
#
# Deploys the lambda fixture and asserts that RecursiveLoop reaches AWS
# via the dedicated PutFunctionRecursionConfig post-create API
# (LambdaFunctionProvider.create wires it after CreateFunction with
# delete-on-failure atomicity). Read-back uses the dedicated
# `aws lambda get-function-recursion-config` API. Then destroys clean.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
#   CDKD_REGION_SPELLING - the spelling handed to `cdkd --region` verbatim
#                  (defaults to AWS_REGION). Set it to an upper-cased region to
#                  run the issue-#2065 arm; see the note beside REGION below.

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

STACK="LambdaStack"

# Two spellings, deliberately (issue #2065).
#
# CDKD_REGION_SPELLING is what this fixture hands `cdkd --region` VERBATIM;
# REGION is its canonical form and is what everything else uses - the state
# key cdkd writes, every `aws` call, every assertion. Keeping them apart is the
# whole point: cdkd folds the spelling internally, so a fixture that reused the
# raw one for its own keys would look for `cdkd/LambdaStack/US-EAST-1/...` and
# fail against a correct binary.
#
# Default: unset -> both are `us-east-1` and this file behaves exactly as
# before, so the ordinary broad-set run is unchanged.
#
# Discriminating arm: `CDKD_REGION_SPELLING=US-EAST-1`. Against a pre-#2065
# binary that arm dies before creating anything - S3 rejects the signature with
# `AuthorizationHeaderMalformed: the region 'US-EAST-1' is wrong; expecting
# 'us-east-1'` at the state-bucket preflight. Against a fixed one it deploys,
# reads back and destroys exactly as the canonical arm does, and the state key
# it writes is the CANONICAL one - which is what proves the fold reached the
# state layer and not merely the SDK client.
CDKD_REGION_SPELLING="${CDKD_REGION_SPELLING:-${AWS_REGION:-us-east-1}}"
REGION="$(printf '%s' "${CDKD_REGION_SPELLING}" | tr '[:upper:]' '[:lower:]')"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Set while Phase 1b holds a deliberately damaged state record (issue #3314).
# PLANTED_ORIGINAL is the record before the plant, PLANTED the damaged copy,
# PLANTED_DLQ_URL the queue the nulled row named.
PLANTED_ORIGINAL=""
PLANTED=""
PLANTED_DLQ_URL=""
PLANTED_UPLOADED=0

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ "${PLANTED_UPLOADED}" = 1 ] && [ -n "${STATE_BUCKET:-}" ]; then
    live=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -c . 2>/dev/null)
    [ -n "${live}" ] || live=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -c . 2>/dev/null)
    if [ -z "${live}" ]; then
      echo "WARNING: could not read s3://${STATE_BUCKET}/${STATE_KEY} to decide how to undo the Phase 1b plant; the destroy may meet the null row" >&2
    elif [ "${live}" = "$(jq -c . "${PLANTED}" 2>/dev/null)" ]; then
      # Still the planted copy: nothing ran over it, so put the original back
      # and let the destroy below take every resource it names.
      aws s3 cp "${PLANTED_ORIGINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 \
        || echo "WARNING: could not restore the pre-plant state record" >&2
    elif [ "${live}" != "$(jq -c . "${PLANTED_ORIGINAL}" 2>/dev/null)" ]; then
      # A binary that did NOT refuse wrote over it: the record now names a
      # SECOND queue, and nothing names the one the nulled row pointed at.
      # Leave the record to the destroy and delete that first queue directly.
      echo "    the planted record was rewritten; deleting the queue the nulled row named"
      aws sqs delete-queue --queue-url "${PLANTED_DLQ_URL}" --region "${REGION}" >/dev/null \
        || echo "LEAK?: could not delete ${PLANTED_DLQ_URL}; delete it by hand" >&2
    fi
  fi
  PLANTED_UPLOADED=0
  rm -f "${PLANTED_ORIGINAL}" "${PLANTED}"
  PLANTED_ORIGINAL=""
  PLANTED=""
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${CDKD_REGION_SPELLING}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CDKD_REGION_SPELLING}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the Handler function name from state (CDK auto-names it) ----
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.physicalId] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve Handler Lambda function name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved Handler function name: ${FN_NAME}"

# --- Assertion: provisionedBy == 'sdk' (RecursiveLoop now handled by SDK provider) ----
PROVISIONED=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("Handler")) | .value.provisionedBy // ""] | first')
if [ "${PROVISIONED}" != "sdk" ]; then
  echo "FAIL: Handler Lambda has provisionedBy='${PROVISIONED}', expected 'sdk' (RecursiveLoop should NOT auto-route to CC now that the SDK provider handles it)" >&2
  exit 1
fi
echo "    OK: Handler Lambda provisionedBy == 'sdk' (RecursiveLoop is handled, no CC auto-route)"

# --- Assertion: RecursiveLoop reached AWS via PutFunctionRecursionConfig --
RECURSIVE_LOOP=$(aws lambda get-function-recursion-config \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'RecursiveLoop' --output text 2>/dev/null)
if [ "${RECURSIVE_LOOP}" != "Allow" ]; then
  echo "FAIL: Lambda RecursiveLoop is '${RECURSIVE_LOOP}', expected 'Allow' (PutFunctionRecursionConfig should have wired it)" >&2
  exit 1
fi
echo "    OK: Lambda RecursiveLoop == 'Allow' on AWS (SDK provider wired via PutFunctionRecursionConfig)"

# --- Assertion: ReservedConcurrentExecutions reached AWS via PutFunctionConcurrency --
# Same pattern as RecursiveLoop above — separate post-create control-plane
# API. Fixture sets reservedConcurrentExecutions: 5; assert the AWS-side
# response carries it via the dedicated `get-function-concurrency` API.
RESERVED_CC=$(aws lambda get-function-concurrency \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'ReservedConcurrentExecutions' --output text 2>/dev/null)
if [ "${RESERVED_CC}" != "5" ]; then
  echo "FAIL: Lambda ReservedConcurrentExecutions is '${RESERVED_CC}', expected '5' (PutFunctionConcurrency should have wired it)" >&2
  exit 1
fi
echo "    OK: Lambda ReservedConcurrentExecutions == 5 on AWS (SDK provider wired via PutFunctionConcurrency)"

# --- Phase 1b: an unreadable resource ROW refuses the deploy (issue #3314) --
# A `null` row in `resources` used to read as "not in state", so the deploy
# planned a CREATE of a resource it already manages. For this unnamed DLQ that
# is a SECOND queue, with the first one left unmanaged. A default deploy died
# before the diff instead, on a bare `TypeError` in the CLI's prefix-migration
# gate. Either way the refusal text below was absent, so this arm fails against
# a pre-#3314 binary at the grep.
echo "==> Phase 1b: plant a null resource row and expect the deploy to refuse it"
DLQ_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::SQS::Queue") | .key] | first')
if [ -z "${DLQ_ID}" ] || [ "${DLQ_ID}" = "null" ]; then
  echo "FAIL: could not resolve the SQS dead-letter queue's logical id from state" >&2
  exit 1
fi
PLANTED_DLQ_URL=$(echo "${STATE}" | jq -r --arg id "${DLQ_ID}" '.resources[$id].physicalId')
PLANTED_ORIGINAL=$(mktemp)
printf '%s\n' "${STATE}" > "${PLANTED_ORIGINAL}"
PLANTED=$(mktemp)
echo "${STATE}" | jq -c --arg id "${DLQ_ID}" '.resources[$id] = null' > "${PLANTED}"
aws s3 cp "${PLANTED}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
PLANTED_UPLOADED=1
echo "    planted resources[${DLQ_ID}] = null"

for mode in default dry-run; do
  extra=()
  [ "${mode}" = "dry-run" ] && extra=(--dry-run)
  set +e
  refuse_out=$(node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${CDKD_REGION_SPELLING}" \
    --yes ${extra[@]+"${extra[@]}"} 2>&1)
  refuse_rc=$?
  set -e
  refuse_txt=$(printf '%s' "${refuse_out}" | sed $'s/\033\[[0-9;]*m//g')
  if [ "${refuse_rc}" -ne 1 ]; then
    echo "${refuse_txt}"
    echo "FAIL: [${mode}] deploy over a null resource row exited ${refuse_rc}, expected 1 (a refusal)" >&2
    exit 1
  fi
  if ! printf '%s' "${refuse_txt}" | grep -q "cannot be read as resources"; then
    echo "${refuse_txt}"
    echo "FAIL: [${mode}] the deploy failed without the unreadable-row refusal (issue #3314)" >&2
    exit 1
  fi
  if ! printf '%s' "${refuse_txt}" | grep -q "planned as a CREATE"; then
    echo "${refuse_txt}"
    echo "FAIL: [${mode}] the refusal does not state the CREATE it prevented (issue #3314)" >&2
    exit 1
  fi
  if ! printf '%s' "${refuse_txt}" | grep -qF "${DLQ_ID}"; then
    echo "${refuse_txt}"
    echo "FAIL: [${mode}] the refusal does not name the damaged row ${DLQ_ID}" >&2
    exit 1
  fi
  # Nothing written: the record is still byte-for-byte the planted one.
  after=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -c .) || { echo "FAIL: could not read state back" >&2; exit 1; }
  if [ "${after}" != "$(jq -c . "${PLANTED}")" ]; then
    echo "FAIL: [${mode}] the refused deploy rewrote the state record" >&2
    exit 1
  fi
  # And the lock taken before the diff was released.
  assert_gone "[${mode}] the refused deploy left its lock behind" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${REGION}/lock.json"
  echo "    OK: [${mode}] refused naming ${DLQ_ID}, state untouched, lock released"
done

# Safe to restore unconditionally here: every pass of the loop above proved
# the record still byte-identical to the planted copy.
aws s3 cp "${PLANTED_ORIGINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null
PLANTED_UPLOADED=0
rm -f "${PLANTED_ORIGINAL}" "${PLANTED}"
PLANTED_ORIGINAL=""
PLANTED=""
echo "    restored the original state record"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${CDKD_REGION_SPELLING}" \
  --yes

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> lambda test passed (RecursiveLoop + ReservedConcurrentExecutions backfills verified end-to-end + clean destroy)"
