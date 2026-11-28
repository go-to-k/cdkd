#!/usr/bin/env bash
# verify.sh — cdkd state schema v16 -> v17 migration integ test
# (issue #6146: `ResourceState.noEchoValueMacs`, a CONDITIONAL bump).
#
# A save writes schema 17 only for a state some record of which carries a
# NoEcho value MAC, and 16 otherwise. This fixture deploys under the RELEASED
# binary (schema v16), then upgrades with the LOCAL binary and proves the
# round trip for both arms: a write with no MAC stays 16, the write that
# records a MAC persists 17, and the released binary refuses that 17.
#
# Every version and value assertion reads S3 or AWS, never a log.
#
# Red line (pre-fix): "the no-MAC write stamped 17 / the MAC write stamped 16
# / the released binary accepted a v17 record".
# Phase 6 red line (issue #6440): "the local binary refused to read a newer
# record that names a readable minReaderVersion / a deploy or destroy over it
# changed AWS or the state".
#
# PHASES
#   0  preflight, pre-run cleanup, the released binary, the region's MAC key
#      (`cdkd bootstrap --no-assets` with the LOCAL binary; kept: bootstrap
#      infrastructure).
#   1  deploy under the released binary: v16 record, no MAC anywhere.
#   2  the LOCAL binary READS it (`state show --json`): VersionId unchanged.
#   3  LOCAL deploy changing only the SSM parameter: the state is written
#      (VersionId moves), still v16, no MAC (the Body is not put: no MAC yet).
#   4  LOCAL deploy changing the Body's unmasked `info.version`: the Body is
#      put and its MAC recorded, so the record is v17.
#   5  the RELEASED binary refuses the v17 record (`state show` and `deploy`),
#      state.json VersionId unchanged by the attempts.
#   6  a NEWER cdkd's record (issue #6440): the v17 record hand-planted as
#      `version: <newest schema the local binary reads> + 1,
#      minReaderVersion: 17`. The LOCAL binary reads it
#      read-only: `cdkd diff` exits 3 with the deploy-refusal reason, `state
#      show` / `state resources` succeed, and `cdkd deploy` / `cdkd destroy`
#      refuse at the load with "written by a newer cdkd ... Upgrade cdkd",
#      changing nothing: state.json VersionId and ETag, the parameter's value,
#      the REST API, and no lock.json left. The original record is restored
#      (by `cleanup` too, so a failure mid-phase never strands a record the
#      teardown's destroy would refuse).
#      The plant is an out-of-band edit on purpose: no released cdkd writes a
#      newer-but-readable record yet, so it is the only way to reach this
#      read path against real AWS.
#   7  LOCAL destroy; REST API, parameter and state gone; every object version
#      under the stack prefix purged.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

cd "$(dirname "$0")"

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

. ../s3-versions.sh

STACK="CdkdSchemaV16ToV17Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PARAM_PATH="/cdkd-schema-v16-v17/"
PARAM_NAME="${PARAM_PATH}value"
API_NAME="${STACK}-api"
RUN_ID="${RUN_ID:-$(date +%s)}"
export CDKD_TEST_NOECHO_TOKEN="noecho-v16-v17-${RUN_ID}"

# The latest released cdkd (`@cdkd/cli`; the old `@go-to-k/cdkd` name stops
# at 0.322.x) when this fixture was written: the release users migrate FROM.
# Phase 0 asserts it writes schema 16, so a later pin that writes a different
# version fails loudly instead of quietly testing nothing.
RELEASED_CDKD_PACKAGE="@cdkd/cli"
RELEASED_CDKD_VERSION="0.348.0"
RELEASED_TMPDIR=""
RELEASED_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The readable list's LAST entry in a built dist/ (the
# `schema-v9-to-v10-migration` derivation).
schema_version_of_dist() { # <dist dir>
  cat "$1"/*.js 2>/dev/null | awk '
    !inside && !done && /STATE_SCHEMA_VERSIONS_READABLE = \[/ {
      inside = 1
      sub(/.*STATE_SCHEMA_VERSIONS_READABLE = \[/, "")
    }
    inside {
      line = $0
      closes = (line ~ /\]/)
      sub(/\].*/, "", line)
      n = split(line, parts, ",")
      for (i = 1; i <= n; i++) {
        gsub(/[^0-9]/, "", parts[i])
        if (parts[i] != "") last = parts[i]
      }
      if (closes) { inside = 0; done = 1 }
    }
    END { if (done) print last }
  '
}
LOCAL_SCHEMA_VERSION="$(schema_version_of_dist ../../../dist)"
case "${LOCAL_SCHEMA_VERSION}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the readable schema versions from the built dist/ (is it built?)" >&2
    exit 1
    ;;
