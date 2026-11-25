#!/bin/bash
# cdkd integration test: AWS::CodeBuild::Project removal semantics (issue #1160
# codebuild batch).
#
# Deploys a project carrying BuildBatchConfig plus the seven optional
# UpdateProject fields a live CFn A/B (2026-08-10) proved CloudFormation
# RETAINS on removal. Then re-deploys with CDKD_TEST_REMOVAL=true, which drops
# ALL EIGHT from the template, and asserts the asymmetry cdkd now matches:
#
#   * BuildBatchConfig must be GONE  -- CFn resets it, so cdkd sends the
#     empty-object clear that UpdateProject requires (an omitted field is a
#     merge no-op, which is the silent drop this issue tracks).
#   * The other seven must be UNCHANGED -- CFn retains them, so cdkd's
#     pass-through is parity. Asserting these is what stops an over-eager
#     provider that reset everything from passing this fixture.
#
# Phase 1 also declares `Visibility: PUBLIC_READ` + `ResourceAccessRole`
# (go-to-k/cdkd#2762), sent through UpdateProjectVisibility; Phase 2 drops both
# and asserts the PRIVATE / no-role reset CloudFormation applies. It also
# declares `EncryptionKey` + `Tags`, and Phase 2 asserts the managed-key reset
# and the tag removal CloudFormation applies (go-to-k/cdkd#1160).
#
# Phase 1 also declares `VpcConfig`, `FileSystemLocations`, `SecondarySources`,
# `SecondarySourceVersions`, `SecondaryArtifacts` and `BadgeEnabled`; Phase 2
# drops all six and asserts they are still live, which is what CloudFormation
# does (CFn A/B, go-to-k/cdkd#5492).
#
# Then destroys and confirms a clean teardown.
#
# Phase 1b moves the deployed project onto Cloud Control with
# `--recreate-via-cc-api` (refused while the type had no Cloud Control
# handlers, issue #3887) and back with `--recreate-via-sdk-provider`.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdCodeBuildProjectExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

PROJECT_NAME="${STACK}-batch"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  # `set +eu` so an early-exit (e.g. STATE_BUCKET unset) does not abort
  # cleanup on the first `"${STATE_BUCKET}"` expansion -- best-effort cleanup
  # should run as much as it can with the env it has.
  set +eu
  state_destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    # `--state-bucket` is REQUIRED here: without it the command resolves
    # cdk.json's placeholder `cdkd-state-test` (the harness exports
    # STATE_BUCKET, not CDKD_STATE_BUCKET), silently targets a nonexistent
    # bucket, and a torn run leaks every resource the raw sweep below does
    # not name.
    node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" \
      --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1
    state_destroy_rc=$?
  fi
  # Raw sweep for what a torn run can strand. The project is swept by its
  # fixed name. The go-to-k/cdkd#5492 scaffolding (VPC, subnet, security group,
  # secondary-artifact bucket) is swept ONLY by the physical ids this run read
  # from its own state after Phase 1, never by a name pattern, so a parallel
  # run's resources are never touched. Order: project (references the SG and
  # subnet), then SG and subnet, then the VPC. The bucket is never written to
  # (no build runs), so a plain `rb` suffices. The role goes with the stack.
  aws codebuild delete-project --name "${PROJECT_NAME}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${SG_ID:-}" ] && aws ec2 delete-security-group --group-id "${SG_ID}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${SUBNET_ID:-}" ] && aws ec2 delete-subnet --subnet-id "${SUBNET_ID}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${VPC_ID:-}" ] && aws ec2 delete-vpc --vpc-id "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${ARTIFACT_BUCKET:-}" ] && aws s3 rb "s3://${ARTIFACT_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    # state.json is gated on the destroy SUCCEEDING: it is the only pointer to
    # resources a failed destroy left behind, so removing it on failure turns a
    # recoverable partial teardown into untracked orphans.
    if [ "${state_destroy_rc:-1}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # lock.json is swept UNCONDITIONALLY. It points at nothing, and a lock
    # stranded by a force-quit makes `state destroy` itself exit non-zero --
    # so gating the lock sweep on that rc would suppress the very cleanup that
    # unsticks the fixture, wedging the next run's deploy until the lock TTL
    # expires.
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} -- run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# `batch-get-projects` returns a projects[] / projectsNotFound[] pair rather
# than erroring on a missing name, so a plain jq read on projects[0] would
# yield `null` for BOTH "field absent" and "project absent". Read the field
# only after asserting the project itself came back.
project_field() { # usage: project_field <jq-path>
  aws codebuild batch-get-projects --names "${PROJECT_NAME}" --region "${REGION}" \
    --output json | jq -r "if (.projects | length) == 0 then
        \"FAIL-PROJECT-NOT-FOUND\" else (.projects[0] | $1 | tostring) end"
}

