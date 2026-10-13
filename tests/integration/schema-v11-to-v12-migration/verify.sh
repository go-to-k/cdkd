#!/usr/bin/env bash
# verify.sh — cdkd state schema v11 -> v12 migration round-trip integ test
# (issues #4847 / #4852: per-reference provenance).
#
# A state file the last v11 binary (@go-to-k/cdkd@0.298.7) wrote holds
# `{{resolve:...}}` tokens and no provenance. The local v12 binary reads it
# with no user action, reading alone does not rewrite it, and the next
# `cdkd deploy` of the UNCHANGED stack rewrites it to `version: 12` with
# `referenceProvenance` on each record that holds a token (and
# `outputReferenceProvenance` for the output), WITHOUT sending, updating or
# replacing anything: the one-time capture adds only the field. A redeploy
# then makes no capture lookup, and the v11 binary refuses the v12 record with
# "Upgrade cdkd". Every version and value assertion reads the S3 JSON, never a
# log line; lookup counts read the SDK call log (`CDKD_SDK_CALL_LOG`).
#
# Red line (pre-fix): "migration changed a resource / field absent".
#
# PHASES
#   0  preflight, pre-run cleanup, the per-run secret.
#   1  deploy under the v11 binary, then redeploy it with `Reader` edited, so
#      the reader re-reads the then-unchanged queue and stores the token form
#      (as does the output) -> `version: 11`, tokens in every record but
#      `Plain`, and no provenance anywhere (the premise: a wrong pin would
#      test nothing).
#   2  the local v12 binary READS it (`state show`): still `version: 11`, no
#      new state.json object version.
#   3  the MIGRATION deploy under v12 (template unchanged): `version: 12`;
#      `Queue` records the region and the secret's AWSCURRENT VersionId (its
#      name holds the value); `Reader` and `PasswordHolder` record the region
#      only and never `readVersions`; `Plain` gains no field; the output
#      records its provenance; every record's physical id, properties and
#      attributes are unchanged and AWS was not written (SSM LastModifiedDate,
#      the queue URL); the deploy made GetSecretValue calls.
#   4  redeploy unchanged, twice: no state.json write, fewer GetSecretValue
#      calls than the migration deploy and EQUAL counts across the two
#      (no capture lookup left).
#   5  the v11 binary refuses the v12 record ("Upgrade cdkd").
#   6  `cdkd destroy`; everything is gone.
#   7  no object version written since the migration carries the password;
#      every version under the stack prefix is purged and asserted gone.
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

. ../s3-versions.sh

STACK="CdkdSchemaV11ToV12Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The LAST v11-writing cdkd release on npm when this fixture was written.
# Phase 1 asserts it writes `version: 11` AND no provenance, so a wrong pin
# fails loudly instead of quietly testing something else.
V11_CDKD_VERSION="0.298.7"
V11_TMPDIR=""
V11_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The schema version the LOCAL binary writes. It was 12 when this fixture was
# written; a later bump moves it, and the local-binary phases assert "the
# current version", not a literal, so this fixture keeps proving the migration
# into the current schema. Read from the BUILT binary (the
# `schema-v9-to-v10-migration` fixture's derivation, verbatim): the readable
# list's LAST entry is the version a binary writes.
LOCAL_SCHEMA_VERSION="$(cat ../../../dist/*.js 2>/dev/null | awk '
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
')"
case "${LOCAL_SCHEMA_VERSION}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the readable schema versions from the built dist/ (is it built?)" >&2
    exit 1
    ;;
esac
if [ "${LOCAL_SCHEMA_VERSION}" -lt 12 ]; then
  echo "FAIL: the local binary writes schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v12+ local binary" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate this fixture's per-run values" >&2
  exit 1
