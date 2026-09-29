#!/usr/bin/env bash
# verify.sh - cdkd scrub-nested-child integ (issue #2252).
#
# A nested-stack CHILD record (`cdkd/<Parent>~Child/<region>/state.json`) that
# a binary older than issue #1903 wrote with the DECRYPTED secret could not be
# remediated: `cdkd scrub` only visited synth stacks, so it never examined the
# record, and `--dry-run --fail` exited 0 over it. The fix reaches the child
# THROUGH its parent -- the parent's resolution of the child's `Parameters`
# block is the only place the `{{resolve:...}}` expression behind the child's
# `{Ref: DbPassword}` is visible.
#
# Phases:
#   1. deploy with the current binary; the child record holds the EXPRESSION.
#   2. SEED the pre-#1903 shape out of band: rewrite the child's state.json so
#      the SSM parameter's `Value` and the `PwOut` output hold the plaintext.
#      ALSO seed the PARENT row's `Outputs.ApiOut` attribute -- the mirror of
#      the child's OWN `{{resolve:...}}` output -- with its plaintext, as a
#      pre-#1899 parent record held it (issue #3961). Only the child's scrub
#      learns that needle, so this is repaired after the child is.
#   3. `cdkd scrub --dry-run --fail` must exit 1 naming the child -- the
#      pre-fix binary exited 0 here, which is this fixture's discriminator.
#   4. `cdkd scrub <parent>` rewrites the child record; the CURRENT object
#      holds the expression and no plaintext, and AWS was not touched.
#   5. VERSIONS. scrub rewrites with a plain PutObject and does not purge
#      (docs/cli-scrub.md, "Scrubbing supersedes the plaintext, it does not
#      erase it"), so the seeded body must survive as a NONCURRENT version --
#      asserted, because the summary line claims it. The script then applies
#      the documented remedy (delete those version ids) and asserts that NO
#      surviving version under either stack's prefix holds the plaintext.
#   6. a second `--dry-run --fail` exits 0 and reports the child clean.
#   7. destroy, then the full version sweep.
#
# SECURITY: the secret value is random per run and never echoed; every cdkd
# output this script captures is scanned for it.
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

# `delete-secret --force-delete-without-recovery` is asynchronous: a single
# probe straight after it can read the pre-delete view. Poll, keeping
# gone_probe's tri-state so an undetermined error still fails fast.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout_s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local waited=0
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${waited}" -ge "${timeout}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s of polling)" >&2
      exit 1
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done
}

cd "$(dirname "$0")"

export AWS_PAGER=""

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture SEEDS a secret
# plaintext into state on purpose, so the sweep is not hygiene but the point.
. ../s3-versions.sh

STACK="CdkdScrubNestedChildVerify"
CHILD_STACK="${STACK}~Child"
REGION="${AWS_REGION:-us-east-1}"
PARENT_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PARENT_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Out-of-band secret, named as lib/scrub-nested-child-stack.ts names it.
SECRET_NAME="cdkd-scrub-nested-child-${ACCOUNT_ID}"
SECRET_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password::}}"
# The child's OWN reference, published as an output (issue #3961).
API_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:api::}}"
# The one resource the child owns.
CHILD_PARAM_NAME="cdkd-scrub-nested-child-pw-${ACCOUNT_ID}"

# Random per run, so a version a PREVIOUS run left behind can never satisfy an
# assertion about this one. Exported so jq reads it from the environment rather
# than from its argv.
PW_VALUE="cdkd-scrub-nested-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export PW_VALUE
API_VALUE="cdkd-scrub-nested-api-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
export API_VALUE

# Whether a FILE holds either plaintext. The needles come from a 0600 file,
# never argv, so neither value shows in the process list. Written lazily
# because WORK_DIR is re-created after the pre-run cleanup.
holds_plaintext() {
  local needles="${WORK_DIR}/needles"
  if [ ! -f "${needles}" ]; then
    ( umask 077 && printf '%s\n%s\n' "${PW_VALUE}" "${API_VALUE}" > "${needles}" ) \
      || { echo "FAIL: could not write the needles file ${needles}" >&2; exit 1; }
  fi
  grep -qFf "${needles}" -- "$1"
}

strip_ansi() { sed -e $'s/\033\\[[0-9;]*m//g'; }

# run_cdkd <log-name> <args...> - run the local binary, keep its output (ANSI
# stripped) in ${WORK_DIR}/<log-name>.txt, and set CDKD_RC. A pipe into
# strip_ansi inside `$( )` would lose the exit status.
run_cdkd() {
  local name="$1"
  shift
  CDKD_RC=0
  node "${LOCAL_DIST}" "$@" > "${WORK_DIR}/${name}.log" 2>&1 || CDKD_RC=$?
  strip_ansi < "${WORK_DIR}/${name}.log" > "${WORK_DIR}/${name}.txt"
}

