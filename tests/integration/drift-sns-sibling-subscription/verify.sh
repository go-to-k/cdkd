#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#6610 (SNS topic <- AWS::SNS::Subscription).
#
# A subscription a sibling AWS::SNS::Subscription adds to a topic is that
# resource's, not the topic's. On a topic declaring an inline Subscription list
# (whose readback lists every live subscription), `cdkd drift` reported it as
#   ~ Topic (AWS::SNS::Topic)  Subscription: [A] -> [A, B]
# and `cdkd drift --revert -y` UNSUBSCRIBED it.
#
# Phases:
#   1. Deploy the topic (inline subscription to queue A). `cdkd drift` exits 0.
#   2. CDKD_TEST_UPDATE=sub adds a standalone subscription to queue B; the topic
#      is unchanged, so its baseline lacks B. `cdkd drift` exits 0.
#   3. Subscribe queue C OUT OF BAND: `cdkd drift` exits 1 and names C, never B;
#      `cdkd drift --revert -y` unsubscribes C ONLY (A and B stay).
#   4. CDKD_TEST_UPDATE=sub,display UPDATES the topic (DisplayName) while B
#      exists, so its re-captured baseline records B. `cdkd drift` exits 0.
#   5. CDKD_TEST_UPDATE=sub,display,nosub removes the standalone subscription;
#      the topic is unchanged. The deploy drops B from the topic's baseline,
#      `cdkd drift` exits 0, and `--revert -y` does not re-subscribe B.
#   6. Destroy + gone-probes.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdDriftSnsSiblingSubscriptionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The phases set the mode; an inherited value would deploy one early.
unset CDKD_TEST_UPDATE
DRIFT_LOG=""
TOPIC_ARN=""
QUEUE_A=""
QUEUE_B=""
QUEUE_C=""
STRANGER_SUB=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  if [ -n "${STRANGER_SUB:-}" ]; then
    aws sns unsubscribe --subscription-arn "${STRANGER_SUB}" >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
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

# The topic's live subscription endpoints, as the queue letters A / B / C,
# sorted and space-joined. Any other endpoint prints as `?`.
endpoints() {
  local out
  out="$(aws sns list-subscriptions-by-topic --topic-arn "${TOPIC_ARN}" \
    --query 'Subscriptions[].Endpoint' --output text)" || return 1
  printf '%s\n' "${out}" | tr -s ' \t' '\n' | grep -v '^$' | while read -r e || [ -n "${e}" ]; do
    case "${e}" in
      "${QUEUE_A}") echo A ;;
      "${QUEUE_B}") echo B ;;
      "${QUEUE_C}") echo C ;;
      *) echo '?' ;;
    esac
  done | sort | tr '\n' ' ' | sed 's/ $//'
}
expect_endpoints() { # usage: expect_endpoints <label> <want>
  local got
  if ! got="$(endpoints)"; then
    echo "FAIL: list-subscriptions-by-topic ${TOPIC_ARN} failed" >&2
    exit 1
  fi
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1 subscriptions: want [$2], got [${got}]" >&2
    exit 1
  fi
  echo "    ok: $1 subscriptions [${got}]"
}
# The topic record's recorded baseline endpoints, as letters.
baseline_endpoints() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  jq -r '.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::Topic")
    | .value.observedProperties.Subscription[]?.Endpoint' <<<"${state}" | while read -r e || [ -n "${e}" ]; do
    case "${e}" in
      "${QUEUE_A}") echo A ;;
      "${QUEUE_B}") echo B ;;
      "${QUEUE_C}") echo C ;;
      *) echo '?' ;;
    esac
  done | sort | tr '\n' ' ' | sed 's/ $//'
}
expect_baseline() { # usage: expect_baseline <label> <want>
  local got
  if ! got="$(baseline_endpoints)"; then
    echo "FAIL: could not read ${STATE_KEY}" >&2
    exit 1
  fi
  if [ "${got}" != "$2" ]; then
    echo "FAIL: $1 recorded baseline: want [$2], got [${got}]" >&2
    exit 1
  fi
  echo "    ok: $1 recorded baseline [${got}]"
}
run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
TOPIC_ARN="$(jq -r '.outputs.TopicArn // empty' <<<"${STATE_JSON}")"
QUEUE_A="$(jq -r '.outputs.QueueAArn // empty' <<<"${STATE_JSON}")"
QUEUE_B="$(jq -r '.outputs.QueueBArn // empty' <<<"${STATE_JSON}")"
QUEUE_C="$(jq -r '.outputs.QueueCArn // empty' <<<"${STATE_JSON}")"
case "${TOPIC_ARN}" in arn:*:sns:?*) ;; *) echo "FAIL: TopicArn output is not a topic ARN: '${TOPIC_ARN}'" >&2; exit 1 ;; esac
for q in "${QUEUE_A}" "${QUEUE_B}" "${QUEUE_C}"; do
  case "${q}" in arn:*:sqs:?*) ;; *) echo "FAIL: a queue output is not a queue ARN: '${q}'" >&2; exit 1 ;; esac
