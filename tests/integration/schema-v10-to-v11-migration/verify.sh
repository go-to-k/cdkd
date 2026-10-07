#!/usr/bin/env bash
# verify.sh — cdkd state schema v10 -> v11 migration round-trip integ test
# (issues #4043 / #2449: NoEcho values redacted in persisted state).
#
# MIGRATION HALF: a state file the last v10 binary (@go-to-k/cdkd@0.296.6)
# wrote — holding every NoEcho parameter value IN THE CLEAR — is read by the
# local v11 binary with no user action, reading alone does not rewrite it,
# and the next `cdkd deploy` rewrites it to `version: 11` with `***` at every
# NoEcho position, WITHOUT updating or replacing anything (the stored plaintext
# is the migration witness). The v10 binary then refuses the v11 record with
# "Upgrade cdkd". Every version and value assertion reads the S3 JSON, never a
# log line.
#
# FEATURE HALF:
#   - `noEchoLeaves` names each positioned leaf, including a 3-character value
#     no needle can key (asserted by COORDINATE: a 3-character blob-grep is
#     meaningless);
#   - a custom resource answering `NoEcho: true` records
#     `noEchoAttributeNames` (#2449), and a dependent added in a LATER deploy is
#     refused with the exact declared-attribute remedy (fail closed: cdkd never
#     re-runs the producer);
#   - an unchanged value is read back and NOT re-sent (SSM `LastModifiedDate`
#     unchanged), a rotated one reaches AWS while state keeps `***`;
#   - a create-only property a NoEcho parameter feeds is replaced on a
#     rotation ONLY where a readback proved the provider reports it exactly
#     (#4656): the migration records that for the topic's name (the SNS
#     readback reports it exactly) and not for the DB parameter group's (RDS
#     stores it lowercased), without replacing either; the rotation REPLACES
#     the topic (its out-of-band marker is lost) and only WARNS for the group,
#     naming --recreate-via-* (maintainer decision 1 on #4043);
#   - no object version written from the migration on — state.json,
#     rollback-journal.json, deployments/*.jsonl, the shared exports index, the
#     custom-resource response objects — carries a NoEcho value.
#
# PHASES
#   0  preflight + pre-run cleanup.
#   1  deploy under the v10 binary -> `version: 10` and the token IN state
#      (the premise: a wrong pin would test nothing).
#   2  the local v11 binary READS it (`state show`): still `version: 10`, no
#      new state.json object version.
#   3  the MIGRATION deploy under v11 (the custom resource's seed rotates, so
#      its handler re-runs and declares its attributes): `version: 11`, no
#      token anywhere, `***` + `noEchoLeaves` at every position, observed
#      baseline masked, `noEchoAttributeNames` on the custom resource, the
#      SSM parameters NOT updated, the topic NOT replaced, and
#      `noEchoExactEchoLeaves` on the topic but not on the group.
#   4  redeploy unchanged: nothing re-sent, the group's lowercased readback
#      warns and replaces nothing; `cdkd diff --fail` exits 0.
#   5  the v10 binary refuses the v11 record ("Upgrade cdkd").
#   6  a dependent of the declared attribute is refused with the exact remedy,
#      created nothing; the stack redeploys clean without it.
#   7  rotate the token, the topic name and the group name: SSM holds the
#      new token, state `***`, the topic is REPLACED (new ARN, old one gone,
#      marker lost) and the group is NOT (the deploy warns naming
#      --recreate-via-cc-api).
#   7b add ParamCr, a custom resource reading the NoEcho parameter: its record
#      holds `***` at `Token`, named in `noEchoLeaves`.
#   7c remove it: the delete is SKIPPED (exit 2), the record is kept with
#      `***`, and the handler's delete marker is never written.
#   7d the same deploy with --allow-unaddressed exits 0; still skipped.
#   7e `cdkd state orphan --resource ParamCr` drops the record (it manages
#      nothing beyond the marker it never wrote).
#   7f re-add ParamCr (CDKD_V11_PARAM_CR stays 1 from here on, through the
#      destroy), so phase 8 exercises the `cdkd destroy` arm of the skip.
#   8  destroy: the first one exits 2 with ParamCr's delete skipped, its
#      record kept with `***` and the marker never written; `state orphan
#      --resource ParamCr`; the second destroy exits 0, and every resource and
#      the state file are gone.
#   9  every object version written since phase 3 is scanned for the values,
#      then every version under the stack prefix is purged and asserted gone.
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
. ../cr-log-groups.sh

STACK="CdkdSchemaV10ToV11Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
INDEX_KEY="cdkd/_index/${REGION}/exports.json"
CR_RESPONSE_PREFIX="custom-resource-responses/"
SECRET_MASK='***'

# Must match lib/schema-migration-stack.ts.
TOKEN_PARAM_NAME="/cdkd-integ/schema-v10-to-v11/token"
SHORT_PARAM_NAME="/cdkd-integ/schema-v10-to-v11/short"
PLAIN_PARAM_NAME="/cdkd-integ/schema-v10-to-v11/plain"
DEPENDENT_PARAM_NAME="/cdkd-integ/schema-v10-to-v11/cr-dependent"
MARKER_PARAM_NAME="/cdkd-integ/schema-v10-to-v11/param-cr-delete-marker"
PARAM_CR_ID="ParamCr"
PLAIN_VALUE="schema-v11-plain-control"
TOKEN_ID="TokenProbe"
SHORT_ID="ShortProbe"
PLAIN_ID="PlainProbe"
TOPIC_ID="NamedTopic"
GROUP_ID="NormalizedGroup"
CR_ID="NoEchoCr"

# The LAST v10-writing cdkd release on npm when this fixture was written.
# Phase 1 asserts it writes `version: 10` AND leaves the token in state, so a
# wrong pin fails loudly instead of quietly testing something else.
V10_CDKD_VERSION="0.296.6"
V10_TMPDIR=""
V10_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate this fixture's per-run values" >&2
  exit 1
