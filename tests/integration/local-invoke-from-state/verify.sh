#!/usr/bin/env bash
#
# End-to-end real-AWS validation for `cdkd local invoke --from-state`
# (PR 2 of #224).
#
# Why this exists: PR 1's integ (`tests/integration/local-invoke/`) was
# fully local — no AWS deploy. PR 2's `--from-state` reads cdkd's S3
# state for an actually-deployed stack and substitutes intrinsic-valued
# env vars with the deployed physical IDs. The only way to exercise
# that round-trip is to deploy + invoke + destroy against real AWS.
#
# Steps:
#   1. install + build cdkd (root) + install fixture deps + docker pull
#   2. cdkd deploy CdkdLocalInvokeFromStateFixture
#   3. PR 1 baseline: cdkd local invoke (no --from-state) — assert
#      BUCKET_NAME comes through as "unset" (env var dropped because
#      it's intrinsic-valued and PR 1 warns + drops).
#   4. PR 2: cdkd local invoke --from-state — assert BUCKET_NAME is the
#      actual deployed S3 bucket name, and STATIC_VALUE still passes
#      through unchanged.
#   4b/4c (issue #1836): the same --from-state read with an UPPER-CASED
#      --stack-region against the canonically-keyed state record, plus the
#      canonical counter-case asserting byte-identical output. No extra
#      deploy — it reuses the stack from step 2.
#   4e (issue #3230): --from-state --role-arn <the stack's state-read role> —
#      the state is read as the role, and ACCOUNT_TAG's ${AWS::AccountId}
#      must still resolve (the role's account, which is the caller's here).
#   4f-4h (issue #2056): a secret-bearing cross-stack output. The producer
#      stack exports a `{{resolve:secretsmanager:...}}` reference, which cdkd
#      persists REDACTED back to the token; the consumer's EchoSecretHandler
#      imports it (IMPORTED_SECRET) and also carries the same reference
#      directly (SAME_STACK_SECRET). Under --from-state both must reach the
#      container RESOLVED, as value-less `-e KEY` flags on the docker argv,
#      and the plaintext must appear nowhere in the --verbose output.
#   4i (issue #2056): the same invoke under --role-arn <the step-4e role>, which
#      cannot read the secret (a negative control proves the denial first): both
#      values still resolve, as the caller.
#   5. cdkd destroy --force (consumer, then producer; the secret is force-deleted)
#
# Run via `/run-integ local-invoke-from-state` (recommended) or directly:
#
#     bash tests/integration/local-invoke-from-state/verify.sh
#
# Requires Docker AND AWS credentials with deploy permissions in the
# target account.

set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLocalInvokeFromStateFixture"
# Issue #2056's producer stack and secret; the names match lib/shared.ts.
PRODUCER_STACK="CdkdLocalInvokeFromStateProducer"
SECRET_NAME="cdkd-local-invoke-from-state-2056"
# Exported BEFORE any cdkd command: every synth subprocess reads it to build the
# secret's plaintext (lib/shared.ts), so the value is unique to this run.
CDKD_INTEG_RUN_ID="${CDKD_INTEG_RUN_ID:-$(date +%s)-$$}"
export CDKD_INTEG_RUN_ID
SECRET_PLAINTEXT="itest-2056-${CDKD_INTEG_RUN_ID}"
EXPORT_NAME="CdkdLocalInvokeFromStateSecretPassword"
SECRET_ERR=""
OVERRIDE_FILE=""
IMAGE="public.ecr.aws/lambda/nodejs:20"

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/local-invoke-from-state"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1a: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install --prefer-offline
fi

echo "[verify] step 1b: verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "[verify] step 1c: pulling ${IMAGE} (one-time, ~600MB if not cached)"
docker pull "${IMAGE}"

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

# Lambda creates `/aws/lambda/<stack>-CustomS3AutoDeleteObjects...` when the S3
# auto-delete custom resource runs, and nothing in the stack owns it, so destroy
# leaves it behind (#3885).
. ../cr-log-groups.sh

