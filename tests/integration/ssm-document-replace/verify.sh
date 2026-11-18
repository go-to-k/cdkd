#!/usr/bin/env bash
# verify.sh -- cdkd AWS::SSM::Document content change under each UpdateMethod
# (issue #6568).
#
# `AWS::SSM::Document` goes through Cloud Control. Under the default
# `UpdateMethod: Replace` a `Content` change replaces the document (what
# CloudFormation does); cdkd called it an in-place update, and the handler
# refused it with "Create-Only Property cannot be updated". The conditional
# rule in `src/analyzer/replacement-rules/rules.ts`
# (`ssmDocumentChangeReplaces`) now replaces it, and keeps a `NewVersion`
# document's change in place.
#
# Phases:
#   1. Deploy an unnamed Command document (no updateMethod) and a named one
#      (`updateMethod: NewVersion`), both running `echo cdkd-<label>-v1`.
#      Assert state records both on the Cloud Control route, AWS reports both
#      Active with the v1 command, and the outputs agree.
#   2. `cdkd diff` reports no changes.
#   3. `cdkd diff` under CDKD_TEST_UPDATE=true (v1 -> v2) marks the unnamed
#      document's Content `[requires replacement]` and the named one's not.
#   4. UPDATE (CDKD_TEST_UPDATE=true). Assert the unnamed document was
#      replaced: a new name in state carrying the v2 command, the old name
#      gone. Assert the named document kept its name, gained one version
#      (latest = previous + 1, the default version), and its default version
#      carries the v2 command. A diff under the same mode is clean.
#   5. Destroy. Assert both documents and the state file are gone.
#
# Required env vars: STATE_BUCKET; AWS_REGION (defaults us-east-1).

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
export AWS_PAGER=""

STACK="CdkdSsmDocumentReplace"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
UNNAMED_LOGICAL="DocUnnamed"
NAMED_LOGICAL="DocNamed"
NAMED_DOC="${STACK}-named"
DIFF_LOG="${TMPDIR:-/tmp}/cdkd-6568-diff.$$.log"

CLEANED_UP=0
PRE_RUN=0
cleanup() {
  if [ "${CLEANED_UP:-0}" = "1" ]; then
    return 0
  fi
  CLEANED_UP=1
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  rm -f "${DIFF_LOG}"
  # `state destroy` throws when there is no state, as before any run and after a
  # PASS, so its failure means something only for a state that exists. Anything
  # but a clean not-found counts as existing: keeping a record costs nothing.
  STATE_LEFT=0
  if [ -n "${STATE_BUCKET:-}" ]; then
    if STATE_HEAD="$(aws s3api head-object --bucket "${STATE_BUCKET:-}" --key "${STATE_KEY}" 2>&1 >/dev/null)"; then
      STATE_LEFT=1
    elif ! grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${STATE_HEAD}"; then
      STATE_LEFT=1
    fi
  fi
  if [ "${STATE_LEFT}" = "1" ] && [ -f "${LOCAL_DIST}" ] &&
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1; then
    STATE_LEFT=0
  fi
  # A deploy that failed before state recorded a document leaves a name
  # nothing here knows (the handler generates the unnamed one's), so the
  # documents are found by the stack tag both carry. The account is shared
  # and a peer may be running this fixture, so only this run's own teardown
  # deletes: before the run, a match is reported and stops it.
  LEFT_BY_TAG=""
  case "${STACK}" in
    CdkdSsm?*)
      if SWEPT_DOCS="$(aws ssm list-documents --region "${REGION}" \
        --filters "Key=Owner,Values=Self" "Key=tag:cdkd-integ,Values=${STACK}" \
        --query 'DocumentIdentifiers[].Name' --output text 2>&1)"; then
        for name in ${SWEPT_DOCS}; do
          [ "${name}" = "None" ] && continue
          if [ "${PRE_RUN}" = "1" ]; then
            LEFT_BY_TAG="${LEFT_BY_TAG} document:${name}"
          else
            aws ssm delete-document --name "${name}" --region "${REGION}" >/dev/null 2>&1 ||
              echo "WARN: could not delete document ${name}" >&2
          fi
        done
      else
        echo "WARN: could not list documents of ${STACK}: ${SWEPT_DOCS}" >&2
      fi
      ;;
    *)
      echo "WARN: teardown sweep refused: STACK='${STACK}' does not match CdkdSsm?*" >&2
      ;;
  esac
  # The state is the only record of what a failed `state destroy` left behind.
  if [ "${STATE_LEFT}" = "1" ]; then
    echo "WARN: state destroy failed: s3://${STATE_BUCKET:-}/${STATE_KEY} is kept, and documents of ${STACK} may remain" >&2
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET:-}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
  if [ -n "${LEFT_BY_TAG}" ]; then
    echo "FAIL: ${STACK} documents exist before this run, possibly a peer's live run:${LEFT_BY_TAG}" >&2
    exit 1
  fi
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then echo "FAIL: STATE_BUCKET required" >&2; exit 1; fi
if [ ! -f "${LOCAL_DIST}" ]; then echo "FAIL: build dist first (vp run build)" >&2; exit 1; fi

