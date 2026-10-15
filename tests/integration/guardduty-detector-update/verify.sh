#!/usr/bin/env bash
# verify.sh — cdkd GuardDuty detector Cloud Control update integ (go-to-k/cdkd#4910).
#
# AWS::GuardDuty::Detector has no SDK provider, so cdkd updates it through
# Cloud Control, which applies the patch on top of its read model. That model
# carries DataSources and the full Features list. Before the fix a scalar-only
# update failed (the read-back Features holds both runtime features), and so
# did a Features update (the read-back DataSources rode along).
#
# Phases:
#   1. Deploy a detector declaring only RDS_LOGIN_EVENTS. Require RDS_DATA_RISK
#      ENABLED (GuardDuty's default, so a reset to DISABLED is visible) and
#      record the status and additional configurations of every feature the
#      template omits.
#   2. Re-deploy with CDKD_TEST_UPDATE=scalar (FindingPublishingFrequency only).
#      Assert ONE_HOUR reached AWS, the id is unchanged, RDS_DATA_RISK is still
#      ENABLED, the omitted features are unchanged, and `cdkd drift` is clean.
#   3. Re-deploy with CDKD_TEST_UPDATE=scalar,features (adds EKS_AUDIT_LOGS:
#      DISABLED). Same assertions, plus EKS_AUDIT_LOGS is DISABLED.
#   4. Destroy; assert the detector and the state file are gone.
#   5. CDKD_TEST_SHAPE=datasources (DataSources only, S3Logs disabled): deploy,
#      scalar update, destroy. Assert ONE_HOUR, the same id, S3Logs still
#      DISABLED, every feature but RDS_LOGIN_EVENTS unchanged and a clean drift.
#   6. CDKD_TEST_SHAPE=bare (neither key declared): the same cycle.
#
# GuardDuty allows ONE detector per region. The run refuses (exit 1) when the
# region already holds a detector without this fixture's `cdkd-integ` tag, and
# cleanup only ever deletes a detector carrying that tag.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1; must hold no foreign detector

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
# Phases 1-4 deploy the default (Features) shape; 5 and 6 set it per command.
unset CDKD_TEST_SHAPE

STACK="CdkdGuarddutyDetectorUpdateExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TAG_VALUE="guardduty-detector-update"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Print every detector id in the region, one per line (strict: a failed list
# aborts the run rather than reading as "no detector").
detector_ids() {
  local out
  out="$(aws guardduty list-detectors --region "${REGION}" --query 'DetectorIds' --output text)" || return 1
  [ "${out}" = "None" ] && out=""
  printf '%s\n' ${out}
}

# Print the cdkd-integ tag value on detector $1 (empty when untagged).
detector_tag() {
  local account arn out
  account="$(aws sts get-caller-identity --query Account --output text)" || return 1
  arn="arn:$(aws_partition):guardduty:${REGION}:${account}:detector/$1"
  out="$(aws guardduty list-tags-for-resource --resource-arn "${arn}" --region "${REGION}" \
    --query 'Tags."cdkd-integ"' --output text)" || return 1
  [ "${out}" = "None" ] && out=""
  printf '%s' "${out}"
}
aws_partition() { case "${REGION}" in cn-*) echo aws-cn ;; us-gov-*) echo aws-us-gov ;; *) echo aws ;; esac; }

# "Name=Status;<additional configurations>" of every feature on detector $1
# except RDS_LOGIN_EVENTS and the names in $2 (a JMESPath condition suffix, e.g.
# " && Name!='EKS_AUDIT_LOGS'"), sorted, tab-separated on one line. The
# additional configurations are "Name:Status" pairs, sorted, comma-separated,
# so a reset of e.g. EKS_ADDON_MANAGEMENT shows too.
omitted_features() {
  aws guardduty get-detector --detector-id "$1" --region "${REGION}" \
    --query "sort_by(Features[?Name!='RDS_LOGIN_EVENTS'${2:-}], &Name)[].join('=', [Name, join(';', [Status, join(',', sort_by(AdditionalConfiguration || \`[]\`, &Name)[].join(':', [Name, Status]))])])" \
    --output text
}
NOT_EKS_AUDIT=" && Name!='EKS_AUDIT_LOGS'"

