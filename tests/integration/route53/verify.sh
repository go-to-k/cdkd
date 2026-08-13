#!/usr/bin/env bash
# verify.sh — cdkd Route53 RecordSet GeoProximityLocation + CidrRoutingConfig
# backfill integ test (issue #609).
#
# Asserts that a geoproximity-routing AWS::Route53::RecordSet whose template
# sets `GeoProximityLocation` (here `AWSRegion` + `Bias`) has that field reach
# AWS after `cdkd deploy` — the property was a silent-drop before the #609
# backfill. GeoProximityLocation rides directly on ChangeResourceRecordSets
# (no separate control-plane API), so closing the silent-drop is purely a
# matter of forwarding the field.
#
# Also asserts that a CIDR-routing AWS::Route53::RecordSet whose template sets
# `CidrRoutingConfig` ({ CollectionId, LocationName }) has that field reach AWS
# — the last silent-drop on AWS::Route53::RecordSet, now closed by #609. It too
# rides directly on ChangeResourceRecordSets; the CollectionId references an
# AWS::Route53::CidrCollection (provisioned via Cloud Control API, no SDK
# provider) and CIDR routing requires a SetIdentifier.
#
# Phase 2 (CDKD_TEST_REMOVAL=true, issue #1160 route53 batch) then drops the
# `Dropped` hosted-zone tag and the whole `QueryLoggingConfig` block, and
# asserts BOTH are gone from AWS while the `Keep` tag survives. Pre-fix each
# removal was a silent no-op: `applyHostedZoneTags` only ever sent `AddTags`
# (no untag diff), and `applyQueryLoggingConfig` returned early on an absent
# block, so a live query-logging config kept writing to CloudWatch — and kept
# billing — with `cdkd diff` reporting no changes. Real CloudFormation removes
# both (live A/B, 2026-08-10).
#
# Also asserts the destroy path cleans up (the hosted zone delete requires
# every non-default record gone first; the cdkd destroy DAG handles order).
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

STACK="Route53Stack"
REGION="${AWS_REGION:-us-east-1}"
# The fixture names its zone / query-log group after the account, so the leak
# probes below can be scoped to THIS account rather than an account-wide prefix.
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPECTED_GEO_REGION="us-east-1"
SET_IDENTIFIER="geo-use1"
CIDR_SET_IDENTIFIER="cidr-office"
EXPECTED_CIDR_LOCATION="office"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  local destroy_rc=0
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # `state destroy` rejects `--force` (unknown option); the global
    # `--yes` auto-confirms. Only `aws s3 rm` the state key when destroy
    # exited 0 — a failed destroy must LEAVE state so AWS resources are
    # not orphaned (the next run / a human can retry against the state).
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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

# Resolve the hosted zone id from the deploy state's HostedZoneId output.
# Output values may carry a `/hostedzone/` prefix — strip it before passing
# to the CLI (`${ID##*/}` keeps only the trailing zone id segment).
ZONE_ID_RAW=$(echo "${STATE}" | jq -r '.outputs.HostedZoneId // empty')
if [ -z "${ZONE_ID_RAW}" ]; then
  echo "FAIL: no HostedZoneId output in state" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
ZONE_ID="${ZONE_ID_RAW##*/}"
echo "    Resolved hosted zone id: ${ZONE_ID}"

# --- Assertion: HostedZone NameServers remains list-valued through Fn::Join
# CloudFormation declares `AWS::Route53::HostedZone.NameServers` as a list.
# cdkd previously flattened the provider attribute into a comma-delimited
# string, so resolving this Output failed when Fn::Join received that string
# instead of the expected list and the Output was absent from state.
JOINED_NAME_SERVERS=$(echo "${STATE}" | jq -r '.outputs.HostedZoneNameServers // empty')
if [ -z "${JOINED_NAME_SERVERS}" ]; then
  echo "FAIL: no HostedZoneNameServers output in state (Fn::Join over NameServers did not resolve)" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi

JOINED_NAME_SERVERS_SORTED=$(printf '%s' "${JOINED_NAME_SERVERS}" \
  | jq -Rr 'split(",") | sort | join(",")')

