#!/usr/bin/env bash
# verify.sh — cdkd Cloud Map HttpNamespace / PublicDnsNamespace SDK provider
# integ test (issue #1044).
#
# Both types are ProvisioningType: NON_PROVISIONABLE, so this fixture proves
# the SDK provider's async operation-based create (OperationId -> GetOperation
# polling -> Targets.NAMESPACE) and delete paths work end to end. The
# PublicDnsNamespace creates a public Route 53 hosted zone alongside the
# namespace — verify.sh captures its HostedZoneId after deploy and asserts
# the zone is GONE after destroy (zero orphans, including the hosted zone).
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
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="ServiceDiscoveryNamespacesStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

HTTP_NS_NAME="cdkd-integ-http-ns"
PUBLIC_NS_NAME="cdkd-integ-ns.cdkd-integ-test.com"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

lookup_ns_id() {
  # $1 = namespace name -> prints the namespace Id or "None"
  aws servicediscovery list-namespaces --region "${REGION}" \
    --query "Namespaces[?Name=='$1'].Id | [0]" --output text
}

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

# --- Assertion: both namespaces exist on AWS --------------------------
HTTP_NS_ID=$(lookup_ns_id "${HTTP_NS_NAME}")
if [ -z "${HTTP_NS_ID}" ] || [ "${HTTP_NS_ID}" = "None" ]; then
  echo "FAIL: HttpNamespace ${HTTP_NS_NAME} not found after deploy" >&2
  exit 1
fi
echo "    resolved HttpNamespace id: ${HTTP_NS_ID}"

PUBLIC_NS_ID=$(lookup_ns_id "${PUBLIC_NS_NAME}")
if [ -z "${PUBLIC_NS_ID}" ] || [ "${PUBLIC_NS_ID}" = "None" ]; then
  echo "FAIL: PublicDnsNamespace ${PUBLIC_NS_NAME} not found after deploy" >&2
  exit 1
fi
echo "    resolved PublicDnsNamespace id: ${PUBLIC_NS_ID}"

# --- Assertion: HTTP namespace type ----------------------------------
HTTP_NS_TYPE=$(aws servicediscovery get-namespace --id "${HTTP_NS_ID}" \
  --region "${REGION}" --query 'Namespace.Type' --output text)
if [ "${HTTP_NS_TYPE}" != "HTTP" ]; then
  echo "FAIL: expected namespace type HTTP for ${HTTP_NS_ID}, got '${HTTP_NS_TYPE}'" >&2
  exit 1
fi
echo "    OK: HttpNamespace type is HTTP"

# --- Assertion: public namespace created a Route 53 hosted zone -------
HOSTED_ZONE_ID=$(aws servicediscovery get-namespace --id "${PUBLIC_NS_ID}" \
  --region "${REGION}" \
  --query 'Namespace.Properties.DnsProperties.HostedZoneId' --output text)
if [ -z "${HOSTED_ZONE_ID}" ] || [ "${HOSTED_ZONE_ID}" = "None" ]; then
  echo "FAIL: PublicDnsNamespace ${PUBLIC_NS_ID} has no HostedZoneId" >&2
  exit 1
fi
if ! aws route53 get-hosted-zone --id "${HOSTED_ZONE_ID}" >/dev/null 2>&1; then
  echo "FAIL: Route 53 hosted zone ${HOSTED_ZONE_ID} not found after deploy" >&2
  exit 1
fi
echo "    OK: public hosted zone ${HOSTED_ZONE_ID} exists"

# --- Assertion: SOA TTL passthrough ----------------------------------
SOA_TTL=$(aws servicediscovery get-namespace --id "${PUBLIC_NS_ID}" \
  --region "${REGION}" \
  --query 'Namespace.Properties.DnsProperties.SOA.TTL' --output text)
if [ "${SOA_TTL}" != "90" ]; then
  echo "FAIL: expected SOA TTL 90 on ${PUBLIC_NS_ID}, got '${SOA_TTL}'" >&2
  exit 1
fi
echo "    OK: SOA TTL 90 reached AWS (Properties passthrough)"

# --- Assertion: HostedZoneId attribute resolved in stack outputs ------
OUTPUT_HZ=$(echo "${STATE}" | jq -r '.outputs.PublicDnsNamespaceHostedZoneId // empty')
if [ "${OUTPUT_HZ}" != "${HOSTED_ZONE_ID}" ]; then
  echo "FAIL: stack output PublicDnsNamespaceHostedZoneId is '${OUTPUT_HZ}', expected '${HOSTED_ZONE_ID}'" >&2
  exit 1
fi
echo "    OK: HostedZoneId attribute surfaced through Fn::GetAtt -> stack output"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# Namespace deletion is operation-based; the provider polls to completion
# before returning, so a single re-query with one retry is enough.
for NAME in "${HTTP_NS_NAME}" "${PUBLIC_NS_NAME}"; do
  STILL=$(lookup_ns_id "${NAME}")
  if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
    sleep 5 2>/dev/null || true
    STILL=$(lookup_ns_id "${NAME}")
  fi
  if [ -n "${STILL}" ] && [ "${STILL}" != "None" ]; then
    echo "FAIL: Cloud Map namespace ${NAME} (${STILL}) still exists after destroy" >&2
    exit 1
  fi
done
echo "    OK: both namespaces are gone"

# --- Assertion: the hosted zone was deleted with the namespace --------
assert_gone "Route 53 hosted zone ${HOSTED_ZONE_ID} still exists after destroy (orphan!)" aws route53 get-hosted-zone --id "${HOSTED_ZONE_ID}"
echo "    OK: hosted zone ${HOSTED_ZONE_ID} is gone (no Route 53 orphan)"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> servicediscovery-namespaces test passed (HttpNamespace + PublicDnsNamespace SDK providers: async operation-based create/delete + hosted-zone cleanup verified)"
