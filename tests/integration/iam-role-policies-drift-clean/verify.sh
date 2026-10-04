#!/usr/bin/env bash
# verify.sh — cdkd IAM Role sibling-policy phantom-drift integ.
#
# Regression coverage for the phantom drift where `cdkd drift` reports a false
# positive on an AWS::IAM::Role right after deploy:
#   ~ FnServiceRole (AWS::IAM::Role)
#     - Policies: [{"PolicyName":"FnServiceRoleDefaultPolicy...",...}]
#     + Policies: []
# CDK emits a construct's grants as a SEPARATE AWS::IAM::Policy (the
# `Default Policy*`) attached to the role; AWS implements that via
# `iam:PutRolePolicy`, so the inline policy shows up in `ListRolePolicies`.
# The deploy-time observedProperties capture for the role passed NO sibling
# context, so its `ListRolePolicies` read RACED the sibling's `PutRolePolicy`
# and sometimes captured the Default Policy into observedProperties.Policies.
# `cdkd drift`'s AWS-current side filters sibling-managed inline policies, so
# the baseline-vs-current mismatch surfaced as phantom drift. The fix builds a
# template-derived sibling context at capture time (deploy-order-independent)
# so the same filter runs on both sides.
#
# Phases:
#   1. Deploy a Lambda whose grant emits a service-role Default Policy + a
#      standalone role with a declared inline policy AND an addToPolicy()
#      Default Policy sibling.
#   2. Run `cdkd drift` (twice) and assert NO drift on any AWS::IAM::Role.
#   2b. Rename an inline policy in place (go-to-k/cdkd#4152).
#   2c-rollback. The 2c hand-off with a failing queue after it: the rollback
#       must leave every name with its FIRST owner (go-to-k/cdkd#4225), the
#       name a rolled-back create took over included (go-to-k/cdkd#4408).
#   2c. Hand inline policy names between resources on the role in ONE deploy
#       (go-to-k/cdkd#4156): a swap of two policies' names, a delete beside a
#       create of the same name, and a rename away from a name the role's own
#       Policies takes. The receiving resource must keep each name.
#   3. Destroy + assert the function / queue / role are gone and the cdkd
#      state file is removed.
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

STACK="CdkdIamRolePoliciesDriftCleanExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-iam-drift-clean-test-fn"
QUEUE_NAME="cdkd-iam-drift-clean-test-queue"
ROLE_NAME="cdkd-iam-drift-clean-test-role"
# Phase 2c-rollback's failing queue: AWS rejects it, so it never exists.
FAILING_QUEUE_NAME="cdkd-iam-drift-clean-test-failing-queue"
# Only Phase 2c-rollback's own deploy may inject the failing queue: an
# inherited value would fail every later deploy too.
unset CDKD_TEST_HANDOFF_FAIL

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF -u CDKD_TEST_HANDOFF_FAIL node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  QUEUE_URL="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${QUEUE_URL}" ] && [ "${QUEUE_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${QUEUE_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # Phase 2c-rollback's queue is rejected by AWS; swept in case it ever is not.
  FAILING_URL="$(aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}" \
    --query 'QueueUrl' --output text 2>/dev/null)"
  if [ -n "${FAILING_URL}" ] && [ "${FAILING_URL}" != "None" ]; then
    aws sqs delete-queue --queue-url "${FAILING_URL}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  rm -f "${ROLLBACK_LOG:-}"
  # The standalone role keeps its inline + sibling-managed policies; delete
  # them before the role or DeleteRole 409s.
  for pn in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --region "${REGION}" \
      --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${pn}" \
      --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws iam delete-role --role-name "${ROLE_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The function's auto-created log group survives a function delete.
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
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

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy Lambda-with-grant + standalone role"
env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
echo "    deploy complete"

# --- Phase 2: no phantom drift on any IAM Role -------------------------
# The capture baseline must exclude the sibling-managed Default Policy, so the
# role compares clean against the (also-filtered) AWS-current snapshot. Run
# twice — the first immediately after deploy (tightest race window), the
# second after a short settle — both must be clean.
assert_no_role_drift() { # usage: assert_no_role_drift <label> [rename:true|false|handoff]
  local label="$1" rename="${2:-false}"
  local out
  # The template the drift synth reads must be the one deployed: RENAME only
  # after Phase 2b, HANDOFF only after Phase 2c.
  if [ "${rename}" = "handoff" ]; then
    out="$(CDKD_TEST_RENAME=true CDKD_TEST_HANDOFF=true node "${LOCAL_DIST}" drift "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
  elif [ "${rename}" = "true" ]; then
    out="$(env -u CDKD_TEST_HANDOFF CDKD_TEST_RENAME=true node "${LOCAL_DIST}" drift "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
  else
    out="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
      --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)"
  fi
  if printf '%s' "${out}" | grep -q 'AWS::IAM::Role'; then
    echo "FAIL: cdkd drift reported phantom drift on an AWS::IAM::Role (${label}):" >&2
    printf '%s\n' "${out}" | grep -B1 -A6 'AWS::IAM::Role' >&2
    exit 1
  fi
  echo "    ${label}: no IAM Role drift"
}

