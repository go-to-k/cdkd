#!/usr/bin/env bash
# verify.sh -- cdkd sticky-CC -> SDK re-route integ for
# AWS::CloudFront::Distribution (issue 6490, batch 11).
#
# Admission evidence for the type's `'sdk-coverage'` sticky exemption. Both
# layers record the CloudFront-minted distribution Id. Phases: deploy on the
# SDK route -> force the distribution onto Cloud Control
# (--recreate-via-cc-api), which mints another Id -> the plan announces the
# return -> --pin-cc-api declines it -> redeploy with a real change: the Id
# unchanged, the record flipped to 'sdk', the update reached AWS on the same
# distribution -> drift clean, then exactly the out-of-band change -> destroy
# on the flipped record.
#
# The slow part is CloudFront's propagation: Cloud Control's create and update
# wait for `Deployed`, and every delete waits for it first.

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
# assert_gone, plus the not-found error AWS answers for that type: the shared
# signature alone would also accept another not-found.
assert_gone_as() { # usage: assert_gone_as "<leak description>" <ErrorCode> aws <service> <read-verb> [args...]
  local desc="$1" code="$2" out
  shift 2
  assert_gone "${desc}" "$@"
  out=$("$@" 2>&1 >/dev/null || true)
  grep -qF "${code}" <<<"${out}" || { echo "FAIL: ${desc}: the gone-probe answered without ${code}: ${out}" >&2; exit 1; }
}
cd "$(dirname "$0")"

STACK="CdkdCcToSdkRerouteCloudFrontDistributionExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
ID_SUBJECT=RerouteDistribution
TYPE="AWS::CloudFront::Distribution"
# A distribution Id: `E` and 13 upper-case letters or digits (measured
# us-east-1, 2026-11-18).
DIST_ID='E[0-9A-Z]{13}'

STATE_JSON=""
load_state() {
  STATE_JSON=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
  [ -n "${STATE_JSON}" ] || { echo "FAIL: state.json unreadable at ${STATE_KEY}" >&2; exit 1; }
}

# The subject's state record, read from the last load_state. A missing record
# would make every assertion below read `null` and pass vacuously, so an empty
# match hard-fails.
record() { # usage: record <jq-expression-over-the-resource-object>
  printf '%s' "${STATE_JSON}" | jq -e --arg k "${ID_SUBJECT}" '.resources[$k]' >/dev/null || {
    echo "FAIL: no state resource ${ID_SUBJECT}" >&2
    exit 1
  }
  printf '%s' "${STATE_JSON}" | jq -r --arg k "${ID_SUBJECT}" ".resources[\$k] | $1"
}

output() { # usage: output <OutputKey>
  printf '%s' "${STATE_JSON}" | jq -r --arg k "$1" '.outputs[$k]'
}

get_dist() { # usage: get_dist <distributionId> <--query expression>
  aws cloudfront get-distribution --id "$1" --query "Distribution.$2" --output text
}

# The value AWS holds for the mutable property, read through the recorded id.
live_comment() { # usage: live_comment <distributionId>
  get_dist "$1" DistributionConfig.Comment
}

# IDENTITY WITNESS, CloudFront-minted: the Id GetDistribution reports with
# the distribution's own DomainName (`<id>.cloudfront.net`-style, minted with
# it). A recreate mints both anew; a read through a stale id is NoSuchDistribution.
witness() { # usage: witness <distributionId>
  local id domain
  id=$(get_dist "$1" Id) || return 1
  domain=$(get_dist "$1" DomainName) || return 1
  [ "${id}" = "$1" ] || { echo "FAIL: get-distribution for $1 answered for ${id}" >&2; return 1; }
  grep -qE '^[a-z0-9]+\.cloudfront\.net$' <<<"${domain}" ||
    { echo "FAIL: distribution $1 reports DomainName '${domain}', not the measured form" >&2; return 1; }
  printf '%s %s' "${id}" "${domain}"
}

assert_layer() { # usage: assert_layer <phase-label> <sdk|cc-api>
  local layer
  layer=$(record '.provisionedBy')
  [ "${layer}" = "$2" ] || { echo "FAIL: $1: ${ID_SUBJECT} recorded provisionedBy=${layer}, expected $2" >&2; exit 1; }
}

# Both layers record the bare Id.
assert_form() { # usage: assert_form <phase-label>
  local pid
  pid=$(record '.physicalId')
  grep -qE "^${DIST_ID}\$" <<<"${pid}" || { echo "FAIL: $1: ${ID_SUBJECT} recorded '${pid}', not a bare distribution Id" >&2; exit 1; }
}

