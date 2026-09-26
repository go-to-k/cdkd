#!/usr/bin/env bash
# verify.sh — cdkd secrets-array-nested integ (issue #1915).
#
# A secret nested in an ARRAY must not survive as PLAINTEXT in persisted state
# on the UNCHANGED-resource path. Both halves that would otherwise catch it are
# switched off there BY DESIGN, which is why this needs a real-AWS arm rather
# than a unit test alone:
#
#   - positional array descent is refused for an AWS readback (AWS does not
#     preserve list order), and
#   - the fallback VALUE scan has no needles, because an unchanged resource is
#     never resolved during a deploy so its `perResourceSecrets` entry is empty
#     (issue #1900).
#
# The fix descends such arrays by an element IDENTITY KEY (`Name`), which is
# order-independent. Only a live `DescribeTaskDefinition` can show whether AWS
# echoes the list back in the template's order — the whole premise of the
# `descendArrays: false` rule — so a mocked test cannot stand in for this.
#
# THE ANCHOR-PAIRING ARM (issue #2012), gated on `CDKD_INTEG_ANCHOR_ARM=1`,
# which this script exports below for every phase.
#
# Everything above rides an array `identityKeyFor` CAN key -- `Environment[]`
# carries `Name`. `refuseUncertifiedReadbackPositions` consults the anchor gate
# `unkeyedArrayPairsByAnchors` ONLY when `identityKeyFor` returns `undefined`,
# so a keyed fixture leaves that gate with no live coverage at all. The
# `anchorprobe` container reaches it with two UNKEYED arrays -- lists of plain
# strings, so no element carries `Name` / `Key` and POSITION is the only
# mechanism left -- picked for OPPOSITE verdicts:
#
#   - `Command: ['-c', <expr>, '-v']` must PAIR. The two literal flags are the
#     anchors AWS echoes back byte-for-byte, and the lone reference leaf --
#     having no interior of its own -- leans on that literal frame. The
#     baseline must end up holding the EXPRESSION at index 1.
#   - `EntryPoint: ['-p', <exprA>, '-p', <exprB>]` must REFUSE: the NEGATIVE
#     CONTROL. Every anchor still matches, so rules 1 and 2 pass and the
#     refusal is attributable to rule 3 -- the two reference-bearing elements
#     share an `anchorSignature`, so a swap between them would be invisible.
#     Since issue #2852 a refused position FAILS CLOSED: indices 1 and 3 must
#     hold exactly the literal mask `***`, never the decrypted readback.
#
# Without that second array, a gate that paired EVERYTHING would satisfy every
# positive assertion here. Before #2852 its refused indices kept the resolved
# plaintext in the observed baseline as a documented residual, and the S3
# VERSION sweep at the end existed partly to bound how long those bytes lived
# in the bucket. That residual is GONE: the refused position persists the
# mask, so no plaintext is written for the sweep to bound. The sweep stays for
# the producer's own `unsafePlainText` properties (the s3-versions.sh note
# below) and as issue #2096 hygiene.
#
# Phases:
#   1. Deploy with --no-capture-observed-state. Assert the reference reached AWS
#      RESOLVED (the container really holds the password) while state
#      `properties` holds the EXPRESSION at the array-nested leaf, and assert the
#      record carries NO observedProperties yet — that absence is what arms
#      phase 2, so it is asserted rather than assumed.
#   2. REDEPLOY UNCHANGED with capture ON. The resource takes the unchanged path
#      (never resolved this deploy, empty secrets map) while cdkd's auto-refresh
#      fires `readCurrentState` for the record that lacks a baseline. Assert the
#      captured `observedProperties` holds the EXPRESSION at the array-nested
#      leaf, that no plaintext appears ANYWHERE in state.json, and that the
#      non-secret siblings in the same arrays are untouched. Then the #2012
#      arm on the same baseline: the corroborated UNKEYED array must hold the
#      EXPRESSION, and its indistinguishable twin must hold what AWS reported.
#   3. Destroy + assert the task definition has no ACTIVE revision left, the
#      secret is deleted/scheduled, and the state file is gone.
#
# THE DRIFT ARM (issue #1947), gated on `CDKD_INTEG_DRIFT_ARM=1`, exported below
# for every phase. `cdkd drift` resolves its baseline before comparing (#1914),
# and both of its secret-path walks descend ARRAYS — the scalar-shape arm in
# `secrets-dynamic-ref` cannot see that half. Two stops:
#
#   1d. Between phases 1 and 2, on the `properties` baseline (no observed one
#       yet, and no mask). (a) the freshly deployed stack is CLEAN, with both
#       array consumers reported compared-and-matched; then a console edit of
#       the MUTABLE consumer's array-nested secret (the CodeBuild project —
#       task definition revisions are immutable, so drift cannot be injected
#       into one and `--revert` refuses it) is (b) reported with no plaintext,
#       (d) refused by `--accept`, which persists no plaintext, and (c)
#       reverted by `--revert` to the RESOLVED value. Last, (b) again with the
#       project's reference made UNRESOLVABLE: the value map is then empty and
#       only the offline array-descending path seed can mask the live array.
#   2d. After phase 2, on the observed baseline. Its #2852 fail-closed mask at
#       the anchor arm's refused positions cannot equal the live value; since
#       issue #3595 that is reported as a not-compared position
#       (`uncertifiedBaseline`, exit 2), never as drift, with no plaintext from
#       any mode and `--accept` leaving the masked baseline byte-identical.
#   2r. Then a NO_CHANGE redeploy RE-CAPTURES that baseline (issue #3595 item
#       1): with one of the two references rotated out of band first, the
#       certifiable position comes back as its expression, the rotated one
#       stays masked and still reads `uncertifiedBaseline`, and nothing else in
#       the bag changes. Rotated back, the next NO_CHANGE redeploy clears the
#       last mask and the resource reads clean.
#
# SECURITY: the resolved secret value is never printed. Assertions compare
# against a masked representation; only PASS/FAIL + a masked snippet is shown.
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

# Shared S3 VERSION-sweep helpers (issue #2096). This fixture's own template
# declares the secret with `unsafePlainText`, so EXPECTED_PASSWORD lands in
# that resource's own state properties by construction -- the no-plaintext
# assertions below are deliberately scoped to the CONSUMER record for exactly
# that reason. The state bucket is VERSIONED, so `aws s3 rm` only writes a
# delete marker and that plaintext stays readable via GetObjectVersion.
# Measured 2026-08-20: 5 of the 7 surviving versions of this stack's state.json
# carried cdkd-array-nested-pw-789, after runs that all exited 0.
. ../s3-versions.sh

STACK="CdkdSecretsArrayNestedExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

SECRET_NAME="cdkd-test-array-secret-${ACCOUNT_ID}"
TOKEN_SECRET_NAME="cdkd-test-array-token-${ACCOUNT_ID}"
FAMILY="cdkd-test-array-secret-${ACCOUNT_ID}"
# The references the template carries, byte-for-byte — what state must hold.
SECRET_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}"
TOKEN_EXPR="{{resolve:secretsmanager:${TOKEN_SECRET_NAME}:SecretString:ref}}"
# The values authored in the fixture stack (test data, still masked in output).
EXPECTED_PASSWORD="cdkd-array-nested-pw-789"
# Issue #1917: a secret whose RESOLVED PLAINTEXT is itself a complete
# `{{resolve:...}}` string. The secret it NAMES is never created, and the
# phase-1 live assertion below is what proves nothing tries to look it up.
#
# Why that holds is narrower than it looks, and the general-sounding version of
# it is FALSE: `resolveJoin` and `resolveSub` DO re-scan their substituted
# result, so a reference reached through an `Fn::Join` / `Fn::Sub` would have
# its resolved value re-scanned and this decoy WOULD be fetched. What makes it
# safe here is that the stack sets the consuming env var to a LITERAL string,
# so no intrinsic ever sees the substitution. See the same note in
# lib/secrets-array-nested-stack.ts.
EXPECTED_TOKEN_SHAPED="{{resolve:secretsmanager:cdkd-decoy-never-created:SecretString:key}}"

# --- issue #2012 anchor-pairing arm ----------------------------------------
# Opt-in in the CDK app so the OFF polarity synthesizes byte-for-byte what this
# fixture shipped before the arm existed. Exported HERE, ahead of every phase,
# because `cdkd deploy` runs the CDK app as a subprocess that inherits this
# environment.
export CDKD_INTEG_ANCHOR_ARM=1
ANCHOR_PW_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:anchorPw}}"
AMBIG_ALPHA_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:ambigAlpha}}"
AMBIG_BRAVO_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:ambigBravo}}"
# The plaintexts the stack seeds for this arm. Deliberately disjoint, as
# literal strings, from every needle above and from each other: a value that
# collides with an existing needle produces a FALSE leak report, which is worse
# than a missing assertion.
EXPECTED_ANCHOR_PW="cdkd-anchor-corroborated-pw-741"
EXPECTED_AMBIG_ALPHA="cdkd-anchor-ambiguous-alpha-742"
EXPECTED_AMBIG_BRAVO="cdkd-anchor-ambiguous-bravo-743"

# --- issue #1947 drift arm -------------------------------------------------
# Exported ahead of every phase for the anchor arm's reason.
export CDKD_INTEG_DRIFT_ARM=1
DRIFT_PROJECT="cdkd-test-array-drift-${ACCOUNT_ID}"
DRIFT_ROLE="cdkd-test-array-drift-${ACCOUNT_ID}"
DRIFT_PW_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:driftPw}}"
# Disjoint from every needle above, for the reason the anchor arm gives.
EXPECTED_DRIFT_PW="cdkd-drift-array-pw-744"
# What the console edit writes. Not a secret, but at a secret-bearing position
# cdkd cannot tell it from last week's rotated-away value, so it must be masked.
DRIFT_SENTINEL="cdkd-drift-injected-not-the-secret"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# assert_read <label> <value> — fail when a read returned nothing.
#
# `aws --output text` renders an empty JMESPath result as the literal `None`,
# which is indistinguishable from a real value at the comparison below: a live
# run reported `got: No***(len=4)` for a DEPLOY THAT WAS CORRECT, and the
# fixture's own query was at fault. Every read whose expression could silently
# select nothing goes through here FIRST, so a broken expression is reported as
# a broken expression.
assert_read() {
  local label="$1" value="$2"
  # `None` is the AWS CLI's empty-JMESPath rendering; `null` is jq's rendering
  # of a field that is absent (or of an element that matched while its `.Value`
  # is missing). Both print as a 4-character word that reads like a real value
  # at the comparison below, which is the exact confusion this helper exists to
  # remove — so both are rejected.
  if [ -z "${value}" ] || [ "${value}" = "None" ] || [ "${value}" = "null" ]; then
    echo "FAIL: the read for ${label} returned no value (got: '${value}')." >&2
    echo "      This is the FIXTURE's query failing to select, not necessarily a cdkd defect." >&2
    exit 1
  fi
}

