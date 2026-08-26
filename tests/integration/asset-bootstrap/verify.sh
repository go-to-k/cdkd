#!/usr/bin/env bash
# verify.sh - cdkd asset-bootstrap integ (issue #1002 PR 1).
#
# End-to-end verification of cdkd-owned asset storage bootstrap + deploy-time
# asset-mode detection:
#
#   Phase 1: deploy WITHOUT a bootstrap marker -> legacy mode: the one-line
#            `cdk gc` hazard notice appears, deploy succeeds as before.
#   Phase 1b: a region-free --asset-bucket name pointing at a bucket THIS
#            account owns in ANOTHER region -> bootstrap refuses by NAMING
#            both regions, and writes no marker (issue #2240).
#   Phase 2: `cdkd bootstrap` -> asset bucket (AES-256, public-access block,
#            deny-external policy, NO versioning) + IMMUTABLE-tag ECR repo +
#            marker `cdkd-bootstrap/{region}.json` written to the state
#            bucket; `state info --json` lists the region.
#   Phase 3: deploy WITH the marker -> cdkd-assets mode: no gc notice,
#            existence verification passes, deploy still succeeds
#            (PR 1 is detection-only; publish destinations unchanged).
#   Phase 4: delete the ECR repo, deploy -> hard error naming the repo and
#            the re-bootstrap fix (never a silent legacy fallback).
#   Cleanup: destroy the stack, delete marker + asset bucket + repo.
#
# SAFETY NOTE (issue #1052): this fixture exercises the region's CANONICAL
# default-named cdkd asset storage (cdkd-assets-{account}-{region} + repo +
# marker), so it must only run in a region whose marker does not exist yet.
# A pre-run guard fails fast when the region already carries a bootstrap
# marker (it belongs to live storage this fixture must not delete — pick a
# marker-free region via AWS_REGION). The guard makes the EXIT-trap cleanup
# safe: any marker/bucket/repo present at exit was created by THIS run.
# The pre-run cleanup pass deletes only stack-scoped leftovers and never
# touches asset storage.
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

STACK="CdkdAssetBootstrapStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
ASSET_BUCKET="cdkd-assets-${ACCOUNT_ID}-${REGION}"
CONTAINER_REPO="cdkd-container-assets-${ACCOUNT_ID}-${REGION}"

# Phase 1b (issue #2240). A region whose name differs from REGION, and a
# region-FREE bucket name -- the default `cdkd-assets-{acct}-{region}` embeds
# the region, which is exactly why this class first read as unreachable. Empty
# until phase 1b creates it, so `cleanup` can be trusted to skip it otherwise.
XREGION_REGION=$([ "${REGION}" = "us-west-2" ] && echo "us-east-1" || echo "us-west-2")
XREGION_BUCKET=""

