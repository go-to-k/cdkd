#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6395.
#
# A nested stack template's own Transform was never expanded, so a
# cdk.NestedStack child was deployed raw: a HostedRotation in a NestedStack
# failed mid-deploy with "To use the HostedRotationLambda property, you must
# use the AWS::SecretsManager transform", after creating (and rolling back)
# the secret.
#
# Phases:
#   1. Deploy CdkdIntegNestedTransform: its child declares the SAM transform
#      and one AWS::Serverless::Function. Assert the nested template was
#      expanded (cdkd's own [macros] line for the nested template) and the
#      expanded Lambda function answers MARK=v1.
#   2. `cdkd diff` + deploy under CDKD_TEST_UPDATE=true: the function is
#      updated in place and answers v2.
#   3. A second deploy with no change reports no changes.
#   4. Destroy; the function, its role and every state record are gone.
#   5. Deploy CdkdIntegNestedTransformRot (a HostedRotation in a NestedStack):
#      refused pre-flight after the nested expansion, naming the hosted
#      rotation (#6385); no state, no secret.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""
export AWS_CLI_AUTO_PROMPT=off

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

STACK="CdkdIntegNestedTransform"
ROT_STACK="CdkdIntegNestedTransformRot"
REGION="${AWS_REGION:-us-east-1}"
ROT_SECRET="cdkd-integ-nested-transform-rot-${REGION}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# cdkd colours its report; compare against the plain text.
strip_ansi() { sed $'s/\x1b\\[[0-9;]*m//g'; }

