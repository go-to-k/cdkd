#!/usr/bin/env bash
# verify.sh -- LaunchTemplate + AutoScalingGroup in-place GetAtt propagation
# (issue #985) + UPDATE property-removal reset (issue #1160).
#
# Issue #985 leg: the ASG's LaunchTemplate.Version is Fn::GetAtt [Lt,
# LatestVersionNumber]. An in-place edit of the LaunchTemplate's instanceType
# (t3.micro -> t3.small under CDKD_TEST_UPDATE=true) bumps the LaunchTemplate's
# computed LatestVersionNumber 1 -> 2. Before the fix the ASG was classified
# NO_CHANGE (its raw template did not change and diff-time resolution saw the
# pre-update version "1"), so it stayed pinned at version "1" and only caught up
# on the NEXT deploy.
#
# Issue #1160 leg: phases 1-2 set non-default HealthCheckGracePeriod (90) /
# MaxInstanceLifetime (604800) / TerminationPolicies (['OldestInstance']) on the
# ASG; the removal phase (CDKD_TEST_REMOVAL=true) drops them from the template.
# UpdateAutoScalingGroup has merge semantics (absent = unchanged), so pre-fix
# the live values silently survived the removal.
#
# This test asserts:
#   1. Phase 1: the LaunchTemplate is at version 1, the ASG's live
#      LaunchTemplate.Version resolves to "1", the three non-default ASG
#      properties are live, and the group metrics and SNS notifications are
#      live after this FIRST deploy (issue #3995: create never sent them).
#   2. UPDATE phase (change only instanceType): the LaunchTemplate advances to
#      version 2 AND the ASG's live LaunchTemplate.Version is "2" in the SAME
#      deploy (NOT "1" -- the #985 symptom is a one-deploy-behind "1"). The
#      three non-default ASG properties are still live (kept, not reset).
#   3. REMOVAL phase (drop the three ASG properties): the live values return to
#      the CFn defaults -- HealthCheckGracePeriod 0, MaxInstanceLifetime
#      cleared, TerminationPolicies ['Default'] (issue #1160).
# Then destroys and confirms a clean teardown.
#
# desiredCapacity is 0 so no EC2 instances launch (cheap deploy, fast destroy).
#
# Required env vars:
#   STATE_BUCKET -- cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   -- defaults to us-east-1

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

STACK="LaunchTemplateAsgInplaceStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LT_NAME="cdkd-lt-asg-inplace"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # A planted #4013 state record goes back BEFORE anything else reads it.
  if [ "${STATE_PLANTED:-0}" = 1 ] && [ -s "${STATE_ORIG:-}" ]; then
    aws s3 cp "${STATE_ORIG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1
  fi
  for tmp in "${STATE_ORIG:-}" "${STATE_LEGACY:-}" "${DRIFT_JSON:-}" "${DRIFT_ERR:-}"; do
    [ -n "${tmp}" ] && rm -f "${tmp}"
  done
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Read the ASG's live LaunchTemplate.Version. CDK auto-names the ASG, so resolve
# it from state by type. The physical id IS the ASG name.
asg_version() {
  local asg_name="$1"
  aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "${asg_name}" --region "${REGION}" \
    --query 'AutoScalingGroups[0].LaunchTemplate.Version' --output text 2>/dev/null
}

lt_latest_version() {
  aws ec2 describe-launch-templates \
    --launch-template-names "${LT_NAME}" --region "${REGION}" \
    --query 'LaunchTemplates[0].LatestVersionNumber' --output text 2>/dev/null
}

# Read the issue #1160 removal-leg properties in one call. Prints ONE
# tab-separated line: HealthCheckGracePeriod, MaxInstanceLifetime (the literal
# string "None" when AWS omits the field = no max lifetime), and the
# comma-joined TerminationPolicies list.
asg_removal_props() {
  local asg_name="$1"
  aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "${asg_name}" --region "${REGION}" \
    --query 'AutoScalingGroups[0].[HealthCheckGracePeriod, MaxInstanceLifetime, join(`,`, TerminationPolicies)]' \
    --output text
}