WORK_DIR="$(mktemp -d)"

# Fail if any captured cdkd output carries the plaintext. The value itself is
# never printed, not even here.
assert_no_plaintext_in() { # usage: assert_no_plaintext_in "<what>" "<text>"
  if [[ "$2" == *"${PW_VALUE}"* || "$2" == *"${API_VALUE}"* ]]; then
    echo "FAIL: $1 carries the secret plaintext" >&2
    exit 1
  fi
}

# The number of object VERSIONS (not delete markers, which have no body) under
# <prefix> whose body contains the plaintext. Every key under the prefix is
# read -- state.json, lock.json, rollback-journal.json, deployments/** -- since
# the journal and the events store hold copies of state. Prints the count;
# returns 1 when the listing or any read failed, so "0" is never "could not
# tell". Page-safe: rows of a projection, never `length()`.
count_plaintext_versions() { # usage: count_plaintext_versions <prefix>
  local prefix="$1" rows key vid n=0 body
  rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${prefix}" \
    --region "${REGION}" --query '(Versions || `[]`)[].[Key,VersionId]' --output text)" || return 1
  body="${WORK_DIR}/version-body"
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" --version-id "${vid}" \
      --region "${REGION}" "${body}" >/dev/null || return 1
    if holds_plaintext "${body}"; then
      n=$(( n + 1 ))
    fi
  done <<EOF
${rows}
EOF
  rm -f "${body}"
  printf '%s\n' "${n}"
}

# Delete every version of <key> whose body holds the plaintext -- the manual
# step docs/cli-scrub.md prescribes after a scrub. Returns 1 on any failure.
delete_plaintext_versions() { # usage: delete_plaintext_versions <key>
  local target="$1" rows key vid body
  rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" --prefix "${target}" \
    --region "${REGION}" --query '(Versions || `[]`)[].[Key,VersionId]' --output text)" || return 1
  body="${WORK_DIR}/version-body"
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ "${key}" = "${target}" ] || continue
    aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" --version-id "${vid}" \
      --region "${REGION}" "${body}" >/dev/null || return 1
    if holds_plaintext "${body}"; then
      aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${key}" --version-id "${vid}" \
        --region "${REGION}" >/dev/null || return 1
    fi
  done <<EOF
${rows}
EOF
  rm -f "${body}"
}

cleanup() {
  (
    set +eu
    echo "==> Cleanup: dropping leftover state + AWS resources"
    if [ -f "${LOCAL_DIST}" ]; then
      node "${LOCAL_DIST}" destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    fi
    # The child's parameter, in case a destroy left it; the secret is this
    # script's own and nothing else deletes it.
    aws ssm delete-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      # NONCURRENT-only: this runs from the pre-run sweep and from the failure
      # and signal traps, where a live state.json may be the only record of
      # resources still standing. The success path does the full sweep.
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX:-}" noncurrent
    fi
    rm -rf "${WORK_DIR:-/nonexistent-cdkd-scrub-nested}"
  )
}

# `trap cleanup EXIT INT TERM` is NOT equivalent and must never be used: a bash
# signal handler returns to the interrupted point, so the script would resume
# the interrupted phase and could exit 0 while resources leak.
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

echo "=== cdkd scrub over a nested-stack child record (#2252) ==="
echo "Stack:        ${STACK}"
echo "Child stack:  ${CHILD_STACK}"
echo "Region:       ${REGION}"
echo "State bucket: ${STATE_BUCKET}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup
WORK_DIR="$(mktemp -d)"

# The pre-run cleanup force-deletes a secret an aborted run left behind, and
# that delete is ASYNCHRONOUS: re-creating the same name straight after it
# fails with "already scheduled for deletion". Returns at once when none was.
assert_gone_eventually 60 "leftover secret ${SECRET_NAME} from an earlier run" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"

echo "==> Creating the secret out of band"
# From a file, not argv, so the value never appears in the process list.
SECRET_FILE="${WORK_DIR}/secret.json"
( umask 077 && jq -n '{password: env.PW_VALUE, api: env.API_VALUE}' > "${SECRET_FILE}" )
aws secretsmanager create-secret --name "${SECRET_NAME}" \
  --secret-string "file://${SECRET_FILE}" \
  --region "${REGION}" >/dev/null
rm -f "${SECRET_FILE}"