# mask <value> -> first 2 chars + length, so logs never carry the plaintext.
mask() {
  local v="$1"
  if [ -z "${v}" ]; then
    echo "<empty>"
    return
  fi
  local n=${#v}
  local head
  head=$(printf '%s' "${v}" | cut -c1-2)
  echo "${head}***(len=${n})"
}

# --- issue #2012 anchor-arm read helpers ------------------------------------
# Every expression below was executed against a real payload shape before it
# was written down. `jq` / JMESPath is untested code, and this fixture has
# already been burned once by a query that silently selected nothing.
#
# `cd_field_of` reads a CFn-cased bag (state `properties` / `observedProperties`);
# `live_cd_field` reads the SDK-cased `DescribeTaskDefinition` payload, whose
# keys are lowerCamel. Both select the container BY NAME rather than by index,
# for the reason `env_value_of` does, and both wrap the selection in
# `[ ... ] | .[0]` so a missing container yields `null` rather than an EMPTY
# string -- `assert_read` rejects both, but only one of them names the read.
cd_field_of() { # usage: cd_field_of <bag-json> <container> <CfnField>
  printf '%s' "$1" | jq -c --arg c "$2" --arg f "$3" \
    '[(.ContainerDefinitions // [])[] | select(.Name==$c) | (.[$f] // null)] | (.[0] // null)'
}
live_cd_field() { # usage: live_cd_field <containerDefinitions-json> <container> <sdkField>
  printf '%s' "$1" | jq -c --arg c "$2" --arg f "$3" \
    '[(. // [])[] | select(.name==$c) | (.[$f] // null)] | (.[0] // null)'
}
# json_index <json-array> <index> -- prints `null`, which `assert_read`
# rejects, when the index is out of range.
json_index() {
  printf '%s' "$1" | jq -r --argjson i "$2" '.[$i]'
}
# assert_unkeyed_string_array <label> <json-array> <expected-length>
#
# THE PREMISE of the anchor arm, asserted rather than assumed. If any element
# carried `Name` / `Key`, `identityKeyFor` would key the array, the issue #1915
# KEYED descent would answer it, and `unkeyedArrayPairsByAnchors` -- the code
# this arm exists to exercise -- would never be consulted at all. The run would
# then report a clean result while testing nothing.
#
# The identity probe is not vacuous: run against this fixture's `Environment[]`
# it answers `true`, and against `Command` it answers `false`. It must run
# BEFORE the all-strings check -- ordered after it, that check rejects any
# array containing an object first, so the identity branch is unreachable and
# the claim above would be true of the jq expression but false of the helper
# (found by the round-3 review of PR go-to-k/cdkd#2295).
assert_unkeyed_string_array() {
  local label="$1" arr="$2" want_len="$3" got_len shapes keyed
  got_len=$(printf '%s' "${arr}" | jq -r 'if type=="array" then length else "not-an-array" end')
  if [ "${got_len}" != "${want_len}" ]; then
    echo "FAIL: ${label}: expected an array of ${want_len} elements, got '${got_len}'" >&2
    exit 1
  fi
  keyed=$(printf '%s' "${arr}" | jq -r '[.[] | select(type=="object") | (has("Name") or has("Key"))] | any')
  if [ "${keyed}" != "false" ]; then
    echo "FAIL: ${label}: an element carries an ARRAY_IDENTITY_KEYS member, so identityKeyFor would key this array and the anchor gate would never run" >&2
    exit 1
  fi
  shapes=$(printf '%s' "${arr}" | jq -r '[.[] | type] | unique | join(",")')
  if [ "${shapes}" != "string" ]; then
    echo "FAIL: ${label}: elements are '${shapes}', not all plain strings" >&2
    exit 1
  fi
}

# Deregister every ACTIVE revision of the family. Best-effort, and written as a
# subshell so it never re-arms strict mode in a `set +eu` caller.
deregister_family() { (
  set +eu
  # SCOPE GUARD (#2621). `FAMILY` is the one DERIVED scope among these guards
  # (`cdkd-test-array-secret-${ACCOUNT_ID}`). An empty `ACCOUNT_ID` would leave
  # the bare literal, and `cdkd-test-array-secret-?*` REFUSES that — skipping
  # the sweep rather than running it. That is deliberate and costs nothing:
  # `ACCOUNT_ID` is assigned under `set -euo pipefail` near the top, well before
  # this trap is armed, so a failed `sts get-caller-identity` aborts the run
  # instead of reaching here. The guard is what keeps the shape safe one edit
  # further on: drop the literal and `--family-prefix ""` matches EVERY family
  # in the account, with the `set +eu` above having disabled the only thing that
  # would have caught it.
  # `deregister` is as destructive as `delete` here: an INACTIVE revision
  # cannot be run and cannot be restored. `exit 0` and not `return 0`: this is
  # a SUBSHELL, so the exit ends the sweep and leaves the caller running.
  # The convention is in `docs/integ-fixture-conventions.md`.
  case "${FAMILY}" in
    cdkd-test-array-secret-?*) ;;
    *)
      echo "    WARN: teardown sweep refused a family prefix outside cdkd-test-array-secret-: '${FAMILY:-<empty>}'" >&2
      exit 0
      ;;
  esac
  local arns arn
  arns=$(aws ecs list-task-definitions --family-prefix "${FAMILY}" --status ACTIVE \
    --region "${REGION}" --query 'taskDefinitionArns[]' --output text 2>/dev/null)
  for arn in ${arns}; do
    aws ecs deregister-task-definition --task-definition "${arn}" --region "${REGION}" >/dev/null 2>&1
  done
) }

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort sweep in case state destroy missed them. The task definition is
  # the one cdkd cannot leave "gone" — deregistration is the only delete AWS
  # offers — so it is swept by FAMILY rather than by a remembered ARN.
  deregister_family
  # The drift arm's project, then its role (in use by the project until then).
  # Both are exact NAMES, not a listed prefix, so there is no scope to widen.
  aws codebuild delete-project --name "${DRIFT_PROJECT}" --region "${REGION}" >/dev/null 2>&1
  aws iam delete-role --role-name "${DRIFT_ROLE}" >/dev/null 2>&1
  if [ -n "${DRIFT_ERR_FILE:-}" ]; then rm -f "${DRIFT_ERR_FILE}"; fi
  if [ -n "${SECRET_VALUE_FILE:-}" ]; then rm -f "${SECRET_VALUE_FILE}"; fi
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  aws secretsmanager delete-secret --secret-id "${TOKEN_SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    # The `aws s3 rm` above only wrote DELETE MARKERS. Purge the versions they
    # hide, NONCURRENT-only: this function also runs from the pre-run sweep and
    # from the failure/INT/TERM traps, where a live state.json may be the only
    # record of resources still standing. The success path does the full sweep.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
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

# --- Out-of-band token-shaped secret (issue #1917) ---------------------
# Created by THIS script rather than declared in the stack: its VALUE contains a
# `{{resolve:...}}` string, and cdkd scans every template string PROPERTY for
# dynamic references before any provider runs — so declaring the value would
# make the deploy try to fetch the decoy secret it names and fail. The stack
# only REFERENCES this secret, and that is safe for a NARROWER reason than
# "substituted values are not re-scanned" — `Fn::Join` / `Fn::Sub` re-scan
# theirs. It is safe because the consuming env var is a LITERAL string, so no
# intrinsic ever sees the substitution. Created AFTER the pre-run cleanup
# (which deletes it) and removed again by the cleanup trap.
echo "==> Creating the token-shaped secret out of band"
# Retried: the pre-run cleanup force-deleted this same name seconds ago, and
# Secrets Manager documents a window in which CreateSecret still reports the
# name as in use / scheduled for deletion. Without the back-off a re-run after
# an aborted run aborts the whole fixture under `set -e` — the failure mode is
# rare and total, which is the worst combination to leave to chance.
create_rc=1
create_out=""
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if create_out=$(aws secretsmanager create-secret --name "${TOKEN_SECRET_NAME}" \
      --secret-string "{\"ref\":\"${EXPECTED_TOKEN_SHAPED}\"}" \
      --region "${REGION}" 2>&1); then
    create_rc=0
    break
  fi
  echo "    create-secret attempt ${attempt} failed, retrying in 5s"
  sleep 5
done
if [ "${create_rc}" -ne 0 ]; then
  echo "FAIL: could not create the out-of-band secret '${TOKEN_SECRET_NAME}': ${create_out}" >&2
  exit 1
fi
# Fail loudly if AWS did not store the value verbatim: every assertion below
# would otherwise pass vacuously against a different string, which is the
# OPPOSITE of what is under test.
STORED_TOKEN=$(aws secretsmanager get-secret-value --secret-id "${TOKEN_SECRET_NAME}" \
  --region "${REGION}" --query 'SecretString' --output text | jq -r '.ref')
assert_read "the out-of-band secret's stored .ref" "${STORED_TOKEN}"
if [ "${STORED_TOKEN}" != "${EXPECTED_TOKEN_SHAPED}" ]; then
  echo "FAIL: the out-of-band secret does not hold the expected token-shaped value" >&2
  echo "      got:  $(mask "${STORED_TOKEN}")" >&2
  exit 1
fi
echo "    OK: token-shaped secret created with a {{resolve:...}} string as its VALUE"

# --- Phase 1: deploy WITHOUT an observed baseline ---------------------------
# `--no-capture-observed-state` is what arms phase 2: cdkd's auto-refresh fires
# `readCurrentState` for records that LACK `observedProperties`, and that is the
# path on which the resource is never resolved (so the secrets map is empty) yet
# a fresh AWS readback still lands in state. Capturing on the first deploy
# instead would carry a baseline forward and phase 2 would prove nothing.
echo "==> Phase 1: deploy with --no-capture-observed-state"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --no-capture-observed-state \
  --yes

echo "==> Reading the registered task definition from AWS"
# NOTE the `[]` after each filter. A filter projection followed by a second
# filter projection does NOT collapse the way a bare `[0][0]` assumes — that
# spelling returns nothing against the real DescribeTaskDefinition payload,
# which is how a correct deploy was reported as a wrong value. Flattening after
# each filter is also why this still names the CONTAINER rather than indexing
# `containerDefinitions[0]`: the `sidecar` container exists to prove the
# redaction is not blanket, and an index would start passing silently if the
# two were ever reordered.
LIVE_ENV=$(aws ecs describe-task-definition --task-definition "${FAMILY}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[?name==`app`][].environment[?name==`DB_PASSWORD`][].value | [0]' \
  --output text)
assert_read "the live container env DB_PASSWORD" "${LIVE_ENV}"

case "${LIVE_ENV}" in
  *'{{resolve:'*)
    echo "FAIL: the live container env DB_PASSWORD is still the LITERAL dynamic reference: $(mask "${LIVE_ENV}")" >&2
    exit 1
    ;;
