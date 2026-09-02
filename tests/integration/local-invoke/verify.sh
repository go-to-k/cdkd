#!/usr/bin/env bash
# verify.sh — local-invoke integ test
#
# Unlike most integ tests this one is fully local: no AWS resources are
# deployed. The test exercises `cdkd local invoke` end-to-end against
# Docker + the AWS Lambda Node.js base image, which bundles the Runtime
# Interface Emulator (RIE).
#
# Run via `/run-integ local-invoke` (recommended) or directly:
#
#     bash tests/integration/local-invoke/verify.sh
#
# Requires Docker. The script pulls the base image up front so the run
# is self-sufficient (no special-case skill change needed).

set -euo pipefail

cd "$(dirname "$0")"

CDKD="node ../../../dist/cli.js"
IMAGE="public.ecr.aws/lambda/nodejs:20"

echo "==> Verifying Docker is available"
docker version --format '{{.Server.Version}}' >/dev/null

echo "==> Pulling ${IMAGE} (one-time, ~600MB)"
docker pull "${IMAGE}"

echo "==> Installing fixture deps"
if [[ ! -d node_modules ]]; then
  vp install --prefer-offline
fi

# Synth, with the two streams captured SEPARATELY rather than discarded.
# Issue go-to-k/cdkd#2410 moved `cdkd synth`'s default output contract --
# stdout is the CloudFormation template and nothing else, every log line goes
# to stderr -- and until this assertion existed that contract had no live
# coverage at all: `cdkd synth` runs in ~20 verify.sh scripts and every one of
# them sends it to /dev/null, so the unit suites were the only thing holding
# it. Asserted here rather than in a new fixture because this one already
# synthesizes the app.
#
# Deliberately NOT asserted: that the template PARSES. `toYaml` still leaves
# YAML indicator characters unquoted, so a template containing `"*"` emits a
# bare `- *` a parser rejects (issue go-to-k/cdkd#2421). That is a serializer
# defect, not a stream one; asserting it here would red on an unrelated fix.
echo "==> Synthesizing fixture CDK app (and asserting the stdout/stderr split)"
SYNTH_OUT=$(mktemp)
SYNTH_ERR=$(mktemp)
# This script's convention is an ACCUMULATING EXIT trap: each later `trap`
# RE-DECLARES the whole list rather than adding to it, so a new temp file must
# be threaded through every subsequent declaration or the one that follows
# silently disarms its cleanup. Adding these two here alone leaked them.
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}"' EXIT
${CDKD} synth >"${SYNTH_OUT}" 2>"${SYNTH_ERR}"

# stdout is the template: it must start at a template key and carry NO prose.
grep -q '^Resources:' "${SYNTH_OUT}" || {
  echo "FAIL: cdkd synth stdout does not contain a top-level 'Resources:' key"
  echo "--- stdout ---"; cat "${SYNTH_OUT}"
  exit 1
}
for PROSE in 'Synthesizing CDK app' 'Synthesis complete' 'Output:'; do
  grep -qF "${PROSE}" "${SYNTH_OUT}" && {
    echo "FAIL: cdkd synth leaked prose onto stdout: ${PROSE}"
    echo "--- stdout ---"; cat "${SYNTH_OUT}"
    exit 1
  }
  # ...and the same line must have ARRIVED on stderr, not merely be absent
  # from stdout -- the reservation MOVES lines, it does not suppress them.
  grep -qF "${PROSE}" "${SYNTH_ERR}" || {
    echo "FAIL: cdkd synth prose missing from stderr (suppressed, not moved): ${PROSE}"
    echo "--- stderr ---"; cat "${SYNTH_ERR}"
    exit 1
  }
done
echo "    stdout: template only ($(wc -l <"${SYNTH_OUT}" | tr -d ' ') lines); stderr: prose ($(wc -l <"${SYNTH_ERR}" | tr -d ' ') lines)"

# Same contract on `cdkd list`, which had even less live coverage than synth:
# it appears in ZERO verify.sh scripts. Issue go-to-k/cdkd#2410 made its
# reservation UNCONDITIONAL -- every mode's stdout is a payload, not just the
# `--json` spellings -- so the default one-id-per-line mode is asserted here,
# which is the mode a shell loop reads and the one the flag-keyed reservation
# used to leave corruptible. Rides this fixture because it already synthesizes
# the app; no new fixture.
echo "==> Asserting cdkd list keeps stdout to the payload"
LIST_OUT=$(mktemp)
LIST_ERR=$(mktemp)
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}" "${LIST_OUT}" "${LIST_ERR}"' EXIT
${CDKD} list --verbose >"${LIST_OUT}" 2>"${LIST_ERR}"

# Every stdout line must be a stack id and nothing else. `--verbose` is what
# makes this discriminating: it guarantees the logger has lines to emit, so a
# reservation regression shows up as extra stdout lines rather than as an
# empty diff.
while IFS= read -r LINE; do
  [[ -n "${LINE}" ]] || continue
  [[ "${LINE}" == "CdkdLocalInvokeFixture" ]] || {
    echo "FAIL: cdkd list stdout carried a non-payload line: ${LINE}"
    echo "--- stdout ---"; cat "${LIST_OUT}"
    exit 1
  }
done <"${LIST_OUT}"
grep -q 'DEBUG' "${LIST_ERR}" || {
  echo "FAIL: cdkd list --verbose produced no debug output on stderr, so this assertion proves nothing"
  echo "--- stderr ---"; cat "${LIST_ERR}"
  exit 1
}
echo "    stdout: ids only ($(wc -l <"${LIST_OUT}" | tr -d ' ') lines); stderr: debug ($(wc -l <"${LIST_ERR}" | tr -d ' ') lines)"

