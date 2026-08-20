#!/usr/bin/env bash
# verify.sh — standalone `AWS::SNS::Subscription` UPDATE integ (issue #1967).
#
# `SNSSubscriptionProvider.update` replaces DELETE-first. Nothing in the integ
# tree drove that method before this fixture, which is how the thrown-delete arm
# of #1967 reached main.
#
#   Phase 1 (create): subscription with RawMessageDelivery=false.
#   Phase 2 (update, CDKD_TEST_UPDATE=raw-delivery): the REGRESSION arm — the
#     replacement must converge, leave EXACTLY ONE subscription, and mint a new
#     SubscriptionArn that cdkd records.
#   Phase 3 (throw arm): the state physicalId is rewritten to a malformed
#     subscription ARN so `Unsubscribe` throws; cdkd must ABORT before creating.
#   Phase 4 (repair + destroy): restore the real ARN, `cdkd destroy`, leak check.
#
# ## Why the mutated property is `RawMessageDelivery` and not `Endpoint`
#
# MEASURED. `Endpoint` / `Protocol` / `TopicArn` are `createOnlyProperties` in
# the live CloudFormation registry (`aws cloudformation describe-type
# --type-name AWS::SNS::Subscription` returns exactly those three), and
# `diff-calculator.ts` applies that schema wherever `ReplacementRulesRegistry`
# has no opinion — it has none for this type. A createOnly change therefore sets
# `requiresReplacement`, which routes to `deploy-engine.ts`'s own replacement
# branch (`if (needsReplacement)`, line ~3501); the engine's ONLY
# `provider.update()` call site (line ~4047) sits in the `else` of that same
# `if`. An endpoint-change fixture would execute not one line of the method
# under test while looking exactly like a test of it.
#
# ## Why phase 3 asserts the failure REASON and not the AWS end state
#
# Also measured, against real SNS:
#
#   - `Subscribe` is idempotent for an identical (topic, protocol, endpoint)
#     with identical attributes: it returns the SAME SubscriptionArn and the
#     topic still holds ONE subscription.
#   - `Subscribe` for an identical (topic, protocol, endpoint) with DIFFERENT
#     attributes is REFUSED: `InvalidParameter ... Subscription already exists
#     with different attributes`.
#
# Since topic / protocol / endpoint are exactly the three createOnly properties,
# any change that reaches `update()` leaves all three identical — so the
# "two live subscriptions" outcome #1967 describes CANNOT occur on this path;
# SNS itself enforces uniqueness. Pre-fix, this phase failed too, but with SNS's
# confusing `already exists with different attributes` from the create. The
# discriminator is therefore that cdkd's own refusal is reported AND that SNS's
# message is ABSENT — i.e. the `Subscribe` was never issued. Asserting only the
# AWS end state would pass against the defect.
#
# LEAK SAFETY. Phase 3 deliberately leaves a malformed physicalId in state, and
# `cdkd state destroy` cannot clear it (a malformed subscription ARN answers
# `InvalidParameter`, not `NotFound`, so the delete throws every time). `cleanup`
# therefore deletes the topic and queue DIRECTLY by their real, deterministic
# names and drops the record with `state orphan --force`, and is armed on
# EXIT / INT / TERM in the exiting form with the rc seeded before arming. The
# happy path repairs state and runs a real `cdkd destroy` instead, so the
# `integ-destroy` gate still sees a clean cdkd teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

set -euo pipefail

export AWS_PAGER=""

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

STACK="CdkdSnsSubscriptionUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SUB_TYPE="AWS::SNS::Subscription"

# Must match lib/sns-subscription-update-stack.ts. Explicit physical names, so
# every assertion below reads AWS by real name rather than by logical id.
TOPIC_NAME="cdkd-sub-update-topic"
QUEUE_NAME="cdkd-sub-update-queue"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Per-run scratch for the state documents this fixture rewrites and pushes back
# to S3. A fixed /tmp path cross-wires two overlapping runs, which for THESE
# documents is the worst possible thing to share. Removed by `cleanup`.
#
# **Created AFTER the pre-run `cleanup` call, deliberately — see the rule on
# `cleanup` below.** Left at the top of the file (where a reader looks for the
# constants) it was created, then destroyed by the pre-run sweep seconds later,
# and phase 3's first write died on a directory that no longer existed.
WORKDIR=""

