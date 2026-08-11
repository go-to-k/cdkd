#!/bin/bash
# cdkd integration test: AWS::CodeBuild::Project removal semantics (issue #1160
# codebuild batch).
#
# Deploys a NO_SOURCE project carrying BuildBatchConfig plus the seven optional
# UpdateProject fields a live CFn A/B (2026-08-10) proved CloudFormation
# RETAINS on removal. Then re-deploys with CDKD_TEST_REMOVAL=true, which drops
# ALL EIGHT from the template, and asserts the asymmetry cdkd now matches:
#
#   * BuildBatchConfig must be GONE  -- CFn resets it, so cdkd sends the
#     empty-object clear that UpdateProject requires (an omitted field is a
#     merge no-op, which is the silent drop this issue tracks).
#   * The other seven must be UNCHANGED -- CFn retains them, so cdkd's
#     pass-through is parity. Asserting these is what stops an over-eager
#     provider that reset everything from passing this fixture.
#
# Then destroys and confirms a clean teardown.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdCodeBuildProjectExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

PROJECT_NAME="${STACK}-batch"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion -- best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  state_destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    # `--state-bucket` is REQUIRED here: without it the command resolves
    # cdk.json's placeholder `cdkd-state-test` (the harness exports
    # STATE_BUCKET, not CDKD_STATE_BUCKET), silently targets a nonexistent
    # bucket, and a torn run leaks every resource the raw sweep below does
    # not name.
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    state_destroy_rc=$?
  fi
  # The project is the only stateful leftover a torn run can strand; the
  # execution role goes with the stack.
  aws codebuild delete-project --name "${PROJECT_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    # state.json is gated on the destroy SUCCEEDING: it is the only pointer to
    # resources a failed destroy left behind, so removing it on failure turns a
    # recoverable partial teardown into untracked orphans.
    if [ "${state_destroy_rc:-1}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # lock.json is swept UNCONDITIONALLY. It points at nothing, and a lock
    # stranded by a force-quit makes `state destroy` itself exit non-zero --
    # so gating the lock sweep on that rc would suppress the very cleanup that
    # unsticks the fixture, wedging the next run's deploy until the lock TTL
    # expires.
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# `batch-get-projects` returns a projects[] / projectsNotFound[] pair rather
# than erroring on a missing name, so a plain jq read on projects[0] would
# yield `null` for BOTH "field absent" and "project absent". Read the field
# only after asserting the project itself came back.
project_field() { # usage: project_field <jq-path>
  aws codebuild batch-get-projects --names "${PROJECT_NAME}" --region "${REGION}" \
    --output json | jq -r "if (.projects | length) == 0 then
        \"FAIL-PROJECT-NOT-FOUND\" else (.projects[0] | $1 | tostring) end"
}

assert_field() { # usage: assert_field <description> <jq-path> <expected>
  local desc="$1" path="$2" want="$3" got
  got="$(project_field "${path}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${desc}: expected '${want}', got '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ${got}"
}

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 1: assert every optional field landed"
assert_field "buildBatchConfig.timeoutInMins"  '.buildBatchConfig.timeoutInMins' '120'
assert_field "buildBatchConfig.combineArtifacts" '.buildBatchConfig.combineArtifacts' 'true'
assert_field "description"                     '.description'            'cdkd-integ-description'
assert_field "timeoutInMinutes"                '.timeoutInMinutes'       '25'
assert_field "queuedTimeoutInMinutes"          '.queuedTimeoutInMinutes' '100'
assert_field "concurrentBuildLimit"            '.concurrentBuildLimit'   '2'
assert_field "autoRetryLimit"                  '.autoRetryLimit'         '3'
assert_field "cache.type"                      '.cache.type'             'LOCAL'
assert_field "logsConfig.cloudWatchLogs.status" '.logsConfig.cloudWatchLogs.status' 'DISABLED'

PROJECT_ARN_P1="$(project_field '.arn')"

# --- Phase 2: removal redeploy ---------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_REMOVAL=true (drops all eight)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 2: the ONE field CFn resets must be gone"
# Pre-fix, `mapProperties` mapped the absent block to `undefined`, UpdateProject
# merged, and the live project kept its batch config -- reported as success by
# cdkd and invisible to the next `cdkd diff`. Post-fix the removal sends the
# empty object and AWS nulls the block out.
assert_field "buildBatchConfig cleared on removal" '.buildBatchConfig' 'null'

echo "==> Phase 2: the seven fields CFn RETAINS must be unchanged"
# These are the CFn-parity pins. If a future change "fixes" them into resets,
# this block fails and forces a fresh live CFn A/B rather than a guess.
assert_field "description retained"            '.description'            'cdkd-integ-description'
assert_field "timeoutInMinutes retained"       '.timeoutInMinutes'       '25'
assert_field "queuedTimeoutInMinutes retained" '.queuedTimeoutInMinutes' '100'
assert_field "concurrentBuildLimit retained"   '.concurrentBuildLimit'   '2'
assert_field "autoRetryLimit retained"         '.autoRetryLimit'         '3'
assert_field "cache.type retained"             '.cache.type'             'LOCAL'
assert_field "logsConfig retained"             '.logsConfig.cloudWatchLogs.status' 'DISABLED'

# Replacement guard: the removal must be an in-place UPDATE. A same-name
# replacement would delete and re-create the project, which would also clear
# the batch config -- and would make every assertion above pass for the wrong
# reason.
PROJECT_ARN_P2="$(project_field '.arn')"
if [ "${PROJECT_ARN_P1}" != "${PROJECT_ARN_P2}" ]; then
  echo "FAIL: project was REPLACED across the removal update (${PROJECT_ARN_P1} -> ${PROJECT_ARN_P2}); the reset must be in-place" >&2
  exit 1
fi
echo "    ok: project ARN unchanged (in-place update)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

echo "==> Phase 3: assert the project is gone"
# `batch-get-projects` does NOT error on a missing name -- it returns the name
# under `projectsNotFound` and exits 0 -- so the `assert_gone` helper would read
# the successful call as "still exists" and false-FAIL. Assert on the API's own
# not-found channel instead. Unsilenced and outside condition position, so a
# throttle / auth failure aborts under `set -e` rather than reading as gone.
NOT_FOUND_COUNT="$(aws codebuild batch-get-projects --names "${PROJECT_NAME}" \
  --region "${REGION}" --query 'length(projectsNotFound)' --output text)"
if [ "${NOT_FOUND_COUNT}" != "1" ]; then
  echo "FAIL: CodeBuild project ${PROJECT_NAME} survived destroy (projectsNotFound=${NOT_FOUND_COUNT})" >&2
  exit 1
fi

echo "==> Phase 3: assert state was removed"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: BuildBatchConfig removal reset + the seven CFn-retained fields verified end to end"
