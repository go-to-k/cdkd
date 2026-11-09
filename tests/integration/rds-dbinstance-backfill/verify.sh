#!/usr/bin/env bash
# verify.sh — cdkd RDS::DBInstance backfill integ test (issue #609).
#
# Asserts that a standalone (non-cluster) RDS Postgres DBInstance whose
# template sets the #609 sibling-of-DBCluster properties has each one reach
# AWS after `cdkd deploy` — each was SDK-unwired before #609.
#
# Original (#738) properties (AWS-readable):
#   DeletionProtection / EngineVersion / Port / StorageEncrypted /
#   VPCSecurityGroups / MasterUsername — asserted via DescribeDBInstances.
#
# Folded-in security properties (this fixture absorbed the former standalone
# `rds-security-backfill` fixture per the "do not proliferate per-property
# integ fixtures" directive):
#   KmsKeyId / MasterUserSecret / ManageMasterUserPassword /
#   MonitoringRoleArn / MonitoringInterval / EnableIAMDatabaseAuthentication
#   — also asserted via DescribeDBInstances.
#
# The credentials shape changed when folding in the security props: the
# managed-master-password (ManageMasterUserPassword) is mutually exclusive
# with a literal MasterUserPassword, so this fixture sets NO password and
# proves the managed credential rode via the populated MasterUserSecret
# read-back (a credibility proxy that the explicit-managed-credential create
# payload was accepted).
#
# The DBInstance is also asserted to carry `provisionedBy=sdk` in cdkd state
# — a routing guard proving none of the set props flipped the resource to
# the Cloud Control path (which would make the SDK-provider verification
# meaningless). Also asserts the destroy path cleans up.
#
# #5004 (removal KEEPS the live value, as CloudFormation does):
# DeletionProtection + EnableIAMDatabaseAuthentication + MonitoringInterval are
# SET in phase 1 and DROPPED in the phase-2 UPDATE pass (CDKD_TEST_UPDATE=true).
# A real CloudFormation A/B (#5004) showed CFn KEEPS all three on removal, and
# ModifyDBInstance treats an absent field as "no change", so cdkd sends no
# reset. Phase 2 asserts all three are STILL live via DescribeDBInstances;
# protection is retained, so the phase-3 destroy passes --remove-protection.
#
# #5542 (removal RESETS, as CloudFormation does): phase 2 also DROPS
# VPCSecurityGroups. A real CloudFormation A/B (#5542) showed CFn sends the
# VPC's `default` security group on that removal, so phase 2 asserts the
# instance ends up on exactly that group, no longer on the custom one.
#
# go-to-k/cdkd#2762: phase 1 asserts the storage / backup / maintenance /
# certificate / Performance Insights props reached AWS. Phase 2 asserts the
# changed BackupRetentionPeriod, PreferredMaintenanceWindow and
# PerformanceInsightsRetentionPeriod reached AWS, a removed
# AutoMinorVersionUpgrade was KEPT, and a removed MaxAllocatedStorage turned
# storage autoscaling off (both per CloudFormation's handler source).
#
# go-to-k/cdkd#2762 (DBInstance NetworkType / LicenseModel /
# DatabaseInsightsMode / AllowMajorVersionUpgrade): phase 1 declares all four;
# the provisionedBy=sdk guard is what a pre-fix cdkd fails. Phase 1d upgrades
# the minor engine version out of band (as AutoMinorVersionUpgrade would) while
# the template keeps the old one; the phase-2 deploy must succeed and leave the
# upgraded version live. A cdkd re-sending the unchanged EngineVersion fails
# that deploy: RDS refuses it as a downgrade.
#
# go-to-k/cdkd#5640 (EngineLifecycleSupport / MasterUserAuthenticationType):
# declared in every phase; before #5640 either one routed the instance to Cloud
# Control (the provisionedBy=sdk guard catches it). EngineLifecycleSupport is
# asserted live.
#
# go-to-k/cdkd#2762 (DBInstance DBParameterGroupName): the instance declares a
# custom parameter group (A); the provisionedBy=sdk guard is what a pre-fix cdkd
# fails, and phase 1 asserts A is live and in-sync. Phase 2b changes ONLY the
# group, to B (CDKD_TEST_PARAM_GROUP=b), which RDS holds `pending-reboot` until
# the instance reboots; CloudFormation reboots after that update, so the deploy
# must return with B live and `in-sync`. Both groups must be gone after destroy.
#
# go-to-k/cdkd#5640 (DBInstance EnableCloudwatchLogsExports): phase 1 exports
# `postgresql`; the provisionedBy=sdk guard is what a pre-fix cdkd fails, and
# phase 1 asserts the live EnabledCloudwatchLogsExports. Phase 2 adds `upgrade`
# and asserts both are live. Phase 2c (CDKD_TEST_LOGS_REMOVED=true) drops the
# property, which disables both, as CloudFormation's handler does (it disables
# what the previous template declared), with parameter group B kept beside it.
# Cleanup deletes the CloudWatch log groups RDS created for the exports.
#
# go-to-k/cdkd#5640 (DBInstance AssociatedRoles): phase 1 attaches an import
# role for `s3Import` (asserted live; before #5640 the provisionedBy=sdk guard
# fails), phase 2 swaps it for an export role for `s3Export`, and phase 2c
# drops the property, which detaches it (each asserted live). Both roles are
# stack resources in every phase.
#
# go-to-k/cdkd#5640 (DBInstance SourceDBInstanceIdentifier): phase 2d adds two
# same-region read replicas of a dedicated source instance (by ARN, as CDK
# names the source);
# the provisionedBy=sdk guard is what a pre-fix cdkd fails, and each replica's
# declared maintenance window proves CloudFormation's after-create
# ModifyDBInstance ran. Phase 2e drops one replica's source, which promotes it
# in place (same DbiResourceId), holding the backup settings it declares. The
# destroy deletes the remaining replica without a final snapshot and the
# promoted one with one.
#
# go-to-k/cdkd#5640 (DBInstance SourceRegion): before phase 2d, a second stack
# (RdsDbInstanceBackfillXrSource-<REGION>) deploys a source instance in another
# region (XR_REGION); phase 2d adds ReadReplicaCrossRegion, a replica of it
# declaring SourceRegion. The provisionedBy=sdk guard is what a pre-fix cdkd
# fails (SourceRegion routed it to Cloud Control); the live source ARN proves a
# cross-region replica. The destroy deletes it without a final snapshot, then
# the source stack's destroy deletes the source.
#
# go-to-k/cdkd#6047 (a Cloud Control-routed replica under DeletionPolicy:
# Snapshot): phase 2f moves ReadReplicaKept onto Cloud Control with
# --recreate-via-cc-api, where every replica deployed before #5640 sits. Its
# policy is CloudFormation's absent default, Snapshot, which a cdkd before
# #6047 refused on that route: the phase-3 destroy failed. It must now succeed,
# with no snapshot of the replica, as CloudFormation's handler takes none.
#
# go-to-k/cdkd#5640 (DBInstance DBName / AvailabilityZone): declared unchanged
# in every phase; the provisionedBy=sdk guard is what a pre-fix cdkd fails, and
# phase 1 asserts the live DBName and zone (the zone the record declares), that
# the observed baseline holds both, and that `cdkd drift` finds the instance
# unchanged.
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

STACK="RdsDbInstanceBackfillStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# go-to-k/cdkd#5640: shared S3 VERSION-sweep helpers (issue #2096). Phase 2d's
# ReplicaSourceInstance declares a literal master password, which reaches the
# state records, and the state bucket is versioned.
REPO_ROOT="$(cd "$(dirname "$0")/../../.." && pwd)"
. "${REPO_ROOT}/tests/integration/s3-versions.sh"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
# go-to-k/cdkd#5640 (SourceRegion): the cross-region replica's source stack, in
# a region other than REGION. Exported: bin/app.ts defines that stack, and the
# main stack's ReadReplicaCrossRegion, only when they are set. Its source
# carries a literal master password too, so its prefix is swept like
# STATE_PREFIX. The stack name and both instance identifiers carry REGION, so
# runs in two regions sharing one XR_REGION never touch each other's; the
# replica's fixed name is what lets cleanup delete it, before the source, when
# no state record holds it (a run stopped mid phase 2d).
if [ "${REGION}" = "us-west-2" ]; then XR_REGION="us-east-2"; else XR_REGION="us-west-2"; fi
XR_STACK="RdsDbInstanceBackfillXrSource-${REGION}"
XR_SOURCE_ID="cdkd-backfill-xr-source-${REGION}"
XR_REPLICA_ID="cdkd-backfill-xr-replica-${REGION}"
export CDKD_TEST_XR_SOURCE_REGION="${XR_REGION}"
export CDKD_TEST_XR_STACK="${XR_STACK}"
export CDKD_TEST_XR_SOURCE_ID="${XR_SOURCE_ID}"
export CDKD_TEST_XR_REPLICA_ID="${XR_REPLICA_ID}"
XR_STATE_KEY="cdkd/${XR_STACK}/${XR_REGION}/state.json"
XR_STATE_PREFIX="$(s3_stack_prefix "${XR_STACK}" "${XR_REGION}")"

EXPECTED_ENGINE_VERSION="17.6"
EXPECTED_PORT=5433
EXPECTED_UPDATED_PORT=5434 # phase 2 companion change (#5004)
EXPECTED_DELETION_PROTECTION="true"
EXPECTED_STORAGE_ENCRYPTED="true"
EXPECTED_MASTER_USERNAME="postgres"
EXPECTED_MONITORING_INTERVAL=60
EXPECTED_IAM_AUTH="true"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The fixture's DBInstance has no explicit instanceIdentifier, so CDK
# auto-generates the physical name; resolve it from cdkd state after deploy.
DB_INSTANCE_ID=""
# go-to-k/cdkd#5640: the two read replicas (phase 2d on), resolved from state.
REPLICA_KEPT_ID=""
# go-to-k/cdkd#6047: ReadReplicaKept's SDK-route copy, which phase 2f's
# recreate deletes before creating the Cloud Control one.
REPLICA_KEPT_SDK_ID=""
REPLICA_PROMOTED_ID=""
REPLICA_SOURCE_ID=""
# go-to-k/cdkd#5640 (SourceRegion): the cross-region replica, resolved from state.
REPLICA_XR_ID=""
# go-to-k/cdkd#2762: the two custom parameter groups, resolved from state.
PG_A_ID=""
PG_B_ID=""
# Issue #4030: when this run began (UTC, second precision, the prefix AWS's
# SnapshotCreateTime is compared on).
RUN_START=""

