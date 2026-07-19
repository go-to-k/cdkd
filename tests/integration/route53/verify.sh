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
# Also asserts the destroy path cleans up (the hosted zone delete requires
# every non-default record gone first; the cdkd destroy DAG handles order).
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="Route53Stack"
REGION="${AWS_REGION:-us-east-1}"
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
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
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

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# The hosted zone delete only succeeds once every non-default (non-NS/SOA)
# record is gone — cdkd's destroy DAG handles that order. Route53 record /
# zone deletes are effectively synchronous, so a single get-hosted-zone is
# enough to confirm the zone is gone.
if aws route53 get-hosted-zone --id "${ZONE_ID}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: hosted zone ${ZONE_ID} still exists after destroy" >&2
  exit 1
fi
echo "    OK: hosted zone is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> route53 test passed (HostedZoneFeatures + GeoProximityLocation + CidrRoutingConfig backfills closed + clean destroy)"
