#!/usr/bin/env bash
# verify.sh - cdkd rds-full-stack integ test.
#
# Stresses a realistic single-instance RDS deployment and the consumption of
# the DBInstance's COMPUTED endpoint address via Fn::GetAtt:
#
#   VPC (natGateways:0, isolated subnets)
#     + explicit DBSubnetGroup
#     + explicit DBParameterGroup (with a non-default `application_name`)
#     + explicit SecurityGroup
#     + L2 rds.DatabaseInstance (db.t3.micro, single-AZ, deletionProtection
#       false, RemovalPolicy DESTROY, CDK-managed Secrets Manager creds)
#     + SSM StringParameter whose value is
#       Fn::GetAtt(<Database>, Endpoint.Address)
#     + SSM StringParameter whose value is
#       Fn::GetAtt(<DbSubnetGroup>, DBSubnetGroupArn)   (issue 1824)
#
# What this proves (the angle the two existing RDS fixtures do NOT cover):
#   1. ORDERING: cdkd creates the SubnetGroup + ParameterGroup + SG before the
#      instance (Ref edges), and the SSM Parameter only AFTER the instance is
#      available (the parameter Refs the instance's computed endpoint).
#   2. SLOW-CREATE PROPAGATION: the DBInstance takes ~5-10 min to become
#      available; cdkd must wait for it and read back the endpoint attribute.
#   3. GETATT OF A COMPUTED ATTRIBUTE: the SSM parameter value must equal the
#      LIVE DescribeDBInstances endpoint address. If cdkd resolved the GetAtt
#      before the instance was available (empty endpoint) or parallelized the
#      parameter against the instance, the value would be empty / wrong.
#   4. The instance uses OUR explicit DBSubnetGroup + DBParameterGroup (not the
#      engine defaults).
#   5. GETATT OF A CREATE-RESPONSE ARN (issue 1824): the second SSM parameter's
#      value must equal the live describe-db-subnet-groups DBSubnetGroupArn,
#      byte for byte. `RDSProvider` reads that ARN off the CreateDBSubnetGroup
#      RESPONSE — a wire assumption every unit test hand-feeds to a mock, so
#      only a real-AWS comparison can catch a wrong one. Pre-fix, this
#      reference did not resolve wrongly: it HARD-FAILED the deploy on the
#      resolver's *Arn shape guard (a subnet group's physicalId is its NAME).
#   7. NO SNAPSHOT ON A REPLACEMENT (issue 4029): phase 1b renames the
#      Cloud Control-routed instance (DBInstanceIdentifier is create-only), so
#      cdkd replaces it and deletes the old one under UpdateReplacePolicy:
#      Delete. Before the fix that delete went through the Cloud Control
#      handler, which took an untagged snapshot of the old instance.
#   6. NO FINAL SNAPSHOT (issue 3993): the DBInstance is routed via Cloud
#      Control (asserted), whose registry delete handler took an untagged
#      `rds-snapshot-<random>` on every delete despite DeletionPolicy: Delete.
#      The run fails if any manual snapshot of the instance was created after
#      it began; cleanup deletes any such snapshot either way.
#
# This integ is SLOW by RDS nature (~5-10 min create, a few min delete) -
# that is acceptable and expected.
#
# Resource identification: the explicit DBSubnetGroup / DBParameterGroup are
# CDK-auto-named (no physical name set), so they are resolved from cdkd state
# after deploy. The SSM parameter has an explicit name. RDS DBInstance/group
# tagging is not relied on; cdkd:integ-fixture tag is added where cheap.
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

STACK="CdkdRdsFullStackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

