#!/usr/bin/env bash
# verify.sh - cdkd asset-migration integ (issue #1002 PR 2).
#
# End-to-end verification of the publish redirection + template rewrite that
# activate once a region is opted into cdkd-owned asset storage:
#
#   Phase 1: deploy WITHOUT a bootstrap marker -> legacy mode: assets land in
#            the CDK bootstrap bucket, state records cdk-hnb659fds-* names.
#   Phase 2: `cdkd bootstrap`, then `cdkd diff` -> the pending one-time
#            migration diff shows the cdkd-assets repointing (§7.1).
#   Phase 3: deploy -> assets publish to the cdkd bucket, every reference
#            repoints IN PLACE (parent Lambda Code, s3_assets env-var URL via
#            GetFunctionConfiguration, nested child Lambda Code), and the
#            function still invokes.
#   Phase 4: deploy --use-cdk-bootstrap-assets -> properties repoint BACK to
#            the CDK bucket (per-app opt-out honored); a normal deploy then
#            repoints to cdkd again (flip-flop is churn, never breakage §9).
#   Phase 5 (Docker daemon available): deploy the image stack -> the image
#            pushes to cdkd-container-assets-* and Lambda pulls it from there.
#   Phase 6: destroy everything, sweep log groups, delete marker + storage.
#
# SAFETY NOTE (issue #1052): this fixture opts the region into cdkd asset
# storage and DELETES the default-named storage on exit. A pre-run guard
# fails fast when the region already carries a cdkd bootstrap marker —
# that marker belongs to live storage (real assets may live there since
# #1002 PR 2) that this fixture must not delete; pick a marker-free region
# via AWS_REGION. The guard makes the EXIT-trap cleanup safe: any
# marker/bucket/repo present at exit was created by THIS run (assets are
# content-addressed and re-publishable, and no deployed stack survives the
# run). The pre-run cleanup pass only deletes stack-scoped leftovers.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="CdkdAssetMigrationStack"
IMAGE_STACK="CdkdAssetMigrationImageStack"
REGION="${AWS_REGION:-us-east-1}"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CDK_BUCKET="cdk-hnb659fds-assets-${ACCOUNT_ID}-${REGION}"
CDKD_BUCKET="cdkd-assets-${ACCOUNT_ID}-${REGION}"
CDKD_REPO="cdkd-container-assets-${ACCOUNT_ID}-${REGION}"

