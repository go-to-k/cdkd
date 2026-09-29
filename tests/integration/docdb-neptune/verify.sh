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
#      The #1160 reset is proven by step 3d's readback; step 3g left the
#      guard ON, so this is also the flip's live SUCCESS path.
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
# Step 3g's out-of-band cluster members (issue #2204). Not in cdkd state, so
# cdkd's destroy cannot remove them: cleanup deletes them FIRST, or the retry
# destroy below cannot delete their clusters. Set just before each create.
OOB_DOCDB_INSTANCE_ID=""
OOB_NEPTUNE_INSTANCE_ID=""
# Step 3g's captured destroy output; removed by cleanup too, since a signal
# landing mid-destroy never reaches the step's own `rm`.
DESTROY_3G_LOG=""

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

# On any failure exit, re-attempt destroy so we never leak DocDB /
# Neptune clusters. Best-effort DeletionProtection flip-offs first: an
# aborted run can die with the baseline (step-2) protection still live,
# which would refuse the delete otherwise (#1160 fixture shape).
cleanup() {
  rc=$?
  [ -n "${DESTROY_3G_LOG}" ] && rm -f "${DESTROY_3G_LOG}"
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
# was never undone, so both clusters read DeletionProtection=false here.
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
# ON afterwards would pass the readback below while testing nothing.
if ! grep -qE 'still contains DB instances|non-deleting state' <<<"${DESTROY_3G_PLAIN}"; then
  echo "[verify] FAIL: step 3g destroy failed, but not with DeleteDBCluster's member refusal -- the arm did not reach the compensation" >&2
  exit 1
fi
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
UNEXPECTED_3G="$(printf '%s\n' "${FAILED_3G}" | grep -vE '^(DocdbCluster|NeptuneCluster|DocdbSubnetGroup|NeptuneSubnetGroup|Sg[0-9A-F]{8}|Vpc[A-Za-z0-9]*)$' || true)"
if [ -n "${UNEXPECTED_3G}" ]; then
  echo "[verify] FAIL: step 3g: deletes failed outside the engineered set: $(printf '%s ' ${UNEXPECTED_3G})" >&2
  exit 1
fi

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