assert_live_value() { # usage: assert_live_value <phase-label> <a|b>
  local pid got
  pid=$(record '.physicalId')
  got=$(live_comment "${pid}") || { echo "FAIL: $1: cannot read ${ID_SUBJECT}'s Comment through ${pid}" >&2; exit 1; }
  [ "${got}" = "cdkd-reroute-cf phase-$2" ] || {
    echo "FAIL: $1: ${ID_SUBJECT} (${pid}) holds Comment '${got}', expected 'cdkd-reroute-cf phase-$2'" >&2
    exit 1
  }
}

# Cloud Control's create and update return only once the distribution is
# `Deployed` (measured us-east-1, 2026-11-18).
assert_deployed() { # usage: assert_deployed <phase-label>
  local pid st
  pid=$(record '.physicalId')
  st=$(get_dist "${pid}" Status) || { echo "FAIL: $1: cannot read ${ID_SUBJECT}'s status through ${pid}" >&2; exit 1; }
  [ "${st}" = "Deployed" ] || { echo "FAIL: $1: ${ID_SUBJECT} (${pid}) is '${st}' when the deploy returned, not Deployed" >&2; exit 1; }
}

# Ref and GetAtt Id are the Id, GetAtt DomainName the live one, on either layer.
assert_refs() { # usage: assert_refs <phase-label>
  local pid domain
  pid=$(record '.physicalId') || { echo "FAIL: $1: cannot read ${ID_SUBJECT}'s state record" >&2; exit 1; }
  domain=$(get_dist "${pid}" DomainName) || { echo "FAIL: $1: cannot read ${ID_SUBJECT}'s DomainName through ${pid}" >&2; exit 1; }
  [ "$(output DistributionRef)" = "${pid}" ] || { echo "FAIL: $1: Ref of ${ID_SUBJECT} resolved to '$(output DistributionRef)', expected ${pid}" >&2; exit 1; }
  [ "$(output DistributionId)" = "${pid}" ] || { echo "FAIL: $1: GetAtt ${ID_SUBJECT}.Id resolved to '$(output DistributionId)', expected ${pid}" >&2; exit 1; }
  [ "$(output DistributionDomainName)" = "${domain}" ] || {
    echo "FAIL: $1: GetAtt ${ID_SUBJECT}.DomainName resolved to '$(output DistributionDomainName)', expected ${domain}" >&2
    exit 1
  }
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  local destroy_rc=1 destroy_out=""
  if [ -f "${LOCAL_DIST}" ]; then
    destroy_out=$(node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes 2>&1)
    destroy_rc=$?
    # No state is the normal pre-run and post-destroy answer, not a failed teardown.
    if [ "${destroy_rc}" -ne 0 ] && ! grep -q 'No state found' <<<"${destroy_out}"; then
      echo "WARN: cdkd state destroy exited ${destroy_rc}; state was kept, so check the account for leftovers" >&2
    fi
  fi
  if [ -n "${STATE_BUCKET:-}" ] && [ "${destroy_rc}" -eq 0 ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
  fi
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

# `--recreate-via-cc-api` validates its argument against the template's own
# logical ids, so a wrong subject fails here, not as a confusing refusal
# mid-run.
node "${LOCAL_DIST}" synth --region "${REGION}" >/dev/null 2>&1
TEMPLATE="cdk.out/${STACK}.template.json"
[ -f "${TEMPLATE}" ] || { echo "FAIL: no synth template at ${TEMPLATE}" >&2; exit 1; }
jq -e --arg k "${ID_SUBJECT}" --arg t "${TYPE}" '.Resources[$k].Type == $t' "${TEMPLATE}" >/dev/null ||
  { echo "FAIL: ${TEMPLATE} declares no ${ID_SUBJECT} of type ${TYPE}" >&2; exit 1; }

echo "==> Phase 1: Deploy (SDK route by default -- the type has no SDK-unwired properties)"
env CDKD_TEST_PHASE=base \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layer "phase 1 (fresh deploy)" sdk
assert_form "phase 1 (fresh deploy)"
P0=$(record '.physicalId')
W0=$(witness "${P0}") || { echo "FAIL: phase 1: cannot read ${ID_SUBJECT}'s identity witness through ${P0}" >&2; exit 1; }
assert_live_value "phase 1 (SDK create)" a
assert_refs "phase 1"
echo "    OK: created on the SDK route (${W0})"

echo "==> Phase 2: force the distribution onto Cloud Control (--recreate-via-cc-api)"
env CDKD_TEST_PHASE=seed \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --recreate-via-cc-api "${ID_SUBJECT}" --yes
load_state
# Without this every assertion below would be vacuous.
assert_layer "phase 2 (after --recreate-via-cc-api)" cc-api
# THE MEASURED FORM: Cloud Control records the bare Id too.
assert_form "phase 2 (after --recreate-via-cc-api)"
P1=$(record '.physicalId')
W1=$(witness "${P1}") || { echo "FAIL: phase 2: cannot read ${ID_SUBJECT}'s identity witness through ${P1}" >&2; exit 1; }
[ "${P1}" != "${P0}" ] && [ "${W1}" != "${W0}" ] || {
  echo "FAIL: the recreate kept ${ID_SUBJECT}'s Id (${P0}); it was not recreated, so the witness cannot prove phase 5" >&2
  exit 1
}
assert_gone_as "${ID_SUBJECT}'s SDK-created distribution ${P0} survived its recreate" NoSuchDistribution \
  aws cloudfront get-distribution --id "${P0}"
assert_deployed "phase 2 (CC create)"
assert_live_value "phase 2 (CC recreate)" b
assert_refs "phase 2"
echo "    OK: pinned to Cloud Control under the bare Id, with a fresh witness (${W1})"

echo "==> Phase 3: the plan ANNOUNCES the return"
# `pinned`, not `flip`: the seed already declares flip's value, and cdkd diff
# renders the routing token only on a changed resource.
DIFF_OUT=$(env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1 || true)
# The change row names the logical id and its type; the token rides on it.
# A row without the token is the routing annotation missing or reworded.
row=$(grep -F "] ${ID_SUBJECT} (AWS::" <<<"${DIFF_OUT}" || true)
[ -n "${row}" ] || { echo "FAIL: cdkd diff shows no change row for ${ID_SUBJECT}" >&2; printf '%s\n' "${DIFF_OUT}" >&2; exit 1; }
grep -qF '[returning to SDK provider]' <<<"${row}" || {
  echo "FAIL: cdkd diff did not announce ${ID_SUBJECT}'s return: ${row}" >&2
  exit 1
}
if grep -q 'via CC API: sticky' <<<"${DIFF_OUT}"; then
  echo "FAIL: cdkd diff still renders the sticky tag for ${ID_SUBJECT}, which is about to leave Cloud Control" >&2
  printf '%s\n' "${DIFF_OUT}" >&2
  exit 1
fi
echo "    OK: plan says 'returning to SDK provider' for ${ID_SUBJECT}"

echo "==> Phase 4: --pin-cc-api DECLINES the flip"
env CDKD_TEST_PHASE=pinned \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
    --pin-cc-api "${ID_SUBJECT}" --yes
load_state
assert_layer "phase 4 (--pin-cc-api)" cc-api
[ "$(record '.physicalId')" = "${P1}" ] || { echo "FAIL: the pinned deploy changed ${ID_SUBJECT}'s id" >&2; exit 1; }
w=$(witness "${P1}") || { echo "FAIL: phase 4: cannot read ${ID_SUBJECT}'s identity witness through ${P1}" >&2; exit 1; }
[ "${w}" = "${W1}" ] || { echo "FAIL: the pinned Cloud Control update replaced ${ID_SUBJECT} (its witness changed)" >&2; exit 1; }
assert_deployed "phase 4 (CC update)"
# Without this, "still cc-api" is equally explained by a NO_CHANGE deploy.
assert_live_value "phase 4 (CC update)" a
echo "    OK: still on Cloud Control, update applied via CC"

echo "==> Phase 5: THE ARM -- redeploy unpinned; the flip must be churn-free"
env CDKD_TEST_PHASE=flip \
  node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
load_state
assert_layer "phase 5 (flip)" sdk
P2=$(record '.physicalId')
[ "${P2}" = "${P1}" ] || {
  echo "FAIL: PHYSICAL ID CHURN across ${ID_SUBJECT}'s flip: ${P1} -> ${P2}. This type must not carry an 'sdk-coverage' exemption." >&2
  exit 1
}
w2=$(witness "${P2}") || { echo "FAIL: phase 5: cannot read ${ID_SUBJECT}'s identity witness through the flipped id ${P2}" >&2; exit 1; }
[ "${w2}" = "${W1}" ] || { echo "FAIL: ${ID_SUBJECT}'s witness changed across the flip (${W1} -> ${w2}); the SDK provider replaced it" >&2; exit 1; }
# The update reached AWS through the id Cloud Control recorded.
assert_live_value "phase 5 (SDK update)" b
assert_refs "phase 5"
# The SDK provider's update returns without waiting for Deployed unless
# --full-wait is passed; the status is reported, not asserted.
echo "    NOTE: ${ID_SUBJECT} is '$(get_dist "${P2}" Status)' as the default-mode SDK update returned"
echo "    OK: same id and witness, record flipped to sdk, update applied in place"

echo "==> Phase 6: drift on the flipped record"
# cdkd drift compares AWS with the snapshot each deploy reads back
# (observedProperties). 6a: nothing changed since the flip, so it must be
# clean. 6b: with its Comment changed out of band, it must drift by that
# property alone, which proves drift reads the live distribution through the
# flipped record rather than skipping it.
DRIFT_OUT=""
DRIFT_RC=0
run_drift() {
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --stack-region "${REGION}" --json 2>/dev/null)
  DRIFT_RC=$?
  set -e
}
# The report bucket(s) the subject lands in, comma-joined.
drift_bucket() {
  jq -r --arg id "${ID_SUBJECT}" '[.. | objects | to_entries[]
    | select((.value | type) == "array") | .key as $bucket
    | .value[]? | objects | select(.logicalId == $id) | $bucket] | join(",")' \
    <<<"${DRIFT_OUT}" 2>/dev/null || true
}
drift_fail() { # usage: drift_fail <message>
  echo "FAIL: $1" >&2
  printf '%s\n' "${DRIFT_OUT}" >&2
  exit 1
}

