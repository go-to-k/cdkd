#!/usr/bin/env bash
# verify.sh — cdkd state schema v14 -> v15 migration integ test
# (issue #5498: `ResourceState.unsettledItems`, the item names a failed
# update's accepted calls added).
#
# The released cdkd on npm (the pin below) writes an OLDER schema than v14:
# v14 (#5380) had not been released when this fixture was written, so no
# released binary can leave a v14 record with an unsettled mark. Phase 3
# therefore writes the v14 shape itself — exactly what a v14 writer leaves
# after a cut-short index add: `version: 14`, `unsettledProperties`, no
# items — over a record the released binary wrote, with the index created
# out of band (a v14 binary cannot tell it from another tool's). For the same
# reason the refusal arm (Phase 8) runs the released binary, which predates
# v14: it proves an older binary refuses v15, not a v14 binary specifically;
# both refuse through the same readable-version check.
#
# Every version and value assertion reads S3 or AWS, never a log; write-call
# counts read the SDK call log (`CDKD_SDK_CALL_LOG`).
#
# Red line (pre-fix): "the converging deploy kept gsi2 / a v14 record was
# rewritten beyond its intended fields / the released binary wrote a v15
# record".
#
# PHASES
#   0  preflight, pre-run cleanup, the released binary.
#   1  deploy under the released binary -> its own version (the premise).
#   2  a local deploy of the SAME template over it: no AWS write call, no new
#      state.json object version (a no-op saves nothing; the version moves at
#      the next real write).
#   3  plant the v14 shape: an out-of-band index `gsioob`, then `version: 14`
#      and `unsettledProperties: [GlobalSecondaryIndexes]` on the record.
#   4  the local binary READS it (`state show`): unchanged, no new version.
#   5  the MIGRATION deploy of the base template: exit 0, the current
#      version, the name cleared, `gsioob` KEPT (v14 recorded no items, so it
#      is an undeclared index) with the warning, and the JSON diff of the
#      record touches only the intended fields. `gsioob` is then deleted by
#      hand.
#   6  a local deploy adding `gsi2` under a 10s deadline fails after the
#      accepted Create: the v15 record names `gsi2` in `unsettledItems`.
#   7  `state show --json` round-trips the items; a read writes nothing.
#   8  the released binary refuses the v15 record ("Upgrade cdkd") for
#      `state show` and `deploy`, with the state byte-identical and no AWS
#      write call.
#   9  once `gsi2` is ACTIVE, a local deploy of the base template DELETES it
#      and clears the names and items.
#  10  `cdkd destroy`; the table and the record are gone, every version under
#      the stack prefix purged.
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

STACK="CdkdSchemaV14ToV15Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The released cdkd on npm when this fixture was written. Phase 1 asserts the
# version it writes is below 15, so a later pin that writes v15 fails loudly
# instead of quietly testing nothing.
RELEASED_CDKD_VERSION="0.308.1"
RELEASED_TMPDIR=""
RELEASED_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The schema version the LOCAL binary writes: the readable list's LAST entry
# in the BUILT binary (the `schema-v9-to-v10-migration` derivation).
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
if [ "${LOCAL_SCHEMA_VERSION}" -lt 15 ]; then
  echo "FAIL: the local binary writes schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v15+ local binary" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate this fixture's per-run values" >&2
  exit 1
