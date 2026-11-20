#!/usr/bin/env bash
# verify.sh — cdkd S3 BucketPolicy create onto a bucket that already holds a
# policy (go-to-k/cdkd#6109).
#
# PutBucketPolicy replaces the bucket's WHOLE policy. Before the fix, cdkd's
# BucketPolicy create sent it blindly, so a policy another owner attached (in
# the wild: the grant a log-delivery service auto-attaches for a WAF / VPC
# Flow Logs destination) was silently dropped, where CloudFormation refuses
# the create with "The bucket policy already exists on bucket <name>".
#
# Phase 1: deploy the bucket alone; assert it holds no policy.
# Phase 2: attach the "other owner's" policy out of band, then deploy the
#          template's BucketPolicy. The deploy must FAIL with the refusal, and
#          the other owner's policy must survive the failed deploy (and its
#          rollback) untouched.
# Phase 3: remove that policy and re-deploy: the create now succeeds and the
#          bucket holds the template's statement (negative control: the guard
#          does not refuse an ordinary create).
# Phase 4: destroy; assert the bucket and state are gone.

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
. ../revert-identity.sh
REVERT_WORK=""

STACK="CdkdS3BucketPolicyExistingExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
BUCKET="cdkd-integ-bp-existing-${ACCOUNT}-${REGION}"
FOREIGN_SID="CdkdIntegForeignOwner"
TEMPLATE_SID="CdkdIntegTemplateStatement"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws s3api delete-bucket-policy --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  aws s3api delete-object --bucket "${BUCKET}" --key cdkd-6609-marker >/dev/null 2>&1 || true
  aws s3api delete-bucket --bucket "${BUCKET}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${REVERT_WORK:-}" ]; then
    rm -f "${REVERT_WORK}/revert-ids-3c-before" "${REVERT_WORK}/revert-ids-3c-after" "${REVERT_WORK}/revert-3c.log"
    rmdir "${REVERT_WORK}" >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  fi
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
REVERT_WORK="$(mktemp -d)"

# go-to-k/cdkd#6609 (slice C): the baseline captured right after cdkd's own
# write must hold the member the deploy just wrote. `cdkd drift` alone cannot
# see a stale baseline while the live member is the declared one (the drift
# heal rule skips the key then), so this reads the baseline itself: the state
# record's observed member must be exactly what AWS holds now, key order
# aside ('<absent>' when neither holds one).
state_json() { aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -; }
state_lids() { # usage: state_lids <resourceType> -- every logical id of that type
  state_json | jq -r --arg t "$1" '.resources | to_entries[] | select(.value.resourceType == $t) | .key'
}
assert_observed_member() { # usage: assert_observed_member <logical-id> <jq path into observedProperties> <live JSON, '' for none> <label>
  local recorded live
  recorded=$(state_json | jq -cS --arg l "$1" \
    ".resources[\$l].observedProperties as \$o | if \$o == null then \"<no baseline>\" else ((\$o | $2) // \"<absent>\") end") \
    || { echo "FAIL: cannot read the state record of $1 after $4" >&2; exit 1; }
  if [ -z "$3" ]; then live='"<absent>"'; else live=$(jq -cS . <<<"$3"); fi
  if [ "${recorded}" != "${live}" ]; then
    echo "FAIL: $1's recorded baseline $2 is not what AWS holds after $4 (#6609)" >&2
    echo "  recorded: ${recorded}" >&2
    echo "  live:     ${live}" >&2
    exit 1
  fi
  echo "    OK: $1's baseline $2 is the live value after $4 (#6609)"
}

