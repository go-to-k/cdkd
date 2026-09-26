#!/usr/bin/env bash
# verify.sh — a `NoEcho` custom-resource value crossing a STACK boundary
# (issue #2460, the real-AWS coverage of issue #2274's cross-stack recovery).
#
# THE MECHANISM UNDER TEST. Since #2274 an output whose value resolves a
# `NoEcho` custom resource's `Data` is persisted as the mask `***`. Every
# cross-stack route reads the PRODUCER's persisted outputs, so without a
# recovery the first deploy of a consumer is REFUSED. The recovery is
# `DeployEngine.rememberRecoverableMaskedOutputs` recording, for THIS PROCESS,
# `stack + region + output key -> plaintext`, read back by
# `NestedStackProvider.readChildOutputsAsAttributes` (a nested stack's
# `Outputs.<Key>`, reported PER ATTRIBUTE via `noEchoAttributeNames`) and by
# `IntrinsicFunctionResolver.reresolveCrossStackValue` (`Fn::ImportValue`).
# Unit tests fence it with mocks that encode cdkd's own belief about the
# ordering; this is the measurement.
#
# THREE STACKS, ONE `cdkd deploy --all`:
#   CdkdCrNoEchoNestedExample    parent; nested child `~Child` holds a NoEcho CR
#                                and an ordinary CR, each feeding a child output,
#                                plus a literal output; three parent SSM
#                                parameters read them through
#                                `Fn::GetAtt [Child, 'Outputs.<Key>']`.
#   CdkdCrNoEchoProducerExample  exports a NoEcho CR value and an ordinary one,
#                                and reads the NoEcho one into its own SSM
#                                parameter (a SAME-STACK reader).
#   CdkdCrNoEchoConsumerExample  imports both into two SSM parameters.
#   CdkdCrNoEchoParamExample     a NoEcho CR fed to nested child ParamChild as a
#                                stack parameter, and an ordinary CR whose
#                                physical id moves with its Seed, read by Ref.
#
# PHASES:
#   1. deploy --all (verbose, captured). Recovery: both consumers of the NoEcho
#      value hold the REAL token on AWS. Non-disclosure: every persisted copy
#      (child outputs + CR attributes, the parent's nested-stack row, the
#      parent / consumer parameters' properties, the producer's outputs) is
#      `***`, and the token appears in no state blob, no object VERSION under
#      the four stack prefixes, no version of the shared exports index, and not
#      in the verbose deploy log. NEGATIVE CONTROL: the ordinary value crosses
#      the same boundaries and stays in the clear everywhere, which is what the
#      per-attribute (`noEchoAttributeNames`) shape exists for.
#   2. `cdkd diff --all --recursive --fail` exits 0 (no perpetual change from a
#      masked leaf), and prints no token.
#   3. deploy --all with CDKD_TEST_UPDATE=seed: both child CRs' `Seed`
#      changes, so the recovery runs on `NestedStackProvider.update`. No parent
#      parameter has an own-property change: each new value reaches AWS only
#      because the diff promotes a reader of an updated nested stack's
#      `Outputs.<Key>` (go-to-k/cdkd#3631). The parent NoEchoParam holds the
#      NEW token on AWS although its record and its redacted value are both
#      `***` (go-to-k/cdkd#3662: the engine's post-resolution skip used to read
#      that as no change), every persisted copy is still `***`, and neither
#      token is disclosed. StaticParam, reading the output no phase moves, is
#      promoted and then SKIPPED by the engine's re-resolve (both log lines
#      asserted). The
#      producer / consumer pair is NO_CHANGE over a mask an EARLIER run wrote:
#      the deploy must still exit 0 (a masked output read is not fatal by
#      default — never add the strict-GetAtt flag here) and the consumer's live
#      value must not become `***`.
#   4. deploy --all with CDKD_TEST_UPDATE=seed,producer-seed: the nested tree
#      is NO_CHANGE over phase 3's masks, and the producer's NoEcho CR `Seed`
#      flips, so the consumer's diff and its UPDATE both resolve the export
#      through the recovery. The consumer holds the NEW producer token on AWS,
#      every copy is still `***`, and no token is disclosed. The consumer has no
#      own-property change, so both the diff's UPDATE (Value alone) and the new
#      token on AWS need the recovery, and the latter also needs the engine not
#      to skip `***` == `***` (go-to-k/cdkd#3662, measured on this fixture's
#      first phase-4 run before the fix). The producer's same-stack reader
#      holds the new token too: the diff promotes a reader of an updated custom
#      resource's attributes, and the engine sends it.
#   5. deploy --all with CDKD_TEST_UPDATE=seed,producer-seed,plain-seed: only
#      the child's ORDINARY CR `Seed` changes, so the child updates while its
#      NoEcho CR does not re-run and nothing re-mints the token. The parent
#      NoEchoParam is still promoted (go-to-k/cdkd#3662 lifted the exclusion
#      of masked readers), resolves the mask itself, and must be SKIPPED as
#      equal to its record rather than REFUSED as a redacted read: the deploy
#      exits 0, the skip line is asserted, and AWS keeps the phase-3 token.
#      PlainParam carries the new plain value.
#   6. deploy --all with CDKD_TEST_UPDATE=seed,producer-seed,plain-seed,parent-seed:
#      only CdkdCrNoEchoParamExample changes, where one handler serves a NoEcho
#      CR and an ordinary one, and both re-run.
#      - go-to-k/cdkd#3717: the nested ParamChild reads the NoEcho token only
#        through a stack PARAMETER. Its diff side is `***` against a recorded
#        `***`, so only the fresh-parameter promotion reaches its
#        ParentTokenParam, which must hold the NEW token on AWS while every
#        persisted copy stays `***`.
#      - go-to-k/cdkd#3722: IdCr's handler answers the Update with a new
#        PhysicalResourceId, and IdRefParam (`Ref IdCr`) must follow it.
#      Both NoEcho CRs with a create-only reader feed a layer version's
#      `Description` (go-to-k/cdkd#3729): ProducerNoEchoLayer (same stack) and
#      ParamChildLayer (the child-parameter path). Phase 4 must REPLACE the
#      producer's layer and phase 6 the child's (a new version ARN, and the
#      "could not confirm unchanged (differs)" line): the token moved, and the
#      AWS readback says so. These are the controls for phase 7.
#   7. deploy --all with CDKD_TEST_UPDATE=...,nonce: both of those CRs re-run
#      (a `Nonce` property their handler ignores) and return the SAME token.
#      The record holds only `***`, so before go-to-k/cdkd#3729 each layer was
#      replaced. Now cdkd reads each layer back from AWS, finds the token
#      already there, and skips it: the same version ARN, the "already holds"
#      and "Skipping" lines, and no persisted copy of the token.
#   8. destroy --all; everything gone; state versions swept and asserted zero.
#
# A RED whole-blob grep is not automatically a fixture defect. The mask-only
# channel keeps no durable NoEcho flag on the record (go-to-k/cdkd#2449), so a
# copy the named assertions do not enumerate — an `observedProperties`
# readback, say — can carry the value; that is a product finding to file.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
#
# BSD-portable (macOS): no `grep -P`, no `date -d`, no GNU-only flags.

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

