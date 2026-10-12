#!/usr/bin/env bash
# verify.sh — a Cloud Control import records an `Fn::GetAtt` attribute that is
# also a WRITABLE property in the clear (issue #3735), and a `cdkd import
# --force` re-import keeps recorded values over masks (issue #2927).
#
# WHAT THIS PROVES
#
# `CloudControlProvider.import` masks every model key that is not an
# `Fn::GetAtt` attribute of the type, and KEEPS the key. Before #3735 it
# certified only the registry schema's `readOnlyProperties`, so
# `AWS::StepFunctions::Activity`'s `Name` (writable, yet an attribute
# CloudFormation accepts in `Fn::GetAtt`) was masked and the consumer
# parameter's next update (`Value: Fn::GetAtt [Act, Name]`) was refused. Now
# `Name` is certified from the generated resource-specification table. The
# #2927 merge (a masked value never displaces an unmasked recorded one, and a
# mask the record already holds is kept with a warning) is exercised on the
# keys that ARE still masked, whichever the live model carries.
#
# Phases:
#   0. PREMISE: the registry schema's readOnlyProperties omit `Name`, so only
#      the #3735 table certifies it. Without that, phases 2 and 4 discriminate
#      nothing.
#   1. `cdkd deploy` (phase=1). The activity is cc-api-routed, state records
#      `Name` unmasked, and the parameter holds the activity name.
#   2. `cdkd import --resource Act=<arn> --force`. State still records `Name`
#      as the activity name, the import does NOT list `Name` among the keys it
#      recorded only as the mask (pre-#3735 it did), and prints no kept-mask
#      warning (the record held no mask).
#   3. `cdkd deploy -c phase=2` updates the consumer, which re-resolves
#      `Fn::GetAtt [Act, Name]`.
#   4. KEY ASSERTION (#3735): `cdkd state orphan`, then a FRESH import of both
#      resources. With no prior record, `Name` is recorded in the CLEAR
#      (pre-fix: the mask). At least one OTHER key must come back masked, or
#      phase 5 has nothing to exercise.
#   5. KEY ASSERTION (#2927 shape 2): a second `--force` re-import keeps that
#      key's mask (it is not dropped) and warns, naming it.
#   6. KEY ASSERTION (#3735): `cdkd deploy -c phase=3` updates the consumer
#      over the IMPORTED record. Pre-fix this deploy is REFUSED (redacted
#      attribute read of `Name`).
#   7. `cdkd destroy --force`, then gone-probes for the activity, the
#      parameter and the state file.
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

STACK="CdkdImportReimportMaskedAttrsExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
ACT_NAME="cdkd-import-reimport-masked-attrs-activity"
PARAM_NAME="/cdkd-integ/import-reimport-masked-attrs/activity-name"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
CLI="node ${LOCAL_DIST}"
MASK='***'
# The one line `buildStackState` prints for a mask a re-import kept.
KEPT_MASK_WARNING="this import produced no value to replace the redaction mask"

IMPORT_LOG="${TMPDIR:-/tmp}/cdkd-2927-import.$$.log"
DEPLOY_LOG="${TMPDIR:-/tmp}/cdkd-2927-deploy.$$.log"

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: ${LOCAL_DIST} not built (run vp run build)" >&2; exit 1; fi

# `head-object` reports a missing bucket and a missing key identically, so the
# post-destroy state assertion would pass trivially against a wrong bucket.
if ! bucket_err="$(aws s3api head-bucket --bucket "${STATE_BUCKET}" 2>&1 >/dev/null)"; then
  echo "FAIL: state bucket '${STATE_BUCKET}' is not reachable: ${bucket_err}" >&2
  exit 1
fi

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
PARTITION="aws"
case "${REGION}" in cn-*) PARTITION="aws-cn" ;; us-gov-*) PARTITION="aws-us-gov" ;; esac
ACT_ARN="arn:${PARTITION}:states:${REGION}:${ACCOUNT_ID}:activity:${ACT_NAME}"

echo "==> region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"
echo "==> activity-arn=${ACT_ARN}"

