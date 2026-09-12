#!/usr/bin/env bash
# verify.sh - cdkd secrets-dynamic-ref integ.
#
# Failure-seeking test for CloudFormation DYNAMIC REFERENCES
# (`{{resolve:secretsmanager:...}}` / `{{resolve:ssm:...}}`). cdkd resolves
# these itself in `resolveDynamicReferences`
# (src/deployment/intrinsic-function-resolver.ts) BEFORE the property reaches
# the provider, so AWS never sees the literal token.
#
# The fixture deploys:
#   - a SecretsManager secret with a KNOWN JSON value
#     ({"username":"cdkd-user","password":"cdkd-known-pw-123","pin":"q7"} -- `pin` is the
#     two-character secret of issue #2516)
#   - an SSM String parameter with a KNOWN value (cdkd-known-ssm-value)
#   - a consumer Lambda whose ENV VARS are literal {{resolve:...}} strings
#
# ...plus, created OUT OF BAND by this script (CloudFormation cannot create
# one), an SSM SecureString parameter the Lambda references through the PLAIN
# `{{resolve:ssm:...}}` form. That reference decrypts to a real secret, so
# issue #1901 requires it to be persisted as its expression while the String
# parameter beside it stays RESOLVED — the two together are what force the
# decision to be made on the parameter's TYPE rather than on the spelling.
#
# After deploy we read GetFunctionConfiguration and assert each env var
# carries the RESOLVED value rather than the literal {{resolve:...}} token.
# If a reference stays literal or resolves to the wrong value, the test FAILS
# with specifics.
#
# Phase 1d (issue #1914) then drives `cdkd drift` over the same stack: state
# holds the {{resolve:...}} expressions while AWS holds the resolved plaintext,
# so the command has to re-resolve for its comparison and for `--revert`'s
# provider call while persisting and printing only the expression. Phase 1e
# covers the standalone rollback.
#
# Phase 2 (CDKD_TEST_REMOVAL=true, issue #1160 secretsmanager batch) then
# drops the secret's Description + KmsKeyId from the template and asserts the
# live secret resets to the pristine defaults (both absent from
# DescribeSecret) instead of silently keeping the old values (UpdateSecret
# merges absent input fields). Phase 3 destroys.
#
# SECURITY: secret-derived values are NEVER printed. Assertions compare
# against a masked representation; only PASS/FAIL + a masked snippet is shown.
#
# Dynamic-reference forms exercised (and which cdkd supports):
#   - secretsmanager :SecretString:<jsonkey>            (JSON-key form)   SUPPORTED
#   - secretsmanager :SecretString  (no key)            (whole secret)    SUPPORTED
#   - secretsmanager :SecretString:<jsonkey>:AWSCURRENT (version-stage)   SUPPORTED
#   - ssm:<name>            (String param)              (plaintext param) SUPPORTED
#   - ssm:<name>            (SecureString param)        (decrypts, and is
#                                                        REDACTED in state)   SUPPORTED
#   - ssm-secure:<name>                                 (SecureString)    SUPPORTED since issue #2482 -> see note below
#
# `ssm-secure` is exercised by its OWN fixture, `ssm-secure-dynamic-ref`, which
# seeds the SecureString parameter out of band (CloudFormation cannot create
# one) and asserts the whole / embedded / versioned forms against a readable
# destination. Before issue #2482 the spelling hit the resolver's unsupported
# service `else` branch (warn + leave literal) and was skipped here.
# A version-ID form (`...:SecretString:key::<uuid>`) is also not exercised
# because the secret's version id is not known ahead of deploy; the
# version-STAGE slot (AWSCURRENT) covers the optional-trailing-field grammar.
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

# Shared S3 VERSION-sweep helpers (issue #2096). The state bucket is
# VERSIONED, so `aws s3 rm` only writes a delete marker and every state.json
# this fixture wrote -- including the pre-GHSA records it SEEDS with the
# plaintext password on purpose -- stays readable via GetObjectVersion after a
# green run. See the file header for the three traps that make a sweep
# silently partial.
. ../s3-versions.sh

STACK="CdkdSecretsDynamicRefExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
# Everything this stack owns in the bucket: state.json, lock.json,
# rollback-journal.json and deployments/**. Swept as one prefix so a key added
# later cannot be forgotten; the trailing '/' is what keeps a sibling stack
# whose name merely starts the same out of it.
STATE_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

SECRET_NAME="cdkd-test-dynref-secret-${ACCOUNT_ID}"
PARAM_NAME="cdkd-test-dynref-param-${ACCOUNT_ID}"
# SecureString counterpart (issue #1901). Created by THIS script, not by the
# stack: CloudFormation cannot create a SecureString parameter, so the fixture
# only references it.
SECURE_PARAM_NAME="cdkd-test-dynref-secure-${ACCOUNT_ID}"

# Known values authored in the fixture stack (NOT secret in any real sense;
# this is test data, but we still mask the secret-derived ones in output).
EXPECTED_PASSWORD="cdkd-known-pw-123"
# The BASE64 of that password (issue #2759), derived HERE rather than at the arm
# that asserts on it. `diag_output` is defined below and first called long before
# Phase 1b2, and it must be able to WITHHOLD this form from the moment it can be
# called: on a derived-needle regression the very line the arm would dump is
# `Resolved Fn::Base64: *** -> <base64(password)>`, which the plaintext arms do
# not match. Deriving it at the assertion left a window in which `diag_output`
# printed a decodable secret into the run log `/run-integ` persists (review round
# 2). Round-tripped so a host `base64` with different flags cannot make the arm
# match a needle nothing emits.
EXPECTED_PASSWORD_B64=$(printf '%s' "${EXPECTED_PASSWORD}" | base64 | tr -d '\n')
if [ -z "${EXPECTED_PASSWORD_B64}" ] \
  || [ "$(printf '%s' "${EXPECTED_PASSWORD_B64}" | base64 --decode)" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: premise: could not derive/round-trip the base64 of the known password -- diag_output could not withhold it and the #2759 assertions would be vacuous" >&2
  exit 1
fi
EXPECTED_FULL='{"username":"cdkd-user","password":"cdkd-known-pw-123","pin":"q7"}'
EXPECTED_SSM="cdkd-known-ssm-value"
# The TWO-character secret (issue #2516): below the redaction value scan's
# four-character needle floor, so the scan never builds a needle from it and
# only the span arm on an engine-marked bag can persist the literal leaves
# embedding it as their token. Never printed, even masked -- `mask` withholds
# the head of a value this short.
EXPECTED_PIN="q7"
# THE INVARIANT behind Guards 3c / 3d (#2516 / #2745), not the instance: the
# value must sit BELOW the redaction value scan's four-character needle floor,
# or the scan alone would redact every framed leaf and the span arms would
# pass with or without the mark. A stack and script edited together to a
# longer value would keep every equality green.
case "${#EXPECTED_PIN}" in
  1|2|3) ;;
  *) echo "FAIL: premise: EXPECTED_PIN must be 1-3 characters (got ${#EXPECTED_PIN}) -- above the needle floor Guards 3c / 3d prove nothing" >&2; exit 1 ;;
esac
# The version-stage reference reads the SAME json key as SECRET_PASSWORD, so
# both resolve to EXPECTED_PASSWORD. That collision is deliberate and is what
# makes the state-expression + `diff --fail` assertions below discriminating:
# the value-keyed redaction map collapses the pair, so only a POSITION source
# can keep each leaf on its own expression (issues #1904 / #1910). See the
# stack's comment.
EXPECTED_USERNAME="cdkd-user"
EXPECTED_SECURE="cdkd-known-secure-value-456"
# The MIXED leaf's persisted form, spelled out rather than globbed (issue #1926
# review). A glob like '{{resolve:ssm:'*'@db.' passes under a sibling-expression
# COLLAPSE — the #1904 / #1910 class this same file fences for the
# secretsmanager pair — because any ssm expression satisfies it. Pinning the
# parameter NAME is what makes the assertion about THIS reference.
EXPECTED_DB_URL_EXPR="postgres://app-svc:{{resolve:ssm:${SECURE_PARAM_NAME}}}@db.${REGION}.internal:5432/app"
# The LITERAL embedded leaf (issue #2485): its persisted form must carry ITS
# OWN `:password}}` spelling, never the staged sibling's — the two share one
# plaintext, and the leaf sits above SECRET_PASSWORD_STAGED in the template so
# the collapsed map's survivor is the staged one (see the stack's comment).
EXPECTED_DB_DSN_LITERAL_EXPR="postgres://app-svc:{{resolve:secretsmanager:${SECRET_NAME}:SecretString:password}}@db.internal:5432/app"
EXPECTED_DB_DSN_LITERAL="postgres://app-svc:${EXPECTED_PASSWORD}@db.internal:5432/app"
# The literal leaves embedding the TWO-character secret (issue #2516): the env
# var and the `PortLiteral` output share one source spelling, and the
# persisted form must be that spelling exactly -- never the staged sibling's
# (`SECRET_PIN_STAGED` shares the plaintext and resolves later, so it is the
# collapsed map's survivor) and never the plaintext (the pre-fix answer).
EXPECTED_DB_PORT_LITERAL_EXPR="port:{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pin}}"
EXPECTED_DB_PORT_LITERAL="port:${EXPECTED_PIN}"
EXPECTED_SECRET_PIN_STAGED_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:pin:AWSCURRENT}}"
# The SecureString reference as a WHOLE token, which is what SSM_SECURE_VALUE
# and SSM_SECURE_COPY must both hold in state (issues #1901 / #2012).
EXPECTED_SECURE_EXPR="{{resolve:ssm:${SECURE_PARAM_NAME}}}"
# The PUBLIC mixed leaf (issue #2036, still OPEN), in BOTH of its forms. The
# RESOLVED one is what state holds wherever the POSITION SOURCE carries no
# reference — which is every path reachable from a template-declared leaf, since
# a public ssm `String` is persisted resolved (issue #1901). The EXPRESSION one
# is the OVER-redaction #2036 records, produced once the source DOES carry the
# reference: the `cdkd import` warn-path shape Phase 1f3 stamps. Pinning both
# means the fixture states which input configuration gets which answer rather
# than accepting either.
EXPECTED_PUBLIC_URL="https://${EXPECTED_SSM}.${REGION}.example.internal"
EXPECTED_PUBLIC_URL_EXPR="https://{{resolve:ssm:${PARAM_NAME}}}.${REGION}.example.internal"

# Resolve the built CLI path without a `cd` into dist/ that fails cryptically
# (aborting under `set -e`) when dist/ is unbuilt -- the friendly guard below
# reports it instead. We are in the fixture dir, three levels below repo root.
LOCAL_DIST="${PWD}/../../../dist/cli.js"

# mask <value> -> echoes a masked form (first 2 chars + length) so logs never
# leak the resolved secret value. Empty -> "<empty>".
mask() {
  local v="$1"
  if [ -z "${v}" ]; then
    echo "<empty>"
    return
  fi
  local n=${#v}
  # A value of four characters or fewer would be printed whole (or nearly) by
  # the two-character head -- the two-character secret of issue #2516 is
  # exactly that shape -- and so would a longer value that STARTS with it, so
  # any value carrying the pin shows only its length.
  case "${v}" in
    *"${EXPECTED_PIN}"*)
      echo "***(len=${n})"
      return ;;
  esac
  if [ "${n}" -le 4 ]; then
    echo "***(len=${n})"
    return
  fi
  local head
  head=$(printf '%s' "${v}" | cut -c1-2)
  echo "${head}***(len=${n})"
}
# The helper's two new arms -- withhold any value CARRYING the pin, and
# withhold the head of any value of four characters or fewer -- are what keep
# the two-character secret out of every masked line below, and nothing else
# exercises them, so each is checked here at startup with an input only IT
# withholds: the bare pin and the pin at either end (the containment arm,
# which must not be a prefix match, nor an endpoint match: the INTERIOR case
# is what separates containment from "starts with or ends with", and it is
# longer than the length arm's four-character bound so that arm cannot answer
# for it -- maintainer-checklist round 2), a short value that is NOT the pin (the
# length arm, which the containment arm never reaches, pinned at its four-
# character boundary from both sides), and a long value the helper must still
# abbreviate rather than withhold.
if [ "$(mask "${EXPECTED_PIN}")" != "***(len=${#EXPECTED_PIN})" ] \
  || [ "$(mask "${EXPECTED_PIN}-extra")" != "***(len=$(( ${#EXPECTED_PIN} + 6 )))" ] \
  || [ "$(mask "extra-${EXPECTED_PIN}")" != "***(len=$(( ${#EXPECTED_PIN} + 6 )))" ] \
  || [ "$(mask "ab${EXPECTED_PIN}cd")" != "***(len=$(( ${#EXPECTED_PIN} + 4 )))" ] \
  || [ "$(mask "zz")" != "***(len=2)" ] \
  || [ "$(mask "abcd")" != "***(len=4)" ] \
  || [ "$(mask "abcde")" != "ab***(len=5)" ] \
  || [ "$(mask "cdkd-known-pw-123")" != "cd***(len=17)" ]; then
  echo "FAIL: premise: mask() printed part of a short value or of the two-character secret instead of withholding it" >&2
  exit 1
fi

# Echo a captured command output as FAILURE diagnostics — but never before
# proving it carries no plaintext. These diagnostics sit on exactly the paths
# that exist to DETECT a redaction bug, so an unchecked echo prints the secret
# to the terminal and into the CI log at the precise moment redaction failed.
# Withholds rather than masking wholesale, so an ordinary failure still shows
# the output that explains it.
# The ONE escaper. `diag_output` and its premise check below both call it --
# a second copy is what let an earlier revision "measure" the check against
# itself while the real guard was mutated away (PR 2753 review round 3).
ere_escape() { # ere_escape <literal> -> the same string, safe inside an ERE
  printf '%s' "$1" | sed 's/[][\\.^$*+?(){}|]/\\&/g'
}

diag_output() { # diag_output <text>
  local text="$1"
  # Bash substring tests, never `printf '%s' "${text}" | grep -q`, for the
  # one decision that must not be wrong in the "no match" direction: a false
  # negative here PRINTS the secret. That pipeline shape DOES report false
  # negatives (issue #2582), and no content check in this file is a
  # `printf | grep` pipeline: this helper and Guard 1b use `[[ == * ]]`
  # tests, every other check on a CAPTURED value is a here-string
  # `grep -q <needle> <<< "${text}"`, the three checks that read a FILE grep
  # the file, and the one surviving pipeline is the canonical `gone_probe`
  # block above, which
  # `tests/unit/scripts/integ-verify-probe-not-found.test.ts` requires
  # verbatim and whose input is one short AWS error line. The mechanism as
  # pinned on bash 5.2.21 / GNU grep 3.11 / Linux 5.15: bash's BUILTIN
  # `printf` writes a multi-line argument in several write-family calls
  # (baseline-subtracted `/proc/<pid>/io` syscw deltas of the writing bash,
  # reader never writing: the 13-line plan text -> 8, thirteen one-character lines -> 13,
  # a 10 KB single line -> 3, a 60 KB single line -> 15; one call per short
  # line and one per 4 KB within a line fits all but the plan text's 8),
  # `grep -q` (GNU 3.11 here) exits at the first matching complete line and
  # closes the pipe, and a write the printf subshell still has pending after
  # that takes SIGPIPE --
  # `PIPESTATUS` reads `141 0`, and under `set -o pipefail` the pipeline is
  # 141: `if !` takes the FAIL branch (a false FAIL; seen live twice on this
  # fixture, on Guard 1b's premise and on the `SKIPPED` plan guard, each
  # over a captured log that visibly carried the text) and a leak check
  # `if printf | grep -qF "${EXPECTED_PASSWORD}"` skips it -- a silent PASS
  # over a leak. A scheduling race: the needle must sit on a line before the
  # last one, and the miss rate per invocation measured 0-2.2 % on a 1 KB,
  # 13-line capture (67/3000, 31/2000, 6/2000, 0/2000 in different load
  # windows). A single-line payload did not race at any size tried,
  # consistent with grep waiting for the newline or EOF before matching, so
  # the writer was done before the reader closed -- which is why a 5 MB
  # single-line probe answers `0 0` on every build tried. An external
  # `/usr/bin/printf`, a here-string and a `[[ == * ]]` test never missed.
  #
  # The two-character secret is withheld in its FRAMED form and, bounded by
  # non-alphanumerics, in its BARE form too (`SECRET_PIN_STAGED=q7` in a diff
  # line is a disclosure as much as `port:q7` is). Withholding is the safe
  # direction, so a bounded match inside an unrelated id costs only a
  # diagnostic. An SGR sequence counts as a boundary on either side: a
  # colorized diagnostic puts the sequence's terminating `m` -- alphanumeric --
  # immediately before the value, which the plain class refuses (maintainer
  # review of PR 2753). Only the LEADING side needs it -- on the trailing side
  # the sequence begins with ESC, which the plain class already accepts, so a
  # trailing alternative would be an unfalsifiable clause. `=~` so `[0-9;]*`
  # is ERE zero-or-more of the class
  # rather than a glob's match-anything, and it needs no `shopt`. Its `^` / `$`
  # anchor the whole capture rather than each line, which only WIDENS the
  # match: an interior line boundary is a newline, already in the class.
  # Any CSI sequence whose parameters are digits, `;`, `:` or `?`: a final byte
  # other than `m` (`\033[2K`, `\033[1A`) is equally alphanumeric and equally
  # abuts the value, and `:` is what a colon-separated indexed-colour SGR uses (`\033[38:5:1m`,
  # round 3 of the review). Not the full CSI grammar -- intermediate bytes are
  # out -- and the comment says so rather than claiming ANY.
  #
  # Why the wider class is not dead grammar, corrected in round 3 of the review
  # after this comment claimed cdkd emits only SGR: it does not.
  # `src/utils/live-renderer.ts` writes `\033[1A\033[2K`, `\033[?25l` and
  # `\033[?25h` -- exactly the shapes widened for. What keeps them out of a
  # CAPTURED log is that the renderer refuses to start unless the stream is a
  # TTY (`live-renderer.ts`, `start()`), and this fixture captures through a
  # pipe. So the class is reachable from cdkd's own code the moment anything
  # writes those sequences ungated, and narrowing it back to `[0-9;]*m` would
  # put `\033[2Kq7` past the boundary and into a CI log.
  local csi=$'\033'"\[[0-9;:?]*[A-Za-z]"
  # The pin is ESCAPED into the ERE rather than interpolated raw: `q7` is inert,
  # but a future pin carrying a metacharacter would silently widen or break the
  # match, and this arm decides whether a secret is printed. `diag_output`
  # cannot distinguish escaped from raw while the pin stays alphanumeric --
  # every probe there uses the declared pin -- so the escaper carries its OWN
  # check below, against a metacharacter-carrying sample (round 3 of the
  # review corrected the earlier claim that it was unpinnable at all).
  local pin_esc
  # `/` is deliberately NOT in the class: it is a sed-delimiter reflex, not an
  # ERE metacharacter, and `\/` is undefined in POSIX ERE (round 3).
  pin_esc="$(ere_escape "${EXPECTED_PIN}")"
  local pin_re="(^|[^A-Za-z0-9]|${csi})${pin_esc}([^A-Za-z0-9]|$)"
  if [[ "${text}" == *"${EXPECTED_PASSWORD}"* ]] \
    || [[ "${text}" == *"${EXPECTED_SECURE}"* ]] \
    || [[ "${text}" == *"${EXPECTED_USERNAME}"* ]] \
    || [[ "${text}" == *"${EXPECTED_DB_PORT_LITERAL}"* ]] \
    || [[ "${text}" == *"${EXPECTED_PASSWORD_B64}"* ]] \
    || [[ "${text}" =~ $pin_re ]]; then
    echo "      output: <WITHHELD — it carries a resolved secret, which is itself the bug>" >&2
    return 0
  fi
  echo "      output: ${text}" >&2
}
# Each withholding arm of `diag_output` is checked at startup with an input
# only IT catches, the way `mask` is above: the bare pin bounded by
# non-alphanumerics (a diff line) and at the very start and the very end of
# the text (each anchor alternative on its own), the framed pin followed by a letter (so
# the bare arm, which needs a boundary, cannot answer for it), the three
# pre-existing needles, the pin wrapped in SGR sequences (whose terminating
# `m` is alphanumeric, so the plain boundary class alone refuses it) with a
# multi-parameter, a ZERO-parameter, a non-`m` final-byte, a colon-parameter
# and a private-parameter (`?`) sequence, which pin the `;`, the zero-or-more,
# the final-byte class, the `:` and the `?` separately, and a
# benign diagnostic that CONTAINS the pin unbounded and must still print. The
# output is captured and never echoed.
assert_diag_output_arms() {
  # A function rather than a top-level loop so the probe variable is `local`
  # like every other helper in this script (maintainer review of PR 2753); at
  # top level `local` is a bash error, so the leak could not be fixed in place.
  local diag_probe
  for diag_probe in "SECRET_PIN_STAGED=${EXPECTED_PIN} in a diff line" \
    "${EXPECTED_PIN} at the start" "value=${EXPECTED_PIN}" \
    "${EXPECTED_DB_PORT_LITERAL}x" "${EXPECTED_PASSWORD}" "${EXPECTED_SECURE}" "${EXPECTED_USERNAME}" \
    "$(printf 'colorized \033[32m%s\033[0m tail' "${EXPECTED_PIN}")" \
    "$(printf 'multi-param \033[1;31;4m%s tail' "${EXPECTED_PIN}")" \
    "$(printf 'zero-param \033[m%s tail' "${EXPECTED_PIN}")" \
    "$(printf 'non-SGR final byte \033[2K%s tail' "${EXPECTED_PIN}")" \
    "$(printf 'colon params \033[38:5:1m%s tail' "${EXPECTED_PIN}")" \
    "$(printf 'private params \033[?25h%s tail' "${EXPECTED_PIN}")" \
    "Resolved Fn::Base64: *** -> ${EXPECTED_PASSWORD_B64}"; do
    case "$(diag_output "${diag_probe}" 2>&1)" in
      *WITHHELD*) ;;
      *) echo "FAIL: premise: diag_output would print a diagnostic carrying a secret" >&2; exit 1 ;;
    esac
  done
  case "$(diag_output "an ordinary diagnostic naming id ab${EXPECTED_PIN}x" 2>&1)" in
    *"output: an ordinary diagnostic"*) ;;
    *) echo "FAIL: premise: diag_output withheld a benign diagnostic (the bare-pin arm must be bounded)" >&2; exit 1 ;;
  esac
}
assert_diag_output_arms
# The ESCAPER, checked on its own because `diag_output` cannot see it: every
# probe there carries the declared alphanumeric pin, where escaped and raw are
# indistinguishable. A metacharacter-carrying sample separates them (round 3 of
# the PR 2753 review). Both directions are wrong and only one is dangerous. An
# unescaped `.` merely WIDENS the match, so an extra diagnostic is withheld --
# noise, not disclosure. An unescaped metacharacter that makes the whole
# pattern fail to match the pin, or match something else, PRINTS the secret.
# Measured on the real `pin_re` with `value=<pin> tail`: `q+7`, `q(7`, `q{7`,
# `q^7` and `q$7` all print. `q*7` does NOT -- the boundary alternation
# consumes the `*` and `q*` matches zero occurrences -- so `*` discloses only
# when what precedes it repeats (`qq*7`) or is itself a metacharacter. Round 4
# of the review corrected this sentence, which had named `*` as the exemplar:
# it is the one character in the class that does not leak on its own.
assert_pin_escaper() {
  # EVERY metacharacter the class names, one per sample, so a class that
  # silently narrowed to a couple of them fails here -- the invariant is "the
  # escaped form behaves as a literal", not "this one sample survives".
  local ch escaped
  for ch in '.' '*' '+' '?' '[' ']' '(' ')' '{' '}' '|' '^' '$' '\'; do
    escaped="$(ere_escape "x${ch}y")"
    if [ "${escaped}" = "x${ch}y" ]; then
      echo "FAIL: premise: ere_escape left the ERE metacharacter '${ch}' unescaped" >&2
      exit 1
    fi
    # The escaped form matches its own literal and nothing else at that offset.
    if ! [[ "x${ch}y" =~ ^${escaped}$ ]]; then
      echo "FAIL: premise: the escaped form of 'x${ch}y' does not match its own literal" >&2
      exit 1
    fi
    # Three negatives, because one is not enough: SUBSTITUTION (a class that
    # still matches any character), OMISSION and REPETITION (a replacement of
    # `\&*` escapes the character and then makes it optional, which the `xZy`
    # probe alone let through -- round 4 of the review).
    if [[ "xZy" =~ ^${escaped}$ ]]; then
      echo "FAIL: premise: the escaped form of 'x${ch}y' still matches 'xZy' -- not a literal" >&2
      exit 1
    fi
    if [[ "xy" =~ ^${escaped}$ ]]; then
      echo "FAIL: premise: the escaped form of 'x${ch}y' matches 'xy' -- the character is optional" >&2
      exit 1
    fi
    if [[ "x${ch}${ch}y" =~ ^${escaped}$ ]]; then
      echo "FAIL: premise: the escaped form of 'x${ch}y' matches a repeat -- not a literal" >&2
      exit 1
    fi
  done
  # EVERY occurrence, not just the first: a substitution missing its `g` flag
  # escapes one metacharacter per string and leaves the rest live, which every
  # single-metacharacter sample above would pass (round 4 of the review).
  local mixed
  mixed="$(ere_escape 'x.y*z.w')"
  if [[ "xAyBzCw" =~ ^${mixed}$ ]] || ! [[ 'x.y*z.w' =~ ^${mixed}$ ]]; then
    echo "FAIL: premise: ere_escape did not escape every occurrence (got '${mixed}')" >&2
    exit 1
  fi
  # `/` is NOT escaped, deliberately: it is not an ERE metacharacter and `\/`
  # is undefined in POSIX ERE.
  if [ "$(ere_escape 'a/b')" != 'a/b' ]; then
    echo "FAIL: premise: ere_escape escaped '/', which POSIX ERE leaves undefined" >&2
    exit 1
  fi
}
assert_pin_escaper
# The probe variable stayed inside the helper: `local` is the whole reason the
# self-check is a function rather than a top-level loop, so it is pinned here
# instead of being asserted only by the declaration.
if [ "${diag_probe-unset}" != "unset" ]; then
  echo "FAIL: premise: assert_diag_output_arms leaked its probe variable into the script's scope" >&2
  exit 1
