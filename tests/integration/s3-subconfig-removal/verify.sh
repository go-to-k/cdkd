#!/usr/bin/env bash
# verify.sh — cdkd S3 sub-config REMOVAL semantics integ (issue #1466).
#
# An `AWS::S3::Bucket` declaring four sub-configs that all used to sit on the
# provider's unconditional "always-PUT" path. Removing one from the template
# was a silent no-op: the guarded `if (properties['X'])` branch never ran, the
# old value survived on the real bucket, `cdkd deploy` printed `updated` and
# `cdkd drift` printed `no drift` -- no command surfaced the difference.
#
# The expected post-removal state is NOT uniform. Each verdict below was pinned
# by a live CloudFormation A/B on this same template pair (see the issue):
#   VersioningConfiguration        -> CFn SUSPENDS
#   OwnershipControls              -> CFn DELETES
#   BucketEncryption               -> CFn RESETS to the SSE-S3 (AES256) default
#   PublicAccessBlockConfiguration -> CFn KEEPS it (cdkd already at parity)
#
# The PublicAccessBlock row is the guard against over-fixing: it looks identical
# to the other three in the provider source, so asserting that it SURVIVES is
# what stops a later "consistency" refactor turning correct behavior into a
# divergence.
#
# Phases:
#   1. Deploy baseline; assert all four sub-configs reached AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (all four REMOVED from the
#      template). Assert versioning Suspended, ownership controls gone,
#      encryption reset to AES256, PAB unchanged, and the bucket NOT replaced.
#      Every one of the first three assertions FAILS against the pre-fix binary.
#   3. go-to-k/cdkd#2762: a second bucket takes each of the phases above on the
#      SDK route (a Cloud Control run would pass every value assertion, so the
#      record's provisionedBy is asserted too). Phase 1 names it from its
#      prefix, turns ABAC on and creates its S3 Metadata configuration. Phase 2
#      re-tags it with ABAC on, which only S3 Control accepts, and updates the
#      journal and inventory tables. Phase 2c removes ABAC and the configuration
#      and Phase 2d drives drift over both, undeclared. Phase 2e re-adds it over
#      the tables S3 kept, which must warn and complete. Destroy then runs with
#      ABAC on and a live configuration, and cleanup deletes the tables. An
#      annotation table takes its role and a role update throughout.
#   4. Destroy; assert the bucket is gone and the state file is removed.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# A pager invoked non-interactively is a route to a hang.
export AWS_PAGER=""

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

# S3 propagates a DeleteBucket to HeadBucket asynchronously: a probe issued
# immediately after a successful delete can still answer 200 for a few seconds.
# Retry on a bounded schedule instead of asserting once. This does NOT weaken
# leak detection -- a bucket that never disappears still FAILs, and gone_probe
# still hard-fails on any non-not-found probe error.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws s3api head-bucket ...
  local desc="$1"; shift
  local attempt
  for attempt in $(seq 1 10); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 3
  done
  echo "FAIL: ${desc} (still present after 10 probes over ~30s)" >&2
  exit 1
}

cd "$(dirname "$0")"

STACK="CdkdS3SubconfigRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
BUCKET_NAME="cdkd-subconfig-removal-${ACCOUNT_ID}"
METADATA_BUCKET="cdkd-2762-metadata-${ACCOUNT_ID}-${REGION}-an"
TABLE_BUCKET_ARN="arn:aws:s3tables:${REGION}:${ACCOUNT_ID}:bucket/aws-s3"

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
  aws s3api delete-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${METADATA_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  for table in journal inventory annotation; do
    aws s3tables delete-table --table-bucket-arn "${TABLE_BUCKET_ARN}" \
      --namespace "b_${METADATA_BUCKET}" --name "${table}" --region "${REGION}" >/dev/null 2>&1 || true
  done
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

# --- Phase 1: deploy baseline (all four sub-configs present) ---------------
echo "==> Phase 1: deploy bucket with versioning + ownership + encryption + PAB"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BUCKET_ID_P1="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SubconfigBucket.physicalId')"
if [ "${BUCKET_ID_P1}" != "${BUCKET_NAME}" ]; then
  echo "FAIL: expected physicalId ${BUCKET_NAME}, got ${BUCKET_ID_P1}" >&2
  exit 1
fi

VERSIONING_P1="$(aws s3api get-bucket-versioning --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Status' --output text)"
OWNERSHIP_P1="$(aws s3api get-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'OwnershipControls.Rules[0].ObjectOwnership' --output text)"
SSE_ALGO_P1="$(aws s3api get-bucket-encryption --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
  --output text)"
