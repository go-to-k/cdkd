#!/usr/bin/env bash
# verify.sh -- an old security group a deploy could not delete is deleted
# before the VPC on `cdkd destroy` (issue #7073).
#
# `cdkd destroy` deleted every superseded old copy (other than a custom
# resource's) only after all of the stack's own resources, so an old security
# group still lived in the VPC when the VPC was deleted: the VPC delete waited
# about 5 minutes, failed DependencyViolation, and the destroy exited 2 with
# state preserved until a re-run.
# Phases:
#   1. deploy v1: a VPC (one isolated subnet) and a security group;
#   2. an out-of-band network interface in the subnet holds the v1 group; deploy
#      v2 (the group's description changes, which replaces it): the old group's
#      delete fails, so state keeps it in supersededResources (premise);
#   3. the interface is deleted, freeing the old group; ONE `cdkd destroy`
#      exits 0 (THE ARM; pre-fix: exit 2 on the VPC's DependencyViolation), and
#      no group, VPC or state file of this fixture is left.
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

STACK="CdkdSupersededSgDestroyOrderExample"
REGION="${AWS_REGION:-us-east-1}"
FIXTURE_TAG="superseded-sg-destroy-order"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
unset CDKD_TEST_UPDATE

# This fixture's VPCs, by tag (one normally; a crashed earlier run may leave more).
fixture_vpcs() { # usage: fixture_vpcs -- ids, one per line, or a hard failure
  aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
    --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | awk 'NF'
}
# This fixture's out-of-band network interfaces, by tag.
fixture_enis() { # usage: fixture_enis -- ids, one per line, or a hard failure
  aws ec2 describe-network-interfaces --region "${REGION}" \
    --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
    --query 'NetworkInterfaces[].NetworkInterfaceId' --output text | tr '\t' '\n' | awk 'NF'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -n "${CLEANUP_FILES:-}" ] && rm -f ${CLEANUP_FILES}
  for eni in $(fixture_enis 2>/dev/null); do
    case "${eni}" in eni-?*) aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
  done
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for vpc in $(fixture_vpcs); do
    case "${vpc}" in
      vpc-?*)
        for gid in $(aws ec2 describe-security-groups --region "${REGION}" \
          --filters "Name=vpc-id,Values=${vpc}" \
          --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
          case "${gid}" in sg-?*) aws ec2 delete-security-group --group-id "${gid}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
        done
        for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
          --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
          case "${subnet}" in subnet-?*) aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
        done
        for rtb in $(aws ec2 describe-route-tables --region "${REGION}" \
          --filters "Name=vpc-id,Values=${vpc}" \
          --query 'RouteTables[?!(Associations[?Main])].RouteTableId' --output text 2>/dev/null); do
          case "${rtb}" in rtb-?*) aws ec2 delete-route-table --route-table-id "${rtb}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
        done
        aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1 || true ;;
    esac
  done
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
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
# The one record of <type>: its physical id, or '' when state holds not exactly one.
only_physical_id() { # usage: only_physical_id <resource type>
  state_field "[.resources[] | select(.resourceType == \"$1\") | .physicalId] | if length == 1 then .[0] else \"\" end"
}
deploy() { # usage: deploy <phase> <log file>
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "$2" || {
    echo "FAIL: $1: deploy failed" >&2
    return 1
  }
}
DEPLOY_LOG="$(mktemp)"
DESTROY_LOG="$(mktemp)"
CLEANUP_FILES="${DEPLOY_LOG} ${DESTROY_LOG}"

echo "==> Phase 1: deploy v1"
deploy "phase 1" "${DEPLOY_LOG}"
GROUP_LID="$(state_field '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .key] | if length == 1 then .[0] else "" end')"
[ -n "${GROUP_LID}" ] || { echo "FAIL: phase 1 premise: state does not hold exactly one AWS::EC2::SecurityGroup" >&2; exit 1; }
OLD_SG="$(only_physical_id AWS::EC2::SecurityGroup)"
VPC_ID="$(only_physical_id AWS::EC2::VPC)"
SUBNET_ID="$(only_physical_id AWS::EC2::Subnet)"
case "${OLD_SG}" in sg-?*) ;; *) echo "FAIL: phase 1: the group recorded '${OLD_SG}'" >&2; exit 1 ;; esac
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: phase 1: the VPC recorded '${VPC_ID}'" >&2; exit 1 ;; esac
case "${SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: phase 1: the subnet recorded '${SUBNET_ID}'" >&2; exit 1 ;; esac
VPC_LID="$(state_field '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .key] | .[0] // ""')"
[ "$(state_field ".resources[\"${GROUP_LID}\"].dependencies // [] | index(\"${VPC_LID}\") != null")" = "true" ] || {
  echo "FAIL: phase 1 premise: ${GROUP_LID}'s record does not depend on ${VPC_LID}" >&2; exit 1; }
