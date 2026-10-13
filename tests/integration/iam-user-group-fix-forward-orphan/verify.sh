#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the IAM user and group arm: a fix-forward deploy deletes
# the user or group an earlier failed CREATE left in AWS, once a live read
# (`IAMUserGroupProvider.isSameResource`) proves it is not the one the new
# state record holds, and its journaled identity (the `UserId` / `GroupId` its
# `CreateUser` / `CreateGroup` answered with, `resourceIdentity` on the live
# side) proves the entity under the name is still the one that CREATE made.
# One whose name was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseUser`.
#   2. The failed CREATE. A role is created that may create a user or group,
#      attach `AWSDenyAll` to it and read it, but may not put an inline policy
#      on it, detach a policy from it, or delete it. A `--no-rollback` deploy
#      run as that role with WITH_ORPHANS=true creates `UserA`, `UserC`,
#      `GroupA` and `GroupC`, fails each on its inline policy put (`UserA` /
#      `GroupA` after a successful attach), and the provider's own cleanup is
#      refused too. Asserted: the deploy failed, all four exist (the A's with
#      `AWSDenyAll` attached, none with an inline policy), no state record
#      holds them, and the rollback journal carries each as a proven orphan
#      whose identity is the id IAM reports for it now (the premise that the
#      wiring calls do not change it).
#   2b. The re-used names: `UserC`'s user and `GroupC`'s group are deleted and
#      their names created again outside the stack, under a marker path.
#      Asserted: each reports another id (the premise the identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps every
#      orphan logical id under other names (`-b`). Asserted: `UserA`'s user and
#      `GroupA`'s group are deleted (`deleting partially-created UserA` /
#      `GroupA`), the re-created `UserC` / `GroupC` names are kept with their
#      marker path and id and warned about as another resource (exit 2, the
#      warning's code: the NEGATIVE CONTROL), the journal is removed, and the
#      state records hold the new entities. Before #4606 the deploy kept
#      `UserA`'s and `GroupA`'s too.
#   4. The re-created `UserC` user and `GroupC` group (this run's, no
#      record's) are deleted by name, then `cdkd destroy`. Every user and
#      group, the state file and the restricted role are gone, and the state
#      prefix's object versions are swept.
#
# Cost: a few IAM users and groups (free; none has credentials). On any
# failure, cleanup destroys the stack, deletes every user and group this run
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
# IAM is eventually consistent: a delete can take a moment to read as gone.
# Retry the gone-probe on a bounded schedule; one that never disappears still
# FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws iam get-user ...
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
# The other direction: an entity just created can take a moment to read back.
# Retry while it reads as gone; one that never appears still FAILs.
present_eventually() { # usage: present_eventually aws iam get-user ...  (0 = present)
  for _ in $(seq 1 12); do
    if ! gone_probe "$@"; then
      return 0
    fi
    sleep 5
  done
  return 1
}

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdIamUserGroupFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/iam-user-group-fix-forward-orphan"
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

# The names the stack derives (lib/iam-user-group-fix-forward-orphan-stack.ts).
BASE_USER="cdkd-iufo-base"
USER_A="cdkd-iufo-user-a"
USER_A_B="cdkd-iufo-user-a-b"
USER_C="cdkd-iufo-user-c"
USER_C_B="cdkd-iufo-user-c-b"
GROUP_A="cdkd-iufo-group-a"
GROUP_A_B="cdkd-iufo-group-a-b"
GROUP_C="cdkd-iufo-group-c"
GROUP_C_B="cdkd-iufo-group-c-b"
ALL_USERS=("${BASE_USER}" "${USER_A}" "${USER_A_B}" "${USER_C}" "${USER_C_B}")
ALL_GROUPS=("${GROUP_A}" "${GROUP_A_B}" "${GROUP_C}" "${GROUP_C_B}")
DENY_ALL_ARN="arn:aws:iam::aws:policy/AWSDenyAll"

