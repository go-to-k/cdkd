#!/usr/bin/env bash
#
# End-to-end real-AWS validation for cdkd's DocDB + Neptune SDK providers
# (PR #207). Pre-PR these types fell through to CC API; this is the
# first time the new providers run against actual AWS.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps
#   1b. CDKD_TEST_NONPROV_REFUSAL=true deploy — adds CopyTagsToSnapshot,
#       which the DocDB cluster's SDK provider does not handle; must be
#       refused pre-flight with no state written (issue #3866)
#   2. cdkd deploy CdkdDocdbNeptuneExample with per-type long timeouts
#      (DocDB / Neptune cluster + instance creates each take 5-10 min).
#      The BASELINE template sets the #1160 removable cluster fields
#      non-default: DeletionProtection=true + BackupRetentionPeriod=7 on
#      both clusters, IamAuthEnabled=true on the Neptune cluster, and
#      AutoMinorVersionUpgrade=false on the Neptune instance.
#   3. cdkd state list — sanity check that state was written
#   3b. assert the baseline fields reached AWS (describe-db-clusters,
#       describe-db-instances) — proves the step-3d retention assertions
#       bind to a real, non-default value
#   3c. CDKD_TEST_REMOVAL=true redeploy — DROPS the step-2 fields so
#       cdkd's Modify* calls see ABSENT fields (removal, issues #1160 /
#       #5004). A real CloudFormation A/B (#5004) showed CloudFormation
#       KEEPS the live value of each, so cdkd must send no reset. The same
#       redeploy changes the DocDB subnet group description, an in-place
#       update through the provider's update() (issue #2613).
#   3d. wait for both clusters to be available, then assert the baseline
#       values are RETAINED (DeletionProtection=true, BackupRetentionPeriod=7,
#       Neptune IAMDatabaseAuthenticationEnabled=true, Neptune instance
#       AutoMinorVersionUpgrade=false). Step 3c also drops both clusters'
#       VpcSecurityGroupIds (#1160): Neptune must move to the VPC's default
#       security group and DocDB must keep `Sg`, as CloudFormation does.
#       It drops both clusters' non-default ports too (#1160): DocDB must
#       reset to 27017 and Neptune keep 8183, as CloudFormation does.
#       Step 3c leaves the DocDB MasterUserPassword unchanged, so the DocDB
#       cluster must never read `resetting-master-credentials` from the
#       deploy's return until it is stable (#5153). The Neptune cluster's
#       engine (1.4.7.0), backup window and cluster parameter group and the
#       instance's parameter group are dropped too: CloudFormation keeps each
#       (#5544 A/B), so they must still be live, and the step-3c output must
#       carry cdkd's warning naming every kept removal.
#   3g. --remove-protection compensation (issue #2204): re-enable
#       DeletionProtection on both clusters out of band, add one
#       out-of-band instance to each (DeleteDBCluster then refuses: the
#       cluster still has a member cdkd does not own — a TERMINAL
#       failure), run `cdkd destroy --remove-protection`, which must FAIL,
#       and assert DeletionProtection is back ON on both clusters: cdkd
#       turned it off, the delete failed, so cdkd must put it back. Then
#       delete the out-of-band instances.
#   4. cdkd destroy --force --remove-protection with the same long
#      per-type timeouts (DocDB / Neptune deletes can also take 5-10 min).
#      The #5004 retention is proven by step 3d's readback; the guard is
#      ON (kept through the removal), so this is also the flip's live
#      SUCCESS path. Both clusters are DeletionPolicy Snapshot, so each
#      delete takes a final snapshot right after the flip, which needs the
#      cluster `available` again (issue #5184).
#   5. cdkd state list — must report empty for the stack
#   5b. exactly one cdkd final snapshot of each cluster since the run began
#       (issue #5184); deleted right after, and by cleanup on any exit
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
# Step 3g's out-of-band cluster members (issue #2204). Not in cdkd state, so
# cdkd's destroy cannot remove them: cleanup deletes them FIRST, or the retry
# destroy below cannot delete their clusters. Set just before each create.
OOB_DOCDB_INSTANCE_ID=""
OOB_NEPTUNE_INSTANCE_ID=""
# Step 3g's captured destroy output; removed by cleanup too, since a signal
# landing mid-destroy never reaches the step's own `rm`.
DESTROY_3G_LOG=""
# Step 3g's go-to-k/cdkd#2319 check: the deployments/*.jsonl keys before the
# destroy, and the RESOURCE_FAILED events read after it (AWS text: removed by
# cleanup on every exit).
EVENT_KEYS_3G=""
EVENTS_3G=""
# Step 3c's captured deploy output (issue #5544's warning is read from it).
REMOVAL_3C_LOG=""
# Issue #5184: when this run began (UTC, second precision, the prefix AWS's
# ClusterCreateTime is compared on). Set before anything is created, so
# cleanup can delete every final snapshot of the clusters this run created.
RUN_START="$(date -u +%Y-%m-%dT%H:%M:%S)"

# Print the manual snapshots of cluster $2 taken from a cluster CREATED at or
# after RUN_START, one id per line. Keyed on the source cluster's
# ClusterCreateTime, which a snapshot carries from its first listing, rather
# than SnapshotCreateTime, which a `creating` one may lack: an older snapshot
# of an earlier run's same-named cluster is never this run's. Fails (rc 1)
# when the listing or a timestamp is unreadable, so a caller cannot read an
# error as "none".
this_run_cluster_snapshots() { # usage: this_run_cluster_snapshots <docdb|neptune> <cluster id>
  local out
  out=$(aws "$1" describe-db-cluster-snapshots --db-cluster-identifier "$2" \
    --snapshot-type manual --region "${REGION}" --output json) || return 1
  echo "${out}" | jq -r --arg start "${RUN_START}" '
    .DBClusterSnapshots
    | if all(.[]; (.ClusterCreateTime // "") | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(\\+00:00|Z)$"))
      then .[] | select(.ClusterCreateTime[0:19] >= $start) | .DBClusterSnapshotIdentifier
      else error("unreadable ClusterCreateTime") end'
}

# Delete one cluster snapshot once it is `available` (one still `creating`
# refuses the delete; DocDB and Neptune have no snapshot waiter). Bounded. A
# snapshot already `deleting`, or gone, needs nothing more; a `failed` one is
# deleted at once.
delete_cluster_snapshot() { # usage: delete_cluster_snapshot <docdb|neptune> <snapshot id>
  local status err i
  # stderr apart from the status: a CLI warning line on a successful read
  # would otherwise match no arm below.
  err="$(mktemp)" || return 1
  for i in $(seq 1 60); do
    if ! status=$(aws "$1" describe-db-cluster-snapshots --db-cluster-snapshot-identifier "$2" \
      --region "${REGION}" --query 'DBClusterSnapshots[0].Status' --output text 2>"${err}"); then
      if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' "${err}"; then
        rm -f "${err}"
        return 0
      fi
      echo "[verify] WARN: could not read snapshot ${2}: $(cat "${err}")" >&2
      rm -f "${err}"
      return 1
    fi
    case "${status}" in
      deleting)
        rm -f "${err}"
        return 0
        ;;
      available | failed) break ;;
    esac
    if [ "${i}" -lt 60 ]; then
      sleep 10
    fi
  done
  rm -f "${err}"
  aws "$1" delete-db-cluster-snapshot --db-cluster-snapshot-identifier "$2" \
    --region "${REGION}" >/dev/null
}