# --- Phase 1: deploy ----------------------------------------------------------
echo "==> Phase 1: deploy"
run_cdkd deploy deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
DEPLOY_RC=${CDKD_RC}
DEPLOY_OUT="$(cat "${WORK_DIR}/deploy.txt")"
assert_no_plaintext_in "phase 1 deploy output" "${DEPLOY_OUT}"
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: phase 1 deploy exited ${DEPLOY_RC}" >&2
  printf '%s\n' "${DEPLOY_OUT}" | tail -40 >&2
  exit 1
fi

aws s3api get-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" \
  "${WORK_DIR}/child-deployed.json" >/dev/null
# Premise: the current binary's deploy wrote the EXPRESSION in both positions,
# so the seed below is what puts the plaintext there, and nothing else.
for path in '.resources.PwParam.properties.Value' '.outputs.PwOut'; do
  got="$(jq -r "${path}" "${WORK_DIR}/child-deployed.json")"
  if [ "${got}" != "${SECRET_EXPR}" ]; then
    echo "FAIL: premise: child ${path} after deploy is not the secret expression" >&2
    exit 1
  fi
done
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" \
  "${WORK_DIR}/parent-deployed.json" >/dev/null
if [ "$(jq -r '.outputs.ApiOut' "${WORK_DIR}/child-deployed.json")" != "${API_EXPR}" ] \
  || [ "$(jq -r '.resources.Child.attributes["Outputs.ApiOut"]' "${WORK_DIR}/parent-deployed.json")" != "${API_EXPR}" ]; then
  echo "FAIL: premise: the child's ApiOut output and the parent's Outputs.ApiOut attribute are not the expression after deploy" >&2
  exit 1
fi
if holds_plaintext "${WORK_DIR}/parent-deployed.json"; then
  echo "FAIL: premise: the deployed parent record already holds a plaintext" >&2
  exit 1
fi
if holds_plaintext "${WORK_DIR}/child-deployed.json"; then
  echo "FAIL: premise: the deployed child record already holds the plaintext" >&2
  exit 1
fi
# The live parameter holds the resolved value: the secret really flowed.
LIVE="$(aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${LIVE}" != "${PW_VALUE}" ]; then
  echo "FAIL: the live child parameter does not hold the resolved secret" >&2
  exit 1
fi
echo "    OK: child record holds the expression; the live parameter holds the secret"

# --- Phase 2: seed the pre-#1903 child record ---------------------------------
echo "==> Phase 2: seeding the child record as a pre-#1903 binary wrote it"
jq '.resources.PwParam.properties.Value = env.PW_VALUE | .outputs.PwOut = env.PW_VALUE' \
  "${WORK_DIR}/child-deployed.json" > "${WORK_DIR}/child-seeded.json"
aws s3api put-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" \
  --body "${WORK_DIR}/child-seeded.json" >/dev/null
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" \
  "${WORK_DIR}/child-seeded-readback.json" >/dev/null
SEEDED_HITS="$(jq -r '[.resources.PwParam.properties.Value, .outputs.PwOut] | map(select(. == env.PW_VALUE)) | length' \
  "${WORK_DIR}/child-seeded-readback.json")"
if [ "${SEEDED_HITS}" -ne 2 ]; then
  echo "FAIL: premise: the seeded child record does not hold the plaintext in both positions" >&2
  exit 1
fi
echo "    OK: the child record now holds the plaintext in the resource and the output"

# The parent row's mirror of the child's OWN output, as a pre-#1899 parent
# record held it (issue #3961). The child record keeps its expression there:
# only the child's scrub knows the needle, and only the parent holds the leak.
jq '.resources.Child.attributes["Outputs.ApiOut"] = env.API_VALUE' \
  "${WORK_DIR}/parent-deployed.json" > "${WORK_DIR}/parent-seeded.json"
aws s3api put-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" \
  --body "${WORK_DIR}/parent-seeded.json" >/dev/null
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" \
  "${WORK_DIR}/parent-seeded-readback.json" >/dev/null
if [ "$(jq -r '.resources.Child.attributes["Outputs.ApiOut"] == env.API_VALUE' "${WORK_DIR}/parent-seeded-readback.json")" != "true" ]; then
  echo "FAIL: premise: the seeded parent record does not hold the child output's plaintext" >&2
  exit 1
fi
echo "    OK: the parent row's Outputs.ApiOut attribute now holds the child's own plaintext"