fi
# Per-run, distinctive, never printed. Inert literals (nothing real), but the
# assertions treat them as secrets: a leak check that prints its needle would
# defeat itself.
TOKEN="cdkdv11tok$(openssl rand -hex 12)"
TOKEN_ROTATED="cdkdv11tok$(openssl rand -hex 12)"
SHORT_VALUE="q$(openssl rand -hex 1)"
TOPIC_NAME="cdkd-v11-topic-$(openssl rand -hex 6)"
TOPIC_NAME_ROTATED="cdkd-v11-topic-$(openssl rand -hex 6)"
# Mixed case on purpose: RDS stores a DB parameter group's name lowercased.
GROUP_NAME="CdkdV11Group$(openssl rand -hex 6)"
GROUP_NAME_ROTATED="CdkdV11GroupR$(openssl rand -hex 6)"
GROUP_NAME_LOWER="$(printf '%s' "${GROUP_NAME}" | tr '[:upper:]' '[:lower:]')"
GROUP_NAME_ROTATED_LOWER="$(printf '%s' "${GROUP_NAME_ROTATED}" | tr '[:upper:]' '[:lower:]')"
CR_SEED_A="$(openssl rand -hex 8)"
CR_SEED_B="$(openssl rand -hex 8)"
CR_SECRET_A="cdkdv11crsecret${CR_SEED_A}"
CR_SECRET_B="cdkdv11crsecret${CR_SEED_B}"
# The values no object version written from Phase 3 on may carry. The topic
# name is NOT here: it names the resource, so it is in the physical id, which
# stays in the clear by design (AWS publishes it); it is asserted by coordinate.
TOKENS="${TOKEN} ${TOKEN_ROTATED} ${CR_SECRET_A} ${CR_SECRET_B}"
# The same needles BY NAME, so a failure says which one leaked without printing
# it (`${!name}` is bash 3.2 indirect expansion). The exact-scalar needles are
# the values too short, or too public, for a blob scan.
BLOB_NEEDLE_NAMES="TOKEN TOKEN_ROTATED CR_SECRET_A CR_SECRET_B"
SCALAR_NEEDLE_NAMES="SHORT_VALUE TOPIC_NAME TOPIC_NAME_ROTATED GROUP_NAME GROUP_NAME_ROTATED"

export CDKD_V11_TOKEN="${TOKEN}"
export CDKD_V11_SHORT="${SHORT_VALUE}"
export CDKD_V11_TOPIC_NAME="${TOPIC_NAME}"
export CDKD_V11_GROUP_NAME="${GROUP_NAME}"
export CDKD_V11_CR_SEED="${CR_SEED_A}"
export CDKD_V11_ADD_DEPENDENT=""
export CDKD_V11_PARAM_CR=""

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
PRE_MIGRATION_VERSIONS=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV10ToV11?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac

  if [ -f "${LOCAL_DIST}" ]; then
    # ParamCr's delete is skipped by design (its record holds `***`), so a
    # failed run drops its record first; it manages nothing but the marker.
    node "${LOCAL_DIST}" state orphan "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --stack-region "${REGION}" --resource "${PARAM_CR_ID}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct-API fallback for the fixed-name objects.
  for param in "${TOKEN_PARAM_NAME}" "${SHORT_PARAM_NAME}" "${PLAIN_PARAM_NAME}" "${DEPENDENT_PARAM_NAME}" "${MARKER_PARAM_NAME}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1
  done
  for name in "${TOPIC_NAME}" "${TOPIC_NAME_ROTATED}"; do
    aws sns delete-topic --region "${REGION}" \
      --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID:-000000000000}:${name}" >/dev/null 2>&1
  done
  for name in "${GROUP_NAME_LOWER}" "${GROUP_NAME_ROTATED_LOWER}"; do
    aws rds delete-db-parameter-group --region "${REGION}" \
      --db-parameter-group-name "${name}" >/dev/null 2>&1
  done
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"

  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true

  if [ -n "${V10_TMPDIR}" ] && [ -d "${V10_TMPDIR}" ]; then
    rm -rf "${V10_TMPDIR}"
  fi
  rm -f "${STATE_FILE:-}" "${DEPLOY_LOG:-}" "${PRE_MIGRATION_VERSIONS:-}"
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
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup || true

STATE_FILE="$(mktemp)"
DEPLOY_LOG="$(mktemp)"
PRE_MIGRATION_VERSIONS="$(mktemp)"

# --- helpers ----------------------------------------------------------------
# NOTHING BELOW PRINTS A TOKEN. Failure paths print key-only summaries or
# token-rewritten lines.

pass() {
  echo "    OK: $1"
  ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
}
fail() {
  echo "FAIL: $1" >&2
  exit 1
}

redact_tokens() { # stdin -> stdout, every token rewritten
  local line t
  while IFS= read -r line || [ -n "${line}" ]; do
    for t in ${TOKENS} ${TOPIC_NAME} ${TOPIC_NAME_ROTATED} ${GROUP_NAME} ${GROUP_NAME_ROTATED}; do
      line="${line//${t}/<noecho>}"
    done
    printf '%s\n' "${line}"
  done
}

fetch_state() { # usage: fetch_state <label> — strict
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${STATE_FILE}" >/dev/null
  [ -s "${STATE_FILE}" ] || fail "$1: s3://${STATE_BUCKET}/${STATE_KEY} is empty"
}

state_summary() {
  jq '{version, resources: (.resources | keys)}' "${STATE_FILE}"
}

assert_version() { # <label> <expected>
  local v
  v="$(jq -r '.version' "${STATE_FILE}")"
  if [ "${v}" != "$2" ]; then
    state_summary >&2
    fail "$1: state.version is ${v}, expected $2"
  fi
  pass "$1: state.version == $2"
}

state_field() { # <jq path expression>
  jq -r "$1" "${STATE_FILE}"
}

assert_eq() { # <label> <actual> <expected>
  if [ "$2" != "$3" ]; then
    printf '%s\n' "FAIL: $1: got '$2', expected '$3'" | redact_tokens >&2
    exit 1
  fi
  pass "$1"
}

assert_state_has_token() { # <label> — the PREMISE half
  local body
  body="$(cat "${STATE_FILE}")"
  if [[ "${body}" != *"${TOKEN}"* ]]; then
    fail "$1: the v10 record does not hold the NoEcho token in the clear — the pin is not a v10 binary that predates the redaction, so this run would test nothing"
  fi
  pass "$1: the v10 record holds the NoEcho token in the clear (the migration's input)"
}