fi
RUN_ID="$(openssl rand -hex 4)"
TABLE_NAME="cdkd-schema-v15-${RUN_ID}"
export CDKD_V15_TABLE="${TABLE_NAME}"
export CDKD_V15_EDIT="base"

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""
CALLS=""
PRE_STATE=""
JSON_OUT=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV14ToV15?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      set -eu
      return
      ;;
  esac
  if [ -f "${LOCAL_DIST}" ]; then
    CDKD_V15_EDIT=base node "${LOCAL_DIST}" destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
  fi
  # Direct-API fallback for the per-run table (its name is this run's own).
  case "${TABLE_NAME}" in
    cdkd-schema-v15-?*)
      aws dynamodb delete-table --table-name "${TABLE_NAME}" --region "${REGION}" >/dev/null 2>&1
      ;;
  esac
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  if [ -n "${RELEASED_TMPDIR}" ] && [ -d "${RELEASED_TMPDIR}" ]; then
    rm -rf "${RELEASED_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${DEPLOY_LOG:-}" "${CALLS:-}" "${PRE_STATE:-}" "${JSON_OUT:-}"
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
CALLS="$(mktemp)"
PRE_STATE="$(mktemp)"
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

# Run a cdkd command, its output into DEPLOY_LOG and its SDK calls into CALLS
# (truncated first, so the counts are this command's alone).
run_cdkd() { # <expect: ok|fail> <label> <binary> <args...>
  local expect="$1" label="$2" bin="$3" rc
  shift 3
  : >"${CALLS}"
  set +e
  CDKD_SDK_CALL_LOG="${CALLS}" AWS_REGION="${REGION}" node "${bin}" "$@" >"${DEPLOY_LOG}" 2>&1
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

# A `--json` read: stdout alone into JSON_OUT (a warning on stderr would break
# the parse), stderr into DEPLOY_LOG.
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

# `cdkd state show --json` reserializes the parsed record and withholds the
# stack instance id (`withStackInstanceIdWithheld`, src/cli/commands/state.ts:
# a present id prints as "<withheld>"); nothing else in the record is
# rewritten. A comparison against S3 masks the id on BOTH sides and sorts
# keys; byte-level checks read the raw S3 object instead.
SHOW_NORMALIZE='if has("stackInstanceId") then .stackInstanceId = "<withheld>" else . end'

state_raw_sha() { # sha256 of the current state.json body as stored — strict
  local out
  out="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | shasum -a 256 | awk '{print $1}')" \
    || fail "could not read state.json"
  printf '%s' "${out}"
}

assert_log_has() { # <label> <fixed text>
  if ! grep -qF -- "$2" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks '$2'"
  fi
  pass "$1: output names '$2'"
}

# The DynamoDB calls of the last run_cdkd that are not a read
# (Describe* / List* / Get*), as "Command=n" lines; empty when none.
dynamodb_writes() {
  [ -s "${CALLS}" ] || fail "the SDK call log ${CALLS} was not written — CDKD_SDK_CALL_LOG did not take effect"
  jq -r -s 'map(.counts) | reduce .[] as $c ({}; reduce ($c | to_entries[]) as $e (.; .[$e.key] += $e.value))
    | to_entries[] | select(.key | startswith("DynamoDBClient."))
    | select(.key | test("^DynamoDBClient\\.(Describe|List|Get)") | not)
    | "\(.key)=\(.value)"' "${CALLS}"
}

assert_no_dynamodb_writes() { # <label>
  local writes
  writes="$(dynamodb_writes)"
  [ -z "${writes}" ] || fail "$1: DynamoDB write calls were sent: ${writes}"
  pass "$1: no DynamoDB write call was sent"
}

state_versions() { # number of object versions of state.json — strict
  s3_count_key_versions "${STATE_BUCKET}" "${STATE_KEY}" || fail "could not count state.json versions"
}

state_sha() { # sha256 of the CURRENT state.json body — strict
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | shasum -a 256 | awk '{print $1}'
}

index_status() { # <index> -> its IndexStatus, or "None"
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query "Table.GlobalSecondaryIndexes[?IndexName=='$1'].IndexStatus | [0]" --output text
}

index_count() {
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}" \
    --query 'length(Table.GlobalSecondaryIndexes || `[]`)' --output text
}

