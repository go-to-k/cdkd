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
# Authored against a RAW L1 `ec2.CfnInstance` so the resource stays on the SDK
# provider path (an L2 `ec2.Instance` emits AvailabilityZone, a silent-drop
# that flips the resource onto the Cloud Control path and bypasses the SDK
# backfill — see the fixture stack doc).
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
      --state-bucket "${STATE_BUCKET}" \
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
PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::Instance") | .value.provisionedBy] | first // "sdk"')
if [ "${PROVISIONED_BY}" = "cc-api" ]; then
  echo "FAIL: instance was provisioned via Cloud Control (cc-api), not the SDK provider — a silent-drop prop must have crept into the template, bypassing the #609 SDK backfill" >&2
  exit 1
fi
echo "    OK: instance provisioned via the SDK provider path (provisionedBy=${PROVISIONED_BY})"

INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::Instance") | .value.physicalId] | first // ""')
if [ -z "${INSTANCE_ID}" ] || [ "${INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve EC2 Instance id from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved instance id: ${INSTANCE_ID}"

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
else
  INSTANCE_STATE=$(aws ec2 describe-instances \
    --instance-ids "${INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'Reservations[0].Instances[0].State.Name' --output text)
fi
if [ "${INSTANCE_STATE}" = "terminated" ] || [ "${INSTANCE_STATE}" = "shutting-down" ] || [ "${INSTANCE_STATE}" = "gone" ]; then
  echo "    OK: instance is terminated/shutting-down/gone (state: ${INSTANCE_STATE})"
  # State is already gone, so the cleanup trap need not re-terminate.
  INSTANCE_ID=""
else
  echo "FAIL: instance still in unexpected state after destroy: ${INSTANCE_STATE}" >&2
  exit 1
fi

echo ""
echo "=== PASS: EC2::Instance #609 security-prop backfill integ ==="
