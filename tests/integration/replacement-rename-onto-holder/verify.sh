#!/usr/bin/env bash
# verify.sh — a replacement renamed onto a name ANOTHER resource holds must
# neither adopt that resource nor delete the one being replaced
# (issues #3937 and #3931), and a plain CREATE onto such a name must not
# adopt it either (issue #4180).
#
# #3937: SQS `CreateQueue` hands back an existing queue of the requested name
# when the attributes match. A replacement renaming the stack's queue onto an
# out-of-band queue's name "succeeded" with that queue: cdkd deleted its own
# queue as the replacement's cleanup and recorded the other one, which a later
# destroy deleted. Now the name is looked up before the create.
#
# #3931: `--recreate-via-cc-api` deleted the old resource FIRST, to free the
# name the new one takes. When the template also renames it onto a name
# another resource holds, the delete freed nothing: the create collided (after
# minutes of retries) and the managed repository was gone. Now a rename
# creates first, and a collision deletes nothing.
#
# Phases (see the stack for the env knobs; both names are create-only):
#   A. Deploy Queue=QUEUE_A, Repo=REPO_A.
#   B. #3937 ARM. Create QUEUE_HELD out of band, then rename Queue onto it. The
#      deploy must FAIL before creating anything: QUEUE_A keeps its
#      CreatedTimestamp, QUEUE_HELD survives, state still records QUEUE_A.
#      Before the fix the deploy SUCCEEDED, deleted QUEUE_A and recorded
#      QUEUE_HELD.
#   C. NEGATIVE CONTROL for B: rename Queue onto the free QUEUE_FREE. The
#      lookup finds nothing, the replacement runs, QUEUE_A is deleted.
#   B2/C2. The same pair for the SNS topic (`CreateTopic` returns an existing
#      topic's ARN): TOPIC_HELD out of band refuses, TOPIC_FREE replaces.
#   B3/C3. The same pair for the ECS cluster (`CreateCluster` returns an
#      existing ACTIVE cluster): CLUSTER_HELD out of band refuses with
#      CLUSTER_A still ACTIVE and recorded, CLUSTER_FREE replaces.
#   C4. The deleted CLUSTER_A, still listed as INACTIVE, does not hold its
#      name: a rename back onto it MUST SUCCEED with a fresh ACTIVE cluster.
#      Before the lookup read INACTIVE as absent it refused.
#   B6/C6. The same pair for the ELBv2 target group (`CreateTargetGroup`
#      returns an existing one of matching settings): TG_HELD out of band
#      refuses with TG_A's ARN unchanged and recorded, TG_FREE replaces.
#   B7/C7. The same pair for the ELBv2 network load balancer
#      (`CreateLoadBalancer` likewise): LB_HELD out of band in the stack's own
#      subnet refuses with LB_A's ARN unchanged and recorded, LB_FREE replaces.
#      LB_HELD is deleted right after B7, so its network interfaces have left
#      the subnet before the destroy deletes it.
#   A8/B8/C8. #3937 review: a replacement that keeps the template Name but
#      SENDS another one because --prefix-user-supplied-names differs from
#      the deploy that created the resource. A8 adds FlagTargetGroup (TCP, in
#      the fixture VPC) under the flag, so AWS holds the PREFIXED name. B8
#      creates FLAG_TG (the bare name, the replacement's settings) out of band,
#      then changes the create-only Port under the default flag: the deploy
#      must FAIL before creating anything, the prefixed group untouched and
#      recorded. Before the review fix the template names compared equal, no
#      lookup ran, and CreateTargetGroup handed back the holder. C8 removes
#      the holder and redeploys: the replacement succeeds.
#   B9/C9. #4180 on ELBv2: NTG_HELD out of band, then NewTargetGroup is
#      CREATED under that name: the deploy must FAIL before the create and
#      record nothing; C9 creates it under the free NTG_FREE.
#   D. #3931 ARM. Create REPO_HELD out of band, then rename Repo onto it under
#      `--recreate-via-cc-api Repo`. The deploy must FAIL with the create-first
#      collision and delete nothing: REPO_A keeps its createdAt, REPO_HELD
#      survives, state still records REPO_A on the SDK route. Before the fix
#      REPO_A was destroyed first.
#   E. CONTROL for D: remove REPO_HELD, rename Repo onto REPO_FREE under the
#      same flag. It must create REPO_FREE BEFORE deleting REPO_A (read off the
#      log order), and record REPO_FREE on the Cloud Control route.
#   B5. #4180 ARM. Create NEWQ_HELD out of band, then add NewQueue under that
#      name. The deploy must FAIL before creating anything: NEWQ_HELD keeps its
#      CreatedTimestamp and state records no NewQueue. Before the fix the
#      deploy SUCCEEDED and recorded NEWQ_HELD as the stack's queue.
#   C5. CONTROL for B5: add NewQueue under the free NEWQ_FREE. It is created
#      and recorded.
#   F. Destroy; every queue, topic, cluster, repository, target group, load
#      balancer and the state file are gone.
#
# After a run killed with SIGKILL (no trap runs), clear by hand the queues,
# topics, ECS clusters, ECR repositories, ELBv2 load balancers and target groups
# whose names start `cdkd-integ-rroh-`, plus the target group A8 created
# under the prefix flag (named `CdkdReplacementRenam...-<hash>`, in the
# stack's VPC), then that VPC (CIDR 10.88.0.0/24) — the out-of-band holders
# carry a per-run suffix after `cdkd-integ-rroh-*-held-` (`-lbh-` / `-tgh-` /
# `-ntgh-` for ELBv2, whose names cap at 32), so a later run's pre-flight check
# does not see them.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1

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

cd "$(dirname "$0")"

