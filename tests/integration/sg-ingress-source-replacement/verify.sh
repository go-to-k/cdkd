#!/usr/bin/env bash
# verify.sh -- a standalone SecurityGroupIngress whose source changes is
# replaced, and a rolled-back replacement leaves no rule behind (issue #7071).
#
# The rule's physical id is <GroupId>|<IpProtocol>|<FromPort>|<ToPort>, with no
# source, so the new rule of a source change has the old rule's id. cdkd read
# that as "the create returned the existing rule" and refused the deploy; the
# new rule stayed authorized, recorded nowhere, and the rollback left it.
# CloudFormation replaces the rule (measured: UPDATE_COMPLETE, new sgr- ids,
# only the new rules left).
# Phases:
#   1. deploy v1: Dst admits 2049 from Src and 443 from 198.51.100.0/24;
#   2. deploy `fail` (Src replaced, InCidr moved to 192.0.2.0/24, then a queue
#      AWS refuses): the deploy fails and rolls back; Dst holds exactly the v1
#      rules again (pre-fix: InCidr refused as a name-idempotent create and
#      192.0.2.0/24 left open on Dst), state records them, drift is clean;
#   3. deploy v2: succeeds; Dst holds exactly 2049 from the new Src and 443 from
#      192.0.2.0/24, each recorded under its new sgr- id; the old Src is gone;
#      drift is clean;
#   4. destroy: no group, VPC or state file of this fixture left.
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

STACK="CdkdSgIngressSourceReplacementExample"
REGION="${AWS_REGION:-us-east-1}"
FIXTURE_TAG="sg-ingress-source-replacement"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
unset CDKD_TEST_UPDATE