echo "==> Phase 2: assert no phantom drift on any AWS::IAM::Role"
assert_no_role_drift "immediately after deploy"
assert_no_role_drift "second pass"

# --- Phase 2b: rename an inline policy in place (go-to-k/cdkd#4152) ------
# The role stays listed across the rename. Before the fix the update put the
# NEW name and removed the old one only from principals that LEFT the list, so
# the role kept `...-renamed-old` too: a stale grant no record names.
OLD_POLICY="cdkd-iam-drift-clean-renamed-old"
NEW_POLICY="cdkd-iam-drift-clean-renamed-new"
role_policies() { # -> the role's inline policy names, sorted, one line
  aws iam list-role-policies --role-name "${ROLE_NAME}" --region "${REGION}" \
    --query 'PolicyNames' --output text | tr '\t' '\n' | awk 'NF' | sort | tr '\n' ' '
}
has_policy() { # usage: has_policy <name> -> 0 when the role holds it
  case " $(role_policies) " in *" $1 "*) return 0 ;; *) return 1 ;; esac
}
echo "==> Phase 2b: rename RenamedPolicy in place; the role must hold only the new name"
# Polled like the post-rename check: IAM reads are eventually consistent.
premise_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if has_policy "${OLD_POLICY}"; then
    premise_ok=1
    break
  fi
  sleep 5
done
if [ "${premise_ok}" -ne 1 ]; then
  echo "FAIL: premise: the role does not hold ${OLD_POLICY} after the first deploy (got: $(role_policies))" >&2
  exit 1
fi
env -u CDKD_TEST_HANDOFF CDKD_TEST_RENAME=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
# Polled: IAM reads are eventually consistent right after a write.
renamed_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if has_policy "${NEW_POLICY}" && ! has_policy "${OLD_POLICY}"; then
    renamed_ok=1
    break
  fi
  sleep 5
done
if [ "${renamed_ok}" -ne 1 ]; then
  echo "FAIL: after the rename the role holds '$(role_policies)'; want ${NEW_POLICY} and NOT ${OLD_POLICY} (the old-named policy is a stale grant)" >&2
  exit 1
fi
echo "    the role holds ${NEW_POLICY} and no longer ${OLD_POLICY}"
# The declared inline policy and the Default Policy sibling are untouched.
if ! has_policy "DeclaredInline"; then
  echo "FAIL: the rename removed the role's declared DeclaredInline policy (got: $(role_policies))" >&2
  exit 1
fi
echo "    DeclaredInline kept"
# The renamed policy is still a sibling the role's drift read filters out.
assert_no_role_drift "after rename" true