cleanup() {
  # $1 = "prerun" skips the asset-storage deletion: a marker/bucket/repo
  # that exists BEFORE this run is live storage we must not delete (the
  # guard below fails fast on it instead). Without the arg (EXIT trap),
  # asset storage is cleaned too — the guard guarantees anything present
  # at exit was created by this run.
  echo "==> Cleanup: dropping stack state/resources${1:+ (stack-scoped only)}"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  if [ "${1:-}" != "prerun" ]; then
    if [ -n "${STATE_BUCKET:-}" ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1 || true
    fi
    # The PR-1 asset bucket is never written to (redirection is PR 2), so a
    # plain delete-bucket suffices; --force also clears any future objects.
    aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
    aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
      --region "${REGION}" --force >/dev/null 2>&1 || true
  fi
  # Phase 1b's cross-region scratch bucket (issue #2240). Folded into the
  # EXISTING handler rather than installed as a second `trap ... EXIT`, which
  # does not chain -- it would replace this one and strand the asset bucket,
  # the ECR repo and the marker on every failure path.
  if [ -n "${XREGION_BUCKET:-}" ]; then
    aws s3 rb "s3://${XREGION_BUCKET}" --force --region "${XREGION_REGION:-}" >/dev/null 2>&1 || true
  fi
  # Lambda deploys leave no log group here (the function is never invoked),
  # but sweep defensively per the fixture template.
  aws logs describe-log-groups --log-group-name-prefix "/aws/lambda/${STACK}" \
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
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (stack-scoped only)"
cleanup prerun

# Own-marker guard (issue #1052): this fixture bootstraps and then DELETES
# the region's default-named asset storage, so a pre-existing marker means
# the region's storage is genuinely in use (real assets may live there since
# #1002 PR 2) — never delete it. Fail fast and let the caller pick a
# marker-free region.
if aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - >/dev/null 2>&1; then
  echo "FAIL: region ${REGION} already has a cdkd bootstrap marker (live asset storage)." >&2
  echo "      This fixture creates AND deletes the region's default-named storage;" >&2
  echo "      run it in a region without cdkd asset storage (e.g. AWS_REGION=us-west-2)." >&2
  echo "      If this is a leftover from a previous crashed run of this fixture, clean it" >&2
  echo "      up first: node dist/cli.js bootstrap --destroy --region ${REGION} --yes" >&2
  exit 1
fi

GC_NOTICE="may garbage-collect"

# --- Phase 1: deploy WITHOUT marker (legacy mode) -------------------------
echo "==> Phase 1: deploy without marker (legacy mode expected)"
# --no-auto-asset-storage: since issue #1007 a --yes deploy into an
# un-opted-in region AUTO-CREATES the asset storage instead of falling
# back to legacy mode — this phase tests the legacy fallback + gc notice,
# so auto-create must be disabled (the auto-create path has its own
# fixture, asset-auto-create).
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-auto-asset-storage \
  --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3

if ! echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: legacy-mode deploy did not print the 'cdk gc' hazard info line" >&2
  exit 1
fi
NOTICE_COUNT=$(echo "${DEPLOY_OUT}" | grep -cF "${GC_NOTICE}")
if [ "${NOTICE_COUNT}" != "1" ]; then
  echo "FAIL: expected exactly 1 gc-hazard info line, got ${NOTICE_COUNT}" >&2
  exit 1
fi
echo "    OK: legacy mode printed the gc-hazard notice exactly once"

# --- Phase 1b: cross-region --asset-bucket refusal (issue #2240) -----------
# Runs BEFORE phase 2 on purpose: once REGION carries a marker, a differing
# requested name hard-errors ASSET_STORAGE_NAME_CONFLICT first and this arm
# would never reach the bucket probe at all.
echo "==> Phase 1b: --asset-bucket naming a bucket we own in ${XREGION_REGION}"
XREGION_BUCKET="cdkd-2240-xregion-${ACCOUNT_ID}-$(date +%s)"
# `us-east-1` is NOT a member of S3's BucketLocationConstraint enum -- passing
# it answers `InvalidLocationConstraint` (measured 2026-08-26; omitting the
# block succeeds). `asset-storage.ts` codes around the same rule. This bites
# whenever REGION is us-west-2, which is exactly what the guard above
# recommends, and `set -e` would take phases 2-5 down with it.
if [ "${XREGION_REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${XREGION_BUCKET}" --region "${XREGION_REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${XREGION_BUCKET}" --region "${XREGION_REGION}" \
    --create-bucket-configuration "LocationConstraint=${XREGION_REGION}" >/dev/null
fi

# A review asked whether a bucket created seconds earlier in another region
# answers 307 (S3's propagation window) rather than 301, which would false-FAIL
# the grep below. Measured 2026-08-26 -- created in us-west-2, then HEADed via
# the us-east-1 endpoint five times back to back: 301 every time, with
# `x-amz-bucket-region: us-west-2` on each. No 307 observed, so no retry arm is
# added here. Recorded rather than left implicit, so the question is not
# re-derived.
#
# Prove the PREMISE before trusting the assertion: the bucket must really be in
# the other region, or this arm passes for the wrong reason.
# `--output text` renders the us-east-1 answer as the literal `None` (the API
# returns an EMPTY LocationConstraint for it), so the raw value must be folded
# before it is compared -- measured 2026-08-26, and the unfolded form
# false-FAILs this arm whenever AWS_REGION is us-west-2.
XREGION_RAW=$(aws s3api get-bucket-location --bucket "${XREGION_BUCKET}" \
  --query 'LocationConstraint' --output text)
case "${XREGION_RAW}" in
  None | '' | null) XREGION_ACTUAL="us-east-1" ;;
  EU) XREGION_ACTUAL="eu-west-1" ;;
  *) XREGION_ACTUAL="${XREGION_RAW}" ;;
