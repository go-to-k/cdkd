#!/usr/bin/env bash
# verify.sh — a custom resource whose RECORDED ServiceToken is the redaction
# mask (go-to-k/cdkd#3938).
#
# A dependent custom resource that reads a `NoEcho` attribute EQUAL to its own
# ServiceToken persists `ServiceToken: "***"`. Before #3938 the delete path
# sent that mask to Lambda as a function name: the backing-Lambda pre-check and
# the Delete invoke failed with an AWS error that said nothing about the mask,
# and the row reported the generic invoke failure. The fix skips the resource
# with a NAMED reason before any AWS call.
#
# PHASES. Deploy with the dependent -> assert the PREMISE (dependent's
# ServiceToken is '***', the producer's is still the ARN) -> destroy #1 (exits
# 2, the masked-token skip reason, record kept, everything else destroyed) ->
# the remedy the warning names (`cdkd state orphan`) -> deploy fresh WITHOUT the
# dependent -> destroy #2, CLEAN.
#
# WHY DESTROY #2 EXISTS. `/run-integ` flips `integ-destroy` only for a run whose
# destroy finished with 0 errors and no orphans; destroy #1 skips by design.
#
# DISCRIMINATOR. Pre-fix, destroy #1 ALSO exits 2 with the record kept (the
# invoke fails and the lenient catch skips), so exit code and record alone
# prove nothing. What only the fix produces is the masked-token REASON on the
# row, and what only the bug produces is the invoke-failure reason — both are
# asserted.
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

STACK="CdkdCrMaskedServiceTokenExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Must match `lib/cr-masked-service-token-stack.ts`. A stack-level
# `cdk.CustomResource` gets its construct id as the logical id verbatim.
DEPENDENT_ID="MaskedDependent"
PRODUCER_ID="EchoProducer"
DEPENDENT_TYPE="Custom::CdkdMaskedTokenDependent"
SECRET_MASK='***'

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Lambda creates `/aws/lambda/<function>` on first invoke and nothing in the
# stack owns it (#3885); the handler is named `<stack>-...`.
. ../cr-log-groups.sh

# Safe to run pre-run: every line targets something a phase re-creates.
cleanup() {
  echo "==> Cleanup: dropping any leftover stack resources and state"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
    # The masked record is skipped by every delete, so it survives
    # `state destroy`; the orphan command is the remedy the skip warning names.
  fi
  # Drop the state file ONLY when nothing live can be behind it: absent, empty,
  # or holding just the masked dependent (orphaned first). A record a real
  # delete failed on points at a live resource, and an UNREADABLE state file
  # may be one — both are KEPT, with a warning, so the next run's
  # `state destroy` can still reach them.
  if [ -n "${STATE_BUCKET:-}" ]; then
    drop_state=0
    # `gone_probe` in a SUBSHELL, since it exits on an undetermined probe: 0 is
    # "confirmed absent"; anything else (present, or unknown) goes on to a read,
    # and a failed read KEEPS the file.
    if ( gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" ) 2>/dev/null; then
      :
    elif left=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
      | jq -r '[.resources // {} | keys[]] | join(",")'); then
      if [ -z "${left}" ]; then
        drop_state=1
      elif [ "${left}" = "${DEPENDENT_ID}" ]; then
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

# --- Phase 1: deploy WITH the dependent -------------------------------------
echo "==> Phase 1: deploy the producer and the masked dependent"
CDKD_TEST_UPDATE=masked-dependent node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi
echo "    OK: state file written"

HANDLER_NAME=$(printf '%s' "${STATE}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .physicalId] | first // ""')
if [ -z "${HANDLER_NAME}" ]; then
  echo "FAIL: no AWS::Lambda::Function in state after deploy" >&2
  exit 1
fi
echo "    OK: handler Lambda is ${HANDLER_NAME}"

# --- Assertion: the PREMISE -------------------------------------------------
# Without a masked ServiceToken the skip phase below would test nothing. If
# this fails because cdkd stopped masking the dependent's ServiceToken, that is
# a change to the redaction, not a regression of #3938: update this fixture.
DEP_TOKEN=$(printf '%s' "${STATE}" \
  | jq -r --arg id "${DEPENDENT_ID}" '.resources[$id].properties.ServiceToken // "<absent>"')
if [ "${DEP_TOKEN}" != "${SECRET_MASK}" ]; then
  echo "FAIL: PREMISE not met — ${DEPENDENT_ID}'s recorded ServiceToken is '${DEP_TOKEN}'," >&2
  echo "    expected the redaction mask '${SECRET_MASK}' (issue #3938's reproduction)" >&2
  exit 1
fi
echo "    OK: PREMISE — ${DEPENDENT_ID}'s recorded ServiceToken is the mask"

# Negative control: the producer's OWN record is protected by its excluded set.
PROD_TOKEN=$(printf '%s' "${STATE}" \
  | jq -r --arg id "${PRODUCER_ID}" '.resources[$id].properties.ServiceToken // "<absent>"')
case "${PROD_TOKEN}" in
  arn:aws*:lambda:*:function:*)
    echo "    OK: ${PRODUCER_ID}'s recorded ServiceToken is still a Lambda ARN"
    ;;
  *)
    echo "FAIL: ${PRODUCER_ID}'s recorded ServiceToken is '${PROD_TOKEN}', expected a Lambda ARN" >&2
    exit 1
    ;;
esac