# State-version sweep (issue #2096). The #2056 arm seeds a secret: the producer
# exports a `{{resolve:secretsmanager:...}}` output that cdkd resolves at
# deploy time, and the state bucket is VERSIONED, so whatever a broken
# redaction ever wrote would outlive the run. Both stacks' prefixes, plus the
# shared exports index, which holds resolved output values (key-scoped and
# NONCURRENT only, so a concurrent lane's live index is untouched).
. ../s3-versions.sh
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
PRODUCER_STATE_PREFIX="$(s3_stack_prefix "${PRODUCER_STACK}" "${REGION}")"
INDEX_KEY="cdkd/_index/${REGION}/exports.json"

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    # Consumer first: it imports the producer's export.
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    ${CLI} destroy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}" --force || true
    # Belt and braces for the #2056 secret: no 7-day recovery window left behind.
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  fi
  rm -f "${SECRET_ERR:-}" "${OVERRIDE_FILE:-}"
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
  # NONCURRENT only, on every exit: a failed run may leave resources standing
  # whose CURRENT state.json a later `cdkd state destroy` needs. The success
  # path does the full sweep and asserts it, after both destroys succeeded.
  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" noncurrent || true
  s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" noncurrent || true
  s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "[verify] step 2: cdkd deploy (producer, then consumer)"
${CLI} deploy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}"
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}"

# Capture the deployed bucket name from cdkd state so the assert can match
# on the literal value. We use 'cdkd state resources' to avoid hard-coding
# any logical-id assumptions.
echo "[verify] step 2b: reading deployed bucket name from cdkd state"
DEPLOYED_BUCKET="$(${CLI} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::S3::Bucket"){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
echo "[verify]   deployed bucket: ${DEPLOYED_BUCKET}"
[ -n "${DEPLOYED_BUCKET}" ] || { echo "[verify] FAIL: could not read deployed bucket name"; exit 1; }

# Local invoke is flaky on cold dockers: the rie-client's TCP probe can
# succeed before RIE has fully wired up its HTTP listener, producing a
# `TypeError: fetch failed`. Retry up to 3 times so a hot-cache run (the
# common case) is fast and a cold-cache run is still reliable. When all
# 3 attempts fail, surface the last attempt's stderr so the user can
# triage. PR 1's RIE readiness window is the load-bearing fix; this
# retry is a cheap belt-and-suspenders for the integ.
invoke_with_retry() {
  local args=("$@")
  local attempts=3
  local i=1
  local err
  err="$(mktemp)"
  while [ $i -le $attempts ]; do
    if out=$(${CLI} local invoke "${args[@]}" 2>"${err}" | tail -1) && \
       echo "${out}" | grep -q '"bucketName":'; then
      rm -f "${err}"
      printf '%s' "${out}"
      return 0
    fi
    if [ $i -lt $attempts ]; then
      echo "[verify]   invoke attempt ${i} failed (last stdout line: ${out}); stderr tail:" >&2
      tail -5 "${err}" >&2
      echo "[verify]   retrying..." >&2
      sleep 2
    fi
    i=$((i+1))
  done
  echo "[verify]   all ${attempts} invoke attempts failed (last stdout line: ${out}); last attempt's stderr below:" >&2
  tail -20 "${err}" >&2
  rm -f "${err}"
  return 1
}

echo "[verify] step 3: cdkd local invoke (no --from-state) — expect BUCKET_NAME=unset"
RESULT_PR1=$(invoke_with_retry "${STACK}/EchoBucketHandler" --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_PR1}"
echo "${RESULT_PR1}" | grep -q '"bucketName":"unset"' || {
  echo "[verify] FAIL: expected BUCKET_NAME to be dropped (PR 1 warn-and-drop), got: ${RESULT_PR1}"
  exit 1
}
echo "${RESULT_PR1}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: expected STATIC_VALUE=always-the-same in response, got: ${RESULT_PR1}"
  exit 1
}
echo "${RESULT_PR1}" | grep -q '"accountTag":"unset"' || {
  echo "[verify] FAIL: expected ACCOUNT_TAG to be dropped without --from-state, got: ${RESULT_PR1}"
  exit 1
}

