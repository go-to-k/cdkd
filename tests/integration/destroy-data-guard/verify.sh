#!/usr/bin/env bash
# verify.sh - cdkd destroy-data-guard integ (issue #1340).
#
# Exercises BOTH sides of the CloudFormation-parity destroy data guard in one
# run:
#
#   Phase 1: deploy 4 resources — a guarded bucket (no opt-in) + a guarded ECR
#            repo (no EmptyOnDelete), plus an opted-in VERSIONED bucket
#            (aws-cdk:auto-delete-objects tag) + an opted-in repo
#            (EmptyOnDelete: true).
#   Phase 2: load data into ALL FOUR out of band (objects; for the versioned
#            opt-in bucket 2 versions + a delete marker; docker-push a tiny
#            image into both repos).
#   Phase 3: first destroy — must FAIL (non-zero) with the guard errors for
#            the guarded pair while the SAME run force-cleans the opted-in
#            pair. Assertions: guarded bucket + object intact, guarded repo +
#            image intact, opt-in bucket GONE (versions + delete marker
#            auto-emptied), opt-in repo GONE, state file still present
#            (partial destroy).
#   Phase 4: AWS-native data cleanup (delete the guarded object + image),
#            second destroy — must SUCCEED; everything + state file gone.
#
# Requires docker (image push into the repos) — fails fast when unavailable.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

STACK="CdkdDestroyDataGuardExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

