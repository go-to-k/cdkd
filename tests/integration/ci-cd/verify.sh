#!/usr/bin/env bash
# verify.sh — cdkd CodeBuild::Project AutoRetryLimit backfill integ test
# (issue #609).
#
# Asserts that a CodeBuild Project whose template sets AutoRetryLimit has
# that value reach AWS after `cdkd deploy` — the property was a
# silent-drop before the #609 backfill. AutoRetryLimit rides
# CreateProject / UpdateProject directly (no separate control-plane API).
# Also asserts the destroy path cleans up.
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

STACK="CiCdStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
EXPECTED_AUTO_RETRY_LIMIT=2

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying stack via cdkd state destroy, dropping state only on clean destroy"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  local destroy_rc=0
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --yes --state-bucket "${STATE_BUCKET}" --region "${REGION}"
    destroy_rc=$?
  fi
  # Only remove the state key when the destroy succeeded (rc 0). A failed
  # / no-op destroy MUST leave state so resources are not orphaned.
  if [ "${destroy_rc}" -eq 0 ] && [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

# Resolve the CDK-generated project name from the BuildProjectName cdkd
# output (the CfnOutput in lib/ci-cd-stack.ts).
PROJECT_NAME=$(echo "${STATE}" | jq -r '.outputs.BuildProjectName // empty')
if [ -z "${PROJECT_NAME}" ]; then
  echo "FAIL: no BuildProjectName output in state file" >&2
  echo "${STATE}" | jq '.outputs'
  exit 1
fi
echo "    Resolved project name: ${PROJECT_NAME}"

# --- Assertion: AutoRetryLimit reached AWS ----------------------------
# BatchGetProjects returns projects[0].autoRetryLimit when the project
# sets it. Seeing the templated value proves the silent-drop is closed by
# the #609 backfill.
ACTUAL=$(aws codebuild batch-get-projects \
  --names "${PROJECT_NAME}" --region "${REGION}" \
  --query 'projects[0].autoRetryLimit' --output text 2>/dev/null)

if [ "${ACTUAL}" != "${EXPECTED_AUTO_RETRY_LIMIT}" ]; then
  echo "FAIL: projects[0].autoRetryLimit is '${ACTUAL}', expected '${EXPECTED_AUTO_RETRY_LIMIT}' (silent-drop NOT closed)" >&2
  aws codebuild batch-get-projects --names "${PROJECT_NAME}" --region "${REGION}" \
    --query 'projects[0]' --output json
  exit 1
fi
echo "    OK: projects[0].autoRetryLimit == ${EXPECTED_AUTO_RETRY_LIMIT} on AWS (silent-drop CLOSED by #609)"

# --- Phase 2: destroy -------------------------------------------------
echo "==> Phase 2: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

# CodeBuild DeleteProject is SYNCHRONOUS — no polling loop needed. A
# single batch-get-projects after destroy returns an empty `projects`
# array and the name in `projectsNotFound`, confirming deletion.
NOT_FOUND=$(aws codebuild batch-get-projects \
  --names "${PROJECT_NAME}" --region "${REGION}" \
  --query 'projectsNotFound[0]' --output text 2>/dev/null)
PROJECTS_LEN=$(aws codebuild batch-get-projects \
  --names "${PROJECT_NAME}" --region "${REGION}" \
  --query 'length(projects)' --output text 2>/dev/null)

if [ "${NOT_FOUND}" != "${PROJECT_NAME}" ] || [ "${PROJECTS_LEN}" != "0" ]; then
  echo "FAIL: CodeBuild project ${PROJECT_NAME} still exists after destroy (projectsNotFound='${NOT_FOUND}', projects len='${PROJECTS_LEN}')" >&2
  exit 1
fi
echo "    OK: CodeBuild project is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "==> ci-cd test passed (AutoRetryLimit backfill closed + clean destroy)"
