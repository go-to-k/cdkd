#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the EventBridge Pipes arm: a fix-forward deploy deletes
# the pipe an earlier failed CREATE left in AWS, once a live read
# (`isSameResource` on `PipesPipeProvider`) proves it is not the one the new
# state record holds, and its journaled identity (`<pipeArn>@<creationTime
# epoch seconds>`, `resourceIdentity`; the failed CREATE's mark carries it from
# `CreatePipe`'s answer) proves the pipe under the name is still the one that
# CREATE made. One whose name was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: the source and target queues, the pipes' execution
#      role and `BasePipe` (every pipe is STOPPED: nothing polls the queue).
#   2. The failed CREATE. A role is created that may create this run's pipes
#      (and pass the execution role to Pipes) but may neither describe nor
#      delete one. A `--no-rollback` deploy run as that role with
#      WITH_ORPHANS=true creates `OrphanA` and `OrphanC`; each settle wait is
#      refused its DescribePipe, and the provider's own cleanup delete is
#      refused too. Asserted: the deploy failed, both pipes exist, no state
#      record holds them, and the rollback journal carries each as a proven
#      orphan whose identity is the ARN and creation time DescribePipe reports
#      for it (as the caller) once it has settled: CreatePipe's and
#      DescribePipe's answers name the same token.
#   2b. The re-used name: `OrphanC`'s pipe is deleted and its name created
#      again outside the stack, with a marker tag. Asserted: it reports
#      another creation time (the premise the identity rests on). An
#      UpdatePipe on it is then measured for whether it moves the creation
#      time (a NOTE: a moved one only keeps an orphan).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps both
#      orphan logical ids under other names (`-b`). Asserted: `OrphanA`'s pipe
#      is deleted (`deleting partially-created OrphanA`), the re-created
#      `OrphanC` name is kept with its marker and creation time and warned
#      about as another resource (exit 2, the warning's text: the NEGATIVE
#      CONTROL), the journal is removed, and the state records hold the new
#      pipes. Before #4606 the deploy kept `OrphanA`'s too.
#   4. The re-created `OrphanC` pipe (this run's, no record's) is deleted by
#      name, then `cdkd destroy`. Every pipe, both queues, the execution role,
#      the state file and the restricted role are gone, and the state prefix's
#      object versions are swept.
#
# Cost: a few STOPPED pipes (no event is processed), two empty queues and two
# IAM roles. On any failure, cleanup deletes every pipe this run names,
# destroys the stack, deletes the queues and the roles by name.
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
STACK="CdkdPipesFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/pipes-fix-forward-orphan"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is
# versioned, and the journal and state records this run writes stay readable
# as noncurrent versions. Sourced by absolute path, before the `cd` below, so
# the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
if [ -z "${ACCOUNT_ID}" ] || [ "${ACCOUNT_ID}" = "None" ] || [ -z "${CALLER_USERID}" ] || [ "${CALLER_USERID}" = "None" ]; then
  echo "[verify] FAIL: sts get-caller-identity answered no account / user id" >&2
  exit 1
fi
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The names the stack derives (lib/pipes-fix-forward-orphan-stack.ts).
NAME_PREFIX="cdkd-pffo-"
P_BASE="cdkd-pffo-base"
P_A="cdkd-pffo-a"
P_A_B="cdkd-pffo-a-b"
P_C="cdkd-pffo-c"
P_C_B="cdkd-pffo-c-b"
ALL_PIPES=("${P_BASE}" "${P_A}" "${P_A_B}" "${P_C}" "${P_C_B}")
Q_SRC="cdkd-pffo-src"
Q_TGT="cdkd-pffo-tgt"
PIPE_ROLE="cdkd-pffo-pipe-role"
PIPE_ROLE_POLICY="source-and-target"
PIPE_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${PIPE_ROLE}"
Q_SRC_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${Q_SRC}"
Q_TGT_ARN="arn:aws:sqs:${REGION}:${ACCOUNT_ID}:${Q_TGT}"