fi
RUN_ID="$(openssl rand -hex 4)"
SECRET_NAME="cdkd-integ/schema-v11-to-v12/${RUN_ID}"
PARAM_PREFIX="/cdkd-integ/schema-v11-to-v12/${RUN_ID}"
QUEUE_NAME="cdkd-v12-q-${RUN_ID}"
# Per-run and never printed: the no-plaintext scan's needle.
PASSWORD="cdkdv12pw$(openssl rand -hex 12)"
QUEUE_TOKEN="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:queue}}"
PASSWORD_TOKEN="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}"

export CDKD_V12_SECRET="${SECRET_NAME}"
export CDKD_V12_PREFIX="${PARAM_PREFIX}"
export CDKD_V12_READER_EDIT=""

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
PRE_MIGRATION_VERSIONS=""
CALLS_DIR=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV11ToV12?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct-API fallback for the per-run objects.
  for param in reader password-holder plain; do
    aws ssm delete-parameter --name "${PARAM_PREFIX}/${param}" --region "${REGION}" >/dev/null 2>&1
  done
  local url
  if url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
      --query QueueUrl --output text 2>/dev/null)" && [ -n "${url}" ] && [ "${url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  fi
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  if [ -n "${V11_TMPDIR}" ] && [ -d "${V11_TMPDIR}" ]; then
    rm -rf "${V11_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${DEPLOY_LOG:-}" "${PRE_MIGRATION_VERSIONS:-}" "${CALLS_DIR:-}"
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
PRE_MIGRATION_VERSIONS="$(mktemp)"
CALLS_DIR="$(mktemp -d)"

# --- helpers ----------------------------------------------------------------
# NOTHING BELOW PRINTS THE PASSWORD.

pass() {
  echo "    OK: $1"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
fail() {
  echo "FAIL: $1" >&2
  exit 1
}

redact_password() { # stdin -> stdout
  local line
  while IFS= read -r line || [ -n "${line}" ]; do
    printf '%s\n' "${line//${PASSWORD}/<password>}"
  done
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
    printf '%s\n' "FAIL: $1: got '$2', expected '$3'" | redact_password >&2
    exit 1
  fi
  pass "$1"
}

assert_version() { # <label> <expected>
  assert_eq "$1: state.version" "$(state_field '.version')" "$2"
}

# Run a cdkd command, its output into DEPLOY_LOG. A non-empty <calls file>
# turns the SDK call log on for that run.
run_cdkd() { # <expect: ok|fail> <label> <calls file or ''> <binary> <args...>
  local expect="$1" label="$2" calls="$3" bin="$4" rc
  shift 4
  set +e
  if [ -n "${calls}" ]; then
    CDKD_SDK_CALL_LOG="${calls}" AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  else
    AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  fi
  rc=$?
  set -e
  if [ "${expect}" = "ok" ] && [ "${rc}" -ne 0 ]; then
    redact_password <"${DEPLOY_LOG}" | tail -40 >&2
    fail "${label}: exited ${rc}"
  fi
  if [ "${expect}" = "fail" ] && [ "${rc}" -eq 0 ]; then
    redact_password <"${DEPLOY_LOG}" | tail -40 >&2
    fail "${label}: exited 0, expected a refusal"
  fi
  pass "${label}: exited ${rc} (${expect})"
}

assert_log_has() { # <label> <fixed text>
  if ! grep -qF -- "$2" "${DEPLOY_LOG}"; then
    redact_password <"${DEPLOY_LOG}" | tail -40 >&2
    fail "$1: output lacks '$2'"
  fi
  pass "$1: output names '$2'"
}

assert_log_has_no_password() { # <label>
  if grep -qF -- "${PASSWORD}" "${DEPLOY_LOG}"; then
    fail "$1: cdkd's output carries the secret's password (value withheld)"
  fi
  pass "$1: cdkd's output carries no password"
}

# A call log holds one JSON line per cdkd process; these read the counts
# summed over its lines.
call_counts() { # <calls file> -> { "<client>.<command>": n }
  [ -f "$1" ] || fail "the SDK call log $1 was not written — CDKD_SDK_CALL_LOG did not take effect"
  jq -cS -s 'map(.counts) | reduce .[] as $c ({}; reduce ($c | to_entries[]) as $e (.; .[$e.key] += $e.value))' "$1"
}

get_secret_value_calls() { # <calls file> -> the GetSecretValue count (0 when absent)
  [ -f "$1" ] || fail "the SDK call log $1 was not written — CDKD_SDK_CALL_LOG did not take effect"
  call_counts "$1" | jq -r '."SecretsManagerClient.GetSecretValueCommand" // 0'
}

state_versions() { # number of object versions of state.json — strict
  s3_count_key_versions "${STATE_BUCKET}" "${STATE_KEY}" || fail "could not count state.json versions"
}

ssm_modified() { # <name> — strict
  aws ssm get-parameter --region "${REGION}" --name "$1" \
    --query 'Parameter.LastModifiedDate' --output text
}

# The record's physical id, properties and attributes, as compact JSON:
# everything the migration must leave as it was.
record_core() { # <logical id>
  jq -cS --arg id "$1" '.resources[$id] | {physicalId, properties, attributes}' "${STATE_FILE}"
}

list_versions() { # <prefix> <query>
  local err out rc=0
  err="$(mktemp)"
  out="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
    --prefix "$1" --query "$2" --output text 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    cat "${err}" >&2
    rm -f "${err}"
    return 1
  fi
  rm -f "${err}"
  printf '%s' "${out}"
}

# Every object version under the stack prefix NOT recorded before the
# migration is read, and none may carry the password.
assert_no_password_in_versions() { # <label>
  local rows key vid modified body scanned=0 hits=""
  rows="$(list_versions "${STATE_PREFIX}" 'Versions[].[LastModified,Key,VersionId]')" \
    || fail "$1: could not list object versions under s3://${STATE_BUCKET}/${STATE_PREFIX}"
  while IFS=$'\t' read -r modified key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] && [ "${vid}" != "None" ] || continue
    if grep -qxF -- "${key}"$'\t'"${vid}" "${PRE_MIGRATION_VERSIONS}"; then
      continue
    fi
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      fail "$1: could not read s3://${STATE_BUCKET}/${key} version ${vid}"
    fi
    scanned=$((scanned + 1))
    if [[ "${body}" == *"${PASSWORD}"* ]]; then
      hits="${hits}  s3://${STATE_BUCKET}/${key} version ${vid} (LastModified ${modified})"$'\n'
    fi
  done <<< "${rows}"
  if [ -n "${hits}" ]; then
    printf '%s' "${hits}" >&2
    fail "$1: object version(s) written since the migration carry the password (value withheld)"
  fi
  [ "${scanned}" -gt 0 ] || fail "$1: no object version written since the migration was found — the scan looked at nothing"
  pass "$1: ${scanned} object version(s) written since the migration scanned, none carries the password"
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: the per-run secret"
# ---------------------------------------------------------------------------
aws secretsmanager create-secret --region "${REGION}" --name "${SECRET_NAME}" \
  --secret-string "$(jq -cn --arg q "${QUEUE_NAME}" --arg p "${PASSWORD}" '{queue: $q, password: $p}')" \
  >/dev/null
SECRET_VERSION="$(aws secretsmanager describe-secret --region "${REGION}" --secret-id "${SECRET_NAME}" \
  --query 'VersionIdsToStages' --output json | jq -r 'to_entries[] | select(.value | index("AWSCURRENT")) | .key')"
[ -n "${SECRET_VERSION}" ] || fail "could not read the secret's AWSCURRENT version id"
pass "the per-run secret exists at version ${SECRET_VERSION}"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the v11 binary (@go-to-k/cdkd@${V11_CDKD_VERSION})"
# ---------------------------------------------------------------------------
V11_TMPDIR="$(mktemp -d)"
(cd "${V11_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${V11_CDKD_VERSION}" >/dev/null)
V11_BIN="${V11_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${V11_BIN}" ] || fail "the v11 binary was not installed at ${V11_BIN}"

run_cdkd ok "v11 deploy" "" "${V11_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# The edit stays set from here on: every later deploy synthesizes this template.
export CDKD_V12_READER_EDIT=1
run_cdkd ok "v11 redeploy (Reader edited)" "" "${V11_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "v11 deploy"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
RECORDED_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${QUEUE_TOKEN}"
assert_eq "v11 deploy: Reader.properties.Value holds the token form (re-read from the unchanged queue)" \
  "$(state_field '.resources.Reader.properties.Value')" "${RECORDED_ARN}"
assert_eq "v11 deploy: the output holds the token form" \
  "$(state_field '.outputs.QueueArn')" "${RECORDED_ARN}"
assert_version "v11 deploy" 11
assert_eq "v11 deploy: Queue.properties.QueueName holds the token (the migration's input)" \
  "$(state_field '.resources.Queue.properties.QueueName')" "${QUEUE_TOKEN}"
assert_eq "v11 deploy: PasswordHolder.properties.Value holds the token" \
  "$(state_field '.resources.PasswordHolder.properties.Value')" "${PASSWORD_TOKEN}"
assert_eq "v11 deploy: no provenance anywhere (a v11 record)" \
  "$(jq '[.. | objects | select(has("referenceProvenance") or has("outputReferenceProvenance"))] | length' "${STATE_FILE}")" "0"
QUEUE_CORE_1="$(record_core Queue)"
READER_CORE_1="$(record_core Reader)"
HOLDER_CORE_1="$(record_core PasswordHolder)"
PLAIN_CORE_1="$(record_core Plain)"
OUTPUTS_1="$(jq -cS '.outputs' "${STATE_FILE}")"
QUEUE_URL_1="$(state_field '.resources.Queue.physicalId')"
case "${QUEUE_URL_1}" in
  https://sqs.*"/${QUEUE_NAME}") pass "v11 deploy: the queue is named from the secret" ;;
  *) fail "v11 deploy: the queue's physical id does not end in the secret's queue name" ;;