DENY_ROLE="${STACK}-no-wire"
DENY_POLICY_NAME="create-without-wiring"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the users, groups or the
# stack may belong to a concurrent or earlier run, which a failure-path delete
# must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The provider's identity tokens, the `UserId` / `GroupId`
# (iam-user-group-provider.ts, `userOrGroupIdentityToken`). Each fails the
# call on a read that answers none.
user_id() { # usage: user_id <user>
  local id
  id="$(aws iam get-user --user-name "$1" --query 'User.UserId' --output text)" || return 1
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    return 1
  fi
  printf '%s' "${id}"
}
group_id() { # usage: group_id <group>
  local id
  id="$(aws iam get-group --group-name "$1" --query 'Group.GroupId' --output text)" || return 1
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    return 1
  fi
  printf '%s' "${id}"
}

delete_user_by_name() { ( # usage: delete_user_by_name <user>  (best-effort; groups and policies first)
  set +eu
  for g in $(aws iam list-groups-for-user --user-name "$1" --query 'Groups[].GroupName' --output text 2>/dev/null); do
    aws iam remove-user-from-group --user-name "$1" --group-name "${g}" >/dev/null 2>&1
  done
  for p in $(aws iam list-user-policies --user-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-user-policy --user-name "$1" --policy-name "${p}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-user-policies --user-name "$1" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-user-policy --user-name "$1" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-user --user-name "$1" >/dev/null 2>&1
  true
); }
delete_group_by_name() { ( # usage: delete_group_by_name <group>  (best-effort; policies first)
  set +eu
  for p in $(aws iam list-group-policies --group-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-group-policy --group-name "$1" --policy-name "${p}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-group-policies --group-name "$1" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-group-policy --group-name "$1" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-group --group-name "$1" >/dev/null 2>&1
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
    # What no state record holds (the orphans and the re-created names) first,
    # by name; the destroy below then deletes what the records hold.
    for u in "${ALL_USERS[@]}"; do
      delete_user_by_name "${u}"
    done
    for g in "${ALL_GROUPS[@]}"; do
      delete_group_by_name "${g}"
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # IAM is eventually consistent: a bounded wait before the WARN.
    for u in "${ALL_USERS[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-user --user-name "${u}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-user --user-name "${u}" ) \
        || echo "[verify] WARN: user ${u} could not be confirmed deleted; delete it by hand" >&2
    done
    for g in "${ALL_GROUPS[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-group --group-name "${g}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-group --group-name "${g}" ) \
        || echo "[verify] WARN: group ${g} could not be confirmed deleted; delete it by hand" >&2
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

# A record, user or group left by an earlier, interrupted run would be blamed
# on the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for u in "${ALL_USERS[@]}"; do
  assert_gone "precondition: user ${u} already exists (left by an earlier run); delete it first" \
    aws iam get-user --user-name "${u}"
done
for g in "${ALL_GROUPS[@]}"; do
  assert_gone "precondition: group ${g} already exists (left by an earlier run); delete it first" \
    aws iam get-group --group-name "${g}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseUser)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
BASE_ID="$(user_id "${BASE_USER}")" || { echo "[verify] FAIL: ${BASE_USER} reads no UserId after step 1" >&2; exit 1; }

echo "[verify] step 2: a role that may create a user or group but neither wire an inline policy nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs and
# sts:GetCallerIdentity (which takes no resource) are `*`; SSM is the CDK
# bootstrap parameters, KMS only through S3 (the state bucket's encryption).
# The S3 verbs on the state bucket are the state path's
# (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts). On this
# run's users and groups (`cdkd-iufo-*`) the role may CreateUser / CreateGroup,
# attach exactly `AWSDenyAll` (the `iam:PolicyARN` condition), and read them
# (GetUser, GetGroup, ListGroupsForUser, ListUserTags, the policy lists). The
# inline policy put (each CREATE's last wiring call) is denied, so each CREATE
# fails after IAM made the user or group; the policy detach and delete and the
# user / group delete are denied, so the provider's own cleanup cannot remove
# it. No statement allows a credential (access key, login profile) or a group
# membership. sts:AssumeRole is denied everywhere: nothing this session runs
# assumes a role (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct,denyAll]=process.argv.slice(1);const ents=[`arn:aws:iam::${acct}:user/cdkd-iufo-*`,`arn:aws:iam::${acct}:group/cdkd-iufo-*`];process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreateUser","iam:CreateGroup","iam:GetUser","iam:GetGroup","iam:ListGroupsForUser","iam:ListUserTags","iam:ListUserPolicies","iam:GetUserPolicy","iam:ListAttachedUserPolicies","iam:ListGroupPolicies","iam:GetGroupPolicy","iam:ListAttachedGroupPolicies"],Resource:ents},{Effect:"Allow",Action:["iam:AttachUserPolicy","iam:AttachGroupPolicy"],Resource:ents,Condition:{ArnEquals:{"iam:PolicyARN":denyAll}}},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["iam:PutUserPolicy","iam:PutGroupPolicy","iam:DeleteUserPolicy","iam:DeleteGroupPolicy","iam:DetachUserPolicy","iam:DetachGroupPolicy","iam:DeleteUser","iam:DeleteGroup"],Resource:ents},{Effect:"Deny",Action:"sts:AssumeRole",Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${DENY_ALL_ARN}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=iam-user-group-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-iam-user-group-fix-forward \
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
# fail before any CREATE for the wrong reason. Probed on BaseUser, which
# EXISTS. The probe cannot delete it: no statement allows DeleteUser, so it is
# refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws iam delete-user --user-name "${BASE_USER}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_USER} (its policy must refuse DeleteUser)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteUser never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws iam get-user --user-name "${BASE_USER}" \
    --query 'User.UserName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${BASE_USER}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not GetUser ${BASE_USER} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after IAM made the user or group"
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
for u in "${USER_A}" "${USER_C}"; do
  if ! present_eventually aws iam get-user --user-name "${u}"; then
    echo "[verify] FAIL: user ${u} does not exist after step 2 -- its CREATE failed before CreateUser returned (output above)" >&2
    exit 1
  fi
done
for g in "${GROUP_A}" "${GROUP_C}"; do
  if ! present_eventually aws iam get-group --group-name "${g}"; then
    echo "[verify] FAIL: group ${g} does not exist after step 2 -- its CREATE failed before CreateGroup returned (output above)" >&2
    exit 1
  fi
done
# The premise of the injection, from AWS's own answers: each CREATE failed on
# its inline policy (none carries one), the A's after their attach went
# through (AWSDenyAll is attached, and the refused detach left it there).
for u in "${USER_A}" "${USER_C}"; do
  N="$(aws iam list-user-policies --user-name "${u}" --query 'PolicyNames[]' --output text)"
  if [ -n "${N}" ]; then
    echo "[verify] FAIL: user ${u} carries inline policies (${N}) after step 2 (expected none: its CREATE must fail on the denied PutUserPolicy)" >&2
    exit 1
  fi
done
for g in "${GROUP_A}" "${GROUP_C}"; do
  N="$(aws iam list-group-policies --group-name "${g}" --query 'PolicyNames[]' --output text)"
  if [ -n "${N}" ]; then
    echo "[verify] FAIL: group ${g} carries inline policies (${N}) after step 2 (expected none: its CREATE must fail on the denied PutGroupPolicy)" >&2
    exit 1
  fi
done
UA_ATTACHED="$(aws iam list-attached-user-policies --user-name "${USER_A}" --query 'AttachedPolicies[].PolicyArn' --output text)"
GA_ATTACHED="$(aws iam list-attached-group-policies --group-name "${GROUP_A}" --query 'AttachedPolicies[].PolicyArn' --output text)"
if [ "${UA_ATTACHED}" != "${DENY_ALL_ARN}" ] || [ "${GA_ATTACHED}" != "${DENY_ALL_ARN}" ]; then
  echo "[verify] FAIL: after step 2 ${USER_A} has '${UA_ATTACHED}' and ${GROUP_A} '${GA_ATTACHED}' attached (expected ${DENY_ALL_ARN} on each: the CREATE must pass the attach and its cleanup must be refused the detach)" >&2
  exit 1
fi
# The deploy's own account: each CREATE's cleanup was refused.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for lid in UserA UserC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created IAM user ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${lid}'s refused cleanup (output above)" >&2
    exit 1
  fi
done
for lid in GroupA GroupC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created IAM group ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${lid}'s refused cleanup (output above)" >&2
    exit 1
  fi
done
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in UserA UserC GroupA GroupC; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655 / #4606: the journal carries the identity the settle
# compares before deleting a name-keyed orphan: the UserId / GroupId the create
# answered with, carried on the failure's mark. It must equal what IAM reports
# now, after the CREATE's wiring calls (the attach for the A's).
assert_journaled() { # usage: assert_journaled <logicalId> <name> <expected id>
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
UA_ID="$(user_id "${USER_A}")" || { echo "[verify] FAIL: GetUser ${USER_A} answered no UserId after step 2" >&2; exit 1; }
UC_ID="$(user_id "${USER_C}")" || { echo "[verify] FAIL: GetUser ${USER_C} answered no UserId after step 2" >&2; exit 1; }
GA_ID="$(group_id "${GROUP_A}")" || { echo "[verify] FAIL: GetGroup ${GROUP_A} answered no GroupId after step 2" >&2; exit 1; }
GC_ID="$(group_id "${GROUP_C}")" || { echo "[verify] FAIL: GetGroup ${GROUP_C} answered no GroupId after step 2" >&2; exit 1; }
assert_journaled UserA "${USER_A}" "${UA_ID}"
assert_journaled UserC "${USER_C}" "${UC_ID}"
assert_journaled GroupA "${GROUP_A}" "${GA_ID}"
assert_journaled GroupC "${GROUP_C}" "${GC_ID}"
echo "[verify] step 2 ok: two users and two groups are in AWS, journaled with their ids (${UA_ID} ${UC_ID} ${GA_ID} ${GC_ID}), with no state record"

echo "[verify] step 2b: ${USER_C} and ${GROUP_C} are deleted and their names re-used outside the stack"
aws iam delete-user --user-name "${USER_C}" >/dev/null
aws iam delete-group --group-name "${GROUP_C}" >/dev/null
assert_gone_eventually "step 2b: ${USER_C} survived its delete" \
  aws iam get-user --user-name "${USER_C}"
assert_gone_eventually "step 2b: ${GROUP_C} survived its delete" \
  aws iam get-group --group-name "${GROUP_C}"
# The marker: a path no CREATE of the stack sets (its entities sit at `/`).
C_MARKER="/cdkd-iufo-$(date -u +%s)/"
UC_CREATED=""
GC_CREATED=""
for _ in $(seq 1 12); do
  if [ -z "${UC_CREATED}" ]; then
    if aws iam create-user --user-name "${USER_C}" --path "${C_MARKER}" >/dev/null 2>"${LOG_DIR}/c-err"; then
      UC_CREATED=1
    else
      # Only the delete not having settled yet is retried.
      grep -q 'EntityAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
    fi
  fi
  if [ -z "${GC_CREATED}" ]; then
    if aws iam create-group --group-name "${GROUP_C}" --path "${C_MARKER}" >/dev/null 2>"${LOG_DIR}/c-err"; then
      GC_CREATED=1
    else
      grep -q 'EntityAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
    fi
  fi
  if [ -n "${UC_CREATED}" ] && [ -n "${GC_CREATED}" ]; then break; fi
  sleep 5
done
if [ -z "${UC_CREATED}" ] || [ -z "${GC_CREATED}" ]; then
  echo "[verify] FAIL: could not re-create ${USER_C} / ${GROUP_C} within a minute of their delete" >&2
  exit 1
fi
if ! present_eventually aws iam get-user --user-name "${USER_C}" \
  || ! present_eventually aws iam get-group --group-name "${GROUP_C}"; then
  echo "[verify] FAIL: the re-created ${USER_C} / ${GROUP_C} never read back" >&2
  exit 1
fi
# The premise the identity rests on: each re-created entity reports ANOTHER id
# under the same name.
UC2_ID="$(user_id "${USER_C}")" || { echo "[verify] FAIL: GetUser ${USER_C} answered no UserId after its re-create" >&2; exit 1; }
GC2_ID="$(group_id "${GROUP_C}")" || { echo "[verify] FAIL: GetGroup ${GROUP_C} answered no GroupId after its re-create" >&2; exit 1; }
if [ "${UC2_ID}" = "${UC_ID}" ] || [ "${GC2_ID}" = "${GC_ID}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${USER_C} reports UserId '${UC2_ID}' (deleted one '${UC_ID}') and ${GROUP_C} GroupId '${GC2_ID}' (deleted one '${GC_ID}'): an identity that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's IAM user/group identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: re-created outside the stack (${UC_ID} -> ${UC2_ID}, ${GC_ID} -> ${GC2_ID})"

echo "[verify] step 3: the fix-forward (same logical ids, other names)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
# 2: the C's re-used names are left in place with a warning, which counts as
# unaddressed (journaled-orphans.ts, `settleJournaledOrphansOnSuccess`). Any
# other code is a failed deploy, or a settle that skipped the warning.
if [ "${FF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 2: the re-used UserC / GroupC names are warned about and kept -- output above)" >&2
  exit 1
fi
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
# A keep warning naming an A, with no "another one" verdict for it, is the
# shape of an `unknown` verdict: the settle's read of the record's
# just-created `-b` entity may have missed it while IAM propagated.
kept_hint() { # usage: kept_hint <logicalId> <type> <-b name>
  if printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy"; then
    echo "[verify] WARN: $1 was kept with a keep warning (output above). If its line is not the 'another one' warning, isSameResource answered unknown, most likely because IAM's eventual consistency hid the just-created $3 from the settle's read; re-run before reading this as a regression" >&2
  fi
}
UA_GONE=""
for _ in $(seq 1 30); do
  if gone_probe aws iam get-user --user-name "${USER_A}"; then
    UA_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${UA_GONE}" ]; then
  kept_hint UserA AWS::IAM::User "${USER_A_B}"
  echo "FAIL: the earlier attempt's user ${USER_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606) (still present after 30 probes over ~150s)" >&2
  exit 1
fi
GA_GONE=""
for _ in $(seq 1 30); do
  if gone_probe aws iam get-group --group-name "${GROUP_A}"; then
    GA_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${GA_GONE}" ]; then
  kept_hint GroupA AWS::IAM::Group "${GROUP_A_B}"
  echo "FAIL: the earlier attempt's group ${GROUP_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606) (still present after 30 probes over ~150s)" >&2
  exit 1
fi
# The NEGATIVE CONTROL: the re-used names are someone else's now: kept,
# untouched. One read of the marker path and id could be a stale IAM answer
# for an entity the settle just deleted, so the same pair must read back
# twice, 5s apart.
C_STABLE=""
UC_PATH="<unread>"
UC3_ID="<unread>"
GC_PATH="<unread>"
GC3_ID="<unread>"
for _ in $(seq 1 6); do
  UC_PATH="$(aws iam get-user --user-name "${USER_C}" --query 'User.Path' --output text 2>&1)" || UC_PATH="<get-user failed: ${UC_PATH}>"
  UC3_ID="$(user_id "${USER_C}")" || UC3_ID="<read failed>"
  GC_PATH="$(aws iam get-group --group-name "${GROUP_C}" --query 'Group.Path' --output text 2>&1)" || GC_PATH="<get-group failed: ${GC_PATH}>"
  GC3_ID="$(group_id "${GROUP_C}")" || GC3_ID="<read failed>"
  if [ "${UC_PATH}" = "${C_MARKER}" ] && [ "${UC3_ID}" = "${UC2_ID}" ] \
    && [ "${GC_PATH}" = "${C_MARKER}" ] && [ "${GC3_ID}" = "${GC2_ID}" ]; then
    if [ -n "${C_STABLE}" ]; then
      C_STABLE=2
      break
    fi
    C_STABLE=1
  else
    C_STABLE=""
  fi
  sleep 5
done
if [ "${C_STABLE}" != "2" ]; then
  echo "[verify] FAIL: the re-created ${USER_C} / ${GROUP_C} were not left untouched by the fix-forward (user path '${UC_PATH}', id '${UC3_ID}', expected '${C_MARKER}' / ${UC2_ID}; group path '${GC_PATH}', id '${GC3_ID}', expected '${C_MARKER}' / ${GC2_ID}; not read back twice in a row)" >&2
  exit 1
fi
# The kept entries were warned about, so the journal goes with them.
assert_gone "the fix-forward kept the rollback journal (expected it removed: the A's deleted, the C's warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for u in "${USER_A_B}" "${USER_C_B}" "${BASE_USER}"; do
  if ! present_eventually aws iam get-user --user-name "${u}"; then
    echo "[verify] FAIL: the record's user ${u} is missing after the fix-forward (the settle must not delete the records' users)" >&2
    exit 1
  fi
done
for g in "${GROUP_A_B}" "${GROUP_C_B}"; do
  if ! present_eventually aws iam get-group --group-name "${g}"; then
    echo "[verify] FAIL: the record's group ${g} is missing after the fix-forward (the settle must not delete the records' groups)" >&2
    exit 1
  fi
done
if [ "$(user_id "${BASE_USER}")" != "${BASE_ID}" ]; then
  echo "[verify] FAIL: ${BASE_USER}'s UserId changed during the run (expected the baseline's ${BASE_ID})" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <name>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record UserA "${USER_A_B}"
assert_record UserC "${USER_C_B}"
assert_record GroupA "${GROUP_A_B}"
assert_record GroupC "${GROUP_C_B}"
assert_record BaseUser "${BASE_USER}"
# For the A's the assertions above decide on AWS's own answers, and the log
# lines below only confirm the deploy's account. For the C's it is the other
# way round: IAM reads can be stale, so the marker and id reads above only
# corroborate. What detects a wrong delete of a C is the exit code (2), the
# log lines below (no delete of it, its "another one" warning), and step 4's
# plain `delete-user` / `delete-group` of it, which fails the run if it is gone.
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name an A.
for pair in "UserA AWS::IAM::User" "GroupA AWS::IAM::Group"; do
  set -- ${pair}
  if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created $1"; then
    echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's $1 (output above)" >&2
    exit 1
  fi
  if printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy"; then
    echo "[verify] FAIL: the fix-forward deploy still warned about the earlier $1 instead of deleting it (output above)" >&2
    exit 1
  fi
done
for pair in "UserC AWS::IAM::User" "GroupC AWS::IAM::Group"; do
  set -- ${pair}
  # Sentinel for the wording above: the C's keep warnings use the same head,
  # so a reword that would blind the A checks fails here first.
  if ! printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy of stack ${STACK} created, is not deleted: the resource now under its physical id is another one"; then
    echo "[verify] FAIL: the fix-forward deploy did not warn that $1's name now holds another $2 (no '$1 ($2), which a failed deploy ... is another one' in the output): if the settle's keep-warning head changed, update the A checks above" >&2
    exit 1
  fi
  if printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created $1"; then
    echo "[verify] FAIL: the fix-forward deploy tried to delete $1's re-used name (output above)" >&2
    exit 1
  fi
done
set --
echo "[verify] step 3 ok: the fix-forward deleted ${USER_A} and ${GROUP_A}, kept the re-created ${USER_C} and ${GROUP_C} untouched, and the records hold the -b entities (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${USER_C} and ${GROUP_C} (this run's, no record's), then destroy"
aws iam delete-user --user-name "${USER_C}" >/dev/null
aws iam delete-group --group-name "${GROUP_C}" >/dev/null
assert_gone_eventually "step 4: ${USER_C} survived its delete" \
  aws iam get-user --user-name "${USER_C}"
assert_gone_eventually "step 4: ${GROUP_C} survived its delete" \
  aws iam get-group --group-name "${GROUP_C}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for u in "${ALL_USERS[@]}"; do
  assert_gone_eventually "user ${u} still exists after destroy" \
    aws iam get-user --user-name "${u}"
done
for g in "${ALL_GROUPS[@]}"; do
  assert_gone_eventually "group ${g} still exists after destroy" \
    aws iam get-group --group-name "${g}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "iam-user-group-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's IAM user and group and kept the ones whose names were re-used (go-to-k/cdkd#4606)"
