#!/usr/bin/env bash
#
# Failure-seeking real-AWS integ for cdkd's ELBv2 destroy ORDERING.
#
# Topology (CdkdDeletionOrderingComplexExample):
#   VPC (10.60.0.0/16, 2 public subnets, natGateways:0)
#   + InternetGateway + VPCGatewayAttachment
#   + SecurityGroup (HTTP :80)
#   + t3.nano EC2 Instance (registered as the TG IP target)
#   + ApplicationLoadBalancer (internet-facing, 2 public subnets)
#   + TargetGroup (TargetType: IP)
#   + Listener (:80 -> forward -> TargetGroup)
#   + ListenerRule (/app/* -> TargetGroup)
#
# What this stresses (NONE covered by an existing fixture; ELBv2 has NO
# implicit-delete-deps edge today):
#   - Listener / ListenerRule MUST be deleted BEFORE the TargetGroup, or
#     `DeleteTargetGroup` fails with `ResourceInUse`.
#   - TargetGroup + Listener MUST be deleted BEFORE the LoadBalancer.
#   - The LoadBalancer's hyperplane ENIs (and the EC2 target's ENI) MUST be
#     released BEFORE the Subnet / SecurityGroup delete, or EC2 rejects with
#     `DependencyViolation`. cdkd's `DeleteLoadBalancer` returns immediately
#     (no `waitUntilLoadBalancersDeleted`), so the subnet/SG delete can race
#     the async ENI teardown.
#
# STEPS:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDeletionOrderingComplexExample
#   3. assert the ALB + TargetGroup + Listener + ListenerRule exist
#   4. cdkd destroy --force  -> MUST exit 0 (the real test)
#   5. assert state is gone
#   6. assert all AWS resources gone (LB, TG, SG, subnets, IGW, VPC,
#      EC2 instance) -> 0 orphans
#
# If destroy fails (wrong ordering), the script prints the exact AWS
# dependency / ResourceInUse error for triage AND the EXIT trap tears the
# remaining resources down in AWS-SAFE order so a failing run never orphans
# the (cost-bearing) ALB / EC2 instance / VPC.
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
# BSD/macOS-portable: no `grep -P`, no `date -d`, real exit codes captured
# to variables, explicit `[verify] PASS` only on full success.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDeletionOrderingComplexExample"
FIXTURE_TAG_KEY="cdkd:integ-fixture"
FIXTURE_TAG_VALUE="deletion-ordering-complex"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/deletion-ordering-complex"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# ── Resource discovery helpers (by our own cdkd:integ-fixture tag) ──────────
# We own the tag (AWS reserves aws:* so cdkd cannot set aws:cdk:path), so we
# locate everything we created via the resourcegroupstaggingapi + per-service
# tag filters. Used by both the post-destroy orphan assertion and the trap.

find_load_balancer_arns() {
  aws elbv2 describe-load-balancers --region "${REGION}" \
    --query 'LoadBalancers[].LoadBalancerArn' --output text 2>/dev/null \
    | tr '\t' '\n' | while read -r arn; do
        [ -z "${arn}" ] && continue
        tags="$(aws elbv2 describe-tags --region "${REGION}" --resource-arns "${arn}" \
          --query "TagDescriptions[0].Tags[?Key=='${FIXTURE_TAG_KEY}' && Value=='${FIXTURE_TAG_VALUE}'] | length(@)" \
          --output text 2>/dev/null || echo 0)"
        if [ "${tags}" != "0" ] && [ -n "${tags}" ]; then echo "${arn}"; fi
      done
}

