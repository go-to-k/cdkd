#!/usr/bin/env bash
# verify.sh — cdkd CUSTOM-named asset storage + gc lifecycle integ (issue #1026).
#
# Covers, in ONE deploy/destroy cycle, the two live paths that were only
# manually verified when #1011 (custom asset-storage names, PR #1021) and
# #1012 (`cdkd gc`, PR #1022) shipped:
#
#   Phase 1: `cdkd bootstrap --asset-bucket <unique> --container-repo <unique>`
#            -> custom-named asset bucket + ECR repo created; the bootstrap
#            marker at cdkd-bootstrap/{region}.json carries the CUSTOM names.
#   Phase 2: deploy a stack with a real FILE asset (Lambda Code.fromAsset over
#            a multi-file dir) -> the asset object lands in the CUSTOM bucket,
#            the function's Code.S3Bucket/Code.S3Key in cdkd state point at
#            it, and the deployed Lambda actually runs (invoke + marker).
#   Phase 1b: push three DISTINCT images into the custom container repo, so
#            the ECR half of gc's reference scan has something to scan. Two of
#            them are then referenced from the deployed stack's state through
#            the WIDENED host forms of issues #1792 / #1793 (see Phase 3);
#            the third is left unreferenced as gc's ECR deletion control.
#   Phase 3: seed unreferenced + case-referenced objects into the custom
#            bucket ->
#            `cdkd gc --dry-run --older-than 0.0002h` lists ONLY the two
#            genuinely unreferenced objects + the ONE unreferenced image
#            (never the deploy-referenced asset, never either widened-form-
#            referenced image, never any of the five case-host-referenced
#            objects) and deletes nothing;
#            `cdkd gc --yes --older-than 0.0002h` deletes those three while
#            the referenced asset object, BOTH referenced images and all five
#            case-host-referenced objects survive.
#
#            The two widened references are what make the ECR arm
#            DISCRIMINATING rather than a re-run of the plain path (issues
#            #1792 / #1793): cdkd's own publisher only ever writes
#            `<acct>.dkr.ecr.<region>.amazonaws.com`, so nothing in this repo
#            exercises a non-plain spelling against real AWS. One reference
#            uses an UPPER-cased host AND an UPPER-cased digest — the case
#            that used to be COLLECTED YET UNMATCHABLE against ECR's
#            lower-case `imageDigest`, i.e. the live image was deleted anyway;
#            the other uses the dual-stack FIPS
#            `<acct>.dkr-ecr-fips.<region>.on.aws` form, which the grammar
#            missed entirely. Both assertions are about what SURVIVES, since
#            deletion is the irreversible direction.
#
#            The S3 arm is that arm's sibling (issue #1847), and the same two
#            things make it discriminating. Six references name seeded objects
#            that must SURVIVE: four vary the HOST (an UPPER-cased and a
#            mixed-case spelling of each HTTPS shape), one uses the `S3://`
#            scheme, and one spells the BUCKET itself upper-cased in the
#            VIRTUAL-HOSTED shape, where the bucket is the leftmost DNS label
#            and therefore names the same live object. None of these can be
#            emitted by cdkd's own publisher.
#
#            Two further references spell the bucket upper-cased where it is
#            NOT a DNS label — a path-style PATH segment and an `s3://` URI
#            authority, both compared byte-for-byte by S3 — so they address a
#            bucket that cannot exist and their objects must be DELETED. That
#            pair is the property separating the shipped fix (fold the host,
#            including the virtual-hosted bucket LABEL, but not a path segment
#            or authority) from the blanket `i` flag, which would keep them
#            alive and let any string embedding a case-variant of the bucket
#            name pin its keys forever. Every seeded key is deliberately NOT
#            `<sha256>.<ext>`-shaped, since gc's name-independent content-hash
#            pass protects such keys regardless of host — the accidental
#            rescue #1781 measured at 71 of 72 objects — and would make the
#            whole arm pass without the matchers doing anything.
#   Phase 4: `cdkd destroy` the stack (referenced asset object persists by
#            design — content-addressed storage), then
#            `cdkd bootstrap --destroy --yes` (names read from the marker,
#            NO --force: the deployed-stack reference scan must pass clean)
#            -> custom bucket gone, custom repo gone, marker gone, state gone.
#
# SAFETY NOTE: the pre-run / trap cleanup reads the region's bootstrap marker
# and, when one exists AND its assetBucket carries this fixture's
# `cdkd-integ-gc-` prefix, runs `cdkd bootstrap --destroy --force --yes`
# against it — clearing leftovers from a previous crashed run even though
# their unique names are unknown. A marker owned by anything else (the
# region's default-named storage, another test) is left untouched, and the
# pre-run guard fails fast telling you to pick a marker-free region via
# AWS_REGION.
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

# Shared S3 VERSION helpers (issue #2096); used by the Phase 4b marker-version
# arm below.
. ../s3-versions.sh

STACK="CdkdGcCustomAssetNamesExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
MARKER_KEY="cdkd-bootstrap/${REGION}.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# UNIQUE custom names per run (the S3 bucket namespace is global, and a
# re-run must never collide with a half-deleted previous bucket).
RUN_ID="$(date +%s)"
ASSET_BUCKET="cdkd-integ-gc-${ACCOUNT_ID}-${RUN_ID}"
CONTAINER_REPO="cdkd-integ-gc-repo-${ACCOUNT_ID}-${RUN_ID}"
if [ "${#ASSET_BUCKET}" -gt 63 ]; then
  echo "FAIL: computed asset bucket name '${ASSET_BUCKET}' exceeds 63 chars (${#ASSET_BUCKET})" >&2
  exit 1
