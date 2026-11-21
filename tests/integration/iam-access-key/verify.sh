#!/usr/bin/env bash
# verify.sh — cdkd AWS::IAM::AccessKey SDK provider integ test (issue #1323).
#
# The type is NON_PROVISIONABLE in the CloudFormation registry (no Cloud
# Control handlers) — before the SDK provider, cdkd's pre-flight rejected any
# template declaring it, including the documented CDK CI-credentials pattern
# (iam.AccessKey + piping secretAccessKey into a Secrets Manager secret).
# This test proves the full lifecycle against real AWS:
#
#   Phase 1 (create): deploy user + access key + secret; assert the key is
#     Active on AWS, and the Secrets Manager secret holds the key's
#     create-time-only SecretAccessKey (Fn::GetAtt resolved from cached
#     attributes — there is NO read-back API for it).
#   Phase 2 (update, CDKD_TEST_UPDATE=true): flip Status to Inactive — the
#     only in-place-mutable property; assert the flip landed, the physical id
#     survived, AND the secret value survived (the provider must not wipe the
#     create-time attributes on update). The same update moves the user and a
#     group from `/` to `/cdkd-moved/` (#3723): IAM must hold the new path and
#     state the ARN read after the move.
#   Phase 3 (destroy): tear down; assert the key, user, secret, and state
#     file are gone.
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

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture asserts that the
# create-time IAM SecretAccessKey is CACHED in state `attributes` -- so a real,
# usable AWS credential is in every state.json this fixture writes, by design.
# The state bucket is VERSIONED, so `aws s3 rm` only writes a delete marker and
# each of those credentials stays readable via GetObjectVersion long after the
# IAM user that owned it was deleted.
. ../s3-versions.sh

STACK="CdkdIamAccessKeyExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

USER_NAME="cdkd-iam-access-key-user"
GROUP_NAME="cdkd-iam-access-key-group"
MOVED_PATH="/cdkd-moved/"
SECRET_NAME="cdkd-iam-access-key-secret"
LOGIN_SECRET_NAME="cdkd-iam-access-key-login-password"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# The user's access-key listing (strict capture — a probe failure aborts the
# run under `set -e` rather than reading as empty).
list_keys() {
  aws iam list-access-keys --user-name "${USER_NAME}" \
    --query 'AccessKeyMetadata[].[AccessKeyId,Status]' --output text
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DRIFT_OUT:-}"
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # The `aws s3 rm` above only wrote DELETE MARKERS, leaving the cached
    # SecretAccessKey readable in every prior version. Purge them
    # NONCURRENT-only here: this function also runs from the pre-run sweep and
    # from the failure/INT/TERM traps, where a live state.json may still be the
    # only record of resources that are standing. The success path does the
    # full sweep and asserts the count is zero.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  # Direct sweep in case state-based teardown could not run: every access key
  # on the fixture user, then the user, then the secret (force, no recovery
  # window — a scheduled deletion would block the next run's same-name create).
  local kid
  for kid in $(aws iam list-access-keys --user-name "${USER_NAME}" \
    --query 'AccessKeyMetadata[].AccessKeyId' --output text 2>/dev/null); do
    aws iam delete-access-key --user-name "${USER_NAME}" --access-key-id "${kid}" >/dev/null 2>&1
  done
  aws iam delete-login-profile --user-name "${USER_NAME}" >/dev/null 2>&1
  aws iam delete-user --user-name "${USER_NAME}" >/dev/null 2>&1
  aws iam delete-group --group-name "${GROUP_NAME}" >/dev/null 2>&1
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  aws secretsmanager delete-secret --secret-id "${LOGIN_SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup

# --- Phase 1: create -------------------------------------------------------
echo "==> Phase 1: deploy (user + access key + secret holding SecretAccessKey)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
if [ -z "${STATE}" ]; then
  echo "FAIL: no state file at s3://${STATE_BUCKET}/${STATE_KEY} after deploy" >&2
  exit 1