STACK="CdkdReplacementRenameOntoHolderExample"
REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCK_KEY="cdkd/${STACK}/${REGION}/lock.json"
QUEUE_A="cdkd-integ-rroh-queue-a"
# The out-of-band holders carry a per-run suffix: SQS refuses a queue name
# for 60 s after it is deleted (QueueDeletedRecently), so a fixed name failed a
# re-run inside that window. The stack's own names stay fixed — cdkd's create
# retries the cooldown.
RUN_SUFFIX="$(date +%s)-$$"
QUEUE_HELD="cdkd-integ-rroh-queue-held-${RUN_SUFFIX}"
QUEUE_FREE="cdkd-integ-rroh-queue-free"
TOPIC_A="cdkd-integ-rroh-topic-a"
TOPIC_HELD="cdkd-integ-rroh-topic-held-${RUN_SUFFIX}"
TOPIC_FREE="cdkd-integ-rroh-topic-free"
CLUSTER_A="cdkd-integ-rroh-cluster-a"
CLUSTER_HELD="cdkd-integ-rroh-cluster-held-${RUN_SUFFIX}"
CLUSTER_FREE="cdkd-integ-rroh-cluster-free"
REPO_A="cdkd-integ-rroh-repo-a"
REPO_HELD="cdkd-integ-rroh-repo-held-${RUN_SUFFIX}"
REPO_FREE="cdkd-integ-rroh-repo-free"
NEWQ_HELD="cdkd-integ-rroh-newqueue-held-${RUN_SUFFIX}"
# ELBv2 names cap at 32 characters, so their holders take a shorter suffix.
RUN_SHORT="$(printf '%x' "$(date +%s)")"
TG_A="cdkd-integ-rroh-tg-a"
TG_HELD="cdkd-integ-rroh-tgh-${RUN_SHORT}"
TG_FREE="cdkd-integ-rroh-tg-free"
LB_A="cdkd-integ-rroh-lb-a"
LB_HELD="cdkd-integ-rroh-lbh-${RUN_SHORT}"
LB_FREE="cdkd-integ-rroh-lb-free"
# FlagTargetGroup's template Name; FLAG_TG_PORT empty leaves it out of the
# stack (phases A to C7). Not run-suffixed: B8's holder MUST be this name.
FLAG_TG="cdkd-integ-rroh-ftg"
FLAG_TG_PORT=""
FTG_OLD_ARN=""
NTG_HELD="cdkd-integ-rroh-ntgh-${RUN_SHORT}"
NTG_FREE="cdkd-integ-rroh-ntg-free"
# NewTargetGroup's name; empty leaves it out of the stack (phases A to C8).
NEW_TG=""
# The TargetGroup and LoadBalancer names every deploy sends; phases B6 to C7
# move them, every later deploy keeps the last one.
TG_CUR="${TG_A}"
LB_CUR="${LB_A}"
# The stack's VPC and subnet, read from state after phase A, so the trap can
# remove them by id when the state destroy could not, and phase F can assert
# them gone.
VPC_ID=""
SUBNET_ID=""
NEWQ_FREE="cdkd-integ-rroh-newqueue-free"
# NewQueue's name; empty leaves it out of the stack (phases A to E).
NEW_QUEUE=""
ALL_QUEUES="${QUEUE_A} ${QUEUE_HELD} ${QUEUE_FREE} ${NEWQ_HELD} ${NEWQ_FREE}"
ALL_TOPICS="${TOPIC_A} ${TOPIC_HELD} ${TOPIC_FREE}"
ALL_CLUSTERS="${CLUSTER_A} ${CLUSTER_HELD} ${CLUSTER_FREE}"
ALL_REPOS="${REPO_A} ${REPO_HELD} ${REPO_FREE}"
ALL_TGS="${TG_A} ${TG_HELD} ${TG_FREE} ${FLAG_TG} ${NTG_HELD} ${NTG_FREE}"
ALL_LBS="${LB_A} ${LB_HELD} ${LB_FREE}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/rroh.XXXXXX")"
ACCOUNT_ID="" PARTITION=""
read -r ACCOUNT_ID PARTITION < <(aws sts get-caller-identity --query '[Account, Arn]' --output text \
  | awk '{ split($2, a, ":"); print $1, a[2] }') || true
if [ -z "${ACCOUNT_ID}" ] || [ -z "${PARTITION}" ]; then
  echo "[verify] FAIL: could not read the account id and partition from sts get-caller-identity" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "[verify] FAIL: STATE_BUCKET env var is required" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "[verify] FAIL: ${LOCAL_DIST} not found — run 'vp run build' at the repo root first" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

