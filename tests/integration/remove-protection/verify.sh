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
#   4b. COMPENSATION (issue #2204): add an out-of-band hosted-UI domain to
#      the user pool (DeleteUserPool then refuses TERMINALLY), run
#      cdkd destroy --remove-protection --force -> expect non-zero, and
#      assert the pool's DeletionProtection is back to ACTIVE: cdkd turned
#      it off, the delete failed, so cdkd must put it back. Also assert
#      AllowAdminCreateUserOnly is still true: the flip and re-enable echo
#      the pool back instead of resetting what they omit (issue #4066). In
#      the SAME destroy, an out-of-band VPC endpoint service on the NLB makes
#      DeleteLoadBalancer refuse terminally; assert the NLB's
#      deletion_protection.enabled is back to true. Then delete the domain
#      and the endpoint service.
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

# Step 4b's out-of-band user pool domain (issue #2204). Not in cdkd state, so
# cdkd's destroy cannot remove it: cleanup deletes it FIRST. Set just before
# the create; the pool id is read from state right after the step-2 deploy.
USER_POOL_ID=""
OOB_POOL_DOMAIN=""
# Step 4b's out-of-band VPC endpoint service on the NLB (issue #2204): not in
# cdkd state either, and while it stands DeleteLoadBalancer refuses, so cleanup
# deletes it FIRST too. The NLB ARN is read from state after the deploy.
NLB_ARN=""
OOB_ENDPOINT_SERVICE_ID=""
# Step 4b's captured destroy output; removed by cleanup too, since a signal
# landing mid-destroy never reaches the step's own `rm`.
DESTROY_4B_LOG=""

# Poll until the endpoint service is gone (not found, or Deleted): the NLB
# stays associated until it is. Returns non-zero when it is still there after
# 2 min.
wait_endpoint_service_gone() { # usage: wait_endpoint_service_gone <service id>
  local state=""
  for _ in $(seq 1 24); do
    if gone_probe aws ec2 describe-vpc-endpoint-service-configurations --region "${REGION}" \
        --service-ids "$1"; then
      return 0
    fi
    state="$(aws ec2 describe-vpc-endpoint-service-configurations --region "${REGION}" \
      --service-ids "$1" --query 'ServiceConfigurations[0].ServiceState' --output text)" || {
      # Deleted between the probe above and this read: the next probe says so.
      sleep 5
      continue
    }
    if [ "${state}" = "Deleted" ] || [ "${state}" = "None" ]; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] endpoint service ${1} is still '${state}' 2 min after its delete" >&2
  return 1
}

# The NLB's deletion_protection.enabled attribute, as ELBv2 reports it.
nlb_deletion_protection() { # usage: nlb_deletion_protection <load balancer arn>
  aws elbv2 describe-load-balancer-attributes --region "${REGION}" --load-balancer-arn "$1" \
    --query "Attributes[?Key=='deletion_protection.enabled'].Value | [0]" --output text
}

# Poll until the pool no longer reports a domain: DeleteUserPool keeps
# refusing until it does. Returns non-zero when it is still there after 2 min.
wait_pool_domain_gone() { # usage: wait_pool_domain_gone <pool id>
  local left=""
  for _ in $(seq 1 24); do
    left="$(aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "$1" \
      --query 'UserPool.Domain' --output text)" || return 1
    if [ "${left}" = "None" ] || [ -z "${left}" ]; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] ${1} still reports domain '${left}' 2 min after delete-user-pool-domain" >&2
  return 1
}