assert_no_tokens_in_state() { # <label>
  local body name v hits=""
  body="$(cat "${STATE_FILE}")"
  for name in ${BLOB_NEEDLE_NAMES}; do
    v="${!name}"
    if [[ "${body}" == *"${v}"* ]]; then
      # WHERE it leaked and WHICH needle, never the value.
      hits="${hits}${name} (contained) at: $(paths_containing "${v}" <"${STATE_FILE}" | tr '\n' ' ')"$'\n'
    fi
  done
  for name in ${SCALAR_NEEDLE_NAMES}; do
    v="${!name}"
    if [ "$(exact_scalar_count "${v}" <"${STATE_FILE}")" != "0" ]; then
      hits="${hits}${name} (whole scalar) at: $(paths_equal "${v}" <"${STATE_FILE}" | tr '\n' ' ')"$'\n'
    fi
  done
  if [ -n "${hits}" ]; then
    # A jq PATH can spell a value too (an alias key holding it): redacted.
    printf '%s' "${hits}" | redact_tokens >&2
    fail "$1: state.json carries a NoEcho value or a NoEcho-served name (needles and paths above, values withheld)"
  fi
  pass "$1: no NoEcho value anywhere in state.json (blob), and no short value / topic name as a whole scalar"
}

ssm_value() { # <name> — strict
  aws ssm get-parameter --region "${REGION}" --name "$1" --query 'Parameter.Value' --output text
}
ssm_modified() { # <name> — strict
  aws ssm get-parameter --region "${REGION}" --name "$1" \
    --query 'Parameter.LastModifiedDate' --output text
}
topic_arn() { # the physical id the record names
  state_field ".resources[\"${TOPIC_ID}\"].physicalId // \"<absent>\""
}
# The ARN is a function of the topic's NAME, so a replacement under the same
# name keeps it: an out-of-band DisplayName (the template sets none) is what a
# replacement loses.
TOPIC_MARKER="cdkd-v11-marker-$(openssl rand -hex 6)"
topic_display() { # <arn> — strict
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "$1" \
    --query 'Attributes.DisplayName' --output text
}
group_name_in_aws() { # <lowercase name> -- the name AWS holds, or <absent>
  if gone_probe aws rds describe-db-parameter-groups --region "${REGION}" \
      --db-parameter-group-name "$1"; then
    printf '<absent>'
    return
  fi
  aws rds describe-db-parameter-groups --region "${REGION}" --db-parameter-group-name "$1" \
    --query 'DBParameterGroups[0].DBParameterGroupName' --output text
}
# Exact-scalar occurrences of <value> in a JSON (or JSON-lines) body on stdin:
# a short value (3 characters) or a name cannot be blob-grepped meaningfully,
# but no scalar of the record may EQUAL it.
exact_scalar_count() { # <value> < body
  jq -s --arg v "$1" '[.. | scalars | select(. == $v)] | length'
}
# The jq paths (dotted) of every scalar that CONTAINS / EQUALS <value>, one per
# line, over a JSON (or JSON-lines) body on stdin; the value is never printed.
paths_containing() { # <value> < body
  jq -r --arg v "$1" \
    '[paths(scalars) as $p | select(getpath($p) | tostring | contains($v)) | ($p | map(tostring) | join("."))] | .[]'
}
paths_equal() { # <value> < body
  jq -r --arg v "$1" \
    '[paths(scalars) as $p | select(getpath($p) == $v) | ($p | map(tostring) | join("."))] | .[]'
}

# Run a cdkd command, its output into DEPLOY_LOG; echo the rc. The log is
# printed token-rewritten on failure.
run_cdkd() { # <expect: ok|fail> <label> <binary> <args...>
  local expect="$1" label="$2" bin="$3" rc
  shift 3
  set +e
  AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${expect}" = "ok" ] && [ "${rc}" -ne 0 ]; then
    redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
    fail "${label}: exited ${rc}"
  fi
  if [ "${expect}" = "fail" ] && [ "${rc}" -eq 0 ]; then
    redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
    fail "${label}: exited 0, expected a refusal"
  fi
  pass "${label}: exited ${rc} (${expect})"
}

# Run a cdkd command expecting EXACTLY <rc>; the log is printed token-rewritten
# on a mismatch.
run_cdkd_rc() { # <rc> <label> <binary> <args...>
  local want="$1" label="$2" bin="$3" rc
  shift 3
  set +e
  AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${rc}" -ne "${want}" ]; then
    redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
    fail "${label}: exited ${rc}, expected ${want}"
  fi
  pass "${label}: exited ${rc}"
}

assert_log_has() { # <label> <fixed text>
  if ! grep -qF -- "$2" "${DEPLOY_LOG}"; then
    redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
    fail "$1: output lacks '$2' — the behavior did not occur, or its wording drifted"
  fi
  pass "$1: output names '$2'"
}

assert_log_has_no_tokens() { # <label>
  local t n=0 body
  body="$(cat "${DEPLOY_LOG}")"
  for t in ${TOKENS}; do
    n=$((n + 1))
    if [[ "${body}" == *"${t}"* ]]; then
      fail "$1: cdkd's output carries NoEcho value #${n} of TOKENS (value withheld)"
    fi
  done
  pass "$1: cdkd's output carries no NoEcho value"
}

