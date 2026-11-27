#!/usr/bin/env bash
# verify.sh — `cdkd deploy --replace-resource <logicalId>` plans a resource's
# update as a replacement (issue #7079).
#
# Phases: deploy a generated-name SNS topic with an SSM parameter holding its
# ARN and an SQS subscription to it -> the flag on a deploy that changes
# nothing on the topic is REFUSED, and nothing moves -> THE ARM: change only
# the topic's DisplayName (an in-place update without the flag) and deploy
# with `--replace-resource Topic`: a NEW topic replaces it (created first,
# the old one deleted), the parameter's value follows it, and the
# subscription (create-only TopicArn) is replaced onto it -> destroy.
#
# Before the fix the flag did not exist (an unknown option), and without it
# the DisplayName change updated the topic in place.

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

STACK="CdkdReplaceResourceFlagExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
PARAM="/cdkd-integ/${STACK}/topic-arn"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
SEEN_FILE="$(mktemp)"

state_json() {
  local json
  json=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)
  [ -n "${json}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
  printf '%s' "${json}"
}

# Field $2 (a jq path) of the state record with logical id $1 (an L1 at the
# stack root, so the id is exact); empty when absent.
record_field() {
  state_json | jq -r --arg k "$1" ".resources[\$k]$2 // empty"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  if [ -n "${STATE_BUCKET:-}" ]; then
    (printf '%s\n%s\n' "$(record_field Topic .physicalId)" "$(record_field Queue .physicalId)") \
      >>"${SEEN_FILE}" 2>/dev/null
  fi
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  while read -r id; do
    case "${id}" in
      arn:aws:sns:*) aws sns delete-topic --topic-arn "${id}" --region "${REGION}" >/dev/null 2>&1 ;;
      https://sqs.*) aws sqs delete-queue --queue-url "${id}" --region "${REGION}" >/dev/null 2>&1 ;;
    esac
  done <"${SEEN_FILE}"
  aws ssm delete-parameter --name "${PARAM}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  rm -f "${SEEN_FILE}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
