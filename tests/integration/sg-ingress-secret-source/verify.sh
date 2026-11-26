#!/usr/bin/env bash
# verify.sh -- an ingress rule whose source is a secret reference leaves no
# untracked rule when its replacement is refused (issue #7084).
#
# The rule's CidrIp is `{{resolve:secretsmanager:<name>}}`, so cdkd records it
# masked and cannot compare sources. Moving the rule to another secret
# replaces it: the create-first create authorizes the new rule under the old
# physical id, and the deploy refuses it as a name-idempotent create. Before
# #7084 the new rule stayed authorized and recorded nowhere; now its own
# sgr- id proves it new, and it is deleted again before the refusal.
# Phases:
#   1. deploy with secret A (198.51.100.0/24): one rule on 443 from A;
#   2. deploy with secret B (203.0.113.0/24): refused, the message says the
#      created resource was deleted again, and the group still admits exactly
#      A (pre-fix: A and B, B untracked);
#   3. deploy with secret B and --replace: succeeds; exactly B, recorded under
#      its sgr- id; drift is clean;
#   4. destroy: no group, VPC, secret or state file of this fixture left.
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
# The secrets' CIDRs can reach state versions (issue #2096): swept below.
. ../s3-versions.sh

STACK="CdkdSgIngressSecretSourceExample"
REGION="${AWS_REGION:-us-east-1}"
FIXTURE_TAG="sg-ingress-secret-source"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
SECRET_A="cdkd-7084-cidr-a"
SECRET_B="cdkd-7084-cidr-b"
unset CDKD_TEST_UPDATE CDKD_7084_SECRET

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
        # Twice: Dst's rule references Src, so Src's first delete can fail.
        for _pass in 1 2; do
        for gid in $(aws ec2 describe-security-groups --region "${REGION}" \
          --filters "Name=vpc-id,Values=${vpc}" \
          --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
          case "${gid}" in sg-?*) aws ec2 delete-security-group --group-id "${gid}" --region "${REGION}" >/dev/null 2>&1 || true ;; esac
        done
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
    # NONCURRENT only: this also runs pre-run and from the traps.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  for s in "${SECRET_A}" "${SECRET_B}"; do
    aws secretsmanager delete-secret --secret-id "${s}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  done
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
# A force-deleted secret's name can stay taken for a moment; retry the create.
create_secret() { # usage: create_secret <name> <value>
  for _ in 1 2 3 4 5 6; do
    aws secretsmanager create-secret --name "$1" --secret-string "$2" --region "${REGION}" >/dev/null 2>&1 && return 0
    sleep 5
  done
  echo "FAIL: premise: could not create secret $1" >&2
  return 1
}
create_secret "${SECRET_A}" 198.51.100.0/24
create_secret "${SECRET_B}" 203.0.113.0/24

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
deploy() { # usage: deploy <log file> [extra args...]
  local log="$1"; shift
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@" 2>&1 | tee "${log}"
}
DEPLOY_LOG="$(mktemp)"
CLEANUP_FILES="${DEPLOY_LOG}"

echo "==> Phase 1: deploy with secret A"
export CDKD_7084_SECRET="${SECRET_A}"
deploy "${DEPLOY_LOG}" || { echo "FAIL: phase 1: deploy failed" >&2; exit 1; }
[ "$(state_field '.resources.InCidr.provisionedBy // "sdk"')" != "cc-api" ] || {
  echo "FAIL: phase 1 premise: InCidr was created on Cloud Control" >&2; exit 1; }
DST="$(state_field '.resources.Dst.physicalId // ""')"
case "${DST}" in sg-?*) ;; *) echo "FAIL: phase 1: Dst recorded '${DST}'" >&2; exit 1 ;; esac
# The premise of #7084: the record cannot be compared by its source.
case "$(state_field '.resources.InCidr.properties.CidrIp // ""')" in
  198.51.100.0/24) echo "FAIL: phase 1 premise: InCidr records its CidrIp in plaintext, so this fixture does not reach #7084" >&2; exit 1 ;;
esac
ID1="$(only_rule "phase 1" "${DST}" 443 198.51.100.0/24)"
echo "    OK: 443 from A (${ID1}), source recorded masked"

echo "==> Phase 2: deploy with secret B (refused, nothing left behind)"
export CDKD_7084_SECRET="${SECRET_B}"
if deploy "${DEPLOY_LOG}"; then
  echo "FAIL: phase 2: the move to secret B deployed without --replace (expected the name-idempotent refusal)" >&2; exit 1
fi
PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${DEPLOY_LOG}")"
grep -q 'name-idempotent' <<<"${PLAIN}" || {
  echo "FAIL: phase 2: the deploy failed for another reason than the name-idempotent refusal" >&2; exit 1; }
grep -q 'was deleted again' <<<"${PLAIN}" || {
  echo "FAIL: phase 2: the refusal does not say the created rule was deleted again (go-to-k/cdkd#7084; if cdkd reworded it, update this check)" >&2; exit 1; }
# THE ARM: only A is admitted; B (the rule the refused create made) is gone.
[ "$(only_rule "phase 2" "${DST}" 443 198.51.100.0/24)" = "${ID1}" ] || {
  echo "FAIL: phase 2: the group no longer admits exactly A as ${ID1}" >&2; exit 1; }
echo "    OK: refused; the group still admits exactly A (${ID1})"

echo "==> Phase 3: deploy with secret B and --replace"
deploy "${DEPLOY_LOG}" --replace || { echo "FAIL: phase 3: deploy --replace failed" >&2; exit 1; }
ID3="$(only_rule "phase 3" "${DST}" 443 203.0.113.0/24)"
[ "$(state_field '.resources.InCidr.attributes.Id // ""')" = "${ID3}" ] || {
  echo "FAIL: phase 3: InCidr does not record ${ID3}" >&2; exit 1; }
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
DRIFT_RC=$?
set -e
[ "${DRIFT_RC}" = "0" ] || { echo "FAIL: phase 3: cdkd drift exited ${DRIFT_RC}, expected 0" >&2; exit 1; }
echo "    OK: 443 from B (${ID3}), recorded; drift clean"

echo "==> Phase 4: destroy"
VPC_ID="$(state_field '.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: phase 4: the VPC recorded '${VPC_ID}'" >&2; exit 1 ;; esac
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "group ${DST} still exists after destroy" \
  aws ec2 describe-security-groups --group-ids "${DST}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
LEFT="$(fixture_vpcs)"
[ -z "${LEFT}" ] || { echo "FAIL: VPCs of this fixture left after destroy: ${LEFT}" >&2; exit 1; }
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
for s in "${SECRET_A}" "${SECRET_B}"; do
  aws secretsmanager delete-secret --secret-id "${s}" --force-delete-without-recovery --region "${REGION}" >/dev/null
done
echo "    OK: nothing left"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "sg-ingress-secret-source state teardown"

echo ""
echo "[verify] PASS — a refused replacement of a secret-sourced ingress rule leaves no untracked rule"
