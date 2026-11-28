#!/usr/bin/env bash
# verify.sh — `{{resolve:ssm-secure:...}}` dynamic-reference integ (issue #2482).
#
# Pre-fix, cdkd's resolver had no arm for the `ssm-secure` spelling: the token
# hit the unsupported-service warning and the LITERAL TEXT was handed to the
# provider, so the live value of the consuming property was the template
# string and the deploy exited 0. This fixture pins the fix end to end: the
# SecureString's VALUE reaches AWS, the EXPRESSION is what state persists, and
# nothing cdkd prints or compares leaks the plaintext.
#
# The consumer is a Lambda environment variable because it reads back
# (`get-function-configuration`). That is a cdkd-only resolver check — Lambda
# `Environment` is not on CloudFormation's `ssm-secure` destination allowlist
# — see the stack docstring.
#
# Two parameters are seeded, one per value: the whole, embedded and
# `SSM_SECURE_VERSIONED_SAME` forms reference the first, `SSM_SECURE_VERSIONED`
# references the second. The same-parameter versioned form is the collision
# this fixture's first real-AWS run measured (issue go-to-k/cdkd#2485): two
# expressions in one resource resolving to the SAME plaintext, where the
# embedded leaf came back spelled `NAME:1` for a template that says `NAME`.
# Since #2485 the embedded leaf is positioned by its own span; the EXACT state
# assertion on SSM_SECURE_EMBEDDED below is what fails without that fix, and
# `SSM_SECURE_VERSIONED_SAME` being declared after `SSM_SECURE_EMBEDDED` (the
# template keeps declaration order; asserted below) is what makes the
# value-keyed map's survivor the `:1` spelling.
#
# Phases:
#   0. Seed the SecureString parameters out of band (CloudFormation cannot
#      create one) with KNOWN marker values.
#   1. Deploy. Assert the whole / embedded / versioned env vars hold the
#      marker (never the token), the persisted state holds the EXPRESSIONS
#      and no marker anywhere, `diff --fail` is clean and prints no marker,
#      `scrub --dry-run` finds nothing, and `drift` exits 0 (the reference is
#      resolved in memory and compared, no longer "unresolvable").
#   2. UPDATE (CDKD_TEST_UPDATE=true): a tag only. Assert the env vars still
#      hold the marker (never the token) and state still holds the expressions.
#   1e. (CDKD_INTEG_SCRUB_TWIN=1 only, go-to-k/cdkd#7154) A record an older
#      binary wrote in plaintext: the EventBridge rule's two target `Input`s
#      are rewritten to the marker in state, then `cdkd scrub --purge-history`
#      must put EACH back on its own expression (`NAME` / `NAME:1`), `diff
#      --fail` and a re-deploy must report no change, and no surviving object
#      version under the stack prefix may carry the marker.
#   3. Destroy; assert the function and the state file are gone, sweep the
#      Lambda log group, remove the parameters, purge the state bucket's object
#      versions and assert zero survive.
#
# NO cdkd output is printed before it has been scanned for the markers. The
# three invocations that stream to the terminal -- the two deploys and the
# destroy -- are captured to a FILE first and shown through `show_deploy_log`;
# streaming any of them through `tee` would put the plaintext on the terminal /
# in CI logs if the masking ever regressed. The rest (`diff`, `scrub`, `drift`,
# `state show`) are captured into VARIABLES and printed, if at all, through
# `diag_output`, which withholds on a marker hit the same way. The one
# invocation in neither group is the cleanup trap's `state destroy`, whose
# output is discarded to /dev/null outright.
#
# Required env vars:
#   STATE_BUCKET — cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   — defaults to us-east-1
# Optional:
#   CDKD_INTEG_SCRUB_TWIN=1 — add the #7154 rule + queue and run Phase 1e.

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

# The state bucket is VERSIONED. This fixture's whole point is that the marker
# never lands in state.json — but if the redaction ever regressed, every
# version this fixture wrote would keep it readable, so the prefix is swept and
# asserted zero on the success path (issue #2096).
. ../s3-versions.sh

STACK="CdkdSsmSecureDynamicRefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
# Derived exactly as the stack derives them.
PARAM_NAME="cdkd-test-ssm-secure-${ACCOUNT_ID}"
PARAM_NAME_VERSIONED="cdkd-test-ssm-secure-versioned-${ACCOUNT_ID}"

