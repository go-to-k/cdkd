#!/usr/bin/env bash
# verify.sh — cdkd Lambda SELF-MANAGED Kafka ESM Endpoints key integ (#1384).
#
# CFn spells the bootstrap-server map key
# `SelfManagedEventSource.Endpoints.KafkaBootstrapServers`; the SDK models
# `Endpoints` as `Partial<Record<EndPointType, string[]>>` keyed by the enum
# value `KAFKA_BOOTSTRAP_SERVERS`. `Endpoints` is a MAP, so the serializer
# forwarded the unknown CFn key verbatim and CreateEventSourceMapping was
# REJECTED — a hard create failure for every CDK SelfManagedKafkaEventSource
# user. A successful Phase 1 deploy is therefore already the proof; the
# readback below pins the exact key AWS ended up with.
#
# The brokers are non-existent hosts and the mapping is created disabled, so
# nothing ever polls them — the API validates the request SHAPE, not
# connectivity.
#
# Phases:
#   1. Deploy. Assert the ESM exists and AWS reports the endpoints under the
#      SDK enum key with both broker strings.
#   2. Re-deploy with CDKD_TEST_UPDATE=true (batchSize 10 -> 20). Assert the
#      UUID is unchanged (in-place UpdateEventSourceMapping, no replacement)
#      and the endpoints survived the update.
#   3. Destroy + assert the function, the ESM and the state file are gone.
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

# Shared S3 VERSION-sweep helpers (issue #2096). The fixture stack declares its
# SASL/SCRAM secret with `unsafePlainText`, so those placeholder credentials sit
# in that resource's own state properties by construction. The state bucket is
# VERSIONED, so `aws s3 rm` only writes a delete marker and they stay readable.
. ../s3-versions.sh

