#!/usr/bin/env bash
# verify.sh - cdkd s3-directory-bucket integ (issue #1344 destroy data guard
#             + issue #609 Tags as a handled property).
#
# Deploys TWO S3 Express Directory Buckets — one untagged (guard target) and
# one carrying template Tags including the `aws-cdk:auto-delete-objects`
# opt-in — then exercises:
#
#   Phase 1:  deploy; assert the create-time tags landed (S3 Control
#             list-tags-for-resource).
#   Phase 1c: UPDATE-mode redeploy; assert the tag mutation landed
#             (TagResource value change + UntagResource removal).
#   Phase 2:  put an object into BOTH buckets out of band.
#   Phase 3:  destroy — must FAIL on the untagged bucket (CloudFormation
#             parity: CFn DELETE_FAILs a non-empty directory bucket) with the
#             "is not empty" guard error; the guarded object must be intact
#             and the state file must survive. The TAGGED bucket must be GONE
#             in the same run (data-carrying auto-empty via the tag opt-in).
#   Phase 4:  delete the guarded object via plain AWS CLI, destroy again —
#             must SUCCEED; buckets + state file gone.
#   Phase 5:  go-to-k/cdkd#2007. A directory bucket NAMED FROM A SECRET
#             (`<secret>--<az>--x-s3`, the only resource under
#             S3DIR_SECRET_NAME) is given an object out of band and then
#             deleted through three delete sites in turn: (5a) `cdkd destroy`,
#             (5b) `cdkd rollback` of a `--no-rollback` deploy whose
#             RollbackBreaker failed after the bucket's create, (5c) a deploy
#             that dropped it from the template (S3DIR_DROP=true). Each delete
#             is refused (the bucket is not empty), and LOAD-BEARING each
#             refusal says the name is secret-derived and prints NO `aws s3 rm`
#             command; no log names the secret. Before the fix the provider had
#             no masker and rendered `aws s3 rm s3://<name> --recursive`, which
#             the printing bag turned into `s3://*** --recursive`, a command
#             naming no bucket. Each sub-phase then empties the bucket and
#             finishes its delete. Afterwards the secret is removed and every
#             object version under the stack's prefix (state, journal,
#             `deployments/`) is swept, on every exit path.
#
# Discrimination: revert the `maskSecrets` this PR threads (destroy-runner.ts
# for 5a, rollback-executor/replay-orphan-delete.ts for 5b,
# deploy-engine/delete.ts for 5c) or src/provisioning/providers/
# s3-directory-bucket-provider.ts ALONE and the matching sub-phase fails "the
# refusal prints an 'aws s3 rm' command" (not yet measured on real AWS).
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

set -euo pipefail

export AWS_PAGER=""

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

# shellcheck source=../s3-versions.sh
. ../s3-versions.sh

STACK="CdkdS3DirectoryBucketExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Resolved after deploy from the stack outputs; kept global for cleanup.
BUCKET=""
AUTO_BUCKET=""
ACCOUNT_ID=""

PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
# Phase 5 (go-to-k/cdkd#2007): one run's secret and the bucket name it builds.
# The base is unique per run and occurs in nothing else the logs print.
SECRET_BASE="sdb2007-$(date +%s)$$"
S3DIR_SECRET_NAME="cdkd-integ-s3dir-2007-$(date +%s)-$$"
SECRET_CREATED=""
SECRET_BUCKET=""
PHASE5_LOG=""
PHASE5_RUNS_LOG=""
SECRET_FILE=""

