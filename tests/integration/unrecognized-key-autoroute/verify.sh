#!/usr/bin/env bash
# verify.sh — a template key absent from cdkd's CFn schema snapshot routes the
# resource through Cloud Control, which REJECTS a misspelled key the way
# CloudFormation does (issue 3713).
#
# Before 3713 such a key ("unrecognized": in neither the handled set nor the
# silent-drop map) stayed on the SDK route, where the provider never sent it and
# the deploy reported success -- a typo was indistinguishable from a property
# AWS published after the snapshot, and both were silently dropped. The fix
# routes it via Cloud Control, with three exclusions that keep working
# deployments working: a READ-ONLY key (CloudFormation ignores one), a key named
# in `--prefer-sdk-route`, and a key the state record already holds with the
# same value (the resource deployed on the SDK route with it and stays there).
#
# Phases (CDKD_TEST_UPDATE tokens are cumulative; see lib/ for the template):
#   1 base            -- deploy; the record is on the SDK route.
#   2 typo            -- ADD CdkdIntegUnknownKey + a DisplayName change, NO flag.
#                        THE ARM: the deploy must FAIL with Cloud Control's
#                        rejection naming the key, and leave the record (route,
#                        physical id) and the live topic untouched.
#   3 prefer-sdk      -- the same template WITH --prefer-sdk-route for the key:
#                        stays on the SDK route and applies DisplayName. The
#                        record keeps the key, which phase 4 relies on.
#   4 unchanged-key   -- another DisplayName change, key unchanged, NO flag.
#                        ZERO-REGRESSION ARM: must stay on the SDK route and
#                        warn that the key is unchanged since the SDK deploy.
#   5 read-only       -- ADD a TopicArn override (the topic's own ARN) + a
#                        DisplayName change, NO flag: stays on SDK, warns
#                        "is read-only".
#   6 fresh-create    -- ADD a second topic carrying the typo key, NO flag: the
#                        CREATE is routed via Cloud Control and rejected; the
#                        second topic must not exist, have no state record, and
#                        the first topic must be intact.
#   7 destroy         -- both topics and the state object gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket
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

# A paged `aws` read blocks forever under a non-interactive runner.
export AWS_PAGER=""

STACK="CdkdUnrecognizedKeyAutorouteExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
TOPIC_NAME="${STACK}-topic"
FRESH_NAME="${STACK}-fresh"
UNKNOWN_KEY="CdkdIntegUnknownKey"
TOPIC_TYPE="AWS::SNS::Topic"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
REPO_ROOT="${PWD}/../../.."
# Resolved from the synth template, never hard-coded: a guessed key would make
# every state assertion read `null` and pass vacuously.
LOGICAL_ID=""
FRESH_LOGICAL_ID=""
# Set once the caller identity is known; cleanup skips the by-name deletes
# while they are empty.
TOPIC_ARN=""
FRESH_ARN=""

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  # Best effort, by deterministic name: a rejected CREATE should leave nothing,
  # and a leaked topic is what this sweep exists to catch.
  [ -n "${TOPIC_ARN}" ] && aws sns delete-topic --topic-arn "${TOPIC_ARN}" --region "${REGION}" >/dev/null 2>&1
  [ -n "${FRESH_ARN}" ] && aws sns delete-topic --topic-arn "${FRESH_ARN}" --region "${REGION}" >/dev/null 2>&1
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }

# state_json: the whole state document. Strict: a read failure aborts.
state_json() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}"
}

# record <logical-id> <jq-expression-over-the-resource-object>
record() {
  local json
  json=$(state_json) || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}" | jq -e --arg k "$1" '.resources | has($k)' >/dev/null || {
    echo "FAIL: no state resource ${1}" >&2; exit 1; }
  printf '%s' "${json}" | jq -r --arg k "$1" ".resources[\$k] | $2"
}

# The live DisplayName, read from AWS rather than from cdkd's state record.
live_display_name() {
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}" \
    --query 'Attributes.DisplayName' --output text
}

# Colour codes can sit inside a logger line, so every grep reads plain text.
strip_ansi() { sed $'s/\033\[[0-9;]*m//g'; }

# deploy_ok <label> <deploy command...> -- runs the command, prints cdkd's
# output (ANSI-stripped) on stdout for the caller to inspect, and fails the run
# on a non-zero exit. The command is spelled out at each call site, so every
# CDKD_TEST_UPDATE mode list is a literal the mode-gating lint can read.
deploy_ok() {
  local label="$1" out
  shift
  if ! out=$("$@" 2>&1); then
    printf '%s\n' "${out}" >&2
    echo "FAIL (${label}): the deploy exited non-zero" >&2
    exit 1
  fi
  printf '%s\n' "${out}" >&2
  printf '%s' "${out}" | strip_ansi
}

