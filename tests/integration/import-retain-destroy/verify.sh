#!/usr/bin/env bash
#
# End-to-end real-AWS validation that `cdkd destroy` run right after
# `cdkd import --migrate-from-cloudformation` keeps a `DeletionPolicy: Retain`
# resource (issue #3645).
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. `cdk deploy` the stack (the existing CloudFormation stack to migrate).
#   3. `cdkd import --migrate-from-cloudformation --yes`; assert the `Kept`
#      record carries `deletionPolicy: Retain`.
#   4. `cdkd destroy --force` with NO deploy in between.
#   5. Assert: `Kept` (Retain) is still in AWS, `Gone` is deleted, state gone.
#   6. Delete the retained parameter and assert it is gone.
#
# Arm R (go-to-k/cdkd#4523), a second stack deployed by cdkd only:
#   R1. First deploy of `CdkdImportRollback` with INJECT_FAIL under
#       --no-rollback: fails, keeps a journal whose completed CREATE is the
#       explicitly named parameter `Named`.
#   R2. `cdkd orphan` drops `Named` from state; the parameter is deleted and
#       re-created BY HAND (the issue's flow), then `cdkd import --resource
#       Named=<name>` adopts it. The journal must mark `Named` as imported.
#   R3. `cdkd rollback --force`: exit 0, and the hand-made parameter is still
#       there with its hand-made value, still recorded in state; journal gone.
#   R3b. (go-to-k/cdkd#4552) A journal seeded from R2's: one failed CREATE of
#       Named naming a hand-made stray parameter, import mark stripped (as a
#       cdkd older than #4547 wrote it). `cdkd rollback --revert-failed
#       --force` must exit 2, name the stray parameter as needing manual
#       attention, and delete neither parameter.
#   R4. `cdkd destroy --force` deletes it; gone-probes.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-retain-destroy"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportRetainDestroy"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

# Arm R (go-to-k/cdkd#4523).
R_STACK="CdkdImportRollback"
R_NAME="${R_STACK}-named"
# Arm R3b (go-to-k/cdkd#4552): created by hand, never by a deploy.
R_STRAY="${R_STACK}-named-stray"
R_QUEUE="${R_STACK}-failing-queue"
R_STATE_KEY="cdkd/${R_STACK}/${REGION}/state.json"
R_JOURNAL_KEY="cdkd/${R_STACK}/${REGION}/rollback-journal.json"

# Captured after `cdk deploy`; empty until then so cleanup can read them under
# `set -u` when it fires earlier.
KEPT_NAME=""
GONE_NAME=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-retain-destroy.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

physical_of() {
  aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
    --query "StackResources[?LogicalResourceId==\`$1\`].PhysicalResourceId" --output text
}

cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${STACK}"
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    # A failure before the names were captured would leave `Kept` (Retain)
    # behind the delete-stack under a CFn-generated name nothing can find
    # later, so take the names now while the stack still lists them.
    [ -n "${KEPT_NAME}" ] || KEPT_NAME="$(physical_of Kept 2>/dev/null)"
    [ -n "${GONE_NAME}" ] || GONE_NAME="$(physical_of Gone 2>/dev/null)"
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  # Arm R: cdkd's destroy first, then whatever it could not name.
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${R_STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${R_STACK}"
    (cd "${TEST_DIR}" && ${CLI} destroy "${R_STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  aws ssm delete-parameter --name "${R_NAME}" --region "${REGION}" 2>/dev/null || true
  aws ssm delete-parameter --name "${R_STRAY}" --region "${REGION}" 2>/dev/null || true
  R_QUEUE_URL="$(aws sqs get-queue-url --queue-name "${R_QUEUE}" --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null)"
  [ -z "${R_QUEUE_URL}" ] || aws sqs delete-queue --queue-url "${R_QUEUE_URL}" --region "${REGION}" 2>/dev/null || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${R_STACK}/" --recursive --region "${REGION}" >/dev/null 2>&1 || true
  # Both parameters outlive a Retain-injected CFn delete, and `Kept` outlives
  # a correct cdkd destroy by design, so reap them by name.
  for n in "${KEPT_NAME}" "${GONE_NAME}"; do
    [ -n "${n}" ] || continue
    aws ssm delete-parameter --name "${n}" --region "${REGION}" 2>/dev/null || true
  done
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" 2>/dev/null || true
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 1: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
(cd "${TEST_DIR}" && { [ -x node_modules/.bin/cdk ] || npm install; })
export PATH="${TEST_DIR}/node_modules/.bin:${PATH}"
CDK_RESOLVED="$(command -v cdk)"
CDK_VERSION="$(cdk --version)"
echo "[verify] step 1 ok: using ${CDK_RESOLVED} (${CDK_VERSION})"

echo "[verify] step 2: pre-flight orphan scan"
if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: ${STACK} already exists — clean up first"
  exit 1
fi
if aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
  echo "[verify] FAIL: cdkd state ${STATE_KEY} already exists — clean up first"
  exit 1
fi
for key in "${R_STATE_KEY}" "${R_JOURNAL_KEY}"; do
  if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" --region "${REGION}"; then
    echo "[verify] FAIL: s3://${STATE_BUCKET}/${key} already exists — clean up first"
    exit 1
  fi
done
for n in "${R_NAME}" "${R_STRAY}"; do
  if ! gone_probe aws ssm get-parameter --name "${n}" --region "${REGION}"; then
    echo "[verify] FAIL: parameter ${n} already exists — clean up first"
    exit 1
  fi
done
if ! gone_probe aws sqs get-queue-url --queue-name "${R_QUEUE}" --region "${REGION}"; then
  echo "[verify] FAIL: queue ${R_QUEUE} already exists — clean up first"
  exit 1
fi

echo "[verify] step 3: cdk deploy (the CloudFormation stack to migrate)"
(cd "${TEST_DIR}" && cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")
KEPT_NAME="$(physical_of Kept)"
GONE_NAME="$(physical_of Gone)"
echo "[verify] step 3 ok: kept=${KEPT_NAME} gone=${GONE_NAME}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation"
(cd "${TEST_DIR}" && ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
KEPT_POLICY="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["resources"]["Kept"].get("deletionPolicy"))' "${WORK}/state.json")"
# Recorded, not exited on: step 5 then shows what destroy does with the
# record, which is the user-visible consequence.
POLICY_FAILED=0
if [ "${KEPT_POLICY}" != "Retain" ]; then
  echo "[verify] FAIL: imported Kept record has deletionPolicy=${KEPT_POLICY}, want Retain (issue #3645)"
  POLICY_FAILED=1
else
  echo "[verify] step 4 ok: Kept.deletionPolicy=Retain"
fi

echo "[verify] step 5: cdkd destroy --force with no deploy in between"
(cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
if gone_probe aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}"; then
  echo "[verify] FAIL: destroy deleted the DeletionPolicy: Retain parameter ${KEPT_NAME} (issue #3645)"
  exit 1
fi
assert_gone "parameter ${GONE_NAME} still exists after destroy" aws ssm get-parameter --name "${GONE_NAME}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
echo "[verify] step 5 ok: Retain parameter kept, the other deleted, state gone"
[ "${POLICY_FAILED}" = 0 ] || exit 1

echo "[verify] step 6: delete the retained parameter"
aws ssm delete-parameter --name "${KEPT_NAME}" --region "${REGION}"
assert_gone "retained parameter ${KEPT_NAME} still exists after its delete" aws ssm get-parameter --name "${KEPT_NAME}" --region "${REGION}"
echo "[verify] step 6 ok"

# ---------------------------------------------------------------------------
# Arm R (go-to-k/cdkd#4523): a rollback after an import must not delete the
# imported resource.
# ---------------------------------------------------------------------------
r_param_value() {
  aws ssm get-parameter --name "${R_NAME}" --region "${REGION}" --query Parameter.Value --output text
}

echo "[verify] step R1: first deploy of ${R_STACK} with INJECT_FAIL --no-rollback (expect FAILURE)"
R1_RC=0
(cd "${TEST_DIR}" && INJECT_FAIL=true ${CLI} deploy "${R_STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback) > "${WORK}/r1-deploy.log" 2>&1 || R1_RC=$?
if [ "${R1_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the INJECT_FAIL deploy of ${R_STACK} unexpectedly succeeded"
  exit 1
fi
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${R_JOURNAL_KEY}" --region "${REGION}"; then
  echo "[verify] FAIL: the failed deploy kept no rollback journal for ${R_STACK}"
  tail -n 40 "${WORK}/r1-deploy.log"
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${R_JOURNAL_KEY}" "${WORK}/r-journal.json" --region "${REGION}" >/dev/null
R_CREATE_PHYS="$(python3 -c '
import json, sys
ops = [op for seg in json.load(open(sys.argv[1]))["segments"] for op in seg["operations"]
       if op["logicalId"] == "Named" and op["changeType"] == "CREATE"]
print(ops[0].get("physicalId", "") if ops else "")' "${WORK}/r-journal.json")"
# The premise: the journal holds a completed CREATE whose physical id IS the
# name the import will adopt. Without it the rollback below decides nothing.
if [ "${R_CREATE_PHYS}" != "${R_NAME}" ]; then
  echo "[verify] FAIL: journal's completed CREATE of Named has physicalId '${R_CREATE_PHYS}', want '${R_NAME}'"
  exit 1
fi
echo "[verify] step R1 ok: deploy failed (rc=${R1_RC}), journal holds CREATE Named=${R_NAME}"

echo "[verify] step R2: orphan Named, re-create it by hand, cdkd import it"
(cd "${TEST_DIR}" && ${CLI} orphan "${R_STACK}/Named" --state-bucket "${STATE_BUCKET}" --force)
aws ssm delete-parameter --name "${R_NAME}" --region "${REGION}"
aws ssm put-parameter --name "${R_NAME}" --type String --value hand-made --region "${REGION}" >/dev/null
(cd "${TEST_DIR}" && ${CLI} import "${R_STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --resource "Named=${R_NAME}" \
  --yes)
aws s3 cp "s3://${STATE_BUCKET}/${R_JOURNAL_KEY}" "${WORK}/r-journal.json" --region "${REGION}" >/dev/null
R_MARKED="$(python3 -c '
import json, sys
want = {"logicalId": "Named", "physicalId": sys.argv[2], "resourceType": "AWS::SSM::Parameter"}
print(any(want in seg.get("importedResources", []) for seg in json.load(open(sys.argv[1]))["segments"]))' \
  "${WORK}/r-journal.json" "${R_NAME}")"
# Recorded, not exited on: step R3 then shows what the rollback does, which
# is the user-visible consequence.
R_MARK_FAILED=0
if [ "${R_MARKED}" != "True" ]; then
  echo "[verify] FAIL: the import did not mark Named as imported on the rollback journal (go-to-k/cdkd#4523)"
  R_MARK_FAILED=1
else
  echo "[verify] step R2 ok: journal marks Named as imported"
fi

echo "[verify] step R3: cdkd rollback ${R_STACK} --force (expect exit 0)"
(cd "${TEST_DIR}" && ${CLI} rollback "${R_STACK}" --state-bucket "${STATE_BUCKET}" --force) \
  > "${WORK}/r3-rollback.log" 2>&1 || { cat "${WORK}/r3-rollback.log"; echo "[verify] FAIL: rollback exited non-zero"; exit 1; }
cat "${WORK}/r3-rollback.log"
if gone_probe aws ssm get-parameter --name "${R_NAME}" --region "${REGION}"; then
  echo "[verify] FAIL: cdkd rollback DELETED the imported parameter ${R_NAME} (go-to-k/cdkd#4523)"
  exit 1
fi
R_VALUE="$(r_param_value)"
if [ "${R_VALUE}" != "hand-made" ]; then
  echo "[verify] FAIL: imported parameter value is '${R_VALUE}', want 'hand-made' (the rollback replaced it)"
  exit 1
fi
if ! grep -q "adopted by cdkd import" "${WORK}/r3-rollback.log"; then
  echo "[verify] FAIL: the rollback plan does not list Named as adopted by cdkd import"
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${R_STATE_KEY}" "${WORK}/r-state.json" --region "${REGION}" >/dev/null
R_STATE_PHYS="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["resources"].get("Named", {}).get("physicalId", ""))' "${WORK}/r-state.json")"
if [ "${R_STATE_PHYS}" != "${R_NAME}" ]; then
  echo "[verify] FAIL: after the rollback state records Named as '${R_STATE_PHYS}', want '${R_NAME}'"
  exit 1
fi
assert_gone "rollback journal still present after a clean rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${R_JOURNAL_KEY}" --region "${REGION}"
[ "${R_MARK_FAILED}" = 0 ] || exit 1
echo "[verify] step R3 ok: the imported parameter survived the rollback, still in state"

echo "[verify] step R3b: --revert-failed over an UNMARKED failed CREATE of another id (expect exit 2)"
# go-to-k/cdkd#4552. A failed CREATE that provisioned R_STRAY, then an import
# by a cdkd older than #4547 put R_NAME under Named and wrote no mark. No
# deploy produces a failed CREATE that recorded a physical id on demand, so
# the segment is seeded from R2's real journal: its operations emptied, one
# failed CREATE of Named naming R_STRAY added, and the import mark stripped
# (the shape an older binary leaves). R_STRAY is real, so "nothing is
# deleted" is observable.
aws ssm put-parameter --name "${R_STRAY}" --type String --value stray --region "${REGION}" >/dev/null
python3 -c '
import json, sys
j = json.load(open(sys.argv[1]))
seg = j["segments"][0]
named = [op for op in seg["operations"] if op["logicalId"] == "Named" and op["changeType"] == "CREATE"][0]
stray = sys.argv[2]
failed = {k: named[k] for k in ("logicalId", "changeType", "resourceType", "provisionedBy") if k in named}
failed["physicalId"] = stray
failed["attemptedProperties"] = dict(named.get("properties", {}), Name=stray)
seg["operations"] = []
seg["failedOperations"] = [failed]
seg.pop("importedResources", None)
seg.pop("supersededLogicalIds", None)
j["segments"] = [seg]
json.dump(j, open(sys.argv[3], "w"))' "${WORK}/r-journal.json" "${R_STRAY}" "${WORK}/r3b-journal.json"
# The premise, read back from what is uploaded: one unmarked failed CREATE of
# Named naming R_STRAY, while state names R_NAME.
R3B_PREMISE="$(python3 -c '
import json, sys
segs = json.load(open(sys.argv[1]))["segments"]
f = [op for s in segs for op in s.get("failedOperations", [])]
print(len(segs) == 1 and not segs[0].get("importedResources") and not segs[0]["operations"]
      and len(f) == 1 and f[0]["logicalId"] == "Named" and f[0]["changeType"] == "CREATE"
      and f[0]["physicalId"] == sys.argv[2])' "${WORK}/r3b-journal.json" "${R_STRAY}")"
if [ "${R3B_PREMISE}" != "True" ] || [ "${R_STATE_PHYS}" != "${R_NAME}" ]; then
  echo "[verify] FAIL: R3b premise: seeded journal shape ok=${R3B_PREMISE}, state Named='${R_STATE_PHYS}' (want '${R_NAME}')"
  exit 1
fi
aws s3 cp "${WORK}/r3b-journal.json" "s3://${STATE_BUCKET}/${R_JOURNAL_KEY}" \
  --content-type application/json --region "${REGION}" >/dev/null
R3B_RC=0
(cd "${TEST_DIR}" && ${CLI} rollback "${R_STACK}" --state-bucket "${STATE_BUCKET}" --revert-failed --force) \
  > "${WORK}/r3b-rollback.raw.log" 2>&1 || R3B_RC=$?
sed -E $'s/\x1b\\[[0-9;]*[A-Za-z]//g' "${WORK}/r3b-rollback.raw.log" > "${WORK}/r3b-rollback.log"
cat "${WORK}/r3b-rollback.log"
if [ "${R3B_RC}" -ne 2 ]; then
  echo "[verify] FAIL: rollback --revert-failed exited ${R3B_RC}, want 2 (a mismatched failed CREATE must warn, go-to-k/cdkd#4552)"
  exit 1
fi
if ! grep -F "recorded ${R_STRAY}, which is not the resource state tracks under this id" "${WORK}/r3b-rollback.log" | grep -q "needs manual attention"; then
  echo "[verify] FAIL: the plan does not name ${R_STRAY} as not tracked, needing manual attention"
  exit 1
fi
if grep -q "left nothing to revert" "${WORK}/r3b-rollback.log"; then
  echo "[verify] FAIL: the plan still says the failed CREATE left nothing to revert"
  exit 1
fi
if gone_probe aws ssm get-parameter --name "${R_STRAY}" --region "${REGION}"; then
  echo "[verify] FAIL: the rollback DELETED ${R_STRAY}, which state does not track"
  exit 1
fi
if gone_probe aws ssm get-parameter --name "${R_NAME}" --region "${REGION}" || [ "$(r_param_value)" != "hand-made" ]; then
  echo "[verify] FAIL: the rollback touched the tracked parameter ${R_NAME}"
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${R_STATE_KEY}" "${WORK}/r-state.json" --region "${REGION}" >/dev/null
R_STATE_PHYS="$(python3 -c '
import json, sys
print(json.load(open(sys.argv[1]))["resources"].get("Named", {}).get("physicalId", ""))' "${WORK}/r-state.json")"
if [ "${R_STATE_PHYS}" != "${R_NAME}" ]; then
  echo "[verify] FAIL: after the R3b rollback state records Named as '${R_STATE_PHYS}', want '${R_NAME}'"
  exit 1
fi
# A warned skip clears its segment (a re-run would skip it again).
assert_gone "rollback journal still present after the warned R3b rollback" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${R_JOURNAL_KEY}" --region "${REGION}"
aws ssm delete-parameter --name "${R_STRAY}" --region "${REGION}"
assert_gone "stray parameter ${R_STRAY} still exists after its delete" \
  aws ssm get-parameter --name "${R_STRAY}" --region "${REGION}"
echo "[verify] step R3b ok: warned, exit 2, ${R_STRAY} and ${R_NAME} untouched"

echo "[verify] step R4: cdkd destroy ${R_STACK}"
(cd "${TEST_DIR}" && ${CLI} destroy "${R_STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "parameter ${R_NAME} still exists after destroy" aws ssm get-parameter --name "${R_NAME}" --region "${REGION}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${R_STATE_KEY}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${R_STATE_KEY}" --region "${REGION}"
assert_gone "failing queue ${R_QUEUE} exists (CreateQueue should have rejected it)" \
  aws sqs get-queue-url --queue-name "${R_QUEUE}" --region "${REGION}"
echo "[verify] step R4 ok"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS"