# Delete every snapshot this run took of both clusters. Best-effort per
# snapshot; returns 1 when any listing or delete failed.
delete_this_run_snapshots() {
  local pair svc id snaps snap failed=0
  for pair in "docdb ${DOCDB_CLUSTER_ID}" "neptune ${NEPTUNE_CLUSTER_ID}"; do
    svc=${pair%% *}
    id=${pair#* }
    [ -n "${id}" ] || continue
    if ! snaps=$(this_run_cluster_snapshots "${svc}" "${id}"); then
      echo "[verify] WARN: could not list the manual snapshots of ${id}; check for a leftover by hand" >&2
      failed=1
      continue
    fi
    for snap in ${snaps}; do
      if delete_cluster_snapshot "${svc}" "${snap}"; then
        echo "[verify] deleted this run's snapshot ${snap}"
      else
        echo "[verify] WARN: could not delete snapshot ${snap}; delete it by hand" >&2
        failed=1
      fi
    done
  done
  return "${failed}"
}

# Delete one out-of-band instance and wait for it to be gone. A member still
# `creating` refuses the delete, so wait for `available` first. Best-effort:
# callers decide what a failure means.
delete_oob_instance() { # usage: delete_oob_instance <docdb|neptune> <instance id>
  aws "$1" wait db-instance-available --db-instance-identifier "$2" --region "${REGION}" || true
  aws "$1" delete-db-instance --db-instance-identifier "$2" --region "${REGION}" >/dev/null || return 1
  aws "$1" wait db-instance-deleted --db-instance-identifier "$2" --region "${REGION}"
}

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# This stack's deployments/*.jsonl keys, sorted, one per line (go-to-k/cdkd#2319).
# A failed listing returns non-zero, so a caller never reads an empty list as
# "no new events".
deployment_event_keys() {
  local listed
  listed="$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
    --prefix "${STATE_PREFIX}deployments/" --output json)" || return 1
  printf '%s' "${listed}" | jq -r '.Contents // [] | .[].Key | select(endswith(".jsonl"))' | LC_ALL=C sort
}

# On any failure exit, re-attempt destroy so we never leak DocDB /
# Neptune clusters. Best-effort DeletionProtection flip-offs first: an
# aborted run can die with the baseline (step-2) protection still live,
# which would refuse the delete otherwise (#1160 fixture shape).
cleanup() {
  rc=$?
  [ -n "${DESTROY_3G_LOG}" ] && rm -f "${DESTROY_3G_LOG}"
  [ -n "${EVENT_KEYS_3G}" ] && rm -f "${EVENT_KEYS_3G}"
  [ -n "${EVENTS_3G}" ] && rm -f "${EVENTS_3G}"
  [ -n "${REMOVAL_3C_LOG}" ] && rm -f "${REMOVAL_3C_LOG}"
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup destroy"
    # Step 3g's out-of-band members first: while one stands, its cluster's
    # DeleteDBCluster refuses and the destroy below leaks the whole stack.
    if [ -n "${OOB_DOCDB_INSTANCE_ID}" ]; then
      delete_oob_instance docdb "${OOB_DOCDB_INSTANCE_ID}" || true
    fi
    if [ -n "${OOB_NEPTUNE_INSTANCE_ID}" ]; then
      delete_oob_instance neptune "${OOB_NEPTUNE_INSTANCE_ID}" || true
    fi
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
    # --skip-final-snapshot: both clusters are DeletionPolicy Snapshot, and a
    # cleanup snapshot is not this run's evidence (issue #5184).
    ${CLI} destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET}" \
      --force \
      --remove-protection \
      --skip-final-snapshot \
      "${TIMEOUT_OVERRIDES[@]}" || true
  fi
  # Issue #5184: any final snapshot this run took, on every exit -- step 4's
  # destroy may have taken one before a later step failed.
  delete_this_run_snapshots || true
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

# AWS::DocDB::DBCluster is NON_PROVISIONABLE (Cloud Control has no handlers),
# so a property its SDK provider does not handle must stop the deploy BEFORE
# anything is provisioned (issue #3866). Before the fix the cluster was
# auto-routed to Cloud Control, which failed with UnsupportedActionException
# after the VPC and subnet group had been created -- also a non-zero exit, so
# the refusal's own wording is the discriminator, not the rc.
echo "[verify] step 1b: a CopyTagsToSnapshot property is refused pre-flight (issue #3866)"
# Precondition for the no-state assertion below: a state record left by an
# earlier, interrupted run would otherwise be blamed on this step.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it before running this fixture" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: step 1b pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
if REFUSAL_OUT="$(env CDKD_TEST_NONPROV_REFUSAL=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  "${TIMEOUT_OVERRIDES[@]}" 2>&1)"; then
  printf '%s\n' "${REFUSAL_OUT}" >&2
  echo "[verify] FAIL: step 1b deploy exited 0; CopyTagsToSnapshot on AWS::DocDB::DBCluster must be refused" >&2
  exit 1
fi
REFUSAL_PLAIN="$(printf '%s\n' "${REFUSAL_OUT}" | sed 's/\x1b\[[0-9;]*m//g')"
printf '%s\n' "${REFUSAL_PLAIN}" >&2
if printf '%s\n' "${REFUSAL_PLAIN}" | grep -qF 'UnsupportedActionException'; then
  echo "[verify] FAIL: step 1b routed the cluster to Cloud Control (the pre-#3866 behavior) instead of refusing pre-flight" >&2
  exit 1
fi
for needle in \
  'AWS::DocDB::DBCluster uses properties' \
  'cannot fall back to Cloud Control API' \
  '- CopyTagsToSnapshot: ' \
  '--prefer-sdk-route AWS::DocDB::DBCluster:CopyTagsToSnapshot'; do
  if ! printf '%s\n' "${REFUSAL_PLAIN}" | grep -qF -- "${needle}"; then
    echo "[verify] FAIL: step 1b output lacks the pre-flight refusal wording: '${needle}'" >&2
    exit 1
  fi
done
# Nothing may be provisioned, so no state record may exist. A probe failing
# for any reason other than not-found is undetermined and fails the run.
if HEAD_OUT="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: step 1b left a state record at ${STATE_KEY}; the refusal must precede provisioning" >&2
  exit 1
elif ! printf '%s' "${HEAD_OUT}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: step 1b state probe undetermined: ${HEAD_OUT}" >&2
  exit 1