# Assert the three #1160 properties hold their phase 1-2 non-default values.
assert_nondefault_props() {
  local phase="$1" asg_name="$2" grace lifetime policies
  read -r grace lifetime policies < <(asg_removal_props "${asg_name}")
  if [ "${grace}" != "90" ] || [ "${lifetime}" != "604800" ] || [ "${policies}" != "OldestInstance" ]; then
    echo "FAIL: ${phase}: expected HealthCheckGracePeriod=90 / MaxInstanceLifetime=604800 / TerminationPolicies=OldestInstance, got '${grace}' / '${lifetime}' / '${policies}'" >&2
    exit 1
  fi
  echo "    OK: ${phase}: non-default ASG props live (grace=90, lifetime=604800, policies=OldestInstance)"
}

# The ASG's enabled metrics, sorted and space-joined (order-insensitive).
enabled_metrics() {
  aws autoscaling describe-auto-scaling-groups \
    --auto-scaling-group-names "$1" --region "${REGION}" \
    --query "join(' ', sort(AutoScalingGroups[0].EnabledMetrics[].Metric || \`[]\`))" --output text
}

# `cdkd drift --json` for this stack into ${DRIFT_JSON}, refusing a report that
# would make the assertions below vacuous (no parseable JSON, no stack). The
# exit status is not the assertion: drift exits 1 on ANY drifted resource, and
# a "drift unknown" resource exits 0.
run_drift_json() { # $1 = label
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json >"${DRIFT_JSON}" 2>"${DRIFT_ERR}" || true
  if ! jq empty "${DRIFT_JSON}" >/dev/null 2>&1; then
    echo "FAIL: cdkd drift --json ($1) produced no parseable JSON report:" >&2
    cat "${DRIFT_JSON}" >&2
    tail -20 "${DRIFT_ERR}" >&2
    exit 1
  fi
  if [ "$(jq -r 'if type == "array" and length > 0 then "yes" else "no" end' "${DRIFT_JSON}")" != "yes" ]; then
    echo "FAIL: cdkd drift --json ($1) reported no stacks — the assertions below would be vacuous:" >&2
    cat "${DRIFT_JSON}" >&2
    tail -20 "${DRIFT_ERR}" >&2
    exit 1
  fi
}
asg_drift_count() { # $1 = bucket (clean|drifted|notSupported)
  jq --arg b "$1" '[.[][$b][] | select(.type == "AWS::AutoScaling::AutoScalingGroup")] | length' "${DRIFT_JSON}"
}
assert_asg_drift_clean() { # $1 = label
  run_drift_json "$1"
  if [ "$(asg_drift_count drifted)" != "0" ] || [ "$(asg_drift_count notSupported)" != "0" ]; then
    echo "FAIL: $1: cdkd drift did not report the ASG clean:" >&2
    jq '[.[].drifted[], .[].notSupported[] | select(.type == "AWS::AutoScaling::AutoScalingGroup")]' "${DRIFT_JSON}" >&2
    exit 1
  fi
  if [ "$(asg_drift_count clean)" != "1" ]; then
    echo "FAIL: $1: the ASG appears in no drift outcome bucket — the assertion checked nothing" >&2
    cat "${DRIFT_JSON}" >&2
    exit 1
  fi
  echo "    OK: $1: cdkd drift reports the ASG clean"
}

# --- Phase 1: deploy (base) -------------------------------------------
echo "==> Phase 1: deploy with the local binary (LT v1)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

ASG_NAME=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .value.physicalId] | first')
if [ -z "${ASG_NAME}" ] || [ "${ASG_NAME}" = "null" ]; then
  echo "FAIL: could not resolve AutoScalingGroup physical id from state" >&2
  echo "${STATE}" | jq .
  exit 1
