#!/usr/bin/env bash
# verify.sh — cdkd S3 analytics + inventory DESTINATION integ (issue #1493 items 2/3).
#
# Both `applyAnalyticsConfigurations` and `applyInventoryConfigurations` pick
# between the CFn FLATTENED destination shape and the SDK NESTED one by probing
# member presence. Before the fix a `Destination` that was a string / array /
# unresolved intrinsic indexed every probe to `undefined`, fell through to an
# equally-`undefined` `S3BucketDestination`, and the caller's
# `s3Dest ? ... : undefined` omitted the whole block from the Put — the
# configuration deployed with NO destination and no error anywhere. The fix
# refuses that on the template-borne create path, warns on the replay-reachable
# update path, and widened the branch probe to include `Bucket`.
#
# Nothing in the integ tree exercised either configuration at all before this
# fixture, so this is the live proof that the rewritten branch selection still
# delivers a real destination to AWS.
#
# Only the FLATTENED shape is covered live — it is the only one a CDK template
# can express (see the stack's header for why the SDK nested spelling stays
# unit-covered).
#
# Phases 2-4 are the live coverage for issue #1670 (the warn-and-SUBSTITUTE
# arms of the same two appliers). #1670's own Scope bullet 3 asks for it, and
# nothing in phases 1 / 5 exercises it: a correct template never reaches a
# substitution arm, so the fixture could stay green while the recorded value
# was the malformed DECLARED one and every later comparison diverged forever.
#
# Phases:
#   1. Deploy; assert BOTH configurations reached AWS carrying the declared
#      destination bucket, format and prefix. Against the pre-fix binary this
#      phase still passes — a correct template was never the broken case — so
#      the value here is regression protection for the rewritten branch pick.
#   2. (#1670) Re-deploy with CDKD_TEST_UPDATE=malformed-substitute: three
#      fields are BLANK, so each read warns and SENDS its default. Assert the
#      deploy succeeds, that it WARNED (the anti-vacuity guard), that AWS holds
#      the defaults, and — the direct assertion #1670 is about — that the STATE
#      record holds the SUBSTITUTED value rather than the declared blank. Also
#      assert the recorded AND observed analytics destinations are the FLATTENED
#      CFn shape: `analyticsSdkToCfn` used to emit the SDK's nested
#      `S3BucketDestination` wrapper, which no CFn template can equal, so the
#      send-side record could never converge with the readback.
#   3. (#1670) Convergence: the recorded bag must equal what a CORRECT template
#      declares — asserted twice via `cdkd diff --json`, plus a NEGATIVE twin
#      that rewrites the recorded destination into the pre-fix NESTED shape and
#      requires `cdkd diff --fail` to report it.
#   4. (#1670) Hand-patch the STATE record malformed and redeploy the valid
#      template: the DESIRED side is guarded and the PREVIOUS side is not, so a
#      value an older binary recorded must not wedge the stack.
#   5. Re-deploy with CDKD_TEST_UPDATE=true (changed prefix on analytics,
#      changed prefix + format on inventory). This runs the per-id diff path
#      (`diffArrayConfigById` -> the appliers with the warn callback wired) and
#      asserts the readback shows the new values — i.e. the update path still
#      delivers a destination rather than silently dropping it.
#   6. Destroy; assert both buckets and the state file are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# A pager invoked non-interactively is a route to a hang.
export AWS_PAGER=""

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

# S3 propagates a DeleteBucket to HeadBucket asynchronously: a probe issued
# immediately after a successful delete can still answer 200 for a few seconds.
# Retry on a bounded schedule instead of asserting once. This does NOT weaken
# leak detection -- a bucket that never disappears still FAILs, and gone_probe
# still hard-fails on any non-not-found probe error.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws s3api head-bucket ...
  local desc="$1"; shift
  local attempt
  for attempt in $(seq 1 10); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 3
  done
  echo "FAIL: ${desc} (still present after 10 probes over ~30s)" >&2
  exit 1
}

assert_eq() { # usage: assert_eq "<what>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: expected $1 = '$2', got '$3'" >&2
    exit 1
  fi
  echo "  ok: $1 = $2"
}

cd "$(dirname "$0")"

