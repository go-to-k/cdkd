#!/usr/bin/env bash
# verify.sh - a BARE cdkd invocation (no --region, no AWS_REGION) takes the
# AWS profile's region, and still finds a stack the old us-east-1 default
# wrote (go-to-k/cdkd#2100).
#
# Before #2100, a bare command keyed state by a `us-east-1` literal whatever
# the profile said. The fix resolves the profile's region, and HOLDS an
# env-agnostic stack on us-east-1 while it has state there and none in the
# profile region, so an upgrade never re-creates a live stack.
#
# The profile is simulated in isolation: the caller's credentials are exported
# into the environment (`aws configure export-credentials`, which works for SSO
# and assumed-role profiles too), and `AWS_CONFIG_FILE` points at a temp file
# whose `[default]` profile carries only `region = ${PROFILE_REGION}`.
#
# Phases:
#   1. Pre-upgrade stack: deploy with AWS_REGION=us-east-1 (exactly what a bare
#      deploy did before #2100). State lands under .../us-east-1/state.json and
#      the SSM parameter in us-east-1 holds 'us-east-1'.
#   2. Bare deploy under the profile region: it must say it is holding the
#      stack on us-east-1, report no changes, and create NOTHING in the profile
#      region (no state key there, no parameter there).
#   2b. Bare deploy of an UPDATE (-c paramDescription=v2) while held: the
#      us-east-1 parameter is updated in place (same region, new description),
#      and still nothing exists in the profile region - so the held run's
#      CLIENTS, not only its state key, are in us-east-1.
#   3. Bare diff: the same hold, and no differences.
#   4. Bare destroy: destroys the us-east-1 stack; parameter and state gone.
#   5. Fresh bare deploy: no state anywhere, so the stack goes to the PROFILE
#      region - state key, parameter and its AWS::Region value all say so, and
#      nothing is written under us-east-1.
#   6. Bare destroy: gone from the profile region.
#   7. Bare deploy with AWS_DEFAULT_REGION set to a THIRD region (the SDK never
#      reads that variable): state, parameter and AWS::Region are all in it,
#      and nothing is in the profile region.
#   8. Bare destroy with the same AWS_DEFAULT_REGION deletes it there.
# Exports index: with a profile-region index present (seeded when absent) AND
# the us-east-1 one, the held stack's export goes to the us-east-1 file only,
# and after the destroy neither index names it.
# Not reached here (unit-tested only): an app of several stacks, the
# legacy-bucket fallback, a named `[profile X]`, `cdkd import`, and an app
# that reads AWS_REGION into `env.region` (cdkd keeps its own AWS_REGION copy
# of an AWS_DEFAULT_REGION answer out of the app's environment).
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket
# Optional:
#   CDKD_PROFILE_REGION - the simulated profile region (default us-west-2;
#                         must not be us-east-1, or the run proves nothing)
#   CDKD_DEFAULT_ENV_REGION - the AWS_DEFAULT_REGION region of phases 7-8
#                         (default us-east-2; must differ from both)

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

STACK="CdkdProfileRegionDefaultExample"
LEGACY_REGION="us-east-1"
PROFILE_REGION="${CDKD_PROFILE_REGION:-us-west-2}"
# A THIRD region, reached only through AWS_DEFAULT_REGION (phase 7): the AWS
# SDK for JavaScript never reads that variable, so cdkd must carry it to its
# clients itself.
DEFAULT_ENV_REGION="${CDKD_DEFAULT_ENV_REGION:-us-east-2}"
DEFAULT_ENV_STATE_KEY="cdkd/${STACK}/${DEFAULT_ENV_REGION}/state.json"
EXPORT_NAME="CdkdProfileRegionDefaultParamName"
PARAM="/cdkd-integ/profile-region-default/region"
LEGACY_STATE_KEY="cdkd/${STACK}/${LEGACY_REGION}/state.json"
PROFILE_STATE_KEY="cdkd/${STACK}/${PROFILE_REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
HOLD_NEEDLE="Continuing to use ${LEGACY_REGION} so the existing stack is not duplicated"
WORK_DIR="$(mktemp -d)"
PROFILE_CONFIG="${WORK_DIR}/aws-config"


