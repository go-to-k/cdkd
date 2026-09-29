#!/usr/bin/env bash
# verify.sh — a resource whose delete ADDRESSES it through a recorded property
# cdkd redacted (go-to-k/cdkd#3952).
#
# An AWS::ApiGatewayV2::Stage reads its ApiId from a NoEcho custom resource that
# echoes the API's id, so the stage's recorded ApiId is the mask '***'. Before
# #3952 the delete sent DeleteStage(apiId: '***'); AWS answered
# NotFoundException, which the provider read as "already deleted", so the
# record was DROPPED and the destroy exited 0 over a stage that was still live.
#
# PHASES. Deploy with the stage -> assert the PREMISE (the stage's recorded
# ApiId is '***', the echo resource's own ApiId is the real id) -> destroy #1
# (exits 2, the redacted-address skip reason, only the stage record kept; the
# API's deletion removes the stage in AWS) -> the remedy the warning names
# (`cdkd state orphan`) -> deploy fresh WITHOUT the stage -> destroy #2, CLEAN.
#
# DISCRIMINATOR. Pre-fix, destroy #1 exits 0 with the stage record dropped, so
# the exit code, the reason row and the kept record all go red.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

set -euo pipefail

export AWS_PAGER=""

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

STACK="CdkdRedactedDeleteAddressExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Must match `lib/redacted-delete-address-stack.ts`. The stage is found by its
# resource type so this script does not repeat its construct id.
STAGE_TYPE="AWS::ApiGatewayV2::Stage"
ECHO_ID="ApiEcho"
SECRET_MASK='***'

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Lambda creates `/aws/lambda/<function>` on first invoke and nothing in the
# stack owns it (#3885); the handler is named `<stack>-...`.
. ../cr-log-groups.sh

