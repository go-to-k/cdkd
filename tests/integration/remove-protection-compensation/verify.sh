#!/usr/bin/env bash
# verify.sh — cdkd `--remove-protection` compensation integ (issue #2204).
#
# `cdkd destroy --remove-protection` turns a resource's guard off, then
# deletes it. When the delete fails TERMINALLY, cdkd must turn the guard back
# on before reporting the failure. This fixture covers four routes that
# compensation was added to in one stack:
#   - SdkInstance    AWS::EC2::Instance, SDK route (DisableApiTermination)
#   - CcInstance     AWS::EC2::Instance, Cloud Control route (DisableApiTermination)
#   - ProtectConfig  AWS::SMSVOICE::ProtectConfiguration, the Cloud Control
#                    protection registry (DeletionProtectionEnabled)
#   - ProtectedAsg   AWS::AutoScaling::AutoScalingGroup: the DisableApiTermination
#                    of the instance it launched, which the group delete turns
#                    off before ForceDelete (issue #796)
#
# Each delete is refused DETERMINISTICALLY by a dependent cdkd does not
# manage, attached out of band after the deploy (the shape of the Cognito arm
# in tests/integration/remove-protection/verify.sh):
#   - each instance gets STOP protection (`DisableApiStop`). It refuses
#     TerminateInstances through the API but is a separate attribute from
#     `DisableApiTermination`, so cdkd's flip of DisableApiTermination lands and
#     the terminate is still refused;
#   - the protect configuration is associated with a configuration set this
#     script creates, which refuses DeleteProtectConfiguration. A FIRST-attempt
#     conflict is a refusal (`ccDeleteMayHaveActed`), so it is compensated.
#   - the Auto Scaling group has no such dependent: `ForceDelete` deletes the
#     instances and lifecycle actions that would otherwise hold it. So phase 2
#     runs the destroy under a role this script creates. Its inline policy
#     allows only the services this stack's destroy calls (S3 on the state
#     bucket alone, EC2, Auto Scaling, Cloud Control, SMS Voice, SSM parameter reads, KMS
#     data-key use, `sts:GetCallerIdentity`), and explicitly denies
#     `autoscaling:UpdateAutoScalingGroup` on that one group. (An IAM deny on
#     the delete itself would read "not authorized to perform", which is
#     retryable.) An allow-list too narrow for some future destroy call fails
#     phase 2 with that call's AccessDenied in the destroy output. cdkd's flip of the GROUP's
#     DeletionProtection is then refused (non-fatal by design), its flip of the
#     INSTANCE's DisableApiTermination lands, and the group's own
#     `prevent-all-deletion` refuses DeleteAutoScalingGroup. The role is
#     assumable only by the exact caller identity that runs this script
#     (`aws:userid`), and is deleted before phase 3 and by the cleanup trap.
#
# Phases:
#   1. Deploy (instances in the account's DEFAULT VPC). Assert each guard is ON
#      and each instance took the route it exists to cover. Attach the
#      dependents.
#   2. destroy --remove-protection. Assert: non-zero exit, all three still live,
#      cdkd's compensation line for each, and every guard ON afterwards. The
#      guard reading ON is a real discriminator here: nothing but cdkd's
#      compensation writes it back after cdkd's flip.
#   3. Detach the dependents; destroy --remove-protection: exit 0, all gone.
#
# A compensation STAND-DOWN (cdkd judged the delete may already be running,
# e.g. a handler failure filed under an ambiguous code) fails phase 2 loudly,
# naming it.
#
# Observed 2026-10-01 (first passing run):
#   SdkInstance   "Failed to terminate EC2 Instance SdkInstance: The instance
#                 '<id>' may not be terminated. Modify its 'disableApiStop'
#                 instance attribute and try again."
#   CcInstance    "DELETE failed for CcInstance: The instance '<id>' may not be
#                 terminated. Modify its 'disableApiStop' ... (Service: Ec2,
#                 Status Code: 400 ...)"
#   ProtectConfig "DELETE failed for ProtectConfig: Conflict Occurred -
#                 Reason="PROTECT_CONFIGURATION_ASSOCIATED_WITH_CONFIGURATION_SET"
#                 ... (Service: PinpointSmsVoiceV2, Status Code: 400 ...)"
#
# Both instance refusals read "may not be terminated", which matches cdkd's
# propagation-race classifier (`isTerminationProtectionPropagationError`). So
# each instance goes through the full re-flip-and-retry budget (5 attempts,
# 3s x attempt sleeps) before the terminal failure. On the Cloud Control route
# that same match is what exempts the refusal from the ambiguous-handler-code
# stand-down, so the CcInstance arm depends on the handler's message keeping
# that wording.
#
# NOT YET OBSERVED (the ASG arm was added after the first passing run): that
# Auto Scaling's AccessDenied for the deny role says "explicit deny" (phase 1c
# counts only that; otherwise it fails its precondition naming the last
# answer), and the exact wording of the `prevent-all-deletion` refusal and
# that it matches no retryable pattern. A retryable one would end the destroy at the attempt cap,
# where no compensation runs (issue #4318), and phase 2 would fail naming the
# missing compensation line.
#
# Not covered live here: the VerifiedPermissions PolicyStore's OBJECT-valued
# guard (`{"Mode":"ENABLED"}`). Its compensation is unit-tested, and its flip
# is exercised live by tests/integration/cc-protection-flip.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1. Needs a default VPC offering t3.nano.
# The caller also needs iam:CreateRole / PutRolePolicy / DeleteRolePolicy /
# DeleteRole / ListRoles and sts:AssumeRole on the role it creates.

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

STACK="CdkdRemoveProtectionCompensationExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PC_TYPE="AWS::SMSVOICE::ProtectConfiguration"
DESTROY_LOG="compensation-destroy.log"
# The configuration set is this run's own (unique name), and the sweep below
# finds any run's by the literal prefix.
CS_NAME="cdkd-rp-comp-$(date +%s)-$$"
# The deny role is this run's own, and the sweep finds any run's by the literal
# prefix. The launch template's name is the fixture's literal.
DENY_ROLE="cdkd-rp-comp-asg-deny-$(date +%s)-$$"
DENY_POLICY_NAME="cdkd-rp-comp-asg-deny"
LT_NAME="cdkd-rp-comp-asg-lt"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Detach every out-of-band dependent this fixture may have attached, found by
# LITERAL tag / prefix (no variable in a filter, so an empty value cannot
# widen the sweep). Idempotent and soft-failing.
detach_dependents() {
  (
    # Best-effort, in a subshell: the caller's errexit is untouched.
    set +eu
    ids="$(aws ec2 describe-instances --region "${REGION}" \
      --filters 'Name=tag:cdkd-integ,Values=rp-compensation' \
        'Name=instance-state-name,Values=pending,running,stopping,stopped' \
      --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)"
    for iid in ${ids}; do
      [ "${iid}" = "None" ] && continue
      aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" \
        --no-disable-api-stop >/dev/null 2>&1
    done
  )
  (
    # Best-effort, in a subshell: the caller's errexit is untouched.
    set +eu
    rows="$(aws pinpoint-sms-voice-v2 describe-configuration-sets --region "${REGION}" \
      --query "ConfigurationSets[?starts_with(ConfigurationSetName, 'cdkd-rp-comp-')].[ConfigurationSetName,ProtectConfigurationId]" \
      --output text 2>/dev/null)"
    printf '%s\n' "${rows}" | while read -r cs pid; do
      [ -z "${cs}" ] && continue
      if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
        aws pinpoint-sms-voice-v2 disassociate-protect-configuration --region "${REGION}" \
          --protect-configuration-id "${pid}" --configuration-set-name "${cs}" >/dev/null 2>&1
      fi
      if aws pinpoint-sms-voice-v2 delete-configuration-set --region "${REGION}" \
        --configuration-set-name "${cs}" >/dev/null 2>&1; then
        echo "    deleted configuration set ${cs}"
      else
        echo "    WARN: could not delete configuration set ${cs}; delete it by hand" >&2
      fi
    done
  )
}

