#!/usr/bin/env bash
#
# `cdkd import` of resources a `NoEcho: true` template parameter feeds
# (go-to-k/cdkd#4043, Phase C, design section 4.5).
#
# Phases:
#   1. `cdk deploy` (UPSTREAM) the stack, binding both `NoEcho` parameters to
#      their per-run `Default`s. PREMISE: AWS holds both values.
#   2. `cdkd import --migrate-from-cloudformation --yes`.
#   3. state.json holds `***` at both NoEcho-fed `Value`s (the 3-character one
#      only by POSITION), `noEchoLeaves` names each, the observed baselines hold
#      `***` there, the plain control is in the clear, and no state blob carries
#      either value.
#   4. The next `cdkd deploy` is a no-op: neither SSM parameter is updated
#      (LastModifiedDate unchanged) and nothing is replaced.
#   5. `cdkd scrub --dry-run --fail` exits 0: scrub agrees with what import wrote.
#   6. No object VERSION under the stack's prefix carries either value.
#   7. `cdkd destroy`, gone-probes, and the S3 version sweep.
#
# The values are generated per run and never printed.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1
set -euo pipefail
cd "$(dirname "$0")"

# Vendored cdk CLI (issue 1485): install the fixture's deps when absent, or
# `npx cdk` falls through to a possibly stale global CLI.
[ -x "${PWD}/node_modules/.bin/cdk" ] || npm install
export PATH="${PWD}/node_modules/.bin:${PATH}"

# Shared S3 VERSION-sweep helpers (issue #2096): the bucket is versioned.
. ../s3-versions.sh

STACK="CdkdImportNoEchoParameterExample"
REGION="${AWS_REGION:-us-east-1}"
LOCAL_DIST="${PWD}/../../../dist/cli.js"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: built CLI not found at ${LOCAL_DIST} — run 'vp run build' from the repo root" >&2
  exit 1
fi

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

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CONSUMER_NAME="cdkd-test-import-noecho-${ACCOUNT_ID}"
SHORT_NAME="cdkd-test-import-noecho-short-${ACCOUNT_ID}"
PLAIN_NAME="cdkd-test-import-noecho-plain-${ACCOUNT_ID}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"

# Per run. Letters, digits and dashes; the short one is exactly 3 characters.
TOKEN="cdkd-import-noecho-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
SHORT="q$(od -An -N1 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#TOKEN}" -lt 20 ] || [ "${#SHORT}" -ne 3 ]; then
  echo "FAIL: premise: could not generate the NoEcho values" >&2
  exit 1
fi
export CDKD_TEST_IMPORT_NOECHO_TOKEN="${TOKEN}"
export CDKD_TEST_IMPORT_NOECHO_SHORT="${SHORT}"

SCRATCH_FILES=()
cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ "${#SCRATCH_FILES[@]}" -gt 0 ]; then
    rm -f "${SCRATCH_FILES[@]}" || true
  fi
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
  fi
  aws ssm delete-parameters --names "${CONSUMER_NAME}" "${SHORT_NAME}" "${PLAIN_NAME}" \
    --region "${REGION}" >/dev/null 2>&1 || true
  # The CloudFormation stack exists only if the run died before the migration
  # retired it; its resources were deleted by name above.
  npx cdk destroy "${STACK}" --force >/dev/null 2>&1 || true
  s3_purge_prefix_versions "${STATE_BUCKET:-}" "${STATE_PREFIX:-}" noncurrent || true
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# A captured output must never be echoed when it may carry a value.
assert_no_value() { # assert_no_value <label> <text>
  if [[ "$2" == *"${TOKEN}"* ]] || grep -qE "(^|[^A-Za-z0-9])${SHORT}([^A-Za-z0-9]|$)" <<< "$2"; then
    echo "FAIL: $1 carries a NoEcho value in plaintext (issue #4043)" >&2
    exit 1
  fi
}

echo "==> Pre-flight: no leftovers from an earlier run"
if aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK}" >/dev/null 2>&1; then
  echo "FAIL: CloudFormation stack ${STACK} already exists — clean it up first" >&2
  exit 1
fi
assert_gone "premise: ${CONSUMER_NAME} already exists" \
  aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}"

# --- Phase 1 ------------------------------------------------------------------
echo "==> Phase 1: cdk deploy (upstream), both NoEcho parameters at their Defaults"
npx cdk deploy "${STACK}" --require-approval never >/dev/null 2>&1 || {
  echo "FAIL: cdk deploy exited non-zero (output withheld: it may print the parameters)" >&2
  exit 1
}
if [ "$(aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}" --query Parameter.Value --output text)" != "token-${TOKEN}" ] \
  || [ "$(aws ssm get-parameter --name "${SHORT_NAME}" --region "${REGION}" --query Parameter.Value --output text)" != "${SHORT}" ]; then
  echo "FAIL: premise: AWS does not hold the NoEcho values after cdk deploy" >&2
  exit 1
fi
echo "    OK: AWS holds both values"

