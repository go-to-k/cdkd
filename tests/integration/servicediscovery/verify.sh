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
# Description, or beside a DnsRecords-only change is KEPT; a Description
# removed beside a HealthCheckConfig change is CLEARED; and a DnsConfig removed
# beside a Description change is REFUSED by AWS. A service declaring no Name is
# created under a generated name that every redeploy keeps (go-to-k/cdkd#5348).
# A DnsConfig.NamespaceId / RoutingPolicy change, which CloudFormation leaves
# unapplied, is left unapplied too and named in a warning (go-to-k/cdkd#5373).
# Then destroys and confirms a clean teardown.
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
# go-to-k/cdkd#5112: SecretHcKeptService reads a secret, so every state object
# version under the stack's prefix is swept (versioning keeps prior versions).
# shellcheck source=../s3-versions.sh
. ../s3-versions.sh
PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

SERVICE_NAME="cdkd-svcdisc-service"
TTL_NAME="cdkd-svcdisc-ttl"
HC_NAME="cdkd-svcdisc-hc"
REFUSED_NAME="cdkd-svcdisc-refused"
DNS_KEPT_NAME="cdkd-svcdisc-dns-kept"
HC_KEPT_NAME="cdkd-svcdisc-hc-kept"
SECRET_HC_KEPT_NAME="cdkd-svcdisc-secret-hc-kept"
NOECHO_HC_KEPT_NAME="cdkd-svcdisc-noecho-hc-kept"
DESC_SECRET_NAME="cdkd-svcdisc-desc-secret"
PUBLIC_NS_NAME="cdkd-svcdisc-hc.cdkd-integ-test.com"
PINNED_NAME="cdkd-svcdisc-pinned-dns"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Phase 4's deploy log, left behind when a run fails before it is removed.
  [ -n "${P4_LOG_DIR:-}" ] && rm -rf "${P4_LOG_DIR}"
  [ -n "${P1_LOG:-}" ] && rm -f "${P1_LOG}"
  [ -n "${P2_LOG:-}" ] && rm -f "${P2_LOG}"
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
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PREFIX}" noncurrent || true
  fi
  aws secretsmanager delete-secret --region "${REGION}" --secret-id "${DESC_SECRET_NAME}" \
    --force-delete-without-recovery >/dev/null 2>&1
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
# go-to-k/cdkd#5348: NamelessService declares no Name. Before the fix the
# provider refused its create, failing this deploy; name that refusal instead
# of leaving only the deploy's exit code.
P1_LOG="$(mktemp -t cdkd-svcdisc-p1.XXXXXX)"
P1_RC=0
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1 | tee "${P1_LOG}" || P1_RC=$?
if [ "${P1_RC}" != "0" ]; then
  if grep -qF 'Name is required for ServiceDiscovery Service' "${P1_LOG}"; then
    echo "FAIL: the nameless Cloud Map service's create was refused (go-to-k/cdkd#5348 NOT closed)" >&2
  else
    echo "FAIL: Phase 1 deploy exited ${P1_RC}" >&2
  fi
  exit 1
fi
rm -f "${P1_LOG}"
P1_LOG=""

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
# expect_field <id> <jmespath> <expected> <failure message> [issue]
expect_field() {
  local got
  got=$(service_field "$1" "$2")
  if [ "${got}" != "$3" ]; then
    echo "FAIL: $4 (${5:-issue #1160}): $1 $2='${got}', expected '$3'" >&2
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
SECRET_HC_KEPT_ID=$(require_id "${SECRET_HC_KEPT_NAME}")
NOECHO_HC_KEPT_ID=$(require_id "${NOECHO_HC_KEPT_NAME}")
PINNED_ID=$(require_id "${PINNED_NAME}")
expect_field "${SERVICE_ID}" Description cdkd-svcdisc-kept-description "phase 1 baseline"
expect_field "${TTL_ID}" Description cdkd-svcdisc-ttl-description "phase 1 baseline"
expect_field "${TTL_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "phase 1 baseline"
expect_field "${HC_ID}" Description cdkd-svcdisc-hc-description "phase 1 baseline"
expect_field "${HC_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
expect_field "${DNS_KEPT_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "phase 1 baseline"
expect_field "${HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
expect_field "${SECRET_HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
# go-to-k/cdkd#5112: AWS holds the RESOLVED secret, and state its reference.
SECRET_DESC=$(service_field "${SECRET_HC_KEPT_ID}" Description)
if [ -z "${SECRET_DESC}" ] || [ "${SECRET_DESC}" = "None" ] || [[ "${SECRET_DESC}" == *"{{resolve:"* ]]; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): ${SECRET_HC_KEPT_NAME} Description is not the resolved secret value" >&2
  exit 1
