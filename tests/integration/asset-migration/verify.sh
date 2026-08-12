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
#   Phase 6 (issue 1652): the IMPORT-driven migration, which is a different
#            bug class from phases 1-4. A stack is deployed by the UPSTREAM
#            `cdk deploy` (so AWS holds cdk-<qualifier>-assets-* everywhere),
#            adopted with `cdkd import --migrate-from-cloudformation` while
#            the region is in cdkd-assets mode, and then:
#              - `cdkd diff` MUST report a real UPDATE on the
#                `AWS::IAM::Policy` that BucketDeployment grants on the asset
#                bucket. Pre-1652 the import baked the REWRITTEN bucket into
#                state, both diff sides agreed, the change classified
#                NO_CHANGE and the live grant was never corrected;
#              - state MUST carry the pre-rewrite `cdk-*` value;
#              - `cdkd deploy` MUST leave the LIVE policy document naming the
#                cdkd asset bucket (read back with `iam get-role-policy`).
#            The deploy-driven migration in phases 1-4 was never affected by
#            1652 — state there already held the old names.
#   Phase 7: destroy everything, sweep log groups, delete marker + storage.
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

STACK="CdkdAssetMigrationStack"
IMAGE_STACK="CdkdAssetMigrationImageStack"
# Issue 1652 import leg — deployed by the UPSTREAM cdk CLI, adopted by cdkd.
IMPORT_STACK="CdkdAssetMigrationImportStack"
REGION="${AWS_REGION:-us-east-1}"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

# Resolved during phase 6; referenced by cleanup, so seed them for `set -u`.
SITE_BUCKET=""
IMPORT_ROLE=""
IMPORT_POLICY=""

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
    for s in "${IMPORT_STACK}" "${IMAGE_STACK}" "${STACK}"; do
      node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" events prune "${s}" --all --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  # Issue 1652 import leg: the destination bucket and any CloudFormation stack
  # a crashed run left behind (the happy path retires it via
  # --migrate-from-cloudformation, so this is a no-op then). `cdk destroy` is
  # last: `state destroy` above has already removed the AWS resources, and a
  # CFn stack left holding references to them cannot be dropped any other way.
  if [ -n "${SITE_BUCKET}" ]; then
    aws s3 rb "s3://${SITE_BUCKET}" --force >/dev/null 2>&1 || true
  fi
  if [ -x "${PWD}/node_modules/.bin/cdk" ]; then
    npx cdk destroy "${IMPORT_STACK}" --force >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${IMAGE_STACK}/" --recursive >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${IMPORT_STACK}/" --recursive >/dev/null 2>&1 || true
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
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
# Guard on the cdk BIN, not on node_modules (issue 1485): phase 6 shells out
# to the UPSTREAM cdk CLI, and a node_modules left over from before the
# `aws-cdk` pin exists but has no cdk in it — so a directory guard would skip
# the very install that provides it and `npx cdk` would fall through to a
# possibly stale global CLI whose cloud-assembly schema no longer matches this
# fixture's aws-cdk-lib.
if [ ! -x "${PWD}/node_modules/.bin/cdk" ]; then
  pnpm install --ignore-workspace --prefer-offline
fi
export PATH="${PWD}/node_modules/.bin:${PATH}"

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
# --no-auto-asset-storage: since issue #1007 a --yes deploy into an
# un-opted-in region AUTO-CREATES the asset storage instead of publishing
# to the legacy CDK bootstrap destinations this phase asserts.
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --no-auto-asset-storage --yes 2>&1)
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

# --- Phase 6: import-driven migration (issue 1652) ----------------------------
# Phases 1-4 cover the DEPLOY-driven migration, where state legitimately holds
# the old cdk-* names so the diff always produced a real UPDATE. The
# import-driven path is the one issue 1652 fixed: the rewrite used to reach
# `state.properties`, so state and template agreed on the cdkd bucket while
# AWS still held the CDK bootstrap one, the change classified NO_CHANGE, and
# the live resource was never corrected.
echo "==> Phase 6: import an upstream-cdk-deployed stack (issue 1652)"