command -v jq >/dev/null || { echo "FAIL: jq required" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup

param_value() {
  aws ssm get-parameter --name "${PARAM}" --region "${REGION}" --query Parameter.Value --output text
}
# The number of subscriptions on topic $1 delivering to queue ARN $2.
subs_to() {
  aws sns list-subscriptions-by-topic --topic-arn "$1" --region "${REGION}" \
    --query "length(Subscriptions[?Endpoint=='$2'])" --output text
}

echo "==> Phase 1: Deploy"
env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
T0=$(record_field Topic .physicalId)
[ -n "${T0}" ] || { echo "FAIL: no Topic record after phase 1" >&2; exit 1; }
printf '%s\n' "${T0}" >>"${SEEN_FILE}"
Q_URL=$(record_field Queue .physicalId)
[ -n "${Q_URL}" ] || { echo "FAIL: no Queue record after phase 1" >&2; exit 1; }
printf '%s\n' "${Q_URL}" >>"${SEEN_FILE}"
Q_ARN=$(aws sqs get-queue-attributes --queue-url "${Q_URL}" --attribute-names QueueArn --region "${REGION}" \
  --query Attributes.QueueArn --output text)
[ -n "${Q_ARN}" ] || { echo "FAIL: no QueueArn for ${Q_URL}" >&2; exit 1; }
V0=$(param_value)
[ "${V0}" = "${T0}" ] || { echo "FAIL: phase 1: ${PARAM} holds ${V0}, expected ${T0}" >&2; exit 1; }
S0=$(subs_to "${T0}" "${Q_ARN}")
[ "${S0}" = "1" ] || { echo "FAIL: phase 1: ${S0} subscription(s) from ${T0} to the queue, expected 1" >&2; exit 1; }
echo "    OK: topic ${T0}, its parameter and its subscription"

echo "==> Phase 2: --replace-resource on a deploy that changes nothing on the target is refused"
set +e
REFUSED=$(env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace-resource Topic --yes 2>&1)
REFUSED_RC=$?
set -e
[ "${REFUSED_RC}" -ne 0 ] || { printf '%s\n' "${REFUSED}" >&2; echo "FAIL: --replace-resource on an unchanged Topic was not refused (issue #7079)" >&2; exit 1; }
grep -qF -- "--replace-resource Topic: this deploy changes no property of Topic" <<<"${REFUSED}" || {
  printf '%s\n' "${REFUSED}" >&2
  echo "FAIL: the unchanged-target refusal does not name the flag and the resource (issue #7079)" >&2
  exit 1
}
[ "$(record_field Topic .physicalId)" = "${T0}" ] || { echo "FAIL: the refused deploy moved the Topic record" >&2; exit 1; }
echo "    OK: refused, nothing moved"

echo "==> Phase 2b: cdkd diff --replace-resource previews the same refusal (exit 3, issue #7089)"
set +e
DIFF_REFUSED=$(env -u CDKD_TEST_PHASE node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace-resource Topic 2>&1)
DIFF_REFUSED_RC=$?
set -e
[ "${DIFF_REFUSED_RC}" -eq 3 ] || { printf '%s\n' "${DIFF_REFUSED}" >&2; echo "FAIL: cdkd diff --replace-resource on an unchanged Topic exited ${DIFF_REFUSED_RC}, expected 3 (issue #7089)" >&2; exit 1; }
grep -qF -- "--replace-resource Topic: this deploy changes no property of Topic" <<<"${DIFF_REFUSED}" || {
  printf '%s\n' "${DIFF_REFUSED}" >&2
  echo "FAIL: cdkd diff does not print the deploy's unchanged-target refusal (issue #7089)" >&2
  exit 1
}
# The deploy refuses with no plan, so the diff shows no replacement either:
# not of the target, and not of Sub, the reader a replaced Topic would replace.
# Both spellings: a target's own row says `[requires replacement]`, a promoted
# reader's `[may require replacement]` / `[replacement propagated]` (render.ts).
if grep -qE 'require(s)? replacement|replacement propagated' <<<"${DIFF_REFUSED}"; then
  printf '%s\n' "${DIFF_REFUSED}" >&2
  echo "FAIL: the refused cdkd diff --replace-resource still shows a replacement the deploy never plans (issue #7089)" >&2
  exit 1
fi
echo "    OK: the diff blocks with the deploy's refusal and shows no replacement"

echo "==> Phase 3: THE ARM -- a DisplayName change, planned as a replacement by --replace-resource"
# PREMISE: the change alone is an in-place update of Topic, whose readers stay
# unchanged in the plan (a type name also contains the word, so the readers'
# absence is the load-bearing half).
PLAN=$(env CDKD_TEST_PHASE=display node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1) || {
  printf '%s\n' "${PLAN}" >&2
  echo "FAIL: premise: cdkd diff failed" >&2
  exit 1
}
grep -qw "Topic" <<<"${PLAN}" || { printf '%s\n' "${PLAN}" >&2; echo "FAIL: premise: the diff does not list Topic" >&2; exit 1; }
for reader in TopicArnParam Sub; do
  grep -qw "${reader}" <<<"${PLAN}" && {
    printf '%s\n' "${PLAN}" >&2
    echo "FAIL: premise: the diff lists ${reader}; without the flag it must be NO_CHANGE" >&2
    exit 1
  }
done
# go-to-k/cdkd#7089: `cdkd diff --replace-resource` previews the replacement
# this deploy then makes: the target and its create-only reader replaced.
set +e
PREVIEW=$(env CDKD_TEST_PHASE=display node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace-resource Topic --fail-on destructive 2>&1)
PREVIEW_RC=$?
set -e
[ "${PREVIEW_RC}" -eq 1 ] || { printf '%s\n' "${PREVIEW}" >&2; echo "FAIL: cdkd diff --replace-resource Topic --fail-on destructive exited ${PREVIEW_RC}, expected 1 (issue #7089)" >&2; exit 1; }
grep -qF "Found 2 destructive change(s)" <<<"${PREVIEW}" || {
  printf '%s\n' "${PREVIEW}" >&2
  echo "FAIL: cdkd diff --replace-resource Topic does not preview Topic and Sub replaced (issue #7089)" >&2
  exit 1
}
# By logical id: the destructive line ends `<logicalId> will|may be replaced`,
# so the type `AWS::SNS::Topic` (which also contains the word) never matches.
# The target WILL be replaced; its promoted reader MAY (a propagated ceiling).
for needle in "Topic will be replaced" "Sub (will|may) be replaced"; do
  grep -qE "[[:space:]]${needle}" <<<"${PREVIEW}" || { printf '%s\n' "${PREVIEW}" >&2; echo "FAIL: cdkd diff --replace-resource Topic does not list '${needle}' (issue #7089)" >&2; exit 1; }
done
echo "    OK: cdkd diff previews Topic and Sub replaced"
OUT=$(env CDKD_TEST_PHASE=display node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  --replace-resource Topic --yes 2>&1) || {
  printf '%s\n' "${OUT}" >&2
  echo "FAIL: the --replace-resource deploy failed" >&2
  exit 1
}
printf '%s\n' "${OUT}"
T1=$(record_field Topic .physicalId)
printf '%s\n' "${T1}" >>"${SEEN_FILE}"
[ -n "${T1}" ] && [ "${T1}" != "${T0}" ] || { echo "FAIL: --replace-resource Topic kept the topic ${T0}; it was updated in place, not replaced (issue #7079)" >&2; exit 1; }
DISPLAY=$(aws sns get-topic-attributes --topic-arn "${T1}" --region "${REGION}" --query Attributes.DisplayName --output text)
[ "${DISPLAY}" = "cdkd-integ-display-b" ] || { echo "FAIL: the replacement topic ${T1} has DisplayName ${DISPLAY}" >&2; exit 1; }
assert_gone "the replaced topic ${T0} still exists (issue #7079)" \
  aws sns get-topic-attributes --topic-arn "${T0}" --region "${REGION}"
V1=$(param_value)
[ "${V1}" = "${T1}" ] || { echo "FAIL: ${PARAM} holds ${V1} after --replace-resource replaced ${T0} -> ${T1}; expected the new ARN (issue #7079)" >&2; exit 1; }
[ "$(record_field TopicArnParam .properties.Value)" = "${T1}" ] || { echo "FAIL: state records ${PARAM}'s value as $(record_field TopicArnParam .properties.Value), expected ${T1} (issue #7079)" >&2; exit 1; }
S1=$(subs_to "${T1}" "${Q_ARN}")
[ "${S1}" = "1" ] || { echo "FAIL: ${S1} subscription(s) from the replacement topic ${T1} to the queue, expected 1 -- the reader whose create-only TopicArn names it was not replaced (issue #7079)" >&2; exit 1; }
[ "$(record_field Sub .properties.TopicArn)" = "${T1}" ] || { echo "FAIL: state records Sub on $(record_field Sub .properties.TopicArn), expected ${T1} (issue #7079)" >&2; exit 1; }
echo "    OK: Topic replaced ${T0} -> ${T1}; its parameter and subscription followed it"

echo "==> Phase 4: Destroy + gone-probes"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_gone "topic ${T1} survived destroy" aws sns get-topic-attributes --topic-arn "${T1}" --region "${REGION}"
assert_gone "SSM parameter ${PARAM} survived destroy" aws ssm get-parameter --name "${PARAM}" --region "${REGION}"
assert_gone "queue ${Q_URL} survived destroy" \
  aws sqs get-queue-attributes --queue-url "${Q_URL}" --attribute-names QueueArn --region "${REGION}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS — replace-resource-flag (--replace-resource plans an update as a replacement)"
