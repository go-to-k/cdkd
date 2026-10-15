#!/usr/bin/env bash
# verify.sh — local-invoke container-Lambda integ test (PR 5 of #224)
#
# Like `tests/integration/local-invoke/verify.sh` this is fully local —
# no AWS resources are deployed. We synthesize a CDK app whose only
# Lambda is a `lambda.DockerImageFunction` (Code.ImageUri) and exercise
# the local-build path of `cdkd local invoke` end-to-end.
#
# Run via `/run-integ local-invoke-container` (recommended) or directly:
#
#     bash tests/integration/local-invoke-container/verify.sh
#
# Requires Docker. The build pulls the AWS Lambda Node.js base image
# (~600MB) the first time.

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
BASE_IMAGE="public.ecr.aws/lambda/nodejs:20"

# --- capture ---------------------------------------------------------------
# Under `set -euo pipefail` the shape
#     VAR=$(${CDKD} local invoke ... 2>/dev/null | tail -1)
# aborts the WHOLE script at the ASSIGNMENT when the CLI exits non-zero:
# pipefail fails the pipeline, the substitution fails, `set -e` kills the
# script BEFORE the assertion, and the CLI's stderr is already gone -- a log
# that ends at `[2/4] Invoking ...` with no error text (issue #3106's lane
# paid a re-run to learn a transient had hit; issue #3126 swept the shape).
# `capture` runs the command with its exit status captured EXPLICITLY. On a
# non-zero exit it prints the status, the last stdout line and the tail of
# the captured stderr, and emits NOTHING on stdout -- the assertion still
# runs and FAILS with its own text, and a response that happened to look
# right never passes a failed invoke (the old shape's one merit, kept). On
# success it emits the last stdout line. The stderr file is per call and
# removed here, so the EXIT trap chain carries no entry for it. Every
# fixture that uses this block carries it byte-for-byte (copy
# CANONICAL_CAPTURE_BLOCK from scripts/check-integ-capture-shape.ts); the
# fence is tests/unit/scripts/integ-verify-capture-shape.test.ts.
capture() {
  local out err rc=0
  err="$(mktemp)"
  out="$("$@" 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "[verify] command exited ${rc}: $*" >&2
    echo "[verify] last stdout line: $(printf '%s\n' "${out}" | tail -1)" >&2
    echo "[verify] captured stderr (last 20 lines):" >&2
    tail -20 "${err}" >&2
    rm -f "${err}"
    return 0
  fi
  rm -f "${err}"
  printf '%s\n' "${out}" | tail -1
}
# --- stdout purity (go-to-k/cdkd#2429) ------------------------------------
# `invoke_split <stdout-file> <stderr-file> <cmd...>` runs an invoke with the
# two streams captured SEPARATELY; on a non-zero exit it prints both and fails
# here, before the trap removes them. `assert_one_json <stdout-file>
# <stderr-file>` then requires stdout to be EXACTLY one JSON document: before
# the fix, cdk-local's `Building container image ...` / `Skipping docker
# build ...` line sat on stdout above the response, a second line.
invoke_split() {
  local out_file="$1" err_file="$2" rc=0
  shift 2
  "$@" >"${out_file}" 2>"${err_file}" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    echo "FAIL: command exited ${rc}: $*"
    echo "stdout was:"; cat "${out_file}"
    echo "stderr was:"; cat "${err_file}"
    exit 1
  fi
}
assert_one_json() {
  node -e '
    const text = require("fs").readFileSync(process.argv[1], "utf8").trim();
    const lines = text.split("\n");
    if (lines.length !== 1) { console.error(`stdout has ${lines.length} lines, expected 1`); process.exit(1); }
    JSON.parse(text);
  ' "$1" || {
    echo "FAIL: stdout is not exactly one JSON document (go-to-k/cdkd#2429). stdout was:"
    cat "$1"
    echo "stderr was:"
    cat "$2"
    exit 1
  }
}

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${BASE_IMAGE} (one-time, ~600MB)"
docker pull "${BASE_IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

echo "==> Synthesizing fixture CDK app"
${CDKD} synth >/dev/null

# Test 1 — container-Lambda default empty event
# Uses --no-pull so docker build's --pull flag is not set (this is the
# default; --no-pull on the container-Lambda local-build path is
# documented as a no-op in CLI help — it still skips the public-base
# image's `docker pull` from the ZIP path which we did up front).
echo "==> [1/5] Invoking EchoHandler (container) with default empty event"
RESULT_1=$(capture ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --no-pull)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}
echo "${RESULT_1}" | grep -q '"fromContainer":true' || {
  echo "FAIL: expected fromContainer=true in response, got: ${RESULT_1}"
  exit 1
}