esac
READER_MODIFIED_1="$(ssm_modified "${PARAM_PREFIX}/reader")"
HOLDER_MODIFIED_1="$(ssm_modified "${PARAM_PREFIX}/password-holder")"
PLAIN_MODIFIED_1="$(ssm_modified "${PARAM_PREFIX}/plain")"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local v12 binary READS the v11 record (no rewrite)"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE_READ="$(state_versions)"
run_cdkd ok "v12 state show" "" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
fetch_state "v12 read-only state show"
assert_version "v12 read-only state show" 11
assert_eq "v12 state show wrote no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE_READ}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: the MIGRATION deploy under the local v12 binary (template unchanged)"
# ---------------------------------------------------------------------------
list_versions "${STATE_PREFIX}" 'Versions[].[Key,VersionId]' >"${PRE_MIGRATION_VERSIONS}" \
  || fail "could not record the pre-migration object versions"
pass "the pre-migration object versions are recorded ($(grep -c . "${PRE_MIGRATION_VERSIONS}" || true) row(s))"
VERSIONS_BEFORE_MIGRATION="$(state_versions)"
run_cdkd ok "v12 migration deploy" "${CALLS_DIR}/migration.json" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_password "v12 migration deploy"
fetch_state "v12 migration deploy"
assert_version "v12 migration deploy" "${LOCAL_SCHEMA_VERSION}"
if [ "$(state_versions)" -le "${VERSIONS_BEFORE_MIGRATION}" ]; then
  fail "v12 migration deploy: no new state.json version was written — field absent"
