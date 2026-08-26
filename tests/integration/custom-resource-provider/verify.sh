#!/usr/bin/env bash
# verify.sh — Custom Resource provider integ.
#
# Two arms:
#
#   A. The pre-existing async CDK Provider framework resource (onEvent +
#      isComplete + Step Functions), which this fixture has always exercised as
#      a plain deploy / destroy.
#
#   B. Failure-seeking, issues #2054 / #1866. A SECOND custom resource manages
#      an SSM parameter and can be told to REFUSE its own Delete. cdkd used to
#      record such a refusal exactly like a successful delete — state record
#      dropped, row printed as `deleted`, exit 0 — over a resource the handler
#      had explicitly said it did not remove. This arm proves the three
#      OBSERVABLE consequences of the fix: the state record is KEPT, the row
#      reports `skipped`, and the run exits 2 — with the SSM parameter still
#      live in AWS to show that "not deleted" was the truth.
#
#      The same parameter's VALUE carries the `StackId` cdkd handed the
#      handler, which is the only way to observe issue #1866 from outside cdkd
#      (the synthetic StackId is handler-visible input and appears in no cdkd
#      output). Before #1866 it was
#      `arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-<id>/cdkd`
#      regardless of where the deploy ran.
#
#   C. CDK's own `autoDeleteObjects`, which is issue #1866's OWN verification
#      bar: a handler cdkd did not author, from the family known to read
#      `event.StackId`, over a bucket holding an object AWS would refuse to
#      delete. "The bucket is gone" is therefore a statement about that
#      handler, not about the bucket.
#
# PHASES. Deploy -> arm the refusal -> destroy #1 (exits 2, record kept,
# parameter alive) -> destroy #2 (the KNOWN BOUND: the issue-#804 pre-check
# drops the kept record and exits 0 while the parameter is STILL ALIVE) ->
# out-of-band removal -> deploy fresh -> destroy #3, CLEAN.
#
# WHY DESTROY #3 EXISTS. `/run-integ` flips `integ-destroy` only for a run whose
# destroy finished with 0 errors and left no orphans, and destroys #1 and #2
# BOTH violate that by design. Without a clean cdkd destroy at the end this
# fixture would either flip that marker dishonestly or never flip it at all, so
# the last phase rebuilds the stack unarmed and tears it down for real — which
# is also the only phase that exercises the autoDeleteObjects teardown. The
# trap's direct deletes stay a safety net, never the teardown.
#
# LEAK SAFETY. Arm B deliberately ends a destroy with a LIVE AWS resource, so
# the teardown is not optional: `cleanup` deletes the SSM parameter DIRECTLY
# (cdkd never will — the handler refused) and drops the preserved state record,
# and it is armed on EXIT / INT / TERM in the exiting form with the `(exit N)`
# rc seed, so a Ctrl-C or a harness timeout tears down too. The happy path runs
# the same teardown explicitly and then ASSERTS both are gone, so a silent
# teardown failure cannot pass.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

set -euo pipefail

export AWS_PAGER=""

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

# A BOUNDED wait for a resource whose delete AWS completes asynchronously
# (issue #2116). Deliberately layered over `gone_probe` rather than re-rolling
# the not-found signature: the canonical block above is checked verbatim by
# `scripts/check-integ-probe-not-found.ts`, and a second hand-copied grep is the
# drift that lint exists to stop. `gone_probe` returns 0 when the resource is
# confirmed gone, 1 while it is still there, and hard-FAILs an undetermined
# probe — so a throttle mid-wait aborts loudly instead of being read as "gone".
poll_until_gone() { # usage: poll_until_gone "<what>" <attempts> <sleep_s> aws <service> <verb> [args...]
  local what="$1" attempts="$2" nap="$3"
  shift 3
  local attempt=1
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${attempt}" -ge "${attempts}" ]; then
      break
    fi
    echo "    (${what} still present — attempt ${attempt}/${attempts})"
    attempt=$((attempt + 1))
    sleep "${nap}"
  done
  echo "FAIL: ${what} was STILL present after $((attempts * nap))s of polling" >&2
  echo "    This wait exists because AWS deletes it asynchronously; if it never" >&2
  echo "    finishes, that is a real leak rather than a slow delete." >&2
  exit 1
}