esac
if [ "${LIVE_ENV}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: the live container env DB_PASSWORD resolved to the WRONG value." >&2
  echo "      got:  $(mask "${LIVE_ENV}")" >&2
  echo "      want: $(mask "${EXPECTED_PASSWORD}")" >&2
  exit 1
fi
echo "    OK: the array-nested reference reached AWS RESOLVED -> $(mask "${LIVE_ENV}")"

# Issue #1917's live half: the container must hold the token-SHAPED plaintext
# byte-for-byte. If cdkd had re-scanned its own substitution the deploy would
# have failed on a nonexistent secret instead, so this also pins that it does
# not.
LIVE_TOKEN=$(aws ecs describe-task-definition --task-definition "${FAMILY}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions[?name==`app`][].environment[?name==`TOKEN_SHAPED`][].value | [0]' \
  --output text)
assert_read "the live container env TOKEN_SHAPED" "${LIVE_TOKEN}"
if [ "${LIVE_TOKEN}" != "${EXPECTED_TOKEN_SHAPED}" ]; then
  echo "FAIL: the live container env TOKEN_SHAPED is not the expected token-shaped value." >&2
  echo "      got:  $(mask "${LIVE_TOKEN}")" >&2
  exit 1
fi
echo "    OK: the token-shaped secret reached AWS as its literal resolved value"

# --- issue #2012: the anchor arm's PREMISE, measured on live AWS ------------
# One read, then all selection in jq. The `--query` here is a plain projection
# rather than the `[?name==...][]` filter spelling above, for the reason that
# note records: a filter projection followed by a second filter projection does
# not collapse, and this fixture has already paid for that once.
LIVE_CDS=$(aws ecs describe-task-definition --task-definition "${FAMILY}" --region "${REGION}" \
  --query 'taskDefinition.containerDefinitions' --output json)
LIVE_ANCHOR_CMD=$(live_cd_field "${LIVE_CDS}" anchorprobe command)
assert_read "the live anchorprobe Command" "${LIVE_ANCHOR_CMD}"
assert_unkeyed_string_array "the live anchorprobe Command" "${LIVE_ANCHOR_CMD}" 3
LIVE_ANCHOR_CMD_1=$(json_index "${LIVE_ANCHOR_CMD}" 1)
assert_read "the live anchorprobe Command[1]" "${LIVE_ANCHOR_CMD_1}"
case "${LIVE_ANCHOR_CMD_1}" in
  *'{{resolve:'*)
    echo "FAIL: the anchor-arm Command position is still the LITERAL dynamic reference: $(mask "${LIVE_ANCHOR_CMD_1}")" >&2
    exit 1
    ;;
esac
if [ "${LIVE_ANCHOR_CMD_1}" != "${EXPECTED_ANCHOR_PW}" ]; then
  echo "FAIL: the anchor-arm reference did not reach AWS RESOLVED." >&2
  echo "      got:  $(mask "${LIVE_ANCHOR_CMD_1}")" >&2
  echo "      want: $(mask "${EXPECTED_ANCHOR_PW}")" >&2
  echo "      Every #2012 assertion below would then be vacuous: there is no plaintext to redact." >&2
  exit 1
fi
# The ANCHORS themselves. Rule 1 of the gate is "AWS returned THIS position
# unchanged", so a rewritten flag would make the gate refuse for a reason that
# has nothing to do with what this arm measures.
if [ "$(json_index "${LIVE_ANCHOR_CMD}" 0)" != "-c" ] \
  || [ "$(json_index "${LIVE_ANCHOR_CMD}" 2)" != "-v" ]; then
  echo "FAIL: AWS did not echo the Command anchors back unchanged, so the pairing has no evidence to rest on" >&2
  exit 1
fi
echo "    OK: the UNKEYED Command array reached AWS resolved, between anchors AWS echoed verbatim"

LIVE_ANCHOR_EP=$(live_cd_field "${LIVE_CDS}" anchorprobe entryPoint)
assert_read "the live anchorprobe EntryPoint" "${LIVE_ANCHOR_EP}"
assert_unkeyed_string_array "the live anchorprobe EntryPoint" "${LIVE_ANCHOR_EP}" 4
LIVE_EP_1=$(json_index "${LIVE_ANCHOR_EP}" 1)
LIVE_EP_3=$(json_index "${LIVE_ANCHOR_EP}" 3)
assert_read "the live anchorprobe EntryPoint[1]" "${LIVE_EP_1}"
assert_read "the live anchorprobe EntryPoint[3]" "${LIVE_EP_3}"
if [ "${LIVE_EP_1}" != "${EXPECTED_AMBIG_ALPHA}" ] || [ "${LIVE_EP_3}" != "${EXPECTED_AMBIG_BRAVO}" ]; then
  echo "FAIL: the negative control's two references did not reach AWS resolved to their own values." >&2
  echo "      got[1]: $(mask "${LIVE_EP_1}")  got[3]: $(mask "${LIVE_EP_3}")" >&2
  exit 1
fi
if [ "${EXPECTED_AMBIG_ALPHA}" = "${EXPECTED_AMBIG_BRAVO}" ]; then
  echo "FAIL: the negative control's two plaintexts are equal, so a mis-assignment between them would be invisible" >&2
  exit 1
fi
# The property that makes it a CONTROL rather than a second positive case: the
# two anchors are IDENTICAL, so the two reference-bearing elements are
# indistinguishable to `anchorSignature` and rule 3 has to refuse.
if [ "$(json_index "${LIVE_ANCHOR_EP}" 0)" != "-p" ] \
  || [ "$(json_index "${LIVE_ANCHOR_EP}" 2)" != "-p" ]; then
  echo "FAIL: the negative control's anchors are not the identical pair that makes it a control" >&2
  exit 1
fi
echo "    OK: the negative control reached AWS resolved, behind two IDENTICAL anchors"

echo "==> Reading cdkd state after phase 1"
STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json)

TD_RECORD=$(printf '%s' "${STATE_JSON}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::ECS::TaskDefinition") | .value')
if [ -z "${TD_RECORD}" ] || [ "${TD_RECORD}" = "null" ]; then
  echo "FAIL: no AWS::ECS::TaskDefinition record in cdkd state" >&2
  exit 1
fi

# jq helper: pull one container's env value out of a properties-shaped bag,
# BY NAME at both levels — a positional read here would pass against exactly the
# bug under test (the point is that order is not guaranteed).
env_value_of() { # usage: env_value_of <bag-json> <container> <var>
  printf '%s' "$1" | jq -r --arg c "$2" --arg v "$3" \
    '(.ContainerDefinitions // [])[] | select(.Name==$c) | (.Environment // [])[]
       | select(.Name==$v) | .Value'
}

P1_PROPS=$(printf '%s' "${TD_RECORD}" | jq -c '.properties')
P1_STATE_SECRET=$(env_value_of "${P1_PROPS}" app DB_PASSWORD)
assert_read "state properties ContainerDefinitions[app].Environment[DB_PASSWORD]" "${P1_STATE_SECRET}"
if [ "${P1_STATE_SECRET}" != "${SECRET_EXPR}" ]; then
  echo "FAIL: state properties must hold the unresolved expression at the array-nested leaf." >&2
  echo "      got:  $(mask "${P1_STATE_SECRET}")" >&2
  echo "      want: ${SECRET_EXPR}" >&2
  exit 1
fi
echo "    OK: state properties hold the {{resolve:...}} expression at ContainerDefinitions[].Environment[]"

# Issue #1917 on the TEMPLATE-sourced row: the leaf whose plaintext looks like
# an expression must be persisted as ITS OWN expression, not kept verbatim.
P1_STATE_TOKEN=$(env_value_of "${P1_PROPS}" app TOKEN_SHAPED)
assert_read "state properties ContainerDefinitions[app].Environment[TOKEN_SHAPED]" "${P1_STATE_TOKEN}"
if [ "${P1_STATE_TOKEN}" != "${TOKEN_EXPR}" ]; then
  echo "FAIL: state properties must hold the expression for the token-shaped secret (issue #1917)." >&2
  echo "      got:  $(mask "${P1_STATE_TOKEN}")" >&2
  echo "      want: ${TOKEN_EXPR}" >&2
  exit 1
fi
echo "    OK: the token-shaped secret is persisted as its own expression"

# The anchor arm's SOURCE side. `properties` comes from the template, so these
# expressions are what the phase-2 readback walk projects FROM -- and the
# arrays must be unkeyed on this side too, since `identityKeyFor` inspects both.
P1_ANCHOR_CMD=$(cd_field_of "${P1_PROPS}" anchorprobe Command)
assert_read "state properties ContainerDefinitions[anchorprobe].Command" "${P1_ANCHOR_CMD}"
assert_unkeyed_string_array "state properties anchorprobe Command" "${P1_ANCHOR_CMD}" 3
P1_ANCHOR_CMD_1=$(json_index "${P1_ANCHOR_CMD}" 1)
if [ "${P1_ANCHOR_CMD_1}" != "${ANCHOR_PW_EXPR}" ]; then
  echo "FAIL: state properties must hold the unresolved expression at the UNKEYED array position." >&2
  echo "      got:  $(mask "${P1_ANCHOR_CMD_1}")" >&2
  echo "      want: ${ANCHOR_PW_EXPR}" >&2
  exit 1
fi
P1_ANCHOR_EP=$(cd_field_of "${P1_PROPS}" anchorprobe EntryPoint)
assert_read "state properties ContainerDefinitions[anchorprobe].EntryPoint" "${P1_ANCHOR_EP}"
assert_unkeyed_string_array "state properties anchorprobe EntryPoint" "${P1_ANCHOR_EP}" 4
if [ "$(json_index "${P1_ANCHOR_EP}" 1)" != "${AMBIG_ALPHA_EXPR}" ] \
  || [ "$(json_index "${P1_ANCHOR_EP}" 3)" != "${AMBIG_BRAVO_EXPR}" ]; then
  echo "FAIL: state properties must hold the two DISTINCT expressions of the negative control" >&2
  exit 1
fi
if [ "${AMBIG_ALPHA_EXPR}" = "${AMBIG_BRAVO_EXPR}" ]; then
  echo "FAIL: the negative control's two expressions are equal, so rule 3 would have nothing to tell apart" >&2
  exit 1
fi
echo "    OK: both UNKEYED anchor-arm arrays hold their expressions in state properties"

# The task definition REVISION at the end of phase 1. Phase 2 asserts this is
# UNCHANGED, which is the only thing that proves the resource took the unchanged
# path: an ECS task definition update mints a new revision, and an UPDATE would
# also populate observedProperties and a non-empty secrets map — so a
# presence-only check on observedProperties passes on both paths and would let
# the whole fixture succeed with the keyed descent removed.
P1_PHYSICAL_ID=$(printf '%s' "${TD_RECORD}" | jq -r '.physicalId')
if [ -z "${P1_PHYSICAL_ID}" ] || [ "${P1_PHYSICAL_ID}" = "null" ]; then
  echo "FAIL: could not read the task definition physicalId from state" >&2
  exit 1
fi
echo "    Task definition revision after phase 1: ${P1_PHYSICAL_ID}"

# The precondition for phase 2. Asserted, not assumed: if a baseline were
# already present the auto-refresh would not fire and every phase-2 assertion
# would pass vacuously against a record that was never re-read from AWS.
P1_OBSERVED=$(printf '%s' "${TD_RECORD}" | jq -r 'if .observedProperties == null then "absent" else "present" end')
if [ "${P1_OBSERVED}" != "absent" ]; then
  echo "FAIL: expected NO observedProperties after --no-capture-observed-state (got: ${P1_OBSERVED}) — phase 2 would be vacuous" >&2
  exit 1
fi
echo "    OK: the record carries no observed baseline yet (phase 2 is armed)"

# Scoped to the CONSUMER's record, not the whole document. The secret resource's
# OWN `SecretString` is the fixture's hardcoded `unsafePlainText` value, which
# legitimately lands in that resource's own state properties exactly as
# CloudFormation stores template values — redacting a resource's own literal is
# a different concern (hardcoded secrets in templates), and the per-resource
# secrets scoping deliberately does not cross records. A whole-document grep
# would therefore fail on CORRECT behavior. The sibling fixture documents the
# same trap. grep -qF so the plaintext is never echoed.
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: the resolved secret plaintext is present in the task definition record after phase 1" >&2
  exit 1
fi
if printf '%s' "${TD_RECORD}" | grep -qF "cdkd-decoy-never-created"; then
  echo "FAIL: the token-shaped secret plaintext is present in the task definition record after phase 1 (issue #1917)" >&2
  exit 1
fi
# ALL THREE anchor-arm plaintexts, and all three unconditionally: phase 1
# carries no observed baseline at all. (Until issue #2852 this differed from
# phase 2, where the negative control's values legitimately survived; the
# refused position now fails closed there too.) grep -qF and no echo of the
# needle, like the two above.
for anchor_needle in "${EXPECTED_ANCHOR_PW}" "${EXPECTED_AMBIG_ALPHA}" "${EXPECTED_AMBIG_BRAVO}"; do
  if printf '%s' "${TD_RECORD}" | grep -qF "${anchor_needle}"; then
    echo "FAIL: an anchor-arm plaintext is present in the task definition record after phase 1 (issue #2012)" >&2
    exit 1
  fi
done
echo "    OK: no resolved plaintext in the consumer record after phase 1"

