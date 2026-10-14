#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the IAM instance profile and managed policy arm: a
# fix-forward deploy deletes the instance profile or managed policy an earlier
# failed CREATE left in AWS, once a live read (`isSameResource` on
# `IAMInstanceProfileProvider` / `IAMManagedPolicyProvider`) proves it is not
# the one the new state record holds, and its journaled identity (the
# `InstanceProfileId` / `PolicyId` its `CreateInstanceProfile` / `CreatePolicy`
# answered with, `resourceIdentity` on the live side) proves the resource
# under the physical id is still the one that CREATE made. One whose name was
# deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseRole`, `BaseGroup`.
#   2. The failed CREATE. A role is created that may create an instance
#      profile or managed policy, attach one of this run's policies to
#      `BaseGroup`, and read them, but may not add a role to a profile, attach
#      a policy to a role, detach a policy, or delete a profile or policy. A
#      `--no-rollback` deploy run as that role with WITH_ORPHANS=true creates
#      `ProfileA`, `ProfileC`, `PolicyA` and `PolicyC`, fails each on its role
#      wiring (`PolicyA` after a successful group attach), and the provider's
#      own cleanup is refused too. Asserted: the deploy failed, all four exist
#      (no profile holds a role, `PolicyA` is attached to `BaseGroup` alone,
#      `PolicyC` to nothing), no state record holds them, and the rollback
#      journal carries each as a proven orphan whose identity is the id IAM
#      reports for it now (the premise that the wiring calls do not change it).
#   2b. The re-used names: `ProfileC`'s profile and `PolicyC`'s policy are
#      deleted and their names created again outside the stack (the profile
#      under a marker path, the policy under the same ARN with a marker
#      description). Asserted: each reports another id (the premise the
#      identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps every
#      orphan logical id under other names (`-b`). Asserted: `ProfileA`'s
#      profile and `PolicyA`'s policy are deleted (`deleting partially-created
#      ProfileA` / `PolicyA`; the policy detached from `BaseGroup` first), the
#      re-created `ProfileC` / `PolicyC` names are kept with their marker and
#      id and warned about as another resource (exit 2, the warning's code:
#      the NEGATIVE CONTROL), the journal is removed, and the state records
#      hold the new resources. Before #4606 the deploy kept `ProfileA`'s and
#      `PolicyA`'s too.
#   4. The re-created `ProfileC` profile and `PolicyC` policy (this run's, no
#      record's) are deleted by name, then `cdkd destroy`. Every profile,
#      policy, the role, the group, the state file and the restricted role are
#      gone, and the state prefix's object versions are swept.
#
# Cost: a few IAM instance profiles, managed policies, one role and one group
# (free; nothing assumes the role). On any failure, cleanup destroys the
# stack, deletes every profile, policy, role and group this run names and
# deletes the restricted role.
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
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws iam get-policy ...
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
# The other direction: a resource just created can take a moment to read back.
# Retry while it reads as gone; one that never appears still FAILs.
present_eventually() { # usage: present_eventually aws iam get-policy ...  (0 = present)
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
STACK="CdkdIamProfilePolicyFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/iam-profile-policy-fix-forward-orphan"
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

# The names the stack derives (lib/iam-profile-policy-fix-forward-orphan-stack.ts).
BASE_ROLE="cdkd-ippfo-base-role"
BASE_GROUP="cdkd-ippfo-base-group"
PROFILE_A="cdkd-ippfo-profile-a"
PROFILE_A_B="cdkd-ippfo-profile-a-b"
PROFILE_C="cdkd-ippfo-profile-c"
PROFILE_C_B="cdkd-ippfo-profile-c-b"
POLICY_ARN_PREFIX="arn:aws:iam::${ACCOUNT_ID}:policy/"
POLICY_A="${POLICY_ARN_PREFIX}cdkd-ippfo-policy-a"
POLICY_A_B="${POLICY_ARN_PREFIX}cdkd-ippfo-policy-a-b"
POLICY_C_NAME="cdkd-ippfo-policy-c"
POLICY_C="${POLICY_ARN_PREFIX}${POLICY_C_NAME}"
POLICY_C_B="${POLICY_ARN_PREFIX}cdkd-ippfo-policy-c-b"
ALL_PROFILES=("${PROFILE_A}" "${PROFILE_A_B}" "${PROFILE_C}" "${PROFILE_C_B}")
ALL_POLICIES=("${POLICY_A}" "${POLICY_A_B}" "${POLICY_C}" "${POLICY_C_B}")

DENY_ROLE="${STACK}-no-wire"
DENY_POLICY_NAME="create-without-wiring"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the profiles, policies
# or the stack may belong to a concurrent or earlier run, which a failure-path
# delete must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The providers' identity tokens, the `InstanceProfileId` / `PolicyId`
# (`instanceProfileIdentityToken` / `policyIdentityToken`). Each fails the call
# on a read that answers none.
profile_id() { # usage: profile_id <instance profile name>
  local id
  id="$(aws iam get-instance-profile --instance-profile-name "$1" \
    --query 'InstanceProfile.InstanceProfileId' --output text)" || return 1
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    return 1
  fi
  printf '%s' "${id}"
}
policy_id() { # usage: policy_id <policy arn>
  local id
  id="$(aws iam get-policy --policy-arn "$1" --query 'Policy.PolicyId' --output text)" || return 1
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    return 1
  fi
  printf '%s' "${id}"
}

delete_profile_by_name() { ( # usage: delete_profile_by_name <name>  (best-effort; roles first)
  set +eu
  for r in $(aws iam get-instance-profile --instance-profile-name "$1" --query 'InstanceProfile.Roles[].RoleName' --output text 2>/dev/null); do
    aws iam remove-role-from-instance-profile --instance-profile-name "$1" --role-name "${r}" >/dev/null 2>&1
  done
  aws iam delete-instance-profile --instance-profile-name "$1" >/dev/null 2>&1
  true
); }
delete_policy_by_arn() { ( # usage: delete_policy_by_arn <arn>  (best-effort; attachments and versions first)
  set +eu
  for g in $(aws iam list-entities-for-policy --policy-arn "$1" --query 'PolicyGroups[].GroupName' --output text 2>/dev/null); do
    aws iam detach-group-policy --group-name "${g}" --policy-arn "$1" >/dev/null 2>&1
  done
  for r in $(aws iam list-entities-for-policy --policy-arn "$1" --query 'PolicyRoles[].RoleName' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${r}" --policy-arn "$1" >/dev/null 2>&1
  done
  for u in $(aws iam list-entities-for-policy --policy-arn "$1" --query 'PolicyUsers[].UserName' --output text 2>/dev/null); do
    aws iam detach-user-policy --user-name "${u}" --policy-arn "$1" >/dev/null 2>&1
  done
  for v in $(aws iam list-policy-versions --policy-arn "$1" --query 'Versions[?!IsDefaultVersion].VersionId' --output text 2>/dev/null); do
    aws iam delete-policy-version --policy-arn "$1" --version-id "${v}" >/dev/null 2>&1
  done
  aws iam delete-policy --policy-arn "$1" >/dev/null 2>&1
  true
); }
delete_base_by_name() { ( # usage: delete_base_by_name  (best-effort; the base role and group)
  set +eu
  for p in $(aws iam list-instance-profiles-for-role --role-name "${BASE_ROLE}" --query 'InstanceProfiles[].InstanceProfileName' --output text 2>/dev/null); do
    aws iam remove-role-from-instance-profile --instance-profile-name "${p}" --role-name "${BASE_ROLE}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-role-policies --role-name "${BASE_ROLE}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "${BASE_ROLE}" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "${BASE_ROLE}" >/dev/null 2>&1
  for a in $(aws iam list-attached-group-policies --group-name "${BASE_GROUP}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-group-policy --group-name "${BASE_GROUP}" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-group --group-name "${BASE_GROUP}" >/dev/null 2>&1
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
    for p in "${ALL_PROFILES[@]}"; do
      delete_profile_by_name "${p}"
    done
    for a in "${ALL_POLICIES[@]}"; do
      delete_policy_by_arn "${a}"
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    delete_base_by_name
    # IAM is eventually consistent: a bounded wait before the WARN.
    for p in "${ALL_PROFILES[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-instance-profile --instance-profile-name "${p}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-instance-profile --instance-profile-name "${p}" ) \
        || echo "[verify] WARN: instance profile ${p} could not be confirmed deleted; delete it by hand" >&2
    done
    for a in "${ALL_POLICIES[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-policy --policy-arn "${a}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-policy --policy-arn "${a}" ) \
        || echo "[verify] WARN: managed policy ${a} could not be confirmed deleted; delete it by hand" >&2
    done
    ( gone_probe aws iam get-role --role-name "${BASE_ROLE}" ) \
      || echo "[verify] WARN: role ${BASE_ROLE} could not be confirmed deleted; delete it by hand" >&2
    ( gone_probe aws iam get-group --group-name "${BASE_GROUP}" ) \
      || echo "[verify] WARN: group ${BASE_GROUP} could not be confirmed deleted; delete it by hand" >&2
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
for p in "${ALL_PROFILES[@]}"; do
  assert_gone "precondition: instance profile ${p} already exists (left by an earlier run); delete it first" \
    aws iam get-instance-profile --instance-profile-name "${p}"
done
for a in "${ALL_POLICIES[@]}"; do
  assert_gone "precondition: managed policy ${a} already exists (left by an earlier run); delete it first" \
    aws iam get-policy --policy-arn "${a}"
done
assert_gone "precondition: role ${BASE_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${BASE_ROLE}"
assert_gone "precondition: group ${BASE_GROUP} already exists (left by an earlier run); delete it first" \
  aws iam get-group --group-name "${BASE_GROUP}"
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseRole, BaseGroup)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if ! present_eventually aws iam get-role --role-name "${BASE_ROLE}" \
  || ! present_eventually aws iam get-group --group-name "${BASE_GROUP}"; then
  echo "[verify] FAIL: ${BASE_ROLE} / ${BASE_GROUP} do not read back after step 1" >&2
  exit 1
fi

echo "[verify] step 2: a role that may create a profile or policy but neither wire it to a role nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs,
# iam:ListPolicies and sts:GetCallerIdentity (which take no resource) are `*`;
# SSM is the CDK bootstrap parameters, KMS only through S3 (the state bucket's
# encryption). The S3 verbs on the state bucket are the state path's
# (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts). On this
# run's resources (`cdkd-ippfo-*`) the role may CreateInstanceProfile /
# CreatePolicy, attach one of this run's policies to a `cdkd-ippfo-*` group
# (the `iam:PolicyARN` condition), and read them. The role add and the role
# attach (each CREATE's role wiring) are denied, so each CREATE fails after
# IAM made the profile or policy; the role removal, every detach, the profile,
# policy, policy-version, role and group deletes are denied, so the providers'
# own cleanup cannot remove it. No statement allows a credential, a PassRole
# or a role or user write. sts:AssumeRole is denied everywhere: nothing this
# session runs assumes a role (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);const p=`arn:aws:iam::${acct}:`;const ents=[`${p}instance-profile/cdkd-ippfo-*`,`${p}policy/cdkd-ippfo-*`,`${p}role/cdkd-ippfo-*`,`${p}group/cdkd-ippfo-*`];process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreateInstanceProfile","iam:CreatePolicy","iam:GetInstanceProfile","iam:ListInstanceProfileTags","iam:GetPolicy","iam:GetPolicyVersion","iam:ListPolicyVersions","iam:ListPolicyTags","iam:ListEntitiesForPolicy","iam:GetRole","iam:ListRolePolicies","iam:ListAttachedRolePolicies","iam:ListRoleTags","iam:GetGroup","iam:ListGroupPolicies","iam:ListAttachedGroupPolicies"],Resource:ents},{Effect:"Allow",Action:"iam:AttachGroupPolicy",Resource:`${p}group/cdkd-ippfo-*`,Condition:{ArnLike:{"iam:PolicyARN":`${p}policy/cdkd-ippfo-*`}}},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","iam:ListPolicies","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["iam:AddRoleToInstanceProfile","iam:RemoveRoleFromInstanceProfile","iam:DeleteInstanceProfile","iam:AttachRolePolicy","iam:DetachRolePolicy","iam:DetachGroupPolicy","iam:DetachUserPolicy","iam:DeletePolicy","iam:DeletePolicyVersion","iam:DeleteRole","iam:DeleteGroup","iam:PassRole"],Resource:ents},{Effect:"Deny",Action:"sts:AssumeRole",Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=iam-profile-policy-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
assume_err=""
for _ in $(seq 1 24); do
  # stderr (the error text only) goes to the log; stdout (the credentials)
  # stays in the variable.
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-iam-profile-policy-fix-forward \
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
# fail before any CREATE for the wrong reason. Probed on BaseGroup, which
# EXISTS. The probe cannot delete it: no statement allows DeleteGroup, so it
# is refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws iam delete-group --group-name "${BASE_GROUP}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_GROUP} (its policy must refuse DeleteGroup)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteGroup never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws iam get-role --role-name "${BASE_ROLE}" \
    --query 'Role.RoleName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${BASE_ROLE}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not GetRole ${BASE_ROLE} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after IAM made the profile or policy"
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
for p in "${PROFILE_A}" "${PROFILE_C}"; do
  if ! present_eventually aws iam get-instance-profile --instance-profile-name "${p}"; then
    echo "[verify] FAIL: instance profile ${p} does not exist after step 2 -- its CREATE failed before CreateInstanceProfile returned (output above)" >&2
    exit 1
  fi
done
for a in "${POLICY_A}" "${POLICY_C}"; do
  if ! present_eventually aws iam get-policy --policy-arn "${a}"; then
    echo "[verify] FAIL: managed policy ${a} does not exist after step 2 -- its CREATE failed before CreatePolicy returned (output above)" >&2
    exit 1
  fi
done
# The premise of the injection, from AWS's own answers: each CREATE failed on
# its role wiring (no profile holds a role, no policy is attached to one),
# PolicyA after its group attach went through (attached to BaseGroup, and the
# refused detach left it there).
for p in "${PROFILE_A}" "${PROFILE_C}"; do
  N="$(aws iam get-instance-profile --instance-profile-name "${p}" --query 'InstanceProfile.Roles[].RoleName' --output text)"
  if [ -n "${N}" ]; then
    echo "[verify] FAIL: instance profile ${p} holds roles (${N}) after step 2 (expected none: its CREATE must fail on the denied AddRoleToInstanceProfile)" >&2
    exit 1
  fi
done
entities() { # usage: entities <policy arn>  -> "groups|roles|users"
  local out
  out="$(aws iam list-entities-for-policy --policy-arn "$1" --output json)" || return 1
  printf '%s' "${out}" | jq -r '[(.PolicyGroups // [] | map(.GroupName) | join(",")), (.PolicyRoles // [] | map(.RoleName) | join(",")), (.PolicyUsers // [] | map(.UserName) | join(","))] | join("|")'
}
PA_ENTITIES="$(entities "${POLICY_A}")"
PC_ENTITIES="$(entities "${POLICY_C}")"
if [ "${PA_ENTITIES}" != "${BASE_GROUP}||" ] || [ "${PC_ENTITIES}" != "||" ]; then
  echo "[verify] FAIL: after step 2 ${POLICY_A} is attached to '${PA_ENTITIES}' and ${POLICY_C} to '${PC_ENTITIES}' (groups|roles|users; expected '${BASE_GROUP}||' and '||': each CREATE must fail on the denied AttachRolePolicy, PolicyA after its group attach, and its cleanup must be refused the detach)" >&2
  exit 1
fi
# The deploy's own account: each CREATE's cleanup was refused.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for lid in ProfileA ProfileC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created IAM instance profile ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${lid}'s refused cleanup (output above)" >&2
    exit 1
  fi
done
for lid in PolicyA PolicyC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created managed policy ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${lid}'s refused cleanup (output above)" >&2
    exit 1
  fi
done
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in ProfileA ProfileC PolicyA PolicyC; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655 / #4606: the journal carries the identity the settle
# compares before deleting a name-keyed orphan: the InstanceProfileId /
# PolicyId the create answered with, carried on the failure's mark. It must
# equal what IAM reports now, after the CREATE's wiring calls (the group
# attach for PolicyA).
assert_journaled() { # usage: assert_journaled <logicalId> <physical id> <expected id>
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
PRA_ID="$(profile_id "${PROFILE_A}")" || { echo "[verify] FAIL: GetInstanceProfile ${PROFILE_A} answered no InstanceProfileId after step 2" >&2; exit 1; }
PRC_ID="$(profile_id "${PROFILE_C}")" || { echo "[verify] FAIL: GetInstanceProfile ${PROFILE_C} answered no InstanceProfileId after step 2" >&2; exit 1; }
POA_ID="$(policy_id "${POLICY_A}")" || { echo "[verify] FAIL: GetPolicy ${POLICY_A} answered no PolicyId after step 2" >&2; exit 1; }
POC_ID="$(policy_id "${POLICY_C}")" || { echo "[verify] FAIL: GetPolicy ${POLICY_C} answered no PolicyId after step 2" >&2; exit 1; }
assert_journaled ProfileA "${PROFILE_A}" "${PRA_ID}"
assert_journaled ProfileC "${PROFILE_C}" "${PRC_ID}"
assert_journaled PolicyA "${POLICY_A}" "${POA_ID}"
assert_journaled PolicyC "${POLICY_C}" "${POC_ID}"
echo "[verify] step 2 ok: two instance profiles and two managed policies are in AWS, journaled with their ids (${PRA_ID} ${PRC_ID} ${POA_ID} ${POC_ID}), with no state record"

echo "[verify] step 2b: ${PROFILE_C} and ${POLICY_C} are deleted and their names re-used outside the stack"
aws iam delete-instance-profile --instance-profile-name "${PROFILE_C}" >/dev/null
aws iam delete-policy --policy-arn "${POLICY_C}" >/dev/null
assert_gone_eventually "step 2b: ${PROFILE_C} survived its delete" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE_C}"
assert_gone_eventually "step 2b: ${POLICY_C} survived its delete" \
  aws iam get-policy --policy-arn "${POLICY_C}"
# The markers: a profile path no CREATE of the stack sets (its profiles sit at
# `/`), and a policy description none sets. The policy keeps its path, so the
# re-created one answers to the journaled ARN itself.
C_STAMP="$(date -u +%s)"
C_MARKER="/cdkd-ippfo-${C_STAMP}/"
C_DESCRIPTION="cdkd-ippfo re-created outside the stack ${C_STAMP}"
C_DOCUMENT='{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"logs:CreateLogGroup","Resource":"*"}]}'
PRC_CREATED=""
POC_CREATED=""
for _ in $(seq 1 12); do
  if [ -z "${PRC_CREATED}" ]; then
    if aws iam create-instance-profile --instance-profile-name "${PROFILE_C}" --path "${C_MARKER}" >/dev/null 2>"${LOG_DIR}/c-err"; then
      PRC_CREATED=1
    else
      # Only the delete not having settled yet is retried.
      grep -q 'EntityAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
    fi
  fi
  if [ -z "${POC_CREATED}" ]; then
    if aws iam create-policy --policy-name "${POLICY_C_NAME}" --description "${C_DESCRIPTION}" \
      --policy-document "${C_DOCUMENT}" >/dev/null 2>"${LOG_DIR}/c-err"; then
      POC_CREATED=1
    else
      grep -q 'EntityAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
    fi
  fi
  if [ -n "${PRC_CREATED}" ] && [ -n "${POC_CREATED}" ]; then break; fi
  sleep 5
done
if [ -z "${PRC_CREATED}" ] || [ -z "${POC_CREATED}" ]; then
  echo "[verify] FAIL: could not re-create ${PROFILE_C} / ${POLICY_C} within a minute of their delete" >&2
  exit 1
fi
if ! present_eventually aws iam get-instance-profile --instance-profile-name "${PROFILE_C}" \
  || ! present_eventually aws iam get-policy --policy-arn "${POLICY_C}"; then
  echo "[verify] FAIL: the re-created ${PROFILE_C} / ${POLICY_C} never read back" >&2
  exit 1
fi
# The premise the identity rests on: each re-created resource reports ANOTHER
# id under the same physical id.
PRC2_ID="$(profile_id "${PROFILE_C}")" || { echo "[verify] FAIL: GetInstanceProfile ${PROFILE_C} answered no InstanceProfileId after its re-create" >&2; exit 1; }
POC2_ID="$(policy_id "${POLICY_C}")" || { echo "[verify] FAIL: GetPolicy ${POLICY_C} answered no PolicyId after its re-create" >&2; exit 1; }
if [ "${PRC2_ID}" = "${PRC_ID}" ] || [ "${POC2_ID}" = "${POC_ID}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${PROFILE_C} reports InstanceProfileId '${PRC2_ID}' (deleted one '${PRC_ID}') and ${POLICY_C} PolicyId '${POC2_ID}' (deleted one '${POC_ID}'): an identity that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's instance profile / managed policy identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: re-created outside the stack (${PRC_ID} -> ${PRC2_ID}, ${POC_ID} -> ${POC2_ID})"

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
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 2: the re-used ProfileC / PolicyC names are warned about and kept -- output above)" >&2
  exit 1
fi
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
# A keep warning naming an A, with no "another one" verdict for it, is the
# shape of an `unknown` verdict: the settle's read of the record's
# just-created `-b` resource may have missed it while IAM propagated.
kept_hint() { # usage: kept_hint <logicalId> <type> <-b id>
  if printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy"; then
    echo "[verify] WARN: $1 was kept with a keep warning (output above). If its line is not the 'another one' warning, isSameResource answered unknown, most likely because IAM's eventual consistency hid the just-created $3 from the settle's read; re-run before reading this as a regression" >&2
  fi
}
PRA_GONE=""
for _ in $(seq 1 30); do
  if gone_probe aws iam get-instance-profile --instance-profile-name "${PROFILE_A}"; then
    PRA_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${PRA_GONE}" ]; then
  kept_hint ProfileA AWS::IAM::InstanceProfile "${PROFILE_A_B}"
  echo "FAIL: the earlier attempt's instance profile ${PROFILE_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606) (still present after 30 probes over ~150s)" >&2
  exit 1
fi
POA_GONE=""
for _ in $(seq 1 30); do
  if gone_probe aws iam get-policy --policy-arn "${POLICY_A}"; then
    POA_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${POA_GONE}" ]; then
  kept_hint PolicyA AWS::IAM::ManagedPolicy "${POLICY_A_B}"
  echo "FAIL: the earlier attempt's managed policy ${POLICY_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606) (still present after 30 probes over ~150s)" >&2
  exit 1
fi
# The NEGATIVE CONTROL: the re-used names are someone else's now: kept,
# untouched. One read of the marker and id could be a stale IAM answer for a
# resource the settle just deleted, so the same pair must read back twice, 5s
# apart.
C_STABLE=""
PRC_PATH="<unread>"
PRC3_ID="<unread>"
POC_DESC="<unread>"
POC3_ID="<unread>"
for _ in $(seq 1 6); do
  PRC_PATH="$(aws iam get-instance-profile --instance-profile-name "${PROFILE_C}" --query 'InstanceProfile.Path' --output text 2>&1)" || PRC_PATH="<get-instance-profile failed: ${PRC_PATH}>"
  PRC3_ID="$(profile_id "${PROFILE_C}")" || PRC3_ID="<read failed>"
  POC_DESC="$(aws iam get-policy --policy-arn "${POLICY_C}" --query 'Policy.Description' --output text 2>&1)" || POC_DESC="<get-policy failed: ${POC_DESC}>"
  POC3_ID="$(policy_id "${POLICY_C}")" || POC3_ID="<read failed>"
  if [ "${PRC_PATH}" = "${C_MARKER}" ] && [ "${PRC3_ID}" = "${PRC2_ID}" ] \
    && [ "${POC_DESC}" = "${C_DESCRIPTION}" ] && [ "${POC3_ID}" = "${POC2_ID}" ]; then
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
  echo "[verify] FAIL: the re-created ${PROFILE_C} / ${POLICY_C} were not left untouched by the fix-forward (profile path '${PRC_PATH}', id '${PRC3_ID}', expected '${C_MARKER}' / ${PRC2_ID}; policy description '${POC_DESC}', id '${POC3_ID}', expected '${C_DESCRIPTION}' / ${POC2_ID}; not read back twice in a row)" >&2
  exit 1
fi
# The kept entries were warned about, so the journal goes with them.
assert_gone "the fix-forward kept the rollback journal (expected it removed: the A's deleted, the C's warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for p in "${PROFILE_A_B}" "${PROFILE_C_B}"; do
  if ! present_eventually aws iam get-instance-profile --instance-profile-name "${p}"; then
    echo "[verify] FAIL: the record's instance profile ${p} is missing after the fix-forward (the settle must not delete the records' profiles)" >&2
    exit 1
  fi
done
for a in "${POLICY_A_B}" "${POLICY_C_B}"; do
  if ! present_eventually aws iam get-policy --policy-arn "${a}"; then
    echo "[verify] FAIL: the record's managed policy ${a} is missing after the fix-forward (the settle must not delete the records' policies)" >&2
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
assert_record ProfileA "${PROFILE_A_B}"
assert_record ProfileC "${PROFILE_C_B}"
assert_record PolicyA "${POLICY_A_B}"
assert_record PolicyC "${POLICY_C_B}"
assert_record BaseRole "${BASE_ROLE}"
assert_record BaseGroup "${BASE_GROUP}"
# For the A's the assertions above decide on AWS's own answers, and the log
# lines below only confirm the deploy's account. For the C's it is the other
# way round: IAM reads can be stale, so the marker and id reads above only
# corroborate. What detects a wrong delete of a C is the exit code (2), the
# log lines below (no delete of it, its "another one" warning), and step 4's
# plain delete of it, which fails the run if it is gone.
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name an A.
for pair in "ProfileA AWS::IAM::InstanceProfile" "PolicyA AWS::IAM::ManagedPolicy"; do
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
for pair in "ProfileC AWS::IAM::InstanceProfile ${PROFILE_C_B}" "PolicyC AWS::IAM::ManagedPolicy ${POLICY_C_B}"; do
  set -- ${pair}
  # Sentinel for the wording above: the C's keep warnings use the same head,
  # so a reword that would blind the A checks fails here first.
  if ! printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy of stack ${STACK} created, is not deleted: the resource now under its physical id is another one"; then
    # Kept with another keep warning is the eventual-consistency shape the A
    # side's hint names: the settle's read missed the just-created -b one.
    kept_hint "$1" "$2" "$3"
    echo "[verify] FAIL: the fix-forward deploy did not warn that $1's physical id now holds another $2 (no '$1 ($2), which a failed deploy ... is another one' in the output): if the settle's keep-warning head changed, update the A checks above" >&2
    exit 1
  fi
  if printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created $1"; then
    echo "[verify] FAIL: the fix-forward deploy tried to delete $1's re-used name (output above)" >&2
    exit 1
  fi
done
set --
echo "[verify] step 3 ok: the fix-forward deleted ${PROFILE_A} and ${POLICY_A}, kept the re-created ${PROFILE_C} and ${POLICY_C} untouched, and the records hold the -b resources (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${PROFILE_C} and ${POLICY_C} (this run's, no record's), then destroy"
aws iam delete-instance-profile --instance-profile-name "${PROFILE_C}" >/dev/null
aws iam delete-policy --policy-arn "${POLICY_C}" >/dev/null
assert_gone_eventually "step 4: ${PROFILE_C} survived its delete" \
  aws iam get-instance-profile --instance-profile-name "${PROFILE_C}"
assert_gone_eventually "step 4: ${POLICY_C} survived its delete" \
  aws iam get-policy --policy-arn "${POLICY_C}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for p in "${ALL_PROFILES[@]}"; do
  assert_gone_eventually "instance profile ${p} still exists after destroy" \
    aws iam get-instance-profile --instance-profile-name "${p}"
done
for a in "${ALL_POLICIES[@]}"; do
  assert_gone_eventually "managed policy ${a} still exists after destroy" \
    aws iam get-policy --policy-arn "${a}"
done
assert_gone_eventually "role ${BASE_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${BASE_ROLE}"
assert_gone_eventually "group ${BASE_GROUP} still exists after destroy" \
  aws iam get-group --group-name "${BASE_GROUP}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "iam-profile-policy-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's IAM instance profile and managed policy and kept the ones whose names were re-used (go-to-k/cdkd#4606)"
