#!/usr/bin/env bash
# verify.sh — cdkd #2567: a recreate target (--recreate-via-cc-api /
# --recreate-via-sdk-provider) is scoped to the stack the
# pre-flight validated it against.
#
# The parent and its nested child both declare a `SharedTarget`:
#
#   parent SharedTarget = AWS::Lambda::Function (stateless, the NAMED target)
#   child  SharedTarget = AWS::S3::Bucket       (stateful, named by NOBODY)
#
# `--recreate-via-cc-api SharedTarget` is validated against the PARENT only —
# its template, its state record, and (for a stateful type) a live emptiness
# probe. `NestedStackProvider` then spreads the parent's engine options into
# the child engine, so before #2567 the bare id set matched the CHILD's
# `SharedTarget` too, `recreateFlagged` skipped the child's mid-deploy stateful
# guard, and the seeded bucket was DELETE + CREATEd with neither check having
# examined it.
#
# Phases:
#   1. Baseline deploy. Assert both state files, both `SharedTarget` records,
#      both `provisionedBy: 'sdk'`. Capture the child bucket's name +
#      CreationDate and the parent Lambda's LastModified.
#   2. Seed an object into the CHILD bucket — the data at risk, and the thing
#      the parent's pre-flight probe never looks at.
#   3. THE HEADLINE: deploy with `--recreate-via-cc-api SharedTarget` and a
#      real property change on BOTH SharedTargets (without a change on the
#      child's the run would be vacuous — the flag only acts in the engine's
#      UPDATE branch). Assert the PARENT resource was recreated onto Cloud
#      Control, and that the CHILD bucket was updated IN PLACE: same
#      CreationDate, still `provisionedBy: 'sdk'`, object intact, and the tag
#      applied (which is what proves the child resource really was visited as
#      an UPDATE in this deploy).
#
#      WHAT PRE-FIX CODE DOES HERE, precisely: the child's delete is attempted
#      and cdkd's CloudFormation-parity data guard REFUSES it, because the
#      bucket holds the object phase 2 seeded and this fixture declares no
#      auto-delete tag. So the phase FAILS at the deploy rather than at the
#      assertions below — a loud failure, and still a discriminating one, but
#      do not read the CreationDate / object assertions as the things that go
#      red first. They are what covers the same bug on an EMPTY child bucket,
#      where nothing refuses the delete and the recreate would be silent.
#   4. A genuinely nested target (`ChildOnlyParam`, declared only in the child)
#      is refused at pre-flight, and the refusal explains the nesting rather
#      than reading as a typo. 4b: naming the nested stack ROW (`Child`) is
#      refused too, and `--force-stateful-recreation` does not clear it. Both
#      are `--dry-run`, so neither mutates anything.
#   5. Empty the bucket, destroy, assert every resource and both state files
#      are gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

set -euo pipefail

# A pager invoked non-interactively hangs the run (issue #1402).
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

cd "$(dirname "$0")"

