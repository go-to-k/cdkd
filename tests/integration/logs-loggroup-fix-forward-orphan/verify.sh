#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the CloudWatch Logs log group arm: a fix-forward deploy
# deletes the log group an earlier failed CREATE left in AWS, once a live read
# (`isSameResource` on `LogsLogGroupProvider`) proves it is not the one the new
# state record holds, and its journaled identity (`<logGroupArn>@<creationTime>`,
# `resourceIdentity`, read by the engine when it journals the failure) proves
# the log group under the name is still the one that CREATE made. One whose
# name was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseLogGroup`.
#   2. The failed CREATE. A role is created that may create and read this
#      run's log groups but may neither put a retention policy on one nor
#      delete one. A `--no-rollback` deploy run as that role with
#      WITH_ORPHANS=true creates `OrphanA` and `OrphanC`, fails each on its
#      `PutRetentionPolicy`, and the provider's own cleanup delete is refused
#      too. Asserted: the deploy failed, both log groups exist with no
#      retention, no state record holds them, and the rollback journal carries
#      each as a proven orphan whose identity is the ARN and creation time
#      CloudWatch Logs reports for it now.
#   2b. The re-used name: `OrphanC`'s log group is deleted and its name
#      created again outside the stack, with a marker tag. Asserted: it
#      reports another creation time (the premise the identity rests on). A
#      retention write on it is then measured for whether it moves the
#      creation time (a NOTE: a moved one only keeps an orphan).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      orphan logical ids under other names (`-b`). Asserted: `OrphanA`'s log
#      group is deleted (`deleting partially-created OrphanA`), the re-created
#      `OrphanC` name is kept with its marker and creation time and warned
#      about as another resource (exit 2, the warning's text: the NEGATIVE
#      CONTROL), the journal is removed, and the state records hold the new
#      log groups. Before #4606 the deploy kept `OrphanA`'s too.
#   4. The re-created `OrphanC` log group (this run's, no record's) is deleted
#      by name, then `cdkd destroy`. Every log group, the state file and the
#      restricted role are gone, and the state prefix's object versions are
#      swept.
#
# Cost: a few empty log groups and one IAM role (free; nothing is logged).
# On any failure, cleanup destroys the stack, deletes every log group this run
# names and deletes the restricted role.
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
STACK="CdkdLogsLogGroupFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/logs-loggroup-fix-forward-orphan"
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

# The names the stack derives (lib/logs-loggroup-fix-forward-orphan-stack.ts).
NAME_PREFIX="cdkd-lgffo-"
LG_BASE="cdkd-lgffo-base"
LG_A="cdkd-lgffo-a"
LG_A_B="cdkd-lgffo-a-b"
LG_C="cdkd-lgffo-c"
LG_C_B="cdkd-lgffo-c-b"
ALL_LOG_GROUPS=("${LG_BASE}" "${LG_A}" "${LG_A_B}" "${LG_C}" "${LG_C_B}")

