#!/usr/bin/env bash
# verify.sh — cdkd Glue update/delete hardening integ test.
#
# Exercises the four Glue provider fixes:
#   1. Job stringly-typed numeric coercion — Timeout / NumberOfWorkers /
#      MaxRetries / ExecutionProperty.MaxConcurrentRuns are synthed as STRINGS
#      in the template; the provider must coerce them to numbers so the Glue
#      SDK accepts them. Asserted via `aws glue get-job` returning real numbers.
#   2. Crawler running-state delete handling (unit-tested; here the crawler is
#      idle so it just creates + deletes).
#   3. Trigger state-machine (unit-tested; the ON_DEMAND trigger create+delete
#      is exercised here).
#   4. Workflow Tags from a MAP shape reaching AWS — asserted via
#      `aws glue get-tags` on the workflow ARN.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

STACK="GlueUpdateHardeningStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOWER="$(echo "${STACK}" | tr '[:upper:]' '[:lower:]')"
JOB_NAME_FALLBACK="${LOWER}-etl-job"
WORKFLOW_NAME_FALLBACK="${LOWER}-workflow"
CRAWLER_NAME_FALLBACK="${LOWER}-crawler"
TRIGGER_NAME_FALLBACK="${LOWER}-trigger"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  local destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --yes \
      --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
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

# --- Phase 1: deploy --------------------------------------------------
# Force the base (non-update) synth even if the caller exported
# CDKD_TEST_UPDATE=true — the update path is exercised unconditionally in
# Phase 2 below, so Phase 1 must always create the base shape (Job.Timeout 60).
echo "==> Phase 1: deploy with the local binary"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

JOB_NAME=$(echo "${STATE}" | jq -r '.outputs.JobName // empty')
[ -z "${JOB_NAME}" ] && JOB_NAME="${JOB_NAME_FALLBACK}"
WORKFLOW_NAME=$(echo "${STATE}" | jq -r '.outputs.WorkflowName // empty')
[ -z "${WORKFLOW_NAME}" ] && WORKFLOW_NAME="${WORKFLOW_NAME_FALLBACK}"
CRAWLER_NAME=$(echo "${STATE}" | jq -r '.outputs.CrawlerName // empty')
[ -z "${CRAWLER_NAME}" ] && CRAWLER_NAME="${CRAWLER_NAME_FALLBACK}"
TRIGGER_NAME=$(echo "${STATE}" | jq -r '.outputs.TriggerName // empty')
[ -z "${TRIGGER_NAME}" ] && TRIGGER_NAME="${TRIGGER_NAME_FALLBACK}"

echo "    Using job '${JOB_NAME}', workflow '${WORKFLOW_NAME}', crawler '${CRAWLER_NAME}', trigger '${TRIGGER_NAME}'"

# --- Assertion 1: Job numeric props reached AWS as NUMBERS ------------
# The provider's numeric-coercion fix sends real numbers to the Glue SDK.
# `aws glue get-job` returns JSON numbers — jq `type` confirms they are numbers
# (not strings) and the values match the fixture. (The string-INPUT coercion
# path is unit-tested; CDK's L1 validator rejects string numerics at synth.)
JOB_JSON=$(aws glue get-job --job-name "${JOB_NAME}" --region "${REGION}" 2>/dev/null)
if [ -z "${JOB_JSON}" ]; then
  echo "FAIL: get-job returned nothing for ${JOB_NAME}" >&2
  exit 1
fi

assert_number() {
  local path="$1" expected="$2" label="$3"
  local typ val
  typ=$(echo "${JOB_JSON}" | jq -r "${path} | type")
  val=$(echo "${JOB_JSON}" | jq -r "${path}")
  if [ "${typ}" != "number" ]; then
    echo "FAIL: ${label} is type '${typ}' (value '${val}'), expected number — numeric coercion NOT applied" >&2
    exit 1
  fi
  if [ "${val}" != "${expected}" ]; then
    echo "FAIL: ${label} is ${val}, expected ${expected}" >&2
    exit 1
  fi
  echo "    OK: ${label} == ${val} (number)"
}

