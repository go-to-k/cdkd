#!/usr/bin/env bash
# verify.sh — cdkd EC2::Instance security-focused property backfill integ
# test (issue #609).
#
# Asserts that an EC2 Instance whose template sets the five security-focused
# silent-drop properties has each one reach AWS after `cdkd deploy` — each was
# a silent-drop before #609:
#   - DisableApiTermination  (DescribeInstanceAttribute)
#   - MetadataOptions        (DescribeInstances .MetadataOptions; IMDSv2)
#   - Monitoring             (DescribeInstances .Monitoring.State)
#   - EbsOptimized           (DescribeInstances .EbsOptimized)
#   - CreditSpecification    (DescribeInstanceCreditSpecifications)
#
# Also exercises the destroy path: the instance is created with
# DisableApiTermination=true, so destroy MUST pass --remove-protection (the
# SDK delete path flips the attribute off before TerminateInstances).
#
# Also asserts the issue #1276 AvailabilityZone -> RunInstances
# `Placement.AvailabilityZone` mapping: the template emits AvailabilityZone (as
# CDK's L2 `ec2.Instance` always does), the instance must STILL take the SDK
# provider path (before #1276 that property was a silent-drop and the #614 rule
# flipped the whole resource onto Cloud Control), and the AZ must reach AWS.
#
# Authored against a RAW L1 `ec2.CfnInstance` because the L2 construct does not
# expose the five #609 security-backfill props this fixture verifies -- see the
# fixture stack doc.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe (macOS): no `grep -P`, no `date -d`; boolean asserts use the
# `if has("X") then .X|tostring else "null" end` jq idiom (jq's `//` treats an
# explicit `false` as missing).

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

STACK="Ec2InstanceStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

INSTANCE_ID=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS instance"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # state destroy with --remove-protection so a leftover protected instance
    # is still terminated. Do NOT silence stderr — a partial failure must be
    # visible so we never leak a billing instance.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --remove-protection \
      --yes
  fi
  if [ -n "${INSTANCE_ID}" ]; then
    # Belt-and-suspenders: flip protection off then terminate directly in
    # case state destroy could not (e.g. state already gone).
    aws ec2 modify-instance-attribute \
      --instance-id "${INSTANCE_ID}" \
      --no-disable-api-termination \
      --region "${REGION}" >/dev/null 2>&1 || true
    aws ec2 terminate-instances \
      --instance-ids "${INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${PUBLIC_INSTANCE_ID:-}" ]; then
    aws ec2 terminate-instances \
      --instance-ids "${PUBLIC_INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Confirm the instance took the SDK provider path (NOT Cloud Control). If a
# silent-drop prop ever sneaks into the template, provisionedBy flips to
# 'cc-api' and this fixture would no longer verify the SDK backfill.
# Both instances (the #609 backfill one AND the #1281 NetworkInterfaces one)
# must be on the SDK path; a cc-api entry means a silent-drop prop crept in.
CC_API_COUNT=$(echo "${STATE}" | jq '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::Instance") | select((.value.provisionedBy // "sdk") == "cc-api")] | length')
if [ "${CC_API_COUNT}" != "0" ]; then
  echo "FAIL: ${CC_API_COUNT} instance(s) provisioned via Cloud Control (cc-api), not the SDK provider — a silent-drop prop must have crept into the template (#609 / #1281)" >&2
  exit 1
fi
echo "    OK: all instances provisioned via the SDK provider path"

INSTANCE_ID=$(echo "${STATE}" | jq -r '.outputs.InstanceId // ""')
if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve EC2 Instance id from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved instance id: ${INSTANCE_ID}"

