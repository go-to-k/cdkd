#!/usr/bin/env bash
# verify.sh — cdkd ECS TaskDefinition Tags in-place update + Service
# LaunchType replacement integ (issue #5392).
#
# CloudFormation A/B (us-east-1, recorded on #5392):
#   - TaskDefinition Tags-only change: change set `Modify`, `Replacement:
#     False`; the SAME revision ARN carries the new tags.
#   - Service LaunchType EC2 -> EXTERNAL, and absent -> EC2: the service is
#     REPLACED (a new ARN). LaunchType removed: updated in place, and the
#     service KEEPS its live launch type.
#
# Before the fix every TaskDefinition update threw (the deploy failed pointing
# at --replace), and a LaunchType change was recorded in state while
# UpdateService (which has no launchType member) left AWS unchanged.
#
# Phases:
#   1. Deploy: TaskDefinition tagged {cdkd-5392: v1, cdkd-5392-gone: x},
#      Service LaunchType EC2. Assert both reached AWS.
#   2. CDKD_TEST_UPDATE=true: tags -> {cdkd-5392: v2} (one key removed),
#      LaunchType -> EXTERNAL. Assert the TaskDefinition kept its revision ARN
#      and carries exactly the new tags, and the Service was replaced (new
#      ARN, launch type EXTERNAL, the old one no longer ACTIVE).
#   3. CDKD_TEST_UPDATE=true,rm-lt: LaunchType removed. Assert the Service
#      was NOT replaced and still runs EXTERNAL (the CloudFormation parity
#      negative control).
#   4. Destroy; assert the cluster and service are inactive and the state
#      file is gone.
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

cd "$(dirname "$0")"

STACK="CdkdEcsTaskdefTagsLaunchTypeExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET:-}" --region "${REGION}"
    rc=$?
  else
    rc=0
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${rc}" = "0" ]; then
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

read_outputs() {
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
  CLUSTER_NAME="$(printf '%s' "${state}" | jq -r '.outputs.ClusterName // empty')"
  TASKDEF_ARN="$(printf '%s' "${state}" | jq -r '.outputs.TaskDefArn // empty')"
  SERVICE_ARN="$(printf '%s' "${state}" | jq -r '.outputs.ServiceArn // empty')"
  if [ -z "${CLUSTER_NAME}" ] || [ -z "${TASKDEF_ARN}" ] || [ -z "${SERVICE_ARN}" ]; then
    echo "FAIL: ClusterName / TaskDefArn / ServiceArn missing from state outputs" >&2
    printf '%s' "${state}" | jq '.outputs' >&2
    exit 1
  fi
}

# Tags as a sorted "k=v,k=v" string.
taskdef_tags() {
  aws ecs list-tags-for-resource --resource-arn "${TASKDEF_ARN}" --region "${REGION}" --output json |
    jq -r '[.tags[] | "\(.key)=\(.value)"] | sort | join(",")'
}

# "<launchType> <status>" of one service ARN. A service missing from the reply
# reads as "NONE MISSING"; so does every service of a cluster that is gone
# (ClusterNotFoundException, after destroy). Any other failure is fatal.
service_shape() {
  local out
  if ! out="$(aws ecs describe-services --cluster "${CLUSTER_NAME}" --services "$1" --region "${REGION}" --output json 2>&1)"; then
    if grep -q 'ClusterNotFoundException' <<<"${out}"; then
      echo "NONE MISSING"
      return 0
    fi
    echo "FAIL: describe-services failed: ${out}" >&2
    exit 1
  fi
  printf '%s' "${out}" | jq -r '.services[0] | "\(.launchType // "NONE") \(.status // "MISSING")"'
}

# --- Phase 1: deploy (base) -------------------------------------------------
echo "==> Phase 1: deploy (tags v1 + gone key, LaunchType EC2)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

read_outputs
BASE_TASKDEF_ARN="${TASKDEF_ARN}"
BASE_SERVICE_ARN="${SERVICE_ARN}"
echo "    cluster=${CLUSTER_NAME} taskdef=${BASE_TASKDEF_ARN} service=${BASE_SERVICE_ARN}"

BASE_TAGS="$(taskdef_tags)"
if [ "${BASE_TAGS}" != "cdkd-5392-gone=x,cdkd-5392=v1" ]; then
  echo "FAIL: base task definition tags are '${BASE_TAGS}', expected 'cdkd-5392-gone=x,cdkd-5392=v1'" >&2
  exit 1
fi
BASE_SHAPE="$(service_shape "${BASE_SERVICE_ARN}")"
if [ "${BASE_SHAPE}" != "EC2 ACTIVE" ]; then
  echo "FAIL: base service is '${BASE_SHAPE}', expected 'EC2 ACTIVE'" >&2
  exit 1
fi
echo "    OK: base tags and launch type reached AWS"

# --- Phase 2: Tags change + LaunchType change -------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_UPDATE=true (tags -> v2 with a key removed, LaunchType -> EXTERNAL)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

