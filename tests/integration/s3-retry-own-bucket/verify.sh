#!/usr/bin/env bash
#
# go-to-k/cdkd#4758: a retried S3 bucket CREATE with an explicit BucketName
# takes the bucket its own first attempt made, instead of refusing it as an
# explicit name already held (go-to-k/cdkd#4684).
#
# Phases:
#   1. A role that may create the fixture's bucket and read it, but may
#      neither tag nor delete it (explicit denies, probed until bound).
#   2. `cdkd deploy --no-rollback` as that role, in the background. The
#      CREATE makes the bucket, enables its versioning (a configuration
#      write, which outside us-east-1 moves the bucket's CreationDate before
#      the identity is recorded), fails on its tagging call (an AccessDenied the
#      deploy engine retries as IAM propagation), and its cleanup DeleteBucket
#      is denied, so the bucket stays. Once the bucket exists, the role's
#      policy is rewritten to allow tagging (DeleteBucket stays denied). Each
#      retry meets its own bucket (`BucketAlreadyOwnedByYou`); the provider
#      proves it is the bucket the failed attempt left (name, region and
#      ListBuckets CreationDate) and takes it, and once the tagging allow
#      propagates the deploy exits 0. Asserted: exit 0, the first attempt's
#      cleanup failed (the premise), no "Refusing to adopt", the state record
#      holds the bucket, the bucket carries the fixture tag.
#      Before #4758 the first retry refused the bucket and the deploy failed.
#      A deploy that gives up on IAM propagation WITHOUT that refusal is
#      reported INCONCLUSIVE (the allow did not propagate within the retry
#      budget), not as the regression.
#   3. Destroy as the caller; the bucket, the state file and the role are
#      gone, and the state prefix's object versions are swept.
#
# Region: us-west-2 by default, where a configuration write moves the
# bucket's CreationDate, so the identity the failed attempt records must be
# read after its last write.
#
# Cost: two empty buckets (the fixture's and a probe bucket) and one IAM
# role. On any failure, cleanup destroys the stack, deletes both buckets by
# name and deletes the role.
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
# S3 propagates a DeleteBucket to HeadBucket asynchronously: retry the
# gone-probe on a bounded schedule. A bucket that never disappears still FAILs.
assert_gone_eventually() { # usage: assert_gone_eventually "<desc>" aws s3api head-bucket ...
  local desc="$1"; shift
  for _ in $(seq 1 10); do
    if gone_probe "$@"; then
      return 0
    fi
    sleep 3
  done
  echo "FAIL: ${desc} (still present after 10 probes over ~30s)" >&2
  exit 1
}

REGION="${AWS_REGION:-us-west-2}"
export AWS_REGION="${REGION}"
STACK="CdkdS3RetryOwnBucket"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/s3-retry-own-bucket"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096). Sourced before the `cd`
# below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# The name the stack derives (lib/s3-retry-own-bucket-stack.ts).
BUCKET="cdkd-s3rob-${ACCOUNT_ID}"
# A bucket this script makes under the deny's name pattern, so the deny can be
# probed on a bucket that EXISTS (S3 answers NoSuchBucket before any policy).
PROBE_BUCKET="cdkd-s3rob-probe-${ACCOUNT_ID}"
PROBE_CREATED=""

ROLE="${STACK}-tag-lift"
POLICY_NAME="create-then-tag"
ROLE_CREATED=""
DEPLOY_PID=""
# Set once the preconditions below pass: before that, the bucket or the stack
# may belong to a concurrent or earlier run, which a failure-path delete must
# not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

CREATE_CFG=()
if [ "${REGION}" != "us-east-1" ]; then
  CREATE_CFG=(--create-bucket-configuration "LocationConstraint=${REGION}")
fi

delete_bucket_by_name() { ( # usage: delete_bucket_by_name <bucket>  (best-effort)
  set +eu
  aws s3api delete-bucket --bucket "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_role() { ( # usage: delete_role
  set +eu
  aws iam delete-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${ROLE}" >/dev/null 2>&1
  true
); }

