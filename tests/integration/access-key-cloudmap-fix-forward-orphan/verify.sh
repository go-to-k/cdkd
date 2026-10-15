#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the IAM access key and Cloud Map service arm: a
# fix-forward deploy deletes the access key or Cloud Map service an earlier
# failed CREATE left in AWS, once a live read (`isSameResource` on
# `IAMAccessKeyProvider` / `ServiceDiscoveryProvider`) proves it is not the
# one the new state record holds. Both physical ids are AWS-generated
# (`AKIA...`, `srv-...`) and in `UNIQUE_PHYSICAL_ID_TYPES`, so no recorded
# identity is needed; before the fix the provider had no `isSameResource`, so
# the settle warned about both, kept them and exited 2.
#
# Phases:
#   1. Baseline deploy: `BaseUser`, `BaseNamespace` (an HTTP namespace).
#   2. The failed CREATE. A role is created that may create an access key or a
#      Cloud Map service and read them, but may neither update an access key,
#      set service attributes, nor delete either. A `--no-rollback` deploy run
#      as that role with WITH_ORPHANS=true creates `KeyA` (`Status: Inactive`)
#      and `ServiceA` (with `ServiceAttributes`), fails each on its follow-up
#      call, and the provider's own cleanup is refused too. Asserted: the
#      deploy failed, the journal carries each as a proven orphan whose key or
#      service exists, and no state record holds them. The follow-up calls are
#      refused by an IMPLICIT deny (never granted), which the engine retries as
#      IAM propagation, as before go-to-k/cdkd#4969 made an explicit deny fail
#      fast. A key create that left its key behind is not replayed
#      (go-to-k/cdkd#4945); the run still deletes any key the journal does not
#      name, so the fix-forward fits the user's 2-key quota.
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      logical ids (the key `Active`, the service as `-b`). Asserted: the
#      deploy exits 0, the journaled key and service are deleted
#      (`deleting partially-created KeyA` / `ServiceA`, no keep warning), the
#      journal is removed, and the state records hold the new key and service.
#      Before #4606's access-key / Cloud Map slice the deploy kept both and
#      exited 2.
#   4. `cdkd destroy`. The user, its keys, the namespace, both services, the
#      state file and the restricted role are gone, and the state prefix's
#      object versions are swept.
#
# Cost: one IAM user with at most two access keys, one role (free; nothing
# assumes the role but this script), one Cloud Map HTTP namespace and two
# services with no instances (no hosted zone; free). On any failure, cleanup
# deletes every key on the user and every service in the namespace, destroys
# the stack, deletes the namespace and the user by name and deletes the
# restricted role.
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
STACK="CdkdAccessKeyCloudMapFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/access-key-cloudmap-fix-forward-orphan"
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

# The names the stack sets (lib/access-key-cloudmap-fix-forward-orphan-stack.ts).
BASE_USER="cdkd-akcfo-base-user"
NAMESPACE="cdkd-akcfo-ns"
SERVICE_A="cdkd-akcfo-svc-a"
SERVICE_A_B="cdkd-akcfo-svc-a-b"

DENY_ROLE="${STACK}-no-wire"
DENY_POLICY_NAME="create-without-wiring"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the user, the namespace
# or the stack may belong to a concurrent or earlier run, which a failure-path
# delete must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The ids of BASE_USER's access keys, space-separated (empty for none). Fails
# the call on a read that fails.
user_key_ids() {
  local out
  out="$(aws iam list-access-keys --user-name "${BASE_USER}" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text)" || return 1
  [ "${out}" = "None" ] && out=""
  printf '%s' "${out}" | tr '\t' ' '
}
key_listed() { # usage: key_listed <access key id>  (0 = listed on BASE_USER)
  local ids
  ids="$(user_key_ids)" || { echo "[verify] FAIL: ListAccessKeys on ${BASE_USER} failed" >&2; exit 1; }
  case " ${ids} " in
    *" $1 "*) return 0 ;;
  esac
  return 1
}
# The id of the namespace named NAMESPACE (empty for none).
namespace_id() {
  local out
  out="$(aws servicediscovery list-namespaces \
    --query "Namespaces[?Name=='${NAMESPACE}'].Id" --output text)" || return 1
  [ "${out}" = "None" ] && out=""
  printf '%s' "${out}"
}

