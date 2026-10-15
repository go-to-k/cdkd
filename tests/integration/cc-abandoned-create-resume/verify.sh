#!/usr/bin/env bash
#
# go-to-k/cdkd#3252: a Cloud Control CREATE whose status polling cdkd
# abandoned is journaled with its RequestToken. The next deploy re-polls it
# and, when the template would send the same properties, TAKES OVER what it
# made instead of creating another; the next destroy re-polls it and records
# what it made as a resource the failed deploy created.
#
# The resource is `AWS::EC2::PrefixList`, which has no SDK provider, so it is
# created through Cloud Control `CreateResource`; its id (`pl-...`) is minted
# by EC2. It is free and is created in seconds.
#
# The abandonment: a role is created that may call
# `cloudformation:CreateResource` (and what the prefix-list handler and cdkd's
# state path need) but is EXPLICITLY DENIED
# `cloudformation:GetResourceRequestStatus`. An AccessDenied on the status poll
# is not a transient failure, so `waitForOperation` abandons the wait at once
# while Cloud Control goes on to finish the create.
#
# Phases:
#   A. A deploy as that role fails. Asserted: its output says cdkd stopped
#      waiting, for the non-retryable reason; no state record holds
#      `PrefixList`; the rollback journal holds exactly one failed op carrying
#      `pendingCloudControlRequest.requestToken`, a cc-api CREATE of
#      `PrefixList` with its attempted properties and no physical id. The token
#      is then read with the caller's own credentials until Cloud Control
#      reports SUCCESS; its Identifier is PL_A, live in EC2.
#   B. The takeover. With the caller's credentials, `cdkd deploy` (the same
#      template, so the same properties) re-polls the token and takes PL_A
#      over. Asserted: exit 0; the takeover line naming PL_A; neither the
#      re-create line nor a skip warning; state records `PrefixList` as PL_A
#      via cc-api; the journal is gone; exactly one list is named
#      `cdkd-ccacr`.
#   C. The destroy-side settle. CCACR_SECOND=true adds `PrefixList2`
#      (`cdkd-ccacr-2`); a deploy as the role again abandons its CREATE
#      (journal token for `PrefixList2`; state still holds PL_A), and the
#      token is polled to SUCCESS (PL_C). The role is then deleted. `cdkd
#      destroy` with the caller's credentials re-polls the token and records
#      PL_C as a resource the failed deploy created. A prefix list's Cloud
#      Control identifier is its `PrefixListId`, which EC2 mints (a read-only
#      primary identifier), so the orphan is journaled
#      `createdIdentifierUnique` and needs no identity token: the destroy
#      deletes it, and PL_A, which state records. Asserted: exit 0, the
#      settle line and the made-PL_C line, no skip warning, PL_A and PL_C
#      gone, then the gone-probes for both lists, the role, the state file and
#      the journal; the state prefix's object versions are swept.
#
# Cost: two empty customer-managed prefix lists (free) and one IAM role. On any
# failure, cleanup deletes the role, destroys the stack and deletes every
# prefix list this run names or created.
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
STACK="CdkdCcAbandonedCreateResume"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/cc-abandoned-create-resume"
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

# The names the stack declares (lib/cc-abandoned-create-resume-stack.ts).
PL_NAME="cdkd-ccacr"
PL_NAME_2="cdkd-ccacr-2"
LOGICAL_ID="PrefixList"
LOGICAL_ID_2="PrefixList2"
RESOURCE_TYPE="AWS::EC2::PrefixList"

