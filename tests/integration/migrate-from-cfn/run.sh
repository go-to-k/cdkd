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

# ---------------------------------------------------------------------------
# VERSION-aware assertions for the transient template upload (issue #2346
# site 7).
#
# `assert_migrate_tmp_empty` above proves no CURRENT object survives, and that
# is genuinely all it can prove: the state bucket is VERSIONED (`cdkd
# bootstrap` turns versioning on), so the `DeleteObject` in `uploadCfnTemplate`'s
# `cleanup()` writes a DELETE MARKER and `aws s3 ls` goes empty while every
# byte of the uploaded TEMPLATE BODY stays readable through
# `GetObject --version-id`. For a template carrying an inline `Code.ZipFile` or
# a hand-written literal, that is the same disclosure shape this issue was
# raised for. So the two assertions compose: the existing one says nothing is
# current, these say nothing is noncurrent either.
#
# WHY A LOCAL COUNTER AND NOT `s3-versions.sh`. The shared helper's
# prefix-scoped `s3_count_versions` cannot answer this question: its
# `_s3v_check_prefix` guard hard-requires a `cdkd/<stack>/<region>/` shape and
# REFUSES anything else, and this prefix is `cdkd-migrate-tmp/` (deliberately
# outside the state prefix so `state list` never mistakes a transient upload
# for a stack). Its key-scoped `s3_count_key_versions` needs an exact key, and
# the key is minted at run time as `<ts>.<ext>` and is already delete-markered
# by the time this runs. Sourcing the helper anyway, for a control it CAN
# answer, would additionally enrol this fixture in the harness fence's caller
# population and move three more committed counts for no coverage gained.
s3_version_rows() {
  local prefix="$1" mode="${2:-all}" query out
  case "${mode}" in
    noncurrent) query="([Versions, DeleteMarkers][])[?IsLatest==\`false\`][].[Key,VersionId]" ;;
    # DELETE MARKERS ONLY. This is the mode that makes the positive marker
    # self-sufficient rather than dependent on `assert_migrate_tmp_empty`
    # running first: a run that uploaded a template and then DIED before
    # deleting it adds a row to the all-rows count too, and measured against
    # the fixtures this arm was written from, an `all >= +1` test PASSES on
    # exactly that shape. A delete marker can only exist because cdkd's own
    # `DeleteObject` ran.
    markers)    query="DeleteMarkers[].[Key,VersionId]" ;;
    *)          query="([Versions, DeleteMarkers][])[][].[Key,VersionId]" ;;
  esac
  # Captured rather than piped, on purpose: piping into the counter hides the
  # exit status, so a throttled LIST would look exactly like "there is nothing
  # here" and this arm would certify a purge it never observed.
  if ! out="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
      --prefix "${prefix}" --query "${query}" --output text --region us-east-1 2>/dev/null)"; then
    return 1
  fi
  printf '%s\n' "${out}" | awk 'NF && $0 != "None" { n++ } END { print n+0 }'
}