assert_field() { # usage: assert_field <description> <jq-path> <expected>
  local desc="$1" path="$2" want="$3" got
  got="$(project_field "${path}")"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: ${desc}: expected '${want}', got '${got}'" >&2
    exit 1
  fi
  echo "    ok: ${desc} = ${got}"
}

# go-to-k/cdkd#1160: Phase 1 declares the AWS managed S3 key by its KEY ARN,
# which reads back as that ARN; the removal reset reads back as the ALIAS ARN.
# DescribeKey on an AWS managed alias creates the key if the account lacks it.
CDKD_INTEG_CB_KEY_ARN="$(aws kms describe-key --key-id alias/aws/s3 --region "${REGION}" \
  --query 'KeyMetadata.Arn' --output text)"
case "${CDKD_INTEG_CB_KEY_ARN}" in
  arn:aws*:kms:*:key/?*) ;;
  *) echo "FAIL: could not resolve the aws/s3 managed key ARN (got '${CDKD_INTEG_CB_KEY_ARN}')" >&2; exit 1 ;;
esac
export CDKD_INTEG_CB_KEY_ARN

# go-to-k/cdkd#6609: the baseline captured right after a member write (a
# policy or setting a separate call puts on the resource) matches the settled
# resource, so drift compares that member and finds nothing. Drift elsewhere
# (exit 1) or an incomplete comparison of another type (exit 2) is not this
# check's subject; only the member's path on the named type is read off the
# report. The phase's env goes after the label, as `env` arguments.
check_member_baseline() { # usage: check_member_baseline <type> <key> <phase label> [env args...]
  local type="$1" key="$2" label="$3" report rc=0
  shift 3
  report=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${report}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report after ${label}" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  if ! jq -e --arg stack "${STACK}" --arg type "${type}" --arg key "${key}" '
    def member: .path == $key or (.path | startswith($key + ".")) or (.path | startswith($key + "["));
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[], ($reports[0].drifted // [])[] | select(.type == $type)] | length) >= 1 and
    ([($reports[0].drifted // [])[] | select(.type == $type) | .changes[] | select(member)] | length) == 0 and
    ([($reports[0].notCompared // [])[] | select(.type == $type)] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: ${type} ${key} is drifted, or a ${type} is not compared, after ${label} (#6609)" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: every ${type} ${key} is drift-clean after ${label} (#6609)"
}

# go-to-k/cdkd#6609: drift alone cannot see a stale baseline while the live
# member is the declared one (the drift heal rule skips the key then), so this
# reads the baseline itself. The state record's observed member must be
# exactly what AWS holds now, key order aside ('<absent>' when neither holds
# one); a baseline captured before the write showed fails here.
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }
state_lids() { # usage: state_lids <resourceType> -- every logical id of that type
  state_json | jq -r --arg t "$1" '.resources | to_entries[] | select(.value.resourceType == $t) | .key'
}
state_field() { # usage: state_field <logical-id> <jq path into the record>
  state_json | jq -r --arg l "$1" ".resources[\$l] | $2"
}
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

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 1: assert every optional field landed"
assert_field "buildBatchConfig.timeoutInMins"  '.buildBatchConfig.timeoutInMins' '120'
assert_field "buildBatchConfig.combineArtifacts" '.buildBatchConfig.combineArtifacts' 'true'
assert_field "description"                     '.description'            'cdkd-integ-description'
assert_field "timeoutInMinutes"                '.timeoutInMinutes'       '25'
assert_field "queuedTimeoutInMinutes"          '.queuedTimeoutInMinutes' '100'
assert_field "concurrentBuildLimit"            '.concurrentBuildLimit'   '2'
assert_field "autoRetryLimit"                  '.autoRetryLimit'         '3'
assert_field "cache.type"                      '.cache.type'             'LOCAL'
assert_field "logsConfig.cloudWatchLogs.status" '.logsConfig.cloudWatchLogs.status' 'DISABLED'
# go-to-k/cdkd#1160 baselines, so the Phase 2 resets cannot pass vacuously.
assert_field "encryptionKey (the managed key's KEY ARN)" '.encryptionKey' "${CDKD_INTEG_CB_KEY_ARN}"
assert_field "user tags"                       '[.tags[]? | select(.key | startswith("aws:") | not) | "\(.key)=\(.value)"] | join(",")' 'cdkd-integ-tag=phase1'
# go-to-k/cdkd#5492 baselines: the six fields CloudFormation KEEPS on removal.
# Asserted here so the Phase 2 retention reads cannot pass on fields that never
# landed.
assert_field "vpcConfig subnet + security group count" \
  '[(.vpcConfig.subnets // [] | length), (.vpcConfig.securityGroupIds // [] | length)] | join(",")' '1,1'
VPC_ID_P1="$(project_field '.vpcConfig.vpcId')"
case "${VPC_ID_P1}" in
  vpc-?*) echo "    ok: vpcConfig.vpcId = ${VPC_ID_P1}" ;;
  *) echo "FAIL: vpcConfig.vpcId: expected a vpc- id, got '${VPC_ID_P1}'" >&2; exit 1 ;;
esac
assert_field "fileSystemLocations identifiers"  '[.fileSystemLocations[]?.identifier] | join(",")' 'efs1'
assert_field "secondarySources identifiers"     '[.secondarySources[]?.sourceIdentifier] | join(",")' 'src2'
assert_field "secondarySourceVersions"          '[.secondarySourceVersions[]? | "\(.sourceIdentifier)=\(.sourceVersion)"] | join(",")' 'src2=refs/heads/main'
assert_field "secondaryArtifacts identifiers"   '[.secondaryArtifacts[]?.artifactIdentifier] | join(",")' 'art2'
assert_field "badge.badgeEnabled"               '.badge.badgeEnabled' 'true'
# go-to-k/cdkd#2762: the UpdateProjectVisibility pair after CreateProject.
assert_field "projectVisibility"               '.projectVisibility'      'PUBLIC_READ'
ROLE_ARN_P1="$(project_field '.serviceRole')"
assert_field "resourceAccessRole (the service role)" '.resourceAccessRole' "${ROLE_ARN_P1}"
# Routing guard: the reads above prove the pair reached AWS, not which layer
# sent it. The type now has a Cloud Control route too, so the recorded
# provisionedBy is what says the SDK provider sent them.
PROVISIONED_BY_P1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r \
  '[.resources[] | select(.resourceType == "AWS::CodeBuild::Project") | .provisionedBy // "sdk"] | join(" ")')"
if [ "${PROVISIONED_BY_P1}" != "sdk" ]; then
  echo "FAIL: the project's routing layer is '${PROVISIONED_BY_P1}', expected 'sdk'" >&2
  exit 1
fi
echo "    ok: provisionedBy = sdk"

PROJECT_ARN_P1="$(project_field '.arn')"
PROJECT_CREATED_P1="$(project_field '.created')"

# go-to-k/cdkd#5492 scaffolding ids, read from THIS run's state so cleanup() can
# sweep them by id and Phase 3 can assert each is gone. Every one must resolve:
# an empty id would silently skip both the sweep and the gone-check.
state_physical_id() { # usage: state_physical_id <resourceType>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r --arg t "$1" \
    '[.resources[] | select(.resourceType == $t) | .physicalId] | if length == 1 then .[0] else "" end'
}
VPC_ID="$(state_physical_id 'AWS::EC2::VPC')"
SUBNET_ID="$(state_physical_id 'AWS::EC2::Subnet')"
SG_ID="$(state_physical_id 'AWS::EC2::SecurityGroup')"
ARTIFACT_BUCKET="$(state_physical_id 'AWS::S3::Bucket')"
case "${VPC_ID}" in vpc-?*) ;; *) echo "FAIL: state VPC id: expected one vpc- id, got '${VPC_ID}'" >&2; exit 1 ;; esac
case "${SUBNET_ID}" in subnet-?*) ;; *) echo "FAIL: state subnet id: expected one subnet- id, got '${SUBNET_ID}'" >&2; exit 1 ;; esac
case "${SG_ID}" in sg-?*) ;; *) echo "FAIL: state security group id: expected one sg- id, got '${SG_ID}'" >&2; exit 1 ;; esac
if [ -z "${ARTIFACT_BUCKET}" ]; then
  echo "FAIL: state secondary-artifact bucket: expected one bucket name, got none" >&2
  exit 1
