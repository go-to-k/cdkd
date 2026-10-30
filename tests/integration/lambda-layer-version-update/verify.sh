#!/usr/bin/env bash
# verify.sh — cdkd Lambda LayerVersion content-change REPLACEMENT integ.
#
# Regression coverage for the bug where editing a Lambda LayerVersion's content
# (same logical id) was misclassified as an in-place UPDATE. A LayerVersion is
# fully immutable on AWS (no UpdateLayerVersion API), so the provider's update()
# hard-failed — suggesting a `cdkd deploy --replace` flag that does not even
# exist — leaving the change undeployable. CloudFormation / `cdk deploy` handle
# this transparently: a content change publishes a NEW version and re-points the
# consuming function. The fix adds a replacement rule for AWS::Lambda::LayerVersion
# so the diff drives a DELETE + CREATE and promoteReplacementDependents re-points
# the function at the new layer version ARN.
#
# Phases:
#   1. Deploy the layer (content `v1`) + a function consuming it. Capture the
#      layer version N the function points at. (Layer version numbers are
#      per-name monotonic and NEVER reset — even after every version is
#      deleted — so N is :1 only on the very first run in an account.)
#   2. Re-deploy with CDKD_TEST_UPDATE=true (content `v2`). Assert: deploy
#      succeeds WITHOUT any manual --replace flag, a new layer version :N+1
#      is published, and the function now points at :N+1 (the replacement
#      was propagated to the dependent).
#   2.5 Re-deploy with CDKD_TEST_REMOVAL=true as well: RefFn drops
#      S3ObjectStorageMode together with a code change (issue #5300).
#   3. Destroy + assert the function is gone and the cdkd state file is removed.
#
# Issue #5300 arm (Phases 1, 2 and 2.5): RefLayer and RefFn ask for
# `S3ObjectStorageMode: REFERENCE`; Layer and CopyFn are the default-COPY
# controls. Lambda accepts REFERENCE only for an object in a VERSIONED bucket
# whose policy lets the Lambda service principal read it (measured: an
# unversioned bucket is refused with "You must enable S3 versioning", a
# bucket without the grant with "Lambda service principal ... does not have
# s3:GetObject and s3:GetObjectVersion permission"), so this script creates
# that bucket, uploads the zips and passes its name in CDKD_TEST_REF_BUCKET.
# No read API returns the mode itself; a REFERENCE package comes back as
# `ResolvedS3Object` (the bucket, key and version Lambda reads), a COPY one as
# a `Location` URL and no `ResolvedS3Object`. Phase 2 points both REFERENCE
# resources at new objects, so each check repeats after the layer replacement
# and the UpdateFunctionCode the second deploy sends.
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

STACK="CdkdLambdaLayerVersionUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LAYER_NAME="cdkd-layer-version-update-test"
FN_NAME="cdkd-layer-version-update-test-fn"
REF_FN="cdkd-layer-version-update-test-ref-fn"
COPY_FN="cdkd-layer-version-update-test-copy-fn"
REF_LAYER_NAME="cdkd-layer-version-update-test-ref"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
REF_BUCKET="cdkd-integ-ref-${ACCOUNT_ID}-${REGION}"
export CDKD_TEST_REF_BUCKET="${REF_BUCKET}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

REF_TMP="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for f in "${FN_NAME}" "${REF_FN}" "${COPY_FN}"; do
    aws lambda delete-function --function-name "${f}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # Delete every published version of the test layers.
  for l in "${LAYER_NAME}" "${REF_LAYER_NAME}"; do
    for v in $(aws lambda list-layer-versions --layer-name "${l}" --region "${REGION}" \
      --query 'LayerVersions[].Version' --output text 2>/dev/null); do
      aws lambda delete-layer-version --layer-name "${l}" --version-number "${v}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
  done
  # The REFERENCE bucket goes last: nothing above needs its objects. It is
  # versioned, so every version and delete marker is removed before it.
  if aws s3api head-bucket --bucket "${REF_BUCKET}" >/dev/null 2>&1; then
    aws s3api list-object-versions --bucket "${REF_BUCKET}" --output json \
      --query '{Objects: [Versions, DeleteMarkers][][].{Key: Key, VersionId: VersionId}, Quiet: `true`}' \
      > "${REF_TMP}/delete.json" 2>/dev/null
    if [ "$(jq '.Objects | length' "${REF_TMP}/delete.json" 2>/dev/null)" != "0" ]; then
      aws s3api delete-objects --bucket "${REF_BUCKET}" --delete "file://${REF_TMP}/delete.json" >/dev/null 2>&1
    fi
    aws s3api delete-bucket --bucket "${REF_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  rm -rf "${REF_TMP}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
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

if ! command -v zip >/dev/null 2>&1; then
  echo "FAIL: zip is required to build the issue #5300 REFERENCE packages" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
mkdir -p "${REF_TMP}"

fn_layer_arn() {
  aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    --query 'Layers[0].Arn' --output text
}