# deploy_fails <label> <deploy command...> -- the inverse: a zero exit fails
# the run.
deploy_fails() {
  local label="$1" out
  shift
  if out=$("$@" 2>&1); then
    printf '%s\n' "${out}" >&2
    echo "FAIL (${label}): the deploy SUCCEEDED; the unrecognized key was expected to route via Cloud Control and be rejected" >&2
    exit 1
  fi
  printf '%s\n' "${out}" >&2
  printf '%s' "${out}" | strip_ansi
}

# assert_cc_rejection <label> <plain-output> <logical-id>
#
# Two halves, and both are needed. The pre-flight line proves cdkd DECIDED to
# route via Cloud Control; the rejection line proves Cloud Control was ASKED and
# said no. The key name alone proves neither: cdkd's own pre-flight line names
# it too, so a grep for the key over the whole output would pass on a deploy
# that failed for any reason at all.
#
# SENTINEL (the rejection half): the parsed marker is the key on a line that is
# NOT one of cdkd's own advisory lines; the independent marker is Cloud
# Control's validation wording. A validation line WITHOUT the key means the
# deploy was rejected for something else (or the wording drifted); a key line
# with no validation wording means the failure is not a schema rejection. Both
# hard-fail with the output already printed above.
assert_cc_rejection() {
  local label="$1" plain="$2" lid="$3" routing others
  routing=$(grep -F "${lid} (${TOPIC_TYPE}): routing via Cloud Control API" <<<"${plain}" || true)
  [ -n "${routing}" ] || {
    echo "FAIL (${label}): no pre-flight 'routing via Cloud Control API' line for ${lid}; cdkd did not decide to route the unrecognized key" >&2; exit 1; }
  grep -qF "${UNKNOWN_KEY}" <<<"${routing}" || {
    echo "FAIL (${label}): the routing line for ${lid} does not name ${UNKNOWN_KEY}: ${routing}" >&2; exit 1; }
  grep -qF "is not in cdkd's CFn schema snapshot" <<<"${routing}" || {
    echo "FAIL (${label}): the routing line for ${lid} does not say the key is not in the schema snapshot (wording drift?): ${routing}" >&2; exit 1; }

  others=$(grep -vF 'routing via Cloud Control API' <<<"${plain}" | grep -vF 'will NOT reach AWS' || true)
  local rejection
  rejection=$(grep -iE 'extraneous key|unsupported propert|model validation|not permitted|ValidationException' <<<"${others}" || true)
  [ -n "${rejection}" ] || {
    echo "FAIL (${label}): the deploy failed, but no Cloud Control validation rejection appears in its output; it failed for another reason" >&2; exit 1; }
  # The loose match above is the SENTINEL; this is the parsed marker, anchored
  # on the key inside the validation clause itself, so a different validation
  # failure that merely echoes the bag cannot pass. Wording observed live:
  # `Model validation failed (#: extraneous key [<key>] is not permitted)`.
  grep -qiE "extraneous key \[${UNKNOWN_KEY}\] is not permitted" <<<"${rejection}" || {
    echo "FAIL (${label}): a Cloud Control validation rejection is present but its clause does not name ${UNKNOWN_KEY} (rejected for something else, or the wording drifted): ${rejection}" >&2; exit 1; }
  echo "    OK (${label}): routed via Cloud Control and rejected naming ${UNKNOWN_KEY}"
}

# assert_not_routed <label> <plain-output> -- the topic stayed on the SDK route.
# Its positive sibling is phase 2's routing line, which proves the wording this
# absence is keyed on exists.
assert_not_routed() {
  if grep -qF "${LOGICAL_ID} (${TOPIC_TYPE}): routing via Cloud Control API" <<<"$2"; then
    echo "FAIL ($1): cdkd announced a Cloud Control route for ${LOGICAL_ID}; this phase must stay on the SDK route" >&2
    exit 1
  fi
}

