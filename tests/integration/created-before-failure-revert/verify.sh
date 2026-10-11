#!/usr/bin/env bash
# verify.sh — a failed CREATE whose resource outlived the failure is journaled
# with its physical id and deleted by `cdkd rollback --revert-failed`, while a
# provider that cleaned up after itself journals nothing to delete
# (issue #4583).
#
# Two stacks, one per arm, each deployed on its own with --no-rollback so the
# failed deploy's journal survives for the rollback to read. Separate stacks,
# not one: a failing resource interrupts its in-flight siblings, so one stack
# holding both would let the first failure decide whether the second create
# ever ran — the arm that lost the race would test nothing.
#
#   PHASE E (ECR, the provider does NOT delete what it made):
#     E1. Deploy the ECR stack: CreateRepository succeeds, ECR rejects the
#         lifecycle policy (an unknown `tagStatus`). The deploy fails; the
#         repository EXISTS with no lifecycle policy (proof the failing call
#         was PutLifecyclePolicy, after the create returned); state has no
#         record of it; the journal's failed op carries physicalId = the
#         repository name and physicalIdRecoveredFromError = true.
#     E2. `cdkd rollback --force --revert-failed`: exit 2. An ECR repository's
#         provider journals no creation identity, so nothing proves the
#         repository under the name is the one the failed CREATE made
#         (go-to-k/cdkd#4658): the rollback KEEPS it and warns naming it, and
#         the journal and state.json are gone (initial-deploy rollback). The
#         fixture then deletes the repository by hand.
#   PHASE S (SNS, the provider deletes what it made, and the delete succeeds):
#     S1. Deploy the SNS stack (--verbose): CreateTopic succeeds, SNS rejects
#         the data protection policy, the provider's catch deletes the topic
#         ("Cleaned up partially-created SNS topic Topic"). The deploy fails;
#         the topic is gone; the journal's failed op for Topic carries NO
#         physical id and NO physicalIdRecoveredFromError.
#     S2. `cdkd rollback --force --revert-failed`: deletes nothing. The failed
#         CREATE recorded no physical id, so the rollback skips it with a
#         warning and exits 2 (a skipped op is a partial rollback). The topic
#         is still gone, the journal and state.json are gone.
#   PHASE N (go-to-k/cdkd#4738, a nested child whose only skip is a journaled
#   orphan):
#     N1. Deploy the nested stack clean: the parent records `Child`, and the
#         child `<Parent>~Child` has its own state.
#     N2. Deploy it again with NESTED_ORPHAN=1 --no-rollback: the child's
#         update creates the ECR arm's repository and fails at its lifecycle
#         policy, so the CHILD's journal names the repository.
#     N3. `cdkd destroy` the parent: exit 2, the repository is KEPT (nothing
#         proves it is the one the failed CREATE made), the child's state is
#         deleted, and -- the fix -- the parent's state is deleted in the SAME
#         run, with the `Child` row reported as deleted leaving 1 resource in
#         AWS and no "State preserved" claim. Before the fix the parent kept
#         its state and needed a second destroy. The fixture then deletes the
#         repository by hand.
#
# After a run killed with SIGKILL (no trap runs), delete by hand the ECR
# repositories `cdkdcreatedbeforefailurerevertecrexample-orphan-repo` and
# `cdkdcreatedbeforefailurerevertnestedexample-orphan-repo` and the SNS topic
# `CdkdCreatedBeforeFailureRevertSnsExample-topic` — the next run's pre-run
# sweep also removes them.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