# This fixture's VPCs, by tag (one normally; a crashed earlier run may leave more).
fixture_vpcs() { # usage: fixture_vpcs -- ids, one per line, or a hard failure
  aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
    --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | awk 'NF'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -n "${CLEANUP_FILES:-}" ] && rm -f "${CLEANUP_FILES}"
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
# Every ingress rule of <group> on <port>, one `<sgr id> <source>` per line,
# sorted; <source> is the CIDR or the referenced group id.
port_rules() { # usage: port_rules <group id> <port>
  local out
  out="$(aws ec2 describe-security-group-rules --region "${REGION}" \
    --filters "Name=group-id,Values=$1" \
    --query "SecurityGroupRules[?IsEgress==\`false\` && FromPort==\`$2\`].[SecurityGroupRuleId, CidrIpv4 || ReferencedGroupInfo.GroupId]" \
    --output text)" || return 1
  printf '%s\n' "${out}" | awk 'NF' | LC_ALL=C sort
}
# <group> admits exactly one rule on <port>, from <source>; prints its sgr- id.
only_rule() { # usage: only_rule <phase> <group id> <port> <source>
  local rules
  rules="$(port_rules "$2" "$3")" || return 1
  [ "$(printf '%s\n' "${rules}" | awk 'NF' | wc -l | tr -d ' ')" = "1" ] \
    && [ "$(printf '%s\n' "${rules}" | awk '{print $2}')" = "$4" ] || {
    echo "FAIL: $1: ${2} does not admit exactly one rule on $3 from $4 (go-to-k/cdkd#7071): '${rules}'" >&2
    return 1
  }
  printf '%s\n' "${rules}" | awk '{print $1}'
}
deploy() { # usage: deploy <log file>
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "$1"
}
drift_clean() { # usage: drift_clean <phase>
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
  local rc=$?
  set -e
  [ "${rc}" = "0" ] || { echo "FAIL: $1: cdkd drift exited ${rc}, expected 0" >&2; return 1; }
}
DEPLOY_LOG="$(mktemp)"
CLEANUP_FILES="${DEPLOY_LOG}"

echo "==> Phase 1: deploy v1"
deploy "${DEPLOY_LOG}" || { echo "FAIL: phase 1: deploy failed" >&2; exit 1; }
for lid in InSg InCidr; do
  [ "$(state_field ".resources.${lid}.provisionedBy // \"sdk\"")" != "cc-api" ] || {
    echo "FAIL: phase 1 premise: ${lid} was created on Cloud Control" >&2; exit 1; }
done
DST="$(state_field '.resources.Dst.physicalId // ""')"
SRC1="$(state_field '.resources.Src.physicalId // ""')"
case "${DST}/${SRC1}" in sg-?*/sg-?*) ;; *) echo "FAIL: phase 1: Dst/Src recorded '${DST}' / '${SRC1}'" >&2; exit 1 ;; esac
SG_ID1="$(only_rule "phase 1" "${DST}" 2049 "${SRC1}")"
CIDR_ID1="$(only_rule "phase 1" "${DST}" 443 198.51.100.0/24)"
[ "$(state_field '.resources.InCidr.attributes.Id // ""')" = "${CIDR_ID1}" ] || {
  echo "FAIL: phase 1 premise: InCidr does not record ${CIDR_ID1}" >&2; exit 1; }
echo "    OK: 2049 from ${SRC1} (${SG_ID1}), 443 from 198.51.100.0/24 (${CIDR_ID1})"

echo "==> Phase 2: a failing deploy replaces both rules, then rolls back"
export CDKD_TEST_UPDATE=fail
if deploy "${DEPLOY_LOG}"; then
  echo "FAIL: phase 2: the deploy with the refused queue succeeded" >&2; exit 1
fi
PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}")"
# The refusal this fixture exists for; and the failure must be the queue's.
if grep -q 'NAMED_REPLACEMENT_IDEMPOTENT_CREATE\|name-idempotent' <<<"${PLAIN}"; then
  echo "FAIL: phase 2: a rule's source change was refused as a name-idempotent create (go-to-k/cdkd#7071)" >&2; exit 1
fi
grep -q 'Failed to create resource Bad' <<<"${PLAIN}" || {
  echo "FAIL: phase 2: the deploy did not fail on the Bad queue (if cdkd reworded its line, update this check)" >&2; exit 1; }
grep -qE 'InCidr \(AWS::EC2::SecurityGroupIngress\) replaced' <<<"${PLAIN}" || {
  echo "FAIL: phase 2 premise: InCidr was not replaced before the queue failed" >&2; exit 1; }
# THE ARM: after the rollback Dst holds exactly the v1 rules; 192.0.2.0/24 is not open.
[ "$(state_field '.resources.Src.physicalId // ""')" = "${SRC1}" ] || {
  echo "FAIL: phase 2: Src no longer records ${SRC1} after the rollback" >&2; exit 1; }
SG_ID2="$(only_rule "phase 2" "${DST}" 2049 "${SRC1}")"
CIDR_ID2="$(only_rule "phase 2" "${DST}" 443 198.51.100.0/24)"
[ "$(state_field '.resources.InCidr.attributes.Id // ""')" = "${CIDR_ID2}" ] || {
  echo "FAIL: phase 2: InCidr does not record the live rule ${CIDR_ID2}" >&2; exit 1; }
[ "$(state_field '.resources.InSg.attributes.Id // ""')" = "${SG_ID2}" ] || {
  echo "FAIL: phase 2: InSg does not record the live rule ${SG_ID2}" >&2; exit 1; }
[ "$(state_field '.resources.InCidr.properties.CidrIp // ""')" = "198.51.100.0/24" ] || {
  echo "FAIL: phase 2: InCidr's record does not hold the v1 CIDR" >&2; exit 1; }
drift_clean "phase 2"
echo "    OK: rolled back to the v1 rules (${SG_ID2}, ${CIDR_ID2}); nothing else on Dst"

echo "==> Phase 3: deploy v2"
export CDKD_TEST_UPDATE=v2
deploy "${DEPLOY_LOG}" || { echo "FAIL: phase 3: deploy failed (go-to-k/cdkd#7071)" >&2; exit 1; }
SRC2="$(state_field '.resources.Src.physicalId // ""')"
case "${SRC2}" in sg-?*) ;; *) echo "FAIL: phase 3: Src recorded '${SRC2}'" >&2; exit 1 ;; esac
[ "${SRC2}" != "${SRC1}" ] || { echo "FAIL: phase 3 premise: Src was not replaced" >&2; exit 1; }
SG_ID3="$(only_rule "phase 3" "${DST}" 2049 "${SRC2}")"
CIDR_ID3="$(only_rule "phase 3" "${DST}" 443 192.0.2.0/24)"
[ "$(state_field '.resources.InSg.attributes.Id // ""')" = "${SG_ID3}" ] || {
  echo "FAIL: phase 3: InSg does not record ${SG_ID3}" >&2; exit 1; }
[ "$(state_field '.resources.InCidr.attributes.Id // ""')" = "${CIDR_ID3}" ] || {
  echo "FAIL: phase 3: InCidr does not record ${CIDR_ID3}" >&2; exit 1; }
assert_gone "the replaced source group ${SRC1} still exists" \
  aws ec2 describe-security-groups --group-ids "${SRC1}" --region "${REGION}"
drift_clean "phase 3"
echo "    OK: 2049 from ${SRC2} (${SG_ID3}), 443 from 192.0.2.0/24 (${CIDR_ID3}); ${SRC1} deleted"

echo "==> Phase 4: destroy"
VPC_ID="$(state_field '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: phase 4: the VPC recorded '${VPC_ID}'" >&2; exit 1 ;; esac
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for gid in "${DST}" "${SRC2}"; do
  assert_gone "group ${gid} still exists after destroy" \
    aws ec2 describe-security-groups --group-ids "${gid}" --region "${REGION}"
done
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LEFT="$(fixture_vpcs)"
[ -z "${LEFT}" ] || { echo "FAIL: VPCs of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: nothing left"

echo ""
echo "[verify] PASS — a standalone ingress rule's source change is replaced, and its rollback leaves only the old rules"