# Print the manual snapshots of instance $1 created at or after RUN_START, one
# id per line. Fails (rc != 0) when the listing or a timestamp is unreadable,
# so a caller cannot read an error as "none".
this_run_instance_snapshots() { # usage: this_run_instance_snapshots <instance id>
  local out
  out=$(aws rds describe-db-snapshots --db-instance-identifier "$1" \
    --snapshot-type manual --region "${REGION}" --output json) || return 1
  echo "${out}" | jq -r --arg start "${RUN_START}" '
    .DBSnapshots
    | if all(.[]; (.SnapshotCreateTime // "") | test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9:.]+(\\+00:00|Z)$"))
      then .[] | select(.SnapshotCreateTime[0:19] >= $start) | .DBSnapshotIdentifier
      else error("unreadable SnapshotCreateTime") end'
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS DBInstance"
  # Do NOT silence stderr on `state destroy` — a partial-failure (e.g.
  # VPC dependency still in 'deleting' from a prior in-flight DBInstance)
  # silently leaves orphan resources behind otherwise. See PR #735
  # retrospective. The two stdout-piped calls below ARE allowed to be
  # silent: the redundant `delete-db-instance` is best-effort (state
  # destroy already handled it on the happy path), and the `s3 rm`
  # calls are expected to NotFound after state destroy succeeds.
  set +eu
  # go-to-k/cdkd#2762: a run aborted before phase 1 resolved the parameter
  # groups still names them in the state record `state destroy` reads; take
  # them from it first, so the best-effort delete below can reach them.
  if [ -z "${PG_A_ID}${PG_B_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    CLEANUP_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
    if [ -n "${CLEANUP_STATE}" ]; then
      PG_A_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup" and (.key | test("^ParamGroupA"))) | .value.physicalId // empty] | first // ""')
      PG_B_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup" and (.key | test("^ParamGroupB"))) | .value.physicalId // empty] | first // ""')
    fi
  fi
  # go-to-k/cdkd#5640: the instance whose exported-log groups cleanup deletes
  # below; on the pre-run pass, the one a leftover state record names.
  LOG_INSTANCE_ID="${DB_INSTANCE_ID}"
  if [ -z "${LOG_INSTANCE_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    LOG_INSTANCE_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
      jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^BackfillInstance"))) | .value.physicalId // empty] | first // ""')
  fi
  # go-to-k/cdkd#5640: a run aborted after the phase-2d deploy started names
  # its read replicas only in the state record.
  if [ -z "${REPLICA_KEPT_ID}${REPLICA_PROMOTED_ID}${REPLICA_SOURCE_ID}${REPLICA_XR_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    CLEANUP_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
    if [ -n "${CLEANUP_STATE}" ]; then
      REPLICA_XR_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^ReadReplicaCrossRegion"))) | .value.physicalId // empty] | first // ""')
      REPLICA_KEPT_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^ReadReplicaKept"))) | .value.physicalId // empty] | first // ""')
      REPLICA_PROMOTED_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^ReadReplicaPromoted"))) | .value.physicalId // empty] | first // ""')
      REPLICA_SOURCE_ID=$(echo "${CLEANUP_STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^ReplicaSourceInstance"))) | .value.physicalId // empty] | first // ""')
    fi
  fi
  # go-to-k/cdkd#6047: phase 2f's deploy can fail after recording the Cloud
  # Control copy of ReadReplicaKept while REPLICA_KEPT_ID still names the SDK
  # copy, so read the recorded one on every pass; left out, it would outlive
  # the source's delete as a promoted standalone instance. Empty when unread.
  REPLICA_KEPT_STATE_ID=""
  if [ -n "${STATE_BUCKET:-}" ]; then
    REPLICA_KEPT_STATE_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null |
      jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^ReadReplicaKept"))) | .value.physicalId // empty] | first // ""')
    case "${REPLICA_KEPT_STATE_ID}" in
      "${REPLICA_KEPT_ID}" | "${REPLICA_KEPT_SDK_ID}") REPLICA_KEPT_STATE_ID="" ;;
    esac
  fi
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Pass --state-bucket explicitly so the cdk.json default placeholder
    # ('your-cdkd-state-bucket') does not poison state destroy with a
    # bogus bucket name — every other integ fixture's cdk.json carries
    # the same placeholder, so the env-var passthrough is load-bearing
    # for any cleanup that needs to find the test's actual state.
    # --remove-protection: an aborted run can leave the phase-1
    # DeletionProtection=true live on the DBInstance (#1160 fixture
    # shape); idempotent when protection is already off.
    # --skip-final-snapshot: the policy-less L1 resource defaults to Snapshot
    # (#4030), and a cleanup snapshot would outlive the run (RUN_START is empty
    # before the run) or be refused on a resource still `creating`.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --remove-protection \
      --skip-final-snapshot \
      --yes
  fi
  # go-to-k/cdkd#5640: the read replicas, best-effort after `state destroy`,
  # and BEFORE their source: deleting a source promotes its same-region
  # replicas to standalone instances, which would then outlive the run.
  for replica_id in ${REPLICA_KEPT_ID} ${REPLICA_KEPT_SDK_ID} ${REPLICA_KEPT_STATE_ID} ${REPLICA_PROMOTED_ID} ${REPLICA_XR_ID} ${XR_REPLICA_ID}; do
    aws rds delete-db-instance \
      --db-instance-identifier "${replica_id}" \
      --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1 || true
  done
  # ... and wait them out first: a replica still `deleting` is still a replica.
  for replica_id in ${REPLICA_KEPT_ID} ${REPLICA_KEPT_SDK_ID} ${REPLICA_KEPT_STATE_ID} ${REPLICA_PROMOTED_ID} ${REPLICA_XR_ID} ${XR_REPLICA_ID}; do
    aws rds wait db-instance-deleted --db-instance-identifier "${replica_id}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
  # go-to-k/cdkd#5640 (SourceRegion): the cross-region source stack, once its
  # replica is gone (deleting a source promotes its cross-region replicas
  # too; XR_REPLICA_ID above covers one no state record names yet), then the
  # source by its name, best-effort, and its state.
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${XR_STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${XR_REGION}" \
      --skip-final-snapshot \
      --yes
  fi
  aws rds delete-db-instance \
    --db-instance-identifier "${XR_SOURCE_ID}" \
    --region "${XR_REGION}" \
    --skip-final-snapshot >/dev/null 2>&1 || true
  # Its name is fixed: wait it out, or a pre-run pass leaves phase 2d's create
  # of the same name to collide with a still-deleting leftover.
  aws rds wait db-instance-deleted --db-instance-identifier "${XR_SOURCE_ID}" \
    --region "${XR_REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${XR_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${XR_STACK}/${XR_REGION}/lock.json" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${XR_STATE_PREFIX:-}" noncurrent
  fi
  # Then their dedicated source (RemovalPolicy.DESTROY: no final snapshot).
  if [ -n "${REPLICA_SOURCE_ID}" ]; then
    aws rds delete-db-instance \
      --db-instance-identifier "${REPLICA_SOURCE_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1 || true
  fi
  if [ -n "${DB_INSTANCE_ID}" ]; then
    # Best-effort flip-off before the redundant raw delete — a protected
    # instance (aborted between phases 1 and 2) refuses delete-db-instance.
    aws rds modify-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" \
      --no-deletion-protection \
      --apply-immediately >/dev/null 2>&1 || true
    aws rds delete-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1 || true
  fi
  # Issue #4030: the final snapshot this run's destroy takes of the
  # policy-less instance (CloudFormation's default is Snapshot), and of the
  # promoted replica, standalone by then (go-to-k/cdkd#5640). Older
  # snapshots are not this run's to delete.
  if [ -n "${RUN_START}" ]; then
    for snap_instance in ${DB_INSTANCE_ID} ${REPLICA_KEPT_ID} ${REPLICA_KEPT_SDK_ID} ${REPLICA_KEPT_STATE_ID} ${REPLICA_PROMOTED_ID} ${REPLICA_SOURCE_ID} ${REPLICA_XR_ID}; do
      if ! SNAPS_TO_CLEAN=$(this_run_instance_snapshots "${snap_instance}"); then
        echo "    WARN: cleanup could not list the manual snapshots of ${snap_instance}; check for a leftover by hand" >&2
        SNAPS_TO_CLEAN=""
      fi
      for snap in ${SNAPS_TO_CLEAN}; do
        aws rds wait db-snapshot-available --db-snapshot-identifier "${snap}" --region "${REGION}"
        aws rds delete-db-snapshot --db-snapshot-identifier "${snap}" --region "${REGION}" >/dev/null \
          && echo "    cleanup: deleted this run's manual snapshot ${snap}"
      done
    done
  fi
  # go-to-k/cdkd#2762: the custom parameter groups, which RDS refuses to
  # delete while an instance still uses them; `state destroy` deletes both on
  # the happy path, so this is best-effort after an aborted one.
  if [ -n "${PG_A_ID}${PG_B_ID}" ]; then
    # go-to-k/cdkd#5640: the replicas share neither group (their source,
    # ReplicaSourceInstance, uses the default one), but wait them out anyway.
    for held_by in ${DB_INSTANCE_ID} ${REPLICA_KEPT_ID} ${REPLICA_PROMOTED_ID}; do
      aws rds wait db-instance-deleted --db-instance-identifier "${held_by}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
    for pg in ${PG_A_ID} ${PG_B_ID}; do
      aws rds delete-db-parameter-group --db-parameter-group-name "${pg}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
  fi
  # go-to-k/cdkd#5640: RDS creates one log group per exported log type and
  # deletes none of them with the instance. Named exactly, never swept by
  # prefix; RDS names them by the lower-cased identifier.
  if [ -n "${LOG_INSTANCE_ID}" ]; then
    LOG_INSTANCE_LOWER=$(printf '%s' "${LOG_INSTANCE_ID}" | tr '[:upper:]' '[:lower:]')
    for log_type in postgresql upgrade; do
      LOG_GROUP="/aws/rds/instance/${LOG_INSTANCE_LOWER}/${log_type}"
      if LOG_DELETE_OUT=$(aws logs delete-log-group --log-group-name "${LOG_GROUP}" --region "${REGION}" 2>&1); then
        echo "    cleanup: deleted log group ${LOG_GROUP}"
      elif ! grep -q 'ResourceNotFoundException' <<<"${LOG_DELETE_OUT}"; then
        echo "    WARN: cleanup could not delete log group ${LOG_GROUP}; delete it by hand: ${LOG_DELETE_OUT}" >&2
      fi
    done
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # NONCURRENT only, per ../s3-versions.sh; the success path sweeps all.
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
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
# A leftover record's groups are not this run's: re-resolve after phase 1.
PG_A_ID=""
PG_B_ID=""

# --- Phase 1: deploy --------------------------------------------------
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "==> Phase 1: deploy with the local binary (run start ${RUN_START}Z)"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the auto-generated DBInstance identifier from cdkd state.
DB_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^BackfillInstance"))) | .value.physicalId] | first // ""')
if [ -z "${DB_INSTANCE_ID}" ] || [ "${DB_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBInstance identifier from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved DBInstance identifier: ${DB_INSTANCE_ID}"

# go-to-k/cdkd#2762: the two custom parameter groups, by logical id.
PG_A_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup" and (.key | test("^ParamGroupA"))) | .value.physicalId] | first // ""')
PG_B_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup" and (.key | test("^ParamGroupB"))) | .value.physicalId] | first // ""')
if [ -z "${PG_A_ID}" ] || [ "${PG_A_ID}" = "null" ] || [ -z "${PG_B_ID}" ] || [ "${PG_B_ID}" = "null" ]; then
  echo "FAIL: could not resolve the two DB parameter groups from state (A='${PG_A_ID}', B='${PG_B_ID}')" >&2
  exit 1
fi
echo "    resolved DB parameter groups: A=${PG_A_ID} B=${PG_B_ID}"

# Issue #4030 premise: the L1 instance declares NO DeletionPolicy, so the
# destroy must apply CloudFormation's default for a standalone instance,
# Snapshot. A recorded policy would make the snapshot assertion below test
# the explicit-policy path instead.
INST_DELETION_POLICY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^BackfillInstance"))) | .value.deletionPolicy // "absent"] | first // ""')
if [ "${INST_DELETION_POLICY}" != "absent" ]; then
  echo "FAIL: issue #4030 premise: the DBInstance records DeletionPolicy '${INST_DELETION_POLICY}', expected none" >&2
  exit 1
fi
echo "    OK: DBInstance records no DeletionPolicy (issue #4030 premise)"

# Resolve the expected VPC security group id from state so the assertion
# can compare against the real generated id (no hardcoded sg-XXX needed).
EXPECTED_SG=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::EC2::SecurityGroup") | .value.physicalId] | first // ""')
if [ -z "${EXPECTED_SG}" ] || [ "${EXPECTED_SG}" = "null" ]; then
  echo "FAIL: could not resolve SecurityGroup id from state" >&2
  exit 1
fi
echo "    expected VPC security group: ${EXPECTED_SG}"

# --- Routing guard: the DBInstance must be SDK-provisioned ------------
# If any set prop were still SDK-unwired, #614 routing would flip the
# resource to the Cloud Control path (provisionedBy=cc-api) and the
# SDK-provider assertions below would prove nothing.
# An absent provisionedBy is a legacy SDK record; an absent RECORD is not.
INST_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance" and (.key | test("^BackfillInstance"))) | .value.provisionedBy // "sdk"] | first // "<no DBInstance record>"')
if [ "${INST_PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: DBInstance routed via '${INST_PROVISIONED_BY}', expected 'sdk' (a set prop is still SDK-unwired → CC-API routing)" >&2
  exit 1
fi
echo "    OK: DBInstance provisionedBy=sdk (no SDK-unwired CC-API flip)"

# --- Assertion: AWS-readable props reached AWS ------------------------
# DescribeDBInstances returns every prop the create payload accepted;
# verifying each one proves the silent-drop is closed by the #609 backfill.
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeDBInstances returned empty for ${DB_INSTANCE_ID}" >&2
  exit 1
fi

# EngineVersion: the create-time payload's literal string, returned as-is.
ACTUAL_ENGINE_VERSION=$(echo "${INSTANCE}" | jq -r '.EngineVersion // "null"')
if [ "${ACTUAL_ENGINE_VERSION}" != "${EXPECTED_ENGINE_VERSION}" ]; then
  echo "FAIL: EngineVersion is '${ACTUAL_ENGINE_VERSION}', expected '${EXPECTED_ENGINE_VERSION}' (EngineVersion silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.EngineVersion'
  exit 1
fi
echo "    OK: EngineVersion == ${EXPECTED_ENGINE_VERSION} on AWS (EngineVersion silent-drop CLOSED by #609)"

# Port: Postgres default is 5432; the fixture sets 5433.
# DescribeDBInstances surfaces the active port at Endpoint.Port (NOT a
# top-level field) — matching the readback's source.
ACTUAL_PORT=$(echo "${INSTANCE}" | jq -r '.Endpoint.Port // "null"')
if [ "${ACTUAL_PORT}" != "${EXPECTED_PORT}" ]; then
  echo "FAIL: Endpoint.Port is '${ACTUAL_PORT}', expected '${EXPECTED_PORT}' (Port silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.Endpoint'
  exit 1
fi
echo "    OK: Endpoint.Port == ${EXPECTED_PORT} on AWS (Port silent-drop CLOSED by #609)"

# DeletionProtection: explicit true from the phase-1 template (#5004
# removable field — phase 2 drops it and asserts it is KEPT).
# NOTE: use `tostring` instead of `// "null"` because jq's `//` operator
# treats `false` as a missing value (it's the "alternative-on-null-or-false"
# operator), so an explicit `false` from AWS would falsely register as `null`.
ACTUAL_DELETION_PROTECTION=$(echo "${INSTANCE}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
if [ "${ACTUAL_DELETION_PROTECTION}" != "${EXPECTED_DELETION_PROTECTION}" ]; then
  echo "FAIL: DeletionProtection is '${ACTUAL_DELETION_PROTECTION}', expected '${EXPECTED_DELETION_PROTECTION}'" >&2
  exit 1
fi
echo "    OK: DeletionProtection == ${EXPECTED_DELETION_PROTECTION} on AWS"

# StorageEncrypted: RDS default is false for db.t3.micro Postgres;
# the fixture sets true. A silent-drop would leave AWS at false.
# Same `false`-vs-null trap as DeletionProtection above — use the
# explicit-presence check.
ACTUAL_STORAGE_ENCRYPTED=$(echo "${INSTANCE}" | jq -r 'if has("StorageEncrypted") then .StorageEncrypted | tostring else "null" end')
if [ "${ACTUAL_STORAGE_ENCRYPTED}" != "${EXPECTED_STORAGE_ENCRYPTED}" ]; then
  echo "FAIL: StorageEncrypted is '${ACTUAL_STORAGE_ENCRYPTED}', expected '${EXPECTED_STORAGE_ENCRYPTED}' (StorageEncrypted silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: StorageEncrypted == ${EXPECTED_STORAGE_ENCRYPTED} on AWS (StorageEncrypted silent-drop CLOSED by #609)"

# VPCSecurityGroups: AWS returns VpcSecurityGroups[].VpcSecurityGroupId.
# A silent-drop would have AWS assign the VPC's default SG (different id).
ACTUAL_SGS=$(echo "${INSTANCE}" | jq -r '[.VpcSecurityGroups[]?.VpcSecurityGroupId] | sort | join(",")')
if [ "${ACTUAL_SGS}" != "${EXPECTED_SG}" ]; then
  echo "FAIL: VpcSecurityGroups is '${ACTUAL_SGS}', expected '${EXPECTED_SG}' (VPCSecurityGroups silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.VpcSecurityGroups'
  exit 1
fi
echo "    OK: VpcSecurityGroups == [${EXPECTED_SG}] on AWS (VPCSecurityGroups silent-drop CLOSED by #609)"

# MasterUsername: AWS-required paired create-time prop, returned as-is.
ACTUAL_MASTER_USERNAME=$(echo "${INSTANCE}" | jq -r '.MasterUsername // "null"')
if [ "${ACTUAL_MASTER_USERNAME}" != "${EXPECTED_MASTER_USERNAME}" ]; then
  echo "FAIL: MasterUsername is '${ACTUAL_MASTER_USERNAME}', expected '${EXPECTED_MASTER_USERNAME}'" >&2
  exit 1
fi
echo "    OK: MasterUsername == ${EXPECTED_MASTER_USERNAME} on AWS"

# --- Assertions: folded-in #609 security props reached AWS ------------
# MonitoringInterval: Enhanced Monitoring interval in seconds (fixture sets
# 60; AWS default is 0). A silent-drop would leave AWS at 0.
ACTUAL_INTERVAL=$(echo "${INSTANCE}" | jq -r '.MonitoringInterval // "null"')
if [ "${ACTUAL_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: MonitoringInterval is '${ACTUAL_INTERVAL}', expected '${EXPECTED_MONITORING_INTERVAL}' (MonitoringInterval silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: MonitoringInterval == ${EXPECTED_MONITORING_INTERVAL} on AWS (silent-drop CLOSED by #609)"

# MonitoringRoleArn: present and non-empty proves the role ARN rode the create.
ACTUAL_MON_ROLE=$(echo "${INSTANCE}" | jq -r '.MonitoringRoleArn // "null"')
if [ "${ACTUAL_MON_ROLE}" = "null" ] || [ -z "${ACTUAL_MON_ROLE}" ]; then
  echo "FAIL: MonitoringRoleArn is empty (MonitoringRoleArn silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: MonitoringRoleArn == ${ACTUAL_MON_ROLE} on AWS (silent-drop CLOSED by #609)"

# EnableIAMDatabaseAuthentication: AWS surfaces it as
# IAMDatabaseAuthenticationEnabled. Same false-vs-null trap as above —
# use the explicit-presence check (jq `//` treats false as missing).
ACTUAL_IAM_AUTH=$(echo "${INSTANCE}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
if [ "${ACTUAL_IAM_AUTH}" != "${EXPECTED_IAM_AUTH}" ]; then
  echo "FAIL: IAMDatabaseAuthenticationEnabled is '${ACTUAL_IAM_AUTH}', expected '${EXPECTED_IAM_AUTH}' (EnableIAMDatabaseAuthentication silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: EnableIAMDatabaseAuthentication == ${EXPECTED_IAM_AUTH} on AWS (silent-drop CLOSED by #609)"

# KmsKeyId: storage-encryption key. With StorageEncrypted=true + the
# aws/rds alias, AWS resolves and returns a key ARN. Non-empty proves the
# create payload carried KmsKeyId.
ACTUAL_KMS=$(echo "${INSTANCE}" | jq -r '.KmsKeyId // "null"')
if [ "${ACTUAL_KMS}" = "null" ] || [ -z "${ACTUAL_KMS}" ]; then
  echo "FAIL: KmsKeyId is empty (KmsKeyId / StorageEncrypted silent-drop NOT closed)" >&2
  exit 1
fi
echo "    OK: KmsKeyId == ${ACTUAL_KMS} on AWS (silent-drop CLOSED by #609)"

# ManageMasterUserPassword + MasterUserSecret: a managed master password is
# reflected by a populated MasterUserSecret (with SecretArn + KmsKeyId).
# Without ManageMasterUserPassword the create would have failed outright
# (no MasterUserPassword was supplied — they are mutually exclusive), so a
# populated secret proves both props rode.
ACTUAL_SECRET=$(echo "${INSTANCE}" | jq -r '.MasterUserSecret.SecretArn // "null"')
if [ "${ACTUAL_SECRET}" = "null" ] || [ -z "${ACTUAL_SECRET}" ]; then
  echo "FAIL: MasterUserSecret.SecretArn is empty (ManageMasterUserPassword / MasterUserSecret silent-drop NOT closed)" >&2
  echo "${INSTANCE}" | jq '.MasterUserSecret'
  exit 1
fi
echo "    OK: MasterUserSecret populated (${ACTUAL_SECRET}); ManageMasterUserPassword + MasterUserSecret CLOSED by #609"

# --- Assertions: go-to-k/cdkd#2762 props reached AWS ----------------------
# Each is the template's NON-default value, so a silent drop reads back the
# AWS default instead. `tostring` with `has()` keeps an explicit false.
# usage: assert_instance_field <jq path> <expected> <property> <phase>
assert_instance_field() {
  local actual
  actual=$(echo "${INSTANCE}" | jq -r "if (${1}) == null then \"null\" else (${1}) | tostring end")
  if [ "${actual}" != "${2}" ]; then
    echo "FAIL: ${4}: ${1} is '${actual}', expected '${2}' (${3} did not reach AWS, go-to-k/cdkd#2762)" >&2
    exit 1
  fi
  echo "    OK: ${4}: ${1} == ${2} on AWS (${3}, go-to-k/cdkd#2762)"
}
assert_instance_field '.StorageType' 'gp3' 'StorageType' 'phase 1'

# go-to-k/cdkd#5640: the associations, as `<role name>:<feature>` sorted (RDS
# answers in its own order); cdkd returns once each change reads back. An
# unread instance or a missing list prints a marker, never the empty string a
# detached list prints.
ROLES_JQ='if type != "object" then "<no instance read>" elif .AssociatedRoles == null then "<no AssociatedRoles field>" else ([.AssociatedRoles[] | ((.RoleArn | split("/") | last) + ":" + (.FeatureName // ""))] | sort | join(" ")) end'
# usage: state_role_name <logical id prefix> -> the IAM role's name from state
state_role_name() {
  echo "${STATE}" | jq -r --arg re "^$1" '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::Role" and (.key | test($re))) | .value.physicalId] | first // ""'
}
IMPORT_ROLE_NAME=$(state_role_name "S3ImportRole")
EXPORT_ROLE_NAME=$(state_role_name "S3ExportRole")
if [ -z "${IMPORT_ROLE_NAME}" ] || [ -z "${EXPORT_ROLE_NAME}" ]; then
  echo "FAIL: #5640: could not resolve the import / export role names from state (got '${IMPORT_ROLE_NAME}' / '${EXPORT_ROLE_NAME}')" >&2
  exit 1
fi
assert_instance_field "${ROLES_JQ}" "${IMPORT_ROLE_NAME}:s3Import" 'AssociatedRoles (the create attaches the declared role)' 'phase 1'
assert_instance_field '.AllocatedStorage' '400' 'AllocatedStorage' 'phase 1'
assert_instance_field '.Iops' '13000' 'Iops' 'phase 1'
assert_instance_field '.StorageThroughput' '600' 'StorageThroughput' 'phase 1'
assert_instance_field '.MaxAllocatedStorage' '500' 'MaxAllocatedStorage' 'phase 1'
assert_instance_field '.BackupRetentionPeriod' '3' 'BackupRetentionPeriod' 'phase 1'
assert_instance_field '.PreferredBackupWindow' '03:00-03:30' 'PreferredBackupWindow' 'phase 1'
assert_instance_field '.PreferredMaintenanceWindow' 'sun:05:00-sun:05:30' 'PreferredMaintenanceWindow' 'phase 1'
assert_instance_field '.AutoMinorVersionUpgrade' 'false' 'AutoMinorVersionUpgrade' 'phase 1'
assert_instance_field '.CopyTagsToSnapshot' 'true' 'CopyTagsToSnapshot' 'phase 1'
assert_instance_field '.CACertificateIdentifier' 'rds-ca-rsa4096-g1' 'CACertificateIdentifier' 'phase 1'
assert_instance_field '.PerformanceInsightsEnabled' 'true' 'EnablePerformanceInsights' 'phase 1'
assert_instance_field '.PerformanceInsightsRetentionPeriod' '31' 'PerformanceInsightsRetentionPeriod' 'phase 1'
# go-to-k/cdkd#2762: NetworkType / LicenseModel / DatabaseInsightsMode /
# AllowMajorVersionUpgrade. Each value is the one RDS would pick anyway (no
# other is available to this instance without IPv6 subnets or a paid
# Performance Insights tier), so the discriminator is the provisionedBy=sdk
# guard above: any one of them unhandled routes the instance to Cloud Control.
# AllowMajorVersionUpgrade is a ModifyDBInstance flag RDS never reads back.
assert_instance_field '.NetworkType' 'IPV4' 'NetworkType' 'phase 1'
assert_instance_field '.LicenseModel' 'postgresql-license' 'LicenseModel' 'phase 1'
assert_instance_field '.DatabaseInsightsMode' 'standard' 'DatabaseInsightsMode' 'phase 1'
# go-to-k/cdkd#5640: EngineLifecycleSupport rode CreateDBInstance (AWS's
# default is open-source-rds-extended-support, so a dropped value reads back
# differently). MasterUserAuthenticationType `password` is write-only (no
# Describe field): only the provisionedBy=sdk guard above sees it. Both are
# unchanged in every phase.
assert_instance_field '.EngineLifecycleSupport' 'open-source-rds-extended-support-disabled' 'EngineLifecycleSupport' 'phase 1'
# go-to-k/cdkd#2762: DBParameterGroupName rode CreateDBInstance. RDS stores the
# name lower-cased, so both sides are compared lower-cased.
PG_A_LOWER=$(printf '%s' "${PG_A_ID}" | tr '[:upper:]' '[:lower:]')
PG_B_LOWER=$(printf '%s' "${PG_B_ID}" | tr '[:upper:]' '[:lower:]')
assert_instance_field '(.DBParameterGroups[0].DBParameterGroupName // "null") | ascii_downcase' "${PG_A_LOWER}" 'DBParameterGroupName' 'phase 1'
assert_instance_field '.DBParameterGroups[0].ParameterApplyStatus' 'in-sync' 'DBParameterGroupName applied at create' 'phase 1'

# go-to-k/cdkd#5640: the exported log types on ${INSTANCE}, sorted (RDS answers
# in its own order). No pending change may be left: the deploy returns once the
# change is applied, as CloudFormation's does.
# usage: assert_log_exports <expected, space-separated, sorted> <what> <phase>
assert_log_exports() {
  local actual pending
  actual=$(echo "${INSTANCE}" | jq -r '[.EnabledCloudwatchLogsExports[]?] | sort | join(" ")')
  pending=$(echo "${INSTANCE}" | jq -c '.PendingModifiedValues.PendingCloudwatchLogsExports // null')
  if [ "${actual}" != "${1}" ] || [ "${pending}" != "null" ]; then
    echo "FAIL: ${3}: EnabledCloudwatchLogsExports is '${actual}' (pending: ${pending}), expected '${1}' with nothing pending (${2}, go-to-k/cdkd#5640)" >&2
    exit 1
  fi
  echo "    OK: ${3}: EnabledCloudwatchLogsExports == '${1}' on AWS (${2}, go-to-k/cdkd#5640)"
}
assert_log_exports 'postgresql' 'EnableCloudwatchLogsExports rode CreateDBInstance' 'phase 1'

# go-to-k/cdkd#5640: DBName and AvailabilityZone rode CreateDBInstance. The
# zone the template declared is the state record's, by logical id (the
# fixture resolves it from the VPC's second subnet).
EXPECTED_AZ=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.key | test("^BackfillInstance")) | .value.properties.AvailabilityZone // empty] | first // ""')
if [ -z "${EXPECTED_AZ}" ]; then
  echo "FAIL: #5640 premise: the BackfillInstance record declares no AvailabilityZone" >&2
  exit 1
fi
ACTUAL_DB_NAME=$(echo "${INSTANCE}" | jq -r '.DBName // "null"')
if [ "${ACTUAL_DB_NAME}" != "cdkdbackfill" ]; then
  echo "FAIL: phase 1: DBName is '${ACTUAL_DB_NAME}', expected 'cdkdbackfill' (DBName did not reach CreateDBInstance, go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK: phase 1: DBName == cdkdbackfill on AWS (go-to-k/cdkd#5640)"
ACTUAL_AZ=$(echo "${INSTANCE}" | jq -r '.AvailabilityZone // "null"')
if [ "${ACTUAL_AZ}" != "${EXPECTED_AZ}" ]; then
  echo "FAIL: phase 1: AvailabilityZone is '${ACTUAL_AZ}', expected '${EXPECTED_AZ}' (AvailabilityZone did not reach CreateDBInstance, go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK: phase 1: AvailabilityZone == ${EXPECTED_AZ} on AWS (go-to-k/cdkd#5640)"

# go-to-k/cdkd#5640: the readback reports both. The record's observed baseline
# is captured from readCurrentState after the deploy, so it holds them only
# when the readback emits them; drift then compares the instance through that
# baseline and must find it unchanged.
OBSERVED_DB_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.key | test("^BackfillInstance")) | .value.observedProperties.DBName // "null"] | first // "null"')
OBSERVED_AZ=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.key | test("^BackfillInstance")) | .value.observedProperties.AvailabilityZone // "null"] | first // "null"')
if [ "${OBSERVED_DB_NAME}" != "cdkdbackfill" ] || [ "${OBSERVED_AZ}" != "${EXPECTED_AZ}" ]; then
  echo "FAIL: phase 1: the BackfillInstance observed baseline holds DBName='${OBSERVED_DB_NAME}' AvailabilityZone='${OBSERVED_AZ}', expected 'cdkdbackfill' / '${EXPECTED_AZ}' (readCurrentState does not report them, go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK: phase 1: the observed baseline holds DBName and AvailabilityZone (go-to-k/cdkd#5640)"
DRIFT_OUT=$(mktemp)
set +e
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" > "${DRIFT_OUT}" 2>&1
DRIFT_RC=$?
set -e
# Only the instance's own rows: other resources' drift is not this arm's subject.
# `~` drifted, `?` unsupported, `!` not compared (a readback that threw), `-`
# deleted: each means the readback did not prove the instance unchanged.
if grep -qE '^[[:space:]]*[~?!-] BackfillInstance \(AWS::RDS::DBInstance\)' "${DRIFT_OUT}"; then
  echo "FAIL: phase 1: cdkd drift reports the unchanged BackfillInstance as drifted, unsupported, not compared or deleted (go-to-k/cdkd#5640; drift rc=${DRIFT_RC}):" >&2
  cat "${DRIFT_OUT}" >&2
  rm -f "${DRIFT_OUT}"
  exit 1
fi
# Sentinel: the per-stack verdict heading (`✓ <stack> (<region>): ...` or
# `⚠ <stack> (<region>): ...`). A crashed run, or one that never reported this
# stack, prints none, and the row check above cannot tell that from "clean".
# The rc cannot: a crash exits 1, the same as detected drift.
if ! grep -qE "^[[:space:]]*(✓|⚠) ${STACK} \(${REGION}\): " "${DRIFT_OUT}"; then
  echo "FAIL: phase 1: cdkd drift did not report on ${STACK} (rc=${DRIFT_RC}), so it compared nothing (go-to-k/cdkd#5640):" >&2
  cat "${DRIFT_OUT}" >&2
  rm -f "${DRIFT_OUT}"
  exit 1
fi
rm -f "${DRIFT_OUT}"
echo "    OK: phase 1: cdkd drift does not report BackfillInstance as drifted (go-to-k/cdkd#5640)"

# #5542 premise: the VPC's `default` group, which the phase-2 removal of
# VPCSecurityGroups must attach. Resolved through the instance's own subnet
# group VPC, and it must differ from the custom group phase 1 asserted.
INSTANCE_VPC=$(echo "${INSTANCE}" | jq -r '.DBSubnetGroup.VpcId // ""')
if [ -z "${INSTANCE_VPC}" ]; then
  echo "FAIL: #5542 premise: DescribeDBInstances reports no DBSubnetGroup.VpcId" >&2
  exit 1
fi
DEFAULT_SG=$(aws ec2 describe-security-groups \
  --filters "Name=vpc-id,Values=${INSTANCE_VPC}" "Name=group-name,Values=default" \
  --region "${REGION}" \
  --query 'SecurityGroups[0].GroupId' --output text)
if [ -z "${DEFAULT_SG}" ] || [ "${DEFAULT_SG}" = "None" ] || [ "${DEFAULT_SG}" = "${EXPECTED_SG}" ]; then
  echo "FAIL: #5542 premise: VPC ${INSTANCE_VPC} default security group is '${DEFAULT_SG}' (custom group: ${EXPECTED_SG})" >&2
  exit 1
fi
echo "    VPC ${INSTANCE_VPC} default security group: ${DEFAULT_SG} (#5542)"

# --- Phase 1d: an out-of-band minor engine upgrade (go-to-k/cdkd#2762) --------
# What AWS does on its own under AutoMinorVersionUpgrade (the CFn default):
# the live version moves past the template's ${EXPECTED_ENGINE_VERSION}. The
# phase-2 template keeps ${EXPECTED_ENGINE_VERSION}, so EngineVersion is
# unchanged there. A cdkd that re-sends an unchanged EngineVersion on every
# ModifyDBInstance asks RDS to downgrade, and the phase-2 deploy fails with
# InvalidParameterCombination; CloudFormation sends EngineVersion only when the
# template changed it.
UPGRADE_TARGET=$(aws rds describe-db-engine-versions --engine postgres \
  --engine-version "${EXPECTED_ENGINE_VERSION}" --region "${REGION}" \
  --query 'DBEngineVersions[0].ValidUpgradeTarget[?IsMajorVersionUpgrade==`false`].EngineVersion' \
  --output json | jq -r 'first // ""')
if [ -z "${UPGRADE_TARGET}" ]; then
  echo "FAIL: #2762 premise: postgres ${EXPECTED_ENGINE_VERSION} lists no minor upgrade target in ${REGION}" >&2
  exit 1
fi
echo "==> Phase 1d: upgrade the instance out of band, ${EXPECTED_ENGINE_VERSION} -> ${UPGRADE_TARGET} (go-to-k/cdkd#2762)"
aws rds modify-db-instance --db-instance-identifier "${DB_INSTANCE_ID}" \
  --engine-version "${UPGRADE_TARGET}" --apply-immediately \
  --region "${REGION}" >/dev/null
UPGRADED=""
UPGRADE_ERR=$(mktemp)
for _ in $(seq 1 240); do
  # A failed read (a throttle mid-upgrade) is retried, not fatal; the last
  # read and its stderr are printed if the loop gives up.
  UPGRADE_READ=$(aws rds describe-db-instances \
    --db-instance-identifier "${DB_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'DBInstances[0]' --output json 2>"${UPGRADE_ERR}" |
    jq -r '"\(.DBInstanceStatus // "null") \(.EngineVersion // "null")"') ||
    UPGRADE_READ="describe-failed: $(tail -c 300 "${UPGRADE_ERR}")"
  if [ "${UPGRADE_READ}" = "available ${UPGRADE_TARGET}" ]; then
    UPGRADED="yes"
    break
  fi
  sleep 15
done
rm -f "${UPGRADE_ERR}"
if [ -z "${UPGRADED}" ]; then
  echo "FAIL: #2762 premise: the out-of-band upgrade to ${UPGRADE_TARGET} did not settle (last read: '${UPGRADE_READ}')" >&2
  exit 1
fi
echo "    OK: the instance runs ${UPGRADE_TARGET}; the template still says ${EXPECTED_ENGINE_VERSION}"

# --- Phase 2: UPDATE pass (#5004 removal keeps the value, #5542 resets) -------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (DROP DeletionProtection + EnableIAMDatabaseAuthentication + MonitoringInterval, which must be KEPT, and VPCSecurityGroups, which must move to the VPC default group; move Port 5433 -> 5434)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# #5004: the removed fields must be KEPT (CloudFormation keeps them on
# removal), NOT reset. Premise: phase 1 asserted all three live above.
# Wait for 'available' (guards the destroy below against an
# InvalidDBInstanceState race), then assert all three are unchanged.
echo "==> Waiting for the DBInstance to settle, then asserting the removed fields were KEPT (#5004)"
SETTLED=""
for _ in $(seq 1 60); do
  AFTER=$(aws rds describe-db-instances \
    --db-instance-identifier "${DB_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'DBInstances[0]' --output json)
  AFTER_STATUS=$(echo "${AFTER}" | jq -r '.DBInstanceStatus // "null"')
  # The port applies via a reboot that can trail ModifyDBInstance, so 'available'
  # alone can still read the old port: settle on both.
  if [ "${AFTER_STATUS}" = "available" ] && [ "$(echo "${AFTER}" | jq -r '.Endpoint.Port // "null"')" = "${EXPECTED_UPDATED_PORT}" ]; then
    SETTLED="yes"
    break
  fi
  sleep 10
done
# Companion change: phase 2 also moved the port, so a live 5434 proves
# ModifyDBInstance FIRED in this deploy. Asserted BEFORE the KEEP checks: without
# it a skipped modify would leave the dropped fields untouched and pass vacuously.
AFTER_PORT=$(echo "${AFTER}" | jq -r '.Endpoint.Port // "null"')
if [ -z "${SETTLED}" ] || [ "${AFTER_PORT}" != "${EXPECTED_UPDATED_PORT}" ]; then
  echo "FAIL: after phase 2, Endpoint.Port is '${AFTER_PORT}' (status='${AFTER_STATUS}'), expected '${EXPECTED_UPDATED_PORT}' -- ModifyDBInstance did not fire, so the KEEP assertions below would prove nothing (#5004)" >&2
  exit 1
fi
echo "    OK: phase 2 ModifyDBInstance fired (Endpoint.Port == ${EXPECTED_UPDATED_PORT}) -- the KEEP assertions are non-vacuous"
AFTER_PROTECTION=$(echo "${AFTER}" | jq -r 'if has("DeletionProtection") then .DeletionProtection | tostring else "null" end')
AFTER_IAM=$(echo "${AFTER}" | jq -r 'if has("IAMDatabaseAuthenticationEnabled") then .IAMDatabaseAuthenticationEnabled | tostring else "null" end')
AFTER_INTERVAL=$(echo "${AFTER}" | jq -r '.MonitoringInterval // "null"')
if [ -z "${SETTLED}" ] || [ "${AFTER_PROTECTION}" != "true" ] || [ "${AFTER_IAM}" != "true" ] || [ "${AFTER_INTERVAL}" != "${EXPECTED_MONITORING_INTERVAL}" ]; then
  echo "FAIL: after removal, DBInstance did not keep DeletionProtection=true + IAMDatabaseAuthenticationEnabled=true + MonitoringInterval=${EXPECTED_MONITORING_INTERVAL} (status='${AFTER_STATUS}', protection='${AFTER_PROTECTION}', iamAuth='${AFTER_IAM}', interval='${AFTER_INTERVAL}') — #5004: CloudFormation keeps all three on removal" >&2
  exit 1
fi
echo "    OK: after removal, AWS kept DeletionProtection=true + IAMDatabaseAuthenticationEnabled=true + MonitoringInterval=${EXPECTED_MONITORING_INTERVAL} (#5004, matches CloudFormation)"

# go-to-k/cdkd#2762 on update: the changed values reached AWS through
# ModifyDBInstance, the removed AutoMinorVersionUpgrade was KEPT (phase 1
# asserted the non-default false), and the storage was left alone.
INSTANCE="${AFTER}"
assert_instance_field '.BackupRetentionPeriod' '5' 'BackupRetentionPeriod change' 'phase 2'
assert_instance_field "${ROLES_JQ}" "${EXPORT_ROLE_NAME}:s3Export" 'AssociatedRoles swap (detach the import role, attach the export role; go-to-k/cdkd#5640)' 'phase 2'
assert_instance_field '.PreferredMaintenanceWindow' 'mon:05:00-mon:05:30' 'PreferredMaintenanceWindow change' 'phase 2'
assert_instance_field '.PerformanceInsightsRetentionPeriod' '7' 'PerformanceInsightsRetentionPeriod change' 'phase 2'
assert_instance_field '.PerformanceInsightsEnabled' 'true' 'EnablePerformanceInsights beside the retention change' 'phase 2'
assert_instance_field '.AutoMinorVersionUpgrade' 'false' 'a removed AutoMinorVersionUpgrade is KEPT, as CloudFormation keeps it' 'phase 2'
assert_instance_field '.AllocatedStorage' '400' 'unchanged AllocatedStorage' 'phase 2'
assert_instance_field '.Iops' '13000' 'unchanged Iops' 'phase 2'
# Phase 1d moved the version out of band and the template kept the old one: the
# phase-2 deploy above succeeding is the main signal (a re-sent EngineVersion is
# refused as a downgrade); the live version must also still be the upgraded one.
assert_instance_field '.EngineVersion' "${UPGRADE_TARGET}" 'an unchanged EngineVersion is not re-sent' 'phase 2'
# go-to-k/cdkd#5640: the added `upgrade` was enabled through ModifyDBInstance's
# CloudwatchLogsExportConfiguration, and `postgresql` kept.
assert_log_exports 'postgresql upgrade' 'an added log type is enabled' 'phase 2'

# A removed MaxAllocatedStorage turns storage autoscaling OFF, as
# CloudFormation's handler does by setting the maximum to the allocated
# storage. Phase 1 asserted 500; the readback now reports the allocated
# storage, or no maximum at all.
AFTER_MAX_STORAGE=$(echo "${AFTER}" | jq -r '.MaxAllocatedStorage // "null"')
if [ "${AFTER_MAX_STORAGE}" != "400" ] && [ "${AFTER_MAX_STORAGE}" != "null" ]; then
  echo "FAIL: phase 2: a removed MaxAllocatedStorage left it at '${AFTER_MAX_STORAGE}', expected autoscaling off (400 or absent) -- go-to-k/cdkd#2762: CloudFormation sets it to the allocated storage" >&2
  exit 1
fi
echo "    OK: phase 2: removed MaxAllocatedStorage turned autoscaling off (MaxAllocatedStorage=${AFTER_MAX_STORAGE}, go-to-k/cdkd#2762)"

# #5542: the removed VPCSecurityGroups RESETS to the VPC's default group, as
# CloudFormation does. The swap can trail 'available', so poll for it; a cdkd
# that sends nothing leaves the custom group attached and fails here.
echo "==> Asserting the removed VPCSecurityGroups moved the instance to the VPC default group (#5542)"
AFTER_SGS=""
for _ in $(seq 1 30); do
  AFTER_SGS=$(aws rds describe-db-instances \
    --db-instance-identifier "${DB_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'DBInstances[0]' --output json |
    jq -r '[.VpcSecurityGroups[]? | "\(.VpcSecurityGroupId):\(.Status)"] | sort | join(",")')
  [ "${AFTER_SGS}" = "${DEFAULT_SG}:active" ] && break
  sleep 10
done
if [ "${AFTER_SGS}" != "${DEFAULT_SG}:active" ]; then
  echo "FAIL: after removing VPCSecurityGroups, the instance's groups are '${AFTER_SGS}', expected only the VPC default group '${DEFAULT_SG}:active' (custom group: ${EXPECTED_SG}) -- #5542: CloudFormation attaches the VPC default group on that removal" >&2
  exit 1
fi
echo "    OK: after removal, the instance is on the VPC default group ${DEFAULT_SG} only (#5542, matches CloudFormation)"

# --- Phase 2b: change ONLY the parameter group (go-to-k/cdkd#2762) -------------
# A -> B. RDS lists B `pending-reboot` until the instance reboots; CloudFormation
# reboots after the update and waits for `in-sync`, so the deploy returning is
# the moment to read: a cdkd that sends the group but never reboots leaves B
# `pending-reboot` here, and one that does not send it leaves A.
echo "==> Phase 2b: redeploy with CDKD_TEST_PARAM_GROUP=b (only the parameter group changes, A -> B; go-to-k/cdkd#2762)"
CDKD_TEST_UPDATE=true CDKD_TEST_PARAM_GROUP=b node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json)
assert_instance_field '.DBParameterGroups | length' '1' 'a single parameter group after the change' 'phase 2b'
assert_instance_field '(.DBParameterGroups[0].DBParameterGroupName // "null") | ascii_downcase' "${PG_B_LOWER}" 'a changed DBParameterGroupName is sent' 'phase 2b'
assert_instance_field '.DBParameterGroups[0].ParameterApplyStatus' 'in-sync' 'the reboot after a pending-reboot parameter group change' 'phase 2b'
assert_instance_field '.DBInstanceStatus' 'available' 'the deploy waited for the reboot' 'phase 2b'

# --- Phase 2c: drop EnableCloudwatchLogsExports (go-to-k/cdkd#5640) -----------
# CloudFormation's handler disables every log type the previous template
# declared when the property is removed (`Translator.
# buildTranslateCloudwatchLogsExportConfiguration`: previous minus desired).
# Premise: phase 2 asserted both live. A cdkd that sends nothing on a removal
# leaves both enabled here. Parameter group B is the retained sibling.
echo "==> Phase 2c: redeploy with CDKD_TEST_LOGS_REMOVED=true (EnableCloudwatchLogsExports dropped; go-to-k/cdkd#5640)"
CDKD_TEST_UPDATE=true CDKD_TEST_PARAM_GROUP=b CDKD_TEST_LOGS_REMOVED=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json)
assert_log_exports '' 'a removed EnableCloudwatchLogsExports disables what the previous template declared' 'phase 2c'
# go-to-k/cdkd#5640: phase 2 asserted the export role live; the removal detaches it.
assert_instance_field "${ROLES_JQ}" '' 'a removed AssociatedRoles detaches the recorded role (go-to-k/cdkd#5640)' 'phase 2c'
assert_instance_field '(.DBParameterGroups[0].DBParameterGroupName // "null") | ascii_downcase' "${PG_B_LOWER}" 'the retained parameter group' 'phase 2c'

# --- Phase 2d: two read replicas (go-to-k/cdkd#5640) --------------------------
# SourceDBInstanceIdentifier, named by ARN as CDK's DatabaseInstanceReadReplica
# names it. Before #5640 a declared source routed each replica to Cloud Control,
# which the provisionedBy=sdk guard below catches. Each declares a maintenance
# window CreateDBInstanceReadReplica cannot carry: CloudFormation's after-create
# ModifyDBInstance applies it, so a cdkd that sends no follow-up leaves RDS's
# own window. The source is a dedicated instance created in the same deploy
# (ReplicaSourceInstance): RDS refuses a replica of a PostgreSQL source whose
# managed master password is on, which BackfillInstance's is. cdkd creates the
# replicas once it is `available`, as their reference orders them.
# go-to-k/cdkd#5640 (SourceRegion): the cross-region replica's source first, in
# its own stack and region; ReadReplicaCrossRegion names it by ARN.
echo "==> Phase 2d: deploy ${XR_STACK} in ${XR_REGION} (the cross-region replica's source; go-to-k/cdkd#5640)"
node "${LOCAL_DIST}" deploy "${XR_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${XR_REGION}" \
  --yes
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${XR_SOURCE_ID}" \
  --region "${XR_REGION}" \
  --query 'DBInstances[0]' --output json)
assert_instance_field '.DBInstanceStatus' 'available' "the cross-region source ${XR_SOURCE_ID} is available" 'phase 2d'
echo "==> Phase 2d: redeploy with CDKD_TEST_REPLICA=create (a source instance and two read replicas of it, plus a cross-region replica; go-to-k/cdkd#5640)"
CDKD_TEST_UPDATE=true CDKD_TEST_PARAM_GROUP=b CDKD_TEST_LOGS_REMOVED=true CDKD_TEST_REPLICA=create node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
# usage: replica_record_field <logical id prefix> <jq path, default if absent>
replica_record_field() {
  echo "${STATE}" | jq -r --arg re "^$1" "[.resources | to_entries[] | select(.value.resourceType == \"AWS::RDS::DBInstance\" and (.key | test(\$re))) | ${2}] | if length == 1 then .[0] else \"<\(length) records>\" end"
}
REPLICA_KEPT_ID=$(replica_record_field ReadReplicaKept '.value.physicalId')
REPLICA_PROMOTED_ID=$(replica_record_field ReadReplicaPromoted '.value.physicalId')
REPLICA_SOURCE_ID=$(replica_record_field ReplicaSourceInstance '.value.physicalId')
REPLICA_XR_ID=$(replica_record_field ReadReplicaCrossRegion '.value.physicalId')
if [ "${REPLICA_XR_ID}" != "${XR_REPLICA_ID}" ]; then
  echo "FAIL: phase 2d: premise: ReadReplicaCrossRegion records physical id '${REPLICA_XR_ID}', expected the declared '${XR_REPLICA_ID}' cleanup deletes by name (go-to-k/cdkd#5640)" >&2
  exit 1
fi
for replica in ReadReplicaKept ReadReplicaPromoted ReadReplicaCrossRegion; do
  REPLICA_ROUTE=$(replica_record_field "${replica}" '.value.provisionedBy // "sdk"')
  if [ "${REPLICA_ROUTE}" != "sdk" ]; then
    echo "FAIL: phase 2d: ${replica} routed via '${REPLICA_ROUTE}', expected sdk (SourceDBInstanceIdentifier / SourceRegion is SDK-unwired, go-to-k/cdkd#5640)" >&2
    exit 1
  fi
done
echo "    OK: phase 2d: the three replicas are provisionedBy=sdk (${REPLICA_KEPT_ID}, ${REPLICA_PROMOTED_ID}, ${REPLICA_XR_ID})"
# go-to-k/cdkd#5640 (SourceRegion): the record keeps the declared SourceRegion
# (nothing narrowed it away), and the replica is one of the source in XR_REGION.
XR_RECORDED_REGION=$(replica_record_field ReadReplicaCrossRegion '.value.properties.SourceRegion // "null"')
if [ "${XR_RECORDED_REGION}" != "${XR_REGION}" ]; then
  echo "FAIL: phase 2d: the ReadReplicaCrossRegion record holds SourceRegion '${XR_RECORDED_REGION}', expected '${XR_REGION}' (go-to-k/cdkd#5640)" >&2
  exit 1
fi
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${REPLICA_XR_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json)
assert_instance_field '(.ReadReplicaSourceDBInstanceIdentifier // "null") | split(":") | "\(.[0])/\(.[3] // "")/\(last | ascii_downcase)"' "arn/${XR_REGION}/${XR_SOURCE_ID}" "ReadReplicaCrossRegion replicates ${XR_SOURCE_ID} in ${XR_REGION}, by ARN (go-to-k/cdkd#5640)" 'phase 2d'
assert_instance_field '.PreferredMaintenanceWindow' 'wed:06:00-wed:06:30' "the after-create ModifyDBInstance applied the cross-region replica's window (go-to-k/cdkd#5640)" 'phase 2d'
assert_instance_field '.DBInstanceStatus' 'available' 'the cross-region replica is available' 'phase 2d'
echo "    OK: phase 2d: ReadReplicaCrossRegion (${REPLICA_XR_ID}) is a replica of ${XR_SOURCE_ID} in ${XR_REGION}"
SOURCE_LOWER=$(printf '%s' "${REPLICA_SOURCE_ID}" | tr '[:upper:]' '[:lower:]')
# usage: assert_replica <identifier> <expected maintenance window> <phase>
assert_replica() {
  INSTANCE=$(aws rds describe-db-instances \
    --db-instance-identifier "$1" \
    --region "${REGION}" \
    --query 'DBInstances[0]' --output json) || return 1
  assert_instance_field '(.ReadReplicaSourceDBInstanceIdentifier // "null") | ascii_downcase' "${SOURCE_LOWER}" "SourceDBInstanceIdentifier made $1 a replica of ReplicaSourceInstance (go-to-k/cdkd#5640)" "$3"
  assert_instance_field '.PreferredMaintenanceWindow' "$2" "the after-create ModifyDBInstance applied $1's window (go-to-k/cdkd#5640)" "$3"
  assert_instance_field '.DBInstanceStatus' 'available' "$1 is available" "$3"
}
assert_replica "${REPLICA_KEPT_ID}" 'mon:06:00-mon:06:30' 'phase 2d'
assert_replica "${REPLICA_PROMOTED_ID}" 'tue:06:00-tue:06:30' 'phase 2d'
PROMOTED_RESOURCE_ID=$(echo "${INSTANCE}" | jq -r '.DbiResourceId // ""')
# The readback must report the source: the observed baseline carries it, and
# `cdkd drift` reads the unchanged replicas clean against that baseline (the
# readback's own spelling). Pairing the template's ARN with RDS's identifier
# happens only on a baseline without observedProperties: unit-tested
# (`canonicalizeDriftPair`), not proven here.
for replica in ReadReplicaKept ReadReplicaPromoted; do
  # Read back as the source's ARN: its region field and its trailing name.
  OBSERVED_SOURCE=$(replica_record_field "${replica}" '(.value.observedProperties.SourceDBInstanceIdentifier // "null") | split(":") | "\(.[3] // "")/\(last | ascii_downcase)"')
  if [ "${OBSERVED_SOURCE}" != "${REGION}/${SOURCE_LOWER}" ]; then
    echo "FAIL: phase 2d: the ${replica} observed baseline holds SourceDBInstanceIdentifier region/name '${OBSERVED_SOURCE}', expected '${REGION}/${SOURCE_LOWER}' (readCurrentState does not report it, go-to-k/cdkd#5640)" >&2
    exit 1
  fi
done
# The cross-region one reads back as its source's ARN too; SourceRegion is
# write-only, so drift (below) must not compare it (go-to-k/cdkd#5640).
OBSERVED_SOURCE=$(replica_record_field ReadReplicaCrossRegion '(.value.observedProperties.SourceDBInstanceIdentifier // "null") | split(":") | "\(.[3] // "")/\(last | ascii_downcase)"')
if [ "${OBSERVED_SOURCE}" != "${XR_REGION}/${XR_SOURCE_ID}" ]; then
  echo "FAIL: phase 2d: the ReadReplicaCrossRegion observed baseline holds SourceDBInstanceIdentifier region/name '${OBSERVED_SOURCE}', expected '${XR_REGION}/${XR_SOURCE_ID}' (go-to-k/cdkd#5640)" >&2
  exit 1
fi
DRIFT_OUT=$(mktemp)
set +e
node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" > "${DRIFT_OUT}" 2>&1
DRIFT_RC=$?
set -e
if grep -qE '^[[:space:]]*[~?!-] ReadReplica(Kept|Promoted|CrossRegion) \(AWS::RDS::DBInstance\)' "${DRIFT_OUT}"; then
  echo "FAIL: phase 2d: cdkd drift reports an unchanged read replica as drifted, unsupported, not compared or deleted (go-to-k/cdkd#5640; drift rc=${DRIFT_RC}):" >&2
  cat "${DRIFT_OUT}" >&2
  rm -f "${DRIFT_OUT}"
  exit 1
fi
# Sentinel: the per-stack verdict heading, as in phase 1.
if ! grep -qE "^[[:space:]]*(✓|⚠) ${STACK} \(${REGION}\): " "${DRIFT_OUT}"; then
  echo "FAIL: phase 2d: cdkd drift did not report on ${STACK} (rc=${DRIFT_RC}), so it compared nothing (go-to-k/cdkd#5640):" >&2
  cat "${DRIFT_OUT}" >&2
  rm -f "${DRIFT_OUT}"
  exit 1
fi
rm -f "${DRIFT_OUT}"
echo "    OK: phase 2d: cdkd drift does not report the read replicas (the cross-region one included) as drifted (go-to-k/cdkd#5640)"
if [ -z "${PROMOTED_RESOURCE_ID}" ]; then
  echo "FAIL: phase 2d: DescribeDBInstances reported no DbiResourceId for ${REPLICA_PROMOTED_ID}" >&2
  exit 1
fi

# --- Phase 2e: promote one replica (go-to-k/cdkd#5640) --------------------------
# ReadReplicaPromoted drops its source and declares backup settings; as
# CloudFormation's update handler does, cdkd promotes it in place
# (PromoteReadReplica) and the ModifyDBInstance after it, which both carry
# them. The empty source and the same DbiResourceId prove an in-place
# promotion; the backup asserts prove only that the promoted instance holds the
# declared settings, not which of the two calls set them (unit-tested).
# ReadReplicaKept is unchanged and stays a replica.
echo "==> Phase 2e: redeploy with CDKD_TEST_REPLICA=promote (ReadReplicaPromoted drops its source; go-to-k/cdkd#5640)"
CDKD_TEST_UPDATE=true CDKD_TEST_PARAM_GROUP=b CDKD_TEST_LOGS_REMOVED=true CDKD_TEST_REPLICA=promote node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${REPLICA_PROMOTED_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json)
assert_instance_field '.ReadReplicaSourceDBInstanceIdentifier' 'null' 'a removed SourceDBInstanceIdentifier promotes the replica (go-to-k/cdkd#5640)' 'phase 2e'
assert_instance_field '.DbiResourceId' "${PROMOTED_RESOURCE_ID}" 'the promotion is in place, not a replacement (go-to-k/cdkd#5640)' 'phase 2e'
assert_instance_field '.BackupRetentionPeriod' '2' 'the promoted instance holds the declared BackupRetentionPeriod (go-to-k/cdkd#5640)' 'phase 2e'
assert_instance_field '.PreferredBackupWindow' '04:00-04:30' 'the promoted instance holds the declared PreferredBackupWindow (go-to-k/cdkd#5640)' 'phase 2e'
assert_instance_field '.DBInstanceStatus' 'available' 'the deploy waited for the promotion' 'phase 2e'
assert_replica "${REPLICA_KEPT_ID}" 'mon:06:00-mon:06:30' 'phase 2e'
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROMOTED_ROUTE=$(replica_record_field ReadReplicaPromoted '.value.provisionedBy // "sdk"')
if [ "${PROMOTED_ROUTE}" != "sdk" ]; then
  echo "FAIL: phase 2e: ReadReplicaPromoted routed via '${PROMOTED_ROUTE}', expected sdk (go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK: phase 2e: ReadReplicaPromoted is standalone, in place, on the SDK route"

# --- Phase 2f: ReadReplicaKept onto Cloud Control (go-to-k/cdkd#6047) ----------
# Every replica deployed before #5640 routed through Cloud Control and stays
# there (sticky provisionedBy). The recreate deletes the SDK copy and creates a
# Cloud Control one, the only replica created in this deploy: two replicas of
# one source created together trip InvalidDBInstanceStateFault on that route.
echo "==> Phase 2f: recreate ReadReplicaKept via Cloud Control (--recreate-via-cc-api; go-to-k/cdkd#6047)"
REPLICA_KEPT_SDK_ID="${REPLICA_KEPT_ID}"
CDKD_TEST_UPDATE=true CDKD_TEST_PARAM_GROUP=b CDKD_TEST_LOGS_REMOVED=true CDKD_TEST_REPLICA=promote node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api ReadReplicaKept \
  --force-stateful-recreation \
  --yes
STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
KEPT_ROUTE=$(replica_record_field ReadReplicaKept '.value.provisionedBy // "sdk"')
if [ "${KEPT_ROUTE}" != "cc-api" ]; then
  echo "FAIL: phase 2f: premise: after --recreate-via-cc-api ReadReplicaKept is routed via '${KEPT_ROUTE}', expected cc-api (go-to-k/cdkd#6047)" >&2
  exit 1
fi
KEPT_POLICY=$(replica_record_field ReadReplicaKept '.value.deletionPolicy // "absent"')
if [ "${KEPT_POLICY}" != "absent" ] && [ "${KEPT_POLICY}" != "Snapshot" ]; then
  echo "FAIL: phase 2f: premise: ReadReplicaKept records DeletionPolicy '${KEPT_POLICY}', expected none or Snapshot (whose delete the arm needs; go-to-k/cdkd#6047)" >&2
  exit 1
fi
REPLICA_KEPT_ID=$(replica_record_field ReadReplicaKept '.value.physicalId')
assert_replica "${REPLICA_KEPT_ID}" 'mon:06:00-mon:06:30' 'phase 2f'
assert_gone "phase 2f: the recreate left the SDK copy ${REPLICA_KEPT_SDK_ID} of ReadReplicaKept alive" \
  aws rds describe-db-instances --db-instance-identifier "${REPLICA_KEPT_SDK_ID}" --region "${REGION}"
echo "    OK: phase 2f: ReadReplicaKept is a Cloud Control-routed replica (${REPLICA_KEPT_ID}), DeletionPolicy ${KEPT_POLICY} (default Snapshot)"

# --- Phase 3: destroy -------------------------------------------------
# --remove-protection: DeletionProtection is retained on removal (#5004), so
# the destroy has to flip it off. go-to-k/cdkd#6047: the Cloud Control-routed
# ReadReplicaKept is under a Snapshot policy, which a cdkd before #6047
# refused on that route, failing the destroy.
echo "==> Phase 3: destroy --remove-protection (protection was kept, #5004)"
DESTROY_OUT=$(mktemp)
set +e
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --remove-protection \
  --force 2>&1 | tee "${DESTROY_OUT}"
DESTROY_RC=${PIPESTATUS[0]}
set -e
if [ "${DESTROY_RC}" != "0" ]; then
  if grep -qE 'ReadReplicaKept.*has DeletionPolicy: Snapshot, but the resource is managed via the Cloud Control API route' "${DESTROY_OUT}"; then
    echo "FAIL: phase 3: the destroy refused the Cloud Control-routed read replica ReadReplicaKept under DeletionPolicy: Snapshot, which CloudFormation deletes without a snapshot (go-to-k/cdkd#6047; rc=${DESTROY_RC})" >&2
  else
    echo "FAIL: phase 3: destroy exited ${DESTROY_RC}" >&2
  fi
  rm -f "${DESTROY_OUT}"
  exit 1
fi
rm -f "${DESTROY_OUT}"
echo "    OK: phase 3: the destroy deleted the Cloud Control-routed read replica under a Snapshot policy (go-to-k/cdkd#6047)"

# RDS DeleteDBInstance is async: the instance lingers in 'deleting' for
# a few minutes before describe returns DBInstanceNotFoundFault. cdkd's
# delete path waits for the terminal NotFound, but the post-delete S3
# state cleanup is the verifiable signal here.
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Spot-check the DBInstance is also gone or in 'deleting'.
if gone_probe aws rds describe-db-instances --db-instance-identifier "${DB_INSTANCE_ID}" --region "${REGION}"; then
  INSTANCE_STATUS="gone"
elif ! INSTANCE_STATUS=$(aws rds describe-db-instances \
    --db-instance-identifier "${DB_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1); then
  # TOCTOU: the instance can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${INSTANCE_STATUS}" \
    && INSTANCE_STATUS="gone" \
    || { echo "FAIL: describe-db-instances requery undetermined: ${INSTANCE_STATUS}" >&2; exit 1; }
fi
if [ "${INSTANCE_STATUS}" = "gone" ] || [ "${INSTANCE_STATUS}" = "deleting" ]; then
  echo "    OK: DBInstance is gone or deleting (status: ${INSTANCE_STATUS})"
else
  echo "FAIL: DBInstance still in unexpected state after destroy: ${INSTANCE_STATUS}" >&2
  exit 1
fi

# Issue #4030: with no DeletionPolicy, CloudFormation's default for a
# standalone instance is Snapshot, so the destroy took exactly one final
# snapshot named `<instance id>-final-<UTC timestamp>`. Before the fix it
# took none. Cleanup deletes it.
if ! FINAL_SNAPSHOTS=$(this_run_instance_snapshots "${DB_INSTANCE_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${DB_INSTANCE_ID}" >&2
  exit 1
fi
FINAL_COUNT=$(printf '%s\n' "${FINAL_SNAPSHOTS}" | grep -c -- "^${DB_INSTANCE_ID}-final-[0-9]\{8\}-[0-9]\{6\}$" || true)
OTHER_SNAPSHOTS=$(printf '%s\n' "${FINAL_SNAPSHOTS}" | grep -v -- "^${DB_INSTANCE_ID}-final-" | grep -v '^$' || true)
if [ "${FINAL_COUNT}" != "1" ] || [ -n "${OTHER_SNAPSHOTS}" ]; then
  echo "FAIL: destroying the policy-less ${DB_INSTANCE_ID} took ${FINAL_COUNT} cdkd final snapshot(s), expected 1 (CloudFormation's default DeletionPolicy is Snapshot; issue #4030); this run's snapshots: $(printf '%s ' ${FINAL_SNAPSHOTS})" >&2
  exit 1
fi
echo "    OK: destroy took the final snapshot $(printf '%s' "${FINAL_SNAPSHOTS}") (issue #4030; cleanup deletes it)"

# go-to-k/cdkd#5640: both replicas are gone. ReadReplicaKept, still a replica,
# was deleted without a final snapshot (RDS refuses one on a replica, and
# CloudFormation ignores a replica's DeletionPolicy), by Cloud Control since
# phase 2f (go-to-k/cdkd#6047), as was its SDK copy by the recreate;
# ReadReplicaPromoted, standalone by then, took one, as the policy-less
# instance did.
for replica_id in "${REPLICA_KEPT_ID}" "${REPLICA_PROMOTED_ID}" "${REPLICA_SOURCE_ID}" "${REPLICA_XR_ID}"; do
  if gone_probe aws rds describe-db-instances --db-instance-identifier "${replica_id}" --region "${REGION}"; then
    REPLICA_STATUS="gone"
  elif ! REPLICA_STATUS=$(aws rds describe-db-instances \
      --db-instance-identifier "${replica_id}" \
      --region "${REGION}" \
      --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1); then
    # TOCTOU: the replica can vanish between gone_probe and this requery.
    grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${REPLICA_STATUS}" \
      && REPLICA_STATUS="gone" \
      || { echo "FAIL: describe-db-instances requery undetermined: ${REPLICA_STATUS}" >&2; exit 1; }
  fi
  if [ "${REPLICA_STATUS}" != "gone" ] && [ "${REPLICA_STATUS}" != "deleting" ]; then
    echo "FAIL: replica ${replica_id} still in unexpected state after destroy: ${REPLICA_STATUS}" >&2
    exit 1
  fi
done
for kept_id in "${REPLICA_KEPT_ID}" "${REPLICA_KEPT_SDK_ID}" "${REPLICA_XR_ID}"; do
  if ! KEPT_SNAPSHOTS=$(this_run_instance_snapshots "${kept_id}"); then
    echo "FAIL: could not list the manual snapshots of ${kept_id}" >&2
    exit 1
  fi
  if [ -n "${KEPT_SNAPSHOTS}" ]; then
    echo "FAIL: deleting the read replica ${kept_id} took snapshot(s) $(printf '%s ' ${KEPT_SNAPSHOTS}), expected none (go-to-k/cdkd#5640, go-to-k/cdkd#6047)" >&2
    exit 1
  fi
done
if ! PROMOTED_SNAPSHOTS=$(this_run_instance_snapshots "${REPLICA_PROMOTED_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${REPLICA_PROMOTED_ID}" >&2
  exit 1
fi
PROMOTED_FINAL=$(printf '%s\n' "${PROMOTED_SNAPSHOTS}" | grep -c -- "^${REPLICA_PROMOTED_ID}-final-[0-9]\{8\}-[0-9]\{6\}$" || true)
if [ "${PROMOTED_FINAL}" != "1" ]; then
  echo "FAIL: destroying the promoted ${REPLICA_PROMOTED_ID} took ${PROMOTED_FINAL} final snapshot(s), expected 1 (a standalone instance's default DeletionPolicy is Snapshot; go-to-k/cdkd#5640)" >&2
  exit 1
fi
if ! SOURCE_SNAPSHOTS=$(this_run_instance_snapshots "${REPLICA_SOURCE_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${REPLICA_SOURCE_ID}" >&2
  exit 1
fi
if [ -n "${SOURCE_SNAPSHOTS}" ]; then
  echo "FAIL: destroying the RemovalPolicy.DESTROY replica source ${REPLICA_SOURCE_ID} took snapshot(s) $(printf '%s ' ${SOURCE_SNAPSHOTS}), expected none (go-to-k/cdkd#5640)" >&2
  exit 1
fi
echo "    OK: both replicas and their source are gone; the replica and the DESTROY source took no final snapshot, the promoted instance one (go-to-k/cdkd#5640; cleanup deletes it)"

# go-to-k/cdkd#5640 (SourceRegion): the cross-region replica went with the
# stack above (no snapshot, asserted with the others); now its source's stack.
echo "==> Phase 3: destroy ${XR_STACK} in ${XR_REGION} (the cross-region replica's source; go-to-k/cdkd#5640)"
node "${LOCAL_DIST}" destroy "${XR_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${XR_REGION}" \
  --force
assert_gone "state file s3://${STATE_BUCKET}/${XR_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${XR_STATE_KEY}"
if gone_probe aws rds describe-db-instances --db-instance-identifier "${XR_SOURCE_ID}" --region "${XR_REGION}"; then
  XR_SOURCE_STATUS="gone"
elif ! XR_SOURCE_STATUS=$(aws rds describe-db-instances \
    --db-instance-identifier "${XR_SOURCE_ID}" \
    --region "${XR_REGION}" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1); then
  # TOCTOU: the source can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${XR_SOURCE_STATUS}" \
    && XR_SOURCE_STATUS="gone" \
    || { echo "FAIL: describe-db-instances requery undetermined: ${XR_SOURCE_STATUS}" >&2; exit 1; }
fi
if [ "${XR_SOURCE_STATUS}" != "gone" ] && [ "${XR_SOURCE_STATUS}" != "deleting" ]; then
  echo "FAIL: the cross-region source ${XR_SOURCE_ID} still in unexpected state after destroy: ${XR_SOURCE_STATUS}" >&2
  exit 1
fi
echo "    OK: phase 3: the cross-region source ${XR_SOURCE_ID} is ${XR_SOURCE_STATUS} (go-to-k/cdkd#5640)"

# go-to-k/cdkd#2762: the destroy deleted both custom parameter groups.
assert_gone "DB parameter group ${PG_A_ID} still exists after destroy" aws rds describe-db-parameter-groups --db-parameter-group-name "${PG_A_ID}" --region "${REGION}"
assert_gone "DB parameter group ${PG_B_ID} still exists after destroy" aws rds describe-db-parameter-groups --db-parameter-group-name "${PG_B_ID}" --region "${REGION}"
echo "    OK: both DB parameter groups are gone"

# go-to-k/cdkd#5640: the sweep runs LAST, after cleanup's own snapshot and log
# group deletes (run here, then disarmed): a later `aws s3 rm` would write a
# delete marker the assertion below never sees.
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "rds-dbinstance-backfill state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${XR_STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${XR_STATE_PREFIX}" "rds-dbinstance-backfill cross-region source state teardown"

echo ""
echo "=== PASS: RDS::DBInstance #609 backfill integ (base + folded-in security props) + #5004 removal-keeps-value + #5640 read replicas (a cross-region one included) + #6047 Cloud Control replica destroy ==="