ECR_STACK="CdkdCreatedBeforeFailureRevertEcrExample"
SNS_STACK="CdkdCreatedBeforeFailureRevertSnsExample"
NESTED_STACK="CdkdCreatedBeforeFailureRevertNestedExample"
NESTED_CHILD="${NESTED_STACK}~Child"
# The names the stacks derive from their own ids (lib/*-stack.ts).
REPO_NAME="cdkdcreatedbeforefailurerevertecrexample-orphan-repo"
TOPIC_NAME="${SNS_STACK}-topic"
NESTED_REPO_NAME="cdkdcreatedbeforefailurerevertnestedexample-orphan-repo"
ECR_STATE_KEY="cdkd/${ECR_STACK}/${REGION}/state.json"
ECR_JOURNAL_KEY="cdkd/${ECR_STACK}/${REGION}/rollback-journal.json"
SNS_STATE_KEY="cdkd/${SNS_STACK}/${REGION}/state.json"
SNS_JOURNAL_KEY="cdkd/${SNS_STACK}/${REGION}/rollback-journal.json"
NESTED_STATE_KEY="cdkd/${NESTED_STACK}/${REGION}/state.json"
NESTED_JOURNAL_KEY="cdkd/${NESTED_STACK}/${REGION}/rollback-journal.json"
CHILD_STATE_KEY="cdkd/${NESTED_CHILD}/${REGION}/state.json"
CHILD_JOURNAL_KEY="cdkd/${NESTED_CHILD}/${REGION}/rollback-journal.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/cbf-revert.XXXXXX")"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "[verify] FAIL: ${LOCAL_DIST} not found — run 'vp run build' at the repo root first" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

ACCOUNT_ID="" PARTITION=""
read -r ACCOUNT_ID PARTITION < <(aws sts get-caller-identity --query '[Account, Arn]' --output text \
  | awk '{ split($2, a, ":"); print $1, a[2] }') || true
if [ -z "${ACCOUNT_ID}" ] || [ -z "${PARTITION}" ]; then
  echo "[verify] FAIL: could not read the account id and partition from sts get-caller-identity" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
TOPIC_ARN="arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"

echo "[verify] region=${REGION} stacks=${ECR_STACK},${SNS_STACK},${NESTED_STACK} state-bucket=${STATE_BUCKET}"

# Best-effort removal of everything this fixture can leave: the two named
# resources first (neither is ever in state, so the state destroy cannot reach
# them), then both stacks' state and their whole state prefixes (journal,
# lock, events). Every name is a literal of this fixture, so no listing is
# swept and no scope guard is needed.
sweep() {
  (
  set +eu
  aws ecr delete-repository --repository-name "${REPO_NAME}" --force --region "${REGION}" >/dev/null 2>&1
  aws ecr delete-repository --repository-name "${NESTED_REPO_NAME}" --force --region "${REGION}" >/dev/null 2>&1
  aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1
  for s in "${ECR_STACK}" "${SNS_STACK}" "${NESTED_STACK}" "${NESTED_CHILD}"; do
    node "${LOCAL_DIST}" state destroy "${s}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/" --recursive >/dev/null 2>&1
  done
  true
  )
}

cleanup() {
  rc=$?
  # Once only: an INT / TERM trap runs this and then exits, which would fire
  # the EXIT trap and sweep a second time.
  trap - EXIT INT TERM
  echo "[verify] cleanup (rc=${rc})"
  sweep
  rm -rf "${LOG_DIR}"
  exit "${rc}"
}

# Deleted resources can answer for a moment, so "gone" is polled.
wait_gone() { # usage: wait_gone <description> aws <service> <read-verb> [args...]
  local desc="$1" deadline
  shift
  deadline=$(( $(date +%s) + 120 ))
  while ! gone_probe "$@"; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: ${desc}" >&2
      exit 1
    fi
    sleep 5
  done
}

# The ECR repositories' and SNS topic's read probes.
repo_probe() { echo "aws ecr describe-repositories --repository-names ${REPO_NAME} --region ${REGION}"; }
nested_repo_probe() { echo "aws ecr describe-repositories --repository-names ${NESTED_REPO_NAME} --region ${REGION}"; }
topic_probe() { echo "aws sns get-topic-attributes --topic-arn ${TOPIC_ARN} --region ${REGION}"; }

