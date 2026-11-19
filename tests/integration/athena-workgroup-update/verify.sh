#!/usr/bin/env bash
# verify.sh -- cdkd Athena WorkGroup configuration UPDATE integ (issue #6561).
# The workgroup (Cloud Control route) never declares
# WorkGroupConfiguration.EngineVersion; AWS fills it in at create. A
# configuration change is one op writing the whole WorkGroupConfiguration,
# and Cloud Control refused it for dropping the read-only
# EngineVersion.EffectiveEngineVersion. Phases: deploy -> UPDATE (output
# location, cutoff, enforcement, description, tags; EngineVersion must stay as
# AWS holds it, the workgroup must not be replaced) -> declare EngineVersion
# -> remove it again (SelectedEngineVersion back to AUTO, as CloudFormation
# does, the read-only leaf kept) -> destroy.

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

STACK="CdkdAthenaWorkgroupUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
WG="${STACK}-wg"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after Phase 1 from the stack output.
RESULTS_BUCKET=""

sweep_log_groups() {
  for lg in $(aws logs describe-log-groups \
    --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
    --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws athena delete-work-group --work-group "${WG}" --recursive-delete-option --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${RESULTS_BUCKET}" ]; then
    aws s3 rb "s3://${RESULTS_BUCKET}" --force >/dev/null 2>&1 || true
  fi
  sweep_log_groups
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first (vp run build)" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

wg_field() { # usage: wg_field <jmespath under WorkGroup>
  aws athena get-work-group --work-group "${WG}" --region "${REGION}" \
    --query "WorkGroup.$1" --output text
}

ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
WG_ARN="arn:aws:athena:${REGION}:${ACCOUNT}:workgroup/${WG}"
wg_tag() { # usage: wg_tag <key>  -> its value, or None
  aws athena list-tags-for-resource --resource-arn "${WG_ARN}" --region "${REGION}" \
    --query "Tags[?Key=='$1'].Value | [0]" --output text
}

echo "==> Phase 1: Deploy (base configuration, no EngineVersion declared)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_ENGINE \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RESULTS_BUCKET="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | jq -r '.outputs.ResultsBucketName // empty')"
[ -n "${RESULTS_BUCKET}" ] || { echo "FAIL: no ResultsBucketName output in state" >&2; exit 1; }
WG_BY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null \
  | jq -r '[.resources[] | select(.resourceType == "AWS::Athena::WorkGroup") | .provisionedBy // "<absent>"] | first // "<none>"')"
[ "${WG_BY}" = "cc-api" ] || { echo "FAIL: premise: the workgroup is provisioned by '${WG_BY}', not Cloud Control (the #6561 route)" >&2; exit 1; }

OUT_LOC=$(wg_field 'Configuration.ResultConfiguration.OutputLocation')
CUTOFF=$(wg_field 'Configuration.BytesScannedCutoffPerQuery')
ENFORCE=$(wg_field 'Configuration.EnforceWorkGroupConfiguration')
[ "${OUT_LOC}" = "s3://${RESULTS_BUCKET}/results/" ] || { echo "FAIL: base OutputLocation is '${OUT_LOC}'" >&2; exit 1; }
[ "${CUTOFF}" = "10000000" ] || { echo "FAIL: base BytesScannedCutoffPerQuery is '${CUTOFF}'" >&2; exit 1; }
[ "${ENFORCE}" = "True" ] || { echo "FAIL: base EnforceWorkGroupConfiguration is '${ENFORCE}'" >&2; exit 1; }
SELECTED=$(wg_field 'Configuration.EngineVersion.SelectedEngineVersion')
EFFECTIVE=$(wg_field 'Configuration.EngineVersion.EffectiveEngineVersion')
CREATED=$(wg_field 'CreationTime')
# The arm's premise: AWS filled in an EngineVersion the template never declared.
case "${EFFECTIVE}" in
  "" | None) echo "FAIL: premise: AWS holds no EffectiveEngineVersion (got '${EFFECTIVE}')" >&2; exit 1 ;;
esac
echo "    OK: base workgroup (EngineVersion ${SELECTED} / ${EFFECTIVE}, created ${CREATED})"

echo "==> Phase 2: UPDATE (configuration, description, tags) -- the #6561 refused patch"
env -u CDKD_TEST_ENGINE CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