fi

KEY_ID_1=$(printf '%s' "${STATE}" | python3 -c "import json,sys; s=json.load(sys.stdin); [print(r['physicalId']) for r in s['resources'].values() if r['resourceType']=='AWS::IAM::AccessKey']")
if [ -z "${KEY_ID_1}" ]; then
  echo "FAIL: no AWS::IAM::AccessKey resource in state after deploy" >&2
  exit 1
fi

KEYS=$(list_keys)
if ! grep -q "${KEY_ID_1}[[:space:]]*Active" <<<"${KEYS}"; then
  echo "FAIL: access key ${KEY_ID_1} is not Active on AWS after create (got: ${KEYS})" >&2
  exit 1
fi
echo "    OK: access key ${KEY_ID_1} exists and is Active"

# The create-time-only SecretAccessKey must have reached the Secrets Manager
# secret via Fn::GetAtt (resolved from the provider's cached attributes — IAM
# never returns the secret again after CreateAccessKey).
SECRET_VALUE_1=$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'SecretString' --output text)
if ! grep -qE '^[A-Za-z0-9/+=]{40}$' <<<"${SECRET_VALUE_1}"; then
  echo "FAIL: secret value is not a 40-char IAM secret access key (got length: ${#SECRET_VALUE_1})" >&2
  exit 1
fi
if grep -q 'Fn::GetAtt\|Token' <<<"${SECRET_VALUE_1}"; then
  echo "FAIL: secret value carries an unresolved intrinsic: ${SECRET_VALUE_1}" >&2
  exit 1
fi
echo "    OK: secret holds a resolved 40-char SecretAccessKey"

# --- Phase 1b: the login profile's PasswordResetRequired is drift (#6755) ---
# Before go-to-k/cdkd#6755 the user readback never read the login profile, so
# a PasswordResetRequired flipped out of band read as no drift. Flipped on, the
# user must be drifted at LoginProfile.PasswordResetRequired; flipped back by
# hand, clean again. The generated password must appear in no drift output and
# nowhere in state: it is held in a variable and never printed.
echo "==> Phase 1b: flip the login profile's PasswordResetRequired out of band, then drift"
LOGIN_PW=$(aws secretsmanager get-secret-value --secret-id "${LOGIN_SECRET_NAME}" \
  --region "${REGION}" --query 'SecretString' --output text)
[ "${#LOGIN_PW}" -eq 32 ] || { echo "FAIL: the generated login password is ${#LOGIN_PW} characters, expected 32" >&2; exit 1; }
if grep -qF -- "${LOGIN_PW}" <<<"${STATE}"; then
  echo "FAIL: the login password is in state.json in plaintext" >&2
  exit 1
fi
USER_ID=$(printf '%s' "${STATE}" | jq -r '[.resources | to_entries[] | select(.value.resourceType == "AWS::IAM::User") | .key] | first // ""')
[ -n "${USER_ID}" ] || { echo "FAIL: no AWS::IAM::User in state" >&2; exit 1; }
DRIFT_OUT=$(mktemp)
user_drift() { # usage: user_drift; fills ${DRIFT_OUT}, prints the user's report bucket
  local rc=0
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_OUT}" || rc=$?
  case "${rc}" in 0 | 1 | 2) ;; *) echo "FAIL: cdkd drift exited ${rc}" >&2; exit 1 ;; esac
  if grep -qF -- "${LOGIN_PW}" "${DRIFT_OUT}"; then
    echo "FAIL: cdkd drift printed the login password" >&2
    exit 1
  fi
  jq -r --arg id "${USER_ID}" '[.[0] | to_entries[] | select((.value | type) == "array") | .key as $b | .value[]? | objects | select(.logicalId == $id) | $b] | join(",")' "${DRIFT_OUT}"
}
# IAM reads lag its writes: wait until GetLoginProfile shows the flag.
wait_reset_required() { # usage: wait_reset_required <true|false>
  local got="" _i
  for _i in $(seq 1 12); do
    got=$(aws iam get-login-profile --user-name "${USER_NAME}" --query 'LoginProfile.PasswordResetRequired' --output text) || return 1
    # `--output text` renders a boolean as True / False.
    [ "$(tr '[:upper:]' '[:lower:]' <<<"${got}")" = "$1" ] && return 0
    sleep 5
  done
  echo "FAIL: PasswordResetRequired is '${got}' 60s after setting it to $1" >&2
  exit 1
}
BUCKET=$(user_drift)
[ "${BUCKET}" = "clean" ] || { echo "FAIL: ${USER_ID} is '${BUCKET}' right after the deploy, expected clean" >&2; jq '.[0].drifted' "${DRIFT_OUT}" >&2; exit 1; }
if [ "$(printf '%s' "${STATE}" | jq -c --arg id "${USER_ID}" '.resources[$id].observedProperties.LoginProfile // null')" != '{"PasswordResetRequired":false}' ]; then
  echo "FAIL: the deploy-time baseline does not read the login profile back as {PasswordResetRequired: false}" >&2
  exit 1