esac
if [ "${LOCAL_SCHEMA_VERSION}" -lt 17 ]; then
  echo "FAIL: the local binary reads up to schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v17+ local binary" >&2
  exit 1
fi
# The plant in Phase 6 must be NEWER than every schema this binary reads: a
# literal goes stale on the next bump (it was 18, which the v18 binary reads; #7201).
NEWER_SCHEMA_VERSION=$((LOCAL_SCHEMA_VERSION + 1))

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
JSON_OUT=""
# Phase 6: the v17 record as fetched before the plant, and whether a planted
# record may be in S3 right now (set BEFORE the upload, cleared after the
# restore).
ORIGINAL_STATE_FILE=""
PLANTED_STATE_FILE=""
STATE_PLANTED=0

# Put the saved v17 record back. Called by `cleanup` (best-effort, under
# `set +eu`) and on the success path (strict: the caller checks the status).
restore_planted_state() {
  [ "${STATE_PLANTED}" = "1" ] || return 0
  [ -s "${ORIGINAL_STATE_FILE}" ] || { echo "WARN: no saved original state to restore" >&2; return 1; }
  aws s3 cp "${ORIGINAL_STATE_FILE}" "s3://${STATE_BUCKET}/${STATE_KEY}" \
    --content-type application/json >/dev/null || return 1
  STATE_PLANTED=0
}