cleanup() {
  echo "==> Cleanup"
  set +eu
  for r in "${LEGACY_REGION}" "${PROFILE_REGION}" "${DEFAULT_ENV_REGION}"; do
    [ -f "${LOCAL_DIST}" ] \
      && AWS_REGION="${r}" node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --stack-region "${r}" --yes >/dev/null 2>&1
    aws ssm delete-parameter --name "${PARAM}" --region "${r}" >/dev/null 2>&1 || true
    if [ -n "${STATE_BUCKET:-}" ]; then
      # Every record under the stack's prefix in that region (state, lock,
      # journal, registry tail) except the deployment-event history.
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${r}/" --recursive --exclude 'deployments/*' \
        >/dev/null 2>&1 || true
    fi
    # Best-effort teardown, but never a SILENT one: name what survived it.
    # (The seeded index is handled after the loop.)
    ( gone_probe aws ssm get-parameter --name "${PARAM}" --region "${r}" ) >/dev/null 2>&1 \
      || echo "LEAK: SSM parameter ${PARAM} still exists in ${r} (or could not be probed) after cleanup" >&2
  done
  if [ "${SEEDED_INDEX:-0}" = 1 ] && [ -n "${STATE_BUCKET:-}" ]; then
    # The index is SHARED: every write is conditional on the ETag just read,
    # so a concurrent writer's entries are never overwritten or deleted.
    seeded_key="cdkd/_index/${PROFILE_REGION}/exports.json"
    seeded_json="${WORK_DIR}/seeded-current.json"
    if ! seeded_etag="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${seeded_key}" \
      "${seeded_json}" --query ETag --output text 2>/dev/null)"; then
      echo "LEAK: could not read the seeded ${seeded_key} to clean it up" >&2
    elif jq -e '(.exports // {}) | length == 0' "${seeded_json}" >/dev/null 2>&1; then
      aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${seeded_key}" \
        --if-match "${seeded_etag}" >/dev/null 2>&1 \
        || echo "NOTE: left the empty seeded ${seeded_key} in place (it changed, or a conditional delete is not supported)" >&2
    elif jq -e --arg n "${EXPORT_NAME}" '.exports | has($n)' "${seeded_json}" >/dev/null 2>&1; then
      # Other entries arrived meanwhile: drop only this run's own entry.
      jq --arg n "${EXPORT_NAME}" 'del(.exports[$n])' "${seeded_json}" >"${WORK_DIR}/seed-index.json" \
        && aws s3api put-object --bucket "${STATE_BUCKET}" --key "${seeded_key}" \
          --body "${WORK_DIR}/seed-index.json" --content-type application/json \
          --if-match "${seeded_etag}" >/dev/null 2>&1 \
        || echo "LEAK: ${EXPORT_NAME} is still listed in ${seeded_key}" >&2
    fi
  fi
  set -eu
}
on_exit() {
  local rc=$?
  cleanup
  rm -rf "${WORK_DIR}"
  return "${rc}"
}
trap on_exit EXIT
trap '(exit 130); on_exit; exit 130' INT
trap '(exit 143); on_exit; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ "${PROFILE_REGION}" = "${LEGACY_REGION}" ] && {
  echo "FAIL: CDKD_PROFILE_REGION must differ from ${LEGACY_REGION}, or nothing is tested" >&2
  exit 1
}
case "${DEFAULT_ENV_REGION}" in
  "${LEGACY_REGION}" | "${PROFILE_REGION}")
    echo "FAIL: CDKD_DEFAULT_ENV_REGION must differ from ${LEGACY_REGION} and ${PROFILE_REGION}" >&2
    exit 1
    ;;
esac
command -v jq >/dev/null || { echo "FAIL: jq is required (the exports-index checks and cleanup)" >&2; exit 1; }
[ -d node_modules ] || npm install

