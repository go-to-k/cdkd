#!/usr/bin/env bash
# verify.sh -- AWS::ElastiCache::CacheCluster SnapshotArns on the SDK route
# (issue #5635).
#
# Pre-fix, SnapshotArns was a silent-drop property of the SDK provider, so a
# template carrying it auto-routed the WHOLE cluster through Cloud Control
# (#614) and recorded `provisionedBy: cc-api` on its state record (sticky).
# Post-fix, CreateCacheCluster sends it.
#
# 1. Seed: write a one-key RDB file (make-seed-rdb.mjs) to a bucket this
#    script owns, whose policy lets ElastiCache read it, and pass the object
#    ARN to the app in CDKD_TEST_SEED_RDB_ARN.
# 2. Deploy. A seed ElastiCache cannot load leaves the cluster
#    `restore-failed`, which fails the deploy at once (the provider's wait
#    names the status).
# 3. Routing guard: the cluster is `provisionedBy=sdk` -- what a pre-fix cdkd
#    FAILS (the value still reaches AWS through Cloud Control there, so the
#    data check alone cannot tell the two apart).
# 4. (LOAD-BEARING) DescribeCacheClusters has no SnapshotArns member, so the
#    value is read back through the DATA it seeds: the in-VPC SeedReader
#    function GETs the seeded key, and it must hold this run's value. A
#    handled-but-unwired property (SDK route, nothing sent) fails here.
# 5. Destroy.
# 6. Assert 0 orphans, then delete the seed bucket. Cleanup order: the stack
#    goes first, the seed after it (the bucket outlives the create).
#
# BSD/macOS-portable (no grep -P, no date -d). Real rc captured. Explicit PASS.

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

STACK="CdkdElastiCacheSnapshotArnsExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
READER_FN="${STACK}-seed-reader"
READER_LOG_GROUP="/aws/lambda/${READER_FN}"
SEED_KEY="cdkd5635:seed"
SEED_OBJECT="seed/dump.rdb"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"
WORK_DIR="$(mktemp -d -t ecsnap.XXXXXX)"
DEPLOY_LOG="${WORK_DIR}/deploy.log"
SEED_BUCKET=""

export AWS_RETRY_MODE=adaptive
export AWS_MAX_ATTEMPTS=10

# Empty and delete the seed bucket. Scope guard first: the name is built from
# the account id, and only this fixture's own spelling is ever deleted.
delete_seed_bucket() {
  (
    set +eu
    case "${SEED_BUCKET}" in
      cdkd-integ-5635-seed-[0-9]?*) ;;
      *)
        echo "WARN: teardown sweep refused -- '${SEED_BUCKET}' is not this fixture's seed bucket" >&2
        exit 0
        ;;
    esac
    aws s3 rm "s3://${SEED_BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1
    aws s3api delete-bucket --bucket "${SEED_BUCKET}" --region "${REGION}" >/dev/null 2>&1
    exit 0
  )
}

cleanup() {
  local rc=$?
  echo "==> Cleanup (errors tolerated)"
  set +eu
  # The stack first, the seed after it. An interrupt DURING the create is
  # not covered: `state destroy` on a cluster still `creating` fails
  # (InvalidCacheClusterState) and the cluster is left behind -- delete it
  # by hand once it settles (aws elasticache delete-cache-cluster).
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes
  fi
  [ -n "${SEED_BUCKET}" ] && delete_seed_bucket
  aws logs delete-log-group --log-group-name "${READER_LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -rf "${WORK_DIR}"
  set -eu
  return "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
case "${ACCOUNT}" in
  [0-9]*) ;;
  *) echo "FAIL: could not read the account id (got '${ACCOUNT}')" >&2; exit 1 ;;
esac
SEED_BUCKET="cdkd-integ-5635-seed-${ACCOUNT}-${REGION}"
SEED_ARN="arn:aws:s3:::${SEED_BUCKET}/${SEED_OBJECT}"
# This run's value, so a stale seed or a cluster left from an earlier run
# cannot satisfy the read-back.
SEED_VALUE="cdkd-5635-$(date -u +%Y%m%d%H%M%S)-$$"

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install

