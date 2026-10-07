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
#   - a create-only property a NoEcho parameter feeds is NEVER replaced
#     (maintainer decision 1 on #4043): its topic ARN is unchanged across the
#     migration AND across a rotation, which warns naming --recreate-via-*;
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
#      SSM parameters NOT updated, the topic NOT replaced.
#   4  redeploy unchanged: nothing re-sent; `cdkd diff --fail` exits 0.
#   5  the v10 binary refuses the v11 record ("Upgrade cdkd").
#   6  a dependent of the declared attribute is refused with the exact remedy,
#      created nothing; the stack redeploys clean without it.
#   7  rotate the token and the topic name: SSM holds the new token, state
#      `***`, the topic is NOT replaced and the deploy warns naming
#      --recreate-via-cc-api.
#   8  destroy; every resource and the state file are gone.
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
PLAIN_VALUE="schema-v11-plain-control"
TOKEN_ID="TokenProbe"
SHORT_ID="ShortProbe"
PLAIN_ID="PlainProbe"
TOPIC_ID="NamedTopic"
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
CR_SEED_A="$(openssl rand -hex 8)"
CR_SEED_B="$(openssl rand -hex 8)"
CR_SECRET_A="cdkdv11crsecret${CR_SEED_A}"
CR_SECRET_B="cdkdv11crsecret${CR_SEED_B}"
# The values no object version written from Phase 3 on may carry. The topic
# name is NOT here: it names the resource, so it is in the physical id, which
# stays in the clear by design (AWS publishes it); it is asserted by coordinate.
TOKENS="${TOKEN} ${TOKEN_ROTATED} ${CR_SECRET_A} ${CR_SECRET_B}"

export CDKD_V11_TOKEN="${TOKEN}"
export CDKD_V11_SHORT="${SHORT_VALUE}"
export CDKD_V11_TOPIC_NAME="${TOPIC_NAME}"
export CDKD_V11_CR_SEED="${CR_SEED_A}"
export CDKD_V11_ADD_DEPENDENT=""

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
MIGRATION_START=""

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
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  # Direct-API fallback for the fixed-name objects.
  for param in "${TOKEN_PARAM_NAME}" "${SHORT_PARAM_NAME}" "${PLAIN_PARAM_NAME}" "${DEPENDENT_PARAM_NAME}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1
  done
  for name in "${TOPIC_NAME}" "${TOPIC_NAME_ROTATED}"; do
    aws sns delete-topic --region "${REGION}" \
      --topic-arn "arn:aws:sns:${REGION}:${ACCOUNT_ID:-000000000000}:${name}" >/dev/null 2>&1
  done
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"

  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true

  if [ -n "${V10_TMPDIR}" ] && [ -d "${V10_TMPDIR}" ]; then
    rm -rf "${V10_TMPDIR}"
  fi
  rm -f "${STATE_FILE:-}" "${DEPLOY_LOG:-}"
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
    for t in ${TOKENS} ${TOPIC_NAME} ${TOPIC_NAME_ROTATED}; do
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
  local body t n=0
  body="$(cat "${STATE_FILE}")"
  for t in ${TOKENS}; do
    n=$((n + 1))
    if [[ "${body}" == *"${t}"* ]]; then
      # WHERE it leaked, never the value: the paths whose scalar holds it.
      jq -r --arg t "${t}" \
        '[paths(scalars) as $p | select(getpath($p) | tostring | contains($t)) | ($p | map(tostring) | join("."))] | .[]' \
        "${STATE_FILE}" >&2
      fail "$1: state.json carries NoEcho value #${n} of TOKENS (value withheld)"
    fi
  done
  pass "$1: no NoEcho value anywhere in state.json"
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

# Read every object version under <scope> written AFTER MIGRATION_START and
# fail if any carries a value. `shared` scopes (the exports index, the
# custom-resource responses) tolerate a version another run removed between
# the listing and the read; this fixture's own prefix does not.
assert_no_tokens_in_versions() { # <scope> <label> <own|shared>
  local scope="$1" label="$2" ownership="$3" rows key vid lm body scanned=0 t
  rows="$(list_versions "${scope}" 'Versions[].[Key,VersionId,LastModified]')" \
    || fail "${label}: could not list object versions under s3://${STATE_BUCKET}/${scope}"
  while IFS=$'\t' read -r key vid lm || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    [[ "${lm}" > "${MIGRATION_START}" ]] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      if [ "${ownership}" = "shared" ] \
          && [[ "${body}" == *NoSuchVersion* || "${body}" == *NoSuchKey* ]]; then
        continue
      fi
      fail "${label}: could not read s3://${STATE_BUCKET}/${key} version ${vid}"
    fi
    for t in ${TOKENS}; do
      if [[ "${body}" == *"${t}"* ]]; then
        fail "${label}: s3://${STATE_BUCKET}/${key} version ${vid} carries a NoEcho value (value withheld)"
      fi
    done
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${ownership}" = "own" ] && [ "${scanned}" -eq 0 ]; then
    fail "${label}: no object version written since the migration was found under ${scope} — the scan looked at nothing"
  fi
  pass "${label}: ${scanned} object version(s) written since the migration scanned, none carries a NoEcho value"
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
# Every version from here on is scanned in Phase 9. Taken a minute early: S3's
# LastModified and this host's clock are not the same clock.
MIGRATION_START="$(perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%S+00:00", gmtime(time - 60))')"
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
  assert_eq "v11 migration deploy: ${id}.observedProperties.Value is not in the clear" \
    "$(state_field ".resources[\"${id}\"].observedProperties.Value // \"${SECRET_MASK}\"")" "${SECRET_MASK}"
