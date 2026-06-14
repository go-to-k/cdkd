#!/usr/bin/env bash
# verify.sh — AWS::OpenSearchService::Domain CC-API GetAtt endpoint enrichment
# (failure-seeking).
#
# OpenSearch Domain has NO SDK provider → always CC-routed. Pre-fix,
# Fn::GetAtt(<Domain>, 'DomainEndpoint') / 'Arn' fell through the resolver's
# constructAttribute to the physicalId (the domain NAME) instead of the real
# *.es.amazonaws.com endpoint / arn:aws:es:... ARN. This fixture stores those
# GetAtts into SSM Parameters and asserts the stored values are the real
# endpoint / ARN, not the domain name.
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.
# NOTE: OpenSearch domain create + delete are SLOW (~15-20 min each).

set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdOpenSearchDomainExample"
REGION="${AWS_REGION:-us-east-1}"
ENDPOINT_PARAM="/cdkd-integ/opensearch-domain/endpoint"
ARN_PARAM="/cdkd-integ/opensearch-domain/arn"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"
DEPLOY_LOG="$(mktemp -t osd-deploy.XXXXXX)"

export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +e
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${ENDPOINT_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${ARN_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
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
aws ssm delete-parameter --name "${ENDPOINT_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
aws ssm delete-parameter --name "${ARN_PARAM}" --region "${REGION}" >/dev/null 2>&1 || true

echo "==> Step 1: deploy (OpenSearch Domain via Cloud Control — SLOW, ~15-20 min)"
set +e
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --verbose > "${DEPLOY_LOG}" 2>&1
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

echo "==> Step 2 (LOAD-BEARING): assert GetAtt DomainEndpoint / Arn resolved to the REAL values"
ENDPOINT=$(aws ssm get-parameter --name "${ENDPOINT_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
ARN=$(aws ssm get-parameter --name "${ARN_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text 2>/dev/null || true)
echo "    DomainEndpoint = '${ENDPOINT}'  Arn = '${ARN}'"
case "${ENDPOINT}" in
  *.es.amazonaws.com)
    echo "    OK: DomainEndpoint is a real OpenSearch endpoint hostname"
    ;;
  *)
    echo "FAIL: DomainEndpoint is '${ENDPOINT}', not a *.es.amazonaws.com endpoint." >&2
    echo "      This is the CC-API physicalId-fallback bug (GetAtt returned the domain name)." >&2
    exit 1
    ;;
esac
case "${ARN}" in
  arn:aws:es:*:domain/*)
    echo "    OK: Arn is a real OpenSearch domain ARN"
    ;;
  *)
    echo "FAIL: Arn is '${ARN}', expected arn:aws:es:...:domain/..." >&2
    exit 1
    ;;
esac

echo "==> Step 3: destroy (SLOW, ~15-20 min)"
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
if aws ssm get-parameter --name "${ENDPOINT_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: SSM parameter ${ENDPOINT_PARAM} still exists after destroy" >&2; exit 1
fi
DOM_LEFT=$(aws opensearch list-domain-names --region "${REGION}" \
  --query "DomainNames[?contains(DomainName, 'cdkd-opensearch')] | length(@)" \
  --output text 2>/dev/null || echo 0)
if [ "${DOM_LEFT}" != "0" ]; then
  echo "FAIL: ${DOM_LEFT} OpenSearch domain(s) still exist after destroy (orphan)" >&2
  exit 1
fi
echo "    OK: 0 orphans (state + SSM params + domain all gone)"

echo ""
echo "==> opensearch-domain-getatt test passed: GetAtt DomainEndpoint/Arn resolved to the real values, clean destroy 0 orphans"
trap - EXIT