fi

# Scratch copies of `state.json` this script makes mid-run. Removed inside the
# EXISTING `cleanup`, not by a tail `rm`: every assertion between a `mktemp` and
# such a tail exits under `set -e`, so a tail cleanup runs only on the happy
# path. And registered here rather than behind a second `trap ... EXIT`, which
# does not chain -- it would silently DISARM this function and leak the AWS
# teardown (fenced repo-wide by `tests/unit/scripts/integ-single-exit-trap.test.ts`).
SCRATCH_FILES=()

cleanup() {
  echo "==> Cleanup: dropping any leftover state + AWS resources"
  set +eu
  if [ "${#SCRATCH_FILES[@]}" -gt 0 ]; then
    rm -f "${SCRATCH_FILES[@]}" || true
  fi
  destroy_rc=0
  if [ -x "${LOCAL_DIST}" ]; then
    node "${LOCAL_DIST}" state destroy "${STACK}" --state-bucket "${STATE_BUCKET:-}" \
      --region "${REGION}" --yes >/dev/null 2>&1
    destroy_rc=$?
  fi
  # Best-effort delete of the secret + param in case state destroy missed them.
  aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
    --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  # The SecureString parameter is created by this script, so cdkd never deletes
  # it — the ONLY thing that keeps it from being an orphan is this sweep.
  aws ssm delete-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" >/dev/null 2>&1 || true
  if [ -n "${STATE_BUCKET:-}" ]; then
    if [ "${destroy_rc}" -eq 0 ]; then
      aws s3 rm "s3://${STATE_BUCKET}/${STATE_KEY}" >/dev/null 2>&1 || true
    fi
    aws s3 rm "s3://${STATE_BUCKET}/cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true
    # The `aws s3 rm` above only wrote DELETE MARKERS. Purge the versions they
    # hide, NONCURRENT-only: this same function runs from the pre-run sweep and
    # from the failure/INT/TERM traps, where a live state.json may still be the
    # only record of resources that are still standing -- deleting it would
    # strand them. The success path below does the full sweep, once destroy has
    # been asserted, and that is where the zero-assertion lives.
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

# --- Out-of-band SecureString parameter (issue #1901) -----------------
# CloudFormation cannot CREATE a SecureString parameter, so the fixture stack
# only REFERENCES this one. Created AFTER the pre-run cleanup (which deletes
# it) and removed again by the cleanup trap.
echo "==> Creating the SecureString SSM parameter out of band"
aws ssm put-parameter --name "${SECURE_PARAM_NAME}" --type SecureString \
  --value "${EXPECTED_SECURE}" --overwrite --region "${REGION}" >/dev/null
# Fail loudly if AWS did not actually store it as a SecureString: every
# assertion below would otherwise pass vacuously against a String parameter,
# which is the OPPOSITE of what is under test.
SECURE_TYPE=$(aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Type' --output text)
if [ "${SECURE_TYPE}" != "SecureString" ]; then
  echo "FAIL: expected '${SECURE_PARAM_NAME}' to be a SecureString, got '${SECURE_TYPE}'" >&2
  exit 1
fi
echo "    OK: SecureString parameter created"

# --- Phase 1: deploy --------------------------------------------------
echo "==> Phase 1: deploy with the local binary"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# The synthesized template cdkd's own synth wrote. Read by Guard 1b just below
# and by the DB_DSN_LITERAL premise guards later; the Phase 1b deploy
# re-synthesizes it, so from there on it is the probe deploy's synth.
SYNTH_TEMPLATE="cdk.out/${STACK}.template.json"

# --- Phase 1b: a probe deploy whose ONE extra output fails to resolve -----
# Issue #2728: `CDKD_TEST_OUTPUT_LEAK=true` declares `OutputFailureLeak`, whose
# `Fn::Sub` variable resolves the secret's `password` key and whose body uses
# that VALUE as the JSON key of a second reference to the same secret -- the
# resolver's own `key '<password>' not found in secret` error, carrying the
# plaintext, is what the deploy engine reports. Nothing else changes, so this
# is a no-change deploy in which only the outputs pass does work; the engine
# warns, skips the output (and, on that no-change path, also says it is
# keeping the previously persisted outputs), and exits 0. The log is CAPTURED
# and NOT shown: the line under test is the one that would carry the password
# on a masking regression, so it reaches the terminal only through
# `diag_output`, which withholds it when it carries a secret -- on a failing
# deploy too (the substitution's status is node's; without the branch, `set
# -e` would abort with the log captured and never printed). `--verbose` so
# the resolver's own `Resolving dynamic reference:` echo of the assembled
# reference -- masked by the same fix -- is emitted and inside the whole-log
# negative below. The output is declared for THIS deploy only -- see the
# stack for why it must not stay (the unchanged-stack `diff --fail` guard
# later).
echo "==> Phase 1b: CDKD_TEST_OUTPUT_LEAK probe deploy (issue #2728)"
if ! DEPLOY_OUT_LEAK=$(CDKD_TEST_OUTPUT_LEAK=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the CDKD_TEST_OUTPUT_LEAK probe deploy exited non-zero -- under the default arm the failing output is warned about and skipped, and the deploy exits 0 (issue #2728)" >&2
  diag_output "${DEPLOY_OUT_LEAK}"
  exit 1
fi

# Guard 1b, premise first: the probe deploy's own synth carried the output in
# EXACTLY the shape the arm needs -- an `Fn::Sub` `[body, variables]` pair
# whose body is the Secrets Manager reference to THIS run's secret with
# `${Pw}` as its JSON key (so the resolved password becomes the failing
# lookup's key and the resolver's error names it) and whose `Pw` variable is
# the same secret's `password` reference. Compared by equality, not by
# shape: a gate that silently stopped declaring it, a CDK token turning the
# body into an `Fn::Join` object, `${Pw}` anywhere but the key position (a
# valid key with the password appended fails naming a literal, never the
# password), or a look-alike that is not a `{{resolve:secretsmanager:...}}`
# reference at all would each leave the greps below with no arm behind them.
if [ ! -f "${SYNTH_TEMPLATE}" ]; then
  echo "FAIL: premise: no synthesized template at ${SYNTH_TEMPLATE} after the probe deploy" >&2
  exit 1
fi
LEAK_SHAPE=$(jq -r --arg secret "${SECRET_NAME}" '.Outputs.OutputFailureLeak.Value
  | if . == null then "absent"
    elif type != "object" then "not-an-intrinsic"
    else .["Fn::Sub"] end
  | if . == null then "absent"
    elif (type == "array" and length == 2
          and .[0] == ("{{resolve:secretsmanager:" + $secret + ":SecretString:${Pw}}}")
          and .[1].Pw == ("{{resolve:secretsmanager:" + $secret + ":SecretString:password}}")) then "Fn::Sub"
    elif . == "not-an-intrinsic" then "not-an-intrinsic"
    else "other" end' "${SYNTH_TEMPLATE}")
if [ "${LEAK_SHAPE}" != "Fn::Sub" ]; then
  echo "FAIL: premise: OutputFailureLeak synthesized as '${LEAK_SHAPE}', not an Fn::Sub [body ending in :SecretString:\${Pw}}}, {Pw: <password reference>}] -- the #2728 output-failure arm is not what this deploy exercised" >&2
  exit 1
fi
echo "    OK: premise: OutputFailureLeak is an Fn::Sub over the password reference (${LEAK_SHAPE})"
# The warn is the sentinel that the arm ran at all -- a deploy that resolved
# the output, or skipped it silently, would pass the negative assertions
# below for free, so its absence is a FAIL. Bash substring tests rather than
# `printf | grep -qF`: the first live run of this guard failed this premise
# on `grep -qF` over a captured log that visibly carried the warn -- the
# `printf | grep -q` SIGPIPE race `diag_output`'s comment pins (the warn sits
# on an early line of a multi-line log, the shape that races).
if [[ "${DEPLOY_OUT_LEAK}" != *"Failed to resolve output OutputFailureLeak"* ]]; then
  echo "FAIL: premise: the probe deploy did not warn 'Failed to resolve output OutputFailureLeak' -- the #2728 output-failure arm did not run" >&2
  diag_output "${DEPLOY_OUT_LEAK}"
  exit 1
fi
# The warn LINE alone (the first one), with the colour codes stripped, so the
# two checks below read exactly what a terminal shows for it.
OUTPUT_FAILURE_WARN=""
while IFS= read -r line || [ -n "${line}" ]; do
  if [[ "${line}" == *"Failed to resolve output OutputFailureLeak"* ]]; then
    OUTPUT_FAILURE_WARN=$(printf '%s' "${line}" | sed 's/\x1b\[[0-9;]*m//g')
    break
  fi
done <<< "${DEPLOY_OUT_LEAK}"
if [ -z "${OUTPUT_FAILURE_WARN}" ]; then
  # Distinct from "carries no mask" below, and a consistency check rather
  # than a reachable failure: the premise above proved the newline-free
  # substring is in the log, so the loop must find it on one line -- this
  # branch fires only if the loop and the premise disagree about the text.
  echo "FAIL: the 'Failed to resolve output OutputFailureLeak' warn is in the probe deploy's log but could not be isolated as one line (issue #2728)" >&2
  diag_output "${DEPLOY_OUT_LEAK}"
  exit 1
fi
if [[ "${OUTPUT_FAILURE_WARN}" == *"${EXPECTED_PASSWORD}"* ]]; then
  echo "FAIL: the output-failure warn carries the resolved password in plaintext (issue #2728)" >&2
  exit 1
fi
# ...and nowhere else in the probe deploy's `--verbose` log either: a line
# that carried the password ahead of the warn would otherwise pass the
# single-line check above. What this covers of the resolver side of the fix
# is its `Resolving dynamic reference:` debug echo of the assembled reference
# (the password as the JSON key), pinned positively next -- the throttle-retry
# label needs a throttle and the SSM unrecognized-`Type` warn an SSM shape,
# neither of which this deploy produces; those are unit-pinned only.
if [[ "${DEPLOY_OUT_LEAK}" == *"${EXPECTED_PASSWORD}"* ]]; then
  echo "FAIL: the probe deploy's log carries the resolved password in plaintext somewhere (issue #2728)" >&2
  exit 1
fi
# The fixture's other two secrets as well: the `--verbose` log spans the
# comparison pass's SecureString lookup and every resolved-intrinsic echo,
# so the negative is over everything this deploy resolved, not the one
# value the #2728 shape exposes.
if [[ "${DEPLOY_OUT_LEAK}" == *"${EXPECTED_SECURE}"* ]] || [[ "${DEPLOY_OUT_LEAK}" == *"${EXPECTED_USERNAME}"* ]]; then
  echo "FAIL: the probe deploy's --verbose log carries the SecureString value or the username in plaintext somewhere (issue #2728)" >&2
  exit 1
fi
# The resolver echoed the second lookup, masked: the premise that the echo is
# in the log at all (a resolver that stopped emitting it would pass the
# negative above for free), and that the key position reads `***`.
if [[ "${DEPLOY_OUT_LEAK}" != *"Resolving dynamic reference: secretsmanager:${SECRET_NAME}:SecretString:***"* ]]; then
  echo "FAIL: the probe deploy's --verbose log carries no masked 'Resolving dynamic reference: secretsmanager:${SECRET_NAME}:SecretString:***' echo of the assembled reference (issue #2728)" >&2
  diag_output "${DEPLOY_OUT_LEAK}"
  exit 1
fi
if [[ "${OUTPUT_FAILURE_WARN}" != *"***"* ]]; then
  echo "FAIL: the output-failure warn carries no mask -- expected the password replaced by '***' (issue #2728)" >&2
  diag_output "${OUTPUT_FAILURE_WARN}"
  exit 1
fi
echo "    OK: the OutputFailureLeak resolution failure was reported masked (#2728)"
# The line itself, through `diag_output`: the guards above reject the
# password, and the helper withholds a line carrying any of the fixture's
# three secrets, so nothing this echo prints can be one.
diag_output "${OUTPUT_FAILURE_WARN}"

# --- Phase 1b2: Fn::Base64 over a dynamic reference (issue #2759) ----------
# ITS OWN DEPLOY, under its own token, and that separation is the arm rather
# than a tidiness choice. It first rode on Phase 1b's `CDKD_TEST_OUTPUT_LEAK`
# deploy and could never have passed: `resolveOutputs` sets `resolutionFailed`
# when ANY output resolves to `undefined`, and `OutputFailureLeak` is DESIGNED
# to fail -- so the engine kept `persistedOutputs` wholesale and `Base64Secret`
# never reached state. Measured live 2026-09-10; the negative assertion ("no
# base64 in state") passed the whole time, and only the positive one ("the key
# is the MASK") caught it.
#
# `Base64Secret`'s value is `Fn::Base64` over the secret's `password`
# reference. The resolver returns the ENCODED value, and
# `redactSecretsForState` / `maskSecretsInText` both match the recorded
# plaintext LITERALLY -- so nothing matched the encoding and the secret was
# persisted to `state.json` in a form one command decodes, and printed on the
# resolver's own debug line beside its mask. The fix registers the TRANSFORMED
# value as a derived MASK-ONLY needle at the transform site.
#
# The encoding is computed HERE from the same known plaintext the rest of the
# fixture uses, so the assertion is about a value this script derived rather
# than about whatever the binary happened to emit.
echo "==> Phase 1b2: CDKD_TEST_BASE64_LEAK probe deploy (issue #2759)"
if ! DEPLOY_OUT_B64=$(CDKD_TEST_BASE64_LEAK=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1); then
  echo "FAIL: the CDKD_TEST_BASE64_LEAK probe deploy exited non-zero -- Base64Secret resolves cleanly, so this deploy must succeed (issue #2759)" >&2
  diag_output "${DEPLOY_OUT_B64}"
  exit 1
fi
# THE PREMISE THAT WOULD HAVE NAMED THE FAILURE DIRECTLY, rather than leaving
# it to be inferred from an absent key. `resolveOutputs` freezes the whole bag
# to `persistedOutputs` when any output resolves to `undefined`, and it says so
# on this line. If it ever fires here again, the arm is inert for the same
# reason as before and this reports THAT instead of "the needle did not fire".
#
# SILENTLY DISARMABLE, and accepted as such rather than left to be discovered
# (review round 2): the sentence is CONCATENATED across two lines in
# `src/deployment/deploy-engine.ts`, so it is not greppable there and a reword
# would disarm this guard with no failure anywhere. It is a DIAGNOSTIC, not the
# assertion — the backstop is the `== '***'` check below, which is a fact about
# state rather than about wording, and which is what actually caught the
# original inert arm. Anchored on the shortest stable fragment for that reason.
if [[ "${DEPLOY_OUT_B64}" == *"keeping the previously persisted outputs"* ]]; then
  echo "FAIL: premise: the Base64 probe deploy suppressed its outputs persist -- some output failed to resolve, so the whole bag was kept and this arm cannot test anything (issue #2759)" >&2
  diag_output "${DEPLOY_OUT_B64}"
  exit 1
fi
# The same whole-log negatives Phase 1b applies to its own capture: this deploy
# resolves every secret the stack references, so a masking regression anywhere
# in it would print here too.
if [[ "${DEPLOY_OUT_B64}" == *"${EXPECTED_PASSWORD}"* ]]; then
  echo "FAIL: the Base64 probe deploy's --verbose log carries the resolved password in plaintext (issue #2759)" >&2
  exit 1
fi
if [[ "${DEPLOY_OUT_B64}" == *"${EXPECTED_SECURE}"* ]] || [[ "${DEPLOY_OUT_B64}" == *"${EXPECTED_USERNAME}"* ]]; then
  echo "FAIL: the Base64 probe deploy's --verbose log carries the SecureString value or the username in plaintext (issue #2759)" >&2
  exit 1
fi
# The needle and its round-trip check are derived beside EXPECTED_PASSWORD above,
# so `diag_output` can withhold this form from its first callable moment.
# Premise: the probe deploy's own synth carried the output as an `Fn::Base64`
# over THIS run's secret reference. Equality, not a shape test: a gate that
# stopped declaring it, a CDK token turning the leaf into an `Fn::Join`, or a
# reference to a different key would each leave the assertions below with no
# arm behind them.
B64_SHAPE=$(jq -r --arg secret "${SECRET_NAME}" '.Outputs.Base64Secret.Value
  | if . == null then "absent"
    elif type != "object" then "not-an-intrinsic"
    elif .["Fn::Base64"] == ("{{resolve:secretsmanager:" + $secret + ":SecretString:password}}") then "Fn::Base64"
    else "other" end' "${SYNTH_TEMPLATE}")
if [ "${B64_SHAPE}" != "Fn::Base64" ]; then
  echo "FAIL: premise: Base64Secret synthesized as '${B64_SHAPE}', not an Fn::Base64 over this run's password reference -- the #2759 arm is not what this deploy exercised" >&2
  exit 1
fi
echo "    OK: premise: Base64Secret is an Fn::Base64 over the password reference (${B64_SHAPE})"
# The whole persisted state document, which is the sink #2759 is about: the
# resolved value flows through the save choke point into `state.outputs`, and
# the pre-fix answer was the encoding verbatim. Grepping the WHOLE document
# rather than the one key is deliberate -- the encoding has no legitimate home
# anywhere in this stack's state.
# Both scratch copies are registered with the EXISTING exit trap rather than
# `rm`-ed at the end of the block: every assertion between here and there exits
# on failure under `set -e`, so a tail cleanup runs only on the happy path --
# the shape `.claude/rules` calls out, one scale down from a leaked AWS
# resource. `cleanup` is the fixture's single EXIT handler; adding a second
# `trap ... EXIT` would DISARM it and leak the real teardown.
B64_STATE=$(mktemp)
B64_TRIMMED=$(mktemp)
SCRATCH_FILES+=("${B64_STATE}" "${B64_TRIMMED}")
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${B64_STATE}" --quiet
if grep -qF "${EXPECTED_PASSWORD_B64}" "${B64_STATE}"; then
  echo "FAIL: state.json carries the base64 of the resolved password -- one command decodes it (issue #2759)" >&2
  exit 1
fi
# ...and MASKED rather than merely absent. Without this the negative above
# passes for a deploy that skipped the output, dropped it, or never resolved
# it at all -- none of which is the fix.
B64_PERSISTED=$(jq -r '.outputs.Base64Secret // "<absent>"' "${B64_STATE}")
if [ "${B64_PERSISTED}" != "***" ]; then
  # Through `diag_output`, not interpolated: the grep above catches the exact
  # `base64(password)` needle, but an ASSEMBLED body (base64 of a string merely
  # CONTAINING the password) is a different string that still decodes, so a bare
  # echo would print it (review round 2).
  echo "FAIL: state.outputs.Base64Secret is not the mask '***' -- the derived needle did not fire (issue #2759); value follows" >&2
  diag_output "${B64_PERSISTED}"
  exit 1
fi
echo "    OK: the Fn::Base64 output persisted as the mask, not as a decodable secret (#2759)"
# The LOG half of the same defect: `Resolved Fn::Base64: *** -> <encoding>`
# masked the input and printed the output in the same breath. `--verbose` is
# on for this deploy, so the line is in the captured log.
if [[ "${DEPLOY_OUT_B64}" == *"${EXPECTED_PASSWORD_B64}"* ]]; then
  echo "FAIL: the probe deploy's --verbose log carries the base64 of the resolved password (issue #2759)" >&2
  exit 1
fi
if [[ "${DEPLOY_OUT_B64}" != *"Resolved Fn::Base64:"* ]]; then
  echo "FAIL: premise: the probe deploy logged no 'Resolved Fn::Base64:' line -- the negative above passes for free (issue #2759)" >&2
  diag_output "${DEPLOY_OUT_B64}"
  exit 1
fi
echo "    OK: no 'Resolved Fn::Base64' line carried the encoded secret (#2759)"
# DROP the key from state before anything else runs. `Base64Secret` is declared
# only for this probe deploy, and the diff pass resolves outputs with
# `skipDynamicReferences` -- so it would show as a REMOVE row and red the
# unchanged-stack `diff --fail` guard later in this fixture. Same direct-S3
# write idiom Phase 1f / 1f2 use, and safe for the same reason: nothing holds
# the lock between phases and the next `saveState` reads its own etag.
jq 'del(.outputs.Base64Secret)' "${B64_STATE}" > "${B64_TRIMMED}"
if jq -e 'has("outputs") and (.outputs | has("Base64Secret"))' "${B64_TRIMMED}" >/dev/null; then
  echo "FAIL: could not drop Base64Secret from the persisted outputs -- the diff --fail guard later would red on it" >&2
  exit 1
fi
aws s3 cp "${B64_TRIMMED}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet

# --- Assertion: dynamic references resolved on the deployed Lambda ----
echo "==> Reading consumer Lambda env vars from AWS (GetFunctionConfiguration)"
FN_NAME=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null \
  | jq -r '.state.outputs.FunctionName // empty')

if [ -z "${FN_NAME}" ]; then
  echo "FAIL: could not read FunctionName output from cdkd state" >&2
  exit 1
fi
echo "    Consumer function: ${FN_NAME}"

CFG=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")

get_env() {
  echo "${CFG}" | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'
}

ENV_SECRET_PASSWORD=$(get_env SECRET_PASSWORD)
ENV_SECRET_FULL=$(get_env SECRET_FULL)
ENV_SECRET_PASSWORD_STAGED=$(get_env SECRET_PASSWORD_STAGED)
ENV_SSM_VALUE=$(get_env SSM_VALUE)
ENV_SSM_SECURE_VALUE=$(get_env SSM_SECURE_VALUE)
ENV_DB_URL=$(get_env DB_URL)
ENV_DB_DSN_LITERAL=$(get_env DB_DSN_LITERAL)
ENV_DB_PORT_LITERAL=$(get_env DB_PORT_LITERAL)
ENV_DB_PORT_SUB=$(get_env DB_PORT_SUB)
ENV_DB_PORT_JOIN=$(get_env DB_PORT_JOIN)
ENV_SECRET_PIN_STAGED=$(get_env SECRET_PIN_STAGED)

# The secret's ARN, for the ARN-form expression the L2 join assembles (issue
# #2745): `secretValueFromJson` renders the ARN as a `Ref`, so the token the
# resolver records -- and state must hold -- is
# `{{resolve:secretsmanager:<ARN>:SecretString:pin::}}`, which only the live
# secret can spell. A strict capture, guarded on the ARN prefix: an empty or
# `None` value would make every equality below compare against a string no
# state could ever hold, which reads as a FAIL rather than a vacuous pass, but
# the guard names the cause instead.
SECRET_ARN=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'ARN' --output text)
case "${SECRET_ARN}" in
  arn:aws:secretsmanager:*) ;;
  *) echo "FAIL: premise: could not read the secret's ARN (got '${SECRET_ARN}')" >&2; exit 1 ;;
esac
EXPECTED_DB_PORT_SUB_EXPR="${EXPECTED_DB_PORT_LITERAL_EXPR}"
EXPECTED_DB_PORT_JOIN_EXPR="port:{{resolve:secretsmanager:${SECRET_ARN}:SecretString:pin::}}"
ENV_SSM_SECURE_COPY=$(get_env SSM_SECURE_COPY)
ENV_PUBLIC_URL=$(get_env PUBLIC_URL)

fail_count=0

# Guard 1: nothing must remain a literal {{resolve:...}} token.
check_not_literal() {
  local name="$1" val="$2"
  case "${val}" in
    *'{{resolve:'*)
      echo "FAIL: env var ${name} is still the LITERAL dynamic reference (unresolved): $(mask "${val}")" >&2
      fail_count=$((fail_count + 1))
      ;;
  esac
}

# Guard 2: resolved value must equal the known expected value.
check_equals() {
  local name="$1" got="$2" want="$3"
  if [ "${got}" != "${want}" ]; then
    echo "FAIL: env var ${name} resolved to the WRONG value." >&2
    echo "      got:  $(mask "${got}")" >&2
    echo "      want: $(mask "${want}")" >&2
    fail_count=$((fail_count + 1))
  else
    echo "    OK: ${name} resolved correctly -> $(mask "${got}")"
  fi
}

check_not_literal SECRET_PASSWORD "${ENV_SECRET_PASSWORD}"
check_not_literal SECRET_FULL "${ENV_SECRET_FULL}"
check_not_literal SECRET_PASSWORD_STAGED "${ENV_SECRET_PASSWORD_STAGED}"
check_not_literal SSM_VALUE "${ENV_SSM_VALUE}"
check_not_literal SSM_SECURE_VALUE "${ENV_SSM_SECURE_VALUE}"
check_not_literal DB_URL "${ENV_DB_URL}"
check_not_literal DB_DSN_LITERAL "${ENV_DB_DSN_LITERAL}"
check_not_literal DB_PORT_LITERAL "${ENV_DB_PORT_LITERAL}"
check_not_literal DB_PORT_SUB "${ENV_DB_PORT_SUB}"
check_not_literal DB_PORT_JOIN "${ENV_DB_PORT_JOIN}"
check_not_literal SECRET_PIN_STAGED "${ENV_SECRET_PIN_STAGED}"
check_not_literal SSM_SECURE_COPY "${ENV_SSM_SECURE_COPY}"
check_not_literal PUBLIC_URL "${ENV_PUBLIC_URL}"

check_equals "SECRET_PASSWORD (secretsmanager :SecretString:<jsonkey>)" \
  "${ENV_SECRET_PASSWORD}" "${EXPECTED_PASSWORD}"
check_equals "SECRET_FULL (secretsmanager :SecretString whole-secret)" \
  "${ENV_SECRET_FULL}" "${EXPECTED_FULL}"
# Same expected value as SECRET_PASSWORD above — that IS the collision. Both
# references must still reach AWS fully resolved; #1904 / #1910 change what
# STATE holds, never what the provider is handed.
check_equals "SECRET_PASSWORD_STAGED (secretsmanager :SecretString:<jsonkey>:AWSCURRENT)" \
  "${ENV_SECRET_PASSWORD_STAGED}" "${EXPECTED_PASSWORD}"
check_equals "SSM_VALUE (ssm:<name> plaintext param)" \
  "${ENV_SSM_VALUE}" "${EXPECTED_SSM}"
# The literal embedded leaf reaches AWS with the password spliced in (#2485
# changes what STATE holds for it, never what the provider is handed).
check_equals "DB_DSN_LITERAL (literal string embedding :SecretString:<jsonkey>)" \
  "${ENV_DB_DSN_LITERAL}" "${EXPECTED_DB_DSN_LITERAL}"
# The PREMISE of Guard 3c and of the Phase 1g readback arm (issue #2516): the
# live resource genuinely holds the two-character value spliced into the
# literal, so a readback of it carries the plaintext at that offset and the
# state assertions are about a value that exists.
check_equals "DB_PORT_LITERAL (literal string embedding a TWO-character :SecretString:<jsonkey>)" \
  "${ENV_DB_PORT_LITERAL}" "${EXPECTED_DB_PORT_LITERAL}"
# The PREMISE of Guard 3d (issue #2745): both intrinsic shapes reach AWS with
# the two-character value spliced in, exactly like the literal leaf, so the
# state assertions on them are about a value the resource holds.
check_equals "DB_PORT_SUB (Fn::Sub embedding a TWO-character :SecretString:<jsonkey>)" \
  "${ENV_DB_PORT_SUB}" "${EXPECTED_DB_PORT_LITERAL}"
check_equals "DB_PORT_JOIN (L2 Fn::Join embedding a TWO-character :SecretString:<jsonkey> by ARN)" \
  "${ENV_DB_PORT_JOIN}" "${EXPECTED_DB_PORT_LITERAL}"
check_equals "SECRET_PIN_STAGED (the two-character value, whole, :AWSCURRENT)" \
  "${ENV_SECRET_PIN_STAGED}" "${EXPECTED_PIN}"
# The MIXED leaf must reach AWS with the reference SUBSTITUTED INTO the
# surrounding text (issue #1926 review). This is the PREMISE of Phase 1g: the
# live resource holds the decrypted value, so a readback of it is a disclosure
# unless state redacts it. Without this assertion Phase 1g could pass because
# nothing was ever resolved.
check_equals "DB_URL (Fn::Join embedding an ssm SecureString)" \
  "${ENV_DB_URL}" "postgres://app-svc:${EXPECTED_SECURE}@db.${REGION}.internal:5432/app"
# The SecureString still has to REACH AWS decrypted — issue #1901 changes what
# STATE holds, never what the provider is handed.
check_equals "SSM_SECURE_VALUE (ssm:<name> SecureString param, decrypted)" \
  "${ENV_SSM_SECURE_VALUE}" "${EXPECTED_SECURE}"
# The PREMISE of Phase 1f2 (issue #2012). That phase asserts the key is redacted
# once its position source is removed, which proves nothing unless the LIVE
# resource genuinely holds the decrypted value at that key — the readback is
# what makes the plaintext arrive in `observedProperties` at all.
check_equals "SSM_SECURE_COPY (second reference to the same SecureString)" \
  "${ENV_SSM_SECURE_COPY}" "${EXPECTED_SECURE}"
# The PREMISE of the PUBLIC_URL arms in Phases 1f / 1f3 / 1g, for the same
# reason. Each compares the persisted value against the RESOLVED one (or, in
# 1f3, against the expression that replaced it), so if the public reference
# never resolved on the way to AWS the comparison would be about a value that
# does not exist.
check_equals "PUBLIC_URL (Fn::Join embedding a PUBLIC ssm String)" \
  "${ENV_PUBLIC_URL}" "${EXPECTED_PUBLIC_URL}"

if [ "${fail_count}" -ne 0 ]; then
  echo "FAIL: ${fail_count} dynamic-reference assertion(s) failed" >&2
  exit 1
fi
echo "    OK: all dynamic references resolved to the correct values (none left literal)"
echo "    NOTE: ssm-secure:<name> is exercised by tests/integration/ssm-secure-dynamic-ref (see header note)"

# --- Assertion 1b: baseline Description + KmsKeyId reached AWS ------------
DESC_P1=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'Description' --output text)
KMS_P1=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'KmsKeyId' --output text)
if [ "${DESC_P1}" != "cdkd f1160 removal-reset probe" ] || [ "${KMS_P1}" != "alias/aws/secretsmanager" ]; then
  echo "FAIL: expected baseline Description/'alias/aws/secretsmanager' on the secret, got '${DESC_P1}' / '${KMS_P1}'" >&2
  exit 1