cd "$(dirname "$0")"

STACK="CustomResourceProviderStack"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Must match `lib/custom-resource-provider-stack.ts`. The construct id is the
# CFn logical id verbatim (a stack-level `cdk.CustomResource` gets no hash
# suffix — confirmed against the synthesized template), which is what makes the
# expected StackId below an exact string rather than a pattern.
CR_LOGICAL_ID="DeleteRefusalResource"
CR_TYPE="Custom::CdkdDeleteRefusal"
PARAM="/cdkd-integ/cr-delete-refusal/${STACK}"
# Set explicitly in the stack from the same two pseudo-parameters, so it is
# derivable here without reading cdkd state.
AUTODELETE_BUCKET=""
AUTODELETE_KEY="cdkd-integ-probe-object.txt"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# **A `cleanup` that ALSO runs pre-run must not destroy anything the run then
# needs.** This one is called before phase 1 as well as from the traps, so every
# line runs at least twice and the first run happens before any phase has built
# anything. It is safe by CONSTRUCTION rather than by luck: every line targets
# an AWS resource whose creation IS a phase (the deploys re-make the parameter,
# the bucket and the stack's records), so a pre-run sweep can only remove a
# previous run's leftovers. It deliberately owns NO local scratch path — the
# sibling `sns-subscription-update` fixture does, and its `mktemp -d` was
# created at variable-definition time and destroyed by exactly this pre-run
# call. If this fixture ever grows one, create it AFTER the pre-run call.
cleanup() {
  echo "==> Cleanup: dropping the refused parameter, then any leftover state"
  set +eu
  # FIRST, and directly: the whole point of arm B is that cdkd cannot remove
  # this one. Nothing else in the teardown reaches it.
  aws ssm delete-parameter --region "${REGION}" --name "${PARAM}" >/dev/null 2>&1
  # The autoDelete bucket holds an object on purpose, so a destroy that never
  # reached its handler would leave a bucket AWS refuses to delete.
  if [ -n "${AUTODELETE_BUCKET}" ]; then
    aws s3 rm "s3://${AUTODELETE_BUCKET}" --recursive --region "${REGION}" >/dev/null 2>&1
    aws s3api delete-bucket --bucket "${AUTODELETE_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" \
      --yes
    # A record whose delete keeps being refused survives `state destroy`; the
    # orphan command is the remedy cdkd's own skip warning names.
    node "${LOCAL_DIST}" state orphan "${STACK}" \
      --state-bucket "${STATE_BUCKET:-}" \
      --stack-region "${REGION}" \
      --force
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
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

ACCOUNT_ID="$(aws sts get-caller-identity --query 'Account' --output text)"
case "${ACCOUNT_ID}" in
  [0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]) ;;
  *)
    echo "FAIL: could not resolve a 12-digit account id (got '${ACCOUNT_ID}')" >&2
    exit 1
    ;;
esac
AUTODELETE_BUCKET="cdkd-integ-cr-autodelete-${ACCOUNT_ID}-${REGION}"
EXPECTED_STACK_ID="arn:aws:cloudformation:${REGION}:${ACCOUNT_ID}:stack/cdkd-${CR_LOGICAL_ID}/cdkd"
# The value EVERY handler saw before issue #1866, in every account and region.
FABRICATED_STACK_ID="arn:aws:cloudformation:us-east-1:000000000000:stack/cdkd-${CR_LOGICAL_ID}/cdkd"

# --- Phase 1: deploy --------------------------------------------------------
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
echo "    OK: state file written"