echo "[verify] step 4: cdkd local invoke --from-state — expect BUCKET_NAME=${DEPLOYED_BUCKET}"
RESULT_PR2=$(invoke_with_retry "${STACK}/EchoBucketHandler" --from-state --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_PR2}"
echo "${RESULT_PR2}" | grep -q "\"bucketName\":\"${DEPLOYED_BUCKET}\"" || {
  echo "[verify] FAIL: expected BUCKET_NAME=${DEPLOYED_BUCKET}, got: ${RESULT_PR2}"
  exit 1
}
echo "${RESULT_PR2}" | grep -q '"staticValue":"always-the-same"' || {
  echo "[verify] FAIL: STATIC_VALUE regressed under --from-state, got: ${RESULT_PR2}"
  exit 1
}
echo "${RESULT_PR2}" | grep -q "\"accountTag\":\"acct-${ACCOUNT_ID}\"" || {
  echo "[verify] FAIL: expected ACCOUNT_TAG=acct-${ACCOUNT_ID} under --from-state, got: ${RESULT_PR2}"
  exit 1
}

# Step 4b — `--stack-region` region-case fold (issue #1836).
#
# The stack is already deployed at this point, so this costs no extra deploy: the
# state record was keyed `cdkd/<stack>/<region>/state.json` with the CANONICAL
# region (AWS_REGION is pinned canonical at the top of this script), and the flag
# is spelled UPPER-CASED here. Pre-fix the flag was compared to the record's
# region with a raw `===`, so it missed, `--from-state` warn-and-fell-back, and
# BUCKET_NAME silently came through as "unset" — a command that "works" against
# no state at all. Both polarities: the canonical spelling must produce the same
# answer, byte for byte.
UPPER_REGION="$(printf '%s' "${REGION}" | tr '[:lower:]' '[:upper:]')"
echo "[verify] step 4b: --from-state --stack-region ${UPPER_REGION} — expect BUCKET_NAME=${DEPLOYED_BUCKET}"
RESULT_UPPER=$(invoke_with_retry "${STACK}/EchoBucketHandler" --from-state \
  --stack-region "${UPPER_REGION}" --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_UPPER}"
echo "${RESULT_UPPER}" | grep -q "\"bucketName\":\"${DEPLOYED_BUCKET}\"" || {
  echo "[verify] FAIL: an upper-cased --stack-region must still read the ${REGION} state record;"
  echo "[verify]       expected BUCKET_NAME=${DEPLOYED_BUCKET}, got: ${RESULT_UPPER}"
  exit 1
}
# The shape the regression emits: a silent fall-back to no state at all.
echo "${RESULT_UPPER}" | grep -q '"bucketName":"unset"' && {
  echo "[verify] FAIL: --stack-region ${UPPER_REGION} fell back to no state (BUCKET_NAME unset)"
  exit 1
}
echo "[verify] step 4c: --from-state --stack-region ${REGION} (canonical counter-case)"
RESULT_CANON=$(invoke_with_retry "${STACK}/EchoBucketHandler" --from-state \
  --stack-region "${REGION}" --no-pull --state-bucket "${STATE_BUCKET}")
[ "${RESULT_UPPER}" = "${RESULT_CANON}" ] || {
  echo "[verify] FAIL: an already-canonical --stack-region must be byte-identical to the folded one"
  echo "[verify]   upper: ${RESULT_UPPER}"
  echo "[verify]   lower: ${RESULT_CANON}"
  exit 1
}

