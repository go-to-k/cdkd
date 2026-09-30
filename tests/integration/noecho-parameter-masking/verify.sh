#!/usr/bin/env bash
# verify.sh - cdkd NoEcho template parameter masking integ (issue #1998).
#
# A `Ref` or `Fn::Sub` variable serving a `NoEcho: true` template PARAMETER
# records the value as a LOG-ONLY needle: the deploy's provider, error, event
# and resolver surfaces mask it (the resolver's --verbose lines, the provider's
# masker, the engine's error text, the deployments/*.jsonl events), and what
# cdkd PERSISTS is unchanged except for an export alias. So do the diff's
# `requires replacement` line and `cdkd diff`'s own rendering, human and --json
# (go-to-k/cdkd#4049), and so are the PIECES of an `Fn::Split` over a NoEcho
# value (#4049's coverage-edges row). An `Export.Name` holding a NoEcho value,
# or a split piece of one, is REFUSED (go-to-k/cdkd#4043): nothing is published
# to state or the exports index.
#
# Phases:
#   1. Deploy with --verbose. The resolver's `Resolved Fn::Sub: token=...` line
#      prints the value masked, AWS holds the REAL value, and state.json holds
#      it in the clear -- the persistence half of the #1998 decision, asserted
#      so a change to it is a visible decision, not a silent one.
#      NoEchoAliasProbe's Export.Name IS a second NoEcho value: the alias is
#      refused with a masked warning, and neither state.json, its exportNames
#      nor the exports index holds it (#4043).
#      NoEchoSplitConsumer reads the second piece of an Fn::Split over a third
#      NoEcho value: the `Resolved Fn::Split` line prints neither piece, AWS
#      and state.json hold the piece, and NoEchoSplitAliasProbe's Export.Name,
#      the first piece, is refused (#4049). The nested SplitChild receives
#      the same value as its CommaDelimitedList ListIn: its `Resolved Ref to
#      parameter: ListIn` line prints neither element, and AWS and its own
#      state.json hold the first. No later phase prints a piece.
#   2. A probe deploy adding `NoEchoReject`, whose `Tier` IS the value. SSM's
#      ValidationException quotes the value back; the deploy fails, and
#      neither its output nor any deployments/*.jsonl object carries it.
#   3a. `cdkd diff --verbose` and `cdkd diff --json --fail` with
#      CDKD_TEST_NOECHO_RENAME=true, before the redeploy that applies it:
#      NoEchoRenamed's TopicName row prints its new side masked and its old
#      side withheld, human and --json, and so does the diff's own
#      `requires replacement` line; the exit codes are unchanged (0, and 1
#      under --fail). Nothing in either output carries the value, and the
#      refused alias is not previewed as an added export (#4043).
#   3. Redeploy with CDKD_TEST_NOECHO_RENAME=true: NoEchoRenamed's create-only
#      TopicName now embeds the value, and the `requires replacement` line
#      prints it masked while AWS holds the real name (#4049). After Phase 2,
#      whose events scan would read the new topic's ARN.
#   4. Redeploy without it: the replacement back prints the old, value-bearing
#      name masked.
#   5. Destroy, gone-probes, and the S3 version sweep (state.json holds the
#      value in the clear by design, so every version of it is purged).
#
# The value is generated per run and never printed.
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

cd "$(dirname "$0")"

# Shared S3 VERSION-sweep helpers (issue #2096): the bucket is versioned, and
# state.json holds the NoEcho value in the clear by design.
. ../s3-versions.sh

STACK="CdkdNoechoParameterMaskingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
# The shared exports index is a SIBLING key no stack prefix reaches. Other
# stacks share it, so it is only READ here and purged `noncurrent` by KEY.
INDEX_KEY="cdkd/_index/${REGION}/exports.json"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
CONSUMER_NAME="cdkd-test-noecho-consumer-${ACCOUNT_ID}"
REJECT_NAME="cdkd-test-noecho-reject-${ACCOUNT_ID}"
RENAME_TOPIC_PREFIX="arn:aws:sns:${REGION}:${ACCOUNT_ID}:cdkd-test-noecho-rename-${ACCOUNT_ID}"

# Per run, so a value left in some sink by an earlier run cannot satisfy or
# confuse this one. Letters, digits and dashes: never one of SSM's `Tier`
# values, so NoEchoReject's create is always rejected.
TOKEN="cdkd-noecho-$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#TOKEN}" -lt 20 ]; then
  echo "FAIL: premise: could not generate the NoEcho value (got ${#TOKEN} characters)" >&2
  exit 1
fi
export CDKD_TEST_NOECHO_TOKEN="${TOKEN}"
# NoEchoAliasProbe's Export.Name (#4043). Appears in no template text but the
# parameter's Default, so no log, state blob or index version may carry it.
ALIAS_TOKEN="CdkdNoEchoAlias$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#ALIAS_TOKEN}" -lt 20 ]; then
  echo "FAIL: premise: could not generate the NoEcho alias value (got ${#ALIAS_TOKEN} characters)" >&2
  exit 1