fi
echo "    OK: baseline Description + KmsKeyId set on the secret"

# --- Assertion 1c: STATE stores the {{resolve:...}} expression, NOT the
#     resolved plaintext (GHSA secret-disclosure fix) --------------------
# cdkd sends the RESOLVED value to AWS (asserted above via the live Lambda
# env), but must PERSIST the unresolved expression so the plaintext never
# lands in state.json / `state show` / diff / drift. A plain `ssm:` value is
# public config and is deliberately NOT redacted, which is the discriminator.
echo "==> Reading cdkd state to assert secret redaction"
STATE_JSON=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)

# The consumer Lambda's persisted env vars.
LAMBDA_ENV=$(printf '%s' "${STATE_JSON}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.properties.Environment.Variables' | head -1)
if [ -z "${LAMBDA_ENV}" ] || [ "${LAMBDA_ENV}" = "null" ]; then
  echo "FAIL: could not read the consumer Lambda's persisted Environment.Variables from state" >&2
  exit 1
fi

STATE_SECRET_PASSWORD=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD // empty')
STATE_SECRET_FULL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_FULL // empty')
STATE_SSM_VALUE=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SSM_VALUE // empty')
STATE_SSM_SECURE_VALUE=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SSM_SECURE_VALUE // empty')
STATE_SECRET_PASSWORD_STAGED=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD_STAGED // empty')
STATE_DB_DSN_LITERAL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_DSN_LITERAL // empty')

# Guard 3: each secretsmanager env var in STATE must be the UNRESOLVED
# expression, not the plaintext. (We can print the expression — it names the
# secret, not its value.)
redaction_fail=0
case "${STATE_SECRET_PASSWORD}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_PASSWORD kept the expression: ${STATE_SECRET_PASSWORD}" ;;
  *) echo "FAIL: state SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_PASSWORD}")" >&2; redaction_fail=1 ;;
esac
# ...and specifically NOT its staged sibling's spelling. The case above accepts
# any secretsmanager expression, so on its own it passes on the collapsed state
# (#1904 / #1910) — the two leaves resolve to one value, so it is exactly this
# leaf that gets rewritten to the OTHER one's expression.
case "${STATE_SECRET_PASSWORD}" in
  *':AWSCURRENT}}')
    echo "FAIL: state SECRET_PASSWORD took the STAGED expression — the colliding pair collapsed (#1910)" >&2
    redaction_fail=1
    ;;
esac
case "${STATE_SECRET_FULL}" in
  '{{resolve:secretsmanager:'*) echo "    OK: state SECRET_FULL kept the expression: ${STATE_SECRET_FULL}" ;;
  *) echo "FAIL: state SECRET_FULL is NOT the {{resolve:...}} expression: $(mask "${STATE_SECRET_FULL}")" >&2; redaction_fail=1 ;;
esac
# The version-stage reference resolves to the SAME value as SECRET_PASSWORD
# (issue #1910 restored that collision deliberately — see the stack comment),
# so this assertion and the `:AWSCURRENT` guard on SECRET_PASSWORD above are a
# PAIR: together they fence both directions of the collapse. Neither is
# sufficient alone, because a collapsed state still holds a valid-looking
# secretsmanager expression at both leaves.
case "${STATE_SECRET_PASSWORD_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: state SECRET_PASSWORD_STAGED kept its OWN staged expression: ${STATE_SECRET_PASSWORD_STAGED}" ;;
  *) echo "FAIL: state SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${STATE_SECRET_PASSWORD_STAGED}")" >&2; redaction_fail=1 ;;
esac

# Guard 3a-mixed (issue #1926 review): the MIXED leaf — the reference EMBEDDED
# in surrounding text rather than being the whole value, which is what an
# `Fn::Join` around a secret renders. On the CREATE path the secrets map is
# populated, so the value SCAN redacts the embedded span; the harder path (empty
# map, position only) is Phase 1g. Asserting both halves means a regression in
# either is attributed to the right one.
STATE_DB_URL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_URL // empty')
if [ "${STATE_DB_URL}" = "${EXPECTED_DB_URL_EXPR}" ]; then
  echo "    OK: state DB_URL kept the EMBEDDED expression: ${STATE_DB_URL}"
else
  echo "FAIL: state DB_URL is not the expected embedded form: $(mask "${STATE_DB_URL}")" >&2
  redaction_fail=1
fi

# PREMISE GUARD for Guard 3a-literal below: the leaf must have synthesized as a
# plain STRING, not an `Fn::Join` — the arm under test is the literal-string
# one, and an intrinsic-shaped leaf takes a different (skeleton) path that
# cannot fix this defect, so the assertion below would then fail for the wrong
# reason (or pass for one, if a later change made it whole-token).
# `SYNTH_TEMPLATE` is defined right after Phase 1 (Guard 1b reads it first);
# the probe deploy re-synthesizes `cdk.out`, so what it names from here on is
# the probe deploy's synth -- the same resource shapes, one output more.
if [ ! -f "${SYNTH_TEMPLATE}" ]; then
  echo "FAIL: premise: no synthesized template at ${SYNTH_TEMPLATE} to check DB_DSN_LITERAL's shape" >&2
  exit 1
fi
# `string` for the literal, `object` for an Fn::Join, `null` for a Lambda
# without the key, `absent` for no Lambda at all — each named so the message
# says what was actually found.
DSN_SHAPE=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables.DB_DSN_LITERAL | if . == null then "null" else type end] | first // "absent"' "${SYNTH_TEMPLATE}")
if [ "${DSN_SHAPE}" != "string" ]; then
  echo "FAIL: premise: DB_DSN_LITERAL synthesized as '${DSN_SHAPE}', not a plain string — the literal-leaf arm (#2485) is not what this deploy exercised (is CDK_DEFAULT_ACCOUNT reaching the app?)" >&2
  exit 1
fi
echo "    OK: premise: DB_DSN_LITERAL synthesized as a plain string"
# ...and BEFORE SECRET_PASSWORD_STAGED in the synthesized env (the template
# keeps the stack's declaration order; CDK sorts env keys only under
# `currentVersion`): the collision only collapses onto the STAGED spelling
# when STAGED resolves later, which is what makes Guard 3a-literal below able
# to fail without the fix.
DSN_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("DB_DSN_LITERAL")] | first' "${SYNTH_TEMPLATE}")
STAGED_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("SECRET_PASSWORD_STAGED")] | first' "${SYNTH_TEMPLATE}")
case "${DSN_IDX}${STAGED_IDX}" in *null*|"")
  echo "FAIL: premise: could not locate DB_DSN_LITERAL / SECRET_PASSWORD_STAGED in the synthesized env (${DSN_IDX} / ${STAGED_IDX})" >&2
  exit 1 ;;
esac
# ...and STAGED must be the LAST of EVERY key resolving to that same plaintext,
# not merely later than the literal one. The map keeps one expression per
# PLAINTEXT, so the survivor is whichever colliding key resolves last:
# `SECRET_PASSWORD` reads the same `:SecretString:password` and sits at index 0
# today, and moving it below STAGED would make the survivor a spelling that is
# NOT the staged one, leaving Guard 3a-literal green either way. Matched by
# flattening each value, because these leaves are a MIX of shapes -- the
# account-token ones synthesize as `Fn::Join` objects while DB_DSN_LITERAL is a
# plain string, which is the whole point of the shape guard above. Matched on
# each value RENDERED the way the resolver assembles it (an `Fn::Join` joined
# with its own delimiter, nested joins included) rather than its JSON text, so
# a join splitting the reference across parts still counts (issue #2516 review).
# FAIL CLOSED on a value the premise checker cannot render: `rendered` knows a
# string, an `Fn::Join` (joined with its own delimiter, nested), a
# PLACEHOLDER-FREE `Fn::Sub` (its template string verbatim -- issue #2745's
# DB_PORT_SUB), and a `Ref` to an `AWS::*` pseudo parameter or to one of the
# template's `AWS::SecretsManager::Secret` resources (either contributes no
# reference text: a secret's `Ref` is its ARN, and a secret NAME cannot carry
# a colon, so the ARN cannot spell any part of `:SecretString:` -- issue
# #2745's DB_PORT_JOIN carries the ARN that way; a `Ref` to ANY OTHER resource
# stays unrenderable, since a physical name can spell part of the reference);
# anything else -- an `Fn::Sub` with variables it would have to substitute, or
# a `Ref` to a template parameter whose default could spell part of the
# reference -- marks the value UNRENDERABLE, and a template carrying one
# cannot have its "last key resolving the reference" computed.
# ...and the survivor is decided by EVERY property the resolver walks, not by
# the env alone: a reference to the same key anywhere else in the Lambda's
# properties (a `Description`, say) would resolve after the env and move the
# survivor, so such an occurrence outside `Environment.Variables` fails the
# premise. Rendered leniently (an intrinsic contributes its string parts, an
# `Fn::Join` with its delimiter) because the fail-closed `rendered` below
# would refuse the `Role`'s `Fn::GetAtt`, which cannot spell a reference --
# and, since a lenient render can substitute neither an `Fn::Sub`'s variables
# nor a template PARAMETER's default, any `Fn::Sub` and any `Ref` to a key of
# the template's `Parameters` outside the env fail the premise on their own
# (a `Ref` to a resource yields a physical id, which cannot spell one).
OUTSIDE_ENV_PASSWORD=$(jq -r '
  def rendered_lenient: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered_lenient) | join($d)) elif type=="object" then ([.[] | rendered_lenient] | join("")) elif type=="array" then (map(rendered_lenient) | join("")) else "" end;
  (.Parameters // {} | keys) as $params
  | [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties | del(.Environment.Variables)]
  | (map(rendered_lenient) | join("") | contains(":SecretString:password"))
    or ([.[] | .. | objects | has("Fn::Sub")] | any)
    or ([.[] | .. | objects | select(has("Ref")) | .Ref | IN($params[])] | any)' "${SYNTH_TEMPLATE}")
if [ "${OUTSIDE_ENV_PASSWORD}" != "false" ]; then
  echo "FAIL: premise: a :SecretString:password reference occurs in the consumer Lambda's properties OUTSIDE Environment.Variables or an Fn::Sub / parameter Ref sits there (${OUTSIDE_ENV_PASSWORD}) -- Guard 3a-literal's survivor premise only orders the env keys" >&2
  exit 1
fi
UNRENDERABLE_PASSWORD=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secretRefs
  | def rendered: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered) | join($d)) elif type=="object" and has("Fn::Sub") and (.["Fn::Sub"] | type=="string" and (test("\\$\\{") | not)) then .["Fn::Sub"] elif type=="object" and has("Ref") and (.Ref | startswith("AWS::") or IN($secretRefs[])) then "" else "UNRENDERABLE" end;
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables] | first
  | to_entries | map(select((.value | rendered) | contains("UNRENDERABLE"))) | map(.key) | join(",")' "${SYNTH_TEMPLATE}")
if [ -n "${UNRENDERABLE_PASSWORD}" ]; then
  echo "FAIL: premise: Guard 3a-literal's ordering check cannot render env key(s) ${UNRENDERABLE_PASSWORD} (not a string / Fn::Join / placeholder-free Fn::Sub / AWS::* or secret-resource Ref) -- extend \`rendered\` before relying on the survivor premise" >&2
  exit 1