# The live read is a POSITIVE probe (the zone must exist here), so it follows
# this file's header rule the same way the gone-probes do: capture combined
# output, branch on the exit status, and report the canonical not-found case
# separately from an undetermined failure (throttle / auth / network). The old
# `$(aws ... 2>/dev/null)` form aborted the whole script at the assignment
# under `set -euo pipefail` with the AWS error discarded, so an expired token
# and a deleted zone were indistinguishable -- and both looked like the
# NameServers assertion itself had blown up.
if ! LIVE_NAME_SERVERS=$(aws route53 get-hosted-zone --id "${ZONE_ID}" --region "${REGION}" \
  --query 'DelegationSet.NameServers' --output json 2>&1); then
  if printf '%s' "${LIVE_NAME_SERVERS}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "FAIL: hosted zone ${ZONE_ID} does not exist while asserting its NameServers" >&2
  else
    echo "FAIL: get-hosted-zone probe undetermined for ${ZONE_ID}" >&2
  fi
  echo "  aws said: ${LIVE_NAME_SERVERS}" >&2
  exit 1
fi
# An absent delegation set serializes as the JSON literal `null`, on which the
# `sort` below exits 5 -- a jq error where an assertion failure is meant.
if [ -z "${LIVE_NAME_SERVERS}" ] || [ "${LIVE_NAME_SERVERS}" = "null" ]; then
  echo "FAIL: hosted zone ${ZONE_ID} reports no DelegationSet.NameServers on AWS" >&2
  exit 1
fi
LIVE_NAME_SERVERS_SORTED=$(printf '%s' "${LIVE_NAME_SERVERS}" \
  | jq -r 'sort | join(",")')

# Both sides are SORTED deliberately, and the trade-off is recorded here
# because it is a judgement call (issue #1873): Route 53 does not guarantee
# that GetHostedZone returns the delegation set in the same order that
# CreateHostedZone did, and the two sides of this comparison come from those
# two different calls (the Output was resolved from the create-time attribute
# in state). An unsorted compare would therefore be flaky, and per the repo's
# "list readbacks must be order-insensitive" rule its failure message would
# accuse the very fix it is guarding.
#
# What sorting gives up is an order-SCRAMBLING regression inside cdkd. That
# half is fenced deterministically at the unit level instead -- the bare
# Fn::GetAtt assertions in tests/unit/deployment/intrinsic-functions.test.ts
# and tests/unit/deployment/deploy-engine-outputs-nameservers-list.test.ts pin
# the exact element ORDER the resolver produces from a fixed input, which a
# live AWS readback cannot do.
#
# Note what this comparison can NOT see either way, sorted or not: the
# pre-#1868 single-element collapse. The Output under test is already
# `Fn::Join`ed with ',', so `['a','b']` and `['a,b']` render the identical
# string and no post-join check can tell them apart (measured with a stubbed
# aws, 2026-08-14 -- it passes). Pre-#1868 that shape surfaced here only
# because Fn::Join THREW on a string operand and the Output went missing from
# state, which is what the `-z "${JOINED_NAME_SERVERS}"` guard above catches.
# The element COUNT itself is fenced by the same two unit tests.
if [ "${JOINED_NAME_SERVERS_SORTED}" != "${LIVE_NAME_SERVERS_SORTED}" ]; then
  echo "FAIL: HostedZoneNameServers output does not match Route 53" >&2
  # Print the SORTED form on both lines -- printing the raw output against a
  # sorted expectation made the two lines differ even on a spurious mismatch.
  echo "  got:      ${JOINED_NAME_SERVERS_SORTED}" >&2
  echo "  expected: ${LIVE_NAME_SERVERS_SORTED}" >&2
  echo "  (raw output value: ${JOINED_NAME_SERVERS})" >&2
  exit 1
fi
echo "    OK: Fn::Join resolved the HostedZone NameServers list (${JOINED_NAME_SERVERS})"

