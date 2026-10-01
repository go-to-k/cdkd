#!/usr/bin/env bash
# verify.sh — a replacement renamed onto a name ANOTHER resource holds must
# neither adopt that resource nor delete the one being replaced
# (issues #3937 and #3931).
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
#   D. #3931 ARM. Create REPO_HELD out of band, then rename Repo onto it under
#      `--recreate-via-cc-api Repo`. The deploy must FAIL with the create-first
#      collision and delete nothing: REPO_A keeps its createdAt, REPO_HELD
#      survives, state still records REPO_A on the SDK route. Before the fix
#      REPO_A was destroyed first.
#   E. CONTROL for D: remove REPO_HELD, rename Repo onto REPO_FREE under the
#      same flag. It must create REPO_FREE BEFORE deleting REPO_A (read off the
#      log order), and record REPO_FREE on the Cloud Control route.
#   F. Destroy; every queue, topic, cluster, repository and the state file are
#      gone.
#
# After a run killed with SIGKILL (no trap runs), clear by hand the queues,
# topics, ECS clusters and ECR repositories whose names start `cdkd-integ-rroh-` — the
# out-of-band holders carry a per-run suffix after `cdkd-integ-rroh-*-held-`,
# so a later run's pre-flight check does not see them.
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
ALL_QUEUES="${QUEUE_A} ${QUEUE_HELD} ${QUEUE_FREE}"
ALL_TOPICS="${TOPIC_A} ${TOPIC_HELD} ${TOPIC_FREE}"
ALL_CLUSTERS="${CLUSTER_A} ${CLUSTER_HELD} ${CLUSTER_FREE}"
ALL_REPOS="${REPO_A} ${REPO_HELD} ${REPO_FREE}"

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
  node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
    --region "${REGION}" --yes >/dev/null 2>&1 || true
  for q in ${ALL_QUEUES}; do delete_queue_best_effort "${q}"; done
  for t in ${ALL_TOPICS}; do delete_topic_best_effort "${t}"; done
  for c in ${ALL_CLUSTERS}; do delete_cluster_best_effort "${c}"; done
  for r in ${ALL_REPOS}; do delete_repo_best_effort "${r}"; done
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
echo "[verify] phase A: deploy ${STACK} (Queue=${QUEUE_A}, Topic=${TOPIC_A}, Cluster=${CLUSTER_A}, Repo=${REPO_A})"
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
# PHASE F: destroy
# ---------------------------------------------------------------------------
echo "[verify] phase F: destroy ${STACK}"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_queue_gone "${QUEUE_FREE}" "queue ${QUEUE_FREE} still exists after destroy"
assert_topic_gone "${TOPIC_FREE}" "topic ${TOPIC_FREE} still exists after destroy"
assert_cluster_gone "${CLUSTER_A}" "ECS cluster ${CLUSTER_A} still exists after destroy"
assert_gone "repository ${REPO_FREE} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${REPO_FREE}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
aws ecs delete-cluster --cluster "${CLUSTER_HELD}" --region "${REGION}" >/dev/null
assert_cluster_gone "${CLUSTER_HELD}" "the out-of-band ${CLUSTER_HELD} survived its own delete"
aws sns delete-topic --topic-arn "${TOPIC_HELD_ARN}" --region "${REGION}"
assert_topic_gone "${TOPIC_HELD}" "the out-of-band ${TOPIC_HELD} survived its own delete"
aws sqs delete-queue --queue-url "${QUEUE_HELD_URL}" --region "${REGION}"
assert_queue_gone "${QUEUE_HELD}" "the out-of-band ${QUEUE_HELD} survived its own delete"
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/" --recursive >/dev/null 2>&1 || true

rm -rf "${LOG_DIR}"
trap - EXIT INT TERM
echo "[verify] PASS — a rename onto a held name neither adopted it nor deleted the resource being replaced"