fi
MAX_PW_IDX=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secretRefs
  | def rendered: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered) | join($d)) elif type=="object" and has("Fn::Sub") and (.["Fn::Sub"] | type=="string" and (test("\\$\\{") | not)) then .["Fn::Sub"] elif type=="object" and has("Ref") and (.Ref | startswith("AWS::") or IN($secretRefs[])) then "" else "UNRENDERABLE" end;
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables] | first
  | to_entries | to_entries
  | map(select((.value.value | rendered) | contains(":SecretString:password")))
  | map(.key) | max' "${SYNTH_TEMPLATE}")
case "${MAX_PW_IDX}" in ''|null)
  echo "FAIL: premise: found no env key resolving :SecretString:password in the synthesized template" >&2
  exit 1 ;;
esac
if [ "${DSN_IDX}" -ge "${STAGED_IDX}" ] || [ "${STAGED_IDX}" -ne "${MAX_PW_IDX}" ]; then
  echo "FAIL: premise: DB_DSN_LITERAL (index ${DSN_IDX}) must precede SECRET_PASSWORD_STAGED (index ${STAGED_IDX}) AND STAGED must be the LAST key resolving to :SecretString:password (last index ${MAX_PW_IDX}); otherwise the collision does not collapse onto the staged spelling and Guard 3a-literal is vacuous" >&2
  exit 1
fi
echo "    OK: premise: DB_DSN_LITERAL (index ${DSN_IDX}) precedes SECRET_PASSWORD_STAGED (index ${STAGED_IDX}), which is the last key resolving to :SecretString:password"

# Guard 3a-literal (issue #2485): the LITERAL leaf embedding the `:password`
# reference must persist ITS OWN spelling. Before the span arm it was redacted
# by the value-keyed map, whose survivor for the shared plaintext is the STAGED
# sibling's expression (that key resolves later), so state read
# `...:password:AWSCURRENT}}@...` here and the deploy diff reported the leaf on
# every run. Exact equality, not a glob: a glob accepting any secretsmanager
# expression passes on exactly the collapsed spelling this guard exists for.
if [ "${STATE_DB_DSN_LITERAL}" = "${EXPECTED_DB_DSN_LITERAL_EXPR}" ]; then
  echo "    OK: state DB_DSN_LITERAL kept its OWN embedded expression: ${STATE_DB_DSN_LITERAL}"
else
  case "${STATE_DB_DSN_LITERAL}" in
    *':AWSCURRENT}}@'*)
      echo "FAIL: state DB_DSN_LITERAL took the STAGED sibling's expression — the embedded leaf collapsed onto the map's survivor (#2485)" >&2 ;;
    *)
      echo "FAIL: state DB_DSN_LITERAL is not the expected embedded form: $(mask "${STATE_DB_DSN_LITERAL}")" >&2 ;;
  esac
  redaction_fail=1
fi

# Guard 3c (issue #2516): the literal leaf embedding a TWO-character secret.
# Below the value scan's four-character needle floor the scan makes no claim,
# so before the fix this leaf persisted `port:<pin>` in plaintext -- with or
# without a sibling. The span arm now writes it as its token only on a bag the
# ENGINE marked as this pass's own (the record's resolved `properties`, the
# readback of the resource it just wrote, the outputs bag it resolved), which
# is what the three assertions below cover one by one. Exact equality with
# the leaf's OWN spelling: the staged sibling is the collapsed map's survivor,
# so a fix writing the survivor rather than the token shows here.
#
# PREMISE GUARD first, the same two facts Guard 3a-literal needs: the leaf
# synthesized as a plain STRING (an `Fn::Join` takes the intrinsic arms --
# Guard 3d's subject, #2745 -- not the literal one this guard is about), and
# it precedes SECRET_PIN_STAGED, the LAST key resolving
# `:SecretString:pin`, so the survivor is the staged spelling. "Resolving" is
# matched on each value RENDERED the way the resolver assembles it (an
# `Fn::Join` joined with its own delimiter, nested joins included), not on
# its JSON text, so a join that splits the reference across parts is still
# counted.
PORT_SHAPE=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables.DB_PORT_LITERAL | if . == null then "null" else type end] | first // "absent"' "${SYNTH_TEMPLATE}")
if [ "${PORT_SHAPE}" != "string" ]; then
  echo "FAIL: premise: DB_PORT_LITERAL synthesized as '${PORT_SHAPE}', not a plain string -- the literal-leaf arm (#2516) is not what this deploy exercised" >&2
  exit 1
fi
PORT_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("DB_PORT_LITERAL")] | first' "${SYNTH_TEMPLATE}")
PIN_STAGED_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("SECRET_PIN_STAGED")] | first' "${SYNTH_TEMPLATE}")
case "${PORT_IDX}${PIN_STAGED_IDX}" in *null*|"")
  echo "FAIL: premise: could not locate DB_PORT_LITERAL / SECRET_PIN_STAGED in the synthesized env (${PORT_IDX} / ${PIN_STAGED_IDX})" >&2
  exit 1 ;;
esac
# FAIL CLOSED on a value the premise checker cannot render: `rendered` knows a
# string, an `Fn::Join` (joined with its own delimiter, nested), a
# PLACEHOLDER-FREE `Fn::Sub` (its template string verbatim -- issue #2745's
# DB_PORT_SUB), and a `Ref` to an `AWS::*` pseudo parameter or to one of the
# template's `AWS::SecretsManager::Secret` resources (either contributes no
# reference text: a secret's `Ref` is its ARN, and a secret NAME cannot carry
# a colon, so the ARN cannot spell any part of `:SecretString:` -- issue
# #2745's DB_PORT_JOIN carries the ARN that way; a `Ref` to ANY OTHER resource
# stays unrenderable, since a physical name can spell part of the reference);
# anything else -- an `Fn::Sub` with variables it would have to substitute, or
# a `Ref` to a template parameter whose default could spell part of the
# reference -- marks the value UNRENDERABLE, and a template carrying one
# cannot have its "last key resolving the reference" computed.
# ...and the survivor is decided by EVERY property the resolver walks, not by
# the env alone: a reference to the same key anywhere else in the Lambda's
# properties (a `Description`, say) would resolve after the env and move the
# survivor, so such an occurrence outside `Environment.Variables` fails the
# premise. Rendered leniently (an intrinsic contributes its string parts, an
# `Fn::Join` with its delimiter) because the fail-closed `rendered` below
# would refuse the `Role`'s `Fn::GetAtt`, which cannot spell a reference --
# and, since a lenient render can substitute neither an `Fn::Sub`'s variables
# nor a template PARAMETER's default, any `Fn::Sub` and any `Ref` to a key of
# the template's `Parameters` outside the env fail the premise on their own
# (a `Ref` to a resource yields a physical id, which cannot spell one).
OUTSIDE_ENV_PIN=$(jq -r '
  def rendered_lenient: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered_lenient) | join($d)) elif type=="object" then ([.[] | rendered_lenient] | join("")) elif type=="array" then (map(rendered_lenient) | join("")) else "" end;
  (.Parameters // {} | keys) as $params
  | [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties | del(.Environment.Variables)]
  | (map(rendered_lenient) | join("") | contains(":SecretString:pin"))
    or ([.[] | .. | objects | has("Fn::Sub")] | any)
    or ([.[] | .. | objects | select(has("Ref")) | .Ref | IN($params[])] | any)' "${SYNTH_TEMPLATE}")
if [ "${OUTSIDE_ENV_PIN}" != "false" ]; then
  echo "FAIL: premise: a :SecretString:pin reference occurs in the consumer Lambda's properties OUTSIDE Environment.Variables or an Fn::Sub / parameter Ref sits there (${OUTSIDE_ENV_PIN}) -- Guard 3c's survivor premise only orders the env keys" >&2
  exit 1
fi
UNRENDERABLE_PIN=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secretRefs
  | def rendered: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered) | join($d)) elif type=="object" and has("Fn::Sub") and (.["Fn::Sub"] | type=="string" and (test("\\$\\{") | not)) then .["Fn::Sub"] elif type=="object" and has("Ref") and (.Ref | startswith("AWS::") or IN($secretRefs[])) then "" else "UNRENDERABLE" end;
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables] | first
  | to_entries | map(select((.value | rendered) | contains("UNRENDERABLE"))) | map(.key) | join(",")' "${SYNTH_TEMPLATE}")
if [ -n "${UNRENDERABLE_PIN}" ]; then
  echo "FAIL: premise: Guard 3c's ordering check cannot render env key(s) ${UNRENDERABLE_PIN} (not a string / Fn::Join / placeholder-free Fn::Sub / AWS::* or secret-resource Ref) -- extend \`rendered\` before relying on the survivor premise" >&2
  exit 1
fi
MAX_PIN_IDX=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secretRefs
  | def rendered: if type=="string" then . elif type=="object" and has("Fn::Join") then (.["Fn::Join"][0] as $d | .["Fn::Join"][1] | map(rendered) | join($d)) elif type=="object" and has("Fn::Sub") and (.["Fn::Sub"] | type=="string" and (test("\\$\\{") | not)) then .["Fn::Sub"] elif type=="object" and has("Ref") and (.Ref | startswith("AWS::") or IN($secretRefs[])) then "" else "UNRENDERABLE" end;
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables] | first
  | to_entries | to_entries
  | map(select((.value.value | rendered) | contains(":SecretString:pin")))
  | map(.key) | max' "${SYNTH_TEMPLATE}")
case "${MAX_PIN_IDX}" in ''|null)
  echo "FAIL: premise: found no env key resolving :SecretString:pin in the synthesized template" >&2
  exit 1 ;;
esac
if [ "${PORT_IDX}" -ge "${PIN_STAGED_IDX}" ] || [ "${PIN_STAGED_IDX}" -ne "${MAX_PIN_IDX}" ]; then
  echo "FAIL: premise: DB_PORT_LITERAL (index ${PORT_IDX}) must precede SECRET_PIN_STAGED (index ${PIN_STAGED_IDX}) AND STAGED must be the LAST key resolving to :SecretString:pin (last index ${MAX_PIN_IDX}); otherwise the survivor is not the staged spelling and Guard 3c cannot tell the token from the survivor" >&2
  exit 1
fi
echo "    OK: premise: DB_PORT_LITERAL is a plain string at index ${PORT_IDX}, before SECRET_PIN_STAGED (index ${PIN_STAGED_IDX}), the last key resolving to :SecretString:pin"

STATE_DB_PORT_LITERAL=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_PORT_LITERAL // empty')
STATE_SECRET_PIN_STAGED=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.SECRET_PIN_STAGED // empty')
if [ "${STATE_DB_PORT_LITERAL}" = "${EXPECTED_DB_PORT_LITERAL_EXPR}" ]; then
  echo "    OK: state DB_PORT_LITERAL kept its OWN embedded expression (two-character secret, #2516): ${STATE_DB_PORT_LITERAL}"
else
  case "${STATE_DB_PORT_LITERAL}" in
    "${EXPECTED_DB_PORT_LITERAL}")
      echo "FAIL: state DB_PORT_LITERAL holds the two-character secret in PLAINTEXT -- the sub-floor residual is open (#2516)" >&2 ;;
    *':AWSCURRENT}}')
      echo "FAIL: state DB_PORT_LITERAL took the STAGED sibling's expression -- the arm wrote the survivor, not the token (#2516)" >&2 ;;
    *)
      echo "FAIL: state DB_PORT_LITERAL is not the expected embedded form: $(mask "${STATE_DB_PORT_LITERAL}")" >&2 ;;
  esac
  redaction_fail=1
fi
# Exact equality, not a glob, and the value is printed only on equality: a
# glob ending in `:pin:AWSCURRENT}}` also accepts a MIXED leaf carrying the
# framed plaintext beside a token, and an echo on that match is a disclosure.
if [ "${STATE_SECRET_PIN_STAGED}" = "${EXPECTED_SECRET_PIN_STAGED_EXPR}" ]; then
  echo "    OK: state SECRET_PIN_STAGED kept its OWN staged expression: ${STATE_SECRET_PIN_STAGED}"
else
  echo "FAIL: state SECRET_PIN_STAGED is NOT its own {{resolve:...:pin:AWSCURRENT}} expression: $(mask "${STATE_SECRET_PIN_STAGED}")" >&2
  redaction_fail=1
fi
# The READBACK of the same resource, installed by the deploy's own capture
# drain and walked at the persist choke point as its own bag against the
# template: a mark on `properties` alone would leave this copy in plaintext.
# Lambda's GetFunctionConfiguration echoes env vars as written (asserted
# live above), so the readback genuinely carries the value at that offset.
OBS_DB_PORT_LITERAL=$(printf '%s' "${STATE_JSON}" \
  | jq -r '[.state.resources[] | select(.resourceType=="AWS::Lambda::Function")
             | .observedProperties.Environment.Variables.DB_PORT_LITERAL // empty] | first // empty')
if [ "${OBS_DB_PORT_LITERAL}" = "${EXPECTED_DB_PORT_LITERAL_EXPR}" ]; then
  echo "    OK: observedProperties DB_PORT_LITERAL holds the embedded expression (the readback bag is marked too, #2516)"
else
  echo "FAIL: observedProperties DB_PORT_LITERAL is not the embedded expression: $(mask "${OBS_DB_PORT_LITERAL}")" >&2
  redaction_fail=1
fi
# The literal OUTPUT embedding the same token, walked by the outputs
# redaction against the template's `Outputs` on the bag this pass resolved.
STATE_PORT_OUTPUT=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.PortLiteral // empty')
if [ "${STATE_PORT_OUTPUT}" = "${EXPECTED_DB_PORT_LITERAL_EXPR}" ]; then
  echo "    OK: state.outputs.PortLiteral holds the embedded expression (the outputs bag is marked too, #2516)"
else
  echo "FAIL: state.outputs.PortLiteral is not the embedded expression: $(mask "${STATE_PORT_OUTPUT}")" >&2
  redaction_fail=1
fi
# The framed plaintext has no legitimate home ANYWHERE in the document (the
# DynRefSecret resource's own SecretString carries `"pin":"q7"`, never
# `port:q7`), so unlike the password grep this one is whole-document.
# A here-string, not `printf | grep -q`: under `pipefail` the builtin printf
# takes SIGPIPE when grep exits on an early line of a multi-line text, and a
# leak check would then read "absent" over a leak.
if grep -qF "${EXPECTED_DB_PORT_LITERAL}" <<< "${STATE_JSON}"; then
  echo "FAIL: the framed two-character secret is somewhere in the persisted state document (#2516)" >&2
  redaction_fail=1
else
  echo "    OK: the framed two-character secret is absent from the WHOLE state document"
fi

# Guard 3d (issue #2745, first site): the same `port:` + two-character
# reference through an INTRINSIC source. The literal span arm needs a source
# string to copy its frame from and the skeleton arm positions only a
# WHOLE-token leaf, so before the frame arm both leaves fell to the value scan
# and persisted `port:<pin>` -- which the whole-document grep above already
# refuses; what these assertions add is the POSITIVE half, exact equality with
# each leaf's OWN expression: the `Fn::Sub`'s name-form spelling, and the L2
# join's ARN-form one, never the staged sibling's (the collapsed map's
# survivor, which a fix writing the survivor would show).
#
# PREMISE GUARD first, per shape. DB_PORT_SUB must have synthesized as an
# `Fn::Sub` OBJECT whose template string is exactly the expected expression (a
# fold to a plain string would exercise the LITERAL arm, #2516, not this one);
# DB_PORT_JOIN as the L2 `Fn::Join` -- empty delimiter, three parts, the prefix
# FUSED into the token's opening part, a `Ref` to the stack's secret INSIDE
# the token, the closing part ending the 6-field token -- a join whose
# non-literal part lands OUTSIDE the token is the nonliteral frame the arm
# refuses (#2745's deferred shape), and a join that folded to a string is the
# literal arm's. Both must precede SECRET_PIN_STAGED for the same survivor
# premise Guard 3c states. On a shape failure the value is printed through
# `diag_output`, which withholds it if it carries a secret.
SUB_SHAPE=$(jq -r --arg expected "${EXPECTED_DB_PORT_SUB_EXPR}" '
  [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables.DB_PORT_SUB] | first
  | if type=="object" and has("Fn::Sub") and (.["Fn::Sub"] == $expected) then "fn-sub" else tojson end' "${SYNTH_TEMPLATE}")
if [ "${SUB_SHAPE}" != "fn-sub" ]; then
  echo "FAIL: premise: DB_PORT_SUB synthesized as '$(diag_output "${SUB_SHAPE}")', not an Fn::Sub over the expected expression -- the intrinsic frame arm (#2745) is not what this deploy exercised" >&2
  exit 1
fi
JOIN_SHAPE=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secrets
  | [.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables.DB_PORT_JOIN] | first
  | if type=="object" and has("Fn::Join") and (.["Fn::Join"][0] == "") and ((.["Fn::Join"][1] | length) == 3)
       and (.["Fn::Join"][1][0] == "port:{{resolve:secretsmanager:")
       and ((.["Fn::Join"][1][1] | type) == "object" and (.["Fn::Join"][1][1] | has("Ref")) and (.["Fn::Join"][1][1].Ref | IN($secrets[])))
       and (.["Fn::Join"][1][2] == ":SecretString:pin::}}")
    then "l2-join" else tojson end' "${SYNTH_TEMPLATE}")
if [ "${JOIN_SHAPE}" != "l2-join" ]; then
  echo "FAIL: premise: DB_PORT_JOIN synthesized as '$(diag_output "${JOIN_SHAPE}")', not the L2 Fn::Join [\"port:{{resolve:secretsmanager:\", {Ref: <secret>}, \":SecretString:pin::}}\"] -- the intrinsic frame arm (#2745) is not what this deploy exercised" >&2
  exit 1
fi
# The OUTPUT twin must carry the SAME L2 shape: an output folded to the
# literal expression would pass the persisted-equality assertion below
# through the literal arm (#2516) and prove nothing about this one.
OUTPUT_JOIN_SHAPE=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secrets
  | .Outputs.PortJoin.Value
  | if type=="object" and has("Fn::Join") and (.["Fn::Join"][0] == "") and ((.["Fn::Join"][1] | length) == 3)
       and (.["Fn::Join"][1][0] == "port:{{resolve:secretsmanager:")
       and ((.["Fn::Join"][1][1] | type) == "object" and (.["Fn::Join"][1][1] | has("Ref")) and (.["Fn::Join"][1][1].Ref | IN($secrets[])))
       and (.["Fn::Join"][1][2] == ":SecretString:pin::}}")
    then "l2-join" else tojson end' "${SYNTH_TEMPLATE}")
if [ "${OUTPUT_JOIN_SHAPE}" != "l2-join" ]; then
  echo "FAIL: premise: Outputs.PortJoin synthesized as '$(diag_output "${OUTPUT_JOIN_SHAPE}")', not the L2 Fn::Join -- the outputs-bag arm of #2745 is not what this deploy exercised" >&2
  exit 1
fi
PORT_SUB_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("DB_PORT_SUB")] | first' "${SYNTH_TEMPLATE}")
PORT_JOIN_IDX=$(jq -r '[.Resources[] | select(.Type=="AWS::Lambda::Function") | .Properties.Environment.Variables | keys_unsorted | index("DB_PORT_JOIN")] | first' "${SYNTH_TEMPLATE}")
case "${PORT_SUB_IDX}${PORT_JOIN_IDX}" in *null*|"")
  echo "FAIL: premise: could not locate DB_PORT_SUB / DB_PORT_JOIN in the synthesized env (${PORT_SUB_IDX} / ${PORT_JOIN_IDX})" >&2
  exit 1 ;;
esac
if [ "${PORT_SUB_IDX}" -ge "${PIN_STAGED_IDX}" ] || [ "${PORT_JOIN_IDX}" -ge "${PIN_STAGED_IDX}" ]; then
  echo "FAIL: premise: DB_PORT_SUB (index ${PORT_SUB_IDX}) and DB_PORT_JOIN (index ${PORT_JOIN_IDX}) must precede SECRET_PIN_STAGED (index ${PIN_STAGED_IDX}); otherwise the survivor is not the staged spelling and Guard 3d cannot tell the token from the survivor" >&2
  exit 1
fi
echo "    OK: premise: DB_PORT_SUB is an Fn::Sub (index ${PORT_SUB_IDX}) and DB_PORT_JOIN the L2 Fn::Join (index ${PORT_JOIN_IDX}), both before SECRET_PIN_STAGED"

STATE_DB_PORT_SUB=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_PORT_SUB // empty')
STATE_DB_PORT_JOIN=$(printf '%s' "${LAMBDA_ENV}" | jq -r '.DB_PORT_JOIN // empty')
for pair in "DB_PORT_SUB|${STATE_DB_PORT_SUB}|${EXPECTED_DB_PORT_SUB_EXPR}" "DB_PORT_JOIN|${STATE_DB_PORT_JOIN}|${EXPECTED_DB_PORT_JOIN_EXPR}"; do
  key="${pair%%|*}"; rest="${pair#*|}"; got="${rest%%|*}"; want="${rest#*|}"
  if [ "${got}" = "${want}" ]; then
    echo "    OK: state ${key} kept its OWN embedded expression (two-character secret through an intrinsic, #2745): ${got}"
  else
    case "${got}" in
      "${EXPECTED_DB_PORT_LITERAL}")
        echo "FAIL: state ${key} holds the two-character secret in PLAINTEXT -- the intrinsic-source residual is open (#2745)" >&2 ;;
      *':AWSCURRENT}}')
        echo "FAIL: state ${key} took the STAGED sibling's expression -- the arm wrote the survivor, not the token (#2745)" >&2 ;;
      *)
        echo "FAIL: state ${key} is not the expected embedded form: $(mask "${got}")" >&2 ;;
    esac
    redaction_fail=1
  fi