read_outputs
if [ "${TASKDEF_ARN}" != "${BASE_TASKDEF_ARN}" ]; then
  echo "FAIL: the task definition moved to '${TASKDEF_ARN}' (was '${BASE_TASKDEF_ARN}'): a tags-only change must tag the same revision in place, as CloudFormation does (#5392)" >&2
  exit 1
fi
AFTER_TAGS="$(taskdef_tags)"
if [ "${AFTER_TAGS}" != "cdkd-5392=v2" ]; then
  echo "FAIL: after update, task definition tags are '${AFTER_TAGS}', expected exactly 'cdkd-5392=v2' (#5392 TaskDefinition Tags update)" >&2
  exit 1
fi
echo "    OK: same revision, tags updated in place and the removed key untagged (#5392)"

if [ "${SERVICE_ARN}" = "${BASE_SERVICE_ARN}" ]; then
  echo "FAIL: the service was not replaced on a LaunchType change (ARN unchanged: ${SERVICE_ARN}); UpdateService cannot change it, so AWS kept the old launch type (#5392 silent drop)" >&2
  service_shape "${SERVICE_ARN}" >&2
  exit 1
fi
NEW_SHAPE="$(service_shape "${SERVICE_ARN}")"
if [ "${NEW_SHAPE}" != "EXTERNAL ACTIVE" ]; then
  echo "FAIL: the replacement service is '${NEW_SHAPE}', expected 'EXTERNAL ACTIVE' (#5392)" >&2
  exit 1
fi
OLD_STATUS="$(service_shape "${BASE_SERVICE_ARN}")"
case "${OLD_STATUS}" in
  *" DRAINING" | *" INACTIVE" | *" MISSING") ;;
  *)
    echo "FAIL: the replaced service is still '${OLD_STATUS}', expected DRAINING / INACTIVE / MISSING (#5392 replacement left the old service)" >&2
    exit 1
    ;;
esac
echo "    OK: LaunchType change replaced the service (new one EXTERNAL, old one ${OLD_STATUS##* }) (#5392)"

# --- Phase 3: LaunchType removed (negative control) -------------------------
echo "==> Phase 3: redeploy with CDKD_TEST_UPDATE=true,rm-lt (LaunchType removed)"
REPLACED_SERVICE_ARN="${SERVICE_ARN}"
CDKD_TEST_UPDATE=true,rm-lt node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

read_outputs
if [ "${SERVICE_ARN}" != "${REPLACED_SERVICE_ARN}" ]; then
  echo "FAIL: removing LaunchType replaced the service ('${REPLACED_SERVICE_ARN}' -> '${SERVICE_ARN}'); CloudFormation updates it in place (#5392)" >&2
  exit 1
fi
RM_SHAPE="$(service_shape "${SERVICE_ARN}")"
if [ "${RM_SHAPE}" != "EXTERNAL ACTIVE" ]; then
  echo "FAIL: after removing LaunchType the service is '${RM_SHAPE}', expected it to keep 'EXTERNAL ACTIVE' as CloudFormation does (#5392)" >&2
  exit 1
fi
echo "    OK: LaunchType removal kept the service and its live launch type (#5392)"

# --- Phase 4: destroy --------------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

FINAL_SHAPE="$(service_shape "${SERVICE_ARN}")"
case "${FINAL_SHAPE}" in
  *" DRAINING" | *" INACTIVE" | *" MISSING") ;;
  *)
    echo "FAIL: the service is still '${FINAL_SHAPE}' after destroy" >&2
    exit 1
    ;;
esac
CLUSTER_STATUS="$(aws ecs describe-clusters --clusters "${CLUSTER_NAME}" --region "${REGION}" --output json |
  jq -r '.clusters[0].status // "MISSING"')"
case "${CLUSTER_STATUS}" in
  INACTIVE | MISSING) ;;
  *)
    echo "FAIL: the cluster is still '${CLUSTER_STATUS}' after destroy" >&2
    exit 1
    ;;
esac
# cdkd deregisters the revision, which then reads INACTIVE (DELETE_IN_PROGRESS
# once deleted); a revision AWS no longer describes counts as gone through
# the canonical gone-probe. An empty or null status is fatal.
if ! gone_probe aws ecs describe-task-definition --task-definition "${TASKDEF_ARN}" --region "${REGION}"; then
  TASKDEF_STATUS="$(aws ecs describe-task-definition --task-definition "${TASKDEF_ARN}" --region "${REGION}" --output json |
    jq -r '.taskDefinition.status // empty')"
  case "${TASKDEF_STATUS}" in
    INACTIVE | DELETE_IN_PROGRESS) ;;
    *)
      echo "FAIL: the task definition status is '${TASKDEF_STATUS:-<empty>}' after destroy, expected INACTIVE / DELETE_IN_PROGRESS" >&2
      exit 1
      ;;
  esac
fi
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: service, cluster and task definition are inactive and the state file is gone"

echo ""
echo "[verify] PASS — ecs-taskdef-tags-launch-type: TaskDefinition Tags updated in place on the same revision; Service LaunchType change replaced the service and its removal kept it (#5392)"