SSM_PARAM_NAME="/cdkd/rds-full-stack/db-endpoint"
# Issue 1824: the second consumer, whose value is
# Fn::GetAtt(<DbSubnetGroup>, DBSubnetGroupArn).
SSM_SUBNET_ARN_PARAM_NAME="/cdkd/rds-full-stack/db-subnet-group-arn"
EXPECTED_APP_NAME="cdkd-rds-full-stack"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Physical ids resolved from cdkd state after deploy; used by the trap so a
# partial-failure run still cleans up in the RDS-safe order.
DB_INSTANCE_ID=""
DB_SUBNET_GROUP=""
DB_PARAM_GROUP=""
# Issue 3993: when this run began (UTC, second precision, the prefix AWS's
# SnapshotCreateTime is compared on).
RUN_START=""
# Issue 4029: the replacement instance's fixed name (lib/ sets it only under
# CDKD_TEST_UPDATE=true). Cleanup deletes it by name, since a run can abort
# after phase 1b created it.
NEW_INSTANCE_ID="cdkd-rds-full-stack-replaced"

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
  echo "==> Cleanup: dropping any leftover state + AWS RDS resources"
  # Do NOT silence stderr on `state destroy` - a partial-failure (e.g. a VPC
  # dependency still 'deleting' from an in-flight DBInstance) silently leaves
  # orphan resources otherwise. The redundant per-resource deletes below ARE
  # allowed to be silent: they are best-effort (state destroy already handled
  # them on the happy path) and the `s3 rm` calls are expected to NotFound
  # after a successful state destroy.
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
  fi

  # RDS teardown ORDER is load-bearing: the instance must be deleted (and gone)
  # BEFORE its DBSubnetGroup / DBParameterGroup can be deleted, and the SG /
  # VPC can only go after the instance releases its ENIs. So: delete the
  # instance first + wait for it to disappear, then the groups.
  # The phase-1b replacement first: it holds the same subnet / parameter
  # groups. Deleting an absent one is absorbed.
  aws rds delete-db-instance \
    --db-instance-identifier "${NEW_INSTANCE_ID}" \
    --region "${REGION}" \
    --skip-final-snapshot \
    --delete-automated-backups >/dev/null 2>&1
  aws rds wait db-instance-deleted \
    --db-instance-identifier "${NEW_INSTANCE_ID}" \
    --region "${REGION}" >/dev/null 2>&1
  if [ -n "${DB_INSTANCE_ID}" ]; then
    aws rds delete-db-instance \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --delete-automated-backups >/dev/null 2>&1
    # Best-effort wait (bounded by the waiter's own default ~30min cap) so the
    # subnet/param group deletes below do not fail with InvalidDBSubnetGroup
    # StateFault / still-in-use. Ignored if the instance is already gone.
    aws rds wait db-instance-deleted \
      --db-instance-identifier "${DB_INSTANCE_ID}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${DB_SUBNET_GROUP}" ]; then
    aws rds delete-db-subnet-group \
      --db-subnet-group-name "${DB_SUBNET_GROUP}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${DB_PARAM_GROUP}" ]; then
    aws rds delete-db-parameter-group \
      --db-parameter-group-name "${DB_PARAM_GROUP}" \
      --region "${REGION}" >/dev/null 2>&1
  fi
  # Issue 3993: a manual snapshot of the instance this run created (the leak,
  # or the reverted-fix proof). Older ones are not this run's to delete.
  if [ -n "${DB_INSTANCE_ID}" ] && [ -n "${RUN_START}" ]; then
    for id in "${DB_INSTANCE_ID}" "${NEW_INSTANCE_ID}"; do
      if ! SNAPS_TO_CLEAN=$(this_run_instance_snapshots "${id}"); then
        echo "    WARN: cleanup could not list the manual snapshots of ${id}; check for a leftover rds-snapshot-* by hand" >&2
        SNAPS_TO_CLEAN=""
      fi
      for snap in ${SNAPS_TO_CLEAN}; do
        aws rds wait db-snapshot-available --db-snapshot-identifier "${snap}" --region "${REGION}"
        aws rds delete-db-snapshot --db-snapshot-identifier "${snap}" --region "${REGION}" >/dev/null \
          && echo "    cleanup: deleted this run's manual snapshot ${snap}"
      done
    done
  fi
  # The SSM parameters have deterministic names - clean them directly.
  aws ssm delete-parameter \
    --name "${SSM_PARAM_NAME}" \
    --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter \
    --name "${SSM_SUBNET_ARN_PARAM_NAME}" \
    --region "${REGION}" >/dev/null 2>&1

  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
