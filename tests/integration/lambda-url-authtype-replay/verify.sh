#!/usr/bin/env bash
# Integration test for the AWS::Lambda::Url `AuthType` warn arms (issue #1654,
# plus the review follow-up that added the create-path replay warning).
#
# The guard (#1551) warns and SUBSTITUTES rather than throwing, because a
# rollback replay / `drift --revert` feeds a cdkd STATE record in as the desired
# bag and a hard refusal would leave the URL un-rollbackable. Two arms:
#
#   PHASE 2  previous-value arm  — the previous `AuthType` is SENT.
#   PHASE 3  OMITTED arm         — the previous side is unusable too, so
#                                  `AuthType` is left out of the update and
#                                  `UpdateFunctionUrlConfig`'s merge semantics
#                                  retain the live value.
#
# Pre-#1654 both recorded the MALFORMED desired value, so state disagreed with
# what `readCurrentState` reads back off `GetFunctionUrlConfig` — permanent
# phantom drift, re-reported by every `cdkd drift` and re-triggered by
# `drift --revert`, which calls `update()` again.
#
# The load-bearing assertion in every phase is not the state record: it is that
# the LIVE URL IS STILL IAM-GUARDED. A regression in this area is a public
# endpoint, so each phase re-reads the live auth type from AWS.
#
#   PHASE 4  the create-path replay warning. The OMITTED arm legitimately
#            leaves state with no `AuthType`, and an ABSENT value is not
#            MALFORMED — so neither the create-path refusal nor `replayWarn`
#            fires for it and `requireConfigString` silently takes the `'NONE'`
#            default. Without an announcement the reverse-replacement replay
#            would recreate the URL PUBLIC with no evidence anywhere. This
#            phase stages a real reverse-replacement (the proven
#            `INJECT_FAIL` + `--no-rollback` + `cdkd rollback` recipe from the
#            `rollback-command` fixture) and asserts the warning fires. It then
#            asserts the URL really is `NONE` afterwards — pinning the
#            ANNOUNCED behavior rather than pretending the replay can restore
#            an auth type cdkd never recorded — and that a corrected deploy
#            puts `AWS_IAM` back.

set -euo pipefail

cd "$(dirname "$0")"

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
assert_eq() { # usage: assert_eq "<label>" "<expected>" "<actual>"
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1 — expected '$2', got '$3'" >&2
    exit 1
  fi
}

REGION="${AWS_REGION:-us-east-1}"
export AWS_REGION="${REGION}"
STACK="CdkdLambdaUrlAuthTypeReplayExample"

REPO_ROOT="$(git rev-parse --show-toplevel)"
CLI="node ${REPO_ROOT}/dist/cli.js"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"
STATE_BUCKET="${STATE_BUCKET:-cdkd-state-${ACCOUNT_ID}}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
JOURNAL_KEY="cdkd/${STACK}/${REGION}/rollback-journal.json"

echo "[verify] region=${REGION} stack=${STACK} state-bucket=${STATE_BUCKET}"

echo "[verify] step 1: install + build cdkd"
(cd "${REPO_ROOT}" && pnpm install)
(cd "${REPO_ROOT}" && vp run build)
if [ ! -d node_modules ]; then
  npm install
fi

cleanup() {
  rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] FAIL (exit ${rc}) — attempting destroy to clean up"
    ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || \
      ${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force || true
  fi
  exit "${rc}"
}
# The `(exit N)` seed is load-bearing: without it the trap body runs with rc=0,
# the `-ne 0` branch is skipped, and an interrupted run leaks every resource.
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

# --- shared readers -------------------------------------------------------

# The recorded AuthType, or the sentinel `<absent>` when the key is gone. The
# two are DIFFERENT answers here (the OMITTED arm drops the key on purpose), so
# they must not both collapse to an empty string.
recorded_auth_type() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::Lambda::Url":
        props = resource.get("properties", {})
        print(props["AuthType"] if "AuthType" in props else "<absent>")
        break
'
}
recorded_url_physical_id() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::Lambda::Url":
        print(resource["physicalId"])
        break
'
}
# The LIVE auth type. Read through the physical id cdkd recorded rather than a
# hard-coded function name, so a phase that REPLACED the URL onto the other
# function is still asking AWS about the URL cdkd believes in.
live_auth_type() {
  aws lambda get-function-url-config --function-name "$(recorded_url_physical_id)" \
    --region "${REGION}" --query 'AuthType' --output text
}