# A run killed by SIGKILL mid-Phase-6 runs no trap and leaves the planted
# record current, which the next run's destroy refuses. Undo exactly that
# plant (Phase 6 asserts it changed only these two fields); leave any other
# record alone.
heal_stranded_plant() (
  set +eu
  [ -n "${STATE_BUCKET:-}" ] || exit 0
  t="$(mktemp)" || exit 1
  if aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${t}" >/dev/null 2>&1 \
    && jq -e --argjson v "${NEWER_SCHEMA_VERSION:-0}" '.version == $v and .minReaderVersion == 17' "${t}" >/dev/null 2>&1; then
    echo "==> restoring a planted state.json left by a killed run"
    jq 'del(.minReaderVersion) | .version = 17' "${t}" >"${t}.healed" \
      && aws s3 cp "${t}.healed" "s3://${STATE_BUCKET}/${STATE_KEY}" \
        --content-type application/json >/dev/null
  fi
  rm -f "${t}" "${t}.healed"
)

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV16ToV17?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  # FIRST: the destroy below refuses a planted (newer-schema) record.
  restore_planted_state || echo "WARN: could not restore the planted state.json; the destroy below will refuse it" >&2
  heal_stranded_plant || true
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  # Direct-API sweep of this fixture's own parameter path and topic names.
  case "${PARAM_PATH}" in
    /cdkd-schema-v16-v17/*)
      for p in $(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --recursive \
        --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
        case "${p}" in
          /cdkd-schema-v16-v17/?*)
            aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1
            ;;
        esac
      done
      ;;
    *)
      echo "WARN: teardown sweep refused -- PARAM_PATH='${PARAM_PATH}' is outside this fixture's scope" >&2
      ;;
  esac
  case "${API_NAME}" in
    CdkdSchemaV16ToV17?*)
      for id in $(aws apigateway get-rest-apis --region "${REGION}" --limit 500 \
        --query "items[?name=='${API_NAME}'].id" --output text 2>/dev/null); do
        # DeleteRestApi allows one call per 30 s per account.
        aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1 \
          || { sleep 31; aws apigateway delete-rest-api --rest-api-id "${id}" --region "${REGION}" >/dev/null 2>&1; }
      done
      ;;
    *)
      echo "WARN: teardown sweep refused -- API_NAME='${API_NAME}' is outside this fixture's scope" >&2
      ;;
  esac
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  if [ -n "${RELEASED_TMPDIR}" ] && [ -d "${RELEASED_TMPDIR}" ]; then
    rm -rf "${RELEASED_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${DEPLOY_LOG:-}" "${JSON_OUT:-}" \
    "${ORIGINAL_STATE_FILE:-}" "${PLANTED_STATE_FILE:-}"
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
cleanup || true

STATE_FILE="$(mktemp)"
DEPLOY_LOG="$(mktemp)"
JSON_OUT="$(mktemp)"
ORIGINAL_STATE_FILE="$(mktemp)"
PLANTED_STATE_FILE="$(mktemp)"

# --- helpers ----------------------------------------------------------------

pass() {
  echo "    OK: $1"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
fail() {
  echo "FAIL: $1" >&2
  exit 1
}

fetch_state() { # usage: fetch_state <label> — strict
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_FILE}" >/dev/null
  [ -s "${STATE_FILE}" ] || fail "$1: s3://${STATE_BUCKET}/${STATE_KEY} is empty"
}

state_field() { # <jq expression>
  jq -r "$1" "${STATE_FILE}"
}

assert_eq() { # <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    fail "$1: got '$2', expected '$3'"
  fi
  pass "$1"
}

assert_version() { # <label> <expected>
  assert_eq "$1: state.version" "$(state_field '.version')" "$2"
}

# The VersionId of the CURRENT state.json object — strict (a write moves it).
state_version_id() {
  local out
  out="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
    --query VersionId --output text)" || return 1
  [ -n "${out}" ] && [ "${out}" != "None" ] || fail "state.json has no VersionId (is bucket versioning on?)"
  printf '%s' "${out}"
}

# Run a cdkd command, its output into DEPLOY_LOG.
run_cdkd() { # <expect: ok|fail> <label> <binary> <args...>
  local expect="$1" label="$2" bin="$3" rc
  shift 3
  set +e
  AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${expect}" = "ok" ] && [ "${rc}" -ne 0 ]; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "${label}: exited ${rc}"
  fi
  if [ "${expect}" = "fail" ] && [ "${rc}" -eq 0 ]; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "${label}: exited 0, expected a refusal"
  fi
  pass "${label}: exited ${rc} (${expect})"
}

# A `--json` read: stdout alone into JSON_OUT, stderr into DEPLOY_LOG.
run_cdkd_json() { # <label> <binary> <args...>
  local label="$1" bin="$2" rc
  shift 2
  set +e
  AWS_REGION="${REGION}" node "${bin}" "$@" >"${JSON_OUT}" 2>"${DEPLOY_LOG}"
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "${label}: exited ${rc}"
  fi
  jq -e . "${JSON_OUT}" >/dev/null 2>&1 || fail "${label}: stdout is not one JSON document"
  pass "${label}: exited 0 with a JSON document"
}

# The refusal wording, with a sentinel: `Unsupported state schema version`
# (the generic marker, independent of the number) must be present WITH the
# parsed `Unsupported state schema version 17`; present without it means the
# wording drifted (or the version differs), a loud failure rather than a
# silent zero match.
assert_refusal() { # <label>
  if grep -qF "Unsupported state schema version" "${DEPLOY_LOG}" \
    && ! grep -qF "Unsupported state schema version 17" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: the output refuses a schema version, but not 17 (sentinel: wording or version drifted)"
  fi
  if ! grep -qF "Unsupported state schema version 17" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Unsupported state schema version 17'"
  fi
  if ! grep -qF "Upgrade cdkd" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Upgrade cdkd'"
  fi
  pass "$1: output refuses schema 17 and says 'Upgrade cdkd'"
}

param_value() { # strict read of the parameter's value
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query 'Parameter.Value' --output text
}

# Every NoEcho value MAC anywhere in the fetched state (records, orphans,
# superseded copies), as one count.
mac_count() {
  jq '[.. | objects | select(has("noEchoValueMacs"))] | length' "${STATE_FILE}"
}

api_body_mac() { # the Body's MAC of Token in the fetched state ('' when none)
  jq -r '.resources.Api.noEchoValueMacs.Body.Token // ""' "${STATE_FILE}"
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: the released binary (${RELEASED_CDKD_PACKAGE}@${RELEASED_CDKD_VERSION}) and the MAC key"
# ---------------------------------------------------------------------------
RELEASED_TMPDIR="$(mktemp -d)"
(cd "${RELEASED_TMPDIR}" && npm init -y >/dev/null && npm install --silent "${RELEASED_CDKD_PACKAGE}@${RELEASED_CDKD_VERSION}" >/dev/null)
RELEASED_BIN="${RELEASED_TMPDIR}/node_modules/${RELEASED_CDKD_PACKAGE}/dist/cli.js"
RELEASED_DIR="${RELEASED_TMPDIR}/node_modules/${RELEASED_CDKD_PACKAGE}/dist"
[ -f "${RELEASED_BIN}" ] || fail "the released binary was not installed at ${RELEASED_BIN}"
RELEASED_SCHEMA_VERSION="$(schema_version_of_dist "${RELEASED_DIR}")"
case "${RELEASED_SCHEMA_VERSION}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the readable schema versions from the released binary's dist/" >&2
    exit 1
    ;;
esac
assert_eq "premise: the released binary writes schema 16" "${RELEASED_SCHEMA_VERSION}" "16"
run_cdkd ok "local bootstrap (the MAC key)" "${LOCAL_DIST}" bootstrap --no-assets \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}"
assert_eq "premise: the region's MAC key is an enabled HMAC_256 key" \
  "$(aws kms describe-key --key-id alias/cdkd-noecho-mac --region "${REGION}" \
    --query 'KeyMetadata.[KeySpec,KeyState]' --output text | tr '\t' ' ')" "HMAC_256 Enabled"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the released binary"
# ---------------------------------------------------------------------------
export CDKD_TEST_PARAM_VALUE=one CDKD_TEST_BODY_VERSION=1
run_cdkd ok "released deploy" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "released deploy"
assert_version "released deploy" "16"
assert_eq "released deploy: no NoEcho value MAC anywhere" "$(mac_count)" "0"
assert_eq "released deploy: the parameter holds 'one'" "$(param_value)" "one"
VID_V16="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local binary READS the v16 record (no write)"
# ---------------------------------------------------------------------------
run_cdkd_json "local state show (v16)" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show (v16): the record is version 16" "$(jq -r '.state.version' "${JSON_OUT}")" "16"
assert_eq "local state show (v16): state.json VersionId is unchanged" "$(state_version_id)" "${VID_V16}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: a LOCAL write with no MAC stays version 16"
# ---------------------------------------------------------------------------
export CDKD_TEST_PARAM_VALUE=two
run_cdkd ok "local deploy (parameter only)" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
VID_NO_MAC="$(state_version_id)"
[ "${VID_NO_MAC}" != "${VID_V16}" ] || fail "local deploy (parameter only): the state was not written"
pass "local deploy (parameter only): the state was written"
fetch_state "local deploy (parameter only)"
assert_version "local deploy (parameter only)" "16"
assert_eq "local deploy (parameter only): no NoEcho value MAC anywhere" "$(mac_count)" "0"
assert_eq "local deploy (parameter only): the parameter holds 'two'" "$(param_value)" "two"

# ---------------------------------------------------------------------------
echo "==> Phase 4: the LOCAL write that records a MAC persists version 17"
# ---------------------------------------------------------------------------
export CDKD_TEST_BODY_VERSION=2
run_cdkd ok "local deploy (Body put)" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "local deploy (Body put)"
assert_version "local deploy (Body put)" "17"
BODY_MAC="$(api_body_mac)"
case "${BODY_MAC}" in
  kms-hmac-sha256:arn:aws*:kms:*) pass "local deploy (Body put): the Body's MAC is recorded" ;;
  *) fail "local deploy (Body put): no Body MAC recorded (got '${BODY_MAC}')" ;;
esac
if grep -qF -e "${CDKD_TEST_NOECHO_TOKEN}" "${STATE_FILE}"; then fail "state.json holds the NoEcho value"; fi
pass "local deploy (Body put): state.json holds no NoEcho value"
VID_V17="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the released binary refuses the v17 record"
# ---------------------------------------------------------------------------
run_cdkd fail "released state show over v17" "${RELEASED_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_refusal "released state show over v17"
run_cdkd fail "released deploy over v17" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_refusal "released deploy over v17"
assert_eq "released refusals: state.json VersionId is unchanged" "$(state_version_id)" "${VID_V17}"

# ---------------------------------------------------------------------------
echo "==> Phase 6: a newer cdkd's record is read read-only, never written (issue #6440)"
# ---------------------------------------------------------------------------
# The current object's ETag — strict, like `state_version_id`.
state_etag() {
  local out
  out="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
    --query ETag --output text)" || return 1
  [ -n "${out}" ] && [ "${out}" != "None" ] || fail "state.json has no ETag"
  printf '%s' "${out}"
}

# The read-only refusal a writer prints at its load. Sentinel: the
# number-independent `Upgrade cdkd to a version that supports schema` present
# WITHOUT the parsed `written by a newer cdkd (state schema version N)` means
# the wording or the version drifted — a loud failure, not a zero match.
assert_newer_refusal() { # <label>
  if grep -qF "Upgrade cdkd to a version that supports schema" "${DEPLOY_LOG}" \
    && ! grep -qF "written by a newer cdkd (state schema version ${NEWER_SCHEMA_VERSION})" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: the output says 'Upgrade cdkd', but not for a newer schema ${NEWER_SCHEMA_VERSION} (sentinel: wording or version drifted)"
  fi
  if ! grep -qF "written by a newer cdkd (state schema version ${NEWER_SCHEMA_VERSION})" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'written by a newer cdkd (state schema version ${NEWER_SCHEMA_VERSION})'"
  fi
  if ! grep -qF "Upgrade cdkd to a version that supports schema ${NEWER_SCHEMA_VERSION}" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Upgrade cdkd to a version that supports schema ${NEWER_SCHEMA_VERSION}'"
  fi
  pass "$1: output refuses the newer schema ${NEWER_SCHEMA_VERSION} record and says 'Upgrade cdkd'"
}

# Nothing changed: the planted object, the parameter, the REST API, no lock.
assert_nothing_changed() { # <label>
  assert_eq "$1: state.json VersionId is unchanged" "$(state_version_id)" "${VID_PLANTED}"
  assert_eq "$1: state.json ETag is unchanged" "$(state_etag)" "${ETAG_PLANTED}"
  assert_eq "$1: the parameter still holds 'two'" "$(param_value)" "two"
  if gone_probe aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"; then
    fail "$1: REST API ${API_ID} is gone"
  fi
  pass "$1: the REST API still exists"
  assert_gone "$1: s3://${STATE_BUCKET}/${LOCK_KEY} was left behind" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LOCK_KEY}"
  pass "$1: no lock.json is left behind"
}

API_ID="$(jq -r '.resources.Api.physicalId' "${STATE_FILE}")"
[ -n "${API_ID}" ] && [ "${API_ID}" != "null" ] || fail "no REST API id recorded"
# Save the v17 record (fetched after Phase 4, unchanged since: Phase 5) and
# plant the same record as a newer writer's, every other field kept.
assert_eq "premise: the saved record is the current object" "$(state_version_id)" "${VID_V17}"
cp "${STATE_FILE}" "${ORIGINAL_STATE_FILE}"
jq --argjson v "${NEWER_SCHEMA_VERSION}" '.version = $v | .minReaderVersion = 17' "${ORIGINAL_STATE_FILE}" >"${PLANTED_STATE_FILE}"
assert_eq "plant: only version and minReaderVersion differ" \
  "$(jq -S 'del(.version, .minReaderVersion)' "${PLANTED_STATE_FILE}" | shasum -a 256)" \
  "$(jq -S 'del(.version, .minReaderVersion)' "${ORIGINAL_STATE_FILE}" | shasum -a 256)"
STATE_PLANTED=1
aws s3 cp "${PLANTED_STATE_FILE}" "s3://${STATE_BUCKET}/${STATE_KEY}" \
  --content-type application/json >/dev/null
fetch_state "plant"
assert_version "plant" "${NEWER_SCHEMA_VERSION}"
assert_eq "plant: state.minReaderVersion" "$(state_field '.minReaderVersion')" "17"
VID_PLANTED="$(state_version_id)"
ETAG_PLANTED="$(state_etag)"

# A template change the deploy WOULD apply, so "nothing changed" is a refusal
# and not an empty diff.
export CDKD_TEST_PARAM_VALUE=three

set +e
AWS_REGION="${REGION}" node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DEPLOY_LOG}" 2>&1
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ne 3 ]; then
  tail -40 "${DEPLOY_LOG}" >&2
  fail "local diff over v${NEWER_SCHEMA_VERSION}: exited ${DIFF_RC}, expected 3 (a deploy refusal)"
fi
pass "local diff over v${NEWER_SCHEMA_VERSION}: exited 3"
# Sentinel: the `Blocking (cdkd deploy will refuse):` header with no newer-
# record reason under it means the reason's wording drifted.
grep -qF "Blocking (cdkd deploy will refuse):" "${DEPLOY_LOG}" \
  || { tail -40 "${DEPLOY_LOG}" >&2; fail "local diff over v${NEWER_SCHEMA_VERSION}: no 'Blocking (cdkd deploy will refuse):' section"; }
grep -qF "The state record was written by a newer cdkd (state schema version ${NEWER_SCHEMA_VERSION})." "${DEPLOY_LOG}" \
  || { tail -40 "${DEPLOY_LOG}" >&2; fail "local diff over v${NEWER_SCHEMA_VERSION}: the Blocking section lacks the newer-record reason (sentinel: wording drifted)"; }
grep -qF "'cdkd deploy' with this cdkd binary refuses to write it." "${DEPLOY_LOG}" \
  || { tail -40 "${DEPLOY_LOG}" >&2; fail "local diff over v${NEWER_SCHEMA_VERSION}: the reason does not say the deploy refuses"; }
pass "local diff over v${NEWER_SCHEMA_VERSION}: the Blocking section names the newer record and the deploy's refusal"

run_cdkd_json "local state show over v${NEWER_SCHEMA_VERSION}" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show over v${NEWER_SCHEMA_VERSION}: the record is version ${NEWER_SCHEMA_VERSION}" "$(jq -r '.state.version' "${JSON_OUT}")" "${NEWER_SCHEMA_VERSION}"
assert_eq "local state show over v${NEWER_SCHEMA_VERSION}: the Api's physical id" \
  "$(jq -r '.state.resources.Api.physicalId' "${JSON_OUT}")" "${API_ID}"

run_cdkd_json "local state resources over v${NEWER_SCHEMA_VERSION}" "${LOCAL_DIST}" state resources "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state resources over v${NEWER_SCHEMA_VERSION}: the logical ids" \
  "$(jq -r '[.[].logicalId] | sort | join(",")' "${JSON_OUT}")" "Api,Param"
assert_eq "local state resources over v${NEWER_SCHEMA_VERSION}: the parameter's physical id" \
  "$(jq -r '.[] | select(.logicalId == "Param") | .physicalId' "${JSON_OUT}")" "${PARAM_NAME}"
assert_nothing_changed "local reads over v${NEWER_SCHEMA_VERSION}"

run_cdkd fail "local deploy over v${NEWER_SCHEMA_VERSION}" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_newer_refusal "local deploy over v${NEWER_SCHEMA_VERSION}"
assert_nothing_changed "local deploy over v${NEWER_SCHEMA_VERSION}"

run_cdkd fail "local destroy over v${NEWER_SCHEMA_VERSION}" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_newer_refusal "local destroy over v${NEWER_SCHEMA_VERSION}"
assert_nothing_changed "local destroy over v${NEWER_SCHEMA_VERSION}"

export CDKD_TEST_PARAM_VALUE=two
restore_planted_state || fail "could not restore the original state.json"
fetch_state "restore"
assert_version "restore" "17"
if jq -e 'has("minReaderVersion")' "${STATE_FILE}" >/dev/null; then fail "restore: state.json still carries minReaderVersion"; fi
pass "restore: state.json carries no minReaderVersion"

# ---------------------------------------------------------------------------
echo "==> Phase 7: cdkd destroy; everything is gone"
# ---------------------------------------------------------------------------
API_ID="$(jq -r '.resources.Api.physicalId' "${STATE_FILE}")"
[ -n "${API_ID}" ] && [ "${API_ID}" != "null" ] || fail "no REST API id recorded"
run_cdkd ok "local destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the destroy"
assert_gone "parameter ${PARAM_NAME} still exists after the destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
pass "the parameter is gone after the destroy"
assert_gone "REST API ${API_ID} still exists after the destroy" \
  aws apigateway get-rest-api --rest-api-id "${API_ID}" --region "${REGION}"
pass "the REST API is gone after the destroy"

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v16-to-v17-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
EXPECTED_ASSERTIONS=62
if [ "${ASSERTIONS_RUN:-0}" -ne "${EXPECTED_ASSERTIONS}" ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly ${EXPECTED_ASSERTIONS} — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v16-to-v17-migration test passed (a v16 record is read unchanged, a write with no MAC stays 16, the write recording a MAC persists 17, the released binary refuses the v17 record without a write, a newer schema ${NEWER_SCHEMA_VERSION} record is read read-only and never written, and the destroy leaves nothing); ${ASSERTIONS_RUN} assertions executed"
