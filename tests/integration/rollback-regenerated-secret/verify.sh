#!/usr/bin/env bash
# verify.sh -- a rollback that regenerates a secret restores a reader of that
# secret with the value the secret holds after its revert (go-to-k/cdkd#6591).
#
# Phase 1 deploys v1: a generated secret and a Lambda whose PW environment
# variable reads the secret's password through a dynamic reference. Phase 2
# deploys v2, which changes the secret's GenerateSecretString (AWS generates a
# new password), changes the function, and adds a queue that fails after both.
# The rollback restores the secret, which generates yet another password, as
# CloudFormation does. The fix reverts the secret first and resolves the
# function's reference at the current value: PW must equal the secret's
# password. Before the fix PW held the password from before the deploy.
# Phase 3 (go-to-k/cdkd#6597) makes the function's OWN update fail after the
# secret's update: the rollback must revert the failed function after the
# secret, at its regenerated value.
#
# Secret values are compared inside node and never printed.

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
. ../s3-versions.sh

STACK="CdkdRollbackRegeneratedSecret"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
QUEUE_NAME="${STACK}-failing"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"
SECRET_ARN=""
FN_NAME=""

expect_eq() { # expect_eq <description> <actual> <expected>
  if [ "$2" != "$3" ]; then echo "FAIL: $1: expected '$3', got '$2'" >&2; exit 1; fi
  echo "    OK: $1 = '$3'"
}
state_output() { # state_output <output name>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const v=JSON.parse(s).outputs?.[process.argv[1]];process.stdout.write(v===undefined?"":String(v))})' "$1"
}
secret_password() { # the secret's current password (kept in a variable, never printed)
  local raw
  raw="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --region "${REGION}" \
    --query SecretString --output text)" || return 1
  node -e 'process.stdout.write(JSON.parse(process.argv[1]).password)' "${raw}"
}
function_pw() { # the function's PW variable (kept in a variable, never printed)
  aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    --query 'Environment.Variables.PW' --output text
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  [ -n "${FN_NAME}" ] && aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${SECRET_ARN}" ] && aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  local url
  url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

echo "==> Phase 1: deploy v1 (generated secret, function reading it)"
env -u ROLLBACK_SECRET_FAIL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SECRET_ARN="$(state_output SecretArn)"
FN_NAME="$(state_output FunctionName)"
[ -n "${SECRET_ARN}" ] && [ -n "${FN_NAME}" ] || { echo "FAIL: stack outputs missing" >&2; exit 1; }
PRE_PW="$(secret_password)"
expect_eq "v1 password length" "${#PRE_PW}" "20"
expect_eq "v1 function PW equals the secret's password" \
  "$([ "$(function_pw)" = "${PRE_PW}" ] && echo yes || echo no)" "yes"

echo "==> Phase 2: deploy v2 (GenerateSecretString changed, failing queue last) -- expect FAILURE"
set +e
ROLLBACK_SECRET_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG_DIR}/deploy-v2.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy-v2.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the v2 deploy unexpectedly SUCCEEDED (the failing queue did not fail)" >&2
  exit 1
fi
echo "    OK: v2 deploy failed (rc=${DEPLOY_RC})"
if grep -qF -- "${PRE_PW}" "${LOG_DIR}/deploy-v2.log"; then
  echo "FAIL: the deploy log carries the secret's plaintext" >&2
  exit 1
fi

# The premise: the rollback restored the secret by generating a NEW 20-char
# password. If it still held the pre-deploy one, the assertion below would
# pass on any binary.
RB_PW="$(secret_password)"
expect_eq "rolled-back password length" "${#RB_PW}" "20"
if [ "${RB_PW}" = "${PRE_PW}" ]; then
  echo "FAIL: premise not reproduced: the rollback did not regenerate the secret" >&2
  exit 1
fi
echo "    OK: the rollback regenerated the secret"
LIVE_PW="$(function_pw)"
if [ "${LIVE_PW}" = "${PRE_PW}" ]; then
  echo "FAIL: the function holds the password from before the deploy, which the secret no longer serves (go-to-k/cdkd#6591)" >&2
  exit 1
