#!/usr/bin/env bash
# verify.sh — `cdkd diff --fail-on=destructive` and
# `cdkd deploy --require-approval=destructive` against real AWS (issue #4429).
#
# Three SSM parameters (see lib/diff-fail-on-destructive-stack.ts):
#   1. baseline deploy;
#   2. an in-place value change: `--fail-on=destructive` passes while
#      `--fail-on=any-change` / `--fail` fail, and a non-interactive
#      `--require-approval=destructive` deploy goes through without asking;
#   3. a create-only `Name` change (replacement) plus a RETAIN parameter leaving
#      the template (orphaning): `--fail-on=destructive` fails and lists both,
#      `--json` classifies both, and a non-interactive
#      `--require-approval=destructive` deploy refuses with AWS untouched;
#      `--yes` then deploys it;
#   4. destroy, and the orphaned parameter is swept by name.
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

cd "$(dirname "$0")"

STACK="CdkdDiffFailOnDestructiveExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
P_INPLACE="/cdkd-integ/fail-on/inplace"
P_RENAMED_A="/cdkd-integ/fail-on/renamed-a"
P_RENAMED_B="/cdkd-integ/fail-on/renamed-b"
P_KEPT="/cdkd-integ/fail-on/kept"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG="${TMPDIR:-/tmp}/cdkd-4429-fail-on.$$.log"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found; run 'vp run build' first" >&2
  exit 1
fi

cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${LOG}"
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # By name: the orphaned RETAIN parameter is in no state record once orphaned.
  for p in "${P_INPLACE}" "${P_RENAMED_A}" "${P_RENAMED_B}" "${P_KEPT}"; do
    aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

cleanup
CLEANED_UP=0

param_value() {
  aws ssm get-parameter --name "$1" --region "${REGION}" --query 'Parameter.Value' --output text
}

# Runs a cdkd command with stdin closed (no terminal), capturing its exit code
# into RC and its combined output into ${LOG}.
run_cdkd() {
  RC=0
  node "${LOCAL_DIST}" "$@" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    </dev/null >"${LOG}" 2>&1 || RC=$?
}

expect_rc() { # usage: expect_rc <code> <what>
  if [ "${RC}" != "$1" ]; then
    echo "FAIL: $2: expected exit $1, got ${RC}" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

expect_log() { # usage: expect_log <fixed string>
  if ! grep -qF -- "$1" "${LOG}"; then
    echo "FAIL: output lacks: $1" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

expect_no_log() { # usage: expect_no_log <fixed string>
  if grep -qF -- "$1" "${LOG}"; then
    echo "FAIL: output unexpectedly contains: $1" >&2
    cat "${LOG}" >&2
    exit 1
  fi
}

echo "==> Phase 1: baseline deploy"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
[ "$(param_value "${P_INPLACE}")" = "v1" ] || { echo "FAIL: baseline value is not v1" >&2; exit 1; }
param_value "${P_KEPT}" >/dev/null

echo "==> Phase 2: an in-place update is not destructive"
CDKD_TEST_UPDATE=inplace run_cdkd diff "${STACK}" --fail-on=destructive
expect_rc 0 "diff --fail-on=destructive over an in-place update"
expect_no_log "destructive change(s)"
CDKD_TEST_UPDATE=inplace run_cdkd diff "${STACK}" --fail-on=any-change
expect_rc 1 "diff --fail-on=any-change over an in-place update"
CDKD_TEST_UPDATE=inplace run_cdkd diff "${STACK}" --fail
expect_rc 1 "diff --fail over an in-place update"
# No terminal and no --yes: deploys only because nothing is destructive.
CDKD_TEST_UPDATE=inplace run_cdkd deploy "${STACK}" --require-approval=destructive
expect_rc 0 "deploy --require-approval=destructive over an in-place update"
expect_no_log "requires approval"
[ "$(param_value "${P_INPLACE}")" = "v2" ] || { echo "FAIL: in-place value did not reach AWS" >&2; exit 1; }

echo "==> Phase 3: a replacement and an orphaning are destructive"
CDKD_TEST_UPDATE=destructive run_cdkd diff "${STACK}" --fail-on=destructive
expect_rc 1 "diff --fail-on=destructive over a replacement + orphaning"
expect_log "Found 2 destructive change(s) (--fail-on=destructive):"
expect_log "${STACK}: AWS::SSM::Parameter Renamed Renamed9CF9602B will be replaced"
# The template no longer declares it: the path comes from the state record
# the baseline deploy stamped (#4607).
expect_log "${STACK}: AWS::SSM::Parameter Kept Kept118DB03B will be orphaned"
# stdout alone is the --json payload; the error block goes to stderr.
RC=0
CDKD_TEST_UPDATE=destructive node "${LOCAL_DIST}" diff "${STACK}" --fail-on=destructive --json \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" </dev/null >"${LOG}" 2>/dev/null || RC=$?
expect_rc 1 "diff --fail-on=destructive --json"
IMPACTS="$(node -e '
  const nodes = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
  console.log(nodes.flatMap((n) => n.destructiveChanges.map((c) => c.impact)).sort().join(","));
' "${LOG}")"
if [ "${IMPACTS}" != "WILL_ORPHAN,WILL_REPLACE" ]; then
  echo "FAIL: --json destructiveChanges impacts: '${IMPACTS}'" >&2
  exit 1
fi
CDKD_TEST_UPDATE=destructive run_cdkd deploy "${STACK}" --require-approval=destructive
expect_rc 1 "deploy --require-approval=destructive without a terminal"
expect_log "requires approval (--require-approval=destructive), but stdin is not interactive"
expect_log "Destructive changes:"
# Refused before any change: both old parameters remain, the new one is absent.
param_value "${P_RENAMED_A}" >/dev/null
param_value "${P_KEPT}" >/dev/null
assert_gone "replacement ${P_RENAMED_B} was created by a refused deploy" \
  aws ssm get-parameter --name "${P_RENAMED_B}" --region "${REGION}"

# cdkd's stateful-resource guard covers SSM parameters, so the replacement also
# needs its own consent; --require-approval does not stand in for it.
CDKD_TEST_UPDATE=destructive run_cdkd deploy "${STACK}" --require-approval=destructive --yes \
  --force-stateful-recreation
expect_rc 0 "deploy --require-approval=destructive --yes"
param_value "${P_RENAMED_B}" >/dev/null
assert_gone "replaced ${P_RENAMED_A} survived the replacement" \
  aws ssm get-parameter --name "${P_RENAMED_A}" --region "${REGION}"
# Orphaned, not deleted.
[ "$(param_value "${P_KEPT}")" = "kept" ] || { echo "FAIL: RETAIN parameter was not kept" >&2; exit 1; }

echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=destructive node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for p in "${P_INPLACE}" "${P_RENAMED_B}"; do
  assert_gone "parameter ${p} still exists after destroy" \
    aws ssm get-parameter --name "${p}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
# The orphan is the run's own leftover by design: sweep it and prove it gone.
aws ssm delete-parameter --name "${P_KEPT}" --region "${REGION}" >/dev/null
assert_gone "orphaned ${P_KEPT} still exists after the sweep" \
  aws ssm get-parameter --name "${P_KEPT}" --region "${REGION}"

trap - EXIT INT TERM
rm -f "${LOG}"
echo "[verify] PASS — diff --fail-on=destructive and deploy --require-approval=destructive"