wait_index() { # <index> <ACTIVE|gone> <label>
  local status=""
  for _ in $(seq 1 360); do
    status="$(index_status "$1")"
    if [ "$2" = "gone" ] && [ "${status}" = "None" ]; then break; fi
    if [ "$2" = "ACTIVE" ] && [ "${status}" = "ACTIVE" ]; then break; fi
    sleep 5
  done
  if [ "$2" = "gone" ]; then
    assert_eq "$3: $1 is gone" "${status}" "None"
  else
    assert_eq "$3: $1 is ACTIVE" "${status}" "ACTIVE"
  fi
}

# ---------------------------------------------------------------------------
echo "==> Phase 0: install the released binary (@go-to-k/cdkd@${RELEASED_CDKD_VERSION})"
# ---------------------------------------------------------------------------
RELEASED_TMPDIR="$(mktemp -d)"
(cd "${RELEASED_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${RELEASED_CDKD_VERSION}" >/dev/null)
RELEASED_BIN="${RELEASED_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
RELEASED_DIR="${RELEASED_TMPDIR}/node_modules/@go-to-k/cdkd/dist"
[ -f "${RELEASED_BIN}" ] || fail "the released binary was not installed at ${RELEASED_BIN}"
RELEASED_SCHEMA_VERSION="$(cat "${RELEASED_DIR}"/*.js 2>/dev/null | awk '
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
case "${RELEASED_SCHEMA_VERSION}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the readable schema versions from the released binary's dist/" >&2
    exit 1
    ;;
esac
if [ "${RELEASED_SCHEMA_VERSION}" -ge 15 ]; then
  fail "premise: the released binary writes schema ${RELEASED_SCHEMA_VERSION}; it must write below 15 to test the refusal"
fi
pass "premise: the released binary writes schema ${RELEASED_SCHEMA_VERSION} (< 15)"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the released binary"
# ---------------------------------------------------------------------------
run_cdkd ok "released deploy" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "released deploy"
assert_version "released deploy" "${RELEASED_SCHEMA_VERSION}"
assert_eq "released deploy: the record carries no unsettled field" \
  "$(state_field '.resources.Table | (has("unsettledProperties") or has("unsettledItems"))')" "false"
assert_eq "released deploy: the table has no index" "$(index_count)" "0"

# ---------------------------------------------------------------------------
echo "==> Phase 2: a local deploy of the same template is a no-op"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE="$(state_versions)"
run_cdkd ok "local no-op deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_no_dynamodb_writes "local no-op deploy"
assert_eq "local no-op deploy: no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE}"
fetch_state "local no-op deploy"
assert_version "local no-op deploy (nothing saved)" "${RELEASED_SCHEMA_VERSION}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: plant the v14 shape (an out-of-band index, an unsettled mark)"
# ---------------------------------------------------------------------------
aws dynamodb update-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --attribute-definitions AttributeName=oobpk,AttributeType=S \
  --global-secondary-index-updates '[{"Create":{"IndexName":"gsioob","KeySchema":[{"AttributeName":"oobpk","KeyType":"HASH"}],"Projection":{"ProjectionType":"KEYS_ONLY"}}}]' >/dev/null
wait_index gsioob ACTIVE "out-of-band create"
jq '.version = 14 | .resources.Table.unsettledProperties = ["GlobalSecondaryIndexes"]' \
  "${STATE_FILE}" >"${PRE_STATE}"
aws s3api put-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
  --content-type application/json --body "${PRE_STATE}" >/dev/null
fetch_state "planted v14"
assert_version "planted v14" 14
assert_eq "planted v14: the record names GlobalSecondaryIndexes unsettled" \
  "$(state_field '.resources.Table.unsettledProperties | join(",")')" "GlobalSecondaryIndexes"

