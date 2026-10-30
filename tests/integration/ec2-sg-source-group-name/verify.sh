#!/usr/bin/env bash
# verify.sh — cdkd inline SecurityGroup ingress SourceSecurityGroupName (#5478).
#
# An inline `SecurityGroupIngress` rule may name its peer with
# `SourceSecurityGroupName` (a default-VPC group). cdkd used to read only
# `SourceSecurityGroupId`, so the rule went out with no peer. CloudFormation,
# measured in a default VPC, creates the rule with the named group as its
# peer; AWS then reports it in `UserIdGroupPairs` by GroupId.
#
# Phases:
#   0. Resolve the region's default VPC. None: print a SKIP line and exit 0
#      (a SKIP is not a PASS).
#   1. Deploy: Main's ingress names PEER_A. Assert the live tcp/443 rule's
#      UserIdGroupPairs GroupIds are exactly PEER_A's id.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (names PEER_B). Assert Main kept
#      its id and the rule's GroupIds are now exactly PEER_B's id.
#   3. Destroy; assert the three groups and the state file are gone.
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

STACK="CdkdEc2SgSourceGroupNameExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Literal names (lib/ec2-sg-source-group-name-stack.ts), so no sweep below can
# widen to an empty filter.
PEER_A="cdkd-integ-sgname-peer-a"
PEER_B="cdkd-integ-sgname-peer-b"
MAIN="cdkd-integ-sgname-main"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-5478-deploy.$$.log"
DEFAULT_VPC=""
CLEANED_UP=0

# The id of a group by its literal name in the default VPC ('' when absent).
group_id() { # usage: group_id <group-name>
  aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=vpc-id,Values=${DEFAULT_VPC}" "Name=group-name,Values=$1" \
    --query 'SecurityGroups[0].GroupId' --output text | sed 's/^None$//'
}

cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=1
  if [ -f "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Sweep the three groups by literal name, Main first (its rule references a
  # peer). Scoped to a resolved default VPC id only.
  case "${DEFAULT_VPC}" in
    vpc-?*)
      for name in "${MAIN}" "${PEER_A}" "${PEER_B}"; do
        gid=$(group_id "${name}" 2>/dev/null)
        case "${gid}" in
          sg-?*) aws ec2 delete-security-group --region "${REGION}" --group-id "${gid}" >/dev/null 2>&1 \
            || echo "WARN: teardown sweep could not delete ${name} (${gid})" >&2 ;;
        esac
      done
      ;;
    *) echo "WARN: no default VPC id resolved; teardown sweep refused" >&2 ;;
  esac
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${DEPLOY_LOG}"
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Phase 0: the default VPC -----------------------------------------
DEFAULT_VPC=$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=is-default,Values=true" \
  --query 'Vpcs[0].VpcId' --output text)
if [ "${DEFAULT_VPC}" = "None" ] || [ -z "${DEFAULT_VPC}" ]; then
  trap - EXIT INT TERM
  echo "[verify] SKIP — no default VPC in ${REGION}; SourceSecurityGroupName reaches only a default-VPC group (issue #5478)"
  exit 0
fi
echo "==> Default VPC: ${DEFAULT_VPC}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup
CLEANED_UP=0

# Main's tcp/443 ingress peers as sorted, space-separated GroupIds.
rule_peers() { # usage: rule_peers <main-group-id>
  aws ec2 describe-security-groups --region "${REGION}" --group-ids "$1" \
    --query 'SecurityGroups[0].IpPermissions[?FromPort==`443`].UserIdGroupPairs[].GroupId' \
    --output text | tr '\t' '\n' | sort | tr '\n' ' ' | sed 's/ $//'
}