# Credentials into the environment, so the temp config only has to carry the
# region. `export-credentials` resolves whatever the caller's chain resolves.
# From here on EVERY command in this script runs under the simulated profile:
# a bare `node "${LOCAL_DIST}" ...` names no region, so only that profile can
# answer, and a command that must name one says `AWS_REGION=<r>` inline. Every
# `aws` probe below passes `--region` explicitly.
CREDS_ENV="$(aws configure export-credentials --format env)"
eval "${CREDS_ENV}"
printf '[default]\nregion = %s\n' "${PROFILE_REGION}" >"${PROFILE_CONFIG}"
: >"${WORK_DIR}/no-credentials"
unset AWS_REGION AWS_DEFAULT_REGION AWS_PROFILE
export AWS_CONFIG_FILE="${PROFILE_CONFIG}"
export AWS_SHARED_CREDENTIALS_FILE="${WORK_DIR}/no-credentials"

# Guard: the simulation really resolves the profile region with no named one.
SIM_REGION="$(aws configure get region)"
[ "${SIM_REGION}" = "${PROFILE_REGION}" ] || {
  echo "FAIL: simulated profile resolves '${SIM_REGION}', expected '${PROFILE_REGION}'" >&2
  exit 1
}

echo "==> Pre-run cleanup"; cleanup

# The exports index. A command uses ONE index file for every stack: under an
# inferred region, the us-east-1 file whenever it exists (phase 1 writes it),
# else the profile region's. A profile-region file MUST exist before phase 2,
# or the run could not tell that rule from "use the profile file when there is
# one". In a shared account another stack's file may already be there;
# otherwise this run seeds an empty one (only if still absent, If-None-Match),
# and at the end removes it, or just this run's entry if others arrived.
index_key() { echo "cdkd/_index/$1/exports.json"; }
SEEDED_INDEX=0
if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(index_key "${PROFILE_REGION}")"; then
  printf '{"indexVersion":1,"region":"%s","exports":{},"lastModified":0}' "${PROFILE_REGION}" \
    >"${WORK_DIR}/seed-index.json"
  if SEED_OUT="$(aws s3api put-object --bucket "${STATE_BUCKET}" --key "$(index_key "${PROFILE_REGION}")" \
    --body "${WORK_DIR}/seed-index.json" --content-type application/json --if-none-match '*' 2>&1)"; then
    SEEDED_INDEX=1
    echo "    seeded an empty $(index_key "${PROFILE_REGION}")"
  elif grep -q 'PreconditionFailed' <<<"${SEED_OUT}"; then
    echo "    $(index_key "${PROFILE_REGION}") appeared meanwhile; using it"
  else
    echo "FAIL: could not seed $(index_key "${PROFILE_REGION}"): ${SEED_OUT}" >&2
    exit 1
  fi
else
  echo "    $(index_key "${PROFILE_REGION}") already exists; using it"
fi
# usage: index_has_export <region> -> 0 when that region's index names the export
index_has_export() {
  local body
  if gone_probe aws s3api head-object --bucket "${STATE_BUCKET}" --key "$(index_key "$1")"; then
    return 1
  fi
  body="$(aws s3 cp "s3://${STATE_BUCKET}/$(index_key "$1")" -)" || {
    echo "FAIL: could not read $(index_key "$1")" >&2
    exit 1
  }
  grep -qF "\"${EXPORT_NAME}\"" <<<"${body}"
}

param_value() { # usage: param_value <region>
  aws ssm get-parameter --name "${PARAM}" --region "$1" --query 'Parameter.Value' --output text
}

echo "==> Phase 1: pre-upgrade deploy (AWS_REGION=${LEGACY_REGION}, the old bare default)"
AWS_REGION="${LEGACY_REGION}" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LEGACY_STATE_KEY}" >/dev/null
[ "$(param_value "${LEGACY_REGION}")" = "${LEGACY_REGION}" ] || {
  echo "FAIL: phase 1 parameter does not hold ${LEGACY_REGION}" >&2
  exit 1
}
echo "    OK: state under ${LEGACY_STATE_KEY}, parameter in ${LEGACY_REGION}"

