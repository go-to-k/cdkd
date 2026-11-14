#!/usr/bin/env bash
# verify.sh — a plain template literal that contains a generated secret's
# plaintext stays a literal in state (issue #6303).
#
# State-persist secret redaction used to replace EVERY occurrence of a resolved
# secret's plaintext with its `{{resolve:...}}` expression, even inside an
# unrelated plain literal: with the generated username `postgres`, the literal
# `engine aurora-postgresql` was stored as
# `engine aurora-{{resolve:secretsmanager:...:SecretString:username::}}ql` and
# the next `cdkd diff` reported a change. The fix keeps a value that is exactly
# the template's own plain literal, and repairs already-mangled records.
#
# Phases:
#   1. Deploy. Param.Description is stored verbatim (properties AND
#      observedProperties), Param.Value is still the {{resolve:...}} reference,
#      the generated password never reaches state.json, and the live
#      Description is the literal.
#   2. `cdkd diff` reports no change.
#   3. Legacy repair via `cdkd scrub`: seed the pre-fix spelling into state,
#      prove the seed took (`cdkd diff` now reports Param), scrub, assert both
#      Descriptions are the literal again.
#   4. Legacy repair via `cdkd deploy` (template unchanged): seed again, deploy,
#      assert NO update reached AWS for Param (no UPDATE event, SSM parameter
#      Version unchanged), the Descriptions are the literal and `cdkd diff` is
#      clean.
#   5. Destroy; assert the secret and parameter are gone, the state file is
#      removed and the state bucket's object versions are swept (the seeded
#      state held the secret's username token; the secret is generated).
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

# The seeded state holds the secret's username token and the state bucket is
# versioned, so teardown must sweep object VERSIONS (issue #2096).
. ../s3-versions.sh

STACK="CdkdSecretSubstringLiteral"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
LITERAL="engine aurora-postgresql"
# Recorded after Phase 1 so cleanup can force-delete by id (the names are generated).
SECRET_ID=""
PARAM_NAME=""

LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort delete by recorded id in case state destroy missed them.
  if [ -n "${SECRET_ID}" ]; then
    aws secretsmanager delete-secret --secret-id "${SECRET_ID}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${PARAM_NAME}" ]; then
    aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
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
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required (state assertions parse JSON)" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

