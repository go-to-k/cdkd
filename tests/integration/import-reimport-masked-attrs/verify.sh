#!/usr/bin/env bash
# verify.sh — Cloud Control records an `Fn::GetAtt` attribute that is also a
# WRITABLE property in the clear (issue #3735) and masks every other model key
# on DEPLOY as well as on import (issue #2925), and a `cdkd import --force`
# re-import keeps recorded values over masks (issue #2927).
#
# WHAT THIS PROVES
#
# `CloudControlProvider` records, on create / update and on import, only the
# type's `Fn::GetAtt` attributes in the clear and masks every other model key,
# KEEPING the key. `AWS::StepFunctions::Activity`'s `Name` is writable yet an
# attribute (certified by the #3735 table), so the consumer parameter
# (`Value: Fn::GetAtt [Act, Name]`) resolves; its non-attribute keys
# (`EncryptionConfiguration` in a live model) are masked. Before #2925 a
# deploy recorded the whole model, so the first deploy after an import
# replaced the import's narrowing. The #2927 merge (a mask never displaces an
# unmasked recorded value, and a kept mask is never dropped) runs on the
# masked keys; since #2925 a kept mask the template does not read is reported
# at `--verbose` only, not warned.
#
# Phases:
#   0. PREMISE: the registry schema's readOnlyProperties omit `Name`, so only
#      the #3735 table certifies it.
#   1. KEY ASSERTION (#2925): `cdkd deploy` (phase=1). cc-api-routed, `Name`
#      in the clear, and at least one OTHER key masked (pre-fix: none — the
#      deploy recorded the whole model). The parameter holds the name.
#   2. `cdkd import --resource Act=<arn> --force`. `Name` stays clear and is
#      not reported as masked; the record's masks are kept, reported on the
#      `--verbose` line, and NOT warned (the template reads none of them).
#   3. `cdkd deploy -c phase=2` updates the consumer (re-resolves `Name`).
#   4. KEY ASSERTION (#3735): `cdkd state orphan`, then a FRESH import of both
#      resources records `Name` in the clear (pre-fix: the mask) and masks
#      every other key but `Arn`, by the same rule as the deploy. (Not the
#      same KEYS: a create event's model and GetResource's may differ.)
#   5. KEY ASSERTION (#2927 shape 2): a second `--force` re-import keeps those
#      masks (never dropped) and reports them, still without a warning.
#   6. KEY ASSERTION (#3735): `cdkd deploy -c phase=3` updates the consumer
#      over the IMPORTED record. Pre-fix this deploy is REFUSED.
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
# The default-verbosity line `buildStackState` prints for a kept mask the
# template READS, and the `--verbose` line for one it does not (issue #2925).
KEPT_MASK_WARNING="this import produced no value to replace the redaction mask"
KEPT_MASK_DEBUG="the redaction mask stays recorded under"

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

# The narrowing RULE, asserted on whichever model a path read (a create
# event's and a GetResource's need not carry the same keys): every top-level
# key of the Act record except the attributes `Arn` and `Name` is masked, and
# `Name` is present and clear. Usage: assert_narrowed <phase label>
assert_narrowed() {
  local clear
  clear="$(${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json | python3 -c '
import sys, json
def masked(v):
    if v == sys.argv[1]: return True
    if isinstance(v, dict): return any(masked(x) for x in v.values())
    if isinstance(v, list): return any(masked(x) for x in v)
    return False
attrs = json.load(sys.stdin)["state"]["resources"]["Act"].get("attributes") or {}
# An EMPTY container has no leaf to mask (maskLeavesDeep keeps it empty), so
# it carries no value either way and does not count as clear.
def empty(v): return isinstance(v, (dict, list)) and not v
print(" ".join(sorted(k for k, v in attrs.items() if not masked(v) and not empty(v))))' "${MASK}")"
  case " ${clear} " in
    *" Name "*) ;;
    *)
      echo "FAIL: $1: Name is not recorded in the clear (clear keys: '${clear}')" >&2
      exit 1
      ;;
  esac
  for key in ${clear}; do
    case "${key}" in
      Arn | Name) ;;
      *)
        echo "FAIL: $1: ${key} is recorded in the clear but is not an Fn::GetAtt attribute of AWS::StepFunctions::Activity" >&2
        exit 1
        ;;
    esac
  done
}