delete_user_keys() { ( # usage: delete_user_keys  (best-effort)
  set +eu
  for k in $(aws iam list-access-keys --user-name "${BASE_USER}" --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
    aws iam delete-access-key --user-name "${BASE_USER}" --access-key-id "${k}" >/dev/null 2>&1
  done
  true
); }
delete_namespace_services() { ( # usage: delete_namespace_services <namespace id>  (best-effort)
  set +eu
  [ -n "$1" ] || exit 0
  for s in $(aws servicediscovery list-services --filters "Name=NAMESPACE_ID,Values=$1,Condition=EQ" --query 'Services[].Id' --output text 2>/dev/null); do
    aws servicediscovery delete-service --id "${s}" >/dev/null 2>&1
  done
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
    # What no state record holds (the orphans) first; the destroy below then
    # deletes what the records hold. An orphan service would block the
    # namespace's delete.
    delete_user_keys
    NS_CLEAN="$(namespace_id 2>/dev/null)"
    delete_namespace_services "${NS_CLEAN}"
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    NS_CLEAN="$(namespace_id 2>/dev/null)"
    if [ -n "${NS_CLEAN}" ]; then
      delete_namespace_services "${NS_CLEAN}"
      aws servicediscovery delete-namespace --id "${NS_CLEAN}" >/dev/null 2>&1
    fi
    delete_user_keys
    aws iam delete-user --user-name "${BASE_USER}" >/dev/null 2>&1
    # IAM is eventually consistent and a namespace delete is an operation: a
    # bounded wait before the WARN.
    for _ in $(seq 1 24); do
      if [ -z "$(namespace_id 2>/dev/null)" ] && ( gone_probe aws iam get-user --user-name "${BASE_USER}" ); then break; fi
      sleep 5
    done
    [ -z "$(namespace_id 2>/dev/null)" ] \
      || echo "[verify] WARN: namespace ${NAMESPACE} could not be confirmed deleted; delete its services and it by hand" >&2
    ( gone_probe aws iam get-user --user-name "${BASE_USER}" ) \
      || echo "[verify] WARN: user ${BASE_USER} could not be confirmed deleted; delete its access keys and it by hand" >&2
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
assert_gone "precondition: user ${BASE_USER} already exists (left by an earlier run); delete its access keys and it first" \
  aws iam get-user --user-name "${BASE_USER}"
NS_PRE="$(namespace_id)" || { echo "[verify] FAIL: precondition -- ListNamespaces failed" >&2; exit 1; }
if [ -n "${NS_PRE}" ]; then
  echo "[verify] FAIL: precondition: namespace ${NAMESPACE} already exists as ${NS_PRE} (left by an earlier run); delete its services and it first" >&2
  exit 1
fi
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (BaseUser, BaseNamespace)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
if ! present_eventually aws iam get-user --user-name "${BASE_USER}"; then
  echo "[verify] FAIL: ${BASE_USER} does not read back after step 1" >&2
  exit 1
fi
STATE_1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
NS_ID="$(printf '%s' "${STATE_1}" | jq -r '.resources.BaseNamespace.physicalId // empty')"
if [ -z "${NS_ID}" ] || [ "$(namespace_id)" != "${NS_ID}" ]; then
  echo "[verify] FAIL: state records BaseNamespace as '${NS_ID}', but ListNamespaces names ${NAMESPACE} '$(namespace_id)'" >&2
  exit 1
fi
# The id form ServiceDiscoveryProvider.isSameResource accepts for a namespace
# (`NAMESPACE_ID_PATTERN`): no namespace orphan is reachable here, so this
# read is the arm's only real-AWS evidence for it.
if ! printf '%s' "${NS_ID}" | grep -qE '^ns-[a-z0-9]{16}$'; then
  echo "[verify] FAIL: Cloud Map names ${NAMESPACE} '${NS_ID}', which is not the ns- plus 16 lowercase alphanumerics form isSameResource accepts" >&2
  exit 1
fi
KEYS_1="$(user_key_ids)" || { echo "[verify] FAIL: ListAccessKeys on ${BASE_USER} failed after step 1" >&2; exit 1; }
if [ -n "${KEYS_1}" ]; then
  echo "[verify] FAIL: ${BASE_USER} holds access keys (${KEYS_1}) after the baseline deploy (expected none)" >&2
  exit 1
fi

echo "[verify] step 2: a role that may create an access key or a service but neither wire nor delete it"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs,
# iam:ListPolicies, sts:GetCallerIdentity and the Cloud Map verbs (whose
# resources a namespace or service id names only after the create) are `*`;
# SSM is the CDK bootstrap parameters, KMS only through S3 (the state bucket's
# encryption). The S3 verbs on the state bucket are the state path's
# (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts). On this
# run's user (`cdkd-akcfo-*`) the role may CreateAccessKey and read the user
# and its keys; in Cloud Map it may CreateService and read. UpdateAccessKey and
# UpdateServiceAttributes (each CREATE's follow-up) are never granted -- an
# IMPLICIT deny, retried as IAM propagation, where an explicit one would fail
# fast (go-to-k/cdkd#4969) -- so each CREATE fails after AWS made the key or
# service; DeleteAccessKey, DeleteService,
# DeleteServiceAttributes, DeleteNamespace and DeleteUser are denied, so the
# providers' own cleanup cannot remove it. No statement allows a credential
# beyond the access key on this run's user, a PassRole or a role write.
# sts:AssumeRole is denied everywhere: nothing this session runs assumes a role
# (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);const user=`arn:aws:iam::${acct}:user/cdkd-akcfo-*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["iam:CreateAccessKey","iam:ListAccessKeys","iam:GetAccessKeyLastUsed","iam:GetUser","iam:ListUserPolicies","iam:ListAttachedUserPolicies","iam:ListUserTags","iam:ListGroupsForUser"],Resource:user},{Effect:"Allow",Action:["servicediscovery:CreateService","servicediscovery:GetService","servicediscovery:GetNamespace","servicediscovery:GetOperation","servicediscovery:GetServiceAttributes","servicediscovery:ListNamespaces","servicediscovery:ListServices","servicediscovery:ListTagsForResource"],Resource:"*"},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","iam:ListPolicies","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["iam:DeleteAccessKey","iam:DeleteUser","iam:PassRole"],Resource:user},{Effect:"Deny",Action:["servicediscovery:DeleteServiceAttributes","servicediscovery:DeleteService","servicediscovery:DeleteNamespace"],Resource:"*"},{Effect:"Deny",Action:"sts:AssumeRole",Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=access-key-cloudmap-fix-forward-orphan >/dev/null
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
    --role-session-name cdkd-access-key-cloudmap-fix-forward \
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
# The EXPLICIT denies must already bind: before the inline policy propagates,
# the role is refused everything implicitly, and the deploy below would then
# fail before any CREATE for the wrong reason. Probed on BaseUser and
# BaseNamespace, which EXIST. Neither probe can delete them: no statement
# allows DeleteUser or DeleteNamespace, so each is refused implicitly before
# the policy binds and explicitly after.
deny_binds() { # usage: deny_binds <desc> aws ...  (exits on an allowed call or a deny that never binds)
  local desc="$1" out=""
  shift
  for _ in $(seq 1 24); do
    if out="$(as_deny_role "$@" 2>&1)"; then
      echo "[verify] FAIL: precondition -- ${DENY_ROLE} was ALLOWED to ${desc} (its policy must refuse it)" >&2
      exit 1
    elif printf '%s' "${out}" | grep -qi 'explicit deny'; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on ${desc} never bound within 2 minutes (last answer: ${out:-<allowed>})" >&2
  exit 1
}
deny_binds "delete ${BASE_USER}" aws iam delete-user --user-name "${BASE_USER}"
deny_binds "delete namespace ${NS_ID}" aws servicediscovery delete-namespace --id "${NS_ID}"
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws iam get-user --user-name "${BASE_USER}" \
    --query 'User.UserName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${BASE_USER}" ] \
    && [ "$(as_deny_role aws servicediscovery get-namespace --id "${NS_ID}" --query 'Namespace.Id' --output text 2>&1)" = "${NS_ID}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not GetUser ${BASE_USER} and GetNamespace ${NS_ID} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: each orphan CREATE fails after AWS made the key or service"
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
# The deploy's own account: each CREATE's cleanup was refused.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created IAM access key KeyA"; then
  echo "[verify] FAIL: the step-2 deploy did not report KeyA's refused cleanup (output above)" >&2
  exit 1
fi
if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Failed to clean up partially-created ServiceDiscovery Service ServiceA"; then
  echo "[verify] FAIL: the step-2 deploy did not report ServiceA's refused cleanup (output above)" >&2
  exit 1
fi
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in KeyA ServiceA; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
journaled_id() { # usage: journaled_id <logicalId>  -> the proven orphan's physical id (sdk), or fails
  local op
  op="$(printf '%s' "${JOURNAL_2}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || return 1
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.provisionedBy // "<absent>"')" != "sdk" ]; then
    echo "[verify] FAIL: the journal does not carry $1 as a proven orphan via sdk after step 2 (op: ${op:-<none>})" >&2
    return 1
  fi
  printf '%s' "${op}" | jq -r '.physicalId // empty'
}
KEY_J="$(journaled_id KeyA)" || exit 1
SRV_J="$(journaled_id ServiceA)" || exit 1
case "${KEY_J}" in
  AKIA????????????????) ;;
  *) echo "[verify] FAIL: the journal records KeyA as '${KEY_J}' (expected an AKIA access key id)" >&2; exit 1 ;;
esac
case "${SRV_J}" in
  srv-*) ;;
  *) echo "[verify] FAIL: the journal records ServiceA as '${SRV_J}' (expected a srv- service id)" >&2; exit 1 ;;