# --- Assertions: the #1281 NetworkInterfaces-shaped instance ----------------
PUBLIC_INSTANCE_ID=$(echo "${STATE}" | jq -r '.outputs.PublicInstanceId // ""')
if [ -z "${PUBLIC_INSTANCE_ID}" ] || [ "${PUBLIC_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve the NetworkInterfaces-shaped instance id from state outputs" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
PUBLIC_INSTANCE=$(aws ec2 describe-instances \
  --instance-ids "${PUBLIC_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'Reservations[0].Instances[0]' --output json)
# The whole point of associatePublicIpAddress: the launched ENI must carry a
# public IP association. A NetworkInterfaces mapping that silently dropped the
# flag would still launch a working instance -- without the address.
PUBLIC_IP=$(echo "${PUBLIC_INSTANCE}" | jq -r '.NetworkInterfaces[0].Association.PublicIp // ""')
if [ -z "${PUBLIC_IP}" ]; then
  echo "FAIL: NetworkInterfaces-shaped instance ${PUBLIC_INSTANCE_ID} has no public IP association — AssociatePublicIpAddress did not reach RunInstances (#1281)" >&2
  echo "${PUBLIC_INSTANCE}" | jq '{NetworkInterfaces}'
  exit 1
fi
NI_GROUP=$(echo "${PUBLIC_INSTANCE}" | jq -r '.NetworkInterfaces[0].Groups[0].GroupId // ""')
if [ -z "${NI_GROUP}" ]; then
  echo "FAIL: NetworkInterfaces-shaped instance has no security group on its ENI — GroupSet did not reach RunInstances (#1281)" >&2
  exit 1
fi
echo "    OK: #1281 instance ${PUBLIC_INSTANCE_ID} has public IP ${PUBLIC_IP} and ENI group ${NI_GROUP}"

# --- Assertions: each backfilled prop reached AWS ---------------------
INSTANCE=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'Reservations[0].Instances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeInstances returned empty for ${INSTANCE_ID}" >&2
  exit 1
fi

# Monitoring: detailed monitoring -> .Monitoring.State == 'enabled'
# (or 'pending' right after launch). A silent-drop leaves it 'disabled'.
ACTUAL_MONITORING=$(echo "${INSTANCE}" | jq -r '.Monitoring.State // "null"')
if [ "${ACTUAL_MONITORING}" != "enabled" ] && [ "${ACTUAL_MONITORING}" != "pending" ]; then
  echo "FAIL: Monitoring.State is '${ACTUAL_MONITORING}', expected enabled/pending (Monitoring silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: Monitoring.State == ${ACTUAL_MONITORING} on AWS (Monitoring silent-drop CLOSED by #609)"

# EbsOptimized: explicit true from the template. A silent-drop leaves false.
ACTUAL_EBS_OPTIMIZED=$(echo "${INSTANCE}" | jq -r 'if has("EbsOptimized") then .EbsOptimized | tostring else "null" end')
if [ "${ACTUAL_EBS_OPTIMIZED}" != "true" ]; then
  echo "FAIL: EbsOptimized is '${ACTUAL_EBS_OPTIMIZED}', expected true (EbsOptimized silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: EbsOptimized == true on AWS (EbsOptimized silent-drop CLOSED by #609)"

# MetadataOptions: IMDSv2 enforcement (HttpTokens == 'required'). A
# silent-drop leaves AWS at the account default (commonly 'optional').
ACTUAL_HTTP_TOKENS=$(echo "${INSTANCE}" | jq -r '.MetadataOptions.HttpTokens // "null"')
if [ "${ACTUAL_HTTP_TOKENS}" != "required" ]; then
  echo "FAIL: MetadataOptions.HttpTokens is '${ACTUAL_HTTP_TOKENS}', expected required (MetadataOptions silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.MetadataOptions'
  exit 1
fi
echo "    OK: MetadataOptions.HttpTokens == required on AWS (IMDSv2 enforced; MetadataOptions silent-drop CLOSED by #609)"

# DisableApiTermination: not on DescribeInstances — needs the dedicated
# DescribeInstanceAttribute call. A silent-drop leaves it false.
ACTUAL_DISABLE_TERM=$(aws ec2 describe-instance-attribute \
  --instance-id "${INSTANCE_ID}" \
  --attribute disableApiTermination \
  --region "${REGION}" \
  --query 'DisableApiTermination.Value' --output text)
if [ "${ACTUAL_DISABLE_TERM}" != "True" ] && [ "${ACTUAL_DISABLE_TERM}" != "true" ]; then
  echo "FAIL: DisableApiTermination is '${ACTUAL_DISABLE_TERM}', expected True (DisableApiTermination silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: DisableApiTermination == ${ACTUAL_DISABLE_TERM} on AWS (DisableApiTermination silent-drop CLOSED by #609)"

# CreditSpecification: T-family burstable mode. The fixture sets
# 'unlimited'; the t3 default is 'unlimited' too in many accounts, so this
# is a weaker signal than the others, but a hard silent-drop (the create
# payload omitting CreditSpecification entirely) is still caught by the
# value reaching AWS via the dedicated API.
ACTUAL_CPU_CREDITS=$(aws ec2 describe-instance-credit-specifications \
  --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'InstanceCreditSpecifications[0].CpuCredits' --output text)
if [ "${ACTUAL_CPU_CREDITS}" != "unlimited" ]; then
  echo "FAIL: CreditSpecification.CpuCredits is '${ACTUAL_CPU_CREDITS}', expected unlimited (CreditSpecification silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: CreditSpecification.CpuCredits == unlimited on AWS (CreditSpecification silent-drop CLOSED by #609)"

# AvailabilityZone (#1276): the CFn property maps to RunInstances'
# `Placement.AvailabilityZone`. Compare AWS against the value cdkd recorded in
# state for THIS instance (the resolved template value) rather than a hardcoded
# AZ, which would break the moment the fixture's VPC lands elsewhere.
EXPECTED_AZ=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::Instance") | .value.properties.AvailabilityZone] | first // ""')
if [ -z "${EXPECTED_AZ}" ] || [ "${EXPECTED_AZ}" = "null" ]; then
  echo "FAIL: state records no AvailabilityZone for the instance — the template must emit it (issue #1276)" >&2
  echo "${STATE}" | jq '.resources'
  exit 1
fi
ACTUAL_AZ=$(echo "${INSTANCE}" | jq -r '.Placement.AvailabilityZone // "null"')
if [ "${ACTUAL_AZ}" != "${EXPECTED_AZ}" ]; then
  echo "FAIL: Placement.AvailabilityZone is '${ACTUAL_AZ}', expected '${EXPECTED_AZ}' (AvailabilityZone silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: Placement.AvailabilityZone == ${ACTUAL_AZ} on AWS (AvailabilityZone silent-drop CLOSED by #1276, instance stayed on the SDK path)"

# --- Phase 2: destroy (--remove-protection required) ------------------
echo "==> Phase 2: destroy with --remove-protection (instance is termination-protected)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --remove-protection \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Instance should be terminated (or shutting-down right after the call).
if gone_probe aws ec2 describe-instances --instance-ids "${INSTANCE_ID}" --region "${REGION}"; then
  INSTANCE_STATE="gone"
elif ! INSTANCE_STATE=$(aws ec2 describe-instances \
    --instance-ids "${INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1); then
  # TOCTOU: the record can be swept between gone_probe and this requery.
  printf '%s' "${INSTANCE_STATE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && INSTANCE_STATE="gone" \
    || { echo "FAIL: describe-instances requery undetermined: ${INSTANCE_STATE}" >&2; exit 1; }
fi
if [ "${INSTANCE_STATE}" = "terminated" ] || [ "${INSTANCE_STATE}" = "shutting-down" ] || [ "${INSTANCE_STATE}" = "gone" ]; then
  echo "    OK: instance is terminated/shutting-down/gone (state: ${INSTANCE_STATE})"
  # State is already gone, so the cleanup trap need not re-terminate.
  INSTANCE_ID=""
else
  echo "FAIL: instance still in unexpected state after destroy: ${INSTANCE_STATE}" >&2
  exit 1
fi

# The #1281 NetworkInterfaces-shaped instance must be gone too.
if gone_probe aws ec2 describe-instances --instance-ids "${PUBLIC_INSTANCE_ID}" --region "${REGION}"; then
  PUB_STATE="gone"
elif ! PUB_STATE=$(aws ec2 describe-instances \
    --instance-ids "${PUBLIC_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text 2>&1); then
  printf '%s' "${PUB_STATE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && PUB_STATE="gone" \
    || { echo "FAIL: describe-instances requery undetermined: ${PUB_STATE}" >&2; exit 1; }
fi
if [ "${PUB_STATE}" = "terminated" ] || [ "${PUB_STATE}" = "shutting-down" ] || [ "${PUB_STATE}" = "gone" ]; then
  echo "    OK: #1281 instance is terminated/shutting-down/gone (state: ${PUB_STATE})"
  PUBLIC_INSTANCE_ID=""
else
  echo "FAIL: #1281 instance still in unexpected state after destroy: ${PUB_STATE}" >&2
  exit 1
fi

echo ""
echo "=== PASS: EC2::Instance integ (#609 security backfill + #1276 AvailabilityZone + #1281 NetworkInterfaces) ==="