# Read the waiter state machine's ARN out of STATE rather than rebuilding it
# from `<stack>-<logicalId>`: that IS cdkd's naming rule, but the logical id
# carries a CDK-generated hash (`Providerwaiterstatemachine5D4A9DF0`) that moves
# with the aws-cdk-lib version, and phase 6 needs the value long after the state
# file is gone. Captured now, used there.
SM_ARN=$(printf '%s' "${STATE}" \
  | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::StepFunctions::StateMachine") | .value.physicalId] | first // ""')
if [ -z "${SM_ARN}" ]; then
  echo "FAIL: no AWS::StepFunctions::StateMachine in state — the CDK Provider" >&2
  echo "    framework's waiter is what phase 6 has to wait out, so losing it here" >&2
  echo "    would make that wait silently vacuous." >&2
  printf '%s' "${STATE}" | jq -r '[.resources | to_entries[] | .value.resourceType] | unique | join(", ")' >&2
  exit 1
fi
echo "    OK: waiter state machine is ${SM_ARN}"

# --- Assertion: issue #1866, the StackId the handler actually received ------
OBSERVED_STACK_ID=$(aws ssm get-parameter --region "${REGION}" --name "${PARAM}" \
  --query 'Parameter.Value' --output text)
if [ "${OBSERVED_STACK_ID}" = "${FABRICATED_STACK_ID}" ]; then
  echo "FAIL: the handler received the pre-#1866 fabricated StackId: ${OBSERVED_STACK_ID}" >&2
  echo "    => the account (000000000000) and region (us-east-1) are both invented." >&2
  exit 1
fi
if [ "${OBSERVED_STACK_ID}" != "${EXPECTED_STACK_ID}" ]; then
  echo "FAIL: the handler received StackId '${OBSERVED_STACK_ID}'" >&2
  echo "    expected '${EXPECTED_STACK_ID}' (this deploy's real partition / region / account)" >&2
  exit 1
fi
echo "    OK: handler observed the REAL StackId (${OBSERVED_STACK_ID})"

# Give CDK's autoDeleteObjects handler real work: AWS refuses to delete a
# non-empty bucket, so the teardown assertion in phase 7 is about that handler.
echo "cdkd integ probe" | aws s3 cp - "s3://${AUTODELETE_BUCKET}/${AUTODELETE_KEY}" \
  --region "${REGION}" >/dev/null
OBJ_COUNT=$(aws s3api list-objects-v2 --bucket "${AUTODELETE_BUCKET}" --region "${REGION}" \
  --query 'length(Contents || `[]`)' --output text)
if [ "${OBJ_COUNT}" != "1" ]; then
  echo "FAIL: expected 1 object in ${AUTODELETE_BUCKET}, found '${OBJ_COUNT}'" >&2
  exit 1
fi
echo "    OK: ${AUTODELETE_BUCKET} holds an object the destroy must clear"

# --- Phase 2: arm the refusal ----------------------------------------------
# A scalar property of the handler, never the presence of a resource: a
# mode-gated RESOURCE would be deleted by any later step whose mode list omits
# the token, which for this fixture is the very thing under test.
echo "==> Phase 2: redeploy with the delete-refusal injection armed"
CDKD_TEST_UPDATE=cr-delete-fails node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# --- Phase 3: destroy — the handler refuses, cdkd must NOT report deleted ---
echo "==> Phase 3: destroy (the delete handler will answer FAILED)"
set +e
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY_RC=$?
set -e
printf '%s\n' "${DESTROY_OUT}"

if [ "${DESTROY_RC}" -ne 2 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}, expected 2 (partial failure)" >&2
  echo "    => a handler that REPORTED it did not delete must not produce a green destroy." >&2
  exit 1
fi
echo "    OK: destroy exited 2"

# Two INDEPENDENT markers, so "the condition did not occur" is distinguishable
# from "the wording moved and the grep went blind". The summary sentence comes
# from `src/cli/commands/destroy.ts`, the row from the provider's skip reason
# via `src/cli/commands/destroy-runner.ts` — different producers, so one can
# fail without the other.
SUMMARY_SEEN=0
if printf '%s' "${DESTROY_OUT}" | grep -q 'Destroy skipped '; then
  SUMMARY_SEEN=1
fi
ROW_SEEN=0
if printf '%s' "${DESTROY_OUT}" | grep -q 'skipped (Delete handler reported FAILED'; then
  ROW_SEEN=1
fi

if [ "${SUMMARY_SEEN}" -eq 1 ] && [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: cdkd reported a skipped destroy but the per-resource row did not carry the" >&2
  echo "    #2054 skip reason. The reason WORDING has drifted away from this assertion —" >&2
  echo "    fix the grep in verify.sh rather than reading this as 'the refusal did not fire'." >&2
  exit 1
fi
if [ "${ROW_SEEN}" -eq 0 ]; then
  echo "FAIL: destroy output carried no '${CR_LOGICAL_ID} ... skipped (Delete handler reported FAILED' row" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_OUT}" | grep -q 'Destroy skipped 1 entr'; then
  echo "FAIL: expected EXACTLY ONE skipped entry (the refusing custom resource)" >&2
  echo "    => a second skip means another resource could not be addressed either." >&2
  exit 1
fi
if ! printf '%s' "${DESTROY_OUT}" | grep -q 'LEFT IN PLACE'; then
  echo "FAIL: the skip warning did not say the managed resource is left in place" >&2
  exit 1
fi
echo "    OK: the row, the summary and the warning all report the skip"

# --- Assertion: the state RECORD is kept ------------------------------------
STATE_AFTER=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE_AFTER}" ]; then
  echo "FAIL: state file was deleted by a destroy that skipped a resource" >&2
  echo "    => without the record the user has neither the resource deleted nor an id to retry with." >&2
  exit 1