find_target_group_arns() {
  aws elbv2 describe-target-groups --region "${REGION}" \
    --query 'TargetGroups[].TargetGroupArn' --output text 2>/dev/null \
    | tr '\t' '\n' | while read -r arn; do
        [ -z "${arn}" ] && continue
        tags="$(aws elbv2 describe-tags --region "${REGION}" --resource-arns "${arn}" \
          --query "TagDescriptions[0].Tags[?Key=='${FIXTURE_TAG_KEY}' && Value=='${FIXTURE_TAG_VALUE}'] | length(@)" \
          --output text 2>/dev/null || echo 0)"
        if [ "${tags}" != "0" ] && [ -n "${tags}" ]; then echo "${arn}"; fi
      done
}

find_vpc_ids() {
  aws ec2 describe-vpcs --region "${REGION}" \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'Vpcs[].VpcId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

find_security_group_ids() {
  aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
    --query 'SecurityGroups[].GroupId' --output text 2>/dev/null | tr '\t' '\n' | grep -v '^$' || true
}

find_instance_ids() {
  aws ec2 describe-instances --region "${REGION}" \
    --filters "Name=tag:${FIXTURE_TAG_KEY},Values=${FIXTURE_TAG_VALUE}" \
              "Name=instance-state-name,Values=pending,running,stopping,stopped" \
    --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v '^$' || true
}

# ── Aggressive AWS-safe-order cleanup (only fires on a failure exit) ─────────
# Order: listener -> TG -> LB (wait deleted) -> EC2 instance (wait) ->
#        leftover ENIs -> SG -> subnets -> IGW detach+delete -> VPC.
# This mirrors the order AWS enforces, so it succeeds where a wrong-order
# cdkd destroy failed. Best-effort throughout (|| true) — never let the
# cleanup itself abort the trap.
cleanup() {
  rc=$?
  if [ "${rc}" -eq 0 ]; then
    exit 0
  fi
  echo "[verify] FAIL (exit ${rc}) — tearing down leftover AWS resources in AWS-safe order"

  # 1. Listeners + 2. TargetGroups (delete listeners first; a TG with a
  #    forwarding listener rejects DeleteTargetGroup).
  for lb in $(find_load_balancer_arns); do
    for la in $(aws elbv2 describe-listeners --region "${REGION}" --load-balancer-arn "${lb}" \
                  --query 'Listeners[].ListenerArn' --output text 2>/dev/null | tr '\t' '\n'); do
      [ -n "${la}" ] && aws elbv2 delete-listener --region "${REGION}" --listener-arn "${la}" 2>/dev/null || true
    done
  done
  for tg in $(find_target_group_arns); do
    aws elbv2 delete-target-group --region "${REGION}" --target-group-arn "${tg}" 2>/dev/null || true
  done

  # 3. LoadBalancers — delete then wait for the ENIs to release.
  LB_ARNS="$(find_load_balancer_arns || true)"
  for lb in ${LB_ARNS}; do
    aws elbv2 delete-load-balancer --region "${REGION}" --load-balancer-arn "${lb}" 2>/dev/null || true
  done
  for lb in ${LB_ARNS}; do
    aws elbv2 wait load-balancers-deleted --region "${REGION}" --load-balancer-arns "${lb}" 2>/dev/null || true
  done

  # 4. EC2 instance(s) — terminate + wait (releases its ENI).
  INST_IDS="$(find_instance_ids || true)"
  if [ -n "${INST_IDS}" ]; then
    aws ec2 terminate-instances --region "${REGION}" --instance-ids ${INST_IDS} 2>/dev/null || true
    aws ec2 wait instance-terminated --region "${REGION}" --instance-ids ${INST_IDS} 2>/dev/null || true
  fi

  # 5. Per-VPC dependents: leftover ENIs -> SGs -> subnets -> IGW -> VPC.
  for vpc in $(find_vpc_ids); do
    for eni in $(aws ec2 describe-network-interfaces --region "${REGION}" \
                   --filters "Name=vpc-id,Values=${vpc}" \
                   --query 'NetworkInterfaces[?Status==`available`].NetworkInterfaceId' \
                   --output text 2>/dev/null | tr '\t' '\n'); do
      [ -n "${eni}" ] && aws ec2 delete-network-interface --region "${REGION}" --network-interface-id "${eni}" 2>/dev/null || true
    done
    for sg in $(find_security_group_ids); do
      aws ec2 delete-security-group --region "${REGION}" --group-id "${sg}" 2>/dev/null || true
    done
    for sn in $(aws ec2 describe-subnets --region "${REGION}" \
                  --filters "Name=vpc-id,Values=${vpc}" \
                  --query 'Subnets[].SubnetId' --output text 2>/dev/null | tr '\t' '\n'); do
      [ -n "${sn}" ] && aws ec2 delete-subnet --region "${REGION}" --subnet-id "${sn}" 2>/dev/null || true
    done
    for igw in $(aws ec2 describe-internet-gateways --region "${REGION}" \
                   --filters "Name=attachment.vpc-id,Values=${vpc}" \
                   --query 'InternetGateways[].InternetGatewayId' --output text 2>/dev/null | tr '\t' '\n'); do
      [ -z "${igw}" ] && continue
      aws ec2 detach-internet-gateway --region "${REGION}" --internet-gateway-id "${igw}" --vpc-id "${vpc}" 2>/dev/null || true
      aws ec2 delete-internet-gateway --region "${REGION}" --internet-gateway-id "${igw}" 2>/dev/null || true
    done
    aws ec2 delete-vpc --region "${REGION}" --vpc-id "${vpc}" 2>/dev/null || true
  done

  # Best-effort cdkd state cleanup so a re-run is not blocked.
  ${CLI} state destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes 2>/dev/null || true
  ${CLI} state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" 2>/dev/null || true

  echo "[verify] cleanup attempt complete (exit ${rc})"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# ── step 3: assert the ELBv2 web exists ─────────────────────────────────────
echo "[verify] step 3: assert ALB + TargetGroup + Listener + ListenerRule exist"

LB_ARNS="$(find_load_balancer_arns || true)"
if [ -z "${LB_ARNS}" ]; then
  echo "[verify] FAIL: no tagged ApplicationLoadBalancer found after deploy"
  exit 1
fi
LB_COUNT="$(printf '%s\n' "${LB_ARNS}" | grep -c . || true)"
echo "[verify]   LoadBalancer(s): ${LB_COUNT}"
LB_ARN="$(printf '%s\n' "${LB_ARNS}" | head -n1)"

TG_ARNS="$(find_target_group_arns || true)"
if [ -z "${TG_ARNS}" ]; then
  echo "[verify] FAIL: no tagged TargetGroup found after deploy"
  exit 1
fi
echo "[verify]   TargetGroup(s): $(printf '%s\n' "${TG_ARNS}" | grep -c . || true)"

LISTENER_COUNT="$(aws elbv2 describe-listeners --region "${REGION}" --load-balancer-arn "${LB_ARN}" \
  --query 'length(Listeners)' --output text 2>/dev/null || echo 0)"
if [ "${LISTENER_COUNT}" = "0" ] || [ -z "${LISTENER_COUNT}" ] || [ "${LISTENER_COUNT}" = "None" ]; then
  echo "[verify] FAIL: LoadBalancer ${LB_ARN} has no Listener"
  exit 1
fi
echo "[verify]   Listener(s): ${LISTENER_COUNT}"

LISTENER_ARN="$(aws elbv2 describe-listeners --region "${REGION}" --load-balancer-arn "${LB_ARN}" \
  --query 'Listeners[0].ListenerArn' --output text 2>/dev/null)"
# A non-default ListenerRule (our /app/* rule) — exclude the `default` rule.
RULE_COUNT="$(aws elbv2 describe-rules --region "${REGION}" --listener-arn "${LISTENER_ARN}" \
  --query "length(Rules[?IsDefault==\`false\`])" --output text 2>/dev/null || echo 0)"
if [ "${RULE_COUNT}" = "0" ] || [ -z "${RULE_COUNT}" ] || [ "${RULE_COUNT}" = "None" ]; then
  echo "[verify] FAIL: no non-default ListenerRule found on ${LISTENER_ARN}"
  exit 1
fi
echo "[verify]   non-default ListenerRule(s): ${RULE_COUNT}"
echo "[verify] step 3 ok: ELBv2 web present"

# ── step 4: THE TEST — destroy must be clean (correct ordering) ─────────────
# Capture the destroy log so that on failure we can surface the exact AWS
# dependency / ResourceInUse error for triage.
echo "[verify] step 4: cdkd destroy --force (MUST exit 0 — the ordering test)"
DESTROY_LOG="$(mktemp -t cdkd-delorder-destroy.XXXXXX)"
set +e
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force --verbose > "${DESTROY_LOG}" 2>&1
DESTROY_RC=$?
set -e
# Echo the tail so a reader sees progress regardless of outcome.
tail -n 40 "${DESTROY_LOG}" || true
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "[verify] FAIL: cdkd destroy exited ${DESTROY_RC} — destroy ordering is WRONG."
  echo "[verify] ── exact AWS dependency / ResourceInUse error(s) for triage ──"
  grep -iE 'DependencyViolation|ResourceInUse|has a dependent object|is currently in use|mapped public address|ResourceInUseException|cannot be deleted' \
    "${DESTROY_LOG}" || echo "[verify]   (no dependency-ordering signature matched — see full log below)"
  echo "[verify] ── full destroy log ──"
  cat "${DESTROY_LOG}" || true
  rm -f "${DESTROY_LOG}"
  exit "${DESTROY_RC}"
fi
rm -f "${DESTROY_LOG}"
echo "[verify] step 4 ok: cdkd destroy exited 0"

# ── step 5: state must be gone ──────────────────────────────────────────────
echo "[verify] step 5: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 5 ok: state cleared"

# ── step 6: assert ALL AWS resources gone (0 orphans) ───────────────────────
# State-empty alone misses orphans that carry no stack name; assert each
# resource family by our own tag. (#796 lesson: state-empty != AWS-empty.)
echo "[verify] step 6: assert all tagged AWS resources gone (0 orphans)"

LEFT_LB="$(find_load_balancer_arns || true)"
LEFT_TG="$(find_target_group_arns || true)"
LEFT_VPC="$(find_vpc_ids || true)"
LEFT_SG="$(find_security_group_ids || true)"
LEFT_INST="$(find_instance_ids || true)"

ORPHANS=0
if [ -n "${LEFT_LB}" ]; then echo "[verify]   ORPHAN LoadBalancer(s): ${LEFT_LB}"; ORPHANS=1; fi
if [ -n "${LEFT_TG}" ]; then echo "[verify]   ORPHAN TargetGroup(s): ${LEFT_TG}"; ORPHANS=1; fi
if [ -n "${LEFT_VPC}" ]; then echo "[verify]   ORPHAN VPC(s): ${LEFT_VPC}"; ORPHANS=1; fi
if [ -n "${LEFT_SG}" ]; then echo "[verify]   ORPHAN SecurityGroup(s): ${LEFT_SG}"; ORPHANS=1; fi
if [ -n "${LEFT_INST}" ]; then echo "[verify]   ORPHAN EC2 instance(s): ${LEFT_INST}"; ORPHANS=1; fi

if [ "${ORPHANS}" -ne 0 ]; then
  echo "[verify] FAIL: orphan AWS resources remain after destroy (see above)."
  echo "[verify]       The destroy reported success but did NOT actually delete everything,"
  echo "[verify]       OR a subnet/ENI DependencyViolation was swallowed."
  exit 1
fi
echo "[verify] step 6 ok: no orphan AWS resources (LB / TG / SG / subnets / IGW / VPC / EC2 all gone)"

trap - EXIT INT TERM
echo "[verify] PASS"