REGION="${AWS_REGION:-us-east-1}"
STACK="CdkdRecreateNestedCollision"
CHILD_STACK="${STACK}~Child"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
FN_NAME="cdkd-recreate-nested-collision-fn"
CHILD_PARAM_NAME="/cdkd/recreate-nested-collision/child-only"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
BUCKET_NAME="cdkd-recreate-nested-collision-${ACCOUNT_ID}"
PROBE_KEY="child-data.txt"
# The mode token every deploy after phase 1 carries. Monotonic by
# construction: it only ever turns property values from "phase one" to "phase
# two", so no later deploy can drop a resource by omitting it.
UPDATE_MODE="updated"
# Declared before `cleanup` so the trap can remove it on any exit path; set for
# real in phase 4.
NESTED_LOG=""
NESTED_ROW_LOG=""

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  # No `rc=$?` gate here: this cleanup runs unconditionally (pre-run, on the
  # success path, and from the traps), so there is no arm to skip. The `(exit N)`
  # seeds on the signal traps below stay correct either way.
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion — best-effort
  # cleanup should run as much as it can with the env it has.
  set +eu
  # Empty the child bucket FIRST: cdkd's CloudFormation-parity data guard
  # refuses to delete a bucket that still holds objects (this fixture carries
  # no auto-delete custom resource on purpose), so a state destroy would leave
  # it behind.
  if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws s3 rm "s3://${BUCKET_NAME}/" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -x "${LOCAL_DIST}" ] || [ -f "${LOCAL_DIST}" ]; then
    # Child first: the parent's nested-stack row points at it.
    node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws lambda delete-function --function-name "${FN_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
    aws s3 rm "s3://${BUCKET_NAME}/" --recursive --region "${REGION}" >/dev/null 2>&1 || true
    aws s3 rb "s3://${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHILD_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  # IAM roles: `starts_with` is precise (CDK auto-names start with the stack id).
  for role in $(aws iam list-roles --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${role}" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole >/dev/null 2>&1 || true
    aws iam delete-role --role-name "${role}" >/dev/null 2>&1 || true
  done
  rm -f "${NESTED_LOG:-}" "${NESTED_ROW_LOG:-}"
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
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: baseline deploy (parent + nested child) -----------------------
echo "==> Phase 1: baseline deploy of ${STACK} (parent Lambda + child bucket, both 'SharedTarget')"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

PARENT_STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")
CHILD_STATE_1=$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")

# The collision itself is the premise: BOTH stacks must record a
# `SharedTarget`, and they must be different resource types. A fixture whose
# ids drifted apart would pass every later assertion while testing nothing.
PARENT_TYPE_1=$(echo "${PARENT_STATE_1}" | jq -r '.resources.SharedTarget.resourceType // ""')
CHILD_TYPE_1=$(echo "${CHILD_STATE_1}" | jq -r '.resources.SharedTarget.resourceType // ""')
if [ "${PARENT_TYPE_1}" != "AWS::Lambda::Function" ]; then
  echo "FAIL: parent SharedTarget has resourceType='${PARENT_TYPE_1}', expected 'AWS::Lambda::Function' — the collision premise is broken" >&2
  echo "${PARENT_STATE_1}" | jq .
  exit 1
fi
if [ "${CHILD_TYPE_1}" != "AWS::S3::Bucket" ]; then
  echo "FAIL: child SharedTarget has resourceType='${CHILD_TYPE_1}', expected 'AWS::S3::Bucket' — the collision premise is broken" >&2
  echo "${CHILD_STATE_1}" | jq .
  exit 1
fi
echo "    OK: both stacks declare 'SharedTarget' (parent Lambda / child bucket)"

PARENT_PROVISIONED_1=$(echo "${PARENT_STATE_1}" | jq -r '.resources.SharedTarget.provisionedBy // ""')
CHILD_PROVISIONED_1=$(echo "${CHILD_STATE_1}" | jq -r '.resources.SharedTarget.provisionedBy // ""')
if [ "${PARENT_PROVISIONED_1}" != "sdk" ] || [ "${CHILD_PROVISIONED_1}" != "sdk" ]; then
  echo "FAIL: baseline provisionedBy is parent='${PARENT_PROVISIONED_1}' child='${CHILD_PROVISIONED_1}', expected 'sdk' for both" >&2
  exit 1
fi
echo "    OK: both SharedTargets baseline at provisionedBy == 'sdk'"

CHILD_BUCKET_1=$(echo "${CHILD_STATE_1}" | jq -r '.resources.SharedTarget.physicalId')
if [ "${CHILD_BUCKET_1}" != "${BUCKET_NAME}" ]; then
  echo "FAIL: child bucket physicalId is '${CHILD_BUCKET_1}', expected '${BUCKET_NAME}'" >&2
  exit 1
fi
CREATED_1=$(aws s3api list-buckets --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate" --output text)
if [ -z "${CREATED_1}" ] || [ "${CREATED_1}" = "None" ]; then
  echo "FAIL: could not read CreationDate for ${BUCKET_NAME}" >&2
  exit 1
fi
LAST_MOD_1=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text)
echo "    Baseline child bucket CreationDate: ${CREATED_1}"
echo "    Baseline parent Lambda LastModified: ${LAST_MOD_1}"

# --- Phase 2: seed the child bucket ----------------------------------------
echo "==> Phase 2: seed an object into the CHILD bucket (the data nobody named)"
echo "cdkd #2567 child payload" | aws s3 cp - "s3://${BUCKET_NAME}/${PROBE_KEY}" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${BUCKET_NAME}" --key "${PROBE_KEY}" --region "${REGION}" >/dev/null
echo "    OK: s3://${BUCKET_NAME}/${PROBE_KEY} in place"

# --- Phase 3: the headline -------------------------------------------------
echo "==> Phase 3: deploy with --recreate-via-cc-api SharedTarget (parent target only)"
CDKD_TEST_UPDATE="${UPDATE_MODE}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api SharedTarget \
  --yes

PARENT_STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")
CHILD_STATE_2=$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" - --region "${REGION}")

# --- 3a: the NAMED target WAS recreated, onto Cloud Control ---
PARENT_PROVISIONED_2=$(echo "${PARENT_STATE_2}" | jq -r '.resources.SharedTarget.provisionedBy // ""')
if [ "${PARENT_PROVISIONED_2}" != "cc-api" ]; then
  echo "FAIL: parent SharedTarget has provisionedBy='${PARENT_PROVISIONED_2}', expected 'cc-api' — the flag did not recreate the resource the user NAMED" >&2
  echo "${PARENT_STATE_2}" | jq .
  exit 1
fi
echo "    OK: parent SharedTarget provisionedBy flipped 'sdk' -> 'cc-api' (the flag still works)"

# The function name is user-supplied and stable across a recreate, so the
# physical id is not a witness. LastModified is a NECESSARY condition, not a
# sufficient one — an in-place update bumps it too — which is why the
# provisionedBy flip above is the assertion that identifies the recreate and
# this one only rules out "nothing happened at all".
LAST_MOD_2=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --query 'LastModified' --output text)
if [ "${LAST_MOD_2}" = "${LAST_MOD_1}" ]; then
  echo "FAIL: parent Lambda LastModified unchanged (${LAST_MOD_1}) — expected a destroy + recreate" >&2
  exit 1