done
# The READBACK of the same two leaves: the observed bag is marked by the
# capture drain, and the frame arm reads the mark for that object exactly as
# the literal arm does (Guard 3c's observed assertion, one arm over).
for pair in "DB_PORT_SUB|${EXPECTED_DB_PORT_SUB_EXPR}" "DB_PORT_JOIN|${EXPECTED_DB_PORT_JOIN_EXPR}"; do
  key="${pair%%|*}"; want="${pair#*|}"
  got=$(printf '%s' "${STATE_JSON}" \
    | jq -r --arg k "${key}" '[.state.resources[] | select(.resourceType=="AWS::Lambda::Function")
               | .observedProperties.Environment.Variables[$k] // empty] | first // empty')
  if [ "${got}" = "${want}" ]; then
    echo "    OK: observedProperties ${key} holds the embedded expression (#2745)"
  else
    echo "FAIL: observedProperties ${key} is not the embedded expression: $(mask "${got}")" >&2
    redaction_fail=1
  fi
done
# The L2 join as an OUTPUT, walked by the outputs redaction against the
# template's `Outputs` on the bag this pass resolved (PortLiteral's twin).
STATE_PORT_JOIN_OUTPUT=$(printf '%s' "${STATE_JSON}" | jq -r '.state.outputs.PortJoin // empty')
if [ "${STATE_PORT_JOIN_OUTPUT}" = "${EXPECTED_DB_PORT_JOIN_EXPR}" ]; then
  echo "    OK: state.outputs.PortJoin holds the ARN-form embedded expression (#2745)"
else
  echo "FAIL: state.outputs.PortJoin is not the embedded expression: $(mask "${STATE_PORT_JOIN_OUTPUT}")" >&2
  redaction_fail=1
fi

# Guard 3b (issue #1901): an ssm reference to a SECURESTRING parameter is a
# secret too, so state must hold its expression — even though the SPELLING is
# identical to the plain-ssm reference Guard 4 requires to stay RESOLVED. The
# two guards together are the discriminator: cdkd must decide by the
# parameter's TYPE, and a fix that redacted by spelling would fail Guard 4
# while one that redacted nothing fails this guard.
case "${STATE_SSM_SECURE_VALUE}" in
  '{{resolve:ssm:'*) echo "    OK: state SSM_SECURE_VALUE kept the expression: ${STATE_SSM_SECURE_VALUE}" ;;
  *) echo "FAIL: state SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${STATE_SSM_SECURE_VALUE}")" >&2; redaction_fail=1 ;;
esac

# Guard 4: the plain ssm value IS resolved in state (public config, not a secret).
if [ "${STATE_SSM_VALUE}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: state SSM_VALUE kept the resolved value (ssm String is not a secret)"
else
  echo "FAIL: state SSM_VALUE should be the resolved '${EXPECTED_SSM}' (ssm String is public config), got $(mask "${STATE_SSM_VALUE}")" >&2
  redaction_fail=1
fi

# Guard 5: the RESOLVED-REFERENCE values (the consumer Lambda's env vars) must
# NOT contain the plaintext — this is the dynamic-reference disclosure the fix
# targets. NOTE we scope this to the Lambda's persisted env, NOT the whole
# state: the AWS::SecretsManager::Secret resource's OWN `SecretString` is the
# fixture's hardcoded value (cdk `unsafePlainText`), which legitimately lands in
# that resource's state properties exactly as CloudFormation stores template
# values. Redacting a resource's own literal is a separate concern (hardcoded
# secrets in templates), out of scope for the dynamic-reference fix — and
# redacting it would be the cross-resource false-positive the per-resource
# scoping deliberately avoids. grep -q so the plaintext is never echoed.
if grep -qF "${EXPECTED_PASSWORD}" <<< "${LAMBDA_ENV}"; then
  echo "FAIL: the resolved secret plaintext LEAKED into the Lambda's persisted env (dynamic-ref disclosure)" >&2
  redaction_fail=1
else
  echo "    OK: resolved-reference plaintext is absent from the consumer Lambda's persisted state"
fi
# Same guard for the decrypted SecureString (issue #1901). Unlike the
# secretsmanager case there is no sibling resource legitimately holding this
# value, so the whole STATE document is scanned, not just the Lambda's env.
if grep -qF "${EXPECTED_SECURE}" <<< "${STATE_JSON}"; then
  echo "FAIL: the decrypted SecureString value LEAKED into persisted state (issue #1901)" >&2
  redaction_fail=1
else
  echo "    OK: decrypted SecureString value is absent from the whole state document"
fi
# The secret's OTHER json key must not survive either. Since #1910 restored the
# collision, the staged reference resolves to the password and is covered by the
# grep above; this now guards SECRET_FULL, whose whole-secret resolution carries
# the username and must likewise be stored as its expression. Scoped to
# LAMBDA_ENV, not the whole state: the DynRefSecret resource's OWN SecretString
# legitimately contains it (same rationale as the password grep above).
if grep -qF "${EXPECTED_USERNAME}" <<< "${LAMBDA_ENV}"; then
  echo "FAIL: the whole-secret reference's resolved value LEAKED into the Lambda's persisted env" >&2
  redaction_fail=1
else
  echo "    OK: whole-secret plaintext is absent from the consumer Lambda's persisted state"
fi

if [ "${redaction_fail}" -ne 0 ]; then
  echo "FAIL: state secret-redaction assertions failed" >&2
  exit 1
fi

# Guard 6: a second `cdkd diff` shows NO change (expression-vs-expression) and
# prints no plaintext. A resolved-vs-expression compare would report a spurious
# UPDATE of every secret-bearing property on every deploy.
# `--fail` is what makes the no-change half non-vacuous: it exits 1 on ANY
# change, so a perpetual UPDATE fails the run instead of only being absent from
# a plaintext grep.
echo "==> Asserting a re-diff is clean (no perpetual UPDATE) and leaks no plaintext"
set +e
DIFF_OUT=$(node "${LOCAL_DIST}" diff "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --fail 2>&1)
DIFF_RC=$?
set -e
if grep -qF "${EXPECTED_PASSWORD}" <<< "${DIFF_OUT}"; then
  echo "FAIL: 'cdkd diff' output leaked the resolved secret plaintext" >&2
  exit 1
fi
if grep -qF "${EXPECTED_SECURE}" <<< "${DIFF_OUT}"; then
  echo "FAIL: 'cdkd diff' output leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
echo "    OK: diff leaks no plaintext"
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --fail' reported changes on an unchanged stack (spurious UPDATE — rc=${DIFF_RC})" >&2
  diag_output "${DIFF_OUT}"
  exit 1
fi
echo "    OK: diff reports no changes (secret + SecureString compare expression-vs-expression)"

# Guard 7: `cdkd scrub --dry-run` on the freshly-deployed stack finds NOTHING
# to scrub (deploy already wrote expressions), proving the command runs and the
# deploy-time redaction is complete.
echo "==> Asserting 'cdkd scrub --dry-run' finds nothing on the freshly-deployed stack"
SCRUB_OUT=$(node "${LOCAL_DIST}" scrub "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --dry-run 2>&1)
if grep -qF "${EXPECTED_PASSWORD}" <<< "${SCRUB_OUT}"; then
  echo "FAIL: 'cdkd scrub' output leaked the resolved secret plaintext" >&2
  exit 1
fi
if grep -qF "${EXPECTED_SECURE}" <<< "${SCRUB_OUT}"; then
  echo "FAIL: 'cdkd scrub' output leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
if grep -qiE 'no plaintext secrets|nothing to scrub' <<< "${SCRUB_OUT}"; then
  echo "    OK: scrub --dry-run reports the deployed state is already clean"
else
  echo "FAIL: scrub --dry-run should report nothing to scrub on a freshly-deployed stack" >&2
  diag_output "${SCRUB_OUT}"
  exit 1
fi

# Guard 7b (issue #2531): that scrub run resolved an INTRINSIC `Export.Name`
# through the outputs pass's name loop -- the arm that resolves each name
# through its own view of the pass map. Two PREMISES first, then the one
# assertion the scrub output can carry.
#
# Premise 1, from the synthesized template: the name must be the `Fn::Sub`
# intrinsic the stack declares, with the stack-name placeholder in its body
# (a plain string never enters that arm, and an arbitrary object is not a
# name scrub can resolve to the deploy's key), or the assertion below would
# pass over an arm scrub never ran.
EXPORT_NAME_SHAPE=$(jq -r '.Outputs.FunctionNameExport.Export.Name
  | if . == null then "absent"
    elif (type == "object" and (keys == ["Fn::Sub"]) and (.["Fn::Sub"] | type == "string") and (.["Fn::Sub"] | contains("${AWS::StackName}"))) then "Fn::Sub"
    else type end' "${SYNTH_TEMPLATE}")
if [ "${EXPORT_NAME_SHAPE}" != "Fn::Sub" ]; then
  echo "FAIL: premise: FunctionNameExport's Export.Name synthesized as '${EXPORT_NAME_SHAPE}', not an Fn::Sub over \${AWS::StackName} -- scrub's name-loop arm (#2531) is not what this run exercised" >&2
  exit 1
fi
echo "    OK: premise: FunctionNameExport's Export.Name is an intrinsic (${EXPORT_NAME_SHAPE})"
# Premise 2, DEPLOY-side: the deploy keyed the alias under the resolved name,
# so the key scrub's name loop has to reproduce exists in `state.outputs`.
# This measures the deploy, not the scrub: the only scrub in this fixture is
# `--dry-run`, which writes no state, so the key could not have changed under
# it -- and a clean stack writes nothing under a non-dry-run scrub either.
EXPORT_ALIAS=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null | jq -r --arg k "${STACK}-function-name" '.state.outputs[$k] // empty')
# The value is not echoed on failure: the key is the function name here, but
# a mis-keyed bag could hold any output's value, and this file prints no
# state value it has not checked.
if [ "${EXPORT_ALIAS}" != "${FN_NAME}" ]; then
  echo "FAIL: premise: state.outputs['${STACK}-function-name'] does not hold the function name (${#EXPORT_ALIAS} characters found) -- the deploy did not key the alias under the resolved Export.Name, so there is no key for scrub's name loop to reproduce" >&2
  exit 1
fi
echo "    OK: premise: the deploy keyed the Export.Name alias under '${STACK}-function-name'"
# The assertion: the name loop has three ways of falling back to the value
# scan, and two of them warn at default verbosity -- a resolution that THREW
# (`could not be resolved during scrub`, its error text masked) and one that
# came back with a placeholder still in it (`did not fully resolve during
# scrub`, which echoes nothing).
# What this pins is the ABSENCE of both warnings on an intrinsic name the
# premises above prove entered the arm. The third fallback, a resolution
# returning a NON-STRING, is silent and has no observable here; it and the
# resolution itself -- that the name went through the view -- are pinned by
# the unit suite (tests/unit/cli/commands/scrub-export-name-collision.test.ts),
# not by this run.
for NAME_FALLBACK in "could not be resolved during scrub" "did not fully resolve during scrub"; do
  if grep -qF "${NAME_FALLBACK}" <<< "${SCRUB_OUT}"; then
    echo "FAIL: scrub's name loop fell back to the value scan on the intrinsic Export.Name (#2531 arm): '${NAME_FALLBACK}'" >&2
    diag_output "${SCRUB_OUT}"
    exit 1
  fi
done
echo "    OK: scrub's name loop took the intrinsic Export.Name without either name-resolution fallback warning (#2531)"

# --- Phase 1d: `cdkd drift` and the secret expressions (issue #1914) -------
# The drift command is state-driven, so its baseline is the REDACTED record —
# `{{resolve:...}}` expressions — while `readCurrentState` returns the resolved
# plaintext AWS actually holds. Nothing reconciled the two, and all three of the
# command's modes broke on it: the comparison could not compare (PR #1899 bought
# quiet by SKIPPING every secret-bearing leaf, which also made a real console
# edit of one undetectable), `--accept` persisted the plaintext into state.json,
# and `--revert` shipped the literal `{{resolve:...}}` token to the live Lambda.
#
# Four assertions, in the order the fix has to hold them:
#   (a) a freshly deployed stack reports NO drift,
#   (b) no drift output ever carries the plaintext — nor any OTHER value at a
#       path known to carry a secret, since cdkd cannot tell an out-of-band edit
#       from the previous version of a rotated secret and must mask both,
#   (c) `--revert` leaves the live env var holding the RESOLVED value,
#   (d) `--accept` refuses a masked path and leaves no plaintext in state.json,
#       while still recording the non-secret paths in the same run.
#
# Ordered so the stack is handed back to Phase 1e exactly as it was found: the
# injected drift is reverted, and the accepted key is removed and re-accepted.
echo "==> Phase 1d: cdkd drift on a dynamic-reference stack (issue #1914)"

drift_env() { # drift_env <var> -> live value of one consumer-Lambda env var
  aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}" \
    | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'
}

# Re-send the consumer Lambda's WHOLE env map with one key overridden (or added).
# The map is never echoed — it carries the resolved secrets by construction.
set_live_env() { # set_live_env <key> <value>
  local key="$1" value="$2" env_json
  env_json=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" \
    | jq -c --arg k "${key}" --arg v "${value}" '{Variables: (.Environment.Variables + {($k): $v})}') \
    || return 1
  aws lambda update-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" --environment "${env_json}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${FN_NAME}" --region "${REGION}" \
    2>/dev/null || aws lambda wait function-updated --function-name "${FN_NAME}" --region "${REGION}"
}

drop_live_env() { # drop_live_env <key>
  local key="$1" env_json
  env_json=$(aws lambda get-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" \
    | jq -c --arg k "${key}" '{Variables: (.Environment.Variables | del(.[$k]))}') \
    || return 1
  aws lambda update-function-configuration --function-name "${FN_NAME}" \
    --region "${REGION}" --environment "${env_json}" >/dev/null
  aws lambda wait function-updated-v2 --function-name "${FN_NAME}" --region "${REGION}" \
    2>/dev/null || aws lambda wait function-updated --function-name "${FN_NAME}" --region "${REGION}"
}

# grep -qF so a match is never echoed. Checks every known plaintext, including
# the SecureString one, which has no sibling resource legitimately holding it.
assert_no_plaintext() { # assert_no_plaintext "<what>" "<text>"
  local what="$1" text="$2" leaked=0
  grep -qF "${EXPECTED_PASSWORD}" <<< "${text}" && leaked=1
  grep -qF "${EXPECTED_SECURE}" <<< "${text}" && leaked=1
  grep -qF "${EXPECTED_USERNAME}" <<< "${text}" && leaked=1
  if [ "${leaked}" -ne 0 ]; then
    echo "FAIL: ${what} leaked a resolved secret plaintext" >&2
    exit 1
  fi
  echo "    OK: ${what} carries no plaintext"
}

run_drift() { # run_drift <extra args...> -> sets DRIFT_OUT / DRIFT_RC
  set +e
  DRIFT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
    --region "${REGION}" "$@" 2>&1)
  DRIFT_RC=$?
  set -e
}

# (a) + (b): a freshly deployed dynamic-ref stack has NO drift, and says so
# without printing anything the state record deliberately does not hold.
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' reported drift on a freshly deployed stack (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift' on a clean stack" "${DRIFT_OUT}"
echo "    OK: no drift on the freshly deployed stack"

# Inject drift the way a console edit would: overwrite ONE secret-bearing env
# var, leaving the rest of the map alone.
echo "==> Injecting out-of-band drift on the consumer Lambda's SECRET_PASSWORD"
DRIFT_SENTINEL="cdkd-drift-injected-not-the-secret"
set_live_env SECRET_PASSWORD "${DRIFT_SENTINEL}"

# The edit MUST be detected. Before the fix the comparator skipped every leaf
# whose state side is an expression, so this returned rc=0 — the assertion that
# makes the like-for-like comparison non-vacuous.
run_drift
if [ "${DRIFT_RC}" -eq 0 ]; then
  echo "FAIL: 'cdkd drift' saw no drift after SECRET_PASSWORD was changed out of band" >&2
  exit 1
fi
assert_no_plaintext "'cdkd drift' on a drifted secret leaf" "${DRIFT_OUT}"
if ! grep -qF "Environment.Variables.SECRET_PASSWORD" <<< "${DRIFT_OUT}"; then
  echo "FAIL: 'cdkd drift' did not name the drifted secret env var" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
# The state side of the diff must be the EXPRESSION (not the value it resolves
# to, and not a blind mask).
if ! grep -qF "{{resolve:secretsmanager:" <<< "${DRIFT_OUT}"; then
  echo "FAIL: the drift report's state side is not the {{resolve:...}} expression" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the console edit is reported, with the expression on the state side"

# ...and the injected value itself must NOT be printed. cdkd cannot tell an
# out-of-band edit from the PREVIOUS version of a rotated secret — both are "a
# value at a path known to carry a secret that is not what the reference
# resolves to today" — so the AWS side of such a diff is masked. This sentinel
# is the stand-in for the rotated case, which needs no rotation to express.
if grep -qF "${DRIFT_SENTINEL}" <<< "${DRIFT_OUT}"; then
  echo "FAIL: 'cdkd drift' printed the AWS-current value at a secret-bearing path verbatim" >&2
  exit 1
fi
if ! grep -qF '***' <<< "${DRIFT_OUT}"; then
  echo "FAIL: 'cdkd drift' did not mask the AWS side of the drifted secret path" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the unidentifiable AWS-side value is masked, not printed"

# The DRIFTED SET must be exactly that one path: every other secret-bearing env
# var compares expression-vs-plaintext too, so a fix that resolved nothing (or
# resolved only some references) shows up here as phantom drift.
set +e
DRIFT_JSON=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
set -e
DRIFT_PATHS=$(printf '%s' "${DRIFT_JSON}" \
  | jq -r '.[].drifted[] | select(.type=="AWS::Lambda::Function") | .changes[].path' \
  | sort | tr '\n' ',' | sed 's/,$//')
if [ "${DRIFT_PATHS}" != "Environment.Variables.SECRET_PASSWORD" ]; then
  echo "FAIL: expected exactly one drifted Lambda path, got: ${DRIFT_PATHS}" >&2
  exit 1
fi
assert_no_plaintext "'cdkd drift --json'" "${DRIFT_JSON}"
echo "    OK: exactly one drifted path — no phantom drift on the untouched references"

# --- The all-changes-REFUSED wording (issue #1958) -------------------------
# Everything above proves the refusal HAPPENS. This proves cdkd SAYS SO
# CONSISTENTLY. Two user-visible strings used to contradict the per-change
# `not accepting` warning printed right beside them:
#   - the PLAN header announced `update cdkd state for <stack>` over a body
#     that is nothing but `SKIPPED` lines;
#   - the SUMMARY counted DRIFTED resources rather than RECORDED ones, so it
#     reported `accepted drift on 1 resource(s)` for a run that accepted none.
# Both are read against the state this fixture is already in, which is the only
# state that can tell the two binaries apart: exactly one drifted resource,
# carrying exactly one change, and that change refused.
#
# PREMISE FIRST. Both assertions describe what cdkd says when EVERY change of
# EVERY drifted resource is refused, so a run with nothing to refuse would
# satisfy the same wording for the wrong reason. `DRIFT_JSON` was captured
# immediately above and nothing has been written since.
DRIFTED_RESOURCES=$(printf '%s' "${DRIFT_JSON}" | jq '[.[].drifted[]] | length')
DRIFTED_CHANGES=$(printf '%s' "${DRIFT_JSON}" | jq '[.[].drifted[].changes[]] | length')
if [ "${DRIFTED_RESOURCES}" != "1" ] || [ "${DRIFTED_CHANGES}" != "1" ]; then
  echo "FAIL: the all-refused premise does not hold — expected 1 drifted resource carrying 1 change, got ${DRIFTED_RESOURCES} resource(s) / ${DRIFTED_CHANGES} change(s)" >&2
  exit 1
fi
echo "    OK: exactly one drifted resource carrying exactly one change — the all-refused premise"

# The PLAN half. `printAcceptPlan` runs BEFORE the `--dry-run` short-circuit,
# so this is the very header the write path prints too.
echo "==> Asserting the --accept PLAN does not promise a write it will refuse (issue #1958)"
set +e
ACCEPT_PLAN_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --dry-run 2>&1)
ACCEPT_PLAN_RC=$?
set -e
if [ "${ACCEPT_PLAN_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept --dry-run' failed (rc=${ACCEPT_PLAN_RC})" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept --dry-run'" "${ACCEPT_PLAN_OUT}"
# The body really is all-SKIPPED, from the command's own mouth — a second
# reading of the premise above, taken from the output being asserted on.
if ! grep -qF "SKIPPED" <<< "${ACCEPT_PLAN_OUT}"; then
  echo "FAIL: the --accept plan printed no SKIPPED line, so its header is not being read over an all-refused body" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# POSITIVE marker: only the fixed binary emits this header.
if ! grep -qF "no accepted values will be written to cdkd state for" <<< "${ACCEPT_PLAN_OUT}"; then
  echo "FAIL: the --accept plan did not say that no accepted values will be written" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# ...and it names WHAT the run does still write. `no accepted values`, not
# `nothing`: the real run over this same input takes the lock, bumps
# lastModified and rewrites the bag through the positioned re-redaction, so a
# plan promising an untouched state.json would be false the other way round.
if ! grep -qF "positioned re-redaction" <<< "${ACCEPT_PLAN_OUT}"; then
  echo "FAIL: the --accept plan did not name the positioned re-redaction the run still writes" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
# NEGATIVE: the pre-change header. Paired with the two positives above so this
# arm cannot go green by asserting absences over an empty output.
if grep -qF "Plan (--accept): update cdkd state for" <<< "${ACCEPT_PLAN_OUT}"; then
  echo "FAIL: the --accept plan still promises 'update cdkd state for' over an all-refused body" >&2
  diag_output "${ACCEPT_PLAN_OUT}"
  exit 1
fi
echo "    OK: the plan describes the body it prints, and names the write it does make"

# --accept must REFUSE this path rather than persisting what it just masked:
# writing `***` into the baseline would corrupt state and make the next deploy
# push the literal mask at AWS. The drift keeps being reported, which is the
# honest outcome — `--revert` below is what actually fixes it.
echo "==> Asserting --accept refuses the unidentifiable secret-bearing path"
set +e
ACCEPT_REFUSE_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes 2>&1)
ACCEPT_REFUSE_RC=$?
set -e
if [ "${ACCEPT_REFUSE_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed instead of refusing the path (rc=${ACCEPT_REFUSE_RC})" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept' on a masked path" "${ACCEPT_REFUSE_OUT}"
if ! grep -qF "not accepting" <<< "${ACCEPT_REFUSE_OUT}"; then
  echo "FAIL: --accept did not say it was refusing the secret-bearing path" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
# The SUMMARY half (issue #1958). Same run, same all-refused input: the
# per-change warning asserted just above says nothing was accepted, so the
# summary must agree. A pre-change binary counts `driftedOutcomes.length` here
# and prints `accepted drift on 1 resource(s)` directly under that warning.
if ! grep -qF "0 resource(s) accepted" <<< "${ACCEPT_REFUSE_OUT}"; then
  echo "FAIL: --accept did not report 0 resource(s) accepted after refusing every drifted change" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
if grep -qF "accepted drift on" <<< "${ACCEPT_REFUSE_OUT}"; then
  echo "FAIL: --accept claimed it accepted drift in the same run it refused every change" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
# ...and the write DID happen, which is what makes `0 resource(s) accepted` the
# honest wording rather than `nothing was written`: the summary is still
# prefixed by the state-updated line. Without this, the two assertions above
# would both be satisfied by a run that had silently stopped writing.
if ! grep -qF "State updated for ${STACK} (${REGION})" <<< "${ACCEPT_REFUSE_OUT}"; then
  echo "FAIL: --accept did not report the state write it still performs" >&2
  diag_output "${ACCEPT_REFUSE_OUT}"
  exit 1
fi
echo "    OK: the summary reports 0 resource(s) accepted over the write it still made"
REFUSED_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
if grep -qF "${DRIFT_SENTINEL}" <<< "${REFUSED_STATE}"; then
  echo "FAIL: --accept persisted the injected value at a secret-bearing path" >&2
  exit 1
fi
if grep -qF '"***"' <<< "${REFUSED_STATE}"; then
  echo "FAIL: --accept persisted the MASK into state.json" >&2
  exit 1
fi
REFUSED_ENV=$(printf '%s' "${REFUSED_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
case "$(printf '%s' "${REFUSED_ENV}" | jq -r '.SECRET_PASSWORD // empty')" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*) echo "    OK: --accept left the path on its own expression" ;;
  *)
    echo "FAIL: --accept did not leave SECRET_PASSWORD as its own {{resolve:...}} expression" >&2
    exit 1
    ;;
esac

# (c) --revert must RE-RESOLVE the expression before handing it to the provider.
# Shipping the literal token is the live-breakage half of issue #1914.
echo "==> Reverting the injected drift"
set +e
REVERT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --revert --yes 2>&1)
REVERT_RC=$?
set -e
if [ "${REVERT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --revert' failed (rc=${REVERT_RC})" >&2
  diag_output "${REVERT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --revert'" "${REVERT_OUT}"

REVERTED_PASSWORD=$(drift_env SECRET_PASSWORD)
case "${REVERTED_PASSWORD}" in
  '{{resolve:'*)
    echo "FAIL: --revert wrote the LITERAL {{resolve:...}} token to the live Lambda: ${REVERTED_PASSWORD}" >&2
    exit 1
    ;;