# Populated after the account lookup; cleanup tolerates them being empty.
TOPIC_ARN=""
QUEUE_ARN=""

# **A `cleanup` that ALSO runs pre-run must not destroy anything the run then
# needs.** This one is called three ways — once explicitly before phase 1 to
# sweep a previous run's leftovers, once by the EXIT trap, and once by the
# INT / TERM traps — so every line in it runs at least twice, and the pre-run
# call happens BEFORE the phases have built anything. AWS resources are safe
# because creating them IS a phase; a local scratch directory computed at
# variable-definition time is NOT, which is exactly how `WORKDIR` broke. The
# rule generalises: anything `cleanup` removes must either be re-created by a
# phase, or be created after the pre-run call.
cleanup() {
  echo "==> Cleanup: deleting topic + queue directly, then dropping the record"
  set +eu
  # AWS FIRST, by deterministic name. Deleting the topic removes its
  # subscriptions, including one this fixture can no longer address.
  if [ -n "${TOPIC_ARN}" ]; then
    aws sns delete-topic --region "${REGION}" --topic-arn "${TOPIC_ARN}" >/dev/null 2>&1
  fi
  local qurl
  qurl=$(aws sqs get-queue-url --region "${REGION}" --queue-name "${QUEUE_NAME}" \
    --query 'QueueUrl' --output text 2>/dev/null)
  if [ -n "${qurl}" ] && [ "${qurl}" != "None" ]; then
    aws sqs delete-queue --region "${REGION}" --queue-url "${qurl}" >/dev/null 2>&1
  fi
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    # `state destroy` cannot clear a record whose subscription physicalId is
    # malformed (phase 3 writes one on purpose); `state orphan` is the drop that
    # always works, and is the remedy cdkd's own abort message names.
    node "${LOCAL_DIST}" state orphan "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --stack-region "${REGION}" --force
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  # Guarded on the mktemp prefix so a mis-set variable cannot widen this.
  case "${WORKDIR:-}" in
    */cdkd-sub-update.*) rm -rf "${WORKDIR}" ;;
  esac
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

ACCOUNT_ID="$(aws sts get-caller-identity --query 'Account' --output text)"
case "${ACCOUNT_ID}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "FAIL: could not resolve a 12-digit account id (got '${ACCOUNT_ID}')" >&2
    exit 1
    ;;
esac
TOPIC_ARN="arn:aws:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"
QUEUE_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_NAME}"

echo "==> Pre-run cleanup"
cleanup

# Only now — the sweep above would have deleted it (see the rule on `cleanup`).
WORKDIR="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-sub-update.XXXXXX")"