# Delete every deny role any run of this fixture created, found by the LITERAL
# prefix. Idempotent and soft-failing.
delete_deny_roles() {
  (
    # Best-effort, in a subshell: the caller's errexit is untouched.
    set +eu
    roles="$(aws iam list-roles \
      --query "Roles[?starts_with(RoleName, 'cdkd-rp-comp-asg-deny-')].RoleName" --output text 2>/dev/null)"
    for r in ${roles}; do
      [ "${r}" = "None" ] && continue
      aws iam delete-role-policy --role-name "${r}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
      if aws iam delete-role --role-name "${r}" >/dev/null 2>&1; then
        echo "    deleted deny role ${r}"
      else
        echo "    WARN: could not delete role ${r}; delete it by hand" >&2
      fi
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  delete_deny_roles
  # Dependents FIRST: while attached they refuse the very deletes below.
  detach_dependents
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --remove-protection --yes >/dev/null 2>&1
  fi
  # Auto Scaling groups BEFORE instances: a live group replaces an instance
  # terminated under it. Literal tag discovery.
  ( set +eu
    names="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
      --filters 'Name=tag:cdkd-integ,Values=rp-compensation-asg' \
      --query 'AutoScalingGroups[].AutoScalingGroupName' --output text 2>/dev/null)"
    for g in ${names}; do
      [ "${g}" = "None" ] && continue
      aws autoscaling update-auto-scaling-group --region "${REGION}" --auto-scaling-group-name "${g}" \
        --deletion-protection none >/dev/null 2>&1
      gids="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
        --auto-scaling-group-names "${g}" --query 'AutoScalingGroups[0].Instances[].InstanceId' \
        --output text 2>/dev/null)"
      for iid in ${gids}; do
        [ "${iid}" = "None" ] && continue
        aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" \
          --no-disable-api-termination >/dev/null 2>&1
      done
      if aws autoscaling delete-auto-scaling-group --region "${REGION}" \
        --auto-scaling-group-name "${g}" --force-delete >/dev/null 2>&1; then
        echo "    deleting leftover Auto Scaling group ${g}"
      else
        echo "    WARN: could not delete leftover Auto Scaling group ${g}; delete it by hand" >&2
      fi
    done
  )
  # Instances: literal tag discovery (the group's instance carries its own value).
  ( set +eu
    ids="$(aws ec2 describe-instances --region "${REGION}" \
      --filters 'Name=tag:cdkd-integ,Values=rp-compensation,rp-compensation-asg' \
        'Name=instance-state-name,Values=pending,running,stopping,stopped' \
      --query 'Reservations[].Instances[].InstanceId' --output text 2>/dev/null)"
    for iid in ${ids}; do
      [ "${iid}" = "None" ] && continue
      # Both attributes are eventually consistent, so retry the terminate, and
      # report what actually happened.
      done_ok=""
      for _ in 1 2 3 4 5 6; do
        aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" \
          --no-disable-api-stop >/dev/null 2>&1
        aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" \
          --no-disable-api-termination >/dev/null 2>&1
        sleep 5
        if aws ec2 terminate-instances --region "${REGION}" --instance-ids "${iid}" >/dev/null 2>&1; then
          done_ok=1
          break
        fi
      done
      if [ -n "${done_ok}" ]; then
        echo "    terminated leftover instance ${iid}"
      else
        echo "    WARN: could not terminate leftover instance ${iid}; terminate it by hand" >&2
      fi
    done
  )
  # ProtectConfiguration: literal tag discovery.
  ( set +eu
    rows="$(aws pinpoint-sms-voice-v2 describe-protect-configurations --region "${REGION}" \
      --query 'ProtectConfigurations[].[ProtectConfigurationId,ProtectConfigurationArn]' --output text 2>/dev/null)"
    printf '%s\n' "${rows}" | while read -r pid parn; do
      [ -z "${pid}" ] && continue
      tagval="$(aws pinpoint-sms-voice-v2 list-tags-for-resource --resource-arn "${parn}" --region "${REGION}" \
        --query "Tags[?Key=='cdkd-integ'].Value | [0]" --output text 2>/dev/null)"
      [ "${tagval}" = "rp-compensation" ] || continue
      aws pinpoint-sms-voice-v2 update-protect-configuration --protect-configuration-id "${pid}" \
        --no-deletion-protection-enabled --region "${REGION}" >/dev/null 2>&1
      if aws pinpoint-sms-voice-v2 delete-protect-configuration --protect-configuration-id "${pid}" \
        --region "${REGION}" >/dev/null 2>&1; then
        echo "    deleted leftover ProtectConfiguration ${pid}"
      else
        echo "    WARN: could not delete leftover ProtectConfiguration ${pid}; delete it by hand" >&2
      fi
    done
  )
  # The launch template: the fixture's literal name.
  if aws ec2 delete-launch-template --region "${REGION}" --launch-template-name "${LT_NAME}" >/dev/null 2>&1; then
    echo "    deleted leftover launch template ${LT_NAME}"
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${DESTROY_LOG}" "${DESTROY_LOG}.poll-err" "${DESTROY_LOG}.id-err"
  set -eu
}

trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the (slow, retrying) cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

# --- Precondition: a default-VPC subnet in an AZ offering t3.nano ----------
AZS="$(aws ec2 describe-instance-type-offerings --region "${REGION}" --location-type availability-zone \
  --filters Name=instance-type,Values=t3.nano --query 'InstanceTypeOfferings[].Location' --output text)"
CDKD_INTEG_SUBNET_ID=""
for az in ${AZS}; do
  sid="$(aws ec2 describe-subnets --region "${REGION}" \
    --filters Name=default-for-az,Values=true "Name=availability-zone,Values=${az}" \
    --query 'Subnets[0].SubnetId' --output text)"
  if [ -n "${sid}" ] && [ "${sid}" != "None" ]; then
    CDKD_INTEG_SUBNET_ID="${sid}"
    break
  fi
done
if [ -z "${CDKD_INTEG_SUBNET_ID}" ]; then
  echo "FAIL: precondition — no default-VPC subnet in ${REGION} in an AZ offering t3.nano" >&2
  exit 1
fi
export CDKD_INTEG_SUBNET_ID
echo "==> Using default-VPC subnet ${CDKD_INTEG_SUBNET_ID}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

STATE_JSON=""
read_state() {
  STATE_JSON="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json)"
}
# Usage: state_field <LogicalId> <physicalId|provisionedBy>; absent prints ''.
state_field() {
  printf '%s' "${STATE_JSON}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).state.resources[process.argv[1]];process.stdout.write(r&&r[process.argv[2]]!=null?String(r[process.argv[2]]):"")})' "$1" "$2"
}
instance_state() {
  aws ec2 describe-instances --region "${REGION}" --instance-ids "$1" \
    --query 'Reservations[0].Instances[0].State.Name' --output text
}
# Usage: instance_attr <id> <disableApiTermination|disableApiStop>; prints True/False.
instance_attr() {
  local field
  case "$2" in
    disableApiTermination) field="DisableApiTermination" ;;
    disableApiStop) field="DisableApiStop" ;;
    *) echo "FAIL: instance_attr: unknown attribute $2" >&2; exit 1 ;;
  esac
  aws ec2 describe-instance-attribute --region "${REGION}" --instance-id "$1" \
    --attribute "$2" --query "${field}.Value" --output text
}
# Usage: wait_instance_attr <id> <attribute> <True|False>. The attribute reads
# are eventually consistent, so poll up to ~2 minutes.
wait_instance_attr() {
  local v=""
  for _ in $(seq 1 24); do
    # A failed read is polled through too, and reported if it is the last.
    v="$(instance_attr "$1" "$2" 2>&1)" || v="<read failed: ${v}>"
    [ "${v}" = "$3" ] && return 0
    sleep 5
  done
  echo "FAIL: $1 $2 still reads '${v}', not $3" >&2
  exit 1
}
pc_guard() {
  aws cloudcontrol get-resource --region "${REGION}" --type-name "${PC_TYPE}" --identifier "$1" \
    --query 'ResourceDescription.Properties' --output text \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s);process.stdout.write(String(p.DeletionProtectionEnabled))})'
}

# --- Phase 1: deploy, then attach the dependents ----------------------------
echo "==> Phase 1: deploy (every guard ON from creation)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

read_state
SDK_ID="$(state_field SdkInstance physicalId)"
CC_ID="$(state_field CcInstance physicalId)"
PC_ID="$(state_field ProtectConfig physicalId)"
ASG_NAME="$(state_field ProtectedAsg physicalId)"
if [ -z "${SDK_ID}" ] || [ -z "${CC_ID}" ] || [ -z "${PC_ID}" ] || [ -z "${ASG_NAME}" ]; then
  echo "FAIL: missing physicalId in state (sdk='${SDK_ID}' cc='${CC_ID}' pc='${PC_ID}' asg='${ASG_NAME}')" >&2
  exit 1