esac
# The premise of the injection, from AWS's own answers: the journaled key is
# on BaseUser and still Active (its UpdateAccessKey was refused), and the
# journaled service is ServiceA's, in BaseNamespace, with no attributes set.
KEY_J_STATUS="$(aws iam list-access-keys --user-name "${BASE_USER}" \
  --query "AccessKeyMetadata[?AccessKeyId=='${KEY_J}'].Status" --output text)"
if [ "${KEY_J_STATUS}" != "Active" ]; then
  echo "[verify] FAIL: the journaled key ${KEY_J} reads as '${KEY_J_STATUS}' on ${BASE_USER} after step 2 (expected Active: listed, its Inactive update refused)" >&2
  exit 1
fi
SRV_J_READ="$(aws servicediscovery get-service --id "${SRV_J}" --query '[Service.Name,Service.NamespaceId]' --output text | tr '\t' ' ')"
if [ "${SRV_J_READ}" != "${SERVICE_A} ${NS_ID}" ]; then
  echo "[verify] FAIL: the journaled service ${SRV_J} reads as '${SRV_J_READ}' (expected '${SERVICE_A} ${NS_ID}')" >&2
  exit 1
fi
SRV_J_ATTRS="$(aws servicediscovery get-service-attributes --service-id "${SRV_J}" \
  --query 'length(ServiceAttributes.Attributes || `{}`)' --output text 2>&1)" || SRV_J_ATTRS="<read failed: ${SRV_J_ATTRS}>"
