#!/usr/bin/env bash
#
# go-to-k/cdkd#4606, the ElastiCache arm: a fix-forward deploy deletes the
# cache cluster an earlier failed CREATE left in AWS when the journal carries
# its identity token (`<ARN>@<CacheClusterCreateTime ms>`, go-to-k/cdkd#4655),
# and keeps it, warning and exiting 2, when it does not. A cache cluster has no
# immutable AWS-generated id, so the creation time is what proves the cluster
# under the id is still the one the failed CREATE made.
#
# Phases:
#   1. Baseline deploy: an isolated three-AZ VPC and a cache subnet group.
#   2. The deletion arm's failed CREATE. A role is created that may create a
#      cache cluster and describe it, but never delete one. A `--no-rollback`
#      deploy run as that role in the background (ORPHAN_ARM=inject) creates
#      `<stack>-orphan` and polls it towards `available`. Meanwhile this script,
#      with its own credentials, polls the cluster until it answers with its
#      CacheClusterCreateTime while still not `available`, then adds an
#      explicit Deny on DescribeCacheClusters to the role. The provider's next
#      poll fails after it has seen the token (the available-wait keeps the
#      first token a poll names), so the failure's mark carries it. Asserted:
#      the deploy failed, no state record holds the cluster, and the journal
#      carries it as a proven orphan whose `createdResourceIdentity` equals the
#      live `<ARN>@<CacheClusterCreateTime ms>`.
#   3. The deletion arm's fix-forward: ORPHAN_ARM=fixed keeps the logical id
#      under `<stack>-orphan-b`. Asserted: the deploy exits 0, deletes the
#      earlier cluster, never warns about it, drops the journal, and the state
#      record holds the new, live cluster. Before #4606 it exited 2 and left it.
#   4. The fail-safe arm's failed CREATE: the role is denied DescribeCacheClusters
#      from the start, so neither the provider's polls nor the deploy engine's
#      write-side identity read can name the creation time. KEPT_ARM=inject
#      creates `<stack>-kept`, and the CREATE fails. Asserted: the journal
#      carries it as a proven orphan WITHOUT a `createdResourceIdentity`.
#   5. The fail-safe arm's fix-forward: KEPT_ARM=fixed (`<stack>-kept-b`).
#      Asserted: the deploy exits 2, warns that nothing proves the cluster is
#      the one the failed deploy created, and `<stack>-kept` is still in AWS.
#      This script then deletes it.
#   6. Destroy, and everything (both generations of both arms, the subnet
#      group, the VPC, the state file) is gone; the run's state prefix's object
#      versions are swept.
#
# The run lives under its OWN state prefix (unique per run): the success
# settle reads every record under the prefix before it deletes an orphan, and
# fails closed on one it cannot read, so another stack's record must not be
# able to decide this run.
#
# Cost: four Memcached cache.t4g.micro single-node clusters, each up for
# minutes. A run takes roughly 40 minutes (four creates and four deletes). On
# any failure, cleanup kills the background deploy, deletes all four clusters
# by id, destroys the stack and deletes the role.
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
STACK="CdkdElastiCacheFixForwardOrphan"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/elasticache-fix-forward-orphan"
CLI="node ${REPO_ROOT}/dist/cli.js"

# Shared S3 VERSION-sweep helpers (issue #2096). The fixture holds no secret;
# the sweep keeps the run's own prefix from outliving it. Sourced by absolute
# path, before the `cd` below, so the first `cleanup` already has it.
. "${REPO_ROOT}/tests/integration/s3-versions.sh"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
CALLER_USERID="$(aws sts get-caller-identity --query UserId --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_PREFIX="${STATE_PREFIX:-cdkd-ecffo-$(date +%s)-$$}"
STATE_KEY="${STATE_PREFIX}/${STACK}/${REGION}/state.json"
JOURNAL_KEY="${STATE_PREFIX}/${STACK}/${REGION}/rollback-journal.json"

# The cluster ids the stack derives from its lower-cased name.
ID_PREFIX="$(printf '%s' "${STACK}" | tr '[:upper:]' '[:lower:]')"
ORPHAN_A="${ID_PREFIX}-orphan"
ORPHAN_B="${ID_PREFIX}-orphan-b"
KEPT_A="${ID_PREFIX}-kept"
KEPT_B="${ID_PREFIX}-kept-b"

