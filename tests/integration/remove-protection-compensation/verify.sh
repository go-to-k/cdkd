#!/usr/bin/env bash
# verify.sh — cdkd `--remove-protection` compensation integ (issue #2204).
#
# `cdkd destroy --remove-protection` turns a resource's guard off, then
# deletes it. When the delete fails TERMINALLY, cdkd must turn the guard back
# on before reporting the failure. This fixture covers the three routes that
# compensation was added to in one stack:
#   - SdkInstance    AWS::EC2::Instance, SDK route (DisableApiTermination)
#   - CcInstance     AWS::EC2::Instance, Cloud Control route (DisableApiTermination)
#   - ProtectConfig  AWS::SMSVOICE::ProtectConfiguration, the Cloud Control
#                    protection registry (DeletionProtectionEnabled)
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
# Not covered live here: the VerifiedPermissions PolicyStore's OBJECT-valued
# guard (`{"Mode":"ENABLED"}`). Its compensation is unit-tested, and its flip
# is exercised live by tests/integration/cc-protection-flip.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1. Needs a default VPC offering t3.nano.

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

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Dependents FIRST: while attached they refuse the very deletes below.
  detach_dependents
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --remove-protection --yes >/dev/null 2>&1
  fi
  # Instances: literal tag discovery.
  ( set +eu
    ids="$(aws ec2 describe-instances --region "${REGION}" \
      --filters 'Name=tag:cdkd-integ,Values=rp-compensation' \
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
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${DESTROY_LOG}"
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
if [ -z "${SDK_ID}" ] || [ -z "${CC_ID}" ] || [ -z "${PC_ID}" ]; then
  echo "FAIL: missing physicalId in state (sdk='${SDK_ID}' cc='${CC_ID}' pc='${PC_ID}')" >&2
  exit 1
fi
echo "    sdkInstance=${SDK_ID} ccInstance=${CC_ID} protectConfig=${PC_ID}"

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

# --- Phase 2: the compensation arm (issue #2204) -----------------------------
echo "==> Phase 2: destroy --remove-protection against out-of-band dependents (expect non-zero)"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
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

for iid in "${SDK_ID}" "${CC_ID}"; do
  st="$(instance_state "${iid}")"
  case "${st}" in
    pending|running|stopping|stopped) ;;
    *)
      echo "FAIL: ${iid} is '${st}': the terminate went through despite stop protection" >&2
      exit 1
      ;;
  esac
done
if gone_probe aws cloudcontrol get-resource --region "${REGION}" --type-name "${PC_TYPE}" --identifier "${PC_ID}"; then
  echo "FAIL: ProtectConfiguration ${PC_ID} was deleted despite its associated configuration set" >&2
  exit 1
fi
echo "    all three resources are still live"

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
echo "    cdkd re-enabled every guard it had turned off"

# A real discriminator: after cdkd's flip, only its compensation writes the
# guard back ON.
# Polled: the attribute read is eventually consistent. Without the
# compensation it never turns True, so the poll times out and FAILs.
for iid in "${SDK_ID}" "${CC_ID}"; do
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
echo "==> Phase 3: detach the dependents, then destroy --remove-protection (expect exit 0)"
detach_dependents
for iid in "${SDK_ID}" "${CC_ID}"; do
  wait_instance_attr "${iid}" disableApiStop False
done
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --force --remove-protection

for iid in "${SDK_ID}" "${CC_ID}"; do
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
assert_gone "ProtectConfiguration ${PC_ID} still exists after destroy" \
  aws cloudcontrol get-resource --region "${REGION}" --type-name "${PC_TYPE}" --identifier "${PC_ID}"
assert_gone "configuration set ${CS_NAME} still exists after detach" \
  aws pinpoint-sms-voice-v2 describe-configuration-sets --region "${REGION}" --configuration-set-names "${CS_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    every resource, the configuration set and the state file are gone"

trap - EXIT INT TERM
rm -f "${DESTROY_LOG}"
echo "[verify] PASS — --remove-protection compensation (EC2 SDK route, EC2 Cloud Control route, Cloud Control registry type), all 3 phases passed"