fi
pass "v12 migration deploy: a new state.json version was written"
# The capture's answers, per record.
assert_eq "v12 migration deploy: Queue records its region and the AWSCURRENT version (field absent = pre-fix)" \
  "$(jq -cS --arg t "${QUEUE_TOKEN}" '.resources.Queue.referenceProvenance[$t] // "absent"' "${STATE_FILE}")" \
  "$(jq -cnS --arg r "${REGION}" --arg v "${SECRET_VERSION}" '{region: $r, versions: [$v]}')"
assert_eq "v12 migration deploy: Reader records its region only (never readVersions)" \
  "$(jq -cS --arg t "${QUEUE_TOKEN}" '.resources.Reader.referenceProvenance[$t] // "absent"' "${STATE_FILE}")" \
  "$(jq -cnS --arg r "${REGION}" '{region: $r}')"
assert_eq "v12 migration deploy: PasswordHolder records its region only (no name holds the value)" \
  "$(jq -cS --arg t "${PASSWORD_TOKEN}" '.resources.PasswordHolder.referenceProvenance[$t] // "absent"' "${STATE_FILE}")" \
  "$(jq -cnS --arg r "${REGION}" '{region: $r}')"
assert_eq "v12 migration deploy: the token-free Plain gains no field" \
  "$(state_field '.resources.Plain | has("referenceProvenance")')" "false"