# --- Issue #5300: the versioned bucket the REFERENCE packages live in ---
# usage: put_ref_objects <v1|v2|v3> -- uploads layer-<v>.zip and fn-<v>.zip
put_ref_objects() {
  local v="$1" d="${REF_TMP}/$1"
  mkdir -p "${d}/layer/nodejs" "${d}/fn"
  printf "module.exports = { version: '%s' };\n" "${v}" > "${d}/layer/nodejs/shared.js"
  printf "exports.handler = async () => ({ v: '%s' });\n" "${v}" > "${d}/fn/index.js"
  (cd "${d}/layer" && zip -q -r "${d}/layer.zip" nodejs)
  (cd "${d}/fn" && zip -q "${d}/fn.zip" index.js)
  aws s3api put-object --bucket "${REF_BUCKET}" --key "layer-${v}.zip" --body "${d}/layer.zip" >/dev/null
  aws s3api put-object --bucket "${REF_BUCKET}" --key "fn-${v}.zip" --body "${d}/fn.zip" >/dev/null
}

echo "==> Creating the versioned REFERENCE bucket ${REF_BUCKET}"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${REF_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${REF_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
aws s3api put-bucket-versioning --bucket "${REF_BUCKET}" --versioning-configuration Status=Enabled
printf '%s' '{"Version":"2012-10-17","Statement":[{"Effect":"Allow",' \
  '"Principal":{"Service":"lambda.amazonaws.com"},' \
  '"Action":["s3:GetObject","s3:GetObjectVersion","s3:ListBucket"],' \
  "\"Resource\":[\"arn:aws:s3:::${REF_BUCKET}\",\"arn:aws:s3:::${REF_BUCKET}/*\"]," \
  "\"Condition\":{\"StringEquals\":{\"aws:SourceAccount\":\"${ACCOUNT_ID}\"}}}]}" \
  > "${REF_TMP}/policy.json"
aws s3api put-bucket-policy --bucket "${REF_BUCKET}" --policy "file://${REF_TMP}/policy.json"
put_ref_objects v1

fn_sha() {
  aws lambda get-function-configuration --function-name "$1" --region "${REGION}" \
    --query 'CodeSha256' --output text
}

# usage: assert_mode <label> <REFERENCE|COPY> <expected key or -> \
#          <ResolvedS3Object.S3Bucket> <ResolvedS3Object.S3Key> <Location>
# A REFERENCE package names the object Lambda reads; a COPY one has a
# Location URL instead. The URL's presigned query string carries a signature
# and a session token, so only "set" / "unset" is ever printed for it.
assert_mode() {
  local label="$1" want="$2" key="$3" bucket="$4" got_key="$5" loc="$6" got has_loc
  case "${loc}" in https://*) has_loc=set ;; *) has_loc=unset ;; esac
  if [ -n "${bucket}" ] && [ "${bucket}" != "None" ]; then got=REFERENCE; else got=COPY; fi
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${label}: S3ObjectStorageMode is ${got}, expected ${want} (issue #5300) -- ResolvedS3Object bucket '${bucket}', Location ${has_loc}" >&2
    exit 1
  fi
  if [ "${want}" = REFERENCE ] && { [ "${bucket}" != "${REF_BUCKET}" ] || [ "${got_key}" != "${key}" ]; }; then
    echo "FAIL: ${label}: REFERENCE package is s3://${bucket}/${got_key}, expected s3://${REF_BUCKET}/${key}" >&2
    exit 1
  fi
  if [ "${want}" = COPY ] && [ "${has_loc}" != set ]; then
    echo "FAIL: ${label}: COPY package has no Location URL" >&2
    exit 1
  fi
  echo "    ${label}: S3ObjectStorageMode ${got}"
}

# usage: assert_fn_mode <label> <function> <REFERENCE|COPY> <expected key or ->
assert_fn_mode() {
  local out
  out="$(aws lambda get-function --function-name "$2" --region "${REGION}" \
    --query '[Code.ResolvedS3Object.S3Bucket, Code.ResolvedS3Object.S3Key, Code.Location]' \
    --output text)" || return 1
  # Word splitting is the point: three tab-separated fields.
  # shellcheck disable=SC2086
  assert_mode "$1" "$3" "$4" ${out}
}

# usage: assert_layer_mode <label> <layer name> <version> <REFERENCE|COPY> <expected key or ->
assert_layer_mode() {
  local out
  out="$(aws lambda get-layer-version --layer-name "$2" --version-number "$3" --region "${REGION}" \
    --query '[Content.ResolvedS3Object.S3Bucket, Content.ResolvedS3Object.S3Key, Content.Location]' \
    --output text)" || return 1
  # shellcheck disable=SC2086
  assert_mode "$1" "$4" "$5" ${out}
}

ref_layer_version() {
  aws lambda list-layer-versions --layer-name "${REF_LAYER_NAME}" --region "${REGION}" \
    --query 'LayerVersions[0].Version' --output text
}

# usage: assert_issue_5300 <phase label> <Layer version> <v1|v2>
assert_issue_5300() {
  local phase="$1" ref_v
  ref_v="$(ref_layer_version)" || return 1
  assert_layer_mode "${phase} ${REF_LAYER_NAME}:${ref_v}" "${REF_LAYER_NAME}" "${ref_v}" REFERENCE "layer-$3.zip"
  assert_layer_mode "${phase} ${LAYER_NAME}:$2 (default)" "${LAYER_NAME}" "$2" COPY -
  assert_fn_mode "${phase} ${REF_FN}" "${REF_FN}" REFERENCE "fn-$3.zip"
  assert_fn_mode "${phase} ${COPY_FN} (default)" "${COPY_FN}" COPY -
}

# --- Phase 1: deploy baseline (layer content v1) ----------------------
echo "==> Phase 1: deploy layer (v1) + consuming function"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

ARN_P1="$(fn_layer_arn)"
echo "    function layer arn (Phase 1): ${ARN_P1}"
case "${ARN_P1}" in
  *":layer:${LAYER_NAME}:"*) ;;
  *) echo "FAIL: expected function to point at layer ${LAYER_NAME}, got '${ARN_P1}'" >&2; exit 1 ;;
esac
V1="${ARN_P1##*:}"
case "${V1}" in
  ''|*[!0-9]*) echo "FAIL: could not parse a numeric layer version from '${ARN_P1}'" >&2; exit 1 ;;