cleanup() {
  rc=$?
  set +eu
  if [ -n "${DEPLOY_PID}" ]; then
    kill "${DEPLOY_PID}" >/dev/null 2>&1
    wait "${DEPLOY_PID}" >/dev/null 2>&1
  fi
  # A deploy cut short by a signal has not been printed yet.
  if [ -f "${LOG_DIR}/deploy.log" ] && [ -z "${DEPLOY_LOG_SHOWN:-}" ]; then
    sed 's/^/  /' "${LOG_DIR}/deploy.log"
  fi
  rm -rf "${LOG_DIR}"
  if [ -n "${ROLE_CREATED}" ]; then
    delete_role
    for _ in $(seq 1 12); do
      if ( gone_probe aws iam get-role --role-name "${ROLE}" ); then break; fi
      sleep 5
    done
    if ! ( gone_probe aws iam get-role --role-name "${ROLE}" ); then
      echo "[verify] WARN: role ${ROLE} could not be confirmed deleted; delete it by hand" >&2
    fi
  fi
  if [ -n "${PROBE_CREATED}" ]; then
    delete_bucket_by_name "${PROBE_BUCKET}"
  fi
  if [ "${rc}" -ne 0 ] && [ -n "${CLEANUP_ARMED}" ]; then
    echo "[verify] FAIL (exit ${rc}) -- attempting cleanup"
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force)
    # The bucket no state record holds when the deploy failed.
    delete_bucket_by_name "${BUCKET}"
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

if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for b in "${BUCKET}" "${PROBE_BUCKET}"; do
  assert_gone "precondition: bucket ${b} already exists (left by an earlier run); delete it first" \
    aws s3api head-bucket --bucket "${b}" --region "${REGION}"
done
assert_gone "precondition: role ${ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: a role that may create the bucket but neither tag nor delete it"
aws s3api create-bucket --bucket "${PROBE_BUCKET}" --region "${REGION}" ${CREATE_CFG[@]+"${CREATE_CFG[@]}"} >/dev/null
PROBE_CREATED=1
TRUST="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")"
# Scoped to what this deploy calls, never `*`. The S3 verbs on the state
# bucket are the state path's. On this run's buckets the role may create and
# read (HeadBucket is ListBucket; the identity read is GetBucketLocation plus
# ListAllMyBuckets). `tagging` is "Deny" first and "Allow" after the lift;
# DeleteBucket stays denied throughout, so the provider's own cleanup cannot
# remove the bucket its failed attempt made.
role_policy() { # usage: role_policy <Deny|Allow>   (the PutBucketTagging effect)
  node -e 'const [bucket,stack,acct,tagging]=process.argv.slice(1);const ours=`arn:aws:s3:::cdkd-s3rob-*${acct}`;const st=[{Effect:"Allow",Action:["s3:ListBucket","s3:ListBucketVersions","s3:GetBucketLocation","s3:GetReplicationConfiguration"],Resource:`arn:aws:s3:::${bucket}`},{Effect:"Allow",Action:["s3:GetObject","s3:PutObject","s3:DeleteObject","s3:DeleteObjectVersion"],Resource:`arn:aws:s3:::${bucket}/cdkd/${stack}/*`},{Effect:"Allow",Action:["s3:CreateBucket","s3:PutBucketVersioning","s3:ListBucket","s3:GetBucketLocation","s3:GetBucketTagging"],Resource:ours},{Effect:"Allow",Action:["s3:ListAllMyBuckets","cloudformation:Describe*","cloudformation:List*","sts:GetCallerIdentity"],Resource:"*"},{Effect:"Allow",Action:["ssm:GetParameter","ssm:GetParameters"],Resource:`arn:aws:ssm:*:${acct}:parameter/cdk-bootstrap/*`},{Effect:"Deny",Action:["s3:DeleteBucket"],Resource:ours},{Effect:tagging,Action:["s3:PutBucketTagging"],Resource:ours}];process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:st}))' "${STATE_BUCKET}" "${STACK}" "${ACCOUNT_ID}" "$1"
}
aws iam create-role --role-name "${ROLE}" --assume-role-policy-document "${TRUST}" \
  --tags Key=cdkd-integ,Value=s3-retry-own-bucket >/dev/null