if [ "${SRV_J_ATTRS}" != "0" ]; then
  echo "[verify] WARN: the journaled service ${SRV_J} carries attributes (${SRV_J_ATTRS}); its CREATE was expected to fail on UpdateServiceAttributes" >&2
fi
echo "[verify] step 2 ok: access key ${KEY_J} and service ${SRV_J} are in AWS, journaled as proven orphans, with no state record"

echo "[verify] step 2b: the keys the journal does not name are deleted (go-to-k/cdkd#4945)"
# A replayed KeyA create would mint another key the journal does not name;
# go-to-k/cdkd#4945 stops that replay, and this sweep keeps the fixture's
# quota premise if one ever happens. Left in place, an extra key fills the
# quota the fix-forward's CREATE needs.
KEYS_2="$(user_key_ids)" || { echo "[verify] FAIL: ListAccessKeys on ${BASE_USER} failed after step 2" >&2; exit 1; }
for k in ${KEYS_2}; do
  if [ "${k}" != "${KEY_J}" ]; then
    echo "[verify] NOTE: deleting ${k}, which step 2 minted but the journal does not name (go-to-k/cdkd#4945)"
    aws iam delete-access-key --user-name "${BASE_USER}" --access-key-id "${k}"
  fi
done
KEYS_2B=""
for _ in $(seq 1 12); do
  KEYS_2B="$(user_key_ids)" || { echo "[verify] FAIL: ListAccessKeys on ${BASE_USER} failed in step 2b" >&2; exit 1; }
  if [ "${KEYS_2B}" = "${KEY_J}" ]; then break; fi
  sleep 5
done
if [ "${KEYS_2B}" != "${KEY_J}" ]; then
  echo "[verify] FAIL: ${BASE_USER} holds keys '${KEYS_2B}' after step 2b (expected the journaled ${KEY_J} alone)" >&2
  exit 1
fi

echo "[verify] step 3: the fix-forward (same logical ids, the key Active, the service as -b)"
set +e
env WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
# A keep warning naming an orphan is the shape of an `unknown` verdict: before
# go-to-k/cdkd#4606's access-key / Cloud Map slice that was every run (neither
# provider had `isSameResource`); after it, the settle's read of the record's
# just-created key may have missed it while IAM propagated.
kept_hint() { # usage: kept_hint <logicalId> <type>
  if printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy"; then
    echo "[verify] WARN: $1 was kept with a keep warning (output above): isSameResource answered unknown. If the provider has isSameResource, IAM's or Cloud Map's eventual consistency most likely hid the just-created record resource from the settle's read; re-run before reading this as a regression" >&2
  fi
}
# 0: both orphans are deleted, nothing is warned about. 2 is the settle's
# warn-and-keep (journaled-orphans.ts, `settleJournaledOrphansOnSuccess`).
if [ "${FF_RC}" -ne 0 ]; then
  kept_hint KeyA AWS::IAM::AccessKey
  kept_hint ServiceA AWS::ServiceDiscovery::Service
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 0: the earlier KeyA and ServiceA are proven other resources and deleted -- output above)" >&2
  exit 1
