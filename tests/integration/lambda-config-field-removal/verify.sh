#!/usr/bin/env bash
# verify.sh — cdkd Lambda config-field removal reset (issue #1155) integ,
# plus the issue #609 property backfill assertions (RuntimeManagementConfig /
# CodeSigningConfigArn removal spellings; DurableConfig / TenancyConfig delivery).
#
# `UpdateFunctionConfiguration` treats an absent field as "no change", so a
# template that drops a previously-set config field must send the CFn-default
# reset value or AWS silently keeps the old one. cdkd previously passed
# Timeout / MemorySize / Description / Environment / Layers / TracingConfig /
# EphemeralStorage straight through as `undefined` on update — the deploy
# reported success, state dropped the field, and the next diff said "No
# changes" while AWS still held the old value. This test removes six of those
# fields on UPDATE and asserts AWS reverted each to its CloudFormation default.
#
# Phases:
#   1. Deploy with Timeout 30 / MemorySize 256 / Description / env {FOO} /
#      EphemeralStorage 1024 / Tracing ACTIVE; assert all live on AWS.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (all six fields removed). Assert
#      AWS shows the CFn defaults: Timeout 3, MemorySize 128, empty
#      Description, no env vars, EphemeralStorage 512, TracingConfig
#      PassThrough (a pre-fix run keeps the old values).
#   3. Destroy; assert both functions + the code-signing config are gone and
#      the state file is removed.
#
# Issue #609 rider, on the same three phases:
#   1b. Assert RuntimeManagementConfig / CodeSigningConfigArn / DurableConfig /
#       TenancyConfig all reached AWS, and that both functions were routed
#       through the SDK provider (provisionedBy=sdk) rather than falling back
#       to Cloud Control.
#   2b. Assert the two removal spellings that are NOT members of
#       UpdateFunctionConfiguration: RuntimeManagementConfig resets to `Auto`
#       and the code-signing config is DETACHED. Both were silent no-ops before
#       the backfill. The durable/tenancy function must keep its blocks (their
#       removal is a replacement, not an in-place edit).
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

# Bounded-retry variant for a resource whose DELETE is acknowledged before the
# read plane catches up. `DeleteFunction` returns 204 and `GetFunction` can keep
# answering successfully for a few seconds afterwards (observed 2026-08-11: the
# destroy reported 5 deleted / 0 errors, this probe still saw the function, and
# an independent check moments later showed it gone). A plain assert_gone
# therefore reports a LEAK that does not exist.
#
# This does NOT weaken the check: gone_probe still hard-FAILs on any
# undetermined probe error, and a resource that is genuinely leaked stays
# visible for the whole window and still fails the run.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout-s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local deadline=$((SECONDS + timeout))
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${SECONDS}" -ge "${deadline}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s)" >&2
      exit 1
    fi
    sleep 3
  done
}

cd "$(dirname "$0")"

STACK="CdkdLambdaConfigFieldRemovalExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN="${STACK}-fn"
DURABLE_FN="${STACK}-durable-fn"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

fncfg() {
  # Print one field of the function configuration (empty if absent).
  aws lambda get-function-configuration --function-name "${FN}" --region "${REGION}" \
    --query "$1" --output text 2>/dev/null
}

durablecfg() {
  # Print one field of the durable/tenancy function's configuration.
  aws lambda get-function-configuration --function-name "${DURABLE_FN}" --region "${REGION}" \
    --query "$1" --output text 2>/dev/null
}