# The markers seeded into the SecureStrings. Test data, not real secrets — but
# they are treated as such everywhere below, because standing in for real ones
# is the point.
MARKER="cdkd-2482-ssm-secure-pw"
MARKER_VERSIONED="cdkd-2482-ssm-secure-versioned-pw"
TOKEN_WHOLE="{{resolve:ssm-secure:${PARAM_NAME}}}"
TOKEN_VERSIONED="{{resolve:ssm-secure:${PARAM_NAME_VERSIONED}:1}}"
TOKEN_VERSIONED_SAME="{{resolve:ssm-secure:${PARAM_NAME}:1}}"
EXPECTED_EMBEDDED="postgres://app-svc:${MARKER}@db.internal:5432/app"
EXPECTED_EMBEDDED_EXPR="postgres://app-svc:${TOKEN_WHOLE}@db.internal:5432/app"

# go-to-k/cdkd#7154 arm: every cdkd command of the run synthesizes the rule, so
# the flag is exported once, with a per-run suffix for the fixed names.
SCRUB_TWIN="${CDKD_INTEG_SCRUB_TWIN:-0}"
if [ "${SCRUB_TWIN}" = "1" ]; then
  export CDKD_TEST_SCRUB_TWIN=true
  CDKD_TEST_SCRUB_TWIN_SUFFIX="${CDKD_TEST_SCRUB_TWIN_SUFFIX:-$(date +%s)}"
  export CDKD_TEST_SCRUB_TWIN_SUFFIX
fi
TWIN_RULE_NAME="cdkd-scrub-twin-${CDKD_TEST_SCRUB_TWIN_SUFFIX:-local}"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