# --- Assertion: the BARE Fn::GetAtt Output round-trips as a real LIST -------
# Issue #1873. This is the arm the joined Output above structurally cannot
# provide: `Fn::Join` with ',' renders `['a','b']` and `['a,b']` identically,
# so a single-element collapse survives every post-join comparison. cdkd
# resolves Outputs itself and stores the resolved value verbatim
# (`resolveOutputs` -> `state.outputs`, typed `Record<string, unknown>`), so
# the bare Fn::GetAtt persists a JSON ARRAY and the element COUNT and members
# become directly observable.
NS_LIST_TYPE=$(echo "${STATE}" | jq -r '.outputs.HostedZoneNameServersList | type')
if [ "${NS_LIST_TYPE}" != "array" ]; then
  echo "FAIL: HostedZoneNameServersList is '${NS_LIST_TYPE}', expected 'array'" >&2
  echo "  a bare Fn::GetAtt over a list-valued attribute must persist a JSON array" >&2
  echo "${STATE}" | jq '.outputs.HostedZoneNameServersList'
  exit 1
fi

# Count first, and compare it to the LIVE count rather than to a literal: the
# delegation-set size is AWS's to choose, so a hardcoded 4 would be a fixture
# assumption rather than a measurement. This is the check that catches the
# pre-#1868 collapse -- one element holding the whole comma-joined string.
NS_LIST_COUNT=$(echo "${STATE}" | jq -r '.outputs.HostedZoneNameServersList | length')
LIVE_NAME_SERVERS_COUNT=$(printf '%s' "${LIVE_NAME_SERVERS}" | jq -r 'length')
if [ "${NS_LIST_COUNT}" != "${LIVE_NAME_SERVERS_COUNT}" ]; then
  echo "FAIL: HostedZoneNameServersList has ${NS_LIST_COUNT} element(s), Route 53 reports ${LIVE_NAME_SERVERS_COUNT}" >&2
  echo "  (1 element vs several is the pre-#1868 comma-string collapse)" >&2
  echo "${STATE}" | jq '.outputs.HostedZoneNameServersList'
  exit 1
fi

# Then the members. Sorted for the same reason as the joined assertion above
# (AWS does not guarantee a stable delegation-set order across calls); the
# count check above is what the sort cannot give us.
NS_LIST_SORTED=$(echo "${STATE}" | jq -r '.outputs.HostedZoneNameServersList | sort | join(",")')
if [ "${NS_LIST_SORTED}" != "${LIVE_NAME_SERVERS_SORTED}" ]; then
  echo "FAIL: HostedZoneNameServersList members do not match Route 53" >&2
  echo "  got:      ${NS_LIST_SORTED}" >&2
  echo "  expected: ${LIVE_NAME_SERVERS_SORTED}" >&2
  exit 1
fi
echo "    OK: bare Fn::GetAtt persisted a ${NS_LIST_COUNT}-element LIST matching the live delegation set (#1873)"

# --- Assertion: Ref to a RecordSet is the record NAME (issue #1681) ----
# cdkd stores the composite physicalId `<hostedZoneId>|<name>|<type>`, while
# CloudFormation's `Ref` returns "the name of the record" — the MIDDLE
# segment, which neither the after-LAST-pipe nor the before-FIRST-pipe
# extraction yields. Pre-fix this output carried the whole composite.
#
# Asserted on the RESOLVED OUTPUT VALUE, not on the state record: the state
# record legitimately holds the composite, so reading it would pass either
# way. The output is what a real consumer receives.
CIDR_REF=$(echo "${STATE}" | jq -r '.outputs.CidrRecordRef // empty')
EXPECTED_CIDR_NAME="cidr.cdkd-test-${ACCOUNT_ID}.internal"
if [ -z "${CIDR_REF}" ]; then
  echo "FAIL: no CidrRecordRef output in state" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
case "${CIDR_REF}" in
  *'|'*)
    echo "FAIL: issue #1681 NOT closed — Ref to the RecordSet resolved to the composite" >&2
    echo "  got:      ${CIDR_REF}" >&2
    echo "  expected: ${EXPECTED_CIDR_NAME} (the MIDDLE segment)" >&2
    exit 1
    ;;