echo "==> Phase 2: bare deploy under profile region ${PROFILE_REGION} holds the existing stack"
OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)" || {
  echo "${OUT}"
  echo "FAIL: phase 2 bare deploy failed" >&2
  exit 1
}
echo "${OUT}"
grep -qF "${HOLD_NEEDLE}" <<<"${OUT}" || {
  echo "FAIL: phase 2 did not report holding the stack on ${LEGACY_REGION} (#2100)" >&2
  exit 1
}
grep -qF "No changes detected. Stack is up to date." <<<"${OUT}" || {
  echo "FAIL: phase 2 bare deploy planned changes against the held stack" >&2
  exit 1
}
assert_gone "phase 2 wrote a state key in the profile region (stack duplicated)" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PROFILE_STATE_KEY}"
assert_gone "phase 2 created the parameter in the profile region (stack duplicated)" \
  aws ssm get-parameter --name "${PARAM}" --region "${PROFILE_REGION}"
echo "    OK: held on ${LEGACY_REGION}, nothing created in ${PROFILE_REGION}"

echo "==> Phase 2b: bare UPDATE while held lands in ${LEGACY_REGION}"
OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" -c paramDescription=v2 --yes 2>&1)" || {
  echo "${OUT}"
  echo "FAIL: phase 2b bare update deploy failed" >&2
  exit 1
}
echo "${OUT}"
grep -qF "${HOLD_NEEDLE}" <<<"${OUT}" || {
  echo "FAIL: phase 2b did not report holding the stack on ${LEGACY_REGION}" >&2
  exit 1
}
DESC="$(aws ssm describe-parameters --region "${LEGACY_REGION}" \
  --parameter-filters "Key=Name,Values=${PARAM}" --query 'Parameters[0].Description' --output text)"
[ "${DESC}" = "v2" ] || {
  echo "FAIL: phase 2b ${LEGACY_REGION} parameter description is '${DESC}', expected 'v2'" >&2
  exit 1
}
assert_gone "phase 2b created the parameter in the profile region (update went to the wrong region)" \
  aws ssm get-parameter --name "${PARAM}" --region "${PROFILE_REGION}"
echo "    OK: the held stack was updated in ${LEGACY_REGION}"

if index_has_export "${PROFILE_REGION}"; then
  echo "FAIL: the held stack's export was written to the ${PROFILE_REGION} exports index, though the us-east-1 one exists (the command's one index file)" >&2
  exit 1
fi
# Not discriminating on its own (phase 1 wrote this entry); kept as a sanity
# check that the index the command uses is the one that holds it.
index_has_export "${LEGACY_REGION}" || {
  echo "FAIL: the ${LEGACY_REGION} exports index does not name ${EXPORT_NAME} for the held stack" >&2
  exit 1
}
echo "    OK: the held stack's export is in the ${LEGACY_REGION} index, not the ${PROFILE_REGION} one"

echo "==> Phase 3: bare diff holds too, and finds no differences"
OUT="$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" -c paramDescription=v2 2>&1)" || {
  echo "${OUT}"
  echo "FAIL: phase 3 bare diff failed" >&2
  exit 1
}
echo "${OUT}"
grep -qF "${HOLD_NEEDLE}" <<<"${OUT}" || {
  echo "FAIL: phase 3 diff did not report holding the stack on ${LEGACY_REGION}" >&2
  exit 1
}
grep -qF "No changes detected for stack ${STACK}" <<<"${OUT}" || {
  echo "FAIL: phase 3 diff reported changes against the held stack" >&2
  exit 1
}
echo "    OK: diff read the ${LEGACY_REGION} state"

echo "==> Phase 4: bare destroy removes the ${LEGACY_REGION} stack"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "phase 4 parameter still exists in ${LEGACY_REGION}" \
  aws ssm get-parameter --name "${PARAM}" --region "${LEGACY_REGION}"
assert_gone "phase 4 state ${LEGACY_STATE_KEY} still exists" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LEGACY_STATE_KEY}"
for r in "${LEGACY_REGION}" "${PROFILE_REGION}"; do
  if index_has_export "${r}"; then
    echo "FAIL: the ${r} exports index still names ${EXPORT_NAME} after the destroy (review F1)" >&2
    exit 1
  fi
done
echo "    OK: ${LEGACY_REGION} stack destroyed, its export gone from the index"