fi

GARBAGE_KEY="integ-gc-seeded-garbage.bin"

# S3 host-case arm (issue #1847). The first group is referenced from state
# through a spelling that DOES name the live object and must SURVIVE gc; the
# second is referenced through a bucket-name case variant in a position where
# it names nothing, and must be DELETED.
#
# The split is by the bucket's ROLE in each URL, not by "is it upper-cased":
# in the virtual-hosted shape the bucket is the leftmost label of the HOST and
# host names are case-insensitive, while in path style it is a PATH segment and
# in an `s3://` URI it is the AUTHORITY sent verbatim by the SDK — and S3
# compares both of those byte-for-byte, where an upper-cased bucket name cannot
# even exist.
#
# None of these keys is `<sha256>.<ext>`-shaped on purpose: gc's
# name-independent content-hash pass collects such tokens out of ANY string
# regardless of host, so a content-hash-shaped key would be protected with the
# host matchers completely broken and the whole arm would prove nothing.
S3_CASE_SURVIVOR_KEYS=(
  "gc-integ-s3-virtual-upper.bin"
  "gc-integ-s3-virtual-mixed.bin"
  "gc-integ-s3-path-upper.bin"
  "gc-integ-s3-path-mixed.bin"
  "gc-integ-s3-uri-upper.bin"
  "gc-integ-s3-virtual-bucketcase.bin"
)
S3_BUCKETCASE_DELETED_KEYS=(
  "gc-integ-s3-path-bucketcase.bin"
  "gc-integ-s3-uri-bucketcase.bin"
)

# The plain registry endpoint — the only host `docker login` / `docker push`
# ever use here. The WIDENED spellings below are references in state, not push
# targets: gc reads them out of state, and making the publisher emit one is not
# something cdkd can do (nor should).
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
# Three DISTINCT busybox libc variants, so the three pushed images have three
# distinct manifest digests from one mirrored repo (`docker tag` alone cannot
# produce a new digest). public.ecr.aws avoids Docker Hub rate limits, and
# `destroy-data-guard` already pushes from this same mirror.
SEED_IMAGE_UPPER_REF="public.ecr.aws/docker/library/busybox:glibc"
SEED_IMAGE_FIPS_REF="public.ecr.aws/docker/library/busybox:musl"
SEED_IMAGE_GARBAGE="public.ecr.aws/docker/library/busybox:uclibc"
UPPER_REF_TAG="gc-integ-upper-digest-ref"
FIPS_REF_TAG="gc-integ-dualstack-fips-tag-ref"
GARBAGE_IMAGE_TAG="gc-integ-unreferenced-image"

cleanup() {
  echo "==> Cleanup: dropping stack state/resources + asset storage + marker"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" events prune "${STACK}" --all --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    # Name-agnostic asset-storage teardown: read the region's marker (if
    # any) so leftovers from a PREVIOUS crashed run — whose unique names we
    # cannot recompute — are cleared via `bootstrap --destroy` (names come
    # from the marker). Print what the marker points at before destroying.
    # ONLY markers created by THIS fixture (assetBucket prefixed
    # cdkd-integ-gc-) are auto-destroyed — a default-named or foreign
    # marker means the region's asset storage is genuinely in use, and
    # tearing it down with --force could delete live assets of deployed
    # stacks. Those are left untouched (the pre-run guard below fails
    # fast on them instead).
    MARKER_LEFTOVER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
    if [ -n "${MARKER_LEFTOVER}" ]; then
      LEFTOVER_BUCKET=$(echo "${MARKER_LEFTOVER}" | jq -r '.assetBucket // empty' 2>/dev/null || true)
      echo "    pre-existing bootstrap marker for ${REGION} points at: ${MARKER_LEFTOVER}"
      case "${LEFTOVER_BUCKET}" in
        cdkd-integ-gc-*)
          echo "    destroying the marker's asset storage (leftover from a previous run of this fixture)"
          node "${LOCAL_DIST}" bootstrap --destroy --state-bucket "${STATE_BUCKET}" \
            --region "${REGION}" --force --yes >/dev/null 2>&1
          # Remove the marker key only once its bucket is really gone —
          # on a partial teardown the marker is the only machine-readable
          # record of the previous run's unique names, so keep it for the
          # next attempt instead of orphaning the resources namelessly.
          if [ -n "${LEFTOVER_BUCKET}" ] &&
            ! aws s3api head-bucket --bucket "${LEFTOVER_BUCKET}" >/dev/null 2>&1; then
            aws s3 rm "s3://${STATE_BUCKET}/${MARKER_KEY}" >/dev/null 2>&1
          else
            echo "    WARNING: teardown incomplete; keeping the marker for the next cleanup attempt"
          fi
          ;;
        *)
          echo "    marker is NOT this fixture's (bucket '${LEFTOVER_BUCKET}') — leaving it untouched"
          ;;
      esac
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  fi
  # Belt-and-braces: THIS run's uniquely-named bucket/repo (no-ops when the
  # marker-driven teardown above already removed them).
  aws s3 rb "s3://${ASSET_BUCKET}" --force >/dev/null 2>&1 || true
  aws ecr delete-repository --repository-name "${CONTAINER_REPO}" \
    --region "${REGION}" --force >/dev/null 2>&1 || true
  # Local docker tags from Phase 1b (the REMOTE images go with the repo, which
  # `bootstrap --destroy` / the belt-and-braces delete-repository above force-
  # deletes). Best-effort: this runs inside the `set +eu` span.
  for t in "${UPPER_REF_TAG}" "${FIPS_REF_TAG}" "${GARBAGE_IMAGE_TAG}"; do
    docker rmi "${ECR_HOST}/${CONTAINER_REPO}:${t}" >/dev/null 2>&1
  done
  # The Lambda invoke in Phase 2 auto-creates a /aws/lambda/* log group that
  # neither CFn nor cdkd deletes — sweep it (CDK auto-names the function
  # with the stack name as prefix).
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