esac
# AWS stores the record name with a trailing dot; the template declares it
# without one. Accept either, and REFUSE anything else — a lax `*cidr*` match
# would also pass on the composite this assertion exists to reject.
if [ "${CIDR_REF}" != "${EXPECTED_CIDR_NAME}" ] &&
   [ "${CIDR_REF}" != "${EXPECTED_CIDR_NAME}." ]; then
  echo "FAIL: Ref to the RecordSet is not the record name" >&2
  echo "  got:      ${CIDR_REF}" >&2
  echo "  expected: ${EXPECTED_CIDR_NAME} (with or without a trailing dot)" >&2
  exit 1
fi
echo "    OK: Ref to the RecordSet resolved to the record name (${CIDR_REF})"

# --- Assertion: GeoProximityLocation reached AWS ----------------------
# list-resource-record-sets returns every record; find the geoproximity
# record by Name prefix `geo.` AND SetIdentifier, then assert its
# GeoProximityLocation.AWSRegion. Seeing the templated value proves the
# silent-drop is closed by the #609 backfill.
RECORDS=$(aws route53 list-resource-record-sets \
  --hosted-zone-id "${ZONE_ID}" --region "${REGION}" \
  --output json 2>/dev/null)

ACTUAL_GEO_REGION=$(echo "${RECORDS}" | jq -r \
  --arg sid "${SET_IDENTIFIER}" \
  '.ResourceRecordSets[]
     | select((.Name | startswith("geo.")) and (.SetIdentifier == $sid))
     | .GeoProximityLocation.AWSRegion // "null"')

if [ "${ACTUAL_GEO_REGION}" != "${EXPECTED_GEO_REGION}" ]; then
  echo "FAIL: GeoProximityLocation.AWSRegion is '${ACTUAL_GEO_REGION}', expected '${EXPECTED_GEO_REGION}' (silent-drop NOT closed)" >&2
  echo "${RECORDS}" | jq '.ResourceRecordSets[] | select(.SetIdentifier == "'"${SET_IDENTIFIER}"'")'
  exit 1
fi
echo "    OK: GeoProximityLocation.AWSRegion == ${EXPECTED_GEO_REGION} on AWS (silent-drop CLOSED by #609)"

# --- Assertion: CidrRoutingConfig reached AWS -------------------------
# Find the CIDR-routing record by Name prefix `cidr.` AND SetIdentifier, then
# assert its CidrRoutingConfig.CollectionId is non-empty AND LocationName ==
# the templated value. Seeing both proves the silent-drop is closed (this is
# the LAST silent-dropped prop on AWS::Route53::RecordSet — type now complete).
CIDR_RECORD=$(echo "${RECORDS}" | jq -c \
  --arg sid "${CIDR_SET_IDENTIFIER}" \
  '.ResourceRecordSets[]
     | select((.Name | startswith("cidr.")) and (.SetIdentifier == $sid))')

if [ -z "${CIDR_RECORD}" ]; then
  echo "FAIL: no CIDR-routing record (Name 'cidr.*', SetIdentifier '${CIDR_SET_IDENTIFIER}') found on AWS" >&2
  echo "${RECORDS}" | jq '.ResourceRecordSets[] | {Name, SetIdentifier}'
  exit 1
fi

ACTUAL_CIDR_COLLECTION=$(echo "${CIDR_RECORD}" | jq -r '.CidrRoutingConfig.CollectionId // ""')
ACTUAL_CIDR_LOCATION=$(echo "${CIDR_RECORD}" | jq -r '.CidrRoutingConfig.LocationName // "null"')

if [ -z "${ACTUAL_CIDR_COLLECTION}" ]; then
  echo "FAIL: CidrRoutingConfig.CollectionId is empty on AWS (silent-drop NOT closed)" >&2
  echo "${CIDR_RECORD}" | jq '.'
  exit 1
fi
if [ "${ACTUAL_CIDR_LOCATION}" != "${EXPECTED_CIDR_LOCATION}" ]; then
  echo "FAIL: CidrRoutingConfig.LocationName is '${ACTUAL_CIDR_LOCATION}', expected '${EXPECTED_CIDR_LOCATION}' (silent-drop NOT closed)" >&2
  echo "${CIDR_RECORD}" | jq '.'
  exit 1
fi
echo "    OK: CidrRoutingConfig reached AWS (CollectionId='${ACTUAL_CIDR_COLLECTION}', LocationName='${ACTUAL_CIDR_LOCATION}') — silent-drop CLOSED by #609"

# --- Assertion: HostedZoneFeatures.AcceleratedRecoveryStatus reached AWS
# The fixture's `addPropertyOverride('HostedZoneFeatures.AcceleratedRecoveryStatus', 'ENABLED')`
# is wired through the post-create UpdateHostedZoneFeatures control-plane
# call. GetHostedZone surfaces it under `HostedZone.Features.AcceleratedRecoveryStatus`.
# AcceleratedRecovery enabling is an ASYNC AWS-side state transition — the
# field reports `ENABLING` immediately after UpdateHostedZoneFeatures
# returns success and only eventually settles to `ENABLED`. Accepting both
# proves the wire reached AWS and the atomicity guard (DeleteHostedZone on
# UHF failure) didn't trip; the final-state poll is out of scope (would
# add ~minutes to integ time for no extra correctness signal — cdkd's
# job is the wire-up, not waiting for AWS-side eventual consistency).
ACCEL_RECOVERY=$(aws route53 get-hosted-zone --id "${ZONE_ID}" --region "${REGION}" \
  --query 'HostedZone.Features.AcceleratedRecoveryStatus' --output text 2>/dev/null)

case "${ACCEL_RECOVERY}" in
  ENABLED|ENABLING) ;;
  *)
    echo "FAIL: HostedZone.Features.AcceleratedRecoveryStatus is '${ACCEL_RECOVERY}', expected 'ENABLED' or 'ENABLING' (silent-drop NOT closed)" >&2
    aws route53 get-hosted-zone --id "${ZONE_ID}" --region "${REGION}" | jq '.HostedZone'
    exit 1
    ;;