DENY_ROLE="${STACK}-no-describe"
DENY_POLICY_NAME="create-without-describe"
DENY_ROLE_CREATED=""
# Set once the preconditions below pass: before that, the pipes or the stack
# may belong to a concurrent or earlier run, which a failure-path delete must
# not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# DescribePipe as the caller, into "${LOG_DIR}/pipe.json" (stderr kept in
# "${LOG_DIR}/pipe-err"). 0 = read, 3 = AWS answered NotFoundException; any
# other failure says why and answers 1, so "could not read" never reads as
# "gone".
pipe_read() { # usage: pipe_read <name>
  if aws pipes describe-pipe --name "$1" --output json >"${LOG_DIR}/pipe.json" 2>"${LOG_DIR}/pipe-err"; then
    return 0
  fi
  if grep -q 'NotFoundException' "${LOG_DIR}/pipe-err"; then
    return 3
  fi
  echo "[verify] DescribePipe for $1 failed: $(tail -3 "${LOG_DIR}/pipe-err" | tr '\n' ' ')" >&2
  return 1
}
pipe_exists() { # usage: pipe_exists <name>  (0 = exists, 1 = not found; exits the run on a read failure)
  local rc=0
  pipe_read "$1" || rc=$?
  case "${rc}" in
    0) return 0 ;;
    3) return 1 ;;
    *) echo "[verify] FAIL: could not read pipe $1" >&2; exit 1 ;;
  esac
}
# One field of the last pipe_read's answer; empty when absent or null.
pipe_field() { # usage: pipe_field <jq path>
  jq -r "$1 // empty" "${LOG_DIR}/pipe.json"
}
# The provider's identity token, `<pipeArn>@<creationTime epoch seconds>`
# (`PipesPipeProvider.resourceIdentity`), from the caller's DescribePipe. The
# CLI prints CreationTime as ISO 8601 (or as the wire's epoch number under
# `cli_timestamp_format = none`); both reduce to whole seconds. Fails the call
# on a read that answers none.
pipe_token() { # usage: pipe_token <name>
  local rc=0 arn ct secs
  pipe_read "$1" || rc=$?
  [ "${rc}" -eq 0 ] || return 1
  arn="$(pipe_field '.Arn')"
  ct="$(pipe_field '.CreationTime')"
  if [ -z "${arn}" ] || [ "${arn}" = "None" ] || [ -z "${ct}" ] || [ "${ct}" = "None" ]; then
    return 1
  fi
  secs="$(node -e 'const v=process.argv[1];const ms=/^[0-9]+(\.[0-9]+)?$/.test(v)?Number(v)*1000:Date.parse(v);if(!Number.isFinite(ms)||ms<=0)process.exit(1);process.stdout.write(String(Math.floor(ms/1000)))' "${ct}")" || return 1
  printf '%s@%s' "${arn}" "${secs}"
}
# Wait for a pipe to rest in RUNNING / STOPPED (a CREATING or UPDATING pipe
# refuses a delete or an update). FAILs the run on a *_FAILED state, a gone
# pipe and the cap.
pipe_wait_settled() { # usage: pipe_wait_settled <name>
  local state=""
  for _ in $(seq 1 60); do
    if ! pipe_exists "$1"; then
      echo "[verify] FAIL: pipe $1 is gone while waiting for it to settle" >&2
      exit 1
    fi
    state="$(pipe_field '.CurrentState')"
    case "${state}" in
      RUNNING | STOPPED) return 0 ;;
      *_FAILED)
        echo "[verify] FAIL: pipe $1 reached ${state}: $(pipe_field '.StateReason')" >&2
        exit 1
        ;;
    esac
    sleep 5
  done
  echo "[verify] FAIL: pipe $1 did not settle within 5 minutes (last state: ${state:-<none>})" >&2
  exit 1
}
# Whether a just-deleted pipe answers NotFoundException, on a bounded schedule
# (a DELETING pipe still holds its name).
pipe_gone_eventually() { # usage: pipe_gone_eventually <name>  (0 = gone)
  for _ in $(seq 1 36); do
    if ! pipe_exists "$1"; then
      return 0
    fi
    sleep 5
  done
  return 1
}
delete_pipe_by_name() { ( # usage: delete_pipe_by_name <name>  (best-effort; retried while a CREATING pipe refuses it)
  set +eu
  for _ in $(seq 1 24); do
    out="$(aws pipes delete-pipe --name "$1" 2>&1)" && break
    printf '%s' "${out}" | grep -q 'NotFoundException' && break
    sleep 5
  done
  true
); }
delete_queue_by_name() { ( # usage: delete_queue_by_name <name>  (best-effort)
  set +eu
  url="$(aws sqs get-queue-url --queue-name "$1" --query QueueUrl --output text 2>/dev/null)"
  if [ -n "${url}" ] && [ "${url}" != "None" ]; then
    aws sqs delete-queue --queue-url "${url}" >/dev/null 2>&1
  fi
  true
); }
delete_pipe_role() { ( # usage: delete_pipe_role  (best-effort)
  set +eu
  aws iam delete-role-policy --role-name "${PIPE_ROLE}" --policy-name "${PIPE_ROLE_POLICY}" >/dev/null 2>&1
  aws iam delete-role --role-name "${PIPE_ROLE}" >/dev/null 2>&1
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
    for p in "${P_A}" "${P_C}"; do
      delete_pipe_by_name "${p}"
    done
    # A DELETING pipe still uses the queues and the execution role the
    # destroy below removes: wait for each to be gone first.
    for p in "${P_A}" "${P_C}"; do
      ( pipe_gone_eventually "${p}" ) \
        || echo "[verify] WARN: pipe ${p} could not be confirmed deleted before the destroy" >&2
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    for p in "${ALL_PIPES[@]}"; do
      delete_pipe_by_name "${p}"
    done
    for p in "${ALL_PIPES[@]}"; do
      ( pipe_gone_eventually "${p}" ) \
        || echo "[verify] WARN: pipe ${p} could not be confirmed deleted; delete it by hand" >&2
    done
    delete_queue_by_name "${Q_SRC}"
    delete_queue_by_name "${Q_TGT}"
    delete_pipe_role
    for q in "${Q_SRC}" "${Q_TGT}"; do
      ( gone_probe aws sqs get-queue-url --queue-name "${q}" ) \
        || echo "[verify] WARN: queue ${q} could not be confirmed deleted; delete it by hand" >&2
    done
    ( gone_probe aws iam get-role --role-name "${PIPE_ROLE}" ) \
      || echo "[verify] WARN: role ${PIPE_ROLE} could not be confirmed deleted; delete it by hand" >&2
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  rm -rf "${LOG_DIR}"
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
PRE_JSON="$(aws pipes list-pipes --name-prefix "${NAME_PREFIX}" --output json 2>"${LOG_DIR}/list-err")" \
  || { echo "[verify] FAIL: precondition -- ListPipes failed: $(tail -3 "${LOG_DIR}/list-err" | tr '\n' ' ')" >&2; exit 1; }
PRE_LISTED="$(printf '%s' "${PRE_JSON}" | jq -r '[.Pipes[]?.Name] | join(" ")')"
if [ -n "${PRE_LISTED}" ]; then
  echo "[verify] FAIL: precondition -- pipes under ${NAME_PREFIX} already exist (${PRE_LISTED}; left by an earlier run); delete them first" >&2
  exit 1
fi
for q in "${Q_SRC}" "${Q_TGT}"; do
  assert_gone "precondition: queue ${q} already exists (left by an earlier run); delete it first" \
    aws sqs get-queue-url --queue-name "${q}"
done
assert_gone "precondition: role ${PIPE_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${PIPE_ROLE}"
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (queues, execution role, BasePipe)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
pipe_wait_settled "${P_BASE}"

echo "[verify] step 2: a role that may create a pipe but neither describe nor delete one"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs and
# sts:GetCallerIdentity are `*`; SSM is the CDK bootstrap parameters, KMS only
# through S3 (the state bucket's encryption). The S3 verbs on the state bucket
# are the state path's (src/state/{s3-state-backend,lock-manager,
# s3-noncurrent-version-purge,s3-replication-purge-gap}.ts,
# src/utils/aws-region-resolver.ts). On this run's pipes (`cdkd-pffo-*`) the
# role may CreatePipe, and it may pass the stack's execution role to Pipes
# only. DescribePipe is denied, so each CREATE's settle wait fails after Pipes
# made the pipe, and so is the engine's own identity read: the journal's token
# can only come from CreatePipe's answer, carried on the failure's mark.
# DeletePipe (and every other write) is denied, so the provider's own cleanup
# cannot remove it. No statement allows a credential or an IAM write.
# sts:AssumeRole is denied everywhere: nothing this session runs assumes a
# role (cdkd is run without --role-arn).
DENY_POLICY="$(node -e 'const [bucket,stack,acct,region,passRole]=process.argv.slice(1);const p=`arn:aws:pipes:${region}:${acct}:pipe/cdkd-pffo-*`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["pipes:CreatePipe"],Resource:p},{Effect:"Allow",Action:["iam:PassRole"],Resource:passRole,Condition:{StringEquals:{"iam:PassedToService":"pipes.amazonaws.com"}}},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["pipes:DescribePipe","pipes:DeletePipe","pipes:UpdatePipe","pipes:StartPipe","pipes:StopPipe"],Resource:p},{Effect:"Deny",Action:["sts:AssumeRole"],Resource:"*"}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${REGION}" "${PIPE_ROLE_ARN}")"
# Armed BEFORE the create: an interrupt between a successful create-role and
# the flag would otherwise leave the role behind. The precondition above
# proved the name absent, so the cleanup's best-effort delete (a NoSuchEntity
# is ignored) and its gone-confirm act only on this run's role.
DENY_ROLE_CREATED=1
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=pipes-fix-forward-orphan >/dev/null
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
assume_err=""
for _ in $(seq 1 24); do
  # stderr (the error text only) goes to the log; stdout (the credentials)
  # stays in the variable.
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-pipes-fix-forward \
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
if [ -z "${DENY_AK}" ] || [ "${DENY_AK}" = "None" ] || [ -z "${DENY_ST}" ] || [ "${DENY_ST}" = "None" ]; then
  echo "[verify] FAIL: precondition -- sts assume-role answered no credentials for ${DENY_ROLE}" >&2
  exit 1
fi
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
# The inline policy must already bind: before it propagates, the role is
# refused everything implicitly, and the deploy below would then fail before
# any CreatePipe for the wrong reason. Its Allow is probed on the state
# record, which only this policy lets the role read.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if as_deny_role aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>"${LOG_DIR}/allow-err"; then
    ALLOW_PROBE=1
    break
  fi
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not read the state record within 2 minutes (last answer: $(tail -3 "${LOG_DIR}/allow-err" 2>/dev/null | tr '\n' ' '))" >&2
  exit 1
fi
# ...and its Deny, on BasePipe, which EXISTS: DescribePipe must be refused
# (an explicit deny once the document binds; no statement allows it either).
if as_deny_role aws pipes describe-pipe --name "${P_BASE}" >/dev/null 2>"${LOG_DIR}/deny-err"; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could DESCRIBE ${P_BASE} (its policy must refuse DescribePipe)" >&2
  exit 1
fi
if ! grep -qiE 'AccessDenied|not authorized' "${LOG_DIR}/deny-err"; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s DescribePipe failed for another reason than a denial: $(tail -3 "${LOG_DIR}/deny-err" | tr '\n' ' ')" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after Pipes made the pipe"
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
for p in "${P_A}" "${P_C}"; do
  if ! pipe_exists "${p}"; then
    echo "[verify] FAIL: pipe ${p} does not exist after step 2 -- its CREATE failed before CreatePipe returned (output above)" >&2
    exit 1
  fi
done
# The deploy's own account: each CREATE's cleanup was refused (the provider's
# pasteable delete command names the pipe; retireFailedCreate's `orphaned`).
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for p in "${P_A}" "${P_C}"; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "Otherwise delete it yourself with: aws pipes delete-pipe --name ${p} --region ${REGION}"; then
    echo "[verify] FAIL: the step-2 deploy did not report ${p}'s refused cleanup (output above)" >&2
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
# Both orphans go on from CREATING by themselves; once settled they also take
# the deletes below.
pipe_wait_settled "${P_A}"
pipe_wait_settled "${P_C}"
# go-to-k/cdkd#4655 / #4606: the journal carries the identity the settle
# compares before deleting a name-keyed orphan: the pipe's ARN and creation
# time from CreatePipe's answer (the role could not describe it). It must
# equal what DescribePipe reports now, after the pipe settled.
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
A_TOKEN="$(pipe_token "${P_A}")" || { echo "[verify] FAIL: DescribePipe answered no Arn / CreationTime for ${P_A} after step 2" >&2; exit 1; }
# A measurement for the token's precision: the CLI's rendering of the time.
echo "[verify] NOTE: DescribePipe reports ${P_A}'s CreationTime as '$(pipe_field '.CreationTime')'"
C_TOKEN="$(pipe_token "${P_C}")" || { echo "[verify] FAIL: DescribePipe answered no Arn / CreationTime for ${P_C} after step 2" >&2; exit 1; }
assert_journaled OrphanA "${P_A}" "${A_TOKEN}"
assert_journaled OrphanC "${P_C}" "${C_TOKEN}"
echo "[verify] step 2 ok: two pipes are in AWS, journaled with their identities (${A_TOKEN} ${C_TOKEN}), with no state record"

echo "[verify] step 2b: ${P_C} is deleted and its name re-used outside the stack"
aws pipes delete-pipe --name "${P_C}" >/dev/null
if ! pipe_gone_eventually "${P_C}"; then
  echo "[verify] FAIL: step 2b: ${P_C} still exists 3 minutes after its delete" >&2
  exit 1
fi
# The marker: a tag no CREATE of the stack sets.
C_STAMP="$(date -u +%s)"
C_MARKER="re-created-outside-${C_STAMP}"
C_CREATED=""
for _ in $(seq 1 12); do
  if aws pipes create-pipe --name "${P_C}" --role-arn "${PIPE_ROLE_ARN}" \
    --source "${Q_SRC_ARN}" --target "${Q_TGT_ARN}" --desired-state STOPPED \
    --tags "cdkd-pffo-marker=${C_MARKER}" >/dev/null 2>"${LOG_DIR}/c-err"; then
    C_CREATED=1
    break
  fi
  # Only the delete not having settled yet is retried.
  grep -q 'ConflictException' "${LOG_DIR}/c-err" || { cat "${LOG_DIR}/c-err" >&2; exit 1; }
  sleep 5
done
if [ -z "${C_CREATED}" ]; then
  echo "[verify] FAIL: could not re-create ${P_C} within a minute of its delete" >&2
  exit 1
fi
pipe_wait_settled "${P_C}"
# The premise the identity rests on: the re-created pipe reports ANOTHER
# token under the same name (the same ARN, another creation time).
C2_TOKEN="$(pipe_token "${P_C}")" || { echo "[verify] FAIL: DescribePipe answered no token for the re-created ${P_C}" >&2; exit 1; }
if [ "${C2_TOKEN}" = "${C_TOKEN}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${P_C} reports '${C2_TOKEN}', the deleted one's identity: a creation time that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's pipe identity is then unsound)" >&2
  exit 1
fi
if [ "${C2_TOKEN%@*}" != "${C_TOKEN%@*}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${P_C} reports ARN '${C2_TOKEN%@*}', not the deleted one's '${C_TOKEN%@*}' (expected the same name-built ARN)" >&2
  exit 1
fi
# A measurement, not a premise: an UpdatePipe after the create. A moved
# creation time would only keep such an orphan (fail-safe), never delete one.
C_DESC="cdkd-pffo update measurement ${C_STAMP}"
aws pipes update-pipe --name "${P_C}" --role-arn "${PIPE_ROLE_ARN}" --desired-state STOPPED \
  --description "${C_DESC}" >/dev/null
# A settled read may still show the pipe from BEFORE the update: wait until
# DescribePipe reports the new description, then until it settles.
C_UPDATED=""
for _ in $(seq 1 36); do
  if ! pipe_exists "${P_C}"; then
    echo "[verify] FAIL: ${P_C} is gone after its update" >&2
    exit 1
  fi
  if [ "$(pipe_field '.Description')" = "${C_DESC}" ]; then
    C_UPDATED=1
    break
  fi
  sleep 5
done
if [ -z "${C_UPDATED}" ]; then
  echo "[verify] FAIL: DescribePipe never reported ${P_C}'s updated description within 3 minutes" >&2
  exit 1
fi
pipe_wait_settled "${P_C}"
C2B_TOKEN="$(pipe_token "${P_C}")" || { echo "[verify] FAIL: DescribePipe answered no token for ${P_C} after its update" >&2; exit 1; }
if [ "${C2B_TOKEN}" = "${C2_TOKEN}" ]; then
  echo "[verify] NOTE: UpdatePipe did not move ${P_C}'s creation time"
else
  echo "[verify] NOTE: UpdatePipe MOVED ${P_C}'s creation time (${C2_TOKEN} -> ${C2B_TOKEN})"
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
if ! pipe_gone_eventually "${P_A}"; then
  echo "[verify] FAIL: the earlier attempt's pipe ${P_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" >&2
  exit 1
fi
# The NEGATIVE CONTROL: the re-used name is someone else's now: kept,
# untouched (its marker tag and its token).
C3_TOKEN="$(pipe_token "${P_C}")" || C3_TOKEN="<not read>"
C3_MARKER="<not read>"
if [ "${C3_TOKEN}" != "<not read>" ]; then
  C3_MARKER="$(pipe_field '.Tags["cdkd-pffo-marker"]')" || C3_MARKER="<unparsable tags>"
fi
if [ "${C3_TOKEN}" != "${C2B_TOKEN}" ] || [ "${C3_MARKER}" != "${C_MARKER}" ]; then
  echo "[verify] FAIL: the re-created ${P_C} was not left untouched by the fix-forward (token '${C3_TOKEN}', marker '${C3_MARKER:-<none>}'; expected '${C2B_TOKEN}' / '${C_MARKER}')" >&2
  exit 1
fi
# The kept entry was warned about, so the journal goes with it.
assert_gone "the fix-forward kept the rollback journal (expected it removed: OrphanA's deleted, OrphanC's warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for p in "${P_A_B}" "${P_C_B}" "${P_BASE}"; do
  if ! pipe_exists "${p}"; then
    echo "[verify] FAIL: the record's pipe ${p} is missing after the fix-forward (the settle must not delete the records' pipes)" >&2
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
assert_record OrphanA "${P_A_B}"
assert_record OrphanC "${P_C_B}"
assert_record BasePipe "${P_BASE}"
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name OrphanA.
if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created OrphanA"; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanA (output above)" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF "OrphanA (AWS::Pipes::Pipe), which a failed deploy"; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanA instead of deleting it (output above)" >&2
  exit 1
fi
# Sentinel for the wording above: OrphanC's keep warning uses the same head,
# so a reword that would blind the OrphanA checks fails here first.
if ! printf '%s' "${FF_FLAT}" | grep -qF "OrphanC (AWS::Pipes::Pipe), which a failed deploy of stack ${STACK} created, is not deleted: the resource now under its physical id is another one"; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's physical id now holds another pipe (no 'OrphanC (AWS::Pipes::Pipe), which a failed deploy ... is another one' in the output): if the settle's keep-warning head changed, update the OrphanA checks above" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created OrphanC"; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${P_A}, kept the re-created ${P_C} untouched, and the records hold the -b pipes (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${P_C} (this run's, no record's), then destroy"
aws pipes delete-pipe --name "${P_C}" >/dev/null
if ! pipe_gone_eventually "${P_C}"; then
  echo "[verify] FAIL: the re-created ${P_C} still exists 3 minutes after its delete" >&2
  exit 1
fi
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for p in "${ALL_PIPES[@]}"; do
  if ! pipe_gone_eventually "${p}"; then
    echo "[verify] FAIL: pipe ${p} still exists after destroy" >&2
    exit 1
  fi
done
for q in "${Q_SRC}" "${Q_TGT}"; do
  assert_gone "queue ${q} still exists after destroy" aws sqs get-queue-url --queue-name "${q}"
done
assert_gone "role ${PIPE_ROLE} still exists after destroy" aws iam get-role --role-name "${PIPE_ROLE}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "pipes-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's pipe and kept the one whose name was re-used (go-to-k/cdkd#4606)"
