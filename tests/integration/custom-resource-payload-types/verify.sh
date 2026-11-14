#!/usr/bin/env bash
# verify.sh — custom resource payload JSON types (go-to-k/cdkd#6309).
#
# The `Echo` custom resource's handler writes the payload it receives to an
# SSM parameter per request type (`<prefix>/Create`, `/Update`, `/Delete`).
# Each is compared with what CloudFormation delivered for the same template
# (measured for #6309): template literals as strings, `Fn::GetAtt` values with
# their JSON type, a custom resource's scalar attribute as a string.
#
# Phases: 1 deploy (Create), 2 redeploy with `CDKD_TEST_PHASE=two` (Update,
# both sides), 3 destroy (Delete), each followed by its assertion.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

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

STACK="CdkdCrPayloadTypes"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Fixed names (see lib/cr-payload-types-stack.ts).
PREFIX="/cdkd-integ/cr-payload-types"
FUNCTION_NAME="CdkdIntegCrPayloadTypesEcho"
LOG_GROUP="/aws/lambda/${FUNCTION_NAME}"
POLICY_NAME="CdkdIntegCrPayloadTypesPol"
ROLE_NAME="CdkdIntegCrPayloadTypesRole"
ECHO_PARAMS="${PREFIX}/Create ${PREFIX}/Update ${PREFIX}/Delete"

# What CloudFormation delivered for this template's `Echo` properties, minus
# `ServiceToken` and `Phase` (go-to-k/cdkd#6309, us-east-1). `jq -S` sorts the
# keys on both sides; list order is the template's and is significant.
EXPECTED='{
  "A_LitBool": "true", "A_LitFloat": "1.5", "A_LitNum": "5", "A_LitStr": "hello",
  "B_GaBool": true, "B_GaCount": 0, "B_GaCrBool": "true", "B_GaCrNum": "5",
  "B_GaCrObj": {"n": 5},
  "C_RefNum": "7", "C_RefNumList": ["1", "2"],
  "D_IfBool": "true", "D_IfGa": 0, "D_IfLit": "5", "D_MapBool": "true",
  "D_MapNum": "9", "D_SelGa": 0, "D_SelLit": "5",
  "E_LitList": ["5", "true", "x"], "E_LitListObj": [{"b": "true", "n": "5"}],
  "E_LitObj": {"b": "true", "deep": {"n": "6"}, "n": "5", "s": "x"},
  "F_GaInList": [0, true, "5"], "F_GaInObj": {"b": true, "lit": "5", "n": 0}
}'

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  for p in ${ECHO_PARAMS}; do
    aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --region "${REGION}" --function-name "${FUNCTION_NAME}" >/dev/null 2>&1 || true
  aws logs delete-log-group --region "${REGION}" --log-group-name "${LOG_GROUP}" >/dev/null 2>&1 || true
  # The role holds inline policies only (lib/cr-payload-types-stack.ts).
  local inline
  for inline in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${inline}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1 || true
  local account
  account=$(aws sts get-caller-identity --query Account --output text 2>/dev/null)
  if [ -n "${account}" ]; then
    aws iam delete-policy --policy-arn "arn:aws:iam::${account}:policy/${POLICY_NAME}" >/dev/null 2>&1 || true
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

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
POLICY_ARN="arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# The payload the handler recorded for one request type, as JSON.
echoed() { # usage: echoed <RequestType>
  aws ssm get-parameter --region "${REGION}" --name "${PREFIX}/$1" \
    --query Parameter.Value --output text
}

# Compare one side of a recorded payload with EXPECTED and its Phase.
assert_side() { # usage: assert_side <label> <payload-json> <side> <phase>
  local label="$1" payload="$2" side="$3" phase="$4" actual expected got_phase
  got_phase=$(jq -r --arg s "${side}" '.[$s].Phase // "<absent>"' <<<"${payload}") || return 1
  if [ "${got_phase}" != "${phase}" ]; then
    echo "FAIL: ${label} ${side}.Phase is '${got_phase}', expected '${phase}'" >&2
    exit 1
  fi
  actual=$(jq -S --arg s "${side}" '.[$s] | del(.ServiceToken, .Phase)' <<<"${payload}") || return 1
  expected=$(jq -S . <<<"${EXPECTED}") || return 1
  if [ "${actual}" != "${expected}" ]; then
    echo "FAIL: ${label} ${side} differs from what CloudFormation delivers (#6309)" >&2
    diff <(printf '%s\n' "${expected}") <(printf '%s\n' "${actual}") >&2 || true
    exit 1
  fi
  echo "    OK: ${label} ${side} matches CloudFormation's types"
}

# --- Phase 1: deploy (Create) ----------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
# Premise: the record carries the coordinates a later Update / Delete reads.
LEAVES=$(jq -c '.resources.Echo.typedPayloadLeaves // "absent"' <<<"${STATE}")
if [ "${LEAVES}" = '"absent"' ] || [ "${LEAVES}" = '[]' ]; then
  echo "FAIL: the Echo record carries no typedPayloadLeaves (got ${LEAVES})" >&2
  exit 1
fi
echo "    OK: Echo record typedPayloadLeaves = ${LEAVES}"

CREATE=$(echoed Create)
assert_side "Create" "${CREATE}" ResourceProperties one

# --- Phase 2: redeploy (Update) --------------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_PHASE=two"
CDKD_TEST_PHASE=two node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

UPDATE=$(echoed Update)
assert_side "Update" "${UPDATE}" ResourceProperties two
assert_side "Update" "${UPDATE}" OldResourceProperties one

# --- Phase 3: destroy (Delete) ---------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_PHASE=two node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

DELETE=$(echoed Delete)
assert_side "Delete" "${DELETE}" ResourceProperties two

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "Lambda ${FUNCTION_NAME} still exists after destroy (orphan)" aws lambda get-function --region "${REGION}" --function-name "${FUNCTION_NAME}"
# No race: the role lacks logs:CreateLogGroup, so a log write delivered after
# the destroy cannot re-create the group.
assert_gone "log group ${LOG_GROUP} still exists after destroy (orphan)" aws logs describe-log-streams --region "${REGION}" --log-group-name "${LOG_GROUP}"
assert_gone "managed policy ${POLICY_NAME} still exists after destroy (orphan)" aws iam get-policy --policy-arn "${POLICY_ARN}"
assert_gone "role ${ROLE_NAME} still exists after destroy (orphan)" aws iam get-role --role-name "${ROLE_NAME}"
echo "    OK: every stack resource is gone"

# The handler's records are not stack resources: verify.sh owns them.
for p in ${ECHO_PARAMS}; do
  aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null
  assert_gone "SSM parameter ${p} still exists" aws ssm get-parameter --region "${REGION}" --name "${p}"
done
echo "    OK: the echo parameters are gone"

echo ""
echo "=== PASS: custom resource payload JSON types integ ==="