fi
expect_eq "rolled-back function PW equals the secret's current password" \
  "$([ "${LIVE_PW}" = "${RB_PW}" ] && echo yes || echo no)" "yes"
expect_eq "rolled-back function PLAIN" \
  "$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    --query 'Environment.Variables.PLAIN' --output text)" "one"
if aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | grep -qF -- "${RB_PW}"; then
  echo "FAIL: the state record carries the secret's plaintext" >&2
  exit 1
fi
echo "    OK: state carries no plaintext"
if ! gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
  echo "FAIL: failing queue ${QUEUE_NAME} exists -- the invalid CreateQueue should have been rejected" >&2
  exit 1
fi
echo "    OK: no failing queue left behind"

echo "==> Phase 2: drift after the rollback (expect none)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  >"${LOG_DIR}/drift.log" 2>&1
DRIFT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/drift.log" || true
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift after the rollback exited ${DRIFT_RC}" >&2
  exit 1
fi
echo "    OK: no drift after the rollback"

echo "==> Phase 3: deploy v3 (GenerateSecretString changed, the function's own update fails) -- expect FAILURE"
set +e
ROLLBACK_SECRET_FAIL=reader node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG_DIR}/deploy-v3.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy-v3.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the v3 deploy unexpectedly SUCCEEDED (the function update did not fail)" >&2
  exit 1
fi
echo "    OK: v3 deploy failed (rc=${DEPLOY_RC})"
if grep -qF -- "${RB_PW}" "${LOG_DIR}/deploy-v3.log"; then
  echo "FAIL: the deploy log carries the secret's plaintext" >&2
  exit 1
fi
# The premise: the rollback regenerated the secret again.
RB3_PW="$(secret_password)"
expect_eq "v3 rolled-back password length" "${#RB3_PW}" "20"
if [ "${RB3_PW}" = "${RB_PW}" ]; then
  echo "FAIL: premise not reproduced: the v3 rollback did not regenerate the secret" >&2
  exit 1
fi
echo "    OK: the v3 rollback regenerated the secret"
LIVE3_PW="$(function_pw)"
if [ "${LIVE3_PW}" = "${RB_PW}" ]; then
  echo "FAIL: the failed function holds the password from before the v3 deploy, which the secret no longer serves (go-to-k/cdkd#6597)" >&2
  exit 1
fi
expect_eq "rolled-back failed function PW equals the secret's current password" \
  "$([ "${LIVE3_PW}" = "${RB3_PW}" ] && echo yes || echo no)" "yes"
expect_eq "rolled-back failed function PLAIN" \
  "$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    --query 'Environment.Variables.PLAIN' --output text)" "one"
if aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | grep -qF -- "${RB3_PW}"; then
  echo "FAIL: the state record carries the secret's plaintext" >&2
  exit 1
fi
echo "    OK: state carries no plaintext"

echo "==> Phase 3: drift after the rollback (expect none)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  >"${LOG_DIR}/drift3.log" 2>&1
DRIFT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/drift3.log" || true
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift after the v3 rollback exited ${DRIFT_RC}" >&2
  exit 1
fi
echo "    OK: no drift after the v3 rollback"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "function ${FN_NAME} still exists after destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: function gone"
# A deleted secret can still answer describe-secret with DeletedDate set (a
# scheduled deletion, or a force delete not yet applied): that is deleted. Only
# a secret still ACTIVE, with no DeletedDate, is a leak.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}"; then
  SECRET_DELETED_DATE="GONE"
elif ! SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" \
    --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
  # TOCTOU: the secret can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${SECRET_DELETED_DATE}" \
    && SECRET_DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED_DATE}" >&2; exit 1; }
fi
if [ "${SECRET_DELETED_DATE}" = "GONE" ]; then
  echo "    OK: secret is gone"
elif [ -n "${SECRET_DELETED_DATE}" ] && [ "${SECRET_DELETED_DATE}" != "None" ]; then
  echo "    OK: secret is deleted (DeletedDate=${SECRET_DELETED_DATE})"
else
  echo "FAIL: the secret is still ACTIVE after destroy (no DeletedDate set)" >&2
  exit 1
fi
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "rollback-regenerated-secret state teardown"

echo ""
echo "==> rollback-regenerated-secret test passed"