# assert_warn <label> <plain-output> <phrase> -- the SDK-route drop warn for
# the topic carries <phrase>.
#
# SENTINEL: the parsed marker is <phrase>; the independent marker is the warn's
# "will NOT reach AWS" clause on a line naming the topic. The drop warn present
# without the phrase is a wording drift (or the wrong bucket named), not an
# absent condition, and fails as such.
assert_warn() {
  local label="$1" plain="$2" phrase="$3" warn
  warn=$(grep -F "${LOGICAL_ID} (${TOPIC_TYPE}):" <<<"${plain}" | grep -F 'will NOT reach AWS' || true)
  [ -n "${warn}" ] || {
    echo "FAIL (${label}): no SDK-route drop warn for ${LOGICAL_ID}; the unrecognized key was not reported at all" >&2; exit 1; }
  grep -qF "${phrase}" <<<"${warn}" || {
    echo "FAIL (${label}): the drop warn for ${LOGICAL_ID} does not carry '${phrase}' (wording drift, or the wrong reason named): ${warn}" >&2; exit 1; }
  echo "    OK (${label}): warn carries '${phrase}'"
}

# Step 0: the premises the fixture rests on, read from the generated coverage
# table before any AWS call. If one dies, every arm below tests something else.
echo "==> Step 0: premise guard"
if ! (cd "${REPO_ROOT}" && KEY="${UNKNOWN_KEY}" TYPE="${TOPIC_TYPE}" node --input-type=module -e "
const mod = await import('./src/provisioning/property-coverage.generated.ts');
const table = Object.values(mod).find((v) => v instanceof Map);
const cov = table && table.get(process.env.TYPE);
const fail = (m) => { console.error(m); process.exit(1); };
if (!cov) fail('no coverage entry for ' + process.env.TYPE);
if (cov.handled.has(process.env.KEY) || cov.silentDrop.has(process.env.KEY)) fail(process.env.KEY + ' is in the schema snapshot');
if (!cov.readOnly.has('TopicArn')) fail('TopicArn is not read-only');
if (cov.ccRouteUnavailable) fail(process.env.TYPE + ' has no Cloud Control route');
"); then
  echo "FAIL: a premise of this fixture no longer holds (see above) -- do NOT debug the deploy" >&2
  exit 1
fi
echo "    OK: ${UNKNOWN_KEY} is unrecognized, TopicArn is read-only, the Cloud Control route is available"

[ -x node_modules/.bin/cdk ] || npm install

CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
PARTITION=$(printf '%s' "${CALLER_ARN}" | cut -d: -f2)
[ -n "${ACCOUNT_ID}" ] && [ -n "${PARTITION}" ] || { echo "FAIL: could not resolve the caller account / partition" >&2; exit 1; }
TOPIC_ARN="arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID}:${TOPIC_NAME}"
FRESH_ARN="arn:${PARTITION}:sns:${REGION}:${ACCOUNT_ID}:${FRESH_NAME}"

echo "==> Pre-run cleanup"; cleanup

# synth_modes <modes> -- synthesizes into cdk.out/ and fails loudly.
TEMPLATE="cdk.out/${STACK}.template.json"
synth_modes() {
  local out
  if ! out=$(env CDKD_TEST_UPDATE="$1" node "${LOCAL_DIST}" synth --region "${REGION}" 2>&1); then
    printf '%s\n' "${out}" >&2
    echo "FAIL: synth failed for modes '$1'" >&2
    exit 1
  fi
  [ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
}
# tprop <logical-id> <property> -- a property's JSON, `null` when absent.
tprop() { jq -c --arg k "$1" --arg p "$2" '.Resources[$k].Properties[$p]' "${TEMPLATE}"; }

echo "==> Template premises per mode"
synth_modes ""
LOGICAL_ID=$(jq -r --arg n "${TOPIC_NAME}" '.Resources | to_entries[] | select(.value.Type == "AWS::SNS::Topic" and .value.Properties.TopicName == $n) | .key' "${TEMPLATE}")
[ -n "${LOGICAL_ID}" ] || { echo "FAIL: no ${TOPIC_TYPE} named ${TOPIC_NAME} in ${TEMPLATE}" >&2; exit 1; }
[ "$(tprop "${LOGICAL_ID}" "${UNKNOWN_KEY}")" = "null" ] || { echo "FAIL: the BASE template already carries ${UNKNOWN_KEY}" >&2; exit 1; }
synth_modes "typo"
[ "$(tprop "${LOGICAL_ID}" "${UNKNOWN_KEY}")" = '"v1"' ] || { echo "FAIL: the typo template does not carry ${UNKNOWN_KEY}=v1; addPropertyOverride did not land" >&2; exit 1; }
synth_modes "typo,display3,readonly"
[ "$(tprop "${LOGICAL_ID}" TopicArn)" != "null" ] || { echo "FAIL: the readonly template does not carry TopicArn" >&2; exit 1; }
[ "$(tprop "${LOGICAL_ID}" "${UNKNOWN_KEY}")" = '"v1"' ] || { echo "FAIL: the readonly template changed ${UNKNOWN_KEY}; phase 5 would route on it" >&2; exit 1; }
synth_modes "typo,display3,readonly,fresh"
FRESH_LOGICAL_ID=$(jq -r --arg n "${FRESH_NAME}" '.Resources | to_entries[] | select(.value.Type == "AWS::SNS::Topic" and .value.Properties.TopicName == $n) | .key' "${TEMPLATE}")
[ -n "${FRESH_LOGICAL_ID}" ] || { echo "FAIL: the fresh template has no ${TOPIC_TYPE} named ${FRESH_NAME}" >&2; exit 1; }
[ "$(tprop "${FRESH_LOGICAL_ID}" "${UNKNOWN_KEY}")" = '"v1"' ] || { echo "FAIL: the fresh topic does not carry ${UNKNOWN_KEY}" >&2; exit 1; }
echo "    OK: resources ${LOGICAL_ID} / ${FRESH_LOGICAL_ID}; each mode differs as the phases need"

echo "==> Phase 1: base deploy (SDK route)"
deploy_ok "phase 1" env -u CDKD_TEST_UPDATE \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >/dev/null
LAYER1=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER1}" = "sdk" ] || { echo "FAIL: the base deploy recorded provisionedBy=${LAYER1}, expected sdk" >&2; exit 1; }
PHYS1=$(record "${LOGICAL_ID}" '.physicalId')
[ "${PHYS1}" = "${TOPIC_ARN}" ] || { echo "FAIL: physicalId ${PHYS1}, expected the TopicArn ${TOPIC_ARN}" >&2; exit 1; }
DN1=$(live_display_name)
[ "${DN1}" = "cdkd-integ-v1" ] || { echo "FAIL: live DisplayName ${DN1}, expected cdkd-integ-v1" >&2; exit 1; }
echo "    OK: on the SDK route, ${PHYS1}"

echo "==> Phase 2: THE ARM -- an unrecognized key on an existing SDK resource, NO flag"
PLAIN2=$(deploy_fails "phase 2" env CDKD_TEST_UPDATE=typo \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes)
assert_cc_rejection "phase 2" "${PLAIN2}" "${LOGICAL_ID}"
LAYER2=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER2}" = "sdk" ] || { echo "FAIL: the rejected Cloud Control update moved the record to provisionedBy=${LAYER2}; a rejected op must leave it untouched" >&2; exit 1; }
PHYS2=$(record "${LOGICAL_ID}" '.physicalId')
[ "${PHYS2}" = "${PHYS1}" ] || { echo "FAIL: physicalId changed across the rejected update (${PHYS1} -> ${PHYS2})" >&2; exit 1; }
RECKEY2=$(record "${LOGICAL_ID}" ".properties.${UNKNOWN_KEY} // \"ABSENT\"")
[ "${RECKEY2}" = "ABSENT" ] || { echo "FAIL: the rejected update recorded ${UNKNOWN_KEY}=${RECKEY2}" >&2; exit 1; }
DN2=$(live_display_name)
[ "${DN2}" = "cdkd-integ-v1" ] || { echo "FAIL: live DisplayName ${DN2} after the rejected update, expected it unchanged (cdkd-integ-v1)" >&2; exit 1; }
echo "    OK: record still sdk, id unchanged, nothing applied"

