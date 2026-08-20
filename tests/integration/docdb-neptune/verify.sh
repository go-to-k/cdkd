#!/usr/bin/env bash
#
# End-to-end real-AWS validation for cdkd's DocDB + Neptune SDK providers
# (PR #207). Pre-PR these types fell through to CC API; this is the
# first time the new providers run against actual AWS.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   2. cdkd deploy CdkdDocdbNeptuneExample with per-type long timeouts
#      (DocDB / Neptune cluster + instance creates each take 5-10 min).
#      The BASELINE template sets the #1160 removable cluster fields
#      non-default: DeletionProtection=true + BackupRetentionPeriod=7 on
#      both clusters, plus IamAuthEnabled=true on the Neptune cluster.
#   3. cdkd state list — sanity check that state was written
#   3b. assert the baseline fields reached AWS (describe-db-clusters) —
#       proves the step-3d reset assertions bind to a real change
#   3c. CDKD_TEST_REMOVAL=true redeploy — DROPS the step-2 fields so
#       cdkd's ModifyDBCluster sees ABSENT fields (removal, issue #1160).
#       ModifyDBCluster has merge semantics (absent = "no change"), so
#       before the #1160 fix the removed fields silently kept their old
#       live values — worst case DeletionProtection, which would make
#       the step-4 destroy fail.
#   3d. poll describe-db-clusters until both clusters settle back to the
#       CFn defaults (DeletionProtection=false, BackupRetentionPeriod=1,
#       Neptune IAMDatabaseAuthenticationEnabled=false)
#   4. cdkd destroy --force with the same long per-type timeouts (DocDB
#      / Neptune deletes can also take 5-10 min). Deliberately NO
#      --remove-protection: the destroy succeeding is itself live proof
#      the #1160 DeletionProtection reset landed.
#   5. cdkd state list — must report empty for the stack
#
# Auto-resolves AWS account ID + state bucket. Run from anywhere.
#
# A failed run leaves DocDB / Neptune clusters that bill ~$0.07/hr each
# (db.t3.medium). The cleanup trap re-attempts destroy on any failure
# exit so a botched run does not bill the user indefinitely; because an
# aborted run can die between steps 2 and 3c with the baseline
# DeletionProtection=true still live, cleanup first best-effort flips
# protection off on both clusters and passes --remove-protection to the
# destroy (the #1222 hardening pattern).
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDocdbNeptuneExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/docdb-neptune"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096). The fixture stack templates a
# literal `masterUserPassword` for the DocDB cluster, so that password lands in
# the cluster's own state properties. The state bucket is VERSIONED, so
# `aws s3 rm` only writes a delete marker and it stays readable via
# GetObjectVersion after a green run -- measured 2026-08-20, 16 of 64 surviving
# versions of this stack's state.json carried it.
#
# Sourced by ABSOLUTE path because this line runs BEFORE the `cd "${TEST_DIR}"`
# further down, so a relative `../s3-versions.sh` would resolve against whatever
# the caller's cwd happens to be. Do NOT "simplify" this by moving the source
# below that `cd` -- the helper is wanted before the first `cleanup` can fire --
# and do not delete the `cd`, which the fixture's own npm/vp steps need.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# Per-resource timeout overrides for DocDB + Neptune. AWS create / delete
# round-trips on cluster + instance routinely run 5–10 min each; the
# default 30m cdkd budget is plenty per-resource but the warn threshold
# would otherwise fire spuriously. We pass both create-side AND delete-
# side cluster + instance overrides, since the same `--resource-timeout`
# flag applies to deploy and destroy.
TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::DocDB::DBCluster=20m
  --resource-timeout AWS::DocDB::DBInstance=25m
  --resource-timeout AWS::Neptune::DBCluster=20m
  --resource-timeout AWS::Neptune::DBInstance=25m
)