DENY_ROLE="${STACK}-no-status"
DENY_POLICY_NAME="create-without-status-read"
DENY_ROLE_CREATED=""
# The lists the two abandoned creates made, once known.
PL_A=""
PL_C=""
# Set once the preconditions below pass: before that, the lists or the stack
# may belong to a concurrent or earlier run, which a failure-path delete must
# not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The live ids of the lists under the given names (comma-separated; one id per
# field; a list EC2 reports `delete-complete` is gone). Every caller passes
# this script's literal names: this can never widen to the account's other
# lists.
named_prefix_lists() { # usage: named_prefix_lists <name>[,<name>...]
  aws ec2 describe-managed-prefix-lists --region "${REGION}" \
    --filters "Name=prefix-list-name,Values=$1" \
    --query "PrefixLists[?State!='delete-complete'].PrefixListId" --output text
}
pl_state() { # usage: pl_state <pl-id>  (EC2's State for the list)
  aws ec2 describe-managed-prefix-lists --region "${REGION}" --prefix-list-ids "$1" \
    --query 'PrefixLists[0].State' --output text
}
# A deleted list is reported `delete-complete` for a while before EC2 answers
# NotFound: either is gone. Bounded; a list that never goes still FAILs.
assert_pl_gone_eventually() { # usage: assert_pl_gone_eventually "<desc>" <pl-id>
  local desc="$1" id="$2" st
  for _ in $(seq 1 30); do
    if gone_probe aws ec2 describe-managed-prefix-lists --region "${REGION}" --prefix-list-ids "${id}"; then
      return 0
    fi
    st="$(pl_state "${id}")" || { echo "[verify] FAIL: could not read ${id}'s state" >&2; exit 1; }
    if [ "${st}" = "delete-complete" ]; then
      return 0
    fi
    sleep 5
  done
  echo "FAIL: ${desc} (still present after 30 probes over ~150s)" >&2
  exit 1
}
assert_pl_live() { # usage: assert_pl_live "<step>" <pl-id> "<why>"
  local st
  st="$(pl_state "$2")" || { echo "[verify] FAIL: $1 -- could not read $2's state" >&2; exit 1; }
  if [ "${st}" != "create-complete" ]; then
    echo "[verify] FAIL: $1 -- $2 reads '${st}' in EC2 (expected create-complete: $3)" >&2
    exit 1
  fi
}
delete_pl() { ( # usage: delete_pl <pl-id>  (best-effort)
  set +eu
  case "$1" in
    pl-?*) aws ec2 delete-managed-prefix-list --prefix-list-id "$1" --region "${REGION}" >/dev/null 2>&1 ;;
    *) echo "[verify] WARN: teardown sweep refused: '$1' is not a prefix-list id" >&2 ;;
  esac
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
    # would otherwise synthesize whatever app the caller's cwd holds. The
    # destroy also settles a journaled token a later step never reached.
    (cd "${TEST_DIR}" && CCACR_SECOND=true ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # Then by id: the abandoned creates' lists (no state record may hold
    # them), and any list under this run's names a failed destroy left.
    leftover="$(named_prefix_lists "${PL_NAME},${PL_NAME_2}" 2>/dev/null)"
    for id in ${PL_A} ${PL_C} ${leftover}; do
      delete_pl "${id}"
    done
    sleep 10
    leftover="$(named_prefix_lists "${PL_NAME},${PL_NAME_2}" 2>&1)" || leftover="<describe failed: ${leftover}>"
    if [ -n "${leftover}" ]; then
      echo "[verify] WARN: prefix list(s) ${leftover} (${PL_NAME} / ${PL_NAME_2}) could not be confirmed deleted; delete them by hand" >&2
    fi
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

# A record, journal or list left by an earlier, interrupted run would be
# blamed on the steps below.
for key in "${STATE_KEY}" "${JOURNAL_KEY}"; do
  if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${key}" 2>&1)"; then
    echo "[verify] FAIL: s3://${STATE_BUCKET}/${key} already exists (left by an earlier run); destroy ${STACK} first" >&2
    exit 1
  elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
    echo "[verify] FAIL: pre-probe of s3://${STATE_BUCKET}/${key} undetermined: ${HEAD_PRE}" >&2
    exit 1
  fi
done
PRE_LISTS="$(named_prefix_lists "${PL_NAME},${PL_NAME_2}")"
if [ -n "${PRE_LISTS}" ]; then
  echo "[verify] FAIL: precondition -- prefix list(s) ${PRE_LISTS} named ${PL_NAME} / ${PL_NAME_2} already exist (left by an earlier run); delete them first" >&2
  exit 1
fi
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step A: a role that may create a prefix list through Cloud Control but not read the request's status"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs and
# sts:GetCallerIdentity (which takes no resource) are `*`; SSM is the CDK
# bootstrap parameters, KMS only through S3 (the state bucket's encryption).
# The S3 verbs on the state bucket are the state path's (src/state/
# {s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts).
# Cloud Control: CreateResource, and GetResource for any read the provider
# makes around it. The handler runs with the caller's credentials, so the EC2
# verbs its create and read call are granted (the EC2 Describe/Get verbs take
# no resource-level scope; CreateManagedPrefixList is scoped to prefix lists).
# GetResourceRequestStatus is EXPLICITLY denied: cdkd's first status poll is
# refused, a non-transient failure, and the wait is abandoned at once.
DENY_POLICY="$(node -e 'const [bucket,stack,acct]=process.argv.slice(1);process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["s3:GetObject"],Resource:`arn:aws:s3:::${bucket}/_cdkd-registry/*/${stack}.json`},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Allow",Action:["cloudformation:CreateResource","cloudformation:GetResource"],Resource:"*"},{Effect:"Allow",Action:["ec2:CreateManagedPrefixList"],Resource:`arn:aws:ec2:*:${acct}:prefix-list/*`},{Effect:"Allow",Action:["ec2:CreateTags"],Resource:`arn:aws:ec2:*:${acct}:prefix-list/*`,Condition:{StringEquals:{"ec2:CreateAction":"CreateManagedPrefixList"}}},{Effect:"Allow",Action:["ec2:DescribeManagedPrefixLists","ec2:GetManagedPrefixListEntries","ec2:GetManagedPrefixListAssociations"],Resource:"*"},{Effect:"Deny",Action:["cloudformation:GetResourceRequestStatus"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=cc-abandoned-create-resume >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it. The session's
# default hour covers both abandoned deploys (steps A and C).
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-cc-abandoned-create \
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
# fail before CreateResource for the wrong reason. Probed with a well-formed
# token no request has: IAM decides before Cloud Control looks the token up.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws cloudcontrol get-resource-request-status --region "${REGION}" \
    --request-token 00000000-0000-0000-0000-000000000000 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} READ a request status (its policy must refuse GetResourceRequestStatus)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on GetResourceRequestStatus never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails on its first
# read for the wrong reason. EC2's describe is the handler's own read.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws ec2 describe-managed-prefix-lists --region "${REGION}" \
    --filters "Name=prefix-list-name,Values=${PL_NAME}" --query 'length(PrefixLists)' --output text 2>&1)" \
    && printf '%s' "${ALLOW_PROBE}" | grep -qE '^[0-9]+$'; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not DescribeManagedPrefixLists within 2 minutes" >&2
  exit 1
