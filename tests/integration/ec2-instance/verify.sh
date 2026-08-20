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
# Issue #2039: read off the live instance after deploy; `cleanup` sweeps every
# instance carrying it, so a replay leak is reachable without a captured id.
CLIENT_TOKEN=""

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
  if [ -n "${CLIENT_TOKEN:-}" ]; then
    # Sweep every instance carrying the #2039 client token, rather than an id
    # captured into a variable: a kill between `run-instances` returning and the
    # assignment would leak a billable instance nothing else in this teardown
    # names, and more than one extra would overwrite a single variable. cdkd
    # mixes a per-process nonce into the token, so this filter cannot match an
    # instance from any other run.
    LEAKED=$(aws ec2 describe-instances \
      --filters "Name=client-token,Values=${CLIENT_TOKEN}" \
      --region "${REGION}" \
      --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId[]' \
      --output text 2>/dev/null)
    for leaked in ${LEAKED}; do
      if [ "${leaked}" != "${INSTANCE_ID}" ]; then
        aws ec2 terminate-instances \
          --instance-ids "${leaked}" \
          --region "${REGION}" >/dev/null 2>&1 || true
      fi
    done
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

# --- Assertions: issue #2039 RunInstances idempotency token -----------------
# cdkd retries a transient HTTP 500 across a multi-second schedule, so a 500
# whose RunInstances actually SUCCEEDED server-side re-invokes create(). Without
# a ClientToken that replay launches a SECOND instance which no state record
# names -- invisible to `cdkd destroy`, billing forever.
#
# The property cannot be provoked from outside (AWS does not 500 on demand), so
# it is verified in its two halves, both against real AWS:
#   (a) cdkd SENT a cdkd-derived token -- read back off the live instance;
#   (b) that token is REGISTERED with EC2 as an idempotency key -- replaying
#       RunInstances with it must NOT produce a new instance.
# Half (b) is the one that matters: a token EC2 does not recognise would let the
# replay through, which is precisely the pre-fix behaviour.
CLIENT_TOKEN=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'Reservations[0].Instances[0].ClientToken' \
  --output text)
case "${CLIENT_TOKEN}" in
  cdkd-*)
    echo "    OK: RunInstances carried a cdkd-derived ClientToken (${CLIENT_TOKEN})"
    ;;
  *)
    echo "FAIL: issue #2039 -- the instance carries no cdkd ClientToken (got: '${CLIENT_TOKEN}'); a retried 500 would launch a duplicate, untracked instance" >&2
    exit 1
    ;;
esac