# Shared S3 VERSION-sweep helpers (issue #2096). The state bucket is VERSIONED,
# so proving the CURRENT state.json is masked says nothing about the versions
# behind it; the version scan below reads each one.
. ../s3-versions.sh

PARENT="CdkdCrNoEchoNestedExample"
CHILD="${PARENT}~Child"
PRODUCER="CdkdCrNoEchoProducerExample"
CONSUMER="CdkdCrNoEchoConsumerExample"
PARAM_PARENT="CdkdCrNoEchoParamExample"
PARAM_CHILD="${PARAM_PARENT}~ParamChild"
REGION="${AWS_REGION:-us-east-1}"

PARENT_KEY="cdkd/${PARENT}/${REGION}/state.json"
CHILD_KEY="cdkd/${CHILD}/${REGION}/state.json"
PRODUCER_KEY="cdkd/${PRODUCER}/${REGION}/state.json"
CONSUMER_KEY="cdkd/${CONSUMER}/${REGION}/state.json"
PARAM_PARENT_KEY="cdkd/${PARAM_PARENT}/${REGION}/state.json"
PARAM_CHILD_KEY="cdkd/${PARAM_CHILD}/${REGION}/state.json"
PARENT_PREFIX="$(s3_stack_prefix "${PARENT}" "${REGION}")"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD}" "${REGION}")"
PRODUCER_PREFIX="$(s3_stack_prefix "${PRODUCER}" "${REGION}")"
CONSUMER_PREFIX="$(s3_stack_prefix "${CONSUMER}" "${REGION}")"
PARAM_PARENT_PREFIX="$(s3_stack_prefix "${PARAM_PARENT}" "${REGION}")"
PARAM_CHILD_PREFIX="$(s3_stack_prefix "${PARAM_CHILD}" "${REGION}")"
# The shared exports index is a SIBLING key no stack prefix reaches. It is
# shared with every other stack in the region, so it is only ever READ here and
# purged `noncurrent` by KEY, never `all` and never by prefix.
INDEX_KEY="cdkd/_index/${REGION}/exports.json"

# Must match lib/*.ts.
NOECHO_EXPORT_NAME="CdkdCrNoEchoNestedToken"
PARENT_NOECHO_PARAM="/cdkd-integ/cr-noecho-nested/parent/noecho"
PARENT_PLAIN_PARAM="/cdkd-integ/cr-noecho-nested/parent/plain"
PARENT_STATIC_PARAM="/cdkd-integ/cr-noecho-nested/parent/static"
CONSUMER_NOECHO_PARAM="/cdkd-integ/cr-noecho-nested/consumer/noecho"
PRODUCER_NOECHO_PARAM="/cdkd-integ/cr-noecho-nested/producer/noecho"
CONSUMER_PLAIN_PARAM="/cdkd-integ/cr-noecho-nested/consumer/plain"
CHILD_FUNCTION="cdkd-integ-crnoecho-nested-child"
PRODUCER_FUNCTION="cdkd-integ-crnoecho-nested-producer"
PARAM_FUNCTION="cdkd-integ-crnoecho-nested-param"
PARAM_CHILD_TOKEN_PARAM="/cdkd-integ/cr-noecho-nested/param-child/token"
# The create-only layer readers (go-to-k/cdkd#3729), by logical id and name.
PRODUCER_LAYER_ID="ProducerNoEchoLayer"
PARAM_CHILD_LAYER_ID="ParamChildLayer"
PRODUCER_LAYER_NAME="cdkd-integ-crnoecho-nested-producer-layer"
PARAM_CHILD_LAYER_NAME="cdkd-integ-crnoecho-nested-paramchild-layer"
ID_REF_PARAM="/cdkd-integ/cr-noecho-nested/param-parent/id-ref"

# The values the handlers assemble (`<Prefix>-<Seed>`, lib/shared.ts). NOT
# credentials: fixed, inert literals, distinctive so the whole-blob greps below
# cannot collide with ordinary text. The full token appears in no template —
# only its prefix does — so a match can only be a value a HANDLER produced.
CHILD_TOKEN_V1="noecho-child-token-integ"
CHILD_TOKEN_V2="noecho-child-token-updated"
PRODUCER_TOKEN="noecho-producer-token-integ"
PRODUCER_TOKEN_V2="noecho-producer-token-updated"
PARAM_TOKEN="noecho-param-token-integ"
PARAM_TOKEN_V2="noecho-param-token-rotated"
# IdCr's physical ids (lib/shared.ts, IdFromSeed). Not secret.
ID_V1="cr-noecho-nested-id-integ"
ID_V2="cr-noecho-nested-id-rotated"
CHILD_PLAIN="plain-child-value-integ"
CHILD_PLAIN_V2="plain-child-value-updated"
CHILD_PLAIN_V3="plain-child-value-rotated"
# A literal child output (lib/nested-parent-stack.ts), moved by no phase.
CHILD_STATIC="static-child-value"
PRODUCER_PLAIN="plain-producer-value-integ"
SECRET_MASK="***"

LOCAL_DIST="${PWD}/../../../dist/cli.js"
# Created after the pre-run cleanup, which removes it.
DEPLOY_LOG=""

pass() { echo "    OK: $1"; }
fail() { # fail <message>
  echo "FAIL: $1" >&2
  exit 1
}

cleanup() {
  (
    set +eu
    echo "==> Cleanup: dropping any leftover state + AWS resources"
    if [ -f "${LOCAL_DIST}" ] && [ -n "${STATE_BUCKET:-}" ]; then
      node "${LOCAL_DIST}" destroy --all \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
      # Consumer before producer: a producer's destroy is refused while a
      # consumer's state still names its export.
      for s in "${CONSUMER}" "${PRODUCER}" "${CHILD}" "${PARENT}" "${PARAM_CHILD}" "${PARAM_PARENT}"; do
        node "${LOCAL_DIST}" state destroy "${s}" \
          --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
      done
    fi
    for p in "${PARENT_NOECHO_PARAM}" "${PARENT_PLAIN_PARAM}" "${PARENT_STATIC_PARAM}" \
             "${CONSUMER_NOECHO_PARAM}" "${CONSUMER_PLAIN_PARAM}" "${PRODUCER_NOECHO_PARAM}" \
             "${PARAM_CHILD_TOKEN_PARAM}" "${ID_REF_PARAM}"; do
      aws ssm delete-parameter --region "${REGION}" --name "${p}" >/dev/null 2>&1
    done
    # Every version of the two fixture-owned layers (exact names, lib/*.ts).
    for l in "${PRODUCER_LAYER_NAME}" "${PARAM_CHILD_LAYER_NAME}"; do
      for v in $(aws lambda list-layer-versions --region "${REGION}" --layer-name "${l}" \
          --query 'LayerVersions[].Version' --output text 2>/dev/null); do
        aws lambda delete-layer-version --region "${REGION}" --layer-name "${l}" \
          --version-number "${v}" >/dev/null 2>&1
      done
    done
    # Explicit, fixture-owned names (lib/*.ts), so these are exact deletes
    # rather than a prefix sweep, and no scope guard is needed.
    for f in "${CHILD_FUNCTION}" "${PRODUCER_FUNCTION}" "${PARAM_FUNCTION}"; do
      aws lambda delete-function --region "${REGION}" --function-name "${f}" >/dev/null 2>&1
      aws logs delete-log-group --region "${REGION}" --log-group-name "/aws/lambda/${f}" >/dev/null 2>&1
    done
    if [ -n "${STATE_BUCKET:-}" ]; then
      # NONCURRENT-only: this runs from the pre-run sweep and the failure /
      # signal traps, where a live state.json may be the only record of
      # resources still standing. The success path does the full sweep.
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PARAM_PARENT_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PARAM_CHILD_PREFIX:-}" noncurrent
      s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY:-}" noncurrent
    fi
    rm -f "${DEPLOY_LOG:-}"
  )
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