queue_url() { # usage: queue_url <name> — the URL, or a hard failure
  aws sqs get-queue-url --queue-name "$1" --region "${REGION}" --query QueueUrl --output text
}
queue_created_at() { # usage: queue_created_at <name>
  local url
  url="$(queue_url "$1")" || return 1
  aws sqs get-queue-attributes --queue-url "${url}" --attribute-names CreatedTimestamp \
    --region "${REGION}" --query Attributes.CreatedTimestamp --output text
}
# The topic ARN a name maps to in this account and region (no API call).
topic_arn() { # usage: topic_arn <name>
  printf 'arn:%s:sns:%s:%s:%s' "${PARTITION}" "${REGION}" "${ACCOUNT_ID}" "$1"
}
# A cluster's status, `None` when ECS knows no cluster of the name. Not a
# gone-probe: `describe-clusters` answers a missing name (listed under
# `failures`) and a deleted one (`INACTIVE`) with exit 0, so "gone" is one of
# those two VALUES. Callers capture it as its own statement, never inside
# `[ ]`, so a failed read is reported as unreadable, not as a wrong status.
cluster_status() { # usage: cluster_status <name>
  aws ecs describe-clusters --clusters "$1" --region "${REGION}" \
    --query 'clusters[0].status' --output text
}
# Fails the run naming the cluster unless its status is <want>; an unreadable
# status is reported as unreadable, never as a wrong status.
assert_cluster_status() { # usage: assert_cluster_status <name> <want> <description>
  local st
  st="$(cluster_status "$1")" || { echo "[verify] FAIL: could not read cluster $1's status" >&2; exit 1; }
  if [ "${st}" != "$2" ]; then
    echo "[verify] FAIL: $3 (cluster $1 is ${st})" >&2
    exit 1
  fi
}
cluster_is_gone() { # usage: cluster_is_gone <name> — 0 when missing or INACTIVE
  local st
  st="$(cluster_status "$1")" || return 2
  [ "${st}" = "None" ] || [ "${st}" = "INACTIVE" ]
}
# A deleted cluster passes through DEPROVISIONING, so "gone" is polled.
assert_cluster_gone() { # usage: assert_cluster_gone <name> <description>
  local deadline rc
  deadline=$(( $(date +%s) + 180 ))
  while :; do
    rc=0
    cluster_is_gone "$1" || rc=$?
    [ "${rc}" -eq 0 ] && return 0
    if [ "${rc}" -eq 2 ]; then
      echo "[verify] FAIL: could not read cluster $1's status" >&2
      exit 1
    fi
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: $2" >&2
      exit 1
    fi
    sleep 10
  done
}
repo_created_at() { # usage: repo_created_at <name>
  aws ecr describe-repositories --repository-names "$1" --region "${REGION}" \
    --query 'repositories[0].createdAt' --output text
}
# An ELBv2 resource's ARN by name, or a hard failure (a missing name included).
lb_arn() { # usage: lb_arn <name>
  aws elbv2 describe-load-balancers --names "$1" --region "${REGION}" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text
}
tg_arn() { # usage: tg_arn <name>
  aws elbv2 describe-target-groups --names "$1" --region "${REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text
}
# A deleted load balancer can stay listed for a moment, so "gone" is polled.
assert_elbv2_gone() { # usage: assert_elbv2_gone <load-balancers|target-groups> <name> <description>
  local deadline
  deadline=$(( $(date +%s) + 300 ))
  while ! gone_probe aws elbv2 "describe-$1" --names "$2" --region "${REGION}"; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: $3" >&2
      exit 1
    fi
    sleep 10
  done
}
# A network load balancer's interfaces leave its subnet minutes after its
# delete; until they do, the subnet cannot be deleted. Returns 1 on a failed
# read or the timeout.
wait_lb_enis_released() { # usage: wait_lb_enis_released <load balancer name> <timeout seconds>
  local deadline ids
  deadline=$(( $(date +%s) + $2 ))
  while :; do
    ids="$(aws ec2 describe-network-interfaces --region "${REGION}" \
      --filters "Name=description,Values=ELB net/$1/*" \
      --query 'NetworkInterfaces[].NetworkInterfaceId' --output text)" || return 1
    [ -z "${ids}" ] && return 0
    [ "$(date +%s)" -ge "${deadline}" ] && return 1
    sleep 15
  done
}
state_field() { # usage: state_field <jq path>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | jq -r "$1"
}

# SQS keeps a deleted queue answering for up to 60 s, so "gone" is polled.
assert_queue_gone() { # usage: assert_queue_gone <name> <description>
  local deadline
  deadline=$(( $(date +%s) + 150 ))
  while ! gone_probe aws sqs get-queue-url --queue-name "$1" --region "${REGION}"; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: $2" >&2
      exit 1
    fi
    sleep 10
  done
}

# SNS can answer a just-deleted topic for a moment, so "gone" is polled too.
assert_topic_gone() { # usage: assert_topic_gone <name> <description>
  local deadline
  deadline=$(( $(date +%s) + 90 ))
  while ! gone_probe aws sns get-topic-attributes --topic-arn "$(topic_arn "$1")" --region "${REGION}"; do
    if [ "$(date +%s)" -ge "${deadline}" ]; then
      echo "[verify] FAIL: $2" >&2
      exit 1
    fi
    sleep 5
  done
}

delete_queue_best_effort() { # usage: delete_queue_best_effort <name>
  (
  set +eu
  url="$(aws sqs get-queue-url --queue-name "$1" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  true
  )
}
delete_topic_best_effort() { # usage: delete_topic_best_effort <name>
  (
  set +eu
  aws sns delete-topic --topic-arn "$(topic_arn "$1")" --region "${REGION}" >/dev/null 2>&1 || true
  )
}
delete_cluster_best_effort() { # usage: delete_cluster_best_effort <name>
  (
  set +eu
  aws ecs delete-cluster --cluster "$1" --region "${REGION}" >/dev/null 2>&1 || true
  )
}
delete_lb_best_effort() { # usage: delete_lb_best_effort <name> — waits for the delete
  (
  set +eu
  arn="$(aws elbv2 describe-load-balancers --names "$1" --region "${REGION}" \
    --query 'LoadBalancers[0].LoadBalancerArn' --output text 2>/dev/null)"
  if [ -n "${arn}" ] && [ "${arn}" != "None" ]; then
    aws elbv2 delete-load-balancer --load-balancer-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
    aws elbv2 wait load-balancers-deleted --load-balancer-arns "${arn}" --region "${REGION}" >/dev/null 2>&1
  fi
  true
  )
}
delete_tg_best_effort() { # usage: delete_tg_best_effort <name>
  (
  set +eu
  arn="$(aws elbv2 describe-target-groups --names "$1" --region "${REGION}" \
    --query 'TargetGroups[0].TargetGroupArn' --output text 2>/dev/null)"
  [ -n "${arn}" ] && [ "${arn}" != "None" ] \
    && aws elbv2 delete-target-group --target-group-arn "${arn}" --region "${REGION}" >/dev/null 2>&1
  true
  )
}
delete_repo_best_effort() { # usage: delete_repo_best_effort <name>
  (
  set +eu
  aws ecr delete-repository --repository-name "$1" --force --region "${REGION}" >/dev/null 2>&1 || true
  )
}

cleanup() {
  rc=$?
  echo "[verify] cleanup (rc=${rc})"
  (
  set +eu
  # The load balancers first: one still in the stack's subnet (the out-of-band
  # holder) would stop the state destroy from deleting that subnet. Then the
  # interfaces of EVERY one of them, those an earlier phase already deleted
  # included, since they leave the subnet minutes after the delete.
  for l in ${ALL_LBS}; do delete_lb_best_effort "${l}"; done
  # ONE bounded wait for every fixture load balancer's interfaces, so the
  # trap stays inside the watchdog.
  wait_lb_enis_released "cdkd-integ-rroh-*" 600 >/dev/null 2>&1
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1 || true
  for q in ${ALL_QUEUES}; do delete_queue_best_effort "${q}"; done
  for t in ${ALL_TOPICS}; do delete_topic_best_effort "${t}"; done
  for c in ${ALL_CLUSTERS}; do delete_cluster_best_effort "${c}"; done
  for r in ${ALL_REPOS}; do delete_repo_best_effort "${r}"; done
  for g in ${ALL_TGS}; do delete_tg_best_effort "${g}"; done
  # The prefixed FlagTargetGroup A8 created, by the ARN read off state.
  case "${FTG_OLD_ARN}" in
    arn:*:targetgroup/?*) aws elbv2 delete-target-group --target-group-arn "${FTG_OLD_ARN}" \
      --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  # The state destroy is silenced, so a subnet or VPC it left goes by id.
  case "${SUBNET_ID}" in
    subnet-?*) aws ec2 delete-subnet --subnet-id "${SUBNET_ID}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  case "${VPC_ID}" in
    vpc-?*) aws ec2 delete-vpc --vpc-id "${VPC_ID}" --region "${REGION}" >/dev/null 2>&1 ;;
  esac
  aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/${LOCK_KEY}" >/dev/null 2>&1 || true
  aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true
  rm -rf "${LOG_DIR}"
  )
  exit "${rc}"
}

# A leftover (an interrupted run, or a CONCURRENT one) would turn an arm into a
# false collision. Checked BEFORE the trap is armed, so a refusal here never
# sweeps what it refused to touch.
for q in ${ALL_QUEUES}; do
  if ! gone_probe aws sqs get-queue-url --queue-name "${q}" --region "${REGION}"; then
    echo "[verify] FAIL: queue ${q} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for t in ${ALL_TOPICS}; do
  if ! gone_probe aws sns get-topic-attributes --topic-arn "$(topic_arn "${t}")" --region "${REGION}"; then
    echo "[verify] FAIL: topic ${t} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for c in ${ALL_CLUSTERS}; do
  c_rc=0
  cluster_is_gone "${c}" || c_rc=$?
  if [ "${c_rc}" -ne 0 ]; then
    echo "[verify] FAIL: ECS cluster ${c} already exists (or its status is unreadable) before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for r in ${ALL_REPOS}; do
  if ! gone_probe aws ecr describe-repositories --repository-names "${r}" --region "${REGION}"; then
    echo "[verify] FAIL: repository ${r} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for g in ${ALL_TGS}; do
  if ! gone_probe aws elbv2 describe-target-groups --names "${g}" --region "${REGION}"; then
    echo "[verify] FAIL: target group ${g} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
for l in ${ALL_LBS}; do
  if ! gone_probe aws elbv2 describe-load-balancers --names "${l}" --region "${REGION}"; then
    echo "[verify] FAIL: load balancer ${l} already exists before the run — nothing was touched; remove it if it is a leftover (or wait for a concurrent run to finish)" >&2
    rm -rf "${LOG_DIR}"
    exit 1
  fi
done
if ! gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"; then
  echo "[verify] FAIL: s3://${STATE_BUCKET}/${STATE_KEY} already exists before the run — nothing was touched" >&2
  rm -rf "${LOG_DIR}"
  exit 1
fi

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ ! -d node_modules ]; then
  CI=true pnpm install --ignore-workspace
fi

deploy() { # usage: deploy <log> <QUEUE_NAME> <TOPIC_NAME> <CLUSTER_NAME> <REPO_NAME> [extra flags...]
  local log="$1" queue="$2" topic="$3" cluster="$4" repo="$5"
  shift 5
  env QUEUE_NAME="${queue}" TOPIC_NAME="${topic}" CLUSTER_NAME="${cluster}" REPO_NAME="${repo}" \
    NEW_QUEUE_NAME="${NEW_QUEUE}" TG_NAME="${TG_CUR}" LB_NAME="${LB_CUR}" \
    FLAG_TG_NAME="${FLAG_TG}" FLAG_TG_PORT="${FLAG_TG_PORT}" NEW_TG_NAME="${NEW_TG}" \
    node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --yes "$@" > "${log}" 2>&1
}

# A refusal is read off two INDEPENDENT markers on one line: the sentinel is
# the refusal's closing clause, the marker names this arm's subject.
# Sentinel without marker = the wording drifted — never read as "no refusal".
assert_refusal() { # usage: assert_refusal <log> <sentinel> <marker> <arm>
  local log="$1" sentinel="$2" marker="$3" arm="$4"
  if ! grep -qF -- "${sentinel}" "${log}"; then
    echo "[verify] FAIL: ${arm}: the deploy failed without the refusal (output above)" >&2
    exit 1
  fi
  if ! grep -F -- "${sentinel}" "${log}" | grep -qF -- "${marker}"; then
    echo "[verify] FAIL: ${arm}: the refusal is present but does not carry '${marker}' (wording drifted):" >&2
    grep -F -- "${sentinel}" "${log}" | sed 's/^/  /' >&2
    exit 1
  fi
}

# ---------------------------------------------------------------------------
# PHASE A: baseline
# ---------------------------------------------------------------------------
echo "[verify] phase A: deploy ${STACK} (Queue=${QUEUE_A}, Topic=${TOPIC_A}, Cluster=${CLUSTER_A}, Repo=${REPO_A}, TargetGroup=${TG_A}, LoadBalancer=${LB_A})"
deploy "${LOG_DIR}/a.log" "${QUEUE_A}" "${TOPIC_A}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/a.log"; echo "[verify] FAIL: phase A deploy failed" >&2; exit 1; }
QUEUE_A_URL="$(queue_url "${QUEUE_A}")"
if [ "$(state_field '.resources.Queue.physicalId')" != "${QUEUE_A_URL}" ]; then
  echo "[verify] FAIL: state does not record Queue as ${QUEUE_A_URL} after phase A" >&2
  exit 1
fi
if [ "$(state_field '.resources.Repo.physicalId')" != "${REPO_A}" ]; then
  echo "[verify] FAIL: state does not record Repo as ${REPO_A} after phase A" >&2
  exit 1
fi
if [ "$(state_field '.resources.Topic.physicalId')" != "$(topic_arn "${TOPIC_A}")" ]; then
  echo "[verify] FAIL: state does not record Topic as $(topic_arn "${TOPIC_A}") after phase A" >&2
  exit 1
fi
TG_A_ARN="$(tg_arn "${TG_A}")"
if [ "$(state_field '.resources.TargetGroup.physicalId')" != "${TG_A_ARN}" ]; then
  echo "[verify] FAIL: state does not record TargetGroup as ${TG_A_ARN} after phase A" >&2
  exit 1
fi
LB_A_ARN="$(lb_arn "${LB_A}")"
VPC_ID="$(state_field '.resources.Vpc.physicalId')"
SUBNET_ID="$(state_field '.resources.Subnet.physicalId')"
case "${VPC_ID}:${SUBNET_ID}" in
  vpc-?*:subnet-?*) ;;
  *) echo "[verify] FAIL: state records no VPC / subnet id after phase A (got '${VPC_ID}' / '${SUBNET_ID}')" >&2; exit 1 ;;
esac
if [ "$(state_field '.resources.LoadBalancer.physicalId')" != "${LB_A_ARN}" ]; then
  echo "[verify] FAIL: state does not record LoadBalancer as ${LB_A_ARN} after phase A" >&2
  exit 1
fi
echo "[verify] phase A ok"

# ---------------------------------------------------------------------------
# PHASE B: #3937 — rename the queue onto an out-of-band queue's name
# ---------------------------------------------------------------------------
echo "[verify] phase B: ${QUEUE_HELD} out of band, then rename Queue onto it (expect REFUSAL)"
QUEUE_A_CREATED="$(queue_created_at "${QUEUE_A}")"
QUEUE_HELD_URL="$(aws sqs create-queue --queue-name "${QUEUE_HELD}" --region "${REGION}" \
  --query QueueUrl --output text)"
QUEUE_HELD_CREATED="$(queue_created_at "${QUEUE_HELD}")"
set +e
deploy "${LOG_DIR}/b.log" "${QUEUE_HELD}" "${TOPIC_A}" "${CLUSTER_A}" "${REPO_A}"
B_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b.log" || true
if [ "${B_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rename onto ${QUEUE_HELD} SUCCEEDED — the replacement adopted the out-of-band queue" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b.log" "already holds the name it asks for" \
  "another existing resource (${QUEUE_HELD_URL})" "phase B"
if [ "$(queue_created_at "${QUEUE_A}")" != "${QUEUE_A_CREATED}" ]; then
  echo "[verify] FAIL: ${QUEUE_A} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(queue_created_at "${QUEUE_HELD}")" != "${QUEUE_HELD_CREATED}" ]; then
  echo "[verify] FAIL: the out-of-band ${QUEUE_HELD} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.Queue.physicalId')" != "${QUEUE_A_URL}" ]; then
  echo "[verify] FAIL: state no longer records Queue as ${QUEUE_A_URL} after the refused deploy" >&2
  exit 1
fi
echo "[verify] phase B ok: refused before any create, both queues untouched"

# ---------------------------------------------------------------------------
# PHASE C: NEGATIVE CONTROL — a rename onto a free name still replaces
# ---------------------------------------------------------------------------
echo "[verify] phase C: rename Queue onto the free ${QUEUE_FREE} (MUST SUCCEED)"
deploy "${LOG_DIR}/c.log" "${QUEUE_FREE}" "${TOPIC_A}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c.log"; echo "[verify] FAIL: the rename onto a free name failed — the lookup refused a name nobody holds" >&2; exit 1; }
QUEUE_FREE_URL="$(queue_url "${QUEUE_FREE}")"
if [ "$(state_field '.resources.Queue.physicalId')" != "${QUEUE_FREE_URL}" ]; then
  echo "[verify] FAIL: state does not record Queue as ${QUEUE_FREE_URL} after phase C" >&2
  exit 1
fi
assert_queue_gone "${QUEUE_A}" "the replaced ${QUEUE_A} survived the phase C replacement"
echo "[verify] phase C ok: ${QUEUE_FREE} replaced ${QUEUE_A}"

# ---------------------------------------------------------------------------
# PHASE B2: #3937 on SNS — rename the topic onto an out-of-band topic's name
# ---------------------------------------------------------------------------
echo "[verify] phase B2: ${TOPIC_HELD} out of band, then rename Topic onto it (expect REFUSAL)"
TOPIC_HELD_ARN="$(aws sns create-topic --name "${TOPIC_HELD}" --region "${REGION}" \
  --query TopicArn --output text)"
if [ "${TOPIC_HELD_ARN}" != "$(topic_arn "${TOPIC_HELD}")" ]; then
  echo "[verify] FAIL: the out-of-band topic's ARN ${TOPIC_HELD_ARN} is not the derived $(topic_arn "${TOPIC_HELD}")" >&2
  exit 1
fi
set +e
deploy "${LOG_DIR}/b2.log" "${QUEUE_FREE}" "${TOPIC_HELD}" "${CLUSTER_A}" "${REPO_A}"
B2_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b2.log" || true
if [ "${B2_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rename onto ${TOPIC_HELD} SUCCEEDED — the replacement adopted the out-of-band topic" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b2.log" "already holds the name it asks for" \
  "another existing resource (${TOPIC_HELD_ARN})" "phase B2"
aws sns get-topic-attributes --topic-arn "$(topic_arn "${TOPIC_A}")" --region "${REGION}" >/dev/null \
  || { echo "[verify] FAIL: ${TOPIC_A} was deleted by the refused deploy" >&2; exit 1; }
aws sns get-topic-attributes --topic-arn "${TOPIC_HELD_ARN}" --region "${REGION}" >/dev/null \
  || { echo "[verify] FAIL: the out-of-band ${TOPIC_HELD} was deleted by the refused deploy" >&2; exit 1; }
if [ "$(state_field '.resources.Topic.physicalId')" != "$(topic_arn "${TOPIC_A}")" ]; then
  echo "[verify] FAIL: state no longer records Topic as ${TOPIC_A} after the refused deploy" >&2
  exit 1
fi
echo "[verify] phase B2 ok: refused before any create, both topics untouched"

# ---------------------------------------------------------------------------
# PHASE C2: CONTROL for B2 — a topic rename onto a free name replaces
# ---------------------------------------------------------------------------
echo "[verify] phase C2: rename Topic onto the free ${TOPIC_FREE} (MUST SUCCEED)"
deploy "${LOG_DIR}/c2.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c2.log"; echo "[verify] FAIL: the topic rename onto a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.Topic.physicalId')" != "$(topic_arn "${TOPIC_FREE}")" ]; then
  echo "[verify] FAIL: state does not record Topic as ${TOPIC_FREE} after phase C2" >&2
  exit 1
fi
assert_topic_gone "${TOPIC_A}" "the replaced ${TOPIC_A} survived the phase C2 replacement"
echo "[verify] phase C2 ok: ${TOPIC_FREE} replaced ${TOPIC_A}"

# ---------------------------------------------------------------------------
# PHASE B3: #3937 on ECS — rename the cluster onto an out-of-band cluster's name
# ---------------------------------------------------------------------------
echo "[verify] phase B3: ${CLUSTER_HELD} out of band, then rename Cluster onto it (expect REFUSAL)"
if [ "$(state_field '.resources.Cluster.physicalId')" != "${CLUSTER_A}" ]; then
  echo "[verify] FAIL: state does not record Cluster as ${CLUSTER_A} before phase B3" >&2
  exit 1
fi
CLUSTER_HELD_ARN="$(aws ecs create-cluster --cluster-name "${CLUSTER_HELD}" --region "${REGION}" \
  --query cluster.clusterArn --output text)"
set +e
deploy "${LOG_DIR}/b3.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_HELD}" "${REPO_A}"
B3_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b3.log" || true
if [ "${B3_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rename onto ${CLUSTER_HELD} SUCCEEDED — the replacement adopted the out-of-band cluster" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b3.log" "already holds the name it asks for" \
  "another existing resource (${CLUSTER_HELD})" "phase B3"
if grep -qF 'Deleting old Cluster' "${LOG_DIR}/b3.log"; then
  echo "[verify] FAIL: the refused deploy started deleting ${CLUSTER_A}" >&2
  exit 1
fi
# An ECS cluster re-created under a name keeps its ARN and carries no
# creation time, so "untouched" is: still ACTIVE, and never deleted in the log.
assert_cluster_status "${CLUSTER_A}" ACTIVE "${CLUSTER_A} is no longer ACTIVE after the refused deploy"
assert_cluster_status "${CLUSTER_HELD}" ACTIVE "the out-of-band ${CLUSTER_HELD} is no longer ACTIVE after the refused deploy"
if [ "$(state_field '.resources.Cluster.physicalId')" != "${CLUSTER_A}" ]; then
  echo "[verify] FAIL: state no longer records Cluster as ${CLUSTER_A} after the refused deploy" >&2
  exit 1
fi
echo "[verify] phase B3 ok: refused before any create, both clusters ACTIVE (${CLUSTER_HELD_ARN})"

# ---------------------------------------------------------------------------
# PHASE C3: CONTROL for B3 — a cluster rename onto a free name replaces
# ---------------------------------------------------------------------------
echo "[verify] phase C3: rename Cluster onto the free ${CLUSTER_FREE} (MUST SUCCEED)"
deploy "${LOG_DIR}/c3.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_FREE}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c3.log"; echo "[verify] FAIL: the cluster rename onto a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.Cluster.physicalId')" != "${CLUSTER_FREE}" ]; then
  echo "[verify] FAIL: state does not record Cluster as ${CLUSTER_FREE} after phase C3" >&2
  exit 1
fi
assert_cluster_status "${CLUSTER_FREE}" ACTIVE "${CLUSTER_FREE} is not ACTIVE after phase C3"
assert_cluster_gone "${CLUSTER_A}" "the replaced ${CLUSTER_A} survived the phase C3 replacement"
echo "[verify] phase C3 ok: ${CLUSTER_FREE} replaced ${CLUSTER_A}"

# ---------------------------------------------------------------------------
# PHASE C4: a DELETED (INACTIVE) cluster does not hold its name
# ---------------------------------------------------------------------------
# The branch under test is the lookup's INACTIVE arm, so the phase first
# proves ECS still LISTS the deleted CLUSTER_A (as INACTIVE, not absent): a
# listing already aged out to `None` would take the missing-name arm and test
# nothing, so that fails loudly rather than passing.
echo "[verify] phase C4: rename Cluster back onto the deleted ${CLUSTER_A} (MUST SUCCEED)"
assert_cluster_status "${CLUSTER_A}" INACTIVE \
  "phase C4 needs ${CLUSTER_A} listed as INACTIVE (a None listing would not reach the arm under test)"
deploy "${LOG_DIR}/c4.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c4.log"; echo "[verify] FAIL: the rename onto the deleted ${CLUSTER_A} failed — an INACTIVE cluster was read as holding its name" >&2; exit 1; }
if [ "$(state_field '.resources.Cluster.physicalId')" != "${CLUSTER_A}" ]; then
  echo "[verify] FAIL: state does not record Cluster as ${CLUSTER_A} after phase C4" >&2
  exit 1
fi
assert_cluster_status "${CLUSTER_A}" ACTIVE "${CLUSTER_A} is not a fresh ACTIVE cluster after phase C4"
assert_cluster_gone "${CLUSTER_FREE}" "the replaced ${CLUSTER_FREE} survived the phase C4 replacement"
echo "[verify] phase C4 ok: a fresh ${CLUSTER_A} replaced ${CLUSTER_FREE}"

# ---------------------------------------------------------------------------
# PHASE B6: #3937 on ELBv2 — rename the target group onto an out-of-band one's name
# ---------------------------------------------------------------------------
echo "[verify] phase B6: ${TG_HELD} out of band, then rename TargetGroup onto it (expect REFUSAL)"
TG_HELD_ARN="$(aws elbv2 create-target-group --name "${TG_HELD}" --target-type lambda \
  --region "${REGION}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
TG_CUR="${TG_HELD}"
set +e
deploy "${LOG_DIR}/b6.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}"
B6_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b6.log" || true
if [ "${B6_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rename onto ${TG_HELD} SUCCEEDED — the replacement adopted the out-of-band target group" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b6.log" "already holds the name it asks for" \
  "another existing resource (${TG_HELD_ARN})" "phase B6"
# A target group re-created under its name gets a new ARN, so an unchanged
# ARN is "untouched".
if [ "$(tg_arn "${TG_A}")" != "${TG_A_ARN}" ]; then
  echo "[verify] FAIL: ${TG_A} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(tg_arn "${TG_HELD}")" != "${TG_HELD_ARN}" ]; then
  echo "[verify] FAIL: the out-of-band ${TG_HELD} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.TargetGroup.physicalId')" != "${TG_A_ARN}" ]; then
  echo "[verify] FAIL: state no longer records TargetGroup as ${TG_A_ARN} after the refused deploy" >&2
  exit 1
fi
echo "[verify] phase B6 ok: refused before any create, both target groups untouched"

# ---------------------------------------------------------------------------
# PHASE C6: CONTROL for B6 — a target group rename onto a free name replaces
# ---------------------------------------------------------------------------
echo "[verify] phase C6: rename TargetGroup onto the free ${TG_FREE} (MUST SUCCEED)"
TG_CUR="${TG_FREE}"
deploy "${LOG_DIR}/c6.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c6.log"; echo "[verify] FAIL: the target group rename onto a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.TargetGroup.physicalId')" != "$(tg_arn "${TG_FREE}")" ]; then
  echo "[verify] FAIL: state does not record TargetGroup as ${TG_FREE} after phase C6" >&2
  exit 1
fi
assert_elbv2_gone target-groups "${TG_A}" "the replaced ${TG_A} survived the phase C6 replacement"
echo "[verify] phase C6 ok: ${TG_FREE} replaced ${TG_A}"

# ---------------------------------------------------------------------------
# PHASE B7: #3937 on ELBv2 — rename the load balancer onto an out-of-band one's name
# ---------------------------------------------------------------------------
echo "[verify] phase B7: ${LB_HELD} out of band, then rename LoadBalancer onto it (expect REFUSAL)"
# The same settings the stack's load balancer declares, so a pre-fix create
# hands this one back rather than refusing the name.
LB_HELD_ARN="$(aws elbv2 create-load-balancer --name "${LB_HELD}" --type network --scheme internal \
  --subnets "${SUBNET_ID}" --region "${REGION}" --query 'LoadBalancers[0].LoadBalancerArn' --output text)"
LB_CUR="${LB_HELD}"
set +e
deploy "${LOG_DIR}/b7.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}"
B7_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b7.log" || true
if [ "${B7_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the rename onto ${LB_HELD} SUCCEEDED — the replacement adopted the out-of-band load balancer" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b7.log" "already holds the name it asks for" \
  "another existing resource (${LB_HELD_ARN})" "phase B7"
if [ "$(lb_arn "${LB_A}")" != "${LB_A_ARN}" ]; then
  echo "[verify] FAIL: ${LB_A} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(lb_arn "${LB_HELD}")" != "${LB_HELD_ARN}" ]; then
  echo "[verify] FAIL: the out-of-band ${LB_HELD} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.LoadBalancer.physicalId')" != "${LB_A_ARN}" ]; then
  echo "[verify] FAIL: state no longer records LoadBalancer as ${LB_A_ARN} after the refused deploy" >&2
  exit 1
fi
# Gone now, so its interfaces have left the subnet before phase F deletes it.
aws elbv2 delete-load-balancer --load-balancer-arn "${LB_HELD_ARN}" --region "${REGION}"
assert_elbv2_gone load-balancers "${LB_HELD}" "the out-of-band ${LB_HELD} survived its own delete"
echo "[verify] phase B7 ok: refused before any create, both load balancers untouched"

# ---------------------------------------------------------------------------
# PHASE C7: CONTROL for B7 — a load balancer rename onto a free name replaces
# ---------------------------------------------------------------------------
echo "[verify] phase C7: rename LoadBalancer onto the free ${LB_FREE} (MUST SUCCEED)"
LB_CUR="${LB_FREE}"
deploy "${LOG_DIR}/c7.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c7.log"; echo "[verify] FAIL: the load balancer rename onto a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.LoadBalancer.physicalId')" != "$(lb_arn "${LB_FREE}")" ]; then
  echo "[verify] FAIL: state does not record LoadBalancer as ${LB_FREE} after phase C7" >&2
  exit 1
fi
assert_elbv2_gone load-balancers "${LB_A}" "the replaced ${LB_A} survived the phase C7 replacement"
echo "[verify] phase C7 ok: ${LB_FREE} replaced ${LB_A}"

# ---------------------------------------------------------------------------
# PHASE A8: FlagTargetGroup created under --prefix-user-supplied-names
# ---------------------------------------------------------------------------
echo "[verify] phase A8: add FlagTargetGroup (${FLAG_TG}, port 80) under --prefix-user-supplied-names"
FLAG_TG_PORT=80
deploy "${LOG_DIR}/a8.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  --prefix-user-supplied-names \
  || { sed 's/^/  /' "${LOG_DIR}/a8.log"; echo "[verify] FAIL: phase A8 deploy failed" >&2; exit 1; }
FTG_OLD_ARN="$(state_field '.resources.FlagTargetGroup.physicalId')"
FTG_OLD_NAME="$(printf '%s' "${FTG_OLD_ARN}" | awk -F/ '{ print $2 }')"
# The flag must have taken: the name AWS holds is the prefixed one, or B8
# would test nothing.
case "${FTG_OLD_NAME}" in
  CdkdReplacementRenam?*) ;;
  *) echo "[verify] FAIL: FlagTargetGroup was not created under the prefixed name (state: '${FTG_OLD_ARN}')" >&2; exit 1 ;;
esac
if [ "$(tg_arn "${FTG_OLD_NAME}")" != "${FTG_OLD_ARN}" ]; then
  echo "[verify] FAIL: AWS does not hold ${FTG_OLD_NAME} as ${FTG_OLD_ARN} after phase A8" >&2
  exit 1
fi
echo "[verify] phase A8 ok: FlagTargetGroup is ${FTG_OLD_NAME}"

# ---------------------------------------------------------------------------
# PHASE B8: the default flag sends the BARE name, which a stranger holds
# ---------------------------------------------------------------------------
echo "[verify] phase B8: ${FLAG_TG} out of band, then replace FlagTargetGroup (port 81) under the default flag (expect REFUSAL)"
# The settings the replacement sends, so a pre-fix create hands this back.
FTG_HELD_ARN="$(aws elbv2 create-target-group --name "${FLAG_TG}" --protocol TCP --port 81 \
  --vpc-id "${VPC_ID}" --target-type ip --region "${REGION}" \
  --query 'TargetGroups[0].TargetGroupArn' --output text)"
FLAG_TG_PORT=81
set +e
deploy "${LOG_DIR}/b8.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}"
B8_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b8.log" || true
if [ "${B8_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the replacement under the default flag SUCCEEDED — it adopted the out-of-band ${FLAG_TG}" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b8.log" "already holds the name it asks for" \
  "another existing resource (${FTG_HELD_ARN})" "phase B8"
if [ "$(tg_arn "${FTG_OLD_NAME}")" != "${FTG_OLD_ARN}" ]; then
  echo "[verify] FAIL: ${FTG_OLD_NAME} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(tg_arn "${FLAG_TG}")" != "${FTG_HELD_ARN}" ]; then
  echo "[verify] FAIL: the out-of-band ${FLAG_TG} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.FlagTargetGroup.physicalId')" != "${FTG_OLD_ARN}" ]; then
  echo "[verify] FAIL: state no longer records FlagTargetGroup as ${FTG_OLD_ARN} after the refused deploy" >&2
  exit 1
fi
aws elbv2 delete-target-group --target-group-arn "${FTG_HELD_ARN}" --region "${REGION}"
assert_elbv2_gone target-groups "${FLAG_TG}" "the out-of-band ${FLAG_TG} survived its own delete"
echo "[verify] phase B8 ok: refused before any create, ${FTG_OLD_NAME} untouched and recorded"

# ---------------------------------------------------------------------------
# PHASE C8: CONTROL for B8 — the same replacement onto the now-free bare name
# ---------------------------------------------------------------------------
echo "[verify] phase C8: replace FlagTargetGroup under the default flag onto the free ${FLAG_TG} (MUST SUCCEED)"
deploy "${LOG_DIR}/c8.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c8.log"; echo "[verify] FAIL: the FlagTargetGroup replacement onto a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.FlagTargetGroup.physicalId')" != "$(tg_arn "${FLAG_TG}")" ]; then
  echo "[verify] FAIL: state does not record FlagTargetGroup as ${FLAG_TG} after phase C8" >&2
  exit 1
fi
assert_elbv2_gone target-groups "${FTG_OLD_NAME}" "the replaced ${FTG_OLD_NAME} survived the phase C8 replacement"
echo "[verify] phase C8 ok: ${FLAG_TG} replaced ${FTG_OLD_NAME}"

# ---------------------------------------------------------------------------
# PHASE B9: #4180 on ELBv2 — a plain CREATE onto an out-of-band target group's name
# ---------------------------------------------------------------------------
echo "[verify] phase B9: ${NTG_HELD} out of band, then add NewTargetGroup under that name (expect REFUSAL)"
NTG_HELD_ARN="$(aws elbv2 create-target-group --name "${NTG_HELD}" --target-type lambda \
  --region "${REGION}" --query 'TargetGroups[0].TargetGroupArn' --output text)"
NEW_TG="${NTG_HELD}"
set +e
deploy "${LOG_DIR}/b9.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}"
B9_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b9.log" || true
if [ "${B9_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the create of NewTargetGroup as ${NTG_HELD} SUCCEEDED — it adopted the out-of-band target group" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b9.log" "already holds that name" \
  "an existing resource (${NTG_HELD_ARN})" "phase B9"
if [ "$(tg_arn "${NTG_HELD}")" != "${NTG_HELD_ARN}" ]; then
  echo "[verify] FAIL: the out-of-band ${NTG_HELD} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.NewTargetGroup.physicalId // "absent"')" != "absent" ]; then
  echo "[verify] FAIL: state records NewTargetGroup after the refused create" >&2
  exit 1
fi
echo "[verify] phase B9 ok: refused before the create, ${NTG_HELD} untouched and not recorded"

# ---------------------------------------------------------------------------
# PHASE C9: CONTROL for B9 — a create under a free name proceeds
# ---------------------------------------------------------------------------
echo "[verify] phase C9: add NewTargetGroup under the free ${NTG_FREE} (MUST SUCCEED)"
NEW_TG="${NTG_FREE}"
deploy "${LOG_DIR}/c9.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_A}" \
  || { sed 's/^/  /' "${LOG_DIR}/c9.log"; echo "[verify] FAIL: the NewTargetGroup create under a free name failed" >&2; exit 1; }
if [ "$(state_field '.resources.NewTargetGroup.physicalId')" != "$(tg_arn "${NTG_FREE}")" ]; then
  echo "[verify] FAIL: state does not record NewTargetGroup as ${NTG_FREE} after phase C9" >&2
  exit 1
fi
echo "[verify] phase C9 ok: NewTargetGroup created as ${NTG_FREE}"

# ---------------------------------------------------------------------------
# PHASE D: #3931 — a recreate renamed onto an out-of-band repository's name
# ---------------------------------------------------------------------------
echo "[verify] phase D: ${REPO_HELD} out of band, then --recreate-via-cc-api Repo renamed onto it (expect REFUSAL)"
REPO_A_CREATED="$(repo_created_at "${REPO_A}")"
aws ecr create-repository --repository-name "${REPO_HELD}" --region "${REGION}" >/dev/null
REPO_HELD_CREATED="$(repo_created_at "${REPO_HELD}")"
set +e
deploy "${LOG_DIR}/d.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_HELD}" \
  --recreate-via-cc-api Repo --force-stateful-recreation
D_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/d.log" || true
if [ "${D_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the recreate renamed onto ${REPO_HELD} SUCCEEDED over an out-of-band repository" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/d.log" "Nothing was deleted. Choose a name" \
  "asks for RepositoryName \"${REPO_HELD}\"" "phase D"
if grep -qF 'Destroying old Repo' "${LOG_DIR}/d.log"; then
  echo "[verify] FAIL: the recreate destroyed the old repository before its create" >&2
  exit 1
fi
if gone_probe aws ecr describe-repositories --repository-names "${REPO_A}" --region "${REGION}"; then
  echo "[verify] FAIL: ${REPO_A} was deleted by the refused recreate" >&2
  exit 1
fi
if [ "$(repo_created_at "${REPO_A}")" != "${REPO_A_CREATED}" ]; then
  echo "[verify] FAIL: ${REPO_A} was re-created by the refused recreate" >&2
  exit 1
fi
if [ "$(repo_created_at "${REPO_HELD}")" != "${REPO_HELD_CREATED}" ]; then
  echo "[verify] FAIL: the out-of-band ${REPO_HELD} was deleted or re-created by the refused recreate" >&2
  exit 1
fi
if [ "$(state_field '.resources.Repo.physicalId')" != "${REPO_A}" ] \
  || [ "$(state_field '.resources.Repo.provisionedBy')" != "sdk" ]; then
  echo "[verify] FAIL: state no longer records Repo as ${REPO_A} on the SDK route after the refused recreate" >&2
  exit 1
fi
aws ecr delete-repository --repository-name "${REPO_HELD}" --force --region "${REGION}" >/dev/null
assert_gone "the out-of-band ${REPO_HELD} survived its own delete" \
  aws ecr describe-repositories --repository-names "${REPO_HELD}" --region "${REGION}"
echo "[verify] phase D ok: refused with nothing deleted"

# ---------------------------------------------------------------------------
# PHASE E: CONTROL — a renamed recreate creates BEFORE it deletes
# ---------------------------------------------------------------------------
echo "[verify] phase E: --recreate-via-cc-api Repo renamed onto the free ${REPO_FREE} (MUST SUCCEED, create first)"
deploy "${LOG_DIR}/e.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_FREE}" \
  --recreate-via-cc-api Repo --force-stateful-recreation \
  || { sed 's/^/  /' "${LOG_DIR}/e.log"; echo "[verify] FAIL: the renamed recreate onto a free name failed" >&2; exit 1; }
sed 's/^/  /' "${LOG_DIR}/e.log" || true
CREATE_LINE="$(grep -nF "Repo's new name differs from the one the old resource holds" "${LOG_DIR}/e.log" | head -1 | cut -d: -f1 || true)"
DELETE_LINE="$(grep -nF 'Deleting old Repo' "${LOG_DIR}/e.log" | head -1 | cut -d: -f1 || true)"
if [ -z "${CREATE_LINE}" ] || [ -z "${DELETE_LINE}" ]; then
  echo "[verify] FAIL: phase E did not log the create-first order (create line '${CREATE_LINE}', delete line '${DELETE_LINE}')" >&2
  exit 1
fi
if [ "${CREATE_LINE}" -ge "${DELETE_LINE}" ]; then
  echo "[verify] FAIL: phase E deleted the old repository before creating the new one" >&2
  exit 1
fi
if grep -qF 'Destroying old Repo' "${LOG_DIR}/e.log"; then
  echo "[verify] FAIL: phase E took the destroy-then-create order" >&2
  exit 1
fi
repo_created_at "${REPO_FREE}" >/dev/null
assert_gone "the replaced ${REPO_A} survived the phase E recreate" \
  aws ecr describe-repositories --repository-names "${REPO_A}" --region "${REGION}"
if [ "$(state_field '.resources.Repo.physicalId')" != "${REPO_FREE}" ] \
  || [ "$(state_field '.resources.Repo.provisionedBy')" != "cc-api" ]; then
  echo "[verify] FAIL: state does not record Repo as ${REPO_FREE} on the Cloud Control route after phase E" >&2
  exit 1
fi
echo "[verify] phase E ok: ${REPO_FREE} created before ${REPO_A} was deleted"

# ---------------------------------------------------------------------------
# PHASE B5: #4180 — a plain CREATE onto an out-of-band queue's name
# ---------------------------------------------------------------------------
echo "[verify] phase B5: ${NEWQ_HELD} out of band, then add NewQueue under that name (expect REFUSAL)"
NEWQ_HELD_URL="$(aws sqs create-queue --queue-name "${NEWQ_HELD}" --region "${REGION}" \
  --query QueueUrl --output text)"
NEWQ_HELD_CREATED="$(queue_created_at "${NEWQ_HELD}")"
NEW_QUEUE="${NEWQ_HELD}"
set +e
deploy "${LOG_DIR}/b5.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_FREE}"
B5_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/b5.log" || true
if [ "${B5_RC}" -eq 0 ]; then
  echo "[verify] FAIL: the create of NewQueue as ${NEWQ_HELD} SUCCEEDED — it adopted the out-of-band queue" >&2
  exit 1
fi
assert_refusal "${LOG_DIR}/b5.log" "already holds that name" \
  "an existing resource (${NEWQ_HELD_URL})" "phase B5"
if [ "$(queue_created_at "${NEWQ_HELD}")" != "${NEWQ_HELD_CREATED}" ]; then
  echo "[verify] FAIL: the out-of-band ${NEWQ_HELD} was deleted or re-created by the refused deploy" >&2
  exit 1
fi
if [ "$(state_field '.resources.NewQueue.physicalId // "absent"')" != "absent" ]; then
  echo "[verify] FAIL: state records NewQueue after the refused create" >&2
  exit 1
fi
echo "[verify] phase B5 ok: refused before the create, ${NEWQ_HELD} untouched and not recorded"

# ---------------------------------------------------------------------------
# PHASE C5: CONTROL for B5 — a create under a free name proceeds
# ---------------------------------------------------------------------------
echo "[verify] phase C5: add NewQueue under the free ${NEWQ_FREE} (MUST SUCCEED)"
NEW_QUEUE="${NEWQ_FREE}"
deploy "${LOG_DIR}/c5.log" "${QUEUE_FREE}" "${TOPIC_FREE}" "${CLUSTER_A}" "${REPO_FREE}" \
  || { sed 's/^/  /' "${LOG_DIR}/c5.log"; echo "[verify] FAIL: the create under a free name failed — the lookup refused a name nobody holds" >&2; exit 1; }
if [ "$(state_field '.resources.NewQueue.physicalId')" != "$(queue_url "${NEWQ_FREE}")" ]; then
  echo "[verify] FAIL: state does not record NewQueue as ${NEWQ_FREE} after phase C5" >&2
  exit 1
fi
echo "[verify] phase C5 ok: NewQueue created as ${NEWQ_FREE}"

# ---------------------------------------------------------------------------
# PHASE F: destroy
# ---------------------------------------------------------------------------
echo "[verify] phase F: destroy ${STACK}"
# The load balancers deleted earlier (the out-of-band one after phase B7, the
# replaced one in phase C7) must have taken their interfaces out of the stack's
# subnet before the destroy deletes that subnet.
for l in "${LB_HELD}" "${LB_A}"; do
  wait_lb_enis_released "${l}" 600 \
    || { echo "[verify] FAIL: ${l}'s network interfaces are still in the subnet (or unreadable)" >&2; exit 1; }
done
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_queue_gone "${QUEUE_FREE}" "queue ${QUEUE_FREE} still exists after destroy"
assert_queue_gone "${NEWQ_FREE}" "queue ${NEWQ_FREE} still exists after destroy"
assert_topic_gone "${TOPIC_FREE}" "topic ${TOPIC_FREE} still exists after destroy"
assert_cluster_gone "${CLUSTER_A}" "ECS cluster ${CLUSTER_A} still exists after destroy"
assert_gone "repository ${REPO_FREE} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${REPO_FREE}" --region "${REGION}"
assert_elbv2_gone target-groups "${TG_FREE}" "target group ${TG_FREE} still exists after destroy"
assert_elbv2_gone target-groups "${FLAG_TG}" "target group ${FLAG_TG} still exists after destroy"
assert_elbv2_gone target-groups "${NTG_FREE}" "target group ${NTG_FREE} still exists after destroy"
assert_elbv2_gone load-balancers "${LB_FREE}" "load balancer ${LB_FREE} still exists after destroy"
assert_gone "subnet ${SUBNET_ID} still exists after destroy" \
  aws ec2 describe-subnets --subnet-ids "${SUBNET_ID}" --region "${REGION}"
assert_gone "VPC ${VPC_ID} still exists after destroy" \
  aws ec2 describe-vpcs --vpc-ids "${VPC_ID}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws elbv2 delete-target-group --target-group-arn "${TG_HELD_ARN}" --region "${REGION}"
aws elbv2 delete-target-group --target-group-arn "${NTG_HELD_ARN}" --region "${REGION}"
assert_elbv2_gone target-groups "${NTG_HELD}" "the out-of-band ${NTG_HELD} survived its own delete"
assert_elbv2_gone target-groups "${TG_HELD}" "the out-of-band ${TG_HELD} survived its own delete"
aws ecs delete-cluster --cluster "${CLUSTER_HELD}" --region "${REGION}" >/dev/null
assert_cluster_gone "${CLUSTER_HELD}" "the out-of-band ${CLUSTER_HELD} survived its own delete"
aws sns delete-topic --topic-arn "${TOPIC_HELD_ARN}" --region "${REGION}"
assert_topic_gone "${TOPIC_HELD}" "the out-of-band ${TOPIC_HELD} survived its own delete"
aws sqs delete-queue --queue-url "${QUEUE_HELD_URL}" --region "${REGION}"
assert_queue_gone "${QUEUE_HELD}" "the out-of-band ${QUEUE_HELD} survived its own delete"
aws sqs delete-queue --queue-url "${NEWQ_HELD_URL}" --region "${REGION}"
assert_queue_gone "${NEWQ_HELD}" "the out-of-band ${NEWQ_HELD} survived its own delete"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — a rename or a create onto a held name neither adopted it nor deleted the resource being replaced"
