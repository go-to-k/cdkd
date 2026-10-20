#!/usr/bin/env bash
# verify.sh -- an un-named security group gets a generated name (issue #5095).
#
# Its SDK provider used to send the bare logical id as GroupName, unique per
# VPC. On a stack with a stack instance id the name is now
# `{stack}-{logicalId}-{suffix}`, so neither a replacement nor a second stack
# with the same logical id in the same VPC asks for a name a live group holds.
# Phases:
#   1. deploy the first stack (a bare VPC and Group): the group is named
#      `{stack}-Group-{suffix}` at generation 0, recomputed from state's
#      stackInstanceId (pre-fix: `Group`);
#   2. change GroupDescription (create-only) and deploy WITHOUT --replace: the
#      new group is created first under generation 1's name and the old group
#      is deleted (pre-fix: InvalidGroup.Duplicate on `Group`);
#   3. deploy the peer stack, whose Group joins the SAME VPC: it gets its own
#      stack's name, and both groups live in that VPC (pre-fix: a collision);
#   4. destroy both: no group of either stack and no VPC of this fixture left.
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

STACK="CdkdGeneratedNameSgExample"
PEER="CdkdGeneratedNameSgPeerExample"
REGION="${AWS_REGION:-us-east-1}"
LOGICAL="Group"
# CreateSecurityGroup: up to 255 characters.
MAX_LENGTH=255
FIXTURE_TAG="generated-name-security-group"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
export GNSG_DESCRIPTION="cdkd 5095 v1"
unset GNSG_SHARED_VPC_ID

state_key() { printf 'cdkd/%s/%s/state.json' "$1" "${REGION}"; }

# This fixture's VPCs, by tag (one normally; a crashed earlier run may leave more).
fixture_vpcs() { # usage: fixture_vpcs -- ids, one per line, or a hard failure
  aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:cdkd-integ,Values=${FIXTURE_TAG}" \
    --query 'Vpcs[].VpcId' --output text | tr '\t' '\n' | awk 'NF'
}
# Every group either stack's un-named Group could have created, by name prefix.
stack_groups() { # usage: stack_groups -- "id name" lines, or a hard failure
  local listed
  listed="$(aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=group-name,Values=${STACK}-${LOGICAL}-*,${PEER}-${LOGICAL}-*" \
    --query 'SecurityGroups[].[GroupId,GroupName]' --output text)" || return 1
  printf '%s\n' "${listed}" | awk 'NF == 2'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    for s in "${PEER}" "${STACK}"; do
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  stack_groups | while read -r gid gname; do
    case "${gname}" in
      "${STACK}-${LOGICAL}-"?* | "${PEER}-${LOGICAL}-"?*)
        aws ec2 delete-security-group --group-id "${gid}" --region "${REGION}" >/dev/null 2>&1 || true ;;
    esac
  done
  for vpc in $(fixture_vpcs); do
    case "${vpc}" in
      vpc-?*)
        # Any non-default group left in this fixture's VPC (a pre-fix run's
        # bare `Group` too), or the VPC delete fails.
        for gid in $(aws ec2 describe-security-groups --region "${REGION}" \
          --filters "Name=vpc-id,Values=${vpc}" \
          --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
          case "${gid}" in sg-?*) aws ec2 delete-security-group --group-id "${gid}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
        done
        aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1 || true ;;
    esac
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    for s in "${PEER}" "${STACK}"; do
      aws s3 rm "s3://${STATE_BUCKET}/$(state_key "${s}")" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/${REGION}/lock.json" >/dev/null 2>&1 || true
    done
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

state_field() { # usage: state_field <stack> <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/$(state_key "$1")" - | jq -r "$2"
}
# The name cdkd generates for <stack>'s un-named Group (go-to-k/cdkd#5064): the
# `{stack}-{logicalId}` part cut to maxLength - 13, then `-` and the first 12
# hex of sha256(id NUL logicalId), with NUL and the generation appended for a
# generation past 0. The id is read from the raw record and never printed.
expected_name() { # usage: expected_name <stack>
  local id generation
  id="$(state_field "$1" '.stackInstanceId // ""')" || return 1
  [ -n "${id}" ] || { echo "FAIL: ${1}'s record carries no stackInstanceId" >&2; return 1; }
  generation="$(state_field "$1" ".resources.${LOGICAL}.nameGeneration // 0")" || return 1
  [ -n "${generation}" ] || { echo "FAIL: ${LOGICAL}'s nameGeneration could not be read" >&2; return 1; }
  ID="${id}" node -e '
    const [stack, logical, max, generation] = process.argv.slice(1);
    const hash = require("crypto").createHash("sha256")
      .update(process.env.ID).update("\u0000").update(logical);
    if (generation !== "0") hash.update("\u0000").update(generation);
    const suffix = hash.digest("hex").slice(0, 12);
    const base = `${stack}-${logical}`.slice(0, Number(max) - 13).replace(/-+$/, "");
    process.stdout.write(`${base}-${suffix}`);
  ' "$1" "${LOGICAL}" "${MAX_LENGTH}" "${generation}"
}
group_field() { # usage: group_field <group id> <GroupName|VpcId|Description>
  aws ec2 describe-security-groups --group-ids "$1" --region "${REGION}" \
    --query "SecurityGroups[0].$2" --output text
}
# <stack>'s recorded Group: its physical id, live name equal to the formula's.
check_group() { # usage: check_group <stack> <phase> -- prints the group id
  local gid want live
  gid="$(state_field "$1" ".resources.${LOGICAL}.physicalId // \"\"")" || return 1
  case "${gid}" in sg-?*) ;; *) echo "FAIL: $2: ${1}'s Group recorded '${gid}', not a group id" >&2; return 1 ;; esac
  want="$(expected_name "$1")" || return 1
  [ -n "${want}" ] || { echo "FAIL: $2: empty expected name" >&2; return 1; }
  live="$(group_field "${gid}" GroupName)" || { echo "FAIL: $2: ${gid} cannot be read" >&2; return 1; }
  [ "${live}" = "${want}" ] || {
    echo "FAIL: $2: ${1}'s group ${gid} is named '${live}', not '${want}' (go-to-k/cdkd#5095: the bare logical id collides)" >&2
    return 1
  }
  printf '%s' "${gid}"
}