# cdkd colours its output whatever the terminal, so every grep reads a copy
# with the ANSI sequences stripped.
strip_ansi() { # usage: strip_ansi <raw log> <plain log>
  sed $'s/\x1b\\[[0-9;]*m//g' "$1" > "$2"
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# ---------------------------------------------------------------------------
# PRE-RUN: an interrupted earlier run can leave the repository, the topic or
# the state behind; any of them would turn a create into a name collision.
# ---------------------------------------------------------------------------
echo "[verify] pre-run: sweep leftovers of an earlier run"
sweep
# shellcheck disable=SC2046
wait_gone "pre-run: ${REPO_NAME} still exists after the sweep" $(repo_probe)
# shellcheck disable=SC2046
wait_gone "pre-run: ${TOPIC_ARN} still exists after the sweep" $(topic_probe)
# shellcheck disable=SC2046
wait_gone "pre-run: ${NESTED_REPO_NAME} still exists after the sweep" $(nested_repo_probe)
for key in "${ECR_STATE_KEY}" "${ECR_JOURNAL_KEY}" "${SNS_STATE_KEY}" "${SNS_JOURNAL_KEY}" \
  "${NESTED_STATE_KEY}" "${NESTED_JOURNAL_KEY}" "${CHILD_STATE_KEY}" "${CHILD_JOURNAL_KEY}"; do
  assert_gone "pre-run: s3://${STATE_BUCKET}/${key} still exists after the sweep" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}"
done

if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

deploy_expect_failure() { # usage: deploy_expect_failure <stack> <plain log> [extra flags...]
  local rc=0 stack="$1" log="$2"
  shift 2
  node "${LOCAL_DIST}" deploy "${stack}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --yes --no-rollback "$@" > "${log}.raw" 2>&1 || rc=$?
  strip_ansi "${log}.raw" "${log}"
  sed 's/^/  /' "${log}" || true
  if [ "${rc}" -eq 0 ]; then
    echo "[verify] FAIL: the ${stack} deploy SUCCEEDED — its post-create call was meant to be rejected" >&2
    exit 1
  fi
}

# Echoes the rollback's exit code; the plain log is written to <plain log>.
run_rollback() { # usage: run_rollback <stack> <plain log>
  local rc=0
  node "${LOCAL_DIST}" rollback "$1" --state-bucket "${STATE_BUCKET}" --force --revert-failed \
    > "$2.raw" 2>&1 || rc=$?
  strip_ansi "$2.raw" "$2"
  sed 's/^/  /' "$2" >&2 || true
  echo "${rc}"
}

# The newest journal segment's failed op for a logical id, compact JSON, or
# empty when there is none. The journal must exist: a failed read aborts.
journal_failed_op() { # usage: journal_failed_op <journal key> <logical id>
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/$1" -)" || return 1
  printf '%s' "${body}" \
    | jq -c --arg id "$2" '[.segments[-1].failedOperations[]? | select(.logicalId == $id)] | first // empty'
}

state_has_resource() { # usage: state_has_resource <state key> <logical id> — true/false
  aws s3 cp "s3://${STATE_BUCKET}/$1" - | jq --arg id "$2" '(.resources // {}) | has($id)'
}

# ---------------------------------------------------------------------------
# PHASE E: ECR — the created repository is journaled and the rollback deletes it
# ---------------------------------------------------------------------------
echo "[verify] phase E1: deploy ${ECR_STACK} --no-rollback (expect FAILURE at PutLifecyclePolicy)"
deploy_expect_failure "${ECR_STACK}" "${LOG_DIR}/e1.log"
if ! grep -qF "Failed to create ECR Repository OrphanRepo" "${LOG_DIR}/e1.log"; then
  echo "[verify] FAIL: phase E1: the deploy did not fail in the OrphanRepo create (or the wording drifted)" >&2
  exit 1
