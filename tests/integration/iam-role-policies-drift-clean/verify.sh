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
#   2s. Widen a two-role inline policy's copy on its SECOND role out of band:
#       drift must report it and `--revert` restore it (go-to-k/cdkd#6616).
#   2o. SharedPolicy's recorded drift baseline is the live document and the
#       declared roles (go-to-k/cdkd#6609).
#   2r. Delete SharedPolicy's copy on its FIRST role (the one the post-write
#       capture reads) out of band: drift --json must report it, and
#       --revert must put it back without re-creating anything
#       (go-to-k/cdkd#6609).
#   2b. Rename an inline policy in place (go-to-k/cdkd#4152).
#   2c-rollback. The 2c hand-off with a failing queue after it: the rollback
#       must leave every name with its FIRST owner (go-to-k/cdkd#4225), the
#       name a rolled-back create took over included (go-to-k/cdkd#4408).
#   2d. Respell the role's own inline policy only in case and back: it must
#       survive each time, held under the new spelling with the new document,
#       and drift stays clean (go-to-k/cdkd#6874).
#   2c. Hand inline policy names between resources on the role in ONE deploy
#       (go-to-k/cdkd#4156): a swap of two policies' names, a delete beside a
#       create of the same name, and a rename away from a name the role's own
#       Policies takes. The receiving resource must keep each name. The swap
#       and a rename-plus-create also run between resources with NO dependency
#       on each other (go-to-k/cdkd#4227).
#   2p. Re-create MixedRole out of band under its name without SharedPolicy's
#       copy or SharedManaged's attachment: drift --revert must refuse to put
#       or attach either on the stranger, changing nothing (go-to-k/cdkd#6734).
#       The stranger is then deleted.
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

# revert_identity_* : prove a drift --revert kept every resource it touched (#6639).
. ../revert-identity.sh
REVERT_DIR=""

