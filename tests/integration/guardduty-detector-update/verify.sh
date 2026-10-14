#!/usr/bin/env bash
# verify.sh — cdkd GuardDuty detector Cloud Control update integ (go-to-k/cdkd#4910).
#
# AWS::GuardDuty::Detector has no SDK provider, so cdkd updates it through
# Cloud Control, which applies the patch on top of its read model. That model
# carries DataSources and the full Features list, both of which UpdateDetector
# refuses beside the declared Features; before the fix every update failed.
#
# Phases:
#   1. Deploy a detector declaring only RDS_LOGIN_EVENTS. Require RDS_DATA_RISK
#      ENABLED (GuardDuty's default, so a reset to DISABLED is visible) and
#      record the status of every feature the template omits.
#   2. Re-deploy with CDKD_TEST_UPDATE=scalar (FindingPublishingFrequency only).
#      Assert ONE_HOUR reached AWS, the id is unchanged, RDS_DATA_RISK is still
#      ENABLED, the omitted features are unchanged, and `cdkd drift` is clean.
#   3. Re-deploy with CDKD_TEST_UPDATE=scalar,features (adds EKS_AUDIT_LOGS:
#      DISABLED). Same assertions, plus EKS_AUDIT_LOGS is DISABLED.
#   4. Destroy; assert the detector and the state file are gone.
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

# "Name=Status" of every feature the template never declares, sorted, one line.
omitted_features() {
  aws guardduty get-detector --detector-id "$1" --region "${REGION}" \
    --query "sort_by(Features[?Name!='RDS_LOGIN_EVENTS' && Name!='EKS_AUDIT_LOGS'], &Name)[].join('=', [Name, Status])" \
    --output text
}

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
  omitted="$(omitted_features "${DETECTOR_ID}")"
  if [ "${omitted}" != "${OMITTED_FEATURES}" ]; then
    echo "FAIL: $1: features the template omits changed: was '${OMITTED_FEATURES}', now '${omitted}'" >&2; exit 1
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
OMITTED_FEATURES="$(omitted_features "${DETECTOR_ID}")"
case "${OMITTED_FEATURES}" in
  *RUNTIME_MONITORING=*) ;;
  *) echo "FAIL: premise: expected the read model to list omitted features, got '${OMITTED_FEATURES}'" >&2; exit 1 ;;
esac
F="$(detector_field "${DETECTOR_ID}" FindingPublishingFrequency)"
if [ "${F}" = "ONE_HOUR" ]; then
  echo "FAIL: premise: FindingPublishingFrequency is already ONE_HOUR before Phase 2" >&2; exit 1
fi
EKS="$(detector_field "${DETECTOR_ID}" "Features[?Name=='EKS_AUDIT_LOGS'] | [0].Status")"
if [ "${EKS}" = "DISABLED" ]; then
  echo "FAIL: premise: EKS_AUDIT_LOGS is already DISABLED before Phase 3" >&2; exit 1
fi
echo "    detector created; RDS_DATA_RISK=${RDS_DATA_RISK_STATUS}; omitted: ${OMITTED_FEATURES}"

# --- Phase 2: scalar-only update -----------------------------------------
echo "==> Phase 2: re-deploy with FindingPublishingFrequency: ONE_HOUR"
CDKD_TEST_UPDATE=scalar node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

F="$(detector_field "${DETECTOR_ID}" FindingPublishingFrequency)"
if [ "${F}" != "ONE_HOUR" ]; then
  echo "FAIL: Phase 2: FindingPublishingFrequency is '${F}', expected ONE_HOUR" >&2; exit 1
fi
assert_updated_in_place "Phase 2"
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
assert_updated_in_place "Phase 3"
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

trap - EXIT INT TERM
echo "[verify] PASS — GuardDuty detector Cloud Control update, all 4 phases passed"
