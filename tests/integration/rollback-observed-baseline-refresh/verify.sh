#!/usr/bin/env bash
# verify.sh -- an in-place rollback restore refreshes the restored drift
# baseline (go-to-k/cdkd#6526).
#
# Phase 1 deploys v1: an S3 bucket whose one lifecycle rule carries no `Id`
# (S3 generates one on every PutBucketLifecycleConfiguration). Phase 2 deploys
# v2, which removes the rule and adds a queue that fails AFTER the bucket's
# update (out-of-range MessageRetentionPeriod, DependsOn the bucket), so the
# automatic rollback restores the bucket in place and S3 generates a NEW rule
# id. The fix re-reads the baseline after the restore: the state record must
# hold the new id and `cdkd drift` must report nothing. Before the fix the
# record kept v1's id and drift reported `LifecycleConfiguration.Rules`.
#
# go-to-k/cdkd#7129: the same stack holds a public hosted zone under a fake,
# never-delegated domain and a CNAME `www` (TTL 300, which CDK synthesizes as
# the string "300"). v2 renames it to `www2`, a replacement the Route 53
# provider runs delete-first, so the rollback RE-CREATES `www`. The re-created
# record must carry a fresh baseline (TTL the number 300) and drift must stay
# clean. Phase 3 repeats v2 under `--no-rollback` and reverts it with
# `cdkd rollback`, which drives the same replay from the command.

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
. ../s3-versions.sh

STACK="CdkdRollbackObservedBaseline"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
QUEUE_NAME="${STACK}-failing"
LOCAL_DIST="${PWD}/../../../dist/cli.js"
LOG_DIR="$(mktemp -d)"

ACCOUNT="$(aws sts get-caller-identity --query Account --output text)" || {
  echo "FAIL: could not read the account id" >&2
  exit 1
}
BUCKET="cdkd-rb-baseline-${ACCOUNT}-${REGION}"
# Region-scoped like BUCKET: a public zone name is not unique, and a peer run
# in another region must not have its zone torn down by this one.
ZONE_NAME="cdkd-rb-baseline-${ACCOUNT}-${REGION}.internal"
RECORD_ID="CnameCA570E29"

expect_eq() { # expect_eq <description> <actual> <expected>
  if [ "$2" != "$3" ]; then echo "FAIL: $1: expected '$3', got '$2'" >&2; exit 1; fi
  echo "    OK: $1 = '$3'"
}
live_rule_id() { # the generated id of the bucket's one lifecycle rule
  aws s3api get-bucket-lifecycle-configuration --bucket "${BUCKET}" --region "${REGION}" \
    --query 'Rules[0].ID' --output text
}
state_field() { # state_field <js expression over r, the bucket's record>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);const r=st.resources["BktDACB3953"];const v=('"$1"');process.stdout.write(v===undefined||v===null?"":String(v))})'
}

