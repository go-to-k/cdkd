#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the Lambda function arm: a fix-forward deploy deletes the
# function an earlier failed CREATE left in AWS, once a live read
# (`LambdaFunctionProvider.isSameResource`) proves it is not the function the
# new state record holds, and its journaled identity (the
# `<FunctionArn>@<LastModified epoch ms>` its `CreateFunction` answered with,
# `LambdaFunctionProvider.resourceIdentity` on the live side) proves the
# function under the name is still the one that CREATE made. A function whose
# name was deleted and re-used in between is kept.
#
# Phases:
#   1. Baseline deploy: `ExecRole` and `BaseFn`.
#   1b. Measurement: each post-create call a CREATE makes changes BaseFn's
#      value and restores it. PutFunctionRecursionConfig and
#      PutFunctionConcurrency must leave `LastModified` where it was;
#      PutRuntimeManagementConfig must move it (what `create` assumes when it
#      drops CreateFunction's token after that call).
#   2. The failed CREATE. A role is created that may create and read a
#      function but may not delete it, set its reserved concurrency, or set
#      the recursion config of OrphanA's or OrphanC's. A
#      `--no-rollback` deploy run as that role with WITH_ORPHANS=true creates
#      `OrphanA`'s, `OrphanC`'s and `OrphanD`'s functions, fails A and C on
#      `PutFunctionRecursionConfig` (D as below), and the provider's own cleanup
#      (`DeleteFunction`) is refused too. (The AccessDenied is retried as IAM
#      propagation; each replayed CreateFunction collides with the first
#      attempt's function, and the first attempt's created-function mark is
#      carried to the journal.) `OrphanD` also declares
#      `ReservedConcurrentExecutions`, and the role allows its
#      PutFunctionRecursionConfig and denies PutFunctionConcurrency, so its
#      CREATE fails on the SECOND Put, after a successful one on a still-Pending
#      function. Asserted: the deploy failed, all three functions exist, no
#      state record holds them, and the rollback journal carries
#      each as a proven orphan whose identity is the ARN and `LastModified`
#      AWS reports for it once it is Active (the premise that the Pending to
#      Active transition does not move `LastModified`).
#   2b. The re-used name: `OrphanC`'s function is deleted and its name created
#      again outside the stack, with a marker tag. Asserted: it reports another
#      identity (the premise the identity rests on).
#   3. The fix-forward: WITH_ORPHANS=true ORPHAN_FIX_FORWARD=true keeps every
#      orphan logical id under other names (`-b`). Asserted: `OrphanA`'s and
#      `OrphanD`'s earlier functions are deleted (`deleting partially-created
#      <lid>`), the re-created `OrphanC` name is kept with its marker and warned about as
#      another function (exit 2, the warning's code), the journal is removed,
#      and the state records hold the new functions. Before #4606 the deploy
#      kept `OrphanA`'s and `OrphanD`'s functions too.
#   4. The re-created `OrphanC` function (this run's, no record's) is deleted
#      by name, then `cdkd destroy`. Every function, the execution role, the
#      state file and the restricted role are gone, and the state prefix's
#      object versions are swept.
#
# Cost: a handful of never-invoked functions. On any failure, cleanup
# destroys the stack, deletes every function this run names and deletes the
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
# A DeleteFunction can take a moment to read as gone: retry the gone-probe on
# a bounded schedule. A function that never disappears still FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws lambda get-function ...
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
STACK="CdkdLambdaFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/lambda-fix-forward-orphan"
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

# The names the stack derives (lib/lambda-fix-forward-orphan-stack.ts).
BASE_FN="cdkd-lffo-base"
FN_A="cdkd-lffo-a"
FN_A_B="cdkd-lffo-a-b"
FN_C="cdkd-lffo-c"
FN_C_B="cdkd-lffo-c-b"
FN_D="cdkd-lffo-d"
FN_D_B="cdkd-lffo-d-b"
ALL_FNS=("${BASE_FN}" "${FN_A}" "${FN_A_B}" "${FN_C}" "${FN_C_B}" "${FN_D}" "${FN_D_B}")

