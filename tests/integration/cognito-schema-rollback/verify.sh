#!/usr/bin/env bash
# verify.sh — cdkd Cognito UserPool rollback over an added custom attribute
# (issue #6375).
#
# CognitoUserPoolProvider.update() sent UpdateUserPool first and refused an
# immutable Schema change (a removed custom attribute) only after it. A
# rollback reverting a deploy that ADDED an attribute therefore applied the old
# password policy, then refused, and reported "Rollback failed": state kept the
# failed deploy's record (12-character minimum) over a pool holding the old one
# (8), so the next deploy of the same update diffed NO_CHANGE and the pool kept
# the weaker policy while cdkd reported success.
#
# Phases:
#   1. Deploy the pool (custom:team, minimum 8). Assert both on AWS.
#   2. Deploy the update (adds custom:level, minimum 12) with a failing queue
#      ordered after the pool. Assert the deploy fails, the rollback reverted
#      the pool to minimum 8 and kept custom:level, state records what AWS
#      holds, and the rollback did not fail.
#   3. Deploy the update again without the failing queue. Assert the pool now
#      has minimum 12 (before the fix: NO_CHANGE, still 8).
#   4. Destroy + assert the pool and the cdkd state file are gone.
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

STACK="CdkdCognitoSchemaRollbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
POOL_NAME="cdkd-cognito-schema-rollback-test"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

pool_id() {
  aws cognito-idp list-user-pools --max-results 60 --region "${REGION}" \
    --query "UserPools[?Name=='${POOL_NAME}'].Id | [0]" --output text 2>/dev/null
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  local pid
  pid="$(pool_id)"
  if [ -n "${pid}" ] && [ "${pid}" != "None" ]; then
    aws cognito-idp delete-user-pool --user-pool-id "${pid}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  [ -n "${P2_LOG:-}" ] && rm -f "${P2_LOG}"
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
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

min_length() {
  aws cognito-idp describe-user-pool --user-pool-id "$1" --region "${REGION}" \
    --query 'UserPool.Policies.PasswordPolicy.MinimumLength' --output text
}
custom_attrs() {
  aws cognito-idp describe-user-pool --user-pool-id "$1" --region "${REGION}" \
    --query "join(' ', sort(UserPool.SchemaAttributes[?starts_with(Name, 'custom:')].Name || \`[]\`))" \
    --output text
}
# The pool record's recorded minimum and custom attribute names, from state.
state_pool() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" | node -e '
    let s = ""; process.stdin.on("data", (d) => (s += d)).on("end", () => {
      const [, rec] = Object.entries(JSON.parse(s).resources).find(([id]) => /^Pool[0-9A-F]{8}$/.test(id));
      const p = rec.properties;
      const names = (p.Schema || []).map((a) => a.Name).sort().join(" ");
      console.log(`${p.Policies.PasswordPolicy.MinimumLength}|${names}`);
    });'
}

# --- Phase 1: base ------------------------------------------------------
echo "==> Phase 1: deploy the pool (custom:team, minimum 8)"
env -u CDKD_TEST_UPDATE -u CDKD_TEST_FAIL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

PID="$(pool_id)"
if [ -z "${PID}" ] || [ "${PID}" = "None" ]; then
  echo "FAIL: pool ${POOL_NAME} not found after Phase 1" >&2
  exit 1
fi
MIN_P1="$(min_length "${PID}")"
ATTRS_P1="$(custom_attrs "${PID}")"
echo "    minimum / custom attributes (Phase 1): ${MIN_P1} / ${ATTRS_P1}"
if [ "${MIN_P1}" != "8" ] || [ "${ATTRS_P1}" != "custom:team" ]; then
  echo "FAIL: Phase 1 baseline not in place" >&2
  exit 1
fi

# --- Phase 2: update + failure -> rollback -------------------------------
echo "==> Phase 2: deploy the update with a failing queue (must roll back)"
P2_LOG="$(mktemp -t cdkd-cognito-schema-rollback-p2.XXXXXX)"
set +e
CDKD_TEST_UPDATE=true CDKD_TEST_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${P2_LOG}" 2>&1
P2_RC=$?
set -e
cat "${P2_LOG}"
if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: Phase 2 deploy succeeded, but the failing queue should have failed it" >&2
  exit 1
fi
# Sentinel: the run must have updated the pool before the queue failed, or
# this phase tests nothing.
if ! grep -qE 'Pool[0-9A-F]+ \(AWS::Cognito::UserPool\).*updated' <<<"$(sed 's/\x1b\[[0-9;]*m//g' "${P2_LOG}")"; then
  echo "FAIL: Phase 2 never updated the pool before failing; the rollback arm was not exercised" >&2
  exit 1
fi

# Correctness first: what AWS holds and what state records.
MIN_P2="$(min_length "${PID}")"
ATTRS_P2="$(custom_attrs "${PID}")"
STATE_P2="$(state_pool)"
echo "    AWS minimum / custom attributes (Phase 2): ${MIN_P2} / ${ATTRS_P2}"
echo "    state minimum|custom attributes (Phase 2): ${STATE_P2}"
if [ "${MIN_P2}" != "8" ]; then
  echo "FAIL: the rollback did not revert the password minimum to 8, got '${MIN_P2}'" >&2
  exit 1
fi
if [ "${ATTRS_P2}" != "custom:level custom:team" ]; then
  echo "FAIL: expected custom:level to stay (AWS cannot remove it), got '${ATTRS_P2}'" >&2
  exit 1
fi
if [ "${STATE_P2}" != "8|level team" ]; then
  echo "FAIL: state does not record what the pool holds (issue #6375): expected '8|level team', got '${STATE_P2}'" >&2
  exit 1
fi
# Then the wording.
P2_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${P2_LOG}")"
# Sentinel for the negative grep below: the rollback must have run and
# reached the pool, or "no failure line" proves nothing.
if ! grep -qE 'Rollback: .*Pool[0-9A-F]+' <<<"${P2_PLAIN}"; then
  echo "FAIL: no rollback line naming the pool; cdkd's rollback wording may have drifted" >&2
  exit 1
fi
if grep -qF "Rollback failed for Pool" <<<"${P2_PLAIN}"; then
  echo "FAIL: the pool's rollback failed (issue #6375)" >&2
  exit 1
fi
if ! grep -qF "removed attribute 'level') cannot be made in place" <<<"${P2_PLAIN}"; then
  echo "FAIL: no warning that the rollback kept custom:level" >&2
  exit 1
fi
echo "    rollback reverted the minimum, kept custom:level with a warning, and state matches AWS"
rm -f "${P2_LOG}"

# --- Phase 3: the update again, without the failure ----------------------
echo "==> Phase 3: deploy the update again (must reach AWS)"
env -u CDKD_TEST_FAIL CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
MIN_P3="$(min_length "${PID}")"
echo "    AWS minimum (Phase 3): ${MIN_P3}"
if [ "${MIN_P3}" != "12" ]; then
  echo "FAIL: the update's 12-character minimum did not reach AWS (issue #6375: NO_CHANGE over a stale record), got '${MIN_P3}'" >&2
  exit 1
fi

# --- Phase 4: destroy ----------------------------------------------------
echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "pool ${PID} still exists after destroy" aws cognito-idp describe-user-pool --user-pool-id "${PID}" --region "${REGION}"
echo "    pool deleted"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — a rollback over an added custom attribute reverts the rest, keeps the attribute, records what AWS holds, and the next deploy applies the update"