# Step 4d — upper-cased AWS_REGION / AWS_DEFAULT_REGION with NO --region
# (issue #3622). The handler folded only the flag, so the env spelling reached
# the SDK clients cdkd builds with no region (the `--from-state` S3 client
# among them), whose region the AWS SDK reads from AWS_REGION directly.
echo "[verify] step 4d: AWS_REGION=${UPPER_REGION} --from-state (no --region) — expect BUCKET_NAME=${DEPLOYED_BUCKET}"
RESULT_ENV_UPPER=$(AWS_REGION="${UPPER_REGION}" AWS_DEFAULT_REGION="${UPPER_REGION}" \
  invoke_with_retry "${STACK}/EchoBucketHandler" --from-state --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_ENV_UPPER}"
echo "${RESULT_ENV_UPPER}" | grep -q "\"bucketName\":\"${DEPLOYED_BUCKET}\"" || {
  echo "[verify] FAIL: AWS_REGION=${UPPER_REGION} must still read the ${REGION} state record;"
  echo "[verify]       expected BUCKET_NAME=${DEPLOYED_BUCKET}, got: ${RESULT_ENV_UPPER}"
  exit 1
}
[ "${RESULT_ENV_UPPER}" = "${RESULT_CANON}" ] || {
  echo "[verify] FAIL: an upper-cased AWS_REGION must answer byte-identically to the canonical run"
  echo "[verify]   upper env: ${RESULT_ENV_UPPER}"
  echo "[verify]   canonical: ${RESULT_CANON}"
  exit 1
}

# Step 4e — `--from-state --role-arn` (issue #3230). The state is read as the
# role, and `${AWS::AccountId}` is now asked as the state reader too. This
# account holds only one identity's account, so the role's account IS the
# caller's: the arm proves the role-published path resolves the account (and
# still reads the state), not that the two differ — the unit suite covers that.
echo "[verify] step 4e: --from-state --role-arn <LocalReadRole> — expect acct-${ACCOUNT_ID} + BUCKET_NAME"
READ_ROLE_NAME="$(${CLI} state resources "${STACK}" --state-bucket "${STATE_BUCKET}" --json \
  | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{const j=JSON.parse(d);for(const r of j){if(r.resourceType==="AWS::IAM::Role"&&r.logicalId.startsWith("LocalReadRole")){console.log(r.physicalId);process.exit(0)}}process.exit(1)})')"
[ -n "${READ_ROLE_NAME}" ] || { echo "[verify] FAIL: could not read LocalReadRole from cdkd state"; exit 1; }
READ_ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${READ_ROLE_NAME}"
# A just-created role is not assumable until IAM propagates. Wait for it with
# the caller's own credentials, bounded, so the invoke below never races it.
role_ready=0
assume_err=""
for _ in $(seq 1 30); do
  # Only the error text is kept; the issued credentials go to /dev/null.
  if assume_err="$(aws sts assume-role --role-arn "${READ_ROLE_ARN}" --role-session-name cdkd-3230-probe \
       --query 'Credentials.Expiration' --output text 2>&1 >/dev/null)"; then
    role_ready=1
    break
  fi
  sleep 3
done
[ "${role_ready}" = 1 ] || {
  echo "[verify] FAIL: ${READ_ROLE_ARN} never became assumable; last error: ${assume_err}"
  exit 1
}
RESULT_ROLE=$(invoke_with_retry "${STACK}/EchoBucketHandler" --from-state --role-arn "${READ_ROLE_ARN}" \
  --no-pull --state-bucket "${STATE_BUCKET}")
echo "[verify]   response: ${RESULT_ROLE}"
echo "${RESULT_ROLE}" | grep -q "\"bucketName\":\"${DEPLOYED_BUCKET}\"" || {
  echo "[verify] FAIL: --role-arn must still read the state record; expected BUCKET_NAME=${DEPLOYED_BUCKET}, got: ${RESULT_ROLE}"
  exit 1
}
echo "${RESULT_ROLE}" | grep -q "\"accountTag\":\"acct-${ACCOUNT_ID}\"" || {
  echo "[verify] FAIL: expected ACCOUNT_TAG=acct-${ACCOUNT_ID} under --from-state --role-arn, got: ${RESULT_ROLE}"
  exit 1
}

