#!/usr/bin/env bash
# verify.sh — cdkd state schema v17 -> v18 migration integ test
# (issue #6824: `ReferenceProvenance.versionsSent`, a CONDITIONAL bump).
#
# A save writes schema 18 only for a state some record of which carries a
# secret version send attestation, and 17 / 16 otherwise. This fixture deploys
# under the RELEASED binary (which writes at most 17, and 16 here: no NoEcho
# MAC), then upgrades with the LOCAL binary and proves the round trip for both
# arms: the local binary reads the record with every command, a write with no
# attestation stays 16, the write that attests the endpoint password's version
# persists 18, and the released binary refuses that 18.
#
# Every version and value assertion reads S3 or AWS, never a log, except the
# skip line of Phase 5 (cdkd's own decision to leave the password unsent).
#
# Red line (pre-fix): "the no-attestation write stamped 18 / the attesting
# write stamped 17 or 16 / the released binary accepted a v18 record".
#
# PHASES
#   0  preflight, pre-run cleanup, the released binary (asserted to read at
#      most schema 17).
#   1  deploy under the released binary: v16 record (no MAC), a plain
#      singleton version for the password reference, no attestation.
#   2  the LOCAL binary READS it with every reading command: `state show`,
#      `state resources`, `state list`, `drift`; state.json VersionId unchanged.
#   3  LOCAL deploy changing only the SSM parameter: the state is written
#      (VersionId moves), still v16, no attestation (the endpoint's record is
#      not rewritten).
#   4  LOCAL deploy changing the endpoint's tag: the released binary's record
#      is not trusted (no attestation), so the password is sent and the write
#      attests its version: the record is v18.
#   5  LOCAL Tags-only deploy again: the password is left out (the attested
#      version is unchanged), still v18.
#   6  the RELEASED binary refuses the v18 record (`state show` and `deploy`),
#      state.json VersionId unchanged by the attempts.
#   7  LOCAL destroy from the v18 record; endpoint, parameter, secret and state
#      gone; every object version under the stack prefix purged.
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

STACK="CdkdSchemaV17ToV18Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PARAM_PATH="/cdkd-schema-v17-v18/"
PARAM_NAME="${PARAM_PATH}value"
ENDPOINT_ID="cdkd-schema-v17-v18"
SKIP_LINE="Password is left out of the patch"

# The latest released cdkd (`@cdkd/cli`) when this fixture was written: the
# release users migrate FROM. Phase 0 asserts it reads at most schema 17, so a
# later pin that already writes 18 fails loudly instead of testing nothing.
RELEASED_CDKD_PACKAGE="@cdkd/cli"
RELEASED_CDKD_VERSION="0.366.0"
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
if [ "${LOCAL_SCHEMA_VERSION}" -lt 18 ]; then
  echo "FAIL: the local binary reads up to schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v18+ local binary" >&2
  exit 1