# ---------------------------------------------------------------------------
echo "[verify] step 2 (PHASE 1): baseline deploy — a function URL with AuthType AWS_IAM"
# ---------------------------------------------------------------------------
unset AUTHTYPE_JUNK URL_TARGET INJECT_FAIL
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose

FN_A="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::Lambda::Function" and logical_id.startswith("UrlFnA"):
        print(resource["physicalId"])
        break
')"
FN_B="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::Lambda::Function" and logical_id.startswith("UrlFnB"):
        print(resource["physicalId"])
        break
')"
if [ -z "${FN_A}" ] || [ -z "${FN_B}" ]; then
  echo "FAIL: both Lambda functions must be in cdkd state (a='${FN_A}' b='${FN_B}')" >&2
  exit 1
fi
assert_eq "baseline recorded AuthType" "AWS_IAM" "$(recorded_auth_type)"
assert_eq "baseline LIVE AuthType" "AWS_IAM" "$(live_auth_type)"
echo "[verify] step 2 ok: URL on ${FN_A} is IAM-guarded"

# ---------------------------------------------------------------------------
echo "[verify] step 3 (PHASE 2): redeploy with a MALFORMED desired AuthType — the PREVIOUS value must be sent AND recorded"
# ---------------------------------------------------------------------------
JUNK_LOG="$(mktemp)"
AUTHTYPE_JUNK=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${JUNK_LOG}"

# The deploy must WARN, not fail — a refusal here is what would strand a
# rollback replay, which is why #1551 downgraded it.
if ! grep -q "AWS::Lambda::Url AuthType must be a non-empty string" "${JUNK_LOG}"; then
  echo "FAIL: issue #1654 — cdkd did not report the malformed desired AuthType" >&2
  grep -i "AuthType" "${JUNK_LOG}" >&2 || echo "  (no AuthType diagnostic at all)" >&2
  exit 1
fi
if ! grep -q "would make the URL public" "${JUNK_LOG}"; then
  echo "FAIL: issue #1654 — the warning did not name the consequence it is avoiding" >&2
  exit 1
fi
rm -f "${JUNK_LOG}"

# What was RECORDED: the PREVIOUS value, which is literally what went on the
# wire — not the malformed array, and not the 'NONE' create default.
RECORDED_2="$(recorded_auth_type)"
assert_eq "issue #1654 — recorded AuthType after the substituted update" "AWS_IAM" "${RECORDED_2}"
# THE security assertion. Everything else in this phase is bookkeeping.
assert_eq "issue #1654 — LIVE AuthType after the substituted update" "AWS_IAM" "$(live_auth_type)"
echo "[verify] step 3 ok: previous AuthType sent + recorded, URL still IAM-guarded"

echo "[verify] step 3b: the CORRECTED template is a NO-OP against the recorded value"
# The consequence half, and the one that actually discriminates.
#
# NOT a `cdkd drift` assertion, deliberately: `drift` prefers the
# `observedProperties` baseline (a live `GetFunctionUrlConfig` snapshot taken at
# the end of every successful deploy, auto-refreshed for records that lack one),
# so it compares AWS against AWS and reports this resource clean whether or not
# the recording is fixed. A drift-based check here would be a vacuous pass. The
# field the fix actually writes is `properties`, and `properties` is the
# PREVIOUS side of the next DEPLOY's diff — so that is what to inspect.
#
# Pre-fix, `properties.AuthType` held the malformed array, so an ordinary
# redeploy of the unchanged template read as a CHANGE and re-issued the same
# substituted call forever. Post-fix the recorded previous IS `AWS_IAM`, which
# is exactly what the template declares, so the diff is empty.
DIFF_JSON="$(mktemp)"
set +e
${CLI} diff "${STACK}" --state-bucket "${STATE_BUCKET}" --json > "${DIFF_JSON}" 2>/dev/null
DIFF_RC=$?
set -e
# A run that produced no parseable report is UNDETERMINED, not clean — the same
# tri-state rule `gone_probe` follows.
DIFF_VERDICT="$(python3 -c '
import json, sys
try:
    payload = json.load(open(sys.argv[1]))
except Exception as exc:  # noqa: BLE001 - any parse failure is undetermined
    print("undetermined: %s" % exc)
    sys.exit(0)