sweep_log_groups() {
  ( set +eu
    for lg in $(aws logs describe-log-groups --region "${REGION}" \
      --log-group-name-prefix "/aws/lambda/${STACK}" \
      --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
      aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1
    done
  )
}

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # A stale lock from a killed previous run would make `state destroy` refuse
  # (the record is then KEPT, below), so drop it first.
  if [ -n "${STATE_BUCKET:-}" ]; then
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
  fi
  destroy_rc=0
  if [ -f "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # The parameters are created by this script, so cdkd never deletes them —
  # the ONLY thing that keeps them from being orphans is this sweep.
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PARAM_NAME_VERSIONED}" --region "${REGION}" >/dev/null 2>&1 || true
  sweep_log_groups
  # The #7154 arm's rule and queue, swept by prefix: a killed earlier run
  # carries another suffix.
  for rule in $(aws events list-rules --name-prefix cdkd-scrub-twin- --region "${REGION}" \
      --query 'Rules[].Name' --output text 2>/dev/null); do
    aws events remove-targets --rule "${rule}" --ids t0 t1 --region "${REGION}" >/dev/null 2>&1
    aws events delete-rule --name "${rule}" --region "${REGION}" >/dev/null 2>&1
  done
  for q in $(aws sqs list-queues --queue-name-prefix cdkd-scrub-twin- --region "${REGION}" \
      --query 'QueueUrls[]' --output text 2>/dev/null); do
    [ "${q}" = "None" ] || aws sqs delete-queue --queue-url "${q}" --region "${REGION}" >/dev/null 2>&1
  done
  rm -f "${DEPLOY_LOG:-}"
  if [ -n "${STATE_BUCKET:-}" ]; then
    # The state record is removed ONLY after `state destroy` succeeded: on a
    # failed destroy it is still the record of resources that may be standing,
    # and the noncurrent purge below would otherwise reap it the moment the
    # `rm` turned it into a noncurrent version.
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    # `noncurrent` here: cleanup runs on the FAILURE path too, where the
    # current state.json is kept (above). The success path below purges `all`
    # after destroy has been asserted.
    s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  fi
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
if ! command -v jq >/dev/null 2>&1; then
  echo "FAIL: jq is required (state / configuration assertions parse JSON)" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  npm install
fi

echo "==> Pre-run cleanup"
cleanup
# The deploy output lands here first and is scanned before it is shown. Created
# AFTER the pre-run cleanup, which removes it, so the file is mktemp's own.
DEPLOY_LOG="$(mktemp "${TMPDIR:-/tmp}/cdkd-2482-deploy.XXXXXX")"

# --- helpers ----------------------------------------------------------------
# Never print a marker: withhold any output that carries one. A diagnostic
# that leaks the value it is guarding is itself the bug.
leaks_marker() { # leaks_marker <text> -> 0 when either marker is in it
  grep -qF -e "${MARKER}" -e "${MARKER_VERSIONED}" <<<"$1"
}
diag_output() { # diag_output <text>
  if leaks_marker "$1"; then
    echo "      output: <WITHHELD — it carries a resolved SecureString value>" >&2
    return 0
  fi
  echo "      output: $1" >&2
}
# show_deploy_log <label>: print the captured deploy output only once it has
# been scanned — on a leak, name the fact and withhold the text.
show_deploy_log() {
  if leaks_marker "$(cat "${DEPLOY_LOG}")"; then
    echo "      $1 output: <WITHHELD — it carries a resolved SecureString value>" >&2
    return 0
  fi
  cat "${DEPLOY_LOG}"
}
# `get-function-configuration` for the deployed function, read fresh each time.
read_function_env() { # read_function_env -> JSON of Environment.Variables
  local out
  out="$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" --output json)" || return 1
  printf '%s' "${out}" | jq -c '.Environment.Variables // {}'
}
env_var() { # env_var <json> <key>
  printf '%s' "$1" | jq -r --arg k "$2" '.[$k] // empty'
}
# The persisted Lambda env block from cdkd state (`state show --json`).
read_state_json() {
  node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --json 2>/dev/null || return 1
}
lambda_env_from_state() { # lambda_env_from_state <state json>
  printf '%s' "$1" | jq -c '.state.resources | to_entries[]
    | select(.value.resourceType=="AWS::Lambda::Function")
    | .value.properties.Environment.Variables' | head -1
}
# assert_live_env <phase>: the three references reached AWS RESOLVED.
assert_live_env() {
  local phase="$1" env whole embedded versioned versioned_same control
  env="$(read_function_env)"
  whole="$(env_var "${env}" SSM_SECURE_WHOLE)"
  embedded="$(env_var "${env}" SSM_SECURE_EMBEDDED)"
  versioned="$(env_var "${env}" SSM_SECURE_VERSIONED)"
  versioned_same="$(env_var "${env}" SSM_SECURE_VERSIONED_SAME)"
  control="$(env_var "${env}" PUBLIC_CONTROL)"
  local fail=0
  if [ "${versioned_same}" != "${MARKER}" ]; then
    echo "FAIL (${phase}, issue #2482): SSM_SECURE_VERSIONED_SAME (the :<version> selector on the FIRST parameter) is not the SecureString value" >&2
    case "${versioned_same}" in *'{{resolve:'*) echo "      the LITERAL TOKEN reached AWS:" >&2; diag_output "${versioned_same}" ;; *) diag_output "${versioned_same}" ;; esac
    fail=1
  fi
  if [ "${whole}" != "${MARKER}" ]; then
    echo "FAIL (${phase}, issue #2482): SSM_SECURE_WHOLE is not the SecureString value" >&2
    case "${whole}" in *'{{resolve:'*) echo "      the LITERAL TOKEN reached AWS:" >&2; diag_output "${whole}" ;; *) diag_output "${whole}" ;; esac
    fail=1
  fi
  if [ "${embedded}" != "${EXPECTED_EMBEDDED}" ]; then
    echo "FAIL (${phase}, issue #2482): SSM_SECURE_EMBEDDED is not the composed string with the value spliced in" >&2
    case "${embedded}" in *'{{resolve:'*) echo "      the LITERAL TOKEN reached AWS inside the string" >&2 ;; *) diag_output "${embedded}" ;; esac
    fail=1
  fi
  if [ "${versioned}" != "${MARKER_VERSIONED}" ]; then
    echo "FAIL (${phase}, issue #2482): SSM_SECURE_VERSIONED (the :<version> selector) is not the second SecureString's value" >&2
    case "${versioned}" in *'{{resolve:'*) echo "      the LITERAL TOKEN reached AWS:" >&2; diag_output "${versioned}" ;; *) diag_output "${versioned}" ;; esac
    fail=1
  fi
  if [ "${control}" != "cdkd-2482-public-control" ]; then
    echo "FAIL (${phase}): PUBLIC_CONTROL did not reach AWS ('${control}') — the env block itself is broken, so the assertions above are not about the reference" >&2
    fail=1
  fi
  [ "${fail}" -eq 0 ] || exit 1
  echo "    OK (${phase}): whole / embedded / versioned references all hold the SecureString value on AWS, never the token"
}
# assert_state_redacted <phase>: state holds the EXPRESSIONS and no marker.
assert_state_redacted() {
  local phase="$1" state env whole embedded versioned control
  state="$(read_state_json)"
  env="$(lambda_env_from_state "${state}")"
  if [ -z "${env}" ] || [ "${env}" = "null" ]; then
    echo "FAIL (${phase}): could not read the consumer Lambda's persisted Environment.Variables from state" >&2
    exit 1
  fi
  whole="$(env_var "${env}" SSM_SECURE_WHOLE)"
  embedded="$(env_var "${env}" SSM_SECURE_EMBEDDED)"
  versioned="$(env_var "${env}" SSM_SECURE_VERSIONED)"
  local versioned_same
  versioned_same="$(env_var "${env}" SSM_SECURE_VERSIONED_SAME)"
  control="$(env_var "${env}" PUBLIC_CONTROL)"
  local fail=0
  # The #2485 collision partner: its own expression, and — the load-bearing
  # half — the EMBEDDED assertion below must still hold beside it.
  [ "${versioned_same}" = "${TOKEN_VERSIONED_SAME}" ] || { echo "FAIL (${phase}): state SSM_SECURE_VERSIONED_SAME is not the expression" >&2; diag_output "${versioned_same}"; fail=1; }
  case "${embedded}" in *':1}}@'*)
    echo "FAIL (${phase}, issue #2485): state SSM_SECURE_EMBEDDED took the version-pinned sibling's expression — the embedded leaf collapsed onto the map's survivor" >&2; fail=1 ;;
  esac
  [ "${whole}" = "${TOKEN_WHOLE}" ] || { echo "FAIL (${phase}): state SSM_SECURE_WHOLE is not the expression" >&2; diag_output "${whole}"; fail=1; }
  [ "${embedded}" = "${EXPECTED_EMBEDDED_EXPR}" ] || { echo "FAIL (${phase}): state SSM_SECURE_EMBEDDED is not the composed string with the EXPRESSION" >&2; diag_output "${embedded}"; fail=1; }
  [ "${versioned}" = "${TOKEN_VERSIONED}" ] || { echo "FAIL (${phase}): state SSM_SECURE_VERSIONED is not the expression" >&2; diag_output "${versioned}"; fail=1; }
  [ "${control}" = "cdkd-2482-public-control" ] || { echo "FAIL (${phase}): state PUBLIC_CONTROL missing — the persisted env block is empty, so the expression assertions are vacuous" >&2; fail=1; }
  # The whole document, not only the env block: nothing else in this stack
  # legitimately holds either value.
  if leaks_marker "${state}"; then
    echo "FAIL (${phase}): a SecureString value LEAKED into persisted state" >&2
    fail=1
  fi
  [ "${fail}" -eq 0 ] || exit 1
  echo "    OK (${phase}): state holds the {{resolve:ssm-secure:...}} expressions and no plaintext"
}

