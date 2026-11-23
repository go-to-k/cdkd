#!/usr/bin/env bash
# verify.sh — cdkd `cc-api-provider` context lookup integ (go-to-k/cdkd#6542).
#
# The Cloud Control context provider must answer with an ARRAY (one object per
# match, each carrying `Identifier`), as the CDK CLI does: aws-cdk-lib's
# `ec2.PrefixList.fromLookup` and `iam.Role.fromLookup` read `value[0]`. A bare
# object for a single match made both fail. A value an older cdkd stored in
# `cdk.context.json` in the bare shape must be dropped and re-looked-up.
#
# Phases:
#   0. Create the IAM role the stack looks up (out of band) and remove any stale
#      `cdk.context.json`.
#   1. Deploy. Assert `cdk.context.json` holds exactly two `cc-api-provider:`
#      entries, each an array of length 1 whose element has `Identifier`
#      (PrefixListId / Arn on the respective entries), and that both SSM
#      parameters carry the live prefix list id and role ARN.
#   2. Rewrite every entry to the OLD bare-object shape (Identifier removed),
#      run `cdkd synth`, and assert both entries are arrays with `Identifier`
#      again (the stale entry was dropped, re-looked-up and overwritten).
#   3. Run the fixture-local upstream `cdk synth --no-lookups` against the SAME
#      context file: it must succeed from the cached values alone.
#   3b. `cdkd synth --no-lookups` succeeds on the same file, and with one
#      entry removed refuses with the lookups-disabled error naming that key,
#      without writing it back (go-to-k/cdkd#6883).
#   4. Destroy, then assert both parameters and the state file are gone.
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

export AWS_CLI_AUTO_PROMPT=off AWS_PAGER=

STACK="CdkdCcApiLookupExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
ROLE_NAME="CdkdCcApiLookupRole-${REGION}"
PREFIX_LIST_PARAM="/cdkd-test/cc-api-lookup/${STACK}/prefix-list-id"
ROLE_ARN_PARAM="/cdkd-test/cc-api-lookup/${STACK}/role-arn"
CONTEXT_FILE="${PWD}/cdk.context.json"
export CDKD_CC_LOOKUP_ROLE_NAME="${ROLE_NAME}"
export AWS_REGION="${REGION}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found — run 'vp run build' first" >&2
  exit 1
fi
command -v jq >/dev/null || { echo "FAIL: jq is required" >&2; exit 1; }