# --- Phase 1d: `cdkd drift` on the array shape (issue #1947) ----------------
# Here, before phase 2, because this is the one point where the drift baseline
# is `properties` for every consumer: phase 1 captured no observed baseline, so
# no #2852 fail-closed mask exists yet for the comparison to trip over. The
# task definition must end the stop exactly as it began — no observed baseline,
# same revision — or phase 2's premises go vacuous; that is re-asserted below.
echo "==> Phase 1d: cdkd drift on the array-nested secret (issue #1947)"

# Every plaintext the two consumers hold. The injected sentinel is checked on
# its own, where it is expected to be live.
DRIFT_NEEDLES=("${EXPECTED_PASSWORD}" "${EXPECTED_ANCHOR_PW}" "${EXPECTED_AMBIG_ALPHA}"
  "${EXPECTED_AMBIG_BRAVO}" "${EXPECTED_DRIFT_PW}" "cdkd-decoy-never-created")
DRIFT_ERR_FILE=$(mktemp)

# assert_no_drift_plaintext "<what>" "<text>" -- grep -qF, so a match is never
# echoed.
assert_no_drift_plaintext() {
  local what="$1" text="$2" needle
  for needle in "${DRIFT_NEEDLES[@]}"; do
    if grep -qF "${needle}" <<< "${text}"; then
      echo "FAIL: ${what} carries a resolved secret plaintext" >&2
      exit 1
    fi
  done
  echo "    OK: ${what} carries no plaintext"
}

# The injected value, at a secret-bearing position, is indistinguishable from a
# rotated-away secret, so no output may carry it verbatim while it is live.
assert_no_sentinel() { # assert_no_sentinel "<what>" "<text>"
  if grep -qF "${DRIFT_SENTINEL}" <<< "$2"; then
    echo "FAIL: $1 carried the AWS-current value at a secret-bearing array verbatim" >&2
    exit 1
  fi
}

# A diagnostic dump with every needle and the sentinel masked out.
diag_masked() {
  local out="$1" needle
  for needle in "${DRIFT_NEEDLES[@]}" "${DRIFT_SENTINEL}"; do
    out=${out//"${needle}"/***}
  done
  printf '%s\n' "${out}" >&2
}

run_drift() { # run_drift <extra args...> -> DRIFT_OUT / DRIFT_RC, stderr folded in
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" "$@" 2>&1)
  DRIFT_RC=$?
  set -e
}

run_drift_json() { # -> DRIFT_JSON (stdout only) / DRIFT_JSON_ERR / DRIFT_JSON_RC
  set +e
  DRIFT_JSON=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>"${DRIFT_ERR_FILE}")
  DRIFT_JSON_RC=$?
  set -e
  DRIFT_JSON_ERR=$(cat "${DRIFT_ERR_FILE}")
  if ! printf '%s' "${DRIFT_JSON}" | jq -e 'type == "array" and length == 1' >/dev/null; then
    echo "FAIL: 'cdkd drift --json' did not print one stack's report (rc=${DRIFT_JSON_RC})" >&2
    diag_masked "${DRIFT_JSON}${DRIFT_JSON_ERR}"
    exit 1
  fi
}

# project_env <var> -> the live value of one of the project's env vars.
project_env() {
  aws codebuild batch-get-projects --names "${DRIFT_PROJECT}" --region "${REGION}" \
    | jq -r --arg k "$1" \
      '[.projects[0].environment.environmentVariables[]? | select(.name==$k) | .value] | (.[0] // empty)'
}

# The console edit: re-send the project's WHOLE environment with one variable's
# value replaced. Nothing here is echoed: the readback it is built from carries
# the resolved secret.
set_project_env() { # set_project_env <var> <value>
  local env_json
  env_json=$(aws codebuild batch-get-projects --names "${DRIFT_PROJECT}" --region "${REGION}" \
    | jq -c --arg k "$1" --arg v "$2" \
      '.projects[0].environment | .environmentVariables |= map(if .name == $k then .value = $v else . end)') \
    || return 1
  aws codebuild update-project --name "${DRIFT_PROJECT}" --region "${REGION}" \
    --environment "${env_json}" >/dev/null
}

# project_state_env <bag-json> <var> -- BY NAME, for the reason env_value_of
# gives.
project_state_env() {
  printf '%s' "$1" | jq -r --arg v "$2" \
    '[(.Environment.EnvironmentVariables // [])[] | select(.Name==$v) | .Value] | (.[0] // null)'
}

read_record() { # read_record <resourceType> -> that record from a fresh `state show`
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json \
    | jq -c --arg t "$1" '[.state.resources | to_entries[] | select(.value.resourceType==$t) | .value] | (.[0] // null)'
}

# PREMISE, asserted: the project's reference reached AWS resolved, and its
# record holds the expression with no observed baseline -- so the comparison
# below really is resolved-`properties` against the live plaintext.
LIVE_DRIFT_PW=$(project_env DB_PASSWORD)
assert_read "the live CodeBuild env DB_PASSWORD" "${LIVE_DRIFT_PW}"
if [ "${LIVE_DRIFT_PW}" != "${EXPECTED_DRIFT_PW}" ]; then
  echo "FAIL: the project's array-nested reference did not reach AWS resolved: $(mask "${LIVE_DRIFT_PW}")" >&2
  exit 1
fi
PROJECT_RECORD=$(read_record AWS::CodeBuild::Project)
assert_read "the CodeBuild project record" "${PROJECT_RECORD}"
P1D_PROJECT_SECRET=$(project_state_env "$(printf '%s' "${PROJECT_RECORD}" | jq -c '.properties')" DB_PASSWORD)
if [ "${P1D_PROJECT_SECRET}" != "${DRIFT_PW_EXPR}" ]; then
  echo "FAIL: the project's state properties must hold the expression at the array-nested leaf" >&2
  echo "      got:  $(mask "${P1D_PROJECT_SECRET}")" >&2
  exit 1
fi
if [ "$(printf '%s' "${PROJECT_RECORD}" | jq -r '.observedProperties == null')" != "true" ]; then
  echo "FAIL: the project already carries an observed baseline, so this stop is not on the properties baseline" >&2
  exit 1
fi
echo "    OK: premise -- the project reached AWS resolved, and state holds the expression with no observed baseline"

# (a) + (b): a freshly deployed stack is CLEAN, and says so without printing
# anything state deliberately does not hold. rc=0 alone is also what a
# resource cdkd never compared produces, so the JSON must name BOTH array
# consumers as compared-and-matched.
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' reported drift on the freshly deployed stack (rc=${DRIFT_RC})" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' on the clean stack" "${DRIFT_OUT}"
run_drift_json
if [ "${DRIFT_JSON_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --json' exited ${DRIFT_JSON_RC} on the freshly deployed stack" >&2
  diag_masked "${DRIFT_JSON}${DRIFT_JSON_ERR}"
  exit 1
fi
for consumer_type in AWS::ECS::TaskDefinition AWS::CodeBuild::Project; do
  if [ "$(printf '%s' "${DRIFT_JSON}" | jq -r --arg t "${consumer_type}" '[.[0].clean[] | select(.type==$t)] | length')" != "1" ]; then
    echo "FAIL: '${consumer_type}' is not reported compared-and-matched on the freshly deployed stack" >&2
    diag_masked "${DRIFT_JSON}"
    exit 1
  fi
done
if [ "$(printf '%s' "${DRIFT_JSON}" | jq -r '(.[0].drifted | length) + (.[0].notCompared | length)')" != "0" ]; then
  echo "FAIL: the freshly deployed stack has a drifted or not-compared resource" >&2
  diag_masked "${DRIFT_JSON}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --json' on the clean stack" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
echo "    OK: no drift -- both array consumers compared and matched"

echo "==> Injecting out-of-band drift on the project's array-nested DB_PASSWORD"
set_project_env DB_PASSWORD "${DRIFT_SENTINEL}"
# Proven to have taken: a silent no-op leaves a clean stack, and every
# assertion below would pass for the wrong reason.
if [ "$(project_env DB_PASSWORD)" != "${DRIFT_SENTINEL}" ]; then
  echo "FAIL: the console edit of DB_PASSWORD did not land -- the assertions below would be vacuous" >&2
  exit 1
fi
if [ "$(project_env MODE)" != "production" ]; then
  echo "FAIL: the console edit disturbed the non-secret sibling MODE" >&2
  exit 1
fi

# (b) on a DRIFTED secret: reported, and masked. The comparator does not
# descend an array, so the change sits at the ARRAY's path and both sides are
# the whole array -- plaintext included, unless the path mask catches it.
run_drift
if [ "${DRIFT_RC}" -eq 0 ]; then
  echo "FAIL: 'cdkd drift' saw no drift after DB_PASSWORD was changed out of band" >&2
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' on the drifted array" "${DRIFT_OUT}"
assert_no_sentinel "'cdkd drift'" "${DRIFT_OUT}"
# The report's AWS-side line for the array itself must carry the mask: a `***`
# anywhere else in the output would not show that THIS value was masked.
DRIFT_AWS_LINE=$(grep -F "+ Environment.EnvironmentVariables:" <<< "${DRIFT_OUT}" || true)
if [ -z "${DRIFT_AWS_LINE}" ] || ! grep -qF '***' <<< "${DRIFT_AWS_LINE}"; then
  echo "FAIL: 'cdkd drift' did not report the drifted array's AWS side masked" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
run_drift_json
DRIFT_SET=$(printf '%s' "${DRIFT_JSON}" \
  | jq -r '[.[0].drifted[] | .type as $t | .changes[] | "\($t) \(.path)"] | sort | join(",")')
if [ "${DRIFT_SET}" != "AWS::CodeBuild::Project Environment.EnvironmentVariables" ]; then
  # Types and paths only -- no value -- so it is safe to print.
  echo "FAIL: expected exactly one drifted path, the project's env-var array; got: '${DRIFT_SET}'" >&2
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --json' on the drifted array" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
assert_no_sentinel "'cdkd drift --json'" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
echo "    OK: the console edit is reported at the array, masked, with no phantom drift elsewhere"

# (d): --accept must REFUSE the masked array rather than persist what it just
# masked -- the live array carries the sentinel AND nothing else could have
# told cdkd whether it is a rotated secret.
echo "==> Asserting --accept refuses the secret-bearing array"
run_drift --accept --yes
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed instead of refusing the array (rc=${DRIFT_RC})" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --accept'" "${DRIFT_OUT}"
assert_no_sentinel "'cdkd drift --accept'" "${DRIFT_OUT}"
if ! grep -qF "not accepting" <<< "${DRIFT_OUT}"; then
  echo "FAIL: --accept did not say it was refusing the secret-bearing array" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
PROJECT_RECORD=$(read_record AWS::CodeBuild::Project)
assert_read "the CodeBuild project record after --accept" "${PROJECT_RECORD}"
assert_no_drift_plaintext "the project record after --accept" "${PROJECT_RECORD}"
if grep -qF "${DRIFT_SENTINEL}" <<< "${PROJECT_RECORD}"; then
  echo "FAIL: --accept persisted the injected value at a secret-bearing array" >&2
  exit 1
fi
if grep -qF '"***"' <<< "${PROJECT_RECORD}"; then
  echo "FAIL: --accept persisted the MASK into the project record" >&2
  exit 1
fi
if [ "$(project_state_env "$(printf '%s' "${PROJECT_RECORD}" | jq -c '.properties')" DB_PASSWORD)" != "${DRIFT_PW_EXPR}" ]; then
  echo "FAIL: --accept did not leave DB_PASSWORD on its own {{resolve:...}} expression" >&2
  exit 1
fi
echo "    OK: --accept refused the array and left the expression in state"

# (c): --revert must RE-RESOLVE the expression before handing it to the
# provider; shipping the literal token is the live-breakage half of #1914.
echo "==> Reverting the injected drift"
run_drift --revert --yes
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --revert' failed (rc=${DRIFT_RC})" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --revert'" "${DRIFT_OUT}"
assert_no_sentinel "'cdkd drift --revert'" "${DRIFT_OUT}"
REVERTED_PW=$(project_env DB_PASSWORD)
case "${REVERTED_PW}" in
  *'{{resolve:'*)
    echo "FAIL: --revert wrote the LITERAL {{resolve:...}} token into the live array" >&2
    exit 1
    ;;