fi

# The assertions an abandoned deploy shares (steps A and C). Sets TOKEN.
#   $1 step label, $2 the deploy's log file, $3 the logical id abandoned.
assert_abandoned() {
  local step="$1" log="$2" lid="$3" flat journal pending op
  flat="$(sed 's/\x1b\[[0-9;]*m//g' "${log}" | tr '\n' ' ' | tr -s ' ')"
  # CloudControlWaitAbandonedError's head (cloud-control-provider.ts,
  # `abandonWait`), and the reason of its non-transient arm: two independent
  # markers on the same message, so a reword of either fails here by name.
  if ! grep -qF "CREATE of ${lid} was accepted by Cloud Control API, but cdkd stopped waiting for it" <<<"${flat}"; then
    echo "[verify] FAIL: ${step} -- the failed deploy does not say cdkd stopped waiting for the CREATE of ${lid} (output above)" >&2
    exit 1
  fi
  if ! grep -qF 'cdkd could not read the operation status and the failure is not retryable' <<<"${flat}"; then
    echo "[verify] FAIL: ${step} -- the wait was not abandoned on the non-retryable status-read arm (expected the AccessDenied on GetResourceRequestStatus to abandon it at once; output above)" >&2
    exit 1
  fi
  journal="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)" || {
    echo "[verify] FAIL: ${step} -- no rollback journal at ${JOURNAL_KEY} after the abandoned CREATE (go-to-k/cdkd#3252 journals its token)" >&2
    exit 1
  }
  pending="$(printf '%s' "${journal}" | jq -c '[.segments[]?.failedOperations[]? | select(.pendingCloudControlRequest != null)]')"
  if [ "$(printf '%s' "${pending}" | jq 'length')" != "1" ]; then
    echo "[verify] FAIL: ${step} -- the journal holds $(printf '%s' "${pending}" | jq 'length') failed op(s) with a pendingCloudControlRequest (expected exactly 1): ${pending}" >&2
    exit 1
  fi
  op="$(printf '%s' "${pending}" | jq -c '.[0]')"
  TOKEN="$(printf '%s' "${op}" | jq -r '.pendingCloudControlRequest.requestToken // ""')"
  # `attemptedProperties` is what the takeover compares the next CREATE's bag
  # with (create.ts, `resumeAbandonedCreate`).
  if [ -z "${TOKEN}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.logicalId')" != "${lid}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.resourceType')" != "${RESOURCE_TYPE}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.changeType')" != "CREATE" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.provisionedBy // "<absent>"')" != "cc-api" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "<absent>" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "<absent>" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.attemptedProperties | type')" != "object" ]; then
    echo "[verify] FAIL: ${step} -- the journaled op is not a cc-api CREATE of ${lid} (${RESOURCE_TYPE}) with a request token, its attempted properties and no physical id: ${op}" >&2
    exit 1
  fi
}
# Read the token with the caller's own credentials until it ends. Bounded: the
# handler creates a prefix list in seconds. Sets MADE.
#   $1 step label, $2 token.
poll_token() {
  local step="$1" token="$2" out="" st=""
  MADE=""
  for _ in $(seq 1 60); do
    out="$(aws cloudcontrol get-resource-request-status --region "${REGION}" --request-token "${token}" \
      --query 'ProgressEvent.[OperationStatus,Identifier,ErrorCode,StatusMessage]' --output json)" || return 1
    st="$(printf '%s' "${out}" | jq -r '.[0] // ""')" || return 1
    MADE="$(printf '%s' "${out}" | jq -r '.[1] // ""')" || return 1
    case "${st}" in
      SUCCESS | FAILED | CANCEL_COMPLETE) break ;;
    esac
    sleep 5
  done
  if [ "${st}" != "SUCCESS" ]; then
    echo "[verify] FAIL: ${step} -- the abandoned CREATE ended '${st:-<still running after 5 minutes>}' in Cloud Control (expected SUCCESS; a FAILED one usually means the role lacks a permission the handler needs): ${out}" >&2
    exit 1
  fi
  case "${MADE}" in
    pl-?*) ;;
    *)
      echo "[verify] FAIL: ${step} -- the SUCCESS event names '${MADE}', not a prefix-list id" >&2
      exit 1
      ;;
  esac
}