state_prefixes() { # every state prefix of STACK and its nested children
  aws s3 ls "s3://${STATE_BUCKET:-}/cdkd/" --region "${REGION}" | awk '{print $2}' | grep -E "^($1|$1~.*)/$" || true
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" destroy "${ROT_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  # A regressed run of the HostedRotation arm creates the secret; its resource
  # policy denies DeleteSecret, so drop that first.
  aws secretsmanager delete-resource-policy --secret-id "${ROT_SECRET}" --region "${REGION}" >/dev/null 2>&1
  aws secretsmanager delete-secret --secret-id "${ROT_SECRET}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
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

deploy_logged() { # usage: deploy_logged <stack> -> prints the plain log, keeps the rc
  local out rc=0
  out="$(node "${LOCAL_DIST}" deploy "$1" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)" || rc=$?
  printf '%s\n' "${out}" | strip_ansi
  return "${rc}"
}

invoke_mark() {
  local fn="$1" out
  out="$(mktemp)"
  aws lambda invoke --region "${REGION}" --function-name "${fn}" "${out}" >/dev/null || { rm -f "${out}"; return 1; }
  node -e 'process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1], "utf-8")).mark))' "${out}"
  rm -f "${out}"
}

# --- Phase 1: deploy the SAM child -------------------------------------------
echo "==> Phase 1: deploy ${STACK} (SAM transform in a NestedStack)"
P1="$(CDKD_TEST_UPDATE= deploy_logged "${STACK}")" || {
  printf '%s\n' "${P1}" >&2
  echo "FAIL: #6395: deploy of the SAM nested child failed" >&2
  exit 1
}
printf '%s\n' "${P1}"
if ! grep -qE '^\[macros\] Expanding CloudFormation macros for nested template .* of stack '"${STACK}"' .*transforms: AWS::Serverless-2016-10-31' <<<"${P1}"; then
  echo "FAIL: #6395: no [macros] line for the nested template (wording changed, or the child was not expanded)" >&2
  exit 1
fi
# Sentinel: the child's expanded function, not a raw SAM type, was created.
if ! grep -qE '✓ Fn \(AWS::Lambda::Function\) created' <<<"${P1}"; then
  echo "FAIL: #6395: the child did not create the expanded AWS::Lambda::Function" >&2
  exit 1
fi

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/state.json" - --region "${REGION}")"
FN_NAME="$(node -e 'const v=(JSON.parse(process.argv[1]).outputs||{}).FunctionName; if (typeof v !== "string" || !v) process.exit(1); process.stdout.write(v)' "${STATE_JSON}")" || {
  echo "FAIL: state output FunctionName missing" >&2
  exit 1
}
MARK="$(invoke_mark "${FN_NAME}")"
if [ "${MARK}" != "v1" ]; then
  echo "FAIL: ${FN_NAME} answered mark=${MARK}, expected v1" >&2
  exit 1
fi
echo "    nested template expanded; ${FN_NAME} answers v1"

# --- Phase 2: update ----------------------------------------------------------
echo "==> Phase 2: diff + deploy under CDKD_TEST_UPDATE=true"
DIFF_RC=0
DIFF_OUT="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)" || DIFF_RC=$?
DIFF_OUT="$(printf '%s\n' "${DIFF_OUT}" | strip_ansi)"
if [ "${DIFF_RC}" -ne 0 ] || ! grep -qE '(^|[^0-9])1 to update' <<<"${DIFF_OUT}"; then
  printf '%s\n' "${DIFF_OUT}" >&2
  echo "FAIL: cdkd diff (rc=${DIFF_RC}) did not forecast exactly the nested update" >&2
  exit 1
fi
P2="$(CDKD_TEST_UPDATE=true deploy_logged "${STACK}")" || {
  printf '%s\n' "${P2}" >&2
  echo "FAIL: update deploy failed" >&2
  exit 1
}
if ! grep -qE '✓ Fn \(AWS::Lambda::Function\) updated' <<<"${P2}"; then
  printf '%s\n' "${P2}" >&2
  echo "FAIL: the expanded function was not updated in place" >&2
  exit 1
fi
if grep -qE 'Fn \(AWS::Lambda::Function\) (created|replaced)' <<<"${P2}"; then
  printf '%s\n' "${P2}" >&2
  echo "FAIL: the expanded function was re-created instead of updated" >&2
  exit 1
fi
MARK="$(invoke_mark "${FN_NAME}")"
if [ "${MARK}" != "v2" ]; then
  echo "FAIL: ${FN_NAME} answered mark=${MARK} after the update, expected v2" >&2
  exit 1
fi
echo "    updated in place; answers v2"

# --- Phase 3: no-op redeploy ---------------------------------------------------
echo "==> Phase 3: an unchanged redeploy reports no changes"
P3="$(CDKD_TEST_UPDATE=true deploy_logged "${STACK}")" || {
  printf '%s\n' "${P3}" >&2
  echo "FAIL: no-op redeploy failed" >&2
  exit 1
}
if ! grep -q 'No changes detected' <<<"${P3}"; then
  printf '%s\n' "${P3}" >&2
  echo "FAIL: the unchanged redeploy did not report 'No changes detected'" >&2
  exit 1
fi
echo "    no changes"

# --- Phase 4: destroy -----------------------------------------------------------
echo "==> Phase 4: destroy ${STACK}"
ROLE_NAME="$(aws lambda get-function --region "${REGION}" --function-name "${FN_NAME}" --query 'Configuration.Role' --output text | awk -F/ '{print $NF}')"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function --region "${REGION}" --function-name "${FN_NAME}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
LEFT="$(state_prefixes "${STACK}")"
for prefix in ${LEFT}; do
  assert_gone "state ${prefix}${REGION}/state.json still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${prefix}${REGION}/state.json"
done
aws logs delete-log-group --region "${REGION}" --log-group-name "/aws/lambda/${FN_NAME}" >/dev/null 2>&1 || true
echo "    function, role and state gone"

# --- Phase 5: HostedRotation in a NestedStack ----------------------------------
echo "==> Phase 5: deploy ${ROT_STACK} is refused pre-flight (#6395 + #6385)"
assert_gone "secret ${ROT_SECRET} exists before the run (a previous run leaked it)" aws secretsmanager describe-secret --secret-id "${ROT_SECRET}" --region "${REGION}"
P5_RC=0
P5="$(CDKD_TEST_UPDATE= deploy_logged "${ROT_STACK}")" || P5_RC=$?
if [ "${P5_RC}" -eq 0 ]; then
  printf '%s\n' "${P5}" >&2
  echo "FAIL: the HostedRotation-in-NestedStack deploy succeeded; expected the pre-flight refusal" >&2
  exit 1
fi
if ! grep -qE '^\[macros\] Expanding CloudFormation macros for nested template .*transforms: AWS::SecretsManager-2024-09-16' <<<"${P5}"; then
  printf '%s\n' "${P5}" >&2
  echo "FAIL: #6395: the nested HostedRotation template was not expanded" >&2
  exit 1
fi
if ! grep -q 'Refusing to start the deploy; nothing has been published or provisioned' <<<"${P5}" \
  || ! grep -q 'rotationLambda' <<<"${P5}"; then
  printf '%s\n' "${P5}" >&2
  echo "FAIL: the deploy did not end in the pre-flight hosted-rotation refusal" >&2
  exit 1
fi
# The pre-fix symptom: the raw rotation reached Secrets Manager mid-deploy.
if grep -q 'you must use the AWS::SecretsManager transform' <<<"${P5}"; then
  printf '%s\n' "${P5}" >&2
  echo "FAIL: #6395: the raw HostedRotationLambda reached Secrets Manager" >&2
  exit 1
fi
assert_gone "secret ${ROT_SECRET} was created by a refused deploy" aws secretsmanager describe-secret --secret-id "${ROT_SECRET}" --region "${REGION}"
for prefix in $(state_prefixes "${ROT_STACK}"); do
  assert_gone "state ${prefix}${REGION}/state.json written by a refused deploy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${prefix}${REGION}/state.json"
done
echo "    refused pre-flight; no secret, no state"

trap - EXIT INT TERM
echo "PASS: nested-stack-transform"