# Reads one field of the Act record out of `cdkd state show --json`.
act_attr() { # usage: act_attr <attribute-name>
  ${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json | python3 -c '
import sys, json
res = json.load(sys.stdin)["state"]["resources"]["Act"]
print((res.get("attributes") or {}).get(sys.argv[1], "<absent>"))' "$1"
}

CLEANED=0
cleanup() {
  if [ "${CLEANED}" -eq 1 ]; then return 0; fi
  CLEANED=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  ${CLI} state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
  # Unconditional: covers the orphaned window in phase 4 and any teardown failure.
  aws stepfunctions delete-activity --activity-arn "${ACT_ARN}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${PARAM_NAME}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1
  rm -f "${IMPORT_LOG}" "${DEPLOY_LOG}"
  set -eu
  return 0
}

# ---------------------------------------------------------------------------
echo "==> Pre-flight: assert no leftovers from an earlier run"
# BEFORE the traps: a leftover is for a human to look at, not for the EXIT
# trap to delete.
# ---------------------------------------------------------------------------
if ! gone_probe aws stepfunctions describe-activity --activity-arn "${ACT_ARN}"; then
  echo "FAIL: ${ACT_ARN} already exists — clean up before running" >&2
  exit 1
fi
if ! gone_probe aws ssm get-parameter --name "${PARAM_NAME}"; then
  echo "FAIL: ${PARAM_NAME} already exists — clean up before running" >&2
  exit 1
fi
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "FAIL: cdkd state ${STATE_KEY} already exists — clean up before running" >&2
  exit 1
fi
echo "==> Pre-flight ok"

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
echo "==> Phase 0: PREMISE — Name is not a readOnlyProperty of AWS::StepFunctions::Activity"
# ---------------------------------------------------------------------------
READ_ONLY="$(aws cloudformation describe-type --type RESOURCE --type-name AWS::StepFunctions::Activity \
  --query Schema --output text | python3 -c '
import sys, json
print(" ".join(json.load(sys.stdin).get("readOnlyProperties", [])))')"
case " ${READ_ONLY} " in
  *" /properties/Name "*)
    echo "FAIL: premise gone — /properties/Name is now read-only (${READ_ONLY}); the #3735 table no longer decides it, so this fixture discriminates nothing. Pick another type." >&2
    exit 1
    ;;
esac
echo "==> Phase 0 ok: readOnlyProperties=${READ_ONLY}"

# ---------------------------------------------------------------------------
echo "==> Phase 1: cdkd deploy (phase=1)"
# ---------------------------------------------------------------------------
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" -c phase=1 --verbose
ROUTE="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json | python3 -c '
import sys, json
print(json.load(sys.stdin)["state"]["resources"]["Act"].get("provisionedBy", "<absent>"))')"
if [ "${ROUTE}" != "cc-api" ]; then
  echo "FAIL: Act.provisionedBy is '${ROUTE}', expected 'cc-api' — the activity must be Cloud-Control-routed" >&2
  exit 1
fi
DEPLOYED_NAME="$(act_attr Name)"
if [ "${DEPLOYED_NAME}" != "${ACT_NAME}" ]; then
  echo "FAIL: after deploy Act.attributes.Name is '${DEPLOYED_NAME}', expected '${ACT_NAME}'" >&2
  exit 1
fi
PARAM_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --query Parameter.Value --output text)"
if [ "${PARAM_VALUE}" != "${ACT_NAME}" ]; then
  echo "FAIL: ${PARAM_NAME} holds '${PARAM_VALUE}', expected '${ACT_NAME}'" >&2
  exit 1
fi
echo "==> Phase 1 ok: cc-api, Name recorded, parameter=${PARAM_VALUE}"

# ---------------------------------------------------------------------------
echo "==> Phase 2: a --force re-import keeps Name and does not treat it as masked"
# ---------------------------------------------------------------------------
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --force --yes --verbose > "${IMPORT_LOG}" 2>&1 \
  || { cat "${IMPORT_LOG}"; echo "FAIL: phase 2 import exited non-zero" >&2; exit 1; }
cat "${IMPORT_LOG}"
REIMPORTED_NAME="$(act_attr Name)"
if [ "${REIMPORTED_NAME}" = "${MASK}" ]; then
  echo "FAIL: the re-import replaced the recorded Name with the mask (issue #2927 / #3735 regression)" >&2
  exit 1
fi
if [ "${REIMPORTED_NAME}" != "${ACT_NAME}" ]; then
  echo "FAIL: after the re-import Act.attributes.Name is '${REIMPORTED_NAME}', expected '${ACT_NAME}'" >&2
  exit 1