# On failure, retry destroy with --remove-protection so we never leak
# expensive AWS resources. The trap is intentionally aggressive — the
# whole point of this integ is verifying the bypass path, so using it
# in cleanup is correct.
cleanup() {
  rc=$?
  [ -n "${DESTROY_4B_LOG}" ] && rm -f "${DESTROY_4B_LOG}"
  if [ "${rc}" -ne 0 ]; then
    # Step 4b's out-of-band domain first: while it stands, DeleteUserPool
    # refuses and the destroy below leaks the pool.
    if [ -n "${OOB_POOL_DOMAIN}" ] && [ -n "${USER_POOL_ID}" ]; then
      aws cognito-idp delete-user-pool-domain --region "${REGION}" \
        --domain "${OOB_POOL_DOMAIN}" --user-pool-id "${USER_POOL_ID}" >/dev/null 2>&1 || true
      wait_pool_domain_gone "${USER_POOL_ID}" || true
    fi
    # Likewise the endpoint service: while it stands, DeleteLoadBalancer
    # refuses and the destroy below leaks the NLB (and the VPC behind it).
    # A create that landed while the CLI still failed leaves the id unset:
    # find it by the tag step 4b gives it.
    if [ -z "${OOB_ENDPOINT_SERVICE_ID}" ] && [ -n "${NLB_ARN}" ]; then
      OOB_ENDPOINT_SERVICE_ID="$(aws ec2 describe-vpc-endpoint-service-configurations --region "${REGION}" \
        --filters "Name=tag:Name,Values=${STACK}-4b" \
        --query 'ServiceConfigurations[0].ServiceId' --output text 2>/dev/null)" || OOB_ENDPOINT_SERVICE_ID=""
      [ "${OOB_ENDPOINT_SERVICE_ID}" = "None" ] && OOB_ENDPOINT_SERVICE_ID=""
    fi
    if [ -n "${OOB_ENDPOINT_SERVICE_ID}" ]; then
      aws ec2 delete-vpc-endpoint-service-configurations --region "${REGION}" \
        --service-ids "${OOB_ENDPOINT_SERVICE_ID}" >/dev/null 2>&1 || true
      # A subshell: gone_probe exits on an undetermined probe, which must not
      # end the cleanup before its destroy.
      (wait_endpoint_service_gone "${OOB_ENDPOINT_SERVICE_ID}") || true
    fi
    echo "[verify] FAIL (exit ${rc}) — attempting destroy --remove-protection to clean up"
    ${CLI} destroy "${STACK}" --remove-protection \
      --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

# Step 4b's user pool id, read NOW: step 3's failing destroy writes back a
# state snapshot with `outputs: {}`, so the output is gone by step 4b.
USER_POOL_ID="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).state?.outputs??{};if(!o.UserPoolId)throw new Error("no UserPoolId output");process.stdout.write(String(o.UserPoolId))})')"
case "${USER_POOL_ID}" in
  "${REGION}"_?*) ;;
  *)
    echo "[verify] FAIL: UserPoolId output '${USER_POOL_ID}' is not a ${REGION} pool id"
    exit 1
    ;;
esac
# The NLB's ARN, read now for the same reason.
NLB_ARN="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s).state?.outputs??{};if(!o.NlbArn)throw new Error("no NlbArn output");process.stdout.write(String(o.NlbArn))})')"
case "${NLB_ARN}" in
  arn:*:elasticloadbalancing:"${REGION}":*:loadbalancer/net/?*) ;;
  *)
    echo "[verify] FAIL: NlbArn output '${NLB_ARN}' is not a ${REGION} NLB ARN"
    exit 1
    ;;
esac

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
    --output text)"
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
    --query 'AutoScalingGroups[0].Instances[].InstanceId' --output text)"
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

# ── COMPENSATION ARM (issue #2204) ────────────────────────────────
# `--remove-protection` turns the user pool's DeletionProtection OFF, then
# deletes it. When that delete fails TERMINALLY, cdkd must turn the guard back
# ON before reporting the failure: a destroy that did not happen must not leave
# a live pool with its guard stripped. An out-of-band hosted-UI domain makes
# DeleteUserPool refuse ("has a domain configured that should be deleted
# first"), which matches no retryable pattern. The NLB is the same arm for
# ELBv2's deletion_protection.enabled: an out-of-band VPC endpoint service
# backed by it makes DeleteLoadBalancer refuse ("currently associated with
# another service"), terminal too. The rest of the stack is deleted by this
# destroy, except the VPC pieces the surviving NLB holds; step 5 then deletes
# what is left.
#
# The log group has no counterpart arm: no DeleteLogGroup refusal that is both
# TERMINAL and constructible from outside exists (an IAM deny reads "not
# authorized to perform", which is retryable, and exhausting the retry cap is
# a documented non-compensated case), so its compensation is unit-tested only.
# The Auto Scaling group has none for the same reason: `ForceDelete` deletes
# the instances and outstanding lifecycle actions that make
# DeleteAutoScalingGroup refuse otherwise, and no other terminal refusal is
# known to be constructible from outside.
echo "[verify] step 4b: --remove-protection compensation on terminally failing user pool + NLB deletes (#2204)"
# Precondition: the guard is ON going in, or the assertion below is vacuous
# (step 3's bare destroy must not have touched it).
PRE_DP="$(aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "${USER_POOL_ID}" \
  --query 'UserPool.DeletionProtection' --output text)"
