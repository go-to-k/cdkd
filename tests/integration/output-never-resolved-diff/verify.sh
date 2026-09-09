#!/usr/bin/env bash
# verify.sh - cdkd output-never-resolved-diff integ (issue #2740).
#
# An Output whose resolution fails INSIDE a secret lookup on every deploy — a
# JSON key the secret does not hold — is SKIPPED by the deploy under the
# default (non-strict) arm: a warn, `undefined` for the key, and
# the key never reaches `state.outputs`. `cdkd diff` resolves outputs with
# `skipDynamicReferences`, so the same reference ASSEMBLES into its token there
# instead of failing; pre-fix the diff then pushed `[+] NeverResolves` on every
# run of the unchanged stack and `--fail` exited 1 for a change no deploy would
# ever make.
#
# The fix records the skipped key with a digest of its template inputs
# (`StackState.skippedOutputs`) and lets the diff preview a still-absent key
# whose digest is unchanged as ABSENT — no row, and no failed section, so a
# sibling's genuine change still renders.
#
# Phases:
#   1.  deploy; the deploy warns for the outputs; state lacks both skipped
#       keys, holds the resolving sibling as its expression, and carries the
#       record for the two SKIPPED keys alone — the sibling and the literal
#       are absent from it
#   2.  `diff --fail` on the unchanged stack exits 0, with no row and no
#       "could not be resolved" warning — THE assertion (pre-fix: rc 1)
#   2b. a SIBLING output changed (CDKD_TEST_SIBLING=true): `diff --fail`
#       exits 1 and renders the sibling's row while NeverResolves still has
#       none — the record must not suppress the section
#   2c. a RESOURCE an output references changed (CDKD_TEST_RESOURCE_EDIT=true
#       moves the RefMarker SSM parameter's value): `diff --fail` exits 1,
#       the resource row for RefMarker is the premise, NeverResolvesViaRef
#       shows its row because its record no longer binds, and NeverResolves
#       shows NONE — the un-bind is per output, not per stack. Without this
#       phase a `referencedLogicalIds` that returns nothing passes the whole
#       fixture (review round 2)
#   3.  a no-change re-deploy re-saves nothing (`lastModified` unchanged)
#   4.  UPGRADE: the field is stripped from state.json out of band (a record a
#       pre-#2740 binary wrote) and a no-change deploy writes it back with the
#       same digest; `diff --fail` exits 0 again
#   5.  REPAIR (CDKD_TEST_UPDATE=true switches BOTH broken Values to a key
#       that exists): `diff --fail` exits 1 and renders both rows — the record
#       must NOT suppress a repaired output; the deploy publishes the keys as
#       their expressions and empties the record; `diff --fail` exits 0.
#       Both repair together because a PARTIAL repair publishes nothing at all
#       (go-to-k/cdkd#2771), which is an engine limitation, not this fix
#   6.  destroy; secret gone or scheduled for deletion; state gone; every
#       state-object version swept
#
# SECURITY: the secret's only value (`username`) is test data, but it is a
# secret-derived value all the same, so no captured output is echoed before
# it is checked for that plaintext, and a failure diagnostic withholds text
# carrying it.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - defaults to us-east-1

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

# Shared S3 VERSION-sweep helpers (issue #2096): the state bucket is versioned,
# so `aws s3 rm` only writes a delete marker.
. ../s3-versions.sh

STACK="CdkdOutputNeverResolvedDiffExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

SECRET_NAME="cdkd-test-neverres-secret-${ACCOUNT_ID}"
# The secret's ONLY value. Test data, still never printed.
EXPECTED_USERNAME="cdkd-neverres-user"
# The one literal `diag_output` redacts, and it lives in TWO files — here and
# in the stack that seeds the secret. If the stack's copy drifted, every
# diagnostic below would redact a string the run no longer produces and print
# the live one instead. Pinned at STARTUP, offline, before anything can print:
# the deployed-value checks that would otherwise catch it all run after the
# first deploy, and several diagnostics fire before then.
#
# `EXPECTED_USERNAME` is the needle every plaintext guard below greps for, and
# it lives in TWO places — here and in the stack that seeds the secret. If the
# stack's copy drifted, every guard would be watching for a value nothing
# produces. The check is NOT a source-text scan (a comment carrying the old
# spelling, or a differently-quoted key, defeats any spelling of that): the
# authority is the SYNTHESIZED template, read in the premise block below,
# which is where the value actually comes from. The premise block runs before
# any diagnostic that could carry the live seed, and reads the seed FIRST —
# see the ordering note there.
EXPECTED_PLAIN="cdkd-neverres-plain-value"
# The `Plain` sibling's value under CDKD_TEST_SIBLING=true (Phase 2b).
EXPECTED_PLAIN_CHANGED="cdkd-neverres-plain-value-changed"
# The two reference spellings the template carries, verbatim.
BROKEN_REF="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}"
REPAIRED_REF="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:username}}"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

# Echo a captured command output as FAILURE diagnostics, never before proving
# it carries no plaintext: these diagnostics sit on the paths that exist to
# detect a leak, so an unchecked echo would print the value at the moment it
# leaked. Here-strings, never `printf | grep -q` (issue #2582).
diag_output() { # diag_output <text>
  local text="$1"
  if grep -qF "${EXPECTED_USERNAME}" <<<"${text}"; then
    echo "      output: <WITHHELD — it carries the resolved secret value, which is itself a bug>" >&2
    return 0
  fi
  echo "      output: ${text}" >&2
}

# Startup self-check of the guard above: a text carrying the plaintext must be
# withheld — the marker present AND the plaintext absent, since a guard that
# printed both would pass a marker-only check — and a benign text must print,
# or every diagnostic below is either a leak or a blank.
DIAG_PROBE=$(diag_output "probe ${EXPECTED_USERNAME} probe" 2>&1)
if ! grep -qF "WITHHELD" <<<"${DIAG_PROBE}" || grep -qF "${EXPECTED_USERNAME}" <<<"${DIAG_PROBE}"; then
  echo "FAIL: diag_output did not withhold a text carrying the plaintext" >&2
  exit 1
fi
if ! diag_output "benign probe text" 2>&1 | grep -qF "benign probe text"; then
  echo "FAIL: diag_output withheld a benign text" >&2
  exit 1
fi

# Read the CURRENT state object. Strict: a failed read aborts under `set -e`
# rather than feeding an empty document to jq.
read_state() {
  aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - --quiet
}

# Assert a captured output carries no plaintext. `what` names the capture.
assert_no_plaintext() { # assert_no_plaintext <what> <text>
  local what="$1" text="$2"
  if grep -qF "${EXPECTED_USERNAME}" <<<"${text}"; then
    echo "FAIL: ${what} leaked the resolved secret value (the 'username' key)" >&2
    exit 1
  fi
}

