#!/usr/bin/env bash
# verify.sh — AWS::ElastiCache::ReplicationGroup CC-API GetAtt endpoint
# enrichment (failure-seeking).
#
# ElastiCache ReplicationGroup has NO SDK provider, so it always routes through
# Cloud Control. Pre-fix, `Fn::GetAtt(<RG>, 'PrimaryEndPoint.Address')` fell
# through the intrinsic resolver's constructAttribute to the physicalId (the
# replication-group id) instead of the real Redis hostname. This fixture stores
# that GetAtt into an SSM Parameter and asserts the stored value is the real
# `*.cache.amazonaws.com` endpoint, NOT the RG id.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CdkdElastiCacheRgExample"
REGION="${AWS_REGION:-us-east-1}"
ADDR_PARAM="/cdkd-integ/elasticache-rg/primary-endpoint-address"
PORT_PARAM="/cdkd-integ/elasticache-rg/primary-endpoint-port"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t ecrg-deploy.XXXXXX)"

# AWS DescribeReplicationGroups + describe-parameters can throttle right after a
# burst; let the CLI back off transparently for the assertion + cleanup calls.
export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${ADDR_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PORT_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  rm -f "${DEPLOY_LOG}" 2>/dev/null || true
  set -e
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || pnpm install --ignore-workspace --prefer-offline

echo "==> Pre-flight orphan scan"
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state already exists at ${STATE_KEY} — clean up first." >&2
  exit 1
fi
aws ssm delete-parameter --name "${ADDR_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
aws ssm delete-parameter --name "${PORT_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true

echo "==> Step 1: deploy (ElastiCache ReplicationGroup via Cloud Control)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2 (LOAD-BEARING): assert GetAtt PrimaryEndPoint.Address resolved to the REAL Redis hostname"
ADDR=$(aws ssm get-parameter --name "${ADDR_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
PORT=$(aws ssm get-parameter --name "${PORT_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
echo "    PrimaryEndPoint.Address = '${ADDR}'  PrimaryEndPoint.Port = '${PORT}'"

# The RG id (physicalId) is the lowercased logical id; a physicalId-fallback bug
# would store something WITHOUT the '.cache.amazonaws.com' suffix. Asserting the
# real hostname shape definitively proves enrichment ran (the RG id can never
# contain that suffix).
case "${ADDR}" in
  *.cache.amazonaws.com)
    echo "    OK: PrimaryEndPoint.Address is a real ElastiCache endpoint hostname"
    ;;
  *)
    echo "FAIL: PrimaryEndPoint.Address is '${ADDR}', not a *.cache.amazonaws.com endpoint." >&2
    echo "      This is the CC-API physicalId-fallback bug (GetAtt returned the RG id)." >&2
    exit 1
    ;;
esac
case "${PORT}" in
  ''|*[!0-9]*)
    echo "FAIL: PrimaryEndPoint.Port is '${PORT}', expected a numeric port (e.g. 6379)." >&2
    exit 1
    ;;
  *)
    echo "    OK: PrimaryEndPoint.Port is numeric (${PORT})"
    ;;
esac

echo "==> Step 3: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 4: assert 0 orphans"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "SSM parameter ${ADDR_PARAM} still exists after destroy" aws ssm get-parameter --name "${ADDR_PARAM}" --region "${REGION}"
RG_LEFT=$(aws elasticache describe-replication-groups --region "${REGION}" \
  --query "ReplicationGroups[?contains(Description, 'cdkd elasticache-rg getatt fixture')] | length(@)" \
  --output text)
if [ "${RG_LEFT}" != "0" ]; then
  echo "FAIL: ${RG_LEFT} ElastiCache ReplicationGroup(s) still exist after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + SSM params + ReplicationGroup all gone)"

echo ""
echo "==> elasticache-replicationgroup-getatt test passed: GetAtt PrimaryEndPoint resolved to the real endpoint, clean destroy 0 orphans"
trap - EXIT INT TERM