# --- Phase 2c: hand inline policy names over in one deploy (go-to-k/cdkd#4156)
# Each name must end up held, with the RECEIVING resource's document (its own
# action), so the check reads both the name and whose grant it carries.
policy_action() { # usage: policy_action <policy-name> -> its first statement's action, or empty when absent
  # Only NoSuchEntity reads as absent; any other probe failure is FAIL. Inside
  # a $( ) the exit ends only the substitution, so the caller then reads an
  # empty action, which never satisfies a wanted one: the phase still fails.
  local out
  if out="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "$1" \
    --region "${REGION}" --query 'PolicyDocument.Statement[0].Action' --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if printf '%s' "${out}" | grep -q 'NoSuchEntity'; then
    return 0
  fi
  echo "FAIL: get-role-policy $1 undetermined: ${out}" >&2
  exit 1
}
# name -> the action of the resource that must hold it after the hand-off.
HANDOFF_WANT=(
  "cdkd-iam-drift-clean-swap-x=sqs:ListDeadLetterSourceQueues"
  "cdkd-iam-drift-clean-swap-y=sqs:ListQueueTags"
  "cdkd-iam-drift-clean-handoff=sqs:DeleteMessage"
  "cdkd-iam-drift-clean-to-role=sqs:ReceiveMessage"
  "cdkd-iam-drift-clean-to-role-moved=sqs:PurgeQueue"
)
handoff_mismatch() { # -> prints every name whose holder is wrong; empty when all match
  local pair name want got
  for pair in "${HANDOFF_WANT[@]}"; do
    name="${pair%%=*}"
    want="${pair#*=}"
    got="$(policy_action "${name}")"
    [ "${got}" = "${want}" ] || printf '%s (want %s, got %s) ' "${name}" "${want}" "${got:-<missing>}"
  done
}
first_owner_mismatch() { # -> prints every name not held by its FIRST owner; empty when all match
  local pair name want got
  for pair in \
    "cdkd-iam-drift-clean-swap-x=sqs:ListQueueTags" \
    "cdkd-iam-drift-clean-swap-y=sqs:ListDeadLetterSourceQueues" \
    "cdkd-iam-drift-clean-handoff=sqs:ChangeMessageVisibility" \
    "cdkd-iam-drift-clean-to-role=sqs:PurgeQueue"; do
    name="${pair%%=*}"
    want="${pair#*=}"
    got="$(policy_action "${name}")"
    [ "${got}" = "${want}" ] || printf '%s (want %s, got %s) ' "${name}" "${want}" "${got:-<missing>}"
  done
}

# --- Phase 2c-rollback: the same hand-off, rolled back (go-to-k/cdkd#4225) ---
# A failing queue depends on every hand-off resource, so the swap, the role's
# update and the to-role rename all complete before the deploy fails. The
# rollback then reverses them newest-first: SwapB before SwapA, ToRolePolicy
# before the role. Before the fix SwapA's reversal removed `swap-y`, which
# SwapB's had just put back, and the role's revert removed `to-role`, which
# ToRolePolicy's had just put back. The deploy fails before HandoffOld's
# delete, so the rollback deletes HandoffNew, which removes the name HandoffOld
# still records; before go-to-k/cdkd#4408 the role was left without it.
echo "==> Phase 2c-rollback: a failed hand-off deploy must roll every name back to its first owner"
ROLLBACK_LOG="$(mktemp)"
set +e
CDKD_TEST_RENAME=true CDKD_TEST_HANDOFF=true CDKD_TEST_HANDOFF_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${ROLLBACK_LOG}" 2>&1
fail_rc=$?
set -e
sed 's/^/    | /' "${ROLLBACK_LOG}"
if [ "${fail_rc}" -eq 0 ]; then
  echo "FAIL: the hand-off deploy with the failing queue SUCCEEDED; it must fail and roll back" >&2
  exit 1
fi
# Non-vacuous only if the hand-off really ran and was reversed: a deploy that
# failed before touching the role leaves every name with its first owner too.
# `Rolling back` is the independent marker: present while a per-resource line
# is missing means the wording drifted, not that the hand-off was skipped.
if ! grep -q 'Rolling back [0-9]* completed operation' "${ROLLBACK_LOG}"; then
  echo "FAIL: the failed deploy did not roll back (no 'Rolling back N completed operation(s)' line)" >&2
  exit 1