# Fail-closed pre-flight: upstream `cdk deploy` needs the CDK bootstrap roles,
# not just the asset bucket phases 1-4 rely on.
if ! aws cloudformation describe-stacks --region "${REGION}" \
  --stack-name CDKToolkit >/dev/null 2>&1; then
  echo "FAIL: region ${REGION} has no CDKToolkit stack — phase 6 deploys with the" >&2
  echo "      upstream cdk CLI, which needs the CDK bootstrap roles. Run" >&2
  echo "      'npx cdk bootstrap aws://<account>/${REGION}' first." >&2
  exit 1
fi
# Pre-flight "already exists" guard (leftover from a crashed earlier run).
if aws cloudformation describe-stacks --region "${REGION}" \
  --stack-name "${IMPORT_STACK}" >/dev/null 2>&1; then
  echo "FAIL: CloudFormation stack ${IMPORT_STACK} already exists — clean it up" >&2
  echo "      first: npx cdk destroy ${IMPORT_STACK} --force" >&2
  exit 1
fi

echo "    6a: cdk deploy (UPSTREAM CLI) — assets land in ${CDK_BUCKET}"
npx cdk deploy "${IMPORT_STACK}" --require-approval never >/dev/null

cfn_physical_id() { # $1 = resource type -> the stack's single resource of that type
  local id
  id="$(aws cloudformation describe-stack-resources --region "${REGION}" \
    --stack-name "${IMPORT_STACK}" \
    --query "StackResources[?ResourceType=='$1']|[0].PhysicalResourceId" \
    --output text)" || return 1
  printf '%s' "${id}"
}

SITE_BUCKET="$(cfn_physical_id 'AWS::S3::Bucket')"
IMPORT_ROLE="$(cfn_physical_id 'AWS::IAM::Role')"

# The inline policy is looked up BY ITS IAM NAME, not by CloudFormation's
# physical id for the AWS::IAM::Policy resource. Those differ: CFn's id is a
# generated token (`CdkdA-Custo-BdGSXILT1JGK`), while `get-role-policy` wants
# the PolicyName IAM actually stored. Deriving it from CFn failed mid-run with
# a bare `NoSuchEntity`, which reads like the resource is missing rather than
# like the lookup being wrong — so ask IAM for the name instead of inferring it.
IMPORT_POLICY_NAMES="$(aws iam list-role-policies --role-name "${IMPORT_ROLE}" \
  --query 'join(`,`, PolicyNames)' --output text)"
case "${IMPORT_POLICY_NAMES}" in
  *,*)
    # More than one inline policy means the grant under test is no longer
    # uniquely identified, so picking [0] would silently assert against the
    # wrong document. Fail loudly instead — the fixture's stack is built to
    # keep exactly one (see its doc comment on omitting autoDeleteObjects).
    echo "FAIL: role ${IMPORT_ROLE} has more than one inline policy" >&2
    echo "      (${IMPORT_POLICY_NAMES}); the asset grant is no longer unique." >&2
    exit 1
    ;;
esac
IMPORT_POLICY="${IMPORT_POLICY_NAMES}"

for pair in "SITE_BUCKET=${SITE_BUCKET}" "IMPORT_ROLE=${IMPORT_ROLE}" "IMPORT_POLICY=${IMPORT_POLICY}"; do
  case "${pair}" in
    *=|*=None)
      echo "FAIL: could not resolve ${pair%%=*} from CloudFormation stack ${IMPORT_STACK}" >&2
      exit 1
      ;;
  esac
done
echo "        bucket=${SITE_BUCKET} role=${IMPORT_ROLE} policy=${IMPORT_POLICY}"

# The live inline policy document. `iam get-role-policy` is exactly the read
# `IAMPolicyProvider.import()` does NOT do — which is why nothing pulled the
# AWS-side value into state and the bug could hide.
role_policy_document() {
  aws iam get-role-policy --role-name "${IMPORT_ROLE}" \
    --policy-name "${IMPORT_POLICY}" --query 'PolicyDocument' --output json
}