assert_number '.Job.Timeout' '60' 'Job.Timeout'
assert_number '.Job.NumberOfWorkers' '2' 'Job.NumberOfWorkers'
assert_number '.Job.MaxRetries' '1' 'Job.MaxRetries'
assert_number '.Job.ExecutionProperty.MaxConcurrentRuns' '2' 'Job.ExecutionProperty.MaxConcurrentRuns'

# --- Assertion 2: Workflow tags (MAP shape) reached AWS ---------------
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
WF_ARN="arn:aws:glue:${REGION}:${ACCOUNT_ID}:workflow/${WORKFLOW_NAME}"
WF_TAGS=$(aws glue get-tags --resource-arn "${WF_ARN}" --region "${REGION}" 2>/dev/null \
  --query 'Tags' --output json || echo "{}")
ENV_TAG=$(echo "${WF_TAGS}" | jq -r '.env // empty')
TEAM_TAG=$(echo "${WF_TAGS}" | jq -r '."team" // empty')
if [ "${ENV_TAG}" != "integ" ] || [ "${TEAM_TAG}" != "data-platform" ]; then
  echo "FAIL: Workflow tags missing/wrong on AWS (env='${ENV_TAG}', team='${TEAM_TAG}'); MAP-shape tags were silently dropped" >&2
  echo "${WF_TAGS}" >&2
  exit 1
fi
echo "    OK: Workflow MAP-shape tags reached AWS (env=integ, team=data-platform)"

# --- Sanity: crawler + trigger exist ----------------------------------
if aws glue get-crawler --name "${CRAWLER_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "    OK: crawler ${CRAWLER_NAME} exists"
else
  echo "FAIL: crawler ${CRAWLER_NAME} missing" >&2
  exit 1
fi
if aws glue get-trigger --name "${TRIGGER_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "    OK: trigger ${TRIGGER_NAME} exists"
else
  echo "FAIL: trigger ${TRIGGER_NAME} missing" >&2
  exit 1
fi

# --- Phase 2: UPDATE --------------------------------------------------
# Always exercise the update path (the whole point of "update hardening") by
# inlining CDKD_TEST_UPDATE=true on THIS deploy only — matching the
# dynamodb-ondemand Phase 1.5 convention. Gating the phase on a caller-set env
# would (a) skip the update test on a plain `bash verify.sh` run and (b) make
# Phase 1's base-shape deploy synth the updated values, so the env must be
# controlled per-phase, not globally.
echo "==> Phase 2: re-deploy with CDKD_TEST_UPDATE=true (trigger desc + job timeout)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
NEW_TIMEOUT=$(aws glue get-job --job-name "${JOB_NAME}" --region "${REGION}" \
  --query 'Job.Timeout' --output text 2>/dev/null || echo "")
if [ "${NEW_TIMEOUT}" != "90" ]; then
  echo "FAIL: Job.Timeout after update is '${NEW_TIMEOUT}', expected 90 (update numeric coercion failed)" >&2
  exit 1
fi
echo "    OK: Job.Timeout updated to 90 (number)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

for chk in \
  "get-job --job-name ${JOB_NAME}" \
  "get-crawler --name ${CRAWLER_NAME}" \
  "get-trigger --name ${TRIGGER_NAME}" \
  "get-workflow --name ${WORKFLOW_NAME}"; do
  # shellcheck disable=SC2086
  if aws glue ${chk} --region "${REGION}" >/dev/null 2>&1; then
    echo "FAIL: Glue resource still exists after destroy: ${chk}" >&2
    exit 1
  fi
done
echo "    OK: all Glue resources are gone"

if aws s3 ls "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1; then
  echo "FAIL: state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" >&2
  exit 1
fi
echo "    OK: state file is gone"

echo ""
echo "==> glue-update-hardening test passed (numeric coercion + MAP tags + clean destroy)"