fi
echo "    resolved ASG name: ${ASG_NAME}"
TOPIC_ARN=$(echo "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::SNS::Topic") | .value.physicalId] | first')
if [ -z "${TOPIC_ARN}" ] || [ "${TOPIC_ARN}" = "null" ]; then
  echo "FAIL: could not resolve the notification SNS topic ARN from state" >&2
  exit 1
fi

LT_V1=$(lt_latest_version)
if [ "${LT_V1}" != "1" ]; then
  echo "FAIL: LaunchTemplate LatestVersionNumber is '${LT_V1}', expected '1' after Phase 1" >&2
  exit 1
fi
echo "    OK: LaunchTemplate LatestVersionNumber == 1"

ASG_V1=$(asg_version "${ASG_NAME}")
if [ "${ASG_V1}" != "1" ]; then
  echo "FAIL: ASG LaunchTemplate.Version is '${ASG_V1}', expected '1' after Phase 1" >&2
  exit 1
fi
echo "    OK: ASG LaunchTemplate.Version == 1"

# Issue #1160 baseline: the three non-default properties must be live.
assert_nondefault_props "Phase 1" "${ASG_NAME}"

# Issue #3995: MetricsCollection / NotificationConfigurations are not
# CreateAutoScalingGroup members, so before the fix a FIRST deploy left both
# unset (only a later update sent them). Assert both are live after Phase 1,
# which is a pure create.
ENABLED_METRICS=$(enabled_metrics "${ASG_NAME}")
if [ "${ENABLED_METRICS}" != "GroupDesiredCapacity GroupMaxSize GroupMinSize" ]; then
  echo "FAIL: Phase 1: expected EnabledMetrics 'GroupDesiredCapacity GroupMaxSize GroupMinSize' (both GroupMetrics entries) after the first deploy, got '${ENABLED_METRICS}' (issue #3995)" >&2
  exit 1
fi
echo "    OK: Phase 1: EnabledMetrics == GroupDesiredCapacity GroupMaxSize GroupMinSize (issue #3995)"
NOTIFICATION_TYPES=$(aws autoscaling describe-notification-configurations \
  --auto-scaling-group-names "${ASG_NAME}" --region "${REGION}" \
  --query "join(' ', sort(NotificationConfigurations[].NotificationType || \`[]\`))" --output text)
if [ "${NOTIFICATION_TYPES}" != "autoscaling:EC2_INSTANCE_LAUNCH autoscaling:EC2_INSTANCE_TERMINATE" ]; then
  echo "FAIL: Phase 1: expected notification types 'autoscaling:EC2_INSTANCE_LAUNCH autoscaling:EC2_INSTANCE_TERMINATE' after the first deploy, got '${NOTIFICATION_TYPES}' (issue #3995)" >&2
  exit 1
fi
echo "    OK: Phase 1: notifications live for EC2_INSTANCE_LAUNCH / EC2_INSTANCE_TERMINATE (issue #3995)"

# --- Phase 2: UPDATE (change only instanceType -> LT v2) --------------
echo "==> Phase 2: UPDATE (instanceType t3.micro -> t3.small; LT v1 -> v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

LT_V2=$(lt_latest_version)
if [ "${LT_V2}" != "2" ]; then
  echo "FAIL: LaunchTemplate LatestVersionNumber is '${LT_V2}', expected '2' after the instanceType edit" >&2
  exit 1
fi
echo "    OK: LaunchTemplate LatestVersionNumber == 2"

# THE #985 ASSERTION: the ASG must re-point at version 2 in the SAME deploy.
# Pre-fix this read back "1" (one deploy behind).
ASG_V2=$(asg_version "${ASG_NAME}")
if [ "${ASG_V2}" != "2" ]; then
  echo "FAIL: ASG LaunchTemplate.Version is '${ASG_V2}', expected '2' after the in-place LT update." >&2
  echo "      This is the issue #985 symptom -- the ASG is pinned one deploy behind:" >&2
  echo "      the in-place LaunchTemplate update bumped LatestVersionNumber to 2 but the" >&2
  echo "      Fn::GetAtt-consuming ASG was classified NO_CHANGE and never re-pointed." >&2
  exit 1