# --- shared readers ---------------------------------------------------------
# Read AWS by the topic's REAL ARN, never through cdkd state, so a cdkd bug
# cannot make its own assertion pass.
sub_count() {
  aws sns list-subscriptions-by-topic --region "${REGION}" --topic-arn "${TOPIC_ARN}" \
    --query 'length(Subscriptions)' --output text
}
sub_arn() {
  aws sns list-subscriptions-by-topic --region "${REGION}" --topic-arn "${TOPIC_ARN}" \
    --query 'Subscriptions[0].SubscriptionArn' --output text
}
sub_endpoint() {
  aws sns list-subscriptions-by-topic --region "${REGION}" --topic-arn "${TOPIC_ARN}" \
    --query 'Subscriptions[0].Endpoint' --output text
}
raw_delivery_of() { # usage: raw_delivery_of <subscriptionArn>
  aws sns get-subscription-attributes --region "${REGION}" --subscription-arn "$1" \
    --query 'Attributes.RawMessageDelivery' --output text
}
state_sub_physical_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
    | jq -r --arg t "${SUB_TYPE}" \
      '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.physicalId] | first // ""'
}
# `ListSubscriptionsByTopic` LAGS an `Unsubscribe`, so a bare read straight after
# a replacement can still show the old subscription beside the new one. Read once
# and you report a DUPLICATE — i.e. you accuse the fix of the exact defect it
# removed — for what is only eventual consistency. Poll instead, and say which of
# the two the run actually saw.
SETTLE_ATTEMPTS=12
SETTLE_SLEEP=5
assert_exactly_one_subscription() { # usage: assert_exactly_one_subscription "<phase>"
  local phase="$1" count attempt=1
  while :; do
    count=$(sub_count)
    [ "${count}" = "1" ] && return 0
    [ "${attempt}" -ge "${SETTLE_ATTEMPTS}" ] && break
    echo "    (${phase}: ${count} subscription(s), still converging — attempt ${attempt}/${SETTLE_ATTEMPTS})"
    attempt=$((attempt + 1))
    sleep "${SETTLE_SLEEP}"
  done

  echo "FAIL: ${phase}: topic ${TOPIC_NAME} settled at ${count} subscription(s), expected exactly 1" >&2
  if [ "${count}" -gt 1 ] 2>/dev/null; then
    echo "    => Still ${count} after $((SETTLE_ATTEMPTS * SETTLE_SLEEP))s of polling, so this is" >&2
    echo "       NOT list-lag: it is a genuine DUPLICATE, and every message published to the" >&2
    echo "       topic is delivered more than once." >&2
  else
    echo "    => Fewer than one: the replacement deleted the old subscription and never" >&2
    echo "       created the new one." >&2
  fi
  aws sns list-subscriptions-by-topic --region "${REGION}" --topic-arn "${TOPIC_ARN}" >&2
  exit 1
}

# --- Phase 1: create --------------------------------------------------------
echo "==> Phase 1: deploy (standalone subscription, RawMessageDelivery=false)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_exactly_one_subscription "phase 1"
SUB_ARN_1=$(sub_arn)
if [ "${SUB_ARN_1}" = "None" ] || [ -z "${SUB_ARN_1}" ]; then
  echo "FAIL: phase 1: no SubscriptionArn on topic ${TOPIC_NAME}" >&2
  exit 1
fi
ENDPOINT_1=$(sub_endpoint)
if [ "${ENDPOINT_1}" != "${QUEUE_ARN}" ]; then
  echo "FAIL: phase 1: subscription endpoint is '${ENDPOINT_1}', expected '${QUEUE_ARN}'" >&2
  exit 1
fi
RAW_1=$(raw_delivery_of "${SUB_ARN_1}")
if [ "${RAW_1}" != "false" ]; then
  echo "FAIL: phase 1: RawMessageDelivery is '${RAW_1}', expected 'false'" >&2
  echo "    => the explicit false was dropped rather than forwarded." >&2
  exit 1
fi
echo "    OK: one subscription ${SUB_ARN_1} -> ${QUEUE_ARN}, RawMessageDelivery=false"

# --- Phase 2: the REGRESSION arm -------------------------------------------
# `RawMessageDelivery` is mutable, so the engine hands this to
# `SNSSubscriptionProvider.update()` — which unsubscribes and re-subscribes.
echo "==> Phase 2: update RawMessageDelivery false -> true (drives update())"
CDKD_TEST_UPDATE=raw-delivery node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_exactly_one_subscription "phase 2"
SUB_ARN_2=$(sub_arn)
if [ "${SUB_ARN_2}" = "${SUB_ARN_1}" ]; then
  echo "FAIL: phase 2: SubscriptionArn is unchanged (${SUB_ARN_2})" >&2
  echo "    => update() did NOT perform its delete-then-create replacement, so this run" >&2
  echo "       exercised none of the path under test. A fresh Subscribe after Unsubscribe" >&2
  echo "       mints a new GUID (measured), so the ARN is what proves the replacement ran." >&2
  exit 1