if ! docker info >/dev/null 2>&1; then
  echo "FAIL: docker is required (Phase 1b pushes images into the custom ECR repo) but unavailable" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# Fail fast when the region's bootstrap marker belongs to something else
# (default-named storage or another test) — this fixture must own the
# region's marker for its bootstrap/gc/teardown cycle, and destroying a
# foreign marker's storage could delete live assets. Pick another region
# via AWS_REGION instead.
PRE_MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
if [ -n "${PRE_MARKER}" ]; then
  echo "FAIL: region ${REGION} already has a bootstrap marker in use: ${PRE_MARKER}" >&2
  echo "      Run this test in a region without cdkd asset storage (e.g. AWS_REGION=us-west-2)." >&2
  exit 1
fi

# --- Phase 1: bootstrap with CUSTOM names ----------------------------------
echo "==> Phase 1: cdkd bootstrap --asset-bucket ${ASSET_BUCKET} --container-repo ${CONTAINER_REPO}"
node "${LOCAL_DIST}" bootstrap --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --asset-bucket "${ASSET_BUCKET}" --container-repo "${CONTAINER_REPO}"

MARKER=$(aws s3 cp "s3://${STATE_BUCKET}/${MARKER_KEY}" - 2>/dev/null || true)
if [ -z "${MARKER}" ]; then
  echo "FAIL: bootstrap marker missing at s3://${STATE_BUCKET}/${MARKER_KEY}" >&2
  exit 1
fi
if [ "$(echo "${MARKER}" | jq -r '.assetBucket')" != "${ASSET_BUCKET}" ] ||
  [ "$(echo "${MARKER}" | jq -r '.containerRepo')" != "${CONTAINER_REPO}" ]; then
  echo "FAIL: marker does not carry the CUSTOM names: ${MARKER}" >&2
  exit 1
fi
echo "    OK: marker carries the custom assetBucket + containerRepo"

if ! aws s3api head-bucket --bucket "${ASSET_BUCKET}" >/dev/null 2>&1; then
  echo "FAIL: custom asset bucket ${ASSET_BUCKET} was not created" >&2
  exit 1
fi
if ! aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" \
  --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: custom container repo ${CONTAINER_REPO} was not created" >&2
  exit 1
fi
echo "    OK: custom asset bucket + custom ECR repo exist"

# --- Phase 1b: seed the custom container repo with three DISTINCT images ----
echo "==> Phase 1b: pushing three images into ${CONTAINER_REPO}"
aws ecr get-login-password --region "${REGION}" |
  docker login --username AWS --password-stdin "${ECR_HOST}" >/dev/null 2>&1

# Echoes the pushed image's digest. The digest is read back from ECR, not from
# docker: ECR's own `imageDigest` is the exact string gc compares references
# against, so it is the only authoritative spelling here. Every intermediate
# capture carries `|| return 1` because errexit is CLEARED inside `$( )`, so
# without it a failed probe would fall through to the formatting tail and the
# caller would see a successful empty result.
push_seed_image() { # $1 = public source image, $2 = ECR tag
  local src="$1" tag="$2" digest
  docker pull -q "${src}" >/dev/null || return 1
  docker tag "${src}" "${ECR_HOST}/${CONTAINER_REPO}:${tag}" || return 1
  docker push -q "${ECR_HOST}/${CONTAINER_REPO}:${tag}" >/dev/null || return 1
  digest="$(aws ecr describe-images --repository-name "${CONTAINER_REPO}" \
    --image-ids "imageTag=${tag}" --region "${REGION}" \
    --query 'imageDetails[0].imageDigest' --output text)" || return 1
  case "${digest}" in
    sha256:*) ;;
    *)
      echo "FAIL: unexpected imageDigest '${digest}' for tag ${tag}" >&2
      return 1
      ;;
  esac
  printf '%s' "${digest}"
}

UPPER_REF_DIGEST="$(push_seed_image "${SEED_IMAGE_UPPER_REF}" "${UPPER_REF_TAG}")"
FIPS_REF_DIGEST="$(push_seed_image "${SEED_IMAGE_FIPS_REF}" "${FIPS_REF_TAG}")"
GARBAGE_IMAGE_DIGEST="$(push_seed_image "${SEED_IMAGE_GARBAGE}" "${GARBAGE_IMAGE_TAG}")"

# Three distinct digests are load-bearing: the referenced-survives and
# garbage-deleted assertions below are contradictory if any two collide, and the
# failure would read as a cdkd bug rather than as a fixture one.
if [ "${UPPER_REF_DIGEST}" = "${FIPS_REF_DIGEST}" ] ||
  [ "${UPPER_REF_DIGEST}" = "${GARBAGE_IMAGE_DIGEST}" ] ||
  [ "${FIPS_REF_DIGEST}" = "${GARBAGE_IMAGE_DIGEST}" ]; then
  echo "FAIL: the three seeded images do not have distinct digests:" >&2
  echo "      ${UPPER_REF_TAG}=${UPPER_REF_DIGEST}" >&2
  echo "      ${FIPS_REF_TAG}=${FIPS_REF_DIGEST}" >&2
  echo "      ${GARBAGE_IMAGE_TAG}=${GARBAGE_IMAGE_DIGEST}" >&2
  echo "      Pick three SEED_IMAGE_* tags with genuinely different content." >&2
  exit 1