# Vendored cdk CLI (issue 1485): install when node_modules is absent OR holds no
# cdk bin, and PATH-prepend so `cdk` resolves the fixture-local CLI.
[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install
export PATH="${PWD}/node_modules/.bin:${PATH}"

# Delete one SSM parameter BY NAME; a subshell under `set +eu` so calling it
# from the `set +eu` trap never re-arms strict mode.
delete_param() { # usage: delete_param <name>
  (
    set +eu
    aws ssm delete-parameter --name "$1" --region "${REGION}" >/dev/null 2>&1
  )
}

CLEANED_UP=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  delete_param "${PREFIX_LIST_PARAM}"
  delete_param "${ROLE_ARN_PARAM}"
  aws iam delete-role --role-name "${ROLE_NAME}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
  rm -f "${CONTEXT_FILE}" "${CONTEXT_FILE}.tmp" "${CONTEXT_FILE}.full"
  # The pre-run call runs in the main shell: restore strict mode, or every
  # later failing command would be ignored.
  set -eu
  return 0
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Pre-run cleanup"
cleanup
# Re-arm for the real run: the pre-run call latched the flag.
CLEANED_UP=0

echo "==> Phase 0: create the IAM role the stack looks up"
CREATE_ERR="$(aws iam create-role --role-name "${ROLE_NAME}" \
  --assume-role-policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"ec2.amazonaws.com"},"Action":"sts:AssumeRole"}]}' \
  2>&1 >/dev/null)" || {
  if ! grep -q 'EntityAlreadyExists' <<<"${CREATE_ERR}"; then
    echo "FAIL: create-role failed: ${CREATE_ERR}" >&2
    exit 1
  fi
}
aws iam wait role-exists --role-name "${ROLE_NAME}"
rm -f "${CONTEXT_FILE}"

# Assert every cc-api-provider entry is an array of length 1 whose element has
# Identifier, that there are exactly two, and that each lookup's own key is set.
assert_context_arrays() { # usage: assert_context_arrays <label>
  local label="$1"
  local n
  n="$(jq '[to_entries[] | select(.key | startswith("cc-api-provider:"))] | length' "${CONTEXT_FILE}")"
  if [ "${n}" != "2" ]; then
    echo "FAIL: ${label}: expected 2 cc-api-provider entries, got ${n}" >&2
    exit 1
  fi
  local bad
  bad="$(jq '[to_entries[] | select(.key | startswith("cc-api-provider:")) | .value | select((type == "array" and length == 1 and (.[0] | type == "object") and (.[0] | has("Identifier"))) | not)] | length' "${CONTEXT_FILE}")"
  if [ "${bad}" != "0" ]; then
    echo "FAIL: ${label}: ${bad} cc-api-provider entries are not a one-element array with Identifier" >&2
    exit 1
  fi
  local pl role
  pl="$(jq '[to_entries[] | select(.key | startswith("cc-api-provider:")) | .value[0] | select(has("PrefixListId"))] | length' "${CONTEXT_FILE}")"
  role="$(jq '[to_entries[] | select(.key | startswith("cc-api-provider:")) | .value[0] | select(has("Arn"))] | length' "${CONTEXT_FILE}")"
  if [ "${pl}" != "1" ] || [ "${role}" != "1" ]; then
    echo "FAIL: ${label}: expected 1 PrefixListId entry and 1 Arn entry, got ${pl} and ${role}" >&2
    exit 1
  fi
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

assert_context_arrays "phase 1"

EXPECTED_PL="$(aws ec2 describe-managed-prefix-lists --region "${REGION}" \
  --filters "Name=prefix-list-name,Values=com.amazonaws.${REGION}.s3" \
  --query 'PrefixLists[0].PrefixListId' --output text)"
EXPECTED_ROLE_ARN="$(aws iam get-role --role-name "${ROLE_NAME}" --query Role.Arn --output text)"
ACTUAL_PL="$(aws ssm get-parameter --name "${PREFIX_LIST_PARAM}" --region "${REGION}" --query Parameter.Value --output text)"
ACTUAL_ROLE_ARN="$(aws ssm get-parameter --name "${ROLE_ARN_PARAM}" --region "${REGION}" --query Parameter.Value --output text)"
if [ -z "${EXPECTED_PL}" ] || [ "${EXPECTED_PL}" = "None" ] || [ "${ACTUAL_PL}" != "${EXPECTED_PL}" ]; then
  echo "FAIL: prefix list id parameter '${ACTUAL_PL}' != live '${EXPECTED_PL}'" >&2
  exit 1
fi
if [ -z "${EXPECTED_ROLE_ARN}" ] || [ "${ACTUAL_ROLE_ARN}" != "${EXPECTED_ROLE_ARN}" ]; then
  echo "FAIL: role arn parameter '${ACTUAL_ROLE_ARN}' != live '${EXPECTED_ROLE_ARN}'" >&2
  exit 1
fi
echo "    both looked-up values reached AWS (${ACTUAL_PL}, ${ACTUAL_ROLE_ARN})"

echo "==> Phase 2: stale bare-object entries are dropped and re-looked-up"
jq 'with_entries(if (.key | startswith("cc-api-provider:")) then .value = (.value[0] | del(.Identifier)) else . end)' \
  "${CONTEXT_FILE}" >"${CONTEXT_FILE}.tmp"
mv "${CONTEXT_FILE}.tmp" "${CONTEXT_FILE}"
STALE="$(jq '[to_entries[] | select(.key | startswith("cc-api-provider:")) | .value | select(type == "object")] | length' "${CONTEXT_FILE}")"
if [ "${STALE}" != "2" ]; then
  echo "FAIL: could not stage the stale shape (got ${STALE} bare-object entries)" >&2
  exit 1
fi
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null
assert_context_arrays "phase 2"

echo "==> Phase 3: upstream cdk synth --no-lookups reads the same context file"
cdk synth --no-lookups --quiet --region "${REGION}"

echo "==> Phase 3b: cdkd synth --no-lookups (go-to-k/cdkd#6883)"
node "${LOCAL_DIST}" synth --no-lookups --region "${REGION}" >/dev/null
# Drop one entry: the app reports it missing, and with lookups disabled cdkd
# must refuse WITHOUT looking it up or writing the context file back.
DROPPED_KEY="$(jq -r '[to_entries[] | select(.key | startswith("cc-api-provider:")) | .key][0]' "${CONTEXT_FILE}")"
cp "${CONTEXT_FILE}" "${CONTEXT_FILE}.full"
jq --arg k "${DROPPED_KEY}" 'del(.[$k])' "${CONTEXT_FILE}.full" >"${CONTEXT_FILE}"
NO_LOOKUPS_RC=0
NO_LOOKUPS_ERR="$(node "${LOCAL_DIST}" synth --no-lookups --region "${REGION}" 2>&1 >/dev/null)" || NO_LOOKUPS_RC=$?
if [ "${NO_LOOKUPS_RC}" = "0" ]; then
  echo "FAIL: cdkd synth --no-lookups succeeded with ${DROPPED_KEY} missing" >&2
  exit 1
fi
# Two independent markers: the refusal's opening clause, and the dropped key
# named after `Missing context keys:` — a reword of either fails loudly.
if ! grep -qF 'Context lookups have been disabled' <<<"${NO_LOOKUPS_ERR}" ||
  ! grep -qF "Missing context keys: '${DROPPED_KEY}'" <<<"${NO_LOOKUPS_ERR}"; then
  echo "FAIL: cdkd synth --no-lookups exited ${NO_LOOKUPS_RC} without the lookups-disabled refusal naming ${DROPPED_KEY}: ${NO_LOOKUPS_ERR}" >&2
  exit 1
fi
if [ "$(jq --arg k "${DROPPED_KEY}" 'has($k)' "${CONTEXT_FILE}")" != "false" ]; then
  echo "FAIL: cdkd synth --no-lookups looked ${DROPPED_KEY} up and wrote it to cdk.context.json" >&2
  exit 1
fi
mv "${CONTEXT_FILE}.full" "${CONTEXT_FILE}"
echo "    cdkd synth --no-lookups passes on cached context and refuses a missing key without writing it"

echo "==> Phase 4: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "parameter ${PREFIX_LIST_PARAM} still exists after destroy" aws ssm get-parameter --name "${PREFIX_LIST_PARAM}" --region "${REGION}"
assert_gone "parameter ${ROLE_ARN_PARAM} still exists after destroy" aws ssm get-parameter --name "${ROLE_ARN_PARAM}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Delete the out-of-band IAM role"
aws iam delete-role --role-name "${ROLE_NAME}"
assert_gone "role ${ROLE_NAME} still exists after delete-role" aws iam get-role --role-name "${ROLE_NAME}"

echo "[verify] PASS — cc-api-provider lookups (PrefixList.fromLookup, Role.fromLookup) are stored as one-element arrays with Identifier, a stale bare-object entry is re-looked-up by cdkd synth, upstream cdk synth --no-lookups accepts the same context file, cdkd synth --no-lookups accepts it and refuses a missing key without writing it (go-to-k/cdkd#6883), and destroy leaves nothing behind (go-to-k/cdkd#6542)"
