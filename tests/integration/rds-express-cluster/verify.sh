#!/usr/bin/env bash
# verify.sh — cdkd RDS DBCluster WithExpressConfiguration on the SDK route
# (go-to-k/cdkd#5984).
#
# RDS creates the writer `<clusterId>-instance-1` itself. cdkd waits for it,
# records its DbiResourceId under the `cdkd:ExpressWriterResourceId` attribute
# of the cluster's state record, and deletes it before the cluster.
#
# Phases:
#   1. deploy: the record is provisionedBy=sdk, the writer is `available`, the
#      recorded writer resource id equals the live DbiResourceId, and the stack
#      output endpoint equals the live cluster endpoint.
#   2. UPDATE (CDKD_TEST_UPDATE=true): BackupRetentionPeriod 1 -> 7 live, and the
#      record still carries the same writer resource id.
#   3. refusal: with an out-of-band instance in the cluster, `cdkd destroy`
#      exits 2 with "besides the writer express configuration created" and
#      deletes NOTHING (the writer is not `deleting`, the cluster and the state
#      record remain). The instance is then deleted.
#   4. destroy: rc 0; the writer, the cluster and the state file are gone and no
#      manual cluster snapshot was left (RemovalPolicy.DESTROY = Delete).
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

STACK="CdkdRdsExpressClusterExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Tagged onto the cluster, so cleanup finds this run's cluster even when no
# state record names it (an aborted create).
export CDKD_TEST_RUN_ID="rds-express-$(date +%s)-$$"
DESTROY_LOG="${TMPDIR:-/tmp}/cdkd-5984-express-destroy.$$.log"
# Resolved from the state record after phase 1.
CLUSTER_ID=""
WRITER_ID=""
OOB_ID=""

# Delete one instance by id and wait until it is gone; a subshell under
# `set +eu` so a `set +eu` caller is never re-armed.
delete_instance() { # usage: delete_instance <instance id>
  (
    set +eu
    aws rds wait db-instance-available --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
    aws rds delete-db-instance --db-instance-identifier "$1" --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1
    aws rds wait db-instance-deleted --db-instance-identifier "$1" --region "${REGION}" >/dev/null 2>&1
  )
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DESTROY_LOG}"
  # The cluster a leftover state record names (the pre-run pass has no id yet).
  if [ -z "${CLUSTER_ID}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    CLUSTER_ID=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" 2>/dev/null |
      jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::RDS::DBCluster") | .value.physicalId // empty] | first // ""')
  fi
  # The cluster this run created but never recorded, found by the run-id tag.
  # The scope guard dominates the sweep: an empty run id would widen the filter.
  TAGGED_IDS=""
  case "${CDKD_TEST_RUN_ID:-}" in
    rds-express-?*)
      TAGGED_IDS=$(aws rds describe-db-clusters --region "${REGION}" \
        --query "DBClusters[?TagList[?Key=='cdkd-integ-run' && Value=='${CDKD_TEST_RUN_ID}']].DBClusterIdentifier" \
        --output text 2>/dev/null)
      ;;
    *)
      echo "WARN: teardown sweep refused: CDKD_TEST_RUN_ID is '${CDKD_TEST_RUN_ID:-}'" >&2
      ;;
  esac
  for CID in ${CLUSTER_ID} ${TAGGED_IDS}; do
    # The out-of-band instance, the writer and the cluster, in that order: RDS
    # refuses to delete a cluster that still has a member.
    delete_instance "${CID}-oob"
    delete_instance "${CID}-instance-1"
    aws rds delete-db-cluster --db-cluster-identifier "${CID}" --region "${REGION}" \
      --skip-final-snapshot >/dev/null 2>&1
    aws rds wait db-cluster-deleted --db-cluster-identifier "${CID}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    # Not silenced: a cluster still held by a deleting writer must show.
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --skip-final-snapshot \
      --yes
  fi
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
CLEANED_UP=0

# The ExpressCluster record, whole (JSON).
cluster_record() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  jq -c '[.resources | to_entries[] | select(.key | startswith("ExpressCluster")) | .value] | if length == 1 then .[0] else error("expected exactly one ExpressCluster record, got \(length)") end' <<<"${state}"
}