fi
# PREMISE: CreateRepository returned. Without it the failure came before the
# create and nothing below tests #4583.
if ! E1_DESCRIBE="$(aws ecr describe-repositories --repository-names "${REPO_NAME}" --region "${REGION}" 2>&1)"; then
  if printf '%s' "${E1_DESCRIBE}" | grep -qF 'RepositoryNotFoundException'; then
    echo "[verify] FAIL: phase E1: ${REPO_NAME} does not exist after the failed deploy — the CREATE failed before CreateRepository, so this phase tests nothing" >&2
  else
    echo "[verify] FAIL: phase E1: describe-repositories for ${REPO_NAME} failed for another reason, so the premise is undetermined: ${E1_DESCRIBE}" >&2
  fi
  exit 1
fi
# PREMISE: the failing call was PutLifecyclePolicy (the only call between
# CreateRepository and the repository policy, which this stack does not set).
assert_gone "phase E1: ${REPO_NAME} carries a lifecycle policy — PutLifecyclePolicy was accepted, so something else failed" \
  aws ecr get-lifecycle-policy --repository-name "${REPO_NAME}" --region "${REGION}"
if [ "$(state_has_resource "${ECR_STATE_KEY}" OrphanRepo)" != "false" ]; then
  echo "[verify] FAIL: phase E1: state records OrphanRepo (expected no record for a CREATE that threw)" >&2
  exit 1
fi
ECR_OP="$(journal_failed_op "${ECR_JOURNAL_KEY}" OrphanRepo)"
if [ -z "${ECR_OP}" ]; then
  echo "[verify] FAIL: phase E1: the journal records no failed op for OrphanRepo" >&2
  exit 1
fi
ECR_OP_FIELDS="$(printf '%s' "${ECR_OP}" \
  | jq -r '[.changeType // "<absent>", .physicalId // "<absent>", (.physicalIdRecoveredFromError | tostring)] | join(" ")')"
# Before #4583 the ECR provider never marked the error, so the failed CREATE
# journaled no physical id and the repository was unreachable for a rollback.
if [ "${ECR_OP_FIELDS}" != "CREATE ${REPO_NAME} true" ]; then
  echo "[verify] FAIL: phase E1: failed OrphanRepo op journaled changeType/physicalId/physicalIdRecoveredFromError = '${ECR_OP_FIELDS}' (expected 'CREATE ${REPO_NAME} true')" >&2
  echo "${ECR_OP}" | jq . | sed 's/^/  /' >&2
  exit 1
fi
echo "[verify] phase E1 ok: repository created, its lifecycle policy rejected, the journal names it (recovered from the error)"

echo "[verify] phase E2: cdkd rollback ${ECR_STACK} --force --revert-failed (expect exit 2, the repository KEPT)"
E2_RC="$(run_rollback "${ECR_STACK}" "${LOG_DIR}/e2.log")"
if [ "${E2_RC}" -ne 2 ]; then
  echo "[verify] FAIL: phase E2: the rollback exited ${E2_RC} (expected 2: the repository is kept unproven -- output above)" >&2
  exit 1
fi
if ! grep -q "Skipping failed CREATE of OrphanRepo.*the journal recorded no identity for it" "${LOG_DIR}/e2.log"; then
  echo "[verify] FAIL: phase E2: the rollback did not warn that nothing proves OrphanRepo is the repository the failed CREATE made" >&2
  exit 1
fi
if grep -qF "deleting partially-created OrphanRepo" "${LOG_DIR}/e2.log"; then
  echo "[verify] FAIL: phase E2: the rollback deleted a repository it had no identity for (go-to-k/cdkd#4658)" >&2
  exit 1
fi
if ! aws ecr describe-repositories --repository-names "${REPO_NAME}" --region "${REGION}" >/dev/null; then
  echo "[verify] FAIL: phase E2: ${REPO_NAME} is gone after the rollback that warned it was kept" >&2
  exit 1
fi
assert_gone "phase E2: the rollback journal is still present" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ECR_JOURNAL_KEY}"
assert_gone "phase E2: state.json is still present after the initial-deploy rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${ECR_STATE_KEY}"
aws ecr delete-repository --repository-name "${REPO_NAME}" --force --region "${REGION}" >/dev/null
# shellcheck disable=SC2046
wait_gone "phase E2: ${REPO_NAME} still exists after the fixture deleted it" $(repo_probe)
echo "[verify] phase E2 ok: the unproven repository was kept and warned about (exit 2), journal and state gone"