record_field() { # record_field <js expression over r, the CNAME's record>
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const st=JSON.parse(s);const r=st.resources["'"${RECORD_ID}"'"];const v=('"$1"');process.stdout.write(v===undefined||v===null?"":String(v))})'
}
zone_ids() { # every hosted zone named ZONE_NAME (a leftover may repeat it)
  aws route53 list-hosted-zones-by-name --dns-name "${ZONE_NAME}." --max-items 100 \
    --query "HostedZones[?Name=='${ZONE_NAME}.'].Id" --output text | tr '\t' '\n' | sed 's|^/hostedzone/||' | { grep -v '^None$' || [ $? -eq 1 ]; }
}
live_cnames() { # the zone's CNAME names, sorted, space-separated
  local zid
  zid="$(zone_ids | head -n1)"
  [ -n "${zid}" ] || { echo "FAIL: hosted zone ${ZONE_NAME} not found" >&2; exit 1; }
  aws route53 list-resource-record-sets --hosted-zone-id "${zid}" \
    --query "ResourceRecordSets[?Type=='CNAME'].Name" --output text | tr '\t' '\n' | LC_ALL=C sort | tr '\n' ' ' | sed 's/ $//'
}
delete_zone_leftovers() { # direct-API teardown of the zone and its non-apex records
  # Runs inside cleanup (set +eu): every failure WARNS, naming what may be
  # left billed, and a zone that fails does not stop the others' teardown.
  local zid zids batch
  if ! zids="$(zone_ids)"; then
    echo "WARNING: could not list hosted zones named ${ZONE_NAME}; a leftover zone may remain" >&2
    return 1
  fi
  for zid in ${zids}; do
    if ! batch="$(aws route53 list-resource-record-sets --hosted-zone-id "${zid}" --output json \
      | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const r=JSON.parse(s).ResourceRecordSets.filter(x=>x.Type!=="NS"&&x.Type!=="SOA");process.stdout.write(r.length?JSON.stringify({Changes:r.map(x=>({Action:"DELETE",ResourceRecordSet:x}))}):"")})')"; then
      echo "WARNING: could not list the records of hosted zone ${zid} (${ZONE_NAME}); it may remain" >&2
      continue
    fi
    if [ -n "${batch}" ] && ! aws route53 change-resource-record-sets --hosted-zone-id "${zid}" --change-batch "${batch}" >/dev/null 2>&1; then
      echo "WARNING: could not delete the records of hosted zone ${zid} (${ZONE_NAME}); it may remain" >&2
      continue
    fi
    if ! aws route53 delete-hosted-zone --id "${zid}" >/dev/null 2>&1; then
      echo "WARNING: could not delete hosted zone ${zid} (${ZONE_NAME}); it may remain" >&2
    fi
  done
}
assert_record_restored() { # assert_record_restored <phase label>
  expect_eq "$1: live CNAMEs are v1's (www re-created, www2 gone)" "$(live_cnames)" "www.${ZONE_NAME}."
  expect_eq "$1: restored record is v1's template (TTL as CDK spells it)" \
    "$(record_field 'typeof r.properties.TTL + ":" + r.properties.TTL')" "string:300"
  # go-to-k/cdkd#7129: the assertion only the fix passes. Before it the
  # re-created record had no baseline at all ("undefined:").
  expect_eq "$1: re-created record has a fresh baseline (TTL as AWS answers it)" \
    "$(record_field 'typeof r.observedProperties?.TTL + ":" + (r.observedProperties?.TTL ?? "")')" "number:300"
}

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -f "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  aws s3 rb "s3://${BUCKET}" --force --region "${REGION}" >/dev/null 2>&1
  local url
  url="$(aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}" --query QueueUrl --output text 2>/dev/null)"
  [ -n "${url}" ] && aws sqs delete-queue --queue-url "${url}" --region "${REGION}" >/dev/null 2>&1
  delete_zone_leftovers
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
  rm -rf "${LOG_DIR}"
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

[ -z "${STATE_BUCKET:-}" ] && { echo "FAIL: STATE_BUCKET required" >&2; exit 1; }
[ ! -f "${LOCAL_DIST}" ] && { echo "FAIL: build dist first" >&2; exit 1; }
[ -d node_modules ] || npm install
echo "==> Pre-run cleanup"; cleanup
LOG_DIR="$(mktemp -d)"

echo "==> Phase 1: deploy v1 (bucket with an id-less lifecycle rule, CNAME www)"
env -u ROLLBACK_BASELINE_FAIL node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

V1_ID="$(live_rule_id)"
if [ -z "${V1_ID}" ] || [ "${V1_ID}" = "None" ]; then
  echo "FAIL: v1 bucket has no lifecycle rule id" >&2; exit 1
fi
echo "    OK: v1 rule id generated by S3: ${V1_ID}"
expect_eq "v1 template declares no rule Id" \
  "$(state_field 'String(r.properties.LifecycleConfiguration.Rules[0].Id ?? "")')" ""
expect_eq "v1 baseline records the generated id" \
  "$(state_field 'r.observedProperties.LifecycleConfiguration.Rules[0].Id')" "${V1_ID}"

expect_eq "v1 live CNAME" "$(live_cnames)" "www.${ZONE_NAME}."
expect_eq "v1 record TTL as CDK spells it" \
  "$(record_field 'typeof r.properties.TTL + ":" + r.properties.TTL')" "string:300"
expect_eq "v1 record baseline TTL as AWS answers it" \
  "$(record_field 'typeof r.observedProperties?.TTL + ":" + (r.observedProperties?.TTL ?? "")')" "number:300"

echo "==> Phase 1: drift (expect none)"
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"

echo "==> Phase 2: deploy v2 (rule removed, www renamed to www2, failing queue after both) -- expect FAILURE"
set +e
ROLLBACK_BASELINE_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes >"${LOG_DIR}/deploy-v2.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy-v2.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the v2 deploy unexpectedly SUCCEEDED (the failing queue did not fail)" >&2
  exit 1
fi
echo "    OK: v2 deploy failed (rc=${DEPLOY_RC})"

# The rollback restored the bucket IN PLACE: the rule is back, and S3 gave it a
# NEW id. An unchanged id means the premise was not reproduced and the drift
# assertion below would pass on any binary.
RESTORED_ID="$(live_rule_id)"
if [ -z "${RESTORED_ID}" ] || [ "${RESTORED_ID}" = "None" ]; then
  echo "FAIL: the rollback did not restore the lifecycle rule" >&2; exit 1
