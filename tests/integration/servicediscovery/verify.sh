#!/usr/bin/env bash
# verify.sh — cdkd AWS Cloud Map (ServiceDiscovery) property-coverage backfill
# integ test (issue #609).
#
# Asserts that the #609 backfill of
# AWS::ServiceDiscovery::Service.ServiceAttributes actually reaches AWS on
# deploy: ServiceAttributes ({team: cdkd, tier: backend}) is applied via the
# post-create UpdateServiceAttributes control-plane call and is readable back
# via GetServiceAttributes. Then three issue #1160 removal phases that follow
# the CloudFormation A/Bs: a removal on its own, beside an unchanged declared
# Description, or beside a DnsRecords-only change is KEPT, a Description removed beside a HealthCheckConfig change is
# CLEARED, and a DnsConfig removed beside a Description change is REFUSED by
# AWS. Then destroys and confirms a clean teardown.
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

STACK="ServiceDiscoveryStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

SERVICE_NAME="cdkd-svcdisc-service"
TTL_NAME="cdkd-svcdisc-ttl"
HC_NAME="cdkd-svcdisc-hc"
REFUSED_NAME="cdkd-svcdisc-refused"
DNS_KEPT_NAME="cdkd-svcdisc-dns-kept"
HC_KEPT_NAME="cdkd-svcdisc-hc-kept"
PUBLIC_NS_NAME="cdkd-svcdisc-hc.cdkd-integ-test.com"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Phase 4's deploy log, left behind when a run fails before it is removed.
  [ -n "${P4_LOG_DIR:-}" ] && rm -rf "${P4_LOG_DIR}"
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

# service_id <name> -> the Cloud Map service id, or "None".
service_id() {
  aws servicediscovery list-services --region "${REGION}" \
    --query "Services[?Name=='$1'].Id | [0]" --output text
}
# service_field <id> <jmespath> -> one field of GetService, "None" when absent.
service_field() {
  aws servicediscovery get-service --id "$1" --region "${REGION}" \
    --query "Service.$2" --output text
}

