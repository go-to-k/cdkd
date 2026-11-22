#!/usr/bin/env bash
#
# End-to-end real-AWS validation that a CDK change made AFTER the last
# `cdk deploy` survives `cdkd import --migrate-from-cloudformation` as a
# pending change, exactly as the next `cdk deploy` would apply it
# (issue #6840), and that the role's inline `AWS::IAM::Policy` is recorded
# under its policy name rather than CloudFormation's generated id (#6841).
#
# Flow:
#   1. Build cdkd; install the fixture's pinned aws-cdk.
#   2. Pre-flight: no CloudFormation stack, no cdkd state.
#   3. `cdk deploy` WITHOUT CDKD_TEST_UPDATE: the trust condition holds ONE
#      `aws:SourceArn` pattern.
#   4. `cdkd import --migrate-from-cloudformation --yes` WITH
#      CDKD_TEST_UPDATE=true (the code now widens it to TWO). State must record
#      the ONE pattern AWS holds, and the policy's physicalId must be the
#      inline policy's name.
#   5. `cdkd diff` shows the widening as an UPDATE of the role, and only that.
#   6. `cdkd drift` is clean (no DELETED policy) and
#      `cdkd state refresh-observed --yes` succeeds.
#   7. `cdkd deploy` applies it: `aws iam get-role` holds TWO patterns, and the
#      next diff and drift are clean.
#   8. `cdkd destroy --force`; gone-probes for the role and the state file.
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

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/import-migrate-pending-change"
CLI="node ${REPO_ROOT}/dist/cli.js"

STACK="CdkdImportMigratePendingChangeExample"
ROLE_NAME="cdkd-integ-pending-change-${REGION}"
ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

WORK="$(mktemp -d "${TMPDIR:-/tmp}/cdkd-import-migrate-pending-change.XXXXXX")"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The import writes cdkd state BEFORE it retires the CloudFormation stack, so
# one of the two owns the role at every point: destroy through whichever holds
# it. The role's name is fixed, so a run that lost both records still leaves a
# deterministic name to sweep.
cleanup() {
  rc=$?
  set +eu
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting cleanup"
  fi
  if [ -f "${REPO_ROOT}/dist/cli.js" ] && aws s3api head-object \
      --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: cdkd destroy ${STACK}"
    (cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force 2>&1) || true
  fi
  if aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1; then
    echo "[verify] cleanup: aws cloudformation delete-stack ${STACK}"
    aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" || true
    aws cloudformation wait stack-delete-complete --stack-name "${STACK}" --region "${REGION}" || true
  fi
  if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
    echo "[verify] cleanup: deleting leftover role ${ROLE_NAME}"
    for policy in $(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames' --output text); do
      aws iam delete-role-policy --role-name "${ROLE_NAME}" --policy-name "${policy}" || true
    done
    aws iam delete-role --role-name "${ROLE_NAME}" || true
  fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# The role's live `aws:SourceArn` condition, as a JSON value.
live_source_arns() {
  aws iam get-role --role-name "${ROLE_NAME}" \
    --query 'Role.AssumeRolePolicyDocument.Statement[0].Condition.StringLike."aws:SourceArn"' \
    --output json
}

# Prints the `cdkd diff --json` verdict for this stack: `undetermined: ...`,
# `no-change`, or the sorted `logicalId:changeType` list of changed resources.
diff_verdict() {
  python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception as exc:  # noqa: BLE001 - any parse failure is undetermined
    print("undetermined: %s" % exc)
    sys.exit(0)
if not isinstance(payload, list) or not payload:
    print("undetermined: empty diff payload")
    sys.exit(0)
changes = sorted(
    "%s:%s" % (change.get("logicalId", ""), change.get("changeType", ""))
    for node in payload
    for change in node.get("changes", [])
)
print(" ".join(changes) if changes else "no-change")
' "$1"
}

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
if ! gone_probe aws iam get-role --role-name "${ROLE_NAME}"; then
  echo "[verify] FAIL: role ${ROLE_NAME} already exists — clean up first"
  exit 1
fi

echo "[verify] step 3: cdk deploy WITHOUT the code change (one SourceArn pattern)"
(cd "${TEST_DIR}" && env -u CDKD_TEST_UPDATE cdk deploy "${STACK}" \
  --require-approval never \
  --no-version-reporting \
  --no-asset-metadata \
  --no-path-metadata \
  --region "${REGION}")
LIVE_BEFORE="$(live_source_arns)"
LIVE_BEFORE_KIND="$(python3 -c 'import json, sys; v = json.loads(sys.argv[1]); print("string" if isinstance(v, str) else "other: %r" % (v,))' "${LIVE_BEFORE}")"
if [ "${LIVE_BEFORE_KIND}" != "string" ]; then
  echo "[verify] FAIL: after cdk deploy the trust condition is ${LIVE_BEFORE_KIND}, expected one string pattern"
  exit 1
fi
POLICY_NAME="$(aws iam list-role-policies --role-name "${ROLE_NAME}" --query 'PolicyNames' --output json \
  | python3 -c 'import json, sys; names = json.load(sys.stdin); print(names[0] if len(names) == 1 else "EXPECTED-ONE-INLINE-POLICY-GOT-%d" % len(names))')"
CFN_POLICY_ID="$(aws cloudformation describe-stack-resources --stack-name "${STACK}" --region "${REGION}" \
  --query 'StackResources[?ResourceType==`AWS::IAM::Policy`].PhysicalResourceId | [0]' --output text)"
case "${POLICY_NAME}" in
  TrustRoleDefaultPolicy?*) ;;
  *) echo "[verify] FAIL: the role's inline policy is '${POLICY_NAME}', expected TrustRoleDefaultPolicy*"; exit 1 ;;