# get-detector field ($2 is a JMESPath query) on detector $1.
detector_field() {
  aws guardduty get-detector --detector-id "$1" --region "${REGION}" --query "$2" --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + this fixture's detector"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Delete ONLY a detector carrying this fixture's tag: the region may hold
  # the account's own detector, which this run must never touch.
  for id in $(aws guardduty list-detectors --region "${REGION}" --query 'DetectorIds' --output text 2>/dev/null); do
    [ "${id}" = "None" ] && continue
    if [ "$(detector_tag "${id}" 2>/dev/null)" = "${TAG_VALUE}" ]; then
      aws guardduty delete-detector --detector-id "${id}" --region "${REGION}" >/dev/null 2>&1
    fi
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

# Refuse BEFORE arming cleanup: a foreign detector means this region cannot
# host the fixture, and nothing of ours exists yet to tear down.
PRE_IDS="$(detector_ids)"
for id in ${PRE_IDS}; do
  TAG="$(detector_tag "${id}")"
  if [ "${TAG}" != "${TAG_VALUE}" ]; then
    echo "FAIL: ${REGION} already has a GuardDuty detector this fixture did not create; GuardDuty allows one per region. Re-run with AWS_REGION set to a region with no detector." >&2
    exit 1
  fi
done

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# Assert the in-place invariants every update phase shares.
#   $1 phase label
#   $2 the omitted-feature baseline to compare against
#   $3 the omitted_features exclusion matching that baseline
assert_updated_in_place() {
  local ids rds omitted
  ids="$(detector_ids)"
  if [ "${ids}" != "${DETECTOR_ID}" ]; then
    echo "FAIL: $1: expected only detector ${DETECTOR_ID}, got '${ids}' (replaced?)" >&2; exit 1
  fi
  rds="$(detector_field "${DETECTOR_ID}" "Features[?Name=='RDS_LOGIN_EVENTS'] | [0].AdditionalConfiguration[?Name=='RDS_DATA_RISK'] | [0].Status")"
  if [ "${rds}" != "ENABLED" ]; then
    echo "FAIL: $1: RDS_DATA_RISK changed from ENABLED to '${rds}'" >&2; exit 1
  fi
  omitted="$(omitted_features "${DETECTOR_ID}" "$3")"
  if [ "${omitted}" != "$2" ]; then
    echo "FAIL: $1: features the template omits changed: was '$2', now '${omitted}'" >&2; exit 1
  fi
  if ! node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
    echo "FAIL: $1: cdkd drift is not clean after the update" >&2; exit 1
  fi
}

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (Features: RDS_LOGIN_EVENTS)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

DETECTOR_ID="$(detector_ids)"
case "${DETECTOR_ID}" in
  ''|*[!0-9a-f]*) echo "FAIL: expected exactly one detector after Phase 1, got '${DETECTOR_ID}'" >&2; exit 1 ;;
esac
TAG="$(detector_tag "${DETECTOR_ID}")"
if [ "${TAG}" != "${TAG_VALUE}" ]; then
  echo "FAIL: the detector after Phase 1 does not carry the fixture tag" >&2; exit 1
fi
RDS_DATA_RISK_STATUS="$(detector_field "${DETECTOR_ID}" "Features[?Name=='RDS_LOGIN_EVENTS'] | [0].AdditionalConfiguration[?Name=='RDS_DATA_RISK'] | [0].Status")"
if [ "${RDS_DATA_RISK_STATUS}" != "ENABLED" ]; then
  echo "FAIL: premise: expected GuardDuty to enable RDS_DATA_RISK on create, got '${RDS_DATA_RISK_STATUS}'" >&2; exit 1