STACK="CdkdIamRolePoliciesDriftCleanExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
FN_NAME="cdkd-iam-drift-clean-test-fn"
QUEUE_NAME="cdkd-iam-drift-clean-test-queue"
ROLE_NAME="cdkd-iam-drift-clean-test-role"
# go-to-k/cdkd#4821: the role an AWS::IAM::Policy and an AWS::IAM::RolePolicy
# swap inline policy names on.
MIXED_ROLE_NAME="cdkd-iam-drift-clean-mixed-role"
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
  if [ -n "${REVERT_DIR:-}" ]; then
    rm -f "${REVERT_DIR}"/revert-* 2>/dev/null
    rmdir "${REVERT_DIR}" 2>/dev/null
  fi
  # The standalone role keeps its inline + sibling-managed policies; delete
  # them before the role or DeleteRole 409s.
  for rn in "${ROLE_NAME}" "${MIXED_ROLE_NAME}"; do
    for arn in $(aws iam list-attached-role-policies --role-name "${rn}" --region "${REGION}" \
        --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
      aws iam detach-role-policy --role-name "${rn}" --policy-arn "${arn}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
    for pn in $(aws iam list-role-policies --role-name "${rn}" --region "${REGION}" \
        --query 'PolicyNames' --output text 2>/dev/null); do
      aws iam delete-role-policy --role-name "${rn}" --policy-name "${pn}" \
        --region "${REGION}" >/dev/null 2>&1 || true
    done
    aws iam delete-role --role-name "${rn}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  # go-to-k/cdkd#6734: Phase 2p's managed policy, detached above.
  SHARED_MANAGED_ARN="arn:aws:iam::$(aws sts get-caller-identity --query Account --output text 2>/dev/null):policy/cdkd-iam-drift-clean-shared-managed"
  for v in $(aws iam list-policy-versions --policy-arn "${SHARED_MANAGED_ARN}" \
      --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "${SHARED_MANAGED_ARN}" --version-id "${v}" >/dev/null 2>&1 || true
  done
  aws iam delete-policy --policy-arn "${SHARED_MANAGED_ARN}" >/dev/null 2>&1 || true
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
REVERT_DIR="$(mktemp -d)"

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
  if grep -q 'AWS::IAM::Role' <<<"${out}"; then
    echo "FAIL: cdkd drift reported phantom drift on an AWS::IAM::Role (${label}):" >&2
    printf '%s\n' "${out}" | grep -B1 -A6 'AWS::IAM::Role' >&2
    exit 1
  fi
  echo "    ${label}: no IAM Role drift"
}

echo "==> Phase 2: assert no phantom drift on any AWS::IAM::Role"
assert_no_role_drift "immediately after deploy"
assert_no_role_drift "second pass"

# --- Phase 2o: SharedPolicy's recorded baseline is the live value (go-to-k/cdkd#6609)
# drift alone cannot see a stale baseline while the live document is the
# declared one (the drift heal rule skips the key then), so this reads the
# baseline itself. The post-write capture reads the FIRST role's copy: a
# baseline captured before that write showed (no copy, or a replaced one)
# fails here.
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"; }
assert_observed_member() { # usage: assert_observed_member <logical-id> <jq path into observedProperties> <live JSON, '' for none> <label>
  local recorded live
  recorded=$(state_json | jq -cS --arg l "$1" \
    ".resources[\$l].observedProperties as \$o | if \$o == null then \"<no baseline>\" else ((\$o | $2) // \"<absent>\") end") \
    || { echo "FAIL: cannot read the state record of $1 after $4" >&2; exit 1; }
  if [ -z "$3" ]; then live='"<absent>"'; else live=$(jq -cS . <<<"$3"); fi
  if [ "${recorded}" != "${live}" ]; then
    echo "FAIL: $1's recorded baseline $2 is not what AWS holds after $4 (#6609)" >&2
    echo "  recorded: ${recorded}" >&2
    echo "  live:     ${live}" >&2
    exit 1
  fi
  echo "    OK: $1's baseline $2 is the live value after $4 (#6609)"
}
SHARED_POLICY="cdkd-iam-drift-clean-shared"
SHARED_POLICY_LID="SharedPolicy"
shared_document() { # usage: shared_document <role> -> the role's copy, decoded JSON
  aws iam get-role-policy --role-name "$1" --policy-name "${SHARED_POLICY}" \
    --region "${REGION}" --query 'PolicyDocument' --output json
}
echo "==> Phase 2o: SharedPolicy's recorded baseline is what AWS holds"
assert_observed_member "${SHARED_POLICY_LID}" '.PolicyDocument' "$(shared_document "${ROLE_NAME}")" "Phase 1 (first role's copy)"
assert_observed_member "${SHARED_POLICY_LID}" '.PolicyDocument' "$(shared_document "${MIXED_ROLE_NAME}")" "Phase 1 (second role's copy)"
assert_observed_member "${SHARED_POLICY_LID}" '.Roles' "[\"${ROLE_NAME}\",\"${MIXED_ROLE_NAME}\"]" "Phase 1"

# --- Phase 2s: an out-of-band edit of a shared policy's SECOND copy (go-to-k/cdkd#6616)
# SharedPolicy is one inline policy on two roles, so each role holds its own
# copy. Before the fix the policy's drift read fetched the FIRST role's copy
# only, so a widened document on the second role read clean and `--revert`
# left it in place.
SHARED_ACTION="sqs:ListQueues"
WIDENED_ACTION="sqs:*"
shared_action() { # usage: shared_action <role> -> the copy's first statement's action
  aws iam get-role-policy --role-name "$1" --policy-name "${SHARED_POLICY}" \
    --region "${REGION}" --query 'PolicyDocument.Statement[0].Action' --output text
}
wait_shared_action() { # usage: wait_shared_action <role> <action> -> 0 once the copy reads it
  local i
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    [ "$(shared_action "$1")" = "$2" ] && return 0
    sleep 5
  done
  return 1
}
echo "==> Phase 2s: widen SharedPolicy's copy on its second role out of band; drift must report it"
for rn in "${ROLE_NAME}" "${MIXED_ROLE_NAME}"; do
  if ! wait_shared_action "${rn}" "${SHARED_ACTION}"; then
    echo "FAIL: premise: ${rn} does not hold ${SHARED_POLICY} with ${SHARED_ACTION} after the first deploy (got: $(shared_action "${rn}"))" >&2
    exit 1
  fi
done
aws iam put-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${SHARED_POLICY}" \
  --region "${REGION}" \
  --policy-document "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"${WIDENED_ACTION}\",\"Resource\":\"*\"}]}"
if ! wait_shared_action "${MIXED_ROLE_NAME}" "${WIDENED_ACTION}"; then
  echo "FAIL: premise: the out-of-band put on ${MIXED_ROLE_NAME} never read back (got: $(shared_action "${MIXED_ROLE_NAME}"))" >&2
  exit 1
fi
# The first role's copy is untouched: the edit is on the SECOND target only.
if [ "$(shared_action "${ROLE_NAME}")" != "${SHARED_ACTION}" ]; then
  echo "FAIL: premise: ${ROLE_NAME}'s copy of ${SHARED_POLICY} changed too (got: $(shared_action "${ROLE_NAME}"))" >&2
  exit 1
fi
set +e
SHARED_DRIFT="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
shared_rc=$?
set -e
printf '%s\n' "${SHARED_DRIFT}" | sed 's/^/    | /'
if ! grep -qF '~ SharedPolicy (AWS::IAM::Policy)' <<<"${SHARED_DRIFT}"; then
  echo "FAIL: cdkd drift did not report the widened copy of ${SHARED_POLICY} on its second role (go-to-k/cdkd#6616)" >&2
  exit 1
fi
if [ "${shared_rc}" -ne 1 ]; then
  echo "FAIL: drift exited ${shared_rc} on a drifted stack, expected 1 (go-to-k/cdkd#6616)" >&2
  exit 1
fi
echo "    drift reported SharedPolicy"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-2s-before" "${STACK}" "${SHARED_POLICY_LID}" || exit 1
RC=0
env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes >"${REVERT_DIR}/revert-2s.log" 2>&1 || RC=$?
cat "${REVERT_DIR}/revert-2s.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-2s-before" "${REVERT_DIR}/revert-ids-2s-after" 1 "${REVERT_DIR}/revert-2s.log" || exit 1
[ "$RC" -eq 0 ] || { echo "FAIL: Phase 2s: drift --revert exited $RC"; exit 1; }
if ! wait_shared_action "${MIXED_ROLE_NAME}" "${SHARED_ACTION}"; then
  echo "FAIL: drift --revert left ${MIXED_ROLE_NAME}'s copy of ${SHARED_POLICY} widened (got: $(shared_action "${MIXED_ROLE_NAME}")) (go-to-k/cdkd#6616)" >&2
  exit 1
fi
if [ "$(shared_action "${ROLE_NAME}")" != "${SHARED_ACTION}" ]; then
  echo "FAIL: drift --revert changed ${ROLE_NAME}'s copy of ${SHARED_POLICY} (got: $(shared_action "${ROLE_NAME}"))" >&2
  exit 1
fi
echo "    --revert restored ${SHARED_ACTION} on ${MIXED_ROLE_NAME}"
set +e
SHARED_DRIFT="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
shared_rc=$?
set -e
# Only this resource: the fixture asserts no stack-wide drift-clean elsewhere.
if grep -qF 'SharedPolicy' <<<"${SHARED_DRIFT}"; then
  printf '%s\n' "${SHARED_DRIFT}" | sed 's/^/    | /' >&2
  echo "FAIL: drift after --revert still reports SharedPolicy (rc=${shared_rc}) (go-to-k/cdkd#6616)" >&2
  exit 1
fi
echo "    drift clean after --revert"

# --- Phase 2r: delete SharedPolicy's FIRST copy out of band, then --revert (go-to-k/cdkd#6609)
# The first role is the target the post-write capture reads and settles. The
# copy is deleted (the removal direction a stale "none" baseline would freeze
# in): drift must report it on Roles, `--revert` must put it back on that role
# by an update, never a delete + create (same RoleIds, same record physical
# id), and a follow-up drift must be clean.
echo "==> Phase 2r: delete SharedPolicy's copy on its first role out of band; drift --revert must restore it"
role_id() { aws iam get-role --role-name "$1" --region "${REGION}" --query 'Role.RoleId' --output text; }
record_physical_id() { state_json | jq -r --arg l "$1" '.resources[$l].physicalId // "<none>"'; }
ROLE_ID_BEFORE="$(role_id "${ROLE_NAME}")"
MIXED_ROLE_ID_BEFORE="$(role_id "${MIXED_ROLE_NAME}")"
SHARED_PHYSICAL_BEFORE="$(record_physical_id "${SHARED_POLICY_LID}")"
TEMPLATE_DOCUMENT="$(state_json | jq -cS --arg l "${SHARED_POLICY_LID}" '.resources[$l].properties.PolicyDocument')"
if [ -z "${ROLE_ID_BEFORE}" ] || [ -z "${MIXED_ROLE_ID_BEFORE}" ] || [ "${SHARED_PHYSICAL_BEFORE}" = "<none>" ] \
    || [ "${TEMPLATE_DOCUMENT}" = "null" ]; then
  echo "FAIL: premise: cannot read the role ids, the record's physical id or its template document before Phase 2r" >&2
  exit 1
fi
aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${SHARED_POLICY}" --region "${REGION}"
gone_first=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "${SHARED_POLICY}" --region "${REGION}"; then
    gone_first=true
    break
  fi
  sleep 5
done
if [ "${gone_first}" != true ]; then
  echo "FAIL: premise: the out-of-band delete of ${ROLE_NAME}'s copy of ${SHARED_POLICY} never read back" >&2
  exit 1
fi
set +e
REVERT_DRIFT="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json 2>/dev/null)"
revert_rc=$?
set -e
shared_paths="$(jq -c --arg l "${SHARED_POLICY_LID}" '[.[].drifted[] | select(.logicalId == $l) | .changes[].path]' <<<"${REVERT_DRIFT}")" || {
  echo "FAIL: cdkd drift --json printed no parseable report in Phase 2r (rc=${revert_rc})" >&2
  printf '%s\n' "${REVERT_DRIFT}" | sed 's/^/    | /' >&2
  exit 1
}
if ! jq -e 'any(.[]; startswith("Roles"))' <<<"${shared_paths}" >/dev/null; then
  echo "FAIL: cdkd drift --json did not report ${ROLE_NAME}'s deleted copy of ${SHARED_POLICY} on Roles (paths: ${shared_paths}) (go-to-k/cdkd#6609)" >&2
  exit 1
fi
if [ "${revert_rc}" -ne 1 ]; then
  echo "FAIL: drift --json exited ${revert_rc} on a drifted stack, expected 1 (go-to-k/cdkd#6609)" >&2
  exit 1
fi
echo "    drift --json reported SharedPolicy (paths: ${shared_paths})"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-2r-before" "${STACK}" "${SHARED_POLICY_LID}" || exit 1
RC=0
env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes >"${REVERT_DIR}/revert-2r.log" 2>&1 || RC=$?
cat "${REVERT_DIR}/revert-2r.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-2r-before" "${REVERT_DIR}/revert-ids-2r-after" 1 "${REVERT_DIR}/revert-2r.log" || exit 1
[ "$RC" -eq 0 ] || { echo "FAIL: Phase 2r: drift --revert exited $RC"; exit 1; }
restored=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  live_first="$(shared_document "${ROLE_NAME}" 2>/dev/null | jq -cS . 2>/dev/null || true)"
  if [ "${live_first}" = "${TEMPLATE_DOCUMENT}" ]; then
    restored=true
    break
  fi
  sleep 5
done
if [ "${restored}" != true ]; then
  echo "FAIL: drift --revert did not put the template's ${SHARED_POLICY} back on ${ROLE_NAME} (got: ${live_first:-<none>}; want: ${TEMPLATE_DOCUMENT}) (go-to-k/cdkd#6609)" >&2
  exit 1
fi
if [ "$(shared_document "${MIXED_ROLE_NAME}" | jq -cS .)" != "${TEMPLATE_DOCUMENT}" ]; then
  echo "FAIL: drift --revert changed ${MIXED_ROLE_NAME}'s copy of ${SHARED_POLICY} (go-to-k/cdkd#6609)" >&2
  exit 1
fi
if [ "$(role_id "${ROLE_NAME}")" != "${ROLE_ID_BEFORE}" ] || [ "$(role_id "${MIXED_ROLE_NAME}")" != "${MIXED_ROLE_ID_BEFORE}" ]; then
  echo "FAIL: drift --revert re-created a role (RoleId changed) restoring ${SHARED_POLICY} (go-to-k/cdkd#6609)" >&2
  exit 1
fi
if [ "$(record_physical_id "${SHARED_POLICY_LID}")" != "${SHARED_PHYSICAL_BEFORE}" ]; then
  echo "FAIL: drift --revert changed ${SHARED_POLICY_LID}'s physical id ($(record_physical_id "${SHARED_POLICY_LID}") vs ${SHARED_PHYSICAL_BEFORE}) (go-to-k/cdkd#6609)" >&2
  exit 1
fi
echo "    --revert restored the template document on ${ROLE_NAME}; RoleIds and the physical id unchanged"
set +e
REVERT_DRIFT="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json 2>/dev/null)"
revert_rc=$?
set -e
# Compared AND clean: absent from `drifted` alone also holds for a read that
# threw (notCompared) or a resource reported deleted.
if ! jq -e --arg l "${SHARED_POLICY_LID}" '[.[].clean[] | select(.logicalId == $l)] | length == 1' <<<"${REVERT_DRIFT}" >/dev/null \
    || [ "${revert_rc}" -ne 0 ]; then
  printf '%s\n' "${REVERT_DRIFT}" | sed 's/^/    | /' >&2
  echo "FAIL: drift after the Phase 2r --revert does not compare ${SHARED_POLICY_LID} clean, or exited ${revert_rc} (expected 0) (go-to-k/cdkd#6609)" >&2
  exit 1
fi
echo "    drift clean on SharedPolicy after --revert"

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

# --- Phase 2d: a case-only rename of the role's own inline policy (go-to-k/cdkd#6874)
# IAM holds one inline policy per name ignoring case. cdkd used to put the new
# spelling (replacing the document) and then delete the old one: the policy it
# had just written. It now deletes the old spelling first, as CloudFormation
# does, so the new spelling is held with the new document; the deploy back
# (the rollback direction) does the same the other way.
inline_action() { # usage: inline_action <exact-name> -> the first statement's action, or empty when absent
  # Only NoSuchEntity reads as absent; any other probe failure is FAIL (as
  # policy_action below). Inside a $( ) the exit ends only the substitution,
  # and the empty action never satisfies a wanted one, so the phase fails.
  local out
  if out="$(aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name "$1" \
    --region "${REGION}" --query 'PolicyDocument.Statement[0].Action' --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if grep -q 'NoSuchEntity' <<<"${out}"; then
    return 0
  fi
  echo "FAIL [6874]: get-role-policy $1 undetermined: ${out}" >&2
  exit 1
}
case_rename_check() { # usage: case_rename_check <want-name> <gone-name> <want-action> <label>
  local ok=0
  for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
    if has_policy "$1" && ! has_policy "$2" && [ "$(inline_action "$1")" = "$3" ]; then
      ok=1
      break
    fi
    sleep 5
  done
  if [ "${ok}" -ne 1 ]; then
    echo "FAIL [6874]: $4: the role holds '$(role_policies)' (action of $1: '$(inline_action "$1")'); want $1 with $3 and not $2" >&2
    exit 1
  fi
  echo "    $4: the role holds $1 with $3"
}
echo "==> Phase 2d: respell DeclaredInline only in case; the policy must survive with the new document"
env -u CDKD_TEST_HANDOFF CDKD_TEST_RENAME=true CDKD_TEST_CASE_RENAME=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
case_rename_check declaredinline DeclaredInline sqs:ChangeMessageVisibility "after the case-only rename"
assert_no_role_drift "after the case-only rename" true
env -u CDKD_TEST_HANDOFF -u CDKD_TEST_CASE_RENAME CDKD_TEST_RENAME=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
case_rename_check DeclaredInline declaredinline sqs:GetQueueAttributes "after renaming it back"
assert_no_role_drift "after renaming it back" true

# --- Phase 2c: hand inline policy names over in one deploy (go-to-k/cdkd#4156)
# Each name must end up held, with the RECEIVING resource's document (its own
# action), so the check reads both the name and whose grant it carries.
policy_action() { # usage: policy_action <policy-name> [role] -> its first statement's action, or empty when absent
  # Only NoSuchEntity reads as absent; any other probe failure is FAIL. Inside
  # a $( ) the exit ends only the substitution, so the caller then reads an
  # empty action, which never satisfies a wanted one: the phase still fails.
  local out
  if out="$(aws iam get-role-policy --role-name "${2:-${ROLE_NAME}}" --policy-name "$1" \
    --region "${REGION}" --query 'PolicyDocument.Statement[0].Action' --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if grep -q 'NoSuchEntity' <<<"${out}"; then
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
  "cdkd-iam-drift-clean-unordered-x=sqs:UntagQueue"
  "cdkd-iam-drift-clean-unordered-y=sqs:TagQueue"
  "cdkd-iam-drift-clean-unordered-handoff=sqs:StartMessageMoveTask"
  "cdkd-iam-drift-clean-unordered-moved=sqs:SetQueueAttributes"
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
# go-to-k/cdkd#4821: name -> the action that must hold it on MIXED_ROLE_NAME,
# before the hand-off (the policy holds `mixed-x`, the RolePolicy `mixed-y`)
# and after it (swapped).
mixed_mismatch() { # usage: mixed_mismatch before|after -> every wrong holder; empty when all match
  local pair name want got pairs
  if [ "$1" = "after" ]; then
    pairs="cdkd-iam-drift-clean-mixed-x=sqs:CancelMessageMoveTask cdkd-iam-drift-clean-mixed-y=sqs:ListMessageMoveTasks"
  else
    pairs="cdkd-iam-drift-clean-mixed-x=sqs:ListMessageMoveTasks cdkd-iam-drift-clean-mixed-y=sqs:CancelMessageMoveTask"
  fi
  for pair in ${pairs}; do
    name="${pair%%=*}"
    want="${pair#*=}"
    got="$(policy_action "${name}" "${MIXED_ROLE_NAME}")"
    [ "${got}" = "${want}" ] || printf '%s (want %s, got %s) ' "${name}" "${want}" "${got:-<missing>}"
  done
}
first_owner_mismatch() { # -> prints every name not held by its FIRST owner; empty when all match
  local pair name want got
  for pair in \
    "cdkd-iam-drift-clean-swap-x=sqs:ListQueueTags" \
    "cdkd-iam-drift-clean-swap-y=sqs:ListDeadLetterSourceQueues" \
    "cdkd-iam-drift-clean-handoff=sqs:ChangeMessageVisibility" \
    "cdkd-iam-drift-clean-to-role=sqs:PurgeQueue" \
    "cdkd-iam-drift-clean-unordered-x=sqs:TagQueue" \
    "cdkd-iam-drift-clean-unordered-y=sqs:UntagQueue" \
    "cdkd-iam-drift-clean-unordered-handoff=sqs:SetQueueAttributes"; do
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
for lid in SwapA SwapB ToRolePolicy UnorderedSwapA UnorderedSwapB UnorderedRenamed MixedPolicy MixedRolePolicy; do
  if ! grep -qE "Rollback: ${lid} (replacement reversed|restored successfully)" "${ROLLBACK_LOG}"; then
    echo "FAIL: the rollback ran but logged no reversal of ${lid}; the hand-off did not complete before the failure, or the rollback wording drifted" >&2
    exit 1
  fi
done
# go-to-k/cdkd#4821: reversed newest-first, the RolePolicy re-created its old
# name while MixedPolicy still held it, which Cloud Control refuses.
if grep -qE 'Rollback failed for Mixed(Policy|RolePolicy)' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback failed to reverse the IAM::Policy <-> RolePolicy swap:" >&2
  grep -E 'Rollback failed for Mixed' "${ROLLBACK_LOG}" >&2
  exit 1
fi
if ! grep -qE 'Rollback: WorkerRole[0-9A-Fa-f]* restored successfully' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback ran but logged no revert of the role's own Policies (WorkerRole...)" >&2
  exit 1
fi
if ! grep -q 'Rollback: HandoffNew deleted successfully' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback ran but logged no delete of HandoffNew; its create did not complete before the failure, or the rollback wording drifted" >&2
  exit 1
fi
if ! grep -q 'Rollback: UnorderedNew deleted successfully' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback ran but logged no delete of UnorderedNew; its create did not complete before the failure, or the rollback wording drifted" >&2
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
  if [ -z "$(first_owner_mismatch)" ] && [ -z "$(mixed_mismatch before)" ]; then
    rolled_back_ok=1
    break
  fi
  sleep 5
done
if [ "${rolled_back_ok}" -ne 1 ]; then
  echo "FAIL: after the rollback the role lost or mis-holds: $(first_owner_mismatch)(role holds: $(role_policies); mixed role: $(mixed_mismatch before)) — a rollback revert removed a name another revert had put back, or the RolePolicy's re-create was refused while the policy still held its name (go-to-k/cdkd#4821)" >&2
  exit 1
fi
# The renamed-to name must be gone: a strict gone-probe, since an empty
# `policy_action` read can also mean a failed probe.
assert_gone "cdkd-iam-drift-clean-to-role-moved is still on ${ROLE_NAME} after the rollback" \
  aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name cdkd-iam-drift-clean-to-role-moved --region "${REGION}"
assert_gone "cdkd-iam-drift-clean-unordered-moved is still on ${ROLE_NAME} after the rollback" \
  aws iam get-role-policy --role-name "${ROLE_NAME}" --policy-name cdkd-iam-drift-clean-unordered-moved --region "${REGION}"
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
    [ "$(policy_action cdkd-iam-drift-clean-to-role)" = "sqs:PurgeQueue" ] &&
    [ -z "$(first_owner_mismatch)" ] &&
    [ -z "$(mixed_mismatch before)" ]; then
    premise_ok=1
    break
  fi
  sleep 5
done
if [ "${premise_ok}" -ne 1 ]; then
  echo "FAIL: premise: the role's hand-off policies are not held by their first owners (got: $(role_policies); mixed role: $(mixed_mismatch before))" >&2
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
# go-to-k/cdkd#4821: the IAM::Policy <-> RolePolicy swap keeps BOTH policies.
# CloudFormation's cleanup-phase delete of the RolePolicy's old name removes
# the IAM::Policy's new one there; cdkd must not.
mixed_ok=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if [ -z "$(mixed_mismatch after)" ]; then
    mixed_ok=1
    break
  fi
  sleep 5
done
if [ "${mixed_ok}" -ne 1 ]; then
  echo "FAIL: after the IAM::Policy <-> RolePolicy swap ${MIXED_ROLE_NAME} lost or mis-holds: $(mixed_mismatch after)— the replaced RolePolicy's delete of its old name, or the policy's removal of its old name, stripped the other's grant (go-to-k/cdkd#4821)" >&2
  exit 1
fi
echo "    the IAM::Policy <-> RolePolicy swap kept both policies"
if ! has_policy "DeclaredInline" || ! has_policy "${NEW_POLICY}"; then
  echo "FAIL: the hand-off removed an unrelated policy (got: $(role_policies))" >&2
  exit 1
fi
assert_no_role_drift "after hand-off" handoff

# --- Phase 2p: a same-named stranger under MixedRole's name, then --revert (go-to-k/cdkd#6734)
# MixedRole is deleted and re-created out of band under its name, holding a
# copy of every inline policy it held EXCEPT SharedPolicy's, and not attached
# to SharedManaged: both are then drifted on Roles, the one change each revert
# would make. Before the fix the revert sent its updates with no record of the
# stack's other resources, saw the role as outside the stack and put
# SharedPolicy on / attached SharedManaged to the stranger by name (a grant).
# It must now read the role, refuse both with nothing put or attached (exit
# 2), and leave both records, SharedPolicy's copy on the first role and every
# id as they were. LAST before the destroy: the stranger is deleted
# afterwards, so the destroy finds MixedRole gone (Phase 3's MixedRole check
# then proves only that it stays gone).
echo "==> Phase 2p: re-create MixedRole out of band; drift --revert must not put SharedPolicy on the stranger"
P2P_PREFIX="${REVERT_DIR}/revert-2p-policy-"
MIXED_ROLE_ID_BEFORE_2P="$(role_id "${MIXED_ROLE_NAME}")"
ROLE_ID_BEFORE_2P="$(role_id "${ROLE_NAME}")"
SHARED_PHYSICAL_BEFORE_2P="$(record_physical_id "${SHARED_POLICY_LID}")"
TEMPLATE_DOCUMENT_2P="$(state_json | jq -cS --arg l "${SHARED_POLICY_LID}" '.resources[$l].properties.PolicyDocument')"
MIXED_TRUST="$(aws iam get-role --role-name "${MIXED_ROLE_NAME}" --region "${REGION}" \
  --query 'Role.AssumeRolePolicyDocument' --output json)"
SHARED_MANAGED_LID="SharedManaged"
SHARED_MANAGED_ARN="$(record_physical_id "${SHARED_MANAGED_LID}")"
MIXED_ATTACHED="$(aws iam list-attached-role-policies --role-name "${MIXED_ROLE_NAME}" --region "${REGION}" \
  --query 'AttachedPolicies[].PolicyArn' --output text)"
if [ -z "${MIXED_ROLE_ID_BEFORE_2P}" ] || [ -z "${ROLE_ID_BEFORE_2P}" ] || [ "${SHARED_PHYSICAL_BEFORE_2P}" = "<none>" ] \
    || [ "${TEMPLATE_DOCUMENT_2P}" = "null" ] || [ -z "${MIXED_TRUST}" ] || [ "${SHARED_MANAGED_ARN}" = "<none>" ] \
    || [ "${MIXED_ATTACHED}" != "${SHARED_MANAGED_ARN}" ]; then
  echo "FAIL: premise: cannot read the role ids, SharedPolicy's / SharedManaged's records or MixedRole's trust policy before Phase 2p, or MixedRole's attached managed policies are not SharedManaged alone (${MIXED_ATTACHED})" >&2
  exit 1
fi
if [ "$(shared_document "${MIXED_ROLE_NAME}" | jq -cS .)" != "${TEMPLATE_DOCUMENT_2P}" ]; then
  echo "FAIL: premise: ${MIXED_ROLE_NAME} does not hold the template's ${SHARED_POLICY} before Phase 2p" >&2
  exit 1
fi
MIXED_INLINE="$(aws iam list-role-policies --role-name "${MIXED_ROLE_NAME}" --region "${REGION}" \
  --query 'PolicyNames' --output text)"
kept_2p=0
for pn in ${MIXED_INLINE}; do
  [ "${pn}" = "${SHARED_POLICY}" ] && continue
  aws iam get-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${pn}" --region "${REGION}" \
    --query 'PolicyDocument' --output json >"${P2P_PREFIX}${pn}.json"
  kept_2p=$((kept_2p + 1))
done
# MixedDeclared, MixedPolicy's and MixedRolePolicy's names; checked before
# anything is deleted.
if [ "${kept_2p}" -ne 3 ]; then
  echo "FAIL: premise: ${MIXED_ROLE_NAME} held ${kept_2p} inline policies besides ${SHARED_POLICY}, expected 3" >&2
  exit 1
fi
for pn in ${MIXED_INLINE}; do
  aws iam delete-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${pn}" --region "${REGION}"
done
aws iam detach-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-arn "${SHARED_MANAGED_ARN}" --region "${REGION}"
aws iam delete-role --role-name "${MIXED_ROLE_NAME}" --region "${REGION}"
aws iam create-role --role-name "${MIXED_ROLE_NAME}" --assume-role-policy-document "${MIXED_TRUST}" \
  --region "${REGION}" >/dev/null
for f in "${P2P_PREFIX}"*.json; do
  pn="${f#"${P2P_PREFIX}"}"
  aws iam put-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${pn%.json}" \
    --policy-document "file://${f}" --region "${REGION}"
done
# Two reads in a row answering the new RoleId: a lagging read answering the
# old one would let cdkd's own compare match and put (a false RED).
stranger_ready=false
new_id_reads=0
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16; do
  stranger_id="$(role_id "${MIXED_ROLE_NAME}" 2>/dev/null || true)"
  if [ -n "${stranger_id}" ] && [ "${stranger_id}" != "${MIXED_ROLE_ID_BEFORE_2P}" ] \
      && gone_probe aws iam get-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${SHARED_POLICY}" --region "${REGION}"; then
    new_id_reads=$((new_id_reads + 1))
    if [ "${new_id_reads}" -ge 2 ]; then
      stranger_ready=true
      break
    fi
  else
    new_id_reads=0
  fi
  sleep 5
done
if [ "${stranger_ready}" != true ]; then
  echo "FAIL: premise: the out-of-band re-create of ${MIXED_ROLE_NAME} never read back with a new RoleId and no ${SHARED_POLICY}" >&2
  exit 1
fi
set +e
REVERT_DRIFT="$(env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json 2>/dev/null)"
revert_rc=$?
set -e
drifted_2p="$(jq -c '[.[].drifted[].logicalId] | sort' <<<"${REVERT_DRIFT}")" || {
  echo "FAIL: cdkd drift --json printed no parseable report in Phase 2p (rc=${revert_rc})" >&2
  printf '%s\n' "${REVERT_DRIFT}" | sed 's/^/    | /' >&2
  exit 1
}
shared_paths="$(jq -c --arg l "${SHARED_POLICY_LID}" '[.[].drifted[] | select(.logicalId == $l) | .changes[].path]' <<<"${REVERT_DRIFT}")"
managed_paths="$(jq -c --arg l "${SHARED_MANAGED_LID}" '[.[].drifted[] | select(.logicalId == $l) | .changes[].path]' <<<"${REVERT_DRIFT}")"
# Not MixedRole / MixedPolicy / MixedRolePolicy: a drifted one would be
# reverted onto the stranger too, by paths this phase does not prove.
if ! jq -e 'any(.[]; startswith("Roles"))' <<<"${shared_paths}" >/dev/null \
    || ! jq -e 'any(.[]; startswith("Roles"))' <<<"${managed_paths}" >/dev/null \
    || jq -e 'any(.[]; startswith("Mixed"))' <<<"${drifted_2p}" >/dev/null \
    || [ "${revert_rc}" -ne 1 ]; then
  echo "FAIL: premise: drift --json must report SharedPolicy and SharedManaged on Roles and nothing of MixedRole's (drifted: ${drifted_2p}; SharedPolicy paths: ${shared_paths}; SharedManaged paths: ${managed_paths}; rc=${revert_rc})" >&2
  exit 1
fi
echo "    drift --json reported SharedPolicy and SharedManaged on Roles (drifted: ${drifted_2p})"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-2p-before" "${STACK}" "${SHARED_POLICY_LID}" "${SHARED_MANAGED_LID}" || exit 1
RC=0
env -u CDKD_TEST_RENAME -u CDKD_TEST_HANDOFF node "${LOCAL_DIST}" drift "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes >"${REVERT_DIR}/revert-2p.log" 2>&1 || RC=$?
cat "${REVERT_DIR}/revert-2p.log"
revert_identity_verify "${REVERT_DIR}/revert-ids-2p-before" "${REVERT_DIR}/revert-ids-2p-after" 2 "${REVERT_DIR}/revert-2p.log" expect-refusal || exit 1
if [ "${RC}" -ne 2 ]; then
  echo "FAIL: Phase 2p: drift --revert exited ${RC}, expected 2 (SharedPolicy and SharedManaged refused) (go-to-k/cdkd#6734)" >&2
  exit 1
fi
P2P_PLAIN="$(sed $'s/\x1b\\[[0-9;]*m//g' "${REVERT_DIR}/revert-2p.log")"
for refusal in "Cannot attach IAM policy ${SHARED_POLICY_LID} to IAM role MixedRole" \
    "Cannot attach IAM managed policy ${SHARED_MANAGED_LID} to IAM role MixedRole"; do
  if ! grep -qF "${refusal}" <<<"${P2P_PLAIN}"; then
    echo "FAIL: Phase 2p: drift --revert printed no '${refusal}...' for the stranger under ${MIXED_ROLE_NAME} (go-to-k/cdkd#6734)" >&2
    exit 1
  fi
done
# A put or attach would read back within seconds: look for a while, not once.
for i in 1 2 3 4 5 6; do
  if ! gone_probe aws iam get-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${SHARED_POLICY}" --region "${REGION}"; then
    echo "FAIL: drift --revert put ${SHARED_POLICY} on the stranger holding ${MIXED_ROLE_NAME} (go-to-k/cdkd#6734)" >&2
    exit 1
  fi
  stranger_attached="$(aws iam list-attached-role-policies --role-name "${MIXED_ROLE_NAME}" --region "${REGION}" \
    --query 'AttachedPolicies[].PolicyArn' --output text)"
  if [ -n "${stranger_attached}" ]; then
    echo "FAIL: drift --revert attached ${stranger_attached} to the stranger holding ${MIXED_ROLE_NAME} (go-to-k/cdkd#6734)" >&2
    exit 1
  fi
  sleep 5
done
if [ "$(shared_document "${ROLE_NAME}" | jq -cS .)" != "${TEMPLATE_DOCUMENT_2P}" ] \
    || [ "$(role_id "${ROLE_NAME}")" != "${ROLE_ID_BEFORE_2P}" ] \
    || [ "$(role_id "${MIXED_ROLE_NAME}")" != "${stranger_id}" ] \
    || [ "$(record_physical_id "${SHARED_POLICY_LID}")" != "${SHARED_PHYSICAL_BEFORE_2P}" ]; then
  echo "FAIL: Phase 2p: the refused revert changed ${ROLE_NAME}'s copy of ${SHARED_POLICY}, a RoleId or SharedPolicy's physical id (go-to-k/cdkd#6734)" >&2
  exit 1
fi
echo "    --revert refused SharedPolicy and SharedManaged for the stranger; nothing put or attached, every id unchanged"
# The stranger goes before the destroy, which then finds MixedRole gone (its
# own delete would refuse a holder with another RoleId, go-to-k/cdkd#6679).
for pn in $(aws iam list-role-policies --role-name "${MIXED_ROLE_NAME}" --region "${REGION}" \
    --query 'PolicyNames' --output text); do
  aws iam delete-role-policy --role-name "${MIXED_ROLE_NAME}" --policy-name "${pn}" --region "${REGION}"
done
aws iam delete-role --role-name "${MIXED_ROLE_NAME}" --region "${REGION}"
stranger_gone=false
for i in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws iam get-role --role-name "${MIXED_ROLE_NAME}" --region "${REGION}"; then
    stranger_gone=true
    break
  fi
  sleep 5
done
if [ "${stranger_gone}" != true ]; then
  echo "FAIL: the out-of-band delete of the stranger holding ${MIXED_ROLE_NAME} never read back" >&2
  exit 1
fi

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
CDKD_TEST_RENAME=true CDKD_TEST_HANDOFF=true node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "function ${FN_NAME} still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    function deleted"

assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}" --region "${REGION}"
echo "    standalone role deleted"

# Phase 2p deleted MixedRole (by then a stranger) out of band: this proves
# only that it stays gone.
assert_gone "role ${MIXED_ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${MIXED_ROLE_NAME}" --region "${REGION}"
echo "    mixed-swap role deleted"

assert_gone "managed policy ${SHARED_MANAGED_ARN} still exists after destroy" aws iam get-policy --policy-arn "${SHARED_MANAGED_ARN}"
echo "    shared managed policy deleted"

assert_gone "queue ${QUEUE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"
echo "    queue deleted"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

echo "[verify] PASS — IAM Role with a sibling Default Policy shows no phantom drift after deploy; all phases passed, an in-place rename left no old-named policy on the retained role, and a same-deploy hand-off kept every name with its new owner"