fi

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
JSON_OUT=""
SECRET_ARN=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV17ToV18?*) ;;
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
  # Direct-API sweep of this fixture's own endpoint, parameter path and secret.
  case "${ENDPOINT_ID}" in
    cdkd-schema-v17-v18)
      for arn in $(aws dms describe-endpoints --region "${REGION}" \
        --filters "Name=endpoint-id,Values=${ENDPOINT_ID}" \
        --query 'Endpoints[].EndpointArn' --output text 2>/dev/null); do
        aws dms delete-endpoint --endpoint-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
      done
      ;;
  esac
  case "${PARAM_PATH}" in
    /cdkd-schema-v17-v18/*)
      for p in $(aws ssm get-parameters-by-path --path "${PARAM_PATH}" --recursive \
        --region "${REGION}" --query 'Parameters[].Name' --output text 2>/dev/null); do
        case "${p}" in
          /cdkd-schema-v17-v18/?*)
            aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1
            ;;
        esac
      done
      ;;
    *)
      echo "WARN: teardown sweep refused -- PARAM_PATH='${PARAM_PATH}' is outside this fixture's scope" >&2
      ;;
  esac
  [ -n "${SECRET_ARN}" ] && aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
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

# `cdkd drift` reads the record: 0 (no drift), 1 (drift) and 2 (incomplete)
# are all a READ; a schema refusal, or any other code, is not.
run_drift_read() { # <label>
  local rc
  set +e
  AWS_REGION="${REGION}" node "${LOCAL_DIST}" drift "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  case "${rc}" in
    0 | 1 | 2) ;;
    *) tail -40 "${DEPLOY_LOG}" >&2; fail "$1: exited ${rc}" ;;
  esac
  if grep -qE "Unsupported state schema version|Upgrade cdkd" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: the record was refused"
  fi
  pass "$1: read the record (exit ${rc})"
}

# The refusal wording, with a sentinel: `Unsupported state schema version`
# (the generic marker) must be present WITH the parsed `... version 18`.
assert_refusal() { # <label>
  if grep -qF "Unsupported state schema version" "${DEPLOY_LOG}" \
    && ! grep -qF "Unsupported state schema version 18" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: the output refuses a schema version, but not 18 (sentinel: wording or version drifted)"
  fi
  if ! grep -qF "Unsupported state schema version 18" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Unsupported state schema version 18'"
  fi
  if ! grep -qF "Upgrade cdkd" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks 'Upgrade cdkd'"
  fi
  pass "$1: output refuses schema 18 and says 'Upgrade cdkd'"
}

param_value() { # strict read of the parameter's value
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
    --query 'Parameter.Value' --output text
}

endpoint_tag() { # the endpoint's `phase` tag, strict
  local arn
  arn="$(aws dms describe-endpoints --region "${REGION}" \
    --filters "Name=endpoint-id,Values=${ENDPOINT_ID}" \
    --query 'Endpoints[0].EndpointArn' --output text)" || return 1
  aws dms list-tags-for-resource --resource-arn "${arn}" --region "${REGION}" \
    --query "TagList[?Key=='phase'].Value | [0]" --output text
}

# Every versionsSent attestation anywhere in the fetched state.
attestation_count() {
  jq '[.. | objects | select(has("versionsSent"))] | length' "${STATE_FILE}"
}

# The endpoint's password-token provenance entry, compact JSON ('null' when none).
password_provenance() {
  jq -c '.resources.Endpoint.referenceProvenance // {} | to_entries
    | map(select(.key | contains("SecretString:password"))) | .[0].value // null' "${STATE_FILE}"
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: the released binary (${RELEASED_CDKD_PACKAGE}@${RELEASED_CDKD_VERSION})"
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
assert_eq "premise: the released binary reads at most schema 17" "${RELEASED_SCHEMA_VERSION}" "17"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the released binary"
# ---------------------------------------------------------------------------
export CDKD_TEST_PARAM_VALUE=one CDKD_TEST_ENDPOINT_TAG=one
run_cdkd ok "released deploy" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "released deploy"
SECRET_ARN="$(state_field '.resources.Secret.physicalId')"
[ -n "${SECRET_ARN}" ] && [ "${SECRET_ARN}" != "null" ] || fail "no secret recorded"
assert_version "released deploy" "16"
assert_eq "released deploy: no attestation anywhere" "$(attestation_count)" "0"
assert_eq "released deploy: the password reference records one version, unattested" \
  "$(password_provenance | jq -r '[(.versions | length), (has("versionsSent"))] | join(",")')" "1,false"
assert_eq "released deploy: the parameter holds 'one'" "$(param_value)" "one"
VID_RELEASED="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local binary READS the released record with every reading command"
# ---------------------------------------------------------------------------
run_cdkd_json "local state show (v16)" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show (v16): the record is version 16" "$(jq -r '.state.version' "${JSON_OUT}")" "16"
run_cdkd_json "local state resources (v16)" "${LOCAL_DIST}" state resources "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state resources (v16): the logical ids" \
  "$(jq -r '[.[].logicalId] | sort | join(",")' "${JSON_OUT}")" "Endpoint,Param,Secret"
run_cdkd ok "local state list" "${LOCAL_DIST}" state list --state-bucket "${STATE_BUCKET}"
grep -qF "${STACK}" "${DEPLOY_LOG}" || fail "local state list: ${STACK} is not listed"
pass "local state list: ${STACK} is listed"
run_drift_read "local drift (v16)"
assert_eq "local reads (v16): state.json VersionId is unchanged" "$(state_version_id)" "${VID_RELEASED}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: a LOCAL write with no attestation stays version 16"
# ---------------------------------------------------------------------------
export CDKD_TEST_PARAM_VALUE=two
run_cdkd ok "local deploy (parameter only)" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
VID_NO_ATTEST="$(state_version_id)"
[ "${VID_NO_ATTEST}" != "${VID_RELEASED}" ] || fail "local deploy (parameter only): the state was not written"
pass "local deploy (parameter only): the state was written"
fetch_state "local deploy (parameter only)"
assert_version "local deploy (parameter only)" "16"
assert_eq "local deploy (parameter only): no attestation anywhere" "$(attestation_count)" "0"
assert_eq "local deploy (parameter only): the parameter holds 'two'" "$(param_value)" "two"

# ---------------------------------------------------------------------------
echo "==> Phase 4: the LOCAL write that attests the password's version persists version 18"
# ---------------------------------------------------------------------------
export CDKD_TEST_ENDPOINT_TAG=two
run_cdkd ok "local deploy (endpoint tag)" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
if grep -qF "${SKIP_LINE}" "${DEPLOY_LOG}"; then
  fail "local deploy (endpoint tag): the password was left out on an unattested record"
fi
pass "local deploy (endpoint tag): the password was sent (the released record attests nothing)"
fetch_state "local deploy (endpoint tag)"
assert_version "local deploy (endpoint tag)" "18"
assert_eq "local deploy (endpoint tag): the password reference is attested at one version" \
  "$(password_provenance | jq -r '[(.versions | length), .versionsSent] | join(",")')" "1,true"
assert_eq "local deploy (endpoint tag): the attestation is the only one" "$(attestation_count)" "1"
assert_eq "local deploy (endpoint tag): the endpoint's tag is 'two'" "$(endpoint_tag)" "two"
SECRET_RAW="$(aws secretsmanager get-secret-value --secret-id "${SECRET_ARN}" --region "${REGION}" \
  --query SecretString --output text)" || fail "could not read the secret"
# The value reaches node on stdin, never as an argument (argv is visible to `ps`).
if printf '%s' "${SECRET_RAW}" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const p=JSON.parse(s).password;process.exit(require("fs").readFileSync(process.argv[1],"utf8").includes(p)?0:1)})' "${STATE_FILE}"; then
  fail "state.json holds the secret's plaintext"
fi
SECRET_RAW=""
pass "local deploy (endpoint tag): state.json holds no plaintext"

# ---------------------------------------------------------------------------
echo "==> Phase 5: a LOCAL Tags-only deploy leaves the password out and stays 18"
# ---------------------------------------------------------------------------
export CDKD_TEST_ENDPOINT_TAG=three
run_cdkd ok "local deploy (tag again)" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
grep -qF "${SKIP_LINE}" "${DEPLOY_LOG}" \
  || fail "local deploy (tag again): the password was re-sent at its attested version"
pass "local deploy (tag again): the password was left out"
fetch_state "local deploy (tag again)"
assert_version "local deploy (tag again)" "18"
assert_eq "local deploy (tag again): the endpoint's tag is 'three'" "$(endpoint_tag)" "three"
run_drift_read "local drift (v18)"
VID_V18="$(state_version_id)"

# ---------------------------------------------------------------------------
echo "==> Phase 6: the released binary refuses the v18 record"
# ---------------------------------------------------------------------------
run_cdkd fail "released state show over v18" "${RELEASED_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_refusal "released state show over v18"
run_cdkd fail "released deploy over v18" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_refusal "released deploy over v18"
assert_eq "released refusals: state.json VersionId is unchanged" "$(state_version_id)" "${VID_V18}"

# ---------------------------------------------------------------------------
echo "==> Phase 7: cdkd destroy from the v18 record; everything is gone"
# ---------------------------------------------------------------------------
run_cdkd ok "local destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the destroy"
assert_gone "parameter ${PARAM_NAME} still exists after the destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
pass "the parameter is gone after the destroy"
assert_gone "endpoint ${ENDPOINT_ID} still exists after the destroy" \
  aws dms describe-endpoints --region "${REGION}" --filters "Name=endpoint-id,Values=${ENDPOINT_ID}"
pass "the endpoint is gone after the destroy"
# A deleted secret may still answer with DeletedDate set (scheduled): deleted.
if ! gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}"; then
  SECRET_DELETED="$(aws secretsmanager describe-secret --secret-id "${SECRET_ARN}" --region "${REGION}" \
    --query DeletedDate --output text)" || fail "describe-secret requery failed"
  [ -n "${SECRET_DELETED}" ] && [ "${SECRET_DELETED}" != "None" ] || fail "secret ${SECRET_ARN} is still active after the destroy"
fi
pass "the secret is deleted after the destroy"

trap - EXIT INT TERM
cleanup
# AFTER cleanup: its sweeps can write delete markers.
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v17-to-v18-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
EXPECTED_ASSERTIONS=42
if [ "${ASSERTIONS_RUN:-0}" -ne "${EXPECTED_ASSERTIONS}" ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly ${EXPECTED_ASSERTIONS} — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v17-to-v18-migration test passed (the released record is read by every local command, a write with no attestation stays 16, the write attesting the password's version persists 18 and the next leaves the password out, the released binary refuses the v18 record without a write, and the destroy leaves nothing); ${ASSERTIONS_RUN} assertions executed"
echo "[verify] PASS -- schema-v17-to-v18-migration"
