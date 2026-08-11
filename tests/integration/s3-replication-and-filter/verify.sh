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
# It ALSO carries the issue #1495 read-backs: five nested blocks the S3 provider
# never assembled at all (TargetObjectKeyFormat, Destination.ReplicationTime +
# Metrics, SourceSelectionCriteria, TransitionDefaultMinimumObjectSize). Those
# are write-side silent drops — nothing errored, the field just never left the
# process — so reading them back off the live bucket is the ONLY proof of
# delivery.
#
# Issue #1523 added the two SSE-KMS members #1495 had deferred:
# Destination.EncryptionConfiguration.ReplicaKmsKeyID and its required partner
# SourceSelectionCriteria.SseKmsEncryptedObjects. They were deferred on the
# belief that their customer-managed key would leave a pending-deletion ORPHAN
# behind every run; that premise was wrong. A PendingDeletion key is the
# AWS-mandated terminal state of a deleted key — a key cannot be deleted
# synchronously at all — and loggroup-kms-associate / propagation-races-2 /
# s3-vectors already assert exactly that as the expected post-destroy outcome.
# Phase 3 asserts it here too.
#
# Destination.AccessControlTranslation.Owner stays unit-only and is NOT a
# follow-up: `Owner: Destination` is an ownership OVERRIDE that is only
# meaningful when the destination bucket is in a DIFFERENT account, so a
# same-account fixture could assert nothing real no matter how it is written.
# Closing it needs a second AWS account, not more fixture work.
#
# Phases:
#   1. Deploy; assert GetBucketReplication returns the rule with
#      Filter.And.Prefix='logs/' AND Filter.And.Tags carrying replicate=yes
#      (NOT an empty filter / replicate-all), plus the five #1495 read-backs,
#      plus `cdkd drift` clean (issue #1530 — the READ side of the #1495
#      blocks must reassemble what AWS returns, not report phantom drift).
#   2. Re-deploy with CDKD_TEST_UPDATE=true (And prefix logs/ -> data/); assert
#      the new prefix reached AWS via an in-place PutBucketReplication (the
#      source bucket was NOT replaced) and the tag filter is still present,
#      then `cdkd drift` clean again on the updated state.
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