echo "    OK: group ${OLD_SG} in ${VPC_ID}"

echo "==> Phase 2: an out-of-band interface holds ${OLD_SG}; deploy v2 replaces the group"
ENI_ID="$(aws ec2 create-network-interface --region "${REGION}" --subnet-id "${SUBNET_ID}" --groups "${OLD_SG}" \
  --description "cdkd integ ${FIXTURE_TAG}: holds the v1 group" \
  --tag-specifications "ResourceType=network-interface,Tags=[{Key=cdkd-integ,Value=${FIXTURE_TAG}}]" \
  --query 'NetworkInterface.NetworkInterfaceId' --output text)"
case "${ENI_ID}" in eni-?*) ;; *) echo "FAIL: phase 2 premise: no network interface was created ('${ENI_ID}')" >&2; exit 1 ;; esac
export CDKD_TEST_UPDATE=v2
set +e
deploy "phase 2" "${DEPLOY_LOG}"
DEPLOY_RC=$?
set -e
echo "    deploy v2 exited ${DEPLOY_RC}"
NEW_SG="$(state_field ".resources[\"${GROUP_LID}\"].physicalId // \"\"")"
case "${NEW_SG}" in sg-?*) ;; *) echo "FAIL: phase 2: ${GROUP_LID} recorded '${NEW_SG}'" >&2; exit 1 ;; esac
[ "${NEW_SG}" != "${OLD_SG}" ] || { echo "FAIL: phase 2 premise: ${GROUP_LID} was not replaced (still ${OLD_SG})" >&2; exit 1; }
KEPT="$(state_field "[(.supersededResources // [])[] | select(.logicalId == \"${GROUP_LID}\") | .state.physicalId] | join(\",\")")"
[ "${KEPT}" = "${OLD_SG}" ] || {
  echo "FAIL: phase 2 premise: supersededResources holds '${KEPT}' for ${GROUP_LID}, expected ${OLD_SG} (its delete was to fail while the interface holds it)" >&2
  exit 1
}
[ "$(state_field "[(.supersededResources // [])[] | select(.logicalId == \"${GROUP_LID}\") | .state.dependencies // [] | index(\"${VPC_LID}\") != null] | .[0]")" = "true" ] || {
  echo "FAIL: phase 2 premise: the superseded record does not depend on ${VPC_LID}" >&2; exit 1; }
aws ec2 describe-security-groups --region "${REGION}" --group-ids "${OLD_SG}" --query 'SecurityGroups[0].GroupId' --output text | grep -qx "${OLD_SG}" || {
  echo "FAIL: phase 2 premise: ${OLD_SG} is gone" >&2; exit 1; }
echo "    OK: ${GROUP_LID} replaced by ${NEW_SG}; ${OLD_SG} kept in supersededResources"

echo "==> Phase 3: the interface is deleted; one destroy removes the stack"
aws ec2 delete-network-interface --region "${REGION}" --network-interface-id "${ENI_ID}"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  gone_probe aws ec2 describe-network-interfaces --region "${REGION}" --network-interface-ids "${ENI_ID}" && break
  sleep 5
done
assert_gone "phase 3 premise: interface ${ENI_ID} still exists" \
  aws ec2 describe-network-interfaces --region "${REGION}" --network-interface-ids "${ENI_ID}"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1 | tee "${DESTROY_LOG}"
DESTROY_RC=${PIPESTATUS[0]}
set -e
# THE ARM: pre-fix, the VPC was deleted while the old group still lived in it.
[ "${DESTROY_RC}" = "0" ] || {
  echo "FAIL: phase 3: cdkd destroy exited ${DESTROY_RC}, expected 0 (go-to-k/cdkd#7073: the superseded group was deleted after the VPC)" >&2
  exit 1
}
if sed 's/\x1b\[[0-9;]*m//g' "${DESTROY_LOG}" | grep -q 'partially destroyed'; then
  echo "FAIL: phase 3: the destroy reported the stack partially destroyed" >&2; exit 1
fi
assert_gone "old group ${OLD_SG} still exists after destroy" \
  aws ec2 describe-security-groups --group-ids "${OLD_SG}" --region "${REGION}"
assert_gone "group ${NEW_SG} still exists after destroy" \
  aws ec2 describe-security-groups --group-ids "${NEW_SG}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LEFT="$(fixture_vpcs)"
[ -z "${LEFT}" ] || { echo "FAIL: VPCs of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: one destroy deleted the old group before the VPC; nothing left"

echo ""
echo "[verify] PASS — a superseded security group is deleted before its VPC on destroy"