# Auto-generated physical names; resolved from cdkd state after deploy so
# the cleanup flip-offs can target the live clusters.
DOCDB_CLUSTER_ID=""
NEPTUNE_CLUSTER_ID=""

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# On any failure exit, re-attempt destroy so we never leak DocDB /
# Neptune clusters. Best-effort DeletionProtection flip-offs first: an
# aborted run can die with the baseline (step-2) protection still live,
# which would refuse the delete otherwise (#1160 fixture shape).
cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup destroy"
    if [ -n "${DOCDB_CLUSTER_ID}" ]; then
      aws docdb modify-db-cluster \
        --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
        --region "${REGION}" \
        --no-deletion-protection \
        --apply-immediately >/dev/null 2>&1 || true
    fi
    if [ -n "${NEPTUNE_CLUSTER_ID}" ]; then
      aws neptune modify-db-cluster \
        --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
        --region "${REGION}" \
        --no-deletion-protection \
        --apply-immediately >/dev/null 2>&1 || true
    fi
    ${CLI} destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force \
      --remove-protection \
      "${TIMEOUT_OVERRIDES[@]}" || true
  fi
  # Purge the versions any `s3 rm` / `state destroy` left behind as delete
  # markers. NONCURRENT-only, per the contract in ../s3-versions.sh: this runs
  # from the failure and signal traps, where a live state.json may be the only
  # record of a cluster that is still standing. The success path does the full
  # sweep, after destroy has been asserted.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy (baseline — #1160 removable fields set non-default)"
