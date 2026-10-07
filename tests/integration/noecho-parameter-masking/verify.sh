#!/usr/bin/env bash
# verify.sh - cdkd NoEcho template parameter masking integ (issue #1998).
#
# A `Ref` or `Fn::Sub` variable serving a `NoEcho: true` template PARAMETER
# records the value as a LOG-ONLY needle: the deploy's provider, error, event
# and resolver surfaces mask it (the resolver's --verbose lines, the provider's
# masker, the engine's error text, the deployments/*.jsonl events). Since state
# schema v11 (go-to-k/cdkd#4043) what cdkd PERSISTS holds `***` where such a
# value served a leaf, and the record names the leaf in `noEchoLeaves`. So do the diff's
# `requires replacement` line and `cdkd diff`'s own rendering, human and --json
# (go-to-k/cdkd#4049), and so are the PIECES of an `Fn::Split` over a NoEcho
# value (#4049's coverage-edges row). An `Export.Name` holding a NoEcho value,
# or a split piece of one, is REFUSED (go-to-k/cdkd#4043): nothing is published
# to state or the exports index.
#
# Phases:
#   1. Deploy with --verbose. The resolver's `Resolved Fn::Sub: ...` line
#      prints the value masked, AWS holds the REAL value, and state.json holds
#      `***` at the leaf, named in `noEchoLeaves` (schema v11, #4043), with no
#      copy of the value anywhere in the blob.
#      NoEchoAliasProbe's Export.Name IS a second NoEcho value: the alias is
#      refused with a masked warning, and neither state.json, its exportNames
#      nor the exports index holds it (#4043). So are a literal name spelling
#      NoEchoToken's value, which only a resource reads, and an earlier literal
#      name spelling the Fn::Base64 encoding a LATER name records (#4043,
#      Phase B: the seed, and the resolve-then-decide order).
#      NoEchoSplitConsumer reads the second piece of an Fn::Split over a third
#      NoEcho value: the `Resolved Fn::Split` line prints neither piece, AWS
#      holds the piece and state.json `***` (the position reads the NoEcho
#      parameter, #4043), and NoEchoSplitAliasProbe's Export.Name, the first
#      piece, is refused (#4049). The nested SplitChild receives the same value
#      as its CommaDelimitedList ListIn: the parent row persists it as `***`,
#      its `Resolved Ref to parameter: ListIn` line prints neither element,
#      AWS holds the first, and its own state.json `***` with the position
#      named in `noEchoLeaves` (the parent fills ListIn from a NoEcho source,
#      so the child positions it, #4043 review round 9). No later phase
#      prints a piece.
#   1b. Redeploy unchanged (#4043 Phase B): the readback finds the value AWS
#      holds, so neither SSM parameter is updated (LastModifiedDate unchanged);
#      `cdkd diff --fail` exits 0; `cdkd drift --json` exits 0 and reports
#      NoEchoConsumer under `noEchoParameter`, printing no value.
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
#   3b. Redeploy with the same renamed TopicName: AWS holds it, so the
#      create-only topic is NOT replaced (its ARN is unchanged), and state
#      holds `***` at TopicName, named in `noEchoLeaves` (#4043).
#   4. Redeploy without it: the replacement back prints the old, value-bearing
#      name masked.
#   4a. Redeploy with CDKD_TEST_NOECHO_SNAPSHOT=true: NoEchoSnapshotGroup, a
#      Redis replication group whose id is `rg-<value>`, under
#      `DeletionPolicy: Snapshot` (go-to-k/cdkd#3869).
#   4b. LOAD-BEARING: redeploy without it. The template-removal DELETE takes a
#      final snapshot named `<the id's first 28 characters>-final-<timestamp>`,
#      which ends inside the value, so no literal needle matches it. The
#      `Creating final snapshot` line prints that name masked, the output
#      holds no fragment of it, and AWS holds the snapshot, which is deleted.
#   5. Destroy, gone-probes, and the S3 version sweep (a physical id named
#      from the value stays in the clear, as AWS publishes it, so every
#      version is purged).
#
# The value is generated per run and never printed.
#
# Discrimination (go-to-k/cdkd#3869, for a mutation probe on real AWS): revert
# the `finalSnapshotSpellingsOf` loop in
# src/deployment/secret-name-needles.ts ALONE and Phase 4b fails "prints
# NoEchoSnapshotGroup's final-snapshot base in plaintext": the engine judges
# the state record's plaintext id from the stack's NoEcho values and masks the
# whole id, which the snapshot name no longer spells (not yet measured on real
# AWS).
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
# state.json holds the value in a physical id named from it (Phases 3, 4a).
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
# NoEchoSnapshotGroup (go-to-k/cdkd#3869): its id, and the 28-character base
# of the final snapshot its removal takes. The base must END inside the
# value's random part, or a whole needle would still match it.
SNAP_GROUP_ID="rg-${TOKEN}"
SNAP_STEM="${SNAP_GROUP_ID:0:28}"
if [ "${#SNAP_GROUP_ID}" -le 28 ] || [ "${#SNAP_GROUP_ID}" -gt 40 ] || [ "${#TOKEN}" -lt 28 ]; then
  echo "FAIL: premise: NoEchoSnapshotGroup's id is ${#SNAP_GROUP_ID} characters; the snapshot arm needs 29 to 40, cut inside the value" >&2
  exit 1
