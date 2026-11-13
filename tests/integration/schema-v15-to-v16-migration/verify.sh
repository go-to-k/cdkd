#!/usr/bin/env bash
# verify.sh — cdkd state schema v15 -> v16 migration integ test
# (issue #6170: `StackState.stackIdFromInstance`, the per-stack UUID tail of
# `AWS::StackId` for a newly deployed stack).
#
# A stack first deployed by a v16 binary gets an AWS::StackId ending in a
# UUID; any EXISTING record keeps the tail `cdkd` forever, so a resource named
# from AWS::StackId is never replaced on upgrade. This fixture deploys under
# the RELEASED binary (schema v15), then upgrades with the LOCAL binary and
# proves nothing is replaced and the tail stays `cdkd`.
#
# Every version and value assertion reads S3 or AWS, never a log.
#
# Red line (pre-fix): "the migration deploy replaced the parameter / the tail
# changed / the released binary accepted a v16 record".
#
# PHASES
#   0  preflight, pre-run cleanup, the released binary.
#   1  deploy under the released binary: v15 record, no `stackIdFromInstance`,
#      StackIdOut ends in `/cdkd`, the parameter exists with value `one`.
#   2  the LOCAL binary READS it (`state show --json`): state.json VersionId
#      is unchanged (a read writes nothing).
#   3  LOCAL `diff --fail` exits 0 (no spurious change from the tail).
#   4  LOCAL migration deploy (CDKD_TEST_UPDATE=true): exit 0, v16 record,
#      `stackIdFromInstance` ABSENT, StackIdOut still ends in `/cdkd`, physical
#      ids identical (no replacement), the parameter value is `two`.
#   5  the RELEASED binary refuses the v16 record (`state show` and `deploy`),
#      state.json VersionId unchanged by the attempts.
#   6  LOCAL destroy; parameter, topic and state gone; every object version
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

STACK="CdkdSchemaV15ToV16Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PARAM_PATH="/cdkd-schema-v15-v16/"
PARAM_NAME="${PARAM_PATH}cdkd"
TOPIC_PREFIX="cdkd-schema-v15-v16-"

# The latest released cdkd (`@cdkd/cli`; the old `@go-to-k/cdkd` name stops
# at 0.322.x) when this fixture was written: the release users migrate FROM.
# Phase 0 asserts it writes schema 15, so a later pin that writes a different
# version fails loudly instead of quietly testing nothing.
RELEASED_CDKD_PACKAGE="@cdkd/cli"
RELEASED_CDKD_VERSION="0.346.0"
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
if [ "${LOCAL_SCHEMA_VERSION}" -lt 16 ]; then
  echo "FAIL: the local binary writes schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v16+ local binary" >&2
  exit 1
fi

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
JSON_OUT=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV15ToV16?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  # Direct-API sweep of this fixture's own parameter path and topic names.
  case "${PARAM_PATH}" in
    /cdkd-schema-v15-v16/*)
      for p in $(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --recursive \
        --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
        case "${p}" in
          /cdkd-schema-v15-v16/?*)
            aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1
            ;;
        esac
      done
      ;;
    *)
      echo "WARN: teardown sweep refused -- PARAM_PATH='${PARAM_PATH}' is outside this fixture's scope" >&2
      ;;
  esac
  case "${TOPIC_PREFIX}" in
    cdkd-schema-v15-v16-*)
      for arn in $(aws sns list-topics --region "${REGION}" --query 'Topics[].TopicArn' --output text 2>/dev/null); do
        case "${arn##*:}" in
          cdkd-schema-v15-v16-?*)
            aws sns delete-topic --topic-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
            ;;
        esac
      done
      ;;
    *)
      echo "WARN: teardown sweep refused -- TOPIC_PREFIX='${TOPIC_PREFIX}' is outside this fixture's scope" >&2
      ;;
  esac
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  if [ -n "${RELEASED_TMPDIR}" ] && [ -d "${RELEASED_TMPDIR}" ]; then
    rm -rf "${RELEASED_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${DEPLOY_LOG:-}" "${JSON_OUT:-}"
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
# parsed `Unsupported state schema version 16`; present without it means the
# wording drifted (or the version differs), a loud failure rather than a
# silent zero match.
assert_refusal() { # <label>
  if grep -qF "Unsupported state schema version" "${DEPLOY_LOG}" \
    && ! grep -qF "Unsupported state schema version 16" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: the output refuses a schema version, but not 16 (sentinel: wording or version drifted)"
  fi
  if ! grep -qF "Unsupported state schema version 16" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Unsupported state schema version 16'"
  fi
  if ! grep -qF "Upgrade cdkd" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Upgrade cdkd'"
  fi
  pass "$1: output refuses schema 16 and says 'Upgrade cdkd'"
}

param_value() { # strict read of the parameter's value
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query 'Parameter.Value' --output text
}

physical_ids() { # logical id -> physical id, from the fetched state, sorted
  jq -cS '.resources | map_values(.physicalId)' "${STATE_FILE}"
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: install the released binary (${RELEASED_CDKD_PACKAGE}@${RELEASED_CDKD_VERSION})"
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
assert_eq "premise: the released binary writes schema 15" "${RELEASED_SCHEMA_VERSION}" "15"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the released binary"
# ---------------------------------------------------------------------------
run_cdkd ok "released deploy" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "released deploy"
assert_version "released deploy" "15"
assert_eq "released deploy: the record has no stackIdFromInstance" \
  "$(state_field 'has("stackIdFromInstance")')" "false"
STACK_ID_V15="$(state_field '.outputs.StackIdOut')"
case "${STACK_ID_V15}" in
  */cdkd) pass "released deploy: StackIdOut ends in /cdkd" ;;
  *) fail "released deploy: StackIdOut '${STACK_ID_V15}' does not end in /cdkd" ;;