instance_field() { # usage: instance_field <instance id> <JMESPath under DBInstances[0]>
  aws rds describe-db-instances --db-instance-identifier "$1" --region "${REGION}" \
    --query "DBInstances[0].$2" --output text || return 1
}

cluster_field() { # usage: cluster_field <JMESPath under DBClusters[0]>
  aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}" \
    --query "DBClusters[0].$1" --output text || return 1
}

# Wait until a probe reports not-found (gone_probe hard-fails on anything else).
wait_gone() { # usage: wait_gone "<description>" aws <service> <read-verb> [args...]
  local desc="$1" i
  shift
  for i in $(seq 1 120); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 15
  done
  echo "FAIL: ${desc}" >&2
  exit 1
}

assert_writer_available() { # usage: assert_writer_available <phase label>
  local st
  st="$(instance_field "${WRITER_ID}" DBInstanceStatus)"
  if [ "${st}" != "available" ]; then
    echo "FAIL ($1): writer ${WRITER_ID} is '${st}', expected available" >&2
    exit 1
  fi
}

assert_writer_recorded() { # usage: assert_writer_recorded <expected resource id> <phase label>
  local rec got
  rec="$(cluster_record)" || { echo "FAIL ($2): could not read the ExpressCluster record" >&2; exit 1; }
  got="$(jq -r '.attributes["cdkd:ExpressWriterResourceId"] // ""' <<<"${rec}")"
  if [ -z "${got}" ] || [ "${got}" != "$1" ]; then
    echo "FAIL ($2): record cdkd:ExpressWriterResourceId is '${got}', expected '$1' (go-to-k/cdkd#5984)" >&2
    exit 1
  fi
  echo "    OK ($2): record carries cdkd:ExpressWriterResourceId=${got}"
}

# --- Phase 1: deploy ----------------------------------------------------------
echo "==> Phase 1: deploy the express cluster"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

REC="$(cluster_record)" || { echo "FAIL: could not read the ExpressCluster record" >&2; exit 1; }
BY="$(jq -r '.provisionedBy // "sdk"' <<<"${REC}")"
if [ "${BY}" != "sdk" ]; then
  echo "FAIL: ExpressCluster is provisionedBy '${BY}', expected sdk — WithExpressConfiguration must not route it to Cloud Control (go-to-k/cdkd#5984)" >&2
  exit 1
fi
CLUSTER_ID="$(jq -r '.physicalId // ""' <<<"${REC}")"
if [ -z "${CLUSTER_ID}" ]; then
  echo "FAIL: the ExpressCluster record has no physicalId" >&2
  exit 1
fi
WRITER_ID="${CLUSTER_ID}-instance-1"
echo "    cluster=${CLUSTER_ID} writer=${WRITER_ID}"

assert_writer_available "phase 1"
WRITER_RESOURCE_ID="$(instance_field "${WRITER_ID}" DbiResourceId)"
if [ -z "${WRITER_RESOURCE_ID}" ] || [ "${WRITER_RESOURCE_ID}" = "None" ]; then
  echo "FAIL: the live writer reports no DbiResourceId" >&2
  exit 1
fi
assert_writer_recorded "${WRITER_RESOURCE_ID}" "phase 1"

LIVE_ENDPOINT="$(cluster_field Endpoint)"
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
OUT_ENDPOINT="$(jq -r '.outputs.ClusterEndpoint // ""' <<<"${STATE_JSON}")"
if [ -z "${LIVE_ENDPOINT}" ] || [ "${LIVE_ENDPOINT}" = "None" ] || [ "${OUT_ENDPOINT}" != "${LIVE_ENDPOINT}" ]; then
  echo "FAIL: stack output endpoint '${OUT_ENDPOINT}' != live cluster endpoint '${LIVE_ENDPOINT}'" >&2
  exit 1
fi
echo "    OK (phase 1): output endpoint matches the live endpoint"

# --- Phase 2: UPDATE ----------------------------------------------------------
echo "==> Phase 2: UPDATE (BackupRetentionPeriod 1 -> 7)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

BRP="$(cluster_field BackupRetentionPeriod)"
if [ "${BRP}" != "7" ]; then
  echo "FAIL: live BackupRetentionPeriod is '${BRP}', expected 7" >&2
  exit 1