fi
echo "    OK: ASG LaunchTemplate.Version == 2 in the SAME deploy (issue #985 fixed)"

# The three non-default properties are still templated in Phase 2 — they must
# pass through unchanged (kept fields are never spuriously reset).
assert_nondefault_props "Phase 2 (props kept)" "${ASG_NAME}"

# --- Phase 3: REMOVAL (drop the three ASG props -> CFn defaults) ------
# Issue #1160: UpdateAutoScalingGroup has merge semantics, so pre-fix the
# removed properties silently kept their old live values. The removal phase
# keeps the Phase-2 instance type, so the ONLY template delta is the three
# dropped ASG properties.
echo "==> Phase 3: REMOVAL (drop HealthCheckGracePeriod / MaxInstanceLifetime / TerminationPolicies)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

read -r GRACE_R LIFETIME_R POLICIES_R < <(asg_removal_props "${ASG_NAME}")
if [ "${GRACE_R}" != "0" ]; then
  echo "FAIL: HealthCheckGracePeriod is '${GRACE_R}' after removal, expected the CFn default '0'." >&2
  echo "      This is the issue #1160 symptom -- UpdateAutoScalingGroup merge semantics kept the old live value." >&2
  exit 1
fi
echo "    OK: HealthCheckGracePeriod reset to 0"
# AWS clears MaxInstanceLifetime via the documented sentinel 0; Describe then
# reports the cleared state as 0 or omits the field entirely ("None" in
# --output text) -- both mean "no max lifetime".
if [ "${LIFETIME_R}" != "None" ] && [ "${LIFETIME_R}" != "0" ]; then
  echo "FAIL: MaxInstanceLifetime is '${LIFETIME_R}' after removal, expected cleared (None or 0)." >&2
  echo "      This is the issue #1160 symptom -- UpdateAutoScalingGroup merge semantics kept the old live value." >&2
  exit 1
fi
echo "    OK: MaxInstanceLifetime cleared (${LIFETIME_R})"
if [ "${POLICIES_R}" != "Default" ]; then
  echo "FAIL: TerminationPolicies is '${POLICIES_R}' after removal, expected the CFn default 'Default'." >&2
  echo "      This is the issue #1160 symptom -- UpdateAutoScalingGroup merge semantics kept the old live value." >&2
  exit 1
fi
echo "    OK: TerminationPolicies reset to ['Default'] (issue #1160 fixed)"

# Issue #4013: the removal phase dropped GroupMaxSize from the FIRST of two
# 1Minute GroupMetrics entries. Pre-fix the update kept only the LAST entry per
# granularity on each side ([GroupDesiredCapacity] both times), saw no change,
# and left GroupMaxSize enabled.
ENABLED_METRICS_R=$(enabled_metrics "${ASG_NAME}")
if [ "${ENABLED_METRICS_R}" != "GroupDesiredCapacity GroupMinSize" ]; then
  echo "FAIL: Phase 3: expected EnabledMetrics 'GroupDesiredCapacity GroupMinSize' after dropping GroupMaxSize from the first GroupMetrics entry, got '${ENABLED_METRICS_R}' (issue #4013)" >&2
  exit 1
fi
echo "    OK: Phase 3: EnabledMetrics == GroupDesiredCapacity GroupMinSize (issue #4013)"

DRIFT_JSON="$(mktemp)"
DRIFT_ERR="$(mktemp)"
assert_asg_drift_clean "Phase 3 (observed baseline)"

# The template-shaped baseline: a record deployed before observed-capture
# compares the template's per-GroupMetrics entries against the readback's one
# folded entry. Plant that shape as the ASG's observed MetricsCollection (the
# same metrics, split as the template splits them) and require it to compare
# clean; pre-fix the two shapes differed and drifted forever. The original
# record is restored afterwards.
STATE_ORIG="$(mktemp)"
STATE_LEGACY="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_ORIG}" --region "${REGION}" >/dev/null
jq '(.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .observedProperties.MetricsCollection) =
      [{"Granularity":"1Minute","Metrics":["GroupMinSize"]},{"Granularity":"1Minute","Metrics":["GroupDesiredCapacity"]}]' \
  "${STATE_ORIG}" > "${STATE_LEGACY}"
