#!/usr/bin/env bash
# An AppSync GraphQL schema create and change are waited for until AppSync
# applies them, so the drift baseline holds the deployed schema (drift clean,
# --revert changes nothing) and a schema AppSync refuses fails the deploy
# (go-to-k/cdkd#7127).
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
# revert_identity_* : prove a drift --revert kept every resource it touched (#6639).
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh
STACK="CdkdAppSyncSchemaUpdateDriftExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
WORK=""
API_ID=""
S3_API_ID=""
CLEANED_UP=0
cleanup() {
  [ "${CLEANED_UP}" = 1 ] && return 0
  CLEANED_UP=1
  (
    set +eu
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      env -u CDKD_TEST_SCHEMA node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes
    fi
    [ -n "${WORK}" ] && rm -rf "${WORK}"
    :
  )
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -n "${STATE_BUCKET:-}" ] || { echo "FAIL: STATE_BUCKET is required" >&2; exit 1; }
[ -f "${LOCAL_DIST}" ] || { echo "FAIL: run vp run build first" >&2; exit 1; }
if [ ! -d node_modules ]; then pnpm install --ignore-workspace --prefer-offline; fi

state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" --only-show-errors
}
# The one record of type $1 outside the S3-sourced API (`S3*` logical ids),
# asserted unique (the L2 API declares one of each).
record_id() { # <resourceType>
  local ids
  ids=$(state_json | jq -r --arg t "$1" '[.resources | to_entries[] | select(.value.resourceType == $t and (.key | startswith("S3") | not)) | .key]') || return 1
  [ "$(jq 'length' <<<"${ids}")" = 1 ] || { echo "FAIL: expected one $1 record, got ${ids}" >&2; exit 1; }
  jq -r '.[0]' <<<"${ids}"
}
deploy_schema() { # <v1|v2|invalid> [extra deploy args...]
  local variant="$1"
  shift
  CDKD_TEST_SCHEMA="${variant}" node "${LOCAL_DIST}" deploy "${STACK}" \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes "$@"
}
# The live SDL of API $1 (default: the L2 API), one line, whitespace squeezed.
live_sdl() { # [<api id>]
  aws appsync get-introspection-schema --region "${REGION}" --api-id "${1:-${API_ID}}" \
    --format SDL "${WORK}/live.graphql" >/dev/null || return 1
  tr -s ' \n' ' ' <"${WORK}/live.graphql"
}
# The live SDL must declare field $2 on Query.
check_live_field() { # has <field> [<api id>]
  local sdl
  sdl=$(live_sdl "${3:-}") || { echo "FAIL: get-introspection-schema failed" >&2; exit 1; }
  grep -q 'type Query {' <<<"${sdl}" || { echo "FAIL: the live SDL has no Query type: ${sdl}" >&2; exit 1; }
  grep -qE "[{ ]$2: String" <<<"${sdl}" || { echo "FAIL: the live SDL lacks Query.$2: ${sdl}" >&2; exit 1; }
  echo "    OK: the live SDL${3:+ of ${3}} $1 Query.$2"
}
# The S3-sourced schema's observed baseline Definition (go-to-k/cdkd#7139).
s3_baseline() {
  state_json | jq -r '.resources.S3Schema.observedProperties.Definition // "<none>"'
}
# The deploy's own capture must hold field $1 (and, with $2, lack field $2).
check_baseline() { # <field it holds> [<field it lacks>]
  local id recorded
  id=$(record_id AWS::AppSync::GraphQLSchema) || exit 1
  recorded=$(state_json | jq -r --arg id "${id}" '.resources[$id].observedProperties.Definition // "<none>"') || exit 1
  grep -qE "(^|[{ ])$1: String" <<<"${recorded}" || {
    echo "FAIL: the schema's observed baseline lacks Query.$1 (the pre-change schema recorded?): ${recorded}" >&2
    exit 1
  }
  if [ -n "${2:-}" ] && grep -qE "(^|[{ ])$2: " <<<"${recorded}"; then
    echo "FAIL: the schema's observed baseline holds Query.$2: ${recorded}" >&2
    exit 1
  fi
  echo "    OK: the schema's observed baseline holds Query.$1"
}
check_resolver() { # present|absent <field>
  if [ "$1" = present ]; then
    aws appsync get-resolver --region "${REGION}" --api-id "${API_ID}" --type-name Query \
      --field-name "$2" --query 'resolver.fieldName' --output text >/dev/null \
      || { echo "FAIL: the resolver on Query.$2 is gone" >&2; exit 1; }
  else
    assert_gone "the resolver on Query.$2 still exists" aws appsync get-resolver --region "${REGION}" \
      --api-id "${API_ID}" --type-name Query --field-name "$2"
  fi
  echo "    OK: the resolver on Query.$2 is $1"
}
check_drift() { # <phase label>
  local report id
  id=$(record_id AWS::AppSync::GraphQLSchema) || exit 1
  report=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || {
    echo "FAIL: cdkd drift failed or reported drift after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  }
  if ! jq -e --arg stack "${STACK}" --arg id "${id}" '
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[] | select(.logicalId == $id)] | length) == 1 and
    ([$reports[0].drifted[]] | length) == 0 and
    ([$reports[0].notCompared[] | select(.logicalId == $id)] | length) == 0 and
    ([$reports[0].clean[] | select(.logicalId == "S3Schema")] | length) == 1 and
    ([$reports[0].notCompared[] | select(.logicalId == "S3Schema")] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: the stack was not drift-clean (schema fully compared) after $1" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: both schemas are fully compared and the stack drift-clean after $1"
}