echo "==> Installing fixture deps"
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"
PRE_RUN=1
cleanup
PRE_RUN=0
CLEANED_UP=0

read_state() { # $1 = python expression over `s` (the state fetched into STATE_JSON)
  printf '%s' "${STATE_JSON}" | python3 -c "import json, sys; s = json.load(sys.stdin); print($1)"
}
doc_field() { # usage: doc_field <name> <query>; strict, no fallback
  aws ssm describe-document --name "$1" --region "${REGION}" --query "$2" --output text
}
doc_content() { # usage: doc_content <name>; the DEFAULT version's content
  aws ssm get-document --name "$1" --region "${REGION}" --query Content --output text
}
assert_runs() { # usage: assert_runs <name> <expected command marker> <label>
  local body
  body="$(doc_content "$1")" || return 1
  grep -qF "$2" <<<"${body}" ||
    { echo "FAIL: $3: document $1's default version does not run '$2'. Content: ${body}" >&2; exit 1; }
}
assert_clean_diff() { # $1 = phase label; runs under the caller's CDKD_TEST_UPDATE
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1
  # cdkd's own line (src/cli/commands/diff.ts), naming this stack.
  if ! grep -qF "No changes detected for stack ${STACK}" "${DIFF_LOG}"; then
    echo "FAIL: diff $1 is not clean. Tail:" >&2
    tail -20 "${DIFF_LOG}" >&2
    exit 1
  fi
}

# --- Phase 1: deploy --------------------------------------------------------
echo "==> Phase 1: deploy (an unnamed default-method document + a named NewVersion one)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
UNNAMED_V1="$(read_state "s['resources']['${UNNAMED_LOGICAL}']['physicalId']")"
NAMED_ID="$(read_state "s['resources']['${NAMED_LOGICAL}']['physicalId']")"
UNNAMED_ROUTE="$(read_state "s['resources']['${UNNAMED_LOGICAL}'].get('provisionedBy', '')")"
NAMED_ROUTE="$(read_state "s['resources']['${NAMED_LOGICAL}'].get('provisionedBy', '')")"
OUT_UNNAMED="$(read_state "s.get('outputs', {}).get('UnnamedDocumentName', '')")"
OUT_NAMED="$(read_state "s.get('outputs', {}).get('NamedDocumentName', '')")"

[ -n "${UNNAMED_V1}" ] && [ "${UNNAMED_V1}" != "None" ] && [ "${UNNAMED_V1}" != "${NAMED_DOC}" ] ||
  { echo "FAIL: ${UNNAMED_LOGICAL} physicalId '${UNNAMED_V1}' is not a generated document name" >&2; exit 1; }
[ "${NAMED_ID}" = "${NAMED_DOC}" ] ||
  { echo "FAIL: ${NAMED_LOGICAL} physicalId '${NAMED_ID}', expected '${NAMED_DOC}'" >&2; exit 1; }
[ "${UNNAMED_ROUTE}" = "cc-api" ] && [ "${NAMED_ROUTE}" = "cc-api" ] ||
  { echo "FAIL: provisionedBy unnamed='${UNNAMED_ROUTE}' named='${NAMED_ROUTE}', expected cc-api for both" >&2; exit 1; }
[ "${OUT_UNNAMED}" = "${UNNAMED_V1}" ] && [ "${OUT_NAMED}" = "${NAMED_DOC}" ] ||
  { echo "FAIL: outputs unnamed='${OUT_UNNAMED}' named='${OUT_NAMED}' disagree with state ('${UNNAMED_V1}', '${NAMED_DOC}')" >&2; exit 1; }

for name in "${UNNAMED_V1}" "${NAMED_DOC}"; do
  status="$(doc_field "${name}" Document.Status)"
  [ "${status}" = "Active" ] ||
    { echo "FAIL: document ${name} Status='${status}', expected Active" >&2; exit 1; }
done
assert_runs "${UNNAMED_V1}" "cdkd-unnamed-v1" "phase 1"
assert_runs "${NAMED_DOC}" "cdkd-named-v1" "phase 1"
NAMED_LATEST_V1="$(doc_field "${NAMED_DOC}" Document.LatestVersion)"
echo "    ${UNNAMED_V1} and ${NAMED_DOC} (version ${NAMED_LATEST_V1}) are Active with the v1 command; outputs agree"

# --- Phase 2: diff is clean -------------------------------------------------
echo "==> Phase 2: diff (expect no changes)"
# Empty rather than unset: a function call cannot take `env -u`, and the stack
# only updates when the value is exactly `true`.
CDKD_TEST_UPDATE= assert_clean_diff "after the create"
echo "    diff reports no changes"