# --- Phase 0: seed the SecureString parameters out of band ------------------
echo "==> Phase 0: creating the SecureString SSM parameters out of band"
seed_secure_parameter() { # seed_secure_parameter <name> <value>
  local name="$1" value="$2" type version
  aws ssm put-parameter --name "${name}" --type SecureString \
    --value "${value}" --overwrite --region "${REGION}" >/dev/null
  # Fail loudly if AWS did not store it as a SecureString: every assertion
  # below would otherwise be about the wrong thing (the `ssm-secure` arm
  # REFUSES a String parameter).
  type=$(aws ssm get-parameter --name "${name}" --region "${REGION}" \
    --query 'Parameter.Type' --output text) || return 1
  if [ "${type}" != "SecureString" ]; then
    echo "FAIL: expected '${name}' to be a SecureString, got '${type}'" >&2
    exit 1
  fi
  version=$(aws ssm get-parameter --name "${name}" --region "${REGION}" \
    --query 'Parameter.Version' --output text) || return 1
  if [ "${version}" != "1" ]; then
    # The stack references `:1`; a leftover from an earlier run would be v2+
    # and the versioned assertion would then read a different value.
    echo "FAIL: expected '${name}' at version 1 after the pre-run cleanup, got version ${version}" >&2
    exit 1
  fi
}
seed_secure_parameter "${PARAM_NAME}" "${MARKER}"
seed_secure_parameter "${PARAM_NAME_VERSIONED}" "${MARKER_VERSIONED}"
echo "    OK: both SecureString parameters created (version 1)"

# --- Phase 1: deploy ---------------------------------------------------------
echo "==> Phase 1: deploy"
# Captured, not streamed: the scan below runs before a byte of it is shown.
if ! env -u CDKD_TEST_UPDATE node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${DEPLOY_LOG}" 2>&1; then
  echo "FAIL: deploy exited non-zero" >&2
  show_deploy_log "deploy" >&2
  exit 1
fi
# The deploy log must not carry a value, and must not carry the pre-fix
# symptom either.
if grep -qF -e "${MARKER}" -e "${MARKER_VERSIONED}" "${DEPLOY_LOG}"; then
  echo "FAIL: the deploy output leaked a SecureString value (output withheld)" >&2
  exit 1