PAB_P1="$(aws s3api get-public-access-block --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text)"

if [ "${VERSIONING_P1}" != "Enabled" ]; then
  echo "FAIL: expected versioning Enabled after Phase 1, got ${VERSIONING_P1}" >&2
  exit 1
fi
if [ "${OWNERSHIP_P1}" != "BucketOwnerPreferred" ]; then
  echo "FAIL: expected ObjectOwnership BucketOwnerPreferred, got ${OWNERSHIP_P1}" >&2
  exit 1
fi
if [ "${SSE_ALGO_P1}" != "aws:kms" ]; then
  echo "FAIL: expected SSEAlgorithm aws:kms after Phase 1, got ${SSE_ALGO_P1}" >&2
  exit 1
fi
if [ "${PAB_P1}" != "True" ]; then
  echo "FAIL: expected BlockPublicAcls True after Phase 1, got ${PAB_P1}" >&2
  exit 1
fi
echo "    baseline applied: versioning=Enabled ownership=BucketOwnerPreferred sse=aws:kms pab=True"

# go-to-k/cdkd#2762: the prefix names the bucket, on the SDK route.
metadata_record() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json | jq -r "$1"
}
assert_sdk_route() {
  local by
  by="$(metadata_record '.state.resources.MetadataBucket.provisionedBy // "sdk"')"
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: MetadataBucket is recorded as provisionedBy=${by}, not the SDK route ($1)" >&2
    exit 1
  fi
}
metadata_field() {
  aws s3api get-bucket-metadata-configuration --bucket "${METADATA_BUCKET}" --region "${REGION}" \
    --query "GetBucketMetadataConfigurationResult.MetadataConfigurationResult.$1" --output text
}
assert_equals() { # usage: assert_equals "<what>" <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1: expected $2, got $3" >&2
    exit 1
  fi
}
# The paths drift reports on the bucket, so a phase proves ITS property moved;
# an exit code of 1 is also what a general failure gives.
drift_paths() {
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --stack-region "${REGION}" --json 2>/dev/null \
    | jq -r '[.[].drifted[] | select(.type == "AWS::S3::Bucket") | .changes[].path] | join(" ")' \
    || true
}
assert_drift_path() { # usage: assert_drift_path "<what>" <path>
  local paths
  paths="$(drift_paths)"
  case " ${paths} " in
    *" $2 "*|*" $2."*) ;;
    *) echo "FAIL: $1: drift reports [${paths}], not $2" >&2; exit 1 ;;
  esac
}
abac_status() {
  aws s3api get-bucket-abac --bucket "${METADATA_BUCKET}" --region "${REGION}" \
    --query 'AbacStatus.Status' --output text
}

assert_sdk_route "Phase 1"
assert_equals "MetadataBucket physical id" "${METADATA_BUCKET}" \
  "$(metadata_record '.state.resources.MetadataBucket.physicalId')"
assert_equals "AbacStatus after create" Enabled "$(abac_status)"
assert_equals "journal retention after create" 7 "$(metadata_field 'JournalTableConfigurationResult.RecordExpiration.Days')"
assert_equals "inventory state after create" DISABLED "$(metadata_field 'InventoryTableConfigurationResult.ConfigurationState')"
JOURNAL_ARN="$(metadata_field 'JournalTableConfigurationResult.TableArn')"
case "${JOURNAL_ARN}" in
  arn:aws:s3tables:*) ;;
  *) echo "FAIL: the journal table has no ARN after create: ${JOURNAL_ARN}" >&2; exit 1 ;;
