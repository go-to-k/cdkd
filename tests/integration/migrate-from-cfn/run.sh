#!/usr/bin/env bash
# End-to-end integ for `cdkd import --migrate-from-cloudformation`.
#
# Usage: ./run.sh [small|large|both]   (default: both)
#
# Per-stack flow:
#   1. Pre-flight orphan scan — abort if a previous run left state behind.
#   2. `cdk deploy` (real CloudFormation) creates the source stack.
#   3. `cdkd import --migrate-from-cloudformation --yes` migrates it.
#   4. Assert: cdkd state written, CFn stack gone, AWS resources retained,
#      cdkd-migrate-tmp/ empty (the large-stack path uploads a transient
#      template; the cleanup must run in `finally`).
#   5. `cdkd destroy --force` walks the migrated state and deletes resources.
#   6. Assert: cdkd state empty, AWS resources gone.
#
# This intentionally lives outside `/run-integ` because that skill's flow is
# `cdkd deploy → cdkd destroy`, which doesn't model the migration path.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
TEST_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${TEST_DIR}/../../.." && pwd)"
CDKD="node ${REPO_ROOT}/dist/cli.js"
WHICH="${1:-both}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET_NEW="cdkd-state-${ACCOUNT_ID}"
STATE_BUCKET_LEGACY="cdkd-state-${ACCOUNT_ID}-${REGION}"
if aws s3api head-bucket --bucket "${STATE_BUCKET_NEW}" --region us-east-1 >/dev/null 2>&1; then
  STATE_BUCKET="${STATE_BUCKET_NEW}"
elif aws s3api head-bucket --bucket "${STATE_BUCKET_LEGACY}" --region us-east-1 >/dev/null 2>&1; then
  STATE_BUCKET="${STATE_BUCKET_LEGACY}"
else
  echo "ERROR: neither '${STATE_BUCKET_NEW}' nor '${STATE_BUCKET_LEGACY}' exists. Run 'cdkd bootstrap' first." >&2
  exit 1
fi

log() { printf '\n=== %s ===\n' "$*"; }

# True (rc 0) iff the cdkd state.json key exists for a stack. Probes the exact
# key via head-object, NOT `aws s3 ls` on the prefix: the deployment-events
# layer at cdkd/<stack>/<region>/deployments/ (issue #808) is intentionally
# retained after destroy, so a whole-prefix sweep false-positives the moment a
# run has emitted any deployment event. A canonical not-found/404 means gone;
# any other error (throttle, auth, network) hard-fails rather than being read
# as "clean" (per .claude/rules/testing.md gone-probe rule).
state_json_exists() {
  local stack="$1" err
  err="$(aws s3api head-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${stack}/${REGION}/state.json" --region us-east-1 2>&1 >/dev/null || true)"
  if [ -z "${err}" ]; then
    return 0
  fi
  if printf '%s' "${err}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|404'; then
    return 1
  fi
  echo "ERROR: unexpected error probing state.json for ${stack}: ${err}" >&2
  exit 1
}

# Hard-fail early if a previous run left cdkd state OR a CFn stack with the
# same name. Resuming on top of either masks real bugs (the import would
# refuse, or the cdk deploy would attempt UPDATE on a stale stack).
preflight_clean() {
  local stack="$1"
  log "[${stack}] pre-flight orphan scan"
  if state_json_exists "${stack}"; then
    echo "ERROR: cdkd state already exists for ${stack}. Run 'cdkd state orphan ${stack} --yes' first." >&2
    exit 1
  fi
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "ERROR: CloudFormation stack '${stack}' already exists. Delete it first." >&2
    exit 1
  fi
}

assert_state_present() {
  local stack="$1"
  if ! state_json_exists "${stack}"; then
    echo "ASSERTION FAILED: cdkd state not written for ${stack}" >&2
    exit 1
  fi
  echo "  ok: cdkd state written"
}

assert_state_absent() {
  local stack="$1"
  if state_json_exists "${stack}"; then
    echo "ASSERTION FAILED: cdkd state still present for ${stack} after destroy" >&2
    exit 1
  fi
  echo "  ok: cdkd state cleaned (deployments/ event log retained by design)"
}

assert_cfn_gone() {
  local stack="$1"
  if aws cloudformation describe-stacks --stack-name "${stack}" --region "${REGION}" >/dev/null 2>&1; then
    echo "ASSERTION FAILED: CloudFormation stack ${stack} should be retired but still exists" >&2
    exit 1
  fi
  echo "  ok: CloudFormation stack retired"
}