fi
if grep -qF "${KEPT_MASK_WARNING}" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import warned about a kept mask although the record held no mask" >&2
  exit 1
fi
# Keys are rendered sorted and comma-separated, and Cloud Control still masks
# the writable keys that are not attributes, so a line for OTHER keys is
# EXPECTED (the record held them unmasked): asserting it first keeps the
# negative below from passing on a reworded message. Only `Name` inside it is
# the #3735 regression (the import masked it again).
if ! grep -qE "Act: this import recorded [A-Za-z0-9]+(, [A-Za-z0-9]+)* only as the redaction mask" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import printed no kept-recorded-value line, so the Name check below would see nothing" >&2
  exit 1
fi
if grep -qE "Act: this import recorded ([A-Za-z0-9]+, )*Name(, [A-Za-z0-9]+)* only as the redaction mask" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import recorded Name only as the mask (issue #3735 regression)" >&2
  exit 1
fi
REIMPORTED_ARN="$(act_attr Arn)"
if [ "${REIMPORTED_ARN}" != "${ACT_ARN}" ]; then
  echo "FAIL: after the re-import Act.attributes.Arn is '${REIMPORTED_ARN}', expected '${ACT_ARN}'" >&2
  exit 1
fi
echo "==> Phase 2 ok: Name=${REIMPORTED_NAME}, Arn=${REIMPORTED_ARN}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: cdkd deploy -c phase=2 re-resolves Fn::GetAtt [Act, Name]"
# ---------------------------------------------------------------------------
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" -c phase=2 --verbose > "${DEPLOY_LOG}" 2>&1 \
  || { cat "${DEPLOY_LOG}"; echo "FAIL: phase 3 deploy exited non-zero (pre-fix: the redacted-attribute refusal)" >&2; exit 1; }
cat "${DEPLOY_LOG}"
PARAM_DESC="$(aws ssm describe-parameters --parameter-filters "Key=Name,Values=${PARAM_NAME}" \
  --query 'Parameters[0].Description' --output text)"
if [ "${PARAM_DESC}" != "cdkd issue 2927 consumer, phase 2" ]; then
  echo "FAIL: ${PARAM_NAME} description is '${PARAM_DESC}' — the consumer was not updated, so Name was never re-resolved" >&2
  exit 1
fi
PARAM_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --query Parameter.Value --output text)"
if [ "${PARAM_VALUE}" != "${ACT_NAME}" ]; then
  echo "FAIL: after the update ${PARAM_NAME} holds '${PARAM_VALUE}', expected '${ACT_NAME}'" >&2
  exit 1
fi
echo "==> Phase 3 ok: consumer updated, parameter=${PARAM_VALUE}"

# ---------------------------------------------------------------------------
echo "==> Phase 4: KEY ASSERTION — orphan state, then a FRESH import records Name in the clear"
# ---------------------------------------------------------------------------
${CLI} state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" --yes
assert_gone "state ${STATE_KEY} still present after orphan" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --resource "NameParam=${PARAM_NAME}" --yes --verbose
FRESH_NAME="$(act_attr Name)"
if [ "${FRESH_NAME}" != "${ACT_NAME}" ]; then
  echo "FAIL: a fresh import recorded Name as '${FRESH_NAME}', expected '${ACT_NAME}' (pre-#3735: the mask)" >&2
  exit 1
fi
# The top-level keys of the imported record holding a mask leaf anywhere —
# the writable keys that are not attributes. Phase 5 needs one.
MASKED_KEYS="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json | python3 -c '
import sys, json
def masked(v):
    if v == sys.argv[1]: return True
    if isinstance(v, dict): return any(masked(x) for x in v.values())
    if isinstance(v, list): return any(masked(x) for x in v)
    return False
attrs = json.load(sys.stdin)["state"]["resources"]["Act"].get("attributes") or {}
print(" ".join(sorted(k for k, v in attrs.items() if masked(v))))' "${MASK}")"
case " ${MASKED_KEYS} " in
  *" Name "*)
    echo "FAIL: the fresh import masked Name inside a container (${MASKED_KEYS})" >&2
    exit 1
    ;;
esac
KEPT_KEY="${MASKED_KEYS%% *}"
if [ -z "${KEPT_KEY}" ]; then
  echo "FAIL: premise gone — the fresh import masked no key of Act, so phase 5 (#2927 shape 2) exercises nothing. Pick a type whose model carries a writable non-attribute key." >&2
  exit 1
