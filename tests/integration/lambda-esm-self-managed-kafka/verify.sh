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

STACK="CdkdLambdaEsmSelfManagedKafkaExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
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
  [ -x "${LOCAL_DIST}" ] && node "${LOCAL_DIST}" state destroy "${STACK}" --region "${REGION}" --yes >/dev/null 2>&1
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

# --- Phase 1.5: drift must be clean ------------------------------------
# The read-side inverse (SDK enum key -> CFn spelling) is otherwise unreachable
# from this fixture: readCurrentState feeds observedProperties / drift, which
# the deploy diff does not consume, so deleting it would leave every phase
# below green. A clean drift run is what proves the inverse.
echo "==> Phase 1.5: cdkd drift must report no drift"
if ! node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}"; then
  echo "FAIL: cdkd drift reported drift on a freshly deployed stack — the readCurrentState inverse for Endpoints is missing or wrong (issue #1384)" >&2
  exit 1
fi
echo "    OK: no drift (readCurrentState re-spells Endpoints back to the CFn key)"

# --- Phase 2: in-place update -----------------------------------------
# Wait out `Creating`: UpdateEventSourceMapping rejects a mapping that is still
# being created with ResourceInUseException, which is NOT in cdkd's retryable
# pattern table.
echo "==> Phase 2: wait for the ESM to settle, then re-deploy with CDKD_TEST_UPDATE=true (batchSize 10 -> 20)"
SETTLED=""
for _ in $(seq 1 24); do
  ESM_STATE="$(aws lambda get-event-source-mapping --uuid "${UUID_P1}" --region "${REGION}" \
    --query 'State' --output text)"
  if [ "${ESM_STATE}" != "Creating" ] && [ "${ESM_STATE}" != "Updating" ]; then SETTLED=1; break; fi
  sleep 5
done
[ -z "${SETTLED}" ] && { echo "FAIL: ESM ${UUID_P1} never left Creating/Updating" >&2; exit 1; }
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
assert_gone "secret ${SECRET} still exists after destroy" aws secretsmanager describe-secret --secret-id "${SECRET}" --region "${REGION}"
echo "    OK: secret gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state gone"

echo ""
echo "==> lambda-esm-self-managed-kafka test passed (issue #1384 closed + clean destroy)"