# The plant must have landed, or the check below compares the real baseline and
# passes vacuously on the pre-fix binary too. Compared by parsed value, not
# bytes: cdkd writes state.json without a trailing newline and jq adds one.
ASG_RECORDS=$(jq '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup")] | length' "${STATE_LEGACY}")
PLANTED=$(jq -c '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .observedProperties.MetricsCollection] | first' "${STATE_LEGACY}")
ORIGINAL=$(jq -c '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .observedProperties.MetricsCollection] | first' "${STATE_ORIG}")
if [ "${ASG_RECORDS}" != "1" ] || [ "${PLANTED}" = "${ORIGINAL}" ]; then
  echo "FAIL: Phase 3: the template-shaped MetricsCollection plant did not land (ASG records: ${ASG_RECORDS}; observed before '${ORIGINAL}', after '${PLANTED}')" >&2
  exit 1
fi
# Set BEFORE the upload: the trap restores the original on every exit path.
STATE_PLANTED=1
aws s3 cp "${STATE_LEGACY}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
assert_asg_drift_clean "Phase 3 (template-shaped observed MetricsCollection baseline)"

# drift --revert over the TWO-ENTRY MetricsCollection, still on the planted
# template-shaped baseline (it touches nothing but MetricsCollection): disable
# GroupMinSize out of band, require cdkd to SEE it (fail closed), revert, and
# require the exact set back. Pre-fix the revert's two-entry desired side keyed
# to its LAST entry ([GroupDesiredCapacity]), equal to the readback, so nothing
# was sent and GroupMinSize stayed disabled.
wait_enabled_metrics() { # $1 = expected sorted list, $2 = label
  local got="" i
  for i in $(seq 1 24); do
    got="$(enabled_metrics "${ASG_NAME}")" || return 1
    [ "${got}" = "$1" ] && return 0
    sleep 5
  done
  echo "FAIL: $2: EnabledMetrics never became '$1' (last '${got}')" >&2
  return 1
}
aws autoscaling disable-metrics-collection --auto-scaling-group-name "${ASG_NAME}" \
  --metrics GroupMinSize --region "${REGION}"
wait_enabled_metrics "GroupDesiredCapacity" "Phase 3 (out-of-band disable)"
run_drift_json "Phase 3 (after out-of-band disable)"
OOB_CHANGES=$(jq '[.[].drifted[] | select(.type == "AWS::AutoScaling::AutoScalingGroup") | .changes[] | select(.path | startswith("MetricsCollection"))] | length' "${DRIFT_JSON}")
if [ "${OOB_CHANGES}" = "0" ]; then
  echo "FAIL: Phase 3: cdkd drift did not report the out-of-band GroupMinSize disable — the revert below would prove nothing" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK: Phase 3: cdkd drift reports the out-of-band MetricsCollection change"
if ! node "${LOCAL_DIST}" drift "${STACK}" --revert -y --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" 2>"${DRIFT_ERR}"; then
  echo "FAIL: Phase 3: cdkd drift --revert failed:" >&2
  tail -30 "${DRIFT_ERR}" >&2
  exit 1
fi
wait_enabled_metrics "GroupDesiredCapacity GroupMinSize" "Phase 3 (after drift --revert, issue #4013)"
echo "    OK: Phase 3: drift --revert restored EnabledMetrics == GroupDesiredCapacity GroupMinSize (issue #4013)"
aws s3 cp "${STATE_ORIG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
STATE_PLANTED=0
assert_asg_drift_clean "Phase 3 (after drift --revert, original record)"