# assert_migrate_tmp_versions_purged <stack> <rows-before> <noncurrent-before> <expect-upload:yes|no>
#
# DELTAS, not absolute counts. `preflight_clean` does not touch
# `cdkd-migrate-tmp/`, and delete markers left by runs that predate this fix
# persist, so an absolute floor would be measuring other runs. A delta measures
# only what THIS migrate did.
#
# The POSITIVE marker is `+1 or more` on the DELETE MARKER count for the large
# stack. It has to be delete markers and not all rows: a delete marker can only
# exist because `cleanup()`'s own `DeleteObject` ran, so it proves a template
# was uploaded AND removed in this run, while an all-rows delta is also +1 for
# a run that uploaded and then died before deleting. Absence alone would prove
# neither — it is equally what a run that never uploaded shows, and what the
# SMALL stack shows, whose template goes inline and never touches S3.
#
# The DISCRIMINATOR is `+0` on the noncurrent count. With the purge:
#   [DM_latest]                -> all +1, noncurrent +0
# Without it:
#   [DM_latest, template body] -> all +2, noncurrent +1
assert_migrate_tmp_versions_purged() {
  local stack="$1" before_markers="$2" before_noncurrent="$3" expect_upload="$4"
  local after_markers after_noncurrent d_markers d_noncurrent

  if ! after_markers="$(s3_version_rows "cdkd-migrate-tmp/" markers)"; then
    echo "ASSERTION FAILED: [${stack}] could not list delete markers under cdkd-migrate-tmp/." >&2
    echo "  An unverified purge is not a verified purge - failing rather than assuming." >&2
    exit 1
  fi
  if ! after_noncurrent="$(s3_version_rows "cdkd-migrate-tmp/" noncurrent)"; then
    echo "ASSERTION FAILED: [${stack}] could not list noncurrent versions under cdkd-migrate-tmp/." >&2
    exit 1
  fi
  d_markers=$((after_markers - before_markers))
  d_noncurrent=$((after_noncurrent - before_noncurrent))

  if [ "${expect_upload}" = "no" ] && [ "${d_markers}" -ne 0 ]; then
    echo "ASSERTION FAILED: [${stack}] the migrate added ${d_markers} delete marker(s) under" >&2
    echo "  cdkd-migrate-tmp/, but this stack's template is under the 51,200-byte inline" >&2
    echo "  TemplateBody ceiling and must never reach S3 at all. Either the ceiling moved or" >&2
    echo "  the inline path regressed into an upload." >&2
    exit 1
  fi
  if [ "${expect_upload}" = "yes" ] && [ "${d_markers}" -lt 1 ]; then
    echo "ASSERTION FAILED: [${stack}] the migrate added ${d_markers} delete marker(s) under" >&2
    echo "  cdkd-migrate-tmp/, so no transient template was uploaded and deleted at all." >&2
    echo "  This stack's template is meant to exceed the 51,200-byte inline TemplateBody" >&2
    echo "  ceiling (see lib/migrate-large-stack.ts); without an upload the purge assertion" >&2
    echo "  below would be vacuous." >&2
    exit 1
  fi
  if [ "${d_noncurrent}" -ne 0 ]; then
    echo "ASSERTION FAILED: [${stack}] the migrate left ${d_noncurrent} NONCURRENT version(s)" >&2
    echo "  under cdkd-migrate-tmp/ (delete markers +${d_markers}). The transient template body is still" >&2
    echo "  readable via GetObject --version-id even though 'aws s3 ls' reports the prefix" >&2
    echo "  empty. Inspect with:" >&2
    echo "    aws s3api list-object-versions --bucket ${STATE_BUCKET} --prefix cdkd-migrate-tmp/" >&2
    exit 1
  fi
  if [ "${expect_upload}" = "yes" ]; then
    echo "  ok: transient template uploaded and delete-markered (+${d_markers}), 0 noncurrent left"
  else
    echo "  ok: no transient upload for this stack (inline TemplateBody), 0 markers and 0 noncurrent added"
  fi

  # THE NEGATIVE CONTROL USED TO LIVE HERE AND HAS MOVED, deliberately, to
  # `assert_state_history_survives` after the destroy. Recording why, because
  # the obvious move -- keep a weaker floor at this point -- is the one that
  # produces a green and meaningless fixture.
  #
  # It asserted `noncurrent >= 1` under `cdkd/${stack}/${REGION}/`, and until
  # issue #2346 site 5 that held because `lock.json`'s renewal chain was never
  # purged. It cannot hold now: `cdkd import` calls `saveState` ONCE for the
  # top-level stack -- one CURRENT version, zero noncurrent -- and the lock key
  # is down to its current delete marker with zero noncurrent by the time this
  # runs. On a residue-free prefix it is 0 and FAILS; on a re-run it passes only
  # on the PREVIOUS run's destroy marker, which is about nothing this run did.
  #
  # Weakening it to `all >= 1` was tried and rejected: `assert_state_present`
  # already ran a `head-object` on `state.json` a few lines above, so `all >= 1`
  # is IMPLIED by an assertion that has already passed, and a purge deleting
  # that current version would have failed the earlier one first. A floor that
  # cannot be the first thing to fail is not a control.
  #
  # Nothing at THIS point can discriminate, and that is a fact about the moment
  # rather than a gap: the prefix holds no noncurrent rows yet, so a purge with
  # a widened prefix would have nothing here to take. The control therefore has
  # to run where this fixture actually creates history -- after the destroy.
}