run_drift
bucket=$(drift_bucket)
[ "${bucket}" = "clean" ] || drift_fail "6a: cdkd drift put ${ID_SUBJECT} in bucket '${bucket}', expected clean"
jq -e '[.[].drifted[]] | length == 0' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6a: cdkd drift reports a drifted resource"
# rc after the bucket, so a non-zero rc names its own cause.
[ "${DRIFT_RC}" -eq 0 ] || drift_fail "6a: cdkd drift exited ${DRIFT_RC} although ${ID_SUBJECT} is clean"
echo "    OK (6a): cdkd drift reported ${ID_SUBJECT} clean (rc=0)"

# UpdateDistribution replaces the whole configuration: the one read back is
# sent with only its Comment changed.
OOB_DIR=$(mktemp -d)
aws cloudfront get-distribution-config --id "${P2}" --output json >"${OOB_DIR}/current.json" ||
  { echo "FAIL: 6b: cannot read ${ID_SUBJECT}'s configuration through ${P2}" >&2; exit 1; }
ETAG=$(jq -r '.ETag' "${OOB_DIR}/current.json")
jq '.DistributionConfig | .Comment = "oob"' "${OOB_DIR}/current.json" >"${OOB_DIR}/config.json"
aws cloudfront update-distribution --id "${P2}" --if-match "${ETAG}" \
  --distribution-config "file://${OOB_DIR}/config.json" >/dev/null ||
  { echo "FAIL: 6b: the out-of-band Comment change of ${ID_SUBJECT} failed" >&2; exit 1; }
