#!/usr/bin/env bash
# verify.sh — a Lambda permission lost with its fixed-name function's
# same-id recreate is re-created (issue #4411).
#
# The function has a FIXED name, so `--recreate-via-cc-api` destroys it first
# and the new function holds the same id. Its `AWS::Lambda::Permission` is a
# statement of the function's resource-based policy and goes with the old
# function, while its `FunctionName` resolves exactly as recorded. Phases:
# deploy on the SDK route -> the policy holds the statement -> premise: the
# template diffs to no changes -> recreate the function on Cloud Control ->
# premise: the function really was re-created (its LastModified moved) ->
# THE ARM: `get-policy` holds the statement again, and state records the
# permission -> destroy + gone-probes.
#
# Before the fix the permission was skipped as unchanged: `get-policy`
# answered ResourceNotFoundException after a green deploy.

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

STACK="CdkdRecreateParentChildPermissionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="${STACK}-fn"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
FN_LOGICAL_ID=""

# The state record of one resource, matched by logical-id PREFIX. Hard-fails
# on no match: a guessed key would make every assertion read `null`.
record() { # usage: record <logical-id-prefix> <jq-expression-over-the-resource-object>
  local json key
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  key=$(printf '%s' "${json}" | jq -r --arg p "$1" \
    '.resources | keys[] | select(startswith($p))' | head -1)
  [ -n "${key}" ] || { echo "FAIL: no state resource whose logical id starts with $1" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "${key}" ".resources[\$k] | $2"
}

# The number of statements in the function's resource-based policy whose
# principal is SNS: 0 when the function has no policy at all (the bug).
sns_statements() {
  local out
  if ! out=$(aws lambda get-policy --function-name "${FN_NAME}" --region "${REGION}" \
      --query Policy --output text 2>&1); then
    if printf '%s' "${out}" | grep -q 'ResourceNotFoundException'; then
      echo 0
      return 0
    fi
    echo "FAIL: get-policy failed: ${out}" >&2
    exit 1
  fi
  printf '%s' "${out}" | jq '[.Statement[] | select(.Principal.Service == "sns.amazonaws.com")] | length'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The execution role's name is generated from the stack name. An empty
  # STACK would widen the prefix to every role, so the guard refuses it.
  case "${STACK}" in
    CdkdRecreateParentChildPermission?*)
      for role in $(aws iam list-roles \
          --query "Roles[?starts_with(RoleName, '${STACK}')].RoleName" --output text 2>/dev/null); do
        for inline in $(aws iam list-role-policies --role-name "${role}" \
            --query 'PolicyNames[]' --output text 2>/dev/null); do
          aws iam delete-role-policy --role-name "${role}" --policy-name "${inline}" >/dev/null 2>&1 || true
        done
        aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
      done
      ;;
    *) echo "    WARN: teardown sweep refused a stack scope outside CdkdRecreateParentChildPermission*: '${STACK:-<empty>}'" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
FN_LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::Lambda::Function") | .key' "${TEMPLATE}" | head -1)
[ -n "${FN_LOGICAL_ID}" ] || { echo "FAIL: no AWS::Lambda::Function in ${TEMPLATE}" >&2; exit 1; }
echo "==> Recreate target: ${FN_LOGICAL_ID}"

echo "==> Phase 1: Deploy (SDK route)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

LAYER0=$(record "${FN_LOGICAL_ID}" '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0} for the function, expected sdk" >&2; exit 1; }
P0=$(record "${FN_LOGICAL_ID}" '.physicalId')
[ "${P0}" = "${FN_NAME}" ] || { echo "FAIL: the function's physical id is ${P0}, expected its fixed name ${FN_NAME}" >&2; exit 1; }
S0=$(sns_statements)
[ "${S0}" = "1" ] || { echo "FAIL: phase 1: the function's policy holds ${S0} SNS statement(s), expected 1" >&2; exit 1; }
M0=$(aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" \
  --query Configuration.LastModified --output text)
[ -n "${M0}" ] || { echo "FAIL: no LastModified for ${FN_NAME}" >&2; exit 1; }
echo "    OK: function ${P0} on the SDK route, its policy holds the permission"

echo "==> Phase 2: premise -- the template diffs to no changes"
set +e
PREMISE_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
PREMISE_RC=$?
set -e
[ "${PREMISE_RC}" -eq 0 ] || {
  printf '%s\n' "${PREMISE_OUT}" >&2
  echo "FAIL: premise: cdkd diff --fail exited ${PREMISE_RC} (expected 0, no changes)" >&2
  exit 1
}
echo "    OK: no template change"

echo "==> Phase 3: THE ARM -- recreate the fixed-name function; its permission must come back"
RECREATE_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --recreate-via-cc-api "${FN_LOGICAL_ID}" --yes 2>&1) || {
  printf '%s\n' "${RECREATE_OUT}" >&2
  echo "FAIL: the --recreate-via-cc-api deploy failed" >&2
  exit 1
}
printf '%s\n' "${RECREATE_OUT}"

LAYER1=$(record "${FN_LOGICAL_ID}" '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: the function record says provisionedBy=${LAYER1} after the recreate, expected cc-api" >&2; exit 1; }
P1=$(record "${FN_LOGICAL_ID}" '.physicalId')
[ "${P1}" = "${P0}" ] || { echo "FAIL: premise: the recreate changed the function's id (${P0} -> ${P1}); a fixed name must keep it, so this run would not witness issue #4411" >&2; exit 1; }
# PREMISE: the function really was destroyed and re-created, so its policy
# really went with it. An unchanged LastModified would mean nothing happened
# and the policy check below would pass on a binary without the fix.
M1=$(aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" \
  --query Configuration.LastModified --output text)
[ "${M1}" != "${M0}" ] || { echo "FAIL: premise: the function's LastModified did not move (${M0}); it was not re-created" >&2; exit 1; }

S1=$(sns_statements)
[ "${S1}" = "1" ] || { echo "FAIL: the recreated function's policy holds ${S1} SNS statement(s), expected 1 -- the permission that went with the old function was not re-created (issue #4411)" >&2; exit 1; }
PERM_ID=$(record "ChildPermission" '.physicalId')
[ -n "${PERM_ID}" ] && [ "${PERM_ID}" != "null" ] || { echo "FAIL: no state record for the permission" >&2; exit 1; }
grep -q 'No changes detected' <<<"${RECREATE_OUT}" && {
  echo "FAIL: the deploy recreated the function but reported 'No changes detected'" >&2
  exit 1
}
echo "    OK: function recreated on Cloud Control under ${P1}; its permission re-created"

echo "==> Phase 4: Destroy + gone-probes"
ROLE_NAME=$(record "FnRole" '.physicalId')
[ -n "${ROLE_NAME}" ] && [ "${ROLE_NAME}" != "null" ] || { echo "FAIL: no state record for the execution role" >&2; exit 1; }
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "Lambda function ${FN_NAME} survived destroy" \
  aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "IAM role ${ROLE_NAME} survived destroy" \
  aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
echo "    OK: destroyed clean"

echo "[verify] PASS — recreate-parent-child-permission (a fixed-name function's recreate keeps its permission)"
