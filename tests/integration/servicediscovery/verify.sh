#!/usr/bin/env bash
# verify.sh — cdkd AWS Cloud Map (ServiceDiscovery) property-coverage backfill
# integ test (issue #609).
#
# Asserts that the #609 backfill of
# AWS::ServiceDiscovery::Service.ServiceAttributes actually reaches AWS on
# deploy: ServiceAttributes ({team: cdkd, tier: backend}) is applied via the
# post-create UpdateServiceAttributes control-plane call and is readable back
# via GetServiceAttributes. Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="ServiceDiscoveryStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

SERVICE_NAME="cdkd-svcdisc-service"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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

# --- Resolve the Cloud Map service id by name -------------------------
SERVICE_ID=$(aws servicediscovery list-services --region "${REGION}" \
  --query "Services[?Name=='${SERVICE_NAME}'].Id | [0]" --output text)
if [ -z "${SERVICE_ID}" ] || [ "${SERVICE_ID}" = "None" ]; then
  echo "FAIL: could not resolve Cloud Map service id for name ${SERVICE_NAME}" >&2
  exit 1
fi
echo "    resolved service id: ${SERVICE_ID}"

# --- Assertion: ServiceAttributes reached AWS -------------------------
ATTRS=$(aws servicediscovery get-service-attributes --service-id "${SERVICE_ID}" \
  --region "${REGION}")
TEAM=$(echo "${ATTRS}" | jq -r '.ServiceAttributes.Attributes.team // empty')
TIER=$(echo "${ATTRS}" | jq -r '.ServiceAttributes.Attributes.tier // empty')
if [ "${TEAM}" != "cdkd" ]; then
  echo "FAIL: ServiceAttributes.team is '${TEAM}', expected 'cdkd'" >&2
  echo "      raw GetServiceAttributes: ${ATTRS}" >&2
  exit 1
fi
if [ "${TIER}" != "backend" ]; then
  echo "FAIL: ServiceAttributes.tier is '${TIER}', expected 'backend'" >&2
  echo "      raw GetServiceAttributes: ${ATTRS}" >&2
  exit 1
fi
echo "    OK: ServiceAttributes {team: cdkd, tier: backend} reached AWS (ServiceAttributes backfill CLOSED)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Cloud Map service deletion is synchronous; re-query once in case the
# list index lags briefly.
STILL=$(aws servicediscovery list-services --region "${REGION}" \
  --query "Services[?Name=='${SERVICE_NAME}'].Id | [0]" --output text)
if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
  sleep 5 2>/dev/null || true
  STILL=$(aws servicediscovery list-services --region "${REGION}" \
    --query "Services[?Name=='${SERVICE_NAME}'].Id | [0]" --output text)
fi
if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
  echo "FAIL: Cloud Map service ${SERVICE_NAME} (${STILL}) still exists after destroy" >&2
  exit 1
fi
echo "    OK: Cloud Map service is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> servicediscovery test passed (ServiceDiscovery::Service ServiceAttributes property-coverage backfill closed + clean destroy)"
