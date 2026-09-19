#!/usr/bin/env bash
# verify.sh — cdkd #651 --recreate-via-sdk-provider integ test
#
# Mid-life CC→SDK migration: a Lambda Function recorded as
# `provisionedBy: 'cc-api'` is destroyed + recreated via cdkd's SDK Provider
# when the next deploy passes `--recreate-via-sdk-provider`.
#
#   Phase 1  plain deploy                          -> 'sdk'
#   Phase 2  + RuntimeManagementConfig, --recreate-via-cc-api  -> 'cc-api' (SEED)
#   Phase 3  - RuntimeManagementConfig, --recreate-via-sdk-provider -> 'sdk' (THE ARM)
#   Phase 4  destroy
#
# The CC baseline is seeded with the explicit flag, NOT with the silent-drop
# auto-route: the auto-route needs a property the SDK provider does not
# handle, and every property this fixture used for that was later wired into
# the provider, which silently moved the baseline to 'sdk'. See
# lib/recreate-stack.ts for the history and the phase table.
#
# The assertions confirm:
#
#   - state `provisionedBy` goes 'sdk' -> 'cc-api' -> 'sdk'
#   - `RuntimeManagementConfig.UpdateRuntimeOn` is FunctionUpdate after the
#     seed (the Cloud Control create really provisioned the function) and back
#     at the default after the arm (a NEW function the template gives no
#     RuntimeManagementConfig)
#   - LastModified changed across the arm (the user-supplied functionName
#     makes the physical id stable, so LastModified is the witness)
#   - destroy via SDK delete path is clean
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

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateViaSdkProvider"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-recreate-via-sdk-provider-probe"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probe"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # SCOPE GUARD (#2621). Safety, not style: an empty `STACK` makes the
  # JMESPath prefix empty, and EVERY role name starts with the empty string —
  # so the sweep below becomes an account-wide role delete, while the `set +eu`
  # above has disabled the only thing that would have caught the empty value.
  # `case` and not `exit`: this runs inside `cleanup`, not a subshell, so a
  # refusal must skip the sweep and let the rest of the teardown run. The
  # convention is in `docs/integ-fixture-conventions.md`.
  case "${STACK}" in
    Cdkd?*)
      for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" --output text 2>/dev/null); do
        aws iam detach-role-policy --role-name "${role}" \
          --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
        aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
      done
      ;;
    *)
      echo "    WARN: teardown sweep refused a stack scope outside Cdkd*: '${STACK:-<empty>}'" >&2
      ;;
  esac
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
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# Every routing phase carries a real property delta (RuntimeManagementConfig
# toggles): a deploy the differ classifies NO_CHANGE never reaches the
# provider, so a recreate flag on an unchanged template does nothing
# (go-to-k/cdkd#2651).
lambda_layer() { # usage: lambda_layer "<state json>"
  printf '%s' "$1" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::Lambda::Function") | .value.provisionedBy // ""] | first // ""'
}

# --- Phase 1: plain deploy (lands on the SDK provider) ----------------------
echo "==> Phase 1: deploy ${STACK} (no flags -> SDK provider)"
CDKD_INTEG_PHASE=base node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_0=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_0=$(lambda_layer "${STATE_0}")
if [ "${PROVISIONED_0}" != "sdk" ]; then
  echo "FAIL: fresh Lambda has provisionedBy='${PROVISIONED_0}', expected 'sdk'. Likely cause: a property of the base template became an SDK-provider silent drop (a schema refresh added one, or handledProperties lost an entry), so the fresh deploy auto-routed to Cloud Control and the seed below would be refused as already-cc-api. Check the deploy output above for an 'Auto-routing ... via Cloud Control' line naming the property." >&2
  echo "${STATE_0}" | jq .
  exit 1
fi
echo "    OK: fresh Lambda provisionedBy == 'sdk'"

# --- Phase 2: seed the CC baseline with --recreate-via-cc-api ---------------
echo "==> Phase 2: re-deploy WITH RuntimeManagementConfig + --recreate-via-cc-api (seed the cc-api baseline)"
CDKD_INTEG_PHASE=seed node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api RecreateProbe \
  --yes

STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_1=$(lambda_layer "${STATE_1}")
if [ "${PROVISIONED_1}" != "cc-api" ]; then
  echo "FAIL: baseline Lambda has provisionedBy='${PROVISIONED_1}', expected 'cc-api'. The --recreate-via-cc-api seeding step did not seed, so every assertion below would be vacuous. Likely cause: the flag no-opped (the differ saw NO_CHANGE between the base and seed templates -- go-to-k/cdkd#2651 -- check that lib/recreate-stack.ts still toggles RuntimeManagementConfig on CDKD_INTEG_PHASE=seed), or --recreate-via-cc-api itself regressed (run the recreate-via-cc-api fixture). This baseline does NOT depend on any property being unhandled by the SDK provider." >&2
  echo "${STATE_1}" | jq .
  exit 1
fi
echo "    OK: baseline Lambda provisionedBy == 'cc-api'"

LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Baseline LastModified: ${LAST_MOD_1}"

# Baseline AWS check: UpdateRuntimeOn should be FunctionUpdate — the record
# says cc-api AND the Cloud Control create really provisioned the function.
RL_1=$(aws lambda get-runtime-management-config --function-name "${FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RL_1}" != "FunctionUpdate" ]; then
  echo "FAIL: baseline Lambda has RuntimeManagementConfig.UpdateRuntimeOn='${RL_1}', expected 'FunctionUpdate' (the CC recreate should have set it; the record says cc-api but the property did not reach AWS)" >&2
  exit 1
fi
echo "    OK: baseline Lambda RuntimeManagementConfig.UpdateRuntimeOn is FunctionUpdate on AWS (CC create confirmed)"

# --- Phase 3: re-deploy WITHOUT RuntimeManagementConfig + --recreate-via-sdk-provider
echo "==> Phase 3: re-deploy ${STACK} WITHOUT RuntimeManagementConfig + --recreate-via-sdk-provider (destroy+recreate via SDK)"
CDKD_INTEG_PHASE=recreate node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-sdk-provider RecreateProbe \
  --yes

STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
PROVISIONED_2=$(lambda_layer "${STATE_2}")
if [ "${PROVISIONED_2}" != "sdk" ]; then
  echo "FAIL: post-recreate Lambda has provisionedBy='${PROVISIONED_2}', expected 'sdk' (recreate should have routed via SDK)" >&2
  echo "${STATE_2}" | jq .
  exit 1
fi
echo "    OK: post-recreate Lambda provisionedBy flipped 'cc-api' -> 'sdk'"

LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text 2>/dev/null)
echo "    Post-recreate LastModified: ${LAST_MOD_2}"
if [ "${LAST_MOD_2}" = "${LAST_MOD_1}" ]; then
  echo "FAIL: Lambda LastModified unchanged after --recreate-via-sdk-provider (expected destroy+recreate to produce a new Lambda instance)" >&2
  exit 1
fi
echo "    OK: LastModified updated across recreate (old destroyed, new created)"

# Post-recreate AWS check: UpdateRuntimeOn should be back at the Auto default —
# the recreated function is a NEW one and its template carries no
# RuntimeManagementConfig.
RL_2=$(aws lambda get-runtime-management-config --function-name "${FN_NAME}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text 2>/dev/null)
if [ "${RL_2}" = "FunctionUpdate" ]; then
  echo "FAIL: post-recreate Lambda still has RuntimeManagementConfig.UpdateRuntimeOn='FunctionUpdate' on AWS — the template dropped it and the function should be a fresh instance" >&2
  exit 1
fi
echo "    OK: post-recreate RuntimeManagementConfig.UpdateRuntimeOn is back at the default (UpdateRuntimeOn='${RL_2}')"

# --- Phase 4: destroy ---------------------------------------------------
echo "==> Phase 4: destroy via SDK delete path"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: Lambda function is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# Audit follow-up: assert the IAM role was destroyed too — not just
# relying on the trap to clean it up. The trap remains as a defence-in-
# depth cleanup for leftover-from-prior-runs cases; this assertion
# confirms the destroy itself handled the role.
LEFTOVER_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" \
  --output text 2>/dev/null)
if [ -n "${LEFTOVER_ROLES}" ]; then
  echo "FAIL: IAM role(s) still exist after destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi
echo "    OK: IAM role is gone"

echo ""
echo "==> recreate-via-sdk-provider test passed (#651 mid-life CC->SDK migration verified end-to-end)"
