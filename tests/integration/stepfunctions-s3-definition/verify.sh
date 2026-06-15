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
#   3. destroy removes the state machine + state file with 0 errors. Bootstrap-
#      bucket asset OBJECTS persist by design (shared infra cdkd never deletes).
#
# BSD/macOS-portable (no `grep -P`, no `date -d`). Captures the real rc and
# prints an explicit `[verify] PASS` only on success.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="StepFunctionsS3Stack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

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

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws stepfunctions describe-state-machine --state-machine-arn "${SM_ARN}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: state machine ${SM_ARN} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state machine is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# NOTE: the bootstrap asset bucket object (the uploaded ASL) is NOT cleaned by
# cdkd destroy - the CDK bootstrap bucket is shared infrastructure cdkd does not
# own. This is by design; we deliberately do NOT assert its absence.
echo "    NOTE: bootstrap-bucket asset object persists by design (cdkd does not delete the CDK bootstrap bucket)"

echo ""
echo "==> stepfunctions-s3-definition test passed (DefinitionS3Location fetch + DefinitionSubstitutions applied + clean destroy)"
echo "[verify] PASS"