fi
echo "[verify] step 1b ok: refused pre-flight, no state written"

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
# Issue #5184 premise: both clusters record DeletionPolicy Snapshot, so step 4's
# destroy takes a final snapshot after the flip. Without it the wait under test
# never runs and step 5b would fail for the wrong reason.
for type in AWS::DocDB::DBCluster AWS::Neptune::DBCluster; do
  policy=$(echo "${STATE}" | jq -r --arg t "${type}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .value.deletionPolicy // "absent"] | first // ""')
  if [ "${policy}" != "Snapshot" ]; then
    echo "[verify] FAIL: issue #5184 premise: ${type} records DeletionPolicy '${policy}', expected Snapshot" >&2
    exit 1
  fi
done

echo "[verify] step 3b: baseline #1160 / #5004 fields reached AWS"
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
NEPTUNE_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Neptune::DBInstance") | .value.physicalId] | first // ""')
if [ -z "${NEPTUNE_INSTANCE_ID}" ]; then
  echo "[verify] FAIL: could not resolve the Neptune instance identifier from state" >&2
  exit 1
fi
NEPTUNE_BASE_AMVU=$(aws neptune describe-db-instances --db-instance-identifier "${NEPTUNE_INSTANCE_ID}" \
  --region "${REGION}" --query 'DBInstances[0]' --output json \
  | jq -r 'if has("AutoMinorVersionUpgrade") then .AutoMinorVersionUpgrade | tostring else "null" end')
if [ "${NEPTUNE_BASE_AMVU}" != "false" ]; then
  echo "[verify] FAIL: Neptune instance baseline AutoMinorVersionUpgrade='${NEPTUNE_BASE_AMVU}', expected false" >&2
  exit 1
fi
# Issue #1160 Port removal arm: both clusters start on a non-default port.
DOCDB_BASE_PORT=$(echo "${DOCDB_BASE}" | jq -r '.Port // "null"')
NEPTUNE_BASE_PORT=$(echo "${NEPTUNE_BASE}" | jq -r '.Port // "null"')
if [ "${DOCDB_BASE_PORT}" != "27018" ] || [ "${NEPTUNE_BASE_PORT}" != "8183" ]; then
  echo "[verify] FAIL: #1160 premise: baseline cluster ports are docdb='${DOCDB_BASE_PORT}' (expected 27018), neptune='${NEPTUNE_BASE_PORT}' (expected 8183)" >&2
  exit 1
fi
# Issue #5544 premise: the Neptune engine, backup window and both custom
# parameter groups are live, so step 3d's KEPT assertions bind to non-default
# values (the default engine is 1.4.8.0, the default groups default.neptune1.4).
NEPTUNE_CLUSTER_PG=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Neptune::DBClusterParameterGroup") | .value.physicalId] | first // ""')
NEPTUNE_INSTANCE_PG=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Neptune::DBParameterGroup") | .value.physicalId] | first // ""')
if [ -z "${NEPTUNE_CLUSTER_PG}" ] || [ -z "${NEPTUNE_INSTANCE_PG}" ]; then
  echo "[verify] FAIL: #5544: could not resolve the Neptune parameter groups from state (cluster='${NEPTUNE_CLUSTER_PG}', instance='${NEPTUNE_INSTANCE_PG}')" >&2
  exit 1
fi
# Neptune stores a parameter group name lower-cased, whatever case the
# create sent, and describe answers it that way.
NEPTUNE_CLUSTER_PG=$(printf '%s' "${NEPTUNE_CLUSTER_PG}" | tr '[:upper:]' '[:lower:]')
NEPTUNE_INSTANCE_PG=$(printf '%s' "${NEPTUNE_INSTANCE_PG}" | tr '[:upper:]' '[:lower:]')
NEPTUNE_BASE_KEPT=$(echo "${NEPTUNE_BASE}" | jq -r '[.EngineVersion, .PreferredBackupWindow, .DBClusterParameterGroup] | map(. // "null") | join(" ")')
NEPTUNE_BASE_INST_PG=$(aws neptune describe-db-instances --db-instance-identifier "${NEPTUNE_INSTANCE_ID}" \
  --region "${REGION}" --query 'DBInstances[0]' --output json \
  | jq -r '[.DBParameterGroups[]?.DBParameterGroupName] | join(",")')
if [ "${NEPTUNE_BASE_KEPT}" != "1.4.7.0 03:00-03:30 ${NEPTUNE_CLUSTER_PG}" ] || [ "${NEPTUNE_BASE_INST_PG}" != "${NEPTUNE_INSTANCE_PG}" ]; then
  echo "[verify] FAIL: #5544 premise: Neptune baseline engine / backup window / cluster parameter group are '${NEPTUNE_BASE_KEPT}' (expected '1.4.7.0 03:00-03:30 ${NEPTUNE_CLUSTER_PG}'), instance parameter groups '${NEPTUNE_BASE_INST_PG}' (expected '${NEPTUNE_INSTANCE_PG}')" >&2
  exit 1
fi
echo "[verify] step 3b ok: baseline non-default fields live on both clusters and the Neptune instance"

# Issue #1160 VpcSecurityGroupIds removal arm. The baseline puts both clusters
# on the stack's `Sg`; step 3c drops VpcSecurityGroupIds from both. A real
# CloudFormation A/B showed CloudFormation moves a Neptune cluster to the VPC's
# `default` group and KEEPS a DocDB cluster's groups, so step 3d asserts
# Neptune -> default and DocDB -> Sg.
# cluster_sgs <docdb|neptune> <cluster id>: "<sg id>:<status>" pairs, sorted.
cluster_sgs() {
  local out
  out=$(aws "$1" describe-db-clusters --db-cluster-identifier "$2" --region "${REGION}" \
    --query 'DBClusters[0].VpcSecurityGroups' --output json) || return 1
  echo "${out}" | jq -r '[(. // [])[] | "\(.VpcSecurityGroupId):\(.Status)"] | sort | join(" ")'
}
CUSTOM_SG_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup" and (.key | test("^Sg"))) | .value.physicalId] | first // ""')
VPC_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::VPC") | .value.physicalId] | first // ""')
DEFAULT_SG_ID=""
if [ -n "${VPC_ID}" ]; then
  DEFAULT_SG_ID=$(aws ec2 describe-security-groups --region "${REGION}" \
    --filters "Name=vpc-id,Values=${VPC_ID}" "Name=group-name,Values=default" \
    --query 'SecurityGroups[0].GroupId' --output text)
fi
case "${CUSTOM_SG_ID}" in sg-?*) ;; *) echo "[verify] FAIL: could not resolve the stack's Sg id from state (got '${CUSTOM_SG_ID}')" >&2; exit 1 ;; esac
# --output text prints `None` for an empty match, so match the id shape.
case "${DEFAULT_SG_ID}" in sg-?*) ;; *) echo "[verify] FAIL: could not resolve the default security group of VPC '${VPC_ID}' (got '${DEFAULT_SG_ID}')" >&2; exit 1 ;; esac
if [ "${CUSTOM_SG_ID}" = "${DEFAULT_SG_ID}" ]; then
  echo "[verify] FAIL: #1160 premise: the stack's Sg is the VPC default group, so the removal arm could not tell the two apart" >&2
  exit 1
fi
DOCDB_BASE_SGS=$(cluster_sgs docdb "${DOCDB_CLUSTER_ID}")
NEPTUNE_BASE_SGS=$(cluster_sgs neptune "${NEPTUNE_CLUSTER_ID}")
if [ "${DOCDB_BASE_SGS}" != "${CUSTOM_SG_ID}:active" ] || [ "${NEPTUNE_BASE_SGS}" != "${CUSTOM_SG_ID}:active" ]; then
  echo "[verify] FAIL: #1160 premise: both clusters must start on Sg only (want '${CUSTOM_SG_ID}:active'; docdb='${DOCDB_BASE_SGS}', neptune='${NEPTUNE_BASE_SGS}')" >&2
  exit 1
fi
echo "[verify] step 3b ok: both clusters on Sg ${CUSTOM_SG_ID}, not the VPC default ${DEFAULT_SG_ID} (#1160 premise)"

