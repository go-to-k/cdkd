#!/usr/bin/env bash
# verify.sh — local-invoke-layers integ test (PR 6 of #224, issue #232)
#
# Exercises Lambda Layers support in `cdkd local invoke`. Fully local —
# no AWS resources are deployed. The fixture stack defines one Lambda
# attached to three LayerVersions; Docker bind-mounts each layer's
# unzipped asset directory at `/opt` (read-only) so the handler can
# `require()` modules that only live in the layers.
#
# Run via `/run-integ local-invoke-layers` (recommended) or directly:
#
#     bash tests/integration/local-invoke-layers/verify.sh
#
# Requires Docker. The script pulls the Node.js base image up front so
# the run is self-sufficient.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"

# --- capture ---------------------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, `set -e` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone. That is
# how a transient during issue #3106's verification left a log ending at
# `[2/4] Invoking ...` with no error text at all. `capture` runs the command
# with its exit status captured EXPLICITLY, prints the status and the tail of
# the captured stderr on a non-zero exit, and still emits the last stdout
# line so the assertion runs, FAILS, and prints its own diagnostic — with
# the evidence in the log. (The shape cdk-local's twin fixture carries.)
CDKD_STDERR="$(mktemp)"
capture() {
  local out rc=0
  out="$("$@" 2>"${CDKD_STDERR}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${CDKD_STDERR}" >&2
  fi
  printf '%s\n' "${out}" | tail -1
}
trap 'rm -f "${CDKD_STDERR}"' EXIT

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Test 1 — multi-layer mounting works: handler can require() modules
# from BOTH the greetings layers AND the counters layer at the same
# /opt mount point.
echo "==> [1/4] Invoking EchoHandler (default empty event)"
EVENT_FILE=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${CDKD_STDERR}"' EXIT
echo '{"name":"alice","n":7}' > "${EVENT_FILE}"
RESULT_1=$(capture ${CDKD} local invoke CdkdLocalInvokeLayersFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_1}"

# 1a: counters layer — distinct module name, no path overlap.
echo "${RESULT_1}" | grep -q '"counterSource":"counters"' || {
  echo "FAIL: expected counterSource=counters (counters layer not mounted), got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"counter":"count=7"' || {
  echo "FAIL: expected counter=count=7, got: ${RESULT_1}"
  exit 1
}
# 1c: a RELATIVE symlink inside the counters layer (`bin/rel-link ->
# real.sh`) is executed THROUGH the link inside the container. Before issue
# #3106 the cpSync merge rewrote the link to the host's absolute asset path,
# so `/opt/bin/rel-link` was dangling in /opt and the handler threw ENOENT.
echo "${RESULT_1}" | grep -q '"linkOutput":"real-via-link"' || {
  echo "FAIL: expected linkOutput=real-via-link (relative layer symlink dangling in /opt, issue #3106), got: ${RESULT_1}"
  exit 1
}

# 1b: greetings layer — last-wins. Both GreetingsA and GreetingsB
# install /opt/nodejs/node_modules/util-greetings/index.js; the
# template declares Layers in order [A, B, Counters], so B's index.js
# must overwrite A's. cdkd merges the layer asset dirs into a single
# tmpdir on the host (cpSync recursive+force, in template order) and
# bind-mounts that at /opt — Docker rejects multiple -v ...:/opt:ro
# entries, so we cannot rely on overlay layering at the runtime.
echo "${RESULT_1}" | grep -q '"greetingSource":"greetings-b"' || {
  echo "FAIL: expected greetingSource=greetings-b (last-layer-wins), got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"greeting":"from-layer-B:hello-alice"' || {
  echo "FAIL: expected greeting=from-layer-B:hello-alice, got: ${RESULT_1}"
  exit 1
}

# Test 2 — different event payload exercises the same warm code path
# end-to-end (sanity check that nothing was cached as constants).
echo "==> [2/4] Invoking with a different event payload"
EVENT2=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${EVENT2}" "${CDKD_STDERR}"' EXIT
echo '{"name":"bob","n":42}' > "${EVENT2}"
RESULT_2=$(capture ${CDKD} local invoke CdkdLocalInvokeLayersFixture/EchoHandler --event "${EVENT2}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"greeting":"from-layer-B:hello-bob"' || {
  echo "FAIL: expected greeting=from-layer-B:hello-bob, got: ${RESULT_2}"
  exit 1
}
echo "${RESULT_2}" | grep -q '"counter":"count=42"' || {
  echo "FAIL: expected counter=count=42, got: ${RESULT_2}"
  exit 1
}