fi
echo "==> Phase 4 ok: fresh import recorded Name=${FRESH_NAME}; masked keys: ${MASKED_KEYS}"

# ---------------------------------------------------------------------------
echo "==> Phase 5: KEY ASSERTION — a re-import over a masked record keeps it and warns"
# ---------------------------------------------------------------------------
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --force --yes --verbose > "${IMPORT_LOG}" 2>&1 \
  || { cat "${IMPORT_LOG}"; echo "FAIL: phase 5 import exited non-zero" >&2; exit 1; }
cat "${IMPORT_LOG}"
KEPT_VALUE="$(act_attr "${KEPT_KEY}")"
case "${KEPT_VALUE}" in
  *"${MASK}"*) ;;
  *)
    echo "FAIL: the re-import left ${KEPT_KEY} as '${KEPT_VALUE}', expected the kept mask (never dropped)" >&2
    exit 1
    ;;
esac
WARN_LINE="$(grep -F "${KEPT_MASK_WARNING}" "${IMPORT_LOG}" || true)"
if [ -z "${WARN_LINE}" ]; then
  echo "FAIL: the re-import kept a mask without warning (issue #2927)" >&2
  exit 1
fi
if ! printf '%s\n' "${WARN_LINE}" | grep -qE "Act: ${KEPT_MASK_WARNING} recorded under ([A-Za-z0-9]+, )*${KEPT_KEY}(, [A-Za-z0-9]+)*, so"; then
  echo "FAIL: the kept-mask warning does not name Act and ${KEPT_KEY}: ${WARN_LINE}" >&2
  exit 1
fi
if printf '%s\n' "${WARN_LINE}" | grep -qE "recorded under ([A-Za-z0-9]+, )*Name(, [A-Za-z0-9]+)*, so"; then
  echo "FAIL: the kept-mask warning names Name, which the import must record in the clear (issue #3735)" >&2
  exit 1
fi
if [ "$(act_attr Name)" != "${ACT_NAME}" ]; then
  echo "FAIL: after the phase 5 re-import Act.attributes.Name is '$(act_attr Name)', expected '${ACT_NAME}'" >&2
  exit 1
fi
echo "==> Phase 5 ok: ${KEPT_KEY} mask kept, warning printed, Name still clear"

# ---------------------------------------------------------------------------
echo "==> Phase 6: KEY ASSERTION — cdkd deploy -c phase=3 resolves Fn::GetAtt [Act, Name] from the IMPORTED record"
# ---------------------------------------------------------------------------
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" -c phase=3 --verbose > "${DEPLOY_LOG}" 2>&1 \
  || { cat "${DEPLOY_LOG}"; echo "FAIL: phase 6 deploy exited non-zero (pre-#3735: the redacted-attribute refusal for Name)" >&2; exit 1; }
cat "${DEPLOY_LOG}"
PARAM_DESC="$(aws ssm describe-parameters --parameter-filters "Key=Name,Values=${PARAM_NAME}" \
  --query 'Parameters[0].Description' --output text)"
if [ "${PARAM_DESC}" != "cdkd issue 2927 consumer, phase 3" ]; then
  echo "FAIL: ${PARAM_NAME} description is '${PARAM_DESC}' — the consumer was not updated, so Name was never re-resolved" >&2
  exit 1
fi
PARAM_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --query Parameter.Value --output text)"
if [ "${PARAM_VALUE}" != "${ACT_NAME}" ]; then
  echo "FAIL: after the phase 6 update ${PARAM_NAME} holds '${PARAM_VALUE}', expected '${ACT_NAME}'" >&2
  exit 1
fi
echo "==> Phase 6 ok: consumer updated over the imported record, parameter=${PARAM_VALUE}"

# ---------------------------------------------------------------------------
echo "==> Phase 7: cdkd destroy --force"
# ---------------------------------------------------------------------------
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "activity ${ACT_ARN} still exists after destroy" \
  aws stepfunctions describe-activity --activity-arn "${ACT_ARN}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "==> Phase 7 ok: activity, parameter and state gone"

rm -f "${IMPORT_LOG}" "${DEPLOY_LOG}"
trap - EXIT INT TERM
echo "[verify] PASS — import records a writable Fn::GetAtt attribute in the clear (issue #3735); re-import keeps recorded values over masks, and keeps + reports a mask it cannot replace (issue #2927)"