cleanup
CLEANED_UP=0
# Created only after the pre-run cleanup, which removes ${WORK}.
WORK="$(mktemp -d)"

echo "==> Create the API with the v1 schema"
deploy_schema v1
API_ID=$(state_json | jq -r '.outputs.ApiId')
[ -n "${API_ID}" ] && [ "${API_ID}" != null ] || { echo "FAIL: no ApiId output" >&2; exit 1; }
check_live_field has a
# Before #7127 the create recorded no baseline at all: the capture read before
# the schema existed.
check_baseline a
S3_API_ID=$(state_json | jq -r '.outputs.S3ApiId')
[ -n "${S3_API_ID}" ] && [ "${S3_API_ID}" != null ] || { echo "FAIL: no S3ApiId output" >&2; exit 1; }
check_live_field has a "${S3_API_ID}"
# The v1 baseline of the S3-sourced schema, seeded back after v2 below.
V1_S3_DEFINITION=$(s3_baseline) || exit 1
grep -qE '(^|[{ ])a: String' <<<"${V1_S3_DEFINITION}" && ! grep -qE '(^|[{ ])b: ' <<<"${V1_S3_DEFINITION}" || {
  echo "FAIL: the S3-sourced schema's v1 baseline is not v1: ${V1_S3_DEFINITION}" >&2
  exit 1
}
check_drift "the v1 create"

echo "==> Add Query.b and its resolver: the baseline must hold the new schema (#7127)"
# Before the fix the capture read the v1 schema AppSync was still serving, so
# drift reported Definition and --revert pushed v1 back, which also deleted
# the Query.b resolver.
deploy_schema v2
export CDKD_TEST_SCHEMA=v2
check_baseline b
check_live_field has b
check_resolver present b
check_live_field has b "${S3_API_ID}"
grep -qE '(^|[{ ])b: String' <<<"$(s3_baseline)" || { echo "FAIL: the S3-sourced schema's baseline lacks Query.b after v2" >&2; exit 1; }
check_drift "the v2 update"

echo "==> Seed a pre-#7127 baseline on the S3-sourced schema: drift must stay clean (#7139)"
# What a cdkd before #7127 recorded after this change: the v1 schema AppSync
# was still serving. Before #7139 drift reported Definition here and
# --revert (next step) pushed v1 back onto the S3-sourced API.
SEED_IN="${WORK}/state-in.json"
SEED_OUT="${WORK}/state-out.json"
state_json >"${SEED_IN}" || exit 1
[ "$(jq -r '.resources.S3Schema.observedProperties | type' "${SEED_IN}")" = object ] || {
  echo "FAIL: S3Schema has no observedProperties to seed — the drift assertion would be vacuous" >&2
  exit 1
}
jq --arg d "${V1_S3_DEFINITION}" '.resources.S3Schema.observedProperties.Definition = $d' "${SEED_IN}" >"${SEED_OUT}"
aws s3 cp "${SEED_OUT}" "s3://${STATE_BUCKET}/${STATE_KEY}" --region "${REGION}" --only-show-errors
[ "$(s3_baseline)" = "${V1_S3_DEFINITION}" ] || { echo "FAIL: the seeded baseline did not land" >&2; exit 1; }
echo "    OK: the S3-sourced schema's baseline is the stale v1 schema"
check_drift "the seeded pre-#7127 S3 baseline"

