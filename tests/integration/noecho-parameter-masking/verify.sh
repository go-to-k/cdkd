#!/usr/bin/env bash
# verify.sh - cdkd NoEcho template parameter masking integ (issue #1998).
#
# A `Ref` or `Fn::Sub` variable serving a `NoEcho: true` template PARAMETER
# records the value as a LOG-ONLY needle: the deploy's provider, error, event
# and resolver surfaces mask it (the resolver's --verbose lines, the provider's
# masker, the engine's error text, the deployments/*.jsonl events), and what
# cdkd PERSISTS is unchanged. So do the diff's `requires replacement` line and
# the export-alias collision warning (go-to-k/cdkd#4049). `cdkd diff` and the
# other surfaces that never read the bag are go-to-k/cdkd#4049's other rows.
#
# Phases:
#   1. Deploy with --verbose. The resolver's `Resolved Fn::Sub: token=...` line
#      prints the value masked, AWS holds the REAL value, and state.json holds
#      it in the clear -- the persistence half of the #1998 decision, asserted
#      so a change to it is a visible decision, not a silent one. The
#      export-alias collision warning names a second NoEcho value, masked.
#   2. A probe deploy adding `NoEchoReject`, whose `Tier` IS the value. SSM's
#      ValidationException quotes the value back; the deploy fails, and
#      neither its output nor any deployments/*.jsonl object carries it.
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
# The export-alias collision's value (#4049): it is also the owner OUTPUT's
# logical id, so letters and digits only. It is template text as that id, so
# only the collision warning is asserted not to carry it.
ALIAS_TOKEN="CdkdNoEchoAlias$(od -An -N8 -tx1 /dev/urandom | tr -d ' \n')"
if [ "${#ALIAS_TOKEN}" -lt 20 ]; then
  echo "FAIL: premise: could not generate the NoEcho alias value (got ${#ALIAS_TOKEN} characters)" >&2
  exit 1
fi
export CDKD_TEST_NOECHO_ALIAS_TOKEN="${ALIAS_TOKEN}"
RENAME_OLD_ARN="${RENAME_TOPIC_PREFIX}-a"
RENAME_NEW_ARN="${RENAME_TOPIC_PREFIX}-${TOKEN}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Scratch files, swept by `cleanup` on every exit path.
SCRATCH_FILES=()

# Print a captured output as failure diagnostics only when it does not carry
# the value: these paths exist to detect a masking regression, and echoing the
# log there would print exactly what failed to be masked.
diag_output() { # diag_output <text>
  if [[ "$1" == *"${TOKEN}"* ]]; then
    echo "    (output withheld: it carries the NoEcho value)" >&2
  else
    printf '%s\n' "$1" | tail -40 >&2
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
  aws ssm delete-parameter --name "${CONSUMER_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${REJECT_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${RENAME_OLD_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws sns delete-topic --topic-arn "${RENAME_NEW_ARN}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # NONCURRENT only here: this also runs from the failure traps, where a live
    # state.json may still be the only record of standing resources. The
    # success path does the full sweep and asserts it.
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
# EXPORT-ALIAS COLLISION (#4049): NoEchoAliasProbe's Export.Name is the second
# NoEcho value, which is also the owner output's key, so the alias is skipped
# and the warning names it -- masked. The SENTINEL is the warning's fixed
# wording: present with no masked name means the name printed.
ALIAS_WARNING_TEXT='which is also the name of another output in this stack'
P1_ALIAS_LINE=$(grep -m1 -F -- "${ALIAS_WARNING_TEXT}" <<< "${DEPLOY_OUT_P1}" || true)
if [ -z "${P1_ALIAS_LINE}" ]; then
  echo "FAIL: premise: the Phase 1 deploy printed no export-alias collision warning -- this arm did not run (issue #4049)" >&2
  exit 1
fi
if [[ "${P1_ALIAS_LINE}" == *"${ALIAS_TOKEN}"* ]]; then
  echo "FAIL: the export-alias collision warning carries the NoEcho alias value in plaintext (issue #4049)" >&2
  exit 1
fi
if [[ "${P1_ALIAS_LINE}" != *'Output NoEchoAliasProbe exports as "***"'* ]]; then
  echo "FAIL: the export-alias collision warning does not name the export masked (issue #4049): ${P1_ALIAS_LINE}" >&2
  exit 1
fi
P1_OWNER_VALUE=$(jq -r --arg key "${ALIAS_TOKEN}" '.outputs[$key] // "<absent>"' "${P1_STATE}")
if [ "${P1_OWNER_VALUE}" != "alias-owner-value" ]; then
  echo "FAIL: state.json does not hold the owner output under its own key -- the collision's skip changed (issue #4049)" >&2
  exit 1
fi
echo "    OK: the export-alias collision warning masks the NoEcho alias value"

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

echo "[verify] PASS - a NoEcho parameter value is masked on the deploy's provider, error, event, resolver, replacement-line and export-alias surfaces, and persistence is unchanged"