fi
RENAME_OLD_ARN="${RENAME_TOPIC_PREFIX}-a"
RENAME_NEW_ARN="${RENAME_TOPIC_PREFIX}-${TOKEN}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
# The schema version the LOCAL binary writes, read from the BUILT binary
# (dist/), as schema-v9-to-v10-migration does: the bundler inlines the current
# constant but keeps the readable list as a named array, whose LAST entry is
# the current version. An unparsable bundle fails the run.
LOCAL_SCHEMA_VERSION="$(cat ../../../dist/*.js 2>/dev/null | awk '
  !inside && !done && /STATE_SCHEMA_VERSIONS_READABLE = \[/ {
    inside = 1
    sub(/.*STATE_SCHEMA_VERSIONS_READABLE = \[/, "")
  }
  inside {
    line = $0
    closes = (line ~ /\]/)
    sub(/\].*/, "", line)
    n = split(line, parts, ",")
    for (i = 1; i <= n; i++) {
      gsub(/[^0-9]/, "", parts[i])
      if (parts[i] != "") last = parts[i]
    }
    if (closes) { inside = 0; done = 1 }
  }
  END { if (done) print last }
')"
case "${LOCAL_SCHEMA_VERSION}" in
  '' | *[!0-9]*)
    echo "FAIL: could not read the readable schema versions from the built dist/ (is it built?)" >&2
    exit 1
    ;;
esac

# Scratch files, swept by `cleanup` on every exit path.
SCRATCH_FILES=()

# Print a captured output as failure diagnostics only when it does not carry
# the value: these paths exist to detect a masking regression, and echoing the
# log there would print exactly what failed to be masked.
diag_output() { # diag_output <text>
  if [[ "$1" == *"${TOKEN}"* ]] || [[ "$1" == *"${SNAP_STEM}"* ]] || [[ "$1" == *"${SPLIT_A}"* ]] || [[ "$1" == *"${SPLIT_B}"* ]] \
    || [[ "$1" == *"${ALIAS_TOKEN}"* ]] || [[ -n "${ALIAS_ENCODING:-}" && "$1" == *"${ALIAS_ENCODING}"* ]]; then
    echo "    (output withheld: it carries a NoEcho value, split piece or encoding)" >&2
  else
    printf '%s\n' "$1" | tail -40 >&2
  fi
}

# Replace every LITERAL occurrence of each needle with *** (awk index(), so a
# base64 `+` `/` `=` is never read as a pattern). Used only on FAIL paths.
mask_literals() { # mask_literals <text> <needle>...
  local text="$1"
  shift
  local needle
  for needle in "$@"; do
    text=$(awk -v n="${needle}" '{ while (n != "" && (i = index($0, n)) > 0) $0 = substr($0, 1, i - 1) "***" substr($0, i + length(n)); print }' <<< "${text}")
  done
  printf '%s' "${text}"
}

# gone_probe / assert_gone for a probe that addresses a resource named from
# the NoEcho value (NoEchoSnapshotGroup, its snapshot; go-to-k/cdkd#3869):
# gone_probe's undetermined line echoes the probe command and AWS's text, so
# it runs in a subshell here and that line is printed masked.
masked_gone_probe() { # usage: masked_gone_probe aws <service> <read-verb> [args...]
  local err rc
  err=$( { gone_probe "$@"; } 2>&1 >/dev/null ) && rc=0 || rc=$?
  if [ -n "${err}" ]; then
    mask_literals "${err}" "${TOKEN}" "${SNAP_STEM}" >&2
    echo >&2
    exit 1
  fi
  return "${rc}"
}
masked_assert_gone() { # usage: masked_assert_gone "<leak description>" aws <service> <read-verb> [args...]
  local desc="$1"
  shift
  if ! masked_gone_probe "$@"; then
    echo "FAIL: ${desc}" >&2
    exit 1
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
  # NoEchoSnapshotGroup and the final snapshot its removal takes (#3869),
  # swept by the `${SNAP_STEM}-final-` prefix. A snapshot still `creating`
  # refuses the delete, so this waits (bounded) for none to be `creating`
  # first; a run killed mid-snapshot is the case this covers.
  # A group still `creating` / `modifying` refuses the delete
  # (InvalidReplicationGroupState), so retry, bounded, until AWS accepts it or
  # the group is gone; one attempt would orphan the node of a run killed early.
  for _ in $(seq 1 90); do
    aws elasticache delete-replication-group --replication-group-id "${SNAP_GROUP_ID}" \
      --region "${REGION}" >/dev/null 2>&1 && break
    rg_probe=$(aws elasticache describe-replication-groups --replication-group-id "${SNAP_GROUP_ID}" \
      --region "${REGION}" --query 'ReplicationGroups[0].Status' --output text 2>&1)
    case "${rg_probe}" in
      *ReplicationGroupNotFound* | deleting) break ;;
    esac
    sleep 10
  done
  for _ in $(seq 1 90); do
    creating=$(aws elasticache describe-snapshots --region "${REGION}" \
      --query "length(Snapshots[?starts_with(SnapshotName, '${SNAP_STEM}-final-') && SnapshotStatus=='creating'])" \
      --output text 2>/dev/null)
    [ "${creating:-0}" = "0" ] && break
    sleep 10
  done
  for snap in $(aws elasticache describe-snapshots --region "${REGION}" \
    --query "Snapshots[?starts_with(SnapshotName, '${SNAP_STEM}-final-')].SnapshotName" \
    --output text 2>/dev/null); do
    [ "${snap}" = "None" ] && continue
    aws elasticache delete-snapshot --snapshot-name "${snap}" --region "${REGION}" >/dev/null 2>&1 || true
  done
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
        | select(type == "object" and .["Fn::Sub"] == "token-${NoEchoToken}")] | length == 1)