assert_eq() { # usage: assert_eq "<what>" <expected> <actual>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}
assert_nonempty() { # usage: assert_nonempty "<what>" <value>
  if [ -z "$2" ]; then
    echo "FAIL: $1 is empty — the assertion built on it would be vacuous" >&2
    exit 1
  fi
}

state_json() { # the whole state.json; a failed read returns non-zero
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - || return 1
}
# Param's record, read BY LOGICAL ID: `param_field .properties.Description`.
param_field() { # usage: param_field <jq path under the Param record>
  local state
  state="$(state_json)" || return 1
  printf '%s' "${state}" | jq -r ".resources.Param${1} // \"\""
}
# Rewrite Param's Description (and observedProperties.Description, when the
# record carries one) to the pre-fix mangled spelling and write it back. No
# cdkd process is running, so no lock is held.
seed_mangled() {
  local state token seeded
  state="$(state_json)" || return 1
  token="$(printf '%s' "${state}" | jq -r '.resources.Param.properties.Value // ""')" || return 1
  case "${token}" in
    '{{resolve:secretsmanager:'*) : ;;
    *) echo "FAIL: seed: Param.properties.Value is not a secretsmanager reference (got '${token}')" >&2; return 1 ;;
  esac
  seeded="$(printf '%s' "${state}" | jq --arg m "engine aurora-${token}ql" '
    .resources.Param.properties.Description = $m
    | if .resources.Param.observedProperties.Description != null
      then .resources.Param.observedProperties.Description = $m else . end')" || return 1
  printf '%s\n' "${seeded}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null || return 1
  case "$(param_field .properties.Description)" in
    "engine aurora-{{resolve:secretsmanager:"*"}}ql") : ;;
    *) echo "FAIL: seeding the mangled Description did not stick" >&2; return 1 ;;
  esac
}
assert_descriptions_literal() { # usage: assert_descriptions_literal "<phase>"
  assert_eq "$1 Param properties.Description" "${LITERAL}" "$(param_field .properties.Description)"
  # observedProperties may legitimately be absent; when present it must be the literal too.
  local obs
  obs="$(param_field .observedProperties.Description)" || return 1
  if [ -n "${obs}" ]; then
    assert_eq "$1 Param observedProperties.Description" "${LITERAL}" "${obs}"
  fi
}
# `cdkd diff` output for the stack. Only cdkd's own verdict line is read
# (aws-cdk-lib `WARNING <Prop>:` lines also land in the output). The clean
# verdict is `✓ No changes detected for stack <stack>`; the SENTINEL is that a
# diff which names Param as a change must not also carry the clean verdict, and
# a diff with neither fails loudly (wording drift would otherwise read as "changed").
diff_out() {
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 \
    | sed $'s/\x1b\\[[0-9;]*m//g'
}
assert_diff_clean() { # usage: assert_diff_clean "<phase>"
  local out
  out="$(diff_out)" || { echo "FAIL: $1 cdkd diff exited non-zero" >&2; exit 1; }
  if ! grep -q "No changes detected for stack ${STACK}" <<<"${out}"; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: $1 cdkd diff did not report 'No changes detected' (issue #6303: the plain literal is stored as a secret reference)" >&2
    exit 1
  fi
}
assert_diff_reports_param() { # usage: assert_diff_reports_param "<phase>"
  local out
  out="$(diff_out)" || { echo "FAIL: $1 cdkd diff exited non-zero" >&2; exit 1; }
  if grep -q "No changes detected for stack ${STACK}" <<<"${out}"; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: $1 cdkd diff reports no change although the mangled record was seeded — the seed did not take" >&2
    exit 1
  fi
  if ! grep -q "Param" <<<"${out}"; then
    printf '%s\n' "${out}" >&2
    echo "FAIL: $1 cdkd diff reports a change but never names Param — its wording drifted" >&2
    exit 1
  fi
}
param_live_description() {
  aws ssm describe-parameters --parameter-filters "Key=Name,Values=${PARAM_NAME}" \
    --region "${REGION}" --query 'Parameters[0].Description' --output text
}
param_live_version() {
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" --query 'Parameter.Version' --output text
}

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

# The L2 secret's logical id carries CDK's hash suffix (`DbSecret685A0FA5`):
# select the single record of its type rather than guessing the suffix.
SECRET_ID="$(printf '%s' "$(state_json)" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::SecretsManager::Secret") | .value.physicalId] | if length == 1 then .[0] else "" end')"
PARAM_NAME="$(printf '%s' "$(state_json)" | jq -r '.resources.Param.physicalId // ""')"
assert_nonempty "Phase 1 DbSecret physicalId" "${SECRET_ID}"
assert_nonempty "Phase 1 Param physicalId" "${PARAM_NAME}"

assert_descriptions_literal "Phase 1 (issue #6303)"
case "$(param_field .properties.Value)" in
  '{{resolve:secretsmanager:'*) : ;;
  *) echo "FAIL: Phase 1 Param properties.Value is not a {{resolve:secretsmanager:...}} reference — the positive control (a real reference stays a reference) is vacuous" >&2; exit 1 ;;
esac
# The generated password must never reach state.json. Read it without echoing.
PASSWORD="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ID}" --region "${REGION}" \
  --query SecretString --output text | jq -r '.password')"
assert_nonempty "Phase 1 generated password" "${PASSWORD}"
STATE_ALL="$(state_json)"
if grep -qF -- "${PASSWORD}" <<<"${STATE_ALL}"; then
  echo "FAIL: Phase 1 state.json contains the generated password in plaintext" >&2
  exit 1
fi
PASSWORD=""
STATE_ALL=""
assert_eq "Phase 1 live SSM Description" "${LITERAL}" "$(param_live_description)"
VERSION_1="$(param_live_version)"
assert_nonempty "Phase 1 live SSM parameter Version" "${VERSION_1}"
echo "    Description stored as the literal; Value still a secret reference; password not in state"