fi
# The project's live VPC config must point at the recorded scaffolding.
assert_field "vpcConfig.vpcId is the recorded VPC" '.vpcConfig.vpcId' "${VPC_ID}"
echo "    ok: scaffolding ids ${VPC_ID} ${SUBNET_ID} ${SG_ID} ${ARTIFACT_BUCKET}"
check_member_baseline AWS::CodeBuild::Project Visibility "Phase 1 (the PUBLIC_READ write)"
CB_LIDS=$(state_lids AWS::CodeBuild::Project)
[ -n "${CB_LIDS}" ] || { echo "FAIL: no AWS::CodeBuild::Project in state after Phase 1" >&2; exit 1; }
for _lid in ${CB_LIDS}; do
  assert_observed_member "${_lid}" .Visibility "$(aws codebuild batch-get-projects --region "${REGION}" \
    --names "$(state_field "${_lid}" .physicalId)" --query 'projects[0].projectVisibility' --output json)" \
    "Phase 1 (the PUBLIC_READ write)"
done

# --- Phase 1b: the Cloud Control route, both ways ----------------------
# AWS::CodeBuild::Project had no Cloud Control handlers when its SDK provider
# landed, so `--recreate-via-cc-api` was refused (#3887). AWS has since made it
# FULLY_MUTABLE, so the recreate now moves the project onto Cloud Control: the
# project is deleted through its SDK provider and re-created by Cloud Control
# under the same name (a new creation time proves the re-create; the ARN is
# derived from the name and survives it). `--recreate-via-sdk-provider` then
# moves it back, so the later phases still exercise the SDK provider.
echo "==> Phase 1b: --recreate-via-cc-api moves the project onto Cloud Control, and back"
PROJECT_LID="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r \
  '[.resources | to_entries[] | select(.value.resourceType == "AWS::CodeBuild::Project") | .key] | first // ""')"