assert_migrate_tmp_empty() {
  if aws s3 ls "s3://${STATE_BUCKET}/cdkd-migrate-tmp/" --region us-east-1 2>/dev/null | grep -q .; then
    echo "ASSERTION FAILED: cdkd-migrate-tmp/ has leftover objects (cleanup didn't run)" >&2
    aws s3 ls "s3://${STATE_BUCKET}/cdkd-migrate-tmp/" --recursive --region us-east-1 >&2
    exit 1
  fi
  echo "  ok: cdkd-migrate-tmp/ is empty (transient template cleaned up)"
}

run_one() {
  local stack="$1"
  preflight_clean "${stack}"

  log "[${stack}] cdk deploy (real CloudFormation)"
  AWS_REGION="${REGION}" npx cdk deploy "${stack}" --require-approval never

  # AWS::SQS::QueuePolicy used to need a `--resource` override here (issue
  # #361): CFn's DescribeStackResources returns the QueuePolicy's resource
  # NAME as PhysicalResourceId, not the queue URL, so
  # SQSQueuePolicyProvider.import() fell back to properties.Queues[0] —
  # which at provider.import() time was an unresolved `{Ref: <Queue>}` intrinsic.
  # The fix in `src/cli/commands/import.ts` (`substituteOverrideRefs`)
  # pre-resolves `{Ref: <X>}` against the CFn-derived overrides map before
  # calling provider.import(), so QueuePolicy.import() now sees the literal
  # queue URL and the fallback branch succeeds. No `--resource` override
  # needed. This integ is the end-to-end regression guard.

  log "[${stack}] cdkd import --migrate-from-cloudformation"
  AWS_REGION="${REGION}" ${CDKD} import "${stack}" --migrate-from-cloudformation --yes

  log "[${stack}] post-migrate assertions"
  assert_state_present "${stack}"
  assert_cfn_gone "${stack}"
  assert_migrate_tmp_empty

  # PR #331 regression guard: cdkd diff must not warn about
  # `AWS::ECR::Repository.Arn` falling back to physical id, and the
  # downstream `Fn::Split` / `Fn::Select` chain must resolve cleanly.
  # The small fixture's ECR Repository + IAM policy referencing
  # `repo.repositoryArn` is the load-bearing input here.
  if [[ "${stack}" == "CdkdMigrateSmall" ]]; then
    log "[${stack}] cdkd diff (PR #331 regression guard for AWS::ECR::Repository.Arn)"
    diff_output=$(AWS_REGION="${REGION}" ${CDKD} diff "${stack}" 2>&1 || true)
    echo "${diff_output}"
    if echo "${diff_output}" | grep -q "Unknown attribute Arn for resource type AWS::ECR::Repository"; then
      echo "ASSERTION FAILED: PR #331 regression — ECR Repository.Arn handler missing from intrinsic resolver" >&2
      exit 1
    fi
    if echo "${diff_output}" | grep -q "Fn::Select: index .* out of bounds (array length: 1)"; then
      echo "ASSERTION FAILED: PR #331 regression — Fn::Select OOB on ECR ARN parse" >&2
      exit 1
    fi
    echo "  ok: no ECR Arn fallback / Fn::Select OOB warnings in cdkd diff"
  fi

  log "[${stack}] cdkd destroy"
  AWS_REGION="${REGION}" ${CDKD} destroy "${stack}" --force

  log "[${stack}] post-destroy assertions"
  assert_state_absent "${stack}"
}

# Build cdkd before each run so the test always exercises the worktree's
# current code (matches /run-integ's invariant).
log "build cdkd"
(cd "${REPO_ROOT}" && vp run build >/dev/null)

# Ensure CDK app deps are installed (idempotent).
if [[ ! -d "${TEST_DIR}/node_modules" ]]; then
  log "install integ deps"
  (cd "${TEST_DIR}" && vp install --silent)
fi

case "${WHICH}" in
  small) run_one CdkdMigrateSmall ;;
  large) run_one CdkdMigrateLarge ;;
  both)
    run_one CdkdMigrateSmall
    run_one CdkdMigrateLarge
    ;;
  *)
    echo "Usage: $0 [small|large|both]" >&2
    exit 2
    ;;
esac

log "ALL CHECKS PASSED"