cleanup() {
  # $1 = "prerun" skips the asset-storage deletion: a marker/bucket/repo
  # that exists BEFORE this run is live storage we must not delete (the
  # marker guard below fails fast on it instead). Without the arg (EXIT
  # trap), asset storage is cleaned too — the guard guarantees anything
  # present at exit was created by this run (issue #1052).
  echo "==> Cleanup: dropping stacks${1:+ (stack-scoped only)}"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    for s in "${IMAGE_STACK}" "${STACK}"; do
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" events prune "${s}" --all --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${IMAGE_STACK}/" --recursive >/dev/null 2>&1 || true
    # Nested-child state keys (Parent~ChildLogicalId).
    aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "cdkd/${STACK}~" \
      --query 'Contents[].Key' --output text 2>/dev/null | tr '\t' '\n' | while read -r key; do
      [ -n "${key}" ] && aws s3 rm "s3://${STATE_BUCKET}/${key}" >/dev/null 2>&1
    done
  fi
  if [ "${1:-}" != "prerun" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
    fi
    # Storage created by THIS run — content-addressed, re-publishable.
    aws s3 rb "s3://${CDKD_BUCKET}" --force >/dev/null 2>&1 || true
    aws ecr delete-repository --repository-name "${CDKD_REPO}" \
      --region "${REGION}" --force >/dev/null 2>&1 || true
  fi
  # Functional invokes create /aws/lambda/* log groups — sweep them.
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/CdkdAssetMigration" \
    --region "${REGION}" --query 'logGroups[].logGroupName' --output text 2>/dev/null |
    tr '\t' '\n' | while read -r lg; do
      [ -n "${lg}" ] && aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
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

echo "==> Pre-run cleanup (stack-scoped only)"
cleanup prerun

# Own-marker guard (issue #1052): this fixture opts the region in and then
# deletes the default-named asset storage — never proceed over a
# pre-existing marker (it belongs to live storage).
if aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - >/dev/null 2>&1; then
  echo "FAIL: region ${REGION} already has a cdkd bootstrap marker (live asset storage)." >&2
  echo "      This fixture bootstraps AND deletes the region's default-named storage;" >&2
  echo "      run it in a CDK-bootstrapped region without a cdkd marker (via AWS_REGION)." >&2
  echo "      If this is a leftover from a previous crashed run of this fixture, clean it" >&2
  echo "      up first: node dist/cli.js bootstrap --destroy --region ${REGION} --yes" >&2
  exit 1
fi

GC_NOTICE="may garbage-collect"

# jq helper: unique Code.S3Bucket values of every Lambda in a state file.
lambda_code_buckets() { # $1 = state key
  aws s3 cp "s3://${STATE_BUCKET}/$1" - 2>/dev/null |
    jq -r '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .properties.Code.S3Bucket] | unique | .[]'
}

parent_state_key="cdkd/${STACK}/${REGION}/state.json"

child_state_key() {
  aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" --prefix "cdkd/${STACK}~" \
    --query "Contents[?ends_with(Key, '/${REGION}/state.json')].Key | [0]" --output text
}

handler_function_name() {
  aws s3 cp "s3://${STATE_BUCKET}/${parent_state_key}" - |
    jq -r '.resources | to_entries[]
      | select(.value.resourceType == "AWS::Lambda::Function")
      | select(.key | startswith("Handler"))
      | .value.physicalId'
}

# --- Phase 1: deploy WITHOUT marker (legacy destinations) -------------------
echo "==> Phase 1: deploy without marker (legacy: CDK bootstrap destinations)"
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3
echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}" ||
  { echo "FAIL: legacy-mode deploy did not print the gc-hazard notice" >&2; exit 1; }

BUCKETS=$(lambda_code_buckets "${parent_state_key}")
if [ "${BUCKETS}" != "${CDK_BUCKET}" ]; then
  echo "FAIL: phase 1 parent Lambda Code.S3Bucket is '${BUCKETS}', expected '${CDK_BUCKET}'" >&2
  exit 1
fi
CHILD_KEY=$(child_state_key)
if [ -z "${CHILD_KEY}" ] || [ "${CHILD_KEY}" = "None" ]; then
  echo "FAIL: nested child state file not found under cdkd/${STACK}~" >&2
  exit 1
fi
CHILD_BUCKETS=$(lambda_code_buckets "${CHILD_KEY}")
if [ "${CHILD_BUCKETS}" != "${CDK_BUCKET}" ]; then
  echo "FAIL: phase 1 child Lambda Code.S3Bucket is '${CHILD_BUCKETS}', expected '${CDK_BUCKET}'" >&2
  exit 1
fi
FN_NAME=$(handler_function_name)
ENV_URL=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
  --region "${REGION}" --query 'Environment.Variables.DATA_ASSET_URL' --output text)
case "${ENV_URL}" in
  *"${CDK_BUCKET}"*) : ;;
  *) echo "FAIL: phase 1 DATA_ASSET_URL is '${ENV_URL}', expected the CDK bucket" >&2; exit 1 ;;
esac
echo "    OK: legacy deploy — parent+child Code and env-var URL all on ${CDK_BUCKET}"

# --- Phase 2: bootstrap, then diff previews the repointing ------------------
echo "==> Phase 2: cdkd bootstrap + diff preview"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null

DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
if ! echo "${DIFF_OUT}" | grep -qF "${CDKD_BUCKET}"; then
  echo "FAIL: post-bootstrap diff does not preview the cdkd-assets repointing. Tail:" >&2
  echo "${DIFF_OUT}" | tail -10 >&2
  exit 1