echo "==> Pre-run cleanup"
cleanup
# cleanup removes WORK_DIR (it is also the EXIT handler): re-create it.
mkdir -p "${WORK_DIR}"

echo "==> Step 1: seed the RDB file in s3://${SEED_BUCKET}/${SEED_OBJECT}"
if [ "${REGION}" = "us-east-1" ]; then
  aws s3api create-bucket --bucket "${SEED_BUCKET}" --region "${REGION}" >/dev/null
else
  aws s3api create-bucket --bucket "${SEED_BUCKET}" --region "${REGION}" \
    --create-bucket-configuration "LocationConstraint=${REGION}" >/dev/null
fi
# The ElastiCache snapshot principal reads the object (AWS's seeding guide,
# "Grant ElastiCache read access to the .rdb file").
cat > "${WORK_DIR}/policy.json" <<EOF
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "ElastiCacheSnapshotAccess",
      "Effect": "Allow",
      "Principal": { "Service": "${REGION}.elasticache-snapshot.amazonaws.com" },
      "Action": ["s3:GetObject", "s3:ListBucket", "s3:GetBucketAcl"],
      "Resource": ["arn:aws:s3:::${SEED_BUCKET}", "arn:aws:s3:::${SEED_BUCKET}/*"]
    }
  ]
}
EOF
aws s3api put-bucket-policy --bucket "${SEED_BUCKET}" --region "${REGION}" \
  --policy "file://${WORK_DIR}/policy.json"
node make-seed-rdb.mjs "${WORK_DIR}/dump.rdb" "${SEED_KEY}" "${SEED_VALUE}"
aws s3 cp "${WORK_DIR}/dump.rdb" "s3://${SEED_BUCKET}/${SEED_OBJECT}" --region "${REGION}" >/dev/null
echo "    OK: seeded ${SEED_KEY}=${SEED_VALUE}"