esac
assert_equals "the Fn::GetAtt journal table ARN output" "${JOURNAL_ARN}" \
  "$(metadata_record '.state.outputs.JournalTableArn')"
echo "    prefix-named bucket on the SDK route, ABAC on, journal table ${JOURNAL_ARN}"

# --- Phase 1a: enable the annotation table (go-to-k/cdkd#2762) ---------------
# S3 fails the table for good when it cannot assume the role yet, and Phase 1
# only just created it, so this waits for IAM before the update enables it.
echo "==> Phase 1a: enable the annotation table once its role has propagated"
sleep 20
CDKD_TEST_ANNOTATION=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_annotation_healthy() { # usage: assert_annotation_healthy <output key of the role>
  assert_equals "annotation role" "$(metadata_record ".state.outputs.$1")" \
    "$(metadata_field 'AnnotationTableConfigurationResult.Role')"
  local status
  status="$(metadata_field 'AnnotationTableConfigurationResult.TableStatus')"
  if [ "${status}" = "FAILED" ] || [ "${status}" = "None" ]; then
    echo "FAIL: annotation table status ${status}: $(metadata_field 'AnnotationTableConfigurationResult.Error')" >&2
    exit 1
  fi
}
assert_annotation_healthy AnnotationRoleAArn
echo "    annotation table enabled"

# --- Phase 1b: drift must SURFACE a console-side ownership change ----------
# This is the assertion that actually exercises the GetBucketOwnershipControls
# read added by issue #1466. It has to run HERE, while state still declares
# OwnershipControls: the drift comparator only descends into keys present in
# state, so the same check after the Phase 2 removal would pass even with no
# read wired at all (i.e. it would be vacuous). Pre-#1466 the provider had no
# Get for this property, so drift could not see the change and exited 0.
echo "==> Phase 1b: out-of-band ownership change must be detected as drift"
aws s3api put-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerEnforced}]'

DRIFT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" || DRIFT_RC=$?
if [ "${DRIFT_RC}" -ne 1 ]; then
  echo "FAIL: expected drift exit 1 after an out-of-band OwnershipControls change, got ${DRIFT_RC}" >&2
  exit 1
fi
echo "    drift detected the console-side ownership change (exit 1)"

# go-to-k/cdkd#2762: the same for the two new readbacks, on a clean baseline.
echo "==> Phase 1b: out-of-band ABAC change must be detected as drift"
aws s3api put-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerPreferred}]'
aws s3api put-bucket-abac --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --abac-status Status=Disabled
assert_drift_path "an out-of-band AbacStatus change" AbacStatus
aws s3api put-bucket-abac --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --abac-status Status=Enabled
echo "==> Phase 1b: out-of-band metadata change must be detected as drift"
aws s3api update-bucket-metadata-journal-table-configuration --bucket "${METADATA_BUCKET}" \
  --region "${REGION}" \
  --journal-table-configuration '{"RecordExpiration":{"Expiration":"ENABLED","Days":9}}'
assert_drift_path "an out-of-band journal change" MetadataConfiguration
aws s3api update-bucket-metadata-journal-table-configuration --bucket "${METADATA_BUCKET}" \
  --region "${REGION}" \
  --journal-table-configuration '{"RecordExpiration":{"Expiration":"ENABLED","Days":7}}'

# Restore so Phase 2 starts from the declared baseline again.
aws s3api put-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --ownership-controls 'Rules=[{ObjectOwnership=BucketOwnerPreferred}]'
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    restored; drift clean again"