esac
if [ "${REVERTED_PASSWORD}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: --revert left SECRET_PASSWORD as $(mask "${REVERTED_PASSWORD}"), expected the resolved secret" >&2
  exit 1
fi
echo "    OK: --revert restored the RESOLVED secret on the live Lambda"

# The whole env map is re-sent on a revert, so every OTHER reference had to be
# re-resolved too — a fix that only handled the drifted leaf corrupts these.
REVERTED_STAGED=$(drift_env SECRET_PASSWORD_STAGED)
REVERTED_SECURE=$(drift_env SSM_SECURE_VALUE)
REVERTED_FULL=$(drift_env SECRET_FULL)
if [ "${REVERTED_STAGED}" != "${EXPECTED_PASSWORD}" ] \
  || [ "${REVERTED_SECURE}" != "${EXPECTED_SECURE}" ] \
  || [ "${REVERTED_FULL}" != "${EXPECTED_FULL}" ]; then
  echo "FAIL: --revert corrupted a sibling reference the same update re-sent" >&2
  echo "      staged=$(mask "${REVERTED_STAGED}") secure=$(mask "${REVERTED_SECURE}") full=$(mask "${REVERTED_FULL}")" >&2
  exit 1
fi
echo "    OK: every sibling reference the same update re-sent stayed resolved"

# ...and the revert's own state write (the #1644 narrowing record) must not have
# persisted what it just resolved.
POST_REVERT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
POST_REVERT_ENV=$(printf '%s' "${POST_REVERT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
if grep -qF "${EXPECTED_PASSWORD}" <<< "${POST_REVERT_ENV}"; then
  echo "FAIL: --revert persisted the resolved secret into the observed baseline" >&2
  exit 1
fi
if grep -qF "${EXPECTED_SECURE}" <<< "${POST_REVERT_STATE}"; then
  echo "FAIL: --revert persisted the decrypted SecureString value into state" >&2
  exit 1
fi
echo "    OK: the revert's state write kept the expressions"

run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' still reports drift after --revert (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: the stack is clean again after --revert"

# --- A property AWS stops reporting is UNKNOWN, not drift ------------------
# The live twin of the write-only-credential shape (`MasterUserPassword` and
# friends, which no readback returns). Dropping the env var out of band makes
# `readCurrentState` answer with no SECRET_PASSWORD at all, which is the same
# `awsValue === undefined` at a secret-bearing leaf.
#
# Before the fix this was three bugs at once, all introduced by resolving the
# baseline — `calculateResourceDrift`'s `{{resolve:` skip stopped firing once
# the state side was no longer a token: drift reported forever, `--accept`
# writing `undefined` and so DELETING the `{{resolve:...}}` reference out of
# state, and `--revert` re-pushing the credential on every run. No new resource
# and no extra deploy is needed to reach it.
echo "==> Asserting an absent readback at a secret-bearing leaf is not drift"
drop_live_env SECRET_PASSWORD
# The setup must be PROVEN to have taken: a silent no-op here leaves a clean
# stack and every assertion below passes for the wrong reason. Same guard the
# pre-fix seed further down carries.
if [ -n "$(drift_env SECRET_PASSWORD)" ]; then
  echo "FAIL: could not drop SECRET_PASSWORD from the live Lambda — the assertions below would pass vacuously" >&2
  exit 1
fi
echo "    OK: SECRET_PASSWORD is absent from the live Lambda"

run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift' reported drift for a property AWS no longer returns (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift' on an absent secret-bearing property" "${DRIFT_OUT}"
if grep -qF "Environment.Variables.SECRET_PASSWORD" <<< "${DRIFT_OUT}"; then
  echo "FAIL: 'cdkd drift' named a property it cannot read back as drifted" >&2
  exit 1
fi
echo "    OK: an unreadable secret-bearing property is reported as neither clean nor drifted"

# ...and the reference must survive an --accept run driven by anything else.
set_live_env DRIFT_ABSENT_PROBE "cdkd-absent-probe"
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
ABSENT_ACCEPT_RC=$?
set -e
if [ "${ABSENT_ACCEPT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed while a secret-bearing property was unreadable (rc=${ABSENT_ACCEPT_RC})" >&2
  exit 1
fi
ABSENT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
ABSENT_ENV=$(printf '%s' "${ABSENT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# The accept must have LANDED, or the reference below survives only because
# nothing was written at all.
if [ "$(printf '%s' "${ABSENT_ENV}" | jq -r '.DRIFT_ABSENT_PROBE // empty')" != "cdkd-absent-probe" ]; then
  echo "FAIL: --accept did not record the probe key, so the reference assertion below is vacuous" >&2
  exit 1
fi
# observedProperties, NOT properties: this record HAS an observed capture, so
# that is the bag `--accept` rewrites (the `hasObserved` branch). Asserting
# against `properties` reads a bag the command never touches, which passes
# whether or not the fix is present.
ABSENT_PW=$(printf '%s' "${ABSENT_ENV}" | jq -r '.SECRET_PASSWORD // empty')
case "${ABSENT_PW}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    # Inert here — no collapse route reaches this arm — but kept so all three
    # SECRET_PASSWORD checks in this file read the same way, and so a future
    # change that DOES open one is caught by whichever runs first.
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*)
    echo "    OK: --accept left the unreadable property's reference intact in the observed baseline"
    ;;
  '')
    echo "FAIL: --accept ERASED the {{resolve:...}} reference from state.observedProperties" >&2
    exit 1
    ;;
  *)
    echo "FAIL: state SECRET_PASSWORD is no longer its {{resolve:...}} expression: $(mask "${ABSENT_PW}")" >&2
    exit 1
    ;;
esac

# Restore: put the resolved value back and drop the probe key, then re-accept so
# the observed baseline matches AWS again before phase 1d's seed.
set_live_env SECRET_PASSWORD "${EXPECTED_PASSWORD}"
drop_live_env DRIFT_ABSENT_PROBE
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
set -e
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: could not restore a clean drift state after the absent-property arm (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: stack restored to a clean drift state"

# (d) --accept must not carry a plaintext into state.json, on either of the two
# routes it can arrive by.
#
# Route 1 is the AWS-CURRENT value: the drift is injected on a NON-secret key so
# the accepted write is a real one, and what makes the assertion bite is that
# before the fix every secret-bearing leaf ALSO drifted, so the same `--accept`
# wrote every resolved secret into state.
#
# Route 2 is the bag ALREADY IN STATE, and it cannot be produced by driving the
# CLI — it is what a user HAS after running `cdkd drift --accept` on a pre-fix
# binary: `observedProperties` holding the resolved secret while `properties`
# still holds the expression. Re-accepting for an unrelated key re-persists that
# whole bag. So the record is seeded directly into the state bucket here, which
# is the only way to reach the positioned redaction at all — the very pass a
# mutation probe was used to justify, and which had no real-AWS coverage
# without this.
echo "==> Seeding a PRE-FIX state record (plaintext in observedProperties)"
PREFIX_SEED=$(aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" - \
  | jq --arg pw "${EXPECTED_PASSWORD}" '
      .resources |= with_entries(
        if .value.resourceType == "AWS::Lambda::Function"
           and (.value.observedProperties.Environment.Variables.SECRET_PASSWORD? != null)
        then .value.observedProperties.Environment.Variables.SECRET_PASSWORD = $pw
        else . end)') || {
  echo "FAIL: could not read the state document to seed the pre-fix shape" >&2
  exit 1
}
# Fail loudly rather than seeding nothing: every assertion below would pass
# vacuously against an unmodified record.
if ! grep -qF "${EXPECTED_PASSWORD}" <<< "${PREFIX_SEED}"; then
  echo "FAIL: the pre-fix seed did not take — no plaintext in the patched document" >&2
  exit 1
fi
printf '%s' "${PREFIX_SEED}" | aws s3 cp - "s3://${STATE_BUCKET}/${STATE_KEY}"
echo "    OK: state now holds the plaintext an older binary would have written"

echo "==> Accepting an out-of-band env addition"
set_live_env DRIFT_EXTRA "cdkd-drift-extra"
set +e
ACCEPT_OUT=$(node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes 2>&1)
ACCEPT_RC=$?
set -e
if [ "${ACCEPT_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd drift --accept' failed (rc=${ACCEPT_RC})" >&2
  diag_output "${ACCEPT_OUT}"
  exit 1
fi
assert_no_plaintext "'cdkd drift --accept'" "${ACCEPT_OUT}"

POST_ACCEPT_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
POST_ACCEPT_ENV=$(printf '%s' "${POST_ACCEPT_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# Non-vacuous: the accept really did write something.
if [ "$(printf '%s' "${POST_ACCEPT_ENV}" | jq -r '.DRIFT_EXTRA // empty')" != "cdkd-drift-extra" ]; then
  echo "FAIL: --accept did not record the out-of-band env addition" >&2
  exit 1
fi
if grep -qF "${EXPECTED_PASSWORD}" <<< "${POST_ACCEPT_ENV}"; then
  echo "FAIL: --accept persisted the resolved secret plaintext into state.json" >&2
  exit 1
fi
if grep -qF "${EXPECTED_USERNAME}" <<< "${POST_ACCEPT_ENV}"; then
  echo "FAIL: --accept persisted the whole-secret plaintext into state.json" >&2
  exit 1
fi
if grep -qF "${EXPECTED_SECURE}" <<< "${POST_ACCEPT_STATE}"; then
  echo "FAIL: --accept persisted the decrypted SecureString value into state.json" >&2
  exit 1
fi
ACCEPT_STATE_PASSWORD=$(printf '%s' "${POST_ACCEPT_ENV}" | jq -r '.SECRET_PASSWORD // empty')
case "${ACCEPT_STATE_PASSWORD}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}')
    echo "FAIL: --accept left SECRET_PASSWORD on its staged sibling's expression" >&2
    exit 1
    ;;
  '{{resolve:secretsmanager:'*) : ;;
  *)
    echo "FAIL: --accept did not keep SECRET_PASSWORD as its own {{resolve:...}} expression" >&2
    exit 1
    ;;
esac
echo "    OK: --accept wrote the AWS-current value and left every secret leaf on its expression"
# ...and specifically: the plaintext SEEDED into observedProperties above is
# gone, re-redacted onto its own expression by the positioned pass. The
# `EXPECTED_PASSWORD` grep on `POST_ACCEPT_ENV` a few lines up is what proves
# it, but only because of the seed — without it that grep passes on a bag that
# never held the plaintext in the first place. This line records the dependency
# so the seed is not tidied away as setup noise.
echo "    OK: the seeded pre-fix plaintext was re-redacted out of the observed baseline"

# Restore: drop the injected key and re-accept, so Phase 1e starts from the
# baseline Phase 1 deployed.
drop_live_env DRIFT_EXTRA
set +e
node "${LOCAL_DIST}" drift "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --accept --yes >/dev/null 2>&1
set -e
run_drift
if [ "${DRIFT_RC}" -ne 0 ]; then
  echo "FAIL: could not restore the stack to a clean drift state (rc=${DRIFT_RC})" >&2
  diag_output "${DRIFT_OUT}"
  exit 1
fi
echo "    OK: stack restored to a clean drift state"

# --- Phase 1e: standalone rollback RE-RESOLVES secret expressions (GHSA #1899) ---
# The journal (and each state record) stores the REDACTED {{resolve:...}}
# expression, never the plaintext. A standalone `cdkd rollback` must re-resolve
# that expression to the concrete secret for the provider replay — replaying the
# literal token would corrupt the Lambda's env. This phase proves it end to end:
#   1. A CDKD_TEST_ROLLBACK deploy adds a non-secret env var (ROLLBACK_EXTRA,
#      forcing a real Lambda UPDATE whose whole env map is re-sent) plus a
#      failing SQS queue that depends on the Lambda. --no-rollback leaves the
#      journal (Lambda previousState secret env = the redacted expression).
#   2. `cdkd rollback` reverts the Lambda; the fix re-resolves the expression.
#   3. The live Lambda must carry the RESOLVED secret (never the literal), and
#      the probe env var must be gone; state must still hold the expression.
echo "==> Phase 1e: --no-rollback failing deploy + standalone rollback re-resolves the secret"
set +e
CDKD_TEST_ROLLBACK=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --no-rollback --yes
ROLLBACK_DEPLOY_RC=$?
set -e
if [ "${ROLLBACK_DEPLOY_RC}" -eq 0 ]; then
  echo "FAIL: the CDKD_TEST_ROLLBACK deploy was expected to FAIL (invalid SQS queue) but exited 0" >&2
  exit 1
fi
echo "    OK: rollback-probe deploy failed as expected (rc=${ROLLBACK_DEPLOY_RC})"

# The Lambda UPDATE must have completed (ROLLBACK_EXTRA live) before the rollback,
# else there is nothing to re-resolve on the revert.
RB_BEFORE=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")
EXTRA_BEFORE=$(printf '%s' "${RB_BEFORE}" | jq -r '.Environment.Variables.ROLLBACK_EXTRA // empty')
if [ "${EXTRA_BEFORE}" != "v2" ]; then
  echo "FAIL: expected the Lambda UPDATE (ROLLBACK_EXTRA=v2) to have completed before rollback, got '$(mask "${EXTRA_BEFORE}")'" >&2
  exit 1
fi
echo "    OK: Lambda UPDATE completed pre-rollback (ROLLBACK_EXTRA live)"

# Standalone rollback reads the REDACTED journal and must re-resolve.
node "${LOCAL_DIST}" rollback "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

RB_CFG=$(aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}")
rb_env() { printf '%s' "${RB_CFG}" | jq -r --arg k "$1" '.Environment.Variables[$k] // empty'; }
RB_PW=$(rb_env SECRET_PASSWORD)
RB_PW_STAGED=$(rb_env SECRET_PASSWORD_STAGED)
RB_SECURE=$(rb_env SSM_SECURE_VALUE)
RB_EXTRA=$(rb_env ROLLBACK_EXTRA)
case "${RB_PW}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SECRET_PASSWORD is the LITERAL expression — the replay did NOT re-resolve: $(mask "${RB_PW}")" >&2
    exit 1
    ;;
esac
if [ "${RB_PW}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: after rollback the Lambda SECRET_PASSWORD is not the resolved value: got $(mask "${RB_PW}")" >&2
  exit 1
fi
# Issue #1901 makes the SecureString reference a SECOND thing the journal now
# stores redacted, so the replay has to re-resolve it too. Without these two
# checks a replay that shipped the literal `{{resolve:ssm:...}}` to the Lambda
# passes on the secretsmanager assertions alone.
case "${RB_SECURE}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SSM_SECURE_VALUE is the LITERAL expression — the replay did NOT re-resolve the SecureString: $(mask "${RB_SECURE}")" >&2
    exit 1
    ;;
esac
if [ "${RB_SECURE}" != "${EXPECTED_SECURE}" ]; then
  echo "FAIL: after rollback the Lambda SSM_SECURE_VALUE is not the decrypted value: got $(mask "${RB_SECURE}")" >&2
  exit 1
fi
# Issue #1910: the journal is the writer whose collapse is not merely cosmetic.
# `resolveReplayProps` RE-RESOLVES these expressions and ships the result to the
# live Lambda, so a staged/unstaged pair collapsed onto one spelling makes the
# replay resolve the WRONG reference for one of the two leaves. Both must come
# back as the resolved value, and neither may still be a literal expression.
case "${RB_PW_STAGED}" in
  *'{{resolve:'*)
    echo "FAIL: after rollback the Lambda SECRET_PASSWORD_STAGED is the LITERAL expression — the replay did NOT re-resolve: $(mask "${RB_PW_STAGED}")" >&2
    exit 1
    ;;
esac
if [ "${RB_PW_STAGED}" != "${EXPECTED_PASSWORD}" ]; then
  echo "FAIL: after rollback the Lambda SECRET_PASSWORD_STAGED is not the resolved value: got $(mask "${RB_PW_STAGED}")" >&2
  exit 1
fi
if [ -n "${RB_EXTRA}" ]; then
  echo "FAIL: rollback did not revert the Lambda env (ROLLBACK_EXTRA still '$(mask "${RB_EXTRA}")')" >&2
  exit 1
fi
echo "    OK: standalone rollback re-resolved the secret (live SECRET_PASSWORD=RESOLVED, ROLLBACK_EXTRA gone)"

# STATE must still hold the {{resolve:...}} expression after the rollback write.
RB_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
RB_LAMBDA_ENV=$(printf '%s' "${RB_STATE}" | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.properties.Environment.Variables' | head -1)
RB_STATE_PW=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD // empty')
RB_STATE_SECURE=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SSM_SECURE_VALUE // empty')
RB_STATE_PW_STAGED=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.SECRET_PASSWORD_STAGED // empty')
RB_STATE_DSN=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.DB_DSN_LITERAL // empty')
# Issue #2485: the rollback replay re-resolves the journal's OWN tokens and
# persists through the same span arm, so the literal embedded leaf must come
# back on its own spelling here too — a collapsed re-persist in THIS phase
# would otherwise pass silently behind the Phase 1 assertion.
if [ "${RB_STATE_DSN}" != "${EXPECTED_DB_DSN_LITERAL_EXPR}" ]; then
  echo "FAIL: post-rollback state DB_DSN_LITERAL is not its own embedded expression (#2485): $(mask "${RB_STATE_DSN}")" >&2
  exit 1
fi
echo "    OK: post-rollback state kept DB_DSN_LITERAL's OWN embedded expression"
# Issue #2516: the rollback's UPDATE arm persists the JOURNALED record itself
# (the Lambda provider substitutes no `effectiveProperties`), so this leaf
# comes back as the token the failed deploy's journal already held. Pinned so
# a provider or an arm that started re-persisting a resolved replay bag here
# cannot re-open the sub-floor plaintext silently.
RB_STATE_PORT=$(printf '%s' "${RB_LAMBDA_ENV}" | jq -r '.DB_PORT_LITERAL // empty')
if [ "${RB_STATE_PORT}" != "${EXPECTED_DB_PORT_LITERAL_EXPR}" ]; then
  echo "FAIL: post-rollback state DB_PORT_LITERAL is not its own embedded expression (#2516): $(mask "${RB_STATE_PORT}")" >&2
  exit 1
fi
echo "    OK: post-rollback state kept DB_PORT_LITERAL's OWN embedded expression (two-character secret)"
if grep -qF "${EXPECTED_DB_PORT_LITERAL}" <<< "${RB_STATE}"; then
  echo "FAIL: post-rollback state carries the framed two-character secret (#2516)" >&2
  exit 1
fi
case "${RB_STATE_PW}" in
  '{{resolve:secretsmanager:'*) echo "    OK: post-rollback state kept the SECRET_PASSWORD expression" ;;
  *) echo "FAIL: post-rollback state SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${RB_STATE_PW}")" >&2; exit 1 ;;
esac
# Issue #1910: the rollback WRITES state after re-resolving, so it is a redaction
# site of its own — and the colliding pair is what makes this assertion bite. A
# plain `:AWSCURRENT}}` suffix check is what discriminates: without a position
# source BOTH leaves come back on whichever expression the replay recorded last,
# so SECRET_PASSWORD would hold the staged spelling and this leaf the unstaged
# one. Checking only "is it an expression" would pass on the collapsed state.
case "${RB_STATE_PW_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: post-rollback state kept SECRET_PASSWORD_STAGED's OWN staged expression" ;;
  *) echo "FAIL: post-rollback state SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${RB_STATE_PW_STAGED}")" >&2; exit 1 ;;
esac
case "${RB_STATE_PW}" in
  *':AWSCURRENT}}') echo "FAIL: post-rollback state SECRET_PASSWORD took the STAGED expression — the pair collapsed (#1910)" >&2; exit 1 ;;
esac
# The rollback WRITES a state record, so it is its own redaction site (issue
# #1901): re-resolving for the provider must not leave the decrypted value in
# what gets persisted.
case "${RB_STATE_SECURE}" in
  '{{resolve:ssm:'*) echo "    OK: post-rollback state kept the SSM_SECURE_VALUE expression" ;;
  *) echo "FAIL: post-rollback state SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${RB_STATE_SECURE}")" >&2; exit 1 ;;
esac
# Scope the plaintext-leak grep to the CONSUMER Lambda's env, NOT the whole
# state — same rationale as Guard 5 above: the DynRefSecret resource's OWN
# SecretString legitimately holds the fixture's hardcoded password, which is out
# of scope for the dynamic-reference (consumer-side) disclosure this fix targets.
if grep -qF "${EXPECTED_PASSWORD}" <<< "${RB_LAMBDA_ENV}"; then
  echo "FAIL: post-rollback the Lambda's persisted env leaked the resolved secret plaintext" >&2
  exit 1