esac
if [ "${REVERTED_PW}" != "${EXPECTED_DRIFT_PW}" ]; then
  echo "FAIL: --revert left DB_PASSWORD as $(mask "${REVERTED_PW}"), expected the resolved secret" >&2
  exit 1
fi
if [ "$(project_env MODE)" != "production" ]; then
  echo "FAIL: --revert corrupted the non-secret sibling MODE it re-sent in the same array" >&2
  exit 1
fi
echo "    OK: --revert restored the RESOLVED secret into the live array"
PROJECT_RECORD=$(read_record AWS::CodeBuild::Project)
assert_read "the CodeBuild project record after --revert" "${PROJECT_RECORD}"
assert_no_drift_plaintext "the project record after --revert" "${PROJECT_RECORD}"
if [ "$(project_state_env "$(printf '%s' "${PROJECT_RECORD}" | jq -c '.properties')" DB_PASSWORD)" != "${DRIFT_PW_EXPR}" ]; then
  echo "FAIL: the revert's state write did not keep DB_PASSWORD's expression" >&2
  exit 1
fi
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' still reports drift after --revert (rc=${DRIFT_RC})" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' after --revert" "${DRIFT_OUT}"
echo "    OK: the stack is clean again after --revert"

# (b) on the resolution-FAILURE path. When a reference cannot be resolved,
# drift compares the UNRESOLVED baseline, clears its value map, and the only
# thing masking the live array is the offline path seed
# `collectDynamicReferencePaths` -- whose array descent is the other half of
# the claim #1947 rests on. Stripping the project's key from the secret fails
# that one resource's resolution (the task definition's keys stay), while the
# live array holds the RESOLVED plaintext the revert just restored. The value
# is restored right after the two runs and before the assertions below; a
# setup failure in between exits with the key still stripped, which is safe
# because `cleanup` force-deletes the secret.
echo "==> Asserting the resolution-failure path masks the array too"
ORIG_SECRET_STRING=$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query SecretString --output text)
assert_read "the fixture secret's SecretString" "${ORIG_SECRET_STRING}"
STRIPPED_SECRET_STRING=$(printf '%s' "${ORIG_SECRET_STRING}" | jq -c 'del(.driftPw)')
# Both values go to put-secret-value through a 0600 file, not argv, where
# `ps` would show every key's plaintext for the life of the call.
SECRET_VALUE_FILE=$(umask 077 && mktemp)
put_secret_string() { # put_secret_string <value>
  printf '%s' "$1" > "${SECRET_VALUE_FILE}"
  aws secretsmanager put-secret-value --secret-id "${SECRET_NAME}" --region "${REGION}" \
    --secret-string "file://${SECRET_VALUE_FILE}" >/dev/null
  : > "${SECRET_VALUE_FILE}"
}
if [ "$(printf '%s' "${STRIPPED_SECRET_STRING}" | jq -r 'has("driftPw") or (has("password") | not)')" != "false" ]; then
  echo "FAIL: could not build a secret value lacking only driftPw -- the failure path would not be reached" >&2
  exit 1
fi
# secret_has_drift_pw -> "true" / "false" for the CURRENT version. Polled
# below: a read straight after a PutSecretValue can still answer with the
# previous version, which would run the failure path against the wrong value.
secret_has_drift_pw() {
  aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" --region "${REGION}" \
    --query SecretString --output text | jq -r 'has("driftPw")'
}
wait_secret_has_drift_pw() { # wait_secret_has_drift_pw <true|false>
  local _
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    [ "$(secret_has_drift_pw)" = "$1" ] && return 0
    sleep 3
  done
  echo "FAIL: the fixture secret never reported has(driftPw)=$1" >&2
  exit 1
}
put_secret_string "${STRIPPED_SECRET_STRING}"
wait_secret_has_drift_pw false
run_drift
FAILPATH_OUT="${DRIFT_OUT}"
FAILPATH_RC="${DRIFT_RC}"
run_drift_json
put_secret_string "${ORIG_SECRET_STRING}"
rm -f "${SECRET_VALUE_FILE}"
wait_secret_has_drift_pw true
if [ "$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" --region "${REGION}" \
    --query SecretString --output text | jq -r '.driftPw // empty')" != "${EXPECTED_DRIFT_PW}" ]; then
  echo "FAIL: could not restore the fixture secret's driftPw after the failure-path runs" >&2
  exit 1
fi
if [ "${FAILPATH_RC}" -eq 0 ]; then
  echo "FAIL: 'cdkd drift' exited 0 with the project's reference unresolvable -- the failure path never reported it" >&2
  diag_masked "${FAILPATH_OUT}"
  exit 1
fi
# POSITIVE marker that the failure path ran, in cdkd's own words: absent, the
# no-plaintext checks below would be satisfied by a run that resolved fine.
if ! grep -qF "could not resolve the dynamic reference" <<< "${FAILPATH_OUT}"; then
  echo "FAIL: 'cdkd drift' did not report the unresolvable reference, so the failure path is unproven" >&2
  diag_masked "${FAILPATH_OUT}"
  exit 1
fi
if [ "$(printf '%s' "${DRIFT_JSON}" | jq -r '[.[0].notCompared[] | select(.type=="AWS::CodeBuild::Project")] | length')" != "1" ]; then
  echo "FAIL: 'cdkd drift --json' does not report the project as not fully compared" >&2
  diag_masked "${DRIFT_JSON}"
  exit 1
fi
# ...and the ARRAY must be reported, masked. Without this, a project reported
# not-compared with no change at all satisfies every check above and below,
# and the path seed this stop exists for would never have masked anything.
FAILPATH_SET=$(printf '%s' "${DRIFT_JSON}" \
  | jq -r '[.[0].drifted[] | select(.type=="AWS::CodeBuild::Project") | .changes[] | "\(.path) \(.awsValue == "***")"] | join(",")')
if [ "${FAILPATH_SET}" != "Environment.EnvironmentVariables true" ]; then
  # Paths and a boolean only -- safe to print.
  echo "FAIL: expected the project's env-var array reported once with a masked AWS side; got: '${FAILPATH_SET}'" >&2
  exit 1
fi
FAILPATH_AWS_LINE=$(grep -F "+ Environment.EnvironmentVariables:" <<< "${FAILPATH_OUT}" || true)
if [ -z "${FAILPATH_AWS_LINE}" ] || ! grep -qF '***' <<< "${FAILPATH_AWS_LINE}"; then
  echo "FAIL: 'cdkd drift' did not report the array's AWS side masked on the resolution-failure path" >&2
  diag_masked "${FAILPATH_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' on the resolution-failure path" "${FAILPATH_OUT}"
assert_no_drift_plaintext "'cdkd drift --json' on the resolution-failure path" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
echo "    OK: with the reference unresolvable, the array is still masked by position"

# Phase 2's premises, re-asserted: this stop must not have given the task
# definition an observed baseline, nor a new revision.
TD_RECORD=$(read_record AWS::ECS::TaskDefinition)
assert_read "the task definition record after phase 1d" "${TD_RECORD}"
if [ "$(printf '%s' "${TD_RECORD}" | jq -r '.observedProperties == null')" != "true" ] \
  || [ "$(printf '%s' "${TD_RECORD}" | jq -r '.physicalId')" != "${P1_PHYSICAL_ID}" ]; then
  echo "FAIL: phase 1d changed the task definition record, so phase 2 would prove nothing" >&2
  exit 1
fi
assert_no_drift_plaintext "the task definition record after phase 1d" "${TD_RECORD}"
echo "    OK: the task definition record is as phase 1 left it"

# --- Phase 2: REDEPLOY UNCHANGED, with the observed capture on --------------
# Nothing in the template changed, so the task definition takes the UNCHANGED
# path: it is never resolved this deploy, its `perResourceSecrets` entry stays
# empty, and the only thing that can redact the freshly-captured readback is the
# PATH pass projecting from the record's own `properties`.
echo "==> Phase 2: redeploy UNCHANGED with the observed capture enabled"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json)
TD_RECORD=$(printf '%s' "${STATE_JSON}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::ECS::TaskDefinition") | .value')

P2_OBSERVED_PRESENT=$(printf '%s' "${TD_RECORD}" | jq -r 'if .observedProperties == null then "absent" else "present" end')
if [ "${P2_OBSERVED_PRESENT}" != "present" ]; then
  echo "FAIL: expected observedProperties to be captured on the unchanged redeploy (got: ${P2_OBSERVED_PRESENT}) — the case under test never ran" >&2
  exit 1
fi
echo "    OK: an observed baseline was captured"

# THE arming guard. Presence of observedProperties alone does NOT distinguish
# the unchanged path from an UPDATE — `kickOffObservedCapture` fires on both,
# and on an UPDATE the secrets map is non-empty so the VALUE scan alone would
# satisfy every assertion below, letting this fixture pass with the keyed
# descent deleted. An ECS task definition update mints a NEW revision, so an
# unchanged physicalId is what actually proves the resource was never
# re-resolved this deploy.
P2_PHYSICAL_ID=$(printf '%s' "${TD_RECORD}" | jq -r '.physicalId')
if [ "${P2_PHYSICAL_ID}" != "${P1_PHYSICAL_ID}" ]; then
  echo "FAIL: the task definition was UPDATED on the redeploy (revision changed), so the resource did not take the unchanged path" >&2
  echo "      phase 1: ${P1_PHYSICAL_ID}" >&2
  echo "      phase 2: ${P2_PHYSICAL_ID}" >&2
  echo "      Every assertion below would pass via the value scan, proving nothing about issue #1915." >&2
  exit 1
fi
echo "    OK: same task definition revision — the resource took the UNCHANGED path"

P2_OBSERVED=$(printf '%s' "${TD_RECORD}" | jq -c '.observedProperties')
# Prove the readback really is the AWS shape rather than a copy of `properties`.
# `Family` is NOT a discriminator — the template sets it, so a copied bag would
# carry it too. `readCurrentStateTaskDefinition` emits `Volumes`,
# `PlacementConstraints` and `Tags` UNCONDITIONALLY, and this template sets none
# of the three, so their presence is only explicable by an actual AWS read.
for member in Volumes PlacementConstraints Tags; do
  if [ "$(printf '%s' "${P2_OBSERVED}" | jq -r --arg m "${member}" 'has($m)')" != "true" ]; then
    echo "FAIL: observedProperties lacks '${member}', which only readCurrentStateTaskDefinition emits — the baseline is not an AWS readback, so the assertions below prove nothing" >&2
    exit 1
  fi
  if [ "$(printf '%s' "${P1_PROPS}" | jq -r --arg m "${member}" 'has($m)')" != "false" ]; then
    echo "FAIL: template properties already carry '${member}', so it cannot discriminate a readback from a copy — pick a different member" >&2
    exit 1
  fi
done
echo "    OK: the baseline carries AWS-only members, so it is a real readback"

# THE assertion this fixture exists for.
P2_OBSERVED_SECRET=$(env_value_of "${P2_OBSERVED}" app DB_PASSWORD)
assert_read "observedProperties ContainerDefinitions[app].Environment[DB_PASSWORD]" "${P2_OBSERVED_SECRET}"
if [ "${P2_OBSERVED_SECRET}" != "${SECRET_EXPR}" ]; then
  echo "FAIL: observedProperties must hold the unresolved expression at the array-nested leaf (issue #1915)." >&2
  echo "      got:  $(mask "${P2_OBSERVED_SECRET}")" >&2
  echo "      want: ${SECRET_EXPR}" >&2
  exit 1