if [ -z "${PROJECT_LID}" ]; then
  echo "FAIL: could not read the project's logical id from ${STATE_KEY}" >&2
  exit 1
fi
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-cc-api "${PROJECT_LID}" \
  --yes
ROUTE_P1B="$(state_field "${PROJECT_LID}" .provisionedBy)"
if [ "${ROUTE_P1B}" != "cc-api" ]; then
  echo "FAIL: after --recreate-via-cc-api the project is recorded provisionedBy '${ROUTE_P1B}', expected 'cc-api'" >&2
  exit 1
fi
PROJECT_ARN_P1B="$(project_field '.arn')"
if [ "${PROJECT_ARN_P1B}" != "${PROJECT_ARN_P1}" ]; then
  echo "FAIL: the Cloud Control re-create changed the project ARN (${PROJECT_ARN_P1} -> ${PROJECT_ARN_P1B})" >&2
  exit 1
fi
PROJECT_CREATED_P1B="$(project_field '.created')"
if [ "${PROJECT_CREATED_P1B}" = "${PROJECT_CREATED_P1}" ]; then
  echo "FAIL: --recreate-via-cc-api did not re-create the project (created ${PROJECT_CREATED_P1} unchanged)" >&2
  exit 1
fi
assert_field "vpcConfig.vpcId survives the Cloud Control re-create" '.vpcConfig.vpcId' "${VPC_ID}"
echo "    ok: project re-created by Cloud Control (created ${PROJECT_CREATED_P1B})"

node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --recreate-via-sdk-provider "${PROJECT_LID}" \
  --yes
ROUTE_P1C="$(state_field "${PROJECT_LID}" .provisionedBy)"
if [ "${ROUTE_P1C}" != "sdk" ]; then
  echo "FAIL: after --recreate-via-sdk-provider the project is recorded provisionedBy '${ROUTE_P1C}', expected 'sdk'" >&2
  exit 1
fi
PROJECT_CREATED_P1C="$(project_field '.created')"
if [ "${PROJECT_CREATED_P1C}" = "${PROJECT_CREATED_P1B}" ]; then
  echo "FAIL: --recreate-via-sdk-provider did not re-create the project (created ${PROJECT_CREATED_P1B} unchanged)" >&2
  exit 1
fi
echo "    ok: project back on its SDK provider (created ${PROJECT_CREATED_P1C})"

# --- Phase 2: removal redeploy ---------------------------------------
echo "==> Phase 2: redeploy with CDKD_TEST_REMOVAL=true (drops the optional fields)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

echo "==> Phase 2: the ONE field CFn resets must be gone"
# Pre-fix, `mapProperties` mapped the absent block to `undefined`, UpdateProject
# merged, and the live project kept its batch config -- reported as success by
# cdkd and invisible to the next `cdkd diff`. Post-fix the removal sends the
# empty object and AWS nulls the block out.
assert_field "buildBatchConfig cleared on removal" '.buildBatchConfig' 'null'
# go-to-k/cdkd#2762: CloudFormation resets a removed Visibility to PRIVATE and
# clears a removed ResourceAccessRole (CFn A/B); so must cdkd.
assert_field "projectVisibility reset on removal" '.projectVisibility'  'PRIVATE'
assert_field "resourceAccessRole cleared on removal" '.resourceAccessRole' 'null'
# go-to-k/cdkd#1160: CloudFormation resets a removed EncryptionKey to the AWS
# managed S3 key and removes every tag when Tags is removed (CFn A/B). Pre-fix,
# UpdateProject merged both absent members and the old values stayed.
assert_field "encryptionKey reset to the managed key on removal" \
  '(.encryptionKey // "") | test(":alias/aws/s3$")' 'true'