fi
ENDPOINT_2=$(sub_endpoint)
if [ "${ENDPOINT_2}" != "${QUEUE_ARN}" ]; then
  echo "FAIL: phase 2: subscription endpoint is '${ENDPOINT_2}', expected '${QUEUE_ARN}'" >&2
  exit 1
fi
RAW_2=$(raw_delivery_of "${SUB_ARN_2}")
if [ "${RAW_2}" != "true" ]; then
  echo "FAIL: phase 2: RawMessageDelivery is '${RAW_2}', expected 'true' after the update" >&2
  exit 1
fi
STATE_PID_2=$(state_sub_physical_id)
if [ "${STATE_PID_2}" != "${SUB_ARN_2}" ]; then
  echo "FAIL: phase 2: state records physicalId '${STATE_PID_2}', AWS has '${SUB_ARN_2}'" >&2
  echo "    => cdkd kept the OLD ARN, so the next destroy would address a subscription" >&2
  echo "       that no longer exists and leak the live one." >&2
  exit 1
fi
echo "    OK: replaced ${SUB_ARN_1} -> ${SUB_ARN_2}, RawMessageDelivery=true, state in sync"

# --- Phase 3: the THROW arm -------------------------------------------------
# A malformed subscription ARN makes `Unsubscribe` answer `InvalidParameter:
# Subscription GUID` (measured) — neither `NotFoundException` nor the
# pending-confirmation wording, so `delete()` raises a `ProvisioningError` and
# `update()` reaches the arm issue #1967 fixed.
echo "==> Phase 3: corrupt the recorded physicalId so the Unsubscribe THROWS"
# Checked at the first USE rather than only at creation: that is where a
# re-ordering of the pre-run cleanup bites, and without it the failure is a bare
# `No such file or directory` from a redirect 200 lines from the cause.
if [ ! -d "${WORKDIR:-/nonexistent}" ]; then
  echo "FAIL: WORKDIR '${WORKDIR:-<unset>}' does not exist at first use." >&2
  echo "    It is created after the pre-run 'cleanup' call because cleanup removes it;" >&2
  echo "    something has re-ordered the two. See the rule on the cleanup function." >&2
  exit 1
fi
MALFORMED="${TOPIC_ARN}:not-a-uuid"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "
import json, sys
state = json.load(sys.stdin)
for resource in state['resources'].values():
    if resource['resourceType'] == '${SUB_TYPE}':
        resource['physicalId'] = sys.argv[1]
print(json.dumps(state))
" "${MALFORMED}" > "${WORKDIR}/state.json"
aws s3 cp "${WORKDIR}/state.json" "s3://${STATE_BUCKET}/${STATE_KEY}" \
  --region "${REGION}" >/dev/null
if [ "$(state_sub_physical_id)" != "${MALFORMED}" ]; then
  echo "FAIL: phase 3: the state rewrite did not take" >&2
  exit 1
fi
echo "    state physicalId rewritten to ${MALFORMED}"

set +e
DEPLOY_OUT=$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DEPLOY_RC=$?
set -e
printf '%s\n' "${DEPLOY_OUT}"
# Assert against a COLOR-STRIPPED copy: cdkd always emits ANSI (colors.ts has no
# TTY check), and a warn line is wrapped whole, but the summary numbers are
# wrapped individually — a literal grep across one would silently never match.
DEPLOY_TXT=$(printf '%s' "${DEPLOY_OUT}" | sed $'s/\033\[[0-9;]*m//g')

if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: phase 3: deploy exited 0 with an un-deletable old subscription" >&2
  exit 1
fi
echo "    OK: deploy exited ${DEPLOY_RC}"

# Two INDEPENDENT markers from different producers, so "the condition did not
# occur" stays distinguishable from "the wording moved and the grep went blind".
THROW_SEEN=0
if printf '%s' "${DEPLOY_TXT}" | grep -q 'Failed to delete old subscription'; then
  THROW_SEEN=1
