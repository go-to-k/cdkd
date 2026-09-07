#!/usr/bin/env bash
# verify.sh — cdkd sticky-CC -> SDK re-route parity integ (issue 2719).
#
# The `'sdk-coverage'` sticky exemption lets a resource recorded as
# `provisionedBy: 'cc-api'` return to its SDK provider once cdkd covers every
# property that resource uses. Its safety property is condition 2: both layers
# address the resource by the SAME physicalId, so the flip is churn-free.
#
# That is an EMPIRICAL, per-type claim -- Cloud Control mints an `Identifier`
# from the schema's `primaryIdentifier`, the SDK provider stores whatever its
# create returned -- and it is false in general. This arm observes it on a live
# resource instead of asserting it from provider source.
#
# Phases: deploy on the SDK route -> force the resource onto Cloud Control
# (--recreate-via-cc-api) -> assert the plan ANNOUNCES the return -> redeploy
# with a real property change -> assert the physical id is UNCHANGED and the
# record flipped to 'sdk' -> assert --pin-cc-api declines the flip -> destroy.

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

STACK="CdkdCcToSdkRerouteExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TOPIC_NAME="${STACK}-topic"
# Resolved from the synth template below, never hard-coded: CDK appends a hash
# to the construct id (RerouteTopic -> RerouteTopic2EE38462), so the literal
# construct id is rejected by --recreate-via-cc-api's own pre-flight.
LOGICAL_ID=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The state record for the one resource under test. `logicalId` is a CDK
# construct path suffixed with a hash, so it is matched by PREFIX rather than
# guessed -- a guessed key would make every assertion below read `null` and
# pass vacuously, which is why `record()` hard-fails on an empty match.
record() { # usage: record <jq-expression-over-the-resource-object>
  local json key
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  key=$(printf '%s' "${json}" | jq -r --arg p "${LOGICAL_ID}" \
    '.resources | keys[] | select(startswith($p))' | head -1)
  [ -n "${key}" ] || { echo "FAIL: no state resource whose logical id starts with ${LOGICAL_ID}" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "${key}" ".resources[\$k] | $1"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  ACCT=$(aws sts get-caller-identity --query Account --output text 2>/dev/null || true)
  if [ -n "${ACCT}" ]; then
    aws sns delete-topic --topic-arn "arn:aws:sns:${REGION}:${ACCT}:${TOPIC_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    # A failed deploy leaves this sibling; `deployments/` is append-only run
    # history and is deliberately kept (same convention as acm-certificate).
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

# Resolve the CFn logical id from the synth template. `--recreate-via-cc-api`
# validates its argument against the template's OWN logical ids, so a construct
# id fails pre-flight; deriving it also keeps this fixture working when a CDK
# upgrade changes the hash suffix.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE=$(ls cdk.out/${STACK}.template.json 2>/dev/null | head -1)
[ -n "${TEMPLATE}" ] || { echo "FAIL: no synth template at cdk.out/${STACK}.template.json" >&2; exit 1; }
LOGICAL_ID=$(jq -r '.Resources | to_entries[] | select(.value.Type == "AWS::SNS::Topic") | .key' "${TEMPLATE}" | head -1)
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no AWS::SNS::Topic in ${TEMPLATE}" >&2; exit 1; }
echo "==> Resource under test: ${LOGICAL_ID}"

echo "==> Phase 1: Deploy (SDK route by default -- SNS::Topic has no silent drops)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

P0=$(record '.physicalId')
LAYER0=$(record '.provisionedBy')
[ "${LAYER0}" = "sdk" ] || { echo "FAIL: fresh deploy recorded provisionedBy=${LAYER0}, expected sdk" >&2; exit 1; }
echo "    OK: created on the SDK route (${P0})"

echo "==> Phase 2: force the resource onto Cloud Control (--recreate-via-cc-api)"
# Seeds the sticky cc-api state the exemption has to escape from. Deliberately
# NOT a binary swap against a released cdkd: seeding via the auto-route would
# need a property that is still a silent drop in THAT release, which is a
# moving target as issue 609's backfill lands. This shape needs one binary.
# CDKD_TEST_PHASE=seed, not base: measured 2026-09-07, `--recreate-via-cc-api`
# on an otherwise-unchanged template PRINTS its "will destroy + recreate"
# warning and then does nothing -- the differ classifies the resource
# NO_CHANGE, so the engine never provisions it and the flag no-ops -- issue
# go-to-k/cdkd#2651, which this run confirmed live. Here it just means the
# seeding phase must carry a real property change like every other routing
# phase.
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${LOGICAL_ID}" --yes

P1=$(record '.physicalId')
LAYER1=$(record '.provisionedBy')
[ "${LAYER1}" = "cc-api" ] || { echo "FAIL: after --recreate-via-cc-api the record says provisionedBy=${LAYER1}, expected cc-api. The seeding step did not seed, so every assertion below would be vacuous." >&2; exit 1; }
# The physical id is EXPECTED to be identical to phase 1's here, and that is
# worth stating because the obvious assertion is the opposite. The topic name
# is fixed by the template, so its ARN is deterministic: a destroy + recreate
# mints the same string. Demanding a CHANGE here failed a run against a
# perfectly good recreate.
#
# It also means "the id did not change" cannot witness the flip in phase 5 --
# see the out-of-band subscription below, which can.
[ "${P1}" = "${P0}" ] || { echo "FAIL: the recreate changed the ARN (${P0} -> ${P1}); the topic name is fixed, so this should be impossible and something else moved" >&2; exit 1; }
D_SEED=$(aws sns get-topic-attributes --topic-arn "${P1}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text)
[ "${D_SEED}" = "seeded-on-cc" ] || { echo "FAIL: the CC recreate did not reach AWS (DisplayName=${D_SEED}); the record says cc-api but nothing was provisioned" >&2; exit 1; }
echo "    OK: pinned to Cloud Control, id ${P1}, CC write confirmed live"

# IDENTITY WITNESS. With a fixed name the ARN survives a destroy + recreate, so
# comparing ids cannot tell an in-place update from a replacement -- and "the
# flip is churn-free" is exactly the claim that distinction carries. A
# subscription cdkd does not manage is destroyed WITH its topic and cannot be
# recreated by a deploy, so its survival across phase 5 is positive evidence
# that the resource itself was never replaced.
aws sns subscribe --topic-arn "${P1}" --protocol email \
  --notification-endpoint "cdkd-integ-witness@example.com" --region "${REGION}" >/dev/null
SUBS_BEFORE=$(aws sns list-subscriptions-by-topic --topic-arn "${P1}" --region "${REGION}" \
  --query 'length(Subscriptions)' --output text)
[ "${SUBS_BEFORE}" = "1" ] || { echo "FAIL: identity witness not established (subscriptions=${SUBS_BEFORE}, expected 1)" >&2; exit 1; }
echo "    OK: identity witness attached (1 unmanaged subscription)"

echo "==> Phase 3: the plan ANNOUNCES the return (issue 2719 sub-question 4)"
DIFF_OUT=$(env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
printf '%s' "${DIFF_OUT}" | grep -q 'returning to SDK provider' || {
  echo "FAIL: cdkd diff did not announce the routing change. A flip that moves a live resource between provisioning layers must be visible at plan time, not only in a debug log." >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
}
printf '%s' "${DIFF_OUT}" | grep -q 'via CC API: sticky' && {
  echo "FAIL: cdkd diff still renders the sticky tag for a resource that is about to leave Cloud Control" >&2
  exit 1
}
echo "    OK: plan says 'returning to SDK provider'"

echo "==> Phase 4: --pin-cc-api DECLINES the flip (the escape hatch is real)"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --pin-cc-api "${LOGICAL_ID}" --yes
LAYER_PINNED=$(record '.provisionedBy')
[ "${LAYER_PINNED}" = "cc-api" ] || { echo "FAIL: --pin-cc-api did not hold the resource on Cloud Control (provisionedBy=${LAYER_PINNED})" >&2; exit 1; }
P_PINNED=$(record '.physicalId')
[ "${P_PINNED}" = "${P1}" ] || { echo "FAIL: the pinned deploy changed the physical id (${P1} -> ${P_PINNED})" >&2; exit 1; }
# Without this, "provisionedBy is still cc-api" is equally explained by "this
# deploy was a NO_CHANGE and the provider was never called", which would make
# the pin assertion vacuous.
D_PINNED=$(aws sns get-topic-attributes --topic-arn "${P_PINNED}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text)
[ "${D_PINNED}" = "pinned-on-cc" ] || { echo "FAIL: the pinned deploy did not reach AWS (DisplayName=${D_PINNED}); the pin assertion above proved nothing" >&2; exit 1; }
echo "    OK: still on Cloud Control, id unchanged, update applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; the flip must be churn-free"
# A REAL property change (DisplayName), because a NO_CHANGE deploy never
# provisions the resource and so cannot flip it: the arm would pass having
# exercised nothing.
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

P2=$(record '.physicalId')
LAYER2=$(record '.provisionedBy')
[ "${LAYER2}" = "sdk" ] || { echo "FAIL: the record did not flip back (provisionedBy=${LAYER2}, expected sdk)" >&2; exit 1; }
[ "${P2}" = "${P1}" ] || { echo "FAIL: PHYSICAL ID CHURN across the flip: ${P1} -> ${P2}. Condition 2 does not hold for this type; it must not carry an 'sdk-coverage' exemption." >&2; exit 1; }
# The id comparison above is NECESSARY but not sufficient -- a fixed-name topic
# keeps its ARN through a replacement. The witness is what makes it sufficient.
SUBS_AFTER=$(aws sns list-subscriptions-by-topic --topic-arn "${P2}" --region "${REGION}" \
  --query 'length(Subscriptions)' --output text)
[ "${SUBS_AFTER}" = "1" ] || { echo "FAIL: the unmanaged subscription is gone (subscriptions=${SUBS_AFTER}, expected 1). The ARN survived but the RESOURCE was replaced, so the flip is NOT churn-free." >&2; exit 1; }
# And the update itself actually reached AWS through the SDK provider.
DISPLAY=$(aws sns get-topic-attributes --topic-arn "${P2}" --region "${REGION}" \
  --query 'Attributes.DisplayName' --output text)
[ "${DISPLAY}" = "after-reroute" ] || { echo "FAIL: the update did not reach AWS (DisplayName=${DISPLAY})" >&2; exit 1; }
echo "    OK: same id ${P2}, record flipped to sdk, unmanaged subscription intact, update applied in place"

echo "==> Phase 6: Destroy (now SDK-routed) + gone-probe"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "SNS topic ${P2} survived destroy" \
  aws sns get-topic-attributes --topic-arn "${P2}" --region "${REGION}"
echo "    OK: destroyed clean"

echo "PASS: cc-to-sdk-reroute (physicalId parity observed on a live resource)"