echo "=== NoEcho custom resource value across a stack boundary (issue #2460) ==="
echo "Parent:   ${PARENT} (child ${CHILD})"
echo "Producer: ${PRODUCER}"
echo "Consumer: ${CONSUMER}"
echo "Region:   ${REGION}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

# The lower bound for the custom-resource response scan, in the AWS CLI's
# LastModified spelling. Five minutes early, so host-vs-S3 clock skew cannot
# drop this run's own objects out of the window (perl: BSD and GNU `date`
# disagree on relative arithmetic).
RUN_START="$(perl -MPOSIX -e 'print strftime("%Y-%m-%dT%H:%M:%S+00:00", gmtime(time - 300))')"

echo "==> Pre-run cleanup"
cleanup
DEPLOY_LOG="$(mktemp)"

# --- helpers -----------------------------------------------------------------

# Every token this run can produce. A phase-1 check includes the phase-3 token
# too: it must be absent everywhere before phase 3 mints it, which is also the
# guard that it really is handler-generated.
TOKENS="${CHILD_TOKEN_V1} ${CHILD_TOKEN_V2} ${PRODUCER_TOKEN} ${PRODUCER_TOKEN_V2} ${PARAM_TOKEN} ${PARAM_TOKEN_V2}"

assert_no_tokens() { # assert_no_tokens <what> <text>
  local t n=0
  for t in ${TOKENS}; do
    n=$((n + 1))
    # A shell pattern, not `printf | grep -q`: under pipefail an early-exiting
    # `grep -q` can SIGPIPE the writer and turn a MATCH into a failed pipeline,
    # i.e. a silent pass. It also never echoes the match.
    if [[ "$2" == *"${t}"* ]]; then
      # The diagnostic a leak needs is WHERE it is: print each offending line
      # with every token rewritten to `<noecho>`, so the report names the
      # emitting line without printing the value it caught.
      echo "  offending line(s), tokens rewritten:" >&2
      printf '%s\n' "$2" | grep -F -e "${t}" | head -20 | redact_tokens >&2 || true
      # By POSITION in TOKENS, never the value, for the reason the dump above
      # rewrites it: this is the site that exists to catch a leak.
      fail "$1 carries NoEcho token #${n} of TOKENS"
    fi
  done
  pass "$1 carries no NoEcho value"
}

redact_tokens() { # stdin -> stdout, every token rewritten to `<noecho>`
  local line t
  while IFS= read -r line || [ -n "${line}" ]; do
    for t in ${TOKENS}; do
      line="${line//"${t}"/<noecho>}"
    done
    printf '%s\n' "${line}"
  done
}

assert_eq() { # assert_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    fail "$1 is '$2', expected '$3'"
  fi
  pass "$1 == '$3'"
}

read_state() { # read_state <key> — strict: a failed read aborts the run
  local body
  body="$(aws s3 cp "s3://${STATE_BUCKET}/$1" -)" || return 1
  if [ -z "${body}" ]; then
    echo "FAIL: empty state at s3://${STATE_BUCKET}/$1" >&2
    return 1
  fi
  printf '%s' "${body}"
}

ssm_value() { # ssm_value <name> — strict
  aws ssm get-parameter --region "${REGION}" --name "$1" \
    --query 'Parameter.Value' --output text
}

# The persisted `properties.Value` of the SSM parameter named <name>, selected
# by the NAME it carries rather than by a CDK-hashed logical id.
param_state_value() { # param_state_value <state-json> <name>
  printf '%s' "$1" | jq -r --arg n "$2" \
    '[.resources[] | select(.properties.Name == $n) | .properties.Value] | if length == 1 then .[0] else "<\(length) matches>" end'
}

# `list-object-versions` rows for <prefix>, stdout only. stderr goes to its
# own file rather than `2>&1`, which would put a benign CLI warning INTO the
# row stream as a phantom key (../s3-versions.sh, `_s3v_rows`); it is printed
# when the listing itself fails. Auto-pagination is relied upon, and the query
# projects rows rather than `length()`, which `--output text` applies per page.
list_versions() { # list_versions <prefix> <query>
  local err out rc=0
  err="$(mktemp)"
  out="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
    --prefix "$1" --query "$2" --output text 2>"${err}")" || rc=$?
  if [ "${rc}" -ne 0 ]; then
    cat "${err}" >&2
    rm -f "${err}"
    return 1
  fi
  rm -f "${err}"
  printf '%s' "${out}"
}

# Read EVERY object version under <scope> (a stack prefix, or the index key)
# and fail if any carries a token. Read-only. A zero-row listing FAILS: the
# scope would then name nothing, and a clean verdict would be about the wrong
# key space.
assert_no_tokens_in_versions() { # <scope> <description>
  local scope="$1" desc="$2" rows key vid body scanned=0 t
  rows="$(list_versions "${scope}" 'Versions[].[Key,VersionId]')" \
    || fail "${desc}: could not list object versions under s3://${STATE_BUCKET}/${scope}"
  # `|| [ -n "${key}" ]`: `$(...)` strips the trailing newline, so `read`
  # returns non-zero on the LAST row (../s3-versions.sh, trap 2). A here-string
  # rather than a pipe so `scanned` survives the loop.
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      # The exports index is SHARED with every other stack in the region, and
      # a concurrent run (another fixture's `noncurrent` purge of the same key,
      # or `cdkd gc`) can remove a version between the listing and this read
      # — measured on a go-to-k/cdkd#3717 run. Gone is not a finding THERE;
      # the stack prefixes are this fixture's own, so it still is for them.
      # A shell pattern rather than `printf | grep -q`, for the SIGPIPE reason
      # `assert_no_tokens` gives.
      if [ "${scope}" = "${INDEX_KEY}" ] \
          && [[ "${body}" == *NoSuchVersion* || "${body}" == *NoSuchKey* ]]; then
        continue
      fi
      fail "${desc}: could not read s3://${STATE_BUCKET}/${key} version ${vid} (${body})"
    fi
    for t in ${TOKENS}; do
      if [[ "${body}" == *"${t}"* ]]; then
        fail "${desc}: s3://${STATE_BUCKET}/${key} version ${vid} carries a NoEcho token (value withheld)"
      fi
    done
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${scanned}" -eq 0 ]; then
    fail "${desc}: scanned ZERO object versions under s3://${STATE_BUCKET}/${scope}"
  fi
  pass "${desc}: ${scanned} object version(s) scanned, none carries a NoEcho value"
}