DENY_ROLE="${STACK}-no-recursion"
DENY_POLICY_NAME="create-without-configure"
DENY_ROLE_CREATED=""
# The stack's execution role, read from the state record after step 1.
EXEC_ROLE=""
# Set once the preconditions below pass: before that, the functions or the
# stack may belong to a concurrent or earlier run, which a failure-path delete
# must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

# The provider's identity token, `<FunctionArn>@<LastModified epoch ms>`
# (lambda-function-provider.ts, `functionIdentityToken`). Fails the call on a
# read that answers no ARN or no parseable LastModified.
fn_token() { # usage: fn_token <function>
  local out arn modified ms
  out="$(aws lambda get-function-configuration --function-name "$1" --region "${REGION}" \
    --query '[FunctionArn, LastModified]' --output text)" || return 1
  arn="$(printf '%s\n' "${out}" | cut -f1)"
  modified="$(printf '%s\n' "${out}" | cut -f2)"
  ms="$(node -e 'const t=Date.parse(process.argv[1]);if(Number.isNaN(t))process.exit(1);process.stdout.write(String(t))' "${modified}")" || return 1
  if [ -z "${arn}" ] || [ "${arn}" = "None" ]; then
    return 1
  fi
  printf '%s@%s' "${arn}" "${ms}"
}