fi
# The SecureString has no such sibling holding it legitimately, so scan the
# WHOLE post-rollback state document (issue #1901).
if grep -qF "${EXPECTED_SECURE}" <<< "${RB_STATE}"; then
  echo "FAIL: post-rollback state leaked the decrypted SecureString value (issue #1901)" >&2
  exit 1
fi
echo "    OK: post-rollback state carries no resolved plaintext (secret + SecureString)"

# --- Phase 1f: `cdkd state refresh-observed` REDACTS (GHSA residual #1926) ---
# `refresh-observed` writes the provider readback into `observedProperties` and
# saves. The readback is what AWS actually holds — for this fixture's consumer
# Lambda that is the DECRYPTED secret, because the deploy sent the resolved
# value — so before issue #1926 this command persisted the plaintext into
# state.json with no redaction pass of any kind. It is the only observed-writer
# the #1910 sweep never reached, and unlike #1915 it leaked SCALARS too.
#
# Its secrets map is EMPTY by construction (the command neither synthesizes nor
# resolves), so what this arm really exercises is the PATH pass: the record's
# own `properties` still hold the expressions and position the observed bag
# against them.
#
# ORDERING. This runs after Phase 1e and before Phase 2 because it WRITES
# `observedProperties`. The drift phase (1d) reads that field as its baseline,
# so placing this arm before it would change what drift compares; Phase 2
# (a redeploy asserting AWS-side removal resets) and Phase 3 (destroy) read
# only `properties` and the live AWS state, so neither is affected.
echo "==> Phase 1f: cdkd state refresh-observed redacts the readback (issue #1926)"
# STALENESS GUARD. The deploy ALREADY wrote a correctly-redacted
# `observedProperties` for this Lambda, so every assertion below is satisfied by
# the pre-existing bag — a `refresh-observed` that wrote nothing at all would
# pass this phase. Stamp a sentinel into the persisted bag first, and require it
# to be GONE afterwards: only an actual refresh can remove it.
#
# Written directly to S3 rather than through the CLI because no command edits
# `observedProperties` in place — that is the point. Safe here: nothing else
# holds the lock between phases, and the next `saveState` reads its own etag.
echo "    stamping a staleness sentinel into the persisted observedProperties"
RO_STAMP_BEFORE=$(mktemp)
RO_STAMP_AFTER=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${RO_STAMP_BEFORE}" --quiet
# Resolve the logical id FIRST. An assignment cannot be written THROUGH
# `to_entries[]`: that builds a new array rather than a path back into the
# document, and jq rejects it with "Invalid path expression". Phase 1g below
# already uses this shape; Phase 1f now matches it.
RO_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${RO_STAMP_BEFORE}" | head -1)
if [ -z "${RO_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f cannot stamp" >&2
  exit 1
fi
# Assert the bag EXISTS before stamping. A plain assignment would CREATE the
# path, so the post-stamp grep would succeed on a record that never had a
# deploy-time capture — turning the freshness guard into a no-op.
if ! jq -e --arg lid "${RO_LID}" \
     '.resources[$lid].observedProperties.Environment.Variables | objects | has("SSM_VALUE")' \
     "${RO_STAMP_BEFORE}" >/dev/null; then
  echo "FAIL: the Lambda has no persisted observedProperties.Environment.Variables to stamp" >&2
  echo "      (the deploy-time capture is expected to have written one; without it this phase cannot prove freshness)" >&2
  exit 1
fi
jq --arg lid "${RO_LID}" \
  '.resources[$lid].observedProperties.Environment.Variables.SSM_VALUE = "STALE-SENTINEL"' \
  "${RO_STAMP_BEFORE}" > "${RO_STAMP_AFTER}"
if ! grep -q 'STALE-SENTINEL' "${RO_STAMP_AFTER}"; then
  echo "FAIL: the sentinel stamp produced no sentinel — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${RO_STAMP_AFTER}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${RO_STAMP_BEFORE}" "${RO_STAMP_AFTER}"

# No `set +e` window around this call. An earlier revision wrapped it to tolerate
# a transient per-resource readback failure; the sentinel above makes that
# tolerance harmful, because a refresh that skipped this Lambda would leave the
# sentinel behind and the failure should be reported as what it is. Removing the
# wrapper simply lets the script's own `set -euo pipefail` (line 63) do it —
# there is no assertion added here beyond that.
node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

RO_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
RO_OBSERVED=$(printf '%s' "${RO_STATE}" \
  | jq -c '.state.resources | to_entries[]
             | select(.value.resourceType=="AWS::Lambda::Function")
             | .value.observedProperties.Environment.Variables' | head -1)
# A missing / null observed bag would make every assertion below vacuously
# pass, so the run FAILS instead: `LambdaFunctionProvider.readCurrentState`
# reports `Environment.Variables`, and if that ever stops being true this arm
# stops testing anything.
if [ -z "${RO_OBSERVED}" ] || [ "${RO_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observedProperties.Environment.Variables for the consumer Lambda" >&2
  exit 1
fi

RO_PASSWORD=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SECRET_PASSWORD // empty')
RO_SECURE=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
RO_SSM=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_VALUE // empty')

RO_PASSWORD_STAGED=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SECRET_PASSWORD_STAGED // empty')

refresh_fail=0
# The staleness guard's payoff: the sentinel is only gone if this command
# actually re-read AWS and rewrote the bag.
if grep -q 'STALE-SENTINEL' <<< "${RO_OBSERVED}"; then
  echo "FAIL: refresh-observed did not rewrite observedProperties — the staleness sentinel survived" >&2
  echo "      (every redaction assertion below would have passed on the deploy-time bag)" >&2
  refresh_fail=1
else
  echo "    OK: the staleness sentinel is gone — this bag was written by refresh-observed"
fi
case "${RO_PASSWORD}" in
  '{{resolve:secretsmanager:'*) echo "    OK: observed SECRET_PASSWORD kept the expression: ${RO_PASSWORD}" ;;
  *) echo "FAIL: observed SECRET_PASSWORD is NOT the {{resolve:...}} expression: $(mask "${RO_PASSWORD}")" >&2; refresh_fail=1 ;;
esac
# The COLLAPSE pair, exactly as Guard 3 spells it on `properties`. The prefix
# check above accepts ANY secretsmanager expression, so on its own it passes on
# the collapsed state (#1904 / #1910): SECRET_PASSWORD and its staged sibling
# resolve to ONE value, so a value-keyed rewrite hands this leaf the OTHER
# one's expression and the prefix still matches. `refresh-observed` is a NEW
# writer of this bag, so it needs both directions fenced here too — and the
# plaintext greps below cannot see this one, since both spellings are valid
# expressions carrying no plaintext at all.
case "${RO_PASSWORD}" in
  *':AWSCURRENT}}')
    echo "FAIL: observed SECRET_PASSWORD took the STAGED expression — the colliding pair collapsed (#1910)" >&2
    refresh_fail=1
    ;;
esac
case "${RO_PASSWORD_STAGED}" in
  '{{resolve:secretsmanager:'*':AWSCURRENT}}') echo "    OK: observed SECRET_PASSWORD_STAGED kept its OWN staged expression: ${RO_PASSWORD_STAGED}" ;;
  *) echo "FAIL: observed SECRET_PASSWORD_STAGED is NOT its own {{resolve:...:AWSCURRENT}} expression: $(mask "${RO_PASSWORD_STAGED}")" >&2; refresh_fail=1 ;;
esac
# The ssm/ssm discriminator, same pair as Guards 3b + 4 on `properties`: the
# SecureString reference must be an expression while the plain String one must
# stay RESOLVED. A redaction that keyed on the SPELLING would fail the second.
case "${RO_SECURE}" in
  '{{resolve:ssm:'*) echo "    OK: observed SSM_SECURE_VALUE kept the expression: ${RO_SECURE}" ;;
  *) echo "FAIL: observed SSM_SECURE_VALUE is NOT the {{resolve:...}} expression: $(mask "${RO_SECURE}")" >&2; refresh_fail=1 ;;
esac
if [ "${RO_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: observed SSM_VALUE kept the resolved value (ssm String is public config)"
else
  echo "FAIL: observed SSM_VALUE should be the resolved '${EXPECTED_SSM}', got $(mask "${RO_SSM}")" >&2
  refresh_fail=1
fi
# The PUBLIC mixed leaf, and what this arm can HONESTLY assert about it — which
# is NOT issue #2036's residual, though an earlier revision of this phase said
# so and FAILED on both fixed code and `main` (PR #2415's pre-merge run, rc=1 at
# exactly this line).
#
# The reason is one step upstream of the redaction: `properties` holds this key
# RESOLVED. A public ssm `String` is persisted resolved by construction (issue
# #1901 — otherwise every parameter-backed property is a perpetual spurious
# UPDATE), and the `Fn::Join` around it declines the skeleton pass, so the
# POSITION SOURCE for PUBLIC_URL carries no reference at all.
# `refuseUncertifiedReadbackPositions` never reaches its mixed-leaf arm here:
# `isDynamicReferenceString(source)` is false and the readback value passes
# straight through. The verdict store is not consulted either way.
#
# #2036's residual is real, but it needs a source that CARRIES the expression,
# which in the wild only `cdkd import`'s warn path produces. Phase 1f3 stamps
# exactly that shape and asserts the residual there, on a premise that holds.
#
# This arm is a PREMISE PIN, not a discriminator: `origin/main` answers the same,
# for the same reason. It is kept because it is falsifiable by a FUTURE
# over-reach — a blanket needle, or a pairing rule that starts substituting at a
# non-reference source leaf — and because the premise it states is the one two
# earlier arms got wrong.
RO_PUBLIC_URL=$(printf '%s' "${RO_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${RO_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL}" ]; then
  echo "    OK: observed PUBLIC_URL kept the resolved value (premise pin; its source carries no expression)"
else
  echo "FAIL: observed PUBLIC_URL should be '${EXPECTED_PUBLIC_URL}', got $(mask "${RO_PUBLIC_URL}")" >&2
  refresh_fail=1
fi
# Both whole-token SecureString references, each on its OWN expression. They
# spell the same reference, so this is not a collapse fence; it is the baseline
# Phase 1f2 perturbs — that phase orphans SSM_SECURE_COPY from the position
# source, and an arm that never checked it here could not tell "the derived
# needle reached it" from "it was fine all along".
RO_SECURE_COPY=$(printf '%s' "${RO_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${RO_SECURE_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: observed SSM_SECURE_COPY kept the expression (positioned by its own source key)"
else
  echo "FAIL: observed SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${RO_SECURE_COPY}")" >&2
  refresh_fail=1
fi

# Same scoping split as Guard 5: the secret's own resource legitimately holds
# the fixture's hardcoded password, so the password grep is scoped to the
# consumer Lambda's observed bag, while the decrypted SecureString has no such
# sibling and the WHOLE state document is scanned for it.
if grep -qF "${EXPECTED_PASSWORD}" <<< "${RO_OBSERVED}"; then
  echo "FAIL: refresh-observed persisted the DECRYPTED secret into observedProperties (#1926)" >&2
  refresh_fail=1
else
  echo "    OK: no resolved secret plaintext in the refreshed observed bag"
fi
if grep -qF "${EXPECTED_SECURE}" <<< "${RO_STATE}"; then
  echo "FAIL: refresh-observed persisted the decrypted SecureString into state (#1926)" >&2
  refresh_fail=1
else
  echo "    OK: no decrypted SecureString anywhere in the refreshed state document"
fi

if [ "${refresh_fail}" -ne 0 ]; then
  echo "FAIL: refresh-observed redaction assertions failed" >&2
  exit 1
fi

# --- Phase 1f2: an observed KEY the SOURCE does not carry (issue #2012) ---
# The residual row this lane closes, exercised against a REAL readback rather
# than a hand-built bag. `refuseUncertifiedReadbackPositions` substitutes only
# where the position source carries the key; a key AWS reports and the source
# does not has no source leaf to take, and with an EMPTY secrets map the value
# scan it falls back to had no needles — so the DECRYPTED SecureString was
# persisted into `observedProperties` and stayed there.
#
# What closes it is a needle DERIVED from a position the same pass certifies:
# SSM_SECURE_VALUE is in the source as a whole `{{resolve:...}}` token, so
# certifying it establishes that AWS's value there IS that expression resolved,
# and SSM_SECURE_COPY — which holds the same plaintext — matches by value.
#
# HOW THE SHAPE IS PRODUCED. In the wild the extra key comes from AWS itself
# (`FunctionArn`, `LastModified`, a defaulted field). A Lambda's
# `Environment.Variables` is echoed back key-for-key, so the fixture instead
# DELETES one key from the persisted `properties` before refreshing, which is
# the same input configuration: source lacks a key the readback has. The deletion
# is reverted immediately afterwards so Phase 1g starts from the state Phase 1f
# left, and the live Lambda is never touched.
#
# The direct S3 write is the idiom Phase 1f already uses for its staleness
# sentinel, and is safe for the same reason: nothing holds the lock between
# phases and the next `saveState` reads its own etag.
echo "==> Phase 1f2: refresh-observed redacts a key the position source does not carry (issue #2012)"

F2_BEFORE=$(mktemp)
F2_ORPHANED=$(mktemp)
F2_RESTORED=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F2_BEFORE}" --quiet
F2_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${F2_BEFORE}" | head -1)
if [ -z "${F2_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f2 cannot run" >&2
  exit 1
fi
# Assert the key is THERE before deleting it. `del` on an absent path is a
# silent no-op, so without this the phase would refresh an unperturbed record
# and pass on the position pass alone — proving nothing about the needle.
if ! jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_BEFORE}" >/dev/null; then
  echo "FAIL: properties.Environment.Variables.SSM_SECURE_COPY is absent — nothing to orphan" >&2
  exit 1
fi
jq --arg lid "${F2_LID}" \
  'del(.resources[$lid].properties.Environment.Variables.SSM_SECURE_COPY)' \
  "${F2_BEFORE}" > "${F2_ORPHANED}"
if jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_ORPHANED}" >/dev/null; then
  echo "FAIL: could not orphan SSM_SECURE_COPY from the position source" >&2
  exit 1
fi
# Stamp the observed side with the PLAINTEXT the pre-fix code would have left
# there. Two things this buys, and neither is available without it: the refresh
# has something to CHANGE at this key (so a no-op refresh cannot pass), and the
# starting state is exactly the leak being closed rather than a bag Phase 1f
# already cleaned.
jq --arg lid "${F2_LID}" --arg plain "${EXPECTED_SECURE}" \
  '.resources[$lid].observedProperties.Environment.Variables.SSM_SECURE_COPY = $plain' \
  "${F2_ORPHANED}" > "${F2_RESTORED}"
mv "${F2_RESTORED}" "${F2_ORPHANED}"
if ! grep -qF "${EXPECTED_SECURE}" "${F2_ORPHANED}"; then
  echo "FAIL: the plaintext stamp produced no plaintext — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${F2_ORPHANED}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet

node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

