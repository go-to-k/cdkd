#!/usr/bin/env bash
# verify.sh -- cdkd AWS::DataSync::LocationS3 created with a same-stack role
# (issue #6573).
#
# `AWS::DataSync::LocationS3` has no SDK provider, so it is created through
# Cloud Control seconds after its bucket access role. Until IAM propagates the
# role, DataSync refuses the create with "Invalid IAM role ... DataSync service
# was unable to perform sts:AssumeRole", which cdkd did not retry: every first
# deploy failed and rolled back. `IAM_PROPAGATION_ERROR_MESSAGE_PATTERNS`
# (`src/deployment/retryable-errors/patterns.ts`) now carries that wording.
#
# Phases:
#   1. Deploy two buckets, a role for `datasync.amazonaws.com`, two S3
#      locations using it and a task between them, all new (the role is created
#      in this deploy). The first deploy succeeding IS the assertion. Assert
#      both locations exist in AWS with the role and the right bucket.
#   2. `cdkd diff` reports no changes.
#   2b. Redeploy with `CDKD_TEST_UPDATE=verify` (the task's
#      `Options.VerifyMode` -> NONE). The task has no schedule and Cloud
#      Control reads it back as `Schedule: {}`, which `UpdateTask` refused on
#      every update (issue #6676). Assert AWS holds NONE, then change it out of
#      band, `drift --revert` it and assert NONE again and a clean drift.
#   2c. go-to-k/cdkd#7007: redeploy with `CDKD_TEST_SUBDIR=1`, which moves
#      ONLY the destination location's `Subdirectory` in place. Its
#      `LocationUri` moves with it; the SSM parameter reading the URI must hold
#      the live one (before the fix it stayed NO_CHANGE on the old URI).
#   3. Destroy. Assert the locations, the task, the role, the SSM parameter and
#      the state file are gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
export AWS_PAGER=""

STACK="CdkdDatasyncLocationRole"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SRC_LOGICAL="LocSrc"
DST_LOGICAL="LocDst"
TASK_LOGICAL="Task"
ROLE_LOGICAL="Role1ABCC5F0"
SRC_BUCKET_LOGICAL="SrcBucket613E28A1"
URI_PARAM="cdkd-datasync-location-role-dst-uri"
DIFF_LOG="${TMPDIR:-/tmp}/cdkd-6573-diff.$$.log"

# The S3 auto-delete custom resource's Lambda log group is created when it runs,
# and nothing in the stack owns it, so destroy leaves it behind (#3885).
. ../cr-log-groups.sh