# --- Phase 1: deploy, Main names PEER_A ------------------------------
echo "==> Phase 1: deploy (Main's ingress names ${PEER_A})"
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_LOG}"
P1_RC=${PIPESTATUS[0]}
set -e
if [ "${P1_RC}" -ne 0 ]; then
  echo "FAIL: Phase 1 deploy exited ${P1_RC}; an inline rule naming its peer by SourceSecurityGroupName must deploy as CloudFormation deploys it (issue #5478)" >&2
  exit 1
fi
MAIN_ID=$(group_id "${MAIN}") || MAIN_ID="<describe failed>"
PEER_A_ID=$(group_id "${PEER_A}") || PEER_A_ID="<describe failed>"
PEER_B_ID=$(group_id "${PEER_B}") || PEER_B_ID="<describe failed>"
if [ -z "${MAIN_ID}" ] || [ -z "${PEER_A_ID}" ] || [ -z "${PEER_B_ID}" ]; then
  echo "FAIL: a group is missing from ${DEFAULT_VPC}: ${MAIN}='${MAIN_ID}' ${PEER_A}='${PEER_A_ID}' ${PEER_B}='${PEER_B_ID}'" >&2
  exit 1
fi
P1_PEERS=""
for _ in 1 2 3 4 5 6; do
  P1_PEERS=$(rule_peers "${MAIN_ID}") || P1_PEERS="<describe failed>"
  [ "${P1_PEERS}" = "${PEER_A_ID}" ] && break
  sleep 5
done
if [ "${P1_PEERS}" != "${PEER_A_ID}" ]; then
  echo "FAIL: ${MAIN} (${MAIN_ID}) tcp/443 ingress peers are '${P1_PEERS}', expected '${PEER_A_ID}' (${PEER_A}): the SourceSecurityGroupName peer did not reach AWS (issue #5478)" >&2
  exit 1
fi
echo "    OK: ${MAIN}'s rule peers with ${PEER_A} (${PEER_A_ID})"

# --- Phase 2: rename the peer to PEER_B ------------------------------
echo "==> Phase 2: update (Main's ingress names ${PEER_B})"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P2_RC=$?
set -e
if [ "${P2_RC}" -ne 0 ]; then
  echo "FAIL: Phase 2 deploy exited ${P2_RC}; renaming the SourceSecurityGroupName peer must update in place (issue #5478)" >&2
  exit 1
fi
P2_MAIN_ID=$(group_id "${MAIN}") || P2_MAIN_ID="<describe failed>"
if [ "${P2_MAIN_ID}" != "${MAIN_ID}" ]; then
  echo "FAIL: ${MAIN} was replaced by a rule change (must update in place): '${MAIN_ID}' -> '${P2_MAIN_ID}'" >&2
  exit 1
fi
P2_PEERS=""
for _ in 1 2 3 4 5 6; do
  P2_PEERS=$(rule_peers "${MAIN_ID}") || P2_PEERS="<describe failed>"
  [ "${P2_PEERS}" = "${PEER_B_ID}" ] && break
  sleep 5
done
if [ "${P2_PEERS}" != "${PEER_B_ID}" ]; then
  echo "FAIL: after renaming the peer, ${MAIN}'s tcp/443 ingress peers are '${P2_PEERS}', expected only '${PEER_B_ID}' (${PEER_B}) (issue #5478)" >&2
  exit 1
fi
echo "    OK: the rule now peers with ${PEER_B} (${PEER_B_ID}) only, in place"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
set +e
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
P3_RC=$?
set -e
if [ "${P3_RC}" -ne 0 ]; then
  echo "FAIL: Phase 3 destroy exited ${P3_RC}" >&2
  exit 1
fi
for gid in "${MAIN_ID}" "${PEER_A_ID}" "${PEER_B_ID}"; do
  assert_gone "security group ${gid} still exists after destroy" aws ec2 describe-security-groups --region "${REGION}" --group-ids "${gid}"
done
echo "    OK: the three security groups are gone"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "[verify] PASS — inline SourceSecurityGroupName peer created and renamed in place, clean destroy (issue #5478)"