fi
echo "    OK: three distinct images pushed (${UPPER_REF_TAG} / ${FIPS_REF_TAG} / ${GARBAGE_IMAGE_TAG})"

# The two WIDENED references, exported so the stack picks them up as Lambda
# environment values and cdkd's own deploy records them into state.
# 1. UPPER-cased plain host AND UPPER-cased digest. The digest is the point: gc
#    compares a collected digest for EXACT equality against ECR's always
#    lower-case `imageDigest`, so before the insert-time fold this reference was
#    collected and INERT and the live image was still deleted. The REPO path
#    stays verbatim (docker requires a lower-case repository name).
REGION_UPPER="$(printf '%s' "${REGION}" | tr '[:lower:]' '[:upper:]')"
UPPER_REF_DIGEST_UPPER="$(printf '%s' "${UPPER_REF_DIGEST}" | tr '[:lower:]' '[:upper:]')"
export GC_INTEG_UPPER_DIGEST_REF="${ACCOUNT_ID}.DKR.ECR.${REGION_UPPER}.AMAZONAWS.COM/${CONTAINER_REPO}@${UPPER_REF_DIGEST_UPPER}"
# 2. Dual-stack FIPS host (fixed `on.aws` suffix), referenced by TAG — the form
#    BOTH copies of the grammar had been missing (issue #1793).
export GC_INTEG_DUALSTACK_FIPS_TAG_REF="${ACCOUNT_ID}.dkr-ecr-fips.${REGION}.on.aws/${CONTAINER_REPO}:${FIPS_REF_TAG}"
echo "    widened refs: ${GC_INTEG_UPPER_DIGEST_REF}"
echo "                  ${GC_INTEG_DUALSTACK_FIPS_TAG_REF}"

# The S3 host-case references (issue #1847), exported for the same reason as
# the ECR pair above: they enter the TEMPLATE, so cdkd's own deploy writes them
# into `state.properties` and gc's reference scan reads them from exactly where
# it would read a real one. Unlike the ECR digests these are knowable up front
# (they name keys this fixture seeds itself), but they stay here so both
# widened-reference blocks live together.
#
# The first four vary only the HOST around a verbatim bucket name.
BUCKET_UPPER="$(printf '%s' "${ASSET_BUCKET}" | tr '[:lower:]' '[:upper:]')"
export GC_INTEG_S3_VIRTUAL_UPPER_REF="https://${ASSET_BUCKET}.S3.${REGION_UPPER}.AMAZONAWS.COM/${S3_CASE_SURVIVOR_KEYS[0]}"
export GC_INTEG_S3_VIRTUAL_MIXED_REF="https://${ASSET_BUCKET}.S3.${REGION}.AmAzOnAwS.CoM/${S3_CASE_SURVIVOR_KEYS[1]}"
export GC_INTEG_S3_PATH_UPPER_REF="https://S3.${REGION_UPPER}.AMAZONAWS.COM/${ASSET_BUCKET}/${S3_CASE_SURVIVOR_KEYS[2]}"
export GC_INTEG_S3_PATH_MIXED_REF="https://s3.${REGION}.AmAzOnAwS.CoM/${ASSET_BUCKET}/${S3_CASE_SURVIVOR_KEYS[3]}"
export GC_INTEG_S3_URI_UPPER_REF="S3://${ASSET_BUCKET}/${S3_CASE_SURVIVOR_KEYS[4]}"
# Bucket upper-cased where it IS a DNS label. Host names are case-insensitive,
# so this URL reaches the same live object and its key must SURVIVE.
export GC_INTEG_S3_VIRTUAL_BUCKETCASE_REF="https://${BUCKET_UPPER}.s3.${REGION}.amazonaws.com/${S3_CASE_SURVIVOR_KEYS[5]}"
# The two NEGATIVE controls. Everything but the BUCKET NAME is spelled
# canonically, and in these positions the name is compared byte-for-byte, so
# the only thing that could protect these objects is a case-INSENSITIVE bucket
# match where the bucket is not a host label — which the fix deliberately does
# not do.
export GC_INTEG_S3_PATH_BUCKETCASE_REF="https://s3.${REGION}.amazonaws.com/${BUCKET_UPPER}/${S3_BUCKETCASE_DELETED_KEYS[0]}"
export GC_INTEG_S3_URI_BUCKETCASE_REF="s3://${BUCKET_UPPER}/${S3_BUCKETCASE_DELETED_KEYS[1]}"
echo "    S3 case refs (must SURVIVE): ${GC_INTEG_S3_VIRTUAL_UPPER_REF}"
echo "                                 ${GC_INTEG_S3_VIRTUAL_MIXED_REF}"
echo "                                 ${GC_INTEG_S3_PATH_UPPER_REF}"
echo "                                 ${GC_INTEG_S3_PATH_MIXED_REF}"
echo "                                 ${GC_INTEG_S3_URI_UPPER_REF}"
echo "                                 ${GC_INTEG_S3_VIRTUAL_BUCKETCASE_REF}"
echo "    S3 bucket-case controls (must be DELETED): ${GC_INTEG_S3_PATH_BUCKETCASE_REF}"
echo "                                               ${GC_INTEG_S3_URI_BUCKETCASE_REF}"

