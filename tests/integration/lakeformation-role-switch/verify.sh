#!/usr/bin/env bash
# verify.sh -- an AWS::LakeFormation::Resource switching from the service-linked
# role to its own role updates in place (issue #7121).
#
# Lake Formation's UpdateResource refuses to move a registration off the
# service-linked role ("Resource managed by Service Linked Role"), and Cloud
# Control's update calls it. CloudFormation applies the same change in place by
# DeregisterResource + RegisterResource (measured via CloudTrail); cdkd now does
# the same through Cloud Control's delete + create.
# Phases:
#   1. deploy: the bucket registered with the service-linked role;
#   2. deploy `own`: registered with the stack's own role, same location ARN;
#   3. deploy the default again: back on the service-linked role (Cloud
#      Control's own update applies this direction);
#   4. destroy: the registration, the role, the bucket and the state are gone.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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

STACK="CdkdLakeFormationRoleSwitchExample"
REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-integ-lf-role-switch-${ACCOUNT}-${REGION}"
LOCATION_ARN="arn:aws:s3:::${BUCKET}"
ROLE_NAME="CdkdLfRoleSwitch-${REGION}"
SLR_PATH=":role/aws-service-role/lakeformation.amazonaws.com/"
unset CDKD_TEST_UPDATE

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -n "${CLEANUP_FILES:-}" ] && rm -f "${CLEANUP_FILES}"
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${ACCOUNT}" ]; then
    aws lakeformation deregister-resource --resource-arn "${LOCATION_ARN}" --region "${REGION}" >/dev/null 2>&1
    aws s3 rb "s3://${BUCKET}" --force --region "${REGION}" >/dev/null 2>&1
  fi
  for p in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${p}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -n "${ACCOUNT}" ] || { echo "FAIL: could not read the account id" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
registration_id() {
  state_field '[.resources | to_entries[] | select(.value.resourceType == "AWS::LakeFormation::Resource")][0].value.physicalId // ""'
}
live_role() {
  aws lakeformation describe-resource --resource-arn "${LOCATION_ARN}" --region "${REGION}" \
    --query ResourceInfo.RoleArn --output text
}
DEPLOY_LOG="$(mktemp)"
CLEANUP_FILES="${DEPLOY_LOG}"
plain() { sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}"; }

echo "==> Phase 1: deploy, registered with the service-linked role"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(registration_id)" = "${LOCATION_ARN}" ] || {
  echo "FAIL: phase 1: the registration recorded '$(registration_id)', expected ${LOCATION_ARN}" >&2; exit 1; }
ROLE1="$(live_role)"
case "${ROLE1}" in *"${SLR_PATH}"*) ;; *)
  echo "FAIL: phase 1: the location is registered with '${ROLE1}', not the service-linked role" >&2; exit 1 ;; esac
echo "    OK: ${LOCATION_ARN} registered with the service-linked role"

echo "==> Phase 2: switch to the stack's own role"
OWN_ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
set +e
CDKD_TEST_UPDATE=own node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
rc=${PIPESTATUS[0]}
set -e
if [ "${rc}" != "0" ]; then
  if plain | grep -q "Resource managed by Service Linked Role"; then
    echo "FAIL: phase 2: the switch off the service-linked role was sent to Lake Formation's UpdateResource, which refuses it (go-to-k/cdkd#7121)" >&2
  else
    echo "FAIL: phase 2: the deploy exited ${rc}" >&2
  fi
  exit 1
fi
ROLE2="$(live_role)"
[ "${ROLE2}" = "${OWN_ROLE_ARN}" ] || {
  echo "FAIL: phase 2: the location is registered with '${ROLE2}', expected the stack's own role ${OWN_ROLE_ARN} (go-to-k/cdkd#7121)" >&2; exit 1; }
[ "$(registration_id)" = "${LOCATION_ARN}" ] || {
  echo "FAIL: phase 2: the registration's record moved to '$(registration_id)'" >&2; exit 1; }
plain | grep -q "deregistering and registering it with its own role" || {
  echo "FAIL: phase 2: the deploy did not take the re-register route (if cdkd reworded its line, update this check)" >&2; exit 1; }
echo "    OK: re-registered in place with ${OWN_ROLE_ARN}"

echo "==> Phase 3: back to the service-linked role"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
ROLE3="$(live_role)"
case "${ROLE3}" in *"${SLR_PATH}"*) ;; *)
  echo "FAIL: phase 3: the location is registered with '${ROLE3}', not the service-linked role" >&2; exit 1 ;; esac
[ "$(registration_id)" = "${LOCATION_ARN}" ] || {
  echo "FAIL: phase 3: the registration's record moved to '$(registration_id)'" >&2; exit 1; }
echo "    OK: back on the service-linked role"

echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "the Lake Formation registration of ${LOCATION_ARN} still exists after destroy" \
  aws lakeformation describe-resource --resource-arn "${LOCATION_ARN}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}"
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: nothing of the stack left"

echo ""
echo "[verify] PASS — a Lake Formation location switches off the service-linked role in place, and back"