# The same guard over a STATE document, minus the one place the plaintext is
# the fixture's OWN doing: the secret's `SecretString` is a literal in the
# template (`unsafePlainText`), and cdkd persists a literal resource property
# as written — it is not a resolved secret, so no redaction pass names it.
# What this fixture guards is everything else: `outputs`, `skippedOutputs`,
# attributes, observed properties of other keys. The deletion is exact — that
# ONE property, and only under a resource whose `resourceType` is the seeded
# `AWS::SecretsManager::Secret` — never a wholesale exemption; the startup
# controls below refuse a widening in either direction.
assert_state_no_plaintext() { # assert_state_no_plaintext <what> <state-json>
  local what="$1" doc="$2" rest
  # Scoped to the SEEDED secret — its TYPE *and* its NAME — rather than to
  # every resource or every secret: a wider `del` would hide a future
  # resource's leak in the very field this guard exists to watch, and a
  # type-only exemption would do the same for a second secret the fixture
  # might grow (review nit). The name is matched on the record's own `Name`
  # property or on its physical id, which is the ARN carrying that name.
  # The guard's own jq was the last unrouted printer in the fixture: jq echoes
  # the offending input on a parse or filter error, and its input here is the
  # STATE DOCUMENT — the one text that carries the seeded plaintext by
  # construction. So its stderr is captured and released through `diag_output`,
  # and a failure is FATAL rather than an empty `rest` the plaintext check
  # would sail through. (jq truncates a long echoed value to its first
  # characters, so this routing is a fence rather than an observed leak —
  # measured: a `has no keys` error printed `cdkd-integ...`, which
  # `diag_output` correctly does not withhold because it is not the value.)
  local jq_err
  jq_err=$(mktemp)
  if ! rest=$(jq -c --arg t 'AWS::SecretsManager::Secret' --arg n "${SECRET_NAME}" '
      # The physical id is the ARN, whose last segment is the secret name plus
      # AWS'"'"'s six-character suffix. Matched EXACTLY (equal, or the name plus
      # `-` and exactly six more characters) — `contains` would admit a
      # different secret named `<name>-other`, whose ARN carries ours as a
      # prefix.
      def arn_names_seed:
        # BOTH fallbacks are live. The first covers a record with no
        # `physicalId`; the second covers what that produces — measured on
        # jq 1.7: `"" | split(":secret:")` is `[]`, so `last` is `null` and
        # `startswith` on it ABORTS the whole guard. That abort is invisible
        # from the refusal side, since a crashing guard also "refuses"; the
        # benign positive control below is what keeps it honest.
        (. // "") | split(":secret:") | last | (. // "")
        | (. == $n) or (startswith($n + "-") and (length == ($n | length) + 7));
      def is_seed:
        .resourceType == $t
        and (
          (.properties.Name? == $n)
          or (.observedProperties.Name? == $n)
          or (.physicalId? | arn_names_seed)
        );
      .resources |= with_entries(
        if (.value | is_seed)
        then .value |= (del(.properties.SecretString) | del(.observedProperties.SecretString))
        else . end)' <<<"${doc}" 2>"${jq_err}"); then
    echo "FAIL: ${what} — the state guard's own jq failed, so nothing was checked" >&2
    diag_output "$(cat "${jq_err}")"
    rm -f "${jq_err}"
    exit 1
  fi
  rm -f "${jq_err}"
  assert_no_plaintext "${what}" "${rest}"
}

# Startup self-check of the state guard: the seed property alone must pass;
# the same plaintext in EVERY other position — an output, a resource's
# attributes, another resource property, an observed property under another
# key, the record itself — must fail, so the exemption cannot quietly widen
# into `del(.resources)`.
# POSITIVES — documents `assert_state_no_plaintext` must ACCEPT. 1 is about
# COMPLETION rather than a predicate arm: a DIFFERENT secret with no
# `physicalId` at all and no plaintext in it, which the guard must pass. The
# ARN predicate walks `null` for that record, and without both `// ""`
# fallbacks jq aborts — and a crashing guard "refuses" every document, so the
# negatives below cannot see it; only a positive can. 2-5 each identify the
# SEEDED secret through a different arm of `is_seed`, so no arm can be deleted
# without one of them refusing a document it must accept: 3 names it only
# through the drift read-back (`observedProperties.Name`), while 4 and 5 carry
# no `Name` anywhere and so depend on the physical-id fallback alone, 5 with
# AWS's real six-character ARN suffix — the shape a live record has.
SELF_SEED_POSITIONS=(
  benign-other-secret-with-no-physicalId
  seed-by-name-property
  seed-by-observed-name-property
  seed-by-arn-exact-name
  seed-by-arn-name-plus-aws-suffix
)
SELF_SEED_DOCS=(
  '{"resources":{"O":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"some-other-secret","SecretString":"nothing-secret-here"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"'"${SECRET_NAME}"'","SecretString":"{\"username\":\"'"${EXPECTED_USERNAME}"'\"}"},"observedProperties":{"SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","observedProperties":{"Name":"'"${SECRET_NAME}"'","SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","physicalId":"arn:aws:secretsmanager:us-east-1:111122223333:secret:'"${SECRET_NAME}"'","properties":{"SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","physicalId":"arn:aws:secretsmanager:us-east-1:111122223333:secret:'"${SECRET_NAME}"'-AbCdEf","properties":{"SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
)
if [ "${#SELF_SEED_DOCS[@]}" -ne "${#SELF_SEED_POSITIONS[@]}" ]; then
  echo "FAIL: the seed self-check arrays disagree — ${#SELF_SEED_DOCS[@]} docs, ${#SELF_SEED_POSITIONS[@]} positions" >&2
  exit 1
fi
for i in "${!SELF_SEED_DOCS[@]}"; do
  if ! (assert_state_no_plaintext "self-check seed" "${SELF_SEED_DOCS[$i]}") >/dev/null 2>&1; then
    echo "FAIL: assert_state_no_plaintext refused the fixture's own seed property (identified by: ${SELF_SEED_POSITIONS[$i]})" >&2
    exit 1
  fi
done

# The guard's own jq must be FATAL, not a silent pass over an unchecked
# document: `.resources` as a string makes `with_entries` error, and the
# original exits 1 where a version without the `exit 1` exits 0. The captured
# diagnostics must also carry no plaintext, since jq echoes the offending
# input and that input is the state document.
SELF_MALFORMED='{"resources":"'"${EXPECTED_USERNAME}"'"}'
MALFORMED_RC=0
MALFORMED_OUT=$( (assert_state_no_plaintext "self-check malformed" "${SELF_MALFORMED}") 2>&1 ) || MALFORMED_RC=$?
if [ "${MALFORMED_RC}" -eq 0 ]; then
  echo "FAIL: assert_state_no_plaintext returned success on a document its own jq could not process" >&2
  exit 1
fi
if grep -qF "${EXPECTED_USERNAME}" <<<"${MALFORMED_OUT}"; then
  echo "FAIL: the state guard's jq-failure diagnostics carried the plaintext" >&2
  exit 1
fi
# ...and it went through `diag_output`, not a bare echo. Checking only for the
# ABSENCE of the plaintext cannot tell those apart: jq truncates an echoed
# value to its first characters (measured — a `has no keys` error printed
# `cdkd-integ...`), so a bare echo of that stderr is already needle-free and
# survives. `diag_output`'s own `      output: ` prefix is the discriminator,
# and it is the only thing in this fixture that emits it.
if ! grep -qF "      output: " <<<"${MALFORMED_OUT}"; then
  echo "FAIL: the state guard's jq-failure diagnostics did not go through diag_output" >&2
  exit 1
fi
# Labelled, so the failure message names the POSITION and never the document
# (which carries the plaintext by construction).
SELF_LEAK_POSITIONS=(
  outputs
  seed-resource-another-property
  seed-resource-attributes
  seed-resource-attributes-secretstring
  seed-resource-observed-another-key
  another-resource-type-seed-name
  another-secret-same-property
  another-secret-whose-arn-extends-the-seed-name
  another-secret-whose-arn-segment-is-the-same-LENGTH
  skippedOutputs
)
# Each control catches ONE way the exemption could widen, so none of them is
# redundant. 2-5: the seeded secret itself, plaintext in a field the exemption
# does not name — a widened `del(.properties, .observedProperties,
# .attributes)` stops refusing them — each carries the seed's NAME so it
# reaches the exemption at all, which is what makes the widening observable.
# 3 and 4 are BOTH needed: 3 puts the plaintext under `attributes.Arn`, which
# survives an exemption grown to `del(.attributes.SecretString)`, and 4 is that
# exact key — the narrowest widening, and the one a reviewer chasing a false
# positive would reach for first. 6: a DIFFERENT resource type carrying the
# seed's NAME, so dropping the type filter stops refusing it. 7: the seeded
# type under a DIFFERENT name, so dropping the name filter stops refusing that
# one. 8: a different secret whose ARN carries the seed's name as a PREFIX, so
# loosening the ARN match to `contains` stops refusing it. 9: a different
# secret whose ARN segment is the SAME LENGTH as the seed's would be, so
# dropping `startswith($n + "-")` and keeping only the length arithmetic stops
# refusing it. Each control carries the half its own filter does not watch —
# one missing that half is inert against exactly the removal it exists for.
# 1 and 10 sit outside `.resources` entirely.
SELF_LEAK_DOCS=(
  '{"resources":{},"outputs":{"Resolves":"'"${EXPECTED_USERNAME}"'"}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"'"${SECRET_NAME}"'","Description":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"'"${SECRET_NAME}"'"},"attributes":{"Arn":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"'"${SECRET_NAME}"'"},"attributes":{"SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"S":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"'"${SECRET_NAME}"'"},"observedProperties":{"Description":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"L":{"resourceType":"AWS::Lambda::Function","properties":{"Name":"'"${SECRET_NAME}"'","SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"O":{"resourceType":"AWS::SecretsManager::Secret","properties":{"Name":"some-other-secret","SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"P":{"resourceType":"AWS::SecretsManager::Secret","physicalId":"arn:aws:secretsmanager:us-east-1:111122223333:secret:'"${SECRET_NAME}"'-other-AbCdEf","properties":{"Name":"'"${SECRET_NAME}"'-other","SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{"Q":{"resourceType":"AWS::SecretsManager::Secret","physicalId":"arn:aws:secretsmanager:us-east-1:111122223333:secret:x'"${SECRET_NAME#?}"'-AbCdEf","properties":{"Name":"x'"${SECRET_NAME#?}"'","SecretString":"'"${EXPECTED_USERNAME}"'"}}},"outputs":{}}'
  '{"resources":{},"outputs":{},"skippedOutputs":{"X":"'"${EXPECTED_USERNAME}"'"}}'
)
# The two arrays are indexed together and the loop keys on the DOCS array, so
# each direction of a drift fails in its own unhelpful way. A doc appended
# without its label: the control runs, and if it ever CATCHES something the
# message interpolates an out-of-range index, which under `set -u` aborts with
# bash's own `SELF_LEAK_POSITIONS[$i]: unbound variable` (measured) instead of
# naming the position — the diagnostic is lost exactly when it is needed. A
# label added without its doc: the control simply never runs, and nothing says
# so. One equality check refuses both.
if [ "${#SELF_LEAK_DOCS[@]}" -ne "${#SELF_LEAK_POSITIONS[@]}" ]; then
  echo "FAIL: the leak self-check arrays disagree — ${#SELF_LEAK_DOCS[@]} docs, ${#SELF_LEAK_POSITIONS[@]} positions" >&2
  exit 1
fi
for i in "${!SELF_LEAK_DOCS[@]}"; do
  if (assert_state_no_plaintext "self-check leak" "${SELF_LEAK_DOCS[$i]}") >/dev/null 2>&1; then
    echo "FAIL: assert_state_no_plaintext passed a plaintext outside the seed property (position: ${SELF_LEAK_POSITIONS[$i]})" >&2
    exit 1
  fi
done

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  # The synth scratch dir, on every exit path (the success path removes it
  # itself once the premise is checked).
  [ -n "${SYNTH_DIR:-}" ] && rm -rf "${SYNTH_DIR}"
  # ...and the two stderr captures, for the window between each `mktemp` and
  # its own `rm -f`. Both are owner-only at 0600 and hold one command's
  # diagnostics, so this is the same tidiness the scratch dir gets rather than
  # a leak — the plaintext guards run on the CAPTURED TEXT and never rewrite
  # the file. `jq_err` is a function-local and bash locals are dynamically
  # scoped, so a trap firing inside that function does see it; outside, the
  # name is simply unset and the guard below skips it.
  [ -n "${DESTROY_ERR:-}" ] && rm -f "${DESTROY_ERR}"
  [ -n "${jq_err:-}" ] && rm -f "${jq_err}"
  # `RENDER_ERR` needs no line of its own: it lives under `SYNTH_DIR`, which
  # the `rm -rf` above already takes on every exit path.
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # NONCURRENT only here: this runs from the pre-run sweep and from the
    # failure traps, where a live state.json may be the only record of
    # resources still standing. The success path sweeps everything, once
    # destroy has been asserted.
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
  echo "FAIL: local binary not built at ${LOCAL_DIST} - run 'vp run build' from repo root first" >&2
  exit 1
fi

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Premise: the synthesized Outputs RENDER to exactly the two reference
# spellings this script asserts against, and the sibling reads the SAME
# secret. Rendered as the resolver assembles the value — a plain string as
# is, an `Fn::Join` joined with its own delimiter with `Ref AWS::AccountId`
# substituted (the shape CDK emits when `CDK_DEFAULT_ACCOUNT` did not reach
# the app) — and FAIL CLOSED on any other shape, so a template that routes
# through some third resolver arm cannot pass this guard by accident.
render_output() { # render_output <template.json> <OutputKey> -> the assembled Value
  jq -er --arg key "$2" --arg acct "${ACCOUNT_ID}" '
    def rendered:
      if type == "string" then .
      elif type == "object" and has("Fn::Join")
           and (.["Fn::Join"] | type == "array" and length == 2) then
        (.["Fn::Join"][0]) as $delim
        | (.["Fn::Join"][1]
           | map(if type == "string" then .
                 elif type == "object" and .Ref == "AWS::AccountId" then $acct
                 else error("unrenderable Fn::Join part: " + tojson) end)
           | join($delim))
      else error("unrenderable Output value: " + tojson) end;
    .Outputs[$key].Value | rendered' "$1"
}
echo "==> Premise: synthesized Outputs render to the two reference spellings"
SYNTH_DIR="$(mktemp -d)"
# ORDERING. `diag_output` withholds a text carrying `EXPECTED_USERNAME`, so it
# is trustworthy only once that constant is known to be the value the stack
# actually seeds — and this synth is the first thing in the run that could
# produce the live one. So the seed is read and compared BEFORE any capture is
# echoed, and the two paths that run before it print NO captured text at all:
# their message plus an exit status is enough to debug a fixture this small,
# and it is the only shape that cannot leak a drifted seed.
if ! SYNTH_OUT=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}" 2>&1); then
  echo "FAIL: the baseline synth failed (output withheld — the seed value is not yet known to match the redaction needle)" >&2
  exit 1
fi
SYNTH_TEMPLATE="${SYNTH_DIR}/${STACK}.template.json"
[ -f "${SYNTH_TEMPLATE}" ] || { echo "FAIL: synth produced no ${SYNTH_TEMPLATE}" >&2; exit 1; }
RENDER_ERR="${SYNTH_DIR}/render.err"
# The seed, straight out of the template — and out of EVERY variant's
# template, because a seed gated on one of the toggles would pass a
# baseline-only check and then reach `diag_output` under a needle that no
# longer matches it. jq's stderr is DISCARDED here rather than routed:
# `fromjson` over a malformed `SecretString` echoes that value, and this runs
# before anything is known to withhold it.
assert_seed_needle() { # assert_seed_needle <template.json> <which synth>
  local tpl="$1" which="$2" verdict
  # The WHOLE parsed seed, compared to `{username: <needle>}`, not just the
  # `username` field: a seed that kept `username` and GAINED a second key
  # would satisfy a field check while carrying a plaintext no guard greps for
  # — and would give the `password` lookup a key to FIND, which is the premise
  # this whole fixture rests on. Both halves, one comparison.
  #
  # The comparison happens INSIDE jq and yields only `ok` / `differs`, so
  # neither the found seed nor the expected one can reach a caller that might
  # echo it. That opacity is why this guard replaced a later, chattier key-set
  # check rather than sitting beside it: a gained KEY is as capable of carrying
  # the guarded value as a value is, and one guard that says nothing beats two
  # where the second prints the key names. jq's stderr is discarded for the same reason: `fromjson` over a
  # malformed `SecretString` echoes that value, and this runs before anything
  # is known to withhold it.
  verdict=$(jq -r --arg u "${EXPECTED_USERNAME}" '
      [.Resources[] | select(.Type == "AWS::SecretsManager::Secret") | .Properties.SecretString]
      | if length == 1 then
          (.[0] | fromjson) as $seed
          | if $seed == { username: $u } then "ok" else "differs" end
        else "not-one-secret" end' "${tpl}" 2>/dev/null) || verdict="unreadable"
  if [ "${verdict}" != "ok" ]; then
    echo "FAIL: the ${which} synth's secret seed is not exactly the single username this script redacts (${verdict}; both values withheld) — every plaintext guard would grep for a value nothing produces, and the 'password' lookup might resolve" >&2
    exit 1
  fi
}
assert_seed_needle "${SYNTH_TEMPLATE}" baseline
# From here on `diag_output` is known to withhold the value this run produces,
# so every capture below goes through it: a malformed fixture must not print
# the plaintext at the moment it is rejected, and jq's `error(... + tojson)`
# echoes the offending value verbatim.
if ! SYNTH_BROKEN=$(render_output "${SYNTH_TEMPLATE}" NeverResolves 2>"${RENDER_ERR}") \
   || ! SYNTH_SIBLING=$(render_output "${SYNTH_TEMPLATE}" Resolves 2>"${RENDER_ERR}"); then
  echo "FAIL: a synthesized Output value has a shape this guard cannot render" >&2
  diag_output "$(cat "${RENDER_ERR}")"
  exit 1
fi
if [ "${SYNTH_BROKEN}" != "${BROKEN_REF}" ] || [ "${SYNTH_SIBLING}" != "${REPAIRED_REF}" ]; then
  echo "FAIL: synthesized Output values do not render to the references this script asserts against" >&2
  diag_output "NeverResolves: ${SYNTH_BROKEN} | Resolves: ${SYNTH_SIBLING}"
  exit 1
fi
SYNTH_PLAIN=$(jq -er '.Outputs.Plain.Value' "${SYNTH_TEMPLATE}")
if [ "${SYNTH_PLAIN}" != "${EXPECTED_PLAIN}" ]; then
  echo "FAIL: synthesized Plain != ${EXPECTED_PLAIN}" >&2
  diag_output "Plain: ${SYNTH_PLAIN}"
  exit 1
fi
# Keep the baseline for the phase-2c premise below, which needs to compare
# the digest INPUTS across a resource edit.
SYNTH_BASELINE="${SYNTH_DIR}/baseline.template.json"
cp "${SYNTH_TEMPLATE}" "${SYNTH_BASELINE}"
# ...and the repaired synth flips BOTH broken outputs to the sibling's
# spelling, leaving the sibling and the literal alone.
# Withheld like the baseline's: a failed synth has no template to read the
# seed out of, so nothing yet proves this variant's seed is the needle.
if ! CDKD_TEST_UPDATE=true env -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}" >/dev/null 2>&1; then
  echo "FAIL: the repaired synth failed (output withheld — this variant's seed is not yet known to match the redaction needle)" >&2
  exit 1
fi
assert_seed_needle "${SYNTH_TEMPLATE}" repaired
if ! SYNTH_REPAIRED=$(render_output "${SYNTH_TEMPLATE}" NeverResolves 2>"${RENDER_ERR}"); then
  echo "FAIL: the repaired NeverResolves value has a shape this guard cannot render" >&2
  diag_output "$(cat "${RENDER_ERR}")"
  exit 1
fi
if [ "${SYNTH_REPAIRED}" != "${REPAIRED_REF}" ]; then
  echo "FAIL: CDKD_TEST_UPDATE=true did not repair NeverResolves to the username key" >&2
  diag_output "NeverResolves: ${SYNTH_REPAIRED}"
  exit 1
fi
# The second broken output repairs on the SAME toggle — asserted here rather
# than only in state, so a repaired branch that quietly became an ordinary
# literal is caught before the run costs an account.
# EXACT, not a substring: the repair must change the JSON KEY and nothing else,
# so the expected value is the BASELINE entry with `password` rewritten to
# `username`. A substring test passes for an ordinary literal, for a reference
# to a different secret, and for a still-broken value with `username` appended.
VIA_REF_BASE=$(jq -cS '.Outputs.NeverResolvesViaRef.Value' "${SYNTH_BASELINE}")
VIA_REF_WANT=${VIA_REF_BASE//:SecretString:password\}\}/:SecretString:username\}\}}
if [ "${VIA_REF_WANT}" = "${VIA_REF_BASE}" ]; then
  echo "FAIL: the baseline NeverResolvesViaRef value carries no ':SecretString:password}}' to repair — the expected-repair derivation is vacuous" >&2
  exit 1
fi
if ! SYNTH_REPAIRED_VIA_REF=$(jq -cS '.Outputs.NeverResolvesViaRef.Value' "${SYNTH_TEMPLATE}" 2>"${RENDER_ERR}"); then
  echo "FAIL: could not read the repaired NeverResolvesViaRef value out of the synthesized template" >&2
  diag_output "$(cat "${RENDER_ERR}")"
  exit 1
fi
if [ "${SYNTH_REPAIRED_VIA_REF}" != "${VIA_REF_WANT}" ]; then
  echo "FAIL: CDKD_TEST_UPDATE=true did not repair NeverResolvesViaRef to the baseline value with the username key" >&2
  diag_output "NeverResolvesViaRef: ${SYNTH_REPAIRED_VIA_REF}"
  exit 1
fi
# The siblings synthesize identically under the repair.
if ! SYNTH_REPAIRED_SIBLING=$(render_output "${SYNTH_TEMPLATE}" Resolves 2>"${RENDER_ERR}"); then
  echo "FAIL: the repaired synth's Resolves value has a shape this guard cannot render" >&2
  diag_output "$(cat "${RENDER_ERR}")"
  exit 1
fi
SYNTH_REPAIRED_PLAIN=$(jq -er '.Outputs.Plain.Value' "${SYNTH_TEMPLATE}")
if [ "${SYNTH_REPAIRED_SIBLING}" != "${REPAIRED_REF}" ] || [ "${SYNTH_REPAIRED_PLAIN}" != "${EXPECTED_PLAIN}" ]; then
  echo "FAIL: the repair changed a sibling too (Resolves or Plain differ from the baseline synth)" >&2
  exit 1
fi

# --- Premise for phase 2c: the resource edit moves the RESOURCE and NOTHING
# the digest reads. Without this, phase 2c's row could come from a changed
# digest rather than from the change map, and a `referencedLogicalIds` that
# returns nothing would still pass. Mirrors `skippedOutputDigest`'s coverage:
# every top-level section EXCEPT `Resources` and `Outputs`, plus the output's
# own entry.
if ! CDKD_TEST_RESOURCE_EDIT=true env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}" >/dev/null 2>&1; then
  echo "FAIL: the resource-edit synth failed (output withheld — this variant's seed is not yet known to match the redaction needle)" >&2
  exit 1
fi
assert_seed_needle "${SYNTH_TEMPLATE}" resource-edit
DIGEST_INPUTS='del(.Resources) | del(.Outputs)'
if [ "$(jq -cS "${DIGEST_INPUTS}" "${SYNTH_BASELINE}")" != "$(jq -cS "${DIGEST_INPUTS}" "${SYNTH_TEMPLATE}")" ]; then
  echo "FAIL: CDKD_TEST_RESOURCE_EDIT=true moved a template section the digest READS — phase 2c would not be about the change map" >&2
  exit 1
fi
for digested in NeverResolvesViaRef NeverResolves; do
  if [ "$(jq -cS --arg k "${digested}" '.Outputs[$k]' "${SYNTH_BASELINE}")" != "$(jq -cS --arg k "${digested}" '.Outputs[$k]' "${SYNTH_TEMPLATE}")" ]; then
    echo "FAIL: CDKD_TEST_RESOURCE_EDIT=true changed the ${digested} output entry, which the digest DOES read" >&2
    exit 1
  fi
done
# ...and it really did move the resource, or there is nothing for the change
# map to intersect with. Selected by TYPE, not by logical id: CDK appends a
# hash to the construct id (measured: `RefMarkerB2E23123`), so a literal
# `.Resources.RefMarker` is `null` on BOTH sides and the comparison would be
# about nothing. The `length == 1` guard keeps the selection honest if the
# stack ever grows a second parameter.
MARKER_RESOURCE='[.Resources | to_entries[] | select(.value.Type == "AWS::SSM::Parameter")] | if length == 1 then .[0] else error("expected exactly one SSM parameter, got " + (length | tostring)) end'
if ! MARKER_BASE=$(jq -ecS "${MARKER_RESOURCE}" "${SYNTH_BASELINE}" 2>"${RENDER_ERR}") \
   || ! MARKER_EDIT=$(jq -ecS "${MARKER_RESOURCE}" "${SYNTH_TEMPLATE}" 2>"${RENDER_ERR}"); then
  echo "FAIL: could not select the marker parameter out of a synthesized template" >&2
  diag_output "$(cat "${RENDER_ERR}")"
  exit 1
fi
if [ "${MARKER_BASE}" = "${MARKER_EDIT}" ]; then
  echo "FAIL: CDKD_TEST_RESOURCE_EDIT=true did not change the marker parameter" >&2
  exit 1
fi

# The last variant any phase drives. It gets a synth of its own for ONE reason:
# `assert_seed_needle` must see every template this run can produce, or a seed
# gated on this toggle alone would reach `diag_output` under a stale needle.
# The Plain value phase 2b greps for is pinned here too, offline, so a
# constant that drifted fails before the run costs an account.
if ! CDKD_TEST_SIBLING=true env -u CDKD_TEST_UPDATE -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" synth --region "${REGION}" --output "${SYNTH_DIR}" >/dev/null 2>&1; then
  echo "FAIL: the sibling-change synth failed (output withheld — this variant's seed is not yet known to match the redaction needle)" >&2
  exit 1
fi
assert_seed_needle "${SYNTH_TEMPLATE}" sibling-change
SYNTH_SIBLING_PLAIN=$(jq -er '.Outputs.Plain.Value' "${SYNTH_TEMPLATE}")
if [ "${SYNTH_SIBLING_PLAIN}" != "${EXPECTED_PLAIN_CHANGED}" ]; then
  echo "FAIL: CDKD_TEST_SIBLING=true did not change Plain to the value phase 2b greps for" >&2
  diag_output "Plain: ${SYNTH_SIBLING_PLAIN}"
  exit 1
fi
rm -rf "${SYNTH_DIR}"
echo "    OK: all four variants seed the same secret; both spellings render as asserted; the repair flips both broken outputs; the resource edit moves the resource and nothing the digest reads; the sibling toggle moves Plain"

# --- Phase 1: deploy — the output fails INSIDE the secret lookup -------------
echo "==> Phase 1: deploy (the NeverResolves lookup fails on the missing 'password' key)"
set +e
DEPLOY_OUT=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_RC=$?
set -e
assert_no_plaintext "the deploy output" "${DEPLOY_OUT}"
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: deploy exited ${DEPLOY_RC} — the default arm must skip the output, not abort" >&2
  diag_output "${DEPLOY_OUT}"
  exit 1
fi
# The deploy's OWN signal for each broken output. Positive: the phase must
# have taken the skip arm for BOTH, or every "no ADD" assertion below is
# vacuous. The trailing colon is load-bearing: `NeverResolves` is a PREFIX of
# `NeverResolvesViaRef`, so the bare needle matches either warning and one
# missing skip would go unnoticed.
for skipped in NeverResolves NeverResolvesViaRef; do
  if ! grep -qF "Failed to resolve output ${skipped}:" <<<"${DEPLOY_OUT}"; then
    echo "FAIL: the deploy did not warn 'Failed to resolve output ${skipped}:' — the premise (a lookup that fails at deploy) did not hold" >&2
    diag_output "${DEPLOY_OUT}"
    exit 1
  fi
done
echo "    OK: deploy succeeded and warned for both skipped outputs"

STATE_1=$(read_state)
assert_state_no_plaintext "state.json after deploy" "${STATE_1}"
# Exact equality on every field the record describes.
HAS_KEY=$(jq -r '.outputs | has("NeverResolves")' <<<"${STATE_1}")
SIBLING=$(jq -r '.outputs.Resolves' <<<"${STATE_1}")
PLAIN=$(jq -r '.outputs.Plain' <<<"${STATE_1}")
RECORD_KEYS=$(jq -c '(.skippedOutputs // {}) | keys' <<<"${STATE_1}")
DIGEST_1=$(jq -r '.skippedOutputs.NeverResolves' <<<"${STATE_1}")
LM_1=$(jq -r '.lastModified' <<<"${STATE_1}")
if [ "${HAS_KEY}" != "false" ]; then
  echo "FAIL: state.outputs holds NeverResolves after a deploy that could not resolve it" >&2
  exit 1
fi
if [ "${SIBLING}" != "${REPAIRED_REF}" ]; then
  echo "FAIL: state.outputs.Resolves is not the sibling's expression (got: $(jq -c '.outputs.Resolves' <<<"${STATE_1}"))" >&2
  exit 1
fi
if [ "${PLAIN}" != "${EXPECTED_PLAIN}" ]; then
  echo "FAIL: state.outputs.Plain != ${EXPECTED_PLAIN} (got: ${PLAIN})" >&2
  exit 1
fi
if [ "${RECORD_KEYS}" != '["NeverResolves","NeverResolvesViaRef"]' ]; then
  echo "FAIL: state.skippedOutputs keys != the two skipped outputs (got: ${RECORD_KEYS}) — the record must name the skipped keys and ONLY them" >&2
  exit 1
fi
if ! [[ "${DIGEST_1}" =~ ^[0-9a-f]{64}$ ]]; then
  echo "FAIL: state.skippedOutputs.NeverResolves is not a sha256 hex digest (got: ${DIGEST_1})" >&2
  exit 1
fi
echo "    OK: state lacks NeverResolves, holds the sibling as its expression, records the two skipped keys and only them"

# The diff-side warning the negative checks below grep for, pinned against
# the BUILT bundle so a reword of the producer
# (`src/cli/commands/diff-recursive.ts`) cannot leave those negatives green by
# accident. The DIFF-SPECIFIC fragment, not the bare needle: "could not be
# resolved" alone also occurs in deploy, resolver and scrub messages, so the
# bare needle would keep this control green through exactly the reword it
# exists to catch. The deploy-side needle has its positive control in Phase 1.
DIFF_WARN_FRAGMENT="may have changed, but one or more could not be resolved"
# The ONE row matcher every check below shares — negatives and the positive
# control alike, so a typo in it cannot leave a negative silently vacuous
# (review nit). `renderOutputChangeLines` indents an outputs row by four
# spaces; a resource row uses two, which is what keeps this off them.
OUTPUT_ROW_RE="^ {4}\\[[+~-]\\] "
# Count the rendered OUTPUT rows in a capture. `grep -c` exits 1 on no match
# and 2 on an error, and a `|| true` tail swallows both — so a grep that
# FAILED would leave the caller comparing an empty string, and `[ "" -ne 1 ]`
# returns 2, which `set -e` ignores inside an `if` condition and the check
# passes silently. `awk` always exits 0 and always prints an integer, and its
# pattern is inline rather than passed through `-v` (which would process the
# backslashes a second time), so every caller below compares a number.
count_output_rows() { # count_output_rows <capture> -> the number of output rows
  awk '/^ {4}\[[+~-]\] / { n++ } END { print n + 0 }' <<<"$1"
}
# ...and the counter is EXERCISED here too, on its own. It carries an
# INDEPENDENT copy of the row pattern — awk's, not `OUTPUT_ROW_RE` — so the
# row-matcher controls below say nothing about it: measured, dropping `-` from
# the counter's class left every one of them green and all three phase counts
# unchanged. Each marker, the empty capture, and both indents that must NOT
# count are checked, so any narrowing or widening of that copy fails here.
for MARKER in '+' '~' '-'; do
  if [ "$(count_output_rows "    [${MARKER}] Something")" != "1" ]; then
    echo "FAIL: count_output_rows does not count a '[${MARKER}]' output row" >&2
    exit 1
  fi
done
if [ "$(count_output_rows "$(printf '    [+] A\n    [~] B\n')")" != "2" ]; then
  echo "FAIL: count_output_rows does not add up over several output rows" >&2
  exit 1
fi
for NOT_A_ROW in \
  '' \
  'no rows here at all' \
  '  [~] RefMarkerB2E23123 (AWS::SSM::Parameter)' \
  '      [~] Value' \
  '    [?] UnknownMarker'; do
  if [ "$(count_output_rows "${NOT_A_ROW}")" != "0" ]; then
    echo "FAIL: count_output_rows counted a line that is not an output row: '${NOT_A_ROW}'" >&2
    exit 1
  fi
done
# Anchored on a word boundary: `NeverResolves` is a PREFIX of
# `NeverResolvesViaRef`, so an unanchored match would let the second output's
# row satisfy every negative written about the first.
never_resolves_row() { grep -qE "${OUTPUT_ROW_RE}NeverResolves( |\$)" <<<"$1"; }
via_ref_row() { grep -qE "${OUTPUT_ROW_RE}NeverResolvesViaRef( |\$)" <<<"$1"; }
# ...and the matcher is EXERCISED on all three markers here, not just the ADD
# the repair phase happens to render, so dropping `~` or `-` from the class
# fails at startup rather than at a negative that never fires.
# ...and NEGATIVES for the same pattern, which it did not have. `count_output_rows`
# carries its own copy and now has controls; `OUTPUT_ROW_RE` was the weaker
# spelling — measured, widening its class to `[^]]` or dropping its `^` left
# every control green, and both matter at the two POSITIVE uses of
# `via_ref_row`, where an anchor-less pattern lets a 6-indent property row
# satisfy a `! via_ref_row` check.
for NOT_A_ROW in \
  '    [?] NeverResolves' \
  '      [+] NeverResolves' \
  '  [+] NeverResolves' \
  'prefixed    [+] NeverResolves'; do
  if never_resolves_row "${NOT_A_ROW}" || via_ref_row "${NOT_A_ROW}ViaRef"; then
    echo "FAIL: the row matcher accepted a line that is not an output row: '${NOT_A_ROW}'" >&2
    exit 1
  fi
done
for MARKER in '+' '~' '-'; do
  if ! never_resolves_row "    [${MARKER}] NeverResolves"; then
    echo "FAIL: the shared row matcher does not match a rendered '[${MARKER}] NeverResolves' row" >&2
    exit 1
  fi
done
if never_resolves_row "  [+] NeverResolves (AWS::S3::Bucket)"; then
  echo "FAIL: the shared row matcher also matches a RESOURCE row" >&2
  exit 1
fi
if never_resolves_row "WARNING Outputs/NeverResolves/Value: Dynamic reference"; then
  echo "FAIL: the shared row matcher also matches CDK's synth validation warning" >&2
  exit 1
fi
if ! grep -rqF "${DIFF_WARN_FRAGMENT}" "$(dirname "${LOCAL_DIST}")"/*.js; then
  echo "FAIL: the built CLI no longer carries the diff warning fragment this fixture asserts the ABSENCE of: ${DIFF_WARN_FRAGMENT}" >&2
  exit 1
fi

# --- Phase 2: diff --fail on the UNCHANGED stack exits 0 -------------------
echo "==> Phase 2: 'cdkd diff --fail' on the unchanged stack (pre-fix: rc 1 with '[+] NeverResolves')"
set +e
DIFF_2=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_2_RC=$?
set -e
assert_no_plaintext "the diff output" "${DIFF_2}"
if [ "${DIFF_2_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' exited ${DIFF_2_RC} on the unchanged stack — the phantom ADD (issue #2740)" >&2
  diag_output "${DIFF_2}"
  exit 1
fi
# A RENDERED ROW, never the bare name: CDK's own synth validation prints
# `Outputs/NeverResolves/Value: Dynamic reference ... can only be used in
# resource properties` (E1051) on every synth, so the bare name is always in
# the capture. `[+] <name>` / `[~] <name>` / `[-] <name>` are the three shapes
# `renderOutputChangeLines` emits.
if never_resolves_row "${DIFF_2}"; then
  echo "FAIL: 'cdkd diff' still renders a NeverResolves row on the unchanged stack" >&2
  diag_output "${DIFF_2}"
  exit 1
fi
# With nothing else changed the resolutionFailed arm stays SILENT — the
# deploy's warn is the signal for the broken output, not a second one here.
if grep -qF "${DIFF_WARN_FRAGMENT}" <<<"${DIFF_2}"; then
  echo "FAIL: 'cdkd diff' warned '${DIFF_WARN_FRAGMENT}' on a stack with nothing else changed" >&2
  diag_output "${DIFF_2}"
  exit 1
fi
echo "    OK: diff --fail exits 0, no NeverResolves row, no warning"

# --- Phase 2b: a changed SIBLING is not hidden by the record -----------------
echo "==> Phase 2b: 'cdkd diff --fail' with the Plain sibling changed (CDKD_TEST_SIBLING=true) exits 1 and renders the sibling only"
set +e
DIFF_2B=$(CDKD_TEST_SIBLING=true env -u CDKD_TEST_UPDATE -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_2B_RC=$?
set -e
assert_no_plaintext "the sibling-change diff output" "${DIFF_2B}"
if [ "${DIFF_2B_RC}" -ne 1 ]; then
  echo "FAIL: 'cdkd diff --fail' with a changed sibling exited ${DIFF_2B_RC}, expected 1 — the record suppressed the Outputs section" >&2
  diag_output "${DIFF_2B}"
  exit 1
fi
if ! grep -qF "[~] Plain" <<<"${DIFF_2B}" || ! grep -qF "${EXPECTED_PLAIN_CHANGED}" <<<"${DIFF_2B}"; then
  echo "FAIL: the sibling-change diff did not render '[~] Plain' with the changed value" >&2
  diag_output "${DIFF_2B}"
  exit 1
fi
# BOTH skipped outputs must stay absent here: neither repair toggle is set, so
# both records still bind, and the row count pins it against a third row this
# phase never accounted for.
OUTPUT_ROWS_2B=$(count_output_rows "${DIFF_2B}")
if never_resolves_row "${DIFF_2B}" || via_ref_row "${DIFF_2B}" \
   || grep -qF "${DIFF_WARN_FRAGMENT}" <<<"${DIFF_2B}" || [ "${OUTPUT_ROWS_2B}" -ne 1 ]; then
  echo "FAIL: the sibling-change diff rendered ${OUTPUT_ROWS_2B} output row(s) or a skipped-output row or warned — only the Plain row may appear" >&2
  diag_output "${DIFF_2B}"
  exit 1
fi
echo "    OK: sibling change renders alone, both skipped outputs stay absent, diff --fail exits 1"

# --- Phase 2c: the record does NOT bind when a REFERENCED resource changes ---
# The arm that exercises the change-map half of the binding rule (review round
# 2). `NeverResolvesViaRef` is skipped exactly like `NeverResolves` and its
# `Fn::Sub` names the `RefMarker` parameter; `CDKD_TEST_RESOURCE_EDIT=true`
# changes ONLY that parameter's value, which the digest cannot see because
# `Resources` is not digested. So the two outputs differ in one thing alone —
# whether a resource they reference is changing — and the diff must render a
# row for the referencing one while the other stays absent. Without this phase
# a regression making `referencedLogicalIds` return nothing at all passes the
# whole fixture green.
echo "==> Phase 2c: a referenced resource changes (CDKD_TEST_RESOURCE_EDIT=true) — the record must not bind for that output"
set +e
DIFF_2C=$(CDKD_TEST_RESOURCE_EDIT=true env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_2C_RC=$?
set -e
assert_no_plaintext "the resource-edit diff output" "${DIFF_2C}"
if [ "${DIFF_2C_RC}" -ne 1 ]; then
  echo "FAIL: 'cdkd diff --fail' with the referenced resource changed exited ${DIFF_2C_RC}, expected 1" >&2
  diag_output "${DIFF_2C}"
  exit 1
fi
# PREMISE: the resource really is on the diff, or the un-bind had nothing to
# key on and the assertions below would be about the wrong thing.
if ! grep -qE "^ {2}\[~\] RefMarker" <<<"${DIFF_2C}"; then
  echo "FAIL: the resource-edit diff did not render the RefMarker parameter's own row" >&2
  diag_output "${DIFF_2C}"
  exit 1
fi
if ! via_ref_row "${DIFF_2C}"; then
  echo "FAIL: the record still bound for NeverResolvesViaRef although a resource it references is changing" >&2
  diag_output "${DIFF_2C}"
  exit 1
fi
# ...and the SIBLING skipped output, which references no resource, must stay
# suppressed — the un-bind is per output, not per run.
if never_resolves_row "${DIFF_2C}"; then
  echo "FAIL: NeverResolves lost its record too — the un-bind must be scoped to the output that references the changed resource" >&2
  diag_output "${DIFF_2C}"
  exit 1
fi
# ...and NOTHING else. Phases 2b and 5 both count their output rows; this one
# did not, so a spurious third row — a sibling that quietly stopped binding,
# an export alias appearing — would have passed unnoticed between two checks
# that each look at one name.
OUTPUT_ROWS_2C=$(count_output_rows "${DIFF_2C}")
if [ "${OUTPUT_ROWS_2C}" -ne 1 ]; then
  echo "FAIL: the resource-edit diff rendered ${OUTPUT_ROWS_2C} output row(s), expected exactly the one for NeverResolvesViaRef" >&2
  diag_output "${DIFF_2C}"
  exit 1
fi
echo "    OK: the referencing output un-binds alone, its sibling stays suppressed, diff --fail exits 1"

# --- Phase 3: a no-change re-deploy re-saves nothing ----------------------
echo "==> Phase 3: no-change re-deploy (record equal -> no state write)"
set +e
DEPLOY_3=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_3_RC=$?
set -e
assert_no_plaintext "the no-change deploy output" "${DEPLOY_3}"
if [ "${DEPLOY_3_RC}" -ne 0 ] || ! grep -qF "No changes detected" <<<"${DEPLOY_3}"; then
  echo "FAIL: the re-deploy did not take the no-change path (rc=${DEPLOY_3_RC})" >&2
  diag_output "${DEPLOY_3}"
  exit 1
fi
STATE_3=$(read_state)
assert_state_no_plaintext "state.json after the no-change deploy" "${STATE_3}"
LM_3=$(jq -r '.lastModified' <<<"${STATE_3}")
DIGEST_3=$(jq -r '.skippedOutputs.NeverResolves' <<<"${STATE_3}")
if [ "${LM_3}" != "${LM_1}" ]; then
  echo "FAIL: the no-change deploy re-saved state (lastModified ${LM_1} -> ${LM_3}) although the record was unchanged" >&2
  exit 1
fi
if [ "${DIGEST_3}" != "${DIGEST_1}" ]; then
  echo "FAIL: the record's digest moved on a no-change deploy (${DIGEST_1} -> ${DIGEST_3})" >&2
  exit 1
fi
echo "    OK: no state write, record intact"

# --- Phase 4: UPGRADE — a record without the field gains it -----------------
echo "==> Phase 4: strip skippedOutputs out of band (pre-#2740 record), no-change deploy writes it back"
STRIPPED=$(jq -c 'del(.skippedOutputs)' <<<"${STATE_3}")
if [ "$(jq -r 'has("skippedOutputs")' <<<"${STRIPPED}")" != "false" ]; then
  echo "FAIL: could not strip skippedOutputs from the state document" >&2
  exit 1
fi
printf '%s' "${STRIPPED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
# Prove the strip LANDED before reading anything back through cdkd.
if [ "$(read_state | jq -r 'has("skippedOutputs")')" != "false" ]; then
  echo "FAIL: the stripped state document did not land in S3" >&2
  exit 1
fi
set +e
DEPLOY_4=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_4_RC=$?
set -e
assert_no_plaintext "the upgrade-path deploy output" "${DEPLOY_4}"
if [ "${DEPLOY_4_RC}" -ne 0 ] || ! grep -qF "No changes detected" <<<"${DEPLOY_4}"; then
  echo "FAIL: the upgrade-path deploy did not take the no-change path (rc=${DEPLOY_4_RC})" >&2
  diag_output "${DEPLOY_4}"
  exit 1
fi
STATE_4=$(read_state)
assert_state_no_plaintext "state.json after the upgrade-path deploy" "${STATE_4}"
DIGEST_4=$(jq -r '.skippedOutputs.NeverResolves // "ABSENT"' <<<"${STATE_4}")
KEYS_4=$(jq -c '.skippedOutputs | keys' <<<"${STATE_4}")
LM_4=$(jq -r '.lastModified' <<<"${STATE_4}")
if [ "${DIGEST_4}" != "${DIGEST_1}" ]; then
  echo "FAIL: the no-change deploy did not write the record back with the same digest (got: ${DIGEST_4}, expected ${DIGEST_1})" >&2
  exit 1
fi
if [ "${KEYS_4}" != '["NeverResolves","NeverResolvesViaRef"]' ]; then
  echo "FAIL: upgrade-path record keys != the two skipped outputs (got: ${KEYS_4})" >&2
  exit 1
fi
if [ "${LM_4}" = "${LM_1}" ]; then
  echo "FAIL: lastModified did not advance on the upgrade-path save" >&2
  exit 1
fi
# The persisted bag and its export set are carried, not blanked, by that save.
if [ "$(jq -r '.outputs.Resolves' <<<"${STATE_4}")" != "${REPAIRED_REF}" ] || [ "$(jq -c '.exportNames' <<<"${STATE_4}")" != "[]" ]; then
  echo "FAIL: the upgrade-path save did not carry the outputs bag / export set (outputs.Resolves=$(jq -c '.outputs.Resolves' <<<"${STATE_4}") exportNames=$(jq -c '.exportNames' <<<"${STATE_4}"))" >&2
  exit 1
fi
set +e
DIFF_4=$(env -u CDKD_TEST_UPDATE -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_4_RC=$?
set -e
assert_no_plaintext "the post-upgrade diff output" "${DIFF_4}"
if [ "${DIFF_4_RC}" -ne 0 ] || never_resolves_row "${DIFF_4}"; then
  echo "FAIL: 'cdkd diff --fail' after the upgrade-path save exited ${DIFF_4_RC} or rendered a NeverResolves row" >&2
  diag_output "${DIFF_4}"
  exit 1
fi
echo "    OK: record written back with the same digest, bag carried, diff --fail exits 0"

# --- Phase 5: REPAIR — the record must not suppress a repaired output --------
echo "==> Phase 5: repair both broken Values (CDKD_TEST_UPDATE=true); diff shows the ADDs, deploy publishes and clears the record"
set +e
DIFF_5=$(CDKD_TEST_UPDATE=true env -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_5_RC=$?
set -e
assert_no_plaintext "the repair diff output" "${DIFF_5}"
if [ "${DIFF_5_RC}" -ne 1 ]; then
  echo "FAIL: 'cdkd diff --fail' with the repaired Value exited ${DIFF_5_RC}, expected 1 — the record suppressed a repaired output" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
# The POSITIVE control for the very regex the negatives above use: matched
# here against a diff that really renders the row, so a typo inside the
# character class cannot leave those three negatives vacuous (review nit).
if ! never_resolves_row "${DIFF_5}"; then
  echo "FAIL: the shared row matcher the negative checks use does not match a diff that DOES render the row" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
if ! via_ref_row "${DIFF_5}"; then
  echo "FAIL: the repair diff did not render the NeverResolvesViaRef row" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
if ! grep -qE "^ {4}\[\+\] NeverResolves( |$)" <<<"${DIFF_5}"; then
  echo "FAIL: the repair diff did not render '[+] NeverResolves' as an ADD row" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
# ...and NOTHING else: the repair touches the two broken outputs, so exactly
# two rows. Counted over the OUTPUT rows alone. The indent is the
# discriminator, taken from the renderer: an outputs row is `    [x] <name>`
# (FOUR spaces, `renderOutputChangeLines`) while a resource row is
# `  [x] <id> (<Type>)` (TWO), so a bare `[+] ` count would also count
# resource rows on a phase that ever grows one (review nit). Everything after
# the marker is left unanchored so an ` [export]` suffix still counts.
OUTPUT_ROWS=$(count_output_rows "${DIFF_5}")
if grep -qE "^ {4}\[[~-]\] " <<<"${DIFF_5}" || [ "${OUTPUT_ROWS}" -ne 2 ]; then
  echo "FAIL: the repair diff rendered ${OUTPUT_ROWS} output row(s), or a non-ADD one, rather than the two repaired ADDs" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
# The row's value is the EXPRESSION (the diff never resolves a secret).
if ! grep -qF "${REPAIRED_REF}" <<<"${DIFF_5}"; then
  echo "FAIL: the repair diff's new value is not the repaired expression" >&2
  diag_output "${DIFF_5}"
  exit 1
fi
echo "    OK: diff --fail exits 1 and renders both repaired ADDs, NeverResolves with its expression"

set +e
DEPLOY_5=$(CDKD_TEST_UPDATE=true env -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes 2>&1)
DEPLOY_5_RC=$?
set -e
assert_no_plaintext "the repair deploy output" "${DEPLOY_5}"
if [ "${DEPLOY_5_RC}" -ne 0 ]; then
  echo "FAIL: the repair deploy exited ${DEPLOY_5_RC}" >&2
  diag_output "${DEPLOY_5}"
  exit 1
fi
# Anchored on the colon for the same prefix reason as phase 1: unanchored,
# a still-broken `NeverResolvesViaRef` would be read as `NeverResolves`
# failing, and vice versa.
for repaired_key in NeverResolves NeverResolvesViaRef; do
  if grep -qF "Failed to resolve output ${repaired_key}:" <<<"${DEPLOY_5}"; then
    echo "FAIL: the repaired output ${repaired_key} still failed to resolve" >&2
    diag_output "${DEPLOY_5}"
    exit 1
  fi
done
STATE_5=$(read_state)
assert_state_no_plaintext "state.json after the repair deploy" "${STATE_5}"
if [ "$(jq -r '.outputs.NeverResolves // "ABSENT"' <<<"${STATE_5}")" != "${REPAIRED_REF}" ]; then
  echo "FAIL: state.outputs.NeverResolves is not the repaired expression after the repair deploy (got: $(jq -c '.outputs.NeverResolves' <<<"${STATE_5}"))" >&2
  exit 1
fi
# The toggle repairs BOTH broken outputs, so the record empties. It is not
# tested with only ONE of them repaired, and that is a limitation of the
# ENGINE rather than of the fixture: deploy's no-resource-change path keeps
# the previous outputs bag whenever any output is still unresolved, so a
# partial repair publishes nothing at all (go-to-k/cdkd#2771). Asserted as an
# empty KEY LIST rather than `has(...) == false`, so a record that kept a
# stale entry is caught whichever way the field is written.
KEYS_5=$(jq -c '(.skippedOutputs // {}) | keys' <<<"${STATE_5}")
if [ "${KEYS_5}" != '[]' ]; then
  echo "FAIL: after the repair the record must be empty (got: ${KEYS_5})" >&2
  exit 1
fi
# ...and it is EXACTLY `<the marker parameter's own name>-<repaired
# expression>`. The marker's name is CDK-generated, so it is read back from
# the same state document rather than spelled here — which is what makes this
# an equality and not a suffix test: a value whose `${Marker}` had been
# replaced by any other literal passes a suffix check and fails this one.
MARKER_NAME=$(jq -r '[.resources[] | select(.resourceType == "AWS::SSM::Parameter") | .physicalId] | if length == 1 then .[0] else "AMBIGUOUS" end' <<<"${STATE_5}")
if [ "${MARKER_NAME}" = "AMBIGUOUS" ] || [ -z "${MARKER_NAME}" ] || [ "${MARKER_NAME}" = "null" ]; then
  echo "FAIL: state does not hold exactly one SSM parameter, so the expected NeverResolvesViaRef value cannot be derived (got: ${MARKER_NAME})" >&2
  exit 1
fi
VIA_REF_5=$(jq -r '.outputs.NeverResolvesViaRef // "ABSENT"' <<<"${STATE_5}")
if [ "${VIA_REF_5}" != "${MARKER_NAME}-${REPAIRED_REF}" ]; then
  echo "FAIL: state.outputs.NeverResolvesViaRef is not <marker name>-<repaired expression> after the repair deploy" >&2
  diag_output "NeverResolvesViaRef: ${VIA_REF_5}"
  exit 1
fi
# The siblings' persisted values are untouched by the repair deploy.
if [ "$(jq -r '.outputs.Plain' <<<"${STATE_5}")" != "${EXPECTED_PLAIN}" ] || [ "$(jq -r '.outputs.Resolves' <<<"${STATE_5}")" != "${REPAIRED_REF}" ]; then
  echo "FAIL: the repair deploy changed a sibling's persisted value (Plain=$(jq -c '.outputs.Plain' <<<"${STATE_5}") Resolves=$(jq -c '.outputs.Resolves' <<<"${STATE_5}"))" >&2
  exit 1
fi
set +e
DIFF_5B=$(CDKD_TEST_UPDATE=true env -u CDKD_TEST_SIBLING -u CDKD_TEST_RESOURCE_EDIT node "${LOCAL_DIST}" diff "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --fail 2>&1)
DIFF_5B_RC=$?
set -e
assert_no_plaintext "the post-repair diff output" "${DIFF_5B}"
if [ "${DIFF_5B_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' after the repair deploy exited ${DIFF_5B_RC}" >&2
  diag_output "${DIFF_5B}"
  exit 1
fi
echo "    OK: both keys published as their expressions, record emptied, diff --fail exits 0"

# --- Phase 6: destroy ----------------------------------------------------
echo "==> Phase 6: destroy"
# CAPTURED and checked BEFORE it is echoed, which is this fixture's actual
# discipline — output that is discarded outright (the cleanup sweep, the
# premise synths) needs no check, and this was the one invocation that printed
# without one. Reading the printers, `destroy-runner.ts` emits logical ids, types
# and wrapped AWS messages and nothing renders a properties bag, so this is a
# fence rather than an observed leak — but "every capture is checked" is the
# rule, and one exception is what makes the rule unreadable. Re-emitted
# afterwards so the run log still carries the destroy summary the harness
# greps.
DESTROY_ERR="$(mktemp)"
set +e
DESTROY_OUT=$(node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes 2>"${DESTROY_ERR}")
DESTROY_RC=$?
set -e
# The two streams are captured SEPARATELY and re-emitted to the stream each
# came from: merging them would put destroy's stderr on stdout for any
# stream-sensitive reader of the run log. Both are checked before either is
# echoed.
DESTROY_ERR_TEXT="$(cat "${DESTROY_ERR}")"
rm -f "${DESTROY_ERR}"
assert_no_plaintext "the destroy output" "${DESTROY_OUT}"
assert_no_plaintext "the destroy diagnostics" "${DESTROY_ERR_TEXT}"
printf '%s\n' "${DESTROY_OUT}"
# An `if` rather than `[ ... ] && printf`. Measured: the `&&` form does NOT
# abort under `set -e` — a non-final command in an `&&` list is exempt — so
# this is legibility, not a fix. Empty stderr is the normal case, and a reader
# should not have to know that exemption to be sure of it.
if [ -n "${DESTROY_ERR_TEXT}" ]; then
  printf '%s\n' "${DESTROY_ERR_TEXT}" >&2
fi
if [ "${DESTROY_RC}" -ne 0 ]; then
  echo "FAIL: destroy exited ${DESTROY_RC}" >&2
  exit 1
fi

echo "==> Asserting resources are gone"
# SecretsManager deletes with a recovery window: DescribeSecret still answers
# with a DeletedDate, so "scheduled for deletion" is a PASS; only an ACTIVE
# secret with no DeletedDate is a leak.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
  SECRET_DELETED_DATE="GONE"
elif ! SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
    --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
  # TOCTOU: the secret can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<<"${SECRET_DELETED_DATE}" \
    && SECRET_DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED_DATE}" >&2; exit 1; }
fi
if [ "${SECRET_DELETED_DATE}" = "GONE" ]; then
  echo "    OK: secret is gone"
elif [ -n "${SECRET_DELETED_DATE}" ] && [ "${SECRET_DELETED_DATE}" != "None" ]; then
  echo "    OK: secret is scheduled for deletion (DeletedDate=${SECRET_DELETED_DATE})"
else
  echo "FAIL: secret '${SECRET_NAME}' still ACTIVE after destroy (no DeletedDate set)" >&2
  exit 1
fi

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH (issue #2096) ----------
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "output-never-resolved-diff state teardown"

echo ""
echo "[verify] PASS — output-never-resolved-diff (no phantom ADD on the unchanged stack, record written / carried / un-bound on a resource edit / cleared, clean destroy, zero surviving state versions)"