fi
echo "    OK: diff shows the pending one-time migration to ${CDKD_BUCKET}"

# --- Phase 3: deploy (redirect + rewrite) ------------------------------------
echo "==> Phase 3: deploy with marker (publish redirection + template rewrite)"
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3
if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: cdkd-assets mode deploy still printed the legacy gc notice" >&2
  exit 1
fi

# `length(Contents || ...)` instead of `KeyCount`: KeyCount rendered as
# literal "None" through --output text on this CLI, silently no-op-ing the
# numeric comparison. Guard non-numeric output explicitly so a query
# regression fails loudly instead of passing vacuously.
OBJECT_COUNT=$(aws s3api list-objects-v2 --bucket "${CDKD_BUCKET}" \
  --query 'length(Contents || `[]`)' --output text)
case "${OBJECT_COUNT}" in
  '' | *[!0-9]*)
    echo "FAIL: could not count objects in ${CDKD_BUCKET} (got '${OBJECT_COUNT}')" >&2
    exit 1
    ;;
esac
if [ "${OBJECT_COUNT}" -lt 3 ]; then
  echo "FAIL: expected >=3 assets in ${CDKD_BUCKET} (2 lambda zips + data asset; CFn template assets are never published), got ${OBJECT_COUNT}" >&2
  exit 1
fi
BUCKETS=$(lambda_code_buckets "${parent_state_key}")
[ "${BUCKETS}" = "${CDKD_BUCKET}" ] ||
  { echo "FAIL: phase 3 parent Code.S3Bucket is '${BUCKETS}', expected '${CDKD_BUCKET}'" >&2; exit 1; }
CHILD_BUCKETS=$(lambda_code_buckets "$(child_state_key)")
[ "${CHILD_BUCKETS}" = "${CDKD_BUCKET}" ] ||
  { echo "FAIL: phase 3 child Code.S3Bucket is '${CHILD_BUCKETS}', expected '${CDKD_BUCKET}'" >&2; exit 1; }
ENV_URL=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
  --region "${REGION}" --query 'Environment.Variables.DATA_ASSET_URL' --output text)
case "${ENV_URL}" in
  *"${CDKD_BUCKET}"*) : ;;
  *) echo "FAIL: phase 3 DATA_ASSET_URL is '${ENV_URL}', expected the cdkd bucket" >&2; exit 1 ;;
esac
INVOKE_OUT=$(aws lambda invoke --function-name "${FN_NAME}" --region "${REGION}" \
  --payload '{}' /tmp/asset-migration-invoke.json --query 'StatusCode' --output text)
[ "${INVOKE_OUT}" = "200" ] ||
  { echo "FAIL: post-migration invoke returned ${INVOKE_OUT}" >&2; exit 1; }
echo "    OK: assets in ${CDKD_BUCKET}; parent+child Code + env-var URL repointed; invoke 200"

# --- Phase 3b: idempotency — a second diff shows no changes ------------------
echo "==> Phase 3b: diff after migration (expect no changes)"
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)
if ! echo "${DIFF_OUT}" | grep -q "No changes detected"; then
  echo "FAIL: post-migration diff is not clean. Tail:" >&2
  echo "${DIFF_OUT}" | tail -10 >&2
  exit 1
fi
echo "    OK: post-migration diff is clean"

# --- Phase 4: --use-cdk-bootstrap-assets opt-out ------------------------------
echo "==> Phase 4: deploy --use-cdk-bootstrap-assets (repoints back to CDK bucket)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --use-cdk-bootstrap-assets --yes >/dev/null 2>&1
BUCKETS=$(lambda_code_buckets "${parent_state_key}")
[ "${BUCKETS}" = "${CDK_BUCKET}" ] ||
  { echo "FAIL: opt-out deploy left Code.S3Bucket at '${BUCKETS}', expected '${CDK_BUCKET}'" >&2; exit 1; }