fi
if grep -q 'Unsupported dynamic reference service: ssm-secure' "${DEPLOY_LOG}"; then
  echo "FAIL (issue #2482): the resolver still treats ssm-secure as an unsupported service" >&2
  show_deploy_log "deploy" >&2
  exit 1
fi
show_deploy_log "deploy"
echo "    OK: deploy output carries neither value nor the unsupported-service warning"

set +e
FN_NAME=$(read_state_json | jq -r '.state.outputs.FunctionName // empty')
set -e
if [ -z "${FN_NAME}" ]; then
  echo "FAIL: could not read the FunctionName output from cdkd state" >&2
  exit 1
fi
echo "    Consumer function: ${FN_NAME}"

# PREMISE for the #2485 arm: the synthesized env must list
# SSM_SECURE_VERSIONED_SAME AFTER SSM_SECURE_EMBEDDED, or the collision cannot
# collapse onto the `:1` spelling and the embedded assertion is vacuous.
SYNTH_TEMPLATE="cdk.out/${STACK}.template.json"
if [ ! -f "${SYNTH_TEMPLATE}" ]; then
  echo "FAIL: premise: no synthesized template at ${SYNTH_TEMPLATE}" >&2
  exit 1
fi
EMB_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("SSM_SECURE_EMBEDDED")] | first' "${SYNTH_TEMPLATE}")
SAME_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("SSM_SECURE_VERSIONED_SAME")] | first' "${SYNTH_TEMPLATE}")
case "${EMB_IDX}${SAME_IDX}" in *null*|"")
  echo "FAIL: premise: could not locate SSM_SECURE_EMBEDDED / SSM_SECURE_VERSIONED_SAME in the synthesized env (${EMB_IDX} / ${SAME_IDX})" >&2
  exit 1 ;;
esac
# ...and it must be the LAST of EVERY key resolving to this parameter, not just
# later than the embedded one. The map keeps one expression per PLAINTEXT, so
# the survivor is decided by whichever of the colliding keys resolves last --
# `SSM_SECURE_WHOLE` reads the same parameter and sits at index 0 today, but
# moving it below `SSM_SECURE_VERSIONED_SAME` would make the survivor the
# embedded leaf's OWN token and the exact assertion below vacuous, with a
# pairwise guard still green. Matched on the token boundary (`}}` or `:`) so
# `cdkd-test-ssm-secure-versioned-<acct>` cannot count as this parameter.
MAX_SAME_PARAM_IDX=$(jq -r --arg p "${PARAM_NAME}" '
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables] | first
  | to_entries | to_entries
  | map(select(.value.value | type == "string"
        and (contains("ssm-secure:" + $p + "}}") or contains("ssm-secure:" + $p + ":"))))
  | map(.key) | max' "${SYNTH_TEMPLATE}")
case "${MAX_SAME_PARAM_IDX}" in ''|null)
  echo "FAIL: premise: found no env key referencing ${PARAM_NAME} in the synthesized template" >&2
  exit 1 ;;
esac
if [ "${SAME_IDX}" -le "${EMB_IDX}" ] || [ "${SAME_IDX}" -ne "${MAX_SAME_PARAM_IDX}" ]; then
  echo "FAIL: premise: SSM_SECURE_VERSIONED_SAME (index ${SAME_IDX}) must follow SSM_SECURE_EMBEDDED (index ${EMB_IDX}) AND be the LAST key resolving to ${PARAM_NAME} (last index ${MAX_SAME_PARAM_IDX}); otherwise the collision does not collapse onto the :1 spelling and the embedded assertion is vacuous (#2485)" >&2
  exit 1
fi
echo "    OK: premise: SSM_SECURE_VERSIONED_SAME (index ${SAME_IDX}) follows SSM_SECURE_EMBEDDED (index ${EMB_IDX}) and is the last key resolving to ${PARAM_NAME}"

assert_live_env "Phase 1"
assert_state_redacted "Phase 1"

# `diff --fail` on the unchanged stack: expression vs expression, no plaintext,
# and no spurious UPDATE (a resolved-vs-expression compare would report one on
# every deploy).
echo "==> Phase 1b: 'cdkd diff --fail' is clean and leaks nothing"
set +e
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail 2>&1)
DIFF_RC=$?
set -e
if leaks_marker "${DIFF_OUT}"; then
  echo "FAIL: 'cdkd diff' output leaked a SecureString value" >&2
  exit 1
fi
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' reported changes on an unchanged stack (rc=${DIFF_RC})" >&2
  diag_output "${DIFF_OUT}"
  exit 1
fi
echo "    OK: diff reports no changes and prints no plaintext"