esac
echo "    OK: HostedZone.Features.AcceleratedRecoveryStatus == '${ACCEL_RECOVERY}' on AWS (silent-drop CLOSED by #609)"

# --- Assertion: the baseline tags + query logging config are live -----
# Both are the BASELINE half of the #1160 route53 removal checks below. Asserting
# them here means a phase-3 "it's gone" result cannot be vacuously true because
# the value never reached AWS in the first place.
BASELINE_TAGS=$(aws route53 list-tags-for-resource \
  --resource-type hostedzone --resource-id "${ZONE_ID}" --region "${REGION}" \
  --query 'ResourceTagSet.Tags[].Key' --output json 2>/dev/null)

for expected_key in Keep Dropped; do
  if ! echo "${BASELINE_TAGS}" | jq -e --arg k "${expected_key}" 'index($k)' >/dev/null; then
    echo "FAIL: baseline hosted-zone tag '${expected_key}' is not on AWS" >&2
    echo "${BASELINE_TAGS}" | jq '.'
    exit 1
  fi
done
echo "    OK: baseline hosted-zone tags Keep + Dropped are live"

BASELINE_QLC=$(aws route53 list-query-logging-configs \
  --hosted-zone-id "${ZONE_ID}" --region "${REGION}" \
  --query 'length(QueryLoggingConfigs)' --output text 2>/dev/null)
if [ "${BASELINE_QLC}" != "1" ]; then
  echo "FAIL: expected exactly 1 baseline query logging config, got '${BASELINE_QLC}'" >&2
  aws route53 list-query-logging-configs --hosted-zone-id "${ZONE_ID}" --region "${REGION}" | jq '.'
  exit 1
fi
echo "    OK: baseline query logging config is live"

# --- Phase 2: REMOVAL redeploy (#1160 route53 batch) ------------------
# Drops the `Dropped` hosted-zone tag and the whole QueryLoggingConfig block.
# Pre-fix, BOTH survived the redeploy: applyHostedZoneTags only ever sent
# AddTags (no untag diff), and applyQueryLoggingConfig returned early on an
# absent block so the live config kept writing to CloudWatch — and kept
# billing — with `cdkd diff` reporting no changes. Real CloudFormation removes
# both (live A/B, 2026-08-10).
echo "==> Phase 2: REMOVAL redeploy (drop the Dropped tag + QueryLoggingConfig)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

