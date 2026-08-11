#!/usr/bin/env bash
# verify.sh — EC2 instance fan-out vs the dense IAM-propagation retry
# (issue #1292).
#
# Deploys TEN t3.nano instances that share ONE freshly-named IAM instance
# profile, so all ten RunInstances retry loops overlap the same cold
# EC2-view-of-IAM propagation window. The #1292 arithmetic says the retry
# traffic alone (~0.54 req/s per instance) exceeds the RunInstances token
# refill (~2 req/s) above ~4 concurrent instances; the throttle-aware
# backoff + the `sawPropagation` budget latch are SUPPOSED to keep that a
# slowdown rather than a failure. This fixture is the empirical answer:
# the deploy must CONVERGE (all ten instances created, zero errors), and
# the log evidence (propagation retries seen; throttles seen or not) plus
# the wall clock are reported for the issue record.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-safe (macOS): no `grep -P`, no `date -d`.

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

STACK="Ec2InstanceFanoutStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Cold-path key: fresh IAM role / instance-profile names on every run.
SUFFIX="$(date +%s)"
INSTANCE_IDS=""

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Do NOT silence stderr — a partial failure must be visible so we never
    # leak ten billing instances.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi
  if [ -n "${INSTANCE_IDS}" ]; then
    # Belt-and-suspenders in case state destroy could not reach them.
    aws ec2 terminate-instances --instance-ids ${INSTANCE_IDS} \
      --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # A mid-deploy interrupt can leave instances that RunInstances created but
  # the incremental state write had not persisted yet (so state destroy
  # cannot see them and INSTANCE_IDS is still empty). Every launched
  # instance carries the suffix-unique profile from birth, so sweep by the
  # profile association before deleting the IAM pair.
  ORPHAN_IDS="$(aws ec2 describe-iam-instance-profile-associations \
    --filters "Name=state,Values=associated,associating" --region "${REGION}" \
    --query "IamInstanceProfileAssociations[?contains(IamInstanceProfile.Arn, \`fanout-prof-${SUFFIX}\`)].InstanceId" \
    --output text 2>/dev/null || true)"
  if [ -n "${ORPHAN_IDS}" ]; then
    aws ec2 terminate-instances --instance-ids ${ORPHAN_IDS} \
      --region "${REGION}" >/dev/null 2>&1 || true
  fi
  aws iam remove-role-from-instance-profile \
    --instance-profile-name "fanout-prof-${SUFFIX}" \
    --role-name "fanout-role-${SUFFIX}" >/dev/null 2>&1 || true
  aws iam delete-instance-profile \
    --instance-profile-name "fanout-prof-${SUFFIX}" >/dev/null 2>&1 || true
  aws iam delete-role --role-name "fanout-role-${SUFFIX}" >/dev/null 2>&1 || true
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

DEPLOY_LOG="$(mktemp)"

echo "==> Phase 1: cold fan-out deploy (suffix=${SUFFIX}, 10 x t3.nano, one fresh profile)"
DEPLOY_START="$(date +%s)"
# --verbose so the propagation-retry and throttle log lines are observable;
# default wait mode (the propagation retry rides the create path either way).
DEPLOY_RC=0
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c "suffix=${SUFFIX}" \
  --verbose \
  --yes 2>&1 | tee "${DEPLOY_LOG}" || DEPLOY_RC=$?
DEPLOY_END="$(date +%s)"
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: fan-out deploy did not converge (rc=${DEPLOY_RC}) — the #1292 interaction IS a real failure mode" >&2
  exit 1
fi
echo "    deploy wall clock: $((DEPLOY_END - DEPLOY_START))s"

# --- Evidence for the #1292 record (informational, never a failure) --------
PROPAGATION_HITS="$(grep -ci 'Invalid IAM Instance Profile' "${DEPLOY_LOG}" || true)"
THROTTLE_HITS="$(grep -ciE 'Rate exceeded|RequestLimitExceeded' "${DEPLOY_LOG}" || true)"
echo "    propagation-retry log lines: ${PROPAGATION_HITS}"
echo "    throttle log lines:          ${THROTTLE_HITS}"

echo "==> Phase 2: assert all ten instances exist in state, all on the SDK path"
STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
INSTANCE_COUNT="$(echo "${STATE}" | jq '[.resources[] | select(.resourceType == "AWS::EC2::Instance")] | length')"
if [ "${INSTANCE_COUNT}" != "10" ]; then
  echo "FAIL: expected 10 AWS::EC2::Instance resources in state, got ${INSTANCE_COUNT}" >&2
  exit 1
fi
NON_SDK="$(echo "${STATE}" | jq '[.resources[] | select(.resourceType == "AWS::EC2::Instance") | select((.provisionedBy // "sdk") != "sdk")] | length')"
if [ "${NON_SDK}" != "0" ]; then
  echo "FAIL: ${NON_SDK} instances routed off the SDK path — the propagation retry under test never ran for them" >&2
  exit 1
fi
INSTANCE_IDS="$(echo "${STATE}" | jq -r '[.resources[] | select(.resourceType == "AWS::EC2::Instance") | .physicalId] | join(" ")')"
echo "    instance ids: ${INSTANCE_IDS}"

echo "==> Phase 3: every instance really exists and carries the shared profile association"
RUNNING_COUNT="$(aws ec2 describe-instances \
  --instance-ids ${INSTANCE_IDS} --region "${REGION}" \
  --query 'length(Reservations[].Instances[?State.Name==`running` || State.Name==`pending`][])' --output text)"
if [ "${RUNNING_COUNT}" != "10" ]; then
  echo "FAIL: expected 10 running/pending instances on AWS, got ${RUNNING_COUNT}" >&2
  exit 1
fi
ASSOC_COUNT="$(aws ec2 describe-iam-instance-profile-associations \
  --filters "Name=state,Values=associated,associating" --region "${REGION}" \
  --query "length(IamInstanceProfileAssociations[?contains(IamInstanceProfile.Arn, \`fanout-prof-${SUFFIX}\`)])" --output text)"
if [ "${ASSOC_COUNT}" != "10" ]; then
  echo "FAIL: expected 10 instance-profile associations for fanout-prof-${SUFFIX}, got ${ASSOC_COUNT} — RunInstances 'converged' without the profile actually attaching" >&2
  exit 1
fi
echo "    OK: 10/10 instances up, 10/10 profile associations live"

echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  -c "suffix=${SUFFIX}" \
  --force

echo "==> Phase 5: gone-probes"
assert_gone "state file survived destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
assert_gone "instance profile fanout-prof-${SUFFIX} survived destroy" \
  aws iam get-instance-profile --instance-profile-name "fanout-prof-${SUFFIX}"
assert_gone "role fanout-role-${SUFFIX} survived destroy" \
  aws iam get-role --role-name "fanout-role-${SUFFIX}"
TERMINATED="$(aws ec2 describe-instances \
  --instance-ids ${INSTANCE_IDS} --region "${REGION}" \
  --query 'length(Reservations[].Instances[?State.Name==`terminated` || State.Name==`shutting-down`][])' --output text)"
if [ "${TERMINATED}" != "10" ]; then
  echo "FAIL: expected all 10 instances terminated/shutting-down after destroy, got ${TERMINATED}" >&2
  exit 1
fi
INSTANCE_IDS=""

rm -f "${DEPLOY_LOG}"
trap - EXIT INT TERM
echo ""
echo "==> ec2-instance-fanout test passed (10-instance cold fan-out converged; propagation retries=${PROPAGATION_HITS}, throttles=${THROTTLE_HITS}, deploy $((DEPLOY_END - DEPLOY_START))s + clean destroy)"