# Step 4f-4h — a secret-bearing cross-stack output (issue #2056).
#
# Premise first: the export must be stored as its EXPRESSION, both in the
# producer's outputs bag and in the exports index the consumer's
# `Fn::ImportValue` actually reads. If either held the plaintext, IMPORTED_SECRET
# would arrive resolved without any local resolution and 4f could not tell the
# fix from its absence. Scoped to the OUTPUT VALUE: the producer's own Secret
# resource carries the plaintext in its persisted properties by construction
# (`unsafePlainText`), so a whole-record grep would always match.
EXPECTED_TOKEN="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password::}}"
echo "[verify] step 4f-premise: the export is persisted as its {{resolve:...}} token"
PRODUCER_STATE_JSON="$(${CLI} state show "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}" --json)"
STATE_EXPORT_VALUE="$(printf '%s' "${PRODUCER_STATE_JSON}" \
  | jq -r --arg k "${EXPORT_NAME}" '.state.outputs[$k] // empty')"
[ "${STATE_EXPORT_VALUE}" = "${EXPECTED_TOKEN}" ] || {
  echo "[verify] FAIL: producer state.outputs[${EXPORT_NAME}] is not the dynamic-reference expression"
  exit 1
}
INDEX_EXPORT_VALUE="$(aws s3 cp "s3://${STATE_BUCKET}/${INDEX_KEY}" - \
  | jq -r --arg k "${EXPORT_NAME}" '.exports[$k].value // empty')"
[ "${INDEX_EXPORT_VALUE}" = "${EXPECTED_TOKEN}" ] || {
  echo "[verify] FAIL: the exports index entry for ${EXPORT_NAME} is not the dynamic-reference expression"
  exit 1
}

# One invoke of EchoSecretHandler, stdout (the payload) and stderr kept apart,
# with the same cold-docker retry as invoke_with_retry.
SECRET_ERR="$(mktemp)"
OVERRIDE_FILE="$(mktemp)"
invoke_secret() {
  local i=1 out=""
  while [ $i -le 3 ]; do
    if out=$(${CLI} local invoke "${STACK}/EchoSecretHandler" "$@" 2>"${SECRET_ERR}" | tail -1) && \
       printf '%s' "${out}" | grep -q '"importedSecret":'; then
      printf '%s' "${out}"
      return 0
    fi
    # Masked: a failed attempt can still have printed the payload.
    echo "[verify]   invoke attempt ${i} failed (last stdout line: ${out//${SECRET_PLAINTEXT}/<plaintext>}); stderr tail:" >&2
    tail -5 "${SECRET_ERR}" | sed "s/${SECRET_PLAINTEXT}/<plaintext>/g" >&2
    i=$((i+1))
    sleep 2
  done
  return 1
}