fi
export CDKD_TEST_NOECHO_ALIAS_TOKEN="${ALIAS_TOKEN}"
# NoEchoSplitToken (#4049): two pieces, each distinct and long enough for the
# substring mask, joined by the delimiter the template splits on.
SPLIT_A="CdkdSplitA$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
SPLIT_B="CdkdSplitB$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#SPLIT_A}" -lt 20 ] || [ "${#SPLIT_B}" -lt 20 ]; then
  echo "FAIL: premise: could not generate the NoEcho split pieces" >&2
  exit 1
fi
export CDKD_TEST_NOECHO_SPLIT_TOKEN="${SPLIT_A},${SPLIT_B}"
SPLIT_NAME="cdkd-test-noecho-split-${ACCOUNT_ID}"
# The nested SplitChild (#4049): its own state key is a SIBLING prefix of the
# parent's, so it is swept by its own prefix too.
SPLIT_CHILD_NAME="cdkd-test-noecho-splitchild-${ACCOUNT_ID}"
CHILD_STACK="${STACK}~SplitChild"
CHILD_STATE_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"
RENAME_OLD_ARN="${RENAME_TOPIC_PREFIX}-a"
RENAME_NEW_ARN="${RENAME_TOPIC_PREFIX}-${TOKEN}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Scratch files, swept by `cleanup` on every exit path.
SCRATCH_FILES=()

# Print a captured output as failure diagnostics only when it does not carry
# the value: these paths exist to detect a masking regression, and echoing the
# log there would print exactly what failed to be masked.
diag_output() { # diag_output <text>
  if [[ "$1" == *"${TOKEN}"* ]] || [[ "$1" == *"${SPLIT_A}"* ]] || [[ "$1" == *"${SPLIT_B}"* ]]; then
    echo "    (output withheld: it carries a NoEcho value or split piece)" >&2
  else
    printf '%s\n' "$1" | tail -40 >&2
  fi
}

# A split piece of NoEchoSplitToken in a captured output is a #4049 leak.
assert_no_split_piece() { # assert_no_split_piece <label> <text>
  if [[ "$2" == *"${SPLIT_A}"* ]] || [[ "$2" == *"${SPLIT_B}"* ]]; then
    echo "FAIL: $1 carries a split piece of the NoEcho value in plaintext (issue #4049)" >&2
    exit 1
  fi
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ "${#SCRATCH_FILES[@]}" -gt 0 ]; then
    rm -f "${SCRATCH_FILES[@]}" || true
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # By exact name, in case state destroy missed them. NoEchoReject exists only
  # if AWS stopped rejecting the value.
  aws ssm delete-parameters --names "${CONSUMER_NAME}" "${REJECT_NAME}" "${SPLIT_NAME}" "${SPLIT_CHILD_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${RENAME_OLD_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${CHILD_STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX:-}" noncurrent || true
    # NONCURRENT only here: this also runs from the failure traps, where a live
    # state.json may still be the only record of standing resources. The
    # success path does the full sweep and asserts it.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
    # A binary that PUBLISHED the refused alias wrote the NoEcho value into the
    # shared index: its noncurrent versions go, never the current one.
    s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY:-}" noncurrent || true
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
# The events scan below must read THIS run's objects only: an earlier run's
# failed deploy leaves a rejection event that would satisfy its floors. The
# prefix is this stack's alone, so every version under it goes.
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}deployments/" all || true
if [ "$(s3_count_versions "${STATE_BUCKET}" "${STATE_PREFIX}deployments/")" != "0" ]; then
  echo "FAIL: premise: ${STATE_PREFIX}deployments/ still holds object versions after the pre-run purge -- the events scan could read an earlier run" >&2
  exit 1
fi

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy with --verbose"
if ! DEPLOY_OUT_P1=$(env -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the Phase 1 deploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P1}"
  exit 1