' "${SYNTH_TEMPLATE}")
if [ "${NOECHO_SHAPE}" != "true" ]; then
  echo "FAIL: premise: the synthesized template does not declare NoEchoToken as NoEcho with this run's Default, consumed through Fn::Sub" >&2
  exit 1
fi
# PREMISE: the resolver logged the line this phase reads, masked. Without it
# the negative below passes for free on a resolver that stopped logging.
# Schema v11 (#4043): the value is also a recorded mask-only entry, so the
# substitution's log twin (`token-***`) and the value's own needle mask BOTH
# fire, and the line gives both up for a whole `***` (logTwinText, #3100):
# it prints no part of the value, and none of the inert frame either.
# SENTINEL: a `Resolved Fn::Sub:` line at all. Present without the masked
# shape means the wording or the masking drifted, not that nothing logged.
if [[ "${DEPLOY_OUT_P1}" != *'Resolved Fn::Sub:'* ]]; then
  echo "FAIL: premise: the Phase 1 --verbose log carries no 'Resolved Fn::Sub:' line at all -- the resolver stopped logging it (issue #1998)" >&2
  diag_output "${DEPLOY_OUT_P1}"
  exit 1
fi
if ! grep -qE 'Resolved Fn::Sub: \*\*\*$' <<< "${DEPLOY_OUT_P1}"; then
  echo "FAIL: premise: the Phase 1 --verbose log carries 'Resolved Fn::Sub:' lines but none is the whole mask 'Resolved Fn::Sub: ***' -- the masking or its wording drifted (issue #1998 / #4043)" >&2
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
if [ "${CONSUMER_VALUE}" != "token-${TOKEN}" ]; then
  echo "FAIL: ${CONSUMER_NAME} does not hold 'token-<the NoEcho value>' -- the value AWS received was altered (issue #1998)" >&2
  exit 1
fi
echo "    OK: AWS holds the real value"
# PERSISTED AS THE MASK (schema v11, #4043): the consumer's Value holds `***`
# and the record names the coordinate, by COORDINATE (the blob check below is
# the negative).
P1_STATE=$(mktemp)
SCRATCH_FILES+=("${P1_STATE}")
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${P1_STATE}" --quiet
P1_VERSION=$(jq -r '.version' "${P1_STATE}")
if [ "${P1_VERSION}" != "${LOCAL_SCHEMA_VERSION}" ]; then
  echo "FAIL: state.json is version ${P1_VERSION}, not the local binary's ${LOCAL_SCHEMA_VERSION} (issue #4043)" >&2
  exit 1
fi
P1_PERSISTED=$(jq -r '.resources.NoEchoConsumer.properties.Value // "<absent>"' "${P1_STATE}")
P1_LEAVES=$(jq -c '.resources.NoEchoConsumer.noEchoLeaves // "<absent>"' "${P1_STATE}")
if [ "${P1_PERSISTED}" != '***' ] || [ "${P1_LEAVES}" != '[["Value"]]' ]; then
  echo "FAIL: state.json does not hold NoEchoConsumer.Value as the mask named in noEchoLeaves (got leaves ${P1_LEAVES}; issue #4043)" >&2
  exit 1
fi
# The deploy captures an observed baseline (the default; this fixture never
# passes --no-capture-observed-state), masked at the marked coordinate.
P1_OBSERVED=$(jq -r '.resources.NoEchoConsumer.observedProperties.Value // "<absent>"' "${P1_STATE}")
if [ "${P1_OBSERVED}" != '***' ]; then
  echo "FAIL: NoEchoConsumer's observed baseline does not hold the mask at the marked coordinate (issue #4043)" >&2
  exit 1
fi
if grep -qF -- "${TOKEN}" "${P1_STATE}" || grep -qF -- "${SPLIT_A}" "${P1_STATE}" || grep -qF -- "${SPLIT_B}" "${P1_STATE}"; then
  echo "FAIL: the Phase 1 state.json carries a NoEcho value or a split piece of one (issue #4043)" >&2
  exit 1
fi
echo "    OK: state.json holds *** at the marked coordinate and no copy of any NoEcho value"
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
    echo "FAIL: the exports index holds ${P1_INDEX_ENTRIES} entr(ies) for ${STACK}, which exports nothing once every alias is refused (issue #4043)" >&2
    exit 1
  fi
fi
echo "    OK: the NoEcho export alias is refused, masked in its warning, and in neither state nor the exports index"

# PHASE B ALIASES (#4043): the SEED and the resolve-then-decide ORDER. PREMISE:
# NoEchoLiteralAliasProbe's literal name spells NoEchoToken's value, which only
# a resource reads (no output's Value or Export.Name refers to NoEchoToken);
# NoEchoEarlyAliasProbe's literal name spells the Fn::Base64 encoding of the
# alias value, and is declared BEFORE NoEchoLateEncodedProbe, whose name is
# that Fn::Base64.
ALIAS_ENCODING=$(printf '%s' "${ALIAS_TOKEN}" | base64 | tr -d '\n')
if [ "${#ALIAS_ENCODING}" -lt 20 ]; then
  echo "FAIL: premise: could not encode the NoEcho alias value" >&2
  exit 1