echo "==> Phase 1c: 'cdkd scrub --dry-run' finds nothing on the freshly-deployed stack"
SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --dry-run 2>&1)
if leaks_marker "${SCRUB_OUT}"; then
  echo "FAIL: 'cdkd scrub' output leaked a SecureString value" >&2
  exit 1
fi
if grep -qiE 'no plaintext secrets|nothing to scrub' <<<"${SCRUB_OUT}"; then
  echo "    OK: scrub --dry-run reports the deployed state is already clean"
else
  echo "FAIL: scrub --dry-run should report nothing to scrub on a freshly-deployed stack" >&2
  diag_output "${SCRUB_OUT}"
  exit 1
fi

# `cdkd drift` now RESOLVES the reference in memory and compares it against
# the readback, instead of reporting the token as an unresolvable survivor
# (`notCompared` / `unresolvedToken`). A clean stack is fully compared: exit 0,
# no `notCompared` entry for the function, no plaintext printed.
echo "==> Phase 1d: 'cdkd drift' compares the reference and reports no drift"
set +e
DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>&1)
DRIFT_RC=$?
set -e
if leaks_marker "${DRIFT_OUT}"; then
  echo "FAIL: 'cdkd drift' output leaked a SecureString value" >&2
  exit 1
fi
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' exited ${DRIFT_RC} on a freshly-deployed stack" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
if grep -q 'unresolvedToken' <<<"${DRIFT_OUT}"; then
  echo "FAIL (issue #2482): drift still reports the ssm-secure reference as an unresolvable token" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: drift exits 0 with the reference compared, not reported as unresolvable"