CHILD_BUCKETS=$(lambda_code_buckets "$(child_state_key)")
[ "${CHILD_BUCKETS}" = "${CDK_BUCKET}" ] ||
  { echo "FAIL: opt-out deploy left child Code.S3Bucket at '${CHILD_BUCKETS}', expected '${CDK_BUCKET}'" >&2; exit 1; }
echo "    OK: opt-out deploy repointed parent+child back to ${CDK_BUCKET}"

echo "==> Phase 4b: deploy --skip-assets still rewrites (assets already in cdkd storage)"
# The rewrite must run even when publishing is skipped: assets were published
# to cdkd storage in Phase 3, so a --skip-assets deploy in cdkd-assets mode
# has to repoint the templates or it would deploy split-brain references.
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --skip-assets --yes >/dev/null 2>&1
BUCKETS=$(lambda_code_buckets "${parent_state_key}")
[ "${BUCKETS}" = "${CDKD_BUCKET}" ] ||
  { echo "FAIL: --skip-assets deploy left Code.S3Bucket at '${BUCKETS}', expected '${CDKD_BUCKET}'" >&2; exit 1; }
CHILD_BUCKETS=$(lambda_code_buckets "$(child_state_key)")
[ "${CHILD_BUCKETS}" = "${CDKD_BUCKET}" ] ||
  { echo "FAIL: --skip-assets deploy left child Code.S3Bucket at '${CHILD_BUCKETS}', expected '${CDKD_BUCKET}'" >&2; exit 1; }
echo "    OK: flip-flop churn round-trips cleanly, incl. under --skip-assets (design §9)"

# --- Phase 5: Docker image asset (skipped without a daemon) -------------------
if docker info >/dev/null 2>&1; then
  echo "==> Phase 5: deploy image stack (ECR redirection)"
  node "${LOCAL_DIST}" deploy "${IMAGE_STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >/dev/null 2>&1
  IMAGE_URI=$(aws s3 cp "s3://${STATE_BUCKET}/cdkd/${IMAGE_STACK}/${REGION}/state.json" - |
    jq -r '.resources[] | select(.resourceType == "AWS::Lambda::Function") | .properties.Code.ImageUri')
  case "${IMAGE_URI}" in
    *"${CDKD_REPO}"*) : ;;
    *) echo "FAIL: image Lambda Code.ImageUri is '${IMAGE_URI}', expected repo '${CDKD_REPO}'" >&2; exit 1 ;;
  esac
  IMAGE_COUNT=$(aws ecr list-images --repository-name "${CDKD_REPO}" --region "${REGION}" \
    --query 'length(imageIds)' --output text)
  [ "${IMAGE_COUNT}" -ge 1 ] ||
    { echo "FAIL: no image pushed to ${CDKD_REPO}" >&2; exit 1; }
  echo "    OK: image pushed to ${CDKD_REPO} and Lambda created from it"

  echo "==> Phase 5b: destroy image stack"
  node "${LOCAL_DIST}" destroy "${IMAGE_STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >/dev/null 2>&1
else
  echo "==> Phase 5: SKIPPED (no Docker daemon available)"
fi

# --- Phase 6: destroy ---------------------------------------------------------
echo "==> Phase 6: destroy (cascades into the nested child)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if aws s3 ls "s3://${STATE_BUCKET}/${parent_state_key}" >/dev/null 2>&1; then
  echo "FAIL: parent state file still exists after destroy" >&2
  exit 1
fi
CHILD_KEY=$(child_state_key)
if [ -n "${CHILD_KEY}" ] && [ "${CHILD_KEY}" != "None" ]; then
  echo "FAIL: nested child state '${CHILD_KEY}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: parent + nested child state gone"

echo ""
echo "==> asset-migration test passed (legacy deploy, migration diff, in-place repoint incl. nested child + env-var URL, opt-out round-trip, ECR leg, clean destroy)"
