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

# Vendored cdk CLI (issue 1485): install the fixture's deps when absent
# (node_modules is gitignored, and the repo-root pnpm install does NOT
# populate fixture dirs), otherwise the PATH prepend is inert and `npx cdk`
# falls through to a possibly stale global CLI whose cloud-assembly schema
# no longer matches the fixture's aws-cdk-lib.
[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install
export PATH="${PWD}/node_modules/.bin:${PATH}"

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

IMPORT_LOG=""
cleanup() {
  rc=$?
  ( set +eu
    [ -n "${IMPORT_LOG}" ] && rm -f "${IMPORT_LOG}"
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
echo "==> Phase 2b: confirm the #1651 premise — CFn's table id is the BARE name"
# ---------------------------------------------------------------------------
# This is the whole reason the Glue pair is in this fixture. cdkd stores
# `<databaseName>|<tableName>`; CloudFormation stores the table name alone.
# Auto mode merges CFn's id into the overrides, so `importTable` receives the
# bare form. If AWS ever changes what DescribeStackResources reports here, this
# assertion must fail LOUDLY rather than let phase 4b silently test nothing.
CFN_TABLE_ID="$(aws cloudformation describe-stack-resources --region "${REGION}" \
  --stack-name "${STACK}" \
  --query 'StackResources[?ResourceType==`AWS::Glue::Table`]|[0].PhysicalResourceId' \
  --output text)"
CFN_DB_ID="$(aws cloudformation describe-stack-resources --region "${REGION}" \
  --stack-name "${STACK}" \
  --query 'StackResources[?ResourceType==`AWS::Glue::Database`]|[0].PhysicalResourceId' \
  --output text)"
for pair in "table:${CFN_TABLE_ID}" "database:${CFN_DB_ID}"; do
  kind="${pair%%:*}"
  value="${pair#*:}"
  if [ -z "${value}" ] || [ "${value}" = "None" ]; then
    echo "FAIL: could not resolve the Glue ${kind} physical id from the CloudFormation stack" >&2
    exit 1
  fi
done
case "${CFN_TABLE_ID}" in
  *"|"*)
    echo "FAIL: CloudFormation reported a COMPOSITE table id (${CFN_TABLE_ID})." >&2
    echo "      #1651 assumes CFn's id is the bare table name; if that changed," >&2
    echo "      resolveTableIdentity's discriminator must be revisited." >&2
    exit 1
    ;;
esac
# Assert by the AWS NAME rather than by the construct id: the two matching is
# a coincidence of this fixture, not a contract.
if [ "${CFN_TABLE_ID}" != "cdkd_import_auto_mode_table" ]; then
  echo "FAIL: unexpected CFn table id: ${CFN_TABLE_ID}" >&2
  exit 1
fi
echo "    cfn table id=${CFN_TABLE_ID} (bare), database=${CFN_DB_ID}"
echo "==> Phase 2b ok: CFn's table physicalId is the bare name, not cdkd's composite"

# ---------------------------------------------------------------------------
echo "==> Phase 3: cdkd import ${STACK} — AUTO mode, no override flags"
# ---------------------------------------------------------------------------
# Deliberately NO --resource and NO --migrate-from-cloudformation. Note also
# that `import` is the one command that does not accept --region (see #1097),
# so the region rides on AWS_REGION.
IMPORT_LOG="$(mktemp)"  # removed by cleanup() on failure, explicitly at the end on success
AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes \
  --verbose 2>&1 | tee "${IMPORT_LOG}"
# `set -o pipefail` is on, so a non-zero import still aborts here despite tee.

# Assert the CloudFormation lookup seeded ALL THREE ids, not just the policy.
# Without this the fixture has a hole: if `mergeCfnDerivedOverrides` stopped
# seeding the TABLE while still seeding the database, `importTable`'s template
# fallback would produce the identical composite and phase 4b would stay green
# while the path under test was no longer exercised.
# The literal 3 is bound to this fixture's importable inventory: the
# ManagedPolicy, the Glue Database, and the Glue Table. (`AWS::CDK::Metadata`
# is filtered out by `mergeCfnDerivedOverrides`, so it never counts.) A COUNT is
# not an identity — if a 4th importable resource is ever added here, this
# assertion stops implying the TABLE was seeded and must be tightened or the
# hole it closes reopens. There is no per-logical-id line to grep instead: the
# auto-mode log omits the `formatCfnOverrideMergeDetail` the migration path
# emits.
if ! grep -qE "Resolved 3 physical ID\(s\) from CloudFormation stack" "${IMPORT_LOG}"; then
  echo "FAIL: import did not resolve all 3 physical ids from CloudFormation." >&2
  echo "      Without the CFn-derived override for the table, phase 4b passes" >&2
  echo "      via the template fallback and tests nothing (#1651)." >&2
  grep -iE "Resolved .* physical|Summary:" "${IMPORT_LOG}" >&2 || true
  exit 1
fi
if ! grep -qE "3 imported, 0 not found" "${IMPORT_LOG}"; then
  echo "FAIL: import summary is not '3 imported, 0 not found'" >&2
  grep -iE "Summary:" "${IMPORT_LOG}" >&2 || true
  exit 1
fi
echo "==> Phase 3 ok: import exited 0, all 3 ids resolved from CloudFormation"

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
echo "==> Phase 4b: assert the Glue table was adopted under cdkd's COMPOSITE id"
# ---------------------------------------------------------------------------
# Two distinct failures are being fenced here, and asserting only that import
# exited 0 would catch NEITHER:
#   1. pre-#1651, the table was reported `skipped-not-found` and never landed
#      in state at all — so the row is simply absent;
#   2. a fix that recorded CloudFormation's BARE name would produce a row that
#      looks adopted while every other method on the provider (update / delete
#      / getAttribute / readCurrentState) splits the stored id on `|` and gets
#      an undefined second segment. That is a silent failure, which is worse
#      than the visible one it replaced.
GLUE_ROWS="$(printf '%s' "${STATE_JSON}" | python3 -c '
import sys, json
res = json.load(sys.stdin)["state"]["resources"]
want = ["AWS::Glue::Database", "AWS::Glue::Table"]
hits = {}
for row in res.values():
    if row["resourceType"] in want:
        hits.setdefault(row["resourceType"], []).append(row["physicalId"])
for t in want:
    got = hits.get(t, [])
    if len(got) != 1:
        sys.exit(f"expected exactly 1 imported {t} row, got {len(got)}; state rows: {sorted(res)}")
    print(got[0])
')"
IMPORTED_DB="$(printf '%s\n' "${GLUE_ROWS}" | sed -n 1p)"
IMPORTED_TABLE="$(printf '%s\n' "${GLUE_ROWS}" | sed -n 2p)"

if [ "${IMPORTED_DB}" != "${CFN_DB_ID}" ]; then
  echo "FAIL: Glue database physicalId mismatch" >&2
  echo "      expected: ${CFN_DB_ID}" >&2
  echo "      actual:   ${IMPORTED_DB}" >&2
  exit 1
fi

EXPECTED_TABLE_ID="${CFN_DB_ID}|${CFN_TABLE_ID}"
if [ "${IMPORTED_TABLE}" != "${EXPECTED_TABLE_ID}" ]; then
  echo "FAIL: Glue table was not adopted under cdkd's composite physicalId" >&2
  echo "      expected: ${EXPECTED_TABLE_ID}" >&2
  echo "      actual:   ${IMPORTED_TABLE}" >&2
  echo "      (a bare table name here means the id was recorded in" >&2
  echo "       CloudFormation's shape, which the provider cannot split — #1651)" >&2
  exit 1
fi
echo "==> Phase 4b ok: table adopted as ${IMPORTED_TABLE}, database as ${IMPORTED_DB}"

# ---------------------------------------------------------------------------
echo "==> Phase 5: cdkd destroy + assert the policy is gone"
# ---------------------------------------------------------------------------
AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "policy ${POLICY_ARN} still exists after destroy" \
  aws iam get-policy --policy-arn "${POLICY_ARN}"

# The destroy half of #1651: a composite id that round-trips through state must
# still split correctly on the way OUT. A table adopted under the wrong id
# shape would fail here rather than leak silently.
assert_gone "glue table ${CFN_TABLE_ID} still exists after destroy" \
  aws glue get-table --region "${REGION}" \
  --database-name "${CFN_DB_ID}" --name "${CFN_TABLE_ID}"

assert_gone "glue database ${CFN_DB_ID} still exists after destroy" \
  aws glue get-database --region "${REGION}" --name "${CFN_DB_ID}"

assert_gone "state.json still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" \
  --key "cdkd/${STACK}/${REGION}/state.json"

# cdkd adopted and then deleted the resources, so the CloudFormation stack is
# left holding references to things that no longer exist. Drop it explicitly —
# leaving it behind would fail the next run's pre-flight.
#
# The exit code is discarded on purpose (CFn can report a failure while still
# reaching DELETE_COMPLETE for a stack whose resources are already gone), but
# the OUTCOME is then asserted: without the assertion a DELETE_FAILED would be
# swallowed and the run would print "All checks passed" over a leftover stack,
# pushing the failure onto the NEXT run's pre-flight where it reads as an
# unrelated "already exists".
npx cdk destroy "${STACK}" --force >/dev/null 2>&1 || true

assert_gone "CloudFormation stack ${STACK} still exists after cdk destroy" \
  aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK}"

trap - EXIT INT TERM
# Disarming the trap is what makes the success path skip cleanup(), so the
# import log has to be removed explicitly here — otherwise every GREEN run
# leaves a mktemp file behind, which is the one leak a passing run can produce.
rm -f "${IMPORT_LOG}"
echo ""
echo "==> All import-auto-mode checks passed"