run_deploy() { # run_deploy <phase label> <Deploying|Updating|Unchanged> [env assignment]
  local label="$1" verb="$2" rc
  shift 2
  : > "${DEPLOY_LOG}"
  set +e
  env "$@" node "${LOCAL_DIST}" deploy --all --verbose \
    --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${DEPLOY_LOG}" 2>&1
  rc=$?
  set -e
  if [ "${rc}" -ne 0 ]; then
    # Shown only on failure, and the values are inert literals: a refusal's
    # text is the diagnostic this fixture most needs.
    cat "${DEPLOY_LOG}" >&2
    fail "${label}: deploy --all exited ${rc}. A refusal naming a masked (***) cross-stack read means the in-run recovery did not serve the plaintext (issue #2274)."
  fi
  # Sentinel: the log must show the nested child went through the expected
  # provider arm, or the token scan below would pass over an empty or
  # truncated capture. `create` logs `Deploying nested stack <child>`, `update`
  # logs `Updating nested stack <child>` (nested-stack-provider.ts); the verb
  # is the proof of WHICH arm of the recovery ran.
  if [ "${verb}" = "Unchanged" ]; then
    # The nested row is NO_CHANGE: no provider arm may run, and the log must
    # still name the stack whose UPDATE this phase is about.
    if grep -qF "nested stack ${CHILD}" "${DEPLOY_LOG}"; then
      fail "${label}: the nested stack ${CHILD} was redeployed in a phase where nothing in it changed"
    fi
    if ! grep -qF "${CONSUMER}" "${DEPLOY_LOG}"; then
      fail "${label}: the captured deploy log never names ${CONSUMER} — the capture is empty, so the log scan would be vacuous"
    fi
  elif ! grep -qF "${verb} nested stack ${CHILD}" "${DEPLOY_LOG}"; then
    if grep -qF "nested stack ${CHILD}" "${DEPLOY_LOG}"; then
      fail "${label}: the deploy log names ${CHILD} but not through '${verb} nested stack' — the parent took a different arm than this phase expects, or the wording drifted"
    fi
    fail "${label}: the captured deploy log never names ${CHILD} — the capture is empty or the wording drifted, so the log scan would be vacuous"
  fi
  # The token check runs BEFORE the log is echoed anywhere, so a leak is never
  # printed by the check that exists to catch it.
  assert_no_tokens "${label}: the verbose deploy log" "$(cat "${DEPLOY_LOG}")"
  cat "${DEPLOY_LOG}"
}

# Every persisted copy of the nested arm. <token> is the value AWS must hold,
# <plain> the ordinary child output's.
assert_nested_arm() { # assert_nested_arm <label> <token> <plain>
  local label="$1" token="$2" plain="$3" parent child
  parent="$(read_state "${PARENT_KEY}")" || fail "${label}: could not read ${PARENT_KEY}"
  child="$(read_state "${CHILD_KEY}")" || fail "${label}: could not read ${CHILD_KEY}"

  echo "  -- ${label}: nested arm, on AWS (the recovery)"
  assert_eq "parent NoEchoParam on AWS" "$(ssm_value "${PARENT_NOECHO_PARAM}")" "${token}"
  assert_eq "parent PlainParam on AWS" "$(ssm_value "${PARENT_PLAIN_PARAM}")" "${plain}"
  assert_eq "parent StaticParam on AWS" "$(ssm_value "${PARENT_STATIC_PARAM}")" "${CHILD_STATIC}"

  echo "  -- ${label}: nested arm, in cdkd state (non-disclosure)"
  assert_eq "child state.outputs.NoEchoToken" \
    "$(printf '%s' "${child}" | jq -r '.outputs.NoEchoToken // "<absent>"')" "${SECRET_MASK}"
  assert_eq "child ChildNoEchoCr attributes.Value" \
    "$(printf '%s' "${child}" | jq -r '.resources.ChildNoEchoCr.attributes.Value // "<absent>"')" "${SECRET_MASK}"
  assert_eq "parent Child row attributes[Outputs.NoEchoToken]" \
    "$(printf '%s' "${parent}" | jq -r '.resources.Child.attributes["Outputs.NoEchoToken"] // "<absent>"')" "${SECRET_MASK}"
  assert_eq "parent NoEchoParam properties.Value" \
    "$(param_state_value "${parent}" "${PARENT_NOECHO_PARAM}")" "${SECRET_MASK}"
  # cdkd's own input must survive the mask-only registration: a masked
  # ServiceToken makes destroy invoke a Lambda named '***'.
  case "$(printf '%s' "${child}" | jq -r '.resources.ChildNoEchoCr.properties.ServiceToken // "<absent>"')" in
    arn:aws*:lambda:*:function:*) pass "child ChildNoEchoCr ServiceToken is still a Lambda ARN" ;;
    *) fail "child ChildNoEchoCr ServiceToken is no longer a Lambda ARN" ;;
  esac

  echo "  -- ${label}: nested arm, NEGATIVE control (per-attribute, not whole-bag)"
  assert_eq "child state.outputs.PlainValue" \
    "$(printf '%s' "${child}" | jq -r '.outputs.PlainValue // "<absent>"')" "${plain}"
  assert_eq "child ChildPlainCr attributes.Value" \
    "$(printf '%s' "${child}" | jq -r '.resources.ChildPlainCr.attributes.Value // "<absent>"')" "${plain}"
  assert_eq "parent Child row attributes[Outputs.PlainValue]" \
    "$(printf '%s' "${parent}" | jq -r '.resources.Child.attributes["Outputs.PlainValue"] // "<absent>"')" "${plain}"
  assert_eq "parent PlainParam properties.Value" \
    "$(param_state_value "${parent}" "${PARENT_PLAIN_PARAM}")" "${plain}"
  assert_eq "parent StaticParam properties.Value" \
    "$(param_state_value "${parent}" "${PARENT_STATIC_PARAM}")" "${CHILD_STATIC}"

  assert_no_tokens "${label}: the parent state blob" "${parent}"
  assert_no_tokens "${label}: the child state blob" "${child}"
}