# Test 3 — startup banner mentions the 3 layer mounts. Combines
# stdout + stderr (since issue go-to-k/cdkd#2410 cdkd's `logger.info` on
# `local invoke` writes to STDERR, stdout being reserved for the response
# payload; we just want to verify the layer-count line appears somewhere in
# the cdkd output) so users know the layer wiring fired.
echo "==> [3/4] Verifying cdkd logs the layer count"
# `capture` is not used here: this assertion greps the MERGED stdout+stderr,
# which `capture` deliberately splits. Only the exit status needs handling --
# without it a non-zero cdkd abandons the script before the FAIL branch that
# prints the output. The diagnostic is already in LOG_OUTPUT.
LOG_RC=0
LOG_OUTPUT=$(${CDKD} local invoke CdkdLocalInvokeLayersFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>&1) || LOG_RC=$?
if [ "${LOG_RC}" -ne 0 ]; then
  echo "[verify] cdkd local invoke exited ${LOG_RC}; its output is echoed by the assertion below" >&2
fi
echo "${LOG_OUTPUT}" | grep -q 'Mounting 3 Lambda layers at /opt' || {
  echo "FAIL: expected 'Mounting 3 Lambda layers' message in cdkd output, got:"
  echo "${LOG_OUTPUT}"
  exit 1
}

# Test 4 (issue #2143) — the layer-version ARN parse derives the partition
# from the region rather than matching a hand-written alternation, so a
# literal-ARN layer whose partition and region DISAGREE is refused at
# resolution time. `MismatchedArnLayerHandler` carries
# `arn:aws-cn:lambda:us-east-1:...`; pre-#2143 that ARN parsed and cdkd went
# on to attempt a `lambda:GetLayerVersion` download, so this assertion is
# discriminating rather than decorative.
#
# It is the half of #2143 an integ CAN exercise: the five partitions the old
# alternation omitted (`aws-iso*`, `aws-eusc`) have no endpoint reachable from
# a normal dev account, whereas a mismatch is decided locally with no network
# call at all. What it adds over the unit matrix is that this runs the SHIPPED
# `dist/` bundle, which is where a broken `src/local` -> `src/utils` import
# would show up.
echo "==> [4/4] Verifying a partition/region-mismatched layer ARN is refused"
set +e
MISMATCH_OUTPUT=$(${CDKD} local invoke CdkdLocalInvokeLayersFixture/MismatchedArnLayerHandler --event "${EVENT_FILE}" --no-pull 2>&1)
MISMATCH_RC=$?
set -e
if [[ ${MISMATCH_RC} -eq 0 ]]; then
  echo "FAIL: expected a non-zero exit for the mismatched layer ARN, got 0. Output:"
  echo "${MISMATCH_OUTPUT}"
  exit 1
fi
echo "${MISMATCH_OUTPUT}" | grep -q 'cdkd cannot resolve locally' || {
  echo "FAIL: expected the layer-resolution refusal for the mismatched ARN, got:"
  echo "${MISMATCH_OUTPUT}"
  exit 1
}
echo "${MISMATCH_OUTPUT}" | grep -q 'arn:aws-cn:lambda:us-east-1:111122223333:layer:Mismatched:1' || {
  echo "FAIL: expected the refusal to name the offending ARN, got:"
  echo "${MISMATCH_OUTPUT}"
  exit 1
}
# The refusal must name the DERIVATION, not merely refuse: a bundle whose
# layer parse broke wholesale would also refuse, and would satisfy the two
# greps above. This sentence only exists on the partition-mismatch arm.
echo "${MISMATCH_OUTPUT}" | grep -qF "The partition 'aws-cn' does not match region 'us-east-1': no partition prefix matches that region, so cdkd resolves it to the commercial partition 'aws'." || {
  echo "FAIL: expected the refusal to name the partition/region disagreement, got:"
  echo "${MISMATCH_OUTPUT}"
  exit 1
}
echo "    refused as expected (exit ${MISMATCH_RC})"

echo ""
echo "==> All 4 local-invoke-layers tests passed"