state_versions() { # number of object versions of state.json — strict
  s3_count_key_versions "${STATE_BUCKET}" "${STATE_KEY}" || fail "could not count state.json versions"
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

# Record every object version that exists under <scope> BEFORE the migration
# deploy, as `<key>\t<versionId>` lines. A version id, not a clock: the v10
# deploy's own writes land seconds before Phase 3, inside any time window.
snapshot_versions() { # <scope> <label>
  local rows
  rows="$(list_versions "$1" 'Versions[].[Key,VersionId]')" \
    || fail "$2: could not list object versions under s3://${STATE_BUCKET}/$1"
  printf '%s\n' "${rows}" >>"${PRE_MIGRATION_VERSIONS}"
}

# Read every object version under <scope> that was NOT in the pre-migration
# snapshot and fail if any carries a value. `shared` scopes (the exports
# index, the custom-resource responses) tolerate a version another run removed
# between the listing and the read; this fixture's own prefix does not.
# DIAGNOSABLE without printing a value: the new versions are walked oldest
# first, each named by its ordinal after the Phase 3 boundary (overall and per
# key) and its LastModified; a hit names the NEEDLE by its variable name and
# the jq path(s) of every matching scalar, then all hits of the scope fail.
assert_no_tokens_in_versions() { # <scope> <label> <own|shared>
  local scope="$1" label="$2" ownership="$3" rows key vid modified body scanned=0
  local name v ordinal_key prev_key="" key_ordinal=0 hits="" where
  rows="$(list_versions "${scope}" 'Versions[].[LastModified,Key,VersionId]')" \
    || fail "${label}: could not list object versions under s3://${STATE_BUCKET}/${scope}"
  # Oldest first (ISO-8601 sorts lexically), so an ordinal reads as "the Nth
  # write after the migration started".
  rows="$(printf '%s\n' "${rows}" | sort)"
  while IFS=$'\t' read -r modified key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    if grep -qxF -- "${key}"$'\t'"${vid}" "${PRE_MIGRATION_VERSIONS}"; then
      continue
    fi
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      if [ "${ownership}" = "shared" ] \
          && [[ "${body}" == *NoSuchVersion* || "${body}" == *NoSuchKey* ]]; then
        continue
      fi
      fail "${label}: could not read s3://${STATE_BUCKET}/${key} version ${vid}"
    fi
    scanned=$((scanned + 1))
    if [ "${key}" = "${prev_key}" ]; then
      key_ordinal=$((key_ordinal + 1))
    else
      # Versions of one key are contiguous only per timestamp; count per key.
      key_ordinal="$(printf '%s\n' "${rows}" | awk -F '\t' -v k="${key}" -v m="${modified}" \
        '$2 == k && $1 <= m { n++ } END { print n + 0 }')"
    fi
    prev_key="${key}"
    ordinal_key="post-Phase-3 write #${scanned} (#${key_ordinal} version of ${key} in the listing), LastModified ${modified}"
    if ! printf '%s' "${body}" | jq -e . >/dev/null 2>&1 && ! printf '%s' "${body}" | jq -s . >/dev/null 2>&1; then
      fail "${label}: s3://${STATE_BUCKET}/${key} version ${vid} is not JSON / JSON lines — the scan cannot read it"
    fi
    for name in ${BLOB_NEEDLE_NAMES}; do
      v="${!name}"
      if [[ "${body}" == *"${v}"* ]]; then
        where="$(printf '%s' "${body}" | paths_containing "${v}" | tr '\n' ' ')"
        hits="${hits}  ${ordinal_key}: s3://${STATE_BUCKET}/${key} version ${vid} carries ${name} at: ${where:-<not in a JSON scalar>}"$'\n'
      fi
    done
    # The short value and the topic names cannot be blob-grepped (a short
    # needle, and a name AWS publishes inside the physical id), but no SCALAR
    # of a cdkd document may EQUAL one of them.
    for name in ${SCALAR_NEEDLE_NAMES}; do
      v="${!name}"
      if [ "$(printf '%s' "${body}" | exact_scalar_count "${v}")" != "0" ]; then
        where="$(printf '%s' "${body}" | paths_equal "${v}" | tr '\n' ' ')"
        hits="${hits}  ${ordinal_key}: s3://${STATE_BUCKET}/${key} version ${vid} holds ${name} as a whole scalar at: ${where}"$'\n'
      fi
    done
  done <<< "${rows}"
  if [ -n "${hits}" ]; then
    # A jq PATH can spell a value too (an alias key holding it): redacted.
    printf '%s' "${hits}" | redact_tokens >&2
    fail "${label}: object version(s) written since the migration carry a NoEcho value (needles, versions and paths above, values withheld)"
  fi
  if [ "${ownership}" = "own" ] && [ "${scanned}" -eq 0 ]; then
    fail "${label}: no object version written since the migration was found under ${scope} — the scan looked at nothing"
  fi
  pass "${label}: ${scanned} object version(s) written since the migration scanned, none carries a NoEcho value (blob) or a short value / topic name (exact scalar)"
}

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the v10 binary (@go-to-k/cdkd@${V10_CDKD_VERSION})"
# ---------------------------------------------------------------------------
V10_TMPDIR="$(mktemp -d)"
(cd "${V10_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${V10_CDKD_VERSION}" >/dev/null)
V10_BIN="${V10_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${V10_BIN}" ] || fail "the v10 binary was not installed at ${V10_BIN}"

run_cdkd ok "v10 deploy" "${V10_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "v10 deploy"
assert_version "v10 deploy" 10
assert_state_has_token "v10 deploy"
assert_eq "v10 deploy: ${TOKEN_ID} has no noEchoLeaves" \
  "$(state_field ".resources[\"${TOKEN_ID}\"].noEchoLeaves // \"absent\"")" "absent"
assert_eq "v10 deploy: AWS holds the token" "$(ssm_value "${TOKEN_PARAM_NAME}")" "${TOKEN}"
TOKEN_MODIFIED_1="$(ssm_modified "${TOKEN_PARAM_NAME}")"
SHORT_MODIFIED_1="$(ssm_modified "${SHORT_PARAM_NAME}")"
TOPIC_ARN_1="$(topic_arn)"
case "${TOPIC_ARN_1}" in
  arn:aws*:sns:*) pass "v10 deploy: the topic's physical id is an SNS ARN" ;;
  *) fail "v10 deploy: the topic's physical id is not an SNS ARN" ;;
esac
# The migration's other inputs, by coordinate: the 3-character value in the
# clear, and the custom resource's value ALREADY masked by v10 (#2274) but
# with no declaration (#2449's premise: the v10 record names nothing).
assert_eq "v10 deploy: ${SHORT_ID}.properties.Value holds the short value in the clear" \
  "$(state_field ".resources[\"${SHORT_ID}\"].properties.Value")" "${SHORT_VALUE}"
assert_eq "v10 deploy: ${CR_ID}.attributes.Secret is masked by v10 already" \
  "$(state_field ".resources[\"${CR_ID}\"].attributes.Secret // \"<absent>\"")" "${SECRET_MASK}"
assert_eq "v10 deploy: ${CR_ID} declares no noEchoAttributeNames" \
  "$(state_field ".resources[\"${CR_ID}\"].noEchoAttributeNames // \"absent\"")" "absent"
# The v10 binary captured an observed baseline in the clear too: the input the
# migration's observed masking (P3) acts on.
assert_eq "v10 deploy: ${TOKEN_ID}.observedProperties.Value holds the token in the clear" \
  "$(state_field ".resources[\"${TOKEN_ID}\"].observedProperties.Value // \"<absent>\"")" "${TOKEN}"
assert_eq "v10 deploy: ${SHORT_ID}.observedProperties.Value holds the short value in the clear" \
  "$(state_field ".resources[\"${SHORT_ID}\"].observedProperties.Value // \"<absent>\"")" "${SHORT_VALUE}"