# Every persisted copy of the Fn::ImportValue arm.
assert_import_arm() { # assert_import_arm <label> <token>
  local label="$1" token="$2" producer consumer index
  producer="$(read_state "${PRODUCER_KEY}")" || fail "${label}: could not read ${PRODUCER_KEY}"
  consumer="$(read_state "${CONSUMER_KEY}")" || fail "${label}: could not read ${CONSUMER_KEY}"
  index="$(read_state "${INDEX_KEY}")" || fail "${label}: could not read ${INDEX_KEY}"

  echo "  -- ${label}: Fn::ImportValue arm, on AWS (the recovery)"
  assert_eq "consumer NoEchoParam on AWS" "$(ssm_value "${CONSUMER_NOECHO_PARAM}")" "${token}"
  # The producer's SAME-STACK reader of its own NoEcho CR (go-to-k/cdkd#3662).
  assert_eq "producer ProducerNoEchoParam on AWS" "$(ssm_value "${PRODUCER_NOECHO_PARAM}")" "${token}"
  assert_eq "consumer PlainParam on AWS" "$(ssm_value "${CONSUMER_PLAIN_PARAM}")" "${PRODUCER_PLAIN}"

  echo "  -- ${label}: Fn::ImportValue arm, in cdkd state (non-disclosure)"
  assert_eq "producer state.outputs.NoEchoTokenExport" \
    "$(printf '%s' "${producer}" | jq -r '.outputs.NoEchoTokenExport // "<absent>"')" "${SECRET_MASK}"
  # The export-name ALIAS of the same output (outputs-export-alias.ts): a
  # literal `Export.Name` is aliased into the SAME bag, so it is a second
  # persisted copy of the same value, and the no-change path keeps it.
  assert_eq "producer state.outputs[${NOECHO_EXPORT_NAME}] (export alias)" \
    "$(printf '%s' "${producer}" | jq -r --arg e "${NOECHO_EXPORT_NAME}" '.outputs[$e] // "<absent>"')" "${SECRET_MASK}"
  assert_eq "producer ProducerNoEchoCr attributes.Value" \
    "$(printf '%s' "${producer}" | jq -r '.resources.ProducerNoEchoCr.attributes.Value // "<absent>"')" "${SECRET_MASK}"
  assert_eq "consumer NoEchoParam properties.Value" \
    "$(param_state_value "${consumer}" "${CONSUMER_NOECHO_PARAM}")" "${SECRET_MASK}"
  assert_eq "producer ProducerNoEchoParam properties.Value" \
    "$(param_state_value "${producer}" "${PRODUCER_NOECHO_PARAM}")" "${SECRET_MASK}"

  echo "  -- ${label}: Fn::ImportValue arm, NEGATIVE control"
  assert_eq "producer state.outputs.PlainValueExport" \
    "$(printf '%s' "${producer}" | jq -r '.outputs.PlainValueExport // "<absent>"')" "${PRODUCER_PLAIN}"
  assert_eq "consumer PlainParam properties.Value" \
    "$(param_state_value "${consumer}" "${CONSUMER_PLAIN_PARAM}")" "${PRODUCER_PLAIN}"

  assert_no_tokens "${label}: the producer state blob" "${producer}"
  assert_no_tokens "${label}: the consumer state blob" "${consumer}"
  # The index is SHARED and holds resolved output values; the ordinary export's
  # value being present is the proof this is the object our producer wrote.
  if [[ "${index}" != *"${PRODUCER_PLAIN}"* ]]; then
    fail "${label}: the exports index does not carry the ordinary export's value — the scan below would be about an object this run never wrote"
  fi
  assert_no_tokens "${label}: the current exports index" "${index}"
}

# Every persisted copy of the parameter arm (go-to-k/cdkd#3717 / #3722).
assert_param_arm() { # assert_param_arm <label> <token> <IdCr physical id>
  local label="$1" token="$2" id="$3" parent child
  parent="$(read_state "${PARAM_PARENT_KEY}")" || fail "${label}: could not read ${PARAM_PARENT_KEY}"
  child="$(read_state "${PARAM_CHILD_KEY}")" || fail "${label}: could not read ${PARAM_CHILD_KEY}"

  echo "  -- ${label}: parameter arm, on AWS"
  assert_eq "param-child ParentTokenParam on AWS" "$(ssm_value "${PARAM_CHILD_TOKEN_PARAM}")" "${token}"
  assert_eq "param-parent IdRefParam on AWS" "$(ssm_value "${ID_REF_PARAM}")" "${id}"

  echo "  -- ${label}: parameter arm, in cdkd state (non-disclosure)"
  assert_eq "param-parent ParentNoEchoCr attributes.Value" \
    "$(printf '%s' "${parent}" | jq -r '.resources.ParentNoEchoCr.attributes.Value // "<absent>"')" "${SECRET_MASK}"
  assert_eq "param-parent ParamChild row properties.Parameters.ParentToken" \
    "$(printf '%s' "${parent}" | jq -r '.resources.ParamChild.properties.Parameters.ParentToken // "<absent>"')" "${SECRET_MASK}"
  assert_eq "param-child ParentTokenParam properties.Value" \
    "$(param_state_value "${child}" "${PARAM_CHILD_TOKEN_PARAM}")" "${SECRET_MASK}"
  assert_eq "param-parent IdCr physicalId" \
    "$(printf '%s' "${parent}" | jq -r '.resources.IdCr.physicalId // "<absent>"')" "${id}"
  assert_eq "param-parent IdRefParam properties.Value" \
    "$(param_state_value "${parent}" "${ID_REF_PARAM}")" "${id}"

  assert_no_tokens "${label}: the param-parent state blob" "${parent}"
  assert_no_tokens "${label}: the param-child state blob" "${child}"
}

# A create-only layer reader of a NoEcho value (go-to-k/cdkd#3729): its record
# holds the mask and its live description the token. Sets LAYER_ARN to the
# physical id the record names, for the caller to compare across phases.
LAYER_ARN=""
assert_layer() { # assert_layer <label> <state key> <logical id> <token>
  local label="$1" state desc
  state="$(read_state "$2")" || fail "${label}: could not read $2"
  LAYER_ARN="$(printf '%s' "${state}" | jq -r --arg id "$3" '.resources[$id].physicalId // "<absent>"')"
  case "${LAYER_ARN}" in
    arn:aws*:lambda:*:layer:*:[0-9]*) pass "${label}: $3 physicalId is a layer version ARN" ;;
    *) fail "${label}: $3 physicalId is not a layer version ARN (${LAYER_ARN})" ;;
  esac
  assert_eq "${label}: $3 properties.Description" \
    "$(printf '%s' "${state}" | jq -r --arg id "$3" '.resources[$id].properties.Description // "<absent>"')" \
    "${SECRET_MASK}"
  if ! desc="$(aws lambda get-layer-version-by-arn --region "${REGION}" --arn "${LAYER_ARN}" --query 'Description' --output text)"; then
    fail "${label}: could not read layer ${LAYER_ARN}"
  fi
  assert_eq "${label}: $3 Description on AWS" "${desc}" "$4"
}

# The engine's verdict line for a layer's create-only `Description`
# (go-to-k/cdkd#3729). FAILS on a zero match, naming a drifted wording.
assert_layer_verdict() { # assert_layer_verdict <label> <logical id> <held|differs>
  local line
  if [ "$3" = "held" ]; then
    line="$2.Description carries a NoEcho value AWS already holds: not replaced."
  else
    line="$2.Description carries a NoEcho value that AWS could not confirm unchanged (differs): replacement kept."
  fi
  if ! grep -qF "${line}" "${DEPLOY_LOG}"; then
    fail "$1: no '${line}' line — the readback did not decide $2's replacement, or the wording drifted"
  fi
  pass "$1: $2 — ${line}"
}

# The custom-resource response objects (`custom-resource-responses/<id>.json`,
# a SHARED top-level prefix of the state bucket): cdkd PUTs an empty
# placeholder per invoke, and a handler answering through `ResponseURL` would
# put its `Data` there. These handlers return directly, so nothing of theirs
# should land here; the scan is the check that cdkd itself writes none. Only
# versions written since this run started are read (other stacks' objects are
# none of this fixture's business), and a zero count is legitimate, since the
# placeholders are deleted after each invoke. Read-only: request ids carry no
# stack, so nothing here is attributable enough to purge.
assert_no_tokens_in_response_objects() { # <label>
  local rows key vid lm body scanned=0 t
  rows="$(list_versions "custom-resource-responses/" 'Versions[].[Key,VersionId,LastModified]')" \
    || fail "$1: could not list custom-resource response object versions"
  while IFS=$'\t' read -r key vid lm || [ -n "${key}" ]; do
    [ -n "${key}" ] || continue
    [ -n "${vid}" ] || continue
    [ "${vid}" != "None" ] || continue
    # ISO-8601 in one zone compares lexicographically.
    [[ "${lm}" > "${RUN_START}" ]] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      # A SHARED prefix: another run or `cdkd gc` may purge a version between
      # the listing and this read. Gone is not a finding; anything else is.
      # The canonical signature (gone_probe's): `NoSuchVersion` / `NoSuchKey`
      # match its `no ?such` arm.
      if printf '%s' "${body}" | grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404'; then
        continue
      fi
      fail "$1: could not read s3://${STATE_BUCKET}/${key} version ${vid} (${body})"
    fi
    for t in ${TOKENS}; do
      if [[ "${body}" == *"${t}"* ]]; then
        fail "$1: custom-resource response object ${key} version ${vid} carries a NoEcho token (value withheld)"
      fi
    done
    scanned=$((scanned + 1))
  done <<< "${rows}"
  pass "$1: ${scanned} custom-resource response object version(s) from this run scanned, none carries a NoEcho value"
}

