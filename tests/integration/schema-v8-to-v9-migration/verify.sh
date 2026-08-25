#!/usr/bin/env bash
# verify.sh — cdkd state schema v8 -> v9 migration round-trip integ test
# (issue #2193).
#
# Proves that v8 -> v9 is transparently auto-migrated by the new binary AND
# that the new `exportNames` field closes the export-shadowing bug the v8
# binary has. Three stacks, because the bug is a three-party one:
#
#   Producer  EXPORTS `SHARED_NAME` (alias of its `ProducerArn` output).
#   Decoy     declares a PLAIN output NAMED `SHARED_NAME` — no Export — with
#             a different value.
#   Consumer  reads `Fn::ImportValue SHARED_NAME` into an SSM parameter.
#
#   1. Deploy Producer, then Decoy, then Consumer under the last v8 binary
#      (@go-to-k/cdkd@0.284.45). The v8 exports index takes EVERY output key
#      as an export and keeps the LAST writer, so the Consumer's parameter
#      holds the DECOY's value — the bug, reproduced on real AWS. All three
#      state files are `version: 8` and carry no `exportNames`.
#   2. Read the v8 state with the local v9 binary — must succeed with no
#      user-side migration action, and reading must not rewrite it.
#   3. Re-deploy Producer, Decoy, then Consumer under the local v9 binary.
#      Each must auto-migrate to `version: 9`; the Producer must write
#      `exportNames: [SHARED_NAME]`, the Decoy `exportNames: []` (written,
#      not omitted), and the Consumer must now hold the PRODUCER's value.
#   4. Destroy Consumer, Decoy, Producer with the v9 binary. State + AWS
#      resources both gone.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# The cdkd `/run-integ` skill exports both before invoking verify.sh.

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

PRODUCER_STACK="CdkdSchemaV8ToV9MigrationProducer"
DECOY_STACK="CdkdSchemaV8ToV9MigrationDecoy"
CONSUMER_STACK="CdkdSchemaV8ToV9MigrationConsumer"
REGION="${AWS_REGION:-us-east-1}"
PRODUCER_STATE_KEY="cdkd/${PRODUCER_STACK}/${REGION}/state.json"
DECOY_STATE_KEY="cdkd/${DECOY_STACK}/${REGION}/state.json"
CONSUMER_STATE_KEY="cdkd/${CONSUMER_STACK}/${REGION}/state.json"
PRODUCER_PARAM_NAME="/cdkd/schema-v8-to-v9-migration/producer"
DECOY_PARAM_NAME="/cdkd/schema-v8-to-v9-migration/decoy"
CONSUMER_PARAM_NAME="/cdkd/schema-v8-to-v9-migration/consumer"
SHARED_NAME="CdkdSchemaV8ToV9SharedName"

# The LATEST v8-shipped cdkd version on npm at the time this integ was
# written. Deploys under it produce real `version: 8` state files AND the
# real v8 exports index — the shadowing this fixture reproduces lives in
# that index, so a hand-written state blob would not do.
V8_CDKD_VERSION="0.284.45"
V8_TMPDIR=""
PRODUCER_V9_LOG=""
# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS probes"
  set +e
  # Consumer first (it imports), then the two producers of the shared name.
  if [ -x "${LOCAL_DIST}" ]; then
    for stack in "${CONSUMER_STACK}" "${DECOY_STACK}" "${PRODUCER_STACK}"; do
      node "${LOCAL_DIST}" state destroy "${stack}" --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    done
  fi
  # Direct API fallback so a half-deployed AWS resource doesn't leak.
  for param in "${CONSUMER_PARAM_NAME}" "${DECOY_PARAM_NAME}" "${PRODUCER_PARAM_NAME}"; do
    aws ssm delete-parameter --name "${param}" --region "${REGION}" >/dev/null 2>&1 || true
  done
  for stack in "${CONSUMER_STACK}" "${DECOY_STACK}" "${PRODUCER_STACK}"; do
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${REGION}/state.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${REGION}/lock.json" >/dev/null 2>&1 || true
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${REGION}/rollback-journal.json" >/dev/null 2>&1 || true
  done
  if [ -n "${V8_TMPDIR}" ] && [ -d "${V8_TMPDIR}" ]; then
    rm -rf "${V8_TMPDIR}"
  fi
  if [ -n "${PRODUCER_V9_LOG}" ] && [ -f "${PRODUCER_V9_LOG}" ]; then
    rm -f "${PRODUCER_V9_LOG}"
  fi
  set -e
}

trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: local v9 binary not built at ${LOCAL_DIST} — run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup (drop any stranded state / probes from a prior failed integ)"
cleanup

state_json() { # usage: state_json <state-key>
  aws s3 cp "s3://${STATE_BUCKET}/$1" - 2>/dev/null
}
assert_version() { # usage: assert_version <label> <state-key> <expected>
  local v
  v=$(state_json "$2" | jq -r '.version')
  if [ "${v}" != "$3" ]; then
    echo "FAIL: $1 state.version is ${v}, expected $3" >&2
    state_json "$2" | jq .
    exit 1
  fi
  echo "    OK: $1 state.version == $3"
}
param_value() { # usage: param_value <name>
  aws ssm get-parameter --name "$1" --region "${REGION}" --query 'Parameter.Value' --output text 2>/dev/null
}
param_arn() { # usage: param_arn <name>
  aws ssm get-parameter --name "$1" --region "${REGION}" --query 'Parameter.ARN' --output text 2>/dev/null
}

# --- Phase 1: deploy all three under the v8 binary -> the shadowing bug -----
V8_TMPDIR=$(mktemp -d)
echo "==> Installing @go-to-k/cdkd@${V8_CDKD_VERSION} into ${V8_TMPDIR} (the pre-PR v8 binary)"
( cd "${V8_TMPDIR}" && npm init -y >/dev/null && npm install --no-audit --no-fund "@go-to-k/cdkd@${V8_CDKD_VERSION}" >/dev/null )
V8_BIN="${V8_TMPDIR}/node_modules/@go-to-k/cdkd/dist/cli.js"
if [ ! -f "${V8_BIN}" ]; then
  echo "FAIL: v8 binary not found at ${V8_BIN} after install" >&2
  exit 1
fi

echo "==> Phase 1a: deploy Producer with v8 binary (cdkd ${V8_CDKD_VERSION}) -> exports ${SHARED_NAME}"
CDKD_TEST_SCHEMA_PHASE=v8 node "${V8_BIN}" deploy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_version "producer (v8 deploy)" "${PRODUCER_STATE_KEY}" 8

echo "==> Phase 1b: deploy Decoy with v8 binary -> a PLAIN output named ${SHARED_NAME}, the LAST writer of the index"
CDKD_TEST_SCHEMA_PHASE=v8 node "${V8_BIN}" deploy "${DECOY_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_version "decoy (v8 deploy)" "${DECOY_STATE_KEY}" 8

# The v8 binary must NOT have written `exportNames`. If it did, the chosen
# V8_CDKD_VERSION is actually v9+ and the pin is wrong.
for key in "${PRODUCER_STATE_KEY}" "${DECOY_STATE_KEY}"; do
  if [ "$(state_json "${key}" | jq -r 'has("exportNames")')" = "true" ]; then
    echo "FAIL: v8 binary wrote exportNames on ${key} (= wrong V8_CDKD_VERSION pin)" >&2
    state_json "${key}" | jq .
    exit 1
  fi
done
echo "    OK: v8 binary left exportNames unset on producer + decoy (correct)"

echo "==> Phase 1c: deploy Consumer with v8 binary -> Fn::ImportValue ${SHARED_NAME}"
CDKD_TEST_SCHEMA_PHASE=v8 node "${V8_BIN}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_version "consumer (v8 deploy)" "${CONSUMER_STATE_KEY}" 8

