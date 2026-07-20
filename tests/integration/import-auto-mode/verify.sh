#!/usr/bin/env bash
#
# `cdkd import` AUTO mode against a CloudFormation-generated physical name
# (issue #1128).
#
# The point of this fixture is the path it does NOT let you take. Auto mode
# resolves physical ids in stages — the template's name property, then an
# `aws:cdk:path` tag walk, then (since #1128) a CloudFormation
# `DescribeStackResources` lookup. The tag stage cannot match on real AWS: AWS
# rejects any `aws:`-prefixed tag write, and CloudFormation keeps the value in
# the template's resource `Metadata` without promoting it to a tag.
#
# So this script deliberately:
#   - deploys with UPSTREAM `cdk deploy` (the advertised adoption scenario),
#   - against a stack whose policy has NO explicit physical name, and
#   - runs `cdkd import` with NEITHER `--resource` NOR
#     `--migrate-from-cloudformation`.
#
# Adding any of those would re-create the blind spot: both pre-existing import
# integs pass one of them, which is why this bug survived four rounds of
# `importTagWalk` work (#1091).
#
# Pre-#1128 expected output here was `0 imported, 1 not found`.
set -euo pipefail
cd "$(dirname "$0")"

STACK="CdkdImportAutoModeExample"
REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: built CLI not found at ${LOCAL_DIST} — run 'vp run build' from the repo root" >&2
  exit 1
fi

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

cleanup() {
  rc=$?
  ( set +eu
    echo "==> Cleanup: dropping cdkd state + the CloudFormation stack"
    node "${LOCAL_DIST}" state orphan "${STACK}" --state-bucket "${STATE_BUCKET}" --yes >/dev/null 2>&1
    npx cdk destroy "${STACK}" --force >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1
  )
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# ---------------------------------------------------------------------------
echo "==> Pre-flight: no leftovers from an earlier run"
# ---------------------------------------------------------------------------
if aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK}" >/dev/null 2>&1; then
  echo "FAIL: CloudFormation stack ${STACK} already exists — clean it up first" >&2
  exit 1
fi
echo "==> Pre-flight ok"

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy with UPSTREAM cdk deploy (the adoption scenario)"
# ---------------------------------------------------------------------------
npx cdk deploy "${STACK}" --require-approval never
echo "==> Phase 1 ok: cdk deploy exited 0"

# ---------------------------------------------------------------------------
echo "==> Phase 2: confirm the premise — CFn-generated name, and NO aws:cdk:path tag"
# ---------------------------------------------------------------------------
POLICY_ARN="$(aws cloudformation describe-stack-resources --region "${REGION}" \
  --stack-name "${STACK}" \
  --query 'StackResources[?ResourceType==`AWS::IAM::ManagedPolicy`]|[0].PhysicalResourceId' \
  --output text)"
if [ -z "${POLICY_ARN}" ] || [ "${POLICY_ARN}" = "None" ]; then
  echo "FAIL: could not resolve the policy ARN from the CloudFormation stack" >&2
  exit 1
fi
echo "    policy=${POLICY_ARN}"

# The name must be CloudFormation-generated. CFn builds it as
# `<Stack>-<LogicalId>-<random>`, and CDK's logical id already carries its own
# hash (`Policy23B91518`), so there is NO dash directly after `Policy`. If a
# future edit adds an explicit `managedPolicyName`, the name stage would resolve
# it and this fixture would stop testing anything.
case "${POLICY_ARN}" in
  *"${STACK}-Policy"*) ;;
  *)
    echo "FAIL: policy name is not CloudFormation-generated (${POLICY_ARN})." >&2
    echo "      This fixture is only meaningful without an explicit physical name." >&2
    exit 1
    ;;
esac

CDK_PATH_TAG="$(aws iam list-policy-tags --policy-arn "${POLICY_ARN}" \
  --query 'Tags[?Key==`aws:cdk:path`].Value' --output text)"
if [ -n "${CDK_PATH_TAG}" ]; then
  echo "FAIL: the policy carries an aws:cdk:path tag (${CDK_PATH_TAG})." >&2
  echo "      AWS is documented to reject aws:-prefixed tags; if this ever" >&2
  echo "      becomes possible the tag walk is viable again and #1128's" >&2
  echo "      CloudFormation lookup should be revisited." >&2
  exit 1
fi
echo "==> Phase 2 ok: CFn-generated name, no aws:cdk:path tag (tag walk cannot match)"

# ---------------------------------------------------------------------------
echo "==> Phase 3: cdkd import ${STACK} — AUTO mode, no override flags"
# ---------------------------------------------------------------------------
# Deliberately NO --resource and NO --migrate-from-cloudformation. Note also
# that `import` is the one command that does not accept --region (see #1097),
# so the region rides on AWS_REGION.
AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes \
  --verbose
echo "==> Phase 3 ok: import exited 0"

# ---------------------------------------------------------------------------
echo "==> Phase 4: assert the resource was actually adopted"
# ---------------------------------------------------------------------------
STATE_JSON="$(AWS_REGION="${REGION}" node "${LOCAL_DIST}" state show "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --json)"
# Look the row up by resource TYPE, not by a hardcoded logical id: CDK hashes
# construct ids (`Policy` synthesizes as `Policy23B91518`), so a literal key
# would break on any construct rename.
IMPORTED="$(printf '%s' "${STATE_JSON}" | python3 -c '
import sys, json
res = json.load(sys.stdin)["state"]["resources"]
hits = [r["physicalId"] for r in res.values() if r["resourceType"] == "AWS::IAM::ManagedPolicy"]
if len(hits) != 1:
    sys.exit(f"expected exactly 1 imported ManagedPolicy row, got {len(hits)}: {list(res)}")
print(hits[0])
')"

if [ "${IMPORTED}" != "${POLICY_ARN}" ]; then
  echo "FAIL: state physicalId mismatch" >&2
  echo "      expected: ${POLICY_ARN}" >&2
  echo "      actual:   ${IMPORTED}" >&2
  exit 1
fi
echo "==> Phase 4 ok: Policy adopted as ${IMPORTED}"

# ---------------------------------------------------------------------------
echo "==> Phase 5: cdkd destroy + assert the policy is gone"
# ---------------------------------------------------------------------------
AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"

assert_gone "state.json still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" \
  --key "cdkd/${STACK}/${REGION}/state.json"

# cdkd adopted and then deleted the resources, so the CloudFormation stack is
# left holding references to things that no longer exist. Drop it explicitly —
# leaving it behind would fail the next run's pre-flight.
npx cdk destroy "${STACK}" --force >/dev/null 2>&1 || true

trap - EXIT INT TERM
echo ""
echo "==> All import-auto-mode checks passed"