fi
echo "    OK: parent Lambda was destroyed and recreated (LastModified ${LAST_MOD_1} -> ${LAST_MOD_2})"

# --- 3b: the child's SharedTarget really WAS visited, as an UPDATE ---
# Load-bearing: without a property change on the child's bucket the engine
# never reaches the `case 'UPDATE'` where the recreate flag is read, and every
# assertion below would pass on a resource cdkd never looked at.
# ORDER IS LOAD-BEARING. The tag read below treats a canonical not-found as
# "no tags", and `NoSuchBucket` matches that same signature — so on the exact
# failure this fixture exists to catch (the child bucket destroyed by the
# inherited flag) it would report a confident wrong cause. Settle existence
# first, fail-closed: a missing bucket IS the bug, and says so.
if ! aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: the child bucket ${BUCKET_NAME} is GONE after the flagged deploy — the parent's recreate target was honoured in the CHILD stack (issue #2567)" >&2
  exit 1
fi

# Strict status-consuming capture. stderr goes to its own file, so the success
# path cannot fold a warning line into the tag value. S3 answers `NoSuchTagSet`
# when the bucket carries no tags at all, which is a legitimate outcome here (it
# means the child was never updated) and must produce THIS message rather than a
# raw CLI error; anything else hard-fails.
TAG_ERR="$(mktemp)"
CHILD_TAG_OUT="$(aws s3api get-bucket-tagging --bucket "${BUCKET_NAME}" --region "${REGION}" \
  --query "TagSet[?Key=='Phase'].Value" --output text 2>"${TAG_ERR}")" && TAG_RC=0 || TAG_RC=$?