fi
P1_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
# Anywhere in the record (properties, observedProperties, attributes), not
# only the Description: a redaction regression fails here. Value withheld.
if printf '%s' "${P1_STATE}" | grep -qF -- "${SECRET_DESC}"; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): state.json holds the resolved secret value (value withheld)" >&2
  exit 1
fi
RECORDED_DESC=$(printf '%s' "${P1_STATE}" | jq -r '.resources.SecretHcKeptService.properties.Description // empty')
# go-to-k/cdkd#5112: the NoEcho arm's premise -- AWS holds a value, state the mask.
expect_field "${NOECHO_HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 "phase 1 baseline"
NOECHO_RECORDED=$(printf '%s' "${P1_STATE}" | jq -r '.resources.NoEchoHcKeptService.properties.Description // empty')
if [ "${NOECHO_RECORDED}" != "***" ]; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): state does not record ${NOECHO_HC_KEPT_NAME}'s NoEcho Description as the mask, so phase 2 proves nothing" >&2
  exit 1
fi
NOECHO_DESC=$(service_field "${NOECHO_HC_KEPT_ID}" Description)
if [ -z "${NOECHO_DESC}" ] || [ "${NOECHO_DESC}" = "None" ]; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): ${NOECHO_HC_KEPT_NAME} has no Description on AWS" >&2
  exit 1
fi
if printf '%s' "${P1_STATE}" | grep -qF -- "${NOECHO_DESC}"; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): state.json holds the NoEcho Description (value withheld)" >&2
  exit 1
fi
if [[ "${RECORDED_DESC}" != "{{resolve:secretsmanager:"* ]]; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5112): state does not record ${SECRET_HC_KEPT_NAME}'s Description as its {{resolve:...}} reference, so phase 2 proves nothing" >&2
  exit 1
fi
# go-to-k/cdkd#5373 baseline: PinnedDnsService sits in the private namespace
# with MULTIVALUE routing.
PRIVATE_NS_ID=$(printf '%s' "${P1_STATE}" | jq -r '.outputs.NamespaceId // empty')
if [ -z "${PRIVATE_NS_ID}" ]; then
  echo "FAIL: phase 1 baseline (go-to-k/cdkd#5373): no NamespaceId output in state" >&2
  exit 1
fi
expect_field "${PINNED_ID}" NamespaceId "${PRIVATE_NS_ID}" "phase 1 baseline" go-to-k/cdkd#5373
expect_field "${PINNED_ID}" DnsConfig.RoutingPolicy MULTIVALUE "phase 1 baseline" go-to-k/cdkd#5373
echo "    OK: phase 1 baseline (Descriptions, TTL 90, HealthCheckConfig threshold 3 on AWS)"

# --- Assertion: a nameless service gets a generated name (go-to-k/cdkd#5348) ---
# cdkd generates `{stack}-{logicalId}-{suffix}`: one DNS label of at most 63
# characters. A fresh stack always carries an instance id, so the 12-hex
# suffix is required (a suffix-less legacy name here would be a regression).
NAMELESS_NAME=$(printf '%s' "${P1_STATE}" | jq -r '.outputs.NamelessServiceName // empty')
if ! printf '%s' "${NAMELESS_NAME}" | grep -qE '^ServiceDiscoveryStack-NamelessService-[0-9a-f]{12}$'; then
  echo "FAIL: the nameless Cloud Map service is named '${NAMELESS_NAME}', expected the generated ServiceDiscoveryStack-NamelessService-<12 hex> (go-to-k/cdkd#5348)" >&2
  exit 1