# Test 1b — a DEFAULT (building) invoke keeps stdout to the payload alone
# (go-to-k/cdkd#2429's headline case): `Building container image ...` is on
# stderr, and stdout is exactly one JSON document.
echo "==> [1b/5] Invoking EchoHandler (container build) with stdout and stderr split"
STDOUT_1B=$(mktemp)
STDERR_1B=$(mktemp)
trap 'rm -f "${STDOUT_1B}" "${STDERR_1B}"' EXIT
invoke_split "${STDOUT_1B}" "${STDERR_1B}" ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --no-pull
assert_one_json "${STDOUT_1B}" "${STDERR_1B}"
grep -q "Building container image" "${STDERR_1B}" || {
  echo "FAIL: the build did not log 'Building container image' on stderr. stdout / stderr were:"
  cat "${STDOUT_1B}" "${STDERR_1B}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/5] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${STDOUT_1B}" "${STDERR_1B}" "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(capture ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --event "${EVENT_FILE}" --no-pull)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override
echo "==> [3/5] Invoking EchoHandler with --env-vars override"
ENV_FILE=$(mktemp)
trap 'rm -f "${STDOUT_1B}" "${STDERR_1B}" "${EVENT_FILE}" "${ENV_FILE}"' EXIT
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(capture ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — --no-build (closes #233): the previous tests already built the
# image under the deterministic local tag, so a 4th invocation with
# --no-build should skip the rebuild and reuse the cached tag. stdout and
# stderr are captured SEPARATELY: the build-vs-skip lines
# (`Skipping docker build` / `Building container image`) come from
# cdk-local's own logger via the `buildContainerImage` shim, which cdkd routes
# through its own logger, so under the payload reservation they land on
# STDERR and stdout carries the response alone (go-to-k/cdkd#2429).
echo "==> [4/5] Invoking EchoHandler with --no-build (image must already be cached from steps 1-3)"
STDOUT_4=$(mktemp)
STDERR_4=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STDOUT_1B}" "${STDERR_1B}" "${STDOUT_4}" "${STDERR_4}"' EXIT
invoke_split "${STDOUT_4}" "${STDERR_4}" ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --no-pull --no-build
RESULT_4=$(cat "${STDOUT_4}")
echo "    response: ${RESULT_4}"
assert_one_json "${STDOUT_4}" "${STDERR_4}"
echo "${RESULT_4}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello (--no-build response), got: ${RESULT_4}"
  cat "${STDERR_4}"
  exit 1
}
grep -q "Skipping docker build" "${STDERR_4}" || {
  echo "FAIL: --no-build did not log 'Skipping docker build' on stderr. stdout / stderr were:"
  cat "${STDOUT_4}" "${STDERR_4}"
  exit 1
}
if grep -q "Building container image" "${STDOUT_4}" "${STDERR_4}"; then
  echo "FAIL: --no-build still logged 'Building container image' (rebuild happened despite --no-build). stdout / stderr were:"
  cat "${STDOUT_4}" "${STDERR_4}"
  exit 1
fi

# Test 5 — a `--verbose` build never prints a build-arg VALUE
# (go-to-k/cdkd#4967). The stack passes an obviously fake sentinel as a build
# arg. Both polarities: the build line IS logged with the key and the `***`
# marker, so the absence below cannot pass because nothing was logged.
echo "==> [5/5] --verbose container build masks the sentinel build-arg value"
SENTINEL="FAKE-SENTINEL-NOT-A-SECRET-7f1e"
STDOUT_5=$(mktemp)
STDERR_5=$(mktemp)
trap 'rm -f "${EVENT_FILE}" "${ENV_FILE}" "${STDOUT_1B}" "${STDERR_1B}" "${STDOUT_4}" "${STDERR_4}" "${STDOUT_5}" "${STDERR_5}"' EXIT
invoke_split "${STDOUT_5}" "${STDERR_5}" ${CDKD} local invoke CdkdLocalInvokeContainerFixture/EchoHandler --no-pull --verbose
grep -qF -- "--build-arg CDKD_SENTINEL_ARG=***" "${STDERR_5}" || {
  echo "FAIL: the --verbose build line with the masked build arg was not logged. stderr was:"
  cat "${STDERR_5}"
  exit 1
}
if grep -qF "${SENTINEL}" "${STDOUT_5}" "${STDERR_5}"; then
  echo "FAIL: the sentinel build-arg value reached the --verbose output (go-to-k/cdkd#4967)"
  grep -nF "${SENTINEL}" "${STDOUT_5}" "${STDERR_5}"
  exit 1
fi

echo ""
echo "==> All 5 local-invoke container-Lambda tests passed"
