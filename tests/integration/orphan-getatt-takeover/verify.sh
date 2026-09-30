#!/usr/bin/env bash
# verify.sh — `cdkd orphan` after an out-of-band NAME takeover (issue #4186).
#
# `cdkd orphan` rewrites every sibling `Fn::GetAtt` to the orphaned resource
# into a literal. It used to take that literal from a LIVE
# `provider.getAttribute(...)`, which most SDK providers address by the
# recorded NAME: once the resource was deleted out of band and another one took
# its name, the rewrite planted the NEWCOMER's attribute into the sibling's
# state. It now takes the orphan's RECORDED attribute whenever the resolver
# would, and reads live only otherwise.
#
# Phases:
#   1. Deploy an IAM role with a fixed name and an SSM parameter whose value is
#      `Fn::GetAtt [Role, RoleId]`. Assert the recorded RoleId equals the live
#      one and the parameter holds it.
#   1b. A deploy persists RESOLVED properties, so the parameter row holds the
#      id, not the intrinsic. The rewrite acts on a row whose intrinsic
#      SURVIVED (a `cdkd import` that could not resolve it, a pre-v3 record),
#      so the row is put in that shape by hand: its `Value` becomes
#      `{"Fn::GetAtt": [<role>, "RoleId"]}` again.
#   2. Take the name over: delete the role out of band and create another under
#      the same name. Assert its RoleId DIFFERS from the recorded one (premise).
#   3. `cdkd orphan <stack>/Role`.
#   4. LOAD-BEARING: the parameter's state row holds the RECORDED RoleId as a
#      literal, never the newcomer's.
#   5. Destroy, delete the takeover role, assert nothing is left.
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

STACK="CdkdOrphanGetattTakeoverExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="cdkd-orphan-getatt-takeover-role"
PARAMETER_NAME="/cdkd-integ/orphan-getatt-takeover/role-id"
TRUST_POLICY='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="${TMPDIR:-/tmp}/cdkd-4186-orphan.$$.log"

DEPLOYED=0
# Set only once the pre-flight proved the role name free, so an early exit
# never deletes a role this run did not create (a concurrent run's included).
ROLE_OWNED=0

# Best-effort, subshell under `set +eu` so the trap never re-arms strict mode.
delete_role_best_effort() {
  (
    set +eu
    aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
    true
  )
}

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +eu
  if [ "${DEPLOYED}" = "1" ] && [ -f "${LOCAL_DIST}" ]; then
    AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    aws ssm delete-parameter --region "${REGION}" --name "${PARAMETER_NAME}" >/dev/null 2>&1
  fi
  # The fixed name covers the stack's role AND the takeover role: at most one
  # of them exists at a time.
  [ "${ROLE_OWNED}" = "1" ] && delete_role_best_effort
  rm -f "${LOG}" 2>/dev/null
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

# Read one value out of the stack's state.json. `$1` is a JS expression over
# `st` (the parsed state); an empty string prints for undefined.
state_query() {
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  printf '%s' "${body}" | node -e '
    let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
      const st = JSON.parse(s);
      const v = (0, eval)("(st) => (" + process.argv[1] + ")")(st);
      process.stdout.write(v === undefined ? "" : typeof v === "string" ? v : JSON.stringify(v));
    });' "$1"
}
# The logical id CDK generated for each resource, found by type.
logical_id_of_type() {
  state_query "Object.keys(st.resources).find((k) => st.resources[k].resourceType === '$1')"
}

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight"
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: state already exists at ${STATE_KEY} - clean up first." >&2
  exit 1
fi
if ! gone_probe aws iam get-role --role-name "${ROLE_NAME}"; then
  echo "FAIL: role ${ROLE_NAME} already exists - clean up first." >&2
  exit 1
fi