esac
assert_eq "released deploy: the parameter holds 'one'" "$(param_value)" "one"
IDS_V15="$(physical_ids)"
[ "$(jq 'length' <<<"${IDS_V15}")" -ge 2 ] || fail "released deploy: fewer than 2 physical ids recorded: ${IDS_V15}"
pass "released deploy: physical ids captured (${IDS_V15})"
VID_V15="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local binary READS the v15 record (no write)"
# ---------------------------------------------------------------------------
run_cdkd_json "local state show (v15)" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show (v15): the record is version 15" "$(jq -r '.state.version' "${JSON_OUT}")" "15"
assert_eq "local state show (v15): state.json VersionId is unchanged" "$(state_version_id)" "${VID_V15}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: the local diff sees no change"
# ---------------------------------------------------------------------------
run_cdkd ok "local diff --fail" "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail
assert_eq "local diff: state.json VersionId is unchanged" "$(state_version_id)" "${VID_V15}"

# ---------------------------------------------------------------------------
echo "==> Phase 4: the MIGRATION deploy (value one -> two)"
# ---------------------------------------------------------------------------
export CDKD_TEST_UPDATE=true
run_cdkd ok "local migration deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "local migration deploy"
assert_version "local migration deploy" "${LOCAL_SCHEMA_VERSION}"
assert_eq "local migration deploy: stackIdFromInstance is ABSENT (the existing record keeps its tail)" \
  "$(state_field 'has("stackIdFromInstance")')" "false"
STACK_ID_V16="$(state_field '.outputs.StackIdOut')"
case "${STACK_ID_V16}" in
  */cdkd) pass "local migration deploy: StackIdOut still ends in /cdkd" ;;
  *) fail "local migration deploy: StackIdOut '${STACK_ID_V16}' does not end in /cdkd" ;;
esac
assert_eq "local migration deploy: physical ids identical (no replacement)" "$(physical_ids)" "${IDS_V15}"
assert_eq "local migration deploy: the parameter holds 'two' under the same name" "$(param_value)" "two"
VID_V16="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the released binary refuses the v16 record"
# ---------------------------------------------------------------------------
run_cdkd fail "released state show over v16" "${RELEASED_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_refusal "released state show over v16"
run_cdkd fail "released deploy over v16" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_refusal "released deploy over v16"
assert_eq "released refusals: state.json VersionId is unchanged" "$(state_version_id)" "${VID_V16}"
assert_eq "released refusals: the parameter still holds 'two'" "$(param_value)" "two"

# ---------------------------------------------------------------------------
echo "==> Phase 6: cdkd destroy; everything is gone"
# ---------------------------------------------------------------------------
TOPIC_ARN="$(jq -r '.resources.Topic.physicalId' "${STATE_FILE}")"
case "${TOPIC_ARN}" in
  arn:*:"${TOPIC_PREFIX}"?*) ;;
  *) fail "the recorded topic id '${TOPIC_ARN}' is not this fixture's topic" ;;
esac
run_cdkd ok "local destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the destroy"
assert_gone "parameter ${PARAM_NAME} still exists after the destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
pass "the parameter is gone after the destroy"
assert_gone "topic ${TOPIC_ARN} still exists after the destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
pass "the topic is gone after the destroy"

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v15-to-v16-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
EXPECTED_ASSERTIONS=29
if [ "${ASSERTIONS_RUN:-0}" -ne "${EXPECTED_ASSERTIONS}" ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly ${EXPECTED_ASSERTIONS} — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v15-to-v16-migration test passed (a v15 record is read and diffed unchanged, the migration deploy keeps the tail cdkd and replaces nothing, the released binary refuses the v16 record without a write, and the destroy leaves nothing); ${ASSERTIONS_RUN} assertions executed"
