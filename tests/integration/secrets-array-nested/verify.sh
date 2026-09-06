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
#     Indices 1 and 3 must be left holding exactly what AWS reported.
#
# Without that second array, a gate that paired EVERYTHING would satisfy every
# positive assertion here. Its refused indices therefore keep a resolved
# plaintext in the observed baseline ON PURPOSE -- that is the documented
# residual behaviour, and the S3 VERSION sweep at the end is what bounds how
# long those bytes live in the bucket.
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
# carries no observed baseline at all, so even the negative control -- whose
# values legitimately survive in phase 2 -- must be absent here. grep -qF and
# no echo of the needle, like the two above.
for anchor_needle in "${EXPECTED_ANCHOR_PW}" "${EXPECTED_AMBIG_ALPHA}" "${EXPECTED_AMBIG_BRAVO}"; do
  if printf '%s' "${TD_RECORD}" | grep -qF "${anchor_needle}"; then
    echo "FAIL: an anchor-arm plaintext is present in the task definition record after phase 1 (issue #2012)" >&2
    exit 1
  fi
done
echo "    OK: no resolved plaintext in the consumer record after phase 1"

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
# whole array and leave AWS's own values in place. Without this, a gate that
# paired EVERYTHING would satisfy every assertion above.
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
if [ "${P2_EP_1}" != "${EXPECTED_AMBIG_ALPHA}" ] || [ "${P2_EP_3}" != "${EXPECTED_AMBIG_BRAVO}" ]; then
  echo "FAIL: the anchor gate must REFUSE an array whose reference-bearing elements are indistinguishable (issue #2012, rule 3)." >&2
  echo "      Each position has to be left exactly as AWS reported it." >&2
  echo "      got[1]: $(mask "${P2_EP_1}")  got[3]: $(mask "${P2_EP_3}")" >&2
  exit 1
fi
echo "    OK: the anchor gate REFUSED the indistinguishable array and left the readback untouched"

# Scoped to the consumer's record for the reason phase 1 gives.
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_PASSWORD}"; then
  echo "FAIL: the resolved secret plaintext is present in the task definition record after the unchanged redeploy (issue #1915)" >&2
  exit 1
fi
if printf '%s' "${TD_RECORD}" | grep -qF "cdkd-decoy-never-created"; then
  echo "FAIL: the token-shaped secret plaintext is present in the task definition record after the unchanged redeploy (issue #1917)" >&2
  exit 1
fi
# ONLY the PAIRED arm's plaintext. The negative control's two values are
# deliberately still in this record -- that IS its assertion, above -- so
# grepping for them here would contradict it. Read this line as a PAIR with
# the positive marker above: "no plaintext" on its own is also satisfied by an
# arm that never ran.
if printf '%s' "${TD_RECORD}" | grep -qF "${EXPECTED_ANCHOR_PW}"; then
  echo "FAIL: the anchor-paired plaintext is present in the task definition record after the unchanged redeploy (issue #2012)" >&2
  exit 1
fi
echo "    OK: no resolved plaintext in the consumer record after phase 2"

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

echo "[verify] PASS — an array-nested secret is redacted in observedProperties on the UNCHANGED-resource path (issue #1915), a token-shaped secret plaintext is redacted on both the template-sourced and same-generation rows (issue #1917), an UNKEYED array is redacted by ANCHOR PAIRING while its indistinguishable twin is refused (issue #2012), non-secret siblings untouched, clean destroy"