# --- Phase 2: remove every sub-config from the template --------------------
# This is the phase the fix exists for. Against the pre-fix binary the first
# three assertions FAIL (old values survive) while cdkd still reports success.
echo "==> Phase 2: redeploy with all four sub-configs REMOVED from the template"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BUCKET_ID_P2="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SubconfigBucket.physicalId')"
if [ "${BUCKET_ID_P2}" != "${BUCKET_ID_P1}" ]; then
  echo "FAIL: bucket was REPLACED across the removal update (${BUCKET_ID_P1} -> ${BUCKET_ID_P2})" >&2
  exit 1
fi
echo "    bucket not replaced (in-place update)"

# Versioning: CFn suspends. Pre-fix this stayed 'Enabled'.
VERSIONING_P2="$(aws s3api get-bucket-versioning --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'Status' --output text)"
if [ "${VERSIONING_P2}" != "Suspended" ]; then
  echo "FAIL: removing VersioningConfiguration must suspend versioning (CFn parity), got ${VERSIONING_P2}" >&2
  exit 1
fi
echo "    VersioningConfiguration removed -> Suspended"

# OwnershipControls: CFn deletes the block outright. Pre-fix it survived.
assert_gone "removing OwnershipControls must delete the block (CFn parity), but it is still present" \
  aws s3api get-bucket-ownership-controls --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    OwnershipControls removed -> deleted"

# BucketEncryption: CFn resets to the SSE-S3 default. Pre-fix it stayed
# aws:kms, which also means the user keeps paying KMS request charges.
SSE_ALGO_P2="$(aws s3api get-bucket-encryption --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'ServerSideEncryptionConfiguration.Rules[0].ApplyServerSideEncryptionByDefault.SSEAlgorithm' \
  --output text)"
if [ "${SSE_ALGO_P2}" != "AES256" ]; then
  echo "FAIL: removing BucketEncryption must reset to the AES256 default (CFn parity), got ${SSE_ALGO_P2}" >&2
  exit 1
fi
echo "    BucketEncryption removed -> reset to AES256"

# PublicAccessBlock: VERIFIED PARITY -- CloudFormation keeps it too, so cdkd
# must NOT delete it. This assertion exists to stop an over-eager "make them
# all consistent" refactor from introducing a divergence.
PAB_P2="$(aws s3api get-public-access-block --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query 'PublicAccessBlockConfiguration.BlockPublicAcls' --output text)"
if [ "${PAB_P2}" != "True" ]; then
  echo "FAIL: removing PublicAccessBlockConfiguration must NOT clear it (CFn parity), got ${PAB_P2}" >&2
  exit 1
fi
echo "    PublicAccessBlockConfiguration removed -> retained (CFn parity, not a bug)"

# go-to-k/cdkd#2762: S3 refuses PutBucketTagging while ABAC is on, so the tag
# change had to go through S3 Control; the tables took their own update calls.
assert_sdk_route "Phase 2"
assert_equals "MetadataBucket not replaced" "${METADATA_BUCKET}" \
  "$(metadata_record '.state.resources.MetadataBucket.physicalId')"
TAGS_P2="$(aws s3api get-bucket-tagging --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --query "TagSet[?starts_with(Key, 'cdkd-2762')].[Key,Value]" --output text | LC_ALL=C sort | tr '\t\n' '= ')"
assert_equals "tags updated with ABAC on" "cdkd-2762=updated cdkd-2762-added=added " "${TAGS_P2}"
assert_equals "journal retention after update" 8 "$(metadata_field 'JournalTableConfigurationResult.RecordExpiration.Days')"
assert_equals "inventory state after update" ENABLED "$(metadata_field 'InventoryTableConfigurationResult.ConfigurationState')"
assert_annotation_healthy AnnotationRoleBArn
case "$(metadata_field 'InventoryTableConfigurationResult.TableArn')" in
  arn:aws:s3tables:*) ;;
  *) echo "FAIL: the deploy returned before the inventory table had an ARN" >&2; exit 1 ;;
esac
echo "    ABAC bucket re-tagged, journal and inventory tables updated"