echo "==> Phase 3: --prefer-sdk-route keeps the key on the SDK route"
PLAIN3=$(deploy_ok "phase 3" env CDKD_TEST_UPDATE=typo \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes \
  --prefer-sdk-route "AWS::SNS::Topic:CdkdIntegUnknownKey")
assert_not_routed "phase 3" "${PLAIN3}"
# The allow-list also suppresses the drop warn; phase 4's warn is the positive
# sibling that proves this line's wording exists.
if grep -qF "${UNKNOWN_KEY} is not in cdkd's CFn schema snapshot" <<<"${PLAIN3}"; then
  echo "FAIL (phase 3): --prefer-sdk-route did not suppress the drop warn for ${UNKNOWN_KEY}" >&2; exit 1
fi
LAYER3=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER3}" = "sdk" ] || { echo "FAIL: --prefer-sdk-route did not keep the record on sdk (provisionedBy=${LAYER3})" >&2; exit 1; }
DN3=$(live_display_name)
[ "${DN3}" = "cdkd-integ-v2" ] || { echo "FAIL: live DisplayName ${DN3}, expected cdkd-integ-v2; the SDK-route update did not land" >&2; exit 1; }
RECKEY3=$(record "${LOGICAL_ID}" ".properties.${UNKNOWN_KEY} // \"ABSENT\"")
[ "${RECKEY3}" = "v1" ] || { echo "FAIL: the record does not carry ${UNKNOWN_KEY}=v1 (got ${RECKEY3}); phase 4's unchanged-key baseline is missing" >&2; exit 1; }
echo "    OK: stayed on sdk, DisplayName applied, record carries the key"