esac
# #6841's premise: CloudFormation's id for the policy is not its name. Were it
# equal, the policy-id assertion in step 4 would pass on the pre-fix code too.
if [ "${CFN_POLICY_ID}" = "${POLICY_NAME}" ]; then
  echo "[verify] FAIL: CloudFormation's PhysicalResourceId for the policy equals its name, so step 4 cannot discriminate #6841"
  exit 1
fi
echo "[verify] step 3 ok: live SourceArn=${LIVE_BEFORE}, policy=${POLICY_NAME}, CloudFormation id=${CFN_POLICY_ID}"

echo "[verify] step 4: cdkd import --migrate-from-cloudformation WITH the code change"
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --migrate-from-cloudformation \
  --yes) 2>&1 | tee "${WORK}/import.log"
PLAIN_IMPORT="$(sed 's/\x1b\[[0-9;]*m//g' "${WORK}/import.log")"
SUMMARY="$(printf '%s\n' "${PLAIN_IMPORT}" | grep -E '^Summary: ' | tail -1)"
if [ -z "${SUMMARY}" ]; then
  echo "[verify] FAIL: the import printed no 'Summary:' line (its wording changed?)"
  exit 1
fi
echo "[verify] import ${SUMMARY}"
if ! grep -q ' 0 not found' <<<"${SUMMARY}" || ! grep -q ' 0 failed' <<<"${SUMMARY}"; then
  echo "[verify] FAIL: the import did not adopt every resource"
  exit 1
fi
if grep -q 'Failed to resolve intrinsics' <<<"${PLAIN_IMPORT}"; then
  echo "[verify] FAIL: the import left an unresolved intrinsic"
  exit 1
fi
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${WORK}/state.json" --region "${REGION}" >/dev/null
STATE_VERDICT="$(python3 -c '
import json, sys
resources = json.load(open(sys.argv[1]))["resources"]
def one(resource_type):
    found = [v for v in resources.values() if v.get("resourceType") == resource_type]
    return found[0] if len(found) == 1 else None
role, policy = one("AWS::IAM::Role"), one("AWS::IAM::Policy")
if role is None or policy is None:
    print("expected one role and one policy in state")
    sys.exit(0)
recorded = role["properties"]["AssumeRolePolicyDocument"]["Statement"][0]["Condition"]["StringLike"]["aws:SourceArn"]
if recorded != json.loads(sys.argv[2]):
    print("role records SourceArn %r, AWS holds %s" % (recorded, sys.argv[2]))