RUN_START=$(date -u +%Y-%m-%dT%H:%M:%S)
echo "==> Phase 1: deploy with the local binary (RDS create is ~5-10 min - be patient; run start ${RUN_START}Z)"
if ! node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes; then
  echo "FAIL: deploy failed for ${STACK}" >&2
  # On a deploy failure, dump the state (if any) so the failing resource +
  # error is visible for triage.
  echo "--- cdkd state (if any) for triage ---" >&2
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq '.' >&2 || echo "(no state file)" >&2
  exit 1
fi

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve physical ids from state (for assertions AND the trap).
DB_INSTANCE_ID=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.physicalId] | first // ""')
DB_SUBNET_GROUP=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBSubnetGroup") | .value.physicalId] | first // ""')
DB_PARAM_GROUP=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBParameterGroup") | .value.physicalId] | first // ""')

if [ -z "${DB_INSTANCE_ID}" ] || [ "${DB_INSTANCE_ID}" = "null" ]; then
  echo "FAIL: could not resolve RDS DBInstance identifier from state" >&2
  echo "${STATE}" | jq '[.resources | to_entries[] | {key, type: .value.resourceType, physicalId: .value.physicalId}]' >&2
  exit 1
fi
if [ -z "${DB_SUBNET_GROUP}" ] || [ "${DB_SUBNET_GROUP}" = "null" ]; then
  echo "FAIL: could not resolve DBSubnetGroup name from state" >&2
  exit 1
fi
if [ -z "${DB_PARAM_GROUP}" ] || [ "${DB_PARAM_GROUP}" = "null" ]; then
  echo "FAIL: could not resolve DBParameterGroup name from state" >&2
  exit 1
fi
echo "    resolved DBInstance:      ${DB_INSTANCE_ID}"
echo "    resolved DBSubnetGroup:   ${DB_SUBNET_GROUP}"
echo "    resolved DBParameterGroup: ${DB_PARAM_GROUP}"

# Issue 3993 premise: the DBInstance must be Cloud Control-routed, or the
# no-snapshot assertion after the destroy tests the SDK path it always passed.
DB_INSTANCE_PROVISIONED_BY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.provisionedBy // "sdk"] | first // ""')
if [ "${DB_INSTANCE_PROVISIONED_BY}" != "cc-api" ]; then
  echo "FAIL: issue 3993 premise: the DBInstance is routed via '${DB_INSTANCE_PROVISIONED_BY}', expected 'cc-api'" >&2
  exit 1
fi
echo "    OK: DBInstance is provisionedBy=cc-api (issue 3993 premise)"
# Without --skip-final-snapshot the fix applies to a RECORDED
# `DeletionPolicy: Delete` only; an absent one is CloudFormation's `Snapshot`
# default, which the Cloud Control route refuses (#4030).
DB_INSTANCE_DELETION_POLICY=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.deletionPolicy // "absent"] | first // ""')
if [ "${DB_INSTANCE_DELETION_POLICY}" != "Delete" ]; then
  echo "FAIL: issue 3993 premise: the DBInstance records DeletionPolicy '${DB_INSTANCE_DELETION_POLICY}', expected 'Delete'" >&2
  exit 1
fi

# --- Assertion 1: the instance exists + uses our groups ---------------
INSTANCE=$(aws rds describe-db-instances \
  --db-instance-identifier "${DB_INSTANCE_ID}" \
  --region "${REGION}" \
  --query 'DBInstances[0]' --output json 2>/dev/null)
if [ -z "${INSTANCE}" ] || [ "${INSTANCE}" = "null" ]; then
  echo "FAIL: DescribeDBInstances returned empty for ${DB_INSTANCE_ID}" >&2
  exit 1
fi