# --- Phase 2: deploy — FILE asset must land in the CUSTOM bucket ------------
echo "==> Phase 2: deploy (file asset publish -> custom bucket)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null || true)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

FN_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.physicalId] | first')
CODE_BUCKET=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Bucket] | first')
CODE_KEY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.properties.Code.S3Key] | first')
if [ -z "${FN_NAME}" ] || [ "${FN_NAME}" = "null" ]; then
  echo "FAIL: could not resolve the Lambda function name from state" >&2
  echo "${STATE}" | jq . >&2
  exit 1
fi
if [ "${CODE_BUCKET}" != "${ASSET_BUCKET}" ]; then
  echo "FAIL: state Code.S3Bucket is '${CODE_BUCKET}', expected the CUSTOM bucket '${ASSET_BUCKET}'" >&2
  exit 1
fi
if [ -z "${CODE_KEY}" ] || [ "${CODE_KEY}" = "null" ]; then
  echo "FAIL: state Code.S3Key is empty" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: referenced asset object s3://${ASSET_BUCKET}/${CODE_KEY} does not exist" >&2
  exit 1
fi
echo "    OK: state Code points at s3://${ASSET_BUCKET}/${CODE_KEY} and the object exists"

# The widened references must be IN state before Phase 3 can claim anything
# about them. Without this, a broken env-var hand-off would leave the survival
# assertions passing vacuously: an image nothing references at all also
# "survives" whenever the age guard or the repo scan silently no-ops.
for ref in "${GC_INTEG_UPPER_DIGEST_REF}" "${GC_INTEG_DUALSTACK_FIPS_TAG_REF}" \
  "${GC_INTEG_S3_VIRTUAL_UPPER_REF}" "${GC_INTEG_S3_VIRTUAL_MIXED_REF}" \
  "${GC_INTEG_S3_PATH_UPPER_REF}" "${GC_INTEG_S3_PATH_MIXED_REF}" \
  "${GC_INTEG_S3_URI_UPPER_REF}" "${GC_INTEG_S3_VIRTUAL_BUCKETCASE_REF}" \
  "${GC_INTEG_S3_PATH_BUCKETCASE_REF}" "${GC_INTEG_S3_URI_BUCKETCASE_REF}"; do
  if ! printf '%s' "${STATE}" | grep -qF "${ref}"; then
    echo "FAIL: widened reference is not in the deployed state: ${ref}" >&2
    printf '%s' "${STATE}" | jq '.resources' >&2
    exit 1
  fi
done
echo "    OK: both widened-form ECR references and all eight S3 case references are recorded in cdkd state"

# Functional assertion: the deployed Lambda actually runs the uploaded asset.
OUT_FILE="$(mktemp)"
trap 'rm -f "${OUT_FILE}"; cleanup' EXIT
trap 'rm -f "${OUT_FILE}"; (exit 130); cleanup; exit 130' INT
trap 'rm -f "${OUT_FILE}"; (exit 143); cleanup; exit 143' TERM
aws lambda invoke \
  --function-name "${FN_NAME}" --region "${REGION}" \
  --cli-binary-format raw-in-base64-out \
  --payload '{}' \
  "${OUT_FILE}" >/dev/null
RESP_MARKER=$(jq -r '.marker // empty' "${OUT_FILE}")
if [ "${RESP_MARKER}" != "cdkd-gc-custom-asset-names-marker-v1" ]; then
  echo "FAIL: Lambda invoke marker is '${RESP_MARKER}', expected 'cdkd-gc-custom-asset-names-marker-v1'. Raw response:" >&2
  cat "${OUT_FILE}" >&2
  exit 1
fi
echo "    OK: Lambda invoke returned the asset marker (uploaded ZIP is the running code)"

# --- Phase 3: gc — seeded garbage deleted, referenced asset kept ------------
echo "==> Phase 3: seed unreferenced object + cdkd gc"
printf 'seeded unreferenced garbage for the cdkd gc integ\n' |
  aws s3 cp - "s3://${ASSET_BUCKET}/${GARBAGE_KEY}"
# The S3 host-case objects (issue #1847). These are seeded HERE, alongside the
# garbage object and BEFORE the sleep below, so every one of them is strictly
# older than the age cutoff when gc lists the bucket — an object newer than the
# cutoff is kept by the age guard alone, which would make every survival
# assertion below pass without the matchers being consulted at all.
for key in "${S3_CASE_SURVIVOR_KEYS[@]}" "${S3_BUCKETCASE_DELETED_KEYS[@]}"; do
  printf 'seeded object for the cdkd gc S3 host-case arm (issue #1847)\n' |
    aws s3 cp - "s3://${ASSET_BUCKET}/${key}"
done
# --older-than 0.0002h (~0.72s) age guard: sleep so the seeded object is
# strictly older than the cutoff when gc lists the bucket. 5s (not 2s)
# keeps the margin clock-skew-proof — gc compares local Date.now()
# against S3's AWS-stamped LastModified.
sleep 5

if ! DRY_OUT=$(node "${LOCAL_DIST}" gc --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --older-than 0.0002h --dry-run 2>&1); then
  echo "FAIL: gc --dry-run exited non-zero. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
echo "${DRY_OUT}" | tail -5