echo "    6b: premise — the live grant names the CDK bootstrap bucket"
LIVE_DOC="$(role_policy_document)"
case "${LIVE_DOC}" in
  *"${CDK_BUCKET}"*) : ;;
  *)
    echo "FAIL: the freshly cdk-deployed policy does not grant ${CDK_BUCKET}." >&2
    echo "      This fixture is only meaningful when it does — has" >&2
    echo "      BucketDeployment stopped calling asset.grantRead(handlerRole)?" >&2
    exit 1
    ;;
esac
case "${LIVE_DOC}" in
  *"${CDKD_BUCKET}"*)
    echo "FAIL: the cdk-deployed policy already grants ${CDKD_BUCKET} — impossible" >&2
    echo "      unless a previous run left state behind. Aborting." >&2
    exit 1
    ;;
esac
echo "        OK: live grant is on ${CDK_BUCKET}"

echo "    6c: cdkd import --migrate-from-cloudformation (region is in cdkd-assets mode)"
# `import` is the one command that does not accept --region (issue #1097), so
# the region rides on AWS_REGION.
AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${IMPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --migrate-from-cloudformation --yes

assert_gone "CloudFormation stack ${IMPORT_STACK} survived --migrate-from-cloudformation" \
  aws cloudformation describe-stacks --region "${REGION}" --stack-name "${IMPORT_STACK}"
echo "        OK: cdkd owns the resources; the CloudFormation stack is retired"

import_state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/cdkd/${IMPORT_STACK}/${REGION}/state.json" -
}

echo "    6d: state records the PRE-rewrite (cdk bootstrap) asset references"
POLICY_PROPS="$(import_state_json |
  jq -c '[.resources[] | select(.resourceType == "AWS::IAM::Policy") | .properties] | .[0]')"
case "${POLICY_PROPS}" in
  *"${CDK_BUCKET}"*) : ;;
  *)
    echo "FAIL: imported state does not carry the pre-rewrite ${CDK_BUCKET} grant." >&2
    echo "      properties: ${POLICY_PROPS}" >&2
    exit 1
    ;;
esac
case "${POLICY_PROPS}" in
  *"${CDKD_BUCKET}"*)
    echo "FAIL (issue 1652): imported state carries the REWRITTEN ${CDKD_BUCKET}" >&2
    echo "      grant. AWS holds ${CDK_BUCKET}, so the next diff will classify" >&2
    echo "      NO_CHANGE and the live policy will never be corrected." >&2
    echo "      properties: ${POLICY_PROPS}" >&2
    exit 1
    ;;
esac
echo "        OK: state holds the cdk-bootstrap grant AWS actually has"

echo "    6e: cdkd diff reports a real UPDATE on the IAM policy (the 1652 assertion)"
DIFF_JSON_FILE="/tmp/asset-migration-import-diff.json"
AWS_REGION="${REGION}" node "${LOCAL_DIST}" diff "${IMPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --json >"${DIFF_JSON_FILE}"
CDK_BUCKET="${CDK_BUCKET}" CDKD_BUCKET="${CDKD_BUCKET}" \
  python3 - "${DIFF_JSON_FILE}" <<'PY'
import json, os, sys

cdk_bucket = os.environ["CDK_BUCKET"]
cdkd_bucket = os.environ["CDKD_BUCKET"]
with open(sys.argv[1]) as fh:
    trees = json.load(fh)

changes = [c for tree in trees for c in tree["changes"]]
summary = [(c["resourceType"], c["changeType"]) for c in changes]
policies = [c for c in changes if c["resourceType"] == "AWS::IAM::Policy"]
if len(policies) != 1:
    sys.exit(
        "FAIL (issue 1652): expected exactly 1 AWS::IAM::Policy change in the "
        f"post-import diff, got {len(policies)}. Pre-fix this list is EMPTY - the "
        "rewrite reached state.properties, both diff sides agreed and the live "
        f"grant was never corrected. All changes: {summary}"
    )

policy = policies[0]
if policy["changeType"] != "UPDATE":
    sys.exit(f"FAIL: IAM policy change is {policy['changeType']}, expected UPDATE")

prop_changes = policy.get("propertyChanges") or []
old_blob = json.dumps([pc.get("oldValue") for pc in prop_changes])
new_blob = json.dumps([pc.get("newValue") for pc in prop_changes])
if cdk_bucket not in old_blob:
    sys.exit(f"FAIL: diff old side does not name {cdk_bucket}: {old_blob}")