DENY_ROLE="${STACK}-no-delete"
DENY_POLICY_NAME="create-without-delete"
DENY_ROLE_CREATED=""
DEPLOY_PID=""
# Set once the preconditions below pass: before that, the four ids or the
# stack may belong to a concurrent or earlier run, which a failure-path delete
# must not tear down.
CLEANUP_ARMED=""
LOG_DIR="$(mktemp -d)"

TIMEOUT_OVERRIDES=(
  --resource-timeout AWS::ElastiCache::CacheCluster=30m
)

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET} state-prefix=${STATE_PREFIX}"

# Best-effort deletes by id, for cleanup only. A cluster still `creating`
# refuses its delete, so each waits for `available` first.
delete_cluster_by_id() { ( # usage: delete_cluster_by_id <cluster id>
  set +eu
  aws elasticache wait cache-cluster-available --cache-cluster-id "$1" --region "${REGION}" >/dev/null 2>&1
  aws elasticache delete-cache-cluster --cache-cluster-id "$1" --region "${REGION}" >/dev/null 2>&1
  aws elasticache wait cache-cluster-deleted --cache-cluster-id "$1" --region "${REGION}" >/dev/null 2>&1
  true
); }
delete_deny_role() { ( # usage: delete_deny_role
  set +eu
  aws iam delete-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DENY_ROLE}" >/dev/null 2>&1
  true
); }
stop_background_deploy() { ( # usage: stop_background_deploy
  set +eu
  if [ -n "${DEPLOY_PID}" ] && kill -0 "${DEPLOY_PID}" 2>/dev/null; then
    kill "${DEPLOY_PID}" 2>/dev/null
    for _ in $(seq 1 30); do
      kill -0 "${DEPLOY_PID}" 2>/dev/null || break
      sleep 1
    done
    kill -9 "${DEPLOY_PID}" 2>/dev/null
  fi
  true
); }

cleanup() {
  rc=$?
  set +eu
  stop_background_deploy
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
    for id in "${ORPHAN_A}" "${ORPHAN_B}" "${KEPT_A}" "${KEPT_B}"; do
      delete_cluster_by_id "${id}"
      if ! ( gone_probe aws elasticache describe-cache-clusters --cache-cluster-id "${id}" --region "${REGION}" ); then
        echo "[verify] WARN: cache cluster ${id} could not be confirmed deleted; delete it by hand" >&2
      fi
    done
    # From the fixture directory: a failure before the script's own `cd`
    # would otherwise synthesize whatever app the caller's cwd holds. A
    # killed deploy may have left its lock.
    (cd "${TEST_DIR}" && ${CLI} force-unlock "${STACK}" --state-bucket "${STATE_BUCKET:-}" --state-prefix "${STATE_PREFIX}" --yes)
    (cd "${TEST_DIR}" && ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force "${TIMEOUT_OVERRIDES[@]}")
  elif [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) before the preconditions passed -- nothing of this run to clean up"
  fi
  # NONCURRENT only, per ../s3-versions.sh: on a failure a live state.json may
  # be the only record of what is still standing. The success path sweeps all.
  if [ -n "${CLEANUP_ARMED}" ]; then
    s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX}/" noncurrent
  fi
  exit "${rc}"
}
trap cleanup EXIT
# Drop the EXIT trap first: the signal handler's own `exit` would otherwise
# run the (slow) cleanup a second time.
trap 'trap - EXIT; (exit 130); cleanup; exit 130' INT
trap 'trap - EXIT; (exit 143); cleanup; exit 143' TERM

echo "[verify] step 0: install + build cdkd, install fixture deps"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  npm install
fi

# The live cluster's identity token, read with this script's credentials
# through the SDK cdkd itself uses (CacheClusterCreateTime as a Date, so the
# epoch ms match the provider's). Prints `<status> <ARN>@<ms>`, or
# `<status> -` when the answer names no creation time yet.
live_cluster() { # usage: live_cluster <cluster id>
  (cd "${REPO_ROOT}" && node --input-type=module -e '
import { ElastiCacheClient, DescribeCacheClustersCommand } from "@aws-sdk/client-elasticache";
const id = process.argv[1];
const r = await new ElastiCacheClient({ region: process.env.AWS_REGION }).send(
  new DescribeCacheClustersCommand({ CacheClusterId: id })
);
const c = r.CacheClusters?.[0];
if (!c || c.CacheClusterId !== id || !c.ARN) throw new Error(`no cluster ${id} in the answer`);
const t = c.CacheClusterCreateTime;
const token = t instanceof Date && !Number.isNaN(t.getTime()) ? `${c.ARN}@${t.getTime()}` : "-";
process.stdout.write(`${c.CacheClusterStatus} ${token}\n`);
' "$1") || return 1
}

# A record or resource left by an earlier, interrupted run would be blamed on
# the steps below.
if HEAD_PRE="$(aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" 2>&1)"; then
  echo "[verify] FAIL: a state record for ${STACK} already exists at ${STATE_KEY} (left by an earlier run); destroy it first" >&2
  exit 1
