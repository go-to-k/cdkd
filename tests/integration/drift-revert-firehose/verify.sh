#!/usr/bin/env bash
# verify.sh — cdkd integ for go-to-k/cdkd#7019.
#
# `cdkd drift --revert` on an S3-destination Firehose delivery stream failed
# whatever drifted:
#   InvalidArgumentException: Bucket ARN is required for S3 destination
# The read-back emits `{}` for every ExtendedS3 block AWS reports none of
# (S3BackupConfiguration, ProcessingConfiguration, DataFormatConversion-,
# DynamicPartitioningConfiguration), and the revert sent them back as written.
#
# Phases:
#   1. Deploy. Premise: both streams are SDK provisioned and the L2 stream's
#      baseline holds the `S3BackupConfiguration: {}` placeholder.
#   2. `cdkd drift` exits 0.
#   3. Out of band: BufferingHints 60 s / 1 MiB on both streams.
#   4. `cdkd drift` exits 1 and names both streams.
#   5. `cdkd drift --revert -y` exits 0 and keeps both streams (identity);
#      the live BufferingHints are 300 s / 5 MiB again.
#   6. `cdkd drift` exits 0.
#   7. Out of band: a Lambda processor on the L2 stream.
#   8. `cdkd drift` exits 1; `cdkd drift --revert -y` exits 0; the live
#      processing is disabled.
#   9. `cdkd drift` exits 0: AWS now reports the disabled block with explicit
#      members, which mean the same as the never-set block.
#  10. Destroy + gone-probes.
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
# shellcheck source=../revert-identity.sh
. ../revert-identity.sh
# shellcheck source=../cr-log-groups.sh
. ../cr-log-groups.sh

STACK="CdkdDriftRevertFirehoseExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
DRIFT_LOG=""
REVERT_DIR=""