fi
echo "    sdkInstance=${SDK_ID} ccInstance=${CC_ID} protectConfig=${PC_ID} asg=${ASG_NAME}"

# Each arm covers its ROUTE only if the resource took it.
SDK_ROUTE="$(state_field SdkInstance provisionedBy)"
CC_ROUTE="$(state_field CcInstance provisionedBy)"
PC_ROUTE="$(state_field ProtectConfig provisionedBy)"
if [ "${SDK_ROUTE}" = "cc-api" ]; then
  echo "FAIL: SdkInstance was provisioned via Cloud Control; a silent-drop property crept in" >&2
  exit 1
fi
if [ "${CC_ROUTE}" != "cc-api" ] || [ "${PC_ROUTE}" != "cc-api" ]; then
  echo "FAIL: expected CcInstance and ProtectConfig provisionedBy=cc-api (got '${CC_ROUTE}' / '${PC_ROUTE}')" >&2
  exit 1
fi
echo "    routes: SdkInstance=sdk CcInstance=cc-api ProtectConfig=cc-api"

for iid in "${SDK_ID}" "${CC_ID}"; do
  g="$(instance_attr "${iid}" disableApiTermination)"
  if [ "${g}" != "True" ]; then
    echo "FAIL: precondition — ${iid} DisableApiTermination is '${g}', not True" >&2
    exit 1
  fi
done
g="$(pc_guard "${PC_ID}")"
if [ "${g}" != "true" ]; then
  echo "FAIL: precondition — ${PC_ID} DeletionProtectionEnabled is '${g}', not true" >&2
  exit 1
fi

# The group launches its instance asynchronously after the deploy.
# A failed describe (throttle, network) is polled through rather than ending
# the run under errexit, and reported if no instance ever shows up.
ASG_IID=""
asg_poll_err=""
for _ in $(seq 1 60); do
  if ASG_IID="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
    --auto-scaling-group-names "${ASG_NAME}" --query 'AutoScalingGroups[0].Instances[0].InstanceId' \
    --output text 2>"${DESTROY_LOG}.poll-err")"; then
    asg_poll_err=""
    if [ -n "${ASG_IID}" ] && [ "${ASG_IID}" != "None" ]; then
      break
    fi
  else
    asg_poll_err="$(cat "${DESTROY_LOG}.poll-err")"
  fi
  ASG_IID=""
  sleep 5
done
rm -f "${DESTROY_LOG}.poll-err"
if [ -z "${ASG_IID}" ]; then
  echo "FAIL: precondition — ${ASG_NAME} launched no instance within 5 minutes${asg_poll_err:+ (last describe failure: ${asg_poll_err})}" >&2
  exit 1
fi
wait_instance_attr "${ASG_IID}" disableApiTermination True
ASG_DP="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" --query 'AutoScalingGroups[0].DeletionProtection' --output text)"
if [ "${ASG_DP}" != "prevent-all-deletion" ]; then
  echo "FAIL: precondition — ${ASG_NAME} DeletionProtection is '${ASG_DP}', not prevent-all-deletion" >&2
  exit 1
fi
echo "    asgInstance=${ASG_IID}"
echo "    every guard is ON"

echo "==> Phase 1b: attach the out-of-band dependents"
for iid in "${SDK_ID}" "${CC_ID}"; do
  aws ec2 modify-instance-attribute --region "${REGION}" --instance-id "${iid}" --disable-api-stop
  wait_instance_attr "${iid}" disableApiStop True
done
echo "    stop protection ON for both instances"
aws pinpoint-sms-voice-v2 create-configuration-set --region "${REGION}" \
  --configuration-set-name "${CS_NAME}" --tags Key=cdkd-integ,Value=rp-compensation >/dev/null
aws pinpoint-sms-voice-v2 associate-protect-configuration --region "${REGION}" \
  --protect-configuration-id "${PC_ID}" --configuration-set-name "${CS_NAME}" >/dev/null
# Read the association back: without it the delete is not refused, and phase 2
# would fail as "the destroy succeeded" rather than naming this premise.
ASSOCIATED_PC="$(aws pinpoint-sms-voice-v2 describe-configuration-sets --region "${REGION}" \
  --configuration-set-names "${CS_NAME}" --query 'ConfigurationSets[0].ProtectConfigurationId' --output text)"
