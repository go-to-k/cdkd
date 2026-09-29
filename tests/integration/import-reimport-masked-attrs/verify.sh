#!/usr/bin/env bash
# verify.sh — a `cdkd import --force` re-import of a Cloud-Control-routed
# resource keeps recorded attribute values over masks (issue #2927).
#
# WHAT THIS PROVES
#
# `CloudControlProvider.import` masks every model key outside the type's
# `readOnlyProperties`, and KEEPS the key. `AWS::StepFunctions::Activity`'s
# `Fn::GetAtt` attribute `Name` is such a key, while the deploy path records
# the whole model, `Name` included. Before the fix, the re-import's bag of masks
# replaced the deploy-recorded bag, so the consumer parameter's next update
# (`Value: Fn::GetAtt [Act, Name]`) was refused. After the fix a masked value
# never displaces an unmasked recorded one, and a mask the record already holds
# is kept (never dropped) with a warning naming the key.
#
# Phases:
#   0. PREMISE: the registry schema's readOnlyProperties omit `Name`, so the
#      Cloud Control import masks it. Without that, phase 2 discriminates
#      nothing.
#   1. `cdkd deploy` (phase=1). The activity is cc-api-routed, state records
#      `Name` unmasked, and the parameter holds the activity name.
#   2. KEY ASSERTION (shape 1): `cdkd import --resource Act=<arn> --force`.
#      State still records `Name` as the activity name (pre-fix: the mask), the
#      import said it kept the recorded value, and printed no kept-mask warning.
#   3. `cdkd deploy -c phase=2` updates the consumer, which re-resolves
#      `Fn::GetAtt [Act, Name]`. Pre-fix this deploy is REFUSED.
#   4. `cdkd state orphan`, then a FRESH import of both resources. With no
#      prior record, `Name` IS recorded as the mask: the in-run proof that the
#      import masks it, so phase 2's pass came from the merge.
#   5. KEY ASSERTION (shape 2): a second `--force` re-import keeps the mask
#      (it is not dropped) and warns, naming `Name`.
#   6. `cdkd destroy --force`, then gone-probes for the activity, the
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
    echo "FAIL: premise gone — /properties/Name is now read-only (${READ_ONLY}); the import no longer masks it, so this fixture discriminates nothing. Pick another type." >&2
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
echo "==> Phase 2: KEY ASSERTION — a --force re-import keeps the recorded Name"
# ---------------------------------------------------------------------------
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --force --yes --verbose > "${IMPORT_LOG}" 2>&1 \
  || { cat "${IMPORT_LOG}"; echo "FAIL: phase 2 import exited non-zero" >&2; exit 1; }
cat "${IMPORT_LOG}"
REIMPORTED_NAME="$(act_attr Name)"
if [ "${REIMPORTED_NAME}" = "${MASK}" ]; then
  echo "FAIL: the re-import replaced the recorded Name with the mask (issue #2927 regression)" >&2
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
# Keys are rendered sorted and comma-separated, and Cloud Control masks other
# writable keys too (EncryptionConfiguration), so match Name within the list.
if ! grep -qE "Act: this import recorded ([A-Za-z0-9]+, )*Name(, [A-Za-z0-9]+)* only as the redaction mask" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import kept the recorded Name without saying so" >&2
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
echo "==> Phase 4: orphan state, then a FRESH import — Name IS masked with no prior record"
# ---------------------------------------------------------------------------
${CLI} state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" --yes
assert_gone "state ${STATE_KEY} still present after orphan" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --resource "NameParam=${PARAM_NAME}" --yes --verbose
FRESH_NAME="$(act_attr Name)"
if [ "${FRESH_NAME}" != "${MASK}" ]; then
  echo "FAIL: a fresh import recorded Name as '${FRESH_NAME}', expected the mask — phase 2 no longer proves the merge" >&2
  exit 1
fi
echo "==> Phase 4 ok: fresh import masked Name"

# ---------------------------------------------------------------------------
echo "==> Phase 5: KEY ASSERTION — a re-import over a masked record keeps it and warns"
# ---------------------------------------------------------------------------
${CLI} import "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --resource "Act=${ACT_ARN}" --force --yes --verbose > "${IMPORT_LOG}" 2>&1 \
  || { cat "${IMPORT_LOG}"; echo "FAIL: phase 5 import exited non-zero" >&2; exit 1; }
cat "${IMPORT_LOG}"
KEPT_NAME="$(act_attr Name)"
if [ "${KEPT_NAME}" != "${MASK}" ]; then
  echo "FAIL: the re-import left Name as '${KEPT_NAME}', expected the kept mask (never dropped)" >&2
  exit 1
fi
WARN_LINE="$(grep -F "${KEPT_MASK_WARNING}" "${IMPORT_LOG}" || true)"
if [ -z "${WARN_LINE}" ]; then
  echo "FAIL: the re-import kept a mask without warning (issue #2927)" >&2
  exit 1
fi
if ! printf '%s\n' "${WARN_LINE}" | grep -qE "Act: ${KEPT_MASK_WARNING} recorded under ([A-Za-z0-9]+, )*Name,"; then
  echo "FAIL: the kept-mask warning does not name Act and Name: ${WARN_LINE}" >&2
  exit 1
fi
echo "==> Phase 5 ok: mask kept, warning printed"

# ---------------------------------------------------------------------------
echo "==> Phase 6: cdkd destroy --force"
# ---------------------------------------------------------------------------
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "activity ${ACT_ARN} still exists after destroy" \
  aws stepfunctions describe-activity --activity-arn "${ACT_ARN}"
assert_gone "parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "==> Phase 6 ok: activity, parameter and state gone"

rm -f "${IMPORT_LOG}" "${DEPLOY_LOG}"
trap - EXIT INT TERM
echo "[verify] PASS — re-import keeps recorded attribute values over masks, and keeps + reports a mask it cannot replace (issue #2927)"