elif policy["physicalId"] != sys.argv[3]:
    print("policy recorded as %r, its name is %r" % (policy["physicalId"], sys.argv[3]))
else:
    print("ok")
' "${WORK}/state.json" "${LIVE_BEFORE}" "${POLICY_NAME}")"
if [ "${STATE_VERDICT}" != "ok" ]; then
  echo "[verify] FAIL: ${STATE_VERDICT} (issues #6840 / #6841)"
  exit 1
fi
echo "[verify] step 4 ok: state records the deployed trust condition and the policy name"

echo "[verify] step 5: cdkd diff shows the pending widening"
set +e
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --json) > "${WORK}/diff1.json" 2>"${WORK}/diff1.err"
DIFF_RC=$?
set -e
DIFF1="$(diff_verdict "${WORK}/diff1.json")"
if ! grep -qE '^TrustRole[0-9A-F]{8}:UPDATE$' <<<"${DIFF1}"; then
  tail -20 "${WORK}/diff1.err" >&2 || true
  echo "[verify] FAIL: after the migration cdkd diff reported '${DIFF1}' (exit ${DIFF_RC}); expected only the role's UPDATE (issue #6840)"
  exit 1
fi
echo "[verify] step 5 ok: ${DIFF1}"

echo "[verify] step 6: cdkd drift is clean; state refresh-observed succeeds"
set +e
(cd "${TEST_DIR}" && ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}") > "${WORK}/drift1.log" 2>&1
DRIFT_RC=$?
set -e
cat "${WORK}/drift1.log"
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "[verify] FAIL: cdkd drift exited ${DRIFT_RC} right after the migration (issue #6841: a policy recorded under CloudFormation's id reads as DELETED)"
  exit 1
fi
(cd "${TEST_DIR}" && ${CLI} state refresh-observed "${STACK}" --state-bucket "${STATE_BUCKET}" --yes)
echo "[verify] step 6 ok: drift exit 0, refresh-observed succeeded"

echo "[verify] step 7: cdkd deploy applies the widening"
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}") 2>&1 | tee "${WORK}/deploy.log"
LIVE_AFTER="$(live_source_arns)"
LIVE_AFTER_COUNT="$(python3 -c 'import json, sys; v = json.loads(sys.argv[1]); print(len(v) if isinstance(v, list) else "not-a-list: %r" % (v,))' "${LIVE_AFTER}")"
if [ "${LIVE_AFTER_COUNT}" != "2" ]; then
  echo "[verify] FAIL: after cdkd deploy the trust condition is ${LIVE_AFTER} (${LIVE_AFTER_COUNT}), expected two patterns (issue #6840)"
  exit 1
fi
set +e
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --json) > "${WORK}/diff2.json" 2>"${WORK}/diff2.err"
set -e
DIFF2="$(diff_verdict "${WORK}/diff2.json")"
if [ "${DIFF2}" != "no-change" ]; then
  tail -20 "${WORK}/diff2.err" >&2 || true
  echo "[verify] FAIL: after the deploy cdkd diff reported '${DIFF2}', expected no-change"
  exit 1
fi
(cd "${TEST_DIR}" && ${CLI} drift "${STACK}" --state-bucket "${STATE_BUCKET}")
echo "[verify] step 7 ok: live SourceArn holds two patterns; diff and drift clean"

echo "[verify] step 8: cdkd destroy --force"
(cd "${TEST_DIR}" && CDKD_TEST_UPDATE=true ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
assert_gone "role ${ROLE_NAME} still exists after destroy" aws iam get-role --role-name "${ROLE_NAME}"
assert_gone "cdkd state still present at s3://${STATE_BUCKET}/${STATE_KEY}" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" --region "${REGION}"
assert_gone "CloudFormation stack ${STACK} still exists" aws cloudformation describe-stacks --stack-name "${STACK}" --region "${REGION}"
echo "[verify] step 8 ok: role, state and CloudFormation stack gone"

trap - EXIT INT TERM
rm -rf "${WORK}"
echo "[verify] PASS — a post-deploy code change survives the migration as a pending diff and deploys"