if [ "${ASSOCIATED_PC}" != "${PC_ID}" ]; then
  echo "FAIL: precondition — configuration set ${CS_NAME} reads protect configuration '${ASSOCIATED_PC}', not ${PC_ID}; the association that must refuse the delete is not in place" >&2
  exit 1
fi
echo "    configuration set ${CS_NAME} associated with ${PC_ID}"

echo "==> Phase 1c: a role that may not call UpdateAutoScalingGroup on ${ASG_NAME}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
ASG_ARN="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" --query 'AutoScalingGroups[0].AutoScalingGroupARN' --output text)"
if [ -z "${ACCOUNT_ID}" ] || [ -z "${CALLER_USERID}" ] || [ -z "${ASG_ARN}" ] || [ "${ASG_ARN}" = "None" ]; then
  echo "FAIL: precondition — account '${ACCOUNT_ID}', caller '${CALLER_USERID}' or group ARN '${ASG_ARN}' is empty" >&2
  exit 1
fi
# Assumable by THIS caller identity only, not by the whole account.
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this stack's destroy calls, never `*`: the role is assumable
# by the caller for minutes, and an inline `Allow *` would hand it more than
# the caller may have (IAM included).
DENY_POLICY="$(node -e 'const [arn,bucket]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:"s3:*",Resource:[`arn:aws:s3:::${bucket}`,`arn:aws:s3:::${bucket}/*`]},{Effect:"Allow",Action:["ec2:*","autoscaling:*","cloudformation:*","sms-voice:*","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:"autoscaling:UpdateAutoScalingGroup",Resource:arn}]}))' "${ASG_ARN}" "${STATE_BUCKET}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=rp-compensation-asg >/dev/null
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-rp-comp-asg \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "FAIL: precondition — could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the deny role. A profile in the environment would win over
# the key variables in the SDK's credential chain, so it is dropped.
as_deny_role() {
  env -u AWS_PROFILE -u AWS_DEFAULT_PROFILE \
    AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}" "$@"
}
# Credentials from assuming a role created seconds ago can be refused for a
# while (measured: `InvalidClientTokenId` on the first call), so poll until STS
# accepts them; the last refusal is named if it never does.
DENY_ARN=""
deny_id_err=""
for _ in $(seq 1 24); do
  if DENY_ARN="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${DESTROY_LOG}.id-err")"; then
    break
  fi
  DENY_ARN=""
  deny_id_err="$(cat "${DESTROY_LOG}.id-err" 2>/dev/null || true)"
  sleep 5
done
rm -f "${DESTROY_LOG}.id-err"
if [ -z "${DENY_ARN}" ]; then
  echo "FAIL: precondition — STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${deny_id_err})" >&2
  exit 1
fi
case "${DENY_ARN}" in
  *":assumed-role/${DENY_ROLE}/"*) ;;
  *)
    echo "FAIL: precondition — the deny-role commands run as '${DENY_ARN}', not ${DENY_ROLE}" >&2
    exit 1
    ;;
esac
# The deny must be IN FORCE before the destroy, or cdkd's group flip lands and
# the group is deleted. The probe writes the value the group already has, so
# while the deny is not yet in force it changes nothing. Two EXPLICIT denials
# in a row, since IAM propagation is eventually consistent: a role whose allow
# has not propagated yet is denied implicitly, which must not count. The ALLOW
# must be in force too (the state read is the destroy's first call), so the
# loop is done only when both hold.
denied=0
ready=0
probe_out=""
for _ in $(seq 1 36); do
  if probe_out="$(as_deny_role aws autoscaling update-auto-scaling-group --region "${REGION}" \
    --auto-scaling-group-name "${ASG_NAME}" --deletion-protection prevent-all-deletion 2>&1)"; then
    denied=0
  elif grep -qi 'explicit deny' <<<"${probe_out}"; then
    denied=$((denied + 1))
    if [ "${denied}" -ge 2 ] && as_deny_role aws s3api head-object --bucket "${STATE_BUCKET}" \
      --key "${STATE_KEY}" >/dev/null 2>&1; then
      ready=1
      break
    fi
  else
    denied=0
  fi
  sleep 5