echo "==> Phase 1: deploy ${STACK}"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(state_field "${STACK}" ".resources.${LOGICAL}.provisionedBy // \"sdk\"")" != "cc-api" ] || {
  echo "FAIL: phase 1 premise: ${LOGICAL} was created on Cloud Control" >&2; exit 1; }
GID1="$(check_group "${STACK}" "phase 1")"
[ -n "${GID1}" ] || { echo "FAIL: phase 1: no group id" >&2; exit 1; }
VPC_ID="$(state_field "${STACK}" '.resources.Vpc.physicalId // ""')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: phase 1: Vpc recorded '${VPC_ID}'" >&2; exit 1 ;; esac
[ "$(group_field "${GID1}" VpcId)" = "${VPC_ID}" ] || { echo "FAIL: phase 1: ${GID1} is not in ${VPC_ID}" >&2; exit 1; }
echo "    OK: ${GID1} carries generation 0's name"

echo "==> Phase 2: GroupDescription changes (a replacement), no --replace"
export GNSG_DESCRIPTION="cdkd 5095 v2"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes || {
  echo "FAIL: phase 2: the replacement failed (go-to-k/cdkd#5095: a create-first replacement asking for the old group's name collides)" >&2
  exit 1
}
GEN="$(state_field "${STACK}" ".resources.${LOGICAL}.nameGeneration // 0")"
[ "${GEN}" = "1" ] || { echo "FAIL: phase 2: ${LOGICAL}'s nameGeneration is '${GEN}', not 1" >&2; exit 1; }
GID2="$(check_group "${STACK}" "phase 2")"
[ -n "${GID2}" ] && [ "${GID2}" != "${GID1}" ] || { echo "FAIL: phase 2: no new group (still ${GID1})" >&2; exit 1; }
[ "$(group_field "${GID2}" Description)" = "${GNSG_DESCRIPTION}" ] || {
  echo "FAIL: phase 2: ${GID2} does not carry the new description" >&2; exit 1; }
assert_gone "phase 2: the replaced group ${GID1} survived" \
  aws ec2 describe-security-groups --group-ids "${GID1}" --region "${REGION}"
echo "    OK: ${GID2} carries generation 1's name; ${GID1} is gone"

echo "==> Phase 3: deploy ${PEER} into the same VPC"
export GNSG_SHARED_VPC_ID="${VPC_ID}"
node "${LOCAL_DIST}" deploy "${PEER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes || {
  echo "FAIL: phase 3: the peer stack's Group failed in ${VPC_ID} (go-to-k/cdkd#5095: two stacks' bare logical ids collide in one VPC)" >&2
  exit 1
}
PEER_GID="$(check_group "${PEER}" "phase 3")"
[ -n "${PEER_GID}" ] || { echo "FAIL: phase 3: no group id" >&2; exit 1; }
[ "$(group_field "${PEER_GID}" VpcId)" = "${VPC_ID}" ] || {
  echo "FAIL: phase 3 premise: ${PEER_GID} is not in ${VPC_ID}" >&2; exit 1; }
[ "$(group_field "${GID2}" VpcId)" = "${VPC_ID}" ] || { echo "FAIL: phase 3: ${GID2} left ${VPC_ID}" >&2; exit 1; }
echo "    OK: ${PEER_GID} and ${GID2} share ${VPC_ID} under their own stacks' names"

echo "==> Phase 4: destroy (peer first: its group is in the first stack's VPC)"
node "${LOCAL_DIST}" destroy "${PEER}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for gid in "${GID2}" "${PEER_GID}"; do
  assert_gone "group ${gid} still exists after destroy" \
    aws ec2 describe-security-groups --group-ids "${gid}" --region "${REGION}"
done
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LEFT="$(stack_groups)"
[ -z "${LEFT}" ] || { echo "FAIL: groups of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
LEFT="$(fixture_vpcs)"
[ -z "${LEFT}" ] || { echo "FAIL: VPCs of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
for s in "${PEER}" "${STACK}"; do
  assert_gone "state file of ${s} still exists after destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(state_key "${s}")"
done
echo "    OK: nothing left"

echo ""
echo "[verify] PASS — an un-named security group's generated name survives a replacement and a second stack in its VPC"
