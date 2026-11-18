#!/usr/bin/env bash
# verify.sh -- cdkd AWS::CloudWatch::MetricStream without an explicit name
# (issue #6555).
#
# `AWS::CloudWatch::MetricStream` has no SDK provider, so it is created through
# Cloud Control. The schema does not require `Name`, but a Cloud Control create
# without one fails with `Cannot invoke "java.lang.CharSequence.length()"
# because "this.text" is null`. cdkd now fills a generated name on the CREATE
# (`FALLBACK_NAME_RULES` in `src/provisioning/resource-name/fallback-rules.ts`)
# and takes it back out of the UPDATE bag (`withoutGeneratedFallbackName`).
#
# Phases:
#   1. Deploy a Firehose delivery stream to S3, a role for
#      `streams.metrics.cloudwatch.amazonaws.com`, and a metric stream with NO
#      name (OutputFormat json, one include filter). Assert: state records the
#      stream under the generated `<stack>-MetricStream-<12 hex>` name
#      (go-to-k/cdkd#5064) on the Cloud Control route, AWS reports it running
#      with the template's format, filter and Firehose ARN, and the outputs
#      agree.
#   2. `cdkd diff` reports no changes (the generated name must not read as a
#      create-only change on the next run).
#   3. UPDATE (CDKD_TEST_UPDATE=true: OutputFormat opentelemetry1.0, a second
#      include filter). Assert both reached AWS, and the stream kept its name,
#      ARN, creation date and state physical id (in place, not replaced); a
#      diff under the same mode is clean.
#   4. Destroy. Assert the metric stream, the delivery stream, the bucket, the
#      role, the delivery log group and the state file are gone.
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
# The auto-delete handler's Lambda log group (`sweep_stack_lambda_log_groups`).
. ../cr-log-groups.sh

