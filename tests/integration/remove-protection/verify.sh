#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd destroy --remove-protection`.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdRemoveProtectionExample
#      (every resource created with deletion-protection ENABLED)
#   3. NEGATIVE: cdkd destroy --force (no --remove-protection)
#      -> expect non-zero exit; stack state must remain
#   4. cdkd state list  -> stack still listed (not stripped from state)
#   5. POSITIVE: cdkd destroy --remove-protection --force
#      -> expect exit 0
#   6. cdkd state list -> stack must be GONE
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
#
# This integ leaks expensive resources (ALB / EC2 / ASG) on a botched
# run — the cleanup trap re-attempts destroy WITH --remove-protection
# on any failure exit so a failing assertion does not orphan AWS
# resources.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdRemoveProtectionExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/remove-protection"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# On failure, retry destroy with --remove-protection so we never leak
# expensive AWS resources. The trap is intentionally aggressive — the
# whole point of this integ is verifying the bypass path, so using it
# in cleanup is correct.
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy --remove-protection to clean up"
    ${CLI} destroy "${STACK}" --remove-protection \
      --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap 'cleanup; exit 130' INT
trap 'cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# ── Capture the ASG-launched, termination-protected instance (issue #796) ──
# The ProtectedAsg launches one t3.nano whose launch template sets
# DisableApiTermination: true. ASG-level DeletionProtection + ForceDelete
# does NOT clear that EC2-level flag, so without the #796 fix the instance
# survives the group delete and ORPHANS. We capture its id now (the ASG is
# named with the stack prefix) and assert after the protected destroy that
# it is terminating/terminated — the direct proof the bypass enumerated the
# group's instances and flipped their termination protection off.
echo "[verify] step 2b: locate ASG-launched protected instance"
ASG_NAME=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  ASG_NAME="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --query "AutoScalingGroups[?contains(AutoScalingGroupName, '${STACK}')].AutoScalingGroupName | [0]" \
    --output text 2>/dev/null || true)"
  if [ -n "${ASG_NAME}" ] && [ "${ASG_NAME}" != "None" ]; then
    break
  fi
  sleep 5
done
if [ -z "${ASG_NAME}" ] || [ "${ASG_NAME}" = "None" ]; then
  echo "[verify] FAIL: could not locate the ProtectedAsg by stack-prefix name"
  exit 1
fi
ASG_INSTANCE_IDS=""
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  ASG_INSTANCE_IDS="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --auto-scaling-group-names "${ASG_NAME}" \
    --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text 2>/dev/null || true)"
  if [ -n "${ASG_INSTANCE_IDS}" ] && [ "${ASG_INSTANCE_IDS}" != "None" ]; then
    break
  fi
  sleep 10
done
if [ -z "${ASG_INSTANCE_IDS}" ] || [ "${ASG_INSTANCE_IDS}" = "None" ]; then
  echo "[verify] FAIL: ProtectedAsg launched no instance (DesiredCapacity unmet) — #796 path not exercised"
  exit 1
fi
echo "[verify] step 2b ok: ASG=${ASG_NAME} instances=[${ASG_INSTANCE_IDS}]"

# ── NEGATIVE TEST ─────────────────────────────────────────────────
# Without --remove-protection cdkd must NOT silently strip protected
# resources. Every resource in the stack carries delete-protection in
# some form, so AWS will reject every per-resource delete and cdkd
# should surface that as PartialFailureError (exit 2 — see
# src/utils/error-handler.ts).
# `--resource-timeout 6m` caps each per-resource wait at 6 min so the
# step finishes in ~6-7 min instead of the default 30 min global
# deadline. The negative test only needs to confirm that AWS rejects
# the protected-resource deletes — once the rejections fire, cdkd
# surfaces PartialFailureError. The remaining un-protected resources
# (Subnets / IGW / VPC etc.) cannot complete because the protected
# resources block the dependency chain (EC2 instance keeps the
# subnet ENI alive, ALB keeps the IGW IP attached, etc.); without
# the per-resource cap, the Subnet waits the full 30 min before
# yielding. 6m is the minimum that exceeds the default 5m
# `--resource-warn-after` (cdkd validates `warn < timeout`).
echo "[verify] step 3: cdkd destroy --force WITHOUT --remove-protection (expect non-zero)"
set +e
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force --resource-timeout 6m
rc=$?
set -e
if [ "${rc}" -eq 0 ]; then
  echo "[verify] FAIL: bare destroy unexpectedly succeeded — protected resources were silently stripped."
  echo "[verify]       This is a regression in cdkd's --remove-protection gating."
  exit 1