# ---------------------------------------------------------------------------
echo "==> Phase 4: the local binary READS the v14 record (no rewrite)"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE="$(state_versions)"
PLANTED_SHA="$(shasum -a 256 "${PRE_STATE}" | awk '{print $1}')"
assert_eq "planted v14: state.json holds the planted bytes" "$(state_raw_sha)" "${PLANTED_SHA}"
run_cdkd_json "local state show (v14)" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show (v14): the record reads as written (id withheld on both sides)" \
  "$(jq -cS ".state | ${SHOW_NORMALIZE}" "${JSON_OUT}")" "$(jq -cS "${SHOW_NORMALIZE}" "${PRE_STATE}")"
assert_eq "local state show (v14): state.json is byte-identical after the read" \
  "$(state_raw_sha)" "${PLANTED_SHA}"
assert_eq "local state show (v14) wrote no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE}"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the MIGRATION deploy of the base template"
# ---------------------------------------------------------------------------
run_cdkd ok "local migration deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "local migration deploy"
assert_version "local migration deploy" "${LOCAL_SCHEMA_VERSION}"
assert_eq "local migration deploy: gsioob is KEPT (v14 recorded no attempted items)" \
  "$(index_status gsioob)" "ACTIVE"
assert_log_has "local migration deploy" "GSI gsioob on DynamoDB table ${TABLE_NAME} is live, but neither"
assert_eq "local migration deploy: the names are cleared and no items were written" \
  "$(state_field '.resources.Table | (has("unsettledProperties") or has("unsettledItems"))')" "false"
assert_no_dynamodb_writes "local migration deploy (gsioob is not touched)"
# The record's JSON diff over EVERY path (containers too, so an added or
# dropped object or array shows): a path is reported when it exists on one
# side only or holds a different scalar. Each must be an intended one.
CHANGED_PATHS="$(jq -r -n --slurpfile a "${PRE_STATE}" --slurpfile b "${STATE_FILE}" '
  def has_path($doc; $p): try ($doc | getpath($p) | . != null) catch false;
  [ ($a[0] | paths), ($b[0] | paths) ] | unique
  | map(. as $p | select(
      (has_path($a[0]; $p) != has_path($b[0]; $p))
      or (($a[0] | getpath($p) | type) as $t | ($t != "object" and $t != "array")
          and (($a[0] | getpath($p)) != ($b[0] | getpath($p))))))
  | map(map(tostring) | join(".")) | .[]' | sort -u)"
# `observedProperties` is NOT migration output: every written update
# re-captures it from AWS (a fire-and-forget readback), and AWS now holds
# gsioob, so its index list legitimately appears there. Only that subtree is
# exempt; any other added, dropped or changed field fails.
UNEXPECTED="$(printf '%s\n' "${CHANGED_PATHS}" | grep -vE '^(version|lastModified|resources\.Table\.unsettledProperties(\.0)?|resources\.Table\.observedProperties(\..*)?)$' | grep -v '^$' || true)"
[ -z "${UNEXPECTED}" ] || fail "local migration deploy: the record changed beyond the intended fields: ${UNEXPECTED//$'\n'/ }"
pass "local migration deploy: the record changed only in version / lastModified / unsettledProperties (observedProperties re-captured)"
aws dynamodb update-table --table-name "${TABLE_NAME}" --region "${REGION}" \
  --global-secondary-index-updates '[{"Delete":{"IndexName":"gsioob"}}]' >/dev/null
wait_index gsioob gone "hand delete"

# ---------------------------------------------------------------------------
echo "==> Phase 6: a cut-short gsi2 add records the accepted Create (v15)"
# ---------------------------------------------------------------------------
export CDKD_V15_EDIT="gsi"
run_cdkd fail "local cut-short gsi2 add" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --resource-warn-after AWS::DynamoDB::Table=5s --resource-timeout AWS::DynamoDB::Table=10s
fetch_state "local cut-short gsi2 add"
assert_version "local cut-short gsi2 add" "${LOCAL_SCHEMA_VERSION}"
assert_eq "local cut-short gsi2 add: the record names GlobalSecondaryIndexes unsettled" \
  "$(state_field '(.resources.Table.unsettledProperties // []) | join(",")')" "GlobalSecondaryIndexes"