fi
echo "    OK: observedProperties hold the {{resolve:...}} expression at the array-nested leaf"

# Issue #1917 on the SAME-GENERATION observed row, which is the one the value
# scan cannot reach: the secrets map is EMPTY here, so only the record's own
# `properties` can supply the expression for a leaf whose plaintext looks like
# one.
P2_OBSERVED_TOKEN=$(env_value_of "${P2_OBSERVED}" app TOKEN_SHAPED)
assert_read "observedProperties ContainerDefinitions[app].Environment[TOKEN_SHAPED]" "${P2_OBSERVED_TOKEN}"
if [ "${P2_OBSERVED_TOKEN}" != "${TOKEN_EXPR}" ]; then
  echo "FAIL: observedProperties must hold the expression for the token-shaped secret (issue #1917)." >&2
  echo "      got:  $(mask "${P2_OBSERVED_TOKEN}")" >&2
  echo "      want: ${TOKEN_EXPR}" >&2
  exit 1
fi
echo "    OK: the token-shaped secret is redacted in the observed baseline too"

# The other direction: the fix must position ONE leaf, not blanket-redact the
# subtree. A sibling in the same array and a whole other container element both
# have to come through untouched.
P2_MODE=$(env_value_of "${P2_OBSERVED}" app MODE)
P2_ROLE=$(env_value_of "${P2_OBSERVED}" sidecar ROLE)
assert_read "observedProperties ContainerDefinitions[app].Environment[MODE]" "${P2_MODE}"
assert_read "observedProperties ContainerDefinitions[sidecar].Environment[ROLE]" "${P2_ROLE}"
if [ "${P2_MODE}" != "production" ] || [ "${P2_ROLE}" != "sidecar" ]; then
  echo "FAIL: non-secret array siblings were altered (MODE='${P2_MODE}', sidecar ROLE='${P2_ROLE}')" >&2
  exit 1
fi
echo "    OK: non-secret siblings in the same arrays are untouched"

# --- issue #2012: THE ANCHOR-PAIRING ARM ------------------------------------
# Same configuration as everything above -- unchanged resource, empty secrets
# map, baseline projected from the record's own `properties` -- but on an array
# `identityKeyFor` CANNOT key. The only thing that can redact it is
# `unkeyedArrayPairsByAnchors` agreeing that the positions corroborate the
# pairing. Nothing earlier in this fixture reaches that gate.
P2_ANCHOR_CMD=$(cd_field_of "${P2_OBSERVED}" anchorprobe Command)
assert_read "observedProperties ContainerDefinitions[anchorprobe].Command" "${P2_ANCHOR_CMD}"
assert_unkeyed_string_array "observedProperties anchorprobe Command" "${P2_ANCHOR_CMD}" 3
# Rules 1 and 2 first: AWS returned both anchor positions unchanged. Asserted
# BEFORE the verdict, so a refusal caused by AWS normalising a flag is reported
# as that rather than as a redaction defect.
if [ "$(json_index "${P2_ANCHOR_CMD}" 0)" != "-c" ] \
  || [ "$(json_index "${P2_ANCHOR_CMD}" 2)" != "-v" ]; then
  echo "FAIL: the readback's Command anchors are not what the source spells, so the gate had no evidence to pair on" >&2
  exit 1
fi
# THE POSITIVE MARKER. "No plaintext in state" is satisfied by any unrelated
# failure that stopped short; the EXPRESSION at index 1 is the only thing the
# anchor arm can produce, so it is what gets asserted.
P2_ANCHOR_CMD_1=$(json_index "${P2_ANCHOR_CMD}" 1)
assert_read "observedProperties anchorprobe Command[1]" "${P2_ANCHOR_CMD_1}"
if [ "${P2_ANCHOR_CMD_1}" != "${ANCHOR_PW_EXPR}" ]; then
  echo "FAIL: observedProperties must hold the expression at the UNKEYED array position (issue #2012)." >&2
  echo "      got:  $(mask "${P2_ANCHOR_CMD_1}")" >&2
  echo "      want: ${ANCHOR_PW_EXPR}" >&2
  exit 1
fi
echo "    OK: the anchor gate PAIRED the unkeyed Command array and persisted the expression"

# THE NEGATIVE CONTROL. Same shape, same empty map, same intact anchors -- but
# the two reference-bearing elements are indistinguishable to `anchorSignature`
# (both bare references, behind an identical `-p`), so rule 3 must refuse the
# whole array -- and, since issue #2852, a refused position FAILS CLOSED to
# the literal mask. Without this, a gate that paired EVERYTHING would satisfy
# every assertion above.
P2_ANCHOR_EP=$(cd_field_of "${P2_OBSERVED}" anchorprobe EntryPoint)
assert_read "observedProperties ContainerDefinitions[anchorprobe].EntryPoint" "${P2_ANCHOR_EP}"
assert_unkeyed_string_array "observedProperties anchorprobe EntryPoint" "${P2_ANCHOR_EP}" 4
if [ "$(json_index "${P2_ANCHOR_EP}" 0)" != "-p" ] \
  || [ "$(json_index "${P2_ANCHOR_EP}" 2)" != "-p" ]; then
  echo "FAIL: the negative control's anchors were rewritten, so its refusal would not be attributable to rule 3" >&2
  exit 1
fi
P2_EP_1=$(json_index "${P2_ANCHOR_EP}" 1)
P2_EP_3=$(json_index "${P2_ANCHOR_EP}" 3)
assert_read "observedProperties anchorprobe EntryPoint[1]" "${P2_EP_1}"
assert_read "observedProperties anchorprobe EntryPoint[3]" "${P2_EP_3}"
# The literal mask keeps this control's DISCRIMINATING power -- all three
# outcomes stay distinguishable: the raw plaintext is the pre-#2852 leak, the
# EXPRESSION is a pair-everything mutation (the swap / fabrication class rule
# 3 exists for), and '***' alone is the fail-closed refusal #2852 decided a
# refused baseline position takes.
if [ "${P2_EP_1}" != "***" ] || [ "${P2_EP_3}" != "***" ]; then
  echo "FAIL: a refused indistinguishable position must FAIL CLOSED to the literal mask (issue #2012 rule 3 disposition per issue #2852)." >&2
  echo "      plaintext here is the old leak; the EXPRESSION here is a pair-everything mutation; only '***' is correct." >&2
  echo "      got[1]: $(mask "${P2_EP_1}")  got[3]: $(mask "${P2_EP_3}")" >&2
  exit 1
fi
echo "    OK: the anchor gate REFUSED the indistinguishable array and FAILED CLOSED to the mask"

# Scoped to the consumer's record for the reason phase 1 gives.
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: the resolved secret plaintext is present in the task definition record after the unchanged redeploy (issue #1915)" >&2
  exit 1
fi
if printf '%s' "${TD_RECORD}" | grep -qF "cdkd-decoy-never-created"; then
  echo "FAIL: the token-shaped secret plaintext is present in the task definition record after the unchanged redeploy (issue #1917)" >&2
  exit 1
fi
# ALL THREE anchor-arm plaintexts must be absent. Until issue #2852 the
# negative control's two values were deliberately still in this record (its
# refusal left the readback in place); the refused position now FAILS CLOSED
# to the mask, so their absence is the stronger assertion. Read these as a
# PAIR with the positive markers above: "no plaintext" on its own is also
# satisfied by an arm that never ran.
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_ANCHOR_PW}"; then
  echo "FAIL: the anchor-paired plaintext is present in the task definition record after the unchanged redeploy (issue #2012)" >&2
  exit 1
fi
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_AMBIG_ALPHA}" \
  || printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_AMBIG_BRAVO}"; then
  echo "FAIL: a refused indistinguishable position persisted its decrypted readback -- the issue #2852 fail-closed contract is broken" >&2
  exit 1
fi
echo "    OK: no resolved plaintext in the consumer record after phase 2"
# The drift arm's consumer took the same unchanged-path capture.
PROJECT_RECORD=$(read_record AWS::CodeBuild::Project)
assert_read "the CodeBuild project record after phase 2" "${PROJECT_RECORD}"
assert_no_drift_plaintext "the CodeBuild project record after phase 2" "${PROJECT_RECORD}"

# A redaction that stores the wrong thing shows up as a diff that never
# converges, so the stack must still read clean right after its own deploy.
echo "==> Asserting the redacted state still diffs clean"
# Captured rather than run bare: under `set -e` a bare invocation aborts with no
# output at all, and "the diff was not clean" without the diff itself is the
# least actionable failure this script can produce.
DIFF_RC=0
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --fail 2>&1) || DIFF_RC=$?
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' reported a change after redaction (rc=${DIFF_RC})." >&2
  echo "      A redaction that stores the WRONG expression shows up exactly here." >&2
  # Masked: a diff of a secret-bearing resource can echo a resolved value.
  # Both fixture values are masked. The decoy is not a credential, but a dump
  # that masks one secret-shaped string and not the other invites the next
  # editor to add a third and mask none.
  printf '%s\n' "${DIFF_OUT}" \
    | sed -e "s|${EXPECTED_PASSWORD}|***|g" -e "s|${EXPECTED_TOKEN_SHAPED}|***|g" >&2
  exit 1
fi
echo "    OK: no spurious change after redaction"

# --- Phase 2d: `cdkd drift` over the MASKED observed baseline (#1947, #3595) --
# The task definition's baseline now holds `***` at the anchor arm's refused
# EntryPoint positions (asserted above), which no live value equals. That is
# an UNKNOWN position, not drift (issue #3595): the mask is the only difference
# there, so the resource is listed under `notCompared` with the cause
# `uncertifiedBaseline`, nothing is drifted, and a detection-only run exits 2
# -- exactly 2: 0 would mean the comparison never reached the mask, 1 that it
# was still called drift. Both remediation modes then leave it alone.
echo "==> Phase 2d: cdkd drift over the masked observed baseline (issues #1947 / #3595)"
TD_LOGICAL_ID=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json \
  | jq -r '[.state.resources | to_entries[] | select(.value.resourceType=="AWS::ECS::TaskDefinition") | .key] | (.[0] // empty)')
assert_read "the task definition's logical id" "${TD_LOGICAL_ID}"

run_drift
if [ "${DRIFT_RC}" -ne 2 ]; then
  echo "FAIL: 'cdkd drift' over the masked baseline exited ${DRIFT_RC}, expected 2 (not compared, nothing drifted)" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' over the masked baseline" "${DRIFT_OUT}"
run_drift_json
TD_CAUSE=$(printf '%s' "${DRIFT_JSON}" | jq -r --arg id "${TD_LOGICAL_ID}" \
  '[.[0].notCompared[] | select(.logicalId==$id) | .cause] | join(",")')
DRIFTED_COUNT=$(printf '%s' "${DRIFT_JSON}" | jq -r '.[0].drifted | length')
if [ "${TD_CAUSE}" != "uncertifiedBaseline" ] || [ "${DRIFTED_COUNT}" != "0" ]; then
  # A cause name and a count -- safe to print.
  echo "FAIL: expected the task definition not-compared as 'uncertifiedBaseline' and nothing drifted; got cause '${TD_CAUSE}', ${DRIFTED_COUNT} drifted" >&2
  exit 1
fi
echo "    OK: the masked positions are reported not compared (uncertifiedBaseline), nothing drifted"
assert_no_drift_plaintext "'cdkd drift --json' over the masked baseline" "${DRIFT_JSON}${DRIFT_JSON_ERR}"

