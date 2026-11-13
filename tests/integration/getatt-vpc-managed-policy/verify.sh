#!/usr/bin/env bash
# verify.sh — cdkd Fn::GetAtt VPC DefaultNetworkAcl / CidrBlockAssociations and
# ManagedPolicy PolicyId / DefaultVersionId (issue #6232).
#
# Each of the four used to resolve to the resource's physical id with only a
# warning. Asserts every output equals the value AWS reports, that the default
# ACL reached a NetworkAclEntry property, that a policy document UPDATE moves
# DefaultVersionId to the new version in place, then destroys clean.

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

STACK="CdkdGetattVpcManagedPolicyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POLICY_NAME="${STACK}-policy"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    fi
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  ACCOUNT="$(aws sts get-caller-identity --query Account --output text 2>/dev/null)"
  if [ -n "${ACCOUNT}" ]; then
    aws iam delete-policy --policy-arn "arn:aws:iam::${ACCOUNT}:policy/${POLICY_NAME}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
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

output_of() { # usage: output_of <output key>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r --arg k "$1" '.outputs[$k] // empty' <<<"${state}"
}

# The old behavior's only signal was this warning; a deploy must not print it
# for any of the four attributes.
assert_no_fallback_warning() { # usage: assert_no_fallback_warning <log file>
  if grep -E 'Unknown attribute (DefaultNetworkAcl|CidrBlockAssociations|PolicyId|DefaultVersionId)' "$1"; then
    echo "FAIL: a physical-id fallback warning was printed (see above)" >&2
    exit 1
  fi
}

assert_policy_outputs() { # usage: assert_policy_outputs <expected version id>
  local arn live_id live_version out_id out_version
  arn="$(output_of PolicyArn)" || return 1
  [ -n "${arn}" ] || { echo "FAIL: PolicyArn output missing" >&2; exit 1; }
  live_id="$(aws iam get-policy --policy-arn "${arn}" --query 'Policy.PolicyId' --output text)" || return 1
  live_version="$(aws iam get-policy --policy-arn "${arn}" --query 'Policy.DefaultVersionId' --output text)" || return 1
  out_id="$(output_of PolicyId)" || return 1
  out_version="$(output_of DefaultVersionId)" || return 1
  if [ "${out_id}" != "${live_id}" ]; then
    echo "FAIL: PolicyId output '${out_id}' != live '${live_id}'" >&2
    exit 1
  fi
  if [ "${out_version}" != "${live_version}" ] || [ "${live_version}" != "$1" ]; then
    echo "FAIL: DefaultVersionId output '${out_version}', live '${live_version}', expected '$1'" >&2
    exit 1
  fi
  echo "    OK: PolicyId == ${live_id}, DefaultVersionId == ${live_version}"
}

echo "==> Phase 1: deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy1.log"
assert_no_fallback_warning "${LOG_DIR}/deploy1.log"

VPC_ID="$(output_of VpcId)"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: VpcId output '${VPC_ID}'" >&2; exit 1 ;; esac

LIVE_ACL="$(aws ec2 describe-network-acls --region "${REGION}" \
  --filters "Name=vpc-id,Values=${VPC_ID}" "Name=default,Values=true" \
  --query 'NetworkAcls[0].NetworkAclId' --output text)"
OUT_ACL="$(output_of DefaultNetworkAcl)"
if [ "${OUT_ACL}" != "${LIVE_ACL}" ]; then
  echo "FAIL: DefaultNetworkAcl output '${OUT_ACL}' != live '${LIVE_ACL}' (physical-id fallback?)" >&2
  exit 1
fi
echo "    OK: DefaultNetworkAcl == ${LIVE_ACL}"

# The ACL id reached a property: the deny entry sits on the default ACL.
ENTRY="$(aws ec2 describe-network-acls --region "${REGION}" --network-acl-ids "${LIVE_ACL}" \
  --query 'NetworkAcls[0].Entries[?RuleNumber==`150` && Egress==`false`].CidrBlock | [0]' --output text)"
if [ "${ENTRY}" != "192.0.2.0/24" ]; then
  echo "FAIL: rule 150 on ${LIVE_ACL} is '${ENTRY}', expected 192.0.2.0/24" >&2
  exit 1
fi
echo "    OK: NetworkAclEntry 150 is on the default ACL"

LIVE_ASSOC="$(aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}" \
  --query 'Vpcs[0].CidrBlockAssociationSet[0].AssociationId' --output text)"
OUT_ASSOC="$(output_of CidrAssociation0)"
if [ "${OUT_ASSOC}" != "${LIVE_ASSOC}" ]; then
  echo "FAIL: CidrAssociation0 output '${OUT_ASSOC}' != live '${LIVE_ASSOC}'" >&2
  exit 1
fi
echo "    OK: Fn::Select 0 of CidrBlockAssociations == ${LIVE_ASSOC}"

assert_policy_outputs v1
ARN_BEFORE="$(output_of PolicyArn)"
ID_BEFORE="$(output_of PolicyId)"

echo "==> Phase 2: UPDATE the policy document (DefaultVersionId v1 -> v2, in place)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${LOG_DIR}/deploy2.log"
assert_no_fallback_warning "${LOG_DIR}/deploy2.log"
assert_policy_outputs v2
if [ "$(output_of PolicyArn)" != "${ARN_BEFORE}" ] || [ "$(output_of PolicyId)" != "${ID_BEFORE}" ]; then
  echo "FAIL: the policy was replaced, not updated in place" >&2
  exit 1
fi
echo "    OK: same PolicyArn and PolicyId (in place)"

echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --region "${REGION}" --vpc-ids "${VPC_ID}"
assert_gone "policy ${ARN_BEFORE} still exists after destroy" aws iam get-policy --policy-arn "${ARN_BEFORE}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: VPC, policy and state gone"

echo ""
echo "[verify] PASS — getatt-vpc-managed-policy: DefaultNetworkAcl, CidrBlockAssociations, PolicyId and DefaultVersionId match AWS across an update"
