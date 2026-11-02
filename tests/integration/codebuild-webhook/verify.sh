#!/bin/bash
# cdkd integration test: AWS::CodeBuild::Project `Triggers` through the webhook
# calls (go-to-k/cdkd#5627).
#
# Walks one project through what CloudFormation does for each change of
# `Triggers` (README.md has the table) and asserts the LIVE `project.webhook`
# after every deploy:
#
#   1 create with filters     CreateWebhook
#   2 filters changed         UpdateWebhook
#   3 Triggers removed        no call, the webhook and its filters are KEPT
#   4 filters removed         UpdateWebhook, the filters clear
#   5 Webhook: false          DeleteWebhook
#   6 Webhook: true           CreateWebhook on the update path
#   7 destroy                 DeleteProject, and no hook is left on the repository
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
#   CDKD_INTEG_WEBHOOK_REPO           - <owner>/<name>, a repository dedicated to
#                                       this fixture; never one anything else uses.
#                                       `gh` must be able to read its hooks
#   CDKD_INTEG_WEBHOOK_CONNECTION_ARN - an AVAILABLE GitHub connection reaching it
#
# Without the last two the run FAILS: a run that checked nothing must not read
# as a pass.

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

STACK="CdkdCodeBuildWebhookExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PROJECT_NAME="${STACK}-project"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  state_destroy_rc=1
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    state_destroy_rc=$?
  fi
  # `DeleteProject` also removes the project's webhook from the repository.
  aws codebuild delete-project --name "${PROJECT_NAME}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${state_destroy_rc:-1}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

if [ -z "${CDKD_INTEG_WEBHOOK_REPO:-}" ] || [ -z "${CDKD_INTEG_WEBHOOK_CONNECTION_ARN:-}" ]; then
  echo "FAIL: CDKD_INTEG_WEBHOOK_REPO and CDKD_INTEG_WEBHOOK_CONNECTION_ARN are required; a webhook needs a real repository (issue #5627)" >&2
  exit 1
fi

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

deploy() { # usage: deploy <webhook mode>
  env CDKD_TEST_WEBHOOK="$1" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" \
    --yes
}