REMOVAL_TAGS=$(aws route53 list-tags-for-resource \
  --resource-type hostedzone --resource-id "${ZONE_ID}" --region "${REGION}" \
  --query 'ResourceTagSet.Tags[].Key' --output json 2>/dev/null)

if echo "${REMOVAL_TAGS}" | jq -e 'index("Dropped")' >/dev/null; then
  echo "FAIL: hosted-zone tag 'Dropped' survived its removal from the template (no untag diff)" >&2
  echo "${REMOVAL_TAGS}" | jq '.'
  exit 1
fi
# The kept tag must still be there — an untag diff that clears everything is
# just as wrong as one that clears nothing. Assert its VALUE, not just its
# presence: a reset that clobbers the value would pass a key-only check.
KEPT_VALUE=$(aws route53 list-tags-for-resource \
  --resource-type hostedzone --resource-id "${ZONE_ID}" --region "${REGION}" \
  --query 'ResourceTagSet.Tags[?Key==`Keep`].Value | [0]' --output text)
if [ "${KEPT_VALUE}" != "yes" ]; then
  echo "FAIL: hosted-zone tag 'Keep' is '${KEPT_VALUE}', expected 'yes' (removed or clobbered)" >&2
  echo "${REMOVAL_TAGS}" | jq '.'
  exit 1
fi
echo "    OK: 'Dropped' untagged and 'Keep' retained (#1160 HostedZoneTags removal reset)"

REMOVAL_QLC=$(aws route53 list-query-logging-configs \
  --hosted-zone-id "${ZONE_ID}" --region "${REGION}" \
  --query 'length(QueryLoggingConfigs)' --output text 2>/dev/null)
if [ "${REMOVAL_QLC}" != "0" ]; then
  echo "FAIL: query logging config survived its removal from the template (got ${REMOVAL_QLC}, expected 0)" >&2
  aws route53 list-query-logging-configs --hosted-zone-id "${ZONE_ID}" --region "${REGION}" | jq '.'
  exit 1
fi
echo "    OK: query logging config deleted (#1160 QueryLoggingConfig removal reset)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# The hosted zone delete only succeeds once every non-default (non-NS/SOA)
# record is gone — cdkd's destroy DAG handles that order. Route53 record /
# zone deletes are effectively synchronous, so a single get-hosted-zone is
# enough to confirm the zone is gone.
assert_gone "hosted zone ${ZONE_ID} still exists after destroy" aws route53 get-hosted-zone --id "${ZONE_ID}" --region "${REGION}"
echo "    OK: hosted zone is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# The query-logging log group is a template resource with RemovalPolicy.DESTROY,
# so destroy must take it too — a surviving log group is an orphan the run
# would otherwise leave behind (and it re-collides on the next run's create).
# Scope the probe to THIS run's exact log-group name. The bare
# `/aws/route53/cdkd-test-` prefix is account-wide, so a concurrent run in the
# same account would false-fail this check.
LEFTOVER_LG=$(aws logs describe-log-groups --region "${REGION}" \
  --log-group-name-prefix "/aws/route53/cdkd-test-${ACCOUNT_ID}.internal" \
  --query 'length(logGroups)' --output text 2>/dev/null)
if [ "${LEFTOVER_LG}" != "0" ]; then
  echo "FAIL: ${LEFTOVER_LG} query-logging log group(s) left behind after destroy" >&2
  aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "/aws/route53/cdkd-test-${ACCOUNT_ID}.internal" | jq '.logGroups[].logGroupName'
  exit 1
fi
echo "    OK: query-logging log group is gone"

echo ""
echo "==> route53 test passed (HostedZoneFeatures + GeoProximityLocation + CidrRoutingConfig backfills closed + #1160 HostedZoneTags / QueryLoggingConfig removal resets + clean destroy)"
