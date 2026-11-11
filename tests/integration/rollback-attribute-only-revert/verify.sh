#!/usr/bin/env bash
# verify.sh — go-to-k/cdkd#6101 against real AWS: a deploy whose only change
# to a resource is its DeletionPolicy / UpdateReplacePolicy, and which then
# fails on another resource, must roll those policies back in state, as
# CloudFormation's rollback restores the previous template. Before the fix the
# rollback kept the failed deploy's policies and still reported the pre-deploy
# state restored, so a later destroy deleted a resource the last successful
# template retained.
#
# Phases:
#   1. Deploy generation 1: `Kept` is Retain, `Dropped` is Delete.
#   2. Deploy generation 2 (CDKD_TEST_UPDATE=true): the policies swap and a
#      queue whose create AWS rejects is added. The deploy fails, the automatic
#      rollback runs, and state.json holds the generation-1 policies again.
#   3. The same deploy with --no-rollback leaves the generation-2 policies in
#      state; `cdkd rollback --force` replays the journal and restores them.
#   4. Destroy (generation 1): `Kept` survives (Retain), `Dropped` is gone,
#      state is gone; then `Kept` is deleted by hand.
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

STACK="CdkdRollbackAttributeOnlyRevertExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
KEPT_NAME="/${STACK}/kept"
DROPPED_NAME="/${STACK}/dropped"
QUEUE_NAME="${STACK}-failing"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The recorded `<policy>` of the state record whose physical id is $2.
recorded_policy() { # usage: recorded_policy <deletionPolicy|updateReplacePolicy> <physical-id>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")" || return 1
  jq -r --arg id "$2" --arg key "$1" \
    '[.resources[] | select(.physicalId == $id)] | if length == 1 then (.[0][$key] // "(unset)") else "NO-UNIQUE-RECORD" end' \
    <<<"${state}"
}

# FAILs unless state records the given DeletionPolicy for both parameters and
# the given UpdateReplacePolicy for `Kept`.
assert_policies() { # usage: assert_policies <phase> <kept> <kept-urp> <dropped>
  local kept kept_urp dropped
  kept="$(recorded_policy deletionPolicy "${KEPT_NAME}")" \
    || { echo "FAIL [$1]: could not read ${STATE_KEY}" >&2; exit 1; }
  kept_urp="$(recorded_policy updateReplacePolicy "${KEPT_NAME}")" \
    || { echo "FAIL [$1]: could not read ${STATE_KEY}" >&2; exit 1; }
  dropped="$(recorded_policy deletionPolicy "${DROPPED_NAME}")" \
    || { echo "FAIL [$1]: could not read ${STATE_KEY}" >&2; exit 1; }
  if [ "${kept}" != "$2" ] || [ "${kept_urp}" != "$3" ] || [ "${dropped}" != "$4" ]; then
    echo "FAIL [$1]: state records Kept DeletionPolicy=${kept} UpdateReplacePolicy=${kept_urp}, Dropped DeletionPolicy=${dropped}; expected $2 / $3 / $4" >&2
    exit 1
  fi
  echo "    [$1] state: Kept ${kept} / ${kept_urp}, Dropped ${dropped}"
}

# FAILs unless the failing queue is absent from state and from AWS.
assert_no_queue() { # usage: assert_no_queue <phase>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
  if [ "$(jq '[.resources[] | select(.resourceType == "AWS::SQS::Queue")] | length' <<<"${state}")" != "0" ]; then
    echo "FAIL [$1]: a queue record is in state after the failed deploy" >&2
    exit 1
  fi
  assert_gone "[$1] queue ${QUEUE_NAME} exists after the failed deploy" \
    aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
}