if not isinstance(payload, list) or not payload:
    print("undetermined: empty diff payload")
    sys.exit(0)
for node in payload:
    for change in node.get("changes", []):
        if change.get("resourceType") == "AWS::Lambda::Url":
            print("changed: %s" % json.dumps(change))
            sys.exit(0)
print("no-change")
' "${DIFF_JSON}")"
rm -f "${DIFF_JSON}"
if [ "${DIFF_VERDICT}" != "no-change" ]; then
  echo "FAIL: issue #1654 — the unchanged template must diff clean against the recorded PREVIOUS value: ${DIFF_VERDICT} (cdkd diff exit ${DIFF_RC})" >&2
  exit 1
fi
echo "[verify] step 3b ok: unchanged template is a no-op against the recorded value"

# ---------------------------------------------------------------------------
echo "[verify] step 4 (PHASE 3): both sides malformed — AuthType must be OMITTED from the call and DROPPED from state"
# ---------------------------------------------------------------------------
# Post-fix cdkd never WRITES a malformed previous side (that is what phase 2
# just proved), so the only way to reach this arm is to hand-patch the record —
# which is exactly the recipe issue #1654 spells out, and a faithful stand-in
# for a state.json written by an older binary.
STATE_PATCH="$(mktemp)"
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - | python3 -c '
import json, sys
state = json.load(sys.stdin)
patched = False
for logical_id, resource in state.get("resources", {}).items():
    if resource.get("resourceType") == "AWS::Lambda::Url":
        resource.setdefault("properties", {})["AuthType"] = ""
        patched = True
        break
if not patched:
    sys.stderr.write("no AWS::Lambda::Url in state to patch\n")
    sys.exit(1)
json.dump(state, sys.stdout)
' > "${STATE_PATCH}"
aws s3 cp "${STATE_PATCH}" "s3://${STATE_BUCKET}/${STATE_KEY}"
rm -f "${STATE_PATCH}"
assert_eq "state patch precondition" "" "$(recorded_auth_type)"

OMIT_LOG="$(mktemp)"
AUTHTYPE_JUNK=true ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose 2>&1 | tee "${OMIT_LOG}"
if ! grep -q "AWS::Lambda::Url AuthType must be a non-empty string" "${OMIT_LOG}"; then
  echo "FAIL: issue #1654 — the guard did not fire on the both-sides-malformed deploy" >&2
  exit 1
fi
rm -f "${OMIT_LOG}"

# The key must be GONE, not recorded as 'NONE' (which would describe a PUBLIC
# URL that is in fact still IAM-guarded) and not as the malformed value.
assert_eq "issue #1654 — recorded AuthType on the OMITTED arm" "<absent>" "$(recorded_auth_type)"
# And the live URL is untouched: nothing was sent for AuthType, so
# UpdateFunctionUrlConfig's merge semantics retained it. This is the second
# security assertion.
assert_eq "issue #1654 — LIVE AuthType on the OMITTED arm" "AWS_IAM" "$(live_auth_type)"
echo "[verify] step 4 ok: AuthType dropped from state, URL still IAM-guarded"

# ---------------------------------------------------------------------------
echo "[verify] step 5 (PHASE 4): reverse-replacement replay of a record with NO AuthType must ANNOUNCE the PUBLIC default"
# ---------------------------------------------------------------------------
# Phase 3 left exactly the precondition this needs — a state record with no
# `AuthType` — which is the point: the drop and the hazard are the same story.
#
# `TargetFunctionArn` is create-only on AWS::Lambda::Url, so re-pointing the URL
# at the second function forces a REPLACEMENT; `INJECT_FAIL` then fails the
# deploy after it lands, leaving a rollback journal. (`AWS::Lambda::Url` is not
# in STATEFUL_TYPES, so no `--force-stateful-recreation` is needed.)
set +e
URL_TARGET=b INJECT_FAIL=true AUTHTYPE_JUNK= \
  ${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --no-rollback > /tmp/laneb-url-replace.log 2>&1
REPLACE_RC=$?
set -e
sed 's/^/  /' /tmp/laneb-url-replace.log || true
if [ "${REPLACE_RC}" -eq 0 ]; then
  echo "FAIL: the INJECT_FAIL deploy unexpectedly SUCCEEDED — phase 4 has no journal to roll back" >&2
  exit 1
fi
if ! aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}" >/dev/null 2>&1; then
  echo "FAIL: no rollback journal after the replacement deploy — the URL was probably not classified as a REPLACEMENT (check the registry schema lookup for AWS::Lambda::Url createOnlyProperties)" >&2
  exit 1