DENY_ROLE="${STACK}-no-wire"
DENY_POLICY_NAME="create-without-wiring"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the log groups or the
# stack may belong to a concurrent or earlier run, which a failure-path delete
# must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The log group's entry, by exact name, from a prefix listing (the CLI pages
# it whole; jq picks the exact name). Fails the call on a read failure, so
# "could not read" never reads as "gone".
lg_entry() { # usage: lg_entry <name>  -> the entry's JSON, or empty when not listed
  local out
  out="$(aws logs describe-log-groups --log-group-name-prefix "$1" --output json)" || return 1
  printf '%s' "${out}" | jq -c --arg n "$1" '[.logGroups[]? | select(.logGroupName == $n)] | first // empty'
}
lg_exists() { # usage: lg_exists <name>  (0 = listed, 1 = not listed; exits the run on a read failure)
  local e
  e="$(lg_entry "$1")" || { echo "[verify] FAIL: DescribeLogGroups for $1 failed" >&2; exit 1; }
  [ -n "${e}" ]
}
# The provider's identity token, `<logGroupArn>@<creationTime>`
# (`LogsLogGroupProvider.resourceIdentity`). Fails the call on a read that
# answers none.
lg_token() { # usage: lg_token <name>
  local e arn ct
  e="$(lg_entry "$1")" || return 1
  [ -n "${e}" ] || return 1
  arn="$(printf '%s' "${e}" | jq -r '.logGroupArn // empty')"
  ct="$(printf '%s' "${e}" | jq -r '.creationTime // empty')"
  if [ -z "${arn}" ] || [ -z "${ct}" ]; then
    return 1
  fi
  printf '%s@%s' "${arn}" "${ct}"
}
# Whether a just-deleted log group is no longer listed, on a bounded schedule.
lg_gone_eventually() { # usage: lg_gone_eventually <name>  (0 = gone)
  for _ in $(seq 1 12); do
    if ! lg_exists "$1"; then
      return 0
    fi
    sleep 5
  done
  return 1
}
delete_lg_by_name() { ( # usage: delete_lg_by_name <name>  (best-effort)
  set +eu
  aws logs delete-log-group --log-group-name "$1" >/dev/null 2>&1
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
    # What no state record holds (the orphans and the re-created name) first,
    # by name; the destroy below then deletes what the records hold.
    for g in "${LG_A}" "${LG_C}"; do
      delete_lg_by_name "${g}"
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    for g in "${ALL_LOG_GROUPS[@]}"; do
      delete_lg_by_name "${g}"
    done
    for g in "${ALL_LOG_GROUPS[@]}"; do
      ( lg_gone_eventually "${g}" ) \
        || echo "[verify] WARN: log group ${g} could not be confirmed deleted; delete it by hand" >&2
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

# A record or resource left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
# A journal left by an aborted run would be settled by step 1's deploy and
# blamed on it.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a rollback journal for ${STACK} already exists at ${JOURNAL_KEY} (left by an earlier run); delete what it records, then the journal (aws s3 rm s3://${STATE_BUCKET}/${JOURNAL_KEY}), first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the rollback journal undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
PRE_LISTED="$(aws logs describe-log-groups --log-group-name-prefix "${NAME_PREFIX}" --output json | jq -r '[.logGroups[]?.logGroupName] | join(" ")')"
if [ -n "${PRE_LISTED}" ]; then
  echo "[verify] FAIL: precondition -- log groups under ${NAME_PREFIX} already exist (${PRE_LISTED}; left by an earlier run); delete them first" >&2
  exit 1
fi
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseLogGroup)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if ! lg_exists "${LG_BASE}"; then
  echo "[verify] FAIL: ${LG_BASE} does not read back after step 1" >&2
  exit 1
fi

echo "[verify] step 2: a role that may create a log group but neither put its retention nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs,
# logs:DescribeLogGroups (a listing, which takes no single log group) and
# sts:GetCallerIdentity are `*`; SSM is the CDK bootstrap parameters, KMS only
# through S3 (the state bucket's encryption). The S3 verbs on the state bucket
# are the state path's (src/state/{s3-state-backend,lock-manager,
# s3-noncurrent-version-purge,s3-replication-purge-gap}.ts,
# src/utils/aws-region-resolver.ts). On this run's log groups
# (`cdkd-lgffo-*`, which also matches the `:*` suffixed form) the role may
# CreateLogGroup and read tags and policies. PutRetentionPolicy (each
# CREATE's wiring) is denied, so each CREATE fails after CloudWatch Logs made
# the log group; DeleteLogGroup, DeleteRetentionPolicy and the deletion
# protection write are denied, so the provider's own cleanup cannot remove
# it. DescribeLogGroups stays allowed: the engine's identity read, made as
# this role when it journals the failure, is what the journal's token comes
# from. No statement allows a credential, a PassRole or an IAM write.
# sts:AssumeRole is denied everywhere: nothing this session runs assumes a
# role (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct,region]=process.argv.slice(1);const lg=`arn:aws:logs:${region}:${acct}:log-group:cdkd-lgffo-*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["logs:CreateLogGroup","logs:ListTagsForResource","logs:ListTagsLogGroup","logs:GetDataProtectionPolicy","logs:DescribeIndexPolicies"],Resource:lg},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","logs:DescribeLogGroups","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["logs:PutRetentionPolicy","logs:DeleteRetentionPolicy","logs:DeleteLogGroup","logs:PutLogGroupDeletionProtection"],Resource:lg},{Effect:"Deny",Action:["iam:PassRole","sts:AssumeRole"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${REGION}")"
# Armed BEFORE the create: an interrupt between a successful create-role and
# the flag would otherwise leave the role behind. The precondition above
# proved the name absent, so the cleanup's best-effort delete (a NoSuchEntity
# is ignored) and its gone-confirm act only on this run's role.
DENY_ROLE_CREATED=1
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=logs-loggroup-fix-forward-orphan >/dev/null
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
assume_err=""
for _ in $(seq 1 24); do
  # stderr (the error text only) goes to the log; stdout (the credentials)
  # stays in the variable.
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-logs-loggroup-fix-forward \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>"${LOG_DIR}/assume-err")"; then
    break
  fi
  DENY_CREDS=""
  assume_err="$(tail -3 "${LOG_DIR}/assume-err" 2>/dev/null || true)"
  sleep 5