CLEANED_UP=0
PRE_RUN=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DIFF_LOG}"
  # `state destroy` throws when there is no state, as before any run and after a
  # PASS, so its failure means something only for a state that exists. Anything
  # but a clean not-found counts as existing: keeping a record costs nothing.
  STATE_LEFT=0
  if [ -n "${STATE_BUCKET:-}" ]; then
    if STATE_HEAD="$(aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" 2>&1 >/dev/null)"; then
      STATE_LEFT=1
    elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${STATE_HEAD}"; then
      STATE_LEFT=1
    fi
  fi
  if [ "${STATE_LEFT}" = "1" ] && [ -f "${LOCAL_DIST}" ] &&
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1; then
    STATE_LEFT=0
  fi
  # A deploy that failed before state recorded them leaves roles nothing here
  # knows: the location role (`<stack>-Role...`) and the auto-delete CR
  # provider role (`<stack>-Custom...`), which has a managed policy attached.
  # The account is shared and a peer may be running this fixture, so only
  # this run's own teardown deletes by prefix: before the run, a match is reported and stops it. Locations and tasks have
  # generated ids with no prefix to sweep; a failed create leaves none (Cloud
  # Control rolls it back).
  LEFT_BY_PREFIX=""
  # The URI reader has a fixed name: a peer's run may hold it before ours.
  if aws ssm get-parameter --name "${URI_PARAM}" --region "${REGION}" >/dev/null 2>&1; then
    if [ "${PRE_RUN}" = "1" ]; then
      LEFT_BY_PREFIX="${LEFT_BY_PREFIX} ssm:${URI_PARAM}"
    else
      aws ssm delete-parameter --name "${URI_PARAM}" --region "${REGION}" >/dev/null 2>&1 ||
        echo "WARN: could not delete SSM parameter ${URI_PARAM}" >&2
    fi
  fi
  case "${STACK}" in
    CdkdDatasync?*)
      if SWEPT_ROLES="$(aws iam list-roles \
        --query "Roles[?starts_with(RoleName, '${STACK}-')].RoleName" --output text 2>&1)"; then
        for role in ${SWEPT_ROLES}; do
          [ "${role}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} role:${role}"
          else
            for pol in $(aws iam list-attached-role-policies --role-name "${role}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
              aws iam detach-role-policy --role-name "${role}" --policy-arn "${pol}" >/dev/null 2>&1 || true
            done
            for policy in $(aws iam list-role-policies --role-name "${role}" --query 'PolicyNames[]' --output text 2>/dev/null); do
              aws iam delete-role-policy --role-name "${role}" --policy-name "${policy}" >/dev/null 2>&1 || true
            done
            aws iam delete-role --role-name "${role}" >/dev/null 2>&1 ||
              echo "WARN: could not delete role ${role}" >&2
          fi
        done
      else
        echo "WARN: could not list roles of ${STACK}: ${SWEPT_ROLES}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdDatasync?*" >&2
      ;;
  esac
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and resources of ${STACK} (locations, task, role, buckets) may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  set -eu
  if [ -n "${LEFT_BY_PREFIX}" ]; then
    echo "FAIL: ${STACK} resources exist before this run, possibly a peer's live run:${LEFT_BY_PREFIX}" >&2
    exit 1
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
PRE_RUN=1
cleanup
PRE_RUN=0
CLEANED_UP=0

read_state() { # $1 = python expression over `s` (the state fetched into STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
location_in_list() { # $1 = location ARN; prints it when DataSync lists it
  aws datasync list-locations --region "${REGION}" \
    --query "Locations[?LocationArn=='$1'].LocationArn" --output text
}

# --- Phase 1: deploy with a role created in the same deploy -----------------
echo "==> Phase 1: deploy (two S3 locations, a task and a brand-new bucket access role)"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
SRC_ARN="$(read_state "s['resources']['${SRC_LOGICAL}']['physicalId']")"
DST_ARN="$(read_state "s['resources']['${DST_LOGICAL}']['physicalId']")"
TASK_ARN="$(read_state "s['resources']['${TASK_LOGICAL}']['physicalId']")"
ROLE_NAME="$(read_state "s['resources']['${ROLE_LOGICAL}']['physicalId']")"
SRC_BUCKET="$(read_state "s['resources']['${SRC_BUCKET_LOGICAL}']['physicalId']")"
for v in SRC_ARN DST_ARN TASK_ARN ROLE_NAME SRC_BUCKET; do
  [ -n "${!v}" ] || { echo "FAIL: state records no physical id for ${v}" >&2; exit 1; }
done
echo "    state records ${SRC_ARN} and ${DST_ARN}"

ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
for arn in "${SRC_ARN}" "${DST_ARN}"; do
  [ "$(location_in_list "${arn}")" = "${arn}" ] ||
    { echo "FAIL: DataSync does not list location ${arn}" >&2; exit 1; }
  ACCESS_ROLE="$(aws datasync describe-location-s3 --location-arn "${arn}" --region "${REGION}" \
    --query S3Config.BucketAccessRoleArn --output text)"
  [ "${ACCESS_ROLE}" = "${ROLE_ARN}" ] ||
    { echo "FAIL: location ${arn} access role '${ACCESS_ROLE}' != '${ROLE_ARN}'" >&2; exit 1; }
done
SRC_URI="$(aws datasync describe-location-s3 --location-arn "${SRC_ARN}" --region "${REGION}" \
  --query LocationUri --output text)"
case "${SRC_URI}" in
  "s3://${SRC_BUCKET}"*) ;;
  *) echo "FAIL: source location uri '${SRC_URI}' does not name bucket ${SRC_BUCKET}" >&2; exit 1 ;;
esac
TASK_SRC="$(aws datasync describe-task --task-arn "${TASK_ARN}" --region "${REGION}" \
  --query SourceLocationArn --output text)"
[ "${TASK_SRC}" = "${SRC_ARN}" ] ||
  { echo "FAIL: task source '${TASK_SRC}' != '${SRC_ARN}'" >&2; exit 1; }
echo "    both locations exist with the new role; the task links them"

# --- Phase 2: diff is clean -------------------------------------------------
echo "==> Phase 2: diff (expect no changes)"
node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1
# cdkd's own line (src/cli/commands/diff.ts), naming this stack.
if ! grep -qF "No changes detected for stack ${STACK}" "${DIFF_LOG}"; then
  echo "FAIL: diff after the create is not clean. Tail:" >&2
  tail -20 "${DIFF_LOG}" >&2
  exit 1
fi
echo "    diff reports no changes"

# --- Phase 2b: update a schedule-less task, then drift --revert it ----------
task_verify_mode() {
  aws datasync describe-task --task-arn "${TASK_ARN}" --region "${REGION}" \
    --query Options.VerifyMode --output text
}
echo "==> Phase 2b: redeploy with the task's VerifyMode -> NONE (issue #6676)"
CDKD_TEST_UPDATE=verify node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
MODE="$(task_verify_mode)"
[ "${MODE}" = "NONE" ] || { echo "FAIL: task VerifyMode '${MODE}' != NONE after the update" >&2; exit 1; }
echo "    the update reached AWS (VerifyMode=NONE)"

aws datasync update-task --task-arn "${TASK_ARN}" --region "${REGION}" \
  --options VerifyMode=POINT_IN_TIME_CONSISTENT
MODE="$(task_verify_mode)"
[ "${MODE}" = "POINT_IN_TIME_CONSISTENT" ] ||
  { echo "FAIL: the out-of-band change did not land (VerifyMode '${MODE}')" >&2; exit 1; }
CDKD_TEST_UPDATE=verify node "${LOCAL_DIST}" drift "${STACK}" --revert --yes \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
MODE="$(task_verify_mode)"
[ "${MODE}" = "NONE" ] || { echo "FAIL: drift --revert left VerifyMode '${MODE}'" >&2; exit 1; }
CDKD_TEST_UPDATE=verify node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
echo "    drift --revert restored VerifyMode=NONE and drift is clean"

# --- Phase 2c: move ONLY the destination Subdirectory in place (#7007) -----
dst_uri() {
  aws datasync describe-location-s3 --location-arn "${DST_ARN}" --region "${REGION}" \
    --query LocationUri --output text
}
uri_reader() {
  aws ssm get-parameter --name "${URI_PARAM}" --region "${REGION}" \
    --query Parameter.Value --output text
}
echo "==> Phase 2c: redeploy moving only the destination Subdirectory (issue #7007)"
# Premise: no earlier phase moved the URI (2b and its drift --revert touch the
# task only), so the reader starts on the live value and only a fix moves it.
URI_BEFORE="$(dst_uri)"
READER_BEFORE="$(uri_reader)"
if [ "${READER_BEFORE}" != "${URI_BEFORE}" ]; then
  echo "FAIL: premise: the URI reader holds '${READER_BEFORE}', the live URI is '${URI_BEFORE}'" >&2
  exit 1
fi
CDKD_TEST_UPDATE=verify CDKD_TEST_SUBDIR=1 node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
URI_AFTER="$(dst_uri)"
READER_AFTER="$(uri_reader)"
echo "    uri before '${URI_BEFORE}', after '${URI_AFTER}', reader '${READER_AFTER}'"
if [ "${URI_AFTER}" = "${URI_BEFORE}" ]; then
  echo "FAIL: premise: the Subdirectory update did not move the LocationUri ('${URI_BEFORE}')" >&2
  exit 1
fi
if [ "${READER_AFTER}" != "${URI_AFTER}" ]; then
  echo "FAIL: the LocationUri reader holds '${READER_AFTER}', the live URI is '${URI_AFTER}' (issue #7007)" >&2
  exit 1
fi
echo "    the LocationUri reader follows the in-place Subdirectory update"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DataSync answers a describe on a deleted resource with InvalidRequestException
# whose text may not say "not found": read the (strict) lists instead.
for arn in "${SRC_ARN}" "${DST_ARN}"; do
  LEFT="$(location_in_list "${arn}")"
  [ -z "${LEFT}" ] ||
    { echo "FAIL: location ${arn} still exists after destroy" >&2; exit 1; }
done
TASKS_LEFT="$(aws datasync list-tasks --region "${REGION}" \
  --query "Tasks[?TaskArn=='${TASK_ARN}'].TaskArn" --output text)"
[ -z "${TASKS_LEFT}" ] ||
  { echo "FAIL: task ${TASK_ARN} still exists after destroy" >&2; exit 1; }
assert_gone "role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
assert_gone "bucket ${SRC_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${SRC_BUCKET}" --region "${REGION}"
assert_gone "SSM parameter ${URI_PARAM} still exists after destroy" \
  aws ssm get-parameter --name "${URI_PARAM}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

cleanup
trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
echo "[verify] PASS -- DataSync S3 locations created with a brand-new role deployed on the first try, diff clean, destroy left nothing"