fi
NAMELESS_ID=$(require_id "${NAMELESS_NAME}")
# expect_nameless <phase>: the redeploy kept the generated name and the service.
expect_nameless() {
  local name
  name=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.outputs.NamelessServiceName // empty')
  if [ "${name}" != "${NAMELESS_NAME}" ]; then
    echo "FAIL: after $1, the nameless Cloud Map service is '${name}', expected '${NAMELESS_NAME}' (go-to-k/cdkd#5348)" >&2
    exit 1
  fi
  expect_same_id "${NAMELESS_NAME}" "${NAMELESS_ID}"
}
echo "    OK: nameless Cloud Map service created as '${NAMELESS_NAME}' (go-to-k/cdkd#5348)"

# The removal phases follow the CloudFormation A/Bs on #1160
# (issuecomment-6272137682, issuecomment-6281592365): UpdateService replaces
# its body, CloudFormation sends it only when a declared Description /
# HealthCheckConfig changed, and sends the declared model as it is.

# --- Phase 2 (kept): removals CloudFormation keeps (issue #1160) -------
echo "==> Phase 2: drop ${SERVICE_NAME}'s Description on its own; ${DNS_KEPT_NAME}'s DnsConfig and ${HC_KEPT_NAME}'s HealthCheckConfig beside an unchanged Description; ${TTL_NAME}'s Description beside a TTL change"
# Read by cleanup() too, which removes it on an early exit.
P2_LOG="$(mktemp -t cdkd-svcdisc-p2.XXXXXX)"
P2_RC=0
deploy_phase kept 2>&1 | tee "${P2_LOG}" || P2_RC=$?
if [ "${P2_RC}" != "0" ]; then
  echo "FAIL: the phase 2 deploy failed (issue #1160): a removal beside an unchanged declared Description must send no UpdateService (a DnsConfig-less one is refused), as CloudFormation sends none" >&2
  exit 1
fi
# go-to-k/cdkd#5373: PinnedDnsService's DnsConfig.NamespaceId and RoutingPolicy
# changed. CloudFormation completes the update without applying either and
# without replacing the service; cdkd must match that, and say so.
P2_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${P2_LOG}" | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${P2_FLAT}" | grep -qF "PinnedDnsService (AWS::ServiceDiscovery::Service): DnsConfig.NamespaceId and DnsConfig.RoutingPolicy changed, but Cloud Map cannot change them on an existing service"; then
  echo "FAIL: the phase 2 deploy did not warn that PinnedDnsService's DnsConfig.NamespaceId and RoutingPolicy changes were not applied (go-to-k/cdkd#5373)" >&2
  exit 1
fi
rm -f "${P2_LOG}"
P2_LOG=""
expect_same_id "${PINNED_NAME}" "${PINNED_ID}"
expect_field "${PINNED_ID}" NamespaceId "${PRIVATE_NS_ID}" \
  "a DnsConfig.NamespaceId change moved the service, where CloudFormation leaves it" go-to-k/cdkd#5373
expect_field "${PINNED_ID}" DnsConfig.RoutingPolicy MULTIVALUE \
  "a DnsConfig.RoutingPolicy change was applied, where CloudFormation leaves it" go-to-k/cdkd#5373