fi
# PREMISE: the template really declares the parameter NoEcho with this run's
# value as its Default, and the consumer really spells it through Fn::Sub.
SYNTH_TEMPLATE="cdk.out/${STACK}.template.json"
NOECHO_SHAPE=$(jq -r --arg tok "${TOKEN}" '
  (.Parameters.NoEchoToken.NoEcho == true and .Parameters.NoEchoToken.Default == $tok)
  and ([.Resources[] | select(.Type == "AWS::SSM::Parameter") | .Properties.Value
        | select(type == "object" and .["Fn::Sub"] == "token=${NoEchoToken}")] | length == 1)
' "${SYNTH_TEMPLATE}")
if [ "${NOECHO_SHAPE}" != "true" ]; then
  echo "FAIL: premise: the synthesized template does not declare NoEchoToken as NoEcho with this run's Default, consumed through Fn::Sub" >&2
  exit 1
fi
# PREMISE: the resolver logged the line this phase reads, masked. Without it
# the negative below passes for free on a resolver that stopped logging.
if [[ "${DEPLOY_OUT_P1}" != *"Resolved Fn::Sub: token=***"* ]]; then
  echo "FAIL: premise: the Phase 1 --verbose log carries no masked 'Resolved Fn::Sub: token=***' line (issue #1998)" >&2
  diag_output "${DEPLOY_OUT_P1}"
  exit 1
fi
if [[ "${DEPLOY_OUT_P1}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 1 --verbose log carries the NoEcho value in plaintext (issue #1998)" >&2
  exit 1
fi
echo "    OK: the --verbose log masks the NoEcho value"
# AWS received the REAL value: the mask is a print-surface decision only.
CONSUMER_VALUE=$(aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
if [ "${CONSUMER_VALUE}" != "token=${TOKEN}" ]; then
  echo "FAIL: ${CONSUMER_NAME} does not hold 'token=<the NoEcho value>' -- the value AWS received was altered (issue #1998)" >&2
  exit 1
fi
echo "    OK: AWS holds the real value"
# PERSISTENCE UNCHANGED (the #1998 decision): state.json holds the value in
# the clear, exactly as it did before the log-only channel existed.
P1_STATE=$(mktemp)
SCRATCH_FILES+=("${P1_STATE}")
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${P1_STATE}" --quiet
P1_PERSISTED=$(jq -r '.resources.NoEchoConsumer.properties.Value // "<absent>"' "${P1_STATE}")
if [ "${P1_PERSISTED}" != "token=${TOKEN}" ]; then
  echo "FAIL: state.json does not hold the consumer's value as deployed -- what cdkd persists changed, which the #1998 decision rules out" >&2
  exit 1
fi
echo "    OK: state.json holds the value as before (persistence unchanged)"
# NOECHO EXPORT NAME REFUSED (#4043). PREMISE: the template declares the second
# parameter NoEcho with this run's value as its Default, and NoEchoAliasProbe
# exports under a bare Ref to it -- so the alias name IS the value.
ALIAS_SHAPE=$(jq -r --arg tok "${ALIAS_TOKEN}" '
  (.Parameters.NoEchoAliasToken.NoEcho == true and .Parameters.NoEchoAliasToken.Default == $tok)
  and (.Outputs.NoEchoAliasProbe.Export.Name == {"Ref": "NoEchoAliasToken"})
' "${SYNTH_TEMPLATE}")
if [ "${ALIAS_SHAPE}" != "true" ]; then
  echo "FAIL: premise: the synthesized template does not export NoEchoAliasProbe under a Ref to the NoEcho NoEchoAliasToken with this run's Default" >&2
  exit 1
fi
# The refusal warning, found by its fixed wording and the output it names --
# neither carries the value -- and printed with the name masked.
REFUSAL_TEXT='has an Export.Name that resolves to a value containing a secret'
P1_REFUSAL_LINE=$(grep -m1 -F -- "Output NoEchoAliasProbe ${REFUSAL_TEXT}" <<< "${DEPLOY_OUT_P1}" || true)
if [ -z "${P1_REFUSAL_LINE}" ]; then
  echo "FAIL: the Phase 1 deploy printed no export-name refusal for NoEchoAliasProbe -- the NoEcho alias was not refused (issue #4043)" >&2
  # The alias value masked by hand: a regression here may print it.
  diag_output "$(grep -F 'NoEchoAliasProbe' <<< "${DEPLOY_OUT_P1}" | sed "s/${ALIAS_TOKEN}/***/g" || true)"
  exit 1
fi
if [[ "${P1_REFUSAL_LINE}" != *'(masked: "***")'* ]]; then
  echo "FAIL: the export-name refusal does not name the export masked (issue #4043): ${P1_REFUSAL_LINE//${ALIAS_TOKEN}/***}" >&2
  exit 1
fi
if [[ "${DEPLOY_OUT_P1}" == *"${ALIAS_TOKEN}"* ]]; then
  echo "FAIL: the Phase 1 deploy output carries the NoEcho alias value in plaintext (issue #4043)" >&2
  exit 1
fi
# Nothing published: the output keeps its own key and value, and neither the
# state blob (outputs keys, exportNames) nor the exports index holds the value.
P1_PROBE_VALUE=$(jq -r '.outputs.NoEchoAliasProbe // "<absent>"' "${P1_STATE}")
if [ "${P1_PROBE_VALUE}" != "alias-probe-value" ]; then
  echo "FAIL: premise: state.json does not hold NoEchoAliasProbe's own value -- the outputs pass did not run as expected" >&2
  exit 1
fi
if grep -qF -- "${ALIAS_TOKEN}" "${P1_STATE}"; then
  echo "FAIL: state.json carries the NoEcho alias value -- the refused alias was published (issue #4043)" >&2
  exit 1
fi
P1_ALIAS_KEYS=$(jq -r '[(.outputs // {} | to_entries[] | select(.value == "alias-probe-value") | .key)] | join(",")' "${P1_STATE}")
if [ "${P1_ALIAS_KEYS}" != "NoEchoAliasProbe" ]; then
  echo "FAIL: state.json holds NoEchoAliasProbe's value under another key -- an alias was published (issue #4043)" >&2
  exit 1
fi
# ONE read: present, it lands in the scratch file; absent, nothing was published.
P1_INDEX=$(mktemp)
SCRATCH_FILES+=("${P1_INDEX}")
if ! gone_probe aws s3api get-object --bucket "${STATE_BUCKET}" --key "${INDEX_KEY}" "${P1_INDEX}"; then
  if grep -qF -- "${ALIAS_TOKEN}" "${P1_INDEX}"; then
    echo "FAIL: the exports index carries the NoEcho alias value -- the refused alias was published (issue #4043)" >&2
    exit 1
  fi
  P1_INDEX_ENTRIES=$(jq -r --arg stack "${STACK}" '[.exports // {} | to_entries[] | select(.value.producerStack == $stack)] | length' "${P1_INDEX}")
  if [ "${P1_INDEX_ENTRIES}" != "0" ]; then
    echo "FAIL: the exports index holds ${P1_INDEX_ENTRIES} entr(ies) for ${STACK}, which exports nothing once its only alias is refused (issue #4043)" >&2
    exit 1
  fi
fi
echo "    OK: the NoEcho export alias is refused, masked in its warning, and in neither state nor the exports index"

# SPLIT PIECES (#4049). PREMISE: the template declares NoEchoSplitToken NoEcho
# with this run's two pieces as its Default, NoEchoSplitConsumer reads the
# second piece through Fn::Select over Fn::Split, and NoEchoSplitAliasProbe
# exports under the first.
SPLIT_SHAPE=$(jq -r --arg tok "${SPLIT_A},${SPLIT_B}" '
  {"Fn::Split": [",", {"Ref": "NoEchoSplitToken"}]} as $sp
  | (.Parameters.NoEchoSplitToken.NoEcho == true and .Parameters.NoEchoSplitToken.Default == $tok)
  and ([.Resources[] | select(.Type == "AWS::SSM::Parameter") | .Properties.Value
        | select(. == {"Fn::Select": [1, $sp]})] | length == 1)
  and (.Outputs.NoEchoSplitAliasProbe.Export.Name == {"Fn::Select": [0, $sp]})
' "${SYNTH_TEMPLATE}" 2>/dev/null || echo "unparsable")
if [ "${SPLIT_SHAPE}" != "true" ]; then
  echo "FAIL: premise: the synthesized template does not split the NoEcho NoEchoSplitToken (this run's Default) into NoEchoSplitConsumer's Value and NoEchoSplitAliasProbe's Export.Name (got ${SPLIT_SHAPE})" >&2
  exit 1
fi
# PREMISE: the resolver logged its split line. The SENTINEL is its fixed
# prefix, which carries no piece.
if [[ "${DEPLOY_OUT_P1}" != *'Resolved Fn::Split: split by ","'* ]]; then
  echo "FAIL: premise: the Phase 1 --verbose log carries no 'Resolved Fn::Split' line -- the split arm did not run" >&2
  diag_output "${DEPLOY_OUT_P1}"
  exit 1
fi
assert_no_split_piece "the Phase 1 --verbose log" "${DEPLOY_OUT_P1}"
echo "    OK: the --verbose log masks both split pieces"
SPLIT_VALUE=$(aws ssm get-parameter --name "${SPLIT_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
if [ "${SPLIT_VALUE}" != "${SPLIT_B}" ]; then
  echo "FAIL: ${SPLIT_NAME} does not hold the second split piece -- the value AWS received was altered (issue #4049)" >&2
  exit 1
fi
P1_SPLIT_PERSISTED=$(jq -r '.resources.NoEchoSplitConsumer.properties.Value // "<absent>"' "${P1_STATE}")
if [ "${P1_SPLIT_PERSISTED}" != "${SPLIT_B}" ]; then
  echo "FAIL: state.json does not hold the split piece as deployed -- what cdkd persists changed (issue #4049)" >&2
  exit 1
fi
echo "    OK: AWS and state.json hold the real piece (persistence unchanged)"
# The split alias: refused (the #4049 widening of the #4043 verdict), and
# published nowhere -- the index check above counts no entry for this stack.
if ! grep -qF -- "Output NoEchoSplitAliasProbe ${REFUSAL_TEXT}" <<< "${DEPLOY_OUT_P1}"; then
  echo "FAIL: the Phase 1 deploy printed no export-name refusal for NoEchoSplitAliasProbe -- an Export.Name holding a split piece was not refused (issue #4049)" >&2
  diag_output "$(grep -F 'NoEchoSplitAliasProbe' <<< "${DEPLOY_OUT_P1}" || true)"
  exit 1
fi
# Not a raw grep of the blob: state holds the whole NoEcho value in the clear
# by design (the SplitChild row's Parameters), and the value contains the
# piece. The alias would live in the outputs KEYS and exportNames.
P1_SPLIT_KEYS=$(jq -r --arg p "${SPLIT_A}" '[(.outputs // {} | keys[]), (.exportNames // [])[] | select(contains($p))] | length' "${P1_STATE}")
if [ "${P1_SPLIT_KEYS}" != "0" ]; then
  echo "FAIL: state.json holds an outputs key or exportName carrying the first split piece -- the refused split alias was published (issue #4049)" >&2
  exit 1
fi
P1_SPLIT_ALIAS_KEYS=$(jq -r '[(.outputs // {} | to_entries[] | select(.value == "split-alias-probe-value") | .key)] | join(",")' "${P1_STATE}")
if [ "${P1_SPLIT_ALIAS_KEYS}" != "NoEchoSplitAliasProbe" ]; then
  echo "FAIL: state.json holds NoEchoSplitAliasProbe's value under another key -- the split alias was published (issue #4049)" >&2
  exit 1
fi
echo "    OK: the Export.Name holding a split piece is refused and published nowhere"

# THE NESTED CHILD's LIST PARAMETER (#4049 (a)). PREMISE: the parent feeds
# SplitChild's ListIn the NoEcho value by a bare Ref, and the child declares
# ListIn a CommaDelimitedList its SSM parameter reads the first element of.
SPLIT_CHILD_TEMPLATE=$(jq -r '.Resources.SplitChild.Metadata["aws:asset:path"] // empty' "${SYNTH_TEMPLATE}")
CHILD_SHAPE=$(jq -r --slurpfile parent "${SYNTH_TEMPLATE}" '
  ($parent[0].Resources.SplitChild.Properties.Parameters.ListIn == {"Ref": "NoEchoSplitToken"})
  and (.Parameters.ListIn.Type == "CommaDelimitedList")
  and ([.Resources[] | select(.Type == "AWS::SSM::Parameter") | .Properties.Value
        | select(. == {"Fn::Select": [0, {"Ref": "ListIn"}]})] | length == 1)
' "cdk.out/${SPLIT_CHILD_TEMPLATE:-<absent>}" 2>/dev/null || echo "unparsable")
if [ "${CHILD_SHAPE}" != "true" ]; then
  echo "FAIL: premise: SplitChild does not receive the NoEcho NoEchoSplitToken as its CommaDelimitedList ListIn read through Fn::Select (got ${CHILD_SHAPE})" >&2
  exit 1
fi
# The child engine's own line for the list, found by its fixed prefix (the
# SENTINEL: it carries no element), must print neither element.
P1_LISTIN_LINE=$(grep -m1 -F 'Resolved Ref to parameter: ListIn ->' <<< "${DEPLOY_OUT_P1}" || true)
if [ -z "${P1_LISTIN_LINE}" ]; then
  echo "FAIL: premise: the Phase 1 --verbose log carries no 'Resolved Ref to parameter: ListIn' line -- the child's list arm did not run" >&2
  exit 1
fi
assert_no_split_piece "SplitChild's 'Resolved Ref to parameter: ListIn' line" "${P1_LISTIN_LINE}"
SPLIT_CHILD_VALUE=$(aws ssm get-parameter --name "${SPLIT_CHILD_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
if [ "${SPLIT_CHILD_VALUE}" != "${SPLIT_A}" ]; then
  echo "FAIL: ${SPLIT_CHILD_NAME} does not hold the first list element -- the value AWS received was altered (issue #4049)" >&2
  exit 1
fi
P1_CHILD_STATE=$(mktemp)
SCRATCH_FILES+=("${P1_CHILD_STATE}")
aws s3 cp "s3://${STATE_BUCKET}/${CHILD_STATE_KEY}" "${P1_CHILD_STATE}" --quiet
P1_CHILD_PERSISTED=$(jq -r '.resources.SplitChildConsumer.properties.Value // "<absent>"' "${P1_CHILD_STATE}")
if [ "${P1_CHILD_PERSISTED}" != "${SPLIT_A}" ]; then
  echo "FAIL: SplitChild's state.json does not hold the list element as deployed -- what cdkd persists changed (issue #4049)" >&2
  exit 1
fi
echo "    OK: the nested child's list line masks both elements; AWS and its state.json hold the real one"

# --- Phase 2: the provider rejection quotes the value ------------------------
echo "==> Phase 2: probe deploy whose SSM Tier is the NoEcho value, which SSM rejects quoting it"
assert_gone "premise: ${REJECT_NAME} already exists before its probe deploy" \
  aws ssm get-parameter --name "${REJECT_NAME}" --region "${REGION}"
set +e
DEPLOY_OUT_P2=$(CDKD_TEST_NOECHO_REJECT=true env -u CDKD_TEST_NOECHO_RENAME node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1)
P2_RC=$?
set -e
# The assertion that matters, FIRST: whatever else went wrong, a log carrying
# the value is the disclosure. ONE line is excluded, and only by its exact
# shape: the CDK app's own synth-time validator (aws-cdk-lib's `CloudFormation
# Validate` plugin) lints the TEMPLATE, where the value is the parameter's
# `Default`, and warns `Tier: '<value>' is not one of [...]`. That is the CDK
# library reporting template text, measured on the first live run, not a cdkd
# surface; the value is in cdk.out in the clear by construction.
P2_CDKD_OUT=$(grep -vE "^WARNING Tier: '.*' is not one of \[.*\] \(CloudFormation Validate\)$" <<< "${DEPLOY_OUT_P2}" || true)
if [[ "${P2_CDKD_OUT}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 2 deploy output carries the NoEcho value in plaintext (issue #1998)" >&2
  exit 1
fi
assert_no_split_piece "the Phase 2 deploy output" "${DEPLOY_OUT_P2}"
if [ "${P2_RC}" -eq 0 ]; then
  echo "FAIL: premise: the Phase 2 deploy exited 0 -- SSM accepted the NoEcho value as a Tier, so nothing was quoted back" >&2
  diag_output "${P2_CDKD_OUT}"
  exit 1
fi
# PREMISE: the failure IS SSM's validation rejection of the Tier, and AWS
# quoted the value in it (masked here). A failure for another reason, or a
# message that stopped quoting the value, leaves the negative above proving
# nothing. Anchored on the provider's OWN wrapper, then on SSM's measured
# wording (`Value '<v>' at 'tier' failed to satisfy constraint`),
# case-insensitive.
REJECTION_RE='failed to satisfy constraint'
# Taken from the FILTERED text: a filter that dropped cdkd's own lines (or a
# grep that errored into an empty result) then fails this premise instead of
# passing the leak negative above vacuously.
P2_REJECTION_LINE=$(grep -m1 -F 'Failed to create SSM parameter NoEchoReject' <<< "${P2_CDKD_OUT}" \
  | grep -iE "${REJECTION_RE}" || true)
if [ -z "${P2_REJECTION_LINE}" ]; then
  echo "FAIL: premise: the Phase 2 deploy failed, but not with SSM's Tier validation rejection -- this arm did not run" >&2
  diag_output "${P2_CDKD_OUT}"
  exit 1
fi
if [[ "${P2_REJECTION_LINE}" != *"***"* ]]; then
  echo "FAIL: premise: SSM's Tier validation rejection carries no masked value -- AWS no longer quotes the value, so this arm needs another vehicle" >&2
  exit 1
fi
echo "    OK: the rejection AWS quoted the value in is printed masked"
assert_gone "${REJECT_NAME} exists after its rejected create" \
  aws ssm get-parameter --name "${REJECT_NAME}" --region "${REGION}"
# The durable sink: every deployments/*.jsonl object, with a floor so a scan
# that read nothing cannot pass, and at least one carrying the rejection.
EVENT_KEYS=$(aws s3api list-objects-v2 --bucket "${STATE_BUCKET}" \
  --prefix "${STATE_PREFIX}deployments/" --output json | jq -r '.Contents // [] | .[].Key')
EVENTS_SCANNED=0
EVENTS_REJECTION=0
while IFS= read -r event_key || [ -n "${event_key}" ]; do
  [ -n "${event_key}" ] || continue
  EVENT_FILE=$(mktemp)
  SCRATCH_FILES+=("${EVENT_FILE}")
  aws s3 cp "s3://${STATE_BUCKET}/${event_key}" "${EVENT_FILE}" --quiet
  EVENTS_SCANNED=$((EVENTS_SCANNED + 1))
  if grep -qF -- "${TOKEN}" "${EVENT_FILE}"; then
    echo "FAIL: deployment events object ${event_key} carries the NoEcho value in plaintext (issue #1998)" >&2
    exit 1
  fi
  assert_no_split_piece "deployment events object ${event_key}" "$(cat "${EVENT_FILE}")"
  if grep -F 'Failed to create SSM parameter NoEchoReject' "${EVENT_FILE}" | grep -qiE "${REJECTION_RE}"; then
    EVENTS_REJECTION=$((EVENTS_REJECTION + 1))
  fi
done <<< "${EVENT_KEYS}"
if [ "${EVENTS_SCANNED}" -lt 2 ]; then
  echo "FAIL: the deployment-events scan read ${EVENTS_SCANNED} object(s) under ${STATE_PREFIX}deployments/, fewer than the index plus one run stream -- the negative above passes for free" >&2
  exit 1
fi
if [ "${EVENTS_REJECTION}" -lt 1 ]; then
  echo "FAIL: no deployment-events object carries the Tier validation rejection -- the failed resource's event was not among what the scan read" >&2
  exit 1
fi
echo "    OK: no deployment-events object carries the value (${EVENTS_SCANNED} objects, ${EVENTS_REJECTION} with the rejection)"

# --- Phase 3a: cdkd diff renders the pending rename masked -------------------
# BEFORE Phase 3 applies it, so state still holds the literal name and the
# diff has a real TopicName row whose new side embeds the value (#4049).
echo "==> Phase 3a: cdkd diff (human --verbose, and --json --fail) over the pending rename"
set +e
DIFF_OUT_P3A=$(CDKD_TEST_NOECHO_RENAME=true env -u CDKD_TEST_NOECHO_REJECT \
  node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose 2>&1)
DIFF_RC_P3A=$?
DIFF_JSON_ERR=$(mktemp)
SCRATCH_FILES+=("${DIFF_JSON_ERR}")
DIFF_JSON_P3A=$(CDKD_TEST_NOECHO_RENAME=true env -u CDKD_TEST_NOECHO_REJECT \
  node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --json \
  --fail 2>"${DIFF_JSON_ERR}")
DIFF_JSON_RC_P3A=$?
set -e
DIFF_JSON_STDERR_P3A=$(cat "${DIFF_JSON_ERR}")
# The disclosure check FIRST, over everything both runs printed.
if [[ "${DIFF_OUT_P3A}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 3a 'cdkd diff --verbose' output carries the NoEcho value in plaintext (issue #4049)" >&2
  exit 1
fi
if [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 3a 'cdkd diff --json' output carries the NoEcho value in plaintext (issue #4049)" >&2
  exit 1
fi
# The diff resolves NoEchoSplitConsumer too: its split line runs, piece-free.
if [[ "${DIFF_OUT_P3A}" != *'Resolved Fn::Split: split by ","'* ]]; then
  echo "FAIL: premise: 'cdkd diff --verbose' logged no 'Resolved Fn::Split' line -- the split arm did not run on the diff" >&2
  diag_output "${DIFF_OUT_P3A}"
  exit 1
fi
assert_no_split_piece "the Phase 3a 'cdkd diff' output" "${DIFF_OUT_P3A}${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}"
# The exit codes are unchanged: a plain diff exits 0 over a change, and
# --fail exits 1 because the change is still REPORTED, only masked.
if [ "${DIFF_RC_P3A}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --verbose' exited ${DIFF_RC_P3A}, not 0" >&2
  diag_output "${DIFF_OUT_P3A}"
  exit 1
fi
if [ "${DIFF_JSON_RC_P3A}" -ne 1 ]; then
  echo "FAIL: 'cdkd diff --json --fail' exited ${DIFF_JSON_RC_P3A}, not 1 -- the pending rename was not reported as a change" >&2
  diag_output "${DIFF_JSON_STDERR_P3A}"
  exit 1
fi
# PREMISE + the masked row, human: the TopicName row exists (its header is the
# SENTINEL, which carries no value), with the new side masked in place and
# the old side withheld whole.
RENAMED_ROW='  [~] NoEchoRenamed (AWS::SNS::Topic)'
if [[ "${DIFF_OUT_P3A}" != *"${RENAMED_ROW}"* ]]; then
  echo "FAIL: premise: 'cdkd diff' printed no UPDATE row for NoEchoRenamed -- this arm did not run" >&2
  diag_output "${DIFF_OUT_P3A}"
  exit 1
fi
if [[ "${DIFF_OUT_P3A}" != *'          old: "***"'* ]] \
  || [[ "${DIFF_OUT_P3A}" != *"          new: \"cdkd-test-noecho-rename-${ACCOUNT_ID}-***\""* ]]; then
  echo "FAIL: the NoEchoRenamed row does not print its old side withheld and its new side masked (issue #4049)" >&2
  diag_output "${DIFF_OUT_P3A}"
  exit 1
fi
# The diff's own --verbose replacement line, which Phase 3 checks on the deploy.
DIFF_REPLACE_LINE="Property TopicName of AWS::SNS::Topic requires replacement (*** -> \"cdkd-test-noecho-rename-${ACCOUNT_ID}-***\")"
if [[ "${DIFF_OUT_P3A}" != *"${DIFF_REPLACE_LINE}"* ]]; then
  echo "FAIL: 'cdkd diff --verbose' does not print the masked 'requires replacement' line for NoEchoRenamed (issue #4049)" >&2
  diag_output "$(grep -F 'requires replacement' <<< "${DIFF_OUT_P3A}" || true)"
  exit 1
fi
# The --json payload: the same row, masked at the value.
JSON_ROW=$(jq -c --arg name "cdkd-test-noecho-rename-${ACCOUNT_ID}-***" '
  [.[] | .changes[] | select(.logicalId == "NoEchoRenamed") | .propertyChanges[]?
   | select(.path == "TopicName" and .oldValue == "***" and .newValue == $name)] | length
' <<< "${DIFF_JSON_P3A}" 2>/dev/null || echo "unparsable")
if [ "${JSON_ROW}" != "1" ]; then
  echo "FAIL: the --json payload does not carry NoEchoRenamed's TopicName change masked (issue #4049; got ${JSON_ROW})" >&2
  diag_output "${DIFF_JSON_P3A}"
  exit 1
fi
# The refused alias (#4043) is not previewed: state holds no key for it, and a
# preview publishing it would be a phantom export row on every run.
ALIAS_ROWS=$(jq -c '[.[] | .outputChanges[]? | select(.export == true or .changeType == "ADD")] | length' <<< "${DIFF_JSON_P3A}" 2>/dev/null || echo "unparsable")
if [ "${ALIAS_ROWS}" != "0" ]; then
  echo "FAIL: the --json payload previews ${ALIAS_ROWS} added or export output row(s) -- the refused NoEcho alias is previewed as published (issue #4043)" >&2
  exit 1
fi
if [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}${DIFF_OUT_P3A}" == *"${ALIAS_TOKEN}"* ]]; then
  echo "FAIL: the Phase 3a diff output carries the NoEcho alias value (issue #4043)" >&2
  exit 1
fi
echo "    OK: cdkd diff masks the NoEcho value on its rows, its --json payload and its replacement line"

# --- Phase 3: a create-only property now embeds the value --------------------
# AFTER Phase 2's events scan: this deploy records the new topic's ARN, which
# embeds the value, as a physical id in its run stream, and that scan reads
# every stream under the prefix.
echo "==> Phase 3: redeploy with NoEchoRenamed's TopicName embedding the NoEcho value"
if ! DEPLOY_OUT_P3=$(CDKD_TEST_NOECHO_RENAME=true env -u CDKD_TEST_NOECHO_REJECT \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the Phase 3 deploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P3}"
  exit 1
fi
# The REPLACEMENT lines only, not the whole log: the new topic's PHYSICAL id
# (its ARN) embeds the value, and a physical id is printed as an identity, as
# CloudFormation's events print it -- not a surface #4049 masks.
P3_REPLACE_LINES=$(grep -F 'requires replacement' <<< "${DEPLOY_OUT_P3}" || true)
if [[ "${P3_REPLACE_LINES}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 3 'requires replacement' line carries the NoEcho value in plaintext (issue #4049)" >&2
  exit 1
fi
# The masked line, whole: the new name masked, the old side withheld. The
# SENTINEL is the engine's own replacement line, which carries no value.
REPLACE_LINE="Property TopicName of AWS::SNS::Topic requires replacement (*** -> \"cdkd-test-noecho-rename-${ACCOUNT_ID}-***\")"
if [[ "${DEPLOY_OUT_P3}" != *"${REPLACE_LINE}"* ]]; then
  if [[ "${DEPLOY_OUT_P3}" == *"Replacing NoEchoRenamed (AWS::SNS::Topic)"* ]]; then
    echo "FAIL: NoEchoRenamed was replaced but the --verbose log carries no masked 'requires replacement' line for it (issue #4049)" >&2
  else
    echo "FAIL: premise: the Phase 3 deploy did not replace NoEchoRenamed -- this arm did not run" >&2
  fi
  # The replacement lines only: the whole log carries the new topic's ARN,
  # which diag_output would always withhold.
  diag_output "${P3_REPLACE_LINES}"
  exit 1
fi
echo "    OK: the replacement line masks the NoEcho value"
assert_no_split_piece "the Phase 3 deploy output" "${DEPLOY_OUT_P3}"
# AWS holds the REAL name, and the old topic is gone.
if gone_probe aws sns get-topic-attributes --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}"; then
  echo "FAIL: the replacement topic named with the real NoEcho value does not exist -- the name AWS received was altered (issue #4049)" >&2
  exit 1
fi
assert_gone "the replaced topic still exists after Phase 3" \
  aws sns get-topic-attributes --topic-arn "${RENAME_OLD_ARN}" --region "${REGION}"
echo "    OK: AWS holds the real name and the old topic is gone"

# --- Phase 4: back to the literal name ---------------------------------------
# The OLD side is now the state's value-bearing name. The deploy's masker
# holds every NoEcho parameter's value before the diff starts, so it is masked
# whichever resource the diff reaches first.
echo "==> Phase 4: redeploy with NoEchoRenamed's literal TopicName"
if ! DEPLOY_OUT_P4=$(env -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the Phase 4 deploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P4}"
  exit 1
fi
P4_REPLACE_LINES=$(grep -F 'requires replacement' <<< "${DEPLOY_OUT_P4}" || true)
if [[ "${P4_REPLACE_LINES}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 4 'requires replacement' line carries the NoEcho value in plaintext (issue #4049)" >&2
  exit 1
fi
REVERT_LINE="Property TopicName of AWS::SNS::Topic requires replacement (\"cdkd-test-noecho-rename-${ACCOUNT_ID}-***\" -> \"cdkd-test-noecho-rename-${ACCOUNT_ID}-a\")"
if [[ "${DEPLOY_OUT_P4}" != *"${REVERT_LINE}"* ]]; then
  if [[ "${DEPLOY_OUT_P4}" == *"Replacing NoEchoRenamed (AWS::SNS::Topic)"* ]]; then
    echo "FAIL: NoEchoRenamed was replaced back but its 'requires replacement' line does not mask the old name (issue #4049)" >&2
  else
    echo "FAIL: premise: the Phase 4 deploy did not replace NoEchoRenamed back -- this arm did not run" >&2
  fi
  diag_output "${P4_REPLACE_LINES}"
  exit 1
fi
if gone_probe aws sns get-topic-attributes --topic-arn "${RENAME_OLD_ARN}" --region "${REGION}"; then
  echo "FAIL: premise: the literal-named topic does not exist after Phase 4" >&2
  exit 1
fi
assert_gone "the value-named topic still exists after Phase 4" \
  aws sns get-topic-attributes --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}"
echo "    OK: the replacement back masks the old, value-bearing name"
assert_no_split_piece "the Phase 4 deploy output" "${DEPLOY_OUT_P4}"

# --- Phase 5: destroy --------------------------------------------------------
echo "==> Phase 5: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes
assert_gone "SSM parameter '${CONSUMER_NAME}' still exists after destroy" \
  aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}"
assert_gone "SSM parameter '${REJECT_NAME}' exists after destroy" \
  aws ssm get-parameter --name "${REJECT_NAME}" --region "${REGION}"
assert_gone "SSM parameter '${SPLIT_NAME}' still exists after destroy" \
  aws ssm get-parameter --name "${SPLIT_NAME}" --region "${REGION}"
assert_gone "SSM parameter '${SPLIT_CHILD_NAME}' still exists after destroy" \
  aws ssm get-parameter --name "${SPLIT_CHILD_NAME}" --region "${REGION}"
assert_gone "child state file s3://${STATE_BUCKET}/${CHILD_STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_STATE_KEY}"
assert_gone "SNS topic NoEchoRenamed still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${RENAME_OLD_ARN}" --region "${REGION}"
assert_gone "the value-named SNS topic exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: resources and state are gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH ---------------------------
# state.json held the value in the clear by design, and the bucket is
# versioned: every version under the stack's prefix is purged, and asserted.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "noecho-parameter-masking state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "noecho-parameter-masking SplitChild state teardown"

echo "[verify] PASS - a NoEcho parameter value is masked on the deploy's provider, error, event, resolver and replacement-line surfaces, and so are its Fn::Split pieces, an Export.Name holding one is refused, and the rest of persistence is unchanged"