delete_fn_by_name() { ( # usage: delete_fn_by_name <function>  (best-effort)
  set +eu
  aws lambda delete-function --function-name "$1" --region "${REGION}" >/dev/null 2>&1
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
    # Functions first, by name, for the ones no state record holds (the
    # orphans and the re-created name): the destroy below then deletes the
    # execution role with nothing left using it.
    for f in "${ALL_FNS[@]}"; do
      delete_fn_by_name "${f}"
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds.
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    for f in "${ALL_FNS[@]}"; do
      ( gone_probe aws lambda get-function --function-name "${f}" --region "${REGION}" ) \
        || echo "[verify] WARN: function ${f} could not be confirmed deleted; delete it by hand" >&2
    done
    if [ -n "${EXEC_ROLE}" ] && ! ( gone_probe aws iam get-role --role-name "${EXEC_ROLE}" ); then
      echo "[verify] WARN: execution role ${EXEC_ROLE} could not be confirmed deleted; delete it by hand" >&2
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

# A record or function left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for f in "${ALL_FNS[@]}"; do
  assert_gone "precondition: function ${f} already exists (left by an earlier run); delete it first" \
    aws lambda get-function --function-name "${f}" --region "${REGION}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (ExecRole, BaseFn)"
env -u WITH_ORPHANS -u ORPHAN_FIX_FORWARD ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"
STATE_1="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
EXEC_ROLE="$(printf '%s' "${STATE_1}" | jq -r '.resources.ExecRole.physicalId // empty')"
if [ -z "${EXEC_ROLE}" ]; then
  echo "[verify] FAIL: the state record holds no ExecRole physical id after step 1" >&2
  exit 1
fi
EXEC_ROLE_ARN="$(aws iam get-role --role-name "${EXEC_ROLE}" --query 'Role.Arn' --output text)"
aws lambda wait function-active-v2 --function-name "${BASE_FN}" --region "${REGION}"

echo "[verify] step 1b: measure which post-create calls move LastModified"
# The identity a failed CREATE journals is CreateFunction's LastModified, and
# a CREATE that failed on a LATER post-create call has already made the
# earlier ones (lambda-function-provider.ts, `create`: RecursiveLoop, then
# ReservedConcurrentExecutions, then RuntimeManagementConfig). Each is called
# here on BaseFn with a value it does NOT have (a Put repeating the current
# value could be a no-op), the token compared, and the value restored before
# any FAIL. Recursion config and concurrency must not move LastModified: one
# that did would keep every orphan failing after it as "another function".
# Runtime management config is measured to move it (below). (Step 2's OrphanD
# measures that a SUCCESSFUL PutFunctionRecursionConfig leaves LastModified
# alone on a still-Pending function, through a CREATE that then failed on
# PutFunctionConcurrency.)
probe_put_keeps_token() { # usage: probe_put_keeps_token <api label> <change cmd> <restore cmd>  (each a single string, eval'd)
  local label="$1" change="$2" restore="$3" before after
  before="$(fn_token "${BASE_FN}")" || { echo "[verify] FAIL: premise -- could not read ${BASE_FN}'s identity before ${label}" >&2; exit 1; }
  eval "${change}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
  after="$(fn_token "${BASE_FN}")" || { echo "[verify] FAIL: premise -- could not read ${BASE_FN}'s identity after ${label}" >&2; exit 1; }
  eval "${restore}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
  if [ "${after}" != "${before}" ]; then
    echo "[verify] FAIL: premise -- ${label} moved ${BASE_FN}'s LastModified (${before} -> ${after}): an orphan whose CREATE failed after it is never proven (go-to-k/cdkd#4606's Lambda identity is then unsound for that path)" >&2
    exit 1
  fi
  echo "[verify]   ${label}: LastModified unchanged"
}
REC_NOW="$(aws lambda get-function-recursion-config --function-name "${BASE_FN}" --region "${REGION}" --query 'RecursiveLoop' --output text)"
RT_NOW="$(aws lambda get-runtime-management-config --function-name "${BASE_FN}" --region "${REGION}" --query 'UpdateRuntimeOn' --output text)"
if [ "${REC_NOW}" != "Terminate" ] || [ "${RT_NOW}" != "Auto" ]; then
  echo "[verify] FAIL: premise -- ${BASE_FN} starts with RecursiveLoop '${REC_NOW}' / UpdateRuntimeOn '${RT_NOW}' (expected the defaults Terminate / Auto, which the probes change away from)" >&2
  exit 1
fi
probe_put_keeps_token PutFunctionRecursionConfig \
  'aws lambda put-function-recursion-config --function-name "${BASE_FN}" --recursive-loop Allow --region "${REGION}"' \
  'aws lambda put-function-recursion-config --function-name "${BASE_FN}" --recursive-loop Terminate --region "${REGION}"'
# PutRuntimeManagementConfig is measured to MOVE LastModified, so `create`
# drops CreateFunction's token after a successful one (a later failure then
# journals the engine's live read). Asserted as the observed fact, so an AWS
# change that stops moving it is noticed and the provider comment updated.
RT_BEFORE="$(fn_token "${BASE_FN}")" || { echo "[verify] FAIL: could not read ${BASE_FN}'s identity before PutRuntimeManagementConfig" >&2; exit 1; }
aws lambda put-runtime-management-config --function-name "${BASE_FN}" --update-runtime-on FunctionUpdate --region "${REGION}" >/dev/null
aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
RT_AFTER="$(fn_token "${BASE_FN}")" || { aws lambda put-runtime-management-config --function-name "${BASE_FN}" --update-runtime-on Auto --region "${REGION}" >/dev/null; echo "[verify] FAIL: could not read ${BASE_FN}'s identity after PutRuntimeManagementConfig" >&2; exit 1; }
aws lambda put-runtime-management-config --function-name "${BASE_FN}" --update-runtime-on Auto --region "${REGION}" >/dev/null
aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
if [ "${RT_AFTER}" = "${RT_BEFORE}" ]; then
  echo "[verify] FAIL: measurement -- PutRuntimeManagementConfig no longer moves ${BASE_FN}'s LastModified (${RT_BEFORE}): update the go-to-k/cdkd#4606 comment in lambda-function-provider.ts \`create\` (it drops CreateFunction's token after this call) and this check" >&2
  exit 1
fi
echo "[verify]   PutRuntimeManagementConfig: LastModified moved (${RT_BEFORE} -> ${RT_AFTER}), as create() expects"
# A reserved concurrency of 1 may be refused on an account whose unreserved
# floor allows none; only that refusal skips the probe, with a NOTE.
CONC_BEFORE="$(fn_token "${BASE_FN}")" || { echo "[verify] FAIL: premise -- could not read ${BASE_FN}'s identity before PutFunctionConcurrency" >&2; exit 1; }
if CONC_OUT="$(aws lambda put-function-concurrency --function-name "${BASE_FN}" \
  --reserved-concurrent-executions 1 --region "${REGION}" 2>&1)"; then
  aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
  CONC_AFTER="$(fn_token "${BASE_FN}")" || { aws lambda delete-function-concurrency --function-name "${BASE_FN}" --region "${REGION}"; echo "[verify] FAIL: premise -- could not read ${BASE_FN}'s identity after PutFunctionConcurrency" >&2; exit 1; }
  aws lambda delete-function-concurrency --function-name "${BASE_FN}" --region "${REGION}"
  if [ "${CONC_AFTER}" != "${CONC_BEFORE}" ]; then
    echo "[verify] FAIL: premise -- PutFunctionConcurrency moved ${BASE_FN}'s LastModified (${CONC_BEFORE} -> ${CONC_AFTER}): an orphan whose CREATE failed after it is never proven (go-to-k/cdkd#4606's Lambda identity is then unsound for that path)" >&2
    exit 1
  fi
  echo "[verify]   PutFunctionConcurrency: LastModified unchanged"
elif printf '%s' "${CONC_OUT}" | grep -qi 'UnreservedConcurrentExecution'; then
  echo "[verify] NOTE: PutFunctionConcurrency probe skipped -- the account's unreserved concurrency floor refuses a reservation (${CONC_OUT})"
else
  echo "[verify] FAIL: premise -- PutFunctionConcurrency on ${BASE_FN} failed: ${CONC_OUT}" >&2
  exit 1
fi
aws lambda wait function-updated-v2 --function-name "${BASE_FN}" --region "${REGION}"
BASE_TOKEN="$(fn_token "${BASE_FN}")"

echo "[verify] step 2: a role that may create a function but not delete it nor complete its post-create calls"
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls: only read-only CloudFormation verbs and
# sts:GetCallerIdentity (which takes no resource) are `*`; SSM is the CDK
# bootstrap parameters, KMS only through S3 (the state bucket's encryption).
# The S3 verbs on the state bucket are the state path's
# (src/state/{s3-state-backend,lock-manager,s3-noncurrent-version-purge,
# s3-replication-purge-gap}.ts, src/utils/aws-region-resolver.ts). On this
# run's functions the role may: CreateFunction (with iam:PassRole on the
# stack's execution role, and TagResource for a create carrying Tags);
# GetFunction / GetFunctionConfiguration / ListTags (reads); iam:GetRole on
# the execution role (a read of the unchanged record).
# PutFunctionRecursionConfig (the first post-create configuration call) is
# denied on OrphanA's and OrphanC's names and allowed on OrphanD's;
# PutFunctionConcurrency (the second) is denied on every name, so OrphanD's
# CREATE passes the first Put and fails on the second. Each CREATE thus fails
# after Lambda made the function; DeleteFunction is denied, so the provider's
# own cleanup cannot remove it.
DENY_POLICY="$(node -e 'const [bucket,stack,acct,region,execRole]=process.argv.slice(1);const fns=`arn:aws:lambda:${region}:${acct}:function:cdkd-lffo-*`;const role=`arn:aws:iam::${acct}:role/${execRole}`;process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["lambda:CreateFunction","lambda:TagResource","lambda:GetFunction","lambda:GetFunctionConfiguration","lambda:ListTags"],Resource:fns},{Effect:"Allow",Action:["lambda:PutFunctionRecursionConfig"],Resource:`arn:aws:lambda:${region}:${acct}:function:cdkd-lffo-d*`},{Effect:"Allow",Action:["iam:PassRole","iam:GetRole"],Resource:role},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Allow",Action:["kms:Decrypt","kms:GenerateDataKey"],Resource:`arn:aws:kms:*:${acct}:key/*`,Condition:{StringLike:{"kms:ViaService":"s3.*.amazonaws.com"}}},{Effect:"Allow",Action:["cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Deny",Action:["lambda:DeleteFunction","lambda:PutFunctionConcurrency"],Resource:fns},{Effect:"Deny",Action:["lambda:PutFunctionRecursionConfig"],Resource:[`arn:aws:lambda:${region}:${acct}:function:cdkd-lffo-a*`,`arn:aws:lambda:${region}:${acct}:function:cdkd-lffo-c*`]}]}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "${REGION}" "${EXEC_ROLE}")"
aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=lambda-fix-forward-orphan >/dev/null
DENY_ROLE_CREATED=1
aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
  --policy-document "${DENY_POLICY}"