echo "    OK: DnsConfig.NamespaceId / RoutingPolicy changes left unapplied, as CloudFormation leaves them, and named in a warning (go-to-k/cdkd#5373)"
expect_same_id "${SERVICE_NAME}" "${SERVICE_ID}"
expect_same_id "${TTL_NAME}" "${TTL_ID}"
expect_same_id "${DNS_KEPT_NAME}" "${DNS_KEPT_ID}"
expect_same_id "${HC_KEPT_NAME}" "${HC_KEPT_ID}"
expect_same_id "${SECRET_HC_KEPT_NAME}" "${SECRET_HC_KEPT_ID}"
expect_same_id "${NOECHO_HC_KEPT_NAME}" "${NOECHO_HC_KEPT_ID}"
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
expect_field "${SECRET_HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 \
  "a HealthCheckConfig removed beside an unchanged secret-reference Description was cleared (go-to-k/cdkd#5112), where CloudFormation keeps it"
# Compared without printing: either side is the secret's plaintext.
if [ "$(service_field "${SECRET_HC_KEPT_ID}" Description)" != "${SECRET_DESC}" ]; then
  echo "FAIL: the unchanged secret-reference Description of ${SECRET_HC_KEPT_NAME} moved (go-to-k/cdkd#5112); values withheld" >&2
  exit 1
fi
echo "    OK: HealthCheckConfig kept beside an unchanged secret-reference Description (go-to-k/cdkd#5112)"
expect_field "${NOECHO_HC_KEPT_ID}" HealthCheckConfig.FailureThreshold 3 \
  "a HealthCheckConfig removed beside an unchanged NoEcho-parameter Description was cleared (go-to-k/cdkd#5112), where CloudFormation keeps it"
if [ "$(service_field "${NOECHO_HC_KEPT_ID}" Description)" != "${NOECHO_DESC}" ]; then
  echo "FAIL: the unchanged NoEcho-parameter Description of ${NOECHO_HC_KEPT_NAME} moved (go-to-k/cdkd#5112); values withheld" >&2
  exit 1
fi
echo "    OK: HealthCheckConfig kept beside an unchanged NoEcho-parameter Description (go-to-k/cdkd#5112)"
expect_nameless "phase 2"
echo "    OK: the nameless service kept its generated name across phase 2 (go-to-k/cdkd#5348)"

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
expect_nameless "phase 3"

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
# AWS's own text ('Service dns config cannot be null') reaches only the debug
# log since go-to-k/cdkd#2319: the thrown (and persisted) message names the
# error class plus the verbose-mode pointer, so the refusal is read by its
# class here, and its text must not be in the default-verbosity output.
P4_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${P4_LOG}" | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${P4_FLAT}" | grep -qE "Failed to update service discovery service RefusedService: InvalidInput\. Re-run with [-][-]verbose for AWS's own message\."; then
  echo "FAIL: the phase 4 deploy failed, but not with AWS's InvalidInput refusal of the update, named by its class (issue #1160, go-to-k/cdkd#2319)" >&2
  exit 1
fi
if grep -qF "Service dns config cannot be null" "${P4_LOG}"; then
  echo "FAIL: AWS's refusal text reached the default-verbosity output; the thrown message must name its class only (go-to-k/cdkd#2319)" >&2
  exit 1
fi
rm -f "${P4_LOG}"
rmdir "${P4_LOG_DIR}"
P4_LOG_DIR=""
expect_same_id "${REFUSED_NAME}" "${REFUSED_ID}"
expect_field "${REFUSED_ID}" Description cdkd-svcdisc-refused "the refused update changed the service"
expect_field "${REFUSED_ID}" "DnsConfig.DnsRecords[0].TTL" 90 "the refused update changed the service"
echo "    OK: DnsConfig removal beside a Description change refused by AWS, service unchanged (issue #1160)"
expect_nameless "phase 4"
echo "    OK: the nameless service kept its generated name through phases 3 and 4, the refused one included (go-to-k/cdkd#5348)"

# --- Phase 5: destroy -------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Cloud Map service deletion is synchronous; re-query once in case the
# list index lags briefly.
for name in "${SERVICE_NAME}" "${TTL_NAME}" "${HC_NAME}" "${REFUSED_NAME}" "${DNS_KEPT_NAME}" "${HC_KEPT_NAME}" "${SECRET_HC_KEPT_NAME}" "${NOECHO_HC_KEPT_NAME}" "${NAMELESS_NAME}" "${PINNED_NAME}"; do
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
# Force-deleted by cdkd; DescribeSecret can lag the delete briefly. Every probe
# still goes through gone_probe, so a throttle or auth error hard-fails.
SECRET_GONE=0
for _ in $(seq 1 12); do
  if gone_probe aws secretsmanager describe-secret --secret-id "${DESC_SECRET_NAME}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" != "1" ]; then
  echo "FAIL: secret ${DESC_SECRET_NAME} still exists 60s after destroy" >&2
  exit 1
fi
echo "    OK: secret ${DESC_SECRET_NAME} is gone"
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

trap - EXIT INT TERM
echo "==> Sweep every object version under the stack's state prefix (go-to-k/cdkd#5112)"
# On the SUCCESS path, after the disarm: a sweep living only in `cleanup` never
# runs here, and `noncurrent` would leave the delete marker behind.
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"

echo ""
echo "==> servicediscovery test passed (ServiceDiscovery::Service ServiceAttributes property-coverage backfill closed + #1160 removal phases follow CloudFormation + #5348 generated name + #5373 unapplied DnsConfig members + clean destroy)"