echo "==> Phase 1: deploy"
DEPLOYED=1
ROLE_OWNED=1
AWS_REGION="${REGION}" env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --region "${REGION}" --state-bucket "${STATE_BUCKET}" > "${LOG}" 2>&1 || {
  echo "FAIL: deploy failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
ROLE_LID="$(logical_id_of_type 'AWS::IAM::Role')"
PARAM_LID="$(logical_id_of_type 'AWS::SSM::Parameter')"
if [ -z "${ROLE_LID}" ] || [ -z "${PARAM_LID}" ]; then
  echo "FAIL: state lacks the role or the parameter row (role='${ROLE_LID}', param='${PARAM_LID}')" >&2
  exit 1
fi
RECORDED_ID="$(state_query "st.resources['${ROLE_LID}'].attributes?.RoleId")"
LIVE_ID="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ -z "${RECORDED_ID}" ] || [ "${RECORDED_ID}" != "${LIVE_ID}" ]; then
  echo "FAIL: premise: recorded RoleId '${RECORDED_ID}' is not the live '${LIVE_ID}'" >&2
  exit 1
fi
PARAM_VALUE="$(aws ssm get-parameter --region "${REGION}" --name "${PARAMETER_NAME}" \
  --query 'Parameter.Value' --output text)"
if [ "${PARAM_VALUE}" != "${RECORDED_ID}" ]; then
  echo "FAIL: the parameter holds '${PARAM_VALUE}', expected the role's id '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: RoleId ${RECORDED_ID} recorded, live, and deployed into the parameter"

echo "==> Phase 1b: put the parameter row back into its unresolved-intrinsic shape"
STATE_BODY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
printf '%s' "${STATE_BODY}" | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const st = JSON.parse(s);
    st.resources[process.argv[1]].properties.Value = { "Fn::GetAtt": [process.argv[2], "RoleId"] };
    process.stdout.write(JSON.stringify(st));
  });' "${PARAM_LID}" "${ROLE_LID}" > "${LOG}"
aws s3 cp "${LOG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
PARAM_BEFORE="$(state_query "JSON.stringify(st.resources['${PARAM_LID}'].properties.Value)")"
case "${PARAM_BEFORE}" in
  *Fn::GetAtt*) ;;
  *)
    echo "FAIL: premise: the parameter's state row holds no Fn::GetAtt (${PARAM_BEFORE})" >&2
    exit 1
    ;;
esac
echo "    OK: ${PARAM_LID}.Value = ${PARAM_BEFORE}"

echo "==> Phase 2: take the role's name over out of band"
aws iam delete-role --role-name "${ROLE_NAME}"
# IAM is eventually consistent: the name can read as taken for a moment after
# the delete. Retried a bounded number of times, then the last error stands.
for attempt in 1 2 3 4 5; do
  if aws iam create-role --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "${TRUST_POLICY}" >/dev/null 2>"${LOG}"; then
    break
  fi
  if [ "${attempt}" = "5" ]; then
    echo "FAIL: could not re-create ${ROLE_NAME}: $(cat "${LOG}")" >&2
    exit 1
  fi
  sleep 5
done
NEW_ID="$(aws iam get-role --role-name "${ROLE_NAME}" --query 'Role.RoleId' --output text)"
if [ -z "${NEW_ID}" ] || [ "${NEW_ID}" = "${RECORDED_ID}" ]; then
  echo "FAIL: premise: the takeover role's id '${NEW_ID}' does not differ from '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: ${ROLE_NAME} is now held by ${NEW_ID}"

echo "==> Phase 3: cdkd orphan ${STACK}/Role"
AWS_REGION="${REGION}" env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" orphan "${STACK}/Role" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --yes > "${LOG}" 2>&1 || {
  echo "FAIL: cdkd orphan failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
if [ -n "$(logical_id_of_type 'AWS::IAM::Role')" ]; then
  echo "FAIL: the role row is still in state after 'cdkd orphan'" >&2
  exit 1
fi

echo "==> Phase 4 (LOAD-BEARING, issue #4186): the parameter row holds the RECORDED RoleId"
PARAM_AFTER="$(state_query "st.resources['${PARAM_LID}'].properties.Value")"
if [ "${PARAM_AFTER}" = "${NEW_ID}" ]; then
  echo "FAIL: 'cdkd orphan' planted the TAKEOVER role's id ${NEW_ID} into ${PARAM_LID}" >&2
  exit 1
fi
if [ "${PARAM_AFTER}" != "${RECORDED_ID}" ]; then
  echo "FAIL: ${PARAM_LID}'s Value is '${PARAM_AFTER}', expected the recorded '${RECORDED_ID}'" >&2
  exit 1
fi
echo "    OK: ${PARAM_LID}.Value = ${PARAM_AFTER}"

echo "==> Phase 5: destroy, then remove the takeover role"
AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" --region "${REGION}" \
  --state-bucket "${STATE_BUCKET}" --force > "${LOG}" 2>&1 || {
  echo "FAIL: destroy failed" >&2
  tail -60 "${LOG}" >&2
  exit 1
}
DEPLOYED=0
# `cdkd orphan` leaves the role in AWS by design; this one is the takeover.
aws iam delete-role --role-name "${ROLE_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "parameter ${PARAMETER_NAME} still exists after destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${PARAMETER_NAME}"
assert_gone "role ${ROLE_NAME} still exists" aws iam get-role --role-name "${ROLE_NAME}"

trap - EXIT INT TERM
rm -f "${LOG}"
echo "[verify] PASS — cdkd orphan substituted the recorded RoleId after a name takeover"