# Deploys generation 2 and FAILs unless it exits non-zero after running the
# metadata-only arm on both parameters. Prints the output.
deploy_failing() { # usage: deploy_failing <phase> [extra deploy flags...]
  local phase="$1"
  shift
  local out rc
  set +e
  out="$(CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@" 2>&1)"
  rc=$?
  set -e
  printf "%s\n" "${out}"
  out="$(printf "%s" "${out}" | sed "s/\x1b\[[0-9;]*m//g")"
  if [ "${rc}" -eq 0 ]; then
    echo "FAIL [${phase}]: the generation-2 deploy exited 0; the queue create must fail" >&2
    exit 1
  fi
  # Sentinel: the policies changed through the metadata-only arm, or the
  # policy assertions below would not test #6101's path.
  if ! grep -q 'Kept.* attribute update: DeletionPolicy: Retain → Delete' <<<"${out}" ||
     ! grep -q 'Dropped.* attribute update: DeletionPolicy: Delete → Retain' <<<"${out}"; then
    echo "FAIL [${phase}]: the deploy did not apply both policy flips as metadata-only updates" >&2
    exit 1
  fi
  # cdkd's own failure line, copied from a live run ("Failed to create
  # FailingQueue: Failed to create SQS queue FailingQueue: InvalidAttributeValue").
  if ! grep -q 'Failed to create FailingQueue' <<<"${out}"; then
    echo "FAIL [${phase}]: the deploy output does not name the failing queue" >&2
    exit 1
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameter --name "${KEPT_NAME}" --region "${REGION}" >/dev/null 2>&1
  aws ssm delete-parameter --name "${DROPPED_NAME}" --region "${REGION}" >/dev/null 2>&1
  queue_url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)"
  [ -n "${queue_url}" ] && aws sqs delete-queue --queue-url "${queue_url}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${JOURNAL_KEY}" >/dev/null 2>&1 || true
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

# --- Phase 1: generation 1 ---------------------------------------------------
echo "==> Phase 1: deploy generation 1 (Kept Retain, Dropped Delete)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_policies "phase 1" Retain Retain Delete
aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}" >/dev/null
aws ssm get-parameter --name "${DROPPED_NAME}" --region "${REGION}" >/dev/null

# --- Phase 2: failed deploy, automatic rollback ------------------------------
echo "==> Phase 2: generation 2 fails; the automatic rollback restores the policies"
deploy_failing "phase 2"
assert_policies "phase 2" Retain Retain Delete
assert_no_queue "phase 2"

# --- Phase 3: --no-rollback, then cdkd rollback ------------------------------
echo "==> Phase 3: generation 2 with --no-rollback, then cdkd rollback"
deploy_failing "phase 3" --no-rollback
# Sentinel: without a rollback the failed deploy's policies are in state, so
# the restore below is the replay's work.
assert_policies "phase 3, before cdkd rollback" Delete Delete Retain
set +e
ROLLBACK_OUT="$(node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force 2>&1)"
ROLLBACK_RC=$?
set -e
printf '%s\n' "${ROLLBACK_OUT}"
if [ "${ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL [phase 3]: cdkd rollback exited ${ROLLBACK_RC}" >&2
  exit 1
fi
# The plan row this fix adds (src/cli/commands/rollback/render.ts).
if ! grep -qF "[DeletionPolicy / UpdateReplacePolicy only, in state; no AWS call]" <<<"${ROLLBACK_OUT}"; then
  echo "FAIL [phase 3]: the cdkd rollback plan does not list the policy-only restore" >&2
  exit 1
fi
assert_policies "phase 3, after cdkd rollback" Retain Retain Delete
assert_no_queue "phase 3"
assert_gone "[phase 3] the rollback journal is still present after cdkd rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"

# --- Phase 4: destroy ---------------------------------------------------------
echo "==> Phase 4: destroy; the Retain parameter survives"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
KEPT_VALUE="$(aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}" \
  --query Parameter.Value --output text)" \
  || { echo "FAIL [phase 4]: ${KEPT_NAME} could not be read after destroy (deleted despite Retain?)" >&2; exit 1; }
[ "${KEPT_VALUE}" = "kept" ] \
  || { echo "FAIL [phase 4]: ${KEPT_NAME} holds '${KEPT_VALUE}' after destroy, expected kept" >&2; exit 1; }
assert_gone "[phase 4] ${DROPPED_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${DROPPED_NAME}" --region "${REGION}"
assert_gone "[phase 4] state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws ssm delete-parameter --name "${KEPT_NAME}" --region "${REGION}" >/dev/null
assert_gone "[phase 4] ${KEPT_NAME} still exists after the hand delete" \
  aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}"
trap - EXIT INT TERM
echo "    Kept retained by destroy and then deleted; Dropped and state removed"

echo "[verify] PASS — a failed deploy's DeletionPolicy / UpdateReplacePolicy-only updates are rolled back by the automatic rollback and by cdkd rollback, and destroy honours the restored policies"
