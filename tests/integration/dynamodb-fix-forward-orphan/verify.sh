#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the DynamoDB table arm: a fix-forward deploy deletes the
# table an earlier failed CREATE left in AWS, once a live read
# (`DynamoDBTableProvider.isSameResource`) proves it is not the table the new
# state record holds, and its journaled identity (the `TableId` its
# `CreateTable` answered with, `DynamoDBTableProvider.resourceIdentity` on the
# live side) proves the table under the name is still the one that CREATE
# made. A table whose name was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseTable` alone.
#   2. The failed CREATE. A role is created that may create, describe and tag
#      a table but may neither set its TTL nor delete it. A `--no-rollback`
#      deploy run as that role with WITH_ORPHANS=true creates `OrphanA`'s and
#      `OrphanC`'s tables, waits for each ACTIVE, fails on `UpdateTimeToLive`,
#      and the provider's own cleanup (`DeleteTable`) is refused too. (The
#      AccessDenied is retried as IAM propagation; each replayed CreateTable
#      collides with the first attempt's table, and the first attempt's
#      created-table mark is carried to the journal.) Asserted: the deploy
#      failed, both tables exist with their TTL still off, no state record
#      holds them, and the rollback journal carries each as a proven orphan
#      whose identity is the `TableId` AWS reports for it.
#   2b. The re-used name: `OrphanC`'s table is deleted and its name created
#      again outside the stack, with a marker tag. Asserted: it reports another
#      `TableId` (the premise the identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      orphan logical ids under other names (`-b`). Asserted: `OrphanA`'s
#      earlier table is deleted (`deleting partially-created OrphanA`), the
#      re-created `OrphanC` name is kept with its marker and warned about as
#      another table (exit 2, the warning's code), the journal is removed, and
#      the state records hold the new tables. Before #4606 the deploy kept
#      `OrphanA`'s table too.
#   4. The re-created `OrphanC` table (this run's, no record's) is deleted by
#      name, then `cdkd destroy`. Every table, the state file and the role are
#      gone, and the state prefix's object versions are swept.
#
# Cost: a handful of empty on-demand tables. On any failure, cleanup destroys
# the stack, deletes every table this run names and deletes the role.
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
# A DeleteTable leaves the table DELETING for a while: retry the gone-probe on
# a bounded schedule. A table that never disappears still FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws dynamodb describe-table ...
  local desc="$1"; shift
  for _ in $(seq 1 30); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 5
  done
  echo "FAIL: ${desc} (still present after 30 probes over ~150s)" >&2
  exit 1
}

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdDynamoDBFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/dynamodb-fix-forward-orphan"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is
# versioned, and the journal and state records this run writes stay readable
# as noncurrent versions. Sourced by absolute path, before the `cd` below, so
# the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The names the stack derives (lib/dynamodb-fix-forward-orphan-stack.ts).
BASE_TABLE="cdkd-ddbffo-base"
TABLE_A="cdkd-ddbffo-a"
TABLE_A_B="cdkd-ddbffo-a-b"
TABLE_C="cdkd-ddbffo-c"
TABLE_C_B="cdkd-ddbffo-c-b"
ALL_TABLES=("${BASE_TABLE}" "${TABLE_A}" "${TABLE_A_B}" "${TABLE_C}" "${TABLE_C_B}")

DENY_ROLE="${STACK}-no-ttl"
DENY_POLICY_NAME="create-without-configure"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the tables or the stack
# may belong to a concurrent or earlier run, which a failure-path delete must
# not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

table_id() { # usage: table_id <table>  (empty when the read answers nothing)
  aws dynamodb describe-table --table-name "$1" --region "${REGION}" \
    --query 'Table.TableId' --output text
}