# The normalization premise of the #4656 control: AWS holds the group's name
# LOWERCASED, so a readback can never report the mixed-case value it was sent.
assert_eq "v10 deploy: RDS holds the group's name lowercased (the normalization premise)" \
  "$(group_name_in_aws "${GROUP_NAME_LOWER}")" "${GROUP_NAME_LOWER}"
aws sns set-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN_1}" \
  --attribute-name DisplayName --attribute-value "${TOPIC_MARKER}" >/dev/null
assert_eq "v10 deploy: the out-of-band topic marker is set" \
  "$(topic_display "${TOPIC_ARN_1}")" "${TOPIC_MARKER}"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local v11 binary READS the v10 record (no rewrite)"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE_READ="$(state_versions)"
run_cdkd ok "v11 state show" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
fetch_state "v11 read-only state show"
assert_version "v11 read-only state show" 10
assert_eq "v11 state show wrote no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE_READ}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: the MIGRATION deploy under the local v11 binary"
# ---------------------------------------------------------------------------
# Every version NOT listed here is scanned in Phase 9.
snapshot_versions "${STATE_PREFIX}" "pre-migration snapshot (stack prefix)"
snapshot_versions "${INDEX_KEY}" "pre-migration snapshot (exports index)"
snapshot_versions "${CR_RESPONSE_PREFIX}" "pre-migration snapshot (custom-resource responses)"
pass "the pre-migration object versions are recorded ($(grep -c . "${PRE_MIGRATION_VERSIONS}" || true) row(s))"
# The custom resource's seed rotates, so its handler runs under v11 and
# declares its attributes (`noEchoAttributeNames`, #2449). Nothing else moves.
export CDKD_V11_CR_SEED="${CR_SEED_B}"
run_cdkd ok "v11 migration deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 migration deploy"
fetch_state "v11 migration deploy"
assert_version "v11 migration deploy" 11
assert_no_tokens_in_state "v11 migration deploy"
for id in "${TOKEN_ID}" "${SHORT_ID}"; do
  assert_eq "v11 migration deploy: ${id}.properties.Value" \
    "$(state_field ".resources[\"${id}\"].properties.Value")" "${SECRET_MASK}"
  assert_eq "v11 migration deploy: ${id}.noEchoLeaves" \
    "$(jq -c ".resources[\"${id}\"].noEchoLeaves" "${STATE_FILE}")" '[["Value"]]'
  assert_eq "v11 migration deploy: ${id}.observedProperties.Value is the mask" \
    "$(state_field ".resources[\"${id}\"].observedProperties.Value // \"<absent>\"")" "${SECRET_MASK}"
  # The SSM provider echoes the value as `attributes.Value`; v11 declares that
  # attribute NoEcho and masks it whatever its length (the 3-character value
  # is in no blob scan, so only this coordinate can see it).
  assert_eq "v11 migration deploy: ${id}.attributes.Value" \
    "$(state_field ".resources[\"${id}\"].attributes.Value // \"<absent>\"")" "${SECRET_MASK}"
  assert_eq "v11 migration deploy: ${id}.noEchoAttributeNames" \
    "$(jq -c ".resources[\"${id}\"].noEchoAttributeNames" "${STATE_FILE}")" '["Value"]'
done
assert_eq "v11 migration deploy: ${TOPIC_ID}.properties.TopicName" \
  "$(state_field ".resources[\"${TOPIC_ID}\"].properties.TopicName")" "${SECRET_MASK}"
assert_eq "v11 migration deploy: ${TOPIC_ID}.noEchoLeaves" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoLeaves" "${STATE_FILE}")" '[["TopicName"]]'
assert_eq "v11 migration deploy: outputs.TokenOut" "$(state_field '.outputs.TokenOut')" "${SECRET_MASK}"
# #4656: the migration's readback, handed the record with the plaintext
# pre-masked, proves the SNS provider reports the name exactly, and never the
# group's (AWS lowercased it).
assert_eq "v11 migration deploy: ${TOPIC_ID}.noEchoExactEchoLeaves" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoExactEchoLeaves" "${STATE_FILE}")" '[["TopicName"]]'
assert_eq "v11 migration deploy: ${GROUP_ID}.properties.DBParameterGroupName" \
  "$(state_field ".resources[\"${GROUP_ID}\"].properties.DBParameterGroupName")" "${SECRET_MASK}"
assert_eq "v11 migration deploy: ${GROUP_ID}.noEchoLeaves" \
  "$(jq -c ".resources[\"${GROUP_ID}\"].noEchoLeaves" "${STATE_FILE}")" '[["DBParameterGroupName"]]'
assert_eq "v11 migration deploy: ${GROUP_ID} has no noEchoExactEchoLeaves" \
  "$(state_field ".resources[\"${GROUP_ID}\"].noEchoExactEchoLeaves // \"absent\"")" "absent"
# The negative control stays in the clear.
assert_eq "v11 migration deploy: ${PLAIN_ID}.properties.Value (ordinary parameter)" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].properties.Value")" "${PLAIN_VALUE}"
assert_eq "v11 migration deploy: ${PLAIN_ID} has no noEchoLeaves" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].noEchoLeaves // \"absent\"")" "absent"
assert_eq "v11 migration deploy: ${PLAIN_ID}.attributes.Value (ordinary echo stays readable)" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].attributes.Value // \"<absent>\"")" "${PLAIN_VALUE}"
assert_eq "v11 migration deploy: ${PLAIN_ID} declares no noEchoAttributeNames" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].noEchoAttributeNames // \"absent\"")" "absent"
# The SNS provider echoes the name as `attributes.TopicName`: declared NoEcho
# and masked. (`TopicArn` names the resource, like the physical id, and stays.)
assert_eq "v11 migration deploy: ${TOPIC_ID}.attributes.TopicName" \
  "$(state_field ".resources[\"${TOPIC_ID}\"].attributes.TopicName // \"<absent>\"")" "${SECRET_MASK}"
assert_eq "v11 migration deploy: ${TOPIC_ID}.noEchoAttributeNames" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoAttributeNames" "${STATE_FILE}")" '["TopicName"]'
# #2449: the custom resource's declaration is persisted by name.
assert_eq "v11 migration deploy: ${CR_ID}.noEchoAttributeNames" \
  "$(jq -c ".resources[\"${CR_ID}\"].noEchoAttributeNames" "${STATE_FILE}")" '["Secret"]'