# `batch-get-projects` answers a missing project with an empty `projects`, so
# read the field only once the project itself came back.
project_field() { # usage: project_field <jq-path>
  aws codebuild batch-get-projects --names "${PROJECT_NAME}" --region "${REGION}" \
    --output json | jq -c "if (.projects | length) == 0 then
        \"FAIL-PROJECT-NOT-FOUND\" else (.projects[0] | $1) end"
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

# The webhook settles after the call answers, so wait for it. `status` can read
# CREATING first.
assert_active() { # usage: assert_active <description>
  local desc="$1" got=""
  for _ in $(seq 1 30); do
    got="$(project_field '.webhook.status')"
    [ "${got}" = '"ACTIVE"' ] && break
    sleep 2
  done
  if [ "${got}" != '"ACTIVE"' ]; then
    echo "FAIL: ${desc}: webhook status stayed '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ACTIVE"
}

# Unsilenced, so an auth failure aborts rather than reading as a count.
repo_hook_count() {
  gh api "repos/${CDKD_INTEG_WEBHOOK_REPO}/hooks" --jq 'length'
}

assert_repo_hooks() { # usage: assert_repo_hooks <when> <expected count>
  local when="$1" want="$2" got=""
  for _ in $(seq 1 15); do
    got="$(repo_hook_count)"
    [ "${got}" = "${want}" ] && break
    sleep 2
  done
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${got} webhook(s) on the repository ${when}, expected ${want}" >&2
    exit 1
  fi
  echo "    ok: ${got} webhook(s) on the repository ${when}"
}

# AWS fills in `excludeMatchedPattern`, so the filters are compared by what the
# template declares, sorted: filters in a group AND together, in any order.
FILTERS='[.webhook.filterGroups[]? | [.[] | [.type, .pattern]] | sort] | sort'
filters_for() { # usage: filters_for <branch>
  printf '[[["EVENT","PUSH"],["HEAD_REF","refs/heads/%s"]]]' "$1"
}

# Before any deploy: Phases 6 and 7 read the repository's hooks.
if ! repo_hook_count >/dev/null; then
  echo "FAIL: gh cannot read the hooks of ${CDKD_INTEG_WEBHOOK_REPO}; authenticate gh with access to them" >&2
  exit 1
fi

echo "==> Phase 1: create with a webhook and filters"
deploy filters
assert_active "webhook status after create"
assert_field "filters after create" "${FILTERS}" "$(filters_for main)"
PROJECT_ARN="$(project_field '.arn')"

# Routing guard: a clean deploy proves nothing if the resource left the SDK path.
PROVISIONED_BY="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
  | jq -r '[.resources[] | select(.resourceType == "AWS::CodeBuild::Project")
            | .provisionedBy // "sdk"] | join(" ")')"
if [ "${PROVISIONED_BY}" != "sdk" ]; then
  echo "FAIL: project provisionedBy='${PROVISIONED_BY}', expected sdk" >&2
  exit 1
fi
echo "    ok: provisionedBy = sdk"

echo "==> Phase 2: a filter change reaches the live webhook"
deploy filters-changed
assert_field "filters after the change" "${FILTERS}" "$(filters_for dev)"

echo "==> Phase 3: removing Triggers keeps the webhook and its filters, as CloudFormation does"
deploy no-triggers
assert_active "webhook status with Triggers removed"
assert_field "filters with Triggers removed" "${FILTERS}" "$(filters_for dev)"

echo "==> Phase 4: removing the filters clears them and keeps the webhook"
deploy no-filters
assert_active "webhook status with no filters"
assert_field "filters after their removal" '.webhook.filterGroups // []' '[]'

echo "==> Phase 5: Webhook: false deletes it"
deploy disabled
# Polled like the other phases, and never `.webhook` itself: it holds urls.
WEBHOOK_LIVE=""
for _ in $(seq 1 30); do
  WEBHOOK_LIVE="$(project_field '.webhook != null')"
  [ "${WEBHOOK_LIVE}" = "false" ] && break
  sleep 2
done
if [ "${WEBHOOK_LIVE}" != "false" ]; then
  echo "FAIL: webhook still live after Webhook: false (webhook != null is '${WEBHOOK_LIVE}')" >&2
  exit 1
fi
echo "    ok: webhook gone after Webhook: false"

echo "==> Phase 6: Webhook: true on the update path creates it again"
deploy filters
assert_active "webhook status after the re-enable"
assert_field "filters after the re-enable" "${FILTERS}" "$(filters_for main)"
if [ "$(project_field '.arn')" != "${PROJECT_ARN}" ]; then
  echo "FAIL: project was REPLACED across the updates; each must be in-place" >&2
  exit 1
fi
echo "    ok: project ARN unchanged (in-place updates)"

# Positive control for Phase 7's count, which a repository that never held a
# hook would pass.
assert_repo_hooks "after the re-enable" 1

echo "==> Phase 7: destroy"
env CDKD_TEST_WEBHOOK=filters node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

NOT_FOUND_COUNT="$(aws codebuild batch-get-projects --names "${PROJECT_NAME}" \
  --region "${REGION}" --query 'length(projectsNotFound)' --output text)"
if [ "${NOT_FOUND_COUNT}" != "1" ]; then
  echo "FAIL: CodeBuild project ${PROJECT_NAME} survived destroy (projectsNotFound=${NOT_FOUND_COUNT})" >&2
  exit 1
fi

# `DeleteProject` removes the hook, a moment after it answers.
assert_repo_hooks "after destroy" 0

assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: AWS::CodeBuild::Project Triggers reached the live webhook on every path"