fi

KEPT=$(printf '%s' "${STATE_AFTER}" \
  | jq -r --arg t "${CR_TYPE}" '[.resources | to_entries[] | select(.value.resourceType == $t) | .key] | join(",")')
if [ "${KEPT}" != "${CR_LOGICAL_ID}" ]; then
  echo "FAIL: state kept '${KEPT}' for ${CR_TYPE}, expected '${CR_LOGICAL_ID}'" >&2
  printf '%s' "${STATE_AFTER}" | jq '.resources | keys' >&2
  exit 1
fi
echo "    OK: the refused custom resource is still in state as ${CR_LOGICAL_ID}"

# ...and the skip did NOT abort the rest of the destroy. Without this the case
# above is also satisfied by a destroy that stopped at the first skip, which
# would leave a stack's worth of resources behind and still look correct.
LEFTOVER=$(printf '%s' "${STATE_AFTER}" \
  | jq -r --arg t "${CR_TYPE}" '[.resources | to_entries[] | select(.value.resourceType != $t) | .value.resourceType] | join(",")')
if [ -n "${LEFTOVER}" ]; then
  echo "FAIL: destroy stopped early — these non-refusing resources are still in state: ${LEFTOVER}" >&2
  exit 1
fi
echo "    OK: every other resource was still destroyed"

# --- Assertion: the managed resource really is ALIVE ------------------------
# Read BY ITS REAL AWS NAME. This is what makes the skip an honest report
# rather than a label: the handler said it did not delete, and it did not.
SURVIVOR=$(aws ssm get-parameter --region "${REGION}" --name "${PARAM}" \
  --query 'Parameter.Value' --output text)
if [ "${SURVIVOR}" != "${EXPECTED_STACK_ID}" ]; then
  echo "FAIL: the managed SSM parameter ${PARAM} reads '${SURVIVOR}' after the refused delete" >&2
  echo "    expected it untouched at '${EXPECTED_STACK_ID}'" >&2
  exit 1
fi
echo "    OK: ${PARAM} survived the destroy, exactly as the handler reported"