echo "[verify] step 4f: --from-state --verbose — expect both secret env vars RESOLVED"
RESULT_SECRET=$(invoke_secret --from-state --verbose --no-pull --state-bucket "${STATE_BUCKET}") || {
  echo "[verify] FAIL: local invoke of EchoSecretHandler failed; stderr tail:"
  tail -20 "${SECRET_ERR}" | sed "s/${SECRET_PLAINTEXT}/<plaintext>/g"
  exit 1
}
# The payload is the container's own echo, so it is where the plaintext is
# EXPECTED; print it with the value masked.
echo "[verify]   response: ${RESULT_SECRET//${SECRET_PLAINTEXT}/<plaintext>}"
printf '%s' "${RESULT_SECRET}" | grep -qF "\"importedSecret\":\"${SECRET_PLAINTEXT}\"" || {
  echo "[verify] FAIL: IMPORTED_SECRET (Fn::ImportValue of a redacted output) did not reach the container resolved"
  exit 1
}
printf '%s' "${RESULT_SECRET}" | grep -qF "\"sameStackSecret\":\"${SECRET_PLAINTEXT}\"" || {
  echo "[verify] FAIL: SAME_STACK_SECRET (a same-stack dynamic reference) did not reach the container resolved"
  exit 1
}
printf '%s' "${RESULT_SECRET}" | grep -qF '{{resolve:' && {
  echo "[verify] FAIL: a {{resolve:...}} token reached the container"
  exit 1
}
# Off the argv: the --verbose docker-run line names each resolved key as a
# value-less `-e KEY`; an inline one would read `-e KEY=***`. The line must be
# present, or the absence checks below prove nothing.
grep -qE -- '-e IMPORTED_SECRET( |$)' "${SECRET_ERR}" || {
  echo "[verify] FAIL: no value-less '-e IMPORTED_SECRET' on the --verbose docker run line"
  exit 1
}
grep -qE -- '-e SAME_STACK_SECRET( |$)' "${SECRET_ERR}" || {
  echo "[verify] FAIL: no value-less '-e SAME_STACK_SECRET' on the --verbose docker run line"
  exit 1
}
grep -qE -- '-e (IMPORTED|SAME_STACK)_SECRET=' "${SECRET_ERR}" && {
  echo "[verify] FAIL: a resolved secret was passed inline on the docker argv"
  exit 1
}
grep -qF "${SECRET_PLAINTEXT}" "${SECRET_ERR}" && {
  echo "[verify] FAIL: the secret plaintext appeared in the --verbose output"
  exit 1
}

echo "[verify] step 4g: no --from-state — the same-stack reference still resolves, the import is dropped"
RESULT_SECRET_NOSTATE=$(invoke_secret --no-pull --state-bucket "${STATE_BUCKET}") || {
  echo "[verify] FAIL: local invoke of EchoSecretHandler (no --from-state) failed"
  exit 1
}
printf '%s' "${RESULT_SECRET_NOSTATE}" | grep -qF "\"sameStackSecret\":\"${SECRET_PLAINTEXT}\"" || {
  echo "[verify] FAIL: SAME_STACK_SECRET must resolve without any state flag"
  exit 1
}
printf '%s' "${RESULT_SECRET_NOSTATE}" | grep -q '"importedSecret":"unset"' || {
  echo "[verify] FAIL: IMPORTED_SECRET must be dropped without --from-state"
  exit 1
}

# A regression guard: the developer's credentials can read the secret, so the
# skipped lookup itself is not observable here (the unit suite pins the skip).
echo "[verify] step 4h: --env-vars override — the developer literal wins"
printf '{"Parameters":{"IMPORTED_SECRET":"local-override-2056"}}' > "${OVERRIDE_FILE}"
RESULT_SECRET_OVR=$(invoke_secret --from-state --env-vars "${OVERRIDE_FILE}" --no-pull --state-bucket "${STATE_BUCKET}") || {
  echo "[verify] FAIL: local invoke of EchoSecretHandler with --env-vars failed"
  exit 1
}
printf '%s' "${RESULT_SECRET_OVR}" | grep -q '"importedSecret":"local-override-2056"' || {
  echo "[verify] FAIL: the --env-vars override of IMPORTED_SECRET did not reach the container"
  exit 1
}

# Negative control for 4i: the role really cannot touch the secret, so 4i
# resolving it proves the lookup did not run as the role. DescribeSecret, not a
# value read: the probe needs the denial, never the plaintext.
echo "[verify] step 4i-control: <LocalReadRole> is denied on the secret"
ROLE_CREDS="$(aws sts assume-role --role-arn "${READ_ROLE_ARN}" --role-session-name cdkd-2056-control \
  --query 'Credentials.[AccessKeyId,SecretAccessKey,SessionToken]' --output text)"