fi
KEY_J_GONE=""
for _ in $(seq 1 30); do
  if ! key_listed "${KEY_J}"; then
    KEY_J_GONE=1
    break
  fi
  sleep 5
done
if [ -z "${KEY_J_GONE}" ]; then
  echo "[verify] FAIL: the earlier attempt's access key ${KEY_J} is still on ${BASE_USER} after the fix-forward deploy (go-to-k/cdkd#4606) (still listed after 30 probes over ~150s)" >&2
  exit 1
fi
assert_gone_eventually "the earlier attempt's service ${SRV_J} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws servicediscovery get-service --id "${SRV_J}"
assert_gone "the fix-forward kept the rollback journal (expected it removed: both orphans deleted)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
record_id() { # usage: record_id <logicalId>  -> its physical id via sdk, or fails
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || return 1
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || return 1
  if [ "${by}" != "sdk" ] || [ "${pid}" = "<absent>" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected a physical id via sdk, where isSameResource lives)" >&2
    return 1
  fi
  printf '%s' "${pid}"
}
KEY_B="$(record_id KeyA)" || exit 1
SRV_B="$(record_id ServiceA)" || exit 1
if [ "${KEY_B}" = "${KEY_J}" ] || [ "${SRV_B}" = "${SRV_J}" ]; then
  echo "[verify] FAIL: state records KeyA as ${KEY_B} and ServiceA as ${SRV_B}, the journaled ids (expected the fix-forward's new key and service)" >&2
  exit 1
fi
# The record's resources are untouched by the settle.
KEYS_3="$(user_key_ids)" || { echo "[verify] FAIL: ListAccessKeys on ${BASE_USER} failed after step 3" >&2; exit 1; }
if [ "${KEYS_3}" != "${KEY_B}" ]; then
  echo "[verify] FAIL: ${BASE_USER} holds keys '${KEYS_3}' after the fix-forward (expected the record's ${KEY_B} alone)" >&2
  exit 1
fi
SRV_B_NAME="$(aws servicediscovery get-service --id "${SRV_B}" --query 'Service.Name' --output text)"
if [ "${SRV_B_NAME}" != "${SERVICE_A_B}" ]; then
  echo "[verify] FAIL: the record's service ${SRV_B} reads as '${SRV_B_NAME}' (expected ${SERVICE_A_B}: the settle must not delete the record's service)" >&2
  exit 1
fi
# The deploy's own account. The settle's keep warnings (journaled-orphans.ts,
# `applySuccessRule`) open with the logical id and type: none may name either.
for pair in "KeyA AWS::IAM::AccessKey" "ServiceA AWS::ServiceDiscovery::Service"; do
  set -- ${pair}
  if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created $1 ($2)"; then
    echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's $1 (no 'deleting partially-created $1 ($2)' in the output above)" >&2
    exit 1
  fi
  if printf '%s' "${FF_FLAT}" | grep -qF "$1 ($2), which a failed deploy"; then
    echo "[verify] FAIL: the fix-forward deploy still warned about the earlier $1 instead of deleting it (output above)" >&2
    exit 1
  fi
done
set --
echo "[verify] step 3 ok: the fix-forward deleted ${KEY_J} and ${SRV_J}, and the records hold ${KEY_B} and ${SRV_B} (rc=${FF_RC})"

echo "[verify] step 4: destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone_eventually "user ${BASE_USER} still exists after destroy" \
  aws iam get-user --user-name "${BASE_USER}"
assert_gone_eventually "service ${SRV_B} still exists after destroy" \
  aws servicediscovery get-service --id "${SRV_B}"
assert_gone_eventually "service ${SRV_J} still exists after destroy" \
  aws servicediscovery get-service --id "${SRV_J}"
assert_gone_eventually "namespace ${NS_ID} still exists after destroy" \
  aws servicediscovery get-namespace --id "${NS_ID}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "access-key-cloudmap-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's IAM access key and Cloud Map service (go-to-k/cdkd#4606)"