assert_field "user tags removed on removal" \
  '[.tags[]? | select(.key | startswith("aws:") | not)] | length' '0'

echo "==> Phase 2: the seven fields CFn RETAINS must be unchanged"
# These are the CFn-parity pins. If a future change "fixes" them into resets,
# this block fails and forces a fresh live CFn A/B rather than a guess.
assert_field "description retained"            '.description'            'cdkd-integ-description'
assert_field "timeoutInMinutes retained"       '.timeoutInMinutes'       '25'
assert_field "queuedTimeoutInMinutes retained" '.queuedTimeoutInMinutes' '100'
assert_field "concurrentBuildLimit retained"   '.concurrentBuildLimit'   '2'
assert_field "autoRetryLimit retained"         '.autoRetryLimit'         '3'
assert_field "cache.type retained"             '.cache.type'             'LOCAL'
assert_field "logsConfig retained"             '.logsConfig.cloudWatchLogs.status' 'DISABLED'

echo "==> Phase 2: the six fields CFn KEEPS (go-to-k/cdkd#5492) must be unchanged"
# CFn A/B: CloudFormation's UpdateProject omitted each removed member and the
# live value stayed, so cdkd must send nothing for them either. A provider that
# "fixed" any of them into a reset (an empty list, `badgeEnabled: false`) fails
# here.
assert_field "vpcConfig retained"               '.vpcConfig.vpcId' "${VPC_ID_P1}"
assert_field "fileSystemLocations retained"     '[.fileSystemLocations[]?.identifier] | join(",")' 'efs1'
assert_field "secondarySources retained"        '[.secondarySources[]?.sourceIdentifier] | join(",")' 'src2'
assert_field "secondarySourceVersions retained" '[.secondarySourceVersions[]? | "\(.sourceIdentifier)=\(.sourceVersion)"] | join(",")' 'src2=refs/heads/main'
assert_field "secondaryArtifacts retained"      '[.secondaryArtifacts[]?.artifactIdentifier] | join(",")' 'art2'
assert_field "badge.badgeEnabled retained"      '.badge.badgeEnabled' 'true'

# Replacement guard: the removal must be an in-place UPDATE. A same-name
# replacement would delete and re-create the project, which would also clear
# the batch config -- and would make every assertion above pass for the wrong
# reason.
PROJECT_ARN_P2="$(project_field '.arn')"
if [ "${PROJECT_ARN_P1}" != "${PROJECT_ARN_P2}" ]; then
  echo "FAIL: project was REPLACED across the removal update (${PROJECT_ARN_P1} -> ${PROJECT_ARN_P2}); the reset must be in-place" >&2
  exit 1
fi
echo "    ok: project ARN unchanged (in-place update)"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

echo "==> Phase 3: assert the project is gone"
# `batch-get-projects` does NOT error on a missing name -- it returns the name
# under `projectsNotFound` and exits 0 -- so the `assert_gone` helper would read
# the successful call as "still exists" and false-FAIL. Assert on the API's own
# not-found channel instead. Unsilenced and outside condition position, so a
# throttle / auth failure aborts under `set -e` rather than reading as gone.
NOT_FOUND_COUNT="$(aws codebuild batch-get-projects --names "${PROJECT_NAME}" \
  --region "${REGION}" --query 'length(projectsNotFound)' --output text)"
if [ "${NOT_FOUND_COUNT}" != "1" ]; then
  echo "FAIL: CodeBuild project ${PROJECT_NAME} survived destroy (projectsNotFound=${NOT_FOUND_COUNT})" >&2
  exit 1
fi

echo "==> Phase 3: assert the go-to-k/cdkd#5492 scaffolding is gone"
assert_gone "VPC ${VPC_ID} survived destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "subnet ${SUBNET_ID} survived destroy" \
  aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}"
assert_gone "security group ${SG_ID} survived destroy" \
  aws ec2 describe-security-groups --group-ids "${SG_ID}" --region "${REGION}"
assert_gone "secondary-artifact bucket ${ARTIFACT_BUCKET} survived destroy" \
  aws s3api head-bucket --bucket "${ARTIFACT_BUCKET}"

echo "==> Phase 3: assert state was removed"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "PASS: BuildBatchConfig removal reset + the seven CFn-retained fields verified end to end"