fi
echo "    OK (phase 2): BackupRetentionPeriod=7"
assert_writer_recorded "${WRITER_RESOURCE_ID}" "phase 2"
NOW_ID="$(cluster_record | jq -r '.physicalId')"
if [ "${NOW_ID}" != "${CLUSTER_ID}" ]; then
  echo "FAIL: the UPDATE replaced the cluster (${CLUSTER_ID} -> ${NOW_ID}); expected in place" >&2
  exit 1
fi

# --- Phase 3: refusal with an extra instance -----------------------------------
echo "==> Phase 3: destroy is refused while another instance is in the cluster"
OOB_ID="${CLUSTER_ID}-oob"
aws rds create-db-instance --db-instance-identifier "${OOB_ID}" \
  --db-cluster-identifier "${CLUSTER_ID}" --engine aurora-postgresql \
  --db-instance-class db.serverless --region "${REGION}" >/dev/null
aws rds wait db-instance-available --db-instance-identifier "${OOB_ID}" --region "${REGION}"

RC=0
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DESTROY_LOG}" 2>&1 || RC=$?
if [ "${RC}" != "2" ]; then
  echo "FAIL: the refused destroy exited ${RC}, expected 2" >&2
  cat "${DESTROY_LOG}" >&2
  exit 1
fi
if ! grep -q 'besides the writer express configuration created' "${DESTROY_LOG}"; then
  echo "FAIL: the refused destroy did not say 'besides the writer express configuration created' (go-to-k/cdkd#5984)" >&2
  cat "${DESTROY_LOG}" >&2
  exit 1
fi
WRITER_STATUS="$(instance_field "${WRITER_ID}" DBInstanceStatus)"
if [ "${WRITER_STATUS}" = "deleting" ]; then
  echo "FAIL: the refused destroy still started deleting the writer ${WRITER_ID}" >&2
  exit 1
fi
CLUSTER_STATUS="$(cluster_field Status)"
if [ "${CLUSTER_STATUS}" = "deleting" ]; then
  echo "FAIL: the refused destroy still started deleting the cluster ${CLUSTER_ID}" >&2
  exit 1
fi
cluster_record >/dev/null || { echo "FAIL: the refused destroy dropped the ExpressCluster state record" >&2; exit 1; }
echo "    OK (phase 3): rc 2, nothing deleted (writer ${WRITER_STATUS}, cluster ${CLUSTER_STATUS}), record kept"

echo "==> Phase 3: delete the out-of-band instance"
aws rds delete-db-instance --db-instance-identifier "${OOB_ID}" --region "${REGION}" \
  --skip-final-snapshot >/dev/null
wait_gone "out-of-band instance ${OOB_ID} still exists" \
  aws rds describe-db-instances --db-instance-identifier "${OOB_ID}" --region "${REGION}"
OOB_ID=""

# --- Phase 4: destroy ------------------------------------------------------------
echo "==> Phase 4: destroy"
RC=0
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${DESTROY_LOG}" 2>&1 || RC=$?
if [ "${RC}" != "0" ]; then
  echo "FAIL: destroy exited ${RC}, expected 0" >&2
  cat "${DESTROY_LOG}" >&2
  exit 1
fi

assert_gone "writer ${WRITER_ID} still exists after destroy" \
  aws rds describe-db-instances --db-instance-identifier "${WRITER_ID}" --region "${REGION}"
assert_gone "cluster ${CLUSTER_ID} still exists after destroy" \
  aws rds describe-db-clusters --db-cluster-identifier "${CLUSTER_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"

SNAPS="$(aws rds describe-db-cluster-snapshots --db-cluster-identifier "${CLUSTER_ID}" \
  --snapshot-type manual --region "${REGION}" --query 'length(DBClusterSnapshots)' --output json)"
if [ "${SNAPS}" != "0" ]; then
  echo "FAIL: ${SNAPS} manual snapshot(s) of ${CLUSTER_ID} left behind; RemovalPolicy.DESTROY must delete without a final snapshot" >&2
  exit 1
fi
echo "    OK (phase 4): writer, cluster and state file gone; no snapshot left"

trap - EXIT INT TERM
cleanup

echo "[verify] PASS — RDS DBCluster WithExpressConfiguration: sdk route, writer recorded, in-place update, refusal with an extra instance, clean destroy (go-to-k/cdkd#5984)"