elif ! printf '%s' "${HEAD_PRE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
  echo "[verify] FAIL: pre-probe of the state record undetermined: ${HEAD_PRE}" >&2
  exit 1
fi
for id in "${ORPHAN_A}" "${ORPHAN_B}" "${KEPT_A}" "${KEPT_B}"; do
  assert_gone "precondition: cache cluster ${id} already exists (left by an earlier run); delete it first" \
    aws elasticache describe-cache-clusters --cache-cluster-id "${id}" --region "${REGION}"
done
assert_gone "precondition: role ${DENY_ROLE} already exists (left by an earlier run); delete it first" \
  aws iam get-role --role-name "${DENY_ROLE}"
CLEANUP_ARMED=1

echo "[verify] step 1: baseline deploy (VPC + cache subnet group)"
env -u ORPHAN_ARM -u KEPT_ARM ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --state-prefix "${STATE_PREFIX}" "${TIMEOUT_OVERRIDES[@]}"

# The role's policy, scoped to what these deploys call. The S3
# verbs are the state path's (src/state/{s3-state-backend,lock-manager,
# s3-noncurrent-version-purge,s3-replication-purge-gap}.ts,
# src/utils/aws-region-resolver.ts): HeadBucket and ListObjectsV2
# (ListBucket), ListObjectVersions, GetBucketLocation and GetBucketReplication
# on the bucket; Get/Head/Put/DeleteObject and a versioned DeleteObjects on
# this run's prefix only. The exports index is written on a successful deploy
# only, which these are not. The read-only EC2 / CloudFormation / SSM / KMS
# grants are `*`, as in rds-fix-forward-orphan; the trust policy admits only
# this script's caller. CreateCacheCluster sends the tags, so it needs
# AddTagsToResource; the ElastiCache service-linked role is created on a
# first cluster in an account. DeleteCacheCluster is always denied (cdkd's
# ElastiCache create has no self-cleanup; the deny keeps it that way);
# `$3 = deny-describe` also denies DescribeCacheClusters (every available-wait
# poll and the identity read).
deny_policy() { # usage: deny_policy <bucket> <prefix> allow-describe|deny-describe
  node -e '
const [bucket, prefix, mode] = process.argv.slice(1);
const denied = ["elasticache:DeleteCacheCluster"];
if (mode === "deny-describe") denied.push("elasticache:DescribeCacheClusters");
else if (mode !== "allow-describe") throw new Error(`unknown mode ${mode}`);
process.stdout.write(JSON.stringify({
  Version: "2012-10-17",
  Statement: [
    { Effect: "Allow", Action: ["s3:ListBucket", "s3:ListBucketVersions", "s3:GetBucketLocation", "s3:GetReplicationConfiguration"], Resource: `arn:aws:s3:::${bucket}` },
    { Effect: "Allow", Action: ["s3:GetObject", "s3:PutObject", "s3:DeleteObject", "s3:DeleteObjectVersion"], Resource: `arn:aws:s3:::${bucket}/${prefix}/*` },
    { Effect: "Allow", Action: ["elasticache:CreateCacheCluster", "elasticache:AddTagsToResource", "elasticache:ListTagsForResource", "elasticache:Describe*", "ec2:Describe*", "cloudformation:Describe*", "cloudformation:List*", "ssm:GetParameter", "ssm:GetParameters", "kms:Decrypt", "kms:GenerateDataKey", "sts:GetCallerIdentity"], Resource: "*" },
    { Effect: "Allow", Action: "iam:CreateServiceLinkedRole", Resource: "*", Condition: { StringEquals: { "iam:AWSServiceName": "elasticache.amazonaws.com" } } },
    { Effect: "Deny", Action: denied, Resource: "*" },
  ],
}));
' "$1" "$2" "$3"
}
put_deny_policy() { # usage: put_deny_policy allow-describe|deny-describe
  local doc
  doc="$(deny_policy "${STATE_BUCKET}" "${STATE_PREFIX}" "$1")" || return 1
  aws iam put-role-policy --role-name "${DENY_ROLE}" --policy-name "${DENY_POLICY_NAME}" \
    --policy-document "${doc}"
}

