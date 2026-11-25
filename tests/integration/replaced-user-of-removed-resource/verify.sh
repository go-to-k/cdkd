#!/usr/bin/env bash
# verify.sh — a replaced resource's old copy that uses a removed resource is
# deleted before it (issue #6977).
#
# Renaming a Lambda function that has a `currentVersion` and an alias replaces
# the alias and removes the old version (its logical id hashes the function
# name). The old alias is deleted in the cleanup phase; cdkd used to delete
# the removed version first, which Lambda refuses while an alias references
# it: the deploy waited ~5 minutes, kept the version's record and exited 2.
# CloudFormation's cleanup phase deletes the old alias, then the old version,
# then the old function.
#
# Phases:
#   1. Deploy `<stack>-fn-v1` + currentVersion + alias `live`. Assert the
#      alias record depends on the version record (the precondition).
#   2. Re-deploy CDKD_TEST_UPDATE=true (function renamed `-fn-v2`): assert
#      rc 0 (a pre-fix run exits 2), the old alias deleted before the removed
#      version, the old function gone, the new alias live, and no record of
#      the old version or of a superseded resource left in state.
#   3. Destroy: assert the new function and the state file are gone.
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

STACK="CdkdReplacedUserOfRemovedExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SCRATCH="$(mktemp -d)"
FN_V1="${STACK}-fn-v1"
FN_V2="${STACK}-fn-v2"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  for fn in "${FN_V1}" "${FN_V2}"; do
    aws lambda delete-function --function-name "${fn}" --region "${REGION}" >/dev/null 2>&1
  done
  rm -rf "${SCRATCH}"
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2; exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2; exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then npm install; fi

echo "==> Pre-run cleanup"
cleanup
SCRATCH="$(mktemp -d)"

fetch_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${SCRATCH}/state.json" --quiet
}
# The logical id of the record whose id starts with $1 (CDK appends a hash).
logical_id() {
  node -e 'const s=require(process.argv[1]); const k=Object.keys(s.resources).filter((id)=>id.startsWith(process.argv[2])); if(k.length!==1){process.exit(1)} console.log(k[0])' \
    "${SCRATCH}/state.json" "$1"
}
physical_id() {
  node -e 'const s=require(process.argv[1]); console.log(s.resources[process.argv[2]].physicalId)' \
    "${SCRATCH}/state.json" "$1"
}
has_record() {
  node -e 'const s=require(process.argv[1]); process.exit(s.resources && s.resources[process.argv[2]] ? 0 : 1)' \
    "${SCRATCH}/state.json" "$1"
}
superseded_count() {
  node -e 'const s=require(process.argv[1]); console.log((s.supersededResources||[]).length)' \
    "${SCRATCH}/state.json"
}

# --- Phase 1 -----------------------------------------------------------------
echo "==> Phase 1: deploy ${FN_V1} + currentVersion + alias live"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

fetch_state
VERSION_ID="$(logical_id FnCurrentVersion)"
ALIAS_ID="$(logical_id Live)"
if ! node -e 'const s=require(process.argv[1]); process.exit((s.resources[process.argv[2]].dependencies||[]).includes(process.argv[3]) ? 0 : 1)' \
  "${SCRATCH}/state.json" "${ALIAS_ID}" "${VERSION_ID}"; then
  echo "FAIL: Phase 1 state does not record ${ALIAS_ID} depending on ${VERSION_ID} (the precondition under test)" >&2; exit 1
fi
aws lambda get-alias --function-name "${FN_V1}" --name live --region "${REGION}" >/dev/null
echo "    ${ALIAS_ID} depends on ${VERSION_ID}; alias live on ${FN_V1}"

# --- Phase 2 -----------------------------------------------------------------
echo "==> Phase 2: rename the function (alias replaced, old version removed)"
set +e
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${SCRATCH}/phase2.log"
RC=${PIPESTATUS[0]}
set -e
sed 's/\x1b\[[0-9;]*m//g' "${SCRATCH}/phase2.log" > "${SCRATCH}/phase2.plain"
if [ "${RC}" -ne 0 ]; then
  echo "FAIL: Phase 2 deploy exited ${RC}, expected 0 (issue #6977: the removed version was deleted before the old alias)" >&2; exit 1
fi
# Sentinel: the old alias's own delete line is printed whatever the order, so
# its presence without the marker means the marker's wording drifted.
if ! grep -qF "replaced resource(s) first: they use a resource removed from the template" "${SCRATCH}/phase2.plain"; then
  if grep -qF "Old ${ALIAS_ID} (" "${SCRATCH}/phase2.plain"; then
    echo "FAIL: Phase 2 deleted ${ALIAS_ID}'s old copy without the line this fixture parses — update the marker" >&2; exit 1
  fi
  echo "FAIL: Phase 2 never deleted ${ALIAS_ID}'s old copy" >&2; exit 1
fi
ALIAS_LINE="$(grep -nF "✓ Old ${ALIAS_ID} (" "${SCRATCH}/phase2.plain" | head -1 | cut -d: -f1 || true)"
VERSION_LINE="$(grep -nF "${VERSION_ID} (AWS::Lambda::Version) deleted" "${SCRATCH}/phase2.plain" | head -1 | cut -d: -f1 || true)"
if [ -z "${ALIAS_LINE}" ] || [ -z "${VERSION_LINE}" ]; then
  echo "FAIL: Phase 2 did not report both deletes (old alias line '${ALIAS_LINE}', version line '${VERSION_LINE}')" >&2; exit 1
fi
if [ "${ALIAS_LINE}" -ge "${VERSION_LINE}" ]; then
  echo "FAIL: Phase 2 deleted ${VERSION_ID} before ${ALIAS_ID}'s old copy" >&2; exit 1
fi
if grep -qF "Skipped (not deleted)" "${SCRATCH}/phase2.plain"; then
  echo "FAIL: Phase 2 left a resource not deleted" >&2; exit 1
fi
assert_gone "old function ${FN_V1} still exists after the rename" aws lambda get-function --function-name "${FN_V1}" --region "${REGION}"
aws lambda get-alias --function-name "${FN_V2}" --name live --region "${REGION}" >/dev/null
fetch_state
if has_record "${VERSION_ID}"; then
  echo "FAIL: Phase 2 still records the removed ${VERSION_ID}" >&2; exit 1
fi
case "$(physical_id "${ALIAS_ID}")" in
  *":function:${FN_V2}:live") ;;
  *) echo "FAIL: Phase 2 ${ALIAS_ID} record does not name ${FN_V2}:live" >&2; exit 1 ;;
esac
if [ "$(superseded_count)" != "0" ]; then
  echo "FAIL: Phase 2 left superseded resources in state" >&2; exit 1
fi
echo "    rc 0, old alias deleted before the removed version, ${FN_V1} gone, alias live on ${FN_V2}"

# --- Phase 3 -----------------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "function ${FN_V2} still exists after destroy" aws lambda get-function --function-name "${FN_V2}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    ${FN_V2} deleted, cdkd state removed"

echo "[verify] PASS — an old copy using a removed resource is deleted first, all 3 phases passed"