# --- Phase 4: the KNOWN BOUND — the next destroy drops the kept record ------
# Destroy #1 deleted the backing Lambda in the same run (the runner walks every
# reverse-DAG level regardless of skips — phase 3 asserted exactly that), so
# this run hits the issue-#804 pre-check, treats the custom resource as already
# deleted and drops the record. That is the bound issue #2054 does NOT close:
# closing it needs a durable "a prior run skipped this" signal, which lives in
# the state schema or in `DeleteContext`. What IS fixed is the silence.
echo "==> Phase 4: destroy again — the kept record is dropped (documented bound)"
set +e
DESTROY2_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY2_RC=$?
set -e
printf '%s\n' "${DESTROY2_OUT}"
DESTROY2_TXT=$(printf '%s' "${DESTROY2_OUT}" | sed $'s/\033\[[0-9;]*m//g')

if [ "${DESTROY2_RC}" -ne 0 ]; then
  echo "FAIL: the second destroy exited ${DESTROY2_RC}, expected 0." >&2
  echo "    If this now exits non-zero the BOUND has been closed — that is an" >&2
  echo "    improvement, not a regression: update this phase and the notes on" >&2
  echo "    CR_SKIP_NOT_A_RETRY_CAVEAT rather than reverting the fix." >&2
  exit 1
fi
if ! printf '%s' "${DESTROY2_TXT}" | grep -q 'DROPPING its state record'; then
  echo "FAIL: the record was dropped SILENTLY — the issue-#804 pre-check warning" >&2
  echo "    must say the resource may still be live and is now untracked." >&2
  exit 1
fi
echo "    OK: the record was dropped, and loudly"

# THE point of this phase: the resource the handler refused is STILL THERE,
# and cdkd no longer names it anywhere.
SURVIVOR2=$(aws ssm get-parameter --region "${REGION}" --name "${PARAM}" \
  --query 'Parameter.Value' --output text)
if [ "${SURVIVOR2}" != "${EXPECTED_STACK_ID}" ]; then
  echo "FAIL: ${PARAM} reads '${SURVIVOR2}' after the second destroy" >&2
  exit 1
fi
echo "    OK: ${PARAM} is still live, now untracked — the orphan this bound leaves"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the second destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Phase 5: remove the orphan out of band --------------------------------
echo "==> Phase 5: delete the refused resource by hand (cdkd never will)"
aws ssm delete-parameter --region "${REGION}" --name "${PARAM}" >/dev/null
assert_gone "SSM parameter ${PARAM} still exists after the manual delete" \
  aws ssm get-parameter --region "${REGION}" --name "${PARAM}"
echo "    OK: the managed parameter is gone"

# --- Phase 6: rebuild UNARMED ----------------------------------------------
# `cdkd destroy` returns when it has ISSUED every delete, not when AWS has
# finished them, and two resources here are torn down asynchronously while
# holding their name:
#
#   - the CDK Provider framework's waiter STATE MACHINE. Measured: after
#     `DeleteStateMachine`, `DescribeStateMachine` keeps answering
#     `status: DELETING` for ~23s on an idle machine, and `CreateStateMachine`
#     with the same name during that window fails
#     `StateMachineDeleting: State Machine is being deleted`. That is exactly
#     how this fixture failed its first real-AWS run — 26 resources created,
#     then the whole deploy rolled back.
#   - the autoDelete BUCKET, whose name is explicit and globally unique, so a
#     re-create before S3 releases it answers `OperationAborted` /
#     `BucketAlreadyOwnedByYou`.
#
# Nothing else in the stack needs it, and that is evidence rather than
# assumption: the failed run CREATED 26 resources — every IAM role, policy and
# Lambda in this template — before dying on the state machine, so their deletes
# had already released their names. The two above are the ones that had not.
#
# **The state-machine wait is GONE, and its absence is this phase's live arm
# for issue [#2116](https://github.com/go-to-k/cdkd/issues/2116).** It used to
# poll the machine to gone before redeploying, because cdkd's
# `isNameCooldownError` matched only `QueueDeletedRecently` / `wait 60 seconds`
# and the Step Functions wording was recognised by nothing — so an ordinary
# destroy-then-redeploy (a routine dev loop for any CDK app using
# `custom_resources.Provider` with an `isCompleteHandler`) failed hard where
# CloudFormation converges. #2116 taught the classifier both Step Functions
# spellings AND made a name cooldown retryable on the ORDINARY create path, so
# the redeploy below rides it out on its own.
#
# That makes this a POSITIVE discriminator rather than the usual vacuous "the
# bad thing did not happen": the redeploy has to REACH
# `Deployment completed successfully` while the name is still held, which only
# the fixed classifier produces. Pre-fix, the same run rolled 26 resources back.
#
# The BUCKET wait stays. S3's `OperationAborted` was already retryable on the
# ordinary create path before #2116 (it is in the same cooldown list now), but
# `BucketAlreadyOwnedByYou` is short-circuited to idempotent SUCCESS by the S3
# provider, so a re-create that lands on that spelling would adopt a bucket
# that is on its way out rather than retry — a different defect, not this one.
# Budget: 40 x 5s = 200s. It costs nothing when the bucket is already gone (the
# first probe returns immediately), which is what keeps the state-machine
# window — measured at ~23s — still OPEN when the redeploy starts.
echo "==> Phase 6: wait for the bucket name to be released (NOT the state machine)"
poll_until_gone "bucket ${AUTODELETE_BUCKET}" 40 5 \
  aws s3api head-bucket --bucket "${AUTODELETE_BUCKET}" --region "${REGION}"