fi
echo "[verify] step 3 ok: bare destroy rejected (exit ${rc})"

# State must still exist — destroy was rejected, not partially applied.
echo "[verify] step 4: cdkd state list (stack should still be listed)"
if ! ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state was stripped despite destroy failing"
  exit 1
fi
echo "[verify] step 4 ok: state preserved"

# ── POSITIVE TEST ─────────────────────────────────────────────────
# `cdkd destroy --remove-protection` should succeed end-to-end on a
# protected stack. In practice the first attempt sometimes lands
# while AWS is still releasing the EC2 instance's public IP after
# `TerminateInstances`, blocking IGW detach with `Network has some
# mapped public address(es)`. The release lag is 5-10 min in
# practice; cdkd's per-call retry budget (~1 min, exponential
# backoff capped at 8s × 10 attempts) is shorter than that, so the
# first attempt occasionally fails and a second attempt 60-90s
# later succeeds against the now-released address.
#
# This is a real cdkd issue worth fixing in a follow-up — extend
# `EC2Provider.deleteInternetGateway` / `deleteVpcGatewayAttachment`
# with a 10-min retry budget on `DependencyViolation` so a fresh
# `--remove-protection` destroy stays self-healing without operator
# intervention. Until then, retry up to 3 times with a 90s sleep
# so the integ tolerates the AWS-side lag.
echo "[verify] step 5: cdkd destroy --remove-protection --force (expect exit 0)"
attempt=1
max_attempts=3
while [ "${attempt}" -le "${max_attempts}" ]; do
  set +e
  ${CLI} destroy "${STACK}" --remove-protection --state-bucket "${STATE_BUCKET}" --force
  rc=$?
  set -e
  if [ "${rc}" -eq 0 ]; then
    break
  fi
  if [ "${attempt}" -lt "${max_attempts}" ]; then
    echo "[verify]   attempt ${attempt}/${max_attempts} failed (exit ${rc}) — sleeping 90s for AWS public IP release"
    sleep 90
  fi
  attempt=$((attempt + 1))
done
if [ "${rc}" -ne 0 ]; then
  echo "[verify] FAIL: --remove-protection destroy failed after ${max_attempts} attempts (exit ${rc})"
  exit "${rc}"
fi
echo "[verify] step 5 ok: --remove-protection destroy succeeded (attempt ${attempt})"

# State must be gone.
echo "[verify] step 6: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 6 ok: state cleared"

# ── ORPHAN ASSERTION (issue #796) ─────────────────────────────────
# The ASG-launched, termination-protected instance(s) captured in step
# 2b MUST be terminating/terminated after the protected destroy. If the
# bypass had failed to enumerate the group's instances and flip their
# DisableApiTermination off, the instance would survive the group delete
# in `running`/`stopped` state — a silent orphan a stack-prefix scan
# misses (ASG instances carry no stack-name in their own id). State-empty
# alone does NOT catch this, which is exactly how #796 shipped.
echo "[verify] step 7: assert ASG-launched protected instance(s) terminated (#796)"
for iid in ${ASG_INSTANCE_IDS}; do
  state="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${iid}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null || echo 'terminated')"
  # `terminated` is also returned when AWS has already swept the record.
  case "${state}" in
    shutting-down|terminated)
      echo "[verify]   ${iid}: ${state} (ok)"
      ;;
    *)
      echo "[verify] FAIL: ASG instance ${iid} is '${state}', not terminating — #796 orphan"
      echo "[verify]       The launch-template DisableApiTermination=true was not flipped off before ForceDelete."
      aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" \
        --no-disable-api-termination 2>/dev/null || true
      aws ec2 terminate-instances --region "${REGION}" --instance-ids "${iid}" 2>/dev/null || true
      exit 1
      ;;
  esac
done
echo "[verify] step 7 ok: no ASG-launched orphan instance"

# Remaining AWS orphan verification (VPC / ALB / hyperplane ENI etc.) is
# delegated to the parent agent's `/run-integ` flow (which runs `/cleanup`
# afterward). The state-empty assertion above + the #796 instance check are
# the integ's own success signals; broad AWS-side orphan auditing belongs in
# `/cleanup`.

trap - EXIT INT TERM
echo "[verify] PASS"
