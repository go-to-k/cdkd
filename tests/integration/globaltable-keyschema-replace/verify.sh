#!/usr/bin/env bash
# verify.sh — issue #6363: a KeySchema change on a custom-named
# AWS::DynamoDB::GlobalTable is refused by the provider's immutable-property
# guard, which advises `--replace --force-stateful-recreation`. Before the fix
# the guard threw a plain ProvisioningError, so the advised command failed with
# the same refusal. Phases:
#   1. deploy (pk only) and seed one item
#   2. add a sort key with no flags        -> refused, table and item untouched
#   3. same with --replace alone           -> refused by the stateful guard
#   4. same with both flags                -> replaced in place under its name
#   5. destroy                             -> table and state gone

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

cd "$(dirname "$0")"

STACK="CdkdGlobalTableKeySchemaReplace"
TABLE="CdkdGlobalTableKeySchemaReplace"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws dynamodb delete-table --table-name "${TABLE}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REGION}"

key_schema() {
  aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}" \
    --query "join(',', Table.KeySchema[].AttributeName)" --output text
}

# deploy_refused <log> <expected substring> <phase> [flags...]
# Every refused phase deploys CDKD_TEST_UPDATE=sk, a literal so the mode-gate fence can read it.
# The deploy must FAIL and its output must carry the expected refusal. The
# match is REQUIRED, never an absence check, so drifted wording fails loudly.
deploy_refused() {
  local log="$1" expected="$2" phase="$3"
  shift 3
  if CDKD_TEST_UPDATE=sk node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@" >"${log}" 2>&1; then
    cat "${log}" >&2
    echo "FAIL: ${phase}: the deploy succeeded, expected a refusal" >&2
    exit 1
  fi
  if ! grep -qF -- "${expected}" "${log}"; then
    cat "${log}" >&2
    echo "FAIL: ${phase}: the refusal does not say '${expected}'" >&2
    exit 1
  fi
  echo "    OK: ${phase} refused: ${expected}"
}

echo "==> Phase 1: deploy (pk only) and seed one item"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(key_schema)" = "pk" ] || { echo "FAIL: Phase 1: KeySchema is '$(key_schema)', expected 'pk'" >&2; exit 1; }
aws dynamodb put-item --table-name "${TABLE}" --region "${REGION}" --item '{"pk":{"S":"seed"}}'

echo "==> Phase 2: add a sort key with no flags"
deploy_refused "${LOG_DIR}/phase2.log" \
  "KeySchema is immutable on AWS::DynamoDB::GlobalTable" "Phase 2"
# The remedy the refusal prints is the one Phase 4 runs.
grep -qF -- "--replace --force-stateful-recreation" "${LOG_DIR}/phase2.log" \
  || { cat "${LOG_DIR}/phase2.log" >&2; echo "FAIL: Phase 2: the refusal does not name the replace flags" >&2; exit 1; }
[ "$(key_schema)" = "pk" ] || { echo "FAIL: Phase 2: KeySchema changed to '$(key_schema)' on a refused deploy" >&2; exit 1; }
SEED="$(aws dynamodb get-item --table-name "${TABLE}" --region "${REGION}" \
  --key '{"pk":{"S":"seed"}}' --query 'Item.pk.S' --output text)"
[ "${SEED}" = "seed" ] || { echo "FAIL: Phase 2: the seeded item is gone after a refused deploy (got '${SEED}')" >&2; exit 1; }
echo "    OK: table and item untouched"

echo "==> Phase 3: --replace alone is refused by the stateful guard"
deploy_refused "${LOG_DIR}/phase3.log" \
  "Re-run with --force-stateful-recreation to confirm the data loss" "Phase 3" --replace
[ "$(key_schema)" = "pk" ] || { echo "FAIL: Phase 3: KeySchema changed to '$(key_schema)' without --force-stateful-recreation" >&2; exit 1; }
echo "    OK: table untouched"

echo "==> Phase 4: --replace --force-stateful-recreation replaces the table"
# Before #6363 this phase failed with Phase 2's refusal again.
CDKD_TEST_UPDATE=sk node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes --replace --force-stateful-recreation
[ "$(key_schema)" = "pk,sk" ] || { echo "FAIL: Phase 4: KeySchema is '$(key_schema)', expected 'pk,sk'" >&2; exit 1; }
RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | node -e '
  let s = ""; process.stdin.on("data", (c) => (s += c)).on("end", () => {
    const r = JSON.parse(s).resources.TableCD117FA1;
    if (!r) { console.log("<no record>"); return; }
    console.log((r.properties.KeySchema ?? []).map((k) => k.AttributeName).join(","));
  });')"
[ "${RECORDED}" = "pk,sk" ] || { echo "FAIL: Phase 4: state records KeySchema '${RECORDED}', expected 'pk,sk'" >&2; exit 1; }
echo "    OK: replaced; AWS and state both hold pk,sk"

echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
aws dynamodb wait table-not-exists --table-name "${TABLE}" --region "${REGION}"
assert_gone "table ${TABLE} remains" aws dynamodb describe-table --table-name "${TABLE}" --region "${REGION}"
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: table and state gone"
trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
echo ""
echo "==> globaltable-keyschema-replace test passed"