# --- Phase 3: the CI gate sees the child ------------------------------------
echo "==> Phase 3: cdkd scrub --dry-run --fail must exit 1 over the child"
run_cdkd scrub-dry scrub "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --dry-run --fail
DRY_RC=${CDKD_RC}
DRY_OUT="$(cat "${WORK_DIR}/scrub-dry.txt")"
assert_no_plaintext_in "cdkd scrub --dry-run output" "${DRY_OUT}"
DRY_LINE="$(printf '%s\n' "${DRY_OUT}" | grep -F "resource record(s) in ${CHILD_STACK}" || true)"
if [ "${DRY_RC}" -eq 0 ]; then
  echo "FAIL: --dry-run --fail exited 0 over a child record holding plaintext -- the #2252 false green" >&2
  printf '%s\n' "${DRY_OUT}" | tail -20 >&2
  exit 1
fi
if [ "${DRY_RC}" -ne 1 ]; then
  echo "FAIL: --dry-run --fail exited ${DRY_RC}, expected 1 (found plaintext)" >&2
  printf '%s\n' "${DRY_OUT}" | tail -20 >&2
  exit 1
fi
# Sentinel: exit 1 with no per-stack line naming the child means the wording
# drifted, not that the child was found -- fail loudly rather than pass.
if [ -z "${DRY_LINE}" ] || ! printf '%s' "${DRY_LINE}" | grep -qF 'Would scrub'; then
  echo "FAIL: --dry-run --fail exited 1 but printed no 'Would scrub ... in ${CHILD_STACK}' line (wording drift?)" >&2
  printf '%s\n' "${DRY_OUT}" | tail -20 >&2
  exit 1
fi
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" \
  "${WORK_DIR}/child-after-dry.json" >/dev/null
if ! cmp -s "${WORK_DIR}/child-after-dry.json" "${WORK_DIR}/child-seeded-readback.json"; then
  echo "FAIL: --dry-run changed the child record" >&2
  exit 1
fi
if ! printf '%s\n' "${DRY_OUT}" | grep -qF "Would scrub 1 nested-stack output attribute(s) in ${STACK}"; then
  echo "FAIL: --dry-run printed no 'Would scrub 1 nested-stack output attribute(s) in ${STACK}' line (#3961)" >&2
  printf '%s\n' "${DRY_OUT}" | tail -20 >&2
  exit 1
fi
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" \
  "${WORK_DIR}/parent-after-dry.json" >/dev/null
if ! cmp -s "${WORK_DIR}/parent-after-dry.json" "${WORK_DIR}/parent-seeded-readback.json"; then
  echo "FAIL: --dry-run changed the parent record" >&2
  exit 1
fi
echo "    OK: the gate names the child and the parent attribute and exits 1; nothing was written"

# --- Phase 4: the remediation -----------------------------------------------
echo "==> Phase 4: cdkd scrub ${STACK} rewrites the child record"
run_cdkd scrub scrub "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"
SCRUB_RC=${CDKD_RC}
SCRUB_OUT="$(cat "${WORK_DIR}/scrub.txt")"
assert_no_plaintext_in "cdkd scrub output" "${SCRUB_OUT}"
if [ "${SCRUB_RC}" -ne 0 ]; then
  echo "FAIL: cdkd scrub exited ${SCRUB_RC}" >&2
  printf '%s\n' "${SCRUB_OUT}" | tail -20 >&2
  exit 1
fi
if ! printf '%s\n' "${SCRUB_OUT}" | grep -qF "Scrubbed 2 resource record(s) in ${CHILD_STACK}"; then
  # Sentinel: a scrub that exited 0 without this line either rewrote a
  # different count or its wording drifted; either way the phase proves nothing.
  echo "FAIL: cdkd scrub printed no 'Scrubbed 2 resource record(s) in ${CHILD_STACK}' line" >&2
  printf '%s\n' "${SCRUB_OUT}" | tail -20 >&2
  exit 1
fi
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}" \
  "${WORK_DIR}/child-scrubbed.json" >/dev/null
for path in '.resources.PwParam.properties.Value' '.outputs.PwOut'; do
  got="$(jq -r "${path}" "${WORK_DIR}/child-scrubbed.json")"
  if [ "${got}" != "${SECRET_EXPR}" ]; then
    echo "FAIL: child ${path} after scrub is not the secret expression" >&2
    exit 1
  fi
done
if holds_plaintext "${WORK_DIR}/child-scrubbed.json"; then
  echo "FAIL: the CURRENT child state.json still holds the plaintext after scrub" >&2
  exit 1
fi
if ! printf '%s\n' "${SCRUB_OUT}" | grep -qF "Scrubbed 1 nested-stack output attribute(s) in ${STACK}"; then
  echo "FAIL: cdkd scrub printed no 'Scrubbed 1 nested-stack output attribute(s) in ${STACK}' line (#3961)" >&2
  printf '%s\n' "${SCRUB_OUT}" | tail -20 >&2
  exit 1