# --- issue #1530: read-side drift proof --------------------------------------
# The #1495 read-backs prove the WRITE side delivered each nested block. This
# proves the READ side: `readCurrentState` must reassemble the live config into
# the same shape the deploy captured, so `cdkd drift` reports the stack clean
# immediately after a deploy. The phantom-drift candidate is a sub-block AWS
# returns that the template never declared: drift-calculator.ts compares arrays
# WHOLESALE, so one extra observed member flags the entire Rules array as
# drifted. This block was originally written around
# `SourceSelectionCriteria.SseKmsEncryptedObjects` as that example — and issue
# #1523 made the template DECLARE it, so within the Rules array what this now
# tests is the OTHER direction: a declared nested member the read side fails to
# reassemble. That is a swap, not an addition. Whether any undeclared-observed
# member survives elsewhere in this bucket (the other top-level blocks are
# still compared) has NOT been measured, so do not read this block as covering
# both directions at once.
# Exit 0 alone is NOT sufficient — an unsupported/skipped SourceBucket also
# exits 0 — so the by-name check asserts the bucket was CHECKED and clean.
assert_drift_clean() { # usage: assert_drift_clean "<phase label>"
  local phase="$1" rc=0 json
  set +e
  json="$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --json)"
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: expected no drift ${phase}, cdkd drift exited ${rc} — phantom drift on the newly-read S3 nested blocks (issue #1530):" >&2
    printf '%s\n' "${json}" >&2
    exit 1
  fi
  local clean_count
  clean_count="$(printf '%s' "${json}" | jq -r '[.[].clean[] | select(.logicalId | startswith("SourceBucket"))] | length')"
  if [ "${clean_count}" != "1" ]; then
    echo "FAIL: SourceBucket not reported CLEAN by cdkd drift ${phase} (an unsupported/skipped bucket would mask a read-side gap):" >&2
    printf '%s\n' "${json}" >&2
    exit 1
  fi
  echo "    cdkd drift clean ${phase} — SourceBucket checked + clean (issue #1530)"
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

STACK="CdkdS3ReplicationAndFilterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SRC_BUCKET="cdkd-repl-src-${ACCOUNT_ID}"
DST_BUCKET="cdkd-repl-dst-${ACCOUNT_ID}"
LOG_BUCKET="cdkd-repl-log-${ACCOUNT_ID}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Replication config must go before the source bucket can be deleted cleanly.
  aws s3api delete-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${SRC_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${DST_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  # The log bucket can receive a server-access-log object at any point after the
  # run, so empty it before the delete rather than leaving a stuck bucket.
  aws s3 rm "s3://${LOG_BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${LOG_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- issue #1495: blocks the provider never built at all ---------------------
# Each of these has a same-spelled member in @aws-sdk/client-s3 and was simply
# never assembled, so the deploy reported success with the setting missing.
# Only a read-back off the live bucket can prove delivery.
KEY_FORMAT="$(aws s3api get-bucket-logging --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "LoggingEnabled.TargetObjectKeyFormat.PartitionedPrefix.PartitionDateSource" --output text)"
if [ "${KEY_FORMAT}" != "EventTime" ]; then
  echo "FAIL: expected LoggingEnabled.TargetObjectKeyFormat.PartitionedPrefix.PartitionDateSource=EventTime, got ${KEY_FORMAT}" >&2
  echo "      (pre-fix bug #1495: TargetObjectKeyFormat never built -> flat default key format)" >&2
  exit 1
fi
echo "    TargetObjectKeyFormat.PartitionedPrefix reached AWS (issue #1495)"

RTC_STATUS="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Destination.ReplicationTime.Status" --output text)"
RTC_MINUTES="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Destination.ReplicationTime.Time.Minutes" --output text)"
METRICS_STATUS="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Destination.Metrics.Status" --output text)"
METRICS_MINUTES="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Destination.Metrics.EventThreshold.Minutes" --output text)"
if [ "${RTC_STATUS}" != "Enabled" ] || [ "${RTC_MINUTES}" != "15" ] || \
   [ "${METRICS_STATUS}" != "Enabled" ] || [ "${METRICS_MINUTES}" != "15" ]; then
  echo "FAIL: expected Replication Time Control (ReplicationTime + Metrics, 15 min each), got rtc=${RTC_STATUS}/${RTC_MINUTES} metrics=${METRICS_STATUS}/${METRICS_MINUTES}" >&2
  echo "      (pre-fix bug #1495: both blocks dropped -> plain async replication, no RTC SLA)" >&2
  exit 1
fi
echo "    Destination.ReplicationTime + Metrics reached AWS — RTC is really on (issue #1495)"

SSC_STATUS="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].SourceSelectionCriteria.ReplicaModifications.Status" --output text)"
if [ "${SSC_STATUS}" != "Enabled" ]; then
  echo "FAIL: expected SourceSelectionCriteria.ReplicaModifications.Status=Enabled, got ${SSC_STATUS}" >&2
  echo "      (pre-fix bug #1495: the whole block dropped -> a different object set replicated)" >&2
  exit 1
fi
echo "    SourceSelectionCriteria.ReplicaModifications reached AWS (issue #1495)"

# --- issue #1523: the two SSE-KMS members #1495 deferred ---------------------
# AWS requires the pair together, so they are asserted together. The key ARN is
# run-specific, so it is read out of cdkd state rather than compared against a
# literal — and the state read doubles as the source for the phase-3
# PendingDeletion probe.
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
REPLICA_KEY_ARN="$(printf '%s' "${STATE_JSON}" | jq -r '.outputs.ReplicaKeyArn // ""')"
if [ -z "${REPLICA_KEY_ARN}" ] || [ "${REPLICA_KEY_ARN}" = "null" ]; then
  echo "FAIL: cdkd state did not emit a ReplicaKeyArn output" >&2
  printf '%s\n' "${STATE_JSON}" | jq .outputs >&2
  exit 1