# The REAL legacy path: a record with no observedProperties at all, so drift
# compares against the template-shaped `properties` (two entries). Other
# templated keys may differ from their readback on this path (e.g. Tags'
# PropagateAtLaunch), so the assertion is scoped to MetricsCollection: the ASG
# must be compared (not skipped) and no reported change may be on that path.
jq '(.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup")) |=
      (del(.observedProperties)
       | .properties.MetricsCollection =
           [{"Granularity":"1Minute","Metrics":["GroupMinSize"]},{"Granularity":"1Minute","Metrics":["GroupDesiredCapacity"]}])' \
  "${STATE_ORIG}" > "${STATE_LEGACY}"
LEGACY_OBSERVED=$(jq '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup") | has("observedProperties")] | first' "${STATE_LEGACY}")
LEGACY_METRICS=$(jq -c '[.resources[] | select(.resourceType == "AWS::AutoScaling::AutoScalingGroup") | .properties.MetricsCollection] | first' "${STATE_LEGACY}")
if [ "${LEGACY_OBSERVED}" != "false" ] || [ "$(echo "${LEGACY_METRICS}" | jq 'length')" != "2" ]; then
  echo "FAIL: Phase 3: the legacy-record plant did not land (observedProperties still present: ${LEGACY_OBSERVED}; properties.MetricsCollection: ${LEGACY_METRICS})" >&2
  exit 1
fi
STATE_PLANTED=1
aws s3 cp "${STATE_LEGACY}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
run_drift_json "Phase 3 (legacy record, properties baseline)"
COMPARED=$(( $(asg_drift_count clean) + $(asg_drift_count drifted) ))
if [ "${COMPARED}" != "1" ] || [ "$(asg_drift_count notSupported)" != "0" ]; then
  echo "FAIL: Phase 3 (legacy record): the ASG was not compared — the MetricsCollection assertion would check nothing" >&2
  cat "${DRIFT_JSON}" >&2
  exit 1
fi
METRICS_CHANGES=$(jq '[.[].drifted[] | select(.type == "AWS::AutoScaling::AutoScalingGroup") | .changes[] | select(.path | startswith("MetricsCollection"))] | length' "${DRIFT_JSON}")
if [ "${METRICS_CHANGES}" != "0" ]; then
  echo "FAIL: Phase 3 (legacy record): cdkd drift reported MetricsCollection drift for the same enabled set split two ways (issue #4013):" >&2
  jq '[.[].drifted[] | select(.type == "AWS::AutoScaling::AutoScalingGroup") | .changes[] | select(.path | startswith("MetricsCollection"))]' "${DRIFT_JSON}" >&2
  exit 1
fi
echo "    OK: Phase 3 (legacy record, properties baseline): no MetricsCollection drift"
aws s3 cp "${STATE_ORIG}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" >/dev/null
STATE_PLANTED=0

rm -f "${STATE_ORIG}" "${STATE_LEGACY}" "${DRIFT_JSON}" "${DRIFT_ERR}"

# --- Phase 4: destroy -------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

REMAINING=$(aws autoscaling describe-auto-scaling-groups \
  --auto-scaling-group-names "${ASG_NAME}" --region "${REGION}" \
  --query 'length(AutoScalingGroups || `[]`)' --output text 2>/dev/null)
if [ "${REMAINING}" != "0" ]; then
  echo "FAIL: AutoScalingGroup ${ASG_NAME} still exists after destroy" >&2
  exit 1
fi
echo "    OK: AutoScalingGroup is gone"

assert_gone "LaunchTemplate ${LT_NAME} still exists after destroy" aws ec2 describe-launch-templates --launch-template-names "${LT_NAME}" --region "${REGION}"
echo "    OK: LaunchTemplate is gone"

assert_gone "notification SNS topic ${TOPIC_ARN} still exists after destroy" aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
echo "    OK: notification SNS topic is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> launchtemplate-asg-inplace test passed (issue #985: in-place GetAtt value change propagated to the ASG in the same deploy; issue #1160: removed ASG properties reset to CFn defaults; issue #3995: group metrics and notifications live after the first deploy; issue #4013: two GroupMetrics entries applied as one set on update, drift clean + clean destroy)"