STACK="CdkdS3AnalyticsInventoryExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
SOURCE_BUCKET="cdkd-ai-source-${ACCOUNT_ID}"
REPORT_BUCKET="cdkd-ai-reports-${ACCOUNT_ID}"
REPORT_ARN="arn:aws:s3:::${REPORT_BUCKET}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws s3api delete-bucket --bucket "${SOURCE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${REPORT_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy baseline ----------------------------------------------
echo "==> Phase 1: deploy source bucket with analytics + inventory configurations"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

echo "==> Phase 1: assert the ANALYTICS destination reached AWS"
ANALYTICS_P1="$(aws s3api get-bucket-analytics-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-analytics --region "${REGION}")"
assert_eq "analytics destination bucket" "${REPORT_ARN}" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Bucket')"
assert_eq "analytics destination format" "CSV" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Format')"
assert_eq "analytics destination prefix" "analytics-v1/" \
  "$(printf '%s' "${ANALYTICS_P1}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 1: assert the INVENTORY destination reached AWS"
INVENTORY_P1="$(aws s3api get-bucket-inventory-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-inventory --region "${REGION}")"
assert_eq "inventory destination bucket" "${REPORT_ARN}" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Bucket')"
assert_eq "inventory destination format" "CSV" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Format')"
assert_eq "inventory destination prefix" "inventory-v1/" \
  "$(printf '%s' "${INVENTORY_P1}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Prefix')"

# --- Phase 2: the warn-and-SUBSTITUTE arms (issue #1670) --------------------
echo "==> Phase 2: re-deploy with BLANK OutputSchemaVersion / Format values"
# `malformed-substitute` blanks three fields the provider reads through
# `readSubstitutedConfigString`. On the UPDATE path the read warns and SENDS
# its default, the Put SUCCEEDS, and before #1670 the engine recorded the
# DECLARED blank — a value AWS never held and `readCurrentState` can never
# return, i.e. permanent phantom drift.
#
# The mode keeps every OTHER value at its phase-1 setting, so the substituted
# result is byte-identical to the phase-1 template. Phase 3 relies on that.
MALFORMED_LOG="$(CDKD_TEST_UPDATE=malformed-substitute node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"
printf '%s\n' "${MALFORMED_LOG}"

echo "==> Phase 2: assert each substitution was ANNOUNCED"
# This is the anti-vacuity guard for every assertion below it. The substituted
# values equal the ones phase 1 already recorded, so a run in which the Put
# never fired would satisfy the state assertions without exercising a single
# substitution arm. The warning exists only if the applier really read the
# blank — and `effectiveProperties` is only licensed for a narrowing that is
# ANNOUNCED, so the warning is part of the contract, not just a probe.
assert_warned() { # usage: assert_warned "<CFn path of the refused field>"
  case "${MALFORMED_LOG}" in
    *"$1 must be a non-empty string"*) echo "  ok: warned about $1" ;;
    *)
      echo "FAIL: no warn-and-substitute warning for $1 — the applier never saw the blank" >&2
      exit 1
      ;;
  esac
}
assert_warned "AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport.OutputSchemaVersion"
assert_warned "AWS::S3::Bucket AnalyticsConfigurations[].StorageClassAnalysis.DataExport.Destination.Format"
assert_warned "AWS::S3::Bucket InventoryConfigurations[].Destination.Format"

echo "==> Phase 2: assert AWS holds the SUBSTITUTED values"
ANALYTICS_SUB="$(aws s3api get-bucket-analytics-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-analytics --region "${REGION}")"
assert_eq "analytics OutputSchemaVersion on AWS" "V_1" \
  "$(printf '%s' "${ANALYTICS_SUB}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.OutputSchemaVersion')"
assert_eq "analytics destination format on AWS" "CSV" \
  "$(printf '%s' "${ANALYTICS_SUB}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Format')"
INVENTORY_SUB="$(aws s3api get-bucket-inventory-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-inventory --region "${REGION}")"
assert_eq "inventory destination format on AWS" "CSV" \
  "$(printf '%s' "${INVENTORY_SUB}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Format')"