# --- Phase 2 ------------------------------------------------------------------
echo "==> Phase 2: cdkd import --migrate-from-cloudformation"
set +e
# `cdkd import` takes the region from AWS_REGION (it declares no --region).
IMPORT_OUT=$(AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" \
  --migrate-from-cloudformation --state-bucket "${STATE_BUCKET}" --yes 2>&1)
IMPORT_RC=$?
set -e
assert_no_value "the cdkd import output" "${IMPORT_OUT}"
if [ "${IMPORT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd import exited ${IMPORT_RC}" >&2
  printf '%s\n' "${IMPORT_OUT}" >&2
  exit 1
fi
echo "    OK: imported"

# --- Phase 3 ------------------------------------------------------------------
echo "==> Phase 3: state.json holds *** at every NoEcho position, named in noEchoLeaves"
STATE_P3=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")
assert_no_value "state.json after cdkd import" "${STATE_P3}"
P3_SHAPE=$(jq -c '[
  .resources.NoEchoConsumer.properties.Value,
  (.resources.NoEchoConsumer.noEchoLeaves // [] | index([["Value"]]) != null),
  .resources.NoEchoShortConsumer.properties.Value,
  (.resources.NoEchoShortConsumer.noEchoLeaves // [] | index([["Value"]]) != null),
  .resources.PlainConsumer.properties.Value,
  (.resources.PlainConsumer.noEchoLeaves == null)
]' <<< "${STATE_P3}")
if [ "${P3_SHAPE}" != '["***",true,"***",true,"plain-control-value",true]' ]; then
  echo "FAIL: state.json after cdkd import does not hold *** at both NoEcho positions named in noEchoLeaves, with the plain control in the clear (got ${P3_SHAPE})" >&2
  exit 1
fi
P3_OBSERVED=$(jq -c '[.resources.NoEchoConsumer.observedProperties.Value, .resources.NoEchoShortConsumer.observedProperties.Value]' <<< "${STATE_P3}")
if [ "${P3_OBSERVED}" != '["***","***"]' ]; then
  echo "FAIL: the observed baselines do not hold *** at the NoEcho positions (got ${P3_OBSERVED})" >&2
  exit 1
fi
echo "    OK: *** at both positions (the 3-character one by position), named in noEchoLeaves"

# --- Phase 4 ------------------------------------------------------------------
echo "==> Phase 4: the next cdkd deploy is a no-op"
mod_date() { # mod_date <name>
  aws ssm describe-parameters --region "${REGION}" \
    --parameter-filters "Key=Name,Option=Equals,Values=$1" \
    --query 'Parameters[0].LastModifiedDate' --output text || return 1
}
BEFORE_LONG=$(mod_date "${CONSUMER_NAME}")
BEFORE_SHORT=$(mod_date "${SHORT_NAME}")
set +e
DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_RC=$?
set -e
assert_no_value "the post-import cdkd deploy output" "${DEPLOY_OUT}"
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: the post-import cdkd deploy exited ${DEPLOY_RC}" >&2
  printf '%s\n' "${DEPLOY_OUT}" >&2
  exit 1
fi
if [ "$(mod_date "${CONSUMER_NAME}")" != "${BEFORE_LONG}" ] || [ "$(mod_date "${SHORT_NAME}")" != "${BEFORE_SHORT}" ]; then
  echo "FAIL: the post-import cdkd deploy updated a NoEcho-fed SSM parameter -- the imported record did not read as unchanged (issue #4043)" >&2
  exit 1
fi
if grep -qiE 'replac' <<< "${DEPLOY_OUT}"; then
  echo "FAIL: the post-import cdkd deploy reports a replacement" >&2
  exit 1
fi
echo "    OK: no update, no replacement"

# --- Phase 5 ------------------------------------------------------------------
echo "==> Phase 5: cdkd scrub --dry-run --fail agrees with what import wrote"
set +e
SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --dry-run --fail 2>&1)
SCRUB_RC=$?
set -e
assert_no_value "the cdkd scrub output" "${SCRUB_OUT}"
if [ "${SCRUB_RC}" -ne 0 ]; then
  echo "FAIL: cdkd scrub --dry-run --fail exited ${SCRUB_RC} on the imported stack" >&2
  printf '%s\n' "${SCRUB_OUT}" >&2
  exit 1
fi
echo "    OK: scrub finds nothing to do"

# --- Phase 6 ------------------------------------------------------------------
echo "==> Phase 6: no object version under the stack's prefix carries a value"
VERSION_ROWS=$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
  --prefix "${STATE_PREFIX}" --output json \
  | jq -r '.Versions // [] | .[] | "\(.Key)\t\(.VersionId)"')
VERSIONS_SCANNED=0
while IFS=$'\t' read -r version_key version_id || [ -n "${version_key}" ]; do
  [ -n "${version_key}" ] || continue
  VERSION_FILE=$(mktemp)
  SCRATCH_FILES+=("${VERSION_FILE}")
  aws s3api get-object --bucket "${STATE_BUCKET}" --key "${version_key}" \
    --version-id "${version_id}" "${VERSION_FILE}" >/dev/null
  VERSIONS_SCANNED=$((VERSIONS_SCANNED + 1))
  assert_no_value "an object version of ${version_key}" "$(cat "${VERSION_FILE}")"
done < <(printf '%s\n' "${VERSION_ROWS}")
if [ "${VERSIONS_SCANNED}" -lt 2 ]; then
  echo "FAIL: the version scan read ${VERSIONS_SCANNED} object version(s) under ${STATE_PREFIX} -- the negative above passes for free" >&2
  exit 1
fi
echo "    OK: ${VERSIONS_SCANNED} versions scanned, none carries a value"

# --- Phase 7 ------------------------------------------------------------------
echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "${CONSUMER_NAME} exists after destroy" \
  aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}"
assert_gone "${SHORT_NAME} exists after destroy" \
  aws ssm get-parameter --name "${SHORT_NAME}" --region "${REGION}"
assert_gone "${PLAIN_NAME} exists after destroy" \
  aws ssm get-parameter --name "${PLAIN_NAME}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "import-noecho-parameter state teardown"

echo "[verify] PASS - cdkd import stores a NoEcho parameter's position as *** named in noEchoLeaves (a 3-character value by position), the next deploy is a no-op, and scrub agrees"