# A new role is assumable only once IAM has propagated it.
DENY_CREDS=""
for _ in $(seq 1 24); do
  if DENY_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
    --role-session-name cdkd-lambda-fix-forward \
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
# fail before any CREATE for the wrong reason. Probed on BaseFn, which EXISTS.
# The probe cannot delete it: no statement allows DeleteFunction, so it is
# refused implicitly before the policy binds and explicitly after.
DENY_PROBE=""
for _ in $(seq 1 24); do
  if DENY_PROBE="$(as_deny_role aws lambda delete-function --function-name "${BASE_FN}" --region "${REGION}" 2>&1)"; then
    echo "[verify] FAIL: precondition -- ${DENY_ROLE} DELETED ${BASE_FN} (its policy must refuse DeleteFunction)" >&2
    exit 1
  elif printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
    break
  fi
  sleep 5
done
if ! printf '%s' "${DENY_PROBE}" | grep -qi 'explicit deny'; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE}'s explicit deny on DeleteFunction never bound within 2 minutes (last answer: ${DENY_PROBE:-<allowed>})" >&2
  exit 1
fi
# The Allow statements must bind too, or the deploy below fails for the wrong
# reason.
ALLOW_PROBE=""
for _ in $(seq 1 24); do
  if ALLOW_PROBE="$(as_deny_role aws lambda get-function-configuration --function-name "${BASE_FN}" --region "${REGION}" \
    --query 'FunctionName' --output text 2>&1)" && [ "${ALLOW_PROBE}" = "${BASE_FN}" ]; then
    break
  fi
  ALLOW_PROBE=""
  sleep 5