echo "==> Phase 2: assert the STATE record holds what was SENT, not what was declared"
STATE_SUB="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json)"
SRC_RES='.state.resources.SourceBucket'
DATA_EXPORT="${SRC_RES}.properties.AnalyticsConfigurations[0].StorageClassAnalysis.DataExport"
OBS_DATA_EXPORT="${SRC_RES}.observedProperties.AnalyticsConfigurations[0].StorageClassAnalysis.DataExport"
INV_DEST="${SRC_RES}.properties.InventoryConfigurations[0].Destination"
# The three direct #1670 assertions. Pre-fix each of these reads back the
# blank string the template declared.
assert_eq "recorded analytics OutputSchemaVersion (#1670)" "V_1" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${DATA_EXPORT}.OutputSchemaVersion")"
assert_eq "recorded analytics destination Format (#1670)" "CSV" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${DATA_EXPORT}.Destination.Format")"
assert_eq "recorded inventory destination Format (#1670)" "CSV" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${INV_DEST}.Format")"
# ...and the readback SHAPE, which is the half that had no live coverage at
# all. `properties` is written by `effectiveProperties` (template-shaped) and
# `observedProperties` by `analyticsSdkToCfn` (readback-shaped); the two must
# agree, or nothing the send side records can ever converge. Pre-fix the
# observed side carried `Destination.S3BucketDestination.*` and no `BucketArn`.
assert_eq "recorded analytics destination is the FLATTENED CFn shape" "${REPORT_ARN}" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${DATA_EXPORT}.Destination.BucketArn")"
assert_eq "recorded analytics destination has no SDK nested wrapper" "null" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${DATA_EXPORT}.Destination.S3BucketDestination")"
assert_eq "observed analytics destination is the FLATTENED CFn shape" "${REPORT_ARN}" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${OBS_DATA_EXPORT}.Destination.BucketArn")"
assert_eq "observed analytics destination has no SDK nested wrapper" "null" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${OBS_DATA_EXPORT}.Destination.S3BucketDestination")"
assert_eq "observed analytics OutputSchemaVersion" "V_1" \
  "$(printf '%s' "${STATE_SUB}" | jq -r "${OBS_DATA_EXPORT}.OutputSchemaVersion")"

# --- Phase 3: the recorded bag CONVERGES (issue #1670) ----------------------
echo "==> Phase 3: two consecutive reads must report no difference on the fixed properties"
# `cdkd diff`, NOT `cdkd drift`: the drift comparator prefers
# `observedProperties`, and BOTH sides of that comparison come from the same
# readback mapper — so a mapper emitting the wrong shape agrees with itself and
# reports nothing. #1670's own caveat says the same. `diff` compares the
# TEMPLATE against the recorded `properties`, which is exactly the pair a
# send-side record has to converge with.
#
# The assertion is scoped to the two properties under test rather than taken
# from `--fail`'s whole-stack exit code: unrelated stack-wide churn would make
# a whole-stack signal report on something this fixture does not own, and the
# NEGATIVE twin below is where an exit code IS unambiguous.
assert_no_diff_on_configs() { # usage: assert_no_diff_on_configs <run label>
  local label="$1"
  local raw json paths
  raw="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" diff "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json)"
  # `cdkd diff` logs its progress lines ("Calculating diff...", "Synthesizing
  # CDK app...") at INFO level, which lands on stdout ahead of the payload —
  # so the capture is not parseable JSON on its own. Take everything from the
  # payload's opening bracket onward; `JSON.stringify(array, null, 2)` puts it
  # alone on its own line and writes nothing after the closing bracket.
  json="$(printf '%s\n' "${raw}" | sed -n '/^\[$/,$p')"
  if [ -z "${json}" ]; then
    echo "FAIL: diff ${label} emitted no JSON payload:" >&2
    printf '%s\n' "${raw}" >&2
    exit 1
  fi
  paths="$(printf '%s' "${json}" | jq -r '
    [ .[].changes[]?
      | select(.logicalId == "SourceBucket")
      | .propertyChanges[]?
      | .path
      | select(startswith("AnalyticsConfigurations") or startswith("InventoryConfigurations")) ]
    | join(",")')"
  if [ -n "${paths}" ]; then
    echo "FAIL: diff ${label} still reports the substituted properties as changed: ${paths}" >&2
    printf '%s\n' "${json}" >&2
    exit 1
  fi
  echo "  ok: diff ${label} reports no analytics/inventory difference"
}
assert_no_diff_on_configs "run 1"
assert_no_diff_on_configs "run 2"

echo "==> Phase 3: NEGATIVE twin — the pre-fix NESTED destination must NOT converge"
# Rewrites the RECORDED destination into the shape `analyticsSdkToCfn` used to
# emit, without touching the provider. If a nested-shaped record compared equal
# to the flattened template, the flattening assertions above would prove
# nothing.
STATE_FLAT="$(mktemp)"
STATE_NESTED="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_FLAT}"
jq '(.resources.SourceBucket.properties.AnalyticsConfigurations[0].StorageClassAnalysis.DataExport.Destination)
      |= { S3BucketDestination: . }' "${STATE_FLAT}" > "${STATE_NESTED}"
aws s3 cp "${STATE_NESTED}" "s3://${STATE_BUCKET}/${STATE_KEY}"
NESTED_DIFF=""
if NESTED_DIFF="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)"; then
  echo "FAIL: the pre-fix NESTED destination shape compared EQUAL to the template — the" >&2
  echo "      flattening assertions in phase 2 cannot distinguish the fix from the bug" >&2
  printf '%s\n' "${NESTED_DIFF}" >&2
  exit 1