assert_eq "v11 migration deploy: ${CR_ID}.attributes.Secret" \
  "$(state_field ".resources[\"${CR_ID}\"].attributes.Secret")" "${SECRET_MASK}"
# NO update, NO replacement: the witness settled every unchanged value.
assert_eq "v11 migration deploy: ${TOKEN_PARAM_NAME} was not re-sent" \
  "$(ssm_modified "${TOKEN_PARAM_NAME}")" "${TOKEN_MODIFIED_1}"
assert_eq "v11 migration deploy: ${SHORT_PARAM_NAME} was not re-sent" \
  "$(ssm_modified "${SHORT_PARAM_NAME}")" "${SHORT_MODIFIED_1}"
assert_eq "v11 migration deploy: the topic was not replaced (out-of-band marker kept)" \
  "$(topic_display "${TOPIC_ARN_1}")" "${TOPIC_MARKER}"
assert_eq "v11 migration deploy: AWS still holds the token" "$(ssm_value "${TOKEN_PARAM_NAME}")" "${TOKEN}"
assert_eq "v11 migration deploy: AWS still holds the short value" \
  "$(ssm_value "${SHORT_PARAM_NAME}")" "${SHORT_VALUE}"

# ---------------------------------------------------------------------------
echo "==> Phase 4: redeploy unchanged (readback settles it; nothing re-sent)"
# ---------------------------------------------------------------------------
run_cdkd ok "v11 unchanged redeploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 unchanged redeploy"
assert_eq "v11 unchanged redeploy: ${TOKEN_PARAM_NAME} was not re-sent" \
  "$(ssm_modified "${TOKEN_PARAM_NAME}")" "${TOKEN_MODIFIED_1}"
assert_eq "v11 unchanged redeploy: ${SHORT_PARAM_NAME} was not re-sent" \
  "$(ssm_modified "${SHORT_PARAM_NAME}")" "${SHORT_MODIFIED_1}"
assert_eq "v11 unchanged redeploy: the topic was not replaced (out-of-band marker kept)" \
  "$(topic_display "${TOPIC_ARN_1}")" "${TOPIC_MARKER}"
# The group's readback differs on an UNCHANGED value (AWS lowercased it): it is
# warned about, naming why, and never replaced.
if ! grep -F -- "${GROUP_ID}.DBParameterGroupName" "${DEPLOY_LOG}" \
    | grep -qF -- "the provider is not known to report this property exactly"; then
  redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
  fail "v11 unchanged redeploy: no line names ${GROUP_ID}.DBParameterGroupName with the normalization reason"
fi
pass "v11 unchanged redeploy: the group's normalized readback is warned about, naming why"
assert_eq "v11 unchanged redeploy: the group was not replaced" \
  "$(group_name_in_aws "${GROUP_NAME_LOWER}")" "${GROUP_NAME_LOWER}"
fetch_state "v11 unchanged redeploy"
assert_no_tokens_in_state "v11 unchanged redeploy"
run_cdkd ok "v11 diff --fail on an unchanged stack" "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail
assert_log_has_no_tokens "v11 diff --fail"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the v10 binary refuses the v11 record"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE_OLD="$(state_versions)"
run_cdkd fail "v10 state show over v11" "${V10_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_log_has "v10 state show over v11" "Upgrade cdkd"
assert_eq "the v10 binary wrote nothing" "$(state_versions)" "${VERSIONS_BEFORE_OLD}"

# ---------------------------------------------------------------------------
echo "==> Phase 6: a dependent of the declared NoEcho attribute is refused (#2449)"
# ---------------------------------------------------------------------------
export CDKD_V11_ADD_DEPENDENT="1"
run_cdkd fail "v11 deploy adding a dependent of Cr.Secret" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has "dependent refusal" "declared that attribute NoEcho"
assert_log_has_no_tokens "dependent refusal"
assert_gone "the refused dependent ${DEPENDENT_PARAM_NAME} exists" \
  aws ssm get-parameter --region "${REGION}" --name "${DEPENDENT_PARAM_NAME}"
pass "the refused dependent was never created"
export CDKD_V11_ADD_DEPENDENT=""
run_cdkd ok "v11 redeploy without the dependent" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 redeploy without the dependent"
fetch_state "after the refusal"
assert_no_tokens_in_state "v11 redeploy without the dependent"
assert_eq "the refused dependent is not in state" \
  "$(state_field '.resources.CrDependent // "absent"')" "absent"

# ---------------------------------------------------------------------------
echo "==> Phase 7: rotate the token and the topic name"
# ---------------------------------------------------------------------------
export CDKD_V11_TOKEN="${TOKEN_ROTATED}"
export CDKD_V11_TOPIC_NAME="${TOPIC_NAME_ROTATED}"
export CDKD_V11_GROUP_NAME="${GROUP_NAME_ROTATED}"
run_cdkd ok "v11 rotation deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 rotation deploy"
assert_eq "v11 rotation deploy: AWS holds the ROTATED token" \
  "$(ssm_value "${TOKEN_PARAM_NAME}")" "${TOKEN_ROTATED}"
fetch_state "v11 rotation deploy"
assert_no_tokens_in_state "v11 rotation deploy"
assert_eq "v11 rotation deploy: ${TOKEN_ID}.properties.Value" \
  "$(state_field ".resources[\"${TOKEN_ID}\"].properties.Value")" "${SECRET_MASK}"
# Every NoEcho coordinate still holds the mask after the rotation.
for id in "${TOKEN_ID}" "${SHORT_ID}"; do
  assert_eq "v11 rotation deploy: ${id}.attributes.Value" \
    "$(state_field ".resources[\"${id}\"].attributes.Value // \"<absent>\"")" "${SECRET_MASK}"
done
assert_eq "v11 rotation deploy: ${SHORT_ID}.properties.Value" \
  "$(state_field ".resources[\"${SHORT_ID}\"].properties.Value")" "${SECRET_MASK}"
assert_eq "v11 rotation deploy: ${TOPIC_ID}.properties.TopicName" \
  "$(state_field ".resources[\"${TOPIC_ID}\"].properties.TopicName")" "${SECRET_MASK}"
assert_eq "v11 rotation deploy: outputs.TokenOut" "$(state_field '.outputs.TokenOut')" "${SECRET_MASK}"
assert_eq "v11 rotation deploy: ${CR_ID}.attributes.Secret" \
  "$(state_field ".resources[\"${CR_ID}\"].attributes.Secret")" "${SECRET_MASK}"