if [ "${TAG_RC}" -ne 0 ]; then
  # The ONE canonical not-found signature (issue #1097). `NoSuchBucket` is ruled
  # out by the head-bucket check above, so reaching this arm means NoSuchTagSet.
  if grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' "${TAG_ERR}"; then
    CHILD_TAG=""
  else
    echo "FAIL: could not read the child bucket's tags: $(cat "${TAG_ERR}")" >&2
    rm -f "${TAG_ERR}"
    exit 1
  fi
else
  CHILD_TAG="${CHILD_TAG_OUT}"
fi
rm -f "${TAG_ERR}"
if [ "${CHILD_TAG}" != "two" ]; then
  echo "FAIL: child bucket tag Phase='${CHILD_TAG}', expected 'two' — the child's SharedTarget was not updated in this deploy, so the scope assertions below would be vacuous" >&2
  exit 1
fi
echo "    OK: child SharedTarget was updated in this deploy (tag Phase=two applied)"

# --- 3c: ...and was NOT recreated ---
CHILD_PROVISIONED_2=$(echo "${CHILD_STATE_2}" | jq -r '.resources.SharedTarget.provisionedBy // ""')
if [ "${CHILD_PROVISIONED_2}" != "sdk" ]; then
  echo "FAIL: child SharedTarget has provisionedBy='${CHILD_PROVISIONED_2}', expected 'sdk' — the parent's recreate flag was honoured in the CHILD stack (issue #2567)" >&2
  echo "${CHILD_STATE_2}" | jq .
  exit 1
fi
echo "    OK: child SharedTarget stayed on the SDK route (the inherited flag did not match)"

CHILD_BUCKET_2=$(echo "${CHILD_STATE_2}" | jq -r '.resources.SharedTarget.physicalId')
if [ "${CHILD_BUCKET_2}" != "${CHILD_BUCKET_1}" ]; then
  echo "FAIL: child bucket physicalId changed '${CHILD_BUCKET_1}' -> '${CHILD_BUCKET_2}'" >&2
  exit 1
fi
CREATED_2=$(aws s3api list-buckets --query "Buckets[?Name=='${BUCKET_NAME}'].CreationDate" --output text)
if [ "${CREATED_2}" != "${CREATED_1}" ]; then
  echo "FAIL: child bucket CreationDate changed '${CREATED_1}' -> '${CREATED_2}' — the bucket was DELETE + CREATEd (issue #2567)" >&2
  exit 1
fi
echo "    OK: child bucket is the same physical bucket (CreationDate ${CREATED_2})"

# The consequence a user would notice.
aws s3api head-object --bucket "${BUCKET_NAME}" --key "${PROBE_KEY}" --region "${REGION}" >/dev/null
echo "    OK: the seeded object survived the deploy"

# --- Phase 4: a genuinely nested target is refused at pre-flight ------------
echo "==> Phase 4: --recreate-via-cc-api ChildOnlyParam (declared only in the child) must be refused"
NESTED_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE="${UPDATE_MODE}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api ChildOnlyParam \
  --dry-run \
  --yes > "${NESTED_LOG}" 2>&1
RC=$?
set -e
if [ ${RC} -eq 0 ]; then
  echo "FAIL: naming a child-only logical id was accepted (expected a pre-flight refusal)" >&2
  cat "${NESTED_LOG}" >&2
  exit 1
fi
if ! grep -qF 'not present in the synth template' "${NESTED_LOG}"; then
  echo "FAIL: the refusal did not report the id as absent from the template" >&2
  cat "${NESTED_LOG}" >&2
  exit 1
fi
if ! grep -qF 'resources inside a nested stack are NOT addressable' "${NESTED_LOG}"; then
  echo "FAIL: the refusal did not explain the nested-stack scope — a user reads it as a typo" >&2
  cat "${NESTED_LOG}" >&2
  exit 1
