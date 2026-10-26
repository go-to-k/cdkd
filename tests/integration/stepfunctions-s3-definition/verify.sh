#!/usr/bin/env bash
# verify.sh - cdkd stepfunctions-s3-definition integ (issue #609 backfill).
#
# Exercises the AWS::StepFunctions::StateMachine.DefinitionS3Location backfill:
#   - The ASL definition lives in an s3_assets.Asset (NOT inline). cdkd uploads
#     it to the bootstrap asset bucket; the L1 CfnStateMachine references it via
#     definitionS3Location. cdkd must fetch the S3 object and inline it as the
#     CreateStateMachine `definition`.
#   - The definition contains a ${Greeting} token resolved via
#     definitionSubstitutions. The intrinsic resolver cannot reach S3 content,
#     so cdkd's provider applies the substitution to the fetched body itself.
#
# Asserts (against real AWS via describe-state-machine):
#   1. deploy creates the state machine and its `.definition` is the ASL from
#      S3 (proving DefinitionS3Location reached AWS, not a dropped/empty def).
#   2. the ${Greeting} token was substituted with `hello-from-cdkd` and the raw
#      token is gone (proving DefinitionSubstitutions was applied to S3 content).
#   3. (issue #5298) DefinitionSubstitutions is applied to the INLINE forms too:
#      ChainMachine (string DefinitionString + a separate
#      DefinitionSubstitutions map, the pair an L2 chain body synthesizes)
#      and ObjectMachine (L1 inline object Definition) deploy with their
#      ${...} tokens substituted (v1).
#   4. (issue #5298) a redeploy with -c phase=2 changes ONLY the two inline
#      machines' substitution values; the same machines (no replacement) now
#      carry the v2 values -- the update path applies them too.
#   5. destroy removes all three state machines + state file with 0 errors.
#      Bootstrap-bucket asset OBJECTS persist by design (shared infra cdkd
#      never deletes).
#
# BSD/macOS-portable (no `grep -P`, no `date -d`). Captures the real rc and
# prints an explicit `[verify] PASS` only on success.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="StepFunctionsS3Stack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
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
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# --- Resolve the state-machine ARN from state -------------------------
SM_ARN=$(echo "${STATE}" | jq -r '.resources.StateMachine.physicalId // empty')
if [ -z "${SM_ARN}" ] || [ "${SM_ARN}" = "null" ]; then
  echo "FAIL: could not resolve StateMachine ARN from state" >&2
  echo "${STATE}" | jq . >&2
  exit 1
fi
echo "    resolved state machine ARN: ${SM_ARN}"

# --- Assertion 1: the definition came from S3 (DefinitionS3Location) ---
DEFINITION=$(aws stepfunctions describe-state-machine \
  --state-machine-arn "${SM_ARN}" --region "${REGION}" \
  --query 'definition' --output text 2>/dev/null)
if [ -z "${DEFINITION}" ] || [ "${DEFINITION}" = "None" ]; then
  echo "FAIL: describe-state-machine returned an empty definition - DefinitionS3Location did not reach AWS" >&2
  exit 1
fi

# The ASL fetched from S3 has a single Pass state named "Greet".
if ! echo "${DEFINITION}" | jq -e '.States.Greet.Type == "Pass"' >/dev/null 2>&1; then
  echo "FAIL: deployed definition is not the ASL from S3 (no Pass state 'Greet'). Got:" >&2
  echo "${DEFINITION}" >&2
  exit 1
fi
echo "    OK: state machine definition was sourced from the S3 object (DefinitionS3Location reached AWS)"

# --- Assertion 2: DefinitionSubstitutions was applied to the S3 body ---
GREETING=$(echo "${DEFINITION}" | jq -r '.States.Greet.Result // empty')
if [ "${GREETING}" != "hello-from-cdkd" ]; then
  echo "FAIL: \${Greeting} substitution not applied - Result is '${GREETING}', expected 'hello-from-cdkd'" >&2
  echo "${DEFINITION}" >&2
  exit 1
fi
if echo "${DEFINITION}" | grep -q '${Greeting}'; then
  echo "FAIL: raw \${Greeting} token still present in deployed definition (substitution not applied)" >&2
  exit 1
fi
echo "    OK: DefinitionSubstitutions applied to the S3 body (\${Greeting} -> hello-from-cdkd)"