if ! echo "${DRY_OUT}" | grep -qF "s3://${ASSET_BUCKET}/${GARBAGE_KEY}"; then
  echo "FAIL: gc --dry-run plan does not list the seeded garbage object. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if echo "${DRY_OUT}" | grep -qF "${CODE_KEY}"; then
  echo "FAIL: gc --dry-run plan lists the deploy-referenced asset ${CODE_KEY} — it would delete a live asset. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if ! echo "${DRY_OUT}" | grep -qF "Total: 3 S3 object(s)"; then
  echo "FAIL: gc --dry-run plan should contain exactly 3 S3 candidates (the seeded garbage + the two bucket-case controls). Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
# The S3 host-case arm, in the plan (issue #1847). The six objects named by a
# spelling that really reaches them must not be candidates at all, and the two
# named through a bucket-case variant in a byte-compared position MUST be — a
# run that simply protected everything would satisfy the six survivals alone.
for key in "${S3_CASE_SURVIVOR_KEYS[@]}"; do
  if echo "${DRY_OUT}" | grep -qF "${key}"; then
    echo "FAIL: gc --dry-run plan lists ${key}, which IS referenced by a spelling that names the live object (issue #1847) — it would delete it. Output:" >&2
    echo "${DRY_OUT}" >&2
    exit 1
  fi
done
for key in "${S3_BUCKETCASE_DELETED_KEYS[@]}"; do
  if ! echo "${DRY_OUT}" | grep -qF "${key}"; then
    echo "FAIL: gc --dry-run plan does not list ${key}, whose only reference spells the BUCKET upper-cased where S3 compares it byte-for-byte — folding the bucket name there would pin any object forever (issue #1847). Output:" >&2
    echo "${DRY_OUT}" >&2
    exit 1
  fi
done
# ONE ECR candidate: the unreferenced image. The two images referenced through
# the WIDENED host forms must not be candidates at all.
if ! echo "${DRY_OUT}" | grep -qF "1 ECR image(s)"; then
  echo "FAIL: gc --dry-run plan should contain exactly 1 ECR candidate (the unreferenced image). Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
if ! echo "${DRY_OUT}" | grep -qF "${GARBAGE_IMAGE_DIGEST}"; then
  echo "FAIL: gc --dry-run plan does not list the unreferenced image ${GARBAGE_IMAGE_DIGEST}. Output:" >&2
  echo "${DRY_OUT}" >&2
  exit 1
fi
# Two explicit args, never a `<digest>:<label>` pack: an ECR digest is itself
# `sha256:<hex>`, so a `${packed%%:*}` split yields the literal `sha256`, which
# appears in every plan line — the assertion then false-FAILs unconditionally
# (and `${packed#*:}` reports a nonsense label). Same trap as cdkd's own
# unescaped composite-id separator (issue #1672).
assert_widened_ref_not_a_candidate() { # usage: <digest> <what it exercises>
  if echo "${DRY_OUT}" | grep -qF "$1"; then
    echo "FAIL: gc --dry-run plan lists $1, which IS referenced through a widened host form ($2) — it would delete a live image. Output:" >&2
    echo "${DRY_OUT}" >&2
    exit 1
  fi
}
assert_widened_ref_not_a_candidate "${UPPER_REF_DIGEST}" \
  "UPPER-cased host + UPPER-cased digest, tag ${UPPER_REF_TAG} (issue #1792)"