if cdkd_bucket not in new_blob:
    sys.exit(f"FAIL: diff new side does not name {cdkd_bucket}: {new_blob}")
print(f"        OK: {policy['logicalId']} UPDATE {cdk_bucket} -> {cdkd_bucket}")
PY

echo "    6f: cdkd deploy corrects the LIVE policy document"
node "${LOCAL_DIST}" deploy "${IMPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >/dev/null
LIVE_DOC="$(role_policy_document)"
case "${LIVE_DOC}" in
  *"${CDKD_BUCKET}"*) : ;;
  *)
    echo "FAIL (issue 1652): after the post-import deploy the live policy still does" >&2
    echo "      not grant ${CDKD_BUCKET}. Document: ${LIVE_DOC}" >&2
    exit 1
    ;;
esac
case "${LIVE_DOC}" in
  *"${CDK_BUCKET}"*)
    echo "FAIL: the live policy still grants the CDK bootstrap bucket ${CDK_BUCKET}" >&2
    echo "      alongside the cdkd one. Document: ${LIVE_DOC}" >&2
    exit 1
    ;;
esac
echo "        OK: live grant is now on ${CDKD_BUCKET} only"

# The custom resource re-ran against the cdkd bucket during that deploy — the
# runtime AccessDenied issue 1652 predicts would have failed the deploy above,
# so this asserts the sync actually produced the object rather than no-op'ing.
BODY="$(aws s3 cp "s3://${SITE_BUCKET}/index.html" - --region "${REGION}")"
echo "${BODY}" | grep -qF "cdkd asset-migration import marker v1" ||
  { echo "FAIL: deployed index.html missing or wrong content; got: ${BODY}" >&2; exit 1; }
echo "        OK: BucketDeployment synced from ${CDKD_BUCKET}"

echo "    6g: state now records the cdkd asset references"
POLICY_PROPS="$(import_state_json |
  jq -c '[.resources[] | select(.resourceType == "AWS::IAM::Policy") | .properties] | .[0]')"
case "${POLICY_PROPS}" in
  *"${CDKD_BUCKET}"*) : ;;
  *)
    echo "FAIL: post-deploy state does not carry ${CDKD_BUCKET}: ${POLICY_PROPS}" >&2
    exit 1
    ;;
esac
echo "        OK: import leg converged"

# --- Phase 7: destroy ---------------------------------------------------------
echo "==> Phase 7: destroy (cascades into the nested child)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone "parent state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${parent_state_key}"
CHILD_KEY=$(child_state_key)
if [ -n "${CHILD_KEY}" ] && [ "${CHILD_KEY}" != "None" ]; then
  echo "FAIL: nested child state '${CHILD_KEY}' still exists after destroy" >&2
  exit 1
fi
echo "    OK: parent + nested child state gone"

echo "==> Phase 7b: destroy the imported stack"
# Empty the destination bucket FIRST. `BucketDeployment` put index.html there,
# the stack deliberately carries no `autoDeleteObjects` (see the stack's doc
# comment for why), and cdkd matches CloudFormation by REFUSING to delete a
# non-empty bucket without that opt-in — the issue #1340 data guard in
# `s3-bucket-provider.ts`. Without this the destroy fails with
# "bucket ... is not empty" and the run ends red on a teardown detail rather
# than on anything the fixture is testing.
#
# NOT `rb --force`: the bucket must still be there for cdkd to delete, because
# deleting it is the step being verified.
aws s3 rm "s3://${SITE_BUCKET}" --recursive --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${IMPORT_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone "destination bucket ${SITE_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${SITE_BUCKET}" --region "${REGION}"
assert_gone "handler role ${IMPORT_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${IMPORT_ROLE}"
assert_gone "import-leg state file still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" \
  --key "cdkd/${IMPORT_STACK}/${REGION}/state.json"
SITE_BUCKET=""
echo "    OK: imported stack fully torn down"

echo ""
echo "==> asset-migration test passed (legacy deploy, migration diff, in-place repoint incl. nested child + env-var URL, opt-out round-trip, ECR leg, import-driven migration incl. live IAM-policy correction, clean destroy)"