done
if [ "${ready}" -ne 1 ]; then
  echo "FAIL: precondition — after 3 minutes ${DENY_ROLE} is not both explicitly denied UpdateAutoScalingGroup (${denied} consecutive) and able to read the state file (last update answer: ${probe_out})" >&2
  exit 1
fi
echo "    ${DENY_ROLE} is denied UpdateAutoScalingGroup on ${ASG_NAME}"

# --- Phase 2: the compensation arm (issue #2204) -----------------------------
echo "==> Phase 2: destroy --remove-protection as ${DENY_ROLE}, against out-of-band dependents (expect non-zero)"
set +e
as_deny_role node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection > "${DESTROY_LOG}" 2>&1
rc=$?
set -e
# ConsoleLogger colours regardless of TTY; every grep below reads plain text.
LOG="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DESTROY_LOG}")"

if [ "${rc}" -eq 0 ]; then
  echo "FAIL: the compensation destroy succeeded; an out-of-band dependent did not hold a delete back" >&2
  tail -40 "${DESTROY_LOG}" >&2
  exit 1
fi
echo "    destroy exited ${rc} as expected"

for iid in "${SDK_ID}" "${CC_ID}" "${ASG_IID}"; do
  st="$(instance_state "${iid}")"
  case "${st}" in
    pending|running|stopping|stopped) ;;
    *)
      echo "FAIL: ${iid} is '${st}': the terminate went through despite stop protection / the group's deletion protection" >&2
      exit 1
      ;;
  esac
done
ASG_LEFT="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" --query 'length(AutoScalingGroups)' --output text)"
if [ "${ASG_LEFT}" != "1" ]; then
  echo "FAIL: Auto Scaling group ${ASG_NAME} was deleted despite its deletion protection (the deny on its flip did not hold)" >&2
  exit 1
fi
if gone_probe aws cloudcontrol get-resource --region "${REGION}" --type-name "${PC_TYPE}" --identifier "${PC_ID}"; then
  echo "FAIL: ProtectConfiguration ${PC_ID} was deleted despite its associated configuration set" >&2
  exit 1
fi
echo "    all four resources are still live"

# cdkd's compensation line per resource. The SENTINEL is a second marker on
# the same line (the line's lead): present without the full needle means the
# wording drifted, which must not read as "the compensation did not run".
assert_compensated() { # usage: assert_compensated <lead> <full needle> <failure marker>
  local lead="$1" needle="$2" failure="$3"
  if ! grep -qF -- "${failure}" <<<"${LOG}"; then
    echo "FAIL: the destroy output lacks '${failure}' -- the delete did not fail the way this arm needs" >&2
    tail -40 <<<"${LOG}" >&2
    exit 1
  fi
  if grep -qF -- "${needle}" <<<"${LOG}"; then
    return 0
  fi
  # The stand-down line shares the lead: cdkd judged the delete may already
  # have been running (an abandoned wait, an ambiguous handler code, or a
  # conflict after one) and left the guard off on purpose. Name that, rather
  # than calling it wording drift.
  # No `-q` on the second grep: an early exit could SIGPIPE the first, which
  # `pipefail` would turn into a false "no".
  if grep -F -- "${lead}" <<<"${LOG}" | grep -F -- "cannot tell whether AWS had started deleting" >/dev/null; then
    echo "FAIL: cdkd STOOD DOWN for '${lead}' (it judged the delete may already be running), so this run never reached a plain refusal:" >&2
    grep -F -- "${lead}" <<<"${LOG}" >&2
    exit 1
  fi
  if grep -qF -- "${lead}" <<<"${LOG}"; then
    echo "FAIL: a compensation line for '${lead}' is present but does not read '${needle}' -- wording drift or a failed re-enable:" >&2
    grep -F -- "${lead}" <<<"${LOG}" >&2
    exit 1
  fi
  echo "FAIL: no compensation line for '${lead}': the guard cdkd turned off was not put back (issue #2204)" >&2
  grep -iE 'protection|refus|fail' <<<"${LOG}" | tail -20 >&2
  exit 1
}
assert_compensated \
  "EC2 Instance SdkInstance: " \
  "EC2 Instance SdkInstance: the delete failed after --remove-protection had turned DisableApiTermination off, so it was re-enabled on ${SDK_ID}." \
  "Failed to terminate EC2 Instance SdkInstance"