F2_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
F2_OBSERVED=$(printf '%s' "${F2_STATE}" \
  | jq -c --arg lid "${F2_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')
if [ -z "${F2_OBSERVED}" ] || [ "${F2_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observed Environment.Variables for ${F2_LID}" >&2
  exit 1
fi

orphan_fail=0
F2_COPY=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${F2_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: the orphaned SSM_SECURE_COPY took the expression by DERIVED NEEDLE (#2012)"
else
  echo "FAIL: orphaned SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F2_COPY}")" >&2
  orphan_fail=1
fi
# The sibling that SUPPLIED the needle must still be right: a regression that
# reached the orphan by rewriting everything would show here first.
F2_SECURE=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
if [ "${F2_SECURE}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: the certifying sibling SSM_SECURE_VALUE still holds its own expression"
else
  echo "FAIL: SSM_SECURE_VALUE should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F2_SECURE}")" >&2
  orphan_fail=1
fi
# The CONTROL, and it is the half that separates a value-keyed needle from a
# blanket rewrite: a public leaf must not be dragged along. SSM_VALUE is stored
# RESOLVED and is not the learned plaintext, so it must survive untouched.
F2_SSM=$(printf '%s' "${F2_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${F2_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: the public SSM_VALUE was not dragged along by the needle"
else
  echo "FAIL: SSM_VALUE should still be the resolved '${EXPECTED_SSM}', got $(mask "${F2_SSM}")" >&2
  orphan_fail=1
fi
# WHOLE-DOCUMENT: the decrypted SecureString has no legitimate home in state.
if grep -qF "${EXPECTED_SECURE}" <<< "${F2_STATE}"; then
  echo "FAIL: the decrypted SecureString survived at a position the source does not carry (#2012)" >&2
  orphan_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

# RESTORE the position source before anything else runs. Done from the bag read
# at the top of this phase rather than by re-adding the key, so a jq slip cannot
# leave a subtly different value behind — and asserted, because a silent restore
# failure would make Phase 1g deploy an UPDATE it is not expecting.
F2_AFTER=$(mktemp)
F2_FINAL=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F2_AFTER}" --quiet
jq --arg lid "${F2_LID}" --slurpfile before "${F2_BEFORE}" \
  '.resources[$lid].properties = $before[0].resources[$lid].properties' \
  "${F2_AFTER}" > "${F2_FINAL}"
if ! jq -e --arg lid "${F2_LID}" \
     '.resources[$lid].properties.Environment.Variables | objects | has("SSM_SECURE_COPY")' \
     "${F2_FINAL}" >/dev/null; then
  echo "FAIL: could not restore the orphaned key into the position source" >&2
  exit 1
fi
aws s3 cp "${F2_FINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${F2_BEFORE}" "${F2_ORPHANED}" "${F2_AFTER}" "${F2_FINAL}"

if [ "${orphan_fail}" -ne 0 ]; then
  echo "FAIL: derived-needle redaction assertions failed" >&2
  exit 1
fi

# --- Phase 1f3: the #2036 RESIDUAL (still OPEN), on a source that carries it ---
# Issue [#2036](https://github.com/go-to-k/cdkd/issues/2036) records an
# OVER-redaction: a MIXED leaf embedding a PUBLIC ssm reference, refused on the
# empty-map readback paths because absence from the verdict store is not
# evidence of anything. Phase 1f used to claim this shape, and could not have:
# `properties` holds PUBLIC_URL RESOLVED (issue #1901), so its position source
# carries no reference and the mixed-leaf arm is never consulted. The arm failed
# on fixed code AND on `main`, which is the signature of a false premise rather
# than a regression.
#
# HOW THE SHAPE IS PRODUCED. A public ssm EXPRESSION survives in `properties`
# only where something wrote it there without resolving: `cdkd import`'s warn
# path, which records the template leaf verbatim. It is unreachable from a
# template-declared leaf on the deploy path, because a properties-borne
# expression makes the resource read as CHANGED and the next UPDATE rewrites it
# resolved. So the fixture stamps it, the same S3 write/restore idiom Phases 1f
# and 1f2 already use, and for the same reason: no command edits this field in
# place, which is the point.
#
# WHICH ARM CARRIES THE DISCRIMINATION, stated because the phase this one
# replaces got exactly this wrong. The residual assertion below is a PIN, not a
# discriminator: `origin/main` refuses this leaf too, and so does this branch --
# issue #2036 stays OPEN, so the refusal rule is unchanged. Keeping the pin is
# still worth the lines (it is falsifiable by any future over-reach that starts
# substituting here), but it is not what earns the phase its runtime. The arm
# that DOES discriminate is the BLAST-RADIUS one: on `main` `SSM_VALUE` stays
# `cdkd-known-ssm-value`, and on this branch it takes its own parameter's
# expression, because only this branch derives a needle from the refused leaf.
#
# WHY #2036 IS STILL OPEN, since this phase is the closest thing to its arm: a
# PROVEN-public verdict store WOULD admit the resolved value here, and PR #2415
# drafted one and WITHDREW it. Keyed on the bare expression and living for the
# whole process, it un-redacts a same-named `SecureString` in another region on
# a `cdkd deploy --all` -- measured, and the un-redacting direction. A revival
# must key the verdict by SCOPE (region + account) at the READ side.
#
# A SEPARATE phase rather than a fold into 1f2, and the reason is measurable:
# once PUBLIC_URL's source carries the expression, `learnMixedLeafNeedle` learns
# `<resolved param value> -> {{resolve:ssm:<name>}}` from it, and the value scan
# then rewrites SSM_VALUE — which holds that same resolved value — onto the same
# expression. That is correct (it is the SAME parameter, so nothing is
# misattributed) but it would destroy Phase 1f2's `SSM_VALUE was not dragged
# along` control, which separates a value-keyed needle from a blanket rewrite.
# The two shapes are therefore exercised on their own records.
echo "==> Phase 1f3: refresh-observed refuses a PUBLIC mixed leaf with no verdict (issue #2036 residual)"

F3_BEFORE=$(mktemp)
F3_STAMPED=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F3_BEFORE}" --quiet
F3_LID=$(jq -r '.resources | to_entries[]
                  | select(.value.resourceType=="AWS::Lambda::Function")
                  | .key' "${F3_BEFORE}" | head -1)
if [ -z "${F3_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1f3 cannot run" >&2
  exit 1
fi
# ASSERT the pre-stamp value is the RESOLVED one. This is the phase's own
# premise stated as a check rather than a comment: if `properties` already held
# the expression, the stamp would be a no-op and the assertion below would pass
# without this phase having perturbed anything.
F3_PRE=$(jq -r --arg lid "${F3_LID}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL // empty' "${F3_BEFORE}")
if [ "${F3_PRE}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "FAIL: properties PUBLIC_URL should start RESOLVED as '${EXPECTED_PUBLIC_URL}', got $(mask "${F3_PRE}")" >&2
  echo "      (Phase 1f3 stamps the expression OVER the resolved value; without that start it proves nothing)" >&2
  exit 1
fi
jq --arg lid "${F3_LID}" --arg expr "${EXPECTED_PUBLIC_URL_EXPR}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL = $expr' \
  "${F3_BEFORE}" > "${F3_STAMPED}"
if ! grep -qF "${EXPECTED_PUBLIC_URL_EXPR}" "${F3_STAMPED}"; then
  echo "FAIL: the PUBLIC_URL expression stamp produced no expression — jq path expression is wrong" >&2
  exit 1
fi
aws s3 cp "${F3_STAMPED}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet

node "${LOCAL_DIST}" state refresh-observed "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

F3_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
F3_OBSERVED=$(printf '%s' "${F3_STATE}" \
  | jq -c --arg lid "${F3_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')

# RESTORE `properties` FIRST, before a single assertion runs. Phase 1g's plain
# deploy must not see the stamped expression: it would read the resource as
# CHANGED and issue an UPDATE that phase is not expecting. Restoring here rather
# than after the assertions means an assertion failure -- or the empty-bag
# refusal below -- cannot leave the stamp behind either, and the `rm -f` of this
# phase's temp files sits on that same path.
#
# Several paths can still leave the stamp live, and saying so beats implying
# there is one: every command between the stamp and the upload below aborts the
# script under `set -e` -- the `refresh-observed` call, the `state show` / `jq`
# reads, this block's own `aws s3 cp` and `jq`, and its `exit 1` when the
# restore does not verify. Counting them is not the point and an earlier
# revision that said THREE was already wrong; what bounds them all is the EXIT
# trap, which destroys the stack and its state. Nothing else does, so do not
# move assertions back above this block.
#
# Done from the bag read at the TOP of this phase rather than by un-stamping, so
# a jq slip cannot leave a subtly different value behind, and asserted, because
# a silent restore failure is what would make Phase 1g deploy an unexpected
# UPDATE.
F3_AFTER=$(mktemp)
F3_FINAL=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${F3_AFTER}" --quiet
jq --arg lid "${F3_LID}" --slurpfile before "${F3_BEFORE}" \
  '.resources[$lid].properties = $before[0].resources[$lid].properties' \
  "${F3_AFTER}" > "${F3_FINAL}"
F3_RESTORED=$(jq -r --arg lid "${F3_LID}" \
  '.resources[$lid].properties.Environment.Variables.PUBLIC_URL // empty' "${F3_FINAL}")
if [ "${F3_RESTORED}" != "${EXPECTED_PUBLIC_URL}" ]; then
  echo "FAIL: could not restore the RESOLVED PUBLIC_URL into the position source" >&2
  exit 1
fi
aws s3 cp "${F3_FINAL}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${F3_BEFORE}" "${F3_STAMPED}" "${F3_AFTER}" "${F3_FINAL}"

if [ -z "${F3_OBSERVED}" ] || [ "${F3_OBSERVED}" = "null" ]; then
  echo "FAIL: refresh-observed wrote no observed Environment.Variables for ${F3_LID}" >&2
  exit 1
fi

residual_fail=0
# THE RESIDUAL, as a PIN (it answers the same on `origin/main` — see the header).
# `cdkd state refresh-observed` neither synthesizes nor resolves, so no
# `GetParameter` ran in this process and the verdict store holds nothing about
# this parameter. Absence is not evidence, the leaf is refused, and the
# expression wins over the value AWS holds. Visible, recoverable, and NOT a
# disclosure — the price of never persisting a decrypted `SecureString` on a
# path that cannot tell the two apart.
F3_PUBLIC_URL=$(printf '%s' "${F3_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${F3_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL_EXPR}" ]; then
  echo "    OK: observed PUBLIC_URL took the expression (#2036 residual, still open — a PIN, same on main)"
else
  echo "FAIL: observed PUBLIC_URL should be '${EXPECTED_PUBLIC_URL_EXPR}', got $(mask "${F3_PUBLIC_URL}")" >&2
  residual_fail=1
fi
# THE NEEDLE'S BLAST RADIUS — and THE ARM THAT DISCRIMINATES in this phase.
# `origin/main` leaves this leaf as `cdkd-known-ssm-value`; only a tree that
# derives needles rewrites it. Refusing
# the leaf also LEARNS from it (`learnMixedLeafNeedle`), so every other leaf
# holding that same resolved value takes the same expression — here SSM_VALUE,
# which references the very same parameter. Nothing is misattributed, and the
# next `cdkd drift` re-resolves it, but the propagation is real and a future
# change that narrows it should have to edit this line rather than discover it
# in the field.
EXPECTED_PUBLIC_EXPR="{{resolve:ssm:${PARAM_NAME}}}"
F3_SSM=$(printf '%s' "${F3_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${F3_SSM}" = "${EXPECTED_PUBLIC_EXPR}" ]; then
  echo "    OK: SSM_VALUE took its OWN parameter's expression by value (the needle's blast radius)"
elif [ "${F3_SSM}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "FAIL: SSM_VALUE took the SecureString expression — the needle was MISATTRIBUTED across parameters" >&2
  residual_fail=1
else
  echo "FAIL: SSM_VALUE should be '${EXPECTED_PUBLIC_EXPR}', got $(mask "${F3_SSM}")" >&2
  echo "      (pinned by the unit case 'propagates a NO-VERDICT ssm needle by VALUE once its own source carries the expression')" >&2
  residual_fail=1
fi
# The SecureString half must be unaffected by any of this.
F3_SECURE=$(printf '%s' "${F3_OBSERVED}" | jq -r '.SSM_SECURE_VALUE // empty')
if [ "${F3_SECURE}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: SSM_SECURE_VALUE still holds its own expression"
else
  echo "FAIL: SSM_SECURE_VALUE should be '${EXPECTED_SECURE_EXPR}', got $(mask "${F3_SECURE}")" >&2
  residual_fail=1
fi
# WHOLE-DOCUMENT: over-redacting a public leaf may never come with a disclosure.
if grep -qF "${EXPECTED_SECURE}" <<< "${F3_STATE}"; then
  echo "FAIL: the decrypted SecureString survived the #2036 residual phase (#1926)" >&2
  residual_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

if [ "${residual_fail}" -ne 0 ]; then
  echo "FAIL: issue #2036 residual assertions failed" >&2
  exit 1
fi

# --- Phase 1g: the DEFAULT `cdkd deploy` path redacts a MIXED leaf (#1926 review) ---
# Phase 1f drives the command; this drives the path that matters more. The
# refusal was hoisted into `secret-redaction.ts` precisely because the leak is
# NOT specific to `cdkd state refresh-observed`: a plain `cdkd deploy`
# auto-refreshes the baseline of any resource whose `observedProperties` is
# ABSENT (`DeployEngine.kickOffAutoRefreshObservedProperties`, on by default via
# `captureObservedState`). Such a resource is UNCHANGED this deploy, so it has
# no secrets map and no template bag, and its readback drains through the
# persist choke point with exactly the configuration Phase 1f exercises by hand.
# Verifying only the command would leave the default path on unit tests alone.
#
# Reaching that path needs the bag ABSENT, which after Phase 1 it is not — so
# this arm clears it, then runs an ordinary deploy with no template change.
echo "==> Phase 1g: a plain deploy re-captures the baseline WITHOUT the plaintext (issue #1926)"

PRE_G_STATE=$(mktemp)
POST_G_STATE=$(mktemp)
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY}" "${PRE_G_STATE}" --quiet

# ASSERT, do not assume, that the deploy captures a baseline at all: a silently
# empty bag would make every assertion below vacuous. `captureObservedState`
# defaults ON, and Phase 1f has just refreshed it, so absence here means the
# capture broke rather than that this fixture opted out.
G_LID=$(jq -r '.resources | to_entries[]
                 | select(.value.resourceType=="AWS::Lambda::Function")
                 | .key' "${PRE_G_STATE}" | head -1)
if [ -z "${G_LID}" ]; then
  echo "FAIL: no AWS::Lambda::Function record in state — Phase 1g cannot run" >&2
  exit 1
fi
G_HAD_OBSERVED=$(jq -r --arg lid "${G_LID}" \
  '.resources[$lid].observedProperties.Environment.Variables.DB_URL // empty' "${PRE_G_STATE}")
if [ -z "${G_HAD_OBSERVED}" ]; then
  echo "FAIL: the deploy captured no observedProperties.Environment.Variables.DB_URL for ${G_LID}" >&2
  echo "      (captureObservedState is ON by default; an empty bag makes this phase vacuous)" >&2
  exit 1
fi
echo "    OK: a baseline exists to re-capture (${G_LID})"

# Clear ONLY that resource's observed bag — the auto-refresh keys on its absence.
jq --arg lid "${G_LID}" 'del(.resources[$lid].observedProperties)' "${PRE_G_STATE}" > "${POST_G_STATE}"
if jq -e --arg lid "${G_LID}" 'has("resources") and (.resources[$lid] | has("observedProperties"))' \
     "${POST_G_STATE}" >/dev/null; then
  echo "FAIL: could not clear observedProperties for ${G_LID}" >&2
  exit 1
fi
aws s3 cp "${POST_G_STATE}" "s3://${STATE_BUCKET}/${STATE_KEY}" --quiet
rm -f "${PRE_G_STATE}" "${POST_G_STATE}"

# A PLAIN deploy: no CDKD_TEST_* mode, no template change. Every resource is
# NO_CHANGE, which is the point — an unchanged resource has no secrets map.
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

G_STATE=$(node "${LOCAL_DIST}" state show "${STACK}" --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" --json 2>/dev/null)
G_OBSERVED=$(printf '%s' "${G_STATE}" \
  | jq -c --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.Environment.Variables')
if [ -z "${G_OBSERVED}" ] || [ "${G_OBSERVED}" = "null" ]; then
  echo "FAIL: the plain deploy did NOT re-capture observedProperties for ${G_LID}" >&2
  echo "      (this phase cleared the bag; a deploy that leaves it empty proves nothing)" >&2
  exit 1
fi
echo "    OK: the plain deploy re-captured the baseline"

deploy_redaction_fail=0
G_DB_URL=$(printf '%s' "${G_OBSERVED}" | jq -r '.DB_URL // empty')
G_DSN_LITERAL=$(printf '%s' "${G_OBSERVED}" | jq -r '.DB_DSN_LITERAL // empty')
if [ "${G_DB_URL}" = "${EXPECTED_DB_URL_EXPR}" ]; then
  echo "    OK: re-captured DB_URL kept the EMBEDDED expression: ${G_DB_URL}"
else
  echo "FAIL: re-captured observed DB_URL is not the expected embedded expression: $(mask "${G_DB_URL}")" >&2
  deploy_redaction_fail=1
fi
# The literal embedded leaf on the EMPTY-map readback path. This is NOT a
# #2485 fence — with no map the span arm has no evidence and never fires; the
# spelling here comes from the same-generation POSITIONAL refusal
# (`refuseUncertifiedReadbackPositions`), which substitutes the source leaf
# whole, and it passes with or without the span arm. It is pinned as the
# invariant the arm must not break: the #2485 fences are Phase 1 (persist) and
# Phase 1e (rollback replay), where the map IS populated.
if [ "${G_DSN_LITERAL}" = "${EXPECTED_DB_DSN_LITERAL_EXPR}" ]; then
  echo "    OK: re-captured DB_DSN_LITERAL kept its embedded expression (empty-map positional invariant)"
else
  echo "FAIL: re-captured DB_DSN_LITERAL is not its embedded expression: $(mask "${G_DSN_LITERAL}")" >&2
  deploy_redaction_fail=1
fi
# The two-character twin on the same EMPTY-map readback path (issue #2516).
# Same invariant, not a #2516 fence: the resource is UNCHANGED this deploy, so
# there is no pair for the mark to pair with, and the spelling comes from the
# positional refusal substituting the source leaf whole. Its #2516 fences are
# Guard 3c (the CREATE deploy's own readback) and Phase 1e.
G_PORT_LITERAL=$(printf '%s' "${G_OBSERVED}" | jq -r '.DB_PORT_LITERAL // empty')
if [ "${G_PORT_LITERAL}" = "${EXPECTED_DB_PORT_LITERAL_EXPR}" ]; then
  echo "    OK: re-captured DB_PORT_LITERAL kept its embedded expression (empty-map positional invariant, two-character secret)"
else
  echo "FAIL: re-captured DB_PORT_LITERAL is not its embedded expression: $(mask "${G_PORT_LITERAL}")" >&2
  deploy_redaction_fail=1
fi

# CONTROL 1: the persisted bag must still be AWS's READBACK, not a copy of the
# record's own `properties`. This is the control that catches a blanket
# "substitute the source wherever it carries a reference" regression, and it
# works because source and bag genuinely DIFFER here: the template sets only
# Code / Environment / Handler / Role / Runtime / Timeout, so `FunctionName` and
# `MemorySize` exist ONLY on the AWS side. A take-source-wholesale bug drops
# them; a mask/drop bug mangles them.
#
# The SSM_VALUE control below cannot do this job on its own, and the review was
# right about why: that leaf is stored RESOLVED, so `source === bag` there and a
# take-source bug writes back the identical string.
G_FN_NAME=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.FunctionName // empty')
G_MEM=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].observedProperties.MemorySize // empty')
if [ "${G_FN_NAME}" = "${FN_NAME}" ] && [ -n "${G_MEM}" ]; then
  echo "    OK: the persisted bag is AWS's readback (carries FunctionName + MemorySize, which the template never sets)"
else
  echo "FAIL: the re-captured bag lost AWS-only keys — FunctionName='${G_FN_NAME}' (want '${FN_NAME}'), MemorySize='${G_MEM}'" >&2
  echo "      (a bag missing keys the template never set is the record's own properties, not a readback)" >&2
  deploy_redaction_fail=1
fi

# CONTROL 2: a PUBLIC ssm String must still be RESOLVED — this one catches a
# mask/drop regression at a leaf whose correct answer is the plaintext.
G_SSM=$(printf '%s' "${G_OBSERVED}" | jq -r '.SSM_VALUE // empty')
if [ "${G_SSM}" = "${EXPECTED_SSM}" ]; then
  echo "    OK: re-captured SSM_VALUE stayed RESOLVED (public config is not redacted)"
else
  echo "FAIL: re-captured SSM_VALUE should be the resolved '${EXPECTED_SSM}', got $(mask "${G_SSM}")" >&2
  deploy_redaction_fail=1
fi

# CONTROL 3: the mixed leaf carrying a PUBLIC ssm reference keeps AWS's value.
#
# LABELLED AS A SANITY CONTROL, NOT AS ISSUE #2036 COVERAGE, and the distinction
# was measured: this arm passes IDENTICALLY on `origin/main`. An earlier revision
# claimed it as the #2036 closure and said the failure form "means the public
# verdict was not consulted". Both were wrong for the same upstream reason Phase
# 1f's arm was: `properties` holds PUBLIC_URL RESOLVED (issue #1901), so the
# POSITION SOURCE carries no reference, `refuseUncertifiedReadbackPositions`
# never reaches its mixed-leaf arm, and the readback passes straight through.
#
# What it DOES still catch is a mask/drop regression at a leaf whose correct
# answer is the plaintext, on the DEPLOY path rather than the command path —
# worth keeping, worth not overselling.
#
# The #2036 residual direction is exercised in Phase 1f3, on a stamped source
# that genuinely carries the expression. There is no CLOSURE direction to fence:
# issue #2036 is still OPEN -- see Phase 1f3's header for the scope defect that
# withdrew the fix.
G_PUBLIC_URL=$(printf '%s' "${G_OBSERVED}" | jq -r '.PUBLIC_URL // empty')
if [ "${G_PUBLIC_URL}" = "${EXPECTED_PUBLIC_URL}" ]; then
  echo "    OK: re-captured PUBLIC_URL kept the RESOLVED public value (sanity control, not #2036 coverage)"
else
  echo "FAIL: re-captured PUBLIC_URL should be '${EXPECTED_PUBLIC_URL}', got $(mask "${G_PUBLIC_URL}")" >&2
  deploy_redaction_fail=1
fi

# ...and its SECRET twin on the same deploy, which is what stops the arm above
# from being satisfied by a blanket "keep the readback for every mixed leaf"
# regression. Same shape, same empty map, opposite answer.
G_SECURE_COPY=$(printf '%s' "${G_OBSERVED}" | jq -r '.SSM_SECURE_COPY // empty')
if [ "${G_SECURE_COPY}" = "${EXPECTED_SECURE_EXPR}" ]; then
  echo "    OK: re-captured SSM_SECURE_COPY still holds the expression (the SecureString twin)"
else
  echo "FAIL: re-captured SSM_SECURE_COPY should be '${EXPECTED_SECURE_EXPR}', got $(mask "${G_SECURE_COPY}")" >&2
  deploy_redaction_fail=1
fi

# ...and the properties half, unchanged by this deploy, so a regression that
# rewrote `properties` instead of `observedProperties` cannot hide.
G_PROPS_DB_URL=$(printf '%s' "${G_STATE}" \
  | jq -r --arg lid "${G_LID}" '.state.resources[$lid].properties.Environment.Variables.DB_URL // empty')
case "${G_PROPS_DB_URL}" in
  'postgres://app-svc:{{resolve:ssm:'*'@db.'*'.internal:5432/app')
    echo "    OK: properties DB_URL still holds the embedded expression" ;;
  *) echo "FAIL: properties DB_URL is not the embedded expression: $(mask "${G_PROPS_DB_URL}")" >&2
     deploy_redaction_fail=1 ;;
esac

# WHOLE-DOCUMENT, not just the key. The SecureString's decrypted value has no
# legitimate home anywhere in state — unlike the secret's own `SecretString`,
# which the DynRefSecret resource genuinely holds (the reason Guard 5 scopes ITS
# password grep to the Lambda's env). That is why the MIXED leaf was built on
# the SecureString: it makes this assertion available.
if grep -qF "${EXPECTED_SECURE}" <<< "${G_STATE}"; then
  echo "FAIL: a plain deploy persisted the decrypted SecureString into state (#1926)" >&2
  deploy_redaction_fail=1
else
  echo "    OK: the decrypted SecureString is absent from the WHOLE state document"
fi

if [ "${deploy_redaction_fail}" -ne 0 ]; then
  echo "FAIL: default-deploy redaction assertions failed" >&2
  exit 1
fi

# --- Phase 2: removal-reset redeploy (issue #1160 secretsmanager batch) ---
echo "==> Phase 2: re-deploy dropping Description + KmsKeyId (removal reset)"
CDKD_TEST_REMOVAL=true node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

# Pre-fix UpdateSecret merge semantics silently kept both values; post-fix
# the provider sends Description='' and KmsKeyId='' (the SDK-documented
# "revert to aws/secretsmanager" sentinel) and DescribeSecret reports the
# pristine shape again: Description absent (text output 'None') and KmsKeyId
# absent ('None').
DESC_P2=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'Description' --output text)
KMS_P2=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'KmsKeyId' --output text)
# Asymmetry is deliberate: a cleared Description may surface as omitted
# ('None') or as a literal empty string depending on how AWS normalizes the
# '' write — both mean "no description". A cleared KmsKeyId is always OMITTED
# from DescribeSecret (the pristine managed-key shape), so it must be exactly
# 'None' — an empty string there would be an unexpected wire shape.
if { [ "${DESC_P2}" != "None" ] && [ -n "${DESC_P2}" ]; } || [ "${KMS_P2}" != "None" ]; then
  echo "FAIL: expected Description/KmsKeyId cleared after removal redeploy, got '${DESC_P2}' / '${KMS_P2}'" >&2
  exit 1
fi
echo "    OK: Description + KmsKeyId reset to the pristine defaults on AWS"

# --- Phase 3: destroy -------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --yes

assert_gone "consumer Lambda '${FN_NAME}' still exists after destroy" aws lambda get-function-configuration --function-name "${FN_NAME}" --region "${REGION}"
echo "    OK: consumer Lambda is gone"

# SecretsManager DeleteSecret SCHEDULES deletion with a recovery window
# (7-30 days) by default; cdkd's secret provider matches CloudFormation and does
# NOT force-delete-without-recovery. So after destroy the secret is NOT gone
# immediately: describe-secret still returns it with a non-empty DeletedDate
# (ScheduledDeletionDate), and it disappears from a default list-secrets (which
# excludes planned-deletion) but reappears under --include-planned-deletion.
# Therefore "scheduled for deletion" (DeletedDate set) is a PASS; only a secret
# that is still ACTIVE with no DeletedDate is a real failure.
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
  SECRET_DELETED_DATE="GONE"
elif ! SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
    --region "${REGION}" --query 'DeletedDate' --output text 2>&1); then
  # TOCTOU: the secret can vanish between gone_probe and this requery.
  grep -qiE 'not ?found|no ?such|does ?not ?exist|non ?existent|\(404' <<< "${SECRET_DELETED_DATE}" \
    && SECRET_DELETED_DATE="GONE" \
    || { echo "FAIL: describe-secret requery undetermined: ${SECRET_DELETED_DATE}" >&2; exit 1; }
fi
if [ "${SECRET_DELETED_DATE}" = "GONE" ]; then
  echo "    OK: secret is gone (describe-secret reports it no longer exists)"
elif [ -n "${SECRET_DELETED_DATE}" ] && [ "${SECRET_DELETED_DATE}" != "None" ]; then
  echo "    OK: secret is scheduled for deletion (DeletedDate=${SECRET_DELETED_DATE}) - SecretsManager recovery-window semantics"
else
  echo "FAIL: secret '${SECRET_NAME}' still ACTIVE after destroy (no DeletedDate set)" >&2
  exit 1
fi

assert_gone "SSM parameter '${PARAM_NAME}' still exists after destroy" aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
echo "    OK: SSM parameter is gone"

# The SecureString parameter is NOT in the stack (this script created it), so
# destroy must have left it alone — deleting a resource cdkd does not manage
# would be the real failure here. Then remove it ourselves and prove it is gone,
# so the run ends with no orphan (the cleanup trap is a backstop, not the proof).
if gone_probe aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"; then
  echo "FAIL: destroy deleted the out-of-band SecureString parameter '${SECURE_PARAM_NAME}' — cdkd must not touch a resource it does not manage" >&2
  exit 1
fi
echo "    OK: destroy left the unmanaged SecureString parameter intact"
aws ssm delete-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" >/dev/null
assert_gone "out-of-band SecureString parameter '${SECURE_PARAM_NAME}' still exists after its explicit delete" aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"
echo "    OK: out-of-band SecureString parameter is gone"

assert_gone "state file s3://${STATE_BUCKET}/${STATE_KEY} still exists after destroy" aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
echo "    OK: state file is gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH -------------------------
# "state file is gone" above is a head-object on the CURRENT object, and that
# is exactly the assertion that let issue #2096 stand: the bucket is VERSIONED,
# so it was green while 304 versions of this key still carried
# cdkd-known-pw-123. The sweep therefore runs HERE, on the normal path, and not
# only in `cleanup` -- a fixture that disarms its trap on success never runs a
# trap-only cleanup, which is how a sibling key reached 30 versions on
# 2026-08-19. `cleanup` is invoked explicitly first (it force-deletes the
# secret and drops the state/lock objects), then the trap is disarmed so
# nothing can write a new delete marker after the count is taken.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" "secrets-dynamic-ref state teardown"

echo ""
echo "==> secrets-dynamic-ref test passed (dynamic references resolved correctly + clean destroy + zero surviving state versions)"
