#!/usr/bin/env bash
# verify.sh -- an old stage on another API whose delete fails stays tracked
# in supersededResources (issue #7088).
#
# A stage moved to another REST API is replaced, and its new copy carries the
# same physical id (`prod`). When the old stage's delete failed, the deploy's
# save read the new record as the old copy's holder ("same id, same type"),
# dropped the superseded entry, and left the old stage in AWS untracked,
# although the warning said cdkd kept it.
# Phases:
#   1. deploy v1: APIs A and B, the stage `prod` on A;
#   2. an out-of-band base path mapping (a regional custom domain on a
#      self-signed certificate imported into ACM) uses A's `prod`, so API
#      Gateway refuses its delete; deploy v2 moves the stage to B: state keeps
#      the old stage (RestApiId A) in supersededResources (THE ARM; pre-fix:
#      empty, the old stage untracked);
#   3. the mapping is deleted; deploy v2 again: the kept old stage is deleted
#      and its entry dropped;
#   4. destroy: no API, stage, domain, certificate or state file left.
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdSupersededStageEqualIdExample"
REGION="${AWS_REGION:-us-east-1}"
# Per run: the cleanup sweeps only this run's APIs and domain, never a peer run's.
RUN_ID="$(date +%s)-$$"
export CDKD_INTEG_RUN_ID="${RUN_ID}"
API_PREFIX="cdkd-integ-superseded-stage-${RUN_ID}-"
DOMAIN="superseded-stage-${RUN_ID}.cdkd-integ.example.com"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CERT_DIR="$(mktemp -d)"
unset CDKD_TEST_UPDATE

# This fixture's certificates, by domain (one normally; a crashed run may leave more).
fixture_certs() { # usage: fixture_certs -- ARNs, one per line, or a hard failure
  aws acm list-certificates --region "${REGION}" \
    --query "CertificateSummaryList[?DomainName=='${DOMAIN}'].CertificateArn" --output text | tr '\t' '\n' | awk 'NF'
}
fixture_apis() { # usage: fixture_apis -- REST API ids, one per line, or a hard failure
  aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?starts_with(name, '${API_PREFIX}')].id" --output text | tr '\t' '\n' | awk 'NF'
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  aws apigateway delete-base-path-mapping --domain-name "${DOMAIN}" --base-path v1 --region "${REGION}" >/dev/null 2>&1
  aws apigateway delete-domain-name --domain-name "${DOMAIN}" --region "${REGION}" >/dev/null 2>&1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for api in $(fixture_apis 2>/dev/null); do
    aws apigateway delete-rest-api --rest-api-id "${api}" --region "${REGION}" >/dev/null 2>&1
  done
  # A just-deleted domain keeps the certificate "in use" for a little while.
  for cert in $(fixture_certs 2>/dev/null); do
    case "${cert}" in
      arn:aws:acm:*)
        for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
          aws acm delete-certificate --certificate-arn "${cert}" --region "${REGION}" >/dev/null 2>&1 && break
          sleep 10
        done ;;
    esac
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -rf "${CERT_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v openssl >/dev/null || { echo "FAIL: openssl is required (the self-signed certificate)" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 1; }
[ -d node_modules ] || npm install
# An earlier run that crashed left its own names behind; sweep those started
# over 2 hours ago (their names carry the start time), never a live peer run's.
sweep_stale_runs() {
  set +eu
  local cutoff=$(( $(date +%s) - 7200 )) name id started
  aws apigateway get-rest-apis --region "${REGION}" \
    --query "items[?starts_with(name, 'cdkd-integ-superseded-stage-')].[id,name]" --output text 2>/dev/null |
    while read -r id name; do
      started="${name#cdkd-integ-superseded-stage-}"; started="${started%%-*}"
      case "${started}" in ''|*[!0-9]*) continue ;; esac
      [ "${started}" -lt "${cutoff}" ] && aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1
    done
  aws apigateway get-domain-names --region "${REGION}" \
    --query "items[?starts_with(domainName, 'superseded-stage-')].domainName" --output text 2>/dev/null | tr '\t' '\n' |
    while read -r name; do
      case "${name}" in *.cdkd-integ.example.com) ;; *) continue ;; esac
      started="${name#superseded-stage-}"; started="${started%%-*}"
      case "${started}" in ''|*[!0-9]*) continue ;; esac
      [ "${started}" -lt "${cutoff}" ] || continue
      aws apigateway get-base-path-mappings --domain-name "${name}" --region "${REGION}" \
        --query 'items[].basePath' --output text 2>/dev/null | tr '\t' '\n' | awk 'NF' | while read -r bp; do
          aws apigateway delete-base-path-mapping --domain-name "${name}" --base-path "${bp}" --region "${REGION}" >/dev/null 2>&1
        done
      aws apigateway delete-domain-name --domain-name "${name}" --region "${REGION}" >/dev/null 2>&1
    done
  aws acm list-certificates --region "${REGION}" \
    --query "CertificateSummaryList[?starts_with(DomainName, 'superseded-stage-')].[CertificateArn,DomainName]" --output text 2>/dev/null |
    while read -r id name; do
      case "${name}" in *.cdkd-integ.example.com) ;; *) continue ;; esac
      started="${name#superseded-stage-}"; started="${started%%-*}"
      case "${started}" in ''|*[!0-9]*) continue ;; esac
      [ "${started}" -lt "${cutoff}" ] && aws acm delete-certificate --certificate-arn "${id}" --region "${REGION}" >/dev/null 2>&1
    done
  set -eu
}
echo "==> Pre-run cleanup"; sweep_stale_runs; cleanup
CERT_DIR="$(mktemp -d)"