assert_compensated \
  "EC2 Instance CcInstance: " \
  "EC2 Instance CcInstance: the delete failed after --remove-protection had turned DisableApiTermination off, so it was re-enabled on ${CC_ID}." \
  "DELETE failed for CcInstance"
assert_compensated \
  "${PC_TYPE} ProtectConfig: " \
  "${PC_TYPE} ProtectConfig: the delete failed after --remove-protection had turned DeletionProtectionEnabled off, so it was re-enabled on ${PC_ID}." \
  "DELETE failed for ProtectConfig"
assert_compensated \
  "EC2 Instance launched by AutoScalingGroup ProtectedAsg: " \
  "EC2 Instance launched by AutoScalingGroup ProtectedAsg: the delete failed after --remove-protection had turned DisableApiTermination off, so it was re-enabled on ${ASG_IID}." \
  "Failed to delete AutoScalingGroup ProtectedAsg"
echo "    cdkd re-enabled every guard it had turned off"

# A real discriminator: after cdkd's flip, only its compensation writes the
# guard back ON.
# Polled: the attribute read is eventually consistent. Without the
# compensation it never turns True, so the poll times out and FAILs.
for iid in "${SDK_ID}" "${CC_ID}" "${ASG_IID}"; do
  wait_instance_attr "${iid}" disableApiTermination True
done
g="$(pc_guard "${PC_ID}")"
if [ "${g}" != "true" ]; then
  echo "FAIL: ${PC_ID} DeletionProtectionEnabled is '${g}' after the failed destroy, not true" >&2
  exit 1
fi
echo "    every guard reads ON"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    cdkd state retained after the failed destroy"

# --- Phase 3: detach, then destroy --remove-protection cleanly --------------
echo "==> Phase 3: delete the deny role, detach the dependents, then destroy --remove-protection (expect exit 0)"
delete_deny_roles
detach_dependents
for iid in "${SDK_ID}" "${CC_ID}"; do
  wait_instance_attr "${iid}" disableApiStop False
done
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

for iid in "${SDK_ID}" "${CC_ID}" "${ASG_IID}"; do
  # A terminated instance stays describable for a while, and AWS later sweeps
  # it (InvalidInstanceID.NotFound): both mean gone.
  if gone_probe aws ec2 describe-instances --region "${REGION}" --instance-ids "${iid}"; then
    st="terminated"
  else
    st="$(instance_state "${iid}")"
  fi
  case "${st}" in
    shutting-down|terminated) echo "    ${iid}: ${st}" ;;
    *)
      echo "FAIL: ${iid} is '${st}' after the destroy, not terminating" >&2
      exit 1
      ;;
  esac
done
ASG_LEFT="$(aws autoscaling describe-auto-scaling-groups --region "${REGION}" \
  --auto-scaling-group-names "${ASG_NAME}" --query 'length(AutoScalingGroups)' --output text)"
if [ "${ASG_LEFT}" != "0" ]; then
  echo "FAIL: Auto Scaling group ${ASG_NAME} still exists after destroy" >&2
  exit 1
fi
assert_gone "deny role ${DENY_ROLE} still exists after phase 3's delete" \
  aws iam get-role --role-name "${DENY_ROLE}"
assert_gone "launch template ${LT_NAME} still exists after destroy" \
  aws ec2 describe-launch-templates --region "${REGION}" --launch-template-names "${LT_NAME}"
assert_gone "ProtectConfiguration ${PC_ID} still exists after destroy" \
  aws cloudcontrol get-resource --region "${REGION}" --type-name "${PC_TYPE}" --identifier "${PC_ID}"
assert_gone "configuration set ${CS_NAME} still exists after detach" \
  aws pinpoint-sms-voice-v2 describe-configuration-sets --region "${REGION}" --configuration-set-names "${CS_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    every resource, the configuration set, the deny role and the state file are gone"

trap - EXIT INT TERM
rm -f "${DESTROY_LOG}"
echo "[verify] PASS — --remove-protection compensation (EC2 SDK route, EC2 Cloud Control route, Cloud Control registry type, Auto Scaling group instance), all 3 phases passed"