# require_id <name> -> the service id; FAILs when the name is not found.
require_id() {
  local id
  id=$(service_id "$1")
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    echo "FAIL: could not resolve Cloud Map service id for name $1" >&2
    exit 1
  fi
  printf '%s' "${id}"
}
# deploy_phase <CDKD_TEST_REMOVAL value> -> runs the deploy; returns its rc.
deploy_phase() {
  CDKD_TEST_REMOVAL="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --yes
}
# expect_field <id> <jmespath> <expected> <failure message>
expect_field() {
  local got
  got=$(service_field "$1" "$2")
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $4 (issue #1160): $1 $2='${got}', expected '$3'" >&2
    exit 1
  fi
}
# expect_same_id <name> <id>: the service was updated in place, not replaced.
expect_same_id() {
  if [ "$(service_id "$1")" != "$2" ]; then
    echo "FAIL: $1 was replaced (must update in place)" >&2
    exit 1
  fi
}

TTL_ID=$(require_id "${TTL_NAME}")
HC_ID=$(require_id "${HC_NAME}")
REFUSED_ID=$(require_id "${REFUSED_NAME}")
DNS_KEPT_ID=$(require_id "${DNS_KEPT_NAME}")
HC_KEPT_ID=$(require_id "${HC_KEPT_NAME}")
expect_field "${SERVICE_ID}" Description cdkd-svcdisc-kept-description "phase 1 baseline"
expect_field "${TTL_ID}" Description cdkd-svcdisc-ttl-description "phase 1 baseline"
expect_field "${TTL_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "phase 1 baseline"
expect_field "${HC_ID}" Description cdkd-svcdisc-hc-description "phase 1 baseline"
expect_field "${HC_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
expect_field "${DNS_KEPT_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "phase 1 baseline"
expect_field "${HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
echo "    OK: phase 1 baseline (Descriptions, TTL 90, HealthCheckConfig threshold 3 on AWS)"

# The removal phases follow the CloudFormation A/Bs on #1160
# (issuecomment-6272137682, issuecomment-6281592365): UpdateService replaces
# its body, CloudFormation sends it only when a declared Description /
# HealthCheckConfig changed, and sends the declared model as it is.

# --- Phase 2 (kept): removals CloudFormation keeps (issue #1160) -------
echo "==> Phase 2: drop ${SERVICE_NAME}'s Description on its own; ${DNS_KEPT_NAME}'s DnsConfig and ${HC_KEPT_NAME}'s HealthCheckConfig beside an unchanged Description; ${TTL_NAME}'s Description beside a TTL change"
if ! deploy_phase kept; then
  echo "FAIL: the phase 2 deploy failed (issue #1160): a removal beside an unchanged declared Description must send no UpdateService (a DnsConfig-less one is refused), as CloudFormation sends none" >&2
  exit 1
fi
expect_same_id "${SERVICE_NAME}" "${SERVICE_ID}"
expect_same_id "${TTL_NAME}" "${TTL_ID}"
expect_same_id "${DNS_KEPT_NAME}" "${DNS_KEPT_ID}"
expect_same_id "${HC_KEPT_NAME}" "${HC_KEPT_ID}"
expect_field "${DNS_KEPT_ID}" "DnsConfig.DnsRecords[0].TTL" 90 \
  "a DnsConfig removed beside an unchanged Description was not kept, as CloudFormation keeps it"
expect_field "${HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 \
  "a HealthCheckConfig removed beside an unchanged Description was not kept, as CloudFormation keeps it"
expect_field "${SERVICE_ID}" Description cdkd-svcdisc-kept-description \
  "a Description removed on its own was not kept, as CloudFormation keeps it"
expect_field "${TTL_ID}" Description cdkd-svcdisc-ttl-description \
  "a Description removed beside a DnsRecords-only change was not kept, as CloudFormation keeps it"
# CloudFormation drops a DnsRecords-only change; cdkd applies it (deliberate).
expect_field "${TTL_ID}" "DnsConfig.DnsRecords[0].TTL" 150 \
  "a DnsRecords TTL change was not applied"
echo "    OK: removed Descriptions, DnsConfig and HealthCheckConfig kept; TTL 90 -> 150 applied (issue #1160)"

# --- Phase 3 (combined): a removal beside a sent change (issue #1160) --
echo "==> Phase 3: drop ${HC_NAME}'s Description beside a HealthCheckConfig change"
if ! deploy_phase combined; then
  echo "FAIL: the phase 3 deploy failed (issue #1160)" >&2
  exit 1
fi
expect_same_id "${HC_NAME}" "${HC_ID}"
expect_field "${HC_ID}" HealthCheckConfig.FailureThreshold 2 "a HealthCheckConfig change was not applied"
# A cleared Description is absent from GetService ("None" in text output);
# an empty string would print as "" — both mean cleared.
P3_HC_DESC=$(service_field "${HC_ID}" Description)
if [ "${P3_HC_DESC}" != "None" ] && [ -n "${P3_HC_DESC}" ]; then
  echo "FAIL: a Description removed beside a HealthCheckConfig change was not cleared, as CloudFormation clears it (issue #1160): ${HC_ID} Description='${P3_HC_DESC}', expected it cleared" >&2
  exit 1
fi
echo "    OK: Description cleared beside the HealthCheckConfig change (issue #1160)"

# --- Phase 4 (refused): DnsConfig removed beside a Description change ---
# CloudFormation's update fails here with AWS's own refusal; cdkd must too.
echo "==> Phase 4: drop ${REFUSED_NAME}'s DnsConfig beside a Description change (expected refusal)"
# Read by cleanup() too, which removes it on an early exit.
P4_LOG_DIR="$(mktemp -d -t cdkd-svcdisc-p4.XXXXXX)"
P4_LOG="${P4_LOG_DIR}/deploy.log"
P4_RC=0
deploy_phase refused > "${P4_LOG}" 2>&1 || P4_RC=$?
cat "${P4_LOG}"
if [ "${P4_RC}" -eq 0 ]; then
  echo "FAIL: a DnsConfig removed beside a Description change was accepted (issue #1160): CloudFormation's update is refused with 'Service dns config cannot be null'" >&2
  exit 1
fi
if ! grep -qF "Service dns config cannot be null" "${P4_LOG}"; then
  echo "FAIL: the phase 4 deploy failed, but not with AWS's 'Service dns config cannot be null' refusal (issue #1160)" >&2
  exit 1
fi
rm -f "${P4_LOG}"
rmdir "${P4_LOG_DIR}"
P4_LOG_DIR=""
expect_same_id "${REFUSED_NAME}" "${REFUSED_ID}"
expect_field "${REFUSED_ID}" Description cdkd-svcdisc-refused "the refused update changed the service"
expect_field "${REFUSED_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "the refused update changed the service"
echo "    OK: DnsConfig removal beside a Description change refused by AWS, service unchanged (issue #1160)"

# --- Phase 5: destroy -------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Cloud Map service deletion is synchronous; re-query once in case the
# list index lags briefly.
for name in "${SERVICE_NAME}" "${TTL_NAME}" "${HC_NAME}" "${REFUSED_NAME}" "${DNS_KEPT_NAME}" "${HC_KEPT_NAME}"; do
  STILL=$(service_id "${name}")
  if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
    sleep 5 2>/dev/null || true
    STILL=$(service_id "${name}")
  fi
  if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
    echo "FAIL: Cloud Map service ${name} (${STILL}) still exists after destroy" >&2
    exit 1
  fi
done
echo "    OK: every Cloud Map service is gone"
STILL_NS=$(aws servicediscovery list-namespaces --region "${REGION}" \
  --query "Namespaces[?Name=='${PUBLIC_NS_NAME}'].Id | [0]" --output text)
if [ -n "${STILL_NS}" ] && [ "${STILL_NS}" != "None" ]; then
  echo "FAIL: public namespace ${PUBLIC_NS_NAME} (${STILL_NS}) still exists after destroy" >&2
  exit 1
fi
echo "    OK: public namespace ${PUBLIC_NS_NAME} is gone"
# Cloud Map deletes the namespace's Route 53 hosted zone with it; a leftover
# zone is a billed orphan.
STILL_ZONE=$(aws route53 list-hosted-zones-by-name --dns-name "${PUBLIC_NS_NAME}." \
  --max-items 1 --query "HostedZones[?Name=='${PUBLIC_NS_NAME}.'].Id | [0]" --output text)
if [ -n "${STILL_ZONE}" ] && [ "${STILL_ZONE}" != "None" ]; then
  echo "FAIL: hosted zone ${PUBLIC_NS_NAME} (${STILL_ZONE}) still exists after destroy" >&2
  exit 1
fi
echo "    OK: hosted zone ${PUBLIC_NS_NAME} is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> servicediscovery test passed (ServiceDiscovery::Service ServiceAttributes property-coverage backfill closed + #1160 removal phases follow CloudFormation + clean destroy)"