esac
if [ "${XREGION_ACTUAL}" != "${XREGION_REGION}" ]; then
  echo "FAIL: scratch bucket landed in '${XREGION_ACTUAL}' (raw '${XREGION_RAW}'), expected ${XREGION_REGION}" >&2
  exit 1
fi

set +e
XREGION_OUT=$(node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --asset-bucket "${XREGION_BUCKET}" 2>&1)
XREGION_RC=$?
set -e

if [ "${XREGION_RC}" -eq 0 ]; then
  echo "FAIL: bootstrap ADOPTED a bucket in ${XREGION_REGION}; output:" >&2
  printf '%s\n' "${XREGION_OUT}" >&2
  exit 1
fi

# A non-zero rc is NOT the discriminator: before the fix this refused too, via
# normalizeAwsError's generic 301 rendering. Only the fixed path names the two
# regions, so that is what is asserted.
if ! printf '%s' "${XREGION_OUT}" | grep -q "resolves to a bucket in ${XREGION_REGION}"; then
  echo "FAIL: refusal does not name the bucket's region (${XREGION_REGION}); output:" >&2
  printf '%s\n' "${XREGION_OUT}" >&2
  exit 1
fi
if ! printf '%s' "${XREGION_OUT}" | grep -q "targets ${REGION}"; then
  echo "FAIL: refusal does not name the target region (${REGION}); output:" >&2
  printf '%s\n' "${XREGION_OUT}" >&2
  exit 1
fi
# The PRE-fix wording, which told the user to file a bug for their own naming
# collision. Its absence is what says the new arm ran rather than the old one.
if printf '%s' "${XREGION_OUT}" | grep -q 'please report it'; then
  echo "FAIL: still emitting the pre-fix 301 wording; output:" >&2
  printf '%s\n' "${XREGION_OUT}" >&2
  exit 1
fi

# The refusal must leave nothing half-done: no marker for REGION. NOTE this is
# a safety net, not a discriminator -- phase 1b runs before phase 2, so no
# marker exists either way; the `rc -eq 0` check above is what catches an
# adoption. Kept because a half-written marker is the worst outcome, and
# routed through the fixture's tri-state helper so a throttled probe cannot
# read as "no marker".
assert_gone "refused bootstrap still wrote marker ${MARKER_KEY}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"
# ...and no configuration applied to the bucket in the other region. A fresh
# bucket has no policy, so a PutBucketPolicy landing there is visible as one.
# Tri-state rather than a blind `if`: a throttle / auth failure must not read
# as "no policy" and pass this check silently. Measured 2026-08-26 -- a
# policy-free bucket answers rc=254 with `NoSuchBucketPolicy`.
XREGION_POLICY_OUT=$(aws s3api get-bucket-policy --bucket "${XREGION_BUCKET}" \
  --region "${XREGION_REGION}" 2>&1) && {
  echo "FAIL: this region's bucket policy was applied to ${XREGION_BUCKET} in ${XREGION_REGION}" >&2
  printf '%s\n' "${XREGION_POLICY_OUT}" >&2
  exit 1
}
if ! printf '%s' "${XREGION_POLICY_OUT}" | grep -q 'NoSuchBucketPolicy'; then
  echo "FAIL: undetermined bucket-policy probe on ${XREGION_BUCKET}: ${XREGION_POLICY_OUT}" >&2
  exit 1
fi
echo "    OK: refused by naming both regions; no marker, no policy on the foreign bucket"

aws s3 rb "s3://${XREGION_BUCKET}" --force --region "${XREGION_REGION}" >/dev/null
XREGION_BUCKET=""

# --- Phase 2: bootstrap (asset storage + marker) ---------------------------
echo "==> Phase 2: cdkd bootstrap (creates asset bucket + ECR repo + marker)"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}"

MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null)
if [ -z "${MARKER}" ]; then
  echo "FAIL: bootstrap marker missing at s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  exit 1
fi
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.containerRepo')" != "${CONTAINER_REPO}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.assetSupportVersion')" != "1" ]; then
  echo "FAIL: marker body unexpected: ${MARKER}" >&2
  exit 1