GUARDED_BUCKET="cdkd-test-ddg-guarded-${ACCOUNT_ID}"
OPTIN_BUCKET="cdkd-test-ddg-optin-${ACCOUNT_ID}"
GUARDED_REPO="cdkd-test-ddg-guarded-repo"
OPTIN_REPO="cdkd-test-ddg-optin-repo"
ECR_HOST="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com"
SEED_IMAGE="public.ecr.aws/docker/library/busybox:stable"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# empty_bucket_all_versions <bucket> — best-effort full empty (versions +
# delete markers) for cleanup. Subshell body with set +eu per the cleanup
# convention so a partial listing never aborts the sweep.
empty_bucket_all_versions() { (
  set +eu
  local bucket="$1"
  local versions
  versions=$(aws s3api list-object-versions --bucket "${bucket}" --region "${REGION}" \
    --query '{Objects: [Versions[].{Key:Key,VersionId:VersionId}, DeleteMarkers[].{Key:Key,VersionId:VersionId}][] | [0:1000]}' \
    --output json 2>/dev/null)
  if [ -n "${versions}" ] && [ "$(printf '%s' "${versions}" | tr -d '[:space:]')" != '{"Objects":null}' ] && [ "$(printf '%s' "${versions}" | tr -d '[:space:]')" != '{"Objects":[]}' ]; then
    aws s3api delete-objects --bucket "${bucket}" --region "${REGION}" \
      --delete "${versions}" >/dev/null 2>&1
  fi
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # Empty data first so the state destroy can proceed even with the guard on.
  empty_bucket_all_versions "${GUARDED_BUCKET}"
  empty_bucket_all_versions "${OPTIN_BUCKET}"
  aws ecr batch-delete-image --repository-name "${GUARDED_REPO}" --region "${REGION}" \
    --image-ids imageTag=hunt >/dev/null 2>&1
  aws ecr batch-delete-image --repository-name "${OPTIN_REPO}" --region "${REGION}" \
    --image-ids imageTag=hunt >/dev/null 2>&1
  destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Belt-and-braces direct deletes in case state destroy missed them.
  aws s3api delete-bucket --bucket "${GUARDED_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  aws s3api delete-bucket --bucket "${OPTIN_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  aws ecr delete-repository --repository-name "${GUARDED_REPO}" --region "${REGION}" --force >/dev/null 2>&1
  aws ecr delete-repository --repository-name "${OPTIN_REPO}" --region "${REGION}" --force >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  set -eu
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo "FAIL: docker is required (image push into the ECR repos) but unavailable" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# --- Phase 2: load data into all four resources out of band ----------------
echo "==> Phase 2: loading data (objects + image pushes)"
echo "guarded-user-data" | aws s3 cp - "s3://${GUARDED_BUCKET}/data/keep-me.txt" --region "${REGION}"
echo "v1" | aws s3 cp - "s3://${OPTIN_BUCKET}/doc.txt" --region "${REGION}"
echo "v2" | aws s3 cp - "s3://${OPTIN_BUCKET}/doc.txt" --region "${REGION}"
aws s3 rm "s3://${OPTIN_BUCKET}/doc.txt" --region "${REGION}"   # creates a delete marker

docker pull -q "${SEED_IMAGE}" >/dev/null
aws ecr get-login-password --region "${REGION}" | docker login --username AWS --password-stdin "${ECR_HOST}" >/dev/null 2>&1
docker tag "${SEED_IMAGE}" "${ECR_HOST}/${GUARDED_REPO}:hunt"
docker tag "${SEED_IMAGE}" "${ECR_HOST}/${OPTIN_REPO}:hunt"
docker push -q "${ECR_HOST}/${GUARDED_REPO}:hunt" >/dev/null
docker push -q "${ECR_HOST}/${OPTIN_REPO}:hunt" >/dev/null
echo "    OK: data loaded (2 buckets with objects, 2 repos with an image)"

# --- Phase 3: first destroy must FAIL on the guarded pair -------------------
echo "==> Phase 3: destroy (expecting FAILURE on the guarded bucket + repo)"
set +e
DESTROY1_LOG=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DESTROY1_RC=$?
set -e
printf '%s\n' "${DESTROY1_LOG}"

if [ "${DESTROY1_RC}" -eq 0 ]; then
  echo "FAIL: first destroy SUCCEEDED — the data guard did not fire (guarded bucket/repo were force-cleaned?)" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY1_LOG}" | grep -q "is not empty"; then
  echo "FAIL: first destroy output lacks the S3 'is not empty' guard error" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY1_LOG}" | grep -q "still contains images"; then
  echo "FAIL: first destroy output lacks the ECR 'still contains images' guard error" >&2
  exit 1
fi
echo "    OK: destroy failed with both guard errors (CFn DELETE_FAILED parity)"

# Guarded data must be fully intact.
aws s3api head-object --bucket "${GUARDED_BUCKET}" --key "data/keep-me.txt" --region "${REGION}" >/dev/null
IMAGE_TAGS=$(aws ecr list-images --repository-name "${GUARDED_REPO}" --region "${REGION}" \
  --query 'imageIds[].imageTag' --output text)
if [ "${IMAGE_TAGS}" != "hunt" ]; then
  echo "FAIL: guarded repo image missing after failed destroy (tags: '${IMAGE_TAGS}')" >&2
  exit 1
fi
echo "    OK: guarded bucket object + guarded repo image intact"

# Opted-in pair must be force-cleaned by the SAME run.
assert_gone "opt-in bucket '${OPTIN_BUCKET}' still exists after destroy (auto-empty opt-in not honored)" \
  aws s3api head-bucket --bucket "${OPTIN_BUCKET}" --region "${REGION}"
assert_gone "opt-in repo '${OPTIN_REPO}' still exists after destroy (EmptyOnDelete not honored)" \
  aws ecr describe-repositories --repository-names "${OPTIN_REPO}" --region "${REGION}"
echo "    OK: opted-in bucket (versions + delete marker) and repo force-cleaned in the same run"

# Partial destroy keeps the state file (guarded resources still tracked).
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    OK: state file survives the partial destroy"

# --- Phase 4: AWS-native cleanup, then destroy must SUCCEED -----------------
echo "==> Phase 4: empty the guarded data manually, destroy again"
aws s3api delete-object --bucket "${GUARDED_BUCKET}" --key "data/keep-me.txt" --region "${REGION}" >/dev/null
aws ecr batch-delete-image --repository-name "${GUARDED_REPO}" --region "${REGION}" \
  --image-ids imageTag=hunt >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "guarded bucket '${GUARDED_BUCKET}' still exists after second destroy" \
  aws s3api head-bucket --bucket "${GUARDED_BUCKET}" --region "${REGION}"
assert_gone "guarded repo '${GUARDED_REPO}' still exists after second destroy" \
  aws ecr describe-repositories --repository-names "${GUARDED_REPO}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: second destroy clean — everything gone"

echo ""
echo "==> destroy-data-guard test passed (guard fired + data intact on the guarded pair, opt-ins force-cleaned, clean second destroy)"