done
assert_eq "v11 migration deploy: ${TOPIC_ID}.properties.TopicName" \
  "$(state_field ".resources[\"${TOPIC_ID}\"].properties.TopicName")" "${SECRET_MASK}"
assert_eq "v11 migration deploy: ${TOPIC_ID}.noEchoLeaves" \
  "$(jq -c ".resources[\"${TOPIC_ID}\"].noEchoLeaves" "${STATE_FILE}")" '[["TopicName"]]'
assert_eq "v11 migration deploy: outputs.TokenOut" "$(state_field '.outputs.TokenOut')" "${SECRET_MASK}"
# The negative control stays in the clear.
assert_eq "v11 migration deploy: ${PLAIN_ID}.properties.Value (ordinary parameter)" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].properties.Value")" "${PLAIN_VALUE}"
assert_eq "v11 migration deploy: ${PLAIN_ID} has no noEchoLeaves" \
  "$(state_field ".resources[\"${PLAIN_ID}\"].noEchoLeaves // \"absent\"")" "absent"
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
assert_eq "v11 migration deploy: the topic was not replaced" "$(topic_arn)" "${TOPIC_ARN_1}"
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
assert_eq "v11 unchanged redeploy: the topic was not replaced" "$(topic_arn)" "${TOPIC_ARN_1}"
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
fetch_state "after the refusal"
assert_eq "the refused dependent is not in state" \
  "$(state_field '.resources.CrDependent // "absent"')" "absent"

# ---------------------------------------------------------------------------
echo "==> Phase 7: rotate the token and the topic name"
# ---------------------------------------------------------------------------
export CDKD_V11_TOKEN="${TOKEN_ROTATED}"
export CDKD_V11_TOPIC_NAME="${TOPIC_NAME_ROTATED}"
run_cdkd ok "v11 rotation deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has_no_tokens "v11 rotation deploy"
assert_eq "v11 rotation deploy: AWS holds the ROTATED token" \
  "$(ssm_value "${TOKEN_PARAM_NAME}")" "${TOKEN_ROTATED}"
fetch_state "v11 rotation deploy"
assert_no_tokens_in_state "v11 rotation deploy"
assert_eq "v11 rotation deploy: ${TOKEN_ID}.properties.Value" \
  "$(state_field ".resources[\"${TOKEN_ID}\"].properties.Value")" "${SECRET_MASK}"
# Maintainer decision 1 on #4043: never replaced on a readback's word.
assert_eq "v11 rotation deploy: the topic was NOT replaced" "$(topic_arn)" "${TOPIC_ARN_1}"
assert_log_has "v11 rotation deploy: create-only warning" "--recreate-via-cc-api"
assert_log_has "v11 rotation deploy: create-only warning names the property" "${TOPIC_ID}.TopicName"

# ---------------------------------------------------------------------------
echo "==> Phase 8: destroy"
# ---------------------------------------------------------------------------
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
assert_gone "the topic still exists after destroy" \
  aws sns get-topic-attributes --region "${REGION}" --topic-arn "${TOPIC_ARN_1}"
pass "the topic is gone"

# ---------------------------------------------------------------------------
echo "==> Phase 9: no object version written since the migration carries a value; sweep"
# ---------------------------------------------------------------------------
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

# THE EXECUTED-ASSERTION FLOOR, a literal maintained by hand.
if [ "${ASSERTIONS_RUN:-0}" -lt 60 ]; then
  echo "FAIL: only ${ASSERTIONS_RUN:-0} of 60 assertions executed — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v10-to-v11-migration test passed (v10 -> v11 transparent auto-migration with no update or replacement, NoEcho values masked by value and position, declared custom-resource attributes refused exactly, readback-settled redeploy, rotation applied without replacing the create-only reader); ${ASSERTIONS_RUN} assertions executed"