fi
# The RENDERED list, not the bare word: the refusal already echoes the offending
# id `ChildOnlyParam`, which contains "Child", so a substring grep would pass
# with `nestedStackLogicalIds` empty or wrong.
if ! grep -qF 'nested stack(s) (Child)' "${NESTED_LOG}"; then
  echo "FAIL: the refusal did not name the template's nested stack as '(Child)'" >&2
  cat "${NESTED_LOG}" >&2
  exit 1
fi
echo "    OK: a child-only target is refused, and the refusal names the nesting"

# --- Phase 4b: the nested stack ROW itself is refused -----------------------
echo "==> Phase 4b: --recreate-via-cc-api Child (the nested stack row) must be refused"
# Same --dry-run shape as 4a, so this arm mutates nothing: the refusal is a
# pre-flight verdict and never reaches a provider. Without it, honouring the
# target would route the WHOLE child stack through the replacement path.
NESTED_ROW_LOG="$(mktemp)"
set +e
CDKD_TEST_UPDATE="${UPDATE_MODE}" node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api Child \
  --force-stateful-recreation \
  --dry-run \
  --yes > "${NESTED_ROW_LOG}" 2>&1
ROW_RC=$?
set -e
if [ ${ROW_RC} -eq 0 ]; then
  echo "FAIL: naming the nested stack row 'Child' was accepted (expected a pre-flight refusal)" >&2
  cat "${NESTED_ROW_LOG}" >&2
  rm -f "${NESTED_ROW_LOG}"
  exit 1
fi
# `--force-stateful-recreation` is passed deliberately: this category has no
# bypass, so the refusal must survive the consent flag that clears the stateful
# guard. A refusal that the flag cleared would be a different, weaker check.
if ! grep -qF 'refuses to operate on 1 nested-stack resource' "${NESTED_ROW_LOG}"; then
  echo "FAIL: the refusal did not name the nested-stack category" >&2
  cat "${NESTED_ROW_LOG}" >&2
  rm -f "${NESTED_ROW_LOG}"
  exit 1
fi
if ! grep -qF 'DELETE the whole child stack' "${NESTED_ROW_LOG}"; then
  echo "FAIL: the refusal did not state the consequence it prevents" >&2
  cat "${NESTED_ROW_LOG}" >&2
  rm -f "${NESTED_ROW_LOG}"
  exit 1
fi
rm -f "${NESTED_ROW_LOG}"
echo "    OK: the nested stack row is refused, and --force-stateful-recreation does not clear it"

# --- Phase 5: destroy -------------------------------------------------------
echo "==> Phase 5: empty the child bucket, then destroy"
aws s3 rm "s3://${BUCKET_NAME}/" --recursive --region "${REGION}" >/dev/null
CDKD_TEST_UPDATE="${UPDATE_MODE}" node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: parent Lambda is gone"

assert_gone "child bucket ${BUCKET_NAME} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET_NAME}" --region "${REGION}"
echo "    OK: child bucket is gone"

assert_gone "child SSM parameter ${CHILD_PARAM_NAME} still exists after destroy" aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}"
echo "    OK: child SSM parameter is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: parent state file is gone"

assert_gone "child state file s3://${STATE_BUCKET}/${CHILD_STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
echo "    OK: child state file is gone"

LEFTOVER_ROLES=$(aws iam list-roles \
  --query "Roles[?starts_with(RoleName, \`${STACK}\`)].RoleName" \
  --output text)
if [ -n "${LEFTOVER_ROLES}" ]; then
  echo "FAIL: IAM role(s) still exist after destroy: ${LEFTOVER_ROLES}" >&2
  exit 1
fi
echo "    OK: IAM role is gone"

echo ""
echo "==> recreate-nested-logical-id-collision passed (#2567: the recreate flags stop at the stack they were validated against)"