# The two plans, over a stack with nothing drifted. Both exit 0 whatever they
# print, so an early failure is the only thing rc can reveal.
for plan_mode in --accept --revert; do
  run_drift "${plan_mode}" --dry-run
  if [ "${DRIFT_RC}" -ne 0 ]; then
    echo "FAIL: 'cdkd drift ${plan_mode} --dry-run' failed over the masked baseline (rc=${DRIFT_RC})" >&2
    diag_masked "${DRIFT_OUT}"
    exit 1
  fi
  assert_no_drift_plaintext "'cdkd drift ${plan_mode} --dry-run' over the masked baseline" "${DRIFT_OUT}"
done

# --accept must leave the record EXACTLY as it was: a not-compared position is
# never written, and a rewrite through the fail-closed redaction would put the
# same `***` back, so the evidence is the whole observed bag, byte for byte.
TD_OBSERVED_BEFORE=$(read_record AWS::ECS::TaskDefinition | jq -cS '.observedProperties')
assert_read "the task definition's observed baseline before --accept" "${TD_OBSERVED_BEFORE}"
run_drift --accept --yes
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed over the masked baseline (rc=${DRIFT_RC})" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --accept' over the masked baseline" "${DRIFT_OUT}"
TD_RECORD=$(read_record AWS::ECS::TaskDefinition)
assert_read "the task definition record after --accept" "${TD_RECORD}"
assert_no_drift_plaintext "the task definition record after --accept" "${TD_RECORD}"
PROJECT_RECORD=$(read_record AWS::CodeBuild::Project)
assert_read "the CodeBuild project record after --accept" "${PROJECT_RECORD}"
assert_no_drift_plaintext "the CodeBuild project record after --accept" "${PROJECT_RECORD}"
if [ "$(printf '%s' "${TD_RECORD}" | jq -cS '.observedProperties')" != "${TD_OBSERVED_BEFORE}" ]; then
  echo "FAIL: --accept rewrote the task definition's observed baseline over a not-compared position" >&2
  exit 1
fi
P2D_OBSERVED=$(printf '%s' "${TD_RECORD}" | jq -c '.observedProperties')
P2D_EP=$(cd_field_of "${P2D_OBSERVED}" anchorprobe EntryPoint)
assert_read "observedProperties anchorprobe EntryPoint after --accept" "${P2D_EP}"
if [ "$(json_index "${P2D_EP}" 1)" != "***" ] || [ "$(json_index "${P2D_EP}" 3)" != "***" ] \
  || [ "$(json_index "$(cd_field_of "${P2D_OBSERVED}" anchorprobe Command)" 1)" != "${ANCHOR_PW_EXPR}" ] \
  || [ "$(env_value_of "${P2D_OBSERVED}" app DB_PASSWORD)" != "${SECRET_EXPR}" ]; then
  echo "FAIL: --accept rewrote the masked observed baseline instead of leaving it as it was" >&2
  exit 1
fi
echo "    OK: --accept left the mask, the paired expression and the keyed expression in place"

# --- Phase 2r: a NO_CHANGE redeploy re-captures the masked baseline (#3595) --
# Issue #3595 item (1). The deploy-start auto-refresh re-captures a baseline
# holding a #2852 fail-closed mask, resolving the record's OWN references for
# that record alone, and replaces a mask only where that resolution certifies
# the position. The two masked EntryPoint positions are split to opposite
# verdicts first: `ambigBravo` is ROTATED out of band, so the registered
# revision still holds the old value while the reference now resolves to the
# new one -- nothing can certify [3], and it must stay masked. [1]
# (`ambigAlpha`) is certifiable and must come back as its EXPRESSION. Every
# other byte of the observed bag must be unchanged: the re-capture repairs
# masks, it does not re-take the baseline. SecretString is a drift-unknown path
# of the secret's own provider, so the rotation adds no drift of its own.
echo "==> Phase 2r: rotate ambigBravo, redeploy UNCHANGED, re-capture the masked baseline (issue #3595)"
ROTATED_AMBIG_BRAVO="cdkd-anchor-ambiguous-bravo-rotated-745"
DRIFT_NEEDLES+=("${ROTATED_AMBIG_BRAVO}")
P2R_BEFORE=$(read_record AWS::ECS::TaskDefinition | jq -cS '.observedProperties')
assert_read "the task definition's observed baseline before the re-capture" "${P2R_BEFORE}"
P2R_BEFORE_EP=$(cd_field_of "${P2R_BEFORE}" anchorprobe EntryPoint)
if [ "$(json_index "${P2R_BEFORE_EP}" 1)" != "***" ] || [ "$(json_index "${P2R_BEFORE_EP}" 3)" != "***" ]; then
  echo "FAIL: premise: both refused EntryPoint positions must be masked before the re-capture, or it has nothing to repair" >&2
  exit 1
fi
ROT_ORIG_SECRET=$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query SecretString --output text)
assert_read "the fixture secret's SecretString before the rotation" "${ROT_ORIG_SECRET}"
ROT_NEW_SECRET=$(printf '%s' "${ROT_ORIG_SECRET}" | jq -c --arg v "${ROTATED_AMBIG_BRAVO}" '.ambigBravo = $v')
# Through a 0600 file, not argv, for the reason `put_secret_string` gives.
SECRET_VALUE_FILE=$(umask 077 && mktemp)
put_secret_string "${ROT_NEW_SECRET}"
rm -f "${SECRET_VALUE_FILE}"
# Polled, for the reason `wait_secret_has_drift_pw` gives.
rotated=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" --region "${REGION}" \
      --query SecretString --output text | jq -r '.ambigBravo // empty')" = "${ROTATED_AMBIG_BRAVO}" ]; then
    rotated=1
    break
  fi
  sleep 3
done
if [ "${rotated}" -ne 1 ]; then
  echo "FAIL: the fixture secret never reported the rotated ambigBravo" >&2
  exit 1
fi
echo "    OK: ambigBravo rotated out of band; the registered revision still holds the old value"

# --verbose, captured: the re-capture's own log lines are debug lines, and the
# resolution it runs holds every plaintext this fixture seeds.
redeploy_verbose() { # -> P2R_DEPLOY_OUT; a failed deploy prints masked and exits
  local rc=0
  P2R_DEPLOY_OUT=$(node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --verbose --yes 2>&1) || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: the NO_CHANGE redeploy failed (rc=${rc})" >&2
    diag_masked "${P2R_DEPLOY_OUT}"
    exit 1
  fi
}
redeploy_verbose
assert_no_drift_plaintext "the re-capturing deploy's --verbose output" "${P2R_DEPLOY_OUT}"
TD_RECORD=$(read_record AWS::ECS::TaskDefinition)
assert_read "the task definition record after the re-capture" "${TD_RECORD}"
# The arming guard phase 2 uses: an UPDATE would re-capture with a populated
# map by the ordinary route and prove nothing about the re-capture.
if [ "$(printf '%s' "${TD_RECORD}" | jq -r '.physicalId')" != "${P1_PHYSICAL_ID}" ]; then
  echo "FAIL: the task definition was UPDATED on the redeploy, so the re-capture was not what rewrote its baseline" >&2
  exit 1
fi
P2R_OBSERVED=$(printf '%s' "${TD_RECORD}" | jq -c '.observedProperties')
P2R_EP=$(cd_field_of "${P2R_OBSERVED}" anchorprobe EntryPoint)
assert_read "observedProperties anchorprobe EntryPoint after the re-capture" "${P2R_EP}"
assert_unkeyed_string_array "observedProperties anchorprobe EntryPoint after the re-capture" "${P2R_EP}" 4
P2R_EP_1=$(json_index "${P2R_EP}" 1)
P2R_EP_3=$(json_index "${P2R_EP}" 3)
# THE assertion item (1) exists for: a NO_CHANGE deploy cleared a mask.
if [ "${P2R_EP_1}" != "${AMBIG_ALPHA_EXPR}" ]; then
  echo "FAIL: a NO_CHANGE redeploy must re-capture the certifiable masked position as its expression (issue #3595)." >&2
  echo "      got:  $(mask "${P2R_EP_1}")" >&2
  echo "      want: ${AMBIG_ALPHA_EXPR}" >&2
  exit 1
fi
echo "    OK: the certifiable masked position was re-captured as its expression"
# ...and the rotated one kept its mask: neither value is the one the reference
# resolves to AND the one AWS holds, so no position can be certified.
if [ "${P2R_EP_3}" != "***" ]; then
  echo "FAIL: the rotated position must stay masked after the re-capture: got $(mask "${P2R_EP_3}")" >&2
  exit 1
fi
echo "    OK: the uncertifiable (rotated) position stayed masked"
# Only [1] moved. Put the mask back there and the bag must be the one phase 2
# captured, byte for byte.
P2R_RESTORED=$(printf '%s' "${P2R_OBSERVED}" \
  | jq -cS '(.ContainerDefinitions[] | select(.Name=="anchorprobe") | .EntryPoint[1]) |= "***"')
if [ "${P2R_RESTORED}" != "${P2R_BEFORE}" ]; then
  echo "FAIL: the re-capture changed the observed baseline outside the masked position it certified" >&2
  exit 1
fi
echo "    OK: nothing else in the observed baseline changed"
assert_no_drift_plaintext "the task definition record after the re-capture" "${TD_RECORD}"

# The position that stays uncertifiable still reads as not compared (#3609).
run_drift
if [ "${DRIFT_RC}" -ne 2 ]; then
  echo "FAIL: 'cdkd drift' after the re-capture exited ${DRIFT_RC}, expected 2 (the rotated position is still not compared)" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' after the re-capture" "${DRIFT_OUT}"
run_drift_json
P2R_CAUSE=$(printf '%s' "${DRIFT_JSON}" | jq -r --arg id "${TD_LOGICAL_ID}" \
  '[.[0].notCompared[] | select(.logicalId==$id) | .cause] | join(",")')
P2R_DRIFTED=$(printf '%s' "${DRIFT_JSON}" | jq -r '.[0].drifted | length')
if [ "${P2R_CAUSE}" != "uncertifiedBaseline" ] || [ "${P2R_DRIFTED}" != "0" ]; then
  echo "FAIL: expected the task definition still not compared as 'uncertifiedBaseline' and nothing drifted; got cause '${P2R_CAUSE}', ${P2R_DRIFTED} drifted" >&2
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --json' after the re-capture" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
echo "    OK: the remaining masked position is still reported not compared (uncertifiedBaseline)"

# A second NO_CHANGE redeploy, still rotated, has nothing more to certify and
# leaves the bag as it is. Not vacuous: the fresh readback masks BOTH positions
# while the baseline now holds [1]'s expression, and the re-capture must read
# that as the baseline it wrote rather than refuse or rewrite it.
redeploy_verbose
assert_no_drift_plaintext "the second NO_CHANGE deploy's --verbose output" "${P2R_DEPLOY_OUT}"
if [ "$(read_record AWS::ECS::TaskDefinition | jq -cS '.observedProperties')" \
  != "$(printf '%s' "${P2R_OBSERVED}" | jq -cS '.')" ]; then
  echo "FAIL: a second NO_CHANGE redeploy changed the re-captured baseline" >&2
  exit 1
fi
echo "    OK: a second NO_CHANGE redeploy left the re-captured baseline as it was"

# Rotate ambigBravo BACK: the registered value is certifiable again, so the next
# NO_CHANGE deploy clears the last mask -- on top of the baseline the first
# re-capture wrote -- and the resource then reads clean.
SECRET_VALUE_FILE=$(umask 077 && mktemp)
put_secret_string "${ROT_ORIG_SECRET}"
rm -f "${SECRET_VALUE_FILE}"
# Both variables hold every key's plaintext; drop them once they are written, so
# no later diagnostic can print them.
unset ROT_ORIG_SECRET ROT_NEW_SECRET
restored=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if [ "$(aws secretsmanager get-secret-value --secret-id "${SECRET_NAME}" --region "${REGION}" \
      --query SecretString --output text | jq -r '.ambigBravo // empty')" = "${EXPECTED_AMBIG_BRAVO}" ]; then
    restored=1
    break
  fi
  sleep 3