STACK="CdkdCwMetricStreamDefaultName"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
STREAM_LOGICAL="MetricStream"
DELIVERY_LOGICAL="Delivery5F6C039D"
BUCKET_LOGICAL="MetricBucket8C17F29F"
ROLE_LOGICAL="MetricStreamRoleD308D174"
LOG_GROUP_LOGICAL="DeliveryLogsAB0E43B0"
DIFF_LOG="${TMPDIR:-/tmp}/cdkd-6555-diff.$$.log"

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
  # A deploy that failed before state recorded them leaves names nothing here
  # knows, and every generated name starts with the stack. The account is
  # shared and a peer may be running this fixture, so only this run's own
  # teardown deletes by prefix: before the run, a match is reported and stops it.
  LEFT_BY_PREFIX=""
  case "${STACK}" in
    CdkdCw?*)
      if SWEPT_STREAMS="$(aws cloudwatch list-metric-streams --region "${REGION}" \
        --query "Entries[?starts_with(Name, '${STACK}-')].Name" --output text 2>&1)"; then
        for name in ${SWEPT_STREAMS}; do
          [ "${name}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} metric-stream:${name}"
          else
            aws cloudwatch delete-metric-stream --name "${name}" --region "${REGION}" >/dev/null 2>&1 ||
              echo "WARN: could not delete metric stream ${name}" >&2
          fi
        done
      else
        echo "WARN: could not list metric streams of ${STACK}: ${SWEPT_STREAMS}" >&2
      fi
      if SWEPT_DELIVERY="$(aws firehose list-delivery-streams --region "${REGION}" --limit 10000 \
        --query "DeliveryStreamNames[?starts_with(@, '${STACK}-')]" --output text 2>&1)"; then
        for name in ${SWEPT_DELIVERY}; do
          [ "${name}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_PREFIX="${LEFT_BY_PREFIX} delivery-stream:${name}"
          else
            aws firehose delete-delivery-stream --delivery-stream-name "${name}" --region "${REGION}" >/dev/null 2>&1 ||
              echo "WARN: could not delete delivery stream ${name}" >&2
          fi
        done
      else
        echo "WARN: could not list delivery streams of ${STACK}: ${SWEPT_DELIVERY}" >&2
      fi
      if [ "${PRE_RUN}" != "1" ]; then
        # The delivery log group of a deploy that failed before state recorded
        # it (cdkd prefixes a generated log group name with `/cdkd/`).
        for lg in $(aws logs describe-log-groups --region "${REGION}" \
          --log-group-name-prefix "/cdkd/${STACK}-" --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
          aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
        done
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdCw?*" >&2
      ;;
  esac
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  # The state is the only record of what a failed `state destroy` left behind.
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and resources of ${STACK} (bucket, roles) may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
stream_field() { # usage: stream_field <query>; strict, no fallback
  aws cloudwatch get-metric-stream --name "${STREAM_NAME}" --region "${REGION}" --query "$1" --output text
}
stream_filters() { # the include filters' namespaces, sorted
  stream_field "join(' ', sort(IncludeFilters[].Namespace || \`[]\`))"
}
assert_clean_diff() { # $1 = phase label; runs under the caller's CDKD_TEST_UPDATE
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1
  if ! grep -q "No changes detected" "${DIFF_LOG}"; then
    echo "FAIL: diff $1 is not clean. Tail:" >&2
    tail -20 "${DIFF_LOG}" >&2
    exit 1
  fi
}

# --- Phase 1: deploy with no Name -------------------------------------------
echo "==> Phase 1: deploy (a metric stream without a name)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
STREAM_NAME="$(read_state "s['resources']['${STREAM_LOGICAL}']['physicalId']")"
STREAM_ROUTE="$(read_state "s['resources']['${STREAM_LOGICAL}'].get('provisionedBy', '')")"
DELIVERY_NAME="$(read_state "s['resources']['${DELIVERY_LOGICAL}']['physicalId']")"
BUCKET_NAME="$(read_state "s['resources']['${BUCKET_LOGICAL}']['physicalId']")"
ROLE_NAME="$(read_state "s['resources']['${ROLE_LOGICAL}']['physicalId']")"
LOG_GROUP_NAME="$(read_state "s['resources']['${LOG_GROUP_LOGICAL}']['physicalId']")"
OUT_NAME="$(read_state "s.get('outputs', {}).get('MetricStreamName', '')")"
OUT_ARN="$(read_state "s.get('outputs', {}).get('MetricStreamArn', '')")"
OUT_DELIVERY="$(read_state "s.get('outputs', {}).get('DeliveryStreamName', '')")"

# go-to-k/cdkd#5064: `<stack>-<logicalId>-<12 hex>`, well under the 255 cap.
grep -qE "^${STACK}-${STREAM_LOGICAL}-[0-9a-f]{12}\$" <<<"${STREAM_NAME}" ||
  { echo "FAIL: ${STREAM_LOGICAL} physicalId '${STREAM_NAME}' is not the generated ${STACK}-${STREAM_LOGICAL}-<12 hex>" >&2; exit 1; }
[ "${STREAM_ROUTE}" = "cc-api" ] ||
  { echo "FAIL: ${STREAM_LOGICAL} provisionedBy='${STREAM_ROUTE}', expected cc-api" >&2; exit 1; }
echo "    state records ${STREAM_NAME} via cc-api"

STREAM_ARN="$(stream_field Arn)"
STREAM_CREATED="$(stream_field CreationDate)"
STREAM_STATE="$(stream_field State)"
STREAM_FORMAT="$(stream_field OutputFormat)"
STREAM_FIREHOSE="$(stream_field FirehoseArn)"
STREAM_FILTERS="$(stream_filters)"
DELIVERY_ARN="$(aws firehose describe-delivery-stream --delivery-stream-name "${DELIVERY_NAME}" --region "${REGION}" \
  --query 'DeliveryStreamDescription.DeliveryStreamARN' --output text)"
[ "${STREAM_STATE}" = "running" ] ||
  { echo "FAIL: metric stream State='${STREAM_STATE}', expected running" >&2; exit 1; }
[ "${STREAM_FORMAT}" = "json" ] ||
  { echo "FAIL: metric stream OutputFormat='${STREAM_FORMAT}', expected json" >&2; exit 1; }
[ "${STREAM_FILTERS}" = "AWS/Lambda" ] ||
  { echo "FAIL: metric stream include filters '${STREAM_FILTERS}', expected 'AWS/Lambda'" >&2; exit 1; }
[ "${STREAM_FIREHOSE}" = "${DELIVERY_ARN}" ] ||
  { echo "FAIL: metric stream FirehoseArn '${STREAM_FIREHOSE}' != delivery stream ARN '${DELIVERY_ARN}'" >&2; exit 1; }
[ "${OUT_NAME}" = "${STREAM_NAME}" ] && [ "${OUT_ARN}" = "${STREAM_ARN}" ] && [ "${OUT_DELIVERY}" = "${DELIVERY_NAME}" ] ||
  { echo "FAIL: outputs name='${OUT_NAME}' arn='${OUT_ARN}' delivery='${OUT_DELIVERY}' disagree with AWS ('${STREAM_NAME}', '${STREAM_ARN}', '${DELIVERY_NAME}')" >&2; exit 1; }
echo "    AWS reports ${STREAM_NAME} running (json, AWS/Lambda) into ${DELIVERY_NAME}; outputs agree"

# --- Phase 2: diff is clean -------------------------------------------------
echo "==> Phase 2: diff (expect no changes)"
# Empty rather than unset: a function call cannot take `env -u`, and the stack
# only updates when the value is exactly `true`.
CDKD_TEST_UPDATE= assert_clean_diff "after the create"
echo "    diff reports no changes"

# --- Phase 3: in-place UPDATE through Cloud Control -------------------------
echo "==> Phase 3: update (OutputFormat opentelemetry1.0 + a second include filter)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

FORMAT_AFTER="$(stream_field OutputFormat)"
FILTERS_AFTER="$(stream_filters)"
ARN_AFTER="$(stream_field Arn)"
CREATED_AFTER="$(stream_field CreationDate)"
[ "${FORMAT_AFTER}" = "opentelemetry1.0" ] ||
  { echo "FAIL: OutputFormat after the update is '${FORMAT_AFTER}', expected opentelemetry1.0" >&2; exit 1; }
[ "${FILTERS_AFTER}" = "AWS/Lambda AWS/S3" ] ||
  { echo "FAIL: include filters after the update are '${FILTERS_AFTER}', expected 'AWS/Lambda AWS/S3'" >&2; exit 1; }
[ "${ARN_AFTER}" = "${STREAM_ARN}" ] && [ "${CREATED_AFTER}" = "${STREAM_CREATED}" ] ||
  { echo "FAIL: the metric stream was replaced (ARN '${STREAM_ARN}' -> '${ARN_AFTER}', created '${STREAM_CREATED}' -> '${CREATED_AFTER}')" >&2; exit 1; }
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
STREAM_ID_AFTER="$(read_state "s['resources']['${STREAM_LOGICAL}']['physicalId']")"
[ "${STREAM_ID_AFTER}" = "${STREAM_NAME}" ] ||
  { echo "FAIL: ${STREAM_LOGICAL} state physical id changed across the update ('${STREAM_NAME}' -> '${STREAM_ID_AFTER}')" >&2; exit 1; }
echo "    update reached AWS; ${STREAM_NAME} updated in place"

CDKD_TEST_UPDATE=true assert_clean_diff "after the update"
echo "    diff under the update mode reports no changes"

# --- Phase 4: destroy -------------------------------------------------------
echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "metric stream ${STREAM_NAME} still exists after destroy" \
  aws cloudwatch get-metric-stream --name "${STREAM_NAME}" --region "${REGION}"
assert_gone "delivery stream ${DELIVERY_NAME} still exists after destroy" \
  aws firehose describe-delivery-stream --delivery-stream-name "${DELIVERY_NAME}" --region "${REGION}"
assert_gone "bucket ${BUCKET_NAME} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
assert_gone "role ${ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
LOG_GROUP_LEFT="$(aws logs describe-log-groups --region "${REGION}" --log-group-name-prefix "${LOG_GROUP_NAME}" \
  --query "logGroups[?logGroupName=='${LOG_GROUP_NAME}'].logGroupName" --output text)"
[ -z "${LOG_GROUP_LEFT}" ] ||
  { echo "FAIL: delivery log group ${LOG_GROUP_NAME} still exists after destroy" >&2; exit 1; }

cleanup
trap - EXIT INT TERM
# Again after the disarm: a log group the handler's delete-time invocation
# creates late must not outlive the PASS (#3885).
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
echo "[verify] PASS — an unnamed metric stream deployed under its generated name, updated in place, diff clean, destroy left nothing"