# go-to-k/cdkd#6609: `cdkd drift --json` compares at least one resource of the
# type, none is left uncompared, and no drifted change sits on the member's
# path. The phase's env goes after the label, as `env` arguments.
check_member_baseline() { # usage: check_member_baseline <type> <key> <phase label> [env args...]
  local type="$1" key="$2" label="$3" report rc=0
  shift 3
  report=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${report}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report after ${label}" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  if ! jq -e --arg stack "${STACK}" --arg type "${type}" --arg key "${key}" '
    def member: .path == $key or (.path | startswith($key + ".")) or (.path | startswith($key + "["));
    [.[] | select(.stack == $stack)] as $reports |
    ($reports | length) == 1 and
    ([$reports[0].clean[], ($reports[0].drifted // [])[] | select(.type == $type)] | length) >= 1 and
    ([($reports[0].drifted // [])[] | select(.type == $type) | .changes[] | select(member)] | length) == 0 and
    ([($reports[0].notCompared // [])[] | select(.type == $type)] | length) == 0
  ' <<<"${report}" >/dev/null; then
    echo "FAIL: ${type} ${key} is drifted, or a ${type} is not compared, after ${label} (#6609)" >&2
    printf '%s\n' "${report}" >&2
    exit 1
  fi
  echo "    OK: every ${type} ${key} is drift-clean after ${label} (#6609)"
}

# The bucket's policy document, or the empty string when it holds none.
# Any other read failure fails the run.
bucket_policy() {
  local out
  if out="$(aws s3api get-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --query Policy --output text 2>&1)"; then
    printf '%s' "${out}"
    return 0
  fi
  if grep -q 'NoSuchBucketPolicy' <<<"${out}"; then
    return 0
  fi
  echo "FAIL: get-bucket-policy on ${BUCKET} failed: ${out}" >&2
  return 1
}

echo "==> Phase 1: deploy the bucket alone"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P1="$(bucket_policy)" || exit 1
if [ -n "${P1}" ]; then
  echo "FAIL: bucket ${BUCKET} already holds a policy after phase 1: ${P1}" >&2
  exit 1
fi
echo "    OK: bucket holds no policy"

echo "==> Phase 2: attach another owner's policy out of band, then deploy the template's BucketPolicy"
FOREIGN_POLICY="{\"Version\":\"2012-10-17\",\"Statement\":[{\"Sid\":\"${FOREIGN_SID}\",\"Effect\":\"Allow\",\"Principal\":{\"AWS\":\"arn:aws:iam::${ACCOUNT}:root\"},\"Action\":\"s3:ListBucket\",\"Resource\":\"arn:aws:s3:::${BUCKET}\"}]}"
aws s3api put-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --policy "${FOREIGN_POLICY}"
P2A="$(bucket_policy)" || exit 1
grep -q "${FOREIGN_SID}" <<<"${P2A}" || { echo "FAIL: the out-of-band policy did not attach: ${P2A}" >&2; exit 1; }

if OUT="$(CDKD_TEST_UPDATE=policy node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)"; then
  RC=0
else
  RC=$?
fi
printf '%s\n' "${OUT}" | tail -40
if [ "${RC}" -eq 0 ]; then
  echo "FAIL: the deploy succeeded over the existing bucket policy (go-to-k/cdkd#6109: the create overwrote it)" >&2
  exit 1
fi
MARKER="The bucket policy already exists on bucket ${BUCKET}"
# Sentinel: a second phrase of the same refusal, so a reworded refusal fails
# loudly instead of reading as "some other failure".
SENTINEL="cdkd does not overwrite it"
if ! grep -qF "${MARKER}" <<<"${OUT}"; then
  if grep -qF "${SENTINEL}" <<<"${OUT}"; then
    echo "FAIL: the refusal's wording drifted (sentinel present, marker '${MARKER}' absent)" >&2
  else
    echo "FAIL: the deploy failed (rc=${RC}) but not with the existing-policy refusal" >&2
  fi
  exit 1
fi
echo "    OK: the deploy refused with '${MARKER}' (rc=${RC})"
P2B="$(bucket_policy)" || exit 1
[ -n "${P2B}" ] || { echo "FAIL: the other owner's policy is gone after the refused deploy" >&2; exit 1; }
# Byte-exact after key-sorting: a rewrite that kept the Sid must fail too.
P2A_NORM="$(jq -S -c . <<<"${P2A}")" || { echo "FAIL: could not parse the policy read before the deploy: ${P2A}" >&2; exit 1; }
P2B_NORM="$(jq -S -c . <<<"${P2B}")" || { echo "FAIL: could not parse the policy read after the deploy: ${P2B}" >&2; exit 1; }
if [ "${P2A_NORM}" != "${P2B_NORM}" ]; then
  echo "FAIL: the other owner's policy changed across the refused deploy" >&2
  echo "  before: ${P2A_NORM}" >&2
  echo "  after:  ${P2B_NORM}" >&2
  exit 1
fi
echo "    OK: the other owner's policy survived the refused deploy untouched"

echo "==> Phase 3: remove the other owner's policy and re-deploy"
aws s3api delete-bucket-policy --bucket "${BUCKET}" --region "${REGION}"
CDKD_TEST_UPDATE=policy node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3="$(bucket_policy)" || exit 1
grep -q "${TEMPLATE_SID}" <<<"${P3}" || { echo "FAIL: the template's BucketPolicy is not on the bucket after phase 3: ${P3:-<no policy>}" >&2; exit 1; }
echo "    OK: the BucketPolicy create succeeded on a bucket with no policy"
POLICY_LID="$(state_lids AWS::S3::BucketPolicy)"
[ -n "${POLICY_LID}" ] || { echo "FAIL: no AWS::S3::BucketPolicy in state after phase 3" >&2; exit 1; }
assert_observed_member "${POLICY_LID}" .PolicyDocument "${P3}" "phase 3 (create)"
check_member_baseline AWS::S3::BucketPolicy PolicyDocument "phase 3 (create)" CDKD_TEST_UPDATE=policy

echo "==> Phase 3b: replace the BucketPolicy document (#6609)"
CDKD_TEST_UPDATE=policy,policy2 node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
P3B="$(bucket_policy)" || exit 1
grep -q "CdkdIntegTemplateStatement2" <<<"${P3B}" || { echo "FAIL: the replaced BucketPolicy lacks its second statement: ${P3B:-<no policy>}" >&2; exit 1; }
assert_observed_member "${POLICY_LID}" .PolicyDocument "${P3B}" "phase 3b (replace)"
check_member_baseline AWS::S3::BucketPolicy PolicyDocument "phase 3b (replace)" CDKD_TEST_UPDATE=policy,policy2

# go-to-k/cdkd#6609: `cdkd drift --revert` acts on what the capture recorded,
# so an out-of-band change of a member must report, revert to the template in
# place (same physical id, no delete / create), and leave drift clean.
revert_drift_json() { # usage: revert_drift_json [env args...] -- prints `cdkd drift --json`; exit 0..2 is a report
  local out rc=0
  out=$(env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --json) || rc=$?
  if [ "${rc}" -gt 2 ] || ! jq -e . >/dev/null 2>&1 <<<"${out}"; then
    echo "FAIL: cdkd drift exited ${rc} without a JSON report (#6609 revert arm)" >&2
    printf '%s\n' "${out}" >&2
    return 1
  fi
  printf '%s' "${out}"
}
assert_member_drifted() { # usage: assert_member_drifted <drift JSON> <type> <member key> <label>
  jq -e --arg t "$2" --arg k "$3" '
    def member: .path == $k or (.path | startswith($k + ".")) or (.path | startswith($k + "["));
    [.[] | (.drifted // [])[] | select(.type == $t) | .changes[] | select(member)] | length > 0
  ' <<<"$1" >/dev/null || {
    echo "FAIL: cdkd drift does not report the out-of-band $2 $3 after $4 (#6609)" >&2
    printf '%s\n' "$1" >&2
    exit 1
  }
  echo "    OK: cdkd drift reports the out-of-band $2 $3 after $4 (#6609)"
}
assert_drift_clean() { # usage: assert_drift_clean <label> [env args...]
  local rc=0 label="$1"
  shift
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" >/dev/null 2>&1 || rc=$?
  [ "${rc}" -eq 0 ] || { echo "FAIL: cdkd drift exited ${rc} after ${label}, want 0 (#6609)" >&2; exit 1; }
  echo "    OK: cdkd drift is clean after ${label} (#6609)"
}
run_revert() { # usage: run_revert [env args...]
  env "$@" node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --revert --yes
}
assert_same() { # usage: assert_same <label> <before> <after>
  [ -n "$2" ] && [ "$2" = "$3" ] || { echo "FAIL: $1 changed across the revert: '$2' -> '$3' (#6609: a delete / create)" >&2; exit 1; }
  echo "    OK: $1 unchanged across the revert ($2)"
}

echo "==> Phase 3c: an out-of-band bucket policy is reverted in place (#6609)"
# A marker object proves the bucket is the same one after the revert (a
# re-created bucket would not hold it); removed before destroy, which needs an
# empty bucket.
MARKER_BODY="$(mktemp)"
printf 'cdkd-6609' >"${MARKER_BODY}"
aws s3api put-object --bucket "${BUCKET}" --region "${REGION}" --key cdkd-6609-marker --body "${MARKER_BODY}" >/dev/null
rm -f "${MARKER_BODY}"
POLICY_PID_BEFORE="$(state_json | jq -r --arg l "${POLICY_LID}" '.resources[$l].physicalId')"
aws s3api put-bucket-policy --bucket "${BUCKET}" --region "${REGION}" --policy "${FOREIGN_POLICY}"
DRIFT_3C="$(revert_drift_json CDKD_TEST_UPDATE=policy,policy2)" || exit 1
assert_member_drifted "${DRIFT_3C}" AWS::S3::BucketPolicy PolicyDocument "an out-of-band put-bucket-policy"
# go-to-k/cdkd#6639: the helpers run right after the revert returns, before any
# assertion on its result; the revert's rc is captured, not acted on, first.
BUCKET_LID="$(state_lids AWS::S3::Bucket)"
[ -n "${BUCKET_LID}" ] || { echo "FAIL: no AWS::S3::Bucket in state before the phase 3c revert" >&2; exit 1; }
revert_identity_snapshot "${REVERT_WORK}/revert-ids-3c-before" "${STACK}" "${BUCKET_LID}" "${POLICY_LID}" || exit 1
REVERT_RC=0
run_revert CDKD_TEST_UPDATE=policy,policy2 2>&1 | tee "${REVERT_WORK}/revert-3c.log" || REVERT_RC=$?
revert_identity_verify "${REVERT_WORK}/revert-ids-3c-before" "${REVERT_WORK}/revert-ids-3c-after" 2 "${REVERT_WORK}/revert-3c.log" || exit 1
[ "${REVERT_RC}" -eq 0 ] || { echo "FAIL: cdkd drift --revert exited ${REVERT_RC} (phase 3c)" >&2; exit 1; }
P3C="$(bucket_policy)" || exit 1
[ "$(jq -cS . <<<"${P3C}")" = "$(jq -cS . <<<"${P3B}")" ] \
  || { echo "FAIL: the reverted bucket policy is not the template's: ${P3C:-<no policy>}" >&2; exit 1; }
echo "    OK: the revert put the template's bucket policy back"
assert_same "the BucketPolicy's state physical id" "${POLICY_PID_BEFORE}" \
  "$(state_json | jq -r --arg l "${POLICY_LID}" '.resources[$l].physicalId')"
aws s3api head-object --bucket "${BUCKET}" --key cdkd-6609-marker >/dev/null \
  || { echo "FAIL: the marker object is gone: the bucket was re-created by the revert (#6609)" >&2; exit 1; }
echo "    OK: the bucket still holds its marker object (not re-created)"
aws s3api delete-object --bucket "${BUCKET}" --key cdkd-6609-marker >/dev/null
assert_drift_clean "the phase 3c revert" CDKD_TEST_UPDATE=policy,policy2

echo "==> Phase 4: destroy"
CDKD_TEST_UPDATE=policy,policy2 node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
echo "    OK: bucket gone"
assert_gone "state ${STATE_KEY} remains after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"

rm -f "${REVERT_WORK}/revert-ids-3c-before" "${REVERT_WORK}/revert-ids-3c-after" "${REVERT_WORK}/revert-3c.log"
rmdir "${REVERT_WORK}"
trap - EXIT INT TERM
echo ""
echo "[verify] PASS — s3-bucket-policy-existing: a BucketPolicy create refuses an existing policy and leaves it intact"