STACK="CdkdLambdaEsmSelfManagedKafkaExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
FN="${STACK}-fn"
SECRET="${STACK}-kafka-auth"
EXPECTED_BROKERS="b-1.cdkd-integ.example.com:9092 b-2.cdkd-integ.example.com:9092"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup"
  set +eu
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
  for uuid in $(aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" --query 'EventSourceMappings[].UUID' --output text 2>/dev/null); do
    aws lambda delete-event-source-mapping --uuid "${uuid}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  aws lambda delete-function --function-name "${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  aws logs delete-log-group --log-group-name "/aws/lambda/${FN}" --region "${REGION}" >/dev/null 2>&1 || true
  # Force-delete so a re-run is not blocked by the 7-day recovery window.
  aws secretsmanager delete-secret --secret-id "${SECRET}" --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # The `aws s3 rm` above only wrote DELETE MARKERS. NONCURRENT-only here:
    # this runs from the pre-run sweep and the failure traps too, where a live
    # state.json may be the only record of resources still standing.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
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

esm_uuid() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query 'EventSourceMappings[0].UUID' --output text
}
# Bootstrap servers AWS reports, under the SDK's enum key. A missing key yields
# an empty string (the `|| ` + backtick-empty-array coalesces null INSIDE
# JMESPath so the CLI never errors on `join` receiving None, which under
# `set -e` would abort at the `$( )` assignment instead of hitting the FAIL
# branch below). SORTED because AWS does not preserve the submitted order —
# an order-sensitive compare fails intermittently (observed 2026-08-09: AWS
# returned b-2 before b-1).
esm_brokers() {
  aws lambda list-event-source-mappings --function-name "${FN}" --region "${REGION}" \
    --query "join(' ', sort(EventSourceMappings[0].SelfManagedEventSource.Endpoints.KAFKA_BOOTSTRAP_SERVERS || \`[]\`))" \
    --output text
}

# --- Phase 1: deploy ---------------------------------------------------
echo "==> Phase 1: deploy (self-managed Kafka ESM; create FAILED outright before #1384)"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

UUID_P1="$(esm_uuid)"
if [ -z "${UUID_P1}" ] || [ "${UUID_P1}" = "None" ]; then
  echo "FAIL: no event source mapping found on ${FN} after deploy" >&2
  exit 1
fi
echo "    ESM created (UUID=${UUID_P1})"

BROKERS_P1="$(esm_brokers)"
if [ "${BROKERS_P1}" != "${EXPECTED_BROKERS}" ]; then
  echo "FAIL: AWS reports Endpoints.KAFKA_BOOTSTRAP_SERVERS='${BROKERS_P1}', expected '${EXPECTED_BROKERS}' (issue #1384 NOT closed)" >&2
  aws lambda get-event-source-mapping --uuid "${UUID_P1}" --region "${REGION}" >&2
  exit 1
fi
echo "    OK: KafkaBootstrapServers translated to the SDK enum key and reached AWS"

# --- Phase 1.5: read-side inverse ---------------------------------------
# The persisted observedProperties spelling is the ONLY asymmetric probe for the
# read-side inverse. A `cdkd drift` run is NOT: its baseline is
# observedProperties, captured at deploy time from the SAME readCurrentState
# call, so both comparison sides pass through toCfnSelfManagedEventSource and
# the rename cancels — deleting the inverse (or renaming to a third key) leaves
# drift green. State, by contrast, must hold the CFn spelling the template used,
# so a missing inverse shows up immediately.
echo "==> Phase 1.5: observedProperties must hold the CFn spelling, and drift must be clean"
OBS_STATE=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" -)
OBS_ENDPOINTS=$(printf '%s' "${OBS_STATE}" | jq -r '
  [ .resources[] | select(.resourceType == "AWS::Lambda::EventSourceMapping")
                 | .observedProperties.SelfManagedEventSource.Endpoints // {} ] | first // {}')
if [ "$(printf '%s' "${OBS_ENDPOINTS}" | jq -r 'has("KafkaBootstrapServers")')" != "true" ]; then
  echo "FAIL: observedProperties Endpoints has no 'KafkaBootstrapServers' — the readCurrentState inverse is missing (issue #1384)" >&2
  echo "      raw: ${OBS_ENDPOINTS}" >&2
  exit 1
fi
if [ "$(printf '%s' "${OBS_ENDPOINTS}" | jq -r 'has("KAFKA_BOOTSTRAP_SERVERS")')" != "false" ]; then
  echo "FAIL: observedProperties Endpoints still carries the SDK enum key 'KAFKA_BOOTSTRAP_SERVERS' — the inverse did not run (issue #1384)" >&2
  echo "      raw: ${OBS_ENDPOINTS}" >&2
  exit 1
fi
echo "    OK: state holds the CFn spelling (readCurrentState inverse applied)"

# Belt-and-braces: the two sides must also agree end to end. Branch on the exit
# code — cdkd drift exits 1 for "drift found" and 2 for a command error, and
# conflating them reports an IAM/throttle failure as a real drift finding.
DRIFT_RC=0
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" || DRIFT_RC=$?
if [ "${DRIFT_RC}" = "1" ]; then
  echo "FAIL: cdkd drift reported drift on a freshly deployed stack" >&2
  exit 1
elif [ "${DRIFT_RC}" != "0" ]; then
  echo "FAIL: cdkd drift errored (exit ${DRIFT_RC}) — result undetermined" >&2
  exit 1
fi
echo "    OK: no drift"

# --- Phase 2: in-place update -----------------------------------------
# Wait out `Creating`: UpdateEventSourceMapping rejects a mapping that is still
# being created with ResourceInUseException, which is NOT in cdkd's retryable
# pattern table.
echo "==> Phase 2: wait for the ESM to settle, then re-deploy with CDKD_TEST_UPDATE=true (batchSize 10 -> 20)"
SETTLED=""
for _ in $(seq 1 24); do
  ESM_STATE="$(aws lambda get-event-source-mapping --uuid "${UUID_P1}" --region "${REGION}" \
    --query 'State' --output text)"
  # Gate on the TERMINAL set, not on "not Creating": Enabling / Disabling are
  # also in-flight states that would break the loop early.
  case "${ESM_STATE}" in
    Enabled | Disabled) SETTLED=1; break ;;
  esac
  sleep 5
done
[ -z "${SETTLED}" ] && { echo "FAIL: ESM ${UUID_P1} never reached Enabled/Disabled (last State=${ESM_STATE})" >&2; exit 1; }
echo "    ESM settled (State=${ESM_STATE})"
CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

UUID_P2="$(esm_uuid)"
if [ "${UUID_P2}" != "${UUID_P1}" ]; then
  echo "FAIL: ESM was REPLACED (${UUID_P1} -> ${UUID_P2}), expected an in-place update" >&2
  exit 1
fi
BATCH_P2="$(aws lambda get-event-source-mapping --uuid "${UUID_P2}" --region "${REGION}" \
  --query 'BatchSize' --output text)"
if [ "${BATCH_P2}" != "20" ]; then
  echo "FAIL: Phase 2 expected BatchSize 20, got '${BATCH_P2}'" >&2
  exit 1
fi
BROKERS_P2="$(esm_brokers)"
if [ "${BROKERS_P2}" != "${EXPECTED_BROKERS}" ]; then
  echo "FAIL: after update, Endpoints.KAFKA_BOOTSTRAP_SERVERS='${BROKERS_P2}', expected '${EXPECTED_BROKERS}'" >&2
  exit 1
fi
echo "    OK: in-place update kept the UUID and the endpoints"

# --- Phase 3: destroy --------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

GONE=""
for _ in $(seq 1 18); do
  if gone_probe aws lambda get-function --function-name "${FN}" --region "${REGION}"; then GONE=1; break; fi
  sleep 5
done
[ -z "${GONE}" ] && { echo "FAIL: function ${FN} still exists after destroy" >&2; exit 1; }
echo "    OK: function gone"

# DeleteEventSourceMapping is ASYNC: the mapping keeps answering 200 with
# State=Deleting for tens of seconds, so a bare assert_gone races (the same
# trap tests/integration/eventsourcemapping-race/verify.sh documents).
ESM_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws lambda get-event-source-mapping --uuid "${UUID_P1}" --region "${REGION}"; then ESM_GONE=1; break; fi
  sleep 5
done
[ -z "${ESM_GONE}" ] && { echo "FAIL: event source mapping ${UUID_P1} still exists after destroy" >&2; exit 1; }
echo "    OK: event source mapping gone"

# The Secret is the one resource this fixture adds beyond Lambda, and cleanup()
# force-deletes it on EXIT — so without an explicit assert here a destroy-path
# regression that strands it in a 7-day recovery window would pass green.
# DeleteSecret is eventually consistent the same way DeleteEventSourceMapping
# is: observed 2026-08-09, describe-secret still answered 200 right after a
# clean destroy and returned ResourceNotFoundException ~a minute later. Poll.
SECRET_GONE=""
for _ in $(seq 1 24); do
  if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET}" --region "${REGION}"; then SECRET_GONE=1; break; fi
  sleep 5
done
[ -z "${SECRET_GONE}" ] && { echo "FAIL: secret ${SECRET} still exists after destroy" >&2; exit 1; }
echo "    OK: secret gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# head-object only looks at the CURRENT object; the bucket is VERSIONED, so the
# placeholder SASL credentials survive in prior versions without this (issue
# #2096). On the success path, not only in `cleanup`, and asserted rather than
# assumed.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "lambda-esm-self-managed-kafka state teardown"

echo ""
echo "==> lambda-esm-self-managed-kafka test passed (issue #1384 closed + clean destroy + zero surviving state versions)"
