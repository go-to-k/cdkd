#!/usr/bin/env bash
# verify.sh — AWS::Redshift::Cluster CC-API GetAtt endpoint enrichment
# (failure-seeking).
#
# Redshift Cluster has NO SDK provider → always CC-routed. Pre-fix,
# Fn::GetAtt(<Cluster>, 'Endpoint.Address') fell through the resolver's
# constructAttribute to the physicalId (the cluster id) instead of the real
# *.redshift.amazonaws.com endpoint. This fixture stores that GetAtt into an
# SSM Parameter and asserts the stored value is the real endpoint, not the id.
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

STACK="CdkdRedshiftClusterExample"
REGION="${AWS_REGION:-us-east-1}"
ADDR_PARAM="/cdkd-integ/redshift-cluster/endpoint-address"
PORT_PARAM="/cdkd-integ/redshift-cluster/endpoint-port"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
DEPLOY_LOG="$(mktemp -t rsc-deploy.XXXXXX)"

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

echo "==> Step 1: deploy (Redshift Cluster via Cloud Control)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  # Surface the actual CREATE-failure reason first — a verbose rollback can
  # push it out of a plain `tail`, forcing a manual diagnostic re-deploy.
  echo "--- CREATE failure reason(s) ---" >&2
  grep -iE "Failed to create|CREATE failed for|Invalid|ValidationException|not valid|not authorized|exceeded|quota" "${DEPLOY_LOG}" >&2 || true
  echo "--- deploy log tail ---" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

echo "==> Step 2 (LOAD-BEARING): assert GetAtt Endpoint.Address resolved to the REAL Redshift endpoint"
ADDR=$(aws ssm get-parameter --name "${ADDR_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
PORT=$(aws ssm get-parameter --name "${PORT_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
echo "    Endpoint.Address = '${ADDR}'  Endpoint.Port = '${PORT}'"
case "${ADDR}" in
  *.redshift.amazonaws.com)
    echo "    OK: Endpoint.Address is a real Redshift endpoint hostname"
    ;;
  *)
    echo "FAIL: Endpoint.Address is '${ADDR}', not a *.redshift.amazonaws.com endpoint." >&2
    echo "      This is the CC-API physicalId-fallback bug (GetAtt returned the cluster id)." >&2
    exit 1
    ;;
esac
case "${PORT}" in
  ''|*[!0-9]*)
    echo "FAIL: Endpoint.Port is '${PORT}', expected a numeric port (e.g. 5439)." >&2
    exit 1
    ;;
  *)
    echo "    OK: Endpoint.Port is numeric (${PORT})"
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
CL_LEFT=$(aws redshift describe-clusters --region "${REGION}" \
  --query "Clusters[?DBName=='cdkddb' && contains(ClusterIdentifier, 'cdkdredshift')] | length(@)" \
  --output text)
if [ "${CL_LEFT}" != "0" ]; then
  echo "FAIL: ${CL_LEFT} Redshift cluster(s) still exist after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + SSM params + cluster all gone)"

echo ""
echo "==> redshift-cluster-getatt test passed: GetAtt Endpoint resolved to the real endpoint, clean destroy 0 orphans"
trap - EXIT INT TERM