# Replay the launch with the SAME token. Two independent checks follow, because
# each one alone has a hole:
#   - the BRANCH on the replay's exit code proves the replay actually reached
#     EC2's idempotency machinery (without it, a replay refused for an unrelated
#     reason -- no permission, no capacity -- would leave the count check below
#     passing vacuously);
#   - the COUNT of instances carrying this client token is the real verdict, and
#     it depends on no error-code spelling at all. `client-token` is a documented
#     describe-instances filter ("The idempotency token you provided when you
#     launched the instance"), and cdkd mixes a per-process nonce into the token,
#     so no earlier run of this fixture can contribute to the count.
# Read the launch parameters off the live instance so the replay is a
# WELL-FORMED request. Omitting the subnet makes EC2 fall back to the default
# VPC, and an account without one answers `VPCIdNotSpecified` -- which would red
# a CORRECT implementation, since the request never reaches the idempotency
# check at all. The subnet also pins the security groups' VPC.
REPLAY_PARAMS=$(aws ec2 describe-instances \
  --instance-ids "${INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'Reservations[0].Instances[0].[ImageId,InstanceType,SubnetId]' \
  --output text)
REPLAY_IMAGE_ID=$(printf '%s' "${REPLAY_PARAMS}" | awk '{print $1}')
REPLAY_INSTANCE_TYPE=$(printf '%s' "${REPLAY_PARAMS}" | awk '{print $2}')
REPLAY_SUBNET_ID=$(printf '%s' "${REPLAY_PARAMS}" | awk '{print $3}')
# `--output text` renders a JMESPath null as the literal string None, so an
# instance with no SubnetId would otherwise be replayed as `--subnet-id None`.
if [ "${REPLAY_SUBNET_ID}" = "None" ]; then
  REPLAY_SUBNET_ID=""
fi
if [ -z "${REPLAY_IMAGE_ID}" ] || [ "${REPLAY_IMAGE_ID}" = "None" ]; then
  echo "FAIL: could not read the launch parameters back off instance ${INSTANCE_ID} for the #2039 replay" >&2
  exit 1
fi

set +e
REPLAY_OUT=$(aws ec2 run-instances \
  --client-token "${CLIENT_TOKEN}" \
  --image-id "${REPLAY_IMAGE_ID}" \
  --instance-type "${REPLAY_INSTANCE_TYPE}" \
  ${REPLAY_SUBNET_ID:+--subnet-id "${REPLAY_SUBNET_ID}"} \
  --min-count 1 --max-count 1 \
  --region "${REGION}" \
  --query 'Instances[0].InstanceId' \
  --output text 2>&1)
REPLAY_RC=$?
set -e

# The EXIT CODE decides which branch applies -- greping the output alone would
# read a new instance id and an error string the same way.
if [ "${REPLAY_RC}" -eq 0 ]; then
  if [ "${REPLAY_OUT}" = "${INSTANCE_ID}" ]; then
    echo "    OK: replaying RunInstances with the same ClientToken returned the ORIGINAL instance"
  else
    # The replay launched a real instance. Record it so cleanup terminates it,
    # then fail -- this is exactly the orphan issue #2039 is about.
    aws ec2 terminate-instances \
      --instance-ids "${REPLAY_OUT}" \
      --region "${REGION}" >/dev/null 2>&1 || true
    echo "FAIL: issue #2039 -- replaying RunInstances with the cdkd ClientToken launched a SECOND instance (${REPLAY_OUT}); the token is not registered with EC2. Terminate requested; verify with: aws ec2 describe-instances --instance-ids ${REPLAY_OUT}" >&2
    exit 1
  fi
# Matched case-INSENSITIVELY on the substring rather than on one exact code:
# EC2 answers a known token with IdempotentParameterMismatch (this replay sends
# a deliberately minimal request) or IdempotentInstanceTerminated, and neither
# spelling is carried in any local artifact this repo can check before the run.
# Any EC2 error containing "idempotent" comes from the idempotency machinery,
# which is all this branch needs to establish.
elif printf '%s' "${REPLAY_OUT}" | grep -qi 'idempotent'; then
  echo "    OK: EC2 recognised the ClientToken (idempotency error on the minimal replay: ${REPLAY_OUT})"
else
  echo "FAIL: issue #2039 -- the ClientToken replay never reached the EC2 idempotency check (rc=${REPLAY_RC}): ${REPLAY_OUT}. Without it the count assertion below would pass vacuously." >&2
  exit 1
fi

# The verdict, independent of the branch above: exactly ONE live instance may
# carry this token.
TOKEN_HOLDERS=$(aws ec2 describe-instances \
  --filters "Name=client-token,Values=${CLIENT_TOKEN}" \
  --region "${REGION}" \
  --query 'Reservations[].Instances[?State.Name!=`terminated`].InstanceId[]' \
  --output text)
TOKEN_HOLDER_COUNT=$(printf '%s' "${TOKEN_HOLDERS}" | wc -w | tr -d ' ')
if [ "${TOKEN_HOLDER_COUNT}" != "1" ]; then
  for extra in ${TOKEN_HOLDERS}; do
    if [ "${extra}" != "${INSTANCE_ID}" ]; then
      aws ec2 terminate-instances \
        --instance-ids "${extra}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    fi
  done
  echo "FAIL: issue #2039 -- ${TOKEN_HOLDER_COUNT} live instances carry ClientToken ${CLIENT_TOKEN} (expected exactly 1): ${TOKEN_HOLDERS}. Terminate requested for the extras." >&2
  exit 1
fi
echo "    OK: exactly one live instance carries the ClientToken"

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