${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 3: cdkd state list (stack should be present)"
if ! ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state was not written after deploy"
  exit 1
fi
echo "[verify] step 3 ok"

# Resolve the auto-generated cluster identifiers from cdkd state (strict
# capture — a read failure aborts under set -e).
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
DOCDB_CLUSTER_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DocDB::DBCluster") | .value.physicalId] | first // ""')
NEPTUNE_CLUSTER_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Neptune::DBCluster") | .value.physicalId] | first // ""')
if [ -z "${DOCDB_CLUSTER_ID}" ] || [ -z "${NEPTUNE_CLUSTER_ID}" ]; then
  echo "[verify] FAIL: could not resolve cluster identifiers from state (docdb='${DOCDB_CLUSTER_ID}', neptune='${NEPTUNE_CLUSTER_ID}')" >&2
  exit 1
fi
echo "[verify] resolved clusters: docdb=${DOCDB_CLUSTER_ID} neptune=${NEPTUNE_CLUSTER_ID}"

echo "[verify] step 3b: baseline #1160 fields reached AWS"
# jq false-vs-null trap: `//` treats false as missing — use explicit
# has() checks for booleans.
DOCDB_BASE=$(aws docdb describe-db-clusters \
  --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0]' --output json)
DOCDB_BASE_PROT=$(echo "${DOCDB_BASE}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
DOCDB_BASE_RETENTION=$(echo "${DOCDB_BASE}" | jq -r '.BackupRetentionPeriod // "null"')
if [ "${DOCDB_BASE_PROT}" != "true" ] || [ "${DOCDB_BASE_RETENTION}" != "7" ]; then
  echo "[verify] FAIL: DocDB baseline fields not set (DeletionProtection='${DOCDB_BASE_PROT}' expected true, BackupRetentionPeriod='${DOCDB_BASE_RETENTION}' expected 7)" >&2
  exit 1
fi
NEPTUNE_BASE=$(aws neptune describe-db-clusters \
  --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
  --region "${REGION}" \
  --query 'DBClusters[0]' --output json)
NEPTUNE_BASE_PROT=$(echo "${NEPTUNE_BASE}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
NEPTUNE_BASE_RETENTION=$(echo "${NEPTUNE_BASE}" | jq -r '.BackupRetentionPeriod // "null"')
NEPTUNE_BASE_IAM=$(echo "${NEPTUNE_BASE}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${NEPTUNE_BASE_PROT}" != "true" ] || [ "${NEPTUNE_BASE_RETENTION}" != "7" ] || [ "${NEPTUNE_BASE_IAM}" != "true" ]; then
  echo "[verify] FAIL: Neptune baseline fields not set (DeletionProtection='${NEPTUNE_BASE_PROT}' expected true, BackupRetentionPeriod='${NEPTUNE_BASE_RETENTION}' expected 7, IAMDatabaseAuthenticationEnabled='${NEPTUNE_BASE_IAM}' expected true)" >&2
  exit 1
fi
echo "[verify] step 3b ok: baseline non-default fields live on both clusters"

echo "[verify] step 3c: CDKD_TEST_REMOVAL=true redeploy (DROP the #1160 fields)"
CDKD_TEST_REMOVAL=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 3d: wait for both clusters to settle at the CFn defaults"
# Cluster modifies can take a couple of minutes to settle; bounded retry,
# no sleep after the final poll.
RESET_OK=""
DOCDB_STATUS="" DOCDB_PROT="" DOCDB_RETENTION=""
NEPTUNE_STATUS="" NEPTUNE_PROT="" NEPTUNE_RETENTION="" NEPTUNE_IAM=""
for i in $(seq 1 60); do
  DOCDB_AFTER=$(aws docdb describe-db-clusters \
    --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json)
  DOCDB_STATUS=$(echo "${DOCDB_AFTER}" | jq -r '.Status // "null"')
  DOCDB_PROT=$(echo "${DOCDB_AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
  DOCDB_RETENTION=$(echo "${DOCDB_AFTER}" | jq -r '.BackupRetentionPeriod // "null"')
  NEPTUNE_AFTER=$(aws neptune describe-db-clusters \
    --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json)
  NEPTUNE_STATUS=$(echo "${NEPTUNE_AFTER}" | jq -r '.Status // "null"')
  NEPTUNE_PROT=$(echo "${NEPTUNE_AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
  NEPTUNE_RETENTION=$(echo "${NEPTUNE_AFTER}" | jq -r '.BackupRetentionPeriod // "null"')
  NEPTUNE_IAM=$(echo "${NEPTUNE_AFTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
  if [ "${DOCDB_STATUS}" = "available" ] && [ "${DOCDB_PROT}" = "false" ] && [ "${DOCDB_RETENTION}" = "1" ] \
    && [ "${NEPTUNE_STATUS}" = "available" ] && [ "${NEPTUNE_PROT}" = "false" ] && [ "${NEPTUNE_RETENTION}" = "1" ] && [ "${NEPTUNE_IAM}" = "false" ]; then
    RESET_OK="yes"
    break
  fi
  if [ "${i}" -lt 60 ]; then
    sleep 10
  fi
done
if [ -z "${RESET_OK}" ]; then
  echo "[verify] FAIL: clusters did not settle at the CFn defaults after removal — #1160 ModifyDBCluster reset-on-removal NOT closed" >&2
  echo "  docdb:   status='${DOCDB_STATUS}' protection='${DOCDB_PROT}' retention='${DOCDB_RETENTION}' (expected available/false/1)" >&2
  echo "  neptune: status='${NEPTUNE_STATUS}' protection='${NEPTUNE_PROT}' retention='${NEPTUNE_RETENTION}' iamAuth='${NEPTUNE_IAM}' (expected available/false/1/false)" >&2
  exit 1
fi
echo "[verify] step 3d ok: both clusters reset to DeletionProtection=false + BackupRetentionPeriod=1 (+ Neptune IAMDatabaseAuthenticationEnabled=false) — #1160 silent-drop CLOSED"

echo "[verify] step 4: cdkd destroy --force (no --remove-protection — proves the #1160 reset landed)"
${CLI} destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 5: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 5 ok: state cleared"

# AWS-side orphan auditing is delegated to /run-integ's /cleanup pass.

# --- Teardown VERSION sweep, ON THE SUCCESS PATH ---------------------------
# `state list` above only proves the CURRENT object is gone; the bucket is
# VERSIONED, so the templated master password survived in every prior version
# (issue #2096). The sweep must run HERE and not only in `cleanup`, because
# `cleanup` does nothing on rc=0 and the line below disarms it anyway.
trap - EXIT INT TERM
echo "[verify] step 6: state-version sweep"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "docdb-neptune state teardown"
echo "[verify] PASS"