done
expect_endpoints "Phase 1" "A"
run_drift
expect_drift_rc 0 "Phase 1"

echo "==> Phase 2: add the standalone subscription to queue B (topic unchanged)"
CDKD_TEST_UPDATE=sub node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_endpoints "Phase 2" "A B"
expect_baseline "Phase 2" "A"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: an out-of-band subscription to queue C is drift"
STRANGER_SUB="$(aws sns subscribe --topic-arn "${TOPIC_ARN}" --protocol sqs \
  --notification-endpoint "${QUEUE_C}" --return-subscription-arn --query SubscriptionArn --output text)"
case "${STRANGER_SUB}" in arn:*) ;; *) echo "FAIL: premise: the out-of-band subscription is not confirmed: '${STRANGER_SUB}'" >&2; exit 1 ;; esac
expect_endpoints "Phase 3 (out-of-band)" "A B C"
run_drift
expect_drift_rc 1 "Phase 3"
# Sentinel: the drifted block must be the topic's, so a reworded report cannot
# pass the endpoint greps below vacuously.
if ! grep -q "(AWS::SNS::Topic)" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 3: no AWS::SNS::Topic drift block — the report wording drifted" >&2
  exit 1
fi
if ! grep -qF "${QUEUE_C}" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 3: the drift report does not name the out-of-band queue C" >&2
  exit 1
fi
if grep -qF "${QUEUE_B}" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 3: the drift report names the sibling-owned queue B subscription" >&2
  exit 1
fi
run_drift --revert -y
expect_drift_rc 0 "Phase 3 (--revert)"
expect_endpoints "Phase 3 (after --revert)" "A B"
STRANGER_SUB=""

echo "==> Phase 4: UPDATE the topic while the sibling subscription exists"
CDKD_TEST_UPDATE=sub,display node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_endpoints "Phase 4" "A B"
expect_baseline "Phase 4" "A B"
run_drift
expect_drift_rc 0 "Phase 4"

echo "==> Phase 5: remove the standalone subscription (topic unchanged)"
CDKD_TEST_UPDATE=sub,display,nosub node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
expect_endpoints "Phase 5" "A"
expect_baseline "Phase 5" "A"
run_drift
expect_drift_rc 0 "Phase 5"
run_drift --revert -y
expect_drift_rc 0 "Phase 5 (--revert)"
expect_endpoints "Phase 5 (after --revert)" "A"

echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "topic ${TOPIC_ARN} leaked" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}"
for q in "${QUEUE_A}" "${QUEUE_B}" "${QUEUE_C}"; do
  name="${q##*:}"
  assert_gone "queue ${name} leaked" aws sqs get-queue-url --queue-name "${name}"
done
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
rm -f "${DRIFT_LOG:-}"
echo "PASS: drift-sns-sibling-subscription"
