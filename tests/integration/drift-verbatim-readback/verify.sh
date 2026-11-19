#!/usr/bin/env bash
# verify.sh -- readback probe for go-to-k/cdkd#6624 / #6627.
#
# Deploys object-form resource policies (S3, SQS, SNS, KMS, ECR, Secrets
# Manager, the Cloud Control-routed IAM inline policies, IAM Policy and
# ManagedPolicy) and IAM principals that declare no attachment-class key, then
# RECORDS what cdkd's readers return for each: the deploy-time readback
# (`observedProperties`, from `cdkd state show --json`), a summary of the keys
# only the readback holds (summarize-readback.ts), `cdkd drift --json` on the
# observed baseline, the same on the template-only baseline (strip-all-observed.ts),
# and a second readback after `cdkd state refresh-observed`. Every file lands
# in one artifact directory whose path is printed at the end.
#
# This phase asserts only that every step ran and that the destroy left
# nothing behind; the readback decides which types get a verbatim-key row.

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
  if ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${out}"; then
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

STACK="CdkdDriftVerbatimReadbackExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ARTIFACT_DIR="${DVR_ARTIFACT_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/cdkd-dvr.XXXXXX")}"
mkdir -p "${ARTIFACT_DIR}"

BUCKET_PREFIX="cdkd-dvr-"
QUEUE="cdkd-dvr-queue"
TOPIC="cdkd-dvr-topic"
REPO="cdkd-dvr-repo"
SECRET="cdkd-dvr-secret"
SIB_ROLE="cdkd-dvr-sibling-role"
SIB_USER="cdkd-dvr-sibling-user"
SIB_GROUP="cdkd-dvr-sibling-group"
BARE_ROLE="cdkd-dvr-bare-role"
BARE_USER="cdkd-dvr-bare-user"
BARE_GROUP="cdkd-dvr-bare-group"
MP_NAME="cdkd-dvr-managed-policy"
KEY_ID=""

# Strip every inline and attached policy from a principal, then delete it.
# $1 = role | user | group, $2 = name.
delete_principal() {
  local kind="$1" name="$2" flag p
  case "${kind}" in
    role) flag="--role-name" ;;
    user) flag="--user-name" ;;
    group) flag="--group-name" ;;
    *) return 0 ;;
  esac
  for p in $(aws iam "list-${kind}-policies" "${flag}" "${name}" --query 'PolicyNames' --output text 2>/dev/null); do
    aws iam "delete-${kind}-policy" "${flag}" "${name}" --policy-name "${p}" >/dev/null 2>&1 || true
  done
  for p in $(aws iam "list-attached-${kind}-policies" "${flag}" "${name}" --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null); do
    aws iam "detach-${kind}-policy" "${flag}" "${name}" --policy-arn "${p}" >/dev/null 2>&1 || true
  done
  if [ "${kind}" = "role" ]; then
    aws iam delete-role-permissions-boundary --role-name "${name}" >/dev/null 2>&1 || true
  fi
  aws iam "delete-${kind}" "${flag}" "${name}" >/dev/null 2>&1 || true
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  if [ -n "${ACCOUNT:-}" ]; then
    aws s3 rb "s3://${BUCKET_PREFIX}${ACCOUNT}-${REGION}" --force >/dev/null 2>&1 || true
    aws sns delete-topic --topic-arn "arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${TOPIC}" --region "${REGION}" >/dev/null 2>&1 || true
    aws iam delete-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}" >/dev/null 2>&1 || true
  fi
  q_url=$(aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null) &&
    aws sqs delete-queue --queue-url "${q_url}" --region "${REGION}" >/dev/null 2>&1
  aws ecr delete-repository --repository-name "${REPO}" --force --region "${REGION}" >/dev/null 2>&1 || true
  aws secretsmanager delete-secret --secret-id "${SECRET}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${KEY_ID}" ]; then
    aws kms schedule-key-deletion --key-id "${KEY_ID}" --pending-window-in-days 7 --region "${REGION}" >/dev/null 2>&1 || true
  fi
  # The managed policy is detached here before its own delete below can run.
  for r in "${SIB_ROLE}" "${BARE_ROLE}"; do delete_principal role "${r}"; done
  for u in "${SIB_USER}" "${BARE_USER}"; do delete_principal user "${u}"; done
  for g in "${SIB_GROUP}" "${BARE_GROUP}"; do delete_principal group "${g}"; done
  if [ -n "${ACCOUNT:-}" ]; then
    aws iam delete-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}" >/dev/null 2>&1 || true
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  echo "    readback artifacts: ${ARTIFACT_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
PARTITION=$(aws sts get-caller-identity --query Arn --output text | cut -d: -f2)
echo "==> Pre-run cleanup"; cleanup

# Deploy WITH the observed capture (the default), so state records each
# resource's deploy-time `readCurrentState` output to read back below.
echo "==> Deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes

# `drift` exits 0 clean, 1 drifted, 2 refused; any of the three is a result
# to record here, anything else is a failure of the run.
run_drift() { # $1 = output file
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --json >"$1" || rc=$?
  case "${rc}" in
    0 | 1 | 2) echo "    drift rc=${rc} -> $1" ;;
    *) echo "FAIL: cdkd drift exited ${rc}" >&2; exit 1 ;;
  esac
}
show_state() { # $1 = output file
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --json >"$1"
}

echo "==> Record the deploy-time readback"
show_state "${ARTIFACT_DIR}/state-show-deploy.json"
node summarize-readback.ts "${ARTIFACT_DIR}/state-show-deploy.json" >"${ARTIFACT_DIR}/summary-deploy.json"
KEY_ID=$(node -e '
  const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).state.resources;
  const id = Object.keys(s).find((k) => s[k].resourceType === "AWS::KMS::Key");
  process.stdout.write(id ? String(s[id].physicalId) : "");
' "${ARTIFACT_DIR}/state-show-deploy.json")
[ -n "${KEY_ID}" ] || { echo "FAIL: no AWS::KMS::Key physical id in state" >&2; exit 1; }
missing=$(node -e '
  const s = require(process.argv[1]);
  process.stdout.write(Object.keys(s).filter((k) => !s[k].hasObserved).join(" "));
' "${ARTIFACT_DIR}/summary-deploy.json")
echo "    resources without a deploy-time readback: ${missing:-none}"

echo "==> Drift on the observed baseline"
run_drift "${ARTIFACT_DIR}/drift-observed.json"

echo "==> Drift on the template-only baseline"
STACK="${STACK}" STATE_BUCKET="${STATE_BUCKET}" AWS_REGION="${REGION}" node strip-all-observed.ts
run_drift "${ARTIFACT_DIR}/drift-template-only.json"

echo "==> Second readback via state refresh-observed"
node "${LOCAL_DIST}" state refresh-observed "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
show_state "${ARTIFACT_DIR}/state-show-refresh.json"
node summarize-readback.ts "${ARTIFACT_DIR}/state-show-refresh.json" >"${ARTIFACT_DIR}/summary-refresh.json"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force

assert_gone "bucket ${BUCKET_PREFIX}${ACCOUNT}-${REGION} still exists after destroy" \
  aws s3api head-bucket --bucket "${BUCKET_PREFIX}${ACCOUNT}-${REGION}" --region "${REGION}"
assert_gone "topic ${TOPIC} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "arn:${PARTITION}:sns:${REGION}:${ACCOUNT}:${TOPIC}" --region "${REGION}"
assert_gone "repository ${REPO} still exists after destroy" \
  aws ecr describe-repositories --repository-names "${REPO}" --region "${REGION}"
assert_gone "managed policy ${MP_NAME} still exists after destroy" \
  aws iam get-policy --policy-arn "arn:${PARTITION}:iam::${ACCOUNT}:policy/${MP_NAME}"
for r in "${SIB_ROLE}" "${BARE_ROLE}"; do
  assert_gone "role ${r} still exists after destroy" aws iam get-role --role-name "${r}"
done
for u in "${SIB_USER}" "${BARE_USER}"; do
  assert_gone "user ${u} still exists after destroy" aws iam get-user --user-name "${u}"
done
for g in "${SIB_GROUP}" "${BARE_GROUP}"; do
  assert_gone "group ${g} still exists after destroy" aws iam get-group --group-name "${g}"
done
# SQS and Secrets Manager settle a delete asynchronously.
for probe in queue secret; do
  GONE=""
  for _ in $(seq 1 24); do
    if [ "${probe}" = queue ]; then
      gone_probe aws sqs get-queue-url --queue-name "${QUEUE}" --region "${REGION}" && { GONE=1; break; }
    else
      gone_probe aws secretsmanager describe-secret --secret-id "${SECRET}" --region "${REGION}" && { GONE=1; break; }
    fi
    sleep 5
  done
  [ -n "${GONE}" ] || { echo "FAIL: ${probe} still exists after destroy" >&2; exit 1; }
done
# A deleted KMS key stays readable through its pending window; 7 days is the
# AWS minimum, so PendingDeletion is the terminal state of a deleted key.
key_state=$(aws kms describe-key --key-id "${KEY_ID}" --region "${REGION}" --query 'KeyMetadata.KeyState' --output text)
[ "${key_state}" = "PendingDeletion" ] || { echo "FAIL: key ${KEY_ID} is ${key_state} after destroy, expected PendingDeletion" >&2; exit 1; }
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: every resource gone"

trap - EXIT INT TERM
echo "    readback artifacts: ${ARTIFACT_DIR}"
echo "[verify] PASS -- drift-verbatim-readback recorded readbacks in ${ARTIFACT_DIR}"