# Masks the secret in anything this script prints about a failure.
hide() { sed "s/${SECRET_BASE}/<SECRET_BASE>/g"; }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -n "${BUCKET}" ]; then
    aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${AUTO_BUCKET}" ]; then
    aws s3api delete-object --bucket "${AUTO_BUCKET}" --key "auto/emptied-by-cdkd.txt" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${SECRET_BUCKET}" ]; then
    aws s3api delete-object --bucket "${SECRET_BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null 2>&1
  fi
  destroy_rc=1
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  if [ -n "${BUCKET}" ]; then
    aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${AUTO_BUCKET}" ]; then
    aws s3api delete-bucket --bucket "${AUTO_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${SECRET_BUCKET}" ]; then
    aws s3api delete-bucket --bucket "${SECRET_BUCKET}" --region "${REGION}" >/dev/null 2>&1
  fi
  if [ -n "${SECRET_CREATED}" ]; then
    aws secretsmanager delete-secret --region "${REGION}" --secret-id "${S3DIR_SECRET_NAME}" \
      --force-delete-without-recovery >/dev/null 2>&1
  fi
  [ -n "${PHASE5_LOG}" ] && rm -f "${PHASE5_LOG}"
  [ -n "${PHASE5_RUNS_LOG}" ] && rm -f "${PHASE5_RUNS_LOG}"
  [ -n "${SECRET_FILE}" ] && rm -f "${SECRET_FILE}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    # Phase 5 puts the secret's reference into state, and the name it builds
    # into the physical id and the `deployments/` events: no version under the
    # stack's prefix may outlive the run. `all` only once the destroy
    # succeeded: a failed one keeps the state.json a recovery needs, so then
    # only the noncurrent versions go.
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
      s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PREFIX}" all || true
    else
      s3_purge_prefix_versions "${STATE_BUCKET:-}" "${PREFIX}" noncurrent || true
    fi
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

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# read_tag <bucket-name> <tag-key> -> prints the tag value ('' when absent)
read_tag() {
  local bucket="$1" key="$2" tags_json
  tags_json="$(aws s3control list-tags-for-resource \
    --account-id "${ACCOUNT_ID}" \
    --resource-arn "arn:aws:s3express:${REGION}:${ACCOUNT_ID}:bucket/${bucket}" \
    --region "${REGION}" --output json)" || return 1
  printf '%s' "${tags_json}" | jq -r --arg k "${key}" '.Tags[] | select(.Key == $k) | .Value'
}

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
BUCKET=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.BucketName // empty')
AUTO_BUCKET=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.AutoBucketName // empty')
if [ -z "${BUCKET}" ] || [ -z "${AUTO_BUCKET}" ]; then
  echo "FAIL: could not read BucketName/AutoBucketName outputs from cdkd state" >&2
  exit 1
fi
echo "    Guard bucket:  ${BUCKET}"
echo "    Tagged bucket: ${AUTO_BUCKET}"

echo "==> Phase 1: asserting create-time tags landed (issue #609)"
V=$(read_tag "${AUTO_BUCKET}" "aws-cdk:auto-delete-objects")
if [ "${V}" != "true" ]; then
  echo "FAIL: aws-cdk:auto-delete-objects tag expected 'true', got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "cdkd-integ")
if [ "${V}" != "initial" ]; then
  echo "FAIL: cdkd-integ tag expected 'initial', got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "transient")
if [ "${V}" != "drop-me" ]; then
  echo "FAIL: transient tag expected 'drop-me', got '${V}'" >&2
  exit 1
fi
echo "    OK: create-time tags present on the directory bucket"

# --- Phase 1c: UPDATE-mode redeploy mutates the tag set ---------------------
echo "==> Phase 1c: UPDATE-mode redeploy (tag value change + tag removal)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

V=$(read_tag "${AUTO_BUCKET}" "cdkd-integ")
if [ "${V}" != "updated" ]; then
  echo "FAIL: cdkd-integ tag expected 'updated' after UPDATE deploy, got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "transient")
if [ -n "${V}" ]; then
  echo "FAIL: transient tag should have been removed by UntagResource, got '${V}'" >&2
  exit 1
fi
V=$(read_tag "${AUTO_BUCKET}" "aws-cdk:auto-delete-objects")
if [ "${V}" != "true" ]; then
  echo "FAIL: aws-cdk:auto-delete-objects tag lost across the UPDATE deploy (got '${V}')" >&2
  exit 1