done
if [ -z "${ALLOW_PROBE}" ]; then
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} could not GetFunctionConfiguration ${BASE_FN} within 2 minutes" >&2
  exit 1
fi

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE}: every orphan CREATE fails after Lambda made the function"
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
for f in "${FN_A}" "${FN_C}" "${FN_D}"; do
  if gone_probe aws lambda get-function --function-name "${f}" --region "${REGION}"; then
    echo "[verify] FAIL: function ${f} does not exist after step 2 -- its CREATE failed before CreateFunction returned (output above)" >&2
    exit 1
  fi
done
# The premise of the injection, from the deploy's own account: each CREATE
# failed on the recursion-config call, after the function was made.
INJECT_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/inject.log" | tr '\n' ' ' | tr -s ' ')"
for lid in OrphanA OrphanC; do
  if ! printf '%s' "${INJECT_FLAT}" | grep -qF "PutFunctionRecursionConfig failed for ${lid}"; then
    echo "[verify] FAIL: the step-2 deploy did not fail ${lid} on PutFunctionRecursionConfig (output above)" >&2
    exit 1
  fi
done
if ! printf '%s' "${INJECT_FLAT}" | grep -qF "PutFunctionConcurrency failed for OrphanD"; then
  echo "[verify] FAIL: the step-2 deploy did not fail OrphanD on PutFunctionConcurrency (output above)" >&2
  exit 1
fi
# OrphanD's first Put went through: the journaled token below is then measured
# after a SUCCESSFUL post-create call on a function that was still Pending.
if printf '%s' "${INJECT_FLAT}" | grep -qF "PutFunctionRecursionConfig failed for OrphanD"; then
  echo "[verify] FAIL: the step-2 deploy failed OrphanD on PutFunctionRecursionConfig (expected it allowed, so the CREATE fails on the later PutFunctionConcurrency -- output above)" >&2
  exit 1
fi
D_REC="$(aws lambda get-function-recursion-config --function-name "${FN_D}" --region "${REGION}" --query 'RecursiveLoop' --output text)"
if [ "${D_REC}" != "Allow" ]; then
  echo "[verify] FAIL: ${FN_D}'s RecursiveLoop reads '${D_REC}' after step 2 (expected Allow: its CREATE must pass PutFunctionRecursionConfig)" >&2
  exit 1