fi
PHASE_B_SHAPE=$(jq -r --arg tok "${TOKEN}" --arg enc "${ALIAS_ENCODING}" '
  (.Outputs.NoEchoLiteralAliasProbe.Export.Name == ("literal-" + $tok))
  and ([.Outputs[] | select((.Value | tostring | contains("NoEchoToken"))
        or (.Export.Name | tostring | contains("NoEchoToken")))] | length == 0)
  and (.Outputs.NoEchoEarlyAliasProbe.Export.Name == ("early-" + $enc))
  and (.Outputs.NoEchoLateEncodedProbe.Export.Name == {"Fn::Base64": {"Ref": "NoEchoAliasToken"}})
  and ((.Outputs | keys_unsorted | index("NoEchoEarlyAliasProbe"))
       < (.Outputs | keys_unsorted | index("NoEchoLateEncodedProbe")))
' "${SYNTH_TEMPLATE}" 2>/dev/null || echo "unparsable")
if [ "${PHASE_B_SHAPE}" != "true" ]; then
  echo "FAIL: premise: the synthesized template does not declare the Phase B alias probes as expected (got ${PHASE_B_SHAPE})" >&2
  exit 1
fi
for probe in NoEchoLiteralAliasProbe NoEchoEarlyAliasProbe NoEchoLateEncodedProbe; do
  PROBE_LINE=$(grep -m1 -F -- "Output ${probe} ${REFUSAL_TEXT}" <<< "${DEPLOY_OUT_P1}" || true)
  if [ -z "${PROBE_LINE}" ]; then
    echo "FAIL: the Phase 1 deploy printed no export-name refusal for ${probe} -- its alias was published (issue #4043, Phase B)" >&2
    exit 1
  fi
  if [[ "${PROBE_LINE}" != *'(masked: "'*'***'*'")'* ]]; then
    echo "FAIL: the export-name refusal for ${probe} does not name the export masked (issue #4043, Phase B)" >&2
    exit 1
  fi
done
if [[ "${DEPLOY_OUT_P1}" == *"${ALIAS_ENCODING}"* ]]; then
  echo "FAIL: the Phase 1 deploy output carries the encoding of the NoEcho alias value (issue #4043)" >&2
  exit 1
fi
# Each probe's value only under its own key, and no refused name in
# exportNames, the outputs keys or the exports index.
for pair in NoEchoLiteralAliasProbe:literal-alias-probe-value \
  NoEchoEarlyAliasProbe:early-alias-probe-value \
  NoEchoLateEncodedProbe:late-encoded-probe-value; do
  probe="${pair%%:*}"
  probe_value="${pair#*:}"
  PROBE_KEYS=$(jq -r --arg v "${probe_value}" '[(.outputs // {} | to_entries[] | select(.value == $v) | .key)] | join(",")' "${P1_STATE}")
  if [ "${PROBE_KEYS}" != "${probe}" ]; then
    echo "FAIL: state.json holds ${probe}'s value under keys [$(mask_literals "${PROBE_KEYS}" "${TOKEN}" "${ALIAS_ENCODING}")] -- an alias was published (issue #4043, Phase B)" >&2
    exit 1
  fi
done
P1_EXPORT_NAMES=$(jq -r '(.exportNames // []) | length' "${P1_STATE}")
if [ "${P1_EXPORT_NAMES}" != "0" ]; then
  echo "FAIL: state.json lists ${P1_EXPORT_NAMES} exportName(s); every alias of this stack is refused (issue #4043)" >&2
  exit 1
fi
if grep -qF -- "${ALIAS_ENCODING}" "${P1_STATE}" || grep -qF -- "literal-${TOKEN}" "${P1_STATE}"; then
  echo "FAIL: state.json carries a refused Phase B alias name (issue #4043)" >&2
  exit 1
fi
if [ -s "${P1_INDEX}" ] && { grep -qF -- "${ALIAS_ENCODING}" "${P1_INDEX}" || grep -qF -- "literal-${TOKEN}" "${P1_INDEX}"; }; then
  echo "FAIL: the exports index carries a refused Phase B alias name (issue #4043)" >&2
  exit 1
fi
echo "    OK: a literal name spelling a resource-only NoEcho value, and an earlier name spelling a later name's encoding, are refused (#4043 Phase B)"

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
P1_SPLIT_LEAVES=$(jq -c '.resources.NoEchoSplitConsumer.noEchoLeaves // "<absent>"' "${P1_STATE}")
if [ "${P1_SPLIT_PERSISTED}" != '***' ] || [ "${P1_SPLIT_LEAVES}" != '[["Value"]]' ]; then
  echo "FAIL: state.json does not hold the split piece as the mask named in noEchoLeaves (issue #4043)" >&2
  exit 1
fi
# The nested row passes the whole value: persisted as the mask too.
P1_ROW_LISTIN=$(jq -r '.resources.SplitChild.properties.Parameters.ListIn // "<absent>"' "${P1_STATE}")
if [ "${P1_ROW_LISTIN}" != '***' ]; then
  echo "FAIL: the parent's SplitChild row does not persist its ListIn parameter as the mask (issue #4043)" >&2
  exit 1
fi
echo "    OK: AWS holds the real piece; state.json holds *** for it and for the nested row's parameter"
# The split alias: refused (the #4049 widening of the #4043 verdict), and
# published nowhere -- the index check above counts no entry for this stack.
if ! grep -qF -- "Output NoEchoSplitAliasProbe ${REFUSAL_TEXT}" <<< "${DEPLOY_OUT_P1}"; then
  echo "FAIL: the Phase 1 deploy printed no export-name refusal for NoEchoSplitAliasProbe -- an Export.Name holding a split piece was not refused (issue #4049)" >&2
  diag_output "$(grep -F 'NoEchoSplitAliasProbe' <<< "${DEPLOY_OUT_P1}" || true)"
  exit 1
fi
# The alias would live in the outputs KEYS and exportNames; the raw blob
# check above already found no piece anywhere.
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
P1_LISTIN_LINE=$(grep -m1 -F 'Resolved Ref to parameter: ListIn resolved to' <<< "${DEPLOY_OUT_P1}" || true)
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
# The CDK child declares no NoEcho, but the parent fills ListIn from its
# NoEcho parameter, so the child positions ListIn like a NoEcho parameter
# (#4043 review round 9): the record holds the mask, named by coordinate.
P1_CHILD_PERSISTED=$(jq -r '.resources.SplitChildConsumer.properties.Value // "<absent>"' "${P1_CHILD_STATE}")
if [ "${P1_CHILD_PERSISTED}" != '***' ]; then
  echo "FAIL: SplitChild's state.json does not hold the list element as the mask (issue #4043)" >&2
  exit 1
fi
P1_CHILD_LEAVES=$(jq -c '.resources.SplitChildConsumer.noEchoLeaves // "<absent>"' "${P1_CHILD_STATE}")
if [ "${P1_CHILD_LEAVES}" != '[["Value"]]' ]; then
  echo "FAIL: SplitChild's record does not name its NoEcho position (got ${P1_CHILD_LEAVES}; issue #4043 review round 9)" >&2
  exit 1
fi
if grep -qF -- "${SPLIT_A}" "${P1_CHILD_STATE}" || grep -qF -- "${SPLIT_B}" "${P1_CHILD_STATE}"; then
  echo "FAIL: SplitChild's state.json carries a split piece of the NoEcho value in plaintext (issue #4043)" >&2
  exit 1
fi
echo "    OK: the nested child's list line masks both elements; AWS holds the real one, the child's state.json the mask"

# --- Phase 1b: an unchanged redeploy reads the value back (#4043 Phase B) ---
echo "==> Phase 1b: redeploy unchanged; cdkd diff --fail; cdkd drift --json"
P1B_BEFORE=$(aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)
P1B_SPLIT_BEFORE=$(aws ssm get-parameter --name "${SPLIT_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)
if ! DEPLOY_OUT_P1B=$(env -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1); then
  echo "FAIL: the Phase 1b redeploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P1B}"
  exit 1
fi
if [[ "${DEPLOY_OUT_P1B}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 1b deploy output carries the NoEcho value in plaintext" >&2
  exit 1
fi
assert_no_split_piece "the Phase 1b deploy output" "${DEPLOY_OUT_P1B}"
P1B_AFTER=$(aws ssm get-parameter --name "${CONSUMER_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)
P1B_SPLIT_AFTER=$(aws ssm get-parameter --name "${SPLIT_NAME}" --region "${REGION}" \
  --query 'Parameter.LastModifiedDate' --output text)
if [ "${P1B_BEFORE}" != "${P1B_AFTER}" ] || [ "${P1B_SPLIT_BEFORE}" != "${P1B_SPLIT_AFTER}" ]; then
  echo "FAIL: an unchanged redeploy UPDATED a NoEcho reader -- the readback did not confirm the value AWS holds (issue #4043)" >&2
  exit 1
fi
echo "    OK: the unchanged redeploy updated neither NoEcho reader"
set +e
DIFF_OUT_P1B=$(env -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --fail 2>&1)
DIFF_RC_P1B=$?
set -e
if [[ "${DIFF_OUT_P1B}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 1b 'cdkd diff' output carries the NoEcho value in plaintext" >&2
  exit 1
fi
assert_no_split_piece "the Phase 1b 'cdkd diff' output" "${DIFF_OUT_P1B}"
if [ "${DIFF_RC_P1B}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' exited ${DIFF_RC_P1B} on the unchanged stack -- a masked NoEcho reader diffs as a change (issue #4043)" >&2
  diag_output "${DIFF_OUT_P1B}"
  exit 1
fi
echo "    OK: cdkd diff --fail exits 0 on the unchanged stack"
DRIFT_JSON_P1B=$(mktemp)
DRIFT_ERR_P1B=$(mktemp)
SCRATCH_FILES+=("${DRIFT_JSON_P1B}" "${DRIFT_ERR_P1B}")
set +e
# stdout alone is the JSON; stderr goes to its own file, so a warning line
# cannot make the document unparsable. Both are scanned for a leak.
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json >"${DRIFT_JSON_P1B}" 2>"${DRIFT_ERR_P1B}"
DRIFT_RC_P1B=$?
set -e
if grep -qF -- "${TOKEN}" "${DRIFT_JSON_P1B}" "${DRIFT_ERR_P1B}"; then
  echo "FAIL: the Phase 1b 'cdkd drift' output carries the NoEcho value in plaintext (issue #4043)" >&2
  exit 1
fi
assert_no_split_piece "the Phase 1b 'cdkd drift' output" "$(cat "${DRIFT_JSON_P1B}" "${DRIFT_ERR_P1B}")"
P1B_BUCKET=$(jq -r '[.[] | .notCompared[]? | select(.logicalId == "NoEchoConsumer" and .cause == "noEchoParameter")] | length' "${DRIFT_JSON_P1B}" 2>/dev/null || echo "unparsable")
P1B_DRIFTED=$(jq -r '[.[] | .drifted[]? | select(.logicalId == "NoEchoConsumer")] | length' "${DRIFT_JSON_P1B}" 2>/dev/null || echo "unparsable")
if [ "${P1B_BUCKET}" != "1" ] || [ "${P1B_DRIFTED}" != "0" ]; then
  echo "FAIL: cdkd drift does not report NoEchoConsumer under noEchoParameter (bucketed ${P1B_BUCKET}, drifted ${P1B_DRIFTED}; issue #4043)" >&2
  diag_output "$(cat "${DRIFT_JSON_P1B}" "${DRIFT_ERR_P1B}")"
  exit 1
fi
if [ "${DRIFT_RC_P1B}" -ne 0 ]; then
  echo "FAIL: cdkd drift exited ${DRIFT_RC_P1B}, not 0, on the unchanged stack (issue #4043)" >&2
  diag_output "$(cat "${DRIFT_JSON_P1B}" "${DRIFT_ERR_P1B}")"
  exit 1
fi
echo "    OK: cdkd drift exits 0 and reports NoEchoConsumer's marked leaf under noEchoParameter"

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
  if grep -qF -- "${ALIAS_TOKEN}" "${EVENT_FILE}" || grep -qF -- "${ALIAS_ENCODING}" "${EVENT_FILE}"; then
    echo "FAIL: deployment events object ${event_key} carries the NoEcho alias value or its encoding (issue #4043)" >&2
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
# Since schema v11 (#4043) the new side is compared as the persist side writes
# it, the whole leaf `***`, and the stored literal (a record written without a
# NoEcho position there) shows as `(previous NoEcho value)`: neither side
# prints a value.
# Scoped to the NoEchoRenamed row block: from its header up to the next row
# header (`  [` at the row indent), so another row cannot satisfy it.
RENAMED_BLOCK=$(awk -v hdr="${RENAMED_ROW}" '
  index($0, hdr) == 1 { inside = 1; print; next }
  inside && /^  \[/ { exit }
  inside { print }
' <<< "${DIFF_OUT_P3A}")
if [[ "${RENAMED_BLOCK}" != *'(previous NoEcho value)'* ]] \
  || [[ "${RENAMED_BLOCK}" != *'new: "***"'* ]]; then
  echo "FAIL: the NoEchoRenamed row does not print its old side as the placeholder and its new side as the mask (issue #4043)" >&2
  diag_output "${RENAMED_BLOCK:-<no NoEchoRenamed row block>}"
  exit 1
fi
# The diff's own --verbose replacement line, which Phase 3 checks on the deploy.
# Its fixed prefix is the SENTINEL; it must carry the mask and no value.
DIFF_REPLACE_LINE=$(grep -m1 -F 'Property TopicName of AWS::SNS::Topic requires replacement (from ' <<< "${DIFF_OUT_P3A}" || true)
if [ -z "${DIFF_REPLACE_LINE}" ] || [[ "${DIFF_REPLACE_LINE}" != *'***'* ]]; then
  echo "FAIL: 'cdkd diff --verbose' does not print a masked 'requires replacement' line for NoEchoRenamed (issue #4049)" >&2
  diag_output "$(grep -F 'requires replacement' <<< "${DIFF_OUT_P3A}" || true)"
  exit 1
fi
# The --json payload: the same row, the placeholder against the mask.
JSON_ROW=$(jq -c '
  [.[] | .changes[] | select(.logicalId == "NoEchoRenamed") | .propertyChanges[]?
   | select(.path == "TopicName" and .oldValue == "(previous NoEcho value)" and .newValue == "***")] | length
' <<< "${DIFF_JSON_P3A}" 2>/dev/null || echo "unparsable")
if [ "${JSON_ROW}" != "1" ]; then
  echo "FAIL: the --json payload does not carry NoEchoRenamed's TopicName change masked (issue #4049; got ${JSON_ROW})" >&2
  diag_output "${DIFF_JSON_P3A}"
  exit 1
fi
# The refused alias (#4043) is not previewed: state holds no key for it, and a
# preview publishing it would be a phantom export row on every run.
# PREMISE: the Outputs section was computed, not suppressed. A suppressed
# section with a would-be ADD always warns with one of these two lines, and
# an empty outputChanges would then pass the check below for free.
if [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}${DIFF_OUT_P3A}" == *"omitting the Outputs section"* ]] \
  || [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}${DIFF_OUT_P3A}" == *"output(s) could not be resolved for this diff"* ]]; then
  echo "FAIL: premise: the Phase 3a diff suppressed or partially resolved its Outputs section, so the alias check below would be vacuous" >&2
  exit 1
fi
ALIAS_ROWS=$(jq -c '[.[] | .outputChanges[]? | select(.export == true or .changeType == "ADD")] | length' <<< "${DIFF_JSON_P3A}" 2>/dev/null || echo "unparsable")
if [ "${ALIAS_ROWS}" != "0" ]; then
  echo "FAIL: the --json payload previews ${ALIAS_ROWS} added or export output row(s) -- the refused NoEcho alias is previewed as published (issue #4043)" >&2
  exit 1
fi
if [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}${DIFF_OUT_P3A}" == *"${ALIAS_TOKEN}"* ]] || [[ "${DIFF_JSON_P3A}${DIFF_JSON_STDERR_P3A}${DIFF_OUT_P3A}" == *"${ALIAS_ENCODING}"* ]]; then
  echo "FAIL: the Phase 3a diff output carries the NoEcho alias value or its encoding (issue #4043)" >&2
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
# Since schema v11 the line compares the persisted forms (#4043): the new side
# is the mask, the old a placeholder. The fixed prefix is the SENTINEL.
REPLACE_LINE=$(grep -m1 -F 'Property TopicName of AWS::SNS::Topic requires replacement (from ' <<< "${DEPLOY_OUT_P3}" || true)
if [ -z "${REPLACE_LINE}" ] || [[ "${REPLACE_LINE}" != *'***'* ]] \
  || [[ "${DEPLOY_OUT_P3}" != *"Replacing NoEchoRenamed (AWS::SNS::Topic)"* ]]; then
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

# --- Phase 3b: the same renamed TopicName again: not replaced (#4043) --------
echo "==> Phase 3b: redeploy with the same NoEcho-fed TopicName"
# The ARN is a function of the (unchanged) name, so a replacement keeps it:
# an OUT-OF-BAND marker the template never sets (DisplayName) is what a
# replacement loses, and what proves the topic is the same resource.
P3B_MARKER="cdkd-noecho-p3b-${RANDOM}${RANDOM}"
aws sns set-topic-attributes --region "${REGION}" --topic-arn "${RENAME_NEW_ARN}" \
  --attribute-name DisplayName --attribute-value "${P3B_MARKER}" >/dev/null
if ! DEPLOY_OUT_P3B=$(CDKD_TEST_NOECHO_RENAME=true env -u CDKD_TEST_NOECHO_REJECT \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>&1); then
  echo "FAIL: the Phase 3b deploy exited non-zero" >&2
  diag_output "$(grep -F 'NoEchoRenamed' <<< "${DEPLOY_OUT_P3B}" || true)"
  exit 1
fi
if [[ "${DEPLOY_OUT_P3B}" == *"Replacing NoEchoRenamed"* ]]; then
  echo "FAIL: an unchanged NoEcho-fed create-only TopicName REPLACED the topic -- the readback did not confirm it (issue #4043)" >&2
  exit 1
fi
# The readback confirmed the unchanged name: no create-only warning, which
# would mean a false `differs` / `not-readable` verdict. SENTINEL for this
# negative grep: the warning it looks for must still exist in the built binary
# with the same shape (one line naming `<Id>.<Property>` and
# `--recreate-via-cc-api`; schema-v10-to-v11-migration Phase 7 asserts that
# line positively on a real rotation), or the grep below could never match.
if ! grep -qF -- 'is a create-only property fed by a NoEcho parameter' ../../../dist/*.js \
    || ! grep -qF -- '--recreate-via-cc-api ${' ../../../dist/*.js; then
  echo "FAIL: sentinel: the built binary no longer carries the create-only NoEcho warning this phase greps for -- its wording drifted, so the negative check below is vacuous" >&2
  exit 1
fi
if grep -F 'NoEchoRenamed.TopicName' <<< "${DEPLOY_OUT_P3B}" | grep -qF -- '--recreate-via'; then
  echo "FAIL: the Phase 3b deploy warned that NoEchoRenamed.TopicName cannot be confirmed -- the readback of an unchanged name did not hold (issue #4043)" >&2
  diag_output "$(grep -F 'NoEchoRenamed' <<< "${DEPLOY_OUT_P3B}" || true)"
  exit 1
fi
if gone_probe aws sns get-topic-attributes --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}"; then
  echo "FAIL: the value-named topic is gone after Phase 3b -- it was replaced (issue #4043)" >&2
  exit 1
fi
P3B_DISPLAY=$(aws sns get-topic-attributes --region "${REGION}" --topic-arn "${RENAME_NEW_ARN}" \
  --query 'Attributes.DisplayName' --output text)
if [ "${P3B_DISPLAY}" != "${P3B_MARKER}" ]; then
  echo "FAIL: the out-of-band DisplayName marker is gone after Phase 3b -- the topic was replaced under the same name (issue #4043)" >&2
  exit 1
fi
P3B_STATE=$(mktemp)
SCRATCH_FILES+=("${P3B_STATE}")
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${P3B_STATE}" --quiet
P3B_TOPIC=$(jq -r '.resources.NoEchoRenamed.properties.TopicName // "<absent>"' "${P3B_STATE}")
P3B_LEAVES=$(jq -c '.resources.NoEchoRenamed.noEchoLeaves // "<absent>"' "${P3B_STATE}")
if [ "${P3B_TOPIC}" != '***' ] || [ "${P3B_LEAVES}" != '[["TopicName"]]' ]; then
  echo "FAIL: state.json does not hold NoEchoRenamed.TopicName as the mask named in noEchoLeaves (got leaves ${P3B_LEAVES}; issue #4043)" >&2
  exit 1
fi
echo "    OK: the create-only topic is not replaced, and state holds *** at its TopicName"

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
# The old side is the persisted mask (#4043); the new one the literal name.
REVERT_LINE=$(grep -m1 -F 'Property TopicName of AWS::SNS::Topic requires replacement (from ' <<< "${DEPLOY_OUT_P4}" || true)
if [ -z "${REVERT_LINE}" ] || [[ "${REVERT_LINE}" != *'***'* ]] \
  || [[ "${REVERT_LINE}" != *"cdkd-test-noecho-rename-${ACCOUNT_ID}-a"* ]] \
  || [[ "${DEPLOY_OUT_P4}" != *"Replacing NoEchoRenamed (AWS::SNS::Topic)"* ]]; then
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

# --- Phase 4a: a replication group named from the value ---------------------
echo "==> Phase 4a: redeploy adding NoEchoSnapshotGroup (id rg-<value>, DeletionPolicy: Snapshot)"
if ! DEPLOY_OUT_P4A=$(CDKD_TEST_NOECHO_SNAPSHOT=true env -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the Phase 4a deploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P4A}"
  exit 1
fi
if [[ "${DEPLOY_OUT_P4A}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 4a deploy output carries the NoEcho value in plaintext (issue #1998)" >&2
  exit 1
fi
assert_no_split_piece "the Phase 4a deploy output" "${DEPLOY_OUT_P4A}"
P4A_STATUS=$(aws elasticache describe-replication-groups --replication-group-id "${SNAP_GROUP_ID}" \
  --region "${REGION}" --query 'ReplicationGroups[0].Status' --output text)
if [ "${P4A_STATUS}" != "available" ]; then
  echo "FAIL: premise: NoEchoSnapshotGroup is '${P4A_STATUS}' after Phase 4a, not 'available' -- the final snapshot cannot be taken" >&2
  exit 1
fi
echo "    OK: AWS holds the replication group under the value-bearing id"

# --- Phase 4b: its removal takes a final snapshot named from a CUT id --------
echo "==> Phase 4b: redeploy without NoEchoSnapshotGroup (a final snapshot of a cut, value-bearing id)"
if ! DEPLOY_OUT_P4B=$(env -u CDKD_TEST_NOECHO_SNAPSHOT -u CDKD_TEST_NOECHO_REJECT -u CDKD_TEST_NOECHO_RENAME \
  node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the Phase 4b deploy exited non-zero" >&2
  diag_output "${DEPLOY_OUT_P4B}"
  exit 1
fi
if [[ "${DEPLOY_OUT_P4B}" == *"${TOKEN}"* ]]; then
  echo "FAIL: the Phase 4b deploy output carries the NoEcho value in plaintext (issue #1998)" >&2
  exit 1
fi
if [[ "${DEPLOY_OUT_P4B}" == *"${SNAP_STEM}"* ]]; then
  echo "FAIL: the Phase 4b deploy prints NoEchoSnapshotGroup's final-snapshot base in plaintext -- the snapshot name cuts the id inside the NoEcho value, and no needle masked the fragment (go-to-k/cdkd#3869)" >&2
  mask_literals "$(grep -F 'final snapshot' <<< "${DEPLOY_OUT_P4B}" || true)" "${SNAP_STEM}" "${TOKEN}" >&2
  echo >&2
  exit 1
fi
assert_no_split_piece "the Phase 4b deploy output" "${DEPLOY_OUT_P4B}"
if ! grep -qE 'Creating final snapshot \*\*\*[0-9]{8}-[0-9]{6} for NoEchoSnapshotGroup ' <<< "${DEPLOY_OUT_P4B}"; then
  echo "FAIL: premise: the Phase 4b deploy printed no masked 'Creating final snapshot ***<timestamp> for NoEchoSnapshotGroup' line -- the final-snapshot arm did not run" >&2
  diag_output "$(grep -F 'NoEchoSnapshotGroup' <<< "${DEPLOY_OUT_P4B}" || true)"
  exit 1
fi
masked_assert_gone "NoEchoSnapshotGroup still exists after Phase 4b" \
  aws elasticache describe-replication-groups --replication-group-id "${SNAP_GROUP_ID}" --region "${REGION}"
SNAP_NAME=$(aws elasticache describe-snapshots --region "${REGION}" \
  --query "Snapshots[?starts_with(SnapshotName, '${SNAP_STEM}-final-')].SnapshotName | [0]" \
  --output text)
if [ -z "${SNAP_NAME}" ] || [ "${SNAP_NAME}" = "None" ]; then
  echo "FAIL: premise: AWS holds no final snapshot of NoEchoSnapshotGroup after Phase 4b (DeletionPolicy: Snapshot ignored)" >&2
  exit 1
fi
SNAP_STATUS=$(aws elasticache describe-snapshots --snapshot-name "${SNAP_NAME}" --region "${REGION}" \
  --query 'Snapshots[0].SnapshotStatus' --output text)
if [ "${SNAP_STATUS}" != "available" ]; then
  echo "FAIL: NoEchoSnapshotGroup's final snapshot is '${SNAP_STATUS}', not 'available', after its delete" >&2
  exit 1
fi
echo "    OK: the snapshot line masks the cut, value-bearing name, and AWS holds the snapshot"
# A test artifact: deleted here, and waited on (the delete is asynchronous).
aws elasticache delete-snapshot --snapshot-name "${SNAP_NAME}" --region "${REGION}" >/dev/null
SNAP_GONE=0
for _ in $(seq 1 60); do
  if masked_gone_probe aws elasticache describe-snapshots --snapshot-name "${SNAP_NAME}" --region "${REGION}"; then
    SNAP_GONE=1
    break
  fi
  # By name, describe-snapshots answers an empty list once the delete
  # completes: a success response, not a not-found error.
  if [ "$(aws elasticache describe-snapshots --snapshot-name "${SNAP_NAME}" --region "${REGION}" \
    --query 'length(Snapshots)' --output text 2>/dev/null)" = "0" ]; then
    SNAP_GONE=1
    break
  fi
  sleep 10
done
if [ "${SNAP_GONE}" -ne 1 ]; then
  echo "FAIL: NoEchoSnapshotGroup's final snapshot is still present 10 minutes after its delete" >&2
  exit 1
fi

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
masked_assert_gone "NoEchoSnapshotGroup exists after destroy" \
  aws elasticache describe-replication-groups --replication-group-id "${SNAP_GROUP_ID}" --region "${REGION}"
assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: resources and state are gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH ---------------------------
# A physical id named from the value (Phases 3, 4a) stays in state, and the
# bucket is versioned: every version under the stack's prefix is purged, and
# asserted.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "noecho-parameter-masking state teardown"
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "noecho-parameter-masking SplitChild state teardown"

echo "[verify] PASS - a NoEcho parameter value is masked on the deploy's provider, error, event, resolver and replacement-line surfaces, and so are its Fn::Split pieces, an Export.Name holding one is refused, state persists *** at every NoEcho position (schema v11), and an unchanged redeploy neither updates nor replaces its readers"