esac
echo "    function points at layer version :${V1}"
assert_issue_5300 "Phase 1" "${V1}" v1
REF_SHA_P1="$(fn_sha "${REF_FN}")"

# --- Phase 2: change layer content (REPLACEMENT, must NOT need --replace) ---
echo "==> Phase 2: re-deploy with v2 layer content (replacement + dependent re-point)"
put_ref_objects v2
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# A new version :V1+1 must have been published.
V2=$((V1 + 1))
# `--output text` list projections are TAB-separated; normalize to spaces so
# the case pattern below matches even when multiple versions coexist.
VERSIONS="$(aws lambda list-layer-versions --layer-name "${LAYER_NAME}" --region "${REGION}" \
  --query 'LayerVersions[].Version' --output text | tr '\t' ' ')"
echo "    published layer versions: ${VERSIONS}"
case " ${VERSIONS} " in
  *" ${V2} "*) ;;
  *) echo "FAIL: expected a published layer version :${V2} after the content change, got '${VERSIONS}'" >&2; exit 1 ;;
esac
echo "    new layer version :${V2} published"

# The function must now follow to :V2 (replacement propagated to dependent).
ARN_P2="$(fn_layer_arn)"
echo "    function layer arn (Phase 2): ${ARN_P2}"
case "${ARN_P2}" in
  *":layer:${LAYER_NAME}:${V2}") ;;
  *) echo "FAIL: expected function to be re-pointed at layer ${LAYER_NAME}:${V2}, got '${ARN_P2}'" >&2; exit 1 ;;
esac
echo "    function re-pointed at layer version :${V2} (replacement propagated)"

# The mode must ride UpdateFunctionCode too: prove the code was replaced,
# then re-read the mode off the updated function.
if [ "$(fn_sha "${REF_FN}")" = "${REF_SHA_P1}" ]; then
  echo "FAIL: ${REF_FN}: CodeSha256 unchanged after the Phase 2 asset change -- UpdateFunctionCode never ran" >&2
  exit 1
fi
assert_issue_5300 "Phase 2" "${V2}" v2

# --- Phase 2.5: RefFn drops S3ObjectStorageMode (issue #5300) ---------
# The template removes the mode together with a code change (fn-v3.zip).
# CloudFormation stores the new package as a COPY then (measured A/B,
# 2026-10-26), so cdkd's UpdateFunctionCode must leave it the same way:
# a Location URL and no ResolvedS3Object.
echo "==> Phase 2.5: RefFn drops S3ObjectStorageMode with a code change"
put_ref_objects v3
REF_SHA_P2="$(fn_sha "${REF_FN}")"
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
if [ "$(fn_sha "${REF_FN}")" = "${REF_SHA_P2}" ]; then
  echo "FAIL: ${REF_FN}: CodeSha256 unchanged by the Phase 2.5 code change -- UpdateFunctionCode never ran" >&2
  exit 1
fi
assert_fn_mode "Phase 2.5 ${REF_FN} (mode removed)" "${REF_FN}" COPY -

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    function deleted"
for f in "${REF_FN}" "${COPY_FN}"; do
  assert_gone "function ${f} still exists after destroy" aws lambda get-function-configuration --function-name "${f}" --region "${REGION}"
done
REF_LAYER_LEFT="$(aws lambda list-layer-versions --layer-name "${REF_LAYER_NAME}" --region "${REGION}" \
  --query 'length(LayerVersions)' --output text)"
if [ "${REF_LAYER_LEFT}" != "0" ]; then
  echo "FAIL: ${REF_LAYER_LEFT} version(s) of layer ${REF_LAYER_NAME} still exist after destroy" >&2
  exit 1
fi
echo "    issue #5300 functions and REFERENCE layer deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Lambda LayerVersion content change auto-replaces (no --replace) and re-points the consuming function; REFERENCE storage mode reaches AWS on layer and function create and on UpdateFunctionCode (issue #5300); all 3 phases passed"