# The instance must reference OUR explicit DBSubnetGroup (not a default).
ACTUAL_SUBNET_GROUP=$(echo "${INSTANCE}" | jq -r '.DBSubnetGroup.DBSubnetGroupName // "null"')
if [ "${ACTUAL_SUBNET_GROUP}" != "${DB_SUBNET_GROUP}" ]; then
  echo "FAIL: DBInstance subnet group is '${ACTUAL_SUBNET_GROUP}', expected '${DB_SUBNET_GROUP}' (custom subnet group not applied)" >&2
  exit 1
fi
echo "    OK: DBInstance uses the custom DBSubnetGroup (${ACTUAL_SUBNET_GROUP})"

# The instance must reference OUR explicit DBParameterGroup. AWS surfaces the
# group(s) under DBParameterGroups[].DBParameterGroupName.
ACTUAL_PARAM_GROUP=$(echo "${INSTANCE}" | jq -r '[.DBParameterGroups[]?.DBParameterGroupName] | index("'"${DB_PARAM_GROUP}"'") // "missing"')
if [ "${ACTUAL_PARAM_GROUP}" = "missing" ] || [ "${ACTUAL_PARAM_GROUP}" = "null" ]; then
  echo "FAIL: DBInstance is not using the custom DBParameterGroup '${DB_PARAM_GROUP}'" >&2
  echo "${INSTANCE}" | jq '.DBParameterGroups' >&2
  exit 1
fi
echo "    OK: DBInstance uses the custom DBParameterGroup (${DB_PARAM_GROUP})"

# Belt-and-suspenders: the custom parameter group carries our non-default
# `application_name` value (proves the explicit group was created with our
# parameters, not just attached by name).
ACTUAL_APP_NAME=$(aws rds describe-db-parameters \
  --db-parameter-group-name "${DB_PARAM_GROUP}" \
  --region "${REGION}" \
  --query "Parameters[?ParameterName=='application_name'].ParameterValue | [0]" \
  --output json 2>/dev/null | jq -r '. // "null"')
if [ "${ACTUAL_APP_NAME}" != "${EXPECTED_APP_NAME}" ]; then
  echo "FAIL: DBParameterGroup application_name is '${ACTUAL_APP_NAME}', expected '${EXPECTED_APP_NAME}'" >&2
  exit 1
fi
echo "    OK: DBParameterGroup application_name == ${EXPECTED_APP_NAME}"

# --- Assertion 2: the computed endpoint resolved into the SSM param ---
# This is the load-bearing assertion: the SSM parameter value must equal the
# LIVE DescribeDBInstances endpoint address. Proves Fn::GetAtt of the computed
# Endpoint.Address resolved post-create.
LIVE_ENDPOINT=$(echo "${INSTANCE}" | jq -r '.Endpoint.Address // "null"')
if [ "${LIVE_ENDPOINT}" = "null" ] || [ -z "${LIVE_ENDPOINT}" ]; then
  echo "FAIL: DescribeDBInstances returned no Endpoint.Address for ${DB_INSTANCE_ID}" >&2
  exit 1
fi
echo "    live DBInstance endpoint: ${LIVE_ENDPOINT}"

SSM_VALUE=$(aws ssm get-parameter \
  --name "${SSM_PARAM_NAME}" \
  --region "${REGION}" \
  --query 'Parameter.Value' --output text)
if [ -z "${SSM_VALUE}" ]; then
  echo "FAIL: SSM parameter ${SSM_PARAM_NAME} not found or empty after deploy" >&2
  exit 1
fi
if [ "${SSM_VALUE}" != "${LIVE_ENDPOINT}" ]; then
  echo "FAIL: SSM parameter value '${SSM_VALUE}' != live DB endpoint '${LIVE_ENDPOINT}'" >&2
  echo "       (Fn::GetAtt(<DBInstance>, Endpoint.Address) did NOT resolve to the computed endpoint)" >&2
  exit 1
fi
echo "    OK: SSM parameter value == live DB endpoint (computed Fn::GetAtt resolved post-create)"

