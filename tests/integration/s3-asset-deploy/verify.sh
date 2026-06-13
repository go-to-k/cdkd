#!/usr/bin/env bash
# verify.sh - cdkd s3-asset-deploy integ.
#
# Exercises cdkd's asset-publishing layer (FileAssetPublisher) during a real
# `cdkd deploy`:
#   - A Lambda whose code comes from a LOCAL multi-file directory asset is
#     zipped + uploaded to the CDK bootstrap asset bucket; the function's
#     Code S3 ref is wired to the uploaded object.
#   - A generic s3_assets.Asset is uploaded to the same bucket and read back
#     by the Lambda at runtime via cdkd-resolved CONFIG_BUCKET/CONFIG_KEY env.
#
# Asserts:
#   1. deploy creates the Lambda from the uploaded asset (CodeSize > 0, i.e.
#      NOT inline) and the function runs.
#   2. invoking the Lambda returns the handler marker (proving the uploaded
#      ZIP is the running code) AND the generic asset was downloaded
#      (configBytes > 0, proving the s3_assets.Asset upload reached AWS and
#      the bucket/key env vars were wired correctly).
#   3. destroy removes the Lambda + state file with 0 errors. Bootstrap-bucket
#      asset OBJECTS persist by design (CDK bootstrap bucket is shared infra
#      cdkd never deletes) — the script does NOT fail on residual objects.
#
# BSD/macOS-portable (no `grep -P`, no `date -d`). Captures the real rc and
# prints an explicit `[verify] PASS` only on success.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdS3AssetDeployExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

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

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
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

# --- Resolve the AssetHandler function name from state (CDK auto-names it) --
FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | select(.key | startswith("AssetHandler")) | .value.physicalId] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve AssetHandler Lambda function name from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved AssetHandler function name: ${FN_NAME}"

# --- Assertion: the function code came from the uploaded ZIP (NOT inline) ---
# An asset-backed function has a non-trivial CodeSize and a CodeSha256; an
# inline single-liner would be only a few dozen bytes. We assert CodeSize is
# comfortably above an inline threshold.
CODE_SIZE=$(aws lambda get-function-configuration \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --query 'CodeSize' --output text 2>/dev/null)
if [ -z "${CODE_SIZE}" ] || [ "${CODE_SIZE}" = "None" ]; then
  echo "FAIL: could not read CodeSize for ${FN_NAME}" >&2
  exit 1
fi
# 500 bytes is well above any inline one-liner but below our multi-file ZIP.
if [ "${CODE_SIZE}" -le 500 ]; then
  echo "FAIL: Lambda CodeSize is ${CODE_SIZE} bytes (<=500) - expected an uploaded multi-file asset ZIP, not inline code" >&2
  exit 1
fi
echo "    OK: Lambda CodeSize == ${CODE_SIZE} bytes (uploaded asset ZIP, not inline)"

# --- Assertion: invoke the Lambda - the uploaded ZIP is the running code,
#     and the generic s3_assets.Asset was downloaded at runtime ---------------
OUT_FILE="$(mktemp)"
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT
aws lambda invoke \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{"ping":"cdkd"}' \
  "${OUT_FILE}" >/dev/null 2>&1

# The function returns an API-Gateway-style envelope: { statusCode, body }
# where body is a JSON string. Parse the body and assert the marker + config.
BODY=$(jq -r '.body // empty' "${OUT_FILE}")
if [ -z "${BODY}" ]; then
  echo "FAIL: Lambda invoke returned no body. Raw response:" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi

MARKER=$(echo "${BODY}" | jq -r '.marker // empty')
if [ "${MARKER}" != "cdkd-s3-asset-deploy-marker-v1" ]; then
  echo "FAIL: Lambda marker is '${MARKER}', expected 'cdkd-s3-asset-deploy-marker-v1' (the uploaded ZIP should be the running code)" >&2
  echo "${BODY}" | jq . >&2
  exit 1
fi
echo "    OK: Lambda invoke returned the asset marker (uploaded ZIP is the running code)"

CONFIG_ERROR=$(echo "${BODY}" | jq -r '.configError // empty')
if [ -n "${CONFIG_ERROR}" ] && [ "${CONFIG_ERROR}" != "null" ]; then
  echo "FAIL: Lambda could not read the generic s3_assets.Asset: ${CONFIG_ERROR}" >&2
  exit 1
fi

CONFIG_BYTES=$(echo "${BODY}" | jq -r '.config.configBytes // 0')
if [ -z "${CONFIG_BYTES}" ] || [ "${CONFIG_BYTES}" -le 0 ]; then
  echo "FAIL: generic asset download returned configBytes=${CONFIG_BYTES} (expected > 0)" >&2
  echo "${BODY}" | jq . >&2
  exit 1
fi
echo "    OK: generic s3_assets.Asset downloaded at runtime (configBytes=${CONFIG_BYTES}) - upload reached AWS + bucket/key env wired"

# --- Phase 2: destroy -----------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

if aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: Lambda function ${FN_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: Lambda function is gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

# NOTE: the bootstrap asset bucket objects (the uploaded ZIPs) are NOT cleaned
# by cdkd destroy - the CDK bootstrap bucket is shared infrastructure cdkd does
# not own. This is by design; we deliberately do NOT assert their absence.
echo "    NOTE: bootstrap-bucket asset objects persist by design (cdkd does not delete the CDK bootstrap bucket)"

echo ""
echo "==> s3-asset-deploy test passed (file/ZIP asset upload + Lambda runs from it + generic asset read-back + clean destroy)"
echo "[verify] PASS"