done
if [ -z "${DENY_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes (last answer: ${assume_err:-<none>})" >&2
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
    # CDKD_ROLE_ARN would make the deploy AssumeRole, which this role denies.
    unset AWS_PROFILE AWS_DEFAULT_PROFILE CDKD_ROLE_ARN
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
# fail before any CREATE for the wrong reason. Probed on BaseLogGroup, which
# EXISTS. The probe cannot delete it: no statement allows DeleteLogGroup, so
# it is refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws logs delete-log-group --log-group-name "${LG_BASE}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${LG_BASE} (its policy must refuse DeleteLogGroup)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteLogGroup never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason: the role must list BaseLogGroup.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws logs describe-log-groups --log-group-name-prefix "${LG_BASE}" \
    --query 'logGroups[0].logGroupName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${LG_BASE}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not list ${LG_BASE} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after CloudWatch Logs made the log group"
set +e
as_deny_role env -u ORPHAN_FIX_FORWARD WITH_ORPHANS=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --no-rollback > "${LOG_DIR}/inject.log" 2>&1
INJECT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inject.log" || true
# The role is not needed again, nor are its live credentials. Still flagged
# until confirmed gone, so a failure here leaves cleanup to retry the delete.
unset DENY_AK DENY_SK DENY_ST
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
for g in "${LG_A}" "${LG_C}"; do
  if ! lg_exists "${g}"; then
    echo "[verify] FAIL: log group ${g} does not exist after step 2 -- its CREATE failed before CreateLogGroup returned (output above)" >&2
    exit 1
  fi
  # The premise of the injection, from AWS's own answer: the CREATE failed on
  # its retention (the denied PutRetentionPolicy left none).
  RET="$(lg_entry "${g}" | jq -r '.retentionInDays // "none"')"
  if [ "${RET}" != "none" ]; then
    echo "[verify] FAIL: log group ${g} has retention ${RET} after step 2 (expected none: its CREATE must fail on the denied PutRetentionPolicy)" >&2
    exit 1
  fi
done
# The deploy's own account: each CREATE's cleanup was refused.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for lid in OrphanA OrphanC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created log group ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${lid}'s refused cleanup (output above)" >&2
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
# compares before deleting a name-keyed orphan: the log group's ARN and
# creation time, read by the engine (as the restricted role) when it
# journaled the failure. It must equal what CloudWatch Logs reports now.
assert_journaled() { # usage: assert_journaled <logicalId> <physical id> <expected token>
  local op
  op="$(printf '%s' "${JOURNAL_2}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || { echo "[verify] FAIL: could not read $1 from the rollback journal after step 2" >&2; exit 1; }
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "$2" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.provisionedBy // "<absent>"')" != "sdk" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.createdResourceIdentity // "<absent>"')" != "$3" ]; then
    echo "[verify] FAIL: the journal does not carry $1's proven id $2 (via sdk) with its identity $3 after step 2 (op: ${op:-<none>})" >&2
    exit 1
  fi
}
A_TOKEN="$(lg_token "${LG_A}")" || { echo "[verify] FAIL: DescribeLogGroups answered no logGroupArn / creationTime for ${LG_A} after step 2" >&2; exit 1; }
C_TOKEN="$(lg_token "${LG_C}")" || { echo "[verify] FAIL: DescribeLogGroups answered no logGroupArn / creationTime for ${LG_C} after step 2" >&2; exit 1; }
assert_journaled OrphanA "${LG_A}" "${A_TOKEN}"
assert_journaled OrphanC "${LG_C}" "${C_TOKEN}"
echo "[verify] step 2 ok: two log groups are in AWS, journaled with their identities (${A_TOKEN} ${C_TOKEN}), with no state record"

echo "[verify] step 2b: ${LG_C} is deleted and its name re-used outside the stack"
aws logs delete-log-group --log-group-name "${LG_C}"
if ! lg_gone_eventually "${LG_C}"; then
  echo "[verify] FAIL: step 2b: ${LG_C} is still listed a minute after its delete" >&2
  exit 1
fi
# The marker: a tag no CREATE of the stack sets.
C_STAMP="$(date -u +%s)"
C_MARKER="re-created-outside-${C_STAMP}"
C_CREATED=""
for _ in $(seq 1 12); do
  if aws logs create-log-group --log-group-name "${LG_C}" --tags "cdkd-lgffo-marker=${C_MARKER}" 2>"${LOG_DIR}/c-err"; then
    C_CREATED=1
    break
  fi
  # Only the delete not having settled yet is retried.
  grep -q 'ResourceAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
  sleep 5
done
if [ -z "${C_CREATED}" ]; then
  echo "[verify] FAIL: could not re-create ${LG_C} within a minute of its delete" >&2
  exit 1
fi
# The premise the identity rests on: the re-created log group reports ANOTHER
# token under the same name (the same ARN, another creation time).
C2_TOKEN="$(lg_token "${LG_C}")" || { echo "[verify] FAIL: DescribeLogGroups answered no token for the re-created ${LG_C}" >&2; exit 1; }
if [ "${C2_TOKEN}" = "${C_TOKEN}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${LG_C} reports '${C2_TOKEN}', the deleted one's identity: a creation time that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's log group identity is then unsound)" >&2
  exit 1
fi
if [ "${C2_TOKEN%@*}" != "${C_TOKEN%@*}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${LG_C} reports ARN '${C2_TOKEN%@*}', not the deleted one's '${C_TOKEN%@*}' (expected the same name-built ARN)" >&2
  exit 1
fi
# A measurement, not a premise: a retention write after the create. A moved
# creation time would only keep such an orphan (fail-safe), never delete one.
aws logs put-retention-policy --log-group-name "${LG_C}" --retention-in-days 1
C2B_TOKEN="$(lg_token "${LG_C}")" || { echo "[verify] FAIL: DescribeLogGroups answered no token for ${LG_C} after its retention write" >&2; exit 1; }
if [ "${C2B_TOKEN}" = "${C2_TOKEN}" ]; then
  echo "[verify] NOTE: PutRetentionPolicy did not move ${LG_C}'s creation time"
else
  echo "[verify] NOTE: PutRetentionPolicy MOVED ${LG_C}'s creation time (${C2_TOKEN} -> ${C2B_TOKEN})"
fi
echo "[verify] step 2b ok: re-created outside the stack (${C_TOKEN} -> ${C2B_TOKEN})"

echo "[verify] step 3: the fix-forward (same logical ids, other names)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
# 2: the C's re-used name is left in place with a warning, which counts as
# unaddressed (journaled-orphans.ts, `settleJournaledOrphansOnSuccess`). Any
# other code is a failed deploy, or a settle that skipped the warning.
if [ "${FF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 2: the re-used OrphanC name is warned about and kept -- output above)" >&2
  exit 1
fi
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
if lg_exists "${LG_A}"; then
  echo "FAIL: the earlier attempt's log group ${LG_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" >&2
  exit 1
fi
# The NEGATIVE CONTROL: the re-used name is someone else's now: kept,
# untouched (its marker tag and its token).
C3_TOKEN="$(lg_token "${LG_C}")" || C3_TOKEN="<not listed>"
# stderr to its own file, so an AWS error never reaches jq and the FAIL line
# below names the cause.
if C3_TAGS="$(aws logs list-tags-for-resource --resource-arn "${C2B_TOKEN%@*}" --output json 2>"${LOG_DIR}/tags-err")"; then
  C3_MARKER="$(printf '%s' "${C3_TAGS}" | jq -r '.tags["cdkd-lgffo-marker"] // "<none>"')" || C3_MARKER="<unparsable tags>"
else
  C3_MARKER="<list-tags-for-resource failed: $(tail -3 "${LOG_DIR}/tags-err" 2>/dev/null | tr '\n' ' ')>"
fi
if [ "${C3_TOKEN}" != "${C2B_TOKEN}" ] || [ "${C3_MARKER}" != "${C_MARKER}" ]; then
  echo "[verify] FAIL: the re-created ${LG_C} was not left untouched by the fix-forward (token '${C3_TOKEN}', marker '${C3_MARKER}'; expected '${C2B_TOKEN}' / '${C_MARKER}')" >&2
  exit 1
fi
# The kept entry was warned about, so the journal goes with it.
assert_gone "the fix-forward kept the rollback journal (expected it removed: OrphanA's deleted, OrphanC's warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for g in "${LG_A_B}" "${LG_C_B}" "${LG_BASE}"; do
  if ! lg_exists "${g}"; then
    echo "[verify] FAIL: the record's log group ${g} is missing after the fix-forward (the settle must not delete the records' log groups)" >&2
    exit 1
  fi
done
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <physical id>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanA "${LG_A_B}"
assert_record OrphanC "${LG_C_B}"
assert_record BaseLogGroup "${LG_BASE}"
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name OrphanA.
if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created OrphanA"; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanA (output above)" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF "OrphanA (AWS::Logs::LogGroup), which a failed deploy"; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanA instead of deleting it (output above)" >&2
  exit 1
fi
# Sentinel for the wording above: OrphanC's keep warning uses the same head,
# so a reword that would blind the OrphanA checks fails here first.
if ! printf '%s' "${FF_FLAT}" | grep -qF "OrphanC (AWS::Logs::LogGroup), which a failed deploy of stack ${STACK} created, is not deleted: the resource now under its physical id is another one"; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's physical id now holds another log group (no 'OrphanC (AWS::Logs::LogGroup), which a failed deploy ... is another one' in the output): if the settle's keep-warning head changed, update the OrphanA checks above" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created OrphanC"; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${LG_A}, kept the re-created ${LG_C} untouched, and the records hold the -b log groups (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${LG_C} (this run's, no record's), then destroy"
aws logs delete-log-group --log-group-name "${LG_C}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for g in "${ALL_LOG_GROUPS[@]}"; do
  if ! lg_gone_eventually "${g}"; then
    echo "FAIL: log group ${g} still exists after destroy" >&2
    exit 1
  fi
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "logs-loggroup-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's log group and kept the one whose name was re-used (go-to-k/cdkd#4606)"