fi
echo "    OK: tag update landed (value changed, removed key untagged, opt-in kept)"

# --- Phase 2: load data out of band ----------------------------------------
echo "==> Phase 2: putting an object into BOTH directory buckets"
echo "guard-data" > /tmp/cdkd-ddbg-obj.txt
aws s3api put-object --bucket "${BUCKET}" --key "guard/keep-me.txt" \
  --body /tmp/cdkd-ddbg-obj.txt --region "${REGION}" >/dev/null
aws s3api put-object --bucket "${AUTO_BUCKET}" --key "auto/emptied-by-cdkd.txt" \
  --body /tmp/cdkd-ddbg-obj.txt --region "${REGION}" >/dev/null
rm -f /tmp/cdkd-ddbg-obj.txt

# --- Phase 3: destroy must FAIL on the guard bucket, empty+delete the tagged one
echo "==> Phase 3: destroy (guard bucket must FAIL; tagged bucket must auto-empty)"
set +e
DESTROY1_LOG=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1)
DESTROY1_RC=$?
set -e
printf '%s\n' "${DESTROY1_LOG}"

if [ "${DESTROY1_RC}" -eq 0 ]; then
  echo "FAIL: destroy SUCCEEDED — the directory-bucket data guard did not fire" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY1_LOG}" | grep -q "is not empty"; then
  echo "FAIL: destroy output lacks the 'is not empty' guard error" >&2
  exit 1
fi
echo "    OK: destroy failed with the guard error (CFn DELETE_FAILED parity)"

# The remedy's pasteable command must name THIS bucket, rendered BARE: a real
# directory-bucket name is clean, so the shared renderer neither quotes nor
# suppresses it (issue #3270 — the quoted / suppressed arms need a name AWS
# refuses to create, so they are unit-pinned). The sentinel is the remedy's
# lead-in, a different substring from the parsed command, so a reworded or
# suppressed command fails HERE instead of reading as "no command expected".
if ! printf '%s' "${DESTROY1_LOG}" | grep -qF "Delete all objects first"; then
  echo "FAIL: guard error lacks its 'Delete all objects first' remedy" >&2
  exit 1
fi
if ! printf '%s' "${DESTROY1_LOG}" | grep -qF "aws s3 rm s3://${BUCKET} --recursive"; then
  echo "FAIL: guard remedy does not carry the bare 'aws s3 rm s3://${BUCKET} --recursive' command" >&2
  exit 1
fi
echo "    OK: guard remedy names the bucket in a bare pasteable command"

# Guarded data must be intact and the state file must survive.
aws s3api head-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null
echo "    OK: guarded object intact + state file survives the failed destroy"

# The tagged sibling must be GONE in the same run: the opt-in auto-empty
# deleted its data-carrying bucket (issue #609 live-exercise).
assert_gone "tagged directory bucket '${AUTO_BUCKET}' survived the destroy despite the auto-delete opt-in" \
  aws s3api head-bucket --bucket "${AUTO_BUCKET}" --region "${REGION}"
echo "    OK: tagged bucket auto-emptied and deleted in the same destroy"

# --- Phase 4: manual empty, then destroy must SUCCEED -----------------------
echo "==> Phase 4: delete the guarded object manually, destroy again"
aws s3api delete-object --bucket "${BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null

node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "directory bucket '${BUCKET}' still exists after second destroy" \
  aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: second destroy clean — buckets + state gone"

# --- Phase 5: a secret-named bucket's not-empty refusal (go-to-k/cdkd#2007)
echo "==> Phase 5: delete a non-empty directory bucket named from a secret, three ways"
AZ_ID="$(aws ec2 describe-availability-zones --region "${REGION}" --zone-names "${REGION}c" \
  --query 'AvailabilityZones[0].ZoneId' --output text)"
if [ -z "${AZ_ID}" ] || [ "${AZ_ID}" = "None" ]; then
  echo "FAIL: premise: could not read the zone id of ${REGION}c" >&2
  exit 1