# assert_state_history_survives <stack>
#
# THE negative control for `assert_migrate_tmp_versions_purged`'s claim above,
# taken AFTER `cdkd destroy` because that is the first moment this run
# guarantees a noncurrent row: `deleteState` is issue #2346 sites 1-3, a bare
# `DeleteObject` with no purge, so it leaves a delete marker CURRENT and the
# imported state body NONCURRENT and still readable. That is deliberate --
# those versions are the recovery capability versioning exists for -- and this
# asserts the deliberate part rather than assuming it. A purge that fired on
# the whole state bucket, which is the bug the migrate-tmp assertion cannot
# tell itself apart from, would take exactly these rows.
#
# Scoped to the `state.json` KEY rather than to the stack prefix: `lock.json`
# and the rollback journal contribute their own rows, and a floor over the
# prefix would be satisfiable by them instead of by the key this is about.
#
# IT IS THIS FILE'S ONLY ABSOLUTE FLOOR -- its siblings are deltas -- so it is
# also the one assertion here that depends on bucket VERSIONING being on. The
# probe below is not defensive clutter: `cdkd bootstrap` enables versioning,
# but this fixture accepts the legacy `cdkd-state-<acct>-<region>` bucket that
# predates that, and on such a bucket a bare `DeleteObject` removes the body
# outright. Without the probe this would fail post-destroy while BLAMING a
# purge -- a false report of the exact bug it exists to detect, which is worse
# than no control at all.
assert_state_history_survives() {
  local stack="$1" rows versioning
  versioning="$(aws s3api get-bucket-versioning --bucket "${STATE_BUCKET}" \
    --query 'Status' --output text 2>/dev/null || echo 'ERROR')"
  if [ "${versioning}" != "Enabled" ]; then
    echo "  skip: s3://${STATE_BUCKET} reports versioning '${versioning}', not 'Enabled', so a" >&2
    echo "        deleted object leaves no noncurrent body to assert on. This control needs a" >&2
    echo "        versioned state bucket - the one 'cdkd bootstrap' creates." >&2
    return 0
  fi
  if ! rows="$(s3_version_rows "cdkd/${stack}/${REGION}/state.json" noncurrent)"; then
    echo "ASSERTION FAILED: [${stack}] could not list noncurrent versions of the state key." >&2
    echo "  An unverified control is not a control - failing rather than assuming." >&2
    exit 1
  fi
  if [ "${rows}" -lt 1 ]; then
    echo "ASSERTION FAILED: [${stack}] cdkd/${stack}/${REGION}/state.json has ${rows} noncurrent" >&2
    echo "  version(s) after the destroy. The destroy delete-markers the key, so the imported body" >&2
    echo "  must survive underneath it - issue #2346 sites 1-3 are held open precisely so state" >&2
    echo "  history remains recoverable. Zero here means something purged it." >&2
    echo "  Inspect with:" >&2
    echo "    aws s3api list-object-versions --bucket ${STATE_BUCKET} --prefix cdkd/${stack}/${REGION}/state.json" >&2
    exit 1
  fi
  echo "  ok: ${rows} noncurrent state.json version(s) survive the destroy, as sites 1-3 intend"
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

  # Baseline for the version deltas below, taken BEFORE the migrate so the
  # assertion measures this run rather than whatever earlier runs left behind.
  # A failed LIST here is fatal for the same reason it is fatal after: a
  # baseline nobody could read makes the delta meaningless.
  if ! MIGRATE_TMP_MARKERS_BEFORE="$(s3_version_rows "cdkd-migrate-tmp/" markers)"; then
    echo "ASSERTION FAILED: [${stack}] could not baseline cdkd-migrate-tmp/ before the migrate." >&2
    exit 1
  fi
  if ! MIGRATE_TMP_NONCURRENT_BEFORE="$(s3_version_rows "cdkd-migrate-tmp/" noncurrent)"; then
    echo "ASSERTION FAILED: [${stack}] could not baseline noncurrent rows under cdkd-migrate-tmp/." >&2
    exit 1
  fi

  log "[${stack}] cdkd import --migrate-from-cloudformation"
  AWS_REGION="${REGION}" ${CDKD} import "${stack}" --migrate-from-cloudformation --yes

  log "[${stack}] post-migrate assertions"
  assert_state_present "${stack}"
  assert_cfn_gone "${stack}"
  assert_migrate_tmp_empty
  # Only the LARGE fixture crosses the 51,200-byte inline ceiling (bin/app.ts
  # calls it "the large (>51,200B TemplateURL) path"; lib/migrate-large-stack.ts
  # puts it at "about 67-69 KB in practice"). The small one is submitted inline
  # and must upload nothing, which is asserted rather than skipped.
  if [[ "${stack}" == "CdkdMigrateLarge" ]]; then
    assert_migrate_tmp_versions_purged "${stack}" \
      "${MIGRATE_TMP_MARKERS_BEFORE}" "${MIGRATE_TMP_NONCURRENT_BEFORE}" yes
  else
    assert_migrate_tmp_versions_purged "${stack}" \
      "${MIGRATE_TMP_MARKERS_BEFORE}" "${MIGRATE_TMP_NONCURRENT_BEFORE}" no
  fi

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
  assert_state_history_survives "${stack}"
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