assert_eq "v12 migration deploy: the output's provenance is recorded, read route" \
  "$(jq -cS --arg t "${QUEUE_TOKEN}" '.outputReferenceProvenance.QueueArn[$t] // "absent"' "${STATE_FILE}")" \
  "$(jq -cnS --arg r "${REGION}" --arg v "${SECRET_VERSION}" '{region: $r, versions: [$v], readVersions: [$v]}')"
assert_eq "v12 migration deploy: every key of every field is a token the record holds" \
  "$(jq '[.resources[] | select(has("referenceProvenance")) | . as $r | ($r.referenceProvenance | keys[]) as $k | select(([$r.properties, $r.attributes, $r.observedProperties] | tostring | contains($k)) | not)] | length' "${STATE_FILE}")" "0"
# Nothing else changed: no leaf, no resource, nothing sent.
assert_eq "v12 migration deploy: Queue unchanged (migration changed a resource = pre-fix)" "$(record_core Queue)" "${QUEUE_CORE_1}"
assert_eq "v12 migration deploy: Reader unchanged" "$(record_core Reader)" "${READER_CORE_1}"
assert_eq "v12 migration deploy: PasswordHolder unchanged" "$(record_core PasswordHolder)" "${HOLDER_CORE_1}"
assert_eq "v12 migration deploy: Plain unchanged" "$(record_core Plain)" "${PLAIN_CORE_1}"
assert_eq "v12 migration deploy: outputs unchanged" "$(jq -cS '.outputs' "${STATE_FILE}")" "${OUTPUTS_1}"
assert_eq "v12 migration deploy: the queue was not replaced" "$(state_field '.resources.Queue.physicalId')" "${QUEUE_URL_1}"
assert_eq "v12 migration deploy: Reader not written in AWS" "$(ssm_modified "${PARAM_PREFIX}/reader")" "${READER_MODIFIED_1}"
assert_eq "v12 migration deploy: PasswordHolder not written in AWS" \
  "$(ssm_modified "${PARAM_PREFIX}/password-holder")" "${HOLDER_MODIFIED_1}"
assert_eq "v12 migration deploy: Plain not written in AWS" "$(ssm_modified "${PARAM_PREFIX}/plain")" "${PLAIN_MODIFIED_1}"
MIGRATION_LOOKUPS="$(get_secret_value_calls "${CALLS_DIR}/migration.json")"
if [ "${MIGRATION_LOOKUPS}" -lt 1 ]; then
  fail "v12 migration deploy: the call log shows no GetSecretValue — the capture did not run"
fi
pass "v12 migration deploy: ${MIGRATION_LOOKUPS} GetSecretValue call(s), the capture's included"
# Nothing was SENT to a resource: the call log holds no SQS / SSM write.
WRITES="$(jq -r 'keys[] | select(test("^(SQSClient|SSMClient)\\.") and (test("\\.(Get|List|Describe)") | not))' <<<"$(call_counts "${CALLS_DIR}/migration.json")" | tr '\n' ' ')"
assert_eq "v12 migration deploy: no SQS / SSM write command was sent (migration changed a resource = pre-fix)" "${WRITES}" ""
if grep -qF -- "state schema v12 migration" "${DEPLOY_LOG}"; then
  redact_password <"${DEPLOY_LOG}" | tail -40 >&2
  fail "v12 migration deploy: the capture warned that a record could not be attributed"