echo "==> drift --revert on the untouched stack changes nothing"
API_LID=$(record_id AWS::AppSync::GraphQLApi) || exit 1
revert_identity_snapshot "${WORK}/ids-before" "${STACK}" "${API_LID}" || exit 1
REVERT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --revert --yes >"${WORK}/revert.log" 2>&1 || REVERT_RC=$?
revert_identity_verify "${WORK}/ids-before" "${WORK}/ids-after" 1 "${WORK}/revert.log" || exit 1
[ "${REVERT_RC}" -eq 0 ] || { echo "FAIL: cdkd drift --revert exited ${REVERT_RC}" >&2; cat "${WORK}/revert.log" >&2; exit 1; }
# command.ts prints this when drift finds nothing; its absence is a reworded
# message or a revert that ran.
grep -q 'No drift detected — nothing to revert.' "${WORK}/revert.log" || {
  echo "FAIL: drift --revert did not report 'No drift detected — nothing to revert.'" >&2
  cat "${WORK}/revert.log" >&2
  exit 1
}
# revert-apply.ts prints `<stack>/<id> (<type>): reverted` per reverted resource.
if grep -qE '\): reverted' "${WORK}/revert.log"; then
  echo "FAIL: drift --revert reverted something on an untouched stack" >&2
  cat "${WORK}/revert.log" >&2
  exit 1
fi
check_live_field has b
check_resolver present b
check_live_field has b "${S3_API_ID}"
check_drift "drift --revert"

echo "==> Deploy a schema AppSync refuses: the deploy must fail and roll back to v2 (#7127)"
# Before the fix this printed `created`/`updated` and exited 0 while
# GetSchemaCreationStatus read FAILED. --verbose puts AWS's own reason (which
# the error message withholds, #2319) in the output.
INVALID_RC=0
deploy_schema invalid --verbose >"${WORK}/invalid.log" 2>&1 || INVALID_RC=$?
if [ "${INVALID_RC}" -eq 0 ]; then
  echo "FAIL: the deploy of a refused schema exited 0" >&2
  tail -40 "${WORK}/invalid.log" >&2
  exit 1
fi
grep -q 'AWS AppSync reports FAILED' "${WORK}/invalid.log" || {
  # Sentinel: AWS's reason present while cdkd's own wording is not means the
  # message drifted, not that the condition did not occur.
  if grep -q 'is not present when resolving type' "${WORK}/invalid.log"; then
    echo "FAIL: AWS's reason is in the output but cdkd's 'AWS AppSync reports FAILED' wording is not (reworded?)" >&2
  else
    echo "FAIL: the failed deploy does not name the refused schema" >&2
  fi
  tail -60 "${WORK}/invalid.log" >&2
  exit 1
}
# AWS's own wording, not `NoSuchType`: the declared SDL carries that token too.
grep -q 'is not present when resolving type' "${WORK}/invalid.log" || {
  echo "FAIL: the --verbose output does not carry AWS's reason ('is not present when resolving type')" >&2
  tail -60 "${WORK}/invalid.log" >&2
  exit 1
}
echo "    OK: the deploy exited ${INVALID_RC}, naming the refused schema"
# The rollback re-submitted v2 and waited for it.
check_live_field has b
check_resolver present b
check_baseline b
check_drift "the refused schema's rollback"
# The S3-sourced schema stayed on v2 and kept its seeded baseline, so the clean
# drift above is the heal's, not a re-capture's (#7139).
check_live_field has b "${S3_API_ID}"
[ "$(s3_baseline)" = "${V1_S3_DEFINITION}" ] || {
  echo "FAIL: the S3-sourced schema's seeded baseline changed (re-captured?): $(s3_baseline)" >&2
  exit 1
}
echo "    OK: the S3-sourced schema still holds the seeded v1 baseline"

echo "==> Destroy and verify resources and state are gone"
env -u CDKD_TEST_SCHEMA node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --force
assert_gone "GraphQL API still exists" aws appsync get-graphql-api --region "${REGION}" --api-id "${API_ID}"
assert_gone "S3-sourced GraphQL API still exists" aws appsync get-graphql-api --region "${REGION}" --api-id "${S3_API_ID}"
assert_gone "state still exists" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
CLEANED_UP=1
rm -rf "${WORK}"
trap - EXIT INT TERM
echo "[verify] PASS: an AppSync schema create, change and refused change were waited for: baseline = deployed schema, drift clean, --revert changed nothing (an S3-sourced schema's seeded pre-#7127 baseline included, #7139), the refused schema failed the deploy and rolled back, clean destroy (#7127)"
