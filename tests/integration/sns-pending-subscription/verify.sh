#!/usr/bin/env bash
# verify.sh — cdkd SNS pending-confirmation subscription destroy integ test
# (issue #1301).
#
# Proves that `cdkd destroy` does NOT get stuck on an AWS::SNS::Subscription
# still in PendingConfirmation. An email subscription to an RFC 2606 reserved
# domain is never confirmed, SNS rejects Unsubscribe on it, and no API can
# remove it (the record auto-expires after ~3 days). CloudFormation skips the
# pending subscription on stack deletion and reports success; cdkd must match.
#
#   Phase 1 (create): deploy topic + email subscription; assert the
#     subscription is listed as PendingConfirmation.
#   Phase 2 (destroy): `cdkd destroy --force` must exit 0 (pre-fix it exited
#     non-zero with PartialFailureError, permanently — every retry failed).
#   Phase 3 (leak check): topic gone, state file gone. The pending
#     subscription record itself legitimately survives (an AWS-side zombie
#     nobody can delete; CloudFormation leaves it too) and is NOT an orphan.
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

STACK="CdkdSnsPendingSubscriptionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

TOPIC_NAME="cdkd-sns-pending-sub-topic"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # The pending email subscription is undeletable by design (SNS rejects
  # Unsubscribe until it expires), so state destroy above may report a
  # partial failure pre-fix; drop the state record directly as a last resort.
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state orphan "${STACK}" --stack-region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # Delete a leftover topic directly (its deletion also invalidates the
  # pending subscription server-side).
  local topic_arn
  topic_arn=$(aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
    --output text 2>/dev/null)
  if [ -n "${topic_arn}" ] && [ "${topic_arn}" != "None" ]; then
    aws sns delete-topic --topic-arn "${topic_arn}" --region "${REGION}" >/dev/null 2>&1 || true
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

resolve_topic_arn() {
  aws sns list-topics --region "${REGION}" \
    --query "Topics[?ends_with(TopicArn, ':${TOPIC_NAME}')].TopicArn | [0]" \
    --output text
}

# --- Phase 1: create (email subscription stays PendingConfirmation) --------
echo "==> Phase 1: deploy (topic + never-confirmed email subscription)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

TOPIC_ARN=$(resolve_topic_arn)
if [ -z "${TOPIC_ARN}" ] || [ "${TOPIC_ARN}" = "None" ]; then
  echo "FAIL: could not resolve topic ARN for ${TOPIC_NAME}" >&2
  exit 1
fi

# Assertion 1: the email subscription exists and is PendingConfirmation.
PENDING_COUNT=$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
  --region "${REGION}" \
  --query "length(Subscriptions[?Protocol=='email' && SubscriptionArn=='PendingConfirmation'] || \`[]\`)" \
  --output text)
if [ "${PENDING_COUNT}" -lt 1 ]; then
  echo "FAIL: expected a PendingConfirmation email subscription on ${TOPIC_NAME}, found ${PENDING_COUNT}" >&2
  exit 1
fi
echo "    OK: email subscription is PendingConfirmation"

# --- Phase 2: destroy must succeed despite the pending subscription --------
echo "==> Phase 2: destroy (must skip the pending subscription — issue #1301)"
if ! node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force; then
  echo "FAIL: cdkd destroy failed — pending-confirmation subscription wedged the destroy (issue #1301)" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

# --- Phase 3: leak check ----------------------------------------------------
# NOTE: the pending subscription record itself may remain visible in
# `aws sns list-subscriptions` for up to 3 days. That zombie is undeletable by
# ANY caller (CloudFormation leaves it too) and expires on its own — it is
# deliberately NOT treated as a leak here.
assert_gone "topic ${TOPIC_NAME} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: topic is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> sns-pending-subscription test passed (pending subscription skipped, clean destroy)"