# Issue #3650: each SSM parameter carries one DocDB / Neptune endpoint
# `Fn::GetAtt`. Before the fix every one held the cluster / instance
# IDENTIFIER, because cdkd recorded only RDS-style dotted keys these services
# do not use. Checked after the create (step 3e) and again after the
# CDKD_TEST_REMOVAL redeploy (step 3f), whose UPDATE rewrites the records.
check_endpoints() { # usage: check_endpoints <step label>
  local state docdb_cluster neptune_cluster docdb_instance_id neptune_instance_id
  local docdb_instance_endpoint neptune_instance_endpoint
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  docdb_instance_id=$(echo "${state}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::DocDB::DBInstance") | .value.physicalId] | first // ""') || return 1
  neptune_instance_id=$(echo "${state}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Neptune::DBInstance") | .value.physicalId] | first // ""') || return 1
  if [ -z "${docdb_instance_id}" ] || [ -z "${neptune_instance_id}" ]; then
    echo "[verify] FAIL: could not resolve instance identifiers from state (docdb='${docdb_instance_id}', neptune='${neptune_instance_id}')" >&2
    return 1
  fi
  docdb_cluster=$(aws docdb describe-db-clusters --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
    --region "${REGION}" --query 'DBClusters[0]' --output json) || return 1
  neptune_cluster=$(aws neptune describe-db-clusters --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
    --region "${REGION}" --query 'DBClusters[0]' --output json) || return 1
  docdb_instance_endpoint=$(aws docdb describe-db-instances --db-instance-identifier "${docdb_instance_id}" \
    --region "${REGION}" --query 'DBInstances[0].Endpoint.Address' --output text) || return 1
  neptune_instance_endpoint=$(aws neptune describe-db-instances --db-instance-identifier "${neptune_instance_id}" \
    --region "${REGION}" --query 'DBInstances[0].Endpoint.Address' --output text) || return 1
  ENDPOINT_FAILED=0
  check_param "${state}" DocdbClusterEndpointParam "$(echo "${docdb_cluster}" | jq -r '.Endpoint')" || return 1
  check_param "${state}" DocdbClusterPortParam "$(echo "${docdb_cluster}" | jq -r '.Port')" || return 1
  check_param "${state}" DocdbClusterReadEndpointParam "$(echo "${docdb_cluster}" | jq -r '.ReaderEndpoint')" || return 1
  check_param "${state}" DocdbInstanceEndpointParam "${docdb_instance_endpoint}" || return 1
  check_param "${state}" NeptuneClusterEndpointParam "$(echo "${neptune_cluster}" | jq -r '.Endpoint')" || return 1
  check_param "${state}" NeptuneClusterPortParam "$(echo "${neptune_cluster}" | jq -r '.Port')" || return 1
  check_param "${state}" NeptuneClusterReadEndpointParam "$(echo "${neptune_cluster}" | jq -r '.ReaderEndpoint')" || return 1
  check_param "${state}" NeptuneInstanceEndpointParam "${neptune_instance_endpoint}" || return 1
  [ "${ENDPOINT_FAILED}" = 0 ] || return 1
  echo "[verify] $1 ok: all eight endpoint attributes resolved to AWS's values"
}
check_param() { # usage: check_param <state json> <logical id> <expected value>
  local name got
  name=$(echo "$1" | jq -r --arg l "$2" '.resources[$l].physicalId // ""') || return 1
  if [ -z "${name}" ]; then
    echo "[verify] FAIL: $2 has no state record" >&2
    ENDPOINT_FAILED=1
    return 0
  fi
  got=$(aws ssm get-parameter --name "${name}" --region "${REGION}" --query Parameter.Value --output text) || return 1
  if [ "${got}" != "$3" ]; then
    echo "[verify] FAIL: $2 holds '${got}', want '$3'" >&2
    ENDPOINT_FAILED=1
  fi
}

echo "[verify] step 3e: endpoint Fn::GetAtt values reached their consumers (issue #3650)"
check_endpoints "step 3e"

# Issue #2613: the step-3c redeploy also changes the DocDB subnet group's
# description, an in-place ModifyDBSubnetGroup through the provider's update().
# The generated name is deterministic, so a replacement would come back under
# the SAME name and this check cannot tell the two apart; a replacement fails
# the deploy itself instead (the cluster still uses the group, and the create
# collides with the name). What is checked here is that the description applied.
DOCDB_SG_NAME=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.DocdbSubnetGroup.physicalId // ""')
if [ -z "${DOCDB_SG_NAME}" ]; then
  echo "[verify] FAIL: DocdbSubnetGroup has no physicalId in state before step 3c" >&2
  exit 1
fi
DOCDB_SG_DESC=$(aws docdb describe-db-subnet-groups --db-subnet-group-name "${DOCDB_SG_NAME}" \
  --region "${REGION}" --query 'DBSubnetGroups[0].DBSubnetGroupDescription' --output text)
if [ "${DOCDB_SG_DESC}" != "cdkd integ docdb subnet group" ]; then
  echo "[verify] FAIL: DocDB subnet group ${DOCDB_SG_NAME} description is '${DOCDB_SG_DESC}' after create, expected 'cdkd integ docdb subnet group'" >&2
  exit 1
fi

echo "[verify] step 3c: CDKD_TEST_REMOVAL=true redeploy (DROP the #1160 / #5004 fields)"
REMOVAL_3C_LOG="$(mktemp)"
if ! CDKD_TEST_REMOVAL=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --verbose \
  "${TIMEOUT_OVERRIDES[@]}" 2>&1 | tee "${REMOVAL_3C_LOG}"; then
  # pipefail: the deploy's own exit code, with its output streamed live.
  echo "[verify] FAIL: step 3c removal redeploy failed" >&2
  exit 1
fi
REMOVAL_3C_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${REMOVAL_3C_LOG}")"
rm -f "${REMOVAL_3C_LOG}"
REMOVAL_3C_LOG=""