fi
if [ "${RESTORED_ID}" = "${V1_ID}" ]; then
  echo "FAIL: premise not reproduced: the restored rule kept v1's id ${V1_ID}" >&2; exit 1
fi
echo "    OK: restored rule has a NEW generated id: ${RESTORED_ID}"
expect_eq "the failing queue left no state record" \
  "$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --region "${REGION}" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(String("FailingQueue" in JSON.parse(s).resources)))')" "false"
expect_eq "restored record is v1's template" \
  "$(state_field 'r.properties.LifecycleConfiguration.Rules[0].Prefix')" "tmp/"
# go-to-k/cdkd#6526: the assertion only the fix passes. The recorded id is
# named against BOTH live ids, so a run tells "never refreshed" (v1's id) from
# a read that answered something else (any other value).
RECORDED_ID="$(state_field 'r.observedProperties.LifecycleConfiguration.Rules[0].Id')"
if [ "${RECORDED_ID}" = "${V1_ID}" ]; then
  echo "FAIL: the restored baseline still holds v1's rule id ${V1_ID} (never refreshed; live is ${RESTORED_ID})" >&2
  exit 1
fi
expect_eq "restored baseline holds the id S3 generated on the restore" "${RECORDED_ID}" "${RESTORED_ID}"
if ! gone_probe aws sqs get-queue-url --queue-name "${QUEUE_NAME}" --region "${REGION}"; then
  echo "FAIL: failing queue ${QUEUE_NAME} exists -- the invalid CreateQueue should have been rejected" >&2
  exit 1
fi
echo "    OK: no failing queue left behind"
# go-to-k/cdkd#7129 premise: the rollback took the re-create arm for the record.
if ! grep -Eq "Reversing replacement of ${RECORD_ID} .*re-creating the old" "${LOG_DIR}/deploy-v2.log"; then
  echo "FAIL: premise not reproduced: the rollback did not reverse the record's replacement" >&2; exit 1
fi
echo "    OK: the rollback reversed the record's replacement"
assert_record_restored "Phase 2"

echo "==> Phase 2: drift after the rollback (expect none)"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  >"${LOG_DIR}/drift.log" 2>&1
DRIFT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/drift.log" || true
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift after the rollback exited ${DRIFT_RC} (go-to-k/cdkd#6526 / #7129: stale or missing restored baseline)" >&2
  exit 1
fi
echo "    OK: no drift after the rollback"

echo "==> Phase 3: deploy v2 under --no-rollback -- expect FAILURE, then cdkd rollback"
set +e
ROLLBACK_BASELINE_FAIL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes --no-rollback >"${LOG_DIR}/deploy-v2-norb.log" 2>&1
DEPLOY_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/deploy-v2-norb.log" || true
if [ "${DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the --no-rollback v2 deploy unexpectedly SUCCEEDED" >&2
  exit 1
fi
expect_eq "Phase 3: --no-rollback left the rename in place" "$(live_cnames)" "www2.${ZONE_NAME}."
node "${LOCAL_DIST}" rollback "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force \
  >"${LOG_DIR}/rollback.log" 2>&1 || { sed 's/^/  /' "${LOG_DIR}/rollback.log"; echo "FAIL: cdkd rollback failed" >&2; exit 1; }
sed 's/^/  /' "${LOG_DIR}/rollback.log" || true
if ! grep -Eq "Reversing replacement of ${RECORD_ID} .*re-creating the old" "${LOG_DIR}/rollback.log"; then
  echo "FAIL: premise not reproduced: cdkd rollback did not reverse the record's replacement" >&2; exit 1
fi
assert_record_restored "Phase 3"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" \
  >"${LOG_DIR}/drift-rb.log" 2>&1
DRIFT_RC=$?
set -e
sed 's/^/  /' "${LOG_DIR}/drift-rb.log" || true
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: cdkd drift after cdkd rollback exited ${DRIFT_RC} (go-to-k/cdkd#6526 / #7129)" >&2
  exit 1
fi
echo "    OK: no drift after cdkd rollback"

echo "==> Destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "bucket ${BUCKET} still exists after destroy" aws s3api head-bucket --bucket "${BUCKET}" --region "${REGION}"
echo "    OK: bucket gone"
# An assignment, so a failed lookup stops the run instead of reading as "gone".
ZONES_LEFT="$(zone_ids)"
expect_eq "hosted zone ${ZONE_NAME} gone after destroy" "$(tr '\n' ' ' <<<"${ZONES_LEFT}" | sed 's/ $//')" ""
assert_gone "state remains" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "rollback-observed-baseline-refresh state teardown"

echo ""
echo "==> rollback-observed-baseline-refresh test passed"