# --- Phase 1e: scrub puts twin references back on their own expressions -------
# go-to-k/cdkd#7154. Pre-fix, the scrub positioned a list element with no
# `Name` / `Key` by the value scan, whose map is keyed by plaintext: both
# target `Input`s came back as the `:1` spelling, and the next deploy planned
# an update of the rule.
twin_rule_record() { # twin_rule_record <raw state.json> -> the rule's record
  printf '%s' "$1" | jq -c '.resources | to_entries[]
    | select(.value.resourceType=="AWS::Events::Rule") | .value' | head -1
}
twin_input() { # twin_input <record> <bag> <target id>
  printf '%s' "$1" | jq -r --arg b "$2" --arg id "$3" '.[$b].Targets // [] | map(select(.Id==$id)) | first | .Input // empty'
}
# Every object version under the stack prefix, the marker in none of them.
assert_no_marker_in_versions() { # <description>
  local desc="$1" rows key vid body scanned=0
  if ! rows="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
      --prefix "${STATE_PREFIX}" --query 'Versions[].[Key,VersionId]' --output text 2>&1)"; then
    echo "FAIL (${desc}): could not list object versions under the stack prefix" >&2
    diag_output "${rows}"
    exit 1
  fi
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    [ -n "${key}" ] && [ -n "${vid}" ] && [ "${vid}" != "None" ] || continue
    if ! body="$(aws s3api get-object --bucket "${STATE_BUCKET}" --key "${key}" \
        --version-id "${vid}" /dev/stdout < /dev/null 2>&1)"; then
      echo "FAIL (${desc}): could not read ${key} version ${vid}" >&2
      exit 1
    fi
    if leaks_marker "${body}"; then
      echo "FAIL (${desc}, issue #7154): ${key} version ${vid} still carries a SecureString value (withheld)" >&2
      exit 1
    fi
    scanned=$((scanned + 1))
  done <<< "${rows}"
  if [ "${scanned}" -eq 0 ]; then
    echo "FAIL (${desc}): scanned ZERO object versions under the stack prefix, so a clean verdict would be about nothing" >&2
    exit 1
  fi
  echo "    OK (${desc}): ${scanned} surviving object version(s) scanned, none carries a SecureString value"
}
if [ "${SCRUB_TWIN}" = "1" ]; then
  echo "==> Phase 1e: 'cdkd scrub' positions two references sharing one plaintext in a list (issue #7154)"
  TWIN_STATE_FILE="$(mktemp "${TMPDIR:-/tmp}/cdkd-7154-state.XXXXXX")"
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${TWIN_STATE_FILE}" --quiet
  TWIN_RECORD="$(twin_rule_record "$(cat "${TWIN_STATE_FILE}")")"
  TWIN_T0_EXPR="{\"pw\":\"${TOKEN_WHOLE}\"}"
  TWIN_T1_EXPR="{\"pw\":\"${TOKEN_VERSIONED_SAME}\"}"
  # PREMISE: the deploy wrote each target on its own expression, so the
  # rewrite below is what puts the plaintext there.
  if [ "$(twin_input "${TWIN_RECORD}" properties t0)" != "${TWIN_T0_EXPR}" ] \
      || [ "$(twin_input "${TWIN_RECORD}" properties t1)" != "${TWIN_T1_EXPR}" ]; then
    echo "FAIL: premise: the deployed rule record does not hold both target Inputs as their own expressions" >&2
    diag_output "${TWIN_RECORD}"
    exit 1
  fi
  # The record an older binary wrote: both target Inputs (and the readback's,
  # where it has them) in plaintext. `split | join`, so the tokens' braces are
  # not regex.
  jq --arg a "${TOKEN_WHOLE}" --arg b "${TOKEN_VERSIONED_SAME}" --arg m "${MARKER}" '
    def plain: if type == "string" then split($b) | join($m) | split($a) | join($m) else . end;
    .resources |= with_entries(
      if .value.resourceType == "AWS::Events::Rule" then
        .value.properties.Targets |= map(.Input |= plain)
        | if (.value.observedProperties.Targets | type) == "array"
          then .value.observedProperties.Targets |= map(if has("Input") then .Input |= plain else . end)
          else . end
      else . end)' "${TWIN_STATE_FILE}" > "${TWIN_STATE_FILE}.legacy"
  LEGACY_RECORD="$(twin_rule_record "$(cat "${TWIN_STATE_FILE}.legacy")")"
  if [ "$(twin_input "${LEGACY_RECORD}" properties t0)" != "{\"pw\":\"${MARKER}\"}" ] \
      || [ "$(twin_input "${LEGACY_RECORD}" properties t1)" != "{\"pw\":\"${MARKER}\"}" ]; then
    echo "FAIL: premise: could not write the plaintext into the rule's target Inputs, so the scrub would test nothing" >&2
    exit 1
  fi
  aws s3 cp "${TWIN_STATE_FILE}.legacy" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
  rm -f "${TWIN_STATE_FILE}" "${TWIN_STATE_FILE}.legacy"
  set +e
  SCRUB_TWIN_OUT=$(node "${LOCAL_DIST}" scrub "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --yes --purge-history 2>&1)
  SCRUB_TWIN_RC=$?
  set -e
  if leaks_marker "${SCRUB_TWIN_OUT}"; then
    echo "FAIL: 'cdkd scrub' output leaked a SecureString value (withheld)" >&2
    exit 1
  fi
  if [ "${SCRUB_TWIN_RC}" -ne 0 ]; then
    echo "FAIL: 'cdkd scrub' exited ${SCRUB_TWIN_RC} over the plaintext rule record" >&2
    diag_output "${SCRUB_TWIN_OUT}"
    exit 1
  fi
  SCRUBBED_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - 2>/dev/null)"
  if leaks_marker "${SCRUBBED_STATE}"; then
    echo "FAIL (issue #7154): the scrubbed state still carries a SecureString value (withheld)" >&2
    exit 1
  fi
  SCRUBBED_RECORD="$(twin_rule_record "${SCRUBBED_STATE}")"
  TWIN_FAIL=0
  for pair in "t0|${TWIN_T0_EXPR}" "t1|${TWIN_T1_EXPR}"; do
    id="${pair%%|*}"
    want="${pair#*|}"
    got="$(twin_input "${SCRUBBED_RECORD}" properties "${id}")"
    if [ "${got}" != "${want}" ]; then
      echo "FAIL (issue #7154): after scrub, target ${id}'s Input is not its own expression" >&2
      echo "      want: ${want}" >&2
      diag_output "${got}"
      TWIN_FAIL=1
    fi
  done
  if [ "${TWIN_FAIL}" -ne 0 ]; then
    diag_output "${SCRUB_TWIN_OUT}"
    exit 1
  fi
  echo "    OK: scrub wrote each target Input back on its own expression"
  set +e
  DIFF_TWIN_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" --fail 2>&1)
  DIFF_TWIN_RC=$?
  set -e
  if leaks_marker "${DIFF_TWIN_OUT}"; then
    echo "FAIL: 'cdkd diff' after scrub leaked a SecureString value (withheld)" >&2
    exit 1
  fi
  if [ "${DIFF_TWIN_RC}" -ne 0 ]; then
    echo "FAIL (issue #7154): 'cdkd diff --fail' after scrub reported changes (rc=${DIFF_TWIN_RC})" >&2
    diag_output "${DIFF_TWIN_OUT}"
    exit 1
  fi
  if ! node "${LOCAL_DIST}" deploy "${STACK}" --state-bucket "${STATE_BUCKET}" \
      --region "${REGION}" --yes > "${DEPLOY_LOG}" 2>&1; then
    echo "FAIL: the re-deploy after scrub exited non-zero" >&2
    show_deploy_log "post-scrub deploy" >&2
    exit 1
  fi
  if leaks_marker "$(cat "${DEPLOY_LOG}")"; then
    echo "FAIL: the re-deploy after scrub leaked a SecureString value (output withheld)" >&2
    exit 1
  fi
  if ! grep -qF 'No changes detected' "${DEPLOY_LOG}"; then
    echo "FAIL (issue #7154): the re-deploy after scrub planned a change (NO_CHANGE expected)" >&2
    show_deploy_log "post-scrub deploy" >&2
    exit 1
  fi
  echo "    OK: diff --fail is clean and the re-deploy reports NO_CHANGE"
  assert_no_marker_in_versions "Phase 1e"
