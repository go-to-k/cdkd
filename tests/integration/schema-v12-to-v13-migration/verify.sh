#!/usr/bin/env bash
# verify.sh — cdkd state schema v12 -> v13 migration round-trip integ test
# (issue #5064: the per-stack-instance id).
#
# A state file the last v12 binary (@go-to-k/cdkd@0.301.12) wrote holds no
# `stackInstanceId`. The local v13 binary reads it with no user action, and its
# deploys rewrite it to `version: 13` WITHOUT minting an id: a stack that
# already has a record stays legacy, and no `stack-instance.json` is ever
# written for it. A v12 binary then refuses the v13 record with
# "Upgrade cdkd". After a destroy, a FIRST deploy mints an id (a v4 UUID),
# writes it ahead to `stack-instance.json` and deletes that object (and its
# earlier versions) once `state.json` carries it; later deploys keep the id.
# A first deploy finding a `stack-instance.json` an interrupted run left (no
# `state.json`) reuses its id. The id never appears in cdkd's output, at
# `--verbose` too. Every version and value assertion reads S3, never a log.
#
# Red line (pre-fix): "legacy stack minted an id / id absent / sibling left".
#
# PHASES
#   0  preflight, pre-run cleanup.
#   1  deploy under the v12 binary -> `version: 12`, no id, no sibling (the
#      premise: a wrong pin would test nothing).
#   2  the local binary READS it (`state show`): still `version: 12`, no new
#      state.json object version.
#   3  the MIGRATION deploy under the local binary (an ordinary UPDATE):
#      the current version, still no id, no sibling object version, `Param`
#      updated in place.
#   4  a second local deploy: still no id (legacy stays legacy).
#   5  the v12 binary refuses the v13 record ("Upgrade cdkd").
#   6  `cdkd destroy`; the record is gone.
#   7  a FRESH first deploy (`--verbose`): an id, the sibling gone with no body
#      version left, the id absent from the output.
#   8  a redeploy keeps the id.
#   9  `cdkd destroy`: the record and the sibling are gone.
#  10  the crash re-run: a planted `stack-instance.json` and no record; the
#      first deploy takes ITS id and then deletes it.
#  11  `cdkd destroy`; every version under the stack prefix is purged and
#      asserted gone.
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

STACK="CdkdSchemaV12ToV13Migration"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
SIBLING_KEY="cdkd/${STACK}/${REGION}/stack-instance.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The LAST v12-writing cdkd release on npm when this fixture was written.
# Phase 1 asserts it writes `version: 12` AND no id, so a wrong pin fails
# loudly instead of quietly testing something else.
V12_CDKD_VERSION="0.301.12"
V12_TMPDIR=""
V12_BIN=""
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The schema version the LOCAL binary writes. It was 13 when this fixture was
# written; a later bump moves it, and the local-binary phases assert "the
# current version", not a literal. Read from the BUILT binary (the
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
if [ "${LOCAL_SCHEMA_VERSION}" -lt 13 ]; then
  echo "FAIL: the local binary writes schema ${LOCAL_SCHEMA_VERSION}; this fixture needs a v13+ local binary" >&2
  exit 1
fi

if ! command -v openssl >/dev/null 2>&1; then
  echo "FAIL: openssl is required to generate this fixture's per-run values" >&2
  exit 1
fi
RUN_ID="$(openssl rand -hex 4)"
PARAM_PREFIX="/cdkd-integ/schema-v12-to-v13/${RUN_ID}"
# The id an interrupted first deploy would have written ahead (phase 10).
PLANTED_ID="$(node -e 'process.stdout.write(require("node:crypto").randomUUID())')"

export CDKD_V13_PREFIX="${PARAM_PREFIX}"
export CDKD_V13_EDIT="initial"

UUID_V4='^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'

ASSERTIONS_RUN=0
STATE_FILE=""
DEPLOY_LOG=""

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"
  case "${STACK}" in
    CdkdSchemaV12ToV13?*) ;;
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
  for param in param plain; do
    aws ssm delete-parameter --name "${PARAM_PREFIX}/${param}" --region "${REGION}" >/dev/null 2>&1
  done
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${SIBLING_KEY}" >/dev/null 2>&1
  fi
  # NONCURRENT only: a failed run may still need the current state.json.
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  if [ -n "${V12_TMPDIR}" ] && [ -d "${V12_TMPDIR}" ]; then
    rm -rf "${V12_TMPDIR}"
  fi
  rm -rf "${STATE_FILE:-}" "${DEPLOY_LOG:-}"
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
# The sibling key's whole history, delete markers included: phases 1-4 assert
# no entry exists for it, and a failed earlier run (or this cleanup's own
# delete) can leave one.
if ! s3_purge_key_versions "${STATE_BUCKET}" "${SIBLING_KEY}"; then
  echo "FAIL: could not purge stack-instance.json versions before the run" >&2
  exit 1
fi

STATE_FILE="$(mktemp)"
DEPLOY_LOG="$(mktemp)"

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