# --- Assertion 3 (issue #5298): substitutions applied to the inline forms ---
# resolve_sm_arn <logical-id-prefix>: match by prefix (robust to a CDK hash
# suffix) and require exactly one hit.
resolve_sm_arn() {
  local prefix="$1" state="$2" arns
  arns=$(echo "${state}" | jq -r --arg p "${prefix}" \
    '.resources | to_entries[] | select(.key | startswith($p)) | select(.value.resourceType == "AWS::StepFunctions::StateMachine") | .value.physicalId')
  if [ -z "${arns}" ] || [ "$(printf '%s\n' "${arns}" | wc -l | tr -d ' ')" != "1" ]; then
    echo "FAIL: expected exactly one StateMachine with logical id prefix '${prefix}' in state, got: '${arns}'" >&2
    exit 1
  fi
  printf '%s' "${arns}"
}
# assert_inline_result <arn> <state-name> <token-name> <expected-result>
assert_inline_result() {
  local arn="$1" state_name="$2" token="$3" expected="$4" def got
  if ! def=$(aws stepfunctions describe-state-machine --state-machine-arn "${arn}" \
    --region "${REGION}" --query 'definition' --output text); then
    echo "FAIL: #5298 describe-state-machine failed for ${state_name} (${arn})" >&2
    return 1
  fi
  got=$(echo "${def}" | jq -r --arg s "${state_name}" '.States[$s].Result // empty')
  if [ "${got}" != "${expected}" ]; then
    echo "FAIL: #5298 inline DefinitionSubstitutions not applied on ${state_name} - Result is '${got}', expected '${expected}'" >&2
    echo "${def}" >&2
    exit 1
  fi
  if printf '%s' "${def}" | grep -qF "\${${token}}"; then
    echo "FAIL: #5298 raw \${${token}} token still present in ${state_name}'s deployed definition" >&2
    exit 1
  fi
  echo "    OK: ${state_name} Result is '${expected}' (inline \${${token}} substituted)"
}

CHAIN_ARN=$(resolve_sm_arn "ChainMachine" "${STATE}")
OBJECT_ARN=$(resolve_sm_arn "ObjectMachine" "${STATE}")
echo "    resolved ChainMachine ARN: ${CHAIN_ARN}"
echo "    resolved ObjectMachine ARN: ${OBJECT_ARN}"
assert_inline_result "${CHAIN_ARN}" "InlineGreet" "InlineGreeting" "inline-hello-v1"
assert_inline_result "${OBJECT_ARN}" "ObjectGreet" "ObjectGreeting" "object-hello-v1"

# --- Phase 1b (issue #5298): redeploy changing ONLY the substitution values ---
echo "==> Phase 1b: redeploy with -c phase=2 (inline DefinitionSubstitutions values change)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c phase=2 \
  --yes

STATE2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
CHAIN_ARN2=$(resolve_sm_arn "ChainMachine" "${STATE2}")
OBJECT_ARN2=$(resolve_sm_arn "ObjectMachine" "${STATE2}")
if [ "${CHAIN_ARN2}" != "${CHAIN_ARN}" ] || [ "${OBJECT_ARN2}" != "${OBJECT_ARN}" ]; then
  echo "FAIL: #5298 a DefinitionSubstitutions-only change replaced a state machine (expected an in-place update)" >&2
  echo "    ChainMachine: ${CHAIN_ARN} -> ${CHAIN_ARN2}" >&2
  echo "    ObjectMachine: ${OBJECT_ARN} -> ${OBJECT_ARN2}" >&2
  exit 1
fi
echo "    OK: both inline machines updated in place (ARNs unchanged)"
assert_inline_result "${CHAIN_ARN}" "InlineGreet" "InlineGreeting" "inline-hello-v2"
assert_inline_result "${OBJECT_ARN}" "ObjectGreet" "ObjectGreeting" "object-hello-v2"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Step Functions DeleteStateMachine is ASYNC: the state machine enters DELETING
# status and `describe-state-machine` keeps returning it (status DELETING) until
# the async deletion completes, so a successful describe is NOT a failure here —
# only a still-ACTIVE status would be. Accept GONE (describe errors) / DELETING /
# DELETED; the DELETING machine finishes deleting on its own.
assert_sm_deleted() { # usage: assert_sm_deleted <arn>
  local arn="$1" sm_status
  if gone_probe aws stepfunctions describe-state-machine --state-machine-arn "${arn}" --region "${REGION}"; then
    sm_status="GONE"
  elif ! sm_status=$(aws stepfunctions describe-state-machine --state-machine-arn "${arn}" \
      --region "${REGION}" --query 'status' --output text 2>&1); then
    # TOCTOU: the machine can finish deleting between gone_probe and this requery.
    printf '%s' "${sm_status}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && sm_status="GONE" \
      || { echo "FAIL: describe-state-machine requery undetermined: ${sm_status}" >&2; exit 1; }
  fi
  case "${sm_status}" in
    GONE | DELETING | DELETED)
      echo "    OK: state machine ${arn} is deleted or async-deleting (status=${sm_status})"
      ;;
    *)
      echo "FAIL: state machine ${arn} is still '${sm_status}' after destroy" >&2
      exit 1
      ;;
  esac
}
assert_sm_deleted "${SM_ARN}"
assert_sm_deleted "${CHAIN_ARN}"
assert_sm_deleted "${OBJECT_ARN}"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# NOTE: the bootstrap asset bucket object (the uploaded ASL) is NOT cleaned by
# cdkd destroy - the CDK bootstrap bucket is shared infrastructure cdkd does not
# own. This is by design; we deliberately do NOT assert its absence.
echo "    NOTE: bootstrap-bucket asset object persists by design (cdkd does not delete the CDK bootstrap bucket)"

echo ""
echo "==> stepfunctions-s3-definition test passed (DefinitionS3Location fetch + DefinitionSubstitutions applied to S3 and inline bodies on create and update + clean destroy)"
echo "[verify] PASS"