# ---------------------------------------------------------------------------
# PHASE S: SNS — the provider deletes its own topic; nothing to journal or delete
# ---------------------------------------------------------------------------
echo "[verify] phase S1: deploy ${SNS_STACK} --no-rollback --verbose (expect FAILURE at SetTopicAttributes, topic cleaned up)"
deploy_expect_failure "${SNS_STACK}" "${LOG_DIR}/s1.log" --verbose
# Proof that CreateTopic AND the failing wiring call ran, and that the
# provider's own delete succeeded: only its cleanup arm prints this line.
if ! grep -qF "Cleaned up partially-created SNS topic Topic" "${LOG_DIR}/s1.log"; then
  echo "[verify] FAIL: phase S1: no 'Cleaned up partially-created SNS topic Topic' line — the create, its wiring step or the cleanup did not run as designed" >&2
  exit 1
fi
if grep -qF "Failed to clean up partially-created SNS topic" "${LOG_DIR}/s1.log"; then
  echo "[verify] FAIL: phase S1: the provider's cleanup failed — this arm needs a cleanup that succeeds" >&2
  exit 1
fi
if grep -qF "already existed before this create" "${LOG_DIR}/s1.log"; then
  echo "[verify] FAIL: phase S1: the topic name was read as held before the create (the pre-run sweep missed it)" >&2
  exit 1
fi
# shellcheck disable=SC2046
wait_gone "phase S1: ${TOPIC_ARN} still exists after the provider's cleanup" $(topic_probe)
SNS_OP="$(journal_failed_op "${SNS_JOURNAL_KEY}" Topic)"
if [ -z "${SNS_OP}" ]; then
  echo "[verify] FAIL: phase S1: the journal records no failed op for Topic" >&2
  exit 1
fi
SNS_OP_FIELDS="$(printf '%s' "${SNS_OP}" \
  | jq -r '[.changeType // "<absent>", .physicalId // "<absent>", (if has("physicalIdRecoveredFromError") then (.physicalIdRecoveredFromError | tostring) else "<absent>" end)] | join(" ")')"
# A topic the provider deleted must not be journaled as one the rollback should
# delete: an id here would aim --revert-failed at a name someone may reuse.
if [ "${SNS_OP_FIELDS}" != "CREATE <absent> <absent>" ]; then
  echo "[verify] FAIL: phase S1: failed Topic op journaled changeType/physicalId/physicalIdRecoveredFromError = '${SNS_OP_FIELDS}' (expected 'CREATE <absent> <absent>')" >&2
  echo "${SNS_OP}" | jq . | sed 's/^/  /' >&2
  exit 1
fi
echo "[verify] phase S1 ok: topic created, wiring rejected, the provider deleted it, the journal names no id"

echo "[verify] phase S2: cdkd rollback ${SNS_STACK} --force --revert-failed (expect exit 2, nothing deleted)"
S2_RC="$(run_rollback "${SNS_STACK}" "${LOG_DIR}/s2.log")"
# Exit 2: the failed CREATE recorded no physical id, so the rollback can only
# skip it with a warning, and a skipped op makes the rollback partial.
if [ "${S2_RC}" -ne 2 ]; then
  echo "[verify] FAIL: phase S2: the rollback exited ${S2_RC} (expected 2: the id-less failed CREATE is skipped)" >&2
  exit 1
fi
# The positive needle doubles as the sentinel for the negative one below: it
# proves this log is the rollback's and that it reached the failed Topic op.
if ! grep -qF "failed CREATE of Topic (AWS::SNS::Topic) recorded no physical id" "${LOG_DIR}/s2.log"; then
  echo "[verify] FAIL: phase S2: no 'failed CREATE of Topic (AWS::SNS::Topic) recorded no physical id' warning (the op was not reached, or the wording drifted)" >&2
  exit 1