fi
aws iam update-login-profile --user-name "${USER_NAME}" --password-reset-required
wait_reset_required true || { echo "FAIL: get-login-profile ${USER_NAME} failed while waiting for PasswordResetRequired=true" >&2; exit 1; }
BUCKET=$(user_drift)
if [ "${BUCKET}" != "drifted" ] ||
  ! jq -e --arg id "${USER_ID}" '[.[0].drifted[]? | select(.logicalId == $id) | .changes[]?.path] | index("LoginProfile.PasswordResetRequired") != null' "${DRIFT_OUT}" >/dev/null; then
  echo "FAIL: ${USER_ID} with PasswordResetRequired flipped out of band is '${BUCKET}', expected drifted at LoginProfile.PasswordResetRequired:" >&2
  jq --arg id "${USER_ID}" '.[0].drifted[]? | select(.logicalId == $id)' "${DRIFT_OUT}" >&2
  exit 1
fi
echo "    OK: the flipped PasswordResetRequired is drift at LoginProfile.PasswordResetRequired"
aws iam update-login-profile --user-name "${USER_NAME}" --no-password-reset-required
wait_reset_required false || { echo "FAIL: get-login-profile ${USER_NAME} failed while waiting for PasswordResetRequired=false" >&2; exit 1; }
BUCKET=$(user_drift)
[ "${BUCKET}" = "clean" ] || { echo "FAIL: ${USER_ID} is '${BUCKET}' once PasswordResetRequired is flipped back, expected clean" >&2; exit 1; }
unset LOGIN_PW
rm -f "${DRIFT_OUT}"
echo "    OK: flipped back by hand, the user compares clean again; the password reached no output"

# --- Phase 2: update (Status flip — the only in-place-mutable property) ----
echo "==> Phase 2: update (Status Active -> Inactive)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

KEYS=$(list_keys)
if ! grep -q "${KEY_ID_1}[[:space:]]*Inactive" <<<"${KEYS}"; then
  echo "FAIL: access key ${KEY_ID_1} is not Inactive after the Status update (got: ${KEYS})" >&2
  exit 1
fi
echo "    OK: Status flip landed in-place (Inactive)"

# In-place means IN PLACE: the key id must survive the Status update.
KEY_ID_2=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin); [print(r['physicalId']) for r in s['resources'].values() if r['resourceType']=='AWS::IAM::AccessKey']")
if [ "${KEY_ID_2}" != "${KEY_ID_1}" ]; then
  echo "FAIL: physical id changed across the in-place update (${KEY_ID_1} -> ${KEY_ID_2})" >&2
  exit 1
fi
echo "    OK: physical id stable across the in-place update"