assert_eq "v11 rotation deploy: ${TOPIC_ID}.attributes.TopicName" \
  "$(state_field ".resources[\"${TOPIC_ID}\"].attributes.TopicName // \"<absent>\"")" "${SECRET_MASK}"
assert_eq "v11 rotation deploy: ${TOPIC_ID}.noEchoAttributeNames" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoAttributeNames" "${STATE_FILE}")" '["TopicName"]'
# #4656: the topic's name is proven to be reported exactly, so the rotated
# name REPLACES it, create-first: a new ARN under the rotated name, the old
# topic gone with its out-of-band marker.
TOPIC_ARN_2="$(topic_arn)"
assert_eq "v11 rotation deploy: the topic was REPLACED under the rotated name" \
  "${TOPIC_ARN_2##*:}" "${TOPIC_NAME_ROTATED}"
assert_gone "v11 rotation deploy: the replaced topic ${TOPIC_ARN_1##*:} still exists" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN_1}"
pass "v11 rotation deploy: the old topic is gone"
if [ "$(topic_display "${TOPIC_ARN_2}")" = "${TOPIC_MARKER}" ]; then
  fail "v11 rotation deploy: the new topic carries the old one's out-of-band marker — it was not a real replacement"
fi
pass "v11 rotation deploy: the out-of-band marker is LOST (a real replacement)"
assert_log_has "v11 rotation deploy: the replacement names its cause" \
  "${TOPIC_ID}.TopicName is a create-only property fed by a NoEcho parameter, and AWS, which reports it exactly, holds a different value: ${TOPIC_ID} is replaced."
assert_eq "v11 rotation deploy: ${TOPIC_ID}.noEchoExactEchoLeaves (the new topic's own readback)" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoExactEchoLeaves" "${STATE_FILE}")" '[["TopicName"]]'
# Maintainer decision 1 on #4043: the group, never proven exact, is never
# replaced on a readback's word.
assert_eq "v11 rotation deploy: the group was NOT replaced (old name still held)" \
  "$(group_name_in_aws "${GROUP_NAME_LOWER}")" "${GROUP_NAME_LOWER}"
assert_eq "v11 rotation deploy: no group exists under the rotated name" \
  "$(group_name_in_aws "${GROUP_NAME_ROTATED_LOWER}")" "<absent>"
assert_eq "v11 rotation deploy: ${GROUP_ID}.properties.DBParameterGroupName" \
  "$(state_field ".resources[\"${GROUP_ID}\"].properties.DBParameterGroupName")" "${SECRET_MASK}"
# ONE line names both the property and the remedy (the wording
# noecho-parameter-masking's Phase 3b negative grep relies on).
if ! grep -F -- "${GROUP_ID}.DBParameterGroupName" "${DEPLOY_LOG}" | grep -qF -- "--recreate-via-cc-api"; then
  redact_tokens <"${DEPLOY_LOG}" | tail -40 >&2
  fail "v11 rotation deploy: no single line names both ${GROUP_ID}.DBParameterGroupName and --recreate-via-cc-api — the create-only warning did not fire, or its wording drifted"
fi
pass "v11 rotation deploy: one create-only warning line names ${GROUP_ID}.DBParameterGroupName and --recreate-via-cc-api"

# ---------------------------------------------------------------------------
echo "==> Phase 7b: add a custom resource reading the NoEcho parameter"
# ---------------------------------------------------------------------------
export CDKD_V11_PARAM_CR="1"
run_cdkd ok "v11 deploy adding ParamCr" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 deploy adding ParamCr"
fetch_state "v11 deploy adding ParamCr"
assert_no_tokens_in_state "v11 deploy adding ParamCr"
assert_eq "v11 deploy adding ParamCr: ${PARAM_CR_ID}.properties.Token" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"].properties.Token // \"<absent>\"")" "${SECRET_MASK}"
assert_eq "v11 deploy adding ParamCr: ${PARAM_CR_ID}.noEchoLeaves" \
  "$(jq -c ".resources[\"${PARAM_CR_ID}\"].noEchoLeaves" "${STATE_FILE}")" '[["Token"]]'
assert_gone "the delete marker ${MARKER_PARAM_NAME} exists before any delete" \
  aws ssm get-parameter --region "${REGION}" --name "${MARKER_PARAM_NAME}"
pass "no delete marker before ParamCr is removed"

# ---------------------------------------------------------------------------
echo "==> Phase 7c: removing it skips the delete (exit 2), the record is kept"
# ---------------------------------------------------------------------------
export CDKD_V11_PARAM_CR=""
run_cdkd_rc 2 "v11 deploy removing ParamCr" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Two independent markers: the provider's skip line, and the deploy's
# unaddressed summary.
assert_log_has "ParamCr delete skip" "Custom resource ${PARAM_CR_ID} is recorded in state with Token holding the '***' mask"
# The deploy's own summary wording: the skip line above already contains
# '--allow-unaddressed', so a bare "unaddressed" would match it.
assert_log_has "ParamCr delete skip (summary)" "resource(s) unaddressed, so they may still exist"
assert_log_has_no_tokens "v11 deploy removing ParamCr"
fetch_state "v11 deploy removing ParamCr"
assert_eq "v11 deploy removing ParamCr: the record is KEPT with the mask" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"].properties.Token // \"<absent>\"")" "${SECRET_MASK}"
assert_gone "the handler received a Delete (marker ${MARKER_PARAM_NAME} written)" \
  aws ssm get-parameter --region "${REGION}" --name "${MARKER_PARAM_NAME}"
pass "the skipped delete never reached the handler"

# ---------------------------------------------------------------------------
echo "==> Phase 7d: --allow-unaddressed exits 0; the delete is skipped again"
# ---------------------------------------------------------------------------
run_cdkd_rc 0 "v11 deploy --allow-unaddressed" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --allow-unaddressed
assert_log_has_no_tokens "v11 deploy --allow-unaddressed"
fetch_state "v11 deploy --allow-unaddressed"
assert_eq "v11 deploy --allow-unaddressed: the record is still kept" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"].properties.Token // \"<absent>\"")" "${SECRET_MASK}"
assert_gone "the handler received a Delete under --allow-unaddressed" \
  aws ssm get-parameter --region "${REGION}" --name "${MARKER_PARAM_NAME}"
pass "the delete still never reached the handler"