done
if [ "${restored}" -ne 1 ]; then
  echo "FAIL: the fixture secret never reported ambigBravo rotated back" >&2
  exit 1
fi
redeploy_verbose
assert_no_drift_plaintext "the third NO_CHANGE deploy's --verbose output" "${P2R_DEPLOY_OUT}"
TD_RECORD=$(read_record AWS::ECS::TaskDefinition)
assert_read "the task definition record after the rotate-back re-capture" "${TD_RECORD}"
if [ "$(printf '%s' "${TD_RECORD}" | jq -r '.physicalId')" != "${P1_PHYSICAL_ID}" ]; then
  echo "FAIL: the task definition was UPDATED on the rotate-back redeploy" >&2
  exit 1
fi
P2R_FINAL_EP=$(cd_field_of "$(printf '%s' "${TD_RECORD}" | jq -c '.observedProperties')" anchorprobe EntryPoint)
assert_read "observedProperties anchorprobe EntryPoint after the rotate-back re-capture" "${P2R_FINAL_EP}"
if [ "$(json_index "${P2R_FINAL_EP}" 1)" != "${AMBIG_ALPHA_EXPR}" ] \
  || [ "$(json_index "${P2R_FINAL_EP}" 3)" != "${AMBIG_BRAVO_EXPR}" ]; then
  echo "FAIL: after ambigBravo was rotated back, a NO_CHANGE redeploy must clear the last mask too" >&2
  echo "      got[1]: $(mask "$(json_index "${P2R_FINAL_EP}" 1)")  got[3]: $(mask "$(json_index "${P2R_FINAL_EP}" 3)")" >&2
  exit 1
fi
assert_no_drift_plaintext "the task definition record after the rotate-back re-capture" "${TD_RECORD}"
echo "    OK: the last masked position was re-captured once it became certifiable"
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' after the last mask cleared exited ${DRIFT_RC}, expected 0" >&2
  diag_masked "${DRIFT_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift' after the last mask cleared" "${DRIFT_OUT}"
run_drift_json
if [ "$(printf '%s' "${DRIFT_JSON}" | jq -r --arg id "${TD_LOGICAL_ID}" '[.[0].clean[] | select(.logicalId==$id)] | length')" != "1" ]; then
  echo "FAIL: the task definition is not reported compared-and-matched once its baseline holds no mask" >&2
  diag_masked "${DRIFT_JSON}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd drift --json' after the last mask cleared" "${DRIFT_JSON}${DRIFT_JSON_ERR}"
echo "    OK: the task definition now reads compared-and-matched"

# `cdkd state refresh-observed` resolves nothing, so it takes the empty-map
# capture and rule 3 masks BOTH positions again (the docs say so) -- and the
# next NO_CHANGE deploy re-captures them from there.
P2R_REFRESH_RC=0
P2R_REFRESH_OUT=$(node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1) || P2R_REFRESH_RC=$?
if [ "${P2R_REFRESH_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd state refresh-observed' failed (rc=${P2R_REFRESH_RC})" >&2
  diag_masked "${P2R_REFRESH_OUT}"
  exit 1
fi
assert_no_drift_plaintext "'cdkd state refresh-observed' output" "${P2R_REFRESH_OUT}"
P2R_REFRESH_EP=$(cd_field_of "$(read_record AWS::ECS::TaskDefinition | jq -c '.observedProperties')" anchorprobe EntryPoint)
assert_read "observedProperties anchorprobe EntryPoint after refresh-observed" "${P2R_REFRESH_EP}"
if [ "$(json_index "${P2R_REFRESH_EP}" 1)" != "***" ] || [ "$(json_index "${P2R_REFRESH_EP}" 3)" != "***" ]; then
  echo "FAIL: 'cdkd state refresh-observed' must write both refused positions back as the mask (rule 3, empty map)" >&2
  echo "      got[1]: $(mask "$(json_index "${P2R_REFRESH_EP}" 1)")  got[3]: $(mask "$(json_index "${P2R_REFRESH_EP}" 3)")" >&2
  exit 1
fi
echo "    OK: refresh-observed wrote the masks back"
redeploy_verbose
assert_no_drift_plaintext "the post-refresh NO_CHANGE deploy's --verbose output" "${P2R_DEPLOY_OUT}"
if [ "$(read_record AWS::ECS::TaskDefinition | jq -r '.physicalId')" != "${P1_PHYSICAL_ID}" ]; then
  echo "FAIL: the task definition was UPDATED on the post-refresh redeploy, so the re-capture was not what rewrote its baseline" >&2
  exit 1
fi
P2R_AGAIN_EP=$(cd_field_of "$(read_record AWS::ECS::TaskDefinition | jq -c '.observedProperties')" anchorprobe EntryPoint)
if [ "$(json_index "${P2R_AGAIN_EP}" 1)" != "${AMBIG_ALPHA_EXPR}" ] \
  || [ "$(json_index "${P2R_AGAIN_EP}" 3)" != "${AMBIG_BRAVO_EXPR}" ]; then
  echo "FAIL: the NO_CHANGE deploy after refresh-observed must re-capture both positions" >&2
  exit 1
fi
assert_no_drift_plaintext "the task definition record after the post-refresh re-capture" "$(read_record AWS::ECS::TaskDefinition)"
echo "    OK: the next NO_CHANGE deploy re-captured both positions"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# A deregistered task definition is never "not found" — AWS keeps the revision
# forever as INACTIVE — so the gone-probe form does not apply and the real
# assertion is that the family has no ACTIVE revision left. Plain strict
# capture, so a throttled or unauthorized call fails the run instead of reading
# as "clean".
# Polled: ECS list-task-definitions is eventually consistent after a
# deregister, so a single read can report a revision that is already gone. A
# single probe would make this assertion flaky in the direction that FAILS a
# good destroy. Each read is a plain strict capture, so a throttled or
# unauthorized call still aborts the run rather than reading as clean.
ACTIVE_TDS=""
for _ in 1 2 3 4 5 6 7 8 9 10; do
  ACTIVE_TDS=$(aws ecs list-task-definitions --family-prefix "${FAMILY}" --status ACTIVE \
    --region "${REGION}" --query 'length(taskDefinitionArns)' --output text)
  [ "${ACTIVE_TDS}" = "0" ] && break
  sleep 3
done
if [ "${ACTIVE_TDS}" != "0" ]; then
  echo "FAIL: ${ACTIVE_TDS} ACTIVE revision(s) of task definition family '${FAMILY}' remain after destroy" >&2
  exit 1
fi
echo "    OK: no ACTIVE task definition revision remains"

# The drift arm's project and role. `batch-get-projects` SUCCEEDS for a
# missing name (it lists it under `projectsNotFound`), so it is not a
# gone-probe: the assertion is a strict count of what it found.
DRIFT_PROJECTS_LEFT=$(aws codebuild batch-get-projects --names "${DRIFT_PROJECT}" \
  --region "${REGION}" --query 'length(projects)' --output text)
if [ "${DRIFT_PROJECTS_LEFT}" != "0" ]; then
  echo "FAIL: CodeBuild project '${DRIFT_PROJECT}' still exists after destroy" >&2
  exit 1
fi
assert_gone "IAM role ${DRIFT_ROLE} still exists after destroy" aws iam get-role --role-name "${DRIFT_ROLE}"
echo "    OK: the drift arm's project and role are gone"

# SecretsManager DeleteSecret SCHEDULES deletion with a recovery window by
# default, and cdkd matches CloudFormation rather than force-deleting. So
# "scheduled for deletion" (DeletedDate set) is a PASS; only a still-ACTIVE
# secret with no DeletedDate is a real failure.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
  SECRET_DELETED_DATE="GONE"
elif ! SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
    --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
  # TOCTOU: the secret can vanish between gone_probe and this requery.
  printf '%s' "${SECRET_DELETED_DATE}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' \
    && SECRET_DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED_DATE}" >&2; exit 1; }
fi
if [ "${SECRET_DELETED_DATE}" = "GONE" ]; then
  echo "    OK: secret is gone"
elif [ -n "${SECRET_DELETED_DATE}" ] && [ "${SECRET_DELETED_DATE}" != "None" ]; then
  echo "    OK: secret is scheduled for deletion (DeletedDate=${SECRET_DELETED_DATE})"
else
  echo "FAIL: secret '${SECRET_NAME}' still ACTIVE after destroy (no DeletedDate set)" >&2
  exit 1
fi

# The token-shaped secret is NOT in the stack (this script created it), so
# destroy must have left it alone — deleting a resource cdkd does not manage
# would be the real failure here. Then remove it ourselves and prove it is gone,
# so the run ends with no orphan (the cleanup trap is a backstop, not the proof).
if gone_probe aws secretsmanager describe-secret --secret-id "${TOKEN_SECRET_NAME}" --region "${REGION}"; then
  echo "FAIL: destroy deleted the out-of-band secret '${TOKEN_SECRET_NAME}' — cdkd must not touch a resource it does not manage" >&2
  exit 1
fi
# NOT routed through `assert_read`, and deliberately: here an EMPTY selection
# is the PASS condition (`DeletedDate` is absent on a secret that is not
# scheduled for deletion), so the helper would invert the assertion. The cost is
# that a typo in this one query is silent — it would read as "not scheduled",
# which is what the next two lines treat as success. Change it only with that in
# mind.
TOKEN_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${TOKEN_SECRET_NAME}" \
  --region "${REGION}" --query 'DeletedDate' --output text)
if [ -n "${TOKEN_DELETED_DATE}" ] && [ "${TOKEN_DELETED_DATE}" != "None" ]; then
  echo "FAIL: destroy scheduled the out-of-band secret '${TOKEN_SECRET_NAME}' for deletion (DeletedDate=${TOKEN_DELETED_DATE})" >&2
  exit 1
fi
echo "    OK: destroy left the unmanaged token-shaped secret intact"
aws secretsmanager delete-secret --secret-id "${TOKEN_SECRET_NAME}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null
# POLLED: `--force-delete-without-recovery` is asynchronous, so a single probe
# right after it fails in the direction that FAILS a correct teardown.
token_gone=0
for _ in 1 2 3 4 5 6 7 8 9 10; do
  if gone_probe aws secretsmanager describe-secret --secret-id "${TOKEN_SECRET_NAME}" --region "${REGION}"; then
    token_gone=1
    break
  fi
  sleep 3
done
if [ "${token_gone}" -ne 1 ]; then
  echo "FAIL: out-of-band secret '${TOKEN_SECRET_NAME}' still exists after its explicit delete" >&2
  exit 1
fi
echo "    OK: out-of-band token-shaped secret is gone"

assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object only looks at the CURRENT object; the bucket is VERSIONED, so
# this fixture was green for months while its seeded password stayed readable
# in every prior version (issue #2096). The sweep runs HERE, on the normal
# path, not only in `cleanup` -- a trap-only sweep never runs on a run that
# disarms its trap, and asserting nothing is how this regressed silently.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secrets-array-nested state teardown"

echo "[verify] PASS — an array-nested secret is redacted in observedProperties on the UNCHANGED-resource path (issue #1915), a token-shaped secret plaintext is redacted on both the template-sourced and same-generation rows (issue #1917), an UNKEYED array is redacted by ANCHOR PAIRING while its indistinguishable twin is refused and FAILS CLOSED to the mask (issues #2012 / #2852), non-secret siblings untouched, cdkd drift on the array shape is clean when fresh, masks a drifted array, refuses to --accept it and --reverts it RESOLVED, and reports a masked baseline position as not compared and leaks nothing over it (issues #1947 / #3595), a NO_CHANGE redeploy re-captures a certifiable masked position and keeps a rotated one masked (issue #3595), clean destroy"