fi
SECRET_BUCKET="${SECRET_BASE}--${AZ_ID}--x-s3"
# The secret travels through a 0600 file, never argv.
SECRET_FILE="$(mktemp -t s3-directory-bucket-2007-secret.XXXXXX)"
chmod 600 "${SECRET_FILE}"
printf '%s' "${SECRET_BASE}" > "${SECRET_FILE}"
aws secretsmanager create-secret --region "${REGION}" --name "${S3DIR_SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" >/dev/null
rm -f "${SECRET_FILE}"
SECRET_FILE=""
SECRET_CREATED=1
PHASE5_LOG="$(mktemp -t s3-directory-bucket-2007.XXXXXX)"
# Every other cdkd run of Phase 5 appends here; none may name the secret.
PHASE5_RUNS_LOG="$(mktemp -t s3-directory-bucket-2007-runs.XXXXXX)"
export S3DIR_SECRET_NAME S3DIR_AZ_ID="${AZ_ID}"


put_guard_object() {
  local body
  body="$(mktemp -t s3-directory-bucket-2007-obj.XXXXXX)"
  printf 'guard-data\n' > "${body}"
  aws s3api put-object --bucket "${SECRET_BUCKET}" --key "guard/keep-me.txt" \
    --body "${body}" --region "${REGION}" >/dev/null
  rm -f "${body}"
}

# assert_refusal_withholds <what>: the log in PHASE5_LOG carries the refusal,
# and the refusal neither names the secret nor prints a command.
assert_refusal_withholds() {
  local what="$1" marker
  # PREMISE: the refusal fired and reached the log; its lead-in is the
  # sentinel, a different substring from the ones asserted below.
  for marker in "is not empty" "Delete all objects first"; do
    if ! grep -qF -- "${marker}" "${PHASE5_LOG}"; then
      echo "FAIL: premise: the ${what} log has no '${marker}' line (the delete was not refused, or the wording drifted)" >&2
      tail -40 "${PHASE5_LOG}" | hide >&2
      exit 1
    fi
  done
  # LOAD-BEARING (go-to-k/cdkd#2007).
  if ! grep -qF -- "the bucket name is derived from a secret, so cdkd does not print it" "${PHASE5_LOG}"; then
    echo "FAIL: the ${what} refusal does not say the bucket name is secret-derived (DeleteContext.maskSecrets did not reach the provider)" >&2
    grep -nF -- "is not empty" "${PHASE5_LOG}" | hide >&2
    exit 1
  fi
  if grep -qF -- "aws s3 rm" "${PHASE5_LOG}"; then
    echo "FAIL: the ${what} refusal prints an 'aws s3 rm' command for a secret-derived bucket name (go-to-k/cdkd#2007)" >&2
    grep -nF -- "aws s3 rm" "${PHASE5_LOG}" | hide >&2
    exit 1
  fi
  if grep -qF -- "${SECRET_BASE}" "${PHASE5_LOG}"; then
    echo "FAIL: the ${what} log names the secret in plaintext: \${SECRET_BASE}" >&2
    exit 1
  fi
  # The refused delete left the bucket and its object in place.
  aws s3api head-object --bucket "${SECRET_BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null
  echo "    OK: the ${what} refusal withholds the secret-derived name and prints no command"
}

# p5run <cmd...>: run a Phase 5 cdkd command into PHASE5_RUNS_LOG, printing
# its tail through `hide` if it fails.
p5run() {
  if ! "$@" >> "${PHASE5_RUNS_LOG}" 2>&1; then
    echo "FAIL: '$*' exited non-zero; its log tail:" | hide >&2
    tail -40 "${PHASE5_RUNS_LOG}" | hide >&2
    exit 1
  fi
}

empty_secret_bucket() {
  aws s3api delete-object --bucket "${SECRET_BUCKET}" --key "guard/keep-me.txt" --region "${REGION}" >/dev/null
}