assert_no_tokens_in_all_versions() { # <label>
  assert_no_tokens_in_versions "${PARENT_PREFIX}" "$1: parent state prefix"
  assert_no_tokens_in_versions "${CHILD_PREFIX}" "$1: child state prefix"
  assert_no_tokens_in_versions "${PRODUCER_PREFIX}" "$1: producer state prefix"
  assert_no_tokens_in_versions "${CONSUMER_PREFIX}" "$1: consumer state prefix"
  assert_no_tokens_in_versions "${PARAM_PARENT_PREFIX}" "$1: param-parent state prefix"
  assert_no_tokens_in_versions "${PARAM_CHILD_PREFIX}" "$1: param-child state prefix"
  assert_no_tokens_in_versions "${INDEX_KEY}" "$1: exports index key"
  assert_no_tokens_in_response_objects "$1"
}

# --- Phase 1: deploy --all --------------------------------------------------
echo "==> Phase 1: deploy --all"
run_deploy "Phase 1" Deploying -u CDKD_TEST_UPDATE
assert_nested_arm "Phase 1" "${CHILD_TOKEN_V1}" "${CHILD_PLAIN}"
assert_import_arm "Phase 1" "${PRODUCER_TOKEN}"
assert_param_arm "Phase 1" "${PARAM_TOKEN}" "${ID_V1}"
assert_layer "Phase 1" "${PRODUCER_KEY}" "${PRODUCER_LAYER_ID}" "${PRODUCER_TOKEN}"
PRODUCER_LAYER_ARN_1="${LAYER_ARN}"
assert_layer "Phase 1" "${PARAM_CHILD_KEY}" "${PARAM_CHILD_LAYER_ID}" "${PARAM_TOKEN}"
PARAM_CHILD_LAYER_ARN_1="${LAYER_ARN}"
assert_no_tokens_in_all_versions "Phase 1"

# --- Phase 2: a freshly deployed tree reports NO change ----------------------
# A masked leaf is exactly where the desired side (resolved) and the persisted
# side (`***`) can disagree forever; the exit code is the check.
echo "==> Phase 2: cdkd diff --all --recursive --fail exits 0"
set +e
DIFF_OUT="$(env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" diff --all --recursive --fail \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DIFF_RC=$?
set -e
# Token check FIRST, so the failure path below never prints a leak.
assert_no_tokens "the diff output" "${DIFF_OUT}"
if [ "${DIFF_RC}" -ne 0 ]; then
  printf '%s\n' "${DIFF_OUT}" >&2
  fail "'cdkd diff --all --recursive --fail' exited ${DIFF_RC} on an unchanged tree (expected 0)"
fi
# Sentinel: `diff` announces every stack it compares (`Calculating diff for
# stack: <name>`, src/cli/commands/diff.ts) independently of its verdict
# wording, so an empty or truncated capture cannot pass the token scan above.
for s in "${PARENT}" "${PRODUCER}" "${CONSUMER}" "${PARAM_PARENT}"; do
  if [[ "${DIFF_OUT}" != *"diff for stack: ${s}"* ]]; then
    fail "the diff output never announces stack ${s} — the capture is incomplete or the wording drifted, so the token scan above would be vacuous"
  fi
done
pass "cdkd diff --all --recursive --fail exited 0 over all four stacks"

# --- Phase 3: UPDATE through NestedStackProvider.update ----------------------
echo "==> Phase 3: deploy --all with CDKD_TEST_UPDATE=seed (child CR Seeds change)"
run_deploy "Phase 3" Updating CDKD_TEST_UPDATE=seed
# go-to-k/cdkd#3631, from the log: the diff promotes every reader of the
# updated nested stack's outputs (it cannot know which ones the child deploy
# moves), NoEchoParam, PlainParam and StaticParam among them — NoEchoParam
# since go-to-k/cdkd#3662, which lifted the exclusion of a reader of a masked
# output — and the engine skips the one whose output did not move. The AWS
# values below are the outcome; these lines are the mechanism, and the skip
# line is the only evidence StaticParam was promoted at all, since a
# never-promoted reader issues no call either. The consumer stack's
# NoEchoParam shares the logical-id prefix, but it reads an `Fn::ImportValue`,
# which no in-place promotion follows, and is NO_CHANGE in phases 3 and 5.
# Every grep FAILS on a zero match, so a drifted wording cannot pass silently;
# each message names that possibility.
PROMOTED_RE='DiffCalculator\] UPDATE \(in-place attr propagated\): '
assert_promoted() { # assert_promoted <phase label> <logical-id prefix>...
  local label="$1" p
  shift
  for p in "$@"; do
    if ! grep -qE "${PROMOTED_RE}${p}[0-9A-F]* " "${DEPLOY_LOG}"; then
      fail "${label}: no 'UPDATE (in-place attr propagated): ${p}...' line — a reader of a value that moves in this deploy (a nested stack output, a custom resource's attribute or physical id, a fresh NoEcho parameter) diffed NO_CHANGE, or the wording drifted"
    fi
    pass "${label}: ${p} promoted as a reader of a value that moves in this deploy"
  done
}
skip_re() { # skip_re <logical-id prefix>
  printf 'Skipping %s[0-9A-F]*: no actual changes after intrinsic function resolution' "$1"
}
assert_promoted "Phase 3" NoEchoParam PlainParam StaticParam
if ! grep -qE "$(skip_re StaticParam)" "${DEPLOY_LOG}"; then
  fail "Phase 3: no 'Skipping StaticParam...: no actual changes after intrinsic function resolution' line — the reader of an output that did not move was re-sent, or the wording drifted"
fi
pass "Phase 3: StaticParam skipped after re-resolution (its output did not move)"
# The go-to-k/cdkd#3662 skip, from the log. The token on AWS below is the
# outcome, and this names the mechanism when it fails: the re-minted token and
# the record both redact to `***`.
if grep -qE "$(skip_re NoEchoParam)" "${DEPLOY_LOG}"; then
  fail "Phase 3: NoEchoParam was skipped as unchanged although the child re-minted its NoEcho token (go-to-k/cdkd#3662: *** compared equal to ***)"