fi
ABORT_SEEN=0
if printf '%s' "${DEPLOY_TXT}" | grep -q 'was not deleted'; then
  ABORT_SEEN=1
fi

# `Failed to delete old subscription` is logged ONLY by the catch in `update()`,
# so it is what proves the THROW arm — not the skip arm — was the one taken.
if [ "${THROW_SEEN}" -eq 0 ]; then
  echo "FAIL: phase 3: the delete did not throw — the arm under test never ran" >&2
  exit 1
fi
if [ "${ABORT_SEEN}" -eq 0 ]; then
  echo "FAIL: phase 3: the delete threw but cdkd did not report the replacement refusal." >&2
  echo "    Either the #1967 abort regressed, or its wording drifted away from this grep —" >&2
  echo "    check the warn text in sns-subscription-provider.ts before reading this as a bug." >&2
  exit 1
fi
echo "    OK: the thrown delete produced the replacement refusal"

# THE discriminator. Pre-fix, cdkd went on to `Subscribe` while the old
# subscription was still live; SNS answers that with `InvalidParameter ...
# Subscription already exists with different attributes` (measured), so the
# deploy failed either way and the AWS end state is identical. Only the ABSENCE
# of SNS's message proves the create was never issued.
if printf '%s' "${DEPLOY_TXT}" | grep -q 'already exists with different attributes'; then
  echo "FAIL: phase 3: cdkd issued the Subscribe anyway after the delete threw." >&2
  echo "    SNS refused it ('already exists with different attributes'), which is the" >&2
  echo "    pre-#1967 behaviour: the create must not be attempted at all." >&2
  exit 1
fi
echo "    OK: no Subscribe was issued after the thrown delete"

# ...and the live subscription is untouched.
assert_exactly_one_subscription "phase 3"
SUB_ARN_3=$(sub_arn)
if [ "${SUB_ARN_3}" != "${SUB_ARN_2}" ]; then
  echo "FAIL: phase 3: the live subscription changed from ${SUB_ARN_2} to ${SUB_ARN_3}" >&2
  exit 1
fi
RAW_3=$(raw_delivery_of "${SUB_ARN_3}")
if [ "${RAW_3}" != "true" ]; then
  echo "FAIL: phase 3: RawMessageDelivery is '${RAW_3}', expected the untouched 'true'" >&2
  exit 1
fi
echo "    OK: the old subscription ${SUB_ARN_3} is untouched"

# --- Phase 4: repair + destroy ---------------------------------------------
# The record still carries the malformed ARN, which `cdkd destroy` cannot
# address. Repair it from AWS so the destroy under test is a REAL cdkd destroy
# (the `integ-destroy` gate needs one) rather than the trap's direct deletes.
echo "==> Phase 4: repair the recorded physicalId, then destroy"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "
import json, sys
state = json.load(sys.stdin)
for resource in state['resources'].values():
    if resource['resourceType'] == '${SUB_TYPE}':
        resource['physicalId'] = sys.argv[1]
print(json.dumps(state))
" "${SUB_ARN_3}" > "${WORKDIR}/state-repaired.json"
aws s3 cp "${WORKDIR}/state-repaired.json" "s3://${STATE_BUCKET}/${STATE_KEY}" \
  --region "${REGION}" >/dev/null
if [ "$(state_sub_physical_id)" != "${SUB_ARN_3}" ]; then
  echo "FAIL: phase 4: the state repair did not take" >&2
  exit 1
fi

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "topic ${TOPIC_NAME} still exists after destroy (orphan)" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN}"
echo "    OK: topic is gone (its subscriptions with it)"

assert_gone "queue ${QUEUE_NAME} still exists after destroy (orphan)" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${QUEUE_NAME}"
echo "    OK: queue is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "=== PASS: standalone SNS::Subscription update replacement + #1967 thrown-delete abort ==="