echo "[verify] step A: deploy as ${DENY_ROLE}: CreateResource is accepted, the status poll is refused, the wait is abandoned"
set +e
as_deny_role env -u CCACR_SECOND ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/abandon-a.log" 2>&1
A_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/abandon-a.log" || true
if [ "${A_RC}" -eq 0 ]; then
  echo "[verify] FAIL: step A -- the deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (its status polls are denied)" >&2
  exit 1
fi
assert_abandoned "step A" "${LOG_DIR}/abandon-a.log" "${LOGICAL_ID}"
TOKEN_A="${TOKEN}"
# No state record holds it: the CREATE threw. A first deploy that fails may
# leave no state file at all.
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  STATE_A="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
  if [ "$(printf '%s' "${STATE_A}" | jq --arg l "${LOGICAL_ID}" '(.resources // {}) | has($l)')" != "false" ]; then
    echo "[verify] FAIL: step A -- state records ${LOGICAL_ID} (expected no record for a CREATE whose wait was abandoned)" >&2
    exit 1
  fi
fi
poll_token "step A" "${TOKEN_A}" \
  || { echo "[verify] FAIL: step A -- could not read the abandoned request's status (aws or jq failed; output above)" >&2; exit 1; }
PL_A="${MADE}"
assert_pl_live "step A" "${PL_A}" "the abandoned CREATE completed"
echo "[verify] step A ok: the wait was abandoned, the journal holds token ${TOKEN_A}, and the CREATE went on to make ${PL_A}"

echo "[verify] step B: deploy with the caller's credentials: the token is re-polled and ${PL_A} taken over"
set +e
env -u CCACR_SECOND ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/resume.log" 2>&1
B_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/resume.log" || true
if [ "${B_RC}" -ne 0 ]; then
  echo "[verify] FAIL: step B -- the deploy exited ${B_RC} (expected 0: the same template takes ${PL_A} over -- output above)" >&2
  exit 1
fi
STATE_B="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
B_PID="$(printf '%s' "${STATE_B}" | jq -r --arg l "${LOGICAL_ID}" '.resources[$l].physicalId // "<absent>"')"
B_BY="$(printf '%s' "${STATE_B}" | jq -r --arg l "${LOGICAL_ID}" '.resources[$l].provisionedBy // "<absent>"')"
if [ "${B_PID}" != "${PL_A}" ] || [ "${B_BY}" != "cc-api" ]; then
  echo "[verify] FAIL: step B -- state records ${LOGICAL_ID} as ${B_PID} via ${B_BY} (expected the abandoned create's ${PL_A} via cc-api)" >&2
  exit 1