ROLE_CREATED=1
aws iam put-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" \
  --policy-document "$(role_policy Deny)"
ROLE_CREDS=""
for _ in $(seq 1 24); do
  if ROLE_CREDS="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${ROLE}" \
    --role-session-name cdkd-s3-retry-own-bucket --duration-seconds 3600 \
    --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
    break
  fi
  ROLE_CREDS=""
  sleep 5
done
if [ -z "${ROLE_CREDS}" ]; then
  echo "[verify] FAIL: precondition -- could not assume ${ROLE} within 2 minutes" >&2
  exit 1
fi
# Process substitution, not a here-string: bash 3.2 backs a here-string with a
# temp file, and these are live credentials.
read -r ROLE_AK ROLE_SK ROLE_ST < <(printf '%s\n' "${ROLE_CREDS}")
unset ROLE_CREDS
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell, so the keys never sit in a process's argv.
as_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${ROLE_AK}" AWS_SECRET_ACCESS_KEY="${ROLE_SK}" AWS_SESSION_TOKEN="${ROLE_ST}"
    exec "$@"
  )
}
ROLE_ARN=""
for _ in $(seq 1 24); do
  if ROLE_ARN="$(as_role aws sts get-caller-identity --query Arn --output text 2>/dev/null)"; then
    break
  fi
  ROLE_ARN=""
  sleep 5
done
case "${ROLE_ARN}" in
  *":assumed-role/${ROLE}/"*) ;;
  *)
    echo "[verify] FAIL: precondition -- the role's commands run as '${ROLE_ARN:-<none>}', not ${ROLE}" >&2
    exit 1
    ;;
esac
# Both explicit denies must already bind, or the deploy below fails before any
# CREATE for the wrong reason (an implicit deny on everything) or tags the
# bucket on its first attempt. Probed on PROBE_BUCKET, which exists.
probe_explicit_deny() { # usage: probe_explicit_deny <aws s3api args...>
  local out=""
  for _ in $(seq 1 24); do
    if out="$(as_role aws s3api "$@" --bucket "${PROBE_BUCKET}" --region "${REGION}" 2>&1)"; then
      echo "[verify] FAIL: precondition -- ${ROLE} was ALLOWED: $* (its policy must deny it)" >&2
      return 1
    elif printf '%s' "${out}" | grep -qi 'explicit deny'; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] FAIL: precondition -- ${ROLE}'s explicit deny on '$1' never bound within 2 minutes (last answer: ${out})" >&2
  return 1
}
probe_explicit_deny delete-bucket
probe_explicit_deny put-bucket-tagging --tagging 'TagSet=[{Key=probe,Value=1}]'

echo "[verify] step 2: deploy as ${ROLE}; tagging is allowed once the bucket exists"
set +e
# --verbose: the provider's debug lines say why a retry did or did not take
# the bucket back (no record, or another CreationDate).
# Inline rather than through `as_role`: `exec` in the backgrounded subshell
# makes `$!` the deploy itself, so cleanup's `kill` stops it.
(
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export AWS_ACCESS_KEY_ID="${ROLE_AK}" AWS_SECRET_ACCESS_KEY="${ROLE_SK}" AWS_SESSION_TOKEN="${ROLE_ST}"
  exec ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback --verbose
) > "${LOG_DIR}/deploy.log" 2>&1 &
DEPLOY_PID=$!
set -e
# The first attempt makes the bucket at once, then fails on tagging; lift the
# deny only after that, so the first attempt cannot succeed.
SEEN=""
for _ in $(seq 1 120); do
  if ! kill -0 "${DEPLOY_PID}" 2>/dev/null; then break; fi
  if aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1; then
    SEEN=1
    break
  fi
  sleep 1
done
if [ -n "${SEEN}" ]; then
  aws iam put-role-policy --role-name "${ROLE}" --policy-name "${POLICY_NAME}" \
    --policy-document "$(role_policy Allow)"
  echo "  (bucket ${BUCKET} exists; tagging allowed)"