fi
if grep -qF "deleting partially-created Topic" "${LOG_DIR}/s2.log"; then
  echo "[verify] FAIL: phase S2: the rollback tried to delete the Topic the provider had already deleted" >&2
  exit 1
fi
# shellcheck disable=SC2046
wait_gone "phase S2: ${TOPIC_ARN} exists after the rollback" $(topic_probe)
assert_gone "phase S2: the rollback journal is still present" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${SNS_JOURNAL_KEY}"
assert_gone "phase S2: state.json is still present after the initial-deploy rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${SNS_STATE_KEY}"
echo "[verify] phase S2 ok: nothing deleted, the skip reported, journal and state gone"

# ---------------------------------------------------------------------------
# PHASE N: a nested child whose only skip is a journaled orphan (go-to-k/cdkd#4738)
# ---------------------------------------------------------------------------
echo "[verify] phase N1: deploy ${NESTED_STACK} (clean, so Child exists)"
N1_RC=0
node "${LOCAL_DIST}" deploy "${NESTED_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes > "${LOG_DIR}/n1.log.raw" 2>&1 || N1_RC=$?
strip_ansi "${LOG_DIR}/n1.log.raw" "${LOG_DIR}/n1.log"
if [ "${N1_RC}" -ne 0 ]; then
  sed 's/^/  /' "${LOG_DIR}/n1.log" >&2 || true
  echo "[verify] FAIL: phase N1: the clean nested deploy exited ${N1_RC}" >&2
  exit 1
fi
if [ "$(state_has_resource "${NESTED_STATE_KEY}" Child)" != "true" ]; then
  echo "[verify] FAIL: phase N1: the parent's state does not record Child" >&2
  exit 1
fi
if [ "$(state_has_resource "${CHILD_STATE_KEY}" ChildAnchor)" != "true" ]; then
  echo "[verify] FAIL: phase N1: the child's state does not record ChildAnchor" >&2
  exit 1
fi
echo "[verify] phase N1 ok: parent records Child, the child has its own state"

echo "[verify] phase N2: deploy ${NESTED_STACK} NESTED_ORPHAN=1 --no-rollback (expect FAILURE in the child at PutLifecyclePolicy)"
export NESTED_ORPHAN=1
deploy_expect_failure "${NESTED_STACK}" "${LOG_DIR}/n2.log"
unset NESTED_ORPHAN
if ! grep -qF "Failed to create ECR Repository OrphanRepo" "${LOG_DIR}/n2.log"; then
  echo "[verify] FAIL: phase N2: the deploy did not fail in the child's OrphanRepo create (or the wording drifted)" >&2
  exit 1
fi
if ! aws ecr describe-repositories --repository-names "${NESTED_REPO_NAME}" --region "${REGION}" >/dev/null; then
  echo "[verify] FAIL: phase N2: ${NESTED_REPO_NAME} does not exist after the failed deploy, so this phase tests nothing" >&2
  exit 1
fi
if ! CHILD_OP="$(journal_failed_op "${CHILD_JOURNAL_KEY}" OrphanRepo)"; then
  echo "[verify] FAIL: phase N2: the child's rollback journal could not be read (s3://${STATE_BUCKET}/${CHILD_JOURNAL_KEY})" >&2
  exit 1
fi
CHILD_OP_FIELDS="$(printf '%s' "${CHILD_OP}" \
  | jq -r '[.changeType // "<absent>", .physicalId // "<absent>", (.physicalIdRecoveredFromError | tostring)] | join(" ")')"
if [ "${CHILD_OP_FIELDS}" != "CREATE ${NESTED_REPO_NAME} true" ]; then
  echo "[verify] FAIL: phase N2: the child's journal op for OrphanRepo is '${CHILD_OP_FIELDS}' (expected 'CREATE ${NESTED_REPO_NAME} true')" >&2
  exit 1
fi
echo "[verify] phase N2 ok: the child's journal names the repository its failed CREATE made"