read -r CTL_AKID CTL_SECRET CTL_TOKEN <<< "${ROLE_CREDS}"
[ -n "${CTL_TOKEN:-}" ] || { echo "[verify] FAIL: could not assume ${READ_ROLE_ARN} for the 4i control"; exit 1; }
# Exported inside a subshell, never as `env K=V` arguments: the session
# credentials must not reach any process's argv.
if control_err="$(
  unset AWS_PROFILE
  export AWS_ACCESS_KEY_ID="${CTL_AKID}" AWS_SECRET_ACCESS_KEY="${CTL_SECRET}" AWS_SESSION_TOKEN="${CTL_TOKEN}"
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}" 2>&1 >/dev/null
)"; then
  echo "[verify] FAIL: the 4i role CAN describe ${SECRET_NAME}, so 4i would not tell the caller from the role"
  exit 1
fi
printf '%s' "${control_err}" | grep -q 'AccessDenied' || {
  echo "[verify] FAIL: the 4i control failed for a reason other than AccessDenied: ${control_err}"
  exit 1
}
unset ROLE_CREDS CTL_AKID CTL_SECRET CTL_TOKEN

# Step 4i — the lookup runs as the CALLER, never the --role-arn role. The
# step-4e role can read this stack's state and the exports index but holds no
# Secrets Manager permission at all, so both values resolving here proves the
# lookups did not use it; run as the role, they would fail and name the
# missing permission.
echo "[verify] step 4i: --from-state --role-arn <LocalReadRole> — the lookups still run as the caller"
RESULT_SECRET_ROLE=$(invoke_secret --from-state --role-arn "${READ_ROLE_ARN}" --no-pull --state-bucket "${STATE_BUCKET}") || {
  echo "[verify] FAIL: local invoke of EchoSecretHandler under --role-arn failed (did a lookup run as the role?)"
  exit 1
}
printf '%s' "${RESULT_SECRET_ROLE}" | grep -qF "\"sameStackSecret\":\"${SECRET_PLAINTEXT}\"" || {
  echo "[verify] FAIL: SAME_STACK_SECRET did not resolve under --role-arn"
  exit 1
}
printf '%s' "${RESULT_SECRET_ROLE}" | grep -qF "\"importedSecret\":\"${SECRET_PLAINTEXT}\"" || {
  echo "[verify] FAIL: IMPORTED_SECRET did not resolve under --role-arn"
  exit 1
}
rm -f "${SECRET_ERR}"

echo "[verify] step 5: cdkd destroy --force (consumer, then producer)"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
${CLI} destroy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}" --force

# The #2056 secret must be gone outright, not parked in a recovery window:
# a parked one would also block the next run's create of the same name.
secret_gone=0
for _ in $(seq 1 10); do
  if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    secret_gone=1
    break
  fi
  sleep 3
done
[ "${secret_gone}" = 1 ] || {
  echo "[verify] FAIL: secret ${SECRET_NAME} survived destroy"
  exit 1
}

# Both destroys succeeded (`set -e`), so every state version can go: sweep and
# ASSERT, as the last thing that looks at the bucket. The shared exports index
# keeps its CURRENT object (another stack may own it); its noncurrent versions go.
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" all || true
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "local-invoke-from-state consumer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PRODUCER_STATE_PREFIX}" "local-invoke-from-state producer state teardown"

# The step-4e role can read the state bucket and is assumable account-wide, so
# a leaked copy is a standing grant: assert it is gone rather than trusting rc.
assert_gone "LocalReadRole ${READ_ROLE_NAME} survived destroy" \
  aws iam get-role --role-name "${READ_ROLE_NAME}"

echo ""
echo "[verify] All checks passed: --from-state substituted BUCKET_NAME with the deployed bucket name,"
echo "[verify] an upper-cased --stack-region still read the ${REGION} state record (#1836),"
echo "[verify] --from-state --role-arn resolved \${AWS::AccountId} as the state reader (#3230),"
echo "[verify] and a secret-bearing cross-stack output reached the container resolved, off the argv (#2056)."