# The id is never printed by this script either: a mismatch names its shape.
assert_no_id() { # <label>
  assert_eq "$1: the record carries no stackInstanceId (a legacy stack minted one = pre-fix)" \
    "$(state_field 'has("stackInstanceId")')" "false"
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

assert_log_has() { # <label> <fixed text>
  if ! grep -qF -- "$2" "${DEPLOY_LOG}"; then
    tail -40 "${DEPLOY_LOG}" >&2
    fail "$1: output lacks '$2'"
  fi
  pass "$1: output names '$2'"
}

assert_log_lacks_id() { # <label> <id>
  if grep -qF -- "$2" "${DEPLOY_LOG}"; then
    fail "$1: cdkd's output carries the stack instance id (value withheld)"
  fi
  pass "$1: cdkd's output carries no stack instance id"
}

state_versions() { # number of object versions of state.json — strict
  s3_count_key_versions "${STATE_BUCKET}" "${STATE_KEY}" || fail "could not count state.json versions"
}

sibling_entries() { # versions AND delete markers of stack-instance.json — strict
  s3_count_key_versions "${STATE_BUCKET}" "${SIBLING_KEY}" all \
    || fail "could not count stack-instance.json versions"
}

sibling_bodies() { # BODY versions of stack-instance.json (delete markers excluded); prints nothing on a failed listing, so the caller's assertion fails
  local rows
  rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${SIBLING_KEY}" \
    --query "Versions[?Key=='${SIBLING_KEY}'].[VersionId]" --output text)" || return 1
  printf '%s\n' "${rows}" | awk 'NF && $1 != "None" {n++} END{print n+0}'
}

param_value() { # <name> — strict
  aws ssm get-parameter --region "${REGION}" --name "$1" --query 'Parameter.Value' --output text
}

assert_sibling_gone() { # <label>
  assert_gone "$1: s3://${STATE_BUCKET}/${SIBLING_KEY} still exists" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${SIBLING_KEY}"
  pass "$1: stack-instance.json is gone"
  assert_eq "$1: no body version of stack-instance.json is left (its history purged)" \
    "$(sibling_bodies)" "0"
}

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy under the v12 binary (@go-to-k/cdkd@${V12_CDKD_VERSION})"
# ---------------------------------------------------------------------------
V12_TMPDIR="$(mktemp -d)"
(cd "${V12_TMPDIR}" && npm init -y >/dev/null && npm install --silent "@go-to-k/cdkd@${V12_CDKD_VERSION}" >/dev/null)
V12_BIN="${V12_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
[ -f "${V12_BIN}" ] || fail "the v12 binary was not installed at ${V12_BIN}"

run_cdkd ok "v12 deploy" "${V12_BIN}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "v12 deploy"
assert_version "v12 deploy" 12
assert_no_id "v12 deploy"
assert_eq "v12 deploy: no stack-instance.json was ever written" "$(sibling_entries)" "0"
PARAM_PHYSICAL_1="$(state_field '.resources.Param.physicalId')"
assert_eq "v12 deploy: Param holds the initial value" \
  "$(param_value "${PARAM_PREFIX}/param")" "schema-v13-param-initial"

# ---------------------------------------------------------------------------
echo "==> Phase 2: the local binary READS the v12 record (no rewrite)"
# ---------------------------------------------------------------------------
VERSIONS_BEFORE_READ="$(state_versions)"
run_cdkd ok "local state show" "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
fetch_state "local read-only state show"
assert_version "local read-only state show" 12
assert_eq "local state show wrote no new state.json version" "$(state_versions)" "${VERSIONS_BEFORE_READ}"

# ---------------------------------------------------------------------------
echo "==> Phase 3: the MIGRATION deploy under the local binary (an ordinary UPDATE)"
# ---------------------------------------------------------------------------
export CDKD_V13_EDIT="edit-1"
VERSIONS_BEFORE_MIGRATION="$(state_versions)"
run_cdkd ok "local migration deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "local migration deploy"
assert_version "local migration deploy" "${LOCAL_SCHEMA_VERSION}"
# Assigned first: a failed count exits here, where `$(...)` inside the test
# would only exit its subshell and read as "not greater".
VERSIONS_AFTER_MIGRATION="$(state_versions)"
if [ "${VERSIONS_AFTER_MIGRATION}" -le "${VERSIONS_BEFORE_MIGRATION}" ]; then
  fail "local migration deploy: no new state.json version was written"
fi
pass "local migration deploy: a new state.json version was written"
assert_no_id "local migration deploy"
assert_eq "local migration deploy: no stack-instance.json was written for a legacy stack" \
  "$(sibling_entries)" "0"
assert_eq "local migration deploy: Param was updated in place, not replaced" \
  "$(state_field '.resources.Param.physicalId')" "${PARAM_PHYSICAL_1}"
assert_eq "local migration deploy: Param holds the edited value" \
  "$(param_value "${PARAM_PREFIX}/param")" "schema-v13-param-edit-1"

# ---------------------------------------------------------------------------
echo "==> Phase 4: a second local deploy: legacy stays legacy"
# ---------------------------------------------------------------------------
export CDKD_V13_EDIT="edit-2"
run_cdkd ok "local deploy 2" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "local deploy 2"
assert_no_id "local deploy 2"
assert_eq "local deploy 2: still no stack-instance.json" "$(sibling_entries)" "0"

# ---------------------------------------------------------------------------
echo "==> Phase 5: the v12 binary refuses the v13 record"
# ---------------------------------------------------------------------------
run_cdkd fail "v12 state show over v13" "${V12_BIN}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}"
assert_log_has "v12 state show over v13" "Upgrade cdkd"

# ---------------------------------------------------------------------------
echo "==> Phase 6: cdkd destroy (legacy stack)"
# ---------------------------------------------------------------------------
run_cdkd ok "local destroy (legacy)" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the legacy destroy"

# ---------------------------------------------------------------------------
echo "==> Phase 7: a FRESH first deploy mints an id (--verbose)"
# ---------------------------------------------------------------------------
export CDKD_V13_EDIT="fresh-1"
run_cdkd ok "first deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
fetch_state "first deploy"
assert_version "first deploy" "${LOCAL_SCHEMA_VERSION}"
FIRST_ID="$(state_field '.stackInstanceId // ""')"
if ! printf '%s' "${FIRST_ID}" | grep -qE "${UUID_V4}"; then
  fail "first deploy: the record carries no well-formed stackInstanceId (id absent = pre-fix)"
fi
pass "first deploy: the record carries a v4 UUID stackInstanceId"
assert_sibling_gone "first deploy"
assert_log_lacks_id "first deploy (--verbose)" "${FIRST_ID}"

# ---------------------------------------------------------------------------
echo "==> Phase 8: a redeploy keeps the id"
# ---------------------------------------------------------------------------
export CDKD_V13_EDIT="fresh-2"
run_cdkd ok "redeploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
fetch_state "redeploy"
if [ "$(state_field '.stackInstanceId // ""')" != "${FIRST_ID}" ]; then
  fail "redeploy: the stackInstanceId changed (value withheld)"
fi
pass "redeploy: the stackInstanceId is unchanged"
assert_eq "redeploy: Param holds the edited value" \
  "$(param_value "${PARAM_PREFIX}/param")" "schema-v13-param-fresh-2"

# ---------------------------------------------------------------------------
echo "==> Phase 9: cdkd destroy (v13 stack)"
# ---------------------------------------------------------------------------
run_cdkd ok "local destroy (v13)" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the v13 destroy"
assert_sibling_gone "v13 destroy"

# ---------------------------------------------------------------------------
echo "==> Phase 10: the crash re-run reuses the id an interrupted first deploy wrote ahead"
# ---------------------------------------------------------------------------
printf '{\n  "stackInstanceVersion": 1,\n  "stackInstanceId": "%s"\n}\n' "${PLANTED_ID}" >"${STATE_FILE}"
aws s3api put-object --bucket "${STATE_BUCKET}" --key "${SIBLING_KEY}" \
  --content-type application/json --body "${STATE_FILE}" >/dev/null
pass "a stack-instance.json is planted with no state.json beside it"
export CDKD_V13_EDIT="rerun"
run_cdkd ok "re-run first deploy" "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --verbose
fetch_state "re-run first deploy"
if [ "$(state_field '.stackInstanceId // ""')" != "${PLANTED_ID}" ]; then
  fail "re-run first deploy: the record does not carry the planted id (a fresh id minted = pre-fix; value withheld)"
fi
pass "re-run first deploy: the record carries the id written ahead"
assert_sibling_gone "re-run first deploy"
assert_log_lacks_id "re-run first deploy (--verbose)" "${PLANTED_ID}"

# ---------------------------------------------------------------------------
echo "==> Phase 11: cdkd destroy; everything is gone"
# ---------------------------------------------------------------------------
run_cdkd ok "local destroy (re-run)" "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
pass "the state file is gone after the final destroy"
for param in param plain; do
  assert_gone "SSM parameter ${PARAM_PREFIX}/${param} still exists after the destroy" \
    aws ssm get-parameter --region "${REGION}" --name "${PARAM_PREFIX}/${param}"
  pass "SSM parameter ${param} is gone"
done

cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "schema-v12-to-v13-migration state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))

# THE EXECUTED-ASSERTION COUNT, an exact literal maintained by hand: every
# assertion on the success path runs once, so any other count means a block
# was skipped (or one was added without updating this line).
if [ "${ASSERTIONS_RUN:-0}" -ne 46 ]; then
  echo "FAIL: ${ASSERTIONS_RUN:-0} assertions executed, expected exactly 46 — a block was skipped," >&2
  echo "      so this run proves less than it claims." >&2
  exit 1
fi

echo ""
echo "==> schema-v12-to-v13-migration test passed (v12 -> v13 transparent auto-migration: a legacy stack stays legacy and gets no stack-instance.json, a v12 binary refuses the v13 record, a first deploy mints an id and drops its write-ahead sibling, a redeploy keeps it, and a crash re-run reuses the id written ahead); ${ASSERTIONS_RUN} assertions executed"
