#!/usr/bin/env bash
# verify.sh — cdkd S3 replication combined-And-filter integ.
#
# An S3 bucket whose replication rule uses a COMBINED filter (a prefix AND a
# tag), which CFn/CDK express only via `Filter.And { Prefix, TagFilters[] }`.
# cdkd's S3 provider previously read only top-level `Filter.Prefix` /
# `Filter.TagFilter` and never `Filter.And`, so the combined filter silently
# collapsed to an empty `Filter: {}` (replicate EVERY object) — a scope-
# broadening divergence. This verifies the And filter reaches AWS verbatim.
#
# Phases:
#   1. Deploy; assert GetBucketReplication returns the rule with
#      Filter.And.Prefix='logs/' AND Filter.And.Tags carrying replicate=yes
#      (NOT an empty filter / replicate-all).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (And prefix logs/ -> data/); assert
#      the new prefix reached AWS via an in-place PutBucketReplication (the
#      source bucket was NOT replaced) and the tag filter is still present.
#   3. Destroy; assert both buckets are gone and the state file is removed.
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
gone_probe() { # usage: gone_probe aws <service> <read-verb> [args...]
  local out
  if out="$("$@" 2>&1)"; then
    return 1
  fi
  if ! printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|404'; then
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

STACK="CdkdS3ReplicationAndFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SRC_BUCKET="cdkd-repl-src-${ACCOUNT_ID}"
DST_BUCKET="cdkd-repl-dst-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Replication config must go before the source bucket can be deleted cleanly.
  aws s3api delete-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${SRC_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${DST_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy baseline (And filter: prefix logs/ + tag replicate=yes) ---
echo "==> Phase 1: deploy source+dest buckets with a combined And replication filter"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

AND_PREFIX_P1="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Filter.And.Prefix" --output text)"
AND_TAG_KEY_P1="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Filter.And.Tags[0].Key" --output text)"
AND_TAG_VAL_P1="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Filter.And.Tags[0].Value" --output text)"
if [ "${AND_PREFIX_P1}" != "logs/" ] || [ "${AND_TAG_KEY_P1}" != "replicate" ] || [ "${AND_TAG_VAL_P1}" != "yes" ]; then
  echo "FAIL: expected Filter.And{Prefix=logs/, Tag replicate=yes}, got prefix=${AND_PREFIX_P1} tag=${AND_TAG_KEY_P1}=${AND_TAG_VAL_P1}" >&2
  echo "      (pre-fix bug: And filter dropped -> empty filter -> replicate-all)" >&2
  exit 1
fi
echo "    And filter reached AWS: prefix=logs/ + tag replicate=yes (NOT replicate-all)"

CREATION_P1="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${SRC_BUCKET}'].CreationDate | [0]" --output text)"
echo "    baseline source-bucket CreationDate=${CREATION_P1}"

# --- Phase 2: in-place UPDATE (And prefix logs/ -> data/) ----------------
echo "==> Phase 2: re-deploy (And prefix logs/ -> data/, tag unchanged)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

AND_PREFIX_P2="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Filter.And.Prefix" --output text)"
AND_TAG_KEY_P2="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Filter.And.Tags[0].Key" --output text)"
if [ "${AND_PREFIX_P2}" != "data/" ] || [ "${AND_TAG_KEY_P2}" != "replicate" ]; then
  echo "FAIL: expected And.Prefix=data/ + tag replicate after UPDATE, got prefix=${AND_PREFIX_P2} tag=${AND_TAG_KEY_P2}" >&2
  exit 1
fi
echo "    And filter updated in place: prefix=data/, tag replicate still present"

CREATION_P2="$(aws s3api list-buckets \
  --query "Buckets[?Name=='${SRC_BUCKET}'].CreationDate | [0]" --output text)"
if [ "${CREATION_P1}" != "${CREATION_P2}" ]; then
  echo "FAIL: source bucket was REPLACED (CreationDate ${CREATION_P1} -> ${CREATION_P2})" >&2
  exit 1
fi
echo "    source bucket identity preserved (CreationDate unchanged) — no replacement"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for b in "${SRC_BUCKET}" "${DST_BUCKET}"; do
  assert_gone "bucket ${b} still exists after destroy" aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
echo "    both buckets deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 replication combined And filter CREATE + in-place UPDATE + destroy, all 3 phases passed"