fi
# Phase 2 omits every feature but RDS_LOGIN_EVENTS; Phase 3 also declares
# EKS_AUDIT_LOGS, so its baseline leaves that one out.
OMITTED_P2="$(omitted_features "${DETECTOR_ID}")"
OMITTED_P3="$(omitted_features "${DETECTOR_ID}" "${NOT_EKS_AUDIT}")"
# The additional-configuration half of the comparison is vacuous unless some
# omitted feature carries one ("Name:Status" after the ';').
if [[ "${OMITTED_P2}" != *';'*':'* ]]; then
  echo "FAIL: premise: no omitted feature carries an additional configuration, got '${OMITTED_P2}'" >&2; exit 1
fi
# Both runtime features must be in the read model: that pair is what
# UpdateDetector refuses on a scalar-only patch.
if [[ $'\t'"${OMITTED_P2}"$'\t' != *$'\t'EKS_RUNTIME_MONITORING=* ]] \
  || [[ $'\t'"${OMITTED_P2}"$'\t' != *$'\t'RUNTIME_MONITORING=* ]]; then
  echo "FAIL: premise: expected both EKS_RUNTIME_MONITORING and RUNTIME_MONITORING in the read model, got '${OMITTED_P2}'" >&2; exit 1
fi
F="$(detector_field "${DETECTOR_ID}" FindingPublishingFrequency)"
if [ "${F}" = "ONE_HOUR" ]; then
  echo "FAIL: premise: FindingPublishingFrequency is already ONE_HOUR before Phase 2" >&2; exit 1
fi
EKS="$(detector_field "${DETECTOR_ID}" "Features[?Name=='EKS_AUDIT_LOGS'] | [0].Status")"
if [ "${EKS}" != "ENABLED" ]; then
  echo "FAIL: premise: expected EKS_AUDIT_LOGS ENABLED before Phase 3 sets it DISABLED, got '${EKS}'" >&2; exit 1
fi
echo "    detector created; RDS_DATA_RISK=${RDS_DATA_RISK_STATUS}; omitted: ${OMITTED_P2}"

# --- Phase 2: scalar-only update -----------------------------------------
echo "==> Phase 2: re-deploy with FindingPublishingFrequency: ONE_HOUR"
CDKD_TEST_UPDATE=scalar node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

F="$(detector_field "${DETECTOR_ID}" FindingPublishingFrequency)"
if [ "${F}" != "ONE_HOUR" ]; then
  echo "FAIL: Phase 2: FindingPublishingFrequency is '${F}', expected ONE_HOUR" >&2; exit 1
fi
assert_updated_in_place "Phase 2" "${OMITTED_P2}" ""
echo "    scalar update applied in place"

# --- Phase 3: Features update --------------------------------------------
echo "==> Phase 3: re-deploy adding EKS_AUDIT_LOGS: DISABLED"
CDKD_TEST_UPDATE=scalar,features node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

EKS="$(detector_field "${DETECTOR_ID}" "Features[?Name=='EKS_AUDIT_LOGS'] | [0].Status")"
if [ "${EKS}" != "DISABLED" ]; then
  echo "FAIL: Phase 3: EKS_AUDIT_LOGS is '${EKS}', expected DISABLED" >&2; exit 1
fi
F="$(detector_field "${DETECTOR_ID}" FindingPublishingFrequency)"
if [ "${F}" != "ONE_HOUR" ]; then
  echo "FAIL: Phase 3: FindingPublishingFrequency is '${F}', expected ONE_HOUR" >&2; exit 1
fi
assert_updated_in_place "Phase 3" "${OMITTED_P3}" "${NOT_EKS_AUDIT}"
echo "    Features update applied in place"

# --- Phase 4: destroy --------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

LEFT="$(detector_ids)"
if [ -n "${LEFT}" ]; then
  echo "FAIL: a detector still exists in ${REGION} after destroy" >&2; exit 1
