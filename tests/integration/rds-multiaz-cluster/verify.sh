#!/usr/bin/env bash
# verify.sh — cdkd Multi-AZ DB cluster integ test (go-to-k/cdkd#5639).
#
# A Multi-AZ DB cluster (engine `postgres`) declares DBClusterInstanceClass,
# AllocatedStorage and Iops, which were SDK-unwired before #5639, so the
# cluster always went through Cloud Control.
#
# Phase 1 deploys `db.c6gd.medium` on io1 100 GiB at 1000 IOPS and asserts the
# cluster record is provisionedBy=sdk (what a pre-fix cdkd fails), the three
# values are live, and `cdkd drift` finds the cluster unchanged (the readback
# reports all three).
#
# Phase 2 (CDKD_TEST_UPDATE=true) changes the class to `db.c6gd.large` and the
# storage to 120 GiB at 1200 IOPS. The deploy must return with all three
# applied (none pending), as CloudFormation's update stabilizes, and the
# cluster's DbClusterResourceId unchanged (in place, not a replacement).
#
# Phase 3 (CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true) DROPS the three
# properties beside a changed BackupRetentionPeriod (1 -> 2, the companion that
# proves the ModifyDBCluster fired). CloudFormation's handler sends nothing for
# a removed one, so all three must stay at their phase-2 values.
#
# Then destroy, and assert the cluster and the state file are gone.
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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdRdsMultiAzClusterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# The fixed identifier lib/rds-multiaz-cluster-stack.ts declares.
CLUSTER_ID="cdkd-integ-multiaz-5639"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The cluster's status, empty when it does not exist. A probe failing for any
# other reason (throttle, auth) prints the error and answers `unknown`, so the
# caller still tries the delete and reports a survivor.
cluster_status_or_absent() {
  local out
  if out=$(aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" \
    --region "${REGION}" --query 'DBClusters[0].Status' --output text 2>&1); then
    printf '%s\n' "${out}"
  elif grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
    printf '\n'
  else
    echo "    WARN: could not read cluster ${CLUSTER_ID}: ${out}" >&2
    printf 'unknown\n'
  fi
}

# A run interrupted before the state record names them leaves the subnet group
# (fixed name) and the VPC, its subnets, route tables and security group (the
# stack tag) for `state destroy` to miss. Best effort, after the cluster is gone.
sweep_network() { (
  set +eu
  aws rds delete-db-subnet-group --db-subnet-group-name "${CLUSTER_ID}" \
    --region "${REGION}" >/dev/null 2>&1 && echo "    cleanup: deleted subnet group ${CLUSTER_ID}"
  vpcs=$(aws ec2 describe-vpcs --region "${REGION}" \
    --filters 'Name=tag:cdkd-integ-fixture,Values=rds-multiaz-cluster' \
    --query 'Vpcs[].VpcId' --output text 2>&1)
  for vpc in ${vpcs}; do
    case "${vpc}" in
      vpc-?*) ;;
      *)
        echo "    WARN: teardown sweep refused for '${vpc}' (not a VPC id); check the account by hand" >&2
        continue
        ;;
    esac
    for sg in $(aws ec2 describe-security-groups --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" \
      --query "SecurityGroups[?GroupName!='default'].GroupId" --output text); do
      aws ec2 delete-security-group --group-id "${sg}" --region "${REGION}" >/dev/null
    done
    for subnet in $(aws ec2 describe-subnets --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" --query 'Subnets[].SubnetId' --output text); do
      aws ec2 delete-subnet --subnet-id "${subnet}" --region "${REGION}" >/dev/null
    done
    for rt in $(aws ec2 describe-route-tables --region "${REGION}" \
      --filters "Name=vpc-id,Values=${vpc}" \
      --query 'RouteTables[?!(Associations[?Main])].RouteTableId' --output text); do
      aws ec2 delete-route-table --route-table-id "${rt}" --region "${REGION}" >/dev/null
    done
    if aws ec2 delete-vpc --vpc-id "${vpc}" --region "${REGION}" >/dev/null; then
      echo "    cleanup: deleted leftover VPC ${vpc}"
    else
      echo "LEAK: VPC ${vpc} (tag cdkd-integ-fixture=rds-multiaz-cluster) could not be deleted; delete it by hand" >&2
    fi
  done
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + the Multi-AZ DB cluster"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --yes
  fi
  # Best-effort after an aborted run: the cluster by its fixed identifier
  # (RDS deletes a Multi-AZ DB cluster's instances and its managed master
  # secret with it), then a second `state destroy` for the subnet group and
  # VPC the first could not delete while the cluster still held them.
  # RDS refuses the delete while the cluster is `creating` or `modifying` (an
  # interrupt mid-phase), so wait for `available` and retry once; a cluster
  # still there after that is reported, never left silently.
  LEFTOVER_STATUS=$(cluster_status_or_absent)
  if [ -n "${LEFTOVER_STATUS}" ]; then
    if ! aws rds delete-db-cluster --db-cluster-identifier "${CLUSTER_ID}" \
      --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1; then
      aws rds wait db-cluster-available --db-cluster-identifier "${CLUSTER_ID}" \
        --region "${REGION}" >/dev/null 2>&1
      aws rds delete-db-cluster --db-cluster-identifier "${CLUSTER_ID}" \
        --skip-final-snapshot --region "${REGION}" >/dev/null 2>&1
    fi
    echo "    cleanup: deleting leftover cluster ${CLUSTER_ID} (was ${LEFTOVER_STATUS})"
    aws rds wait db-cluster-deleted --db-cluster-identifier "${CLUSTER_ID}" \
      --region "${REGION}" >/dev/null 2>&1
    STILL_STATUS=$(cluster_status_or_absent)
    if [ -n "${STILL_STATUS}" ]; then
      echo "LEAK: cluster ${CLUSTER_ID} is still there (${STILL_STATUS}); delete it with aws rds delete-db-cluster --db-cluster-identifier ${CLUSTER_ID} --skip-final-snapshot" >&2
    fi
    if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" \
        --region "${REGION}" \
        --skip-final-snapshot \
        --yes
    fi
  fi
  sweep_network
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

# The live cluster as JSON.
describe_cluster() {
  aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" \
    --region "${REGION}" --query 'DBClusters[0]' --output json
}

# Fail unless the live class, size and IOPS are $1 / $2 / $3 with no storage
# change pending. $4 names the phase.
assert_live() {
  local cluster class size iops pending
  cluster=$(describe_cluster)
  class=$(jq -r '.DBClusterInstanceClass // "null"' <<<"${cluster}")
  size=$(jq -r '.AllocatedStorage // "null"' <<<"${cluster}")
  iops=$(jq -r '.Iops // "null"' <<<"${cluster}")
  pending=$(jq -c '[.PendingModifiedValues // {} | .AllocatedStorage, .Iops, .StorageType | select(. != null)]' <<<"${cluster}")
  if [ "${class}" != "$1" ] || [ "${size}" != "$2" ] || [ "${iops}" != "$3" ] || [ "${pending}" != "[]" ]; then
    echo "FAIL: $4: live DBClusterInstanceClass=${class} AllocatedStorage=${size} Iops=${iops} pending=${pending}, expected $1 / $2 / $3 with nothing pending (go-to-k/cdkd#5639)" >&2
    exit 1
  fi
  echo "    OK: $4: live ${class}, ${size} GiB at ${iops} IOPS, nothing pending"
}

# The cluster record's provisionedBy (absent reads as sdk).
cluster_provisioned_by() {
  local state
  state=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -) || return 1
  jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | .value.provisionedBy // "sdk"] | first // ""' <<<"${state}"
}

assert_sdk_route() {
  local by
  by=$(cluster_provisioned_by)
  if [ "${by}" != "sdk" ]; then
    echo "FAIL: $1: the MultiAzCluster record is provisionedBy='${by}', expected sdk: a declared DBClusterInstanceClass / AllocatedStorage / Iops routed it to Cloud Control (go-to-k/cdkd#5639)" >&2
    exit 1
  fi
  echo "    OK: $1: MultiAzCluster is provisionedBy=sdk"
}

# Fail unless `cdkd drift` reports the cluster unchanged. $1 names the phase.
# The readback reports DBClusterInstanceClass / AllocatedStorage / Iops, so a
# record that does not declare them (phase 3) must not read them as drift.
assert_drift_clean() {
  local drift_out drift_rc
  drift_out=$(mktemp)
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" > "${drift_out}" 2>&1
  drift_rc=$?
  set -e
  # Only the cluster's own rows. `~` drifted, `?` unsupported, `!` not
  # compared, `-` deleted: each means the readback did not prove it unchanged.
  if grep -qE '^[[:space:]]*[~?!-] MultiAzCluster \(AWS::RDS::DBCluster\)' "${drift_out}"; then
    echo "FAIL: $1: cdkd drift reports the unchanged MultiAzCluster as drifted, unsupported, not compared or deleted (go-to-k/cdkd#5639; drift rc=${drift_rc}):" >&2
    cat "${drift_out}" >&2
    rm -f "${drift_out}"
    exit 1
  fi
  # Sentinel: the per-stack verdict heading. A crashed run, or one that never
  # reported this stack, prints none, and the row check cannot tell that from
  # "clean"; the rc cannot either (a crash exits 1, as detected drift does).
  if ! grep -qE "^[[:space:]]*(✓|⚠) ${STACK} \(${REGION}\): " "${drift_out}"; then
    echo "FAIL: $1: cdkd drift did not report on ${STACK} (rc=${drift_rc}), so it compared nothing (go-to-k/cdkd#5639):" >&2
    cat "${drift_out}" >&2
    rm -f "${drift_out}"
    exit 1
  fi
  rm -f "${drift_out}"
  echo "    OK: $1: cdkd drift does not report MultiAzCluster as drifted"
}

# Fail unless the cluster still has the phase-1 DbClusterResourceId.
assert_in_place() {
  local id
  id=$(describe_cluster | jq -r '.DbClusterResourceId // ""')
  if [ "${id}" != "${RESOURCE_ID}" ]; then
    echo "FAIL: $1: DbClusterResourceId changed (${RESOURCE_ID} -> ${id}): the cluster was replaced, not updated in place" >&2
    exit 1
  fi
  echo "    OK: $1: updated in place (DbClusterResourceId ${RESOURCE_ID})"
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy db.c6gd.medium, io1 100 GiB at 1000 IOPS"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_REMOVAL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route "phase 1"
assert_live "db.c6gd.medium" "100" "1000" "phase 1"
PHASE1_CLUSTER=$(describe_cluster)
RESOURCE_ID=$(jq -r '.DbClusterResourceId // ""' <<<"${PHASE1_CLUSTER}")
# The RDS-managed master secret and the subnet group, asserted gone after
# destroy. The secret's value is never read.
SECRET_ARN=$(jq -r '.MasterUserSecret.SecretArn // ""' <<<"${PHASE1_CLUSTER}")
SUBNET_GROUP=$(jq -r '.DBSubnetGroup // ""' <<<"${PHASE1_CLUSTER}")
SG_ID=$(jq -r '.VpcSecurityGroups[0].VpcSecurityGroupId // ""' <<<"${PHASE1_CLUSTER}")
VPC_ID=$(aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}" \
  --query 'SecurityGroups[0].VpcId' --output text)
if [ -z "${RESOURCE_ID}" ] || [ -z "${SECRET_ARN}" ] || [ -z "${SUBNET_GROUP}" ] || [ -z "${SG_ID}" ] || [ -z "${VPC_ID}" ]; then
  echo "FAIL: phase 1: DescribeDBClusters did not report the DbClusterResourceId, the managed master secret, the subnet group or the security group and its VPC" >&2
  exit 1
fi

assert_drift_clean "phase 1"
# The drift above compares through the observed baseline, which holds the
# three only if the readback reports them; a clean drift alone would also
# pass a readback that dropped them.
OBSERVED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - |
  jq -c '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | .value.observedProperties // {} | {DBClusterInstanceClass, AllocatedStorage, Iops}] | first // {}')
if [ "${OBSERVED}" != '{"DBClusterInstanceClass":"db.c6gd.medium","AllocatedStorage":100,"Iops":1000}' ]; then
  echo "FAIL: phase 1: the MultiAzCluster observed baseline holds ${OBSERVED}, expected db.c6gd.medium / 100 / 1000: readCurrentState does not report them (go-to-k/cdkd#5639)" >&2
  exit 1
fi
echo "    OK: phase 1: the observed baseline holds the class, size and IOPS"

# --- Phase 2: change class and storage --------------------------------
echo "==> Phase 2: update to db.c6gd.large, 120 GiB at 1200 IOPS"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_sdk_route "phase 2"
# Read right after the deploy returns: the update waits for the change to
# apply, as CloudFormation's does.
assert_live "db.c6gd.large" "120" "1200" "phase 2"
assert_in_place "phase 2"

# --- Phase 3: remove the three properties -----------------------------
echo "==> Phase 3: drop DBClusterInstanceClass / AllocatedStorage / Iops, BackupRetentionPeriod 1 -> 2"
CDKD_TEST_UPDATE=true CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RETENTION=$(describe_cluster | jq -r '.BackupRetentionPeriod // "null"')
if [ "${RETENTION}" != "2" ]; then
  echo "FAIL: phase 3: live BackupRetentionPeriod=${RETENTION}, expected 2: the companion change did not reach AWS, so the removal below proves nothing" >&2
  exit 1
fi
echo "    OK: phase 3: the companion BackupRetentionPeriod change is live"
assert_live "db.c6gd.large" "120" "1200" "phase 3 (removed values kept)"
assert_in_place "phase 3"
assert_drift_clean "phase 3"

# --- Destroy ----------------------------------------------------------
echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

if gone_probe aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}"; then
  CLUSTER_STATUS="gone"
elif ! CLUSTER_STATUS=$(aws rds describe-db-clusters \
    --db-cluster-identifier "${CLUSTER_ID}" \
    --region "${REGION}" \
    --query 'DBClusters[0].Status' --output text 2>&1); then
  # TOCTOU: the cluster can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${CLUSTER_STATUS}" \
    && CLUSTER_STATUS="gone" \
    || { echo "FAIL: describe-db-clusters requery undetermined: ${CLUSTER_STATUS}" >&2; exit 1; }
fi
if [ "${CLUSTER_STATUS}" = "gone" ] || [ "${CLUSTER_STATUS}" = "deleting" ]; then
  echo "    OK: the cluster is gone or deleting (status: ${CLUSTER_STATUS})"
else
  echo "FAIL: the cluster is in an unexpected state after destroy: ${CLUSTER_STATUS}" >&2
  exit 1
fi
if [ "${CLUSTER_STATUS}" = "deleting" ]; then
  aws rds wait db-cluster-deleted --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}"
fi

assert_gone "DB subnet group ${SUBNET_GROUP} still exists after destroy" aws rds describe-db-subnet-groups --db-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
echo "    OK: the DB subnet group is gone"
assert_gone "security group ${SG_ID} still exists after destroy" aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
echo "    OK: the security group and the VPC are gone"

# RDS deletes its managed master secret with the cluster: gone, or scheduled
# for deletion.
if ! gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}"; then
  if ! SECRET_DELETED=$(aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" \
      --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
    # TOCTOU: the secret can vanish between gone_probe and this requery.
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${SECRET_DELETED}" \
      && SECRET_DELETED="gone" \
      || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED}" >&2; exit 1; }
  fi
  if [ -z "${SECRET_DELETED}" ] || [ "${SECRET_DELETED}" = "None" ]; then
    echo "FAIL: the cluster's managed master secret is still live after destroy (go-to-k/cdkd#5639)" >&2
    exit 1
  fi
fi
echo "    OK: the managed master secret is gone or scheduled for deletion"

trap - EXIT INT TERM
echo "[verify] PASS — Multi-AZ DB cluster class / storage / IOPS on the SDK route (go-to-k/cdkd#5639)"