fi
pass "Phase 3: NoEchoParam was not skipped as *** == ***"
# The new token on AWS is also the proof the phase changed something: the old
# one can only be replaced by a handler run on the UPDATE.
assert_nested_arm "Phase 3" "${CHILD_TOKEN_V2}" "${CHILD_PLAIN_V2}"
# NO_CHANGE for this pair, over a mask the PREVIOUS run wrote: the consumer's
# live value must still be the real token, never `***`.
assert_import_arm "Phase 3" "${PRODUCER_TOKEN}"
assert_no_tokens_in_all_versions "Phase 3"

# --- Phase 4: UPDATE through the Fn::ImportValue recovery --------------------
# `seed` stays in the mode list (monotonic), so the nested tree is NO_CHANGE
# over the masks phase 3 wrote, and only the producer's NoEcho CR Seed flips:
# the export value changes, the consumer's diff resolves it through the
# recovery (the producer deployed earlier in this same process) and the
# consumer takes an UPDATE.
echo "==> Phase 4: deploy --all with CDKD_TEST_UPDATE=seed,producer-seed (producer NoEcho CR Seed changes)"
run_deploy "Phase 4" Unchanged CDKD_TEST_UPDATE=seed,producer-seed
# The DIFF-side recovery, asserted on its own. The consumer has no
# own-property change, so its diff is an UPDATE of `Value` only if it recovered
# the new token; reading `***` it would be NO_CHANGE and print no line. The
# AWS value below then proves the PROVISIONING side: the recovery, and the
# engine not skipping the update as `***` == `***` (go-to-k/cdkd#3662). The
# parent's NoEchoParam (same logical-id prefix) is NO_CHANGE in this phase, so
# an UPDATE line for that id can only be the consumer's.
DIFF_LINE_RE='DiffCalculator\] UPDATE: NoEchoParam[0-9A-F]* \(([0-9]+) property changes'
if ! grep -qE "${DIFF_LINE_RE}" "${DEPLOY_LOG}"; then
  fail "Phase 4: the deploy log has no 'UPDATE: NoEchoParam... (N property changes' line — the consumer did not diff as an UPDATE, or the wording drifted and this check is blind"
fi
CONSUMER_CHANGES="$(grep -oE "${DIFF_LINE_RE}" "${DEPLOY_LOG}" | head -1 | sed -E 's/.*\(([0-9]+) property changes/\1/')"
assert_eq "Phase 4: consumer NoEchoParam diff property-change count (Value)" \
  "${CONSUMER_CHANGES}" "1"
# The same-stack reader: the CR's attributes are no template property, so only
# the custom-resource promotion (go-to-k/cdkd#3662) makes it an UPDATE.
if ! grep -qE "${PROMOTED_RE}ProducerNoEchoParam[0-9A-F]* " "${DEPLOY_LOG}"; then
  fail "Phase 4: no 'UPDATE (in-place attr propagated): ProducerNoEchoParam...' line — a reader of an updated custom resource's attribute diffed NO_CHANGE (go-to-k/cdkd#3662), or the wording drifted"
fi
pass "Phase 4: ProducerNoEchoParam promoted as a reader of the updated custom resource"
assert_nested_arm "Phase 4" "${CHILD_TOKEN_V2}" "${CHILD_PLAIN_V2}"
assert_import_arm "Phase 4" "${PRODUCER_TOKEN_V2}"
# The CONTROL for phase 7 (go-to-k/cdkd#3729): the token moved, the readback
# found the old one on AWS, and the layer was replaced.
assert_layer_verdict "Phase 4" "${PRODUCER_LAYER_ID}" differs
assert_layer "Phase 4" "${PRODUCER_KEY}" "${PRODUCER_LAYER_ID}" "${PRODUCER_TOKEN_V2}"
PRODUCER_LAYER_ARN_4="${LAYER_ARN}"
if [ "${PRODUCER_LAYER_ARN_4}" = "${PRODUCER_LAYER_ARN_1}" ]; then
  fail "Phase 4: ${PRODUCER_LAYER_ID} kept version ARN ${PRODUCER_LAYER_ARN_1} although its token moved"
fi
pass "Phase 4: ${PRODUCER_LAYER_ID} replaced (a new layer version)"
assert_no_tokens_in_all_versions "Phase 4"

# --- Phase 5: a promoted reader of a mask NOTHING re-minted ------------------
# Only the child's ordinary CR `Seed` flips (`plain-seed`), so the child
# updates and its NoEcho CR does not re-run. The parent NoEchoParam is promoted
# (go-to-k/cdkd#3662), resolves the persisted mask, and its bag equals its
# record: the engine must skip it BEFORE its refusal of a redacted read. A
# refusal fails run_deploy's exit-code check; the skip line is the positive
# evidence, and AWS keeping the phase-3 token is the outcome.
echo "==> Phase 5: deploy --all with CDKD_TEST_UPDATE=seed,producer-seed,plain-seed (child plain CR Seed changes alone)"
run_deploy "Phase 5" Updating CDKD_TEST_UPDATE=seed,producer-seed,plain-seed
assert_promoted "Phase 5" NoEchoParam PlainParam StaticParam
for p in NoEchoParam StaticParam; do
  if ! grep -qE "$(skip_re "${p}")" "${DEPLOY_LOG}"; then
    fail "Phase 5: no 'Skipping ${p}...: no actual changes after intrinsic function resolution' line — the promoted reader was re-sent or refused, or the wording drifted"
  fi
  pass "Phase 5: ${p} skipped after re-resolution (its output did not move)"
done
assert_nested_arm "Phase 5" "${CHILD_TOKEN_V2}" "${CHILD_PLAIN_V3}"
assert_import_arm "Phase 5" "${PRODUCER_TOKEN_V2}"
# Unchanged since phase 1: no earlier phase touches this stack.
assert_param_arm "Phase 5" "${PARAM_TOKEN}" "${ID_V1}"
assert_no_tokens_in_all_versions "Phase 5"

# --- Phase 6: a NoEcho parameter and a moving physical id --------------------
# Only CdkdCrNoEchoParamExample's two CRs re-run (`parent-seed`). Both readers
# have no own-property change, so each reaches AWS only through a promotion:
# ParentTokenParam in the CHILD engine's diff (the fresh-parameter arm,
# go-to-k/cdkd#3717), IdRefParam in the parent's (a Ref of a custom resource,
# go-to-k/cdkd#3722). The first stack's nested child does not change, hence
# the `Unchanged` sentinel.
echo "==> Phase 6: deploy --all with CDKD_TEST_UPDATE=seed,producer-seed,plain-seed,parent-seed (the param stack's CRs re-run)"
run_deploy "Phase 6" Unchanged CDKD_TEST_UPDATE=seed,producer-seed,plain-seed,parent-seed
# The param stack's child must have gone through the UPDATE arm: without it the
# AWS assertion below could only say the value is stale, not why.
if ! grep -qF "Updating nested stack ${PARAM_CHILD}" "${DEPLOY_LOG}"; then
  fail "Phase 6: no 'Updating nested stack ${PARAM_CHILD}' line — the ParamChild row was not updated with the fresh parameter, or the wording drifted"