fi
echo "    OK: marker present with expected assetBucket/containerRepo/version"

ENC=$(aws s3api get-bucket-encryption --bucket "${ASSET_BUCKET}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' --output text)
if [ "${ENC}" != "AES256" ]; then
  echo "FAIL: asset bucket encryption is '${ENC}', expected AES256" >&2
  exit 1
fi
VERSIONING=$(aws s3api get-bucket-versioning --bucket "${ASSET_BUCKET}" --query 'Status' --output text)
if [ "${VERSIONING}" != "None" ] && [ -n "${VERSIONING}" ] && [ "${VERSIONING}" != "null" ]; then
  echo "FAIL: asset bucket versioning is '${VERSIONING}', expected disabled" >&2
  exit 1
fi
if ! aws s3api get-bucket-policy --bucket "${ASSET_BUCKET}" --query 'Policy' --output text | grep -q 'DenyExternalAccess'; then
  echo "FAIL: asset bucket policy lacks DenyExternalAccess" >&2
  exit 1
fi
PAB=$(aws s3api get-public-access-block --bucket "${ASSET_BUCKET}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicPolicy' --output text)
if [ "${PAB}" != "True" ]; then
  echo "FAIL: asset bucket public access block not enabled (BlockPublicPolicy=${PAB})" >&2
  exit 1
fi
MUTABILITY=$(aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" \
  --region "${REGION}" --query 'repositories[0].imageTagMutability' --output text)
if [ "${MUTABILITY}" != "IMMUTABLE" ]; then
  echo "FAIL: container repo imageTagMutability is '${MUTABILITY}', expected IMMUTABLE" >&2
  exit 1
fi
echo "    OK: asset bucket (AES256, no versioning, PAB, deny-external) + repo (IMMUTABLE)"

INFO=$(node "${LOCAL_DIST}" state info --state-bucket "${STATE_BUCKET}" --json)
if [ "$(echo "${INFO}" | jq -r --arg r "${REGION}" '[.assetStorage[] | select(.region == $r)] | length')" != "1" ]; then
  echo "FAIL: state info --json does not list ${REGION} in assetStorage: ${INFO}" >&2
  exit 1
fi
echo "    OK: state info --json lists ${REGION} in assetStorage"

# --- Phase 2b: bootstrap idempotency (re-run, no --force) ------------------
echo "==> Phase 2b: re-run bootstrap (idempotent)"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null
echo "    OK: re-run bootstrap succeeded"

# --- Phase 3: deploy WITH marker (cdkd-assets mode) -------------------------
echo "==> Phase 3: deploy with marker (cdkd-assets mode expected)"
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
echo "${DEPLOY_OUT}" | tail -3

if echo "${DEPLOY_OUT}" | grep -qF "${GC_NOTICE}"; then
  echo "FAIL: cdkd-assets mode deploy still printed the legacy gc-hazard line" >&2
  exit 1
fi
echo "    OK: cdkd-assets mode deploy succeeded with no legacy notice"

# --- Phase 4: marker present but repo deleted -> hard error ------------------
echo "==> Phase 4: delete container repo, expect deploy hard error"
aws ecr delete-repository --repository-name "${CONTAINER_REPO}" --region "${REGION}" --force >/dev/null

set +e
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: deploy succeeded although the container repo named by the marker is deleted" >&2
  exit 1
fi
if ! echo "${DEPLOY_OUT}" | grep -qF "${CONTAINER_REPO}"; then
  echo "FAIL: hard error does not name the missing repo. Output tail:" >&2
  echo "${DEPLOY_OUT}" | tail -5 >&2
  exit 1
fi
if ! echo "${DEPLOY_OUT}" | grep -qF "cdkd bootstrap"; then
  echo "FAIL: hard error does not point at the 'cdkd bootstrap' fix" >&2
  exit 1
fi
echo "    OK: deploy hard-errored naming the missing repo + re-bootstrap fix"

# --- Phase 5: destroy -------------------------------------------------------
echo "==> Phase 5: destroy (state-driven, unaffected by asset mode)"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> asset-bootstrap test passed (legacy notice, bootstrap resources+marker, cdkd-assets detection, deleted-resource hard error, clean destroy)"