if [ "${PRE_DP}" != "ACTIVE" ]; then
  echo "[verify] FAIL: precondition — ${USER_POOL_ID} DeletionProtection is '${PRE_DP}', not ACTIVE"
  exit 1
fi
# Issue #4066: a member UpdateUserPool RESETS when a call omits it. The CDK
# default (self sign-up off) is AllowAdminCreateUserOnly: true, measured to
# reset to false -- self sign-up switched ON -- under a DeletionProtection-only
# write. Precondition first, so the assertion after the destroy is not vacuous.
PRE_ADMIN_ONLY="$(aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "${USER_POOL_ID}" \
  --query 'UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' --output text)"
if [ "${PRE_ADMIN_ONLY}" != "True" ]; then
  echo "[verify] FAIL: precondition — ${USER_POOL_ID} AllowAdminCreateUserOnly is '${PRE_ADMIN_ONLY}', not True"
  exit 1
fi
# A hosted-UI prefix: lowercase letters, digits and hyphens, no "aws" /
# "amazon" / "cognito", globally unique. Random rather than account-derived:
# the prefix is a publicly resolvable name while it exists.
OOB_POOL_DOMAIN="cdkd-rp-$(date +%s)-$(openssl rand -hex 4)"
aws cognito-idp create-user-pool-domain --region "${REGION}" \
  --domain "${OOB_POOL_DOMAIN}" --user-pool-id "${USER_POOL_ID}" >/dev/null
# The NLB's precondition, for the same reason as the pool's.
PRE_NLB_DP="$(nlb_deletion_protection "${NLB_ARN}")"
if [ "${PRE_NLB_DP}" != "true" ]; then
  echo "[verify] FAIL: precondition — ${NLB_ARN} deletion_protection.enabled is '${PRE_NLB_DP}', not true"
  exit 1
fi
# Assigned straight from the create's output: the cleanup deletes it by this id
# from here on.
OOB_ENDPOINT_SERVICE_ID="$(aws ec2 create-vpc-endpoint-service-configuration --region "${REGION}" \
  --network-load-balancer-arns "${NLB_ARN}" --no-acceptance-required \
  --tag-specifications "ResourceType=vpc-endpoint-service,Tags=[{Key=Name,Value=${STACK}-4b}]" \
  --query 'ServiceConfiguration.ServiceId' --output text)"
case "${OOB_ENDPOINT_SERVICE_ID}" in
  vpce-svc-?*) ;;
  *)
    echo "[verify] FAIL: create-vpc-endpoint-service-configuration returned '${OOB_ENDPOINT_SERVICE_ID}'"
    exit 1
    ;;
esac
# Wait for it to be Available, so the association the refusal needs is in place
# before the destroy reaches the NLB.
EPS_STATE=""
for _ in $(seq 1 24); do
  EPS_STATE="$(aws ec2 describe-vpc-endpoint-service-configurations --region "${REGION}" \
    --service-ids "${OOB_ENDPOINT_SERVICE_ID}" \
    --query 'ServiceConfigurations[0].ServiceState' --output text)"
  [ "${EPS_STATE}" = "Available" ] && break
  sleep 5
done
if [ "${EPS_STATE}" != "Available" ]; then
  echo "[verify] FAIL: endpoint service ${OOB_ENDPOINT_SERVICE_ID} is '${EPS_STATE}', not Available, after 2 min"
  exit 1
fi
DESTROY_4B_LOG="$(mktemp)"
# `--resource-timeout 6m`: as in step 3, caps the waits of the resources this
# destroy cannot finish (the IGW public-IP lag, and the subnets and VPC the
# surviving NLB holds) so the step does not sit out
# the 30 min default before its expected failure.
set +e
${CLI} destroy "${STACK}" --remove-protection --state-bucket "${STATE_BUCKET}" --force \
  --resource-timeout 6m > "${DESTROY_4B_LOG}" 2>&1
rc=$?
set -e
cat "${DESTROY_4B_LOG}"
if [ "${rc}" -eq 0 ]; then
  echo "[verify] FAIL: destroy succeeded although the user pool carries an out-of-band domain and the NLB an endpoint service"
  exit 1
fi
# The NLB must still be there (its delete really failed) ...
if ! POST_NLB_DP="$(nlb_deletion_protection "${NLB_ARN}" 2>&1)"; then
  echo "[verify] FAIL: could not read ${NLB_ARN} after the failed destroy: ${POST_NLB_DP}"
  exit 1