# We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: destroying any leftover stack + state"
  set +eu
  rm -f "${DRIFT_LOG:-}"
  rm -f "${REVERT_DIR:-/nonexistent}"/revert-ids-* 2>/dev/null
  rmdir "${REVERT_DIR:-/nonexistent}" 2>/dev/null
  if [ -x "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
    node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --force >/dev/null 2>&1
  fi
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  fi
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/rollback-journal.json" >/dev/null 2>&1
  fi
  sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
# Created AFTER the pre-run cleanup above, which removes it (go-to-k/cdkd#6639).
REVERT_DIR="$(mktemp -d)"

run_drift() { # usage: run_drift [extra drift flags...] -> sets DRIFT_RC; output in DRIFT_LOG
  rm -f "${DRIFT_LOG:-}"
  DRIFT_LOG="$(mktemp)"
  set +e
  node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" "$@" \
    >"${DRIFT_LOG}" 2>&1
  DRIFT_RC=$?
  set -e
  sed 's/^/    | /' "${DRIFT_LOG}"
}
expect_drift_rc() { # usage: expect_drift_rc <want> <phase label>
  if [ "${DRIFT_RC}" != "$1" ]; then
    echo "FAIL: $2: cdkd drift exited ${DRIFT_RC}, want $1" >&2
    exit 1
  fi
}
# The logical id of the record whose constructPath is <path>.
logical_id_at() { # usage: logical_id_at <constructPath>
  jq -r --arg p "$1" '[.resources | to_entries[] | select(.value.constructPath == $p) | .key] | if length == 1 then .[0] else empty end' \
    <<<"${STATE_JSON}"
}
stream_dest() { # usage: stream_dest <stream name> <JMESPath under the ExtendedS3 description>
  aws firehose describe-delivery-stream --region "${REGION}" --delivery-stream-name "$1" \
    --query "DeliveryStreamDescription.Destinations[0].ExtendedS3DestinationDescription.$2" --output json
}
update_dest() { # usage: update_dest <stream name> <ExtendedS3DestinationUpdate JSON>
  local described version dest_id
  described="$(aws firehose describe-delivery-stream --region "${REGION}" --delivery-stream-name "$1" \
    --query 'DeliveryStreamDescription.[VersionId,Destinations[0].DestinationId]' --output text)" || return 1
  read -r version dest_id <<<"${described}"
  aws firehose update-destination --region "${REGION}" --delivery-stream-name "$1" \
    --current-delivery-stream-version-id "${version}" --destination-id "${dest_id}" \
    --extended-s3-destination-update "$2" >/dev/null
}
expect_hints() { # usage: expect_hints <stream name> <phase label>
  local hints
  hints="$(stream_dest "$1" 'BufferingHints' | jq -c '{s: .SizeInMBs, i: .IntervalInSeconds}')" || return 1
  if [ "${hints}" != '{"s":5,"i":300}' ]; then
    echo "FAIL: $2: $1 BufferingHints are ${hints}, want 5 MiB / 300 s" >&2
    exit 1
  fi
  echo "    ok: $2: $1 BufferingHints 5 MiB / 300 s"
}

echo "==> Phase 1: deploy"
node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
STATE_JSON="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)"
L2_ID="$(logical_id_at "${STACK}/L2/Resource")"
LEGACY_ID="$(logical_id_at "${STACK}/Legacy")"
PROCESSOR_ID="$(logical_id_at "${STACK}/Processor/Resource")"
BUCKET_ID="$(logical_id_at "${STACK}/Bucket/Resource")"
if [ -z "${L2_ID}" ] || [ -z "${LEGACY_ID}" ] || [ -z "${PROCESSOR_ID}" ] || [ -z "${BUCKET_ID}" ]; then
  echo "FAIL: Phase 1: the state lacks the L2 / Legacy stream, processor or bucket record" >&2
  exit 1
fi
pid_of() { jq -r --arg id "$1" '.resources[$id].physicalId // empty' <<<"${STATE_JSON}"; }
L2_STREAM="$(pid_of "${L2_ID}")"
LEGACY_STREAM="$(pid_of "${LEGACY_ID}")"
PROCESSOR="$(pid_of "${PROCESSOR_ID}")"
BUCKET="$(pid_of "${BUCKET_ID}")"
for id in "${L2_ID}" "${LEGACY_ID}"; do
  if [ "$(jq -r --arg id "${id}" '.resources[$id].provisionedBy // empty' <<<"${STATE_JSON}")" != "sdk" ]; then
    echo "FAIL: premise: ${id} is not SDK provisioned" >&2
    exit 1
  fi
done
# Premise: the baseline holds the empty backup placeholder the revert sent back.
if [ "$(jq -c --arg id "${L2_ID}" '.resources[$id].observedProperties.ExtendedS3DestinationConfiguration.S3BackupConfiguration' <<<"${STATE_JSON}")" != "{}" ]; then
  echo "FAIL: premise: the L2 baseline holds no S3BackupConfiguration placeholder" >&2
  exit 1
fi
PROCESSOR_ARN="$(aws lambda get-function --region "${REGION}" --function-name "${PROCESSOR}" \
  --query Configuration.FunctionArn --output text)"

echo "==> Phase 2: cdkd drift on the fresh stack reports no drift"
run_drift
expect_drift_rc 0 "Phase 2"

echo "==> Phase 3: change both streams' BufferingHints out of band"
for stream in "${L2_STREAM}" "${LEGACY_STREAM}"; do
  update_dest "${stream}" '{"BufferingHints":{"IntervalInSeconds":60,"SizeInMBs":1}}'
done

echo "==> Phase 4: cdkd drift reports both streams"
run_drift
expect_drift_rc 1 "Phase 4"
for id in "${L2_ID}" "${LEGACY_ID}"; do
  if ! grep -qF "${id} (AWS::KinesisFirehose::DeliveryStream)" "${DRIFT_LOG}"; then
    echo "FAIL: Phase 4: no drift block for ${id} — the report wording drifted" >&2
    exit 1
  fi
done

echo "==> Phase 5: cdkd drift --revert -y reverts both streams in place"
revert_identity_snapshot "${REVERT_DIR}/revert-ids-1-before" "${STACK}" "${L2_ID}" "${LEGACY_ID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-1-before" "${REVERT_DIR}/revert-ids-1-after" 2 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 5"
expect_hints "${L2_STREAM}" "Phase 5"
expect_hints "${LEGACY_STREAM}" "Phase 5"

echo "==> Phase 6: cdkd drift is clean again"
run_drift
expect_drift_rc 0 "Phase 6"

echo "==> Phase 7: attach a Lambda processor to the L2 stream out of band"
update_dest "${L2_STREAM}" "$(jq -cn --arg fn "${PROCESSOR_ARN}" \
  '{ProcessingConfiguration: {Enabled: true, Processors: [{Type: "Lambda", Parameters: [{ParameterName: "LambdaArn", ParameterValue: $fn}]}]}}')"

echo "==> Phase 8: cdkd drift reports it, and --revert disables processing"
run_drift
expect_drift_rc 1 "Phase 8 (drift)"
if ! grep -qF "ProcessingConfiguration.Enabled" "${DRIFT_LOG}"; then
  echo "FAIL: Phase 8: the drift report names no ProcessingConfiguration.Enabled change" >&2
  exit 1
fi
revert_identity_snapshot "${REVERT_DIR}/revert-ids-2-before" "${STACK}" "${L2_ID}" || exit 1
run_drift --revert -y
revert_identity_verify "${REVERT_DIR}/revert-ids-2-before" "${REVERT_DIR}/revert-ids-2-after" 1 "${DRIFT_LOG}" || exit 1
expect_drift_rc 0 "Phase 8 (revert)"
PROCESSING_ON="$(stream_dest "${L2_STREAM}" 'ProcessingConfiguration.Enabled')"
if [ "${PROCESSING_ON}" != "false" ]; then
  echo "FAIL: Phase 8: live ProcessingConfiguration.Enabled is ${PROCESSING_ON}, want false" >&2
  exit 1
fi
echo "    ok: Phase 8: processing disabled"

echo "==> Phase 9: cdkd drift reads the disabled block as the never-set one"
run_drift
expect_drift_rc 0 "Phase 9"

echo "==> Phase 10: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
for stream in "${L2_STREAM}" "${LEGACY_STREAM}"; do
  assert_gone "delivery stream ${stream} leaked" aws firehose describe-delivery-stream --region "${REGION}" --delivery-stream-name "${stream}"
done
assert_gone "function ${PROCESSOR} leaked" aws lambda get-function --region "${REGION}" --function-name "${PROCESSOR}"
assert_gone "bucket ${BUCKET} leaked" aws s3api head-bucket --bucket "${BUCKET}"
assert_gone "state ${STATE_KEY} leaked" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"

trap - EXIT INT TERM
sweep_stack_lambda_log_groups "${STACK}" "${REGION}"
rm -f "${DRIFT_LOG:-}"
rm -f "${REVERT_DIR}"/revert-ids-* 2>/dev/null || true
rmdir "${REVERT_DIR}" 2>/dev/null || true
echo "PASS: drift-revert-firehose"