# --- Assertion 3 (issue 1824): DBSubnetGroupArn resolved into the SSM param ---
# `RDSProvider.create` reads `DBSubnetGroupArn` off the `CreateDBSubnetGroup`
# RESPONSE. That is a wire ASSUMPTION, and every unit test hand-feeds the field to
# a mock, so a green mocked suite would agree with a wrong assumption. Comparing
# the resolved parameter value against `describe-db-subnet-groups` is what settles
# it against real AWS. Before the fix this reference did not resolve wrongly — the
# deploy HARD-FAILED on the resolver's `*Arn` shape guard, since a subnet group's
# physicalId is its NAME.
LIVE_SUBNET_GROUP_ARN=$(aws rds describe-db-subnet-groups \
  --db-subnet-group-name "${DB_SUBNET_GROUP}" \
  --region "${REGION}" \
  --query 'DBSubnetGroups[0].DBSubnetGroupArn' --output text)
case "${LIVE_SUBNET_GROUP_ARN}" in
  arn:*:rds:*:subgrp:*) ;;
  *)
    echo "FAIL: describe-db-subnet-groups reported no usable DBSubnetGroupArn for ${DB_SUBNET_GROUP}: '${LIVE_SUBNET_GROUP_ARN}'" >&2
    exit 1
    ;;
esac
echo "    live DBSubnetGroup ARN:   ${LIVE_SUBNET_GROUP_ARN}"

SSM_SUBNET_ARN_VALUE=$(aws ssm get-parameter \
  --name "${SSM_SUBNET_ARN_PARAM_NAME}" \
  --region "${REGION}" \
  --query 'Parameter.Value' --output text)
# BYTE FOR BYTE: a wrong partition, a case-folded region or a value read off the
# wrong response field all show up here and nowhere else.
if [ "${SSM_SUBNET_ARN_VALUE}" != "${LIVE_SUBNET_GROUP_ARN}" ]; then
  echo "FAIL: SSM parameter value '${SSM_SUBNET_ARN_VALUE}' != live DBSubnetGroupArn '${LIVE_SUBNET_GROUP_ARN}'" >&2
  echo "       (Fn::GetAtt(<DbSubnetGroup>, DBSubnetGroupArn) did NOT resolve to the ARN AWS holds)" >&2
  exit 1
fi
echo "    OK: SSM parameter value == live DBSubnetGroupArn (issue 1824 GetAtt resolved from the create response)"

# --- Phase 1b: replacement (issue 4029) --------------------------------
# Renaming the instance forces a replacement; the OLD instance is deleted
# under UpdateReplacePolicy: Delete. --force-stateful-recreation
# is the consent cdkd requires to replace a stateful type.
echo "==> Phase 1b: rename the DBInstance (replacement, issue 4029)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force-stateful-recreation \
  --yes

