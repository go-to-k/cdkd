#!/usr/bin/env bash
# verify.sh -- a security group rule's Description edit is applied in place
# (issue #6514).
#
# A description-only change used to revoke the rule and authorize it again: the
# rule was briefly absent, came back with a new sgr- id, and the standalone
# AWS::EC2::SecurityGroupIngress was reported `replaced`. CloudFormation keeps
# the rule and changes only its description.
# Phases:
#   1. deploy v1: a group with an inline ingress (443) and inline egress (443)
#      rule, and a standalone ingress (8443); record the three sgr- ids;
#   2. deploy v2 (every description changes): the SAME three ids carry the new
#      descriptions, and the standalone rule is not reported replaced
#      (pre-fix: three new ids, `Standalone ... replaced`);
#   3. deploy v3 (the standalone rule's description is dropped): its id is kept
#      and the description is gone;
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

STACK="CdkdSgRuleDescriptionUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
FIXTURE_TAG="sg-rule-description-update"
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
# The one rule of <group> in <direction> on <port>: its sgr- id. Exactly one,
# or a failure: a revoke + authorize that left the old rule would show two.
rule_id() { # usage: rule_id <group id> <true|false: is egress> <port>
  local ids
  ids="$(aws ec2 describe-security-group-rules --region "${REGION}" \
    --filters "Name=group-id,Values=$1" \
    --query "SecurityGroupRules[?IsEgress==\`$2\` && FromPort==\`$3\`].SecurityGroupRuleId" \
    --output text)" || return 1
  ids="$(printf '%s' "${ids}" | tr '\t' '\n' | awk 'NF')"
  [ "$(printf '%s\n' "${ids}" | awk 'NF' | wc -l | tr -d ' ')" = "1" ] || {
    echo "FAIL: group $1 has not exactly one rule (egress=$2, port $3): '${ids}'" >&2
    return 1
  }
  printf '%s' "${ids}"
}
# <rule id>'s description, '' when it has none. Fails when the id is gone.
rule_description() { # usage: rule_description <rule id>
  aws ec2 describe-security-group-rules --region "${REGION}" --security-group-rule-ids "$1" \
    --query "SecurityGroupRules[0].Description || ''" --output text
}
# Poll until <rule id> carries <want> (a description write is eventually
# consistent on the read side); a rule id that is gone fails at once.
expect_description() { # usage: expect_description <phase> <group id> <rule id> <want>
  local got=""
  for _ in 1 2 3 4 5 6; do
    got="$(rule_description "$3")" || {
      echo "FAIL: $1: rule $3 cannot be read (go-to-k/cdkd#6514: a description edit revoked the rule)" >&2
      return 1
    }
    [ "${got}" = "$4" ] && return 0
    sleep 5
  done
  echo "FAIL: $1: rule $3 carries description '${got}', expected '$4'" >&2
  return 1
}
deploy() { # usage: deploy <phase> <log file>
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "$2" || {
    echo "FAIL: $1: deploy failed" >&2
    return 1
  }
}
DEPLOY_LOG="$(mktemp)"
# The Standalone row of the deploy's progress output must say `updated` (an
# in-place update). Its row is found by the logical id AND the resource type,
# so a reworded verb fails loudly as "no row" instead of passing as "not
# replaced"; `replaced` is the pre-fix revoke + authorize.
expect_standalone_updated() { # usage: expect_standalone_updated <phase> <log file>
  local rows
  rows="$(sed 's/\x1b\[[0-9;]*m//g' "$2" | grep -E 'Standalone \(AWS::EC2::SecurityGroupIngress\)' || true)"
  if grep -q 'replaced' <<<"${rows}"; then
    echo "FAIL: $1: the standalone rule was replaced for a description edit (go-to-k/cdkd#6514): ${rows}" >&2
    return 1
  fi
  grep -qE 'Standalone \(AWS::EC2::SecurityGroupIngress\) updated' <<<"${rows}" || {
    echo "FAIL: $1: no 'Standalone (AWS::EC2::SecurityGroupIngress) updated' row in the deploy output (rows: '${rows}'); if cdkd reworded its row, update this check" >&2
    return 1
  }
}

echo "==> Phase 1: deploy v1"
deploy "phase 1" "${DEPLOY_LOG}"
# The L2 group's logical id carries CDK's hash, so it is found by type.
GROUP_LID="$(state_field '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .key] | if length == 1 then .[0] else "" end')"
[ -n "${GROUP_LID}" ] || { echo "FAIL: phase 1 premise: state does not hold exactly one AWS::EC2::SecurityGroup" >&2; exit 1; }
for lid in "${GROUP_LID}" Standalone; do
  [ "$(state_field ".resources[\"${lid}\"].provisionedBy // \"sdk\"")" != "cc-api" ] || {
    echo "FAIL: phase 1 premise: ${lid} was created on Cloud Control" >&2; exit 1; }
done
SG="$(state_field ".resources[\"${GROUP_LID}\"].physicalId // \"\"")"
case "${SG}" in sg-?*) ;; *) echo "FAIL: phase 1: ${GROUP_LID} recorded '${SG}', not a group id" >&2; exit 1 ;; esac
IN_ID="$(rule_id "${SG}" false 443)"
OUT_ID="$(rule_id "${SG}" true 443)"
ST_ID="$(rule_id "${SG}" false 8443)"
for id in "${IN_ID}" "${OUT_ID}" "${ST_ID}"; do
  case "${id}" in sgr-?*) ;; *) echo "FAIL: phase 1: rule id '${id}' is not an sgr- id" >&2; exit 1 ;; esac
done
[ "$(state_field '.resources.Standalone.attributes.Id // ""')" = "${ST_ID}" ] || {
  echo "FAIL: phase 1 premise: Standalone does not record ${ST_ID} as its Id" >&2; exit 1; }
expect_description "phase 1" "${SG}" "${IN_ID}" "cdkd 6514 ingress v1"
expect_description "phase 1" "${SG}" "${OUT_ID}" "cdkd 6514 egress v1"
expect_description "phase 1" "${SG}" "${ST_ID}" "cdkd 6514 standalone v1"
echo "    OK: ingress ${IN_ID}, egress ${OUT_ID}, standalone ${ST_ID}"

echo "==> Phase 2: deploy v2 (every description changes)"
export CDKD_TEST_UPDATE=v2
deploy "phase 2" "${DEPLOY_LOG}"
expect_standalone_updated "phase 2" "${DEPLOY_LOG}"
expect_description "phase 2" "${SG}" "${IN_ID}" "cdkd 6514 ingress v2"
expect_description "phase 2" "${SG}" "${OUT_ID}" "cdkd 6514 egress v2"
expect_description "phase 2" "${SG}" "${ST_ID}" "cdkd 6514 standalone v2"
[ "$(rule_id "${SG}" false 443)" = "${IN_ID}" ] || { echo "FAIL: phase 2: the inline ingress rule is no longer ${IN_ID}" >&2; exit 1; }
[ "$(rule_id "${SG}" true 443)" = "${OUT_ID}" ] || { echo "FAIL: phase 2: the inline egress rule is no longer ${OUT_ID}" >&2; exit 1; }
[ "$(rule_id "${SG}" false 8443)" = "${ST_ID}" ] || { echo "FAIL: phase 2: the standalone rule is no longer ${ST_ID}" >&2; exit 1; }
[ "$(state_field '.resources.Standalone.attributes.Id // ""')" = "${ST_ID}" ] || {
  echo "FAIL: phase 2: Standalone no longer records ${ST_ID} as its Id" >&2; exit 1; }
echo "    OK: the three rules kept their ids and carry the v2 descriptions"

echo "==> Phase 3: deploy v3 (the standalone rule's description is dropped)"
export CDKD_TEST_UPDATE=v3
deploy "phase 3" "${DEPLOY_LOG}"
expect_standalone_updated "phase 3" "${DEPLOY_LOG}"
expect_description "phase 3" "${SG}" "${ST_ID}" ""
[ "$(rule_id "${SG}" false 8443)" = "${ST_ID}" ] || { echo "FAIL: phase 3: the standalone rule is no longer ${ST_ID}" >&2; exit 1; }
expect_description "phase 3" "${SG}" "${IN_ID}" "cdkd 6514 ingress v2"
expect_description "phase 3" "${SG}" "${OUT_ID}" "cdkd 6514 egress v2"
echo "    OK: ${ST_ID} kept, its description cleared"

echo "==> Phase 4: destroy"
VPC_ID="$(state_field '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: phase 4: the VPC recorded '${VPC_ID}'" >&2; exit 1 ;; esac
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "group ${SG} still exists after destroy" \
  aws ec2 describe-security-groups --group-ids "${SG}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LEFT="$(fixture_vpcs)"
[ -z "${LEFT}" ] || { echo "FAIL: VPCs of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: nothing left"

echo ""
echo "[verify] PASS — security group rule description edits keep the rule (inline ingress, inline egress, standalone ingress)"