assert_widened_ref_not_a_candidate "${FIPS_REF_DIGEST}" \
  "dual-stack FIPS on.aws host, tag ${FIPS_REF_TAG} (issue #1793)"
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${GARBAGE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: gc --dry-run DELETED the seeded object (dry run must not delete)" >&2
  exit 1
fi
echo "    OK: dry-run plan lists ONLY the unreferenced set (3 S3 objects, 1 ECR image) and deleted nothing"

echo "==> Phase 3b: cdkd gc --yes (real deletion)"
node "${LOCAL_DIST}" gc --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --older-than 0.0002h --yes

assert_gone "seeded garbage object still exists after gc --yes" aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${GARBAGE_KEY}"
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: gc deleted the deploy-referenced asset s3://${ASSET_BUCKET}/${CODE_KEY}" >&2
  exit 1
fi

# The load-bearing ECR assertions — about what SURVIVES, since a deletion here
# is irreversible. Pre-fix, the UPPER-cased-digest reference was collected in a
# spelling that could never match ECR's lower-case `imageDigest`, so this image
# was DELETED while gc reported success.
assert_gone "unreferenced image ${GARBAGE_IMAGE_DIGEST} still exists after gc --yes" \
  aws ecr describe-images --repository-name "${CONTAINER_REPO}" \
  --image-ids "imageDigest=${GARBAGE_IMAGE_DIGEST}" --region "${REGION}"
# Two explicit args for the same reason as the dry-run helper above: packing
# `<digest>:<label>` and splitting on the first colon would query
# `imageDigest=sha256`, which ECR rejects — reporting "gc DELETED a live image"
# when nothing was deleted.
assert_widened_ref_survived() { # usage: <digest> <what it exercises>
  if ! aws ecr describe-images --repository-name "${CONTAINER_REPO}" \
    --image-ids "imageDigest=$1" --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: gc DELETED a live image referenced via $2: $1" >&2
    exit 1
  fi
}
assert_widened_ref_survived "${UPPER_REF_DIGEST}" \
  "UPPER-cased host + UPPER-cased digest (issue #1792)"
assert_widened_ref_survived "${FIPS_REF_DIGEST}" \
  "dual-stack FIPS on.aws host + tag (issue #1793)"

# The S3 host-case arm, after the real deletion (issue #1847). Same posture as
# the ECR pair: the load-bearing assertions are about what SURVIVES, and the
# two bucket-case controls' DELETION is what stops the six survivals from being
# satisfiable by a gc that deleted nothing.
for key in "${S3_CASE_SURVIVOR_KEYS[@]}"; do
  if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${key}" >/dev/null 2>&1; then
    echo "FAIL: gc DELETED a live object whose reference really names it (issue #1847): s3://${ASSET_BUCKET}/${key}" >&2
    exit 1
  fi
done
for key in "${S3_BUCKETCASE_DELETED_KEYS[@]}"; do
  assert_gone "object ${key} still exists after gc --yes — its only reference spells the BUCKET upper-cased where S3 compares it byte-for-byte, so folding the bucket name there has turned gc into a no-op for it (issue #1847)" \
    aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${key}"
done
echo "    OK: gc deleted the unreferenced object + image + both bucket-case controls, and KEPT both widened-form images and all six really-referenced objects"

# --- Phase 4: destroy stack, then bootstrap --destroy ------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# Content-addressed asset storage is never deleted on `cdkd destroy` (a
# rollback or another stack may reference the same hash) — the object must
# survive until `bootstrap --destroy` empties the bucket.
if ! aws s3api head-object --bucket "${ASSET_BUCKET}" --key "${CODE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: asset object s3://${ASSET_BUCKET}/${CODE_KEY} vanished on destroy (content-addressed storage must persist)" >&2
  exit 1
fi
echo "    OK: stack + state gone; content-addressed asset object persists (by design)"

echo "==> Phase 4b: cdkd bootstrap --destroy (names read from the marker, no --force)"
# --region is spelled UPPER-CASED here on purpose (issue #1995), and it costs
# nothing: the marker was written by Phase 1 under the canonical spelling, so
# this run exercises the canonicalize-then-probe path against real AWS through
# the teardown this fixture already performs. Pre-fix it found no marker at
# `cdkd-bootstrap/US-EAST-1.json`, printed "nothing to delete", exited 0 — and
# left the bucket and repository alive, which the three assert_gone probes
# below now catch.
#
# The OTHER arm — a marker written under a raw upper-cased region — cannot be
# reached from here without a second real bootstrap cycle, which is not worth a
# whole extra bucket + repo + push; it is covered by unit test instead
# ("destroys the storage a RAW upper-cased marker names, and deletes THAT key").
# --- PREMISE for the marker-version arm below (issue #2346 site 6) ---------
# The arm certifies that the marker's history is gone after the teardown. An
# absence is also what a run that never bootstrapped would show, so establish
# here -- while the marker is still a live object -- that there IS a body for
# the purge to remove. The helper's tri-state separates "zero" from "could not
# list": it returns 1 on a failed LIST.
if ! MARKER_ROWS_BEFORE="$(s3_count_key_versions "${STATE_BUCKET}" "${MARKER_KEY}" all)"; then
  echo "FAIL: could not list object versions for s3://${STATE_BUCKET}/${MARKER_KEY}." >&2
  echo "      The post-teardown version assertion would be unverifiable, so failing here instead." >&2
  exit 1
fi
if [ "${MARKER_ROWS_BEFORE}" -lt 1 ]; then
  echo "FAIL: the bootstrap marker key holds ${MARKER_ROWS_BEFORE} version row(s) before the teardown," >&2
  echo "      so the assertion after it would certify a purge that had nothing to purge." >&2
  exit 1
fi
echo "    premise: marker key holds ${MARKER_ROWS_BEFORE} version row(s) before the teardown"

node "${LOCAL_DIST}" bootstrap --destroy --state-bucket "${STATE_BUCKET}" \
  --region "${REGION_UPPER}" --yes

assert_gone "custom asset bucket ${ASSET_BUCKET} still exists after bootstrap --destroy" aws s3api head-bucket --bucket "${ASSET_BUCKET}"
assert_gone "custom container repo ${CONTAINER_REPO} still exists after bootstrap --destroy" aws ecr describe-repositories --repository-names "${CONTAINER_REPO}" --region "${REGION}"
assert_gone "bootstrap marker ${MARKER_KEY} still exists after bootstrap --destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${MARKER_KEY}"

# The `assert_gone` above is a `head-object` probe, and on a VERSIONED bucket
# that answers 404 as soon as a DELETE MARKER exists -- every earlier body of
# the marker stays readable through `GetObject --version-id`. It therefore
# passes identically with issue #2346's site-6 purge reverted. This is the arm
# that does not.
#
# `all == 1` rather than "nothing survives", for the same reason as the journal
# arm in tests/integration/rollback-command/verify.sh: an absence is also what
# a run that never bootstrapped shows. Exactly one surviving row can only be
# the CURRENT delete marker cdkd's own delete wrote, since the purge filters on
# `IsLatest` and can never remove it. Reverted, the marker body written in
# Phase 1 survives alongside it and both counts rise.
if ! MARKER_ROWS_AFTER="$(s3_count_key_versions "${STATE_BUCKET}" "${MARKER_KEY}" all)"; then
  echo "FAIL: could not list object versions for s3://${STATE_BUCKET}/${MARKER_KEY} after the teardown." >&2
  echo "      An unverified purge is not a verified purge - failing rather than assuming." >&2
  exit 1
fi
if ! MARKER_NONCURRENT_AFTER="$(s3_count_key_versions "${STATE_BUCKET}" "${MARKER_KEY}" noncurrent)"; then
  echo "FAIL: could not list noncurrent versions for s3://${STATE_BUCKET}/${MARKER_KEY}." >&2
  exit 1
fi
if [ "${MARKER_ROWS_AFTER}" -ne 1 ] || [ "${MARKER_NONCURRENT_AFTER}" -ne 0 ]; then
  echo "FAIL: after bootstrap --destroy the marker key holds ${MARKER_ROWS_AFTER} row(s)" >&2
  echo "      (${MARKER_NONCURRENT_AFTER} noncurrent); expected exactly 1 row, the current delete marker," >&2
  echo "      and 0 noncurrent. ${MARKER_ROWS_BEFORE} row(s) existed before the teardown, so the marker" >&2
  echo "      body was really there to be removed. Inspect with:" >&2
  echo "        aws s3api list-object-versions --bucket ${STATE_BUCKET} --prefix ${MARKER_KEY}" >&2
  exit 1
fi
echo "    OK: marker key down to 1 row (the current delete marker), 0 noncurrent (issue #2346 site 6)"

# NEGATIVE CONTROL: a state-bucket key issue #2346 deliberately does NOT purge
# must keep its history, or the assertion above is equally satisfied by a
# purge-everything bug. `state.json` is sites 1-3, left unfixed ON PURPOSE --
# its noncurrent versions ARE the state-recovery capability versioning is
# enabled for -- and it is documented as never-purged in three places, so it is
# the key most likely to break LOUDLY if a future purge over-reaches. This
# fixture deployed and destroyed the stack, so its history is guaranteed
# non-empty rather than merely likely (`cdkd destroy` delete-markers the key;
# the bodies underneath stay).
#
# THIS CONTROL USED TO BE `lock.json`, AND HAD TO MOVE. Site 5 now purges the
# lock key on every release, so `LOCK_NONCURRENT >= 1` stopped discriminating
# -- and worse, it would have kept PASSING on accumulated delete markers from
# an un-reaped crash while its comment ("as site 5 intends") became false: a
# fixture that is green and meaningless. The lock invariant is asserted below
# instead, so the pair still fences both directions.
if ! STATE_NONCURRENT="$(s3_count_key_versions "${STATE_BUCKET}" "${STATE_KEY}" noncurrent)"; then
  echo "FAIL: could not list noncurrent versions for s3://${STATE_BUCKET}/${STATE_KEY}." >&2
  echo "      Without this count the marker assertion cannot be told apart from a purge-everything bug." >&2
  exit 1
fi
if [ "${STATE_NONCURRENT}" -lt 1 ]; then
  echo "FAIL: state.json has ${STATE_NONCURRENT} noncurrent version(s) after this fixture's deploy +" >&2
  echo "      destroy cycle. Either a purge is running on keys issue #2346 sites 1-3 exclude - which" >&2
  echo "      would destroy the state-recovery capability - or state is no longer written per deploy." >&2
  echo "      Both make the marker assertion meaningless." >&2
  exit 1
fi
echo "    OK: ${STATE_NONCURRENT} noncurrent state.json version(s) survive, as sites 1-3 intend"

# POSITIVE assertion for issue #2346 SITE 5, the twin of the marker arm above.
# The last stack-scoped cdkd command was `cdkd destroy`, which released the
# lock, so the key must be down to exactly one row -- the CURRENT delete marker
# that release wrote, which the purge can never remove because it filters on
# `IsLatest`. `all == 1` rather than "nothing survives", for the same reason the
# marker arm gives: an absence is also what a run that never acquired a lock
# shows. Reverted, the acquire body and every renewal body survive alongside it.
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
if ! LOCK_ALL="$(s3_count_key_versions "${STATE_BUCKET}" "${LOCK_KEY}" all)"; then
  echo "FAIL: could not list object versions for s3://${STATE_BUCKET}/${LOCK_KEY}." >&2
  echo "      An unverified purge is not a verified purge - failing rather than assuming." >&2
  exit 1
fi
if ! LOCK_NONCURRENT="$(s3_count_key_versions "${STATE_BUCKET}" "${LOCK_KEY}" noncurrent)"; then
  echo "FAIL: could not list noncurrent versions for s3://${STATE_BUCKET}/${LOCK_KEY}." >&2
  exit 1
fi
if [ "${LOCK_ALL}" -ne 1 ] || [ "${LOCK_NONCURRENT}" -ne 0 ]; then
  echo "FAIL: after this fixture's deploy + destroy cycle the lock key holds ${LOCK_ALL} row(s)" >&2
  echo "      (${LOCK_NONCURRENT} noncurrent); expected exactly 1 row, the current delete marker the" >&2
  echo "      last release wrote, and 0 noncurrent. Before issue #2346 site 5 this key was the" >&2
  echo "      fastest-growing object in the bucket (452 versions measured on one key). Inspect with:" >&2
  echo "        aws s3api list-object-versions --bucket ${STATE_BUCKET} --prefix ${LOCK_KEY}" >&2
  exit 1
fi
echo "    OK: lock key down to 1 row (the current delete marker), 0 noncurrent (issue #2346 site 5)"
echo "    OK: custom bucket gone, custom repo gone, marker gone — zero residue (teardown driven by an UPPER-cased --region, issue #1995)"

echo "[verify] PASS — custom-named asset storage bootstrap, publish-to-custom-bucket, gc dry-run/delete precision (incl. the ECR and S3 case-varied host arms and the bucket-name-exactness control), and marker-driven teardown all verified"