assert_eq "local cut-short gsi2 add: the record names gsi2 as the accepted Create" \
  "$(state_field '(.resources.Table.unsettledItems.GlobalSecondaryIndexes // []) | join(",")')" "gsi2"
cp "${STATE_FILE}" "${PRE_STATE}"

# ---------------------------------------------------------------------------
echo "==> Phase 7: the v15 record round-trips through a read"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE="$(state_versions)"
V15_SHA="$(state_raw_sha)"
run_cdkd_json "local state show (v15)" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" --json
assert_eq "local state show (v15): the items read as written" \
  "$(jq -c '.state.resources.Table.unsettledItems' "${JSON_OUT}")" '{"GlobalSecondaryIndexes":["gsi2"]}'
assert_eq "local state show (v15): the record reads as stored (id withheld on both sides)" \
  "$(jq -cS ".state | ${SHOW_NORMALIZE}" "${JSON_OUT}")" "$(jq -cS "${SHOW_NORMALIZE}" "${PRE_STATE}")"
assert_eq "local state show (v15): state.json is byte-identical after the read" "$(state_raw_sha)" "${V15_SHA}"
assert_eq "local state show (v15) wrote no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE}"

# ---------------------------------------------------------------------------
echo "==> Phase 8: the released binary refuses the v15 record"
# ---------------------------------------------------------------------------
SHA_BEFORE="$(state_sha)"
VERSIONS_BEFORE="$(state_versions)"
run_cdkd fail "released state show over v15" "${RELEASED_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_log_has "released state show over v15" "Upgrade cdkd"
export CDKD_V15_EDIT="base"
run_cdkd fail "released deploy over v15" "${RELEASED_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_log_has "released deploy over v15" "Upgrade cdkd"
assert_no_dynamodb_writes "released deploy over v15"
assert_eq "released refusals: state.json is byte-identical" "$(state_sha)" "${SHA_BEFORE}"
assert_eq "released refusals: no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE}"

# ---------------------------------------------------------------------------
echo "==> Phase 9: the base redeploy deletes gsi2 (the failed update created it)"
# ---------------------------------------------------------------------------
wait_index gsi2 ACTIVE "cut-short add"
run_cdkd ok "local converging deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
wait_index gsi2 gone "local converging deploy"
if grep -qF "GSI gsi2 on DynamoDB table ${TABLE_NAME} is live, but neither" "${DEPLOY_LOG}"; then
  fail "local converging deploy: warned gsi2 is undeclared, though the record names it attempted"
fi
pass "local converging deploy: no undeclared-index warning for gsi2"
fetch_state "local converging deploy"
assert_version "local converging deploy" "${LOCAL_SCHEMA_VERSION}"
assert_eq "local converging deploy: the names and items are cleared" \
  "$(state_field '.resources.Table | (has("unsettledProperties") or has("unsettledItems"))')" "false"

# ---------------------------------------------------------------------------
echo "==> Phase 10: cdkd destroy; everything is gone"
# ---------------------------------------------------------------------------
run_cdkd ok "local destroy" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the destroy"
assert_gone "table ${TABLE_NAME} still exists after the destroy" \
  aws dynamodb describe-table --table-name "${TABLE_NAME}" --region "${REGION}"
pass "the table is gone after the destroy"

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v14-to-v15-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
EXPECTED_ASSERTIONS=51
if [ "${ASSERTIONS_RUN:-0}" -ne "${EXPECTED_ASSERTIONS}" ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly ${EXPECTED_ASSERTIONS} — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v14-to-v15-migration test passed (a v14 record with an unsettled mark is read unchanged and migrates to v15 touching only its intended fields, an index it cannot attribute is kept, a v15 record names the accepted index Create and round-trips, the released binary refuses it without a write, and the next deploy deletes the index the failed update created); ${ASSERTIONS_RUN} assertions executed"