# ---------------------------------------------------------------------------
echo "==> Phase 7e: drop the record with cdkd state orphan --resource"
# ---------------------------------------------------------------------------
# ParamCr manages nothing beyond the marker it never wrote, so the manual
# teardown the skip warning asks for is only the record.
run_cdkd ok "state orphan --resource ${PARAM_CR_ID}" "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --resource "${PARAM_CR_ID}" --yes
fetch_state "after state orphan"
assert_eq "after state orphan: ${PARAM_CR_ID} is no longer recorded" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"] // \"absent\"")" "absent"

# ---------------------------------------------------------------------------
echo "==> Phase 7f: re-add ParamCr for the destroy arm of the skip"
# ---------------------------------------------------------------------------
# The token stays set from here on: phase 8's destroy must meet ParamCr.
export CDKD_V11_PARAM_CR="1"
run_cdkd ok "v11 deploy re-adding ParamCr" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "v11 deploy re-adding ParamCr"
assert_eq "v11 deploy re-adding ParamCr: ${PARAM_CR_ID}.properties.Token" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"].properties.Token // \"<absent>\"")" "${SECRET_MASK}"
assert_gone "the delete marker ${MARKER_PARAM_NAME} exists before the destroy" \
  aws ssm get-parameter --region "${REGION}" --name "${MARKER_PARAM_NAME}"
pass "no delete marker before the destroy"

# ---------------------------------------------------------------------------
echo "==> Phase 8: destroy"
# ---------------------------------------------------------------------------
# The custom-resource handler and its role, by TYPE (CDK hashes their ids).
CR_HANDLER_NAME="$(state_field '[.resources[] | select(.resourceType == "AWS::Lambda::Function") | .physicalId][0] // ""')"
CR_ROLE_NAME="$(state_field '[.resources[] | select(.resourceType == "AWS::IAM::Role") | .physicalId][0] // ""')"
[ -n "${CR_HANDLER_NAME}" ] || fail "no AWS::Lambda::Function record before destroy"
[ -n "${CR_ROLE_NAME}" ] || fail "no AWS::IAM::Role record before destroy"
pass "the custom-resource handler and its role are recorded before destroy"
# The stack-destroy arm of the custom-resource skip (stackDestroy: the record
# is KEPT and the run exits 2, as CloudFormation leaves DELETE_FAILED).
run_cdkd_rc 2 "v11 destroy with ParamCr" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_log_has "destroy: ParamCr delete skip" "Custom resource ${PARAM_CR_ID} is recorded in state with Token holding the '***' mask"
assert_log_has "destroy: ParamCr delete skip (record kept)" "cdkd is KEEPING the state record and the run exits non-zero"
assert_log_has_no_tokens "v11 destroy with ParamCr"
fetch_state "v11 destroy with ParamCr"
assert_eq "v11 destroy with ParamCr: the record is KEPT with the mask" \
  "$(state_field ".resources[\"${PARAM_CR_ID}\"].properties.Token // \"<absent>\"")" "${SECRET_MASK}"
assert_gone "the destroy's skipped delete reached the handler (marker ${MARKER_PARAM_NAME} written)" \
  aws ssm get-parameter --region "${REGION}" --name "${MARKER_PARAM_NAME}"
pass "the destroy's skipped delete never reached the handler"
# The remedy the skip names: drop the record (ParamCr manages nothing beyond
# the marker it never wrote), then the destroy completes.
run_cdkd ok "state orphan --resource ${PARAM_CR_ID} after the destroy" "${LOCAL_DIST}" state orphan "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --resource "${PARAM_CR_ID}" --yes
run_cdkd ok "v11 destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone"
for param in "${TOKEN_PARAM_NAME}" "${SHORT_PARAM_NAME}" "${PLAIN_PARAM_NAME}"; do
  assert_gone "SSM parameter ${param} still exists after destroy" \
    aws ssm get-parameter --region "${REGION}" --name "${param}"
done
pass "every SSM parameter is gone"
assert_gone "the (replacement) topic still exists after destroy" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN_2}"
assert_gone "the replaced topic exists again after destroy" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN_1}"
pass "both topics are gone"
assert_eq "the DB parameter group is gone after destroy" \
  "$(group_name_in_aws "${GROUP_NAME_LOWER}")" "<absent>"
assert_eq "no DB parameter group exists under the rotated name after destroy" \
  "$(group_name_in_aws "${GROUP_NAME_ROTATED_LOWER}")" "<absent>"
assert_gone "the custom-resource handler ${CR_HANDLER_NAME} still exists after destroy" \
  aws lambda get-function --region "${REGION}" --function-name "${CR_HANDLER_NAME}"
pass "the custom-resource handler is gone"
assert_gone "the handler role ${CR_ROLE_NAME} still exists after destroy" \
  aws iam get-role --role-name "${CR_ROLE_NAME}"
pass "the handler role is gone"

# ---------------------------------------------------------------------------
echo "==> Phase 9: no object version written since the migration carries a value; sweep"
# ---------------------------------------------------------------------------
# Includes the per-resource saves of the migration deploy, written before its
# outputs pass: those once carried the v10 outputs bag in the clear.
# The stack prefix holds state.json, lock.json, rollback-journal.json and
# deployments/*.jsonl; this stack has no nested child, so no `<Stack>~<Child>`
# sibling prefix exists. The exports index and the custom-resource responses
# are SHARED prefixes: scanned read-only for this run's window.
assert_no_tokens_in_versions "${STATE_PREFIX}" "stack prefix" own
assert_no_tokens_in_versions "${INDEX_KEY}" "exports index" shared
assert_no_tokens_in_versions "${CR_RESPONSE_PREFIX}" "custom-resource responses" shared

cleanup
trap - EXIT INT TERM
# The pre-migration versions hold the token by design (Phase 1): `all`, then
# assert nothing survives.
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v10-to-v11-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
s3_assert_key_versions_swept "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent \
  "schema-v10-to-v11-migration exports index"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
if [ "${ASSERTIONS_RUN:-0}" -ne 136 ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly 136 — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v10-to-v11-migration test passed (v10 -> v11 transparent auto-migration with no update or replacement, NoEcho values masked by value and position, declared custom-resource attributes refused exactly, readback-settled redeploy, a rotated create-only value replaced only where the readback is proven exact, a custom resource reading a NoEcho parameter never sent a Delete holding the mask); ${ASSERTIONS_RUN} assertions executed"