# The read side must now see ownership controls, otherwise drift stays blind to
# exactly the property this issue fixed. A clean drift here proves state and
# AWS agree AFTER the removal round-trip.
echo "==> Phase 2b: drift must be clean after the removal update"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    drift clean"

# --- Phase 2c: remove ABAC and the metadata configuration (go-to-k/cdkd#2762) --
# CloudFormation sets AbacStatus back to Disabled and deletes the configuration.
echo "==> Phase 2c: redeploy with AbacStatus and MetadataConfiguration removed"
CDKD_TEST_UPDATE=true CDKD_TEST_METADATA_REMOVED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_sdk_route "Phase 2c"
assert_equals "AbacStatus after removal" Disabled "$(abac_status)"
# ABAC went off in this same deploy: PutBucketTagging only works after it.
assert_equals "tag written as ABAC went off" abac-off "$(aws s3api get-bucket-tagging \
  --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --query "TagSet[?Key=='cdkd-2762'].Value | [0]" --output text)"
assert_gone_eventually "removing MetadataConfiguration must delete it" \
  aws s3api get-bucket-metadata-configuration --bucket "${METADATA_BUCKET}" --region "${REGION}"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
echo "    both removed, drift clean"

# Both are read back only away from their default, so this is the path a
# baseline with neither key depends on.
echo "==> Phase 2d: an undeclared AbacStatus turned on out of band is drift"
aws s3api put-bucket-abac --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --abac-status Status=Enabled
assert_drift_path "an undeclared AbacStatus turned on" AbacStatus
aws s3api put-bucket-abac --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --abac-status Status=Disabled

echo "==> Phase 2d: an undeclared MetadataConfiguration created out of band is drift"
aws s3api create-bucket-metadata-configuration --bucket "${METADATA_BUCKET}" --region "${REGION}" \
  --metadata-configuration '{"JournalTableConfiguration":{"RecordExpiration":{"Expiration":"DISABLED"}}}'
assert_drift_path "an undeclared MetadataConfiguration created" MetadataConfiguration
aws s3api delete-bucket-metadata-configuration --bucket "${METADATA_BUCKET}" --region "${REGION}"
assert_gone_eventually "the out-of-band MetadataConfiguration is still there" \
  aws s3api get-bucket-metadata-configuration --bucket "${METADATA_BUCKET}" --region "${REGION}"

# --- Phase 2e: re-add over the tables the removal left (go-to-k/cdkd#2762) -----
# S3 accepts it and fails the tables; CloudFormation completes, on a create and
# on an update, so cdkd must too, and name the cause. It also leaves ABAC on and
# a configuration live for the destroy below.
echo "==> Phase 2e: re-adding MetadataConfiguration over its leftover tables"
DEPLOY_2E_LOG="$(mktemp)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${DEPLOY_2E_LOG}"
if ! grep -q 'JournalTableAlreadyExists' "${DEPLOY_2E_LOG}"; then
  echo "FAIL: the deploy over a leftover journal table did not name JournalTableAlreadyExists" >&2
  exit 1
fi
rm -f "${DEPLOY_2E_LOG}"
assert_equals "journal table state over a leftover table" FAILED \
  "$(metadata_field 'JournalTableConfigurationResult.TableStatus')"
assert_equals "AbacStatus after the re-add" Enabled "$(abac_status)"
echo "    deploy continued and named the failed table"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_gone_eventually "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone_eventually "bucket ${METADATA_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${METADATA_BUCKET}" --region "${REGION}"
echo "    buckets deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    state file removed"

# Destroy leaves S3 Metadata's tables, as CloudFormation does.
cleanup
for table in journal inventory annotation; do
  assert_gone "S3 Metadata table ${table} still exists after cleanup" \
    aws s3tables get-table --table-bucket-arn "${TABLE_BUCKET_ARN}" \
    --namespace "b_${METADATA_BUCKET}" --name "${table}" --region "${REGION}"
done

trap - EXIT INT TERM
echo "PASS: s3-subconfig-removal"