# --- Phase 2: diff is clean --------------------------------------------------
echo "==> Phase 2: cdkd diff reports no change"
assert_diff_clean "Phase 2"
echo "    diff clean"

# --- Phase 3: legacy repair via scrub ----------------------------------------
echo "==> Phase 3: seed the pre-fix spelling, then repair it with cdkd scrub"
seed_mangled
assert_diff_reports_param "Phase 3 (after seeding)"
node "${LOCAL_DIST}" scrub "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
assert_descriptions_literal "Phase 3 (after scrub)"
assert_diff_clean "Phase 3 (after scrub)"
echo "    scrub rewrote the mangled record to the literal"

# --- Phase 4: legacy repair via deploy (no AWS update) -----------------------
echo "==> Phase 4: seed the pre-fix spelling, then repair it with an unchanged-template deploy"
seed_mangled
PHASE4_OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | sed $'s/\x1b\\[[0-9;]*m//g')" || {
  printf '%s\n' "${PHASE4_OUT}" >&2
  echo "FAIL: Phase 4 deploy exited non-zero" >&2
  exit 1
}
printf '%s\n' "${PHASE4_OUT}"
assert_descriptions_literal "Phase 4 (after deploy)"
assert_diff_clean "Phase 4 (after deploy)"
# No UPDATE reached AWS. The plan, computed without resolving the secret, lists
# Param as an update; the engine then finds the record unchanged and skips it.
# Two independent checks: the SSM parameter's Version is unchanged (a
# PutParameter overwrite bumps it), and cdkd's own summary counts no update.
# SENTINEL: the summary line must be present, so a reworded summary fails
# loudly instead of reading as "no update".
assert_eq "Phase 4 live SSM Version (an update was sent to AWS)" "${VERSION_1}" "$(param_live_version)"
assert_eq "Phase 4 live SSM Description" "${LITERAL}" "$(param_live_description)"
if ! grep -q "Deployment Summary:" <<<"${PHASE4_OUT}"; then
  echo "FAIL: Phase 4 deploy printed no 'Deployment Summary:' line — its wording drifted" >&2
  exit 1
fi
if ! grep -qE '^ +Updated: 0$' <<<"${PHASE4_OUT}"; then
  echo "FAIL: Phase 4 deploy summary counts an update for an unchanged template" >&2
  exit 1
fi
echo "    deploy rewrote the record without an AWS update (Version ${VERSION_1}, summary Updated 0)"

# --- Phase 5: destroy --------------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

# DESTROY on a secret schedules deletion (recovery window): it is either gone or
# carries a DeletedDate. Force-delete it so the generated secret does not linger.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_ID}" --region "${REGION}"; then
  DELETED_DATE="GONE"
elif ! DELETED_DATE="$(aws secretsmanager describe-secret --secret-id "${SECRET_ID}" --region "${REGION}" \
    --query 'DeletedDate' --output text 2>&1)"; then
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${DELETED_DATE}" \
    && DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${DELETED_DATE}" >&2; exit 1; }
fi
if [ "${DELETED_DATE}" = "None" ]; then
  echo "FAIL: secret ${SECRET_ID} still live (not deleted/scheduled) after destroy" >&2
  exit 1
fi
echo "    secret deleted (state: ${DELETED_DATE})"
if [ "${DELETED_DATE}" != "GONE" ]; then
  aws secretsmanager delete-secret --secret-id "${SECRET_ID}" --force-delete-without-recovery --region "${REGION}" >/dev/null
  assert_gone "secret ${SECRET_ID} still exists after force delete" aws secretsmanager describe-secret --secret-id "${SECRET_ID}" --region "${REGION}"
fi
assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# Success path: purge EVERY version and delete marker under the stack prefix, then assert it (issue #2096).
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secret-substring-literal state teardown"
echo "    state bucket versions swept"

echo "[verify] PASS — a plain literal containing a secret's username stays a literal in state; scrub and an unchanged deploy repair the legacy spelling without an AWS update (issue #6303)"
