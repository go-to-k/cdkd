#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the IAM role arm: a fix-forward deploy deletes the role an
# earlier failed CREATE left in AWS, once a live read
# (`IAMRoleProvider.isSameResource`) proves it is not the role the new state
# record holds, and its journaled identity (the `RoleId` its `CreateRole`
# answered with, `IAMRoleProvider.resourceIdentity` on the live side) proves
# the role under the name is still the one that CREATE made. A role whose name
# was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `BaseRole`.
#   2. The failed CREATE. A role is created that may create a role, put an
#      inline policy on it and read it, but may not tag it, delete its inline
#      policy, or delete it. A `--no-rollback` deploy run as that role with
#      WITH_ORPHANS=true creates `OrphanA`'s and `OrphanC`'s roles, fails each
#      on `TagRole` (OrphanA after a successful `PutRolePolicy`), and the
#      provider's own cleanup (`DeleteRolePolicy` / `DeleteRole`) is refused
#      too. Asserted: the deploy failed, both roles exist untagged (OrphanA with
#      its inline policy), no state record holds them, and the rollback journal
#      carries each as a proven orphan whose identity is the `RoleId` GetRole
#      reports for it (the premise that the wiring calls do not change it).
#   2b. The re-used name: `OrphanC`'s role is deleted and its name created
#      again outside the stack, with a marker tag. Asserted: it reports another
#      `RoleId` (the premise the identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps every
#      orphan logical id under other names (`-b`). Asserted: `OrphanA`'s
#      earlier role is deleted (`deleting partially-created OrphanA`), the
#      re-created `OrphanC` name is kept with its marker and `RoleId` and warned
#      about as another role (exit 2, the warning's code: the NEGATIVE
#      CONTROL), the journal is removed, and the state records hold the new
#      roles. Before #4606 the deploy kept `OrphanA`'s role too.
#   4. The re-created `OrphanC` role (this run's, no record's) is deleted by
#      name, then `cdkd destroy`. Every role, the state file and the restricted
#      role are gone, and the state prefix's object versions are swept.
#
# Cost: a few IAM roles (free). On any failure, cleanup destroys the stack,
# deletes every role this run names and deletes the restricted role.
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
# IAM is eventually consistent: a DeleteRole can take a moment to read as
# gone. Retry the gone-probe on a bounded schedule; a role that never
# disappears still FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws iam get-role ...
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
# The other direction: a role just created can take a moment to read back.
# Retry while it reads as gone; one that never appears still FAILs.
present_eventually() { # usage: present_eventually aws iam get-role ...  (0 = present)
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
STACK="CdkdIamRoleFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/iam-role-fix-forward-orphan"
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

# The names the stack derives (lib/iam-role-fix-forward-orphan-stack.ts).
BASE_ROLE="cdkd-irffo-base"
ROLE_A="cdkd-irffo-a"
ROLE_A_B="cdkd-irffo-a-b"
ROLE_C="cdkd-irffo-c"
ROLE_C_B="cdkd-irffo-c-b"
ALL_ROLES=("${BASE_ROLE}" "${ROLE_A}" "${ROLE_A_B}" "${ROLE_C}" "${ROLE_C_B}")
INLINE_POLICY="irffo-inline"
LAMBDA_TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'

DENY_ROLE="${STACK}-no-tag"
DENY_POLICY_NAME="create-without-tag"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the roles or the stack
# may belong to a concurrent or earlier run, which a failure-path delete must
# not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The provider's identity token, the role's `RoleId`
# (iam-role-provider.ts, `roleIdentityToken`). Fails the call on a read that
# answers none.
role_id() { # usage: role_id <role>
  local id
  id="$(aws iam get-role --role-name "$1" --query 'Role.RoleId' --output text)" || return 1
  if [ -z "${id}" ] || [ "${id}" = "None" ]; then
    return 1
  fi
  printf '%s' "${id}"
}

delete_role_by_name() { ( # usage: delete_role_by_name <role>  (best-effort; inline and managed policies first)
  set +eu
  for p in $(aws iam list-role-policies --role-name "$1" --query 'PolicyNames[]' --output text 2>/dev/null); do
    aws iam delete-role-policy --role-name "$1" --policy-name "${p}" >/dev/null 2>&1
  done
  for a in $(aws iam list-attached-role-policies --role-name "$1" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam detach-role-policy --role-name "$1" --policy-arn "${a}" >/dev/null 2>&1
  done
  aws iam delete-role --role-name "$1" >/dev/null 2>&1
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
    # The roles no state record holds (the orphans and the re-created name)
    # first, by name; the destroy below then deletes what the records hold.
    for r in "${ALL_ROLES[@]}"; do
      delete_role_by_name "${r}"
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # IAM is eventually consistent: a bounded wait before the WARN.
    for r in "${ALL_ROLES[@]}"; do
      for _ in $(seq 1 12); do
        if ( gone_probe aws iam get-role --role-name "${r}" ); then break; fi
        sleep 5
      done
      ( gone_probe aws iam get-role --role-name "${r}" ) \
        || echo "[verify] WARN: role ${r} could not be confirmed deleted; delete it by hand" >&2
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

# A record or role left by an earlier, interrupted run would be blamed on the
# steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for r in "${ALL_ROLES[@]}" "${DENY_ROLE}"; do
  assert_gone "precondition: role ${r} already exists (left by an earlier run); delete it first" \
    aws iam get-role --role-name "${r}"
done
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseRole)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
BASE_ID="$(role_id "${BASE_ROLE}")" || { echo "[verify] FAIL: ${BASE_ROLE} reads no RoleId after step 1" >&2; exit 1; }

echo "[verify] step 2: a role that may create a role but neither tag nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs and
# sts:GetCallerIdentity (which takes no resource) are `*`; SSM is the CDK
# bootstrap parameters, KMS only through S3 (the state bucket's encryption).
# The S3 verbs on the state bucket are the state path's
# (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts). On this
# run's roles (`cdkd-irffo-*`) the role may CreateRole and PutRolePolicy, and
# read (GetRole, ListRoleTags, ListRolePolicies, GetRolePolicy,
# ListAttachedRolePolicies, ListInstanceProfilesForRole). TagRole (the CREATE's
# last wiring call) is denied, so each CREATE fails after IAM made the role;
# DeleteRolePolicy and DeleteRole are denied, so the provider's own cleanup
# cannot remove it. sts:AssumeRole is denied everywhere: CreateRole and
# PutRolePolicy could otherwise mint a role trusting this session and assume
# it. Nothing this session runs assumes a role (cdkd is run without
# --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);const roles=`arn:aws:iam::${acct}:role/cdkd-irffo-*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreateRole","iam:PutRolePolicy","iam:GetRole","iam:ListRoleTags","iam:ListRolePolicies","iam:GetRolePolicy","iam:ListAttachedRolePolicies","iam:ListInstanceProfilesForRole"],Resource:roles},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["iam:TagRole","iam:DeleteRolePolicy","iam:DeleteRole"],Resource:roles},{Effect:"Deny",Action:"sts:AssumeRole",Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=iam-role-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-iam-role-fix-forward \
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
# fail before any CREATE for the wrong reason. Probed on BaseRole, which
# EXISTS. The probe cannot delete it: no statement allows DeleteRole, so it is
# refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws iam delete-role --role-name "${BASE_ROLE}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_ROLE} (its policy must refuse DeleteRole)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteRole never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
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

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after IAM made the role"
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
for r in "${ROLE_A}" "${ROLE_C}"; do
  if ! present_eventually aws iam get-role --role-name "${r}"; then
    echo "[verify] FAIL: role ${r} does not exist after step 2 -- its CREATE failed before CreateRole returned (output above)" >&2
    exit 1
  fi
done
# The premise of the injection, from AWS's own answers: each CREATE failed on
# TagRole (the roles carry no tag), OrphanA's after its PutRolePolicy went
# through (its inline policy is there).
for r in "${ROLE_A}" "${ROLE_C}"; do
  TAGS="$(aws iam list-role-tags --role-name "${r}" --query 'length(Tags)' --output text)"
  if [ "${TAGS}" != "0" ]; then
    echo "[verify] FAIL: role ${r} carries ${TAGS} tag(s) after step 2 (expected none: its CREATE must fail on the denied TagRole)" >&2
    exit 1
  fi
done
A_POLICIES="$(aws iam list-role-policies --role-name "${ROLE_A}" --query 'PolicyNames' --output text)"
if [ "${A_POLICIES}" != "${INLINE_POLICY}" ]; then
  echo "[verify] FAIL: role ${ROLE_A}'s inline policies read '${A_POLICIES}' after step 2 (expected ${INLINE_POLICY}: its CREATE must pass PutRolePolicy and its cleanup must be refused DeleteRolePolicy)" >&2
  exit 1
fi
# The deploy's own account: each CREATE's cleanup was refused.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for lid in OrphanA OrphanC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created IAM role ${lid}"; then
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
# compares before deleting a name-keyed orphan: the RoleId CreateRole answered
# with, carried on the failure's mark. It must equal what GetRole reports now,
# after the CREATE's wiring calls (PutRolePolicy for OrphanA).
assert_journaled() { # usage: assert_journaled <logicalId> <role>
  local op want
  want="$(role_id "$2")" || { echo "[verify] FAIL: GetRole $2 answered no RoleId after step 2" >&2; exit 1; }
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
assert_journaled OrphanA "${ROLE_A}"
assert_journaled OrphanC "${ROLE_C}"
C_ID="$(role_id "${ROLE_C}")" || { echo "[verify] FAIL: GetRole ${ROLE_C} answered no RoleId after step 2" >&2; exit 1; }
echo "[verify] step 2 ok: ${ROLE_A} and ${ROLE_C} are in AWS, journaled with their RoleIds, with no state record"

echo "[verify] step 2b: ${ROLE_C} is deleted and its name re-used outside the stack"
aws iam delete-role --role-name "${ROLE_C}" >/dev/null
assert_gone_eventually "step 2b: ${ROLE_C} survived its delete" \
  aws iam get-role --role-name "${ROLE_C}"
C_MARKER="phase2b-$(date -u +%s)"
C_CREATED=""
for _ in $(seq 1 12); do
  if aws iam create-role --role-name "${ROLE_C}" --assume-role-policy-document "${LAMBDA_TRUST}" \
    --tags "Key=cdkd-integ-marker,Value=${C_MARKER}" >/dev/null 2>"${LOG_DIR}/c-err"; then
    C_CREATED=1
    break
  fi
  # Only the delete not having settled yet is retried.
  grep -q 'EntityAlreadyExists' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
  sleep 5
done
if [ -z "${C_CREATED}" ]; then
  echo "[verify] FAIL: could not re-create ${ROLE_C} within a minute of its delete" >&2
  exit 1
fi
# The premise the identity rests on: the re-created role reports ANOTHER
# RoleId under the same name.
C2_ID="$(role_id "${ROLE_C}")" || { echo "[verify] FAIL: GetRole ${ROLE_C} answered no RoleId after its re-create" >&2; exit 1; }
if [ -z "${C2_ID}" ] || [ "${C2_ID}" = "${C_ID}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${ROLE_C} reports RoleId '${C2_ID}', the deleted one '${C_ID}': an identity that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's IAM role identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: ${ROLE_C} re-created outside the stack (${C_ID} -> ${C2_ID})"

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
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
A_GONE=""
for _ in $(seq 1 30); do
  if gone_probe aws iam get-role --role-name "${ROLE_A}"; then
    A_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${A_GONE}" ]; then
  # A keep warning naming OrphanA, with no "another one" verdict for it, is
  # the shape of an `unknown` verdict: the settle's GetRole of the record's
  # just-created role (${ROLE_A_B}) may have missed it while IAM propagated.
  if printf '%s' "${FF_FLAT}" | grep -qF "OrphanA (AWS::IAM::Role), which a failed deploy"; then
    echo "[verify] WARN: OrphanA was kept with a keep warning (output above). If its line is not the 'another one' warning, isSameResource answered unknown, most likely because IAM's eventual consistency hid the just-created ${ROLE_A_B} from the settle's GetRole; re-run before reading this as a regression" >&2
  fi
  echo "FAIL: the earlier attempt's role ${ROLE_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606) (still present after 30 probes over ~150s)" >&2
  exit 1
fi
# The NEGATIVE CONTROL: the re-used name is someone else's now: kept, untouched.
# One read of the marker tag and RoleId could be a stale IAM answer for a role
# the settle just deleted, so the same pair must read back twice, 5s apart.
C_STABLE=""
C_TAG="<unread>"
C3_ID="<unread>"
for _ in $(seq 1 6); do
  C_TAG="$(aws iam list-role-tags --role-name "${ROLE_C}" \
    --query "Tags[?Key=='cdkd-integ-marker'].Value | [0]" --output text 2>&1)" || C_TAG="<list-role-tags failed: ${C_TAG}>"
  C3_ID="$(role_id "${ROLE_C}")" || C3_ID="<read failed>"
  if [ "${C_TAG}" = "${C_MARKER}" ] && [ "${C3_ID}" = "${C2_ID}" ]; then
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
  echo "[verify] FAIL: the re-created ${ROLE_C} was not left untouched by the fix-forward (marker tag '${C_TAG}', expected '${C_MARKER}'; RoleId '${C3_ID}', expected ${C2_ID}; not read back twice in a row)" >&2
  exit 1
fi
# The kept entry was warned about, so the journal goes with it.
assert_gone "the fix-forward kept the rollback journal (expected it removed: OrphanA deleted, OrphanC warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for r in "${ROLE_A_B}" "${ROLE_C_B}" "${BASE_ROLE}"; do
  if ! present_eventually aws iam get-role --role-name "${r}"; then
    echo "[verify] FAIL: the record's role ${r} is missing after the fix-forward (the settle must not delete the records' roles)" >&2
    exit 1
  fi
done
if [ "$(role_id "${BASE_ROLE}")" != "${BASE_ID}" ]; then
  echo "[verify] FAIL: ${BASE_ROLE}'s RoleId changed during the run (expected the baseline's ${BASE_ID})" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <role>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanA "${ROLE_A_B}"
assert_record OrphanC "${ROLE_C_B}"
assert_record BaseRole "${BASE_ROLE}"
# For OrphanA the assertions above decide on AWS's own answers, and the log
# lines below only confirm the deploy's account. For OrphanC it is the other
# way round: IAM reads can be stale, so the marker and RoleId reads above only
# corroborate. What detects a wrong delete of OrphanC is the exit code (2), the
# log lines below (no delete of OrphanC, its "another one" warning), and step
# 4's plain `delete-role` of it, which fails the run if the role is gone.
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name OrphanA.
if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created OrphanA"; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanA (output above)" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF "OrphanA (AWS::IAM::Role), which a failed deploy"; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanA instead of deleting it (output above)" >&2
  exit 1
fi
# Sentinel for the wording above: OrphanC's keep warning uses the same head,
# so a reword that would blind the OrphanA check fails here first.
if ! printf '%s' "${FF_FLAT}" | grep -qF 'OrphanC (AWS::IAM::Role), which a failed deploy'; then
  echo "[verify] FAIL: the settle's keep-warning head changed (no 'OrphanC (AWS::IAM::Role), which a failed deploy' in the output): update the OrphanA check above" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanC'; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
if ! printf '%s' "${FF_FLAT}" | grep -qF 'is not deleted: the resource now under its physical id is another one'; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's name now holds another role (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${ROLE_A}, kept the re-created ${ROLE_C} untouched, and the records hold the -b roles (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${ROLE_C} (this run's, no record's), then destroy"
aws iam delete-role --role-name "${ROLE_C}" >/dev/null
assert_gone_eventually "step 4: ${ROLE_C} survived its delete" \
  aws iam get-role --role-name "${ROLE_C}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for r in "${ALL_ROLES[@]}"; do
  assert_gone_eventually "role ${r} still exists after destroy" \
    aws iam get-role --role-name "${r}"
done
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "iam-role-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's IAM role and kept one whose name was re-used (go-to-k/cdkd#4606)"