PRODUCER_ARN=$(param_arn "${PRODUCER_PARAM_NAME}")
DECOY_ARN=$(param_arn "${DECOY_PARAM_NAME}")
if [ -z "${PRODUCER_ARN}" ] || [ -z "${DECOY_ARN}" ] || [ "${PRODUCER_ARN}" = "${DECOY_ARN}" ]; then
  echo "FAIL: producer / decoy ARNs are not two distinct values (producer='${PRODUCER_ARN}', decoy='${DECOY_ARN}')" >&2
  exit 1
fi

# THE BUG, on real AWS: the v8 index served the decoy's plain output as the
# export, so the consumer holds the DECOY's ARN. This assertion is what makes
# the fixture discriminate — if a future v8 pin no longer reproduces it, the
# pin (or the premise) is wrong and the run must say so rather than pass.
CONSUMER_V8_VALUE=$(param_value "${CONSUMER_PARAM_NAME}")
if [ "${CONSUMER_V8_VALUE}" != "${DECOY_ARN}" ]; then
  echo "FAIL: under the v8 binary the consumer holds '${CONSUMER_V8_VALUE}', expected the DECOY's ARN '${DECOY_ARN}' (the shadowing bug did not reproduce — check V8_CDKD_VERSION)" >&2
  exit 1
fi
echo "    OK (bug reproduced): under v8 the consumer holds the DECOY's ARN, not the producer's"

# --- Phase 2: read v8 state with the v9 binary (transparent auto-migration on read) --
echo "==> Phase 2: read v8 producer state with v9 binary"
node "${LOCAL_DIST}" state show "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --stack-region "${REGION}" >/dev/null
echo "    OK: v9 binary read v8 producer state cleanly"
assert_version "producer (after read-only state show)" "${PRODUCER_STATE_KEY}" 8

# --- Phase 3: re-deploy under the v9 binary -> version: 9 + exportNames + rebound consumer --
echo "==> Phase 3a: re-deploy Producer with v9 binary -> version: 9, exportNames: [${SHARED_NAME}]"
PRODUCER_V9_LOG=$(mktemp)
CDKD_TEST_SCHEMA_PHASE=v9 node "${LOCAL_DIST}" deploy "${PRODUCER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1 | tee "${PRODUCER_V9_LOG}"
assert_version "producer (v9 deploy)" "${PRODUCER_STATE_KEY}" 9
PRODUCER_EXPORTS=$(state_json "${PRODUCER_STATE_KEY}" | jq -c '.exportNames')
if [ "${PRODUCER_EXPORTS}" != "[\"${SHARED_NAME}\"]" ]; then
  echo "FAIL: producer state.exportNames is ${PRODUCER_EXPORTS}, expected [\"${SHARED_NAME}\"]" >&2
  state_json "${PRODUCER_STATE_KEY}" | jq .
  exit 1
fi
echo "    OK: producer state.exportNames == [\"${SHARED_NAME}\"]"

# The index still holds the decoy's v8-era plain-name entry at this point, so
# the producer's re-index overwrites an entry another stack owns — the v9
# binary must SAY so (and name the transitional cause) rather than stay silent.
if ! grep -q "is published by both '${DECOY_STACK}'" "${PRODUCER_V9_LOG}"; then
  echo "FAIL: producer v9 deploy did not warn about the decoy's stale index entry" >&2
  cat "${PRODUCER_V9_LOG}"
  exit 1
fi
if ! grep -q "predates cdkd's state schema v9" "${PRODUCER_V9_LOG}"; then
  echo "FAIL: the duplicate-producer warning does not name the pre-v9 transitional cause" >&2
  cat "${PRODUCER_V9_LOG}"
  exit 1
fi
echo "    OK: producer v9 deploy warned about the decoy's stale entry (transitional, named as such)"