# --- issue #609 readback helpers -------------------------------------------
# Each is a STRICT capture: an AWS failure propagates to `set -e` instead of
# being defaulted into a value that would satisfy the assertion.
runtime_mgmt() { # -> UpdateRuntimeOn of the main function
  aws lambda get-runtime-management-config --function-name "${FN}" --region "${REGION}" \
    --query 'UpdateRuntimeOn' --output text
}
code_signing_arn() { # -> attached CodeSigningConfigArn, or GONE when detached
  local out
  if out="$(aws lambda get-function-code-signing-config --function-name "${FN}" \
    --region "${REGION}" --query 'CodeSigningConfigArn' --output text 2>&1)"; then
    # A DETACHED function returns a SUCCESSFUL response with the field simply
    # absent, which `--output text` renders as the literal `None` (measured
    # 2026-08-11 — the first draft of this helper assumed a not-found ERROR and
    # so read a correct detach as a failure). An EMPTY string is NOT the same
    # thing: that would mean the probe itself produced no output, which must
    # not be read as "detached" (issue #1097 pattern 2).
    if [ "${out}" = "None" ]; then
      printf 'GONE'
      return 0
    fi
    if [ -z "${out}" ]; then
      echo "FAIL: get-function-code-signing-config returned empty output (probe error)" >&2
      return 1
    fi
    printf '%s' "${out}"
    return 0
  fi
  # Kept for the shape AWS uses when the FUNCTION itself is gone; a canonical
  # not-found is still "no config attached". Anything else is undetermined and
  # must hard-fail rather than read as "detached".
  if printf '%s' "${out}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    printf 'GONE'
    return 0
  fi
  echo "FAIL: get-function-code-signing-config undetermined: ${out}" >&2
  return 1
}
state_provisioned_by() { # $1 = physical id -> that resource's routing layer
  # Keyed by PHYSICAL id, not logical: CDK logical ids carry a generated hash
  # suffix (`Fn9270CBC0`), so a literal-logical-id lookup would silently miss
  # and report `absent` regardless of the real routing.
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  printf '%s' "${state}" | node -e "
let s='';
process.stdin.on('data', (d) => (s += d)).on('end', () => {
  const entry = Object.values(JSON.parse(s).resources ?? {}).find(
    (r) => r?.physicalId === process.argv[1]
  );
  process.stdout.write(entry ? (entry.provisionedBy ?? 'sdk') : 'absent');
});
" "$1"
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1
  aws lambda delete-function --function-name "${DURABLE_FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1
  aws logs delete-log-group --log-group-name "/aws/lambda/${DURABLE_FN}" --region "${REGION}" >/dev/null 2>&1
  # Code-signing configs are account-scoped and survive a function delete, so
  # sweep any left by an interrupted run of this fixture.
  for csc in $(aws lambda list-code-signing-configs --region "${REGION}" \
    --query "CodeSigningConfigs[?contains(Description, 'issue #609 CodeSigningConfigArn wiring')].CodeSigningConfigArn" \
    --output text 2>/dev/null); do
    aws lambda delete-code-signing-config --code-signing-config-arn "${csc}" --region "${REGION}" >/dev/null 2>&1
  done
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
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy with all five fields set --------------------------
echo "==> Phase 1: deploy with Timeout/MemorySize/Description/Environment/EphemeralStorage/TracingConfig set"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

if [ "$(fncfg Timeout)" != "30" ] || [ "$(fncfg MemorySize)" != "256" ] \
  || [ "$(fncfg Description)" != "before removal" ] \
  || [ "$(fncfg 'Environment.Variables.FOO')" != "bar" ] \
  || [ "$(fncfg 'EphemeralStorage.Size')" != "1024" ] \
  || [ "$(fncfg 'TracingConfig.Mode')" != "Active" ]; then
  echo "FAIL: Phase 1 fields not all live: Timeout=$(fncfg Timeout) MemorySize=$(fncfg MemorySize) Description='$(fncfg Description)' FOO=$(fncfg 'Environment.Variables.FOO') Eph=$(fncfg 'EphemeralStorage.Size') Tracing=$(fncfg 'TracingConfig.Mode')" >&2
  exit 1
fi
echo "    all six fields live"

# --- Phase 1b: issue #609 backfilled properties reached AWS -----------------
# A `handledProperties` declaration alone makes the pre-flight pass; only a
# readback proves the value was actually delivered.
RM="$(runtime_mgmt)"
if [ "${RM}" != "FunctionUpdate" ]; then
  echo "FAIL: RuntimeManagementConfig.UpdateRuntimeOn not delivered (want FunctionUpdate, got '${RM}')" >&2
  exit 1
fi
CS="$(code_signing_arn)"
case "${CS}" in
  arn:aws:lambda:*:code-signing-config:*) ;;
  *) echo "FAIL: CodeSigningConfigArn not attached (got '${CS}')" >&2; exit 1 ;;
esac
DUR_TIMEOUT="$(durablecfg 'DurableConfig.ExecutionTimeout')"
DUR_RETENTION="$(durablecfg 'DurableConfig.RetentionPeriodInDays')"
TENANCY="$(durablecfg 'TenancyConfig.TenantIsolationMode')"
if [ "${DUR_TIMEOUT}" != "3600" ] || [ "${DUR_RETENTION}" != "14" ]; then
  echo "FAIL: DurableConfig not delivered (ExecutionTimeout='${DUR_TIMEOUT}' RetentionPeriodInDays='${DUR_RETENTION}')" >&2
  exit 1
fi
if [ "${TENANCY}" != "PER_TENANT" ]; then
  echo "FAIL: TenancyConfig.TenantIsolationMode not delivered (got '${TENANCY}')" >&2
  exit 1
fi
echo "    #609 properties delivered: RuntimeManagementConfig, CodeSigningConfigArn, DurableConfig, TenancyConfig"