echo "==> Phase 4: ZERO-REGRESSION -- an unrelated change, key unchanged, NO flag"
PLAIN4=$(deploy_ok "phase 4" env CDKD_TEST_UPDATE=typo,display3 \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes)
assert_not_routed "phase 4" "${PLAIN4}"
assert_warn "phase 4" "${PLAIN4}" "unchanged since this resource was deployed on the SDK route"
LAYER4=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER4}" = "sdk" ] || { echo "FAIL: an unchanged unrecognized key moved the record to provisionedBy=${LAYER4}" >&2; exit 1; }
PHYS4=$(record "${LOGICAL_ID}" '.physicalId')
[ "${PHYS4}" = "${PHYS1}" ] || { echo "FAIL: physicalId changed (${PHYS1} -> ${PHYS4})" >&2; exit 1; }
DN4=$(live_display_name)
[ "${DN4}" = "cdkd-integ-v3" ] || { echo "FAIL: live DisplayName ${DN4}, expected cdkd-integ-v3" >&2; exit 1; }
echo "    OK: stayed on sdk, DisplayName applied"

echo "==> Phase 5: a read-only key stays on the SDK route, NO flag"
PLAIN5=$(deploy_ok "phase 5" env CDKD_TEST_UPDATE=typo,display3,readonly \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes)
assert_not_routed "phase 5" "${PLAIN5}"
assert_warn "phase 5" "${PLAIN5}" "TopicArn is read-only"
LAYER5=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER5}" = "sdk" ] || { echo "FAIL: a read-only key moved the record to provisionedBy=${LAYER5}" >&2; exit 1; }
PHYS5=$(record "${LOGICAL_ID}" '.physicalId')
[ "${PHYS5}" = "${PHYS1}" ] || { echo "FAIL: physicalId changed (${PHYS1} -> ${PHYS5})" >&2; exit 1; }
# Both SDK-route buckets in one line: the read-only key and the unchanged one.
assert_warn "phase 5" "${PLAIN5}" "${UNKNOWN_KEY} is not in cdkd's CFn schema snapshot and unchanged"
DN5=$(live_display_name)
[ "${DN5}" = "cdkd-integ-v4" ] || { echo "FAIL: live DisplayName ${DN5}, expected cdkd-integ-v4" >&2; exit 1; }
echo "    OK: stayed on sdk, same topic, DisplayName applied"

echo "==> Phase 6: a fresh CREATE carrying the typo key, NO flag"
PLAIN6=$(deploy_fails "phase 6" env CDKD_TEST_UPDATE=typo,display3,readonly,fresh \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes)
assert_cc_rejection "phase 6" "${PLAIN6}" "${FRESH_LOGICAL_ID}"
assert_gone "the rejected CREATE left topic ${FRESH_NAME} behind" \
  aws sns get-topic-attributes --topic-arn "${FRESH_ARN}" --region "${REGION}"
HAS_FRESH=$(state_json | jq -r --arg k "${FRESH_LOGICAL_ID}" '.resources | has($k)')
[ "${HAS_FRESH}" = "false" ] || { echo "FAIL: the state holds a record for ${FRESH_LOGICAL_ID} after its CREATE was rejected" >&2; exit 1; }
LAYER6=$(record "${LOGICAL_ID}" '.provisionedBy')
[ "${LAYER6}" = "sdk" ] || { echo "FAIL: the failed deploy moved ${LOGICAL_ID} to provisionedBy=${LAYER6}" >&2; exit 1; }
DN6=$(live_display_name)
[ "${DN6}" = "cdkd-integ-v4" ] || { echo "FAIL: the first topic changed (DisplayName ${DN6}, expected cdkd-integ-v4)" >&2; exit 1; }
echo "    OK: nothing created, no record, first topic intact"

echo "==> Phase 7: destroy + gone-probes"
env CDKD_TEST_UPDATE=typo,display3,readonly \
  node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "topic ${TOPIC_NAME} still exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${TOPIC_ARN}" --region "${REGION}"
assert_gone "topic ${FRESH_NAME} exists after destroy" \
  aws sns get-topic-attributes --topic-arn "${FRESH_ARN}" --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

trap - EXIT INT TERM
echo "[verify] PASS — unrecognized-key-autoroute (unrecognized keys route via Cloud Control; exclusions stay on SDK)"