rm -rf "${OOB_DIR}"
run_drift
bucket=$(drift_bucket)
[ "${bucket}" = "drifted" ] || drift_fail "6b: cdkd drift put ${ID_SUBJECT} in bucket '${bucket}', expected drifted by its out-of-band Comment change"
paths=$(jq -c --arg id "${ID_SUBJECT}" '[.[].drifted[] | select(.logicalId == $id) | .changes[].path]' <<<"${DRIFT_OUT}") ||
  drift_fail "6b: cdkd drift's JSON report is unreadable for ${ID_SUBJECT}"
jq -e 'length > 0 and all(. == "DistributionConfig.Comment")' <<<"${paths}" >/dev/null ||
  drift_fail "6b: ${ID_SUBJECT} drifted by ${paths}, expected only DistributionConfig.Comment"
jq -e '[.[].drifted[]] | length == 1' <<<"${DRIFT_OUT}" >/dev/null ||
  drift_fail "6b: cdkd drift reports a drifted resource other than ${ID_SUBJECT}"
[ "${DRIFT_RC}" -ne 0 ] || drift_fail "6b: cdkd drift exited 0 although it reports ${ID_SUBJECT} drifted"
echo "    OK (6b): ${ID_SUBJECT} drifted by its out-of-band Comment change alone (rc=${DRIFT_RC})"

echo "==> Phase 7: Destroy on the flipped record + gone-probe"
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee /dev/stderr)
DESTROY_PLAIN=$(sed $'s/\033\\[[0-9;]*m//g' <<<"${DESTROY_OUT}")
grep -qF "${ID_SUBJECT} (${TYPE})" <<<"${DESTROY_PLAIN}" || {
  echo "FAIL: the destroy printed no line for ${ID_SUBJECT} (${TYPE})" >&2
  exit 1
}
assert_gone_as "distribution ${P2} survived its delete under the flipped id" NoSuchDistribution \
  aws cloudfront get-distribution --id "${P2}"
assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: destroyed clean"

echo "[verify] PASS -- cc-to-sdk-reroute-cloudfront-distribution (the distribution flipped in place under the Id both layers record)"