fi

ROLLBACK_LOG=/tmp/laneb-url-rollback.log
set +e
${CLI} rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --force > "${ROLLBACK_LOG}" 2>&1
ROLLBACK_RC=$?
set -e
sed 's/^/  /' "${ROLLBACK_LOG}" || true
if [ "${ROLLBACK_RC}" -ne 0 ]; then
  echo "FAIL: the reverse-replacement rollback exited ${ROLLBACK_RC} (output above)" >&2
  exit 1
fi
if ! grep -qi 'reverse-replace\|Reversing replacement' "${ROLLBACK_LOG}"; then
  echo "FAIL: the rollback did not perform a reverse-replacement, so the replay create never ran" >&2
  exit 1
fi
# THE assertion this phase exists for. Without it the replay silently recreates
# a PUBLIC url — an absent AuthType is not malformed, so no other guard speaks.
if ! grep -q "cdkd cannot vouch for the auth type" "${ROLLBACK_LOG}"; then
  echo "FAIL: issue #1654 review — the replay create did not announce that it is defaulting an absent AuthType" >&2
  grep -i "auth type" "${ROLLBACK_LOG}" >&2 || echo "  (no auth-type sentence at all)" >&2
  exit 1
fi
if ! grep -q "PUBLIC" "${ROLLBACK_LOG}"; then
  echo "FAIL: issue #1654 review — the replay warning did not name the consequence (PUBLIC)" >&2
  exit 1
fi

# The URL is back on the FIRST function...
REPLAYED_ID="$(recorded_url_physical_id)"
case "${REPLAYED_ID}" in
  *"${FN_A}"*) ;;
  *)
    echo "FAIL: the reverse-replacement did not restore the URL onto ${FN_A} (physicalId=${REPLAYED_ID})" >&2
    exit 1
    ;;
esac
# ...and it really is PUBLIC now. Asserted rather than glossed over: this is
# the ANNOUNCED behavior, not a silent one, and pinning it is what stops a
# future change from quietly making the announcement wrong in either direction.
assert_eq "issue #1654 review — LIVE AuthType after the replay create" "NONE" "$(live_auth_type)"
echo "[verify] step 5 ok: replay warned about the PUBLIC default and the URL is NONE, as announced"

echo "[verify] step 6: a corrected deploy restores AWS_IAM"
# The recovery half: the template still says AWS_IAM, so the very next ordinary
# deploy converges the URL back. If this did not hold, the announcement in
# step 5 would be advice with no remedy behind it.
${CLI} deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --verbose
assert_eq "recorded AuthType after the corrected deploy" "AWS_IAM" "$(recorded_auth_type)"
assert_eq "LIVE AuthType after the corrected deploy" "AWS_IAM" "$(live_auth_type)"
echo "[verify] step 6 ok: URL back to IAM-guarded"

# ---------------------------------------------------------------------------
echo "[verify] step 7: cdkd destroy --force"
# ---------------------------------------------------------------------------
URL_PHYSICAL_ID="$(recorded_url_physical_id)"
${CLI} destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --force

echo "[verify] step 8: assert nothing survived"
assert_gone "function URL on '${URL_PHYSICAL_ID}' still exists after destroy" \
  aws lambda get-function-url-config --function-name "${URL_PHYSICAL_ID}" --region "${REGION}"
assert_gone "function '${FN_A}' still exists after destroy" \
  aws lambda get-function --function-name "${FN_A}" --region "${REGION}"
assert_gone "function '${FN_B}' still exists after destroy" \
  aws lambda get-function --function-name "${FN_B}" --region "${REGION}"
assert_gone "cdkd state file still exists at s3://${STATE_BUCKET}/${STATE_KEY}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
assert_gone "rollback journal still exists at s3://${STATE_BUCKET}/${JOURNAL_KEY}" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${JOURNAL_KEY}"
echo "[verify] step 8 ok: functions, URL, state and journal all gone"

trap - EXIT INT TERM
echo "[verify] PASS: lambda-url-authtype-replay (issues #1654 + review)"