STATE_1B=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
REPLACED_ID=$(echo "${STATE_1B}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.physicalId] | first // ""')
if [ "${REPLACED_ID}" != "${NEW_INSTANCE_ID}" ]; then
  echo "FAIL: issue 4029 premise: after phase 1b the DBInstance is '${REPLACED_ID}', expected '${NEW_INSTANCE_ID}' (no replacement happened)" >&2
  exit 1
fi
REPLACED_BY=$(echo "${STATE_1B}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBInstance") | .value.provisionedBy // "sdk"] | first // ""')
if [ "${REPLACED_BY}" != "cc-api" ]; then
  echo "FAIL: issue 4029 premise: the replacement is routed via '${REPLACED_BY}', expected 'cc-api'" >&2
  exit 1
fi
assert_gone "the replaced instance ${DB_INSTANCE_ID} still exists after phase 1b" aws rds describe-db-instances --db-instance-identifier "${DB_INSTANCE_ID}" --region "${REGION}"
if ! REPLACED_SNAPSHOTS=$(this_run_instance_snapshots "${DB_INSTANCE_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${DB_INSTANCE_ID}" >&2
  exit 1
fi
if [ -n "${REPLACED_SNAPSHOTS}" ]; then
  echo "FAIL: replacing the Cloud Control-routed ${DB_INSTANCE_ID} (UpdateReplacePolicy: Delete) left manual snapshot(s): $(printf '%s ' ${REPLACED_SNAPSHOTS})(issue 4029)" >&2
  exit 1
fi
echo "    OK: ${DB_INSTANCE_ID} replaced by ${NEW_INSTANCE_ID} with no manual snapshot (issue 4029)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy (RDS delete is slow - allow a few minutes)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# State file must be gone after a clean destroy.
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# The destroy deletes the phase-1b replacement (phase 1b already asserted the
# original gone). It must be gone or in 'deleting'. RDS Delete* is async;
# cdkd's delete path waits for the terminal NotFound, so a clean destroy
# leaves it gone.
if gone_probe aws rds describe-db-instances --db-instance-identifier "${NEW_INSTANCE_ID}" --region "${REGION}"; then
  INSTANCE_STATUS="gone"
elif ! INSTANCE_STATUS=$(aws rds describe-db-instances \
    --db-instance-identifier "${NEW_INSTANCE_ID}" \
    --region "${REGION}" \
    --query 'DBInstances[0].DBInstanceStatus' --output text 2>&1); then
  # TOCTOU: the instance can vanish between gone_probe and this requery.
  printf '%s' "${INSTANCE_STATUS}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && INSTANCE_STATUS="gone" \
    || { echo "FAIL: describe-db-instances requery undetermined: ${INSTANCE_STATUS}" >&2; exit 1; }
fi
if [ "${INSTANCE_STATUS}" = "gone" ] || [ "${INSTANCE_STATUS}" = "deleting" ]; then
  echo "    OK: DBInstance is gone or deleting (status: ${INSTANCE_STATUS})"
else
  echo "FAIL: DBInstance still in unexpected state after destroy: ${INSTANCE_STATUS}" >&2
  exit 1
fi

# DBSubnetGroup must be gone.
assert_gone "DBSubnetGroup ${DB_SUBNET_GROUP} still exists after destroy" aws rds describe-db-subnet-groups --db-subnet-group-name "${DB_SUBNET_GROUP}" --region "${REGION}"
echo "    OK: DBSubnetGroup is gone"

# DBParameterGroup must be gone.
assert_gone "DBParameterGroup ${DB_PARAM_GROUP} still exists after destroy" aws rds describe-db-parameter-groups --db-parameter-group-name "${DB_PARAM_GROUP}" --region "${REGION}"
echo "    OK: DBParameterGroup is gone"

# SSM parameter must be gone.
assert_gone "SSM parameter ${SSM_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_PARAM_NAME}" --region "${REGION}"
echo "    OK: SSM parameter is gone"

# The issue-1824 DBSubnetGroupArn consumer must be gone too.
assert_gone "SSM parameter ${SSM_SUBNET_ARN_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${SSM_SUBNET_ARN_PARAM_NAME}" --region "${REGION}"
echo "    OK: SSM DBSubnetGroupArn parameter is gone"

# Issue 3993: before the fix the Cloud Control delete handler left a manual
# final snapshot of the destroyed instance (the phase-1b replacement) here.
if ! LEAKED_SNAPSHOTS=$(this_run_instance_snapshots "${NEW_INSTANCE_ID}"); then
  echo "FAIL: could not list the manual snapshots of ${NEW_INSTANCE_ID}" >&2
  exit 1
fi
if [ -n "${LEAKED_SNAPSHOTS}" ]; then
  echo "FAIL: destroying the Cloud Control-routed ${NEW_INSTANCE_ID} (DeletionPolicy: Delete) left manual snapshot(s): $(printf '%s ' ${LEAKED_SNAPSHOTS})(issue 3993)" >&2
  exit 1
fi
echo "    OK: no manual snapshot of ${NEW_INSTANCE_ID} since ${RUN_START}Z (issue 3993)"

echo ""
echo "[verify] PASS"
echo "=== PASS: rds-full-stack integ (custom subnet/param groups + GetAtt computed endpoint) ==="