fi

REPLICA_KMS="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].Destination.EncryptionConfiguration.ReplicaKmsKeyID" --output text)"
if [ "${REPLICA_KMS}" != "${REPLICA_KEY_ARN}" ]; then
  echo "FAIL: expected Destination.EncryptionConfiguration.ReplicaKmsKeyID=${REPLICA_KEY_ARN}, got ${REPLICA_KMS}" >&2
  echo "      (pre-fix bug #1495: the block was never built -> replicas encrypted with the bucket default, not the declared key)" >&2
  exit 1
fi
echo "    Destination.EncryptionConfiguration.ReplicaKmsKeyID reached AWS (issue #1523)"

SSE_KMS_STATUS="$(aws s3api get-bucket-replication --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "ReplicationConfiguration.Rules[0].SourceSelectionCriteria.SseKmsEncryptedObjects.Status" --output text)"
if [ "${SSE_KMS_STATUS}" != "Enabled" ]; then
  echo "FAIL: expected SourceSelectionCriteria.SseKmsEncryptedObjects.Status=Enabled, got ${SSE_KMS_STATUS}" >&2
  echo "      (pre-fix bug #1495: dropped -> SSE-KMS source objects silently excluded from replication)" >&2
  exit 1
fi
echo "    SourceSelectionCriteria.SseKmsEncryptedObjects reached AWS (issue #1523)"

MIN_SIZE="$(aws s3api get-bucket-lifecycle-configuration --bucket "${SRC_BUCKET}" --region "${REGION}" \
  --query "TransitionDefaultMinimumObjectSize" --output text)"
# The NON-default value on purpose: AWS defaults new buckets to
# `all_storage_classes_128K`, so asserting that would pass with the write
# removed. `varies_by_storage_class` can only be there because cdkd sent it.
if [ "${MIN_SIZE}" != "varies_by_storage_class" ]; then
  echo "FAIL: expected TransitionDefaultMinimumObjectSize=varies_by_storage_class, got ${MIN_SIZE}" >&2
  echo "      (pre-fix bug #1495: it lives on the PUT REQUEST, not inside LifecycleConfiguration, so the rules-only mapper never sent it)" >&2
  exit 1
fi
echo "    LifecycleConfiguration.TransitionDefaultMinimumObjectSize reached AWS (issue #1495)"

assert_drift_clean "after the phase-1 deploy"

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

assert_drift_clean "after the phase-2 update"

# --- Phase 3: destroy ----------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for b in "${SRC_BUCKET}" "${DST_BUCKET}" "${LOG_BUCKET}"; do
  assert_gone "bucket ${b} still exists after destroy" aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
echo "    all three buckets deleted"

# Issue #1523. A customer-managed key cannot be deleted synchronously — the
# minimum pending window is 7 days — so PendingDeletion IS the terminal state
# of a deleted key, not an orphan. The stderr capture distinguishes a genuine
# NotFound (an already-elapsed window from an earlier run) from a probe failure
# that must abort rather than masquerade as a deleted key.
KEY_STATE="$(aws kms describe-key --key-id "${REPLICA_KEY_ARN}" --region "${REGION}" \
  --query 'KeyMetadata.KeyState' --output text 2>&1)" || {
  if echo "${KEY_STATE}" | grep -q "NotFoundException"; then
    KEY_STATE="GONE"
  else
    echo "FAIL: describe-key failed unexpectedly: ${KEY_STATE}" >&2
    exit 1
  fi
}
if [ "${KEY_STATE}" != "PendingDeletion" ] && [ "${KEY_STATE}" != "GONE" ]; then
  echo "FAIL: expected the replica KMS key to be PendingDeletion after destroy, got '${KEY_STATE}'" >&2
  exit 1
fi
echo "    replica KMS key state: ${KEY_STATE} (7-day pending window is AWS-mandated, not an orphan)"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — S3 replication combined And filter CREATE + in-place UPDATE + destroy, all 3 phases passed"