fi
STATE_2="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
for lid in OrphanA OrphanC OrphanD; do
  if [ "$(printf '%s' "${STATE_2}" | jq --arg l "${lid}" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records ${lid} after step 2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
done
JOURNAL_2="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)"
# go-to-k/cdkd#4655 / #4606: the journal carries the identity the settle
# compares before deleting a name-keyed orphan: the ARN and LastModified
# CreateFunction answered with, carried on the failure's mark. It must equal
# what GetFunctionConfiguration reports once the function is Active: cdkd does
# not wait for Active, so a LastModified the transition moved would never
# prove the orphan.
assert_journaled() { # usage: assert_journaled <logicalId> <function>
  local op want
  aws lambda wait function-active-v2 --function-name "$2" --region "${REGION}" \
    || { echo "[verify] FAIL: $2 never became Active after step 2" >&2; exit 1; }
  want="$(fn_token "$2")" || { echo "[verify] FAIL: GetFunctionConfiguration $2 answered no ARN or LastModified after step 2" >&2; exit 1; }
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
assert_journaled OrphanA "${FN_A}"
assert_journaled OrphanC "${FN_C}"
assert_journaled OrphanD "${FN_D}"
C_TOKEN="$(fn_token "${FN_C}")"
echo "[verify] step 2 ok: ${FN_A}, ${FN_C} and ${FN_D} are in AWS, journaled with their identities, with no state record"

echo "[verify] step 2b: ${FN_C} is deleted and its name re-used outside the stack"
aws lambda delete-function --function-name "${FN_C}" --region "${REGION}" >/dev/null
assert_gone_eventually "step 2b: ${FN_C} survived its delete" \
  aws lambda get-function --function-name "${FN_C}" --region "${REGION}"
C_MARKER="phase2b-$(date -u +%s)"
python3 -I - "${LOG_DIR}/holder.zip" <<'PY'
import sys, zipfile
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    z.writestr('index.js', 'exports.handler = async () => ({});\n')
PY
aws lambda create-function --function-name "${FN_C}" --runtime nodejs22.x \
  --handler index.handler --role "${EXEC_ROLE_ARN}" \
  --zip-file "fileb://${LOG_DIR}/holder.zip" --tags "cdkd-integ-marker=${C_MARKER}" \
  --region "${REGION}" >/dev/null
aws lambda wait function-active-v2 --function-name "${FN_C}" --region "${REGION}"
C_ARN="$(aws lambda get-function-configuration --function-name "${FN_C}" --region "${REGION}" --query 'FunctionArn' --output text)"
# The premise the identity rests on: the re-created function reports ANOTHER
# identity (its ARN repeats, its LastModified does not).
C2_TOKEN="$(fn_token "${FN_C}")"
if [ -z "${C2_TOKEN}" ] || [ "${C2_TOKEN}" = "${C_TOKEN}" ]; then
  echo "[verify] FAIL: premise -- the re-created ${FN_C} reports identity '${C2_TOKEN}', the deleted one '${C_TOKEN}': an identity that does not change on re-create cannot tell the two apart (go-to-k/cdkd#4606's Lambda function identity is then unsound)" >&2
  exit 1
fi
echo "[verify] step 2b ok: ${FN_C} re-created outside the stack (${C_TOKEN} -> ${C2_TOKEN})"

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
assert_gone_eventually "the earlier attempt's function ${FN_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws lambda get-function --function-name "${FN_A}" --region "${REGION}"
assert_gone_eventually "the earlier attempt's function ${FN_D} (failed after a successful Put) still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws lambda get-function --function-name "${FN_D}" --region "${REGION}"
# The re-used name is someone else's now: kept, untouched.
C_TAG="$(aws lambda list-tags --resource "${C_ARN}" --region "${REGION}" \
  --query 'Tags."cdkd-integ-marker"' --output text 2>&1)" || C_TAG="<list-tags failed: ${C_TAG}>"
C3_TOKEN="$(fn_token "${FN_C}")" || C3_TOKEN="<read failed>"
if [ "${C_TAG}" != "${C_MARKER}" ] || [ "${C3_TOKEN}" != "${C2_TOKEN}" ]; then
  echo "[verify] FAIL: the re-created ${FN_C} was not left untouched by the fix-forward (marker tag '${C_TAG}', expected '${C_MARKER}'; identity '${C3_TOKEN}', expected ${C2_TOKEN})" >&2
  exit 1
fi
# The kept entry was warned about, so the journal goes with it.
assert_gone "the fix-forward kept the rollback journal (expected it removed: OrphanA and OrphanD deleted, OrphanC warned about)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
for f in "${FN_A_B}" "${FN_C_B}" "${FN_D_B}" "${BASE_FN}"; do
  if gone_probe aws lambda get-function --function-name "${f}" --region "${REGION}"; then
    echo "[verify] FAIL: the record's function ${f} is missing after the fix-forward (the settle must not delete the records' functions)" >&2
    exit 1
  fi
done
if [ "$(fn_token "${BASE_FN}")" != "${BASE_TOKEN}" ]; then
  echo "[verify] FAIL: ${BASE_FN}'s identity changed during the run (expected the baseline's ${BASE_TOKEN})" >&2
  exit 1
fi
STATE_3="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
assert_record() { # usage: assert_record <logicalId> <function>
  local pid by
  pid="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  by="$(printf '%s' "${STATE_3}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || { echo "[verify] FAIL: could not read $1 from the state record after step 3" >&2; exit 1; }
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}
assert_record OrphanA "${FN_A_B}"
assert_record OrphanC "${FN_C_B}"
assert_record OrphanD "${FN_D_B}"
assert_record BaseFn "${BASE_FN}"
# The assertions above decide the step on AWS's own answers. The log lines
# below only confirm the deploy's account of it, so a reworded line fails
# here, never silently above.
FF_FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/fix-forward.log" | tr '\n' ' ' | tr -s ' ')"
# The settle's keep warnings (journaled-orphans.ts, `applySuccessRule`) open
# with the logical id and type: none may name OrphanA.
for lid in OrphanA OrphanD; do
  if ! printf '%s' "${FF_FLAT}" | grep -qF "deleting partially-created ${lid}"; then
    echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's ${lid} (output above)" >&2
    exit 1
  fi
  if printf '%s' "${FF_FLAT}" | grep -qF "${lid} (AWS::Lambda::Function), which a failed deploy"; then
    echo "[verify] FAIL: the fix-forward deploy still warned about the earlier ${lid} instead of deleting it (output above)" >&2
    exit 1
  fi
done
# Sentinel for the wording above: OrphanC's keep warning uses the same head,
# so a reword that would blind the OrphanA / OrphanD check fails here first.
if ! printf '%s' "${FF_FLAT}" | grep -qF 'OrphanC (AWS::Lambda::Function), which a failed deploy'; then
  echo "[verify] FAIL: the settle's keep-warning head changed (no 'OrphanC (AWS::Lambda::Function), which a failed deploy' in the output): update the OrphanA / OrphanD check above" >&2
  exit 1
fi
if printf '%s' "${FF_FLAT}" | grep -qF 'deleting partially-created OrphanC'; then
  echo "[verify] FAIL: the fix-forward deploy tried to delete OrphanC's re-used name (output above)" >&2
  exit 1
fi
if ! printf '%s' "${FF_FLAT}" | grep -qF 'is not deleted: the resource now under its physical id is another one'; then
  echo "[verify] FAIL: the fix-forward deploy did not warn that OrphanC's name now holds another function (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${FN_A} and ${FN_D}, kept the re-created ${FN_C} untouched, and the records hold the -b functions (rc=${FF_RC})"

echo "[verify] step 4: delete the re-created ${FN_C} (this run's, no record's), then destroy"
aws lambda delete-function --function-name "${FN_C}" --region "${REGION}" >/dev/null
assert_gone_eventually "step 4: ${FN_C} survived its delete" \
  aws lambda get-function --function-name "${FN_C}" --region "${REGION}"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
for f in "${ALL_FNS[@]}"; do
  assert_gone_eventually "function ${f} still exists after destroy" \
    aws lambda get-function --function-name "${f}" --region "${REGION}"
done
assert_gone "execution role ${EXEC_ROLE} still exists after destroy" \
  aws iam get-role --role-name "${EXEC_ROLE}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "lambda-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's Lambda function and kept one whose name was re-used (go-to-k/cdkd#4606)"