fi
set +e
wait "${DEPLOY_PID}"
DEPLOY_RC=$?
set -e
DEPLOY_PID=""
sed 's/^/  /' "${LOG_DIR}/deploy.log" || true
DEPLOY_LOG_SHOWN=1
# The role is not needed again. Still flagged until confirmed gone, so a
# failure here leaves cleanup to retry the delete.
delete_role
for _ in $(seq 1 12); do
  if gone_probe aws iam get-role --role-name "${ROLE}"; then break; fi
  sleep 5
done
assert_gone "role ${ROLE} still exists a minute after its delete" aws iam get-role --role-name "${ROLE}"
ROLE_CREATED=""
aws s3api delete-bucket --bucket "${PROBE_BUCKET}" --region "${REGION}"
PROBE_CREATED=""

if [ -z "${SEEN}" ]; then
  echo "[verify] FAIL: precondition -- bucket ${BUCKET} never appeared while the deploy ran (exit ${DEPLOY_RC}; output above)" >&2
  exit 1
fi
FLAT="$(sed 's/\x1b\[[0-9;]*m//g' "${LOG_DIR}/deploy.log" | tr '\n' ' ' | tr -s ' ')"
# The regression (go-to-k/cdkd#4758): the retry refused the bucket its own
# first attempt made. Sentinel: the refusal's second clause, independent of
# the parsed needle, without the needle means its wording drifted.
if printf '%s' "${FLAT}" | grep -qF "Refusing to adopt S3 bucket ${BUCKET}"; then
  echo "[verify] FAIL: the retry refused the bucket its own first attempt made (go-to-k/cdkd#4758 -- output above)" >&2
  exit 1
fi
if printf '%s' "${FLAT}" | grep -qF 'its BucketName is set explicitly'; then
  echo "[verify] FAIL: the explicit-name refusal fired but its wording no longer matches 'Refusing to adopt S3 bucket <name>' -- update this fixture (output above)" >&2
  exit 1
fi
if [ "${DEPLOY_RC}" -ne 0 ]; then
  # Only the deny this fixture lifts: any other AccessDenied also reads as
  # IAM propagation, and is a gap in the role's policy, so it FAILs.
  if printf '%s' "${FLAT}" | grep -qF 'IAM-propagation retr' &&
    printf '%s' "${FLAT}" | grep -qF 's3:PutBucketTagging'; then
    echo "[verify] INCONCLUSIVE: tagging allow did not propagate within the retry budget (exit ${DEPLOY_RC}, no refusal -- output above)" >&2
    exit 1
  fi
  echo "[verify] FAIL: the deploy exited ${DEPLOY_RC} for another reason (output above)" >&2
  exit 1
fi
# The premise: the first attempt made the bucket and could not delete it, so
# a retry met it.
if ! printf '%s' "${FLAT}" | grep -qF "Failed to clean up partially-created S3 bucket Bucket (${BUCKET})"; then
  echo "[verify] FAIL: premise -- the first attempt's cleanup did not fail, so no retry met its bucket (output above)" >&2
  exit 1
fi
RECORDED="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r '.resources.Bucket.physicalId // empty')"
if [ "${RECORDED}" != "${BUCKET}" ]; then
  echo "[verify] FAIL: the state record holds '${RECORDED}' for Bucket (expected ${BUCKET})" >&2
  exit 1
fi
TAG="$(aws s3api get-bucket-tagging --bucket "${BUCKET}" --region "${REGION}" \
  --query "TagSet[?Key=='cdkd:integ-fixture'].Value | [0]" --output text)"
if [ "${TAG}" != "s3-retry-own-bucket" ]; then
  echo "[verify] FAIL: ${BUCKET} carries fixture tag '${TAG}' (expected s3-retry-own-bucket: the retry must finish configuring it)" >&2
  exit 1
fi
echo "[verify] step 2 ok: the retry took its own bucket and the deploy finished"

echo "[verify] step 3: destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone_eventually "bucket ${BUCKET} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone_eventually "probe bucket ${PROBE_BUCKET} still exists" \
  aws s3api head-bucket --bucket "${PROBE_BUCKET}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${ROLE} still exists after the run" \
  aws iam get-role --role-name "${ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "s3-retry-own-bucket state teardown"

echo "[verify] PASS -- the retried explicit-name create took the bucket its own first attempt made (go-to-k/cdkd#4758)"