# --- Phase 3: the diff classifies each Content change -----------------------
echo "==> Phase 3: diff under the update (v1 -> v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >"${DIFF_LOG}" 2>&1 || true
DIFF_PLAIN="$(sed 's/\x1b\[[0-9;]*m//g' "${DIFF_LOG}")"
# The `- Content:` property line under each resource's `[~] <logicalId>`
# header (src/cli/commands/diff-recursive/render.ts). The line itself is the
# sentinel: its absence fails as "not shown" rather than reading as in place.
content_line() { # usage: content_line <logicalId>
  awk -v id="$1" '
    /\[[~+-]\] / { cur = index($0, "] " id " (") > 0; next }
    cur && /^ *- Content:/ { print; exit }
  ' <<<"${DIFF_PLAIN}"
}
UNNAMED_LINE="$(content_line "${UNNAMED_LOGICAL}")"
NAMED_LINE="$(content_line "${NAMED_LOGICAL}")"
if [ -z "${UNNAMED_LINE}" ] || [ -z "${NAMED_LINE}" ]; then
  echo "FAIL [phase 3]: cdkd diff does not show both Content changes. Output:" >&2
  printf '%s\n' "${DIFF_PLAIN}" | tail -40 >&2
  exit 1
fi
grep -qF "[requires replacement]" <<<"${UNNAMED_LINE}" ||
  { echo "FAIL [phase 3]: ${UNNAMED_LOGICAL}'s Content change is not marked [requires replacement] (go-to-k/cdkd#6568): ${UNNAMED_LINE}" >&2; exit 1; }
if grep -qF "replacement" <<<"${NAMED_LINE}"; then
  echo "FAIL [phase 3]: ${NAMED_LOGICAL} (updateMethod NewVersion) is marked for replacement: ${NAMED_LINE}" >&2
  exit 1
fi
echo "    diff marks ${UNNAMED_LOGICAL} Content [requires replacement], ${NAMED_LOGICAL} Content in place"

# --- Phase 4: UPDATE --------------------------------------------------------
echo "==> Phase 4: update (both commands v1 -> v2)"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}")"
UNNAMED_V2="$(read_state "s['resources']['${UNNAMED_LOGICAL}']['physicalId']")"
NAMED_ID_AFTER="$(read_state "s['resources']['${NAMED_LOGICAL}']['physicalId']")"
OUT_UNNAMED_AFTER="$(read_state "s.get('outputs', {}).get('UnnamedDocumentName', '')")"

[ -n "${UNNAMED_V2}" ] && [ "${UNNAMED_V2}" != "None" ] && [ "${UNNAMED_V2}" != "${UNNAMED_V1}" ] ||
  { echo "FAIL: ${UNNAMED_LOGICAL} was not replaced (physicalId '${UNNAMED_V1}' -> '${UNNAMED_V2}')" >&2; exit 1; }
[ "${OUT_UNNAMED_AFTER}" = "${UNNAMED_V2}" ] ||
  { echo "FAIL: output UnnamedDocumentName '${OUT_UNNAMED_AFTER}' != the replacement '${UNNAMED_V2}'" >&2; exit 1; }
assert_runs "${UNNAMED_V2}" "cdkd-unnamed-v2" "phase 4"
assert_gone "the replaced document ${UNNAMED_V1} still exists after the update" \
  aws ssm describe-document --name "${UNNAMED_V1}" --region "${REGION}"
echo "    ${UNNAMED_LOGICAL} replaced: ${UNNAMED_V1} -> ${UNNAMED_V2} (v2), old one deleted"

[ "${NAMED_ID_AFTER}" = "${NAMED_DOC}" ] ||
  { echo "FAIL: ${NAMED_LOGICAL} physicalId changed across the update ('${NAMED_DOC}' -> '${NAMED_ID_AFTER}')" >&2; exit 1; }
NAMED_LATEST_V2="$(doc_field "${NAMED_DOC}" Document.LatestVersion)"
NAMED_DEFAULT_V2="$(doc_field "${NAMED_DOC}" Document.DefaultVersion)"
[ "${NAMED_LATEST_V2}" = "$((NAMED_LATEST_V1 + 1))" ] ||
  { echo "FAIL: ${NAMED_DOC} latest version '${NAMED_LATEST_V2}', expected $((NAMED_LATEST_V1 + 1)) (one new version)" >&2; exit 1; }
[ "${NAMED_DEFAULT_V2}" = "${NAMED_LATEST_V2}" ] ||
  { echo "FAIL: ${NAMED_DOC} default version '${NAMED_DEFAULT_V2}' is not the new version '${NAMED_LATEST_V2}'" >&2; exit 1; }
assert_runs "${NAMED_DOC}" "cdkd-named-v2" "phase 4"
echo "    ${NAMED_DOC} updated in place: version ${NAMED_LATEST_V1} -> ${NAMED_LATEST_V2} (default, v2)"

CDKD_TEST_UPDATE=true assert_clean_diff "after the update"
echo "    diff under the update mode reports no changes"

# --- Phase 5: destroy -------------------------------------------------------
echo "==> Phase 5: destroy"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

assert_gone "document ${UNNAMED_V2} still exists after destroy" \
  aws ssm describe-document --name "${UNNAMED_V2}" --region "${REGION}"
assert_gone "document ${NAMED_DOC} still exists after destroy" \
  aws ssm describe-document --name "${NAMED_DOC}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

cleanup
trap - EXIT INT TERM
echo "[verify] PASS — a default-method SSM document was replaced on a Content change, a NewVersion one gained a version in place, destroy left nothing"