delete_table_by_name() { ( # usage: delete_table_by_name <table>  (best-effort)
  set +eu
  aws dynamodb delete-table --table-name "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_deny_role() { ( # usage: delete_deny_role
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  rc=$?
  set +eu
  rm -rf "${LOG_DIR}"
  if [ -n "${DENY_ROLE_CREATED}" ]; then
    delete_deny_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then break; fi
      sleep 5
    done
    if ! ( gone_probe aws iam get-role --role-name "${DENY_ROLE}" ); then
      echo "[verify] WARN: role ${DENY_ROLE} could not be confirmed deleted; delete it by hand" >&2
    fi
  fi
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # Then by name, for the tables no state record holds (the orphans and the
    # re-created name).
    for t in "${ALL_TABLES[@]}"; do
      delete_table_by_name "${t}"
    done
    for t in "${ALL_TABLES[@]}"; do
      aws dynamodb wait table-not-exists --table-name "${t}" --region "${REGION}" >/dev/null 2>&1 \
        || echo "[verify] WARN: table ${t} could not be confirmed deleted; delete it by hand" >&2
    done
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  # NONCURRENT only, per ../s3-versions.sh: on a failure a live state.json may
  # be the only record of what is still standing. The success path sweeps all.
  if [ -n "${CLEANUP_ARMED}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent
  fi
  exit "${rc}"
}
trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# A record or table left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for t in "${ALL_TABLES[@]}"; do
  assert_gone "precondition: table ${t} already exists (left by an earlier run); delete it first" \
    aws dynamodb describe-table --table-name "${t}" --region "${REGION}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseTable)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
BASE_ID="$(table_id "${BASE_TABLE}")"

echo "[verify] step 2: a role that may create a table but neither set its TTL nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls, never `*`. The S3 verbs on the state
# bucket are the state path's (src/state/{s3-state-backend,lock-manager,
# s3-noncurrent-version-purge,s3-replication-purge-gap}.ts,
# src/utils/aws-region-resolver.ts). On this run's tables the role may:
# CreateTable (with TagResource, which a CreateTable carrying Tags needs);
# DescribeTable (the ACTIVE wait, and any pre-create name lookup);
# ListTagsOfResource / DescribeTimeToLive / DescribeContinuousBackups (reads).
# UpdateTimeToLive (the first post-ACTIVE configuration call) is denied, so
# each CREATE fails after DynamoDB made the table; DeleteTable is denied, so
# the provider's own cleanup cannot remove it.
DENY_POLICY="$(node -e 'const [bucket,stack,acct,region]=process.argv.slice(1);const tables=`arn:aws:dynamodb:${region}:${acct}:table/cdkd-ddbffo-*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["dynamodb:CreateTable","dynamodb:TagResource","dynamodb:DescribeTable","dynamodb:ListTagsOfResource","dynamodb:DescribeTimeToLive","dynamodb:DescribeContinuousBackups"],Resource:tables},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","ssm:GetParameter","ssm:GetParameters","kms:Decrypt","kms:GenerateDataKey","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["dynamodb:UpdateTimeToLive","dynamodb:DeleteTable"],Resource:tables}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${REGION}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=dynamodb-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-dynamodb-fix-forward \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  DENY_CREDS=""
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${DENY_CREDS}")
unset DENY_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
DENY_ARN=""
deny_id_err=""
for _ in $(seq 1 24); do
  if DENY_ARN="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${LOG_DIR}/id-err")"; then
    break
  fi
  DENY_ARN=""
  deny_id_err="$(cat "${LOG_DIR}/id-err" 2>/dev/null || true)"
  sleep 5
done
if [ -z "${DENY_ARN}" ]; then
  echo "[verify] FAIL: precondition -- STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${deny_id_err})" >&2
  exit 1
fi
case "${DENY_ARN}" in
  *":assumed-role/${DENY_ROLE}/"*) ;;
  *)
    echo "[verify] FAIL: precondition -- the role's commands run as '${DENY_ARN}', not ${DENY_ROLE}" >&2
    exit 1
    ;;
esac
# The EXPLICIT deny must already bind: before the inline policy propagates,
# the role is refused everything implicitly, and the deploy below would then
# fail before any CREATE for the wrong reason. Probed on BaseTable, which
# EXISTS. The probe cannot delete it: no statement allows DeleteTable, so it
# is refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws dynamodb delete-table --table-name "${BASE_TABLE}" --region "${REGION}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_TABLE} (its policy must refuse DeleteTable)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteTable never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails on its first
# DescribeTable for the wrong reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws dynamodb describe-table --table-name "${BASE_TABLE}" --region "${REGION}" \
    --query 'Table.TableName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${BASE_TABLE}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not DescribeTable ${BASE_TABLE} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after DynamoDB made the table"