echo "[verify] step 3d: wait for both clusters to be available, then assert the baseline values are RETAINED (#5004)"
# Cluster modifies can take a couple of minutes to settle; bounded retry,
# no sleep after the final poll. Retention is read AFTER a settle pause: a
# regression that resets a field applies it through ModifyDBCluster, and the
# pause lets a pending change land before it is read.
read_state() {
  DOCDB_AFTER=$(aws docdb describe-db-clusters \
    --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json) || return 1
  DOCDB_STATUS=$(echo "${DOCDB_AFTER}" | jq -r '.Status // "null"') || return 1
  if [ "${DOCDB_STATUS}" = "resetting-master-credentials" ]; then
    DOCDB_RESET_SEEN="yes"
  fi
  DOCDB_PROT=$(echo "${DOCDB_AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end') || return 1
  DOCDB_RETENTION=$(echo "${DOCDB_AFTER}" | jq -r '.BackupRetentionPeriod // "null"') || return 1
  DOCDB_MW=$(echo "${DOCDB_AFTER}" | jq -r '.PreferredMaintenanceWindow // "null"') || return 1
  NEPTUNE_AFTER=$(aws neptune describe-db-clusters \
    --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0]' --output json) || return 1
  NEPTUNE_STATUS=$(echo "${NEPTUNE_AFTER}" | jq -r '.Status // "null"') || return 1
  NEPTUNE_PROT=$(echo "${NEPTUNE_AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end') || return 1
  NEPTUNE_RETENTION=$(echo "${NEPTUNE_AFTER}" | jq -r '.BackupRetentionPeriod // "null"') || return 1
  NEPTUNE_MW=$(echo "${NEPTUNE_AFTER}" | jq -r '.PreferredMaintenanceWindow // "null"') || return 1
  NEPTUNE_IAM=$(echo "${NEPTUNE_AFTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end') || return 1
  NEPTUNE_INST_AFTER=$(aws neptune describe-db-instances --db-instance-identifier "${NEPTUNE_INSTANCE_ID}" \
    --region "${REGION}" --query 'DBInstances[0]' --output json) || return 1
  NEPTUNE_INST_MW=$(echo "${NEPTUNE_INST_AFTER}" | jq -r '.PreferredMaintenanceWindow // "null"') || return 1
  NEPTUNE_AMVU=$(echo "${NEPTUNE_INST_AFTER}" \
    | jq -r 'if has("AutoMinorVersionUpgrade") then .AutoMinorVersionUpgrade | tostring else "null" end') || return 1
}
DOCDB_STATUS="" DOCDB_PROT="" DOCDB_RETENTION="" DOCDB_MW=""
NEPTUNE_STATUS="" NEPTUNE_PROT="" NEPTUNE_RETENTION="" NEPTUNE_IAM="" NEPTUNE_AMVU="" NEPTUNE_MW="" NEPTUNE_INST_MW=""
# Issue #5153: step 3c leaves the DocDB cluster's templated MasterUserPassword
# unchanged, so cdkd must not send it. A sent password resets the master
# credentials, and the cluster shows `resetting-master-credentials` for a while
# after the deploy returns. Every read_state below records that status, starting
# with this short window right after the deploy; the check follows step 3d's
# stability loop.
DOCDB_RESET_SEEN=""
for i in $(seq 1 12); do
  read_state || exit 1
  if [ "${i}" -lt 12 ]; then
    sleep 5
  fi
done
SETTLED=""
for i in $(seq 1 60); do
  read_state || exit 1
  if [ "${DOCDB_STATUS}" = "available" ] && [ "${NEPTUNE_STATUS}" = "available" ]; then
    SETTLED="yes"
    break
  fi
  if [ "${i}" -lt 60 ]; then
    sleep 10
  fi
done
if [ -z "${SETTLED}" ]; then
  echo "[verify] FAIL: clusters did not become available after the removal redeploy (docdb='${DOCDB_STATUS}', neptune='${NEPTUNE_STATUS}')" >&2
  exit 1
fi
sleep 30
# A cluster can leave `available` again right after the first read (an update
# that sent a password, which the #5153 check below refuses, is one cause).
# So the reads below are taken only once BOTH clusters read `available` on two
# consecutive polls; the last poll's values are the ones asserted.
STABLE=""
PREV_AVAILABLE=""
for i in $(seq 1 60); do
  read_state || exit 1
  if [ "${DOCDB_STATUS}" = "available" ] && [ "${NEPTUNE_STATUS}" = "available" ]; then
    if [ -n "${PREV_AVAILABLE}" ]; then
      STABLE="yes"
      break
    fi
    PREV_AVAILABLE="yes"
  else
    PREV_AVAILABLE=""
  fi
  if [ "${i}" -lt 60 ]; then
    sleep 10
  fi
done
if [ -z "${STABLE}" ]; then
  echo "[verify] FAIL: clusters did not stay available across two consecutive reads after the removal redeploy (docdb='${DOCDB_STATUS}', neptune='${NEPTUNE_STATUS}')" >&2
  exit 1
fi
if [ -n "${DOCDB_RESET_SEEN}" ]; then
  echo "[verify] FAIL: #5153: the DocDB cluster entered 'resetting-master-credentials' after the step-3c redeploy, which did not change MasterUserPassword: cdkd re-sent the unchanged password (CloudFormation sends only a changed one)" >&2
  exit 1
fi
echo "[verify] step 3d ok: the DocDB cluster never read 'resetting-master-credentials' after the step-3c redeploy — unchanged MasterUserPassword not re-sent (#5153)"
# Companion-change guard (#5004): the maintenance window moved tue -> wed in
# the SAME removal deploy, so these must already read the new value. If a
# Modify* call was never sent, they still read tue and this fails BEFORE the
# retention assertions below could pass vacuously.
if [ "${DOCDB_MW}" != "wed:05:00-wed:05:30" ] || [ "${NEPTUNE_MW}" != "wed:05:00-wed:05:30" ] \
  || [ "${NEPTUNE_INST_MW}" != "wed:06:00-wed:06:30" ]; then
  echo "[verify] FAIL: the removal redeploy's companion change (PreferredMaintenanceWindow tue -> wed) is not live, so the Modify* calls did not fire and the KEEP assertions would be vacuous (#5004)" >&2
  echo "  docdb cluster='${DOCDB_MW}' (expected wed:05:00-wed:05:30) neptune cluster='${NEPTUNE_MW}' (expected wed:05:00-wed:05:30) neptune instance='${NEPTUNE_INST_MW}' (expected wed:06:00-wed:06:30)" >&2
  exit 1
fi
echo "[verify] step 3d: companion PreferredMaintenanceWindow change is live on DocDB cluster, Neptune cluster and Neptune instance — Modify* fired"
if [ "${DOCDB_STATUS}" != "available" ] || [ "${DOCDB_PROT}" != "true" ] || [ "${DOCDB_RETENTION}" != "7" ] \
  || [ "${NEPTUNE_STATUS}" != "available" ] || [ "${NEPTUNE_PROT}" != "true" ] || [ "${NEPTUNE_RETENTION}" != "7" ] || [ "${NEPTUNE_IAM}" != "true" ] \
  || [ "${NEPTUNE_AMVU}" != "false" ]; then
  echo "[verify] FAIL: a removed property was reset — CloudFormation KEEPS the live value (#5004)" >&2
  echo "  docdb:   status='${DOCDB_STATUS}' protection='${DOCDB_PROT}' retention='${DOCDB_RETENTION}' (expected available/true/7)" >&2
  echo "  neptune: status='${NEPTUNE_STATUS}' protection='${NEPTUNE_PROT}' retention='${NEPTUNE_RETENTION}' iamAuth='${NEPTUNE_IAM}' autoMinorVersionUpgrade='${NEPTUNE_AMVU}' (expected available/true/7/true/false)" >&2
  exit 1
fi
echo "[verify] step 3d ok: DeletionProtection=true + BackupRetentionPeriod=7 (+ Neptune IAMDatabaseAuthenticationEnabled=true, instance AutoMinorVersionUpgrade=false) retained after removal — #5004"

# Issue #1160: Port was removed from both clusters. A real CloudFormation A/B
# resets a DocDB cluster to 27017 and keeps a Neptune cluster's port; a pre-fix
# cdkd sends nothing and DocDB stays on 27018, which fails HERE. Read from the
# step-3d stable poll above, taken after the deploy returned: cdkd waits for a
# changed port before it finishes the cluster update.
DOCDB_PORT=$(echo "${DOCDB_AFTER}" | jq -r '.Port // "null"')
NEPTUNE_PORT=$(echo "${NEPTUNE_AFTER}" | jq -r '.Port // "null"')
if [ "${DOCDB_PORT}" != "27017" ]; then
  echo "[verify] FAIL: #1160: after Port was removed, the DocDB cluster's port is '${DOCDB_PORT}', want '27017' (CloudFormation resets it to the default; still 27018 means the removal sent nothing)" >&2
  exit 1
fi
if [ "${NEPTUNE_PORT}" != "8183" ]; then
  echo "[verify] FAIL: #1160: after DBPort was removed, the Neptune cluster's port is '${NEPTUNE_PORT}', want '8183' (CloudFormation keeps the live port)" >&2
  exit 1
fi
echo "[verify] step 3d ok: Port removal: DocDB reset to 27017, Neptune kept 8183 (#1160, matches CloudFormation)"

# Issue #5544: the Neptune engine, backup window and both parameter groups were
# removed; a real CloudFormation A/B keeps every one. Read from the stable poll
# above, after the companion change was seen live.
NEPTUNE_KEPT=$(echo "${NEPTUNE_AFTER}" | jq -r '[.EngineVersion, .PreferredBackupWindow, .DBClusterParameterGroup] | map(. // "null") | join(" ")')
NEPTUNE_INST_PG=$(echo "${NEPTUNE_INST_AFTER}" | jq -r '[.DBParameterGroups[]?.DBParameterGroupName] | join(",")')
if [ "${NEPTUNE_KEPT}" != "1.4.7.0 03:00-03:30 ${NEPTUNE_CLUSTER_PG}" ] || [ "${NEPTUNE_INST_PG}" != "${NEPTUNE_INSTANCE_PG}" ]; then
  echo "[verify] FAIL: #5544: after the removal, the Neptune engine / backup window / cluster parameter group are '${NEPTUNE_KEPT}' (want '1.4.7.0 03:00-03:30 ${NEPTUNE_CLUSTER_PG}') and the instance parameter groups '${NEPTUNE_INST_PG}' (want '${NEPTUNE_INSTANCE_PG}'): CloudFormation keeps all of them" >&2
  exit 1
fi
# The kept removals are named, one line per resource. Before #5544 cdkd kept
# them silently, so this is the arm's only post-fix-only assertion.
for needle in \
  "NeptuneCluster (AWS::Neptune::DBCluster): properties EngineVersion, PreferredBackupWindow, DBClusterParameterGroupName, DeletionProtection, IamAuthEnabled, BackupRetentionPeriod, DBPort were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does. Declare them to change them." \
  "NeptuneInstance (AWS::Neptune::DBInstance): properties DBParameterGroupName, AutoMinorVersionUpgrade were removed from the template; cdkd leaves the current AWS values in place, as CloudFormation does. Declare them to change them."; do
  if ! grep -qF "${needle}" <<<"${REMOVAL_3C_PLAIN}"; then
    echo "[verify] FAIL: #5544: the step-3c deploy output lacks the kept-removal warning '${needle}'" >&2
    exit 1
  fi
done
echo "[verify] step 3d ok: Neptune engine, backup window and both parameter groups kept after removal and named in cdkd's warning (#5544, matches CloudFormation)"

# Issue #1160: VpcSecurityGroupIds was removed from both clusters. Neptune must
# move to the VPC default group, as CloudFormation does; a pre-fix cdkd sends
# nothing and the cluster stays on Sg, which fails HERE. Polled, because the
# group swap can sit in `adding` / `removing` for a while after `available`.
NEPTUNE_SGS=""
for i in $(seq 1 30); do
  NEPTUNE_SGS=$(cluster_sgs neptune "${NEPTUNE_CLUSTER_ID}")
  [ "${NEPTUNE_SGS}" = "${DEFAULT_SG_ID}:active" ] && break
  if [ "${i}" -lt 30 ]; then
    sleep 10
  fi
done
if [ "${NEPTUNE_SGS}" != "${DEFAULT_SG_ID}:active" ]; then
  echo "[verify] FAIL: #1160: after VpcSecurityGroupIds was removed, the Neptune cluster's groups are '${NEPTUNE_SGS}', want '${DEFAULT_SG_ID}:active' (the VPC default group, as CloudFormation does; still '${CUSTOM_SG_ID}' means the removal sent nothing)" >&2
  exit 1
fi
# DocDB: CloudFormation KEEPS the groups. Read after the Neptune poll, so a
# reset sent through the same deploy has had the same time to land.
DOCDB_SGS=$(cluster_sgs docdb "${DOCDB_CLUSTER_ID}")
if [ "${DOCDB_SGS}" != "${CUSTOM_SG_ID}:active" ]; then
  echo "[verify] FAIL: #1160: after VpcSecurityGroupIds was removed, the DocDB cluster's groups are '${DOCDB_SGS}', want '${CUSTOM_SG_ID}:active' (CloudFormation keeps a DocDB cluster's groups)" >&2
  exit 1
fi
echo "[verify] step 3d ok: VpcSecurityGroupIds removal: Neptune moved to the VPC default ${DEFAULT_SG_ID}, DocDB kept Sg ${CUSTOM_SG_ID} (#1160, matches CloudFormation)"

# Issue #2613: the description must have changed on the recorded group.
if ! DOCDB_SG_DESC=$(aws docdb describe-db-subnet-groups --db-subnet-group-name "${DOCDB_SG_NAME}" \
  --region "${REGION}" --query 'DBSubnetGroups[0].DBSubnetGroupDescription' --output text); then
  echo "[verify] FAIL: DocDB subnet group ${DOCDB_SG_NAME} is gone after step 3c (issue #2613: the description change must update the group in place)" >&2
  exit 1
fi
if [ "${DOCDB_SG_DESC}" != "cdkd integ docdb subnet group (updated)" ]; then
  echo "[verify] FAIL: DocDB subnet group ${DOCDB_SG_NAME} description is '${DOCDB_SG_DESC}' after step 3c, expected 'cdkd integ docdb subnet group (updated)' (issue #2613: the subnet group update() did not apply)" >&2
  exit 1
fi
echo "[verify] step 3c ok: DocDB subnet group description updated (issue #2613)"

echo "[verify] step 3f: endpoint Fn::GetAtt values after the UPDATE redeploy (issue #3650)"
check_endpoints "step 3f"

# --- Step 3g: --remove-protection compensation (issue #2204) -------------
# The failure has to be TERMINAL (a retryable one is retried, and a sequence
# that exhausts its attempts is a deliberate non-compensated case) and has to
# land AFTER the flip but BEFORE AWS accepts the delete. A cluster member cdkd
# does not own gives exactly that: cdkd deletes its own instance, flips the
# cluster's guard off, and DeleteDBCluster refuses (InvalidDBClusterStateFault,
# "still contains DB instances"), which matches no retryable pattern.
#
# The discriminator is the READBACK, not cdkd's output: before #2204 the flip
# was never undone, so both clusters read DeletionProtection=false here. (The
# guard is already ON going in, since a removed DeletionProtection is kept, #5004;
# the out-of-band re-enable below is then idempotent.)
#
# COST, stated so a slow run is not read as a hang. cdkd's destroy has no
# per-resource target and its level loop does not stop at a failure, so this
# destroy deletes everything it can and keeps going below the refused
# clusters. Their subnet groups, the shared SG, the subnets and the VPC are
# still held by the out-of-band members' ENIs and answer DependencyViolation,
# which the EC2 provider and the destroy loop both retry: expect this step to
# add tens of minutes. The failure-set assertion below proves nothing ELSE
# failed along the way, and step 4 deletes what is left.
echo "[verify] step 3g: --remove-protection compensation after a terminal delete failure (issue #2204)"
aws docdb modify-db-cluster --db-cluster-identifier "${DOCDB_CLUSTER_ID}" \
  --region "${REGION}" --deletion-protection --apply-immediately >/dev/null
aws neptune modify-db-cluster --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" \
  --region "${REGION}" --deletion-protection --apply-immediately >/dev/null

# PREMISE: the guard is ON before the destroy. Without it the arm is vacuous --
# a guard that was already off must be LEFT off, so "false afterwards" would
# then be the correct answer rather than the bug.
cluster_protection() { # usage: cluster_protection <docdb|neptune> <cluster id>
  local out
  out=$(aws "$1" describe-db-clusters --db-cluster-identifier "$2" \
    --region "${REGION}" --query 'DBClusters[0]' --output json) || return 1
  echo "${out}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end'
}
DOCDB_PRE=$(cluster_protection docdb "${DOCDB_CLUSTER_ID}")
NEPTUNE_PRE=$(cluster_protection neptune "${NEPTUNE_CLUSTER_ID}")
if [ "${DOCDB_PRE}" != "true" ] || [ "${NEPTUNE_PRE}" != "true" ]; then
  echo "[verify] FAIL: step 3g premise: DeletionProtection not ON before the destroy (docdb='${DOCDB_PRE}', neptune='${NEPTUNE_PRE}')" >&2
  exit 1
fi

# Run-unique names, so a leftover from an aborted run cannot collide. Each id
# is recorded BEFORE its create: a create AWS accepted but the CLI reported as
# failed must still be deleted by cleanup (deleting an absent one is absorbed).
OOB_SUFFIX="$(date +%s)"
OOB_DOCDB_INSTANCE_ID="cdkd-dn-oob-docdb-${OOB_SUFFIX}"
aws docdb create-db-instance --db-instance-identifier "${OOB_DOCDB_INSTANCE_ID}" \
  --db-instance-class db.t3.medium --engine docdb \
  --db-cluster-identifier "${DOCDB_CLUSTER_ID}" --region "${REGION}" >/dev/null
OOB_NEPTUNE_INSTANCE_ID="cdkd-dn-oob-neptune-${OOB_SUFFIX}"
aws neptune create-db-instance --db-instance-identifier "${OOB_NEPTUNE_INSTANCE_ID}" \
  --db-instance-class db.t3.medium --engine neptune \
  --db-cluster-identifier "${NEPTUNE_CLUSTER_ID}" --region "${REGION}" >/dev/null
# Wait for both to be `available`: a member still `creating` also blocks the
# cluster delete, but waiting takes the create's own timing out of the arm, and
# cleanup can only delete an available member anyway.
aws docdb wait db-instance-available --db-instance-identifier "${OOB_DOCDB_INSTANCE_ID}" --region "${REGION}"
aws neptune wait db-instance-available --db-instance-identifier "${OOB_NEPTUNE_INSTANCE_ID}" --region "${REGION}"

EVENT_KEYS_3G="$(mktemp)"
if ! deployment_event_keys > "${EVENT_KEYS_3G}"; then
  echo "[verify] FAIL: step 3g: could not list the deployments/ prefix before the destroy" >&2
  exit 1
fi
DESTROY_3G_LOG="$(mktemp)"
if ${CLI} destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  --remove-protection \
  "${TIMEOUT_OVERRIDES[@]}" >"${DESTROY_3G_LOG}" 2>&1; then
  cat "${DESTROY_3G_LOG}" >&2
  echo "[verify] FAIL: step 3g destroy exited 0; both clusters still hold an out-of-band member, so DeleteDBCluster must refuse" >&2
  exit 1
fi
DESTROY_3G_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${DESTROY_3G_LOG}")"
rm -f "${DESTROY_3G_LOG}"
DESTROY_3G_LOG=""
printf '%s\n' "${DESTROY_3G_PLAIN}" >&2
# PREMISE: the failure is the engineered one. A destroy that died earlier (a
# credential error, a region refusal) never reached the flip, so a guard still
# ON afterwards would pass the readback below while testing nothing. The
# thrown wrap names AWS's error by its class only (go-to-k/cdkd#2319), and this
# destroy runs without --verbose, so the member refusal is read as each
# provider's DeleteDBCluster catch-wrap with the class DeleteDBCluster answers
# it with. The failure-set check below rules out an earlier death.
for premise in "Failed to delete DocDB DBCluster DocdbCluster" "Failed to delete Neptune DBCluster NeptuneCluster"; do
  if ! grep -qF "${premise}: InvalidDBClusterStateFault. Re-run with --verbose" <<<"${DESTROY_3G_PLAIN}"; then
    echo "[verify] FAIL: step 3g destroy failed, but not with '${premise}: InvalidDBClusterStateFault' (DeleteDBCluster's member refusal) -- the arm did not reach the compensation" >&2
    exit 1
  fi
done
# The FAILURE SET: both clusters, and nothing but them and what the
# out-of-band members' ENIs hold (subnet groups, the shared SG, the VPC and its
# subnets). Anything else failing here would otherwise be absorbed silently by
# step 4's destroy.
FAILED_3G="$(printf '%s\n' "${DESTROY_3G_PLAIN}" | sed -n 's/^.*✗ Failed to delete \([A-Za-z0-9]*\):.*$/\1/p' | sort -u)"
for cluster_lid in DocdbCluster NeptuneCluster; do
  if ! printf '%s\n' "${FAILED_3G}" | grep -qx "${cluster_lid}"; then
    echo "[verify] FAIL: step 3g: ${cluster_lid} is not among the failed deletes (got: $(printf '%s ' ${FAILED_3G}))" >&2
    exit 1
  fi
done
# NeptuneClusterParams / NeptuneInstanceParams: the NeptuneCluster delete fails
# on purpose, and destroy's level loop does not skip dependents, so the parameter
# groups (NeptuneCluster depends on them) are attempted too and fail because the
# surviving cluster still has them attached.
UNEXPECTED_3G="$(printf '%s\n' "${FAILED_3G}" | grep -vE '^(DocdbCluster|NeptuneCluster|NeptuneClusterParams|NeptuneInstanceParams|DocdbSubnetGroup|NeptuneSubnetGroup|Sg[0-9A-F]{8}|Vpc[A-Za-z0-9]*)$' || true)"
if [ -n "${UNEXPECTED_3G}" ]; then
  echo "[verify] FAIL: step 3g: deletes failed outside the engineered set: $(printf '%s ' ${UNEXPECTED_3G})" >&2
  exit 1
fi
# go-to-k/cdkd#2319: the failed deletes' persisted RESOURCE_FAILED events name
# AWS's refusal by its class, and deployments/*.jsonl outlives the run. The
# engineered member refusal may quote no account id, so the account-id check
# guards a regression rather than proving this change. Only this destroy's
# new event files are read, so an earlier run's events cannot answer.
EVENTS_3G="$(mktemp)"
if ! NEW_EVENT_KEYS_3G="$(deployment_event_keys | LC_ALL=C comm -13 "${EVENT_KEYS_3G}" -)"; then
  echo "[verify] FAIL: step 3g: could not list the deployments/ prefix after the destroy" >&2
  exit 1
fi
while IFS= read -r event_key || [ -n "${event_key}" ]; do
  [ -n "${event_key}" ] || continue
  aws s3 cp "s3://${STATE_BUCKET}/${event_key}" - --quiet \
    | jq -c 'select(.eventType == "RESOURCE_FAILED")' >> "${EVENTS_3G}"
done <<< "${NEW_EVENT_KEYS_3G}"
EVENT_ACCOUNT_3G="${ACCOUNT_ID}"
# A FAIL prints only the cdkd-authored prefix and the length: the rest may be
# AWS's text, naming accounts, roles or sessions.
# The cdkd-authored prefix of a persisted message, never AWS's text: a message
# with no colon has no prefix of cdkd's (go-to-k/cdkd#2319).
msg_prefix() { case "$1" in *:*) printf '%s' "${1%%:*}" ;; *) printf '<none>' ;; esac; }
assert_failed_event_class_only_3G() { # usage: <logicalId> <wrap prefix>
  local msg
  # One value, not a line: a message can span lines.
  msg="$(jq -rs --arg l "$1" '[.[] | select(.logicalId == $l) | .error.message // empty] | last // empty' "${EVENTS_3G}")"
  if [ -z "${msg}" ]; then
    echo "[verify] FAIL: step 3g: the destroy persisted no RESOURCE_FAILED event with an error message for $1 (the #2319 checks below would pass for free)" >&2
    exit 1
  fi
  if ! printf '%s' "${msg}" | grep -qE "$2: [A-Za-z0-9]+\. Re-run with --verbose for AWS's own message\."; then
    echo "[verify] FAIL: step 3g: $1's RESOURCE_FAILED message is not '$2: <ErrorClass>. Re-run with --verbose for AWS's own message.' (#2319); observed prefix: '$(msg_prefix "${msg}")', ${#msg} chars" >&2
    exit 1
  fi
  # Every FAILED event this destroy wrote for it, not only the last.
  if jq -r --arg l "$1" 'select(.logicalId == $l) | .error.message // empty' "${EVENTS_3G}" \
    | grep -F "${EVENT_ACCOUNT_3G}" >/dev/null; then
    echo "[verify] FAIL: step 3g: $1's RESOURCE_FAILED message quotes AWS's text, with this account's id (#2319); observed prefix: '$(msg_prefix "${msg}")', ${#msg} chars" >&2
    exit 1
  fi
}
assert_failed_event_class_only_3G DocdbCluster "Failed to delete DocDB DBCluster DocdbCluster"
assert_failed_event_class_only_3G NeptuneCluster "Failed to delete Neptune DBCluster NeptuneCluster"
rm -f "${EVENTS_3G}" "${EVENT_KEYS_3G}"
EVENTS_3G=""
EVENT_KEYS_3G=""
echo "[verify] step 3g ok: the DocdbCluster and NeptuneCluster RESOURCE_FAILED events name the AWS failure by its class, with no account id"

# The assertion under test. ModifyDBCluster(DeletionProtection) applies
# immediately, but read it back under a short bounded poll rather than once.
DOCDB_POST="" NEPTUNE_POST=""
for i in $(seq 1 12); do
  DOCDB_POST=$(cluster_protection docdb "${DOCDB_CLUSTER_ID}")
  NEPTUNE_POST=$(cluster_protection neptune "${NEPTUNE_CLUSTER_ID}")
  if [ "${DOCDB_POST}" = "true" ] && [ "${NEPTUNE_POST}" = "true" ]; then
    break
  fi
  if [ "${i}" -lt 12 ]; then
    sleep 5
  fi
done
if [ "${DOCDB_POST}" != "true" ] || [ "${NEPTUNE_POST}" != "true" ]; then
  echo "[verify] FAIL: step 3g: a failed destroy left DeletionProtection stripped (docdb='${DOCDB_POST}', neptune='${NEPTUNE_POST}', expected true/true) -- the --remove-protection flip was not compensated (issue #2204)" >&2
  exit 1
fi
# The narration names each cluster. Its sentinel is the readback above: a
# restored guard with no line means the wording drifted, not the behavior.
for cluster in "DocDB DBCluster" "Neptune DBCluster"; do
  if ! grep -qF -- "${cluster}" <<<"${DESTROY_3G_PLAIN}"; then
    echo "[verify] FAIL: step 3g: no line names ${cluster} in the destroy output" >&2
    exit 1
  fi
done
for id in "${DOCDB_CLUSTER_ID}" "${NEPTUNE_CLUSTER_ID}"; do
  if ! grep -qF -- "--remove-protection had turned DeletionProtection off, so it was re-enabled on ${id}." <<<"${DESTROY_3G_PLAIN}"; then
    echo "[verify] FAIL: step 3g: DeletionProtection is back ON, but no restore line names ${id} -- the compensation wording drifted" >&2
    exit 1
  fi
done
echo "[verify] step 3g ok: both clusters' DeletionProtection restored after the terminal delete failure"

delete_oob_instance docdb "${OOB_DOCDB_INSTANCE_ID}"
OOB_DOCDB_INSTANCE_ID=""
delete_oob_instance neptune "${OOB_NEPTUNE_INSTANCE_ID}"
OOB_NEPTUNE_INSTANCE_ID=""
echo "[verify] step 3g cleanup ok: out-of-band instances deleted"

echo "[verify] step 4: cdkd destroy --force --remove-protection (step 3g left both guards ON)"
${CLI} destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --force \
  --remove-protection \
  "${TIMEOUT_OVERRIDES[@]}"

echo "[verify] step 5: cdkd state list (stack should be gone)"
if ${CLI} state list --state-bucket "${STATE_BUCKET}" | grep -q "${STACK}"; then
  echo "[verify] FAIL: state still present after successful destroy"
  exit 1
fi
echo "[verify] step 5 ok: state cleared"

# The step-3g failure set let both Neptune parameter groups fail while the
# surviving cluster held them; the final destroy must have removed them.
for pg in "${NEPTUNE_CLUSTER_PG}:describe-db-cluster-parameter-groups --db-cluster-parameter-group-name" "${NEPTUNE_INSTANCE_PG}:describe-db-parameter-groups --db-parameter-group-name"; do
  pg_name=${pg%%:*}
  pg_cmd=${pg#*:}
  # shellcheck disable=SC2086
  if pg_out=$(aws neptune ${pg_cmd} "${pg_name}" --output text 2>&1); then
    echo "[verify] FAIL: step 5: Neptune parameter group ${pg_name} still exists after the final destroy" >&2
    exit 1
  fi
  if ! grep -q 'NotFound' <<<"${pg_out}"; then
    echo "[verify] FAIL: step 5: could not confirm Neptune parameter group ${pg_name} is gone (probe failed with something other than NotFound)" >&2
    exit 1
  fi
done
echo "[verify] step 5 ok: both Neptune parameter groups are gone"

# Issue #5184: step 4 turned each guard off and then deleted the cluster with a
# final snapshot. The snapshot needs the cluster `available`, and right after
# the flip AWS can read protection OFF and `available` before the change shows
# as `modifying`; a delete sent then is refused and step 4 fails. This step
# proves the real-AWS path end to end. It cannot discriminate the fix, since a
# pre-fix run passes whenever the first read lands after `modifying` shows; the
# unit suites' mutation probes are the discrimination.
echo "[verify] step 5b: one cdkd final snapshot of each cluster (issue #5184)"
for pair in "docdb ${DOCDB_CLUSTER_ID}" "neptune ${NEPTUNE_CLUSTER_ID}"; do
  svc=${pair%% *}
  id=${pair#* }
  if ! snaps=$(this_run_cluster_snapshots "${svc}" "${id}"); then
    echo "[verify] FAIL: step 5b: could not list the manual snapshots of ${id}" >&2
    exit 1
  fi
  final_count=$(printf '%s\n' "${snaps}" | grep -cE -- '-final-[0-9]{8}-[0-9]{6}$' || true)
  other=$(printf '%s\n' "${snaps}" | grep -vE -- '-final-[0-9]{8}-[0-9]{6}$' | grep -v '^$' || true)
  if [ "${final_count}" != "1" ] || [ -n "${other}" ]; then
    echo "[verify] FAIL: step 5b: destroying ${svc} cluster ${id} (DeletionPolicy Snapshot) took ${final_count} cdkd final snapshot(s), expected 1; this run's snapshots: $(printf '%s ' ${snaps})" >&2
    exit 1
  fi
  echo "[verify] step 5b ok: ${svc} cluster destroy took the final snapshot ${snaps}"
done
delete_this_run_snapshots
echo "[verify] step 5b cleanup ok: final snapshots deleted"

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