fi

# --- Phase 2: Tags-only UPDATE ---------------------------------------------
echo "==> Phase 2: re-deploy with a tag added (Tags-only in-place UPDATE)"
if ! CDKD_TEST_UPDATE=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes > "${DEPLOY_LOG}" 2>&1; then
  echo "FAIL: the update deploy exited non-zero" >&2
  show_deploy_log "update" >&2
  exit 1
fi
if grep -qF -e "${MARKER}" -e "${MARKER_VERSIONED}" "${DEPLOY_LOG}"; then
  echo "FAIL: the update's deploy output leaked a SecureString value (output withheld)" >&2
  exit 1
fi
show_deploy_log "update"
TAG_VALUE=$(aws lambda list-tags --resource "$(aws lambda get-function-configuration \
  --function-name "${FN_NAME}" --region "${REGION}" --query 'FunctionArn' --output text)" \
  --region "${REGION}" --query 'Tags."cdkd-update-probe"' --output text)
if [ "${TAG_VALUE}" != "true" ]; then
  echo "FAIL: the update phase's tag did not reach AWS (got '${TAG_VALUE}') — the UPDATE did not happen, so the assertions below are not about a re-send" >&2
  exit 1
fi
# The Lambda provider compares the resolved desired env against the redacted
# previous, so a re-send of the env block is expected here; what is asserted
# is that whatever it sent carries the VALUE, never the token.
assert_live_env "Phase 2"
assert_state_redacted "Phase 2"

# --- Phase 3: destroy --------------------------------------------------------
echo "==> Phase 3: destroy"
# CAPTURED and scanned before a byte is shown, exactly like the two deploy
# phases. No realistic leak channel is known here — by this point state holds
# only expressions and destroy prints resource ids, with in-process masking
# still active — but "no channel is known" is the claim every other phase in
# this fixture declines to make about itself, and an unscanned stream is where
# a masking regression would surface unmasked in a CI log.
if ! node "${LOCAL_DIST}" destroy "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --force > "${DEPLOY_LOG}" 2>&1; then
  echo "FAIL: destroy exited non-zero" >&2
  show_deploy_log "destroy" >&2
  exit 1
fi
if grep -qF -e "${MARKER}" -e "${MARKER_VERSIONED}" "${DEPLOY_LOG}"; then
  echo "FAIL: the destroy output leaked a SecureString value (output withheld)" >&2
  exit 1
fi
show_deploy_log "destroy"
assert_gone "Lambda function ${FN_NAME} still exists after destroy" aws lambda get-function --function-name "${FN_NAME}" --region "${REGION}"
echo "    consumer function deleted"
if [ "${SCRUB_TWIN}" = "1" ]; then
  assert_gone "EventBridge rule ${TWIN_RULE_NAME} still exists after destroy" aws events describe-rule --name "${TWIN_RULE_NAME}" --region "${REGION}"
  assert_gone "SQS queue ${TWIN_RULE_NAME} still exists after destroy" aws sqs get-queue-url --queue-name "${TWIN_RULE_NAME}" --region "${REGION}"
  echo "    #7154 rule and queue deleted"
fi
assert_gone "state file ${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    cdkd state removed"

# Success path: nothing needs the state any more, so purge EVERY version and
# delete marker under the stack prefix, then assert the sweep (issue #2096).
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "ssm-secure-dynamic-ref state teardown"
assert_gone "SecureString parameter ${PARAM_NAME} still exists after cleanup" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
assert_gone "SecureString parameter ${PARAM_NAME_VERSIONED} still exists after cleanup" aws ssm get-parameter --name "${PARAM_NAME_VERSIONED}" --region "${REGION}"
echo "    state bucket versions swept; parameters removed"

echo "[verify] PASS — {{resolve:ssm-secure:...}} resolves to the SecureString value on AWS and to the expression in state (issue #2482)"