echo "    OK: the bucket name is free again"

# The PREMISE, read immediately before the redeploy. It is NECESSARY but not
# SUFFICIENT, and that gap is why it does not decide the verdict on its own:
# `CreateStateMachine` fires ~26 resources into the deploy, so a window that is
# open HERE can still have closed by the time the create lands. The bucket poll
# above can burn up to 200s too, which closes it before the deploy even starts.
# So this reading is context for the verdict, not the verdict.
#
# `2>&1` rather than `2>/dev/null`: the probe's error text lands IN the value,
# so the CLOSED reading prints WHY (a `StateMachineDoesNotExist` reads very
# differently from an AccessDenied) instead of silently rendering every failure
# as "already gone". A blind `2>/dev/null || echo GONE` is the exact shape
# `tests/unit/scripts/integ-verify-probe-not-found.test.ts` refuses.
SM_STATUS="$(aws stepfunctions describe-state-machine --region "${REGION}" \
  --state-machine-arn "${SM_ARN}" --query 'status' --output text 2>&1 || true)"
echo "    PREMISE: DescribeStateMachine answers '${SM_STATUS}' at redeploy time"

echo "==> Phase 6: deploy again with the refusal disabled (no state-machine wait)"
# --verbose is load-bearing, not diagnostic decoration: `withRetry`'s
# per-attempt line is a debug line, and it is the only POSITIVE evidence that
# the cooldown was actually ridden out. Same idiom as
# tests/integration/rollback-sqs-cooldown/verify.sh, which greps its own retry
# lines for the SQS wording.
set +e
REDEPLOY_OUT=$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1)
REDEPLOY_RC=$?
set -e
printf '%s\n' "${REDEPLOY_OUT}"
REDEPLOY_TXT=$(printf '%s' "${REDEPLOY_OUT}" | sed $'s/\033\[[0-9;]*m//g')