fi
pass "Phase 6: ${PARAM_CHILD} updated through NestedStackProvider.update"
assert_promoted "Phase 6" ParamChild IdRefParam ParentTokenParam
assert_param_arm "Phase 6" "${PARAM_TOKEN_V2}" "${ID_V2}"
assert_nested_arm "Phase 6" "${CHILD_TOKEN_V2}" "${CHILD_PLAIN_V3}"
assert_import_arm "Phase 6" "${PRODUCER_TOKEN_V2}"
# The child-parameter CONTROL for phase 7 (go-to-k/cdkd#3729).
assert_layer_verdict "Phase 6" "${PARAM_CHILD_LAYER_ID}" differs
assert_layer "Phase 6" "${PARAM_CHILD_KEY}" "${PARAM_CHILD_LAYER_ID}" "${PARAM_TOKEN_V2}"
PARAM_CHILD_LAYER_ARN_6="${LAYER_ARN}"
if [ "${PARAM_CHILD_LAYER_ARN_6}" = "${PARAM_CHILD_LAYER_ARN_1}" ]; then
  fail "Phase 6: ${PARAM_CHILD_LAYER_ID} kept version ARN ${PARAM_CHILD_LAYER_ARN_1} although its token moved"
fi
pass "Phase 6: ${PARAM_CHILD_LAYER_ID} replaced (a new layer version)"
assert_no_tokens_in_all_versions "Phase 6"

# --- Phase 7: a NoEcho CR returns the SAME value (go-to-k/cdkd#3729) ---------
# `nonce` re-runs ProducerNoEchoCr and ParentNoEchoCr, whose handlers ignore
# it and return the token they returned in phases 4 and 6. Each layer's record
# holds only `***`, so only the AWS readback can say the value did not move.
# Nothing else about a layer changed, so each is skipped outright: the same
# version ARN is the outcome, and the verdict and skip lines are the mechanism.
echo "==> Phase 7: deploy --all with CDKD_TEST_UPDATE=seed,producer-seed,plain-seed,parent-seed,nonce (the NoEcho CRs re-run with the same token)"
run_deploy "Phase 7" Unchanged CDKD_TEST_UPDATE=seed,producer-seed,plain-seed,parent-seed,nonce
if ! grep -qF "Updating nested stack ${PARAM_CHILD}" "${DEPLOY_LOG}"; then
  fail "Phase 7: no 'Updating nested stack ${PARAM_CHILD}' line — the re-run CR's fresh value did not reach the child, so its layer was never asked about"
fi
pass "Phase 7: ${PARAM_CHILD} updated with the re-run CR's value"
for id in "${PRODUCER_LAYER_ID}" "${PARAM_CHILD_LAYER_ID}"; do
  assert_layer_verdict "Phase 7" "${id}" held
  skip_line="Skipping ${id}: AWS already holds every NoEcho value it carries, and nothing else changed"
  if ! grep -qF "${skip_line}" "${DEPLOY_LOG}"; then
    fail "Phase 7: no '${skip_line}' line — the layer was sent to its provider although nothing moved, or the wording drifted"
  fi
  pass "Phase 7: ${id} skipped"
  if grep -qF "${id}.Description carries a NoEcho value that AWS could not confirm" "${DEPLOY_LOG}"; then
    fail "Phase 7: ${id} was judged unconfirmed although its token did not move"
  fi
done
assert_layer "Phase 7" "${PRODUCER_KEY}" "${PRODUCER_LAYER_ID}" "${PRODUCER_TOKEN_V2}"
assert_eq "Phase 7: ${PRODUCER_LAYER_ID} version ARN (not replaced)" "${LAYER_ARN}" "${PRODUCER_LAYER_ARN_4}"
assert_layer "Phase 7" "${PARAM_CHILD_KEY}" "${PARAM_CHILD_LAYER_ID}" "${PARAM_TOKEN_V2}"
assert_eq "Phase 7: ${PARAM_CHILD_LAYER_ID} version ARN (not replaced)" "${LAYER_ARN}" "${PARAM_CHILD_LAYER_ARN_6}"
assert_param_arm "Phase 7" "${PARAM_TOKEN_V2}" "${ID_V2}"
assert_import_arm "Phase 7" "${PRODUCER_TOKEN_V2}"
assert_nested_arm "Phase 7" "${CHILD_TOKEN_V2}" "${CHILD_PLAIN_V3}"
assert_no_tokens_in_all_versions "Phase 7"

# --- Phase 8: destroy --------------------------------------------------------
echo "==> Phase 8: destroy --all"
env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" destroy --all \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for k in "${PARENT_KEY}" "${CHILD_KEY}" "${PRODUCER_KEY}" "${CONSUMER_KEY}" \
         "${PARAM_PARENT_KEY}" "${PARAM_CHILD_KEY}"; do
  assert_gone "state file s3://${STATE_BUCKET}/${k} still exists after destroy" \
    aws s3api head-object --bucket "${STATE_BUCKET}" --key "${k}"
done
pass "all six state files are gone"
for p in "${PARENT_NOECHO_PARAM}" "${PARENT_PLAIN_PARAM}" "${PARENT_STATIC_PARAM}" \
         "${CONSUMER_NOECHO_PARAM}" "${CONSUMER_PLAIN_PARAM}" "${PRODUCER_NOECHO_PARAM}" \
         "${PARAM_CHILD_TOKEN_PARAM}" "${ID_REF_PARAM}"; do
  assert_gone "SSM parameter ${p} still exists after destroy (orphan)" \
    aws ssm get-parameter --region "${REGION}" --name "${p}"
done
pass "all eight SSM parameters are gone"
for f in "${CHILD_FUNCTION}" "${PRODUCER_FUNCTION}" "${PARAM_FUNCTION}"; do
  assert_gone "Lambda ${f} still exists after destroy (orphan)" \
    aws lambda get-function --region "${REGION}" --function-name "${f}"
done
pass "all three handler Lambdas are gone"
for l in "${PRODUCER_LAYER_NAME}" "${PARAM_CHILD_LAYER_NAME}"; do
  left="$(aws lambda list-layer-versions --region "${REGION}" --layer-name "${l}" \
    --query 'length(LayerVersions)' --output text)" \
    || fail "could not list the versions of layer ${l}"
  assert_eq "layer ${l} versions left after destroy" "${left}" "0"
done

# Lambda creates its log group on invoke and neither CFn nor cdkd deletes it.
for f in "${CHILD_FUNCTION}" "${PRODUCER_FUNCTION}" "${PARAM_FUNCTION}"; do
  aws logs delete-log-group --region "${REGION}" --log-group-name "/aws/lambda/${f}" >/dev/null 2>&1 || true
done

trap - EXIT INT TERM
rm -f "${DEPLOY_LOG}"

# The success-path version sweep: `cleanup` purges only `noncurrent`, which
# leaves the delete markers destroy wrote.
s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PRODUCER_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CONSUMER_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PARAM_PARENT_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${PARAM_CHILD_PREFIX}" all || true
s3_purge_key_versions "${STATE_BUCKET}" "${INDEX_KEY}" noncurrent || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PARENT_PREFIX}" "custom-resource-noecho-nested parent state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "custom-resource-noecho-nested child state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PRODUCER_PREFIX}" "custom-resource-noecho-nested producer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CONSUMER_PREFIX}" "custom-resource-noecho-nested consumer state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PARAM_PARENT_PREFIX}" "custom-resource-noecho-nested param-parent state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${PARAM_CHILD_PREFIX}" "custom-resource-noecho-nested param-child state teardown"

echo ""
echo "[verify] PASS — a NoEcho custom resource value crossed a nested-stack and an Fn::ImportValue boundary: real on AWS, masked in every persisted copy"