state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}
deploy() { # usage: deploy <phase> <log file>
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "$2" || {
    echo "FAIL: $1: deploy failed" >&2
    return 1
  }
}
stage_live() { # usage: stage_live <api id> -- 0 when `prod` exists on it
  ! gone_probe aws apigateway get-stage --rest-api-id "$1" --stage-name prod --region "${REGION}"
}
DEPLOY_LOG="${CERT_DIR}/deploy.log"

echo "==> Phase 1: deploy v1 (the stage on API A)"
deploy "phase 1" "${DEPLOY_LOG}"
API_A="$(state_field '.resources.ApiA.physicalId // ""')"
API_B="$(state_field '.resources.ApiB.physicalId // ""')"
[ -n "${API_A}" ] && [ -n "${API_B}" ] || { echo "FAIL: phase 1: the APIs are not recorded ('${API_A}', '${API_B}')" >&2; exit 1; }
[ "$(state_field '.resources.Stage | [.physicalId, .properties.RestApiId] | join(" ")')" = "prod ${API_A}" ] || {
  echo "FAIL: phase 1 premise: the stage is not recorded as prod on ${API_A}" >&2; exit 1; }
echo "    OK: stage prod on ${API_A}"

echo "==> Phase 2: a base path mapping uses A's prod; deploy v2 moves the stage to B"
openssl req -x509 -newkey rsa:2048 -nodes -keyout "${CERT_DIR}/key.pem" -out "${CERT_DIR}/cert.pem" -days 2 \
  -subj "/CN=${DOMAIN}" -addext "subjectAltName=DNS:${DOMAIN}" >/dev/null 2>&1
CERT_ARN="$(aws acm import-certificate --region "${REGION}" \
  --certificate "fileb://${CERT_DIR}/cert.pem" --private-key "fileb://${CERT_DIR}/key.pem" \
  --query CertificateArn --output text)"
case "${CERT_ARN}" in arn:aws:acm:*) ;; *) echo "FAIL: phase 2 premise: no certificate imported ('${CERT_ARN}')" >&2; exit 1 ;; esac
aws apigateway create-domain-name --region "${REGION}" --domain-name "${DOMAIN}" \
  --regional-certificate-arn "${CERT_ARN}" --endpoint-configuration types=REGIONAL >/dev/null
aws apigateway create-base-path-mapping --region "${REGION}" --domain-name "${DOMAIN}" \
  --rest-api-id "${API_A}" --stage prod --base-path v1 >/dev/null
export CDKD_TEST_UPDATE=v2
deploy "phase 2" "${DEPLOY_LOG}"
[ "$(state_field '.resources.Stage | [.physicalId, .properties.RestApiId] | join(" ")')" = "prod ${API_B}" ] || {
  echo "FAIL: phase 2 premise: the stage was not moved to ${API_B}" >&2; exit 1; }
stage_live "${API_A}" || { echo "FAIL: phase 2 premise: the old stage on ${API_A} is gone (its delete was to fail on the mapping)" >&2; exit 1; }
# THE ARM: the old stage is still tracked.
KEPT="$(state_field "[(.supersededResources // [])[] | select(.logicalId == \"Stage\") | [.state.physicalId, .state.properties.RestApiId] | join(\" \")] | join(\",\")")"
[ "${KEPT}" = "prod ${API_A}" ] || {
  echo "FAIL: phase 2: supersededResources holds '${KEPT}', expected 'prod ${API_A}' (go-to-k/cdkd#7088: the new stage on another API was read as the old one's holder and the entry dropped)" >&2
  exit 1
}
echo "    OK: the old stage on ${API_A} is kept in supersededResources"

echo "==> Phase 3: the mapping is deleted; the next deploy deletes the kept old stage"
aws apigateway delete-base-path-mapping --region "${REGION}" --domain-name "${DOMAIN}" --base-path v1
deploy "phase 3" "${DEPLOY_LOG}"
assert_gone "phase 3: the old stage on ${API_A} still exists" \
  aws apigateway get-stage --rest-api-id "${API_A}" --stage-name prod --region "${REGION}"
stage_live "${API_B}" || { echo "FAIL: phase 3: the stage on ${API_B} is gone" >&2; exit 1; }
[ "$(state_field '(.supersededResources // []) | length')" = "0" ] || {
  echo "FAIL: phase 3: supersededResources is not empty after the old stage was deleted" >&2; exit 1; }
echo "    OK: the kept old stage was deleted and its entry dropped; the new one is live"

echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for api in "${API_A}" "${API_B}"; do
  assert_gone "API ${api} still exists after destroy" aws apigateway get-rest-api --rest-api-id "${api}" --region "${REGION}"
done
assert_gone "state file of ${STACK} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The out-of-band domain and certificate this run made.
aws apigateway delete-domain-name --domain-name "${DOMAIN}" --region "${REGION}"
assert_gone "domain ${DOMAIN} still exists" aws apigateway get-domain-name --domain-name "${DOMAIN}" --region "${REGION}"
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  aws acm delete-certificate --certificate-arn "${CERT_ARN}" --region "${REGION}" >/dev/null 2>&1 && break
  sleep 10
done
assert_gone "certificate ${CERT_ARN} still exists" aws acm describe-certificate --certificate-arn "${CERT_ARN}" --region "${REGION}"
echo "    OK: nothing left"

echo ""
echo "[verify] PASS — an old stage on another API whose delete fails stays tracked, and the next deploy deletes it"