fi
assert_pl_live "step B" "${PL_A}" "the record's list"
# The token was dropped with the takeover: nothing is left to settle.
assert_gone "step B -- the deploy kept the rollback journal (expected it removed once the token was taken over)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# No duplicate: the deploy did not create a second list under the name.
B_LISTS="$(named_prefix_lists "${PL_NAME}")"
if [ "${B_LISTS}" != "${PL_A}" ]; then
  echo "[verify] FAIL: step B -- the lists named ${PL_NAME} are '${B_LISTS}' (expected ${PL_A} alone: a takeover creates nothing)" >&2
  exit 1
fi
# The assertions above decide the step on AWS's own answers. The log lines
# below confirm the deploy's account of it, so a reworded line fails here,
# never silently above. The resolver's head and the takeover clause are
# independent markers (cc-pending-requests.ts).
B_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/resume.log" | tr '\n' ' ' | tr -s ' ')"
if ! grep -qF "stopped waiting for the Cloud Control CREATE of ${LOGICAL_ID} (${RESOURCE_TYPE})" <<<"${B_FLAT}"; then
  echo "[verify] FAIL: step B -- the deploy did not report re-polling the abandoned CREATE of ${LOGICAL_ID} (output above)" >&2
  exit 1
fi
if ! grep -qF "completed in AWS after cdkd stopped waiting, and made ${PL_A}; this deploy's CREATE of it takes that resource over when it sends the same properties" <<<"${B_FLAT}"; then
  echo "[verify] FAIL: step B -- the deploy did not offer ${PL_A} for takeover (output above)" >&2
  exit 1
fi
if ! grep -qF "${LOGICAL_ID}: took over ${PL_A}, the resource the earlier CREATE made, instead of creating another" <<<"${B_FLAT}"; then
  echo "[verify] FAIL: step B -- the deploy did not report taking ${PL_A} over (output above)" >&2
  exit 1
fi
# Neither the bag-mismatch arm (create.ts) nor an orphan skip (the settle's
# replay) may have run.
if grep -qF 'creates the resource again' <<<"${B_FLAT}"; then
  echo "[verify] FAIL: step B -- the deploy says it creates ${LOGICAL_ID} again (the template did not change: the takeover's bag comparison failed; output above)" >&2
  exit 1
fi
if grep -qF 'Skipping failed CREATE' <<<"${B_FLAT}"; then
  echo "[verify] FAIL: step B -- the deploy skipped a failed CREATE (expected the takeover to leave no orphan; output above)" >&2
  exit 1
fi
echo "[verify] step B ok: ${PL_A} was taken over and recorded, the token dropped, no second list created"

echo "[verify] step C: PrefixList2 added; deploy as ${DENY_ROLE} again: its CREATE is abandoned"
set +e
as_deny_role env CCACR_SECOND=true ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" > "${LOG_DIR}/abandon-c.log" 2>&1
C_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/abandon-c.log" || true
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves cleanup to retry the delete.
delete_deny_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
DENY_ROLE_CREATED=""
if [ "${C_RC}" -eq 0 ]; then
  echo "[verify] FAIL: step C -- the deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (its status polls are denied)" >&2
  exit 1
fi
assert_abandoned "step C" "${LOG_DIR}/abandon-c.log" "${LOGICAL_ID_2}"
TOKEN_C="${TOKEN}"
STATE_C="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
if [ "$(printf '%s' "${STATE_C}" | jq -r --arg l "${LOGICAL_ID}" '.resources[$l].physicalId // "<absent>"')" != "${PL_A}" ] \
  || [ "$(printf '%s' "${STATE_C}" | jq --arg l "${LOGICAL_ID_2}" '.resources | has($l)')" != "false" ]; then
  echo "[verify] FAIL: step C -- after the abandoned deploy state must still record ${LOGICAL_ID} as ${PL_A} and hold no ${LOGICAL_ID_2}: $(printf '%s' "${STATE_C}" | jq -c '.resources | map_values(.physicalId)')" >&2
  exit 1