set +e
as_deny_role env -u ORPHAN_FIX_FORWARD WITH_ORPHANS=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback > "${LOG_DIR}/inject.log" 2>&1
INJECT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inject.log" || true
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves cleanup to retry the delete.
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${INJECT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback deploy as ${DENY_ROLE} unexpectedly SUCCEEDED" >&2
  exit 1
fi
for t in "${TABLE_A}" "${TABLE_C}"; do
  if gone_probe aws dynamodb describe-table --table-name "${t}" --region "${REGION}"; then
    echo "[verify] FAIL: table ${t} does not exist after step 2 -- its CREATE failed before CreateTable returned (output above)" >&2
    exit 1
  fi
  # The premise of the injection: the CREATE failed on the TTL call, after
  # the table was made, so the TTL is still off.
  T_TTL="$(aws dynamodb describe-time-to-live --table-name "${t}" --region "${REGION}" \
    --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)"
  if [ "${T_TTL}" != "DISABLED" ]; then
    echo "[verify] FAIL: table ${t}'s TTL reads '${T_TTL}' after step 2 (expected DISABLED: the CREATE must fail on UpdateTimeToLive)" >&2
    exit 1
  fi
done
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in OrphanA OrphanC; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655 / #4606: the journal carries the identity the settle
# compares before deleting a name-keyed orphan: the TableId CreateTable
# answered with, carried on the failure's mark. It must equal what
# DescribeTable reports.
assert_journaled() { # usage: assert_journaled <logicalId> <table>
  local op want
  want="$(table_id "$2")" || { echo "[verify] FAIL: DescribeTable $2 failed after step 2 (output above)" >&2; exit 1; }
  if [ -z "${want}" ] || [ "${want}" = "None" ]; then
    echo "[verify] FAIL: DescribeTable reports no TableId for $2 after step 2" >&2
    exit 1
  fi
  op="$(printf '%s' "${JOURNAL_2}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || { echo "[verify] FAIL: could not read $1 from the rollback journal after step 2" >&2; exit 1; }
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "$2" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.provisionedBy // "<absent>"')" != "sdk" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.createdResourceIdentity // "<absent>"')" != "${want}" ]; then
    echo "[verify] FAIL: the journal does not carry $1's proven id $2 (via sdk) with its identity ${want} after step 2 (op: ${op:-<none>})" >&2
    exit 1
  fi
}
assert_journaled OrphanA "${TABLE_A}"
assert_journaled OrphanC "${TABLE_C}"
C_ID="$(table_id "${TABLE_C}")"
echo "[verify] step 2 ok: ${TABLE_A} and ${TABLE_C} are in AWS, journaled with their TableIds, with no state record"

echo "[verify] step 2b: ${TABLE_C} is deleted and its name re-used outside the stack"
aws dynamodb delete-table --table-name "${TABLE_C}" --region "${REGION}" >/dev/null
assert_gone_eventually "step 2b: ${TABLE_C} survived its delete" \
  aws dynamodb describe-table --table-name "${TABLE_C}" --region "${REGION}"
C_MARKER="phase2b-$(date -u +%s)"
aws dynamodb create-table --table-name "${TABLE_C}" --region "${REGION}" \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST \
  --tags "Key=cdkd-integ-marker,Value=${C_MARKER}" >/dev/null
aws dynamodb wait table-exists --table-name "${TABLE_C}" --region "${REGION}"
C_ARN="$(aws dynamodb describe-table --table-name "${TABLE_C}" --region "${REGION}" --query 'Table.TableArn' --output text)"
# The premise the identity rests on: the re-created table reports ANOTHER
# TableId.
C2_ID="$(table_id "${TABLE_C}")"
if [ -z "${C2_ID}" ] || [ "${C2_ID}" = "None" ] || [ "${C2_ID}" = "${C_ID}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${TABLE_C} reports TableId '${C2_ID}', the deleted one '${C_ID}': a TableId that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's DynamoDB identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: ${TABLE_C} re-created outside the stack (TableId ${C_ID} -> ${C2_ID})"

echo "[verify] step 3: the fix-forward (same logical ids, other names)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
# 2: OrphanC's re-used name is left in place with a warning, which counts as
# unaddressed (journaled-orphans.ts, `settleJournaledOrphansOnSuccess`). Any
# other code is a failed deploy, or a settle that skipped the warning.
if [ "${FF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 2: OrphanC's re-used name is warned about and kept -- output above)" >&2
  exit 1
fi
assert_gone_eventually "the earlier attempt's table ${TABLE_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws dynamodb describe-table --table-name "${TABLE_A}" --region "${REGION}"
# The re-used name is someone else's now: kept, untouched.
C_TAG="$(aws dynamodb list-tags-of-resource --resource-arn "${C_ARN}" --region "${REGION}" \
  --query "Tags[?Key=='cdkd-integ-marker'].Value | [0]" --output text 2>&1)" || C_TAG="<list-tags-of-resource failed: ${C_TAG}>"
if [ "${C_TAG}" != "${C_MARKER}" ] || [ "$(table_id "${TABLE_C}")" != "${C2_ID}" ]; then
  echo "[verify] FAIL: the re-created ${TABLE_C} was not left untouched by the fix-forward (marker tag '${C_TAG}', expected '${C_MARKER}'; TableId expected ${C2_ID})" >&2
  exit 1
fi
# The kept entry was warned about, so the journal goes with it.
assert_gone "the fix-forward kept the rollback journal (expected it removed: OrphanA deleted, OrphanC warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for t in "${TABLE_A_B}" "${TABLE_C_B}" "${BASE_TABLE}"; do
  if gone_probe aws dynamodb describe-table --table-name "${t}" --region "${REGION}"; then
    echo "[verify] FAIL: the record's table ${t} is missing after the fix-forward (the settle must not delete the records' tables)" >&2
    exit 1
  fi
done
if [ "$(table_id "${BASE_TABLE}")" != "${BASE_ID}" ]; then
  echo "[verify] FAIL: ${BASE_TABLE}'s TableId changed during the run (expected the baseline's ${BASE_ID})" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <table>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanA "${TABLE_A_B}"
assert_record OrphanC "${TABLE_C_B}"
assert_record BaseTable "${BASE_TABLE}"
# The assertions above decide the step on AWS's own answers. The log lines
# below only confirm the deploy's account of it, so a reworded line fails
# here, never silently above.
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanA'; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanA (output above)" >&2
  exit 1
fi
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name OrphanA.
if printf '%s' "${FF_FLAT}" | grep -qF 'OrphanA (AWS::DynamoDB::Table), which a failed deploy'; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanA instead of deleting it (output above)" >&2
  exit 1
fi
# Sentinel for the wording above: OrphanC's keep warning uses the same head,
# so a reword that would blind the OrphanA check fails here first.
if ! printf '%s' "${FF_FLAT}" | grep -qF 'OrphanC (AWS::DynamoDB::Table), which a failed deploy'; then
  echo "[verify] FAIL: the settle's keep-warning head changed (no 'OrphanC (AWS::DynamoDB::Table), which a failed deploy' in the output): update the OrphanA check above" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanC'; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
if ! printf '%s' "${FF_FLAT}" | grep -qF 'is not deleted: the resource now under its physical id is another one'; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's name now holds another table (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${TABLE_A}, kept the re-created ${TABLE_C} untouched, and the records hold the -b tables (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${TABLE_C} (this run's, no record's), then destroy"
aws dynamodb delete-table --table-name "${TABLE_C}" --region "${REGION}" >/dev/null
assert_gone_eventually "step 4: ${TABLE_C} survived its delete" \
  aws dynamodb describe-table --table-name "${TABLE_C}" --region "${REGION}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for t in "${ALL_TABLES[@]}"; do
  assert_gone_eventually "table ${t} still exists after destroy" \
    aws dynamodb describe-table --table-name "${t}" --region "${REGION}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "dynamodb-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's table and kept one whose name was re-used (go-to-k/cdkd#4606)"