# --- the FATAL fence -------------------------------------------------------
# Exit code AND the positive marker, both: a grep on output alone passes over a
# non-zero exit, and an absence assertion ("no rollback") is true of every
# unrelated failure.
#
# This pair is what a #2116 REGRESSION trips, and it cannot be silently green:
# without the retry the `CreateStateMachine` fails outright and the deploy
# rolls back, so a regression shows up here as a non-zero exit, never as a
# quiet pass. That is what lets the coverage verdict below stay non-fatal.
if [ "${REDEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: the unarmed redeploy exited ${REDEPLOY_RC}, expected 0" >&2
  echo "    If the failure names 'State Machine is being deleted', the #2116" >&2
  echo "    name-cooldown retry regressed -- that is what this phase fences." >&2
  exit 1
fi
if ! printf '%s' "${REDEPLOY_TXT}" | grep -q 'Deployment completed successfully'; then
  echo "FAIL: the unarmed redeploy never printed 'Deployment completed successfully'" >&2
  exit 1
fi

# --- the COVERAGE verdict, decided by evidence from the run itself ---------
# `rc == 0` plus the success marker is ALSO what a fully-closed window
# produces, i.e. a confluence point: it cannot tell "rode out the cooldown"
# from "never met it". The retry line can, because it quotes the AWS message
# that only a real cooldown produces. Gate the OK line on it, so a run that
# missed the window reports INCONCLUSIVE rather than claiming coverage it did
# not have.
#
# Deliberately NON-FATAL: the window is a real-AWS timing property (~23s
# measured), and failing the fixture because AWS was fast that day would make
# it flaky for a reason unrelated to the code under test. The fatal half above
# already catches the regression.
if printf '%s' "${REDEPLOY_TXT}" | grep -qiE 'State Machine is being deleted|StateMachineDeleting'; then
  echo "    OK: COVERED -- the redeploy hit the state-machine name cooldown and"
  echo "        retried through it (issue #2116), with no wait in the fixture"
else
  echo "    INCONCLUSIVE: the redeploy succeeded, but no cooldown retry line"
  echo "        appeared, so the #2116 window had already closed by the time"
  echo "        CreateStateMachine fired (DescribeStateMachine read"
  echo "        '${SM_STATUS}' beforehand). This run PROVES the redeploy works;"
  echo "        it does NOT exercise the cooldown retry. Re-run before reading"
  echo "        this phase as coverage."
fi

echo "cdkd integ probe" | aws s3 cp - "s3://${AUTODELETE_BUCKET}/${AUTODELETE_KEY}" \
  --region "${REGION}" >/dev/null
echo "    OK: rebuilt, and the autoDelete bucket holds an object again"

# --- Phase 7: the CLEAN destroy --------------------------------------------
# The one `/run-integ` may honestly read as "the destroy path works": 0 errors,
# 0 skips, 0 orphans. It is also the only phase that exercises CDK's
# autoDeleteObjects handler end to end against the issue-#1866 StackId.
echo "==> Phase 7: clean destroy (this is the run the integ-destroy gate reads)"
set +e
DESTROY3_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force 2>&1)
DESTROY3_RC=$?
set -e
printf '%s\n' "${DESTROY3_OUT}"
DESTROY3_TXT=$(printf '%s' "${DESTROY3_OUT}" | sed $'s/\033\[[0-9;]*m//g')

if [ "${DESTROY3_RC}" -ne 0 ]; then
  echo "FAIL: the unarmed destroy exited ${DESTROY3_RC}, expected 0" >&2
  exit 1
fi
if printf '%s' "${DESTROY3_TXT}" | grep -q 'Destroy skipped '; then
  echo "FAIL: the unarmed destroy still skipped something" >&2
  exit 1
fi
echo "    OK: clean destroy, no skips"

assert_gone "SSM parameter ${PARAM} still exists after the clean destroy (orphan)" \
  aws ssm get-parameter --region "${REGION}" --name "${PARAM}"
echo "    OK: the handler deleted its managed parameter"

# Issue #1866's own bar. A non-empty bucket cannot be deleted by AWS, so this
# is only true if CDK's autoDeleteObjects handler ran and emptied it — with the
# real StackId in its event.
assert_gone "bucket ${AUTODELETE_BUCKET} still exists after the clean destroy (orphan)" \
  aws s3api head-bucket --bucket "${AUTODELETE_BUCKET}" --region "${REGION}"
echo "    OK: CDK's autoDeleteObjects handler emptied and removed its bucket"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after the clean destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

echo ""
echo "=== PASS: custom-resource provider integ (async Provider + #2054 refused delete + its"
echo "          next-run bound + #1866 StackId incl. CDK autoDeleteObjects + clean destroy) ==="