OUT_LOC=$(wg_field 'Configuration.ResultConfiguration.OutputLocation')
CUTOFF=$(wg_field 'Configuration.BytesScannedCutoffPerQuery')
ENFORCE=$(wg_field 'Configuration.EnforceWorkGroupConfiguration')
DESC=$(wg_field 'Description')
[ "${OUT_LOC}" = "s3://${RESULTS_BUCKET}/results-v2/" ] || { echo "FAIL: updated OutputLocation is '${OUT_LOC}'" >&2; exit 1; }
[ "${CUTOFF}" = "20000000" ] || { echo "FAIL: updated BytesScannedCutoffPerQuery is '${CUTOFF}'" >&2; exit 1; }
[ "${ENFORCE}" = "False" ] || { echo "FAIL: updated EnforceWorkGroupConfiguration is '${ENFORCE}'" >&2; exit 1; }
[ "${DESC}" = "cdkd athena workgroup update (updated)" ] || { echo "FAIL: updated Description is '${DESC}'" >&2; exit 1; }
[ "$(wg_tag phase)" = "updated" ] || { echo "FAIL: tag phase is '$(wg_tag phase)'" >&2; exit 1; }
[ "$(wg_tag added)" = "yes" ] || { echo "FAIL: tag added is '$(wg_tag added)'" >&2; exit 1; }
echo "    OK: the configuration, description and tags reached AWS"

AFTER_SELECTED=$(wg_field 'Configuration.EngineVersion.SelectedEngineVersion')
AFTER_EFFECTIVE=$(wg_field 'Configuration.EngineVersion.EffectiveEngineVersion')
[ "${AFTER_SELECTED}" = "${SELECTED}" ] && [ "${AFTER_EFFECTIVE}" = "${EFFECTIVE}" ] || {
  echo "FAIL: EngineVersion changed across the update (${SELECTED} / ${EFFECTIVE} -> ${AFTER_SELECTED} / ${AFTER_EFFECTIVE}); the template never declared it" >&2
  exit 1
}
[ "$(wg_field 'CreationTime')" = "${CREATED}" ] || { echo "FAIL: the workgroup was replaced (CreationTime changed)" >&2; exit 1; }
echo "    OK: EngineVersion intact, updated in place"

echo "==> Phase 3: UPDATE (the template declares EngineVersion)"
CDKD_TEST_UPDATE=true CDKD_TEST_ENGINE=declare \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SELECTED=$(wg_field 'Configuration.EngineVersion.SelectedEngineVersion')
[ "${SELECTED}" = "Athena engine version 3" ] || { echo "FAIL: declared SelectedEngineVersion is '${SELECTED}'" >&2; exit 1; }
echo "    OK: declared EngineVersion reached AWS (${SELECTED})"

echo "==> Phase 4: UPDATE (the template removes EngineVersion) -- the #6561 removed-block patch"
env -u CDKD_TEST_ENGINE CDKD_TEST_UPDATE=true \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

SELECTED=$(wg_field 'Configuration.EngineVersion.SelectedEngineVersion')
EFFECTIVE=$(wg_field 'Configuration.EngineVersion.EffectiveEngineVersion')
# CloudFormation (AWS CDK CLI A/B, measured in #6561) resets the removed
# SelectedEngineVersion to AUTO and keeps the read-only leaf.
[ "${SELECTED}" = "AUTO" ] || { echo "FAIL: SelectedEngineVersion after removal is '${SELECTED}' (CloudFormation resets it to AUTO)" >&2; exit 1; }
case "${EFFECTIVE}" in
  "" | None) echo "FAIL: EffectiveEngineVersion is gone after removal (got '${EFFECTIVE}')" >&2; exit 1 ;;
esac
[ "$(wg_field 'CreationTime')" = "${CREATED}" ] || { echo "FAIL: the workgroup was replaced (CreationTime changed)" >&2; exit 1; }
echo "    OK: EngineVersion removed in place (${SELECTED} / ${EFFECTIVE})"

echo "==> Phase 5: Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "workgroup ${WG} still exists after destroy" aws athena get-work-group --work-group "${WG}" --region "${REGION}"
echo "    OK: workgroup gone"
assert_gone "bucket ${RESULTS_BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${RESULTS_BUCKET}" --region "${REGION}"
echo "    OK: results bucket gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"
# Lambda auto-creates /aws/lambda/* log groups on invoke; sweep so orphan-zero.
sweep_log_groups
echo "    OK: lambda log groups swept"

echo "[verify] PASS -- Athena workgroup configuration updated in place, EngineVersion intact, declared then removed, clean destroy"