echo "[verify] phase N3: cdkd destroy ${NESTED_STACK} --force (expect exit 2, the repository KEPT, BOTH states deleted in one run)"
N3_RC=0
node "${LOCAL_DIST}" destroy "${NESTED_STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force > "${LOG_DIR}/n3.log.raw" 2>&1 || N3_RC=$?
strip_ansi "${LOG_DIR}/n3.log.raw" "${LOG_DIR}/n3.log"
sed 's/^/  /' "${LOG_DIR}/n3.log" || true
if [ "${N3_RC}" -ne 2 ]; then
  echo "[verify] FAIL: phase N3: the destroy exited ${N3_RC} (expected 2: the kept repository is a skip)" >&2
  exit 1
fi
# PREMISE: the child kept the repository as an unproven journaled orphan.
if ! grep -q "Skipping failed CREATE of OrphanRepo.*the journal recorded no identity for it" "${LOG_DIR}/n3.log"; then
  echo "[verify] FAIL: phase N3: the child destroy did not keep OrphanRepo as an unproven journaled orphan" >&2
  exit 1
fi
assert_gone "phase N3: the child's state.json is still present" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
# The fix: before go-to-k/cdkd#4738 the parent kept its Child row and state.
assert_gone "phase N3: the parent's state.json is still present -- the parent kept its Child row (go-to-k/cdkd#4738)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NESTED_STATE_KEY}"
# Each state delete sweeps that stack's rollback journal with it.
assert_gone "phase N3: the child's rollback journal is still present" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_JOURNAL_KEY}"
assert_gone "phase N3: the parent's rollback journal is still present" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${NESTED_JOURNAL_KEY}"
if ! grep -qF "Child (AWS::CloudFormation::Stack) deleted (nested stack ${NESTED_CHILD} left 1 resource(s) a failed deploy created in AWS)" "${LOG_DIR}/n3.log"; then
  echo "[verify] FAIL: phase N3: the parent's Child line does not say the child left 1 resource in AWS" >&2
  exit 1
fi
if ! grep -qF "Destroy finished, but 1 resource(s) a failed deploy created were left in AWS" "${LOG_DIR}/n3.log"; then
  echo "[verify] FAIL: phase N3: the final message does not name the resource left in AWS" >&2
  exit 1
fi
if grep -qF "State preserved" "${LOG_DIR}/n3.log"; then
  echo "[verify] FAIL: phase N3: the destroy claims state was preserved, but none was" >&2
  exit 1
fi
if ! aws ecr describe-repositories --repository-names "${NESTED_REPO_NAME}" --region "${REGION}" >/dev/null; then
  echo "[verify] FAIL: phase N3: ${NESTED_REPO_NAME} is gone after the destroy that warned it was kept" >&2
  exit 1
fi
aws ecr delete-repository --repository-name "${NESTED_REPO_NAME}" --force --region "${REGION}" >/dev/null
# shellcheck disable=SC2046
wait_gone "phase N3: ${NESTED_REPO_NAME} still exists after the fixture deleted it" $(nested_repo_probe)
echo "[verify] phase N3 ok: one destroy deleted both states, kept the unproven repository (exit 2)"

# ---------------------------------------------------------------------------
# FINAL: nothing left
# ---------------------------------------------------------------------------
# shellcheck disable=SC2046
assert_gone "${REPO_NAME} still exists at the end of the run" $(repo_probe)
# shellcheck disable=SC2046
assert_gone "${TOPIC_ARN} still exists at the end of the run" $(topic_probe)
# shellcheck disable=SC2046
assert_gone "${NESTED_REPO_NAME} still exists at the end of the run" $(nested_repo_probe)
for s in "${ECR_STACK}" "${SNS_STACK}" "${NESTED_STACK}" "${NESTED_CHILD}"; do
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${s}/" --recursive >/dev/null 2>&1 || true
done

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — a created-before-failure resource is journaled and reverted; a self-cleaned one is left alone; a nested child's kept orphan does not keep its parent's state"