fi
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}" \
  "${WORK_DIR}/parent-scrubbed.json" >/dev/null
if [ "$(jq -r '.resources.Child.attributes["Outputs.ApiOut"]' "${WORK_DIR}/parent-scrubbed.json")" != "${API_EXPR}" ]; then
  echo "FAIL: the parent's Outputs.ApiOut attribute is not the child output's expression after scrub (#3961)" >&2
  exit 1
fi
if holds_plaintext "${WORK_DIR}/parent-scrubbed.json"; then
  echo "FAIL: the CURRENT parent state.json still holds a plaintext after scrub (#3961)" >&2
  exit 1
fi
# scrub touches no AWS resource: the live value is what the deploy put there.
LIVE="$(aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${LIVE}" != "${PW_VALUE}" ]; then
  echo "FAIL: cdkd scrub changed the live child parameter" >&2
  exit 1
fi
echo "    OK: the current child record holds the expression and no plaintext"

# --- Phase 5: surviving versions --------------------------------------------
echo "==> Phase 5: the seeded body survives as a noncurrent version, then is removed"
# Both seeded keys: the child record, and the parent record (issue #3961).
for key in "${CHILD_KEY}" "${PARENT_KEY}"; do
  if ! SURVIVING="$(count_plaintext_versions "${key}")"; then
    echo "FAIL: could not read the versions of ${key}" >&2
    exit 1
  fi
  # The claim scrub's summary line makes: a versioned bucket keeps the
  # pre-scrub body. Zero here would mean either the bucket is not versioned
  # (then the assertion below is vacuous) or the listing is broken.
  if [ "${SURVIVING}" -lt 1 ]; then
    echo "FAIL: premise: no version of ${key} holds the seeded plaintext -- is the state bucket versioned?" >&2
    exit 1
  fi
  echo "    OK: ${SURVIVING} noncurrent version(s) of ${key} hold the seeded plaintext, as documented"
  if ! delete_plaintext_versions "${key}"; then
    echo "FAIL: could not delete the plaintext-bearing versions of ${key}" >&2
    exit 1
  fi
done
for prefix in "${CHILD_PREFIX}" "${PARENT_PREFIX}"; do
  if ! LEFT="$(count_plaintext_versions "${prefix}")"; then
    echo "FAIL: could not read the versions under ${prefix}" >&2
    exit 1
  fi
  if [ "${LEFT}" -ne 0 ]; then
    echo "FAIL: ${LEFT} surviving version(s) under ${prefix} still hold the plaintext" >&2
    exit 1
  fi
done
echo "    OK: no surviving version under either stack's prefix holds the plaintext"

# --- Phase 6: the gate is green now ------------------------------------------
echo "==> Phase 6: cdkd scrub --dry-run --fail exits 0 over the repaired child and parent"
run_cdkd scrub-clean scrub "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --dry-run --fail
CLEAN_RC=${CDKD_RC}
CLEAN_OUT="$(cat "${WORK_DIR}/scrub-clean.txt")"
assert_no_plaintext_in "second cdkd scrub --dry-run output" "${CLEAN_OUT}"
if [ "${CLEAN_RC}" -ne 0 ]; then
  echo "FAIL: --dry-run --fail exited ${CLEAN_RC} over a repaired child" >&2
  printf '%s\n' "${CLEAN_OUT}" | tail -20 >&2
  exit 1
fi
if ! printf '%s\n' "${CLEAN_OUT}" | grep -qF "No plaintext secrets found in ${CHILD_STACK}"; then
  echo "FAIL: the clean run printed no 'No plaintext secrets found in ${CHILD_STACK}' line -- was the child visited?" >&2
  printf '%s\n' "${CLEAN_OUT}" | tail -20 >&2
  exit 1
fi
echo "    OK: the child is visited and reported clean"

# --- Phase 7: destroy -------------------------------------------------------
echo "==> Phase 7: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "child parameter ${CHILD_PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${CHILD_PARAM_NAME}" --region "${REGION}"
assert_gone "state file ${CHILD_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}" --region "${REGION}"
assert_gone "state file ${PARENT_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}" --region "${REGION}"

trap - EXIT INT TERM

aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null
assert_gone_eventually 60 "out-of-band secret '${SECRET_NAME}' still exists after its force-delete" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"

s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PARENT_PREFIX}" "scrub-nested-child parent state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "scrub-nested-child child state teardown"
rm -rf "${WORK_DIR}"

echo "[verify] PASS — cdkd scrub repaired a seeded pre-#1903 nested child record through its parent (#2252) and the parent row's child-sourced output attribute (#3961)"
