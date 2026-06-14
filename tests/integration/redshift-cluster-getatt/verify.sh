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
cd "$(dirname "$0")"

STACK="CdkdRedshiftClusterExample"
REGION="${AWS_REGION:-us-east-1}"
ADDR_PARAM="/cdkd-integ/redshift-cluster/endpoint-address"
PORT_PARAM="/cdkd-integ/redshift-cluster/endpoint-port"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"
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
trap cleanup EXIT INT TERM

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
  --query 'Parameter.Value' --output text 2>/dev/null || true)
PORT=$(aws ssm get-parameter --name "${PORT_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
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
if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file still exists after destroy" >&2; exit 1
fi
if aws ssm get-parameter --name "${ADDR_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${ADDR_PARAM} still exists after destroy" >&2; exit 1
fi
CL_LEFT=$(aws redshift describe-clusters --region "${REGION}" \
  --query "Clusters[?DBName=='cdkddb' && contains(ClusterIdentifier, 'cdkdredshift')] | length(@)" \
  --output text 2>/dev/null || echo 0)
if [ "${CL_LEFT}" != "0" ]; then
  echo "FAIL: ${CL_LEFT} Redshift cluster(s) still exist after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + SSM params + cluster all gone)"

echo ""
echo "==> redshift-cluster-getatt test passed: GetAtt Endpoint resolved to the real endpoint, clean destroy 0 orphans"
trap - EXIT