echo "==> Phase 3b: re-deploy Decoy with v9 binary -> version: 9, exportNames: [] (written, not omitted)"
CDKD_TEST_SCHEMA_PHASE=v9 node "${LOCAL_DIST}" deploy "${DECOY_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_version "decoy (v9 deploy)" "${DECOY_STATE_KEY}" 9
DECOY_STATE=$(state_json "${DECOY_STATE_KEY}")
if [ "$(echo "${DECOY_STATE}" | jq -r 'has("exportNames")')" != "true" ] || [ "$(echo "${DECOY_STATE}" | jq -c '.exportNames')" != "[]" ]; then
  echo "FAIL: decoy state.exportNames must be an EMPTY ARRAY (written), got: $(echo "${DECOY_STATE}" | jq -c '.exportNames // "absent"')" >&2
  echo "${DECOY_STATE}" | jq .
  exit 1
fi
# ... while its plain output is still there — only its export-ness changed.
if [ "$(echo "${DECOY_STATE}" | jq -r ".outputs[\"${SHARED_NAME}\"]")" != "${DECOY_ARN}" ]; then
  echo "FAIL: decoy plain output ${SHARED_NAME} should still be persisted in state.outputs" >&2
  echo "${DECOY_STATE}" | jq .
  exit 1
fi
echo "    OK: decoy state.exportNames == [] and its plain output is still in state.outputs"

echo "==> Phase 3c: re-deploy Consumer with v9 binary -> rebinds to the PRODUCER's export"
CDKD_TEST_SCHEMA_PHASE=v9 node "${LOCAL_DIST}" deploy "${CONSUMER_STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes
assert_version "consumer (v9 deploy)" "${CONSUMER_STATE_KEY}" 9

# The fix, on real AWS: same template, same three stacks, and the consumer now
# holds the PRODUCER's ARN.
CONSUMER_V9_VALUE=$(param_value "${CONSUMER_PARAM_NAME}")
if [ "${CONSUMER_V9_VALUE}" != "${PRODUCER_ARN}" ]; then
  echo "FAIL: under the v9 binary the consumer holds '${CONSUMER_V9_VALUE}', expected the PRODUCER's ARN '${PRODUCER_ARN}'" >&2
  exit 1
fi
echo "    OK (bug fixed): under v9 the consumer holds the PRODUCER's ARN"

# The consumer's strong-reference record must name the producer, not the decoy.
CONSUMER_IMPORT_SOURCE=$(state_json "${CONSUMER_STATE_KEY}" | jq -r '.imports[0].sourceStack')
if [ "${CONSUMER_IMPORT_SOURCE}" != "${PRODUCER_STACK}" ]; then
  echo "FAIL: consumer state.imports[0].sourceStack = '${CONSUMER_IMPORT_SOURCE}', expected '${PRODUCER_STACK}'" >&2
  state_json "${CONSUMER_STATE_KEY}" | jq .
  exit 1
fi
echo "    OK: consumer state.imports[0] names the producer"

# --- Phase 4: destroy under the v9 binary -> clean --------------------------
echo "==> Phase 4a: destroy Consumer with v9 binary"
node "${LOCAL_DIST}" destroy "${CONSUMER_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "consumer parameter still exists after destroy" aws ssm get-parameter --name "${CONSUMER_PARAM_NAME}" --region "${REGION}"
assert_gone "consumer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CONSUMER_STATE_KEY}"
echo "    OK: consumer is gone (AWS resource + state)"

echo "==> Phase 4b: destroy Decoy with v9 binary"
node "${LOCAL_DIST}" destroy "${DECOY_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "decoy parameter still exists after destroy" aws ssm get-parameter --name "${DECOY_PARAM_NAME}" --region "${REGION}"
assert_gone "decoy state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${DECOY_STATE_KEY}"
echo "    OK: decoy is gone (AWS resource + state)"

echo "==> Phase 4c: destroy Producer with v9 binary"
node "${LOCAL_DIST}" destroy "${PRODUCER_STACK}" --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force
assert_gone "producer parameter still exists after destroy" aws ssm get-parameter --name "${PRODUCER_PARAM_NAME}" --region "${REGION}"
assert_gone "producer state file still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PRODUCER_STATE_KEY}"
echo "    OK: producer is gone (AWS resource + state)"

echo ""
echo "==> schema-v8-to-v9-migration test passed (v8 shadowing reproduced, v9 transparent auto-migration + exportNames + consumer rebound)"