fi
# ... with its guard back ON: before the fix this read false.
if [ "${POST_NLB_DP}" != "true" ]; then
  echo "[verify] FAIL: ${NLB_ARN} was left with deletion_protection.enabled '${POST_NLB_DP}' after the failed destroy (#2204)"
  exit 1
fi
# ... and it was cdkd that turned it off and back on in this run.
if ! grep -qF "re-enabled on ${NLB_ARN}" "${DESTROY_4B_LOG}"; then
  echo "[verify] FAIL: deletion_protection.enabled is true but the destroy output carries no re-enable line for ${NLB_ARN}"
  exit 1
fi
# The pool must still be there (the delete really failed) ...
if ! POST_DP="$(aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "${USER_POOL_ID}" \
    --query 'UserPool.DeletionProtection' --output text 2>&1)"; then
  echo "[verify] FAIL: could not read ${USER_POOL_ID} after the failed destroy: ${POST_DP}"
  exit 1
fi
# ... and its guard back ON. This is the assertion the fix exists for: before
# it, the flip-off was never undone and this read INACTIVE.
if [ "${POST_DP}" != "ACTIVE" ]; then
  echo "[verify] FAIL: ${USER_POOL_ID} was left with DeletionProtection '${POST_DP}' after the failed destroy (#2204)"
  exit 1
fi
# ... and the flip and re-enable changed NOTHING else (#4066): both echo the
# pool's configuration back, so self sign-up is still off.
POST_ADMIN_ONLY="$(aws cognito-idp describe-user-pool --region "${REGION}" --user-pool-id "${USER_POOL_ID}" \
  --query 'UserPool.AdminCreateUserConfig.AllowAdminCreateUserOnly' --output text)"
if [ "${POST_ADMIN_ONLY}" != "True" ]; then
  echo "[verify] FAIL: ${USER_POOL_ID} AllowAdminCreateUserOnly is '${POST_ADMIN_ONLY}' after the failed destroy — the flip or re-enable reset it (#4066)"
  exit 1
fi
# The flip really happened in THIS run and was undone by cdkd, not merely never
# issued: only the compensation's line says so. A reword fails here loudly.
if ! grep -qF "re-enabled on ${USER_POOL_ID}" "${DESTROY_4B_LOG}"; then
  echo "[verify] FAIL: DeletionProtection is ACTIVE but the destroy output carries no re-enable line for ${USER_POOL_ID}"
  exit 1
fi
rm -f "${DESTROY_4B_LOG}"
DESTROY_4B_LOG=""
aws cognito-idp delete-user-pool-domain --region "${REGION}" \
  --domain "${OOB_POOL_DOMAIN}" --user-pool-id "${USER_POOL_ID}" >/dev/null
if ! wait_pool_domain_gone "${USER_POOL_ID}"; then
  echo "[verify] FAIL: the out-of-band domain did not clear from ${USER_POOL_ID}"
  exit 1
fi
OOB_POOL_DOMAIN=""
aws ec2 delete-vpc-endpoint-service-configurations --region "${REGION}" \
  --service-ids "${OOB_ENDPOINT_SERVICE_ID}" >/dev/null
if ! wait_endpoint_service_gone "${OOB_ENDPOINT_SERVICE_ID}"; then
  echo "[verify] FAIL: the out-of-band endpoint service ${OOB_ENDPOINT_SERVICE_ID} did not go away"
  exit 1
fi
OOB_ENDPOINT_SERVICE_ID=""
echo "[verify] step 4b ok: the failed deletes put DeletionProtection back to ACTIVE on ${USER_POOL_ID} and deletion_protection.enabled back to true on ${NLB_ARN}"

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
  # `terminated` is also spelled by AWS as sweeping the record entirely
  # (InvalidInstanceID.NotFound) once the terminated instance ages out.
  if gone_probe aws ec2 describe-instances --region "${REGION}" --instance-ids "${iid}"; then
    state="terminated"
  elif ! state="$(aws ec2 describe-instances --region "${REGION}" --instance-ids "${iid}" \
      --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1)"; then
    # TOCTOU: the record can be swept between gone_probe and this requery.
    printf '%s' "${state}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
      && state="terminated" \
      || { echo "[verify] FAIL: describe-instances requery undetermined: ${state}"; exit 1; }
  fi
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