echo "==> Step 2: deploy (redis CacheCluster with SnapshotArns + in-VPC seed reader)"
set +e
CDKD_TEST_SEED_RDB_ARN="${SEED_ARN}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --verbose --yes > "${DEPLOY_LOG}" 2>&1
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC}" >&2
  if grep -q 'is restore-failed' "${DEPLOY_LOG}"; then
    echo "      the cluster is restore-failed: SnapshotArns reached AWS, but ElastiCache could not load the seed (bucket policy or RDB format)" >&2
  fi
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: deploy exited 0"

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
CLUSTER_ID=$(jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ElastiCache::CacheCluster") | .value.physicalId] | first // ""' <<<"${STATE}")
if [ -z "${CLUSTER_ID}" ]; then
  echo "FAIL: no AWS::ElastiCache::CacheCluster record in state" >&2
  exit 1
fi
echo "    cache cluster: ${CLUSTER_ID}"

echo "==> Step 3: routing guard -- the CacheCluster is provisionedBy=sdk"
# A still-unwired SnapshotArns routes the whole resource to Cloud Control
# (#614). An absent provisionedBy is a legacy SDK record; an absent RECORD is not.
PROVISIONED_BY=$(jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::ElastiCache::CacheCluster") | .value.provisionedBy // "sdk"] | first // "<no CacheCluster record>"' <<<"${STATE}")
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: CacheCluster routed via '${PROVISIONED_BY}', expected 'sdk' (SnapshotArns is still a silent-drop -> Cloud Control, issue #5635)" >&2
  exit 1
fi
echo "    OK: CacheCluster provisionedBy=sdk"

echo "==> Step 4 (LOAD-BEARING): the seeded key is in the cluster"
STATUS=$(aws elasticache describe-cache-clusters --cache-cluster-id "${CLUSTER_ID}" \
  --region "${REGION}" --query 'CacheClusters[0].CacheClusterStatus' --output text)
if [ "${STATUS}" != "available" ]; then
  # The deploy's wait already refuses `restore-failed`; this catches a
  # cluster that left `available` after it.
  echo "FAIL: cache cluster ${CLUSTER_ID} is '${STATUS}', expected 'available'" >&2
  exit 1
fi
# The cluster's own account of the restore, for the record (not asserted:
# the event wording is AWS's and has not been pinned by a run).
aws elasticache describe-events --source-type cache-cluster --source-identifier "${CLUSTER_ID}" \
  --duration 120 --region "${REGION}" --query 'Events[].Message' --output text | tr '\t' '\n' | sed 's/^/    event: /' ||
  echo "    (describe-events failed; not asserted)"

READ_OUT="${WORK_DIR}/read.json"
INVOKE_ERR=""
for attempt in 1 2 3 4 5; do
  rm -f "${READ_OUT}"
  # A CLI-level failure (function still Pending, throttling) is retried like
  # a function error rather than ending the run under `set -e`.
  if INVOKE_META=$(aws lambda invoke --function-name "${READER_FN}" --region "${REGION}" \
    --cli-binary-format raw-in-base64-out --payload "{\"key\":\"${SEED_KEY}\"}" \
    "${READ_OUT}" --output json); then
    INVOKE_ERR=$(jq -r '.FunctionError // ""' <<<"${INVOKE_META}")
  else
    INVOKE_ERR="aws lambda invoke failed"
  fi
  [ -z "${INVOKE_ERR}" ] && break
  echo "    reader attempt ${attempt} failed (${INVOKE_ERR}): $(cat "${READ_OUT}" 2>/dev/null)"
  sleep 15
done
if [ -n "${INVOKE_ERR}" ]; then
  echo "FAIL: the seed reader kept failing (${INVOKE_ERR}): $(cat "${READ_OUT}" 2>/dev/null)" >&2
  exit 1
fi
FOUND=$(jq -r '.found' "${READ_OUT}") || {
  echo "FAIL: the seed reader's output is missing or not JSON: $(cat "${READ_OUT}" 2>/dev/null)" >&2
  exit 1
}
GOT=$(jq -r '.value // ""' "${READ_OUT}")
if [ "${FOUND}" != "true" ]; then
  echo "FAIL: ${SEED_KEY} is absent from the cluster: CreateCacheCluster carried no SnapshotArns (issue #5635)" >&2
  exit 1
fi
if [ "${GOT}" != "${SEED_VALUE}" ]; then
  echo "FAIL: ${SEED_KEY} is '${GOT}', expected this run's '${SEED_VALUE}'" >&2
  exit 1
fi
echo "    OK: ${SEED_KEY}=${GOT} -- the cluster was seeded from SnapshotArns"

echo "==> Step 5: destroy"
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force --verbose > "${DEPLOY_LOG}" 2>&1
DESTROY_RC=$?
set -e
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  tail -60 "${DEPLOY_LOG}" >&2
  exit 1
fi
echo "    OK: destroy exited 0"

echo "==> Step 6: assert 0 orphans, then delete the seed"
assert_gone "state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "cache cluster ${CLUSTER_ID} still exists after destroy" aws elasticache describe-cache-clusters --cache-cluster-id "${CLUSTER_ID}" --region "${REGION}"
assert_gone "seed reader ${READER_FN} still exists after destroy" aws lambda get-function --function-name "${READER_FN}" --region "${REGION}"
aws logs delete-log-group --log-group-name "${READER_LOG_GROUP}" --region "${REGION}" >/dev/null 2>&1 || true
delete_seed_bucket
assert_gone "seed bucket ${SEED_BUCKET} still exists" aws s3api head-bucket --bucket "${SEED_BUCKET}" --region "${REGION}"
echo "    OK: 0 orphans (state + cluster + reader + seed bucket gone)"

trap - EXIT INT TERM
rm -rf "${WORK_DIR}"
echo ""
echo "[verify] PASS -- elasticache-snapshot-arns: SnapshotArns sent on the SDK route (provisionedBy=sdk, seeded key read back), clean destroy"