# The canonical gone_probe echoes its argv on an undetermined probe, and the
# argv names the secret-derived bucket: run it in a subshell and print its
# complaint through `hide`.
assert_secret_bucket_gone() {
  local err rc=0
  err="$( (gone_probe aws s3api head-bucket --bucket "${SECRET_BUCKET}" --region "${REGION}") 2>&1)" || rc=$?
  if [ -n "${err}" ]; then
    printf '%s\n' "${err}" | hide >&2
    exit 1
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: the secret-named directory bucket still exists after $1" >&2
    exit 1
  fi
}

# --- 5a: cdkd destroy -------------------------------------------------------
echo "==> Phase 5a: cdkd destroy of the non-empty secret-named bucket"
p5run node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
aws s3api head-bucket --bucket "${SECRET_BUCKET}" --region "${REGION}" >/dev/null
put_guard_object
set +e
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --verbose --yes > "${PHASE5_LOG}" 2>&1
P5_RC=$?
set -e
if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: premise: the destroy of the non-empty secret-named bucket exited 0" >&2
  exit 1
fi
assert_refusal_withholds "destroy"
empty_secret_bucket
p5run node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_secret_bucket_gone "Phase 5a's second destroy"

# --- 5b: cdkd rollback ------------------------------------------------------
echo "==> Phase 5b: cdkd rollback of the bucket a failed --no-rollback deploy created"
set +e
S3DIR_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes --no-rollback > "${PHASE5_LOG}" 2>&1
P5_RC=$?
set -e
if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: premise: the S3DIR_FAIL deploy exited 0 (RollbackBreaker was not refused)" >&2
  exit 1
fi
cat "${PHASE5_LOG}" >> "${PHASE5_RUNS_LOG}"
aws s3api head-bucket --bucket "${SECRET_BUCKET}" --region "${REGION}" >/dev/null
put_guard_object
set +e
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --force --verbose > "${PHASE5_LOG}" 2>&1
P5_RC=$?
set -e
if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: premise: the rollback that deletes the non-empty secret-named bucket exited 0" >&2
  exit 1
fi
assert_refusal_withholds "rollback"
empty_secret_bucket
p5run node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --stack-region "${REGION}" --force
assert_secret_bucket_gone "Phase 5b's second rollback"

# --- 5c: a deploy that drops the bucket from the template ---------------------
echo "==> Phase 5c: a deploy that removed the non-empty secret-named bucket from its template"
p5run node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
put_guard_object
set +e
S3DIR_DROP=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --verbose --yes > "${PHASE5_LOG}" 2>&1
P5_RC=$?
set -e
if [ "${P5_RC}" -eq 0 ]; then
  echo "FAIL: premise: the deploy dropping the non-empty secret-named bucket exited 0" >&2
  exit 1
fi
assert_refusal_withholds "template-removal deploy"
empty_secret_bucket
S3DIR_DROP=true p5run node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
assert_secret_bucket_gone "Phase 5c's second deploy"
S3DIR_DROP=true p5run node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --yes
# None of the uncaptured runs above named the secret either.
if grep -qF -- "${SECRET_BASE}" "${PHASE5_RUNS_LOG}"; then
  echo "FAIL: a Phase 5 cdkd run names the secret in plaintext: \${SECRET_BASE}" >&2
  exit 1
fi
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after Phase 5's destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

aws secretsmanager delete-secret --region "${REGION}" --secret-id "${S3DIR_SECRET_NAME}" \
  --force-delete-without-recovery >/dev/null
SECRET_CREATED=""

# SUCCESS path: disarm the trap, then sweep every version under the stack's
# prefix (state, journal, deployments/) and assert none is left.
trap - EXIT INT TERM
rm -f "${PHASE5_LOG}" "${PHASE5_RUNS_LOG}"
PHASE5_LOG=""
PHASE5_RUNS_LOG=""
aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PREFIX}" "stack state teardown"

echo ""
echo "==> s3-directory-bucket test passed (tags landed + updated, guard fired with data intact, tagged bucket auto-emptied, clean second destroy, secret-named bucket's refusal withholds the name on destroy, rollback and template removal)"