# --- Phase 2: destroy — the masked dependent must be SKIPPED, by name -------
echo "==> Phase 2: destroy (the dependent's ServiceToken is the mask)"
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
  exit 1
fi
echo "    OK: destroy exited 2"

# Two INDEPENDENT markers: the summary comes from `destroy.ts`, the row from the
# provider's skip reason via `destroy-runner.ts`. A summary with no matching
# row means the reason wording moved, not that the fix did not fire.
SUMMARY_SEEN=0
if printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped '; then
  SUMMARY_SEEN=1
fi
ROW_SEEN=0
if printf '%s' "${DESTROY_TXT}" | grep -q 'skipped (masked ServiceToken in state'; then
  ROW_SEEN=1
fi
if [ "${SUMMARY_SEEN}" -eq 1 ] && [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: cdkd reported a skipped destroy but no row carried the #3938 reason." >&2
  if printf '%s' "${DESTROY_TXT}" | grep -q 'Delete request to the handler did not complete'; then
    echo "    The row carries the INVOKE-FAILURE reason instead: the mask was sent to" >&2
    echo "    Lambda as a function name — the pre-#3938 behaviour." >&2
  else
    echo "    The reason WORDING has drifted away from this grep — fix verify.sh." >&2
  fi
  exit 1
fi
if [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: destroy output carried no 'skipped (masked ServiceToken in state' row" >&2
  exit 1
fi
if printf '%s' "${DESTROY_TXT}" | grep -q 'Delete request to the handler did not complete'; then
  echo "FAIL: a Delete invoke failed — the mask reached Lambda (pre-#3938 behaviour)" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_TXT}" | grep -q 'Destroy skipped 1 entr'; then
  echo "FAIL: expected EXACTLY ONE skipped entry (the masked dependent)" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_TXT}" | grep -q 'is recorded in state as the redaction mask'; then
  echo "FAIL: the skip warning did not name the redaction mask" >&2
  exit 1
fi
echo "    OK: the row, the summary and the warning all name the masked ServiceToken"

# --- Assertion: the record is kept, and ONLY it -----------------------------
STATE_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_AFTER}" ]; then
  echo "FAIL: state file was deleted by a destroy that skipped a resource" >&2
  exit 1
fi
KEPT=$(printf '%s' "${STATE_AFTER}" | jq -r '[.resources | keys[]] | join(",")')
if [ "${KEPT}" != "${DEPENDENT_ID}" ]; then
  echo "FAIL: state kept '${KEPT}', expected only '${DEPENDENT_ID}'" >&2
  echo "    => either the skip aborted the rest of the destroy, or another resource was skipped" >&2
  exit 1
fi
KEPT_TYPE=$(printf '%s' "${STATE_AFTER}" \
  | jq -r --arg id "${DEPENDENT_ID}" '.resources[$id].resourceType // "<absent>"')
if [ "${KEPT_TYPE}" != "${DEPENDENT_TYPE}" ]; then
  echo "FAIL: the kept record's type is '${KEPT_TYPE}', expected '${DEPENDENT_TYPE}'" >&2
  exit 1
fi
echo "    OK: only ${DEPENDENT_ID} is kept in state"

assert_gone "handler Lambda ${HANDLER_NAME} still exists after the skipping teardown" \
  aws lambda get-function --region "${REGION}" --function-name "${HANDLER_NAME}"
echo "    OK: the rest of the stack, including the handler, was destroyed"

# --- Phase 3: the remedy the warning names ----------------------------------
echo "==> Phase 3: drop the kept record with 'cdkd state orphan'"
node "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" \
  --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after state orphan" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: the record is gone"

# --- Phase 4: deploy fresh WITHOUT the dependent ----------------------------
echo "==> Phase 4: deploy again without the masked dependent"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Re-read the handler's name rather than reusing phase 1's: a gone-probe on a
# name this deploy did not create would pass vacuously.
STATE2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
HANDLER2_NAME=$(printf '%s' "${STATE2}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .physicalId] | first // ""')
HANDLER2_ROLE=$(printf '%s' "${STATE2}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::IAM::Role") | .physicalId] | first // ""')
if [ -z "${HANDLER2_ROLE}" ]; then
  echo "FAIL: no AWS::IAM::Role in state after the fresh deploy" >&2
  exit 1
fi
if [ -z "${HANDLER2_NAME}" ]; then
  echo "FAIL: no AWS::Lambda::Function in state after the fresh deploy" >&2
  exit 1
fi
if printf '%s' "${STATE2}" | jq -e --arg id "${DEPENDENT_ID}" '.resources | has($id)' >/dev/null; then
  echo "FAIL: ${DEPENDENT_ID} is in state after a deploy that omits it" >&2
  exit 1
fi
echo "    OK: fresh stack without ${DEPENDENT_ID}; handler is ${HANDLER2_NAME}"

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
echo "    OK: clean destroy, no skips"

assert_gone "handler Lambda ${HANDLER2_NAME} still exists after the clean destroy (orphan)" \
  aws lambda get-function --region "${REGION}" --function-name "${HANDLER2_NAME}"
assert_gone "handler role ${HANDLER2_ROLE} still exists after the clean destroy (orphan)" \
  aws iam get-role --role-name "${HANDLER2_ROLE}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: handler, its role and the state file are gone"

trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"

echo ""
echo "[verify] PASS — custom-resource-masked-service-token (#3938 masked-ServiceToken skip + clean destroy)"