echo "==> Phase 5: a fresh bare deploy goes to the profile region"
OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)" || {
  echo "${OUT}"
  echo "FAIL: phase 5 bare deploy failed" >&2
  exit 1
}
echo "${OUT}"
if grep -qF "${HOLD_NEEDLE}" <<<"${OUT}"; then
  echo "FAIL: phase 5 held a stack that has no state anywhere" >&2
  exit 1
fi
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PROFILE_STATE_KEY}" >/dev/null || {
  echo "FAIL: phase 5 state is not under ${PROFILE_STATE_KEY} (pre-#2100 it went to ${LEGACY_REGION})" >&2
  exit 1
}
[ "$(param_value "${PROFILE_REGION}")" = "${PROFILE_REGION}" ] || {
  echo "FAIL: phase 5 parameter in ${PROFILE_REGION} does not hold AWS::Region=${PROFILE_REGION}" >&2
  exit 1
}
assert_gone "phase 5 wrote state under ${LEGACY_REGION}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${LEGACY_STATE_KEY}"
assert_gone "phase 5 created the parameter in ${LEGACY_REGION}" \
  aws ssm get-parameter --name "${PARAM}" --region "${LEGACY_REGION}"
echo "    OK: state key, resource and AWS::Region all say ${PROFILE_REGION}"

echo "==> Phase 6: bare destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "phase 6 parameter still exists in ${PROFILE_REGION}" \
  aws ssm get-parameter --name "${PARAM}" --region "${PROFILE_REGION}"
assert_gone "phase 6 state ${PROFILE_STATE_KEY} still exists" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PROFILE_STATE_KEY}"
echo "    OK: gone from ${PROFILE_REGION}"

echo "==> Phase 7: a bare deploy under AWS_DEFAULT_REGION=${DEFAULT_ENV_REGION} (profile ${PROFILE_REGION})"
OUT="$(AWS_DEFAULT_REGION="${DEFAULT_ENV_REGION}" node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --yes 2>&1)" || {
  echo "${OUT}"
  echo "FAIL: phase 7 deploy failed" >&2
  exit 1
}
echo "${OUT}"
aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DEFAULT_ENV_STATE_KEY}" >/dev/null || {
  echo "FAIL: phase 7 state is not under ${DEFAULT_ENV_STATE_KEY}" >&2
  exit 1
}
[ "$(param_value "${DEFAULT_ENV_REGION}")" = "${DEFAULT_ENV_REGION}" ] || {
  echo "FAIL: phase 7 parameter in ${DEFAULT_ENV_REGION} does not hold AWS::Region=${DEFAULT_ENV_REGION}" >&2
  exit 1
}
assert_gone "phase 7 created the parameter in the profile region" \
  aws ssm get-parameter --name "${PARAM}" --region "${PROFILE_REGION}"
echo "    OK: state, resource and AWS::Region all say ${DEFAULT_ENV_REGION}"

echo "==> Phase 8: bare destroy under AWS_DEFAULT_REGION deletes it THERE"
AWS_DEFAULT_REGION="${DEFAULT_ENV_REGION}" node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force
assert_gone "phase 8 parameter still exists in ${DEFAULT_ENV_REGION} (the delete went elsewhere)" \
  aws ssm get-parameter --name "${PARAM}" --region "${DEFAULT_ENV_REGION}"
assert_gone "phase 8 state ${DEFAULT_ENV_STATE_KEY} still exists" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DEFAULT_ENV_STATE_KEY}"
echo "    OK: gone from ${DEFAULT_ENV_REGION}"

echo "==> Final: nothing left in any region"
for r in "${LEGACY_REGION}" "${PROFILE_REGION}" "${DEFAULT_ENV_REGION}"; do
  if index_has_export "${r}"; then
    echo "FAIL: the ${r} exports index still names ${EXPORT_NAME} after every destroy" >&2
    exit 1
  fi
  assert_gone "parameter ${PARAM} left in ${r}" aws ssm get-parameter --name "${PARAM}" --region "${r}"
  assert_gone "state left under cdkd/${STACK}/${r}/" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK}/${r}/state.json"
done

echo ""
echo "[verify] PASS - a bare invocation takes the profile region and holds a pre-upgrade us-east-1 stack (#2100)"