# Test 1 — asset-backed Lambda echoes event + env var
echo "==> [1/6] Invoking EchoHandler with default empty event"
RESULT_1=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_1}"
echo "${RESULT_1}" | grep -q '"greeting":"hello"' || {
  echo "FAIL: expected greeting=hello in response, got: ${RESULT_1}"
  exit 1
}

# Test 2 — event payload via --event
echo "==> [2/6] Invoking EchoHandler with --event payload"
EVENT_FILE=$(mktemp)
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}" "${LIST_OUT}" "${LIST_ERR}" "${EVENT_FILE}"' EXIT
echo '{"key":"value","n":42}' > "${EVENT_FILE}"
RESULT_2=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --event "${EVENT_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_2}"
echo "${RESULT_2}" | grep -q '"key":"value"' || {
  echo "FAIL: expected echoed key=value, got: ${RESULT_2}"
  exit 1
}

# Test 3 — --env-vars override (Parameters)
echo "==> [3/6] Invoking EchoHandler with --env-vars Parameters block"
ENV_FILE=$(mktemp)
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}" "${LIST_OUT}" "${LIST_ERR}" "${EVENT_FILE}" "${ENV_FILE}"' EXIT
# Use a wildcard `Parameters` block so the test doesn't break if the
# L1 logical ID changes.
echo '{"Parameters":{"GREETING":"overridden"}}' > "${ENV_FILE}"
RESULT_3=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --env-vars "${ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_3}"
echo "${RESULT_3}" | grep -q '"greeting":"overridden"' || {
  echo "FAIL: expected greeting=overridden, got: ${RESULT_3}"
  exit 1
}

# Test 4 — --env-vars function-specific key by display path
echo "==> [4/6] Invoking EchoHandler with --env-vars display-path key"
DP_ENV_FILE=$(mktemp)
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}" "${LIST_OUT}" "${LIST_ERR}" "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}"' EXIT
# The display-path key matches `Metadata['aws:cdk:path']` — i.e. the
# same form `cdkd local invoke <target>` already accepts.
echo '{"CdkdLocalInvokeFixture/EchoHandler":{"GREETING":"path-key-overridden"}}' > "${DP_ENV_FILE}"
RESULT_4=$(${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --env-vars "${DP_ENV_FILE}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_4}"
echo "${RESULT_4}" | grep -q '"greeting":"path-key-overridden"' || {
  echo "FAIL: expected greeting=path-key-overridden, got: ${RESULT_4}"
  exit 1
}

# Test 5 — inline (Code.ZipFile) Lambda
echo "==> [5/6] Invoking InlineHandler (Code.ZipFile)"
INLINE_EVENT=$(mktemp)
trap 'rm -f "${SYNTH_OUT}" "${SYNTH_ERR}" "${LIST_OUT}" "${LIST_ERR}" "${EVENT_FILE}" "${ENV_FILE}" "${DP_ENV_FILE}" "${INLINE_EVENT}"' EXIT
echo '{"hi":"there"}' > "${INLINE_EVENT}"
RESULT_5=$(${CDKD} local invoke CdkdLocalInvokeFixture/InlineHandler --event "${INLINE_EVENT}" --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_5}"
echo "${RESULT_5}" | grep -q '"inlineEcho":{"hi":"there"}' || {
  echo "FAIL: expected inlineEcho={hi:there}, got: ${RESULT_5}"
  exit 1
}

# Test 6 — the container's own AWS_REGION arrives CANONICAL (issue #1836)
#
# COVERAGE LIMIT, stated rather than implied: this arm exercises the DEFAULT
# credential path only (`forwardAwsEnv` in src/cli/commands/local-invoke.ts).
# The `--assume-role` STS chain is deliberately NOT exercised here — it needs a
# real assumable IAM role, and this fixture deploys nothing to AWS at all. That
# chain is covered by the feared-shape unit assertions in
# tests/unit/cli/local-region-case.test.ts (which assert the STSClient's own
# constructor region), so the Docker arm stays Docker-only.
#
# Both polarities: the upper-cased shell must produce the canonical container
# value, and the already-canonical shell must produce byte-identical output.
echo "==> [6/6] Invoking EchoHandler with an UPPER-CASED AWS_REGION (region-case fold)"
RESULT_6=$(AWS_REGION=US-EAST-1 AWS_DEFAULT_REGION=US-EAST-1 ${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    response: ${RESULT_6}"
echo "${RESULT_6}" | grep -q '"awsRegion":"us-east-1"' || {
  echo "FAIL: expected the container AWS_REGION to arrive canonical (us-east-1), got: ${RESULT_6}"
  exit 1
}
# The shape the regression emits: the raw spelling forwarded verbatim, which the
# handler's SDK clients then resolve against the WRONG partition's endpoint.
echo "${RESULT_6}" | grep -q '"awsRegion":"US-EAST-1"' && {
  echo "FAIL: container AWS_REGION carried the raw upper-cased spelling: ${RESULT_6}"
  exit 1
}
RESULT_6B=$(AWS_REGION=us-east-1 AWS_DEFAULT_REGION=us-east-1 ${CDKD} local invoke CdkdLocalInvokeFixture/EchoHandler --no-pull 2>/dev/null | tail -1)
echo "    counter-case response: ${RESULT_6B}"
[ "${RESULT_6}" = "${RESULT_6B}" ] || {
  echo "FAIL: an already-canonical AWS_REGION must be byte-identical to the folded one"
  echo "  upper: ${RESULT_6}"
  echo "  lower: ${RESULT_6B}"
  exit 1
}

echo ""
echo "==> All 6 local-invoke tests passed"