# Creates the role with `$1`'s policy and assumes it (DENY_AK/SK/ST).
make_deny_role() { # usage: make_deny_role allow-describe|deny-describe
  local trust creds="" arn="" id_err=""
  trust="$(node -e 'process.stdout.write(JSON.stringify({Version:"2012-10-17",Statement:[{Effect:"Allow",Principal:{AWS:`arn:aws:iam::${process.argv[1]}:root`},Action:"sts:AssumeRole",Condition:{StringEquals:{"aws:userid":process.argv[2]}}}]}))' "${ACCOUNT_ID}" "${CALLER_USERID}")" || return 1
  aws iam create-role --role-name "${DENY_ROLE}" --assume-role-policy-document "${trust}" \
    --tags Key=cdkd-integ,Value=elasticache-fix-forward-orphan >/dev/null
  DENY_ROLE_CREATED=1
  put_deny_policy "$1"
  # A new role is assumable only once IAM has propagated it.
  for _ in $(seq 1 24); do
    if creds="$(aws sts assume-role --role-arn "arn:aws:iam::${ACCOUNT_ID}:role/${DENY_ROLE}" \
      --role-session-name cdkd-elasticache-fix-forward \
      --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text 2>/dev/null)"; then
      break
    fi
    creds=""
    sleep 5
  done
  if [ -z "${creds}" ]; then
    echo "[verify] FAIL: precondition -- could not assume ${DENY_ROLE} within 2 minutes" >&2
    exit 1
  fi
  # Process substitution, not a here-string: bash 3.2 backs a here-string with
  # a temp file, and these are live credentials.
  read -r DENY_AK DENY_SK DENY_ST < <(printf '%s\n' "${creds}")
  # Credentials from a role created seconds ago can be refused for a while,
  # so poll until STS accepts them, naming the last refusal if it never does.
  for _ in $(seq 1 24); do
    if arn="$(as_deny_role aws sts get-caller-identity --query Arn --output text 2>"${LOG_DIR}/id-err")"; then
      break
    fi
    arn=""
    id_err="$(cat "${LOG_DIR}/id-err" 2>/dev/null || true)"
    sleep 5
  done
  if [ -z "${arn}" ]; then
    echo "[verify] FAIL: precondition -- STS never accepted ${DENY_ROLE}'s credentials within 2 minutes (last answer: ${id_err})" >&2
    exit 1
  fi
  case "${arn}" in
    *":assumed-role/${DENY_ROLE}/"*) ;;
    *)
      echo "[verify] FAIL: precondition -- the role's commands run as '${arn}', not ${DENY_ROLE}" >&2
      exit 1
      ;;
  esac
}
# Run a command as the role. A profile in the environment would win over the
# key variables in the SDK's credential chain, so it is dropped. Exported
# inside a subshell rather than passed as `env VAR=value` arguments, so the
# keys never sit in a process's argv.
as_deny_role() {
  (
    unset AWS_PROFILE AWS_DEFAULT_PROFILE
    export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
    exec "$@"
  )
}
# Waits until the role's EXPLICIT deny on DescribeCacheClusters binds: before
# a fresh inline policy propagates, the role is refused everything implicitly
# (the same AccessDenied), and after a policy change the old one may still
# answer for a while.
wait_describe_denied() { # usage: wait_describe_denied <cluster id>
  local probe=""
  for _ in $(seq 1 36); do
    if probe="$(as_deny_role aws elasticache describe-cache-clusters --cache-cluster-id "$1" --region "${REGION}" 2>&1)"; then
      probe=""
    elif printf '%s' "${probe}" | grep -qi 'explicit deny'; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] FAIL: ${DENY_ROLE}'s explicit deny on DescribeCacheClusters never bound within 3 minutes (last answer: ${probe:-<allowed>})" >&2
  exit 1
}
# Waits until the role's fresh inline policy grants DescribeCacheClusters:
# before it propagates, the role is refused everything, and the deploy would
# fail before its CREATE for the wrong reason.
wait_describe_allowed() { # usage: wait_describe_allowed
  local probe=""
  for _ in $(seq 1 24); do
    if probe="$(as_deny_role aws elasticache describe-cache-clusters --max-records 20 --region "${REGION}" 2>&1)"; then
      return 0
    fi
    sleep 5
  done
  echo "[verify] FAIL: precondition -- ${DENY_ROLE} was never granted DescribeCacheClusters within 2 minutes (last answer: ${probe})" >&2
  exit 1
}
drop_deny_role() { # usage: drop_deny_role
  delete_deny_role
  # IAM is eventually consistent: a get-role right after delete-role can
  # still answer, so poll before the one assertion.
  for _ in $(seq 1 12); do
    if gone_probe aws iam get-role --role-name "${DENY_ROLE}"; then break; fi
    sleep 5
  done
  assert_gone "role ${DENY_ROLE} still exists a minute after its delete" aws iam get-role --role-name "${DENY_ROLE}"
  DENY_ROLE_CREATED=""
}
# The journal's entry for `$1`, which must be a proven orphan under `$2`.
journaled_op() { # usage: journaled_op <logicalId> <cluster id>
  local journal op
  journal="$(aws s3 cp "s3://${STATE_BUCKET}/${JOURNAL_KEY}" -)" || return 1
  op="$(printf '%s' "${journal}" | jq -c --arg l "$1" '[.segments[-1].failedOperations[]? | select(.logicalId == $l)] | first // empty')" || return 1
  if [ -z "${op}" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalId // "<absent>"')" != "$2" ] \
    || [ "$(printf '%s' "${op}" | jq -r '.physicalIdRecoveredFromError // "<absent>"')" != "true" ]; then
    echo "[verify] FAIL: the journal does not carry $1's proven id $2 (op: ${op:-<none>})" >&2
    exit 1
  fi
  printf '%s\n' "${op}"
}
assert_no_record() { # usage: assert_no_record <logicalId> <step>
  local state
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  if [ "$(printf '%s' "${state}" | jq --arg l "$1" '.resources | has($l)')" != "false" ]; then
    echo "[verify] FAIL: state records $1 after $2 (expected no record for a CREATE that threw)" >&2
    exit 1
  fi
}
assert_record() { # usage: assert_record <logicalId> <cluster id>
  local state pid by
  state="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)" || return 1
  pid="$(printf '%s' "${state}" | jq -r --arg l "$1" '.resources[$l].physicalId // "<absent>"')" || return 1
  by="$(printf '%s' "${state}" | jq -r --arg l "$1" '.resources[$l].provisionedBy // "<absent>"')" || return 1
  if [ "${pid}" != "$2" ] || [ "${by}" != "sdk" ]; then
    echo "[verify] FAIL: state records $1 as ${pid} via ${by} (expected $2 via sdk, where isSameResource lives)" >&2
    exit 1
  fi
}

echo "[verify] step 2: a role that may create and describe cache clusters, but not delete one"
make_deny_role allow-describe
wait_describe_allowed

echo "[verify] step 2: --no-rollback deploy as ${DENY_ROLE} in the background (ORPHAN_ARM=inject)"
# An inline subshell that execs, not `as_deny_role ... &`: backgrounding the
# function forks twice, and `$!` would then name a wrapper whose kill leaves
# the deploy running. Here the exec chain (subshell -> env -> node) keeps one
# pid, so cleanup's kill reaches the deploy itself.
(
  unset AWS_PROFILE AWS_DEFAULT_PROFILE
  export AWS_ACCESS_KEY_ID="${DENY_AK}" AWS_SECRET_ACCESS_KEY="${DENY_SK}" AWS_SESSION_TOKEN="${DENY_ST}"
  exec env -u KEPT_ARM ORPHAN_ARM=inject ${CLI} deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --no-rollback \
    "${TIMEOUT_OVERRIDES[@]}"
) > "${LOG_DIR}/inject.log" 2>&1 &
DEPLOY_PID=$!

# Wait, with this script's credentials, for the cluster to answer with its
# creation time while it is still being created. This discovery is part of the
# arm: the provider can carry the token only from such an answer.
SEEN=""
for _ in $(seq 1 120); do
  if ! kill -0 "${DEPLOY_PID}" 2>/dev/null; then
    sed 's/^/  /' "${LOG_DIR}/inject.log" || true
    echo "[verify] FAIL: the background deploy exited before the cluster answered with its creation time (output above)" >&2
    exit 1
  fi
  if LIVE="$(live_cluster "${ORPHAN_A}" 2>"${LOG_DIR}/live-err")"; then
    status="${LIVE%% *}"
    token="${LIVE#* }"
    if [ "${status}" = "available" ]; then
      echo "[verify] FAIL: ${ORPHAN_A} reached 'available' before any describe showed its CacheClusterCreateTime" >&2
      echo "         (AWS names the creation time only once a cluster is available: no deny can then land between a" >&2
      echo "         poll that saw the token and the provider's last poll, so this arm cannot run as designed)" >&2
      exit 1
    fi
    if [ "${token}" != "-" ]; then
      SEEN="${token}"
      echo "[verify] ${ORPHAN_A} answers '${status}' with its creation time: ${SEEN}"
      break
    fi
  elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' "${LOG_DIR}/live-err"; then
    echo "[verify] FAIL: describing ${ORPHAN_A} failed: $(cat "${LOG_DIR}/live-err")" >&2
    exit 1
  fi
  sleep 5
done
if [ -z "${SEEN}" ]; then
  echo "[verify] FAIL: ${ORPHAN_A} never answered with its creation time within 10 minutes" >&2
  exit 1
fi
# The provider polls every 10 seconds and keeps the first token a poll names:
# let at least one of its polls see the creation time before any deny lands.
sleep 15

echo "[verify] step 2: deny DescribeCacheClusters to ${DENY_ROLE} while ${ORPHAN_A} is still being created"
put_deny_policy deny-describe
wait_describe_denied "${ORPHAN_A}"
if ! kill -0 "${DEPLOY_PID}" 2>/dev/null; then
  # It may have failed or succeeded; either way it ended before the deny bound.
  wait "${DEPLOY_PID}" && RACE_RC=0 || RACE_RC=$?
  DEPLOY_PID=""
  sed 's/^/  /' "${LOG_DIR}/inject.log" || true
  echo "[verify] FAIL: the background deploy exited (${RACE_RC}) before the deny on DescribeCacheClusters bound -- the cluster went available first (output above)" >&2
  exit 1
fi
set +e
wait "${DEPLOY_PID}"
INJECT_RC=$?
set -e
DEPLOY_PID=""
sed 's/^/  /' "${LOG_DIR}/inject.log" || true
drop_deny_role
if [ "${INJECT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback deploy as ${DENY_ROLE} unexpectedly SUCCEEDED (the cluster went available before the deny bound)" >&2
  exit 1
fi
if ! LIVE="$(live_cluster "${ORPHAN_A}")"; then
  echo "[verify] FAIL: cache cluster ${ORPHAN_A} does not exist after step 2 (output above)" >&2
  exit 1
fi
LIVE_TOKEN="${LIVE#* }"
if [ "${LIVE_TOKEN}" != "${SEEN}" ]; then
  echo "[verify] FAIL: ${ORPHAN_A}'s live token reads '${LIVE_TOKEN}', not the '${SEEN}' it showed while being created" >&2
  exit 1
fi
assert_no_record OrphanCache "step 2"
OP_2="$(journaled_op OrphanCache "${ORPHAN_A}")"
JOURNALED_TOKEN="$(printf '%s' "${OP_2}" | jq -r '.createdResourceIdentity // "<absent>"')"
if [ "${JOURNALED_TOKEN}" != "${LIVE_TOKEN}" ]; then
  echo "[verify] FAIL: the journal carries OrphanCache's identity as '${JOURNALED_TOKEN}' (expected the live ${LIVE_TOKEN}; op: ${OP_2})" >&2
  echo "         ('<absent>': no available-wait poll carried the creation time onto the failure's mark)" >&2
  exit 1
fi
echo "[verify] step 2 ok: ${ORPHAN_A} is in AWS, journaled with its live identity ${LIVE_TOKEN}, with no state record"

# A user fixes forward minutes later, once it is up; a cluster still
# `creating` refuses its delete, which is not what this step measures.
aws elasticache wait cache-cluster-available --cache-cluster-id "${ORPHAN_A}" --region "${REGION}"

echo "[verify] step 3: the deletion arm's fix-forward (same logical id, another cluster id)"
set +e
env -u KEPT_ARM ORPHAN_ARM=fixed ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" "${TIMEOUT_OVERRIDES[@]}" \
  > "${LOG_DIR}/fix-forward.log" 2>&1
FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward.log" || true
if [ "${FF_RC}" -ne 0 ]; then
  echo "[verify] FAIL: the fix-forward deploy exited ${FF_RC} (expected 0: the earlier cluster is proven another one, with its identity unchanged, and deleted -- output above)" >&2
  echo "         (before go-to-k/cdkd#4606 it exited 2 and left it)" >&2
  exit 1
fi
assert_gone "the rollback journal is still present after the fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# The waiter only waits: the assertion below decides, with its own message.
aws elasticache wait cache-cluster-deleted --cache-cluster-id "${ORPHAN_A}" --region "${REGION}" || true
assert_gone "the earlier attempt's cache cluster ${ORPHAN_A} still exists after the fix-forward deploy (go-to-k/cdkd#4606)" \
  aws elasticache describe-cache-clusters --cache-cluster-id "${ORPHAN_A}" --region "${REGION}"
# The new cluster is the record's: deleting the earlier one must not touch it.
FF_STATUS="$(aws elasticache describe-cache-clusters --cache-cluster-id "${ORPHAN_B}" --region "${REGION}" \
  --query 'CacheClusters[0].CacheClusterStatus' --output text)"
if [ "${FF_STATUS}" != "available" ]; then
  echo "[verify] FAIL: the fix-forward cluster ${ORPHAN_B} is '${FF_STATUS}' (expected available -- the settle must not delete the record's cluster)" >&2
  exit 1
fi
assert_record OrphanCache "${ORPHAN_B}"
# The assertions above decide the step on AWS's own answers. The log lines
# below only confirm the deploy's account of it, so a reworded line fails
# here, never silently above.
if ! grep -q "deleting partially-created OrphanCache" "${LOG_DIR}/fix-forward.log"; then
  echo "[verify] FAIL: the fix-forward deploy did not delete the earlier attempt's OrphanCache (output above)" >&2
  exit 1
fi
if grep -q "Skipping failed CREATE of OrphanCache" "${LOG_DIR}/fix-forward.log" \
  || grep -q "OrphanCache.*is not deleted" "${LOG_DIR}/fix-forward.log"; then
  echo "[verify] FAIL: the fix-forward deploy still warned about the earlier OrphanCache instead of deleting it (output above)" >&2
  exit 1
fi
echo "[verify] step 3 ok: the fix-forward deleted ${ORPHAN_A}, kept ${ORPHAN_B}, exited 0 and dropped the journal"

echo "[verify] step 4: a role denied DescribeCacheClusters from the start (KEPT_ARM=inject)"
make_deny_role deny-describe
wait_describe_denied "${ORPHAN_B}"
set +e
as_deny_role env ORPHAN_ARM=fixed KEPT_ARM=inject ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --no-rollback \
  "${TIMEOUT_OVERRIDES[@]}" > "${LOG_DIR}/inject-kept.log" 2>&1
KEPT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/inject-kept.log" || true
drop_deny_role
if [ "${KEPT_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the --no-rollback deploy as ${DENY_ROLE} unexpectedly SUCCEEDED" >&2
  exit 1
fi
if ! live_cluster "${KEPT_A}" >/dev/null; then
  echo "[verify] FAIL: cache cluster ${KEPT_A} does not exist after step 4 -- its CREATE failed before CreateCacheCluster returned (output above)" >&2
  exit 1
fi
assert_no_record KeptCache "step 4"
OP_4="$(journaled_op KeptCache "${KEPT_A}")"
if [ "$(printf '%s' "${OP_4}" | jq -r 'has("createdResourceIdentity")')" != "false" ]; then
  echo "[verify] FAIL: the journal carries an identity for KeptCache although every describe was denied (op: ${OP_4})" >&2
  echo "         (CreateCacheCluster's own answer then named the creation time: this arm no longer reaches the fail-safe path)" >&2
  exit 1
fi
echo "[verify] step 4 ok: ${KEPT_A} is in AWS, journaled without an identity, with no state record"

aws elasticache wait cache-cluster-available --cache-cluster-id "${KEPT_A}" --region "${REGION}"

echo "[verify] step 5: the fail-safe arm's fix-forward (same logical id, another cluster id)"
set +e
env ORPHAN_ARM=fixed KEPT_ARM=fixed ${CLI} deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" "${TIMEOUT_OVERRIDES[@]}" \
  > "${LOG_DIR}/fix-forward-kept.log" 2>&1
KEPT_FF_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/fix-forward-kept.log" || true
if [ "${KEPT_FF_RC}" -ne 2 ]; then
  echo "[verify] FAIL: the fail-safe fix-forward exited ${KEPT_FF_RC} (expected 2: nothing proves ${KEPT_A} is the cluster the failed deploy made, so it is kept and reported -- output above)" >&2
  exit 1
fi
KEPT_STATUS="$(aws elasticache describe-cache-clusters --cache-cluster-id "${KEPT_A}" --region "${REGION}" \
  --query 'CacheClusters[0].CacheClusterStatus' --output text)"
if [ "${KEPT_STATUS}" != "available" ]; then
  echo "[verify] FAIL: ${KEPT_A} is '${KEPT_STATUS}' after the fail-safe fix-forward (expected available: a cluster with no journaled identity is never deleted)" >&2
  exit 1
fi
KEPT_FF_STATUS="$(aws elasticache describe-cache-clusters --cache-cluster-id "${KEPT_B}" --region "${REGION}" \
  --query 'CacheClusters[0].CacheClusterStatus' --output text)"
if [ "${KEPT_FF_STATUS}" != "available" ]; then
  echo "[verify] FAIL: the fail-safe fix-forward cluster ${KEPT_B} is '${KEPT_FF_STATUS}' (expected available)" >&2
  exit 1
fi
assert_record KeptCache "${KEPT_B}"
# The kept entry is reported and cleared with the journal, as `cdkd rollback`
# settles such a skip: the next deploy does not report it again.
assert_gone "the rollback journal is still present after the fail-safe fix-forward deploy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
# The deploy's account of it. The sentinel is the settle's "which a failed
# deploy ... is not deleted" frame on a KeptCache line: present without the
# parsed reason, the wording drifted, which must fail loudly rather than read
# as "no warning".
if ! grep -q "KeptCache.*is not deleted: nothing proves" "${LOG_DIR}/fix-forward-kept.log"; then
  if grep -q "KeptCache.*is not deleted" "${LOG_DIR}/fix-forward-kept.log"; then
    echo "[verify] FAIL: the fail-safe warning about KeptCache was reworded; update this fixture's grep (output above)" >&2
  else
    echo "[verify] FAIL: the fail-safe fix-forward did not warn that nothing proves KeptCache's cluster is the one it created (output above)" >&2
  fi
  exit 1
fi
if grep -q "deleting partially-created KeptCache" "${LOG_DIR}/fix-forward-kept.log"; then
  echo "[verify] FAIL: the fail-safe fix-forward tried to delete ${KEPT_A} (output above)" >&2
  exit 1
fi
echo "[verify] step 5 ok: the fail-safe fix-forward kept ${KEPT_A}, warned and exited 2; deleting it by hand"
aws elasticache delete-cache-cluster --cache-cluster-id "${KEPT_A}" --region "${REGION}" >/dev/null
aws elasticache wait cache-cluster-deleted --cache-cluster-id "${KEPT_A}" --region "${REGION}"
assert_gone "cache cluster ${KEPT_A} still exists after its delete" \
  aws elasticache describe-cache-clusters --cache-cluster-id "${KEPT_A}" --region "${REGION}"

STATE_5="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
SUBNET_GROUP="$(printf '%s' "${STATE_5}" | jq -r '.resources.SubnetGroup.physicalId // empty')"
VPC_ID="$(printf '%s' "${STATE_5}" | jq -r '[.resources[] | select(.resourceType == "AWS::EC2::VPC") | .physicalId] | first // empty')"
if [ -z "${SUBNET_GROUP}" ] || [ -z "${VPC_ID}" ]; then
  echo "[verify] FAIL: state names no cache subnet group ('${SUBNET_GROUP}') or VPC ('${VPC_ID}') after step 5" >&2
  exit 1
fi

echo "[verify] step 6: destroy"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --state-prefix "${STATE_PREFIX}" --force \
  "${TIMEOUT_OVERRIDES[@]}"
for id in "${ORPHAN_A}" "${ORPHAN_B}" "${KEPT_A}" "${KEPT_B}"; do
  assert_gone "cache cluster ${id} still exists after destroy" \
    aws elasticache describe-cache-clusters --cache-cluster-id "${id}" --region "${REGION}"
done
assert_gone "cache subnet group ${SUBNET_GROUP} still exists after destroy" \
  aws elasticache describe-cache-subnet-groups --cache-subnet-group-name "${SUBNET_GROUP}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "role ${DENY_ROLE} still exists after the run" \
  aws iam get-role --role-name "${DENY_ROLE}"

trap - EXIT INT TERM
rm -rf "${LOG_DIR}"
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}/" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}/" "elasticache-fix-forward-orphan state teardown"

echo "[verify] PASS -- the fix-forward deleted the earlier failed CREATE's cache cluster when its identity was journaled, and kept it when not (go-to-k/cdkd#4606)"