# Safe to run pre-run: every line targets something a phase re-creates.
cleanup() {
  echo "==> Cleanup: dropping any leftover stack resources and state"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  # Drop the state file ONLY when nothing live can be behind it: absent, empty,
  # or holding just the stage record, which every delete skips and whose API
  # the destroy already removed. Any other survivor, or an unreadable file, is
  # KEPT with a warning so the next run's `state destroy` can still reach it.
  if [ -n "${STATE_BUCKET:-}" ]; then
    drop_state=0
    if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) 2>/dev/null; then
      :
    elif left=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
      | jq -r '[.resources // {} | to_entries[] | .value.resourceType] | join(",")'); then
      if [ -z "${left}" ]; then
        drop_state=1
      elif [ "${left}" = "${STAGE_TYPE}" ]; then
        if [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state orphan "${STACK}" \
          --state-bucket "${STATE_BUCKET}" \
          --stack-region "${REGION}" \
          --force; then
          drop_state=1
        else
          echo "    WARN: state orphan failed (or no built CLI); KEEPING ${STATE_KEY}" >&2
        fi
      else
        echo "    WARN: state still holds '${left}' after state destroy; KEEPING it so the" >&2
        echo "          surviving resources stay tracked. Inspect with 'cdkd state show ${STACK}'." >&2
      fi
    else
      echo "    WARN: could not read ${STATE_KEY}; KEEPING it" >&2
    fi
    if [ "${drop_state}" -eq 1 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
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

# --- Phase 1: deploy WITH the echoed stage ----------------------------------
echo "==> Phase 1: deploy the API, the NoEcho echo and the stage"
CDKD_TEST_UPDATE=redacted-stage node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi
API_ID=$(printf '%s' "${STATE}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::ApiGatewayV2::Api") | .physicalId] | first // ""')
if [ -z "${API_ID}" ]; then
  echo "FAIL: no AWS::ApiGatewayV2::Api in state after deploy" >&2
  exit 1
fi
STAGE_ID=$(printf '%s' "${STATE}" \
  | jq -r --arg t "${STAGE_TYPE}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .key] | first // ""')
if [ -z "${STAGE_ID}" ]; then
  echo "FAIL: no ${STAGE_TYPE} in state after deploy" >&2
  exit 1
fi
echo "    OK: API ${API_ID}, stage record ${STAGE_ID}"

# The stage really exists in AWS, under the REAL api id.
aws apigatewayv2 get-stage --region "${REGION}" --api-id "${API_ID}" --stage-name echoed >/dev/null
echo "    OK: stage 'echoed' is live on ${API_ID}"

# --- Assertion: the PREMISE -------------------------------------------------
# Without a redacted ApiId the skip phase below would test nothing. If cdkd
# stops masking the stage's ApiId, that is a change to the redaction, not a
# regression of #3952: update this fixture.
STAGE_API_ID=$(printf '%s' "${STATE}" \
  | jq -r --arg id "${STAGE_ID}" '.resources[$id].properties.ApiId // "<absent>"')
if [ "${STAGE_API_ID}" != "${SECRET_MASK}" ]; then
  echo "FAIL: PREMISE not met — the stage's recorded ApiId is '${STAGE_API_ID}'," >&2
  echo "    expected the redaction mask '${SECRET_MASK}' (issue #3952's reproduction)" >&2
  exit 1
fi
ECHO_API_ID=$(printf '%s' "${STATE}" \
  | jq -r --arg id "${ECHO_ID}" '.resources[$id].properties.ApiId // "<absent>"')
if [ "${ECHO_API_ID}" != "${API_ID}" ]; then
  echo "FAIL: ${ECHO_ID}'s own recorded ApiId is '${ECHO_API_ID}', expected '${API_ID}'" >&2
  exit 1
fi
echo "    OK: PREMISE — the stage's recorded ApiId is the mask; the echo's own is the real id"

# --- Phase 2: destroy — the stage must be SKIPPED, by name ------------------
echo "==> Phase 2: destroy (the stage's ApiId is redacted)"
set +e
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY_RC=$?
set -e
printf '%s\n' "${DESTROY_OUT}"
DESTROY_TXT=$(printf '%s' "${DESTROY_OUT}" | sed $'s/\033\[[0-9;]*m//g')

if [ "${DESTROY_RC}" -ne 2 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}, expected 2 (one resource skipped)" >&2
  if [ "${DESTROY_RC}" -eq 0 ]; then
    echo "    => the redacted ApiId reached DeleteStage and its NotFound read as" >&2
    echo "       'already deleted' — the pre-#3952 behaviour." >&2
  fi
  exit 1
fi
# Two INDEPENDENT markers: the summary from destroy.ts, the row from the skip
# reason via destroy-runner.ts.
SUMMARY_SEEN=0
if printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped '; then
  SUMMARY_SEEN=1
fi
ROW_SEEN=0
if printf '%s' "${DESTROY_TXT}" | grep -q 'skipped (redacted address property in state'; then
  ROW_SEEN=1
fi
if [ "${SUMMARY_SEEN}" -eq 1 ] && [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: cdkd reported a skipped destroy but no row carried the #3952 reason —" >&2
  echo "    the reason WORDING has drifted away from this grep; fix verify.sh." >&2
  exit 1
fi
if [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: destroy output carried no 'skipped (redacted address property in state' row" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped 1 entr'; then
  echo "FAIL: expected EXACTLY ONE skipped entry (the stage)" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_TXT}" | grep -q 'recorded in state with ApiId redacted'; then
  echo "FAIL: the skip warning did not name the redacted ApiId" >&2
  exit 1
fi
echo "    OK: the row, the summary and the warning all name the redacted ApiId"

STATE_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_AFTER}" ]; then
  echo "FAIL: state file was deleted by a destroy that skipped a resource" >&2
  exit 1
fi
KEPT=$(printf '%s' "${STATE_AFTER}" | jq -r '[.resources | keys[]] | join(",")')
if [ "${KEPT}" != "${STAGE_ID}" ]; then
  echo "FAIL: state kept '${KEPT}', expected only '${STAGE_ID}'" >&2
  exit 1
fi
echo "    OK: only the stage record is kept"

# The API's own delete removed its stage, so AWS ends clean; only the record is
# stale, which is what the warning's parent clause says.
assert_gone "API ${API_ID} still exists after the skipping teardown" \
  aws apigatewayv2 get-api --region "${REGION}" --api-id "${API_ID}"
echo "    OK: the API (and with it the stage) is gone"

# --- Phase 3: the remedy the warning names ----------------------------------
echo "==> Phase 3: drop the kept record with 'cdkd state orphan'"
node "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" \
  --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after state orphan" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the record is gone"

# --- Phase 4: deploy fresh WITHOUT the stage ---------------------------------
echo "==> Phase 4: deploy again without the echoed stage"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
STATE2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
API2_ID=$(printf '%s' "${STATE2}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::ApiGatewayV2::Api") | .physicalId] | first // ""')
if [ -z "${API2_ID}" ]; then
  echo "FAIL: no AWS::ApiGatewayV2::Api in state after the fresh deploy" >&2
  exit 1
fi
HANDLER2_NAME=$(printf '%s' "${STATE2}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .physicalId] | first // ""')
if [ -z "${HANDLER2_NAME}" ]; then
  echo "FAIL: no AWS::Lambda::Function in state after the fresh deploy" >&2
  exit 1
fi
echo "    OK: fresh stack; API ${API2_ID}, handler ${HANDLER2_NAME}"

# --- Phase 5: the CLEAN destroy ---------------------------------------------
echo "==> Phase 5: clean destroy (this is the run the integ-destroy gate reads)"
set +e
DESTROY2_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY2_RC=$?
set -e
printf '%s\n' "${DESTROY2_OUT}"
DESTROY2_TXT=$(printf '%s' "${DESTROY2_OUT}" | sed $'s/\033\[[0-9;]*m//g')

if [ "${DESTROY2_RC}" -ne 0 ]; then
  echo "FAIL: the clean destroy exited ${DESTROY2_RC}, expected 0" >&2
  exit 1
fi
if printf '%s' "${DESTROY2_TXT}" | grep -q 'Destroy skipped '; then
  echo "FAIL: the clean destroy still skipped something" >&2
  exit 1
fi
assert_gone "API ${API2_ID} still exists after the clean destroy (orphan)" \
  aws apigatewayv2 get-api --region "${REGION}" --api-id "${API2_ID}"
assert_gone "handler Lambda ${HANDLER2_NAME} still exists after the clean destroy (orphan)" \
  aws lambda get-function --region "${REGION}" --function-name "${HANDLER2_NAME}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: clean destroy; API, handler and state file are gone"

trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"

echo ""
echo "[verify] PASS — redacted-delete-address (#3952 redacted ApiId skip + clean destroy)"