fi
pass "v12 migration deploy: no capture warning"

# ---------------------------------------------------------------------------
echo "==> Phase 4: redeploy unchanged, twice: no write, no capture lookup left"
# ---------------------------------------------------------------------------
VERSIONS_AFTER_MIGRATION="$(state_versions)"
run_cdkd ok "v12 redeploy 1" "${CALLS_DIR}/redeploy-1.json" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
run_cdkd ok "v12 redeploy 2" "${CALLS_DIR}/redeploy-2.json" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_eq "v12 redeploys wrote no new state.json version" "$(state_versions)" "${VERSIONS_AFTER_MIGRATION}"
REDEPLOY_LOOKUPS_1="$(get_secret_value_calls "${CALLS_DIR}/redeploy-1.json")"
REDEPLOY_LOOKUPS_2="$(get_secret_value_calls "${CALLS_DIR}/redeploy-2.json")"
if [ "${REDEPLOY_LOOKUPS_1}" -ge "${MIGRATION_LOOKUPS}" ]; then
  fail "v12 redeploy 1: ${REDEPLOY_LOOKUPS_1} GetSecretValue call(s), not fewer than the migration's ${MIGRATION_LOOKUPS} — the capture ran again"
fi
pass "v12 redeploy 1: ${REDEPLOY_LOOKUPS_1} GetSecretValue call(s), fewer than the migration's ${MIGRATION_LOOKUPS}"
assert_eq "v12 redeploys: the steady state's call logs are identical" \
  "$(call_counts "${CALLS_DIR}/redeploy-1.json")" "$(call_counts "${CALLS_DIR}/redeploy-2.json")"
fetch_state "v12 redeploy"
assert_eq "v12 redeploy: Queue's provenance is unchanged" \
  "$(jq -cS --arg t "${QUEUE_TOKEN}" '.resources.Queue.referenceProvenance[$t] // "absent"' "${STATE_FILE}")" \
  "$(jq -cnS --arg r "${REGION}" --arg v "${SECRET_VERSION}" '{region: $r, versions: [$v]}')"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the v11 binary refuses the v12 record"
# ---------------------------------------------------------------------------
run_cdkd fail "v11 state show over v12" "" "${V11_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_log_has "v11 state show over v12" "Upgrade cdkd"

# ---------------------------------------------------------------------------
echo "==> Phase 6: cdkd destroy"
# ---------------------------------------------------------------------------
run_cdkd ok "v12 destroy" "" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_log_has_no_password "v12 destroy"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the destroy"
for param in reader password-holder plain; do
  assert_gone "SSM parameter ${PARAM_PREFIX}/${param} still exists after the destroy" \
    aws ssm get-parameter --region "${REGION}" --name "${PARAM_PREFIX}/${param}"
  pass "SSM parameter ${param} is gone"
done
assert_gone "queue ${QUEUE_NAME} still exists after the destroy" \
  aws sqs get-queue-url --region "${REGION}" --queue-name "${QUEUE_NAME}"
pass "the queue is gone"

# ---------------------------------------------------------------------------
echo "==> Phase 7: no object version written since the migration carries the password; sweep"
# ---------------------------------------------------------------------------
assert_no_password_in_versions "stack prefix"

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v11-to-v12-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
if [ "${ASSERTIONS_RUN:-0}" -ne 53 ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly 53 — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v11-to-v12-migration test passed (v11 -> v12 transparent auto-migration: the one-time capture adds per-reference provenance to unchanged records and the output with no send, update or replacement, makes no lookup on a redeploy, and a v11 binary refuses the v12 record); ${ASSERTIONS_RUN} assertions executed"