fi
# A non-zero exit alone is not enough: any diff-time error is also non-zero.
# Require the report to NAME the property, so the twin fails for its own reason.
case "${NESTED_DIFF}" in
  *AnalyticsConfigurations*) echo "  ok: the nested shape is reported as a real difference" ;;
  *)
    echo "FAIL: diff exited non-zero but never named AnalyticsConfigurations:" >&2
    printf '%s\n' "${NESTED_DIFF}" >&2
    exit 1
    ;;
esac
aws s3 cp "${STATE_FLAT}" "s3://${STATE_BUCKET}/${STATE_KEY}"
rm -f "${STATE_NESTED}"

# --- Phase 4: a malformed PREVIOUS side must not wedge the stack (#1670) ----
echo "==> Phase 4: hand-patch the state record malformed, then redeploy the valid template"
# The recipe #1670 spells out, and worth being precise about what it covers:
# on a redeploy the DESIRED bag comes from the template, so the substitution
# arms phase 2 exercises are NOT reachable here. What this covers is the
# `config-shape.ts` rule that only the DESIRED side is guarded — a blank an
# older binary recorded must not make the stack permanently undeployable, and
# the record must heal on the next successful deploy.
STATE_MALFORMED="$(mktemp)"
jq '(.resources.SourceBucket.properties.AnalyticsConfigurations[0].StorageClassAnalysis.DataExport)
      |= (.OutputSchemaVersion = "   " | .Destination.Format = "   ")
    | (.resources.SourceBucket.properties.InventoryConfigurations[0].Destination.Format) = "   "' \
  "${STATE_FLAT}" > "${STATE_MALFORMED}"
aws s3 cp "${STATE_MALFORMED}" "s3://${STATE_BUCKET}/${STATE_KEY}"

env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_HEALED="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json)"
assert_eq "healed analytics OutputSchemaVersion" "V_1" \
  "$(printf '%s' "${STATE_HEALED}" | jq -r "${DATA_EXPORT}.OutputSchemaVersion")"
assert_eq "healed analytics destination Format" "CSV" \
  "$(printf '%s' "${STATE_HEALED}" | jq -r "${DATA_EXPORT}.Destination.Format")"
assert_eq "healed inventory destination Format" "CSV" \
  "$(printf '%s' "${STATE_HEALED}" | jq -r "${INV_DEST}.Format")"
rm -f "${STATE_FLAT}" "${STATE_MALFORMED}"

# --- Phase 5: UPDATE the destinations --------------------------------------
echo "==> Phase 5: re-deploy with changed prefixes + inventory format (UPDATE path)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

echo "==> Phase 5: assert the analytics destination was UPDATED, not dropped"
ANALYTICS_P2="$(aws s3api get-bucket-analytics-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-analytics --region "${REGION}")"
assert_eq "analytics destination bucket (after update)" "${REPORT_ARN}" \
  "$(printf '%s' "${ANALYTICS_P2}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Bucket')"
assert_eq "analytics destination prefix (after update)" "analytics-v2/" \
  "$(printf '%s' "${ANALYTICS_P2}" | jq -r '.AnalyticsConfiguration.StorageClassAnalysis.DataExport.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 5: assert the inventory destination was UPDATED, not dropped"
INVENTORY_P2="$(aws s3api get-bucket-inventory-configuration \
  --bucket "${SOURCE_BUCKET}" --id daily-inventory --region "${REGION}")"
assert_eq "inventory destination bucket (after update)" "${REPORT_ARN}" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Bucket')"
assert_eq "inventory destination format (after update)" "ORC" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Format')"
assert_eq "inventory destination prefix (after update)" "inventory-v2/" \
  "$(printf '%s' "${INVENTORY_P2}" | jq -r '.InventoryConfiguration.Destination.S3BucketDestination.Prefix')"

echo "==> Phase 5: assert the source bucket was NOT replaced"
SOURCE_ID_P2="$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --json | jq -r '.state.resources.SourceBucket.physicalId')"
assert_eq "source bucket physicalId" "${SOURCE_BUCKET}" "${SOURCE_ID_P2}"

# --- Phase 6: destroy -------------------------------------------------------
echo "==> Phase 6: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

echo "==> Phase 6: assert both buckets are gone"
assert_gone_eventually "source bucket ${SOURCE_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${SOURCE_BUCKET}" --region "${REGION}"
assert_gone_eventually "report bucket ${REPORT_BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${REPORT_BUCKET}" --region "${REGION}"

echo "==> Phase 6: assert the state file is gone"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: s3-analytics-inventory"
