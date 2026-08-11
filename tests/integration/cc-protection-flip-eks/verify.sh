#!/usr/bin/env bash
# verify.sh — cdkd CC protection flip integ for AWS::EKS::Cluster (issue #1315).
#
# The EKS cluster deploys with DeletionProtection: true. A bare destroy must
# fail on the cluster (the VPC teardown may partially proceed or be blocked by
# control-plane ENIs — either way the destroy exits non-zero, the cluster
# survives, and state is retained), and `destroy --remove-protection` must
# flip the property off via the CC UpdateResource patch and delete everything
# cleanly. Kept separate from `cc-protection-flip` because the control plane
# takes ~10-15 min each way.
#
# Phases:
#   1. Deploy. Assert DeletionProtection=true via `aws eks describe-cluster`
#      and provisionedBy=cc-api for the cluster.
#   2. Bare destroy (no flag). Assert: exit non-zero, cluster still exists,
#      state file retained.
#   3. Destroy with --remove-protection. Assert: exit 0, cluster gone, state
#      file removed.
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

STACK="CdkdCcProtectionFlipEksExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CLUSTER_NAME="cdkd-ccprot-eks"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    # state destroy --remove-protection tears down the whole stack (cluster
    # flip included) when state still exists; the per-resource sweeps below
    # cover the no-state case.
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --remove-protection --yes >/dev/null 2>&1
  fi
  ( set +eu
    if aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" >/dev/null 2>&1; then
      aws eks update-cluster-config --name "${CLUSTER_NAME}" --no-deletion-protection --region "${REGION}" >/dev/null 2>&1
      for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
        st="$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" --query 'cluster.status' --output text 2>/dev/null)"
        [ "${st}" = "ACTIVE" ] && break
        sleep 10
      done
      aws eks delete-cluster --name "${CLUSTER_NAME}" --region "${REGION}" >/dev/null 2>&1
      echo "    delete requested for leftover EKS cluster ${CLUSTER_NAME}"
      for _ in $(seq 1 60); do
        st="$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" --query 'cluster.status' --output text 2>/dev/null)"
        [ -z "${st}" ] && break
        sleep 15
      done
    fi
  )
  # VPC remnants (subnets / IGW / route tables / SGs / VPC) from a partial
  # destroy: discover by the CDK Name tag and delete leaf-first.
  ( set +eu
    vpc="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" --query 'Vpcs[0].VpcId' --output text 2>/dev/null)"
    if [ -n "${vpc}" ] && [ "${vpc}" != "None" ]; then
      for eni in $(aws ec2 describe-network-interfaces --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'NetworkInterfaces[].NetworkInterfaceId' --output text 2>/dev/null); do
        aws ec2 delete-network-interface --network-interface-id "${eni}" --region "${REGION}" >/dev/null 2>&1
      done
      for sg in $(aws ec2 describe-security-groups --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "SecurityGroups[?GroupName!='default'].GroupId" --output text 2>/dev/null); do
        aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null 2>&1
      done
      for subnet in $(aws ec2 describe-subnets --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text 2>/dev/null); do
        aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null 2>&1
      done
      igw="$(aws ec2 describe-internet-gateways --region "${REGION}" --filters "Name=attachment.vpc-id,Values=${vpc}" --query 'InternetGateways[0].InternetGatewayId' --output text 2>/dev/null)"
      if [ -n "${igw}" ] && [ "${igw}" != "None" ]; then
        aws ec2 detach-internet-gateway --internet-gateway-id "${igw}" --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
        aws ec2 delete-internet-gateway --internet-gateway-id "${igw}" --region "${REGION}" >/dev/null 2>&1
      fi
      for rt in $(aws ec2 describe-route-tables --region "${REGION}" --filters "Name=vpc-id,Values=${vpc}" --query "RouteTables[?Associations[0].Main!=\`true\`].RouteTableId" --output text 2>/dev/null); do
        aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null 2>&1
      done
      aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null 2>&1
      echo "    swept leftover VPC ${vpc}"
    fi
  )
  # Cluster role: deterministic-prefix discovery.
  ( set +eu
    for role in $(aws iam list-roles --query "Roles[?contains(RoleName, '${STACK}')].RoleName" --output text 2>/dev/null); do
      for pol in $(aws iam list-attached-role-policies --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
        aws iam detach-role-policy --role-name "${role}" --policy-arn "${pol}" >/dev/null 2>&1
      done
      aws iam delete-role --role-name "${role}" >/dev/null 2>&1
      echo "    deleted leftover role ${role}"
    done
  )
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f destroy-blocked.log
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with protection ON --------------------------------
echo "==> Phase 1: deploy (EKS cluster with DeletionProtection: true; ~10-15 min)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PROTECTION_P1="$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'cluster.deletionProtection' --output text)"
if [ "${PROTECTION_P1}" != "True" ]; then
  echo "FAIL: expected deletionProtection=True after Phase 1, got '${PROTECTION_P1}'" >&2
  exit 1
fi
echo "    cluster is up with deletion protection ON"

PROVISIONED_BY="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const j=JSON.parse(s);const r=j.state.resources;const k=Object.keys(r).find(x=>r[x].resourceType==="AWS::EKS::Cluster");process.stdout.write(k?(r[k].provisionedBy||"sdk"):"missing-from-state")})')"
if [ "${PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: expected EKS cluster provisionedBy=cc-api, got '${PROVISIONED_BY}'" >&2
  exit 1
fi
echo "    cluster routed via Cloud Control (provisionedBy=cc-api)"

# --- Phase 2: bare destroy must fail on the protected cluster ----------
echo "==> Phase 2: bare destroy (must fail; protection is ON)"
if node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force \
    > destroy-blocked.log 2>&1; then
  echo "FAIL: bare destroy succeeded despite deletionProtection=true" >&2
  tail -20 destroy-blocked.log >&2
  exit 1
fi
echo "    bare destroy exited non-zero as expected"

STATUS_P2="$(aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}" \
  --query 'cluster.status' --output text)"
if [ "${STATUS_P2}" != "ACTIVE" ]; then
  echo "FAIL: expected cluster still ACTIVE after blocked destroy, got '${STATUS_P2}'" >&2
  exit 1
fi
echo "    cluster survived the blocked destroy (still ACTIVE)"

aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    cdkd state retained after blocked destroy"

# --- Phase 3: destroy --remove-protection ------------------------------
echo "==> Phase 3: destroy --remove-protection (flips protection off via CC patch, then deletes; ~10-15 min)"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

assert_gone "EKS cluster ${CLUSTER_NAME} still exists after destroy" \
  aws eks describe-cluster --name "${CLUSTER_NAME}" --region "${REGION}"
echo "    cluster deleted"

VPC_LEFT="$(aws ec2 describe-vpcs --region "${REGION}" --filters "Name=tag:Name,Values=${STACK}/Vpc" \
  --query 'length(Vpcs)' --output text)"
if [ "${VPC_LEFT}" != "0" ]; then
  echo "FAIL: fixture VPC still exists after destroy" >&2
  exit 1
fi
echo "    VPC deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — EKS cluster protected-destroy-block + destroy --remove-protection, all 3 phases passed"