fi
poll_token "step C" "${TOKEN_C}" \
  || { echo "[verify] FAIL: step C -- could not read the abandoned request's status (aws or jq failed; output above)" >&2; exit 1; }
PL_C="${MADE}"
if [ "${PL_C}" = "${PL_A}" ]; then
  echo "[verify] FAIL: step C -- the second abandoned CREATE reports ${PL_C}, the list ${LOGICAL_ID} holds" >&2
  exit 1
fi
assert_pl_live "step C" "${PL_C}" "the abandoned CREATE completed"
echo "[verify] step C: the CREATE of ${LOGICAL_ID_2} was abandoned (token ${TOKEN_C}) and made ${PL_C}; destroy with the caller's credentials"
set +e
CCACR_SECOND=true ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force \
  > "${LOG_DIR}/destroy.log" 2>&1
D_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/destroy.log" || true
# 0: PL_C's identifier is EC2-minted, so the destroy deletes it as a proven
# orphan with no identity token (orphan-identity.ts, `orphanNeedsIdentity`),
# along with PL_A. Any other code is a failed destroy, or one that skipped or
# forgot PL_C.
if [ "${D_RC}" -ne 0 ]; then
  echo "[verify] FAIL: step C -- the destroy exited ${D_RC} (expected 0: ${PL_C} is deleted, not warned about -- output above)" >&2
  exit 1
fi
assert_pl_gone_eventually "step C -- ${PL_A} (state's ${LOGICAL_ID}) still exists after destroy" "${PL_A}"
assert_pl_gone_eventually "step C -- ${PL_C} (the abandoned CREATE of ${LOGICAL_ID_2}) still exists after destroy" "${PL_C}"
assert_gone "step C -- the destroy kept the rollback journal (expected the token settled and its orphan deleted)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# The assertions above decide the step on AWS's own answers; the log lines
# confirm the destroy's account of it. The resolver's head, its made-PL_C
# clause and the replay's delete line are independent markers, so the absent
# skip warning below cannot pass on a reworded log alone.
D_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/destroy.log" | tr '\n' ' ' | tr -s ' ')"
if ! grep -qF "stopped waiting for the Cloud Control CREATE of ${LOGICAL_ID_2} (${RESOURCE_TYPE})" <<<"${D_FLAT}"; then
  echo "[verify] FAIL: step C -- the destroy did not report re-polling the abandoned CREATE of ${LOGICAL_ID_2} (output above)" >&2
  exit 1
fi
if ! grep -qF "completed in AWS after cdkd stopped waiting, and made ${PL_C}." <<<"${D_FLAT}"; then
  echo "[verify] FAIL: step C -- the destroy did not report that the abandoned CREATE completed and made ${PL_C} (output above)" >&2
  exit 1
fi
if ! grep -qF "deleting partially-created ${LOGICAL_ID_2} (${RESOURCE_TYPE})" <<<"${D_FLAT}"; then
  echo "[verify] FAIL: step C -- the destroy did not report deleting ${LOGICAL_ID_2}'s list ${PL_C} (output above)" >&2
  exit 1
fi
if grep -qF 'Skipping failed CREATE' <<<"${D_FLAT}"; then
  echo "[verify] FAIL: step C -- the destroy skipped a failed CREATE (expected ${PL_C}, an EC2-minted id, deleted; output above)" >&2
  exit 1
fi
echo "[verify] step C ok: the destroy settled ${LOGICAL_ID_2}'s token and deleted ${PL_C} and ${PL_A} (rc=${D_RC})"

echo "[verify] step C: final gone-probes"
assert_pl_gone_eventually "prefix list ${PL_A} still exists after the run" "${PL_A}"
assert_pl_gone_eventually "prefix list ${PL_C} still exists after the run" "${PL_C}"
LEFT_LISTS="$(named_prefix_lists "${PL_NAME},${PL_NAME_2}")"
if [ -n "${LEFT_LISTS}" ]; then
  echo "[verify] FAIL: prefix list(s) ${LEFT_LISTS} named ${PL_NAME} / ${PL_NAME_2} still exist after the run" >&2
  exit 1
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal ${JOURNAL_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "cc-abandoned-create-resume state teardown"

echo "[verify] PASS -- an abandoned Cloud Control CREATE was taken over by the next deploy, and a second one was settled and named by destroy (go-to-k/cdkd#3252)"