# The create-time secret must SURVIVE the update — the provider omits
# attributes on update precisely so the cached SecretAccessKey is not wiped
# (a partial attribute set would REPLACE the stored attributes).
SECRET_VALUE_2=$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'SecretString' --output text)
if [ "${SECRET_VALUE_2}" != "${SECRET_VALUE_1}" ]; then
  echo "FAIL: secret value changed across the Status update — the cached SecretAccessKey was not preserved" >&2
  exit 1
fi
CACHED_SECRET=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin); [print(r['attributes'].get('SecretAccessKey','')) for r in s['resources'].values() if r['resourceType']=='AWS::IAM::AccessKey']")
if [ "${CACHED_SECRET}" != "${SECRET_VALUE_1}" ]; then
  echo "FAIL: state attributes no longer carry the create-time SecretAccessKey after update" >&2
  exit 1
fi
echo "    OK: create-time SecretAccessKey survived the update (secret + state attributes)"

# #3723: Path is mutable in place, and cdkd used to send nothing for it on
# update. The deploy succeeded either way, so only IAM's own Path tells.
USER_PATH=$(aws iam get-user --user-name "${USER_NAME}" --query 'User.Path' --output text)
GROUP_PATH=$(aws iam get-group --group-name "${GROUP_NAME}" --query 'Group.Path' --output text)
if [ "${USER_PATH}" != "${MOVED_PATH}" ] || [ "${GROUP_PATH}" != "${MOVED_PATH}" ]; then
  echo "FAIL: the Path update did not reach IAM (user: ${USER_PATH}, group: ${GROUP_PATH}; want ${MOVED_PATH})" >&2
  exit 1
fi
# The ARN embeds the path, so the recorded one must be the moved principal's.
STATE_ARNS=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null | python3 -c "import json,sys; s=json.load(sys.stdin); [print(r.get('attributes',{}).get('Arn','')) for r in s['resources'].values() if r['resourceType'] in ('AWS::IAM::User','AWS::IAM::Group')]")
for want in "user${MOVED_PATH}${USER_NAME}" "group${MOVED_PATH}${GROUP_NAME}"; do
  if ! grep -qF ":${want}" <<<"${STATE_ARNS}"; then
    echo "FAIL: state records no ARN ending in ${want} after the Path update (got: ${STATE_ARNS})" >&2
    exit 1
  fi
done
echo "    OK: user and group moved to ${MOVED_PATH} in place, and state records their new ARNs"

# --- Phase 3: destroy ------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --force

assert_gone "user ${USER_NAME} still exists after destroy (key deletion must precede user deletion)" \
  aws iam get-user --user-name "${USER_NAME}"
echo "    OK: user (and its access key) are gone"
assert_gone "group ${GROUP_NAME} still exists after destroy" \
  aws iam get-group --group-name "${GROUP_NAME}"
echo "    OK: group is gone"

# DeleteSecret with ForceDeleteWithoutRecovery is ASYNC: DescribeSecret can
# still return the record (with DeletionDate) for a short window after the
# delete succeeded, so a single immediate probe false-FAILs the leak check
# (observed live 2026-07-31: the probe raced a destroy that had completed
# with 0 errors, and the secret 404'd seconds later). Poll bounded; every
# probe still goes through gone_probe so a throttle / auth error hard-fails
# instead of reading as "gone".
SECRET_GONE=0
for _ in $(seq 1 12); do
  if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" != "1" ]; then
  echo "FAIL: secret ${SECRET_NAME} still exists 60s after destroy" >&2
  exit 1
fi
echo "    OK: secret is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object above only looks at the CURRENT object. The bucket is VERSIONED
# (issue #2096), so without this the cached SecretAccessKey survives the run in
# every prior version. The sweep runs HERE, on the normal path, and not only in
# `cleanup` -- a trap-only sweep never runs on a fixture that disarms its trap
# -- and it ASSERTS zero rather than assuming it worked.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "iam-access-key state teardown"

echo ""
echo "==> iam-access-key test passed (create + in-place Status and Path update + secret preservation + clean destroy + zero surviving state versions)"