fi
echo "    detector deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# --- Phases 5-6: the other template shapes ------------------------------
# $1 phase label, $2 CDKD_TEST_SHAPE value
shape_cycle() {
  local id f s3 ids left tag omitted after
  echo "==> $1: deploy CDKD_TEST_SHAPE=$2"
  env -u CDKD_TEST_UPDATE CDKD_TEST_SHAPE="$2" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  id="$(detector_ids)"
  case "${id}" in
    ''|*[!0-9a-f]*) echo "FAIL: $1: expected exactly one detector after deploy, got '${id}'" >&2; exit 1 ;;
  esac
  tag="$(detector_tag "${id}")"
  if [ "${tag}" != "${TAG_VALUE}" ]; then
    echo "FAIL: $1: the detector does not carry the fixture tag" >&2; exit 1
  fi
  f="$(detector_field "${id}" FindingPublishingFrequency)"
  if [ "${f}" = "ONE_HOUR" ]; then
    echo "FAIL: $1: premise: FindingPublishingFrequency is already ONE_HOUR" >&2; exit 1
  fi
  if [ "$2" = "datasources" ]; then
    s3="$(detector_field "${id}" DataSources.S3Logs.Status)"
    if [ "${s3}" != "DISABLED" ]; then
      echo "FAIL: $1: premise: expected the declared S3Logs DISABLED, got '${s3}'" >&2; exit 1
    fi
  fi
  # This shape declares no Features, so every feature but RDS_LOGIN_EVENTS is
  # compared, and the runtime pair must be in the read model (as in Phase 1).
  omitted="$(omitted_features "${id}")"
  if [[ $'\t'"${omitted}"$'\t' != *$'\t'EKS_RUNTIME_MONITORING=* ]] \
    || [[ $'\t'"${omitted}"$'\t' != *$'\t'RUNTIME_MONITORING=* ]]; then
    echo "FAIL: $1: premise: expected both EKS_RUNTIME_MONITORING and RUNTIME_MONITORING in the read model, got '${omitted}'" >&2; exit 1
  fi

  echo "==> $1: scalar update"
  CDKD_TEST_SHAPE="$2" CDKD_TEST_UPDATE=scalar node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
  f="$(detector_field "${id}" FindingPublishingFrequency)"
  if [ "${f}" != "ONE_HOUR" ]; then
    echo "FAIL: $1: FindingPublishingFrequency is '${f}', expected ONE_HOUR" >&2; exit 1
  fi
  ids="$(detector_ids)"
  if [ "${ids}" != "${id}" ]; then
    echo "FAIL: $1: expected only detector ${id}, got '${ids}' (replaced?)" >&2; exit 1
  fi
  if [ "$2" = "datasources" ]; then
    s3="$(detector_field "${id}" DataSources.S3Logs.Status)"
    if [ "${s3}" != "DISABLED" ]; then
      echo "FAIL: $1: S3Logs changed from DISABLED to '${s3}'" >&2; exit 1
    fi
  fi
  after="$(omitted_features "${id}")"
  if [ "${after}" != "${omitted}" ]; then
    echo "FAIL: $1: features changed: was '${omitted}', now '${after}'" >&2; exit 1
  fi
  if ! node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
    echo "FAIL: $1: cdkd drift is not clean after the update" >&2; exit 1
  fi

  echo "==> $1: destroy"
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
  left="$(detector_ids)"
  if [ -n "${left}" ]; then
    echo "FAIL: $1: a detector still exists in ${REGION} after destroy" >&2; exit 1
  fi
  echo "    $2 shape updated in place and destroyed"
}
shape_cycle "Phase 5" datasources
shape_cycle "Phase 6" bare

assert_gone "state file ${STATE_KEY} still exists after the shape phases" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
echo "[verify] PASS — GuardDuty detector Cloud Control update, all 6 phases passed"