# Routing guard: these assertions are only meaningful for the SDK provider —
# a silent-drop property would have re-routed the resource to Cloud Control.
for fname in "${FN}" "${DURABLE_FN}"; do
  PB="$(state_provisioned_by "${fname}")"
  if [ "${PB}" != "sdk" ]; then
    echo "FAIL: ${fname} not provisioned by the SDK provider (provisionedBy='${PB}')" >&2
    exit 1
  fi
done
echo "    both functions routed through the SDK provider (provisionedBy=sdk)"

# --- Phase 2: remove all six fields ------------------------------------
echo "==> Phase 2: re-deploy with all six fields removed (must reset to CFn defaults)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

T="$(fncfg Timeout)"; M="$(fncfg MemorySize)"; D="$(fncfg Description)"
F="$(fncfg 'Environment.Variables.FOO')"; E="$(fncfg 'EphemeralStorage.Size')"
TR="$(fncfg 'TracingConfig.Mode')"
if [ "${T}" != "3" ]; then
  echo "FAIL: Timeout not reset to 3 after removal (got '${T}')" >&2; exit 1
fi
if [ "${M}" != "128" ]; then
  echo "FAIL: MemorySize not reset to 128 after removal (got '${M}')" >&2; exit 1
fi
if [ "${D}" != "" ] && [ "${D}" != "None" ]; then
  echo "FAIL: Description not cleared after removal (got '${D}')" >&2; exit 1
fi
# `--output text` prints the literal `None` for an absent key; an empty
# string means the probe itself failed (throttle/auth), which must NOT be
# read as "removed" (issue #1097 pattern 2 — negative assertion over an
# error-swallowing probe).
if [ "${F}" != "None" ]; then
  echo "FAIL: Environment.Variables.FOO not removed (got '${F}'; empty = probe error)" >&2; exit 1
fi
if [ "${E}" != "512" ]; then
  echo "FAIL: EphemeralStorage not reset to 512 after removal (got '${E}')" >&2; exit 1
fi
if [ "${TR}" != "PassThrough" ]; then
  echo "FAIL: TracingConfig not reset to PassThrough after removal (got '${TR}')" >&2; exit 1
fi
echo "    all six fields reset to CFn defaults"

# --- Phase 2b: issue #609 removal spellings --------------------------------
# Neither property is a member of UpdateFunctionConfiguration, so each needs
# its own removal call. Before the backfill both were silent no-ops.
RM_AFTER="$(runtime_mgmt)"
if [ "${RM_AFTER}" != "Auto" ]; then
  echo "FAIL: RuntimeManagementConfig not reset to Auto after removal (got '${RM_AFTER}')" >&2
  exit 1
fi
CS_AFTER="$(code_signing_arn)"
if [ "${CS_AFTER}" != "GONE" ]; then
  echo "FAIL: CodeSigningConfigArn not detached after removal (got '${CS_AFTER}')" >&2
  exit 1
fi
echo "    RuntimeManagementConfig reset to Auto; code-signing config detached"

# The durable/tenancy function keeps both blocks across the update — a drop
# there would be a replacement, not an in-place edit (see the stack docstring).
DUR_TIMEOUT_AFTER="$(durablecfg 'DurableConfig.ExecutionTimeout')"
TENANCY_AFTER="$(durablecfg 'TenancyConfig.TenantIsolationMode')"
if [ "${DUR_TIMEOUT_AFTER}" != "3600" ] || [ "${TENANCY_AFTER}" != "PER_TENANT" ]; then
  echo "FAIL: durable/tenancy function lost its config across the update (ExecutionTimeout='${DUR_TIMEOUT_AFTER}' TenantIsolationMode='${TENANCY_AFTER}')" >&2
  exit 1
fi
echo "    durable/tenancy function unchanged across the update"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone_eventually 60 "function ${FN} still exists after destroy" aws lambda get-function --function-name "${FN}" --region "${REGION}"
assert_gone_eventually 60 "function ${DURABLE_FN} still exists after destroy" aws lambda get-function --function-name "${DURABLE_FN}" --region "${REGION}"
echo "    both functions deleted"

# The code-signing config is an account-scoped resource of its own; destroy
# must remove it too, or every run of this fixture leaks one.
LEFTOVER_CSC="$(aws lambda list-code-signing-configs --region "${REGION}" \
  --query "length(CodeSigningConfigs[?contains(Description, 'issue #609 CodeSigningConfigArn wiring')])" \
  --output text)"
if [ "${LEFTOVER_CSC}" != "0" ]; then
  echo "FAIL: ${LEFTOVER_CSC} code-signing config(s) leaked after destroy" >&2
  exit 1
fi
echo "    code-signing config deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — Lambda config-field removal reset (issue #1155), all 3 phases passed"