fi
for lid in SwapA SwapB ToRolePolicy; do
  if ! grep -qE "Rollback: ${lid} (replacement reversed|restored successfully)" "${ROLLBACK_LOG}"; then
    echo "FAIL: the rollback ran but logged no reversal of ${lid}; the hand-off did not complete before the failure, or the rollback wording drifted" >&2
    exit 1
  fi
done
if ! grep -qE 'Rollback: WorkerRole[0-9A-Fa-f]* restored successfully' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback ran but logged no revert of the role's own Policies (WorkerRole...)" >&2
  exit 1
fi
if ! grep -q 'Rollback: HandoffNew deleted successfully' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback ran but logged no delete of HandoffNew; its create did not complete before the failure, or the rollback wording drifted" >&2
  exit 1
fi
if ! grep -q 'Rollback: put back the inline policy HandoffOld records on its role' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback deleted HandoffNew but did not put back HandoffOld's inline policy (go-to-k/cdkd#4408)" >&2
  exit 1
fi
rm -f "${ROLLBACK_LOG}"
assert_gone "failing queue ${FAILING_QUEUE_NAME} exists; AWS should have rejected it" \
  aws sqs get-queue-url --queue-name "${FAILING_QUEUE_NAME}" --region "${REGION}"
rolled_back_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if [ -z "$(first_owner_mismatch)" ]; then
    rolled_back_ok=1
    break
  fi
  sleep 5
done
if [ "${rolled_back_ok}" -ne 1 ]; then
  echo "FAIL: after the rollback the role lost or mis-holds: $(first_owner_mismatch)(role holds: $(role_policies)) — a rollback revert removed a name another revert had put back" >&2
  exit 1
fi
# The renamed-to name must be gone: a strict gone-probe, since an empty
# `policy_action` read can also mean a failed probe.
assert_gone "cdkd-iam-drift-clean-to-role-moved is still on ${ROLE_NAME} after the rollback" \
  aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name cdkd-iam-drift-clean-to-role-moved --region "${REGION}"
echo "    every name is back with its first owner"
assert_no_role_drift "after the rolled-back hand-off" true

echo "==> Phase 2c: hand inline policy names over between resources on the role in one deploy"
# Premise: before the hand-off each name is held by its FIRST owner, so the
# phase moves real grants (a swap of two absent names would pass vacuously).
premise_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if [ "$(policy_action cdkd-iam-drift-clean-swap-x)" = "sqs:ListQueueTags" ] &&
    [ "$(policy_action cdkd-iam-drift-clean-swap-y)" = "sqs:ListDeadLetterSourceQueues" ] &&
    [ "$(policy_action cdkd-iam-drift-clean-handoff)" = "sqs:ChangeMessageVisibility" ] &&
    [ "$(policy_action cdkd-iam-drift-clean-to-role)" = "sqs:PurgeQueue" ]; then
    premise_ok=1
    break
  fi
  sleep 5
done
if [ "${premise_ok}" -ne 1 ]; then
  echo "FAIL: premise: the role's hand-off policies are not held by their first owners (got: $(role_policies))" >&2
  exit 1
fi
CDKD_TEST_RENAME=true CDKD_TEST_HANDOFF=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
handoff_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if [ -z "$(handoff_mismatch)" ]; then
    handoff_ok=1
    break
  fi
  sleep 5
done
if [ "${handoff_ok}" -ne 1 ]; then
  echo "FAIL: after the hand-off the role lost or mis-holds: $(handoff_mismatch)(role holds: $(role_policies)) — a same-deploy hand-off removed the receiving resource's grant" >&2
  exit 1
fi
echo "    every handed-off name is held by its new owner"
if ! has_policy "DeclaredInline" || ! has_policy "${NEW_POLICY}"; then
  echo "FAIL: the hand-off removed an unrelated policy (got: $(role_policies))" >&2
  exit 1
fi
assert_no_role_drift "after hand-off" handoff

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_RENAME=true CDKD_TEST_HANDOFF=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    function deleted"

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
echo "    standalone role deleted"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    queue deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — IAM Role with a sibling Default Policy shows no phantom drift after deploy; all phases passed, an in-place rename left no old-named policy on the retained role, and a same-deploy hand-off kept every name with its new owner"