# The top-level keys of the Act record holding a mask leaf anywhere.
masked_keys() {
  ${CLI} state show "${STACK}" --state-bucket "${STATE_BUCKET}" --json | python3 -c '
import sys, json
def masked(v):
    if v == sys.argv[1]: return True
    if isinstance(v, dict): return any(masked(x) for x in v.values())
    if isinstance(v, list): return any(masked(x) for x in v)
    return False
attrs = json.load(sys.stdin)["state"]["resources"]["Act"].get("attributes") or {}
print(" ".join(sorted(k for k, v in attrs.items() if masked(v))))' "${MASK}"
}

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
echo "==> Phase 1: KEY ASSERTION — cdkd deploy (phase=1) masks the non-attribute keys"
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
DEPLOYED_MASKED="$(masked_keys)"
case " ${DEPLOYED_MASKED} " in
  *" Name "*)
    echo "FAIL: the deploy masked Name (${DEPLOYED_MASKED}), an Fn::GetAtt attribute (issue #3735)" >&2
    exit 1
    ;;
esac
assert_narrowed "after the deploy"
KEPT_KEY="${DEPLOYED_MASKED%% *}"
if [ -z "${KEPT_KEY}" ]; then
  echo "FAIL: the deploy masked no key of Act — it recorded the whole Cloud Control model (issue #2925 regression), or the model has no non-attribute key left" >&2
  exit 1
fi
echo "==> Phase 1 ok: cc-api, Name recorded, masked keys: ${DEPLOYED_MASKED}, parameter=${PARAM_VALUE}"

# ---------------------------------------------------------------------------
echo "==> Phase 2: a --force re-import keeps Name clear and the deploy's masks, without a warning"
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
# The record already holds the deploy's masks, so the import keeps them
# (#2927) and, the template reading none of them, reports them on the
# `--verbose` line instead of warning (#2925). Asserting that line first keeps
# the negatives below from passing on a reworded message.
if ! grep -qE "Act: ${KEPT_MASK_DEBUG} ([A-Za-z0-9]+, )*${KEPT_KEY}(, [A-Za-z0-9]+)*; this template reads none of them" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import did not report the kept ${KEPT_KEY} mask on the --verbose line" >&2
  exit 1
fi
if grep -qF "${KEPT_MASK_WARNING}" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import warned about a kept mask the template never reads (issue #2925)" >&2
  exit 1
fi
if grep -qE "Act: (this import recorded|${KEPT_MASK_DEBUG}) ([A-Za-z0-9]+, )*Name(, [A-Za-z0-9]+)*[ ;]" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import treated Name as masked (issue #3735 regression)" >&2
  exit 1
fi
# INCLUSION, not equality: GetResource may carry a key the create event did
# not, which the import masks too.
REIMPORT_MASKED=" $(masked_keys) "
for key in ${DEPLOYED_MASKED}; do
  case "${REIMPORT_MASKED}" in
    *" ${key} "*) ;;
    *)
      echo "FAIL: the re-import no longer masks ${key} (masked now:${REIMPORT_MASKED}), which the deploy masked — a mask was dropped or replaced" >&2
      exit 1
      ;;
  esac
done
assert_narrowed "after the re-import"
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
# The same RULE as the deploy, on the GetResource model.
assert_narrowed "after the fresh import"
MASKED_KEYS="$(masked_keys)"
case " ${MASKED_KEYS} " in
  *" ${KEPT_KEY} "*) ;;
  *)
    echo "FAIL: the fresh import does not mask ${KEPT_KEY} (masked: '${MASKED_KEYS}'), which phase 5 re-imports over" >&2
    exit 1
    ;;
esac
echo "==> Phase 4 ok: fresh import recorded Name=${FRESH_NAME}; masked keys: ${MASKED_KEYS}"

# ---------------------------------------------------------------------------
echo "==> Phase 5: KEY ASSERTION — a re-import over a masked record keeps the mask and reports it"
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
if ! grep -qE "Act: ${KEPT_MASK_DEBUG} ([A-Za-z0-9]+, )*${KEPT_KEY}(, [A-Za-z0-9]+)*; this template reads none of them" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import kept the ${KEPT_KEY} mask without reporting it (issue #2927)" >&2
  exit 1
fi
if grep -qF "${KEPT_MASK_WARNING}" "${IMPORT_LOG}"; then
  echo "FAIL: the re-import warned about a kept mask the template never reads (issue #2925)" >&2
  exit 1
fi
if [ "$(act_attr Name)" != "${ACT_NAME}" ]; then
  echo "FAIL: after the phase 5 re-import Act.attributes.Name is '$(act_attr Name)', expected '${ACT_NAME}'" >&2
  exit 1
fi
echo "==> Phase 5 ok: ${KEPT_KEY} mask kept and reported at --verbose, Name still clear"

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
echo "[verify] PASS — deploy and import record a writable Fn::GetAtt attribute in the clear (issue #3735) and mask the rest (issue #2925); re-import keeps masks and reports them (issue #2927)"
