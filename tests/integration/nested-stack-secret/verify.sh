#!/usr/bin/env bash
# verify.sh - cdkd nested-stack-secret integ.
#
# The secret flow across a NESTED-STACK boundary, in BOTH directions, plus the
# scoping of the redaction inside the child.
#
#   #1903 - parameters IN. The PARENT resolves the child's `Parameters` block,
#           so the child engine receives PLAINTEXT while its own template
#           spells the consumption as `{Ref: <ParamName>}` -- an intrinsic
#           OBJECT, never a `{{resolve:` string. Nothing in the child's own
#           resolution can record the `plaintext -> expression` pair its
#           state-save choke point redacts with, so the child's state.json
#           persisted the DECRYPTED secret.
#   #2055 - outputs OUT. Since PR #1899 a secret-bearing output is persisted
#           REDACTED, and the parent read the child's outputs verbatim, so
#           `Fn::GetAtt: [Child, 'Outputs.X']` shipped the literal
#           `{{resolve:...}}` token to AWS.
#   #2087 - the SCOPE of the fix. The pair must land only in the bag of a
#           resource that actually consumed the parameter. `UnrelatedParam`
#           below is the discriminator: an ordinary literal that CONTAINS the
#           plaintext as a substring and references nothing.
#   #2270 - the `Fn::Sub` SPELLING of that same outputs-OUT read. The resolver
#           rejected the three-segment STRING form
#           (`${Child.Outputs.X}` -> `Fn::GetAtt "Child.Outputs.X"`), and
#           `Fn::Sub`'s catch turned the rejection into a KEPT literal, so the
#           resource was created holding the placeholder TEXT with a green
#           deploy. `SubConsumer` reads a NON-secret child output, so its
#           failure cannot be confused with a redaction failure. ROUND 3 adds
#           the half `SubConsumer` cannot see: making that placeholder resolve
#           CREATED a #2059 collapse population, because the leaf now carries a
#           secret and `crossStackSourceKey` refused every `Fn::Sub`.
#           `SubSecretPair` holds BOTH leaves in ONE resource (its Value and its
#           Description) reading two expressions of one secret that resolve
#           EQUAL, and each must persist its OWN. One resource, not two:
#           `perResourceSecrets` is keyed by logical id, so two resources get
#           two bags and would pass either way. The pair uses its own JSON key,
#           so `StageParam` stays the only leaf carrying ITS plaintext.
#   #2086 - the rollback executor binds the same seed. Not directly provoked
#           here (that needs a mid-deploy failure); its unit coverage is
#           `tests/unit/deployment/rollback-executor-nested-stack-secret-scope.test.ts`.
#           What this fixture contributes is the shape those bindings feed.
#
# THREE deploys, and the third is not decoration. Phases 1-2b only ever reach
# `NestedStackProvider.create` and a no-op, so the deploy engine's UPDATE call
# site -- the arm #1903's own comment names, "a nested stack that already exists
# silently keeps persisting the parent's plaintext" -- never ran here at all.
# Phase 2c changes a CHILD property so the parent's `Child` row is a genuine
# UPDATE, and asserts from AWS that it happened before drawing any conclusion
# from the resulting state.
#
# The perpetual-UPDATE class is checked by EXIT CODE, not by text: a redeploy
# plus `cdkd diff --recursive --fail` must exit 0 over the whole tree.
#
# SECURITY: the two secret values are never echoed. Only masked forms and
# PASS/FAIL lines reach the log -- and both deploys run under `--verbose` with
# their output SCANNED for either plaintext, because the child engine is the one
# place `context.parameters` holds a decrypted value.
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

# Some AWS deletes are ASYNCHRONOUS, so a SINGLE gone-probe fired straight after
# the delete call reads the pre-delete view and reports a leak that does not
# exist. Measured here 2026-08-26: `delete-secret --force-delete-without-recovery`
# returned, the probe immediately after said the secret was still present, and a
# `describe-secret` seconds later returned ResourceNotFoundException -- a FALSE
# leak report, which is worse than a missing assertion because it is
# indistinguishable from the real thing and sends the reader into the deletion
# code. Poll instead, and keep gone_probe's tri-state: a genuinely undetermined
# error still fails fast rather than being retried until the deadline.
assert_gone_eventually() { # usage: assert_gone_eventually <timeout_s> "<desc>" aws <service> <verb> [args...]
  local timeout="$1" desc="$2"
  shift 2
  local waited=0
  while :; do
    if gone_probe "$@"; then
      return 0
    fi
    if [ "${waited}" -ge "${timeout}" ]; then
      echo "FAIL: ${desc} (still present after ${timeout}s of polling)" >&2
      exit 1
    fi
    sleep 3
    waited=$(( waited + 3 ))
  done
}

cd "$(dirname "$0")"

export AWS_PAGER=""

# Shared S3 VERSION-sweep helpers (issue #2096). The state bucket is VERSIONED,
# so `aws s3 rm` only writes a delete marker and every state.json this fixture
# wrote stays readable via GetObjectVersion after a green run. That matters
# more here than almost anywhere: proving the CURRENT state.json is redacted
# says nothing about the versions behind it.
. ../s3-versions.sh

STACK="CdkdNestedStackSecretVerify"
CHILD_STACK="${STACK}~Child"
REGION="${AWS_REGION:-us-east-1}"
PARENT_KEY="cdkd/${STACK}/${REGION}/state.json"
CHILD_KEY="cdkd/${CHILD_STACK}/${REGION}/state.json"
PARENT_PREFIX="$(s3_stack_prefix "${STACK}" "${REGION}")"
CHILD_PREFIX="$(s3_stack_prefix "${CHILD_STACK}" "${REGION}")"

LOCAL_DIST="${PWD}/../../../dist/cli.js"

ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)

# Created OUT OF BAND by this script, and deleted by it. CloudFormation cannot
# create a SecureString parameter at all; the secretsmanager secret is kept out
# of band for a different reason -- a `{{resolve:...}}` reference is a literal
# string, so there is no DAG edge that could order a consumer behind an
# in-stack producer.
SECRET_NAME="cdkd-nested-secret-${ACCOUNT_ID}"
SECURE_PARAM_NAME="cdkd-nested-secure-${ACCOUNT_ID}"

# Resources the stack owns.
CHILD_STAGE_PARAM="cdkd-nested-child-stage-${ACCOUNT_ID}"
CHILD_SECURE_PARAM="cdkd-nested-child-secure-${ACCOUNT_ID}"
CHILD_UNRELATED_PARAM="cdkd-nested-child-unrelated-${ACCOUNT_ID}"
PARENT_CONSUMER_PARAM="cdkd-nested-parent-consumer-${ACCOUNT_ID}"
PARENT_SUB_PARAM="cdkd-nested-parent-sub-${ACCOUNT_ID}"
PARENT_SUBPAIR_PARAM="cdkd-nested-parent-subpair-${ACCOUNT_ID}"

# The two secret plaintexts, and the expressions they must be persisted as.
# `prodstage2087` is deliberately UNUSUAL rather than a word like `production`:
# every wholesale "the plaintext appears nowhere" grep below would otherwise
# collide with ordinary text in the state file and pass or fail for the wrong
# reason.
SECRET_STAGE_VALUE="prodstage2087"
SECURE_PW_VALUE="securepw2086"
STAGE_EXPR="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:stage::}}"
# The #2270 round-3 SHARED pair. A DIFFERENT JSON key from `stage`, so a
# different plaintext: sharing `stage` would drag `StageParam` into the same
# collapse, which is exactly how the first cut of this arm broke the #1903
# assertion below. Two spellings that resolve IDENTICALLY, because
# `resolveDynamicReferences` defaults an empty version-stage to `AWSCURRENT` --
# issue #2059's rotating-secret shape made deterministic. Neither expression is
# a substring of the other (one ends `shared::}}`, the other
# `shared:AWSCURRENT:}}`), so an assertion naming one cannot be satisfied by the
# other.
SHARED_PW_VALUE="sharedpw2270"
SHARED_EXPR_A="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:shared::}}"
SHARED_EXPR_B="{{resolve:secretsmanager:${SECRET_NAME}:SecretString:shared:AWSCURRENT:}}"
SECURE_EXPR="{{resolve:ssm:${SECURE_PARAM_NAME}}}"
# The #2087 discriminator's literal, kept in sync with the fixture stack. It
# CONTAINS `SECRET_STAGE_VALUE`, which is the whole point: a non-overlapping
# literal cannot see the defect.
UNRELATED_LITERAL="cdkd-bucket-prodstage2087-logs"

# The #2270 arm's NON-secret child output, kept in sync with the fixture stack,
# plus the string the parent's `Fn::Sub` must produce from it and the literal
# placeholder a pre-fix cdkd shipped instead. `plainout2270` shares no substring
# with either secret plaintext or with any parameter name in this fixture, so
# no other grep here can hit it and no assertion of this arm can pass for a
# reason belonging to another one.
CHILD_PLAIN_OUTPUT_VALUE="plainout2270"
PARENT_SUB_EXPECTED="sub-${CHILD_PLAIN_OUTPUT_VALUE}-end"
# shellcheck disable=SC2016  # the ${...} here is CloudFormation's, not the shell's
PARENT_SUB_PLACEHOLDER='sub-${Child.Outputs.ChildPlainOutput}-end'

# ASSERTED, not merely commented. The literal is triplicated -- here, in the
# assertion below, and in lib/nested-stack-secret-stack.ts -- and kept in sync
# only by prose. If it drifts, `UnrelatedParam` stops overlapping the needle and
# the whole #2087 arm passes VACUOUSLY: a non-overlapping literal is left alone
# by `redactSecretsForState` under the correct AND the defective design, so the
# assertion could never go red. Same reason `SECRET_STAGE_VALUE` is unusual
# rather than a word like `production`.
case "${UNRELATED_LITERAL}" in
  *"${SECRET_STAGE_VALUE}"*) ;;
  *)
    echo "FAIL: the #2087 discriminator no longer overlaps the secret plaintext" >&2
    echo "      UNRELATED_LITERAL must CONTAIN SECRET_STAGE_VALUE, or the arm is vacuous" >&2
    exit 1
    ;;
esac

# The MIRROR of the check above, for the #2270 arms. That one needs an overlap;
# these need the OPPOSITE -- a literal of theirs that collided with a secret
# plaintext, with the #2087 literal, OR WITH EACH OTHER would make an assertion
# pass or fail for a reason belonging to a different arm, and the wholesale "no
# plaintext in state" greps would start reporting a leak that is not one.
#
# The one property this most concretely protects, because its violation is what
# broke this fixture's first real-AWS run: `SHARED_PW_VALUE` must not equal (or
# contain, or be contained by) `SECRET_STAGE_VALUE`. Giving the round-3 arm its
# own secret JSON key is what puts `StageParam` back to being the ONLY leaf
# carrying its plaintext; the moment the two coincide, the #1903 assertion below
# starts failing again for exactly the reason that split exists to remove.
#
# ITERATED BY VARIABLE NAME, not by value, and that is the whole correctness of
# the self-comparison guard: skipping when the two VALUES are equal would skip
# precisely the case this exists to catch (two literals that have become
# identical), so the guard tests the NAMES and the comparison tests the values.
# The pre-existing three are inner-only -- `UNRELATED_LITERAL` legitimately
# CONTAINS `SECRET_STAGE_VALUE`, which the #2087 assertion above requires, so
# they must never be compared against each other.
CDKD_2270_LITERALS="CHILD_PLAIN_OUTPUT_VALUE SHARED_PW_VALUE"
CDKD_ALL_LITERALS="SECRET_STAGE_VALUE SECURE_PW_VALUE UNRELATED_LITERAL ${CDKD_2270_LITERALS}"
for mine_name in ${CDKD_2270_LITERALS}; do
  mine="${!mine_name}"
  for needle_name in ${CDKD_ALL_LITERALS}; do
    [ "${mine_name}" = "${needle_name}" ] && continue
    needle="${!needle_name}"
    case "${needle}" in
      *"${mine}"*)
        echo "FAIL: ${needle_name} contains ${mine_name} -- the two literals collide" >&2
        exit 1
        ;;
    esac
    case "${mine}" in
      *"${needle}"*)
        echo "FAIL: ${mine_name} contains ${needle_name} -- the two literals collide" >&2
        exit 1
        ;;
    esac
  done
done

mask() {
  local v="$1"
  if [ -z "${v}" ]; then echo "<empty>"; return; fi
  echo "$(printf '%s' "${v}" | cut -c1-2)***(len=${#v})"
}

# Echo captured output as diagnostics, but never before proving it carries no
# plaintext: these paths exist to DETECT a redaction bug, so an unchecked echo
# prints the secret at the exact moment redaction failed.
diag_output() {
  local text="$1"
  # BOTH plaintexts. Withholding only SECURE_PW_VALUE echoed SECRET_STAGE_VALUE
  # to stderr on the diff-failure path -- the exact disclosure this function
  # exists to prevent, in the one place it is most likely to have happened.
  if printf '%s' "${text}" | grep -qE "${SECRET_STAGE_VALUE}|${SECURE_PW_VALUE}"; then
    echo "      output: <WITHHELD - it carries a resolved secret, which is itself the bug>" >&2
    return 0
  fi
  echo "      output: ${text}" >&2
}

assert_eq() { # assert_eq <what> <actual> <expected>
  if [ "$2" != "$3" ]; then
    echo "FAIL: $1" >&2
    echo "      expected: $(mask "$3")" >&2
    echo "      actual:   $(mask "$2")" >&2
    exit 1
  fi
  echo "    OK: $1"
}

# The WHOLESALE plaintext scan of the CHILD record, as a function because it
# must run after EVERY deploy: a re-deploy that re-persisted the plaintext at
# some OTHER leaf (an attribute, an output, a nested-stack row) satisfies the
# per-row asserts and still ships the secret.
assert_child_state_carries_no_plaintext() { # $1 = label, $2 = child state json
  local label="$1" state="$2" scan
  # `UnrelatedParam` is REMOVED first: its literal legitimately contains
  # `SECRET_STAGE_VALUE` and has its own exact assertion, so leaving it in would
  # make this grep fail on the CORRECT behaviour.
  scan="$(printf '%s' "${state}" | jq 'del(.resources.UnrelatedParam)')"
  if printf '%s' "${scan}" | grep -qF "${SECRET_STAGE_VALUE}"; then
    echo "FAIL: ${label}: the child's state.json carries the resolved secretsmanager plaintext" >&2
    exit 1
  fi
  if printf '%s' "${scan}" | grep -qF "${SECURE_PW_VALUE}"; then
    echo "FAIL: ${label}: the child's state.json carries the resolved SecureString plaintext" >&2
    exit 1
  fi
  # The #2270 round-3 pair resolves inside the CHILD, so its plaintext must be
  # absent from the child's record too -- the outputs are persisted redacted.
  if printf '%s' "${scan}" | grep -qF "${SHARED_PW_VALUE}"; then
    echo "FAIL: ${label}: the child's state.json carries the resolved shared plaintext" >&2
    exit 1
  fi
  echo "    OK: ${label}: no resolved plaintext anywhere else in the child's state.json"
}

scan_verbose_output() { # scan_verbose_output <label> <text>
  local label="$1" text="$2"
  # SENTINEL FIRST. A grep that matches nothing is indistinguishable from "the
  # line was masked", so prove the verbose stream carried the parameter lines at
  # all before concluding anything from their absence of plaintext. The two
  # markers are independent of the masking: `--verbose` prints them whatever the
  # value renders as.
  if ! printf '%s' "${text}" | grep -q 'Resolved Ref to parameter'; then
    echo "FAIL: ${label}: no 'Resolved Ref to parameter' line in the --verbose output" >&2
    echo "      the log format drifted, so the plaintext scan below proves nothing" >&2
    exit 1
  fi
  if ! printf '%s' "${text}" | grep -q 'using user-provided value'; then
    echo "FAIL: ${label}: no 'using user-provided value' line in the --verbose output" >&2
    echo "      the log format drifted, so the plaintext scan below proves nothing" >&2
    exit 1
  fi
  if printf '%s' "${text}" | grep -qE "${SECRET_STAGE_VALUE}|${SECURE_PW_VALUE}|${SHARED_PW_VALUE}"; then
    echo "FAIL: ${label}: --verbose printed a resolved secret plaintext" >&2
    exit 1
  fi
  echo "    OK: ${label}: the parameter debug lines are present and carry no plaintext"
}

# ONE cleanup handler. A second `trap ... EXIT` would silently REPLACE this one
# (bash traps do not chain) and disarm the AWS teardown, so any extra teardown
# belongs INSIDE this function.
cleanup() {
  (
    set +eu
    echo "==> Cleanup: dropping leftover state + AWS resources"
    if [ -f "${LOCAL_DIST}" ]; then
      node "${LOCAL_DIST}" destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --force >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${CHILD_STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
      node "${LOCAL_DIST}" state destroy "${STACK}" \
        --state-bucket "${STATE_BUCKET:-}" --region "${REGION}" --yes >/dev/null 2>&1
    fi
    # Best-effort deletes in case a destroy left something standing. The two
    # out-of-band resources are cdkd's responsibility NOWHERE, so this sweep is
    # the only thing that keeps them from being orphans.
    for p in "${CHILD_STAGE_PARAM}" "${CHILD_SECURE_PARAM}" "${CHILD_UNRELATED_PARAM}" \
             "${PARENT_CONSUMER_PARAM}" "${PARENT_SUB_PARAM}" \
             "${PARENT_SUBPAIR_PARAM}" "${SECURE_PARAM_NAME}"; do
      aws ssm delete-parameter --name "${p}" --region "${REGION}" >/dev/null 2>&1
    done
    aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1
    if [ -n "${STATE_BUCKET:-}" ]; then
      # NONCURRENT-only from here: this same function runs from the pre-run
      # sweep and from the failure / INT / TERM traps, where a live state.json
      # may be the only record of resources still standing. The success path
      # below does the full sweep once destroy has been asserted.
      s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX:-}" noncurrent
      s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX:-}" noncurrent
    fi
  )
}

# `trap cleanup EXIT INT TERM` is NOT equivalent and must never be used: a bash
# signal handler returns to the interrupted point, so the script would resume
# the interrupted phase and could exit 0 while resources leak. The `(exit N)`
# seed is load-bearing too -- inside a handler `$?` is the interrupted
# command's status, so a cleanup opening with `rc=$?` would see 0.
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

echo "=== nested-stack secret flow integ (#1903 / #2055 / #2086 / #2087) ==="
echo "Stack:        ${STACK}"
echo "Child stack:  ${CHILD_STACK}"
echo "Region:       ${REGION}"
echo "State bucket: ${STATE_BUCKET}"

echo "==> Installing fixture deps"
if [ ! -d node_modules ]; then
  pnpm install --ignore-workspace --prefer-offline
fi

echo "==> Pre-run cleanup"
cleanup

# --- Out-of-band secret + SecureString parameter ---------------------------
echo "==> Creating the secretsmanager secret and the SecureString SSM parameter out of band"
aws secretsmanager create-secret --name "${SECRET_NAME}" \
  --secret-string "{\"stage\":\"${SECRET_STAGE_VALUE}\",\"shared\":\"${SHARED_PW_VALUE}\"}" \
  --region "${REGION}" >/dev/null
aws ssm put-parameter --name "${SECURE_PARAM_NAME}" --type SecureString \
  --value "${SECURE_PW_VALUE}" --overwrite --region "${REGION}" >/dev/null

# Fail loudly if AWS did not actually store a SecureString: every assertion
# about the #1901 type-based classification would otherwise pass vacuously
# against a plain String parameter, which is the OPPOSITE of what is tested.
SECURE_TYPE=$(aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Type' --output text)
assert_eq "the out-of-band parameter is a SecureString" "${SECURE_TYPE}" "SecureString"

# --- Phase 1: deploy --------------------------------------------------------
# `--verbose` ON PURPOSE, and captured. The CHILD engine is the only place in
# cdkd where `context.parameters` holds DECRYPTED plaintext -- the PARENT
# resolves the child's `Parameters` block -- and the resolver's two parameter
# debug lines print a parameter VALUE. `stringifyParameterForLog` redacts only
# on the template author's `NoEcho`, which the CDK-synthesized `CfnParameter`s
# in lib/nested-stack-secret-stack.ts deliberately do NOT set: adding it would
# redact the line unconditionally and this assertion could no longer tell a
# masked line from a declared-sensitive one. The masking under test comes from
# `context.inheritedSecrets` instead.
echo "==> Phase 1: deploy (--verbose, output scanned for plaintext)"
set +e
DEPLOY_OUT="$(node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1)"
DEPLOY_RC=$?
set -e
if [ "${DEPLOY_RC}" -ne 0 ]; then
  echo "FAIL: phase 1 deploy exited ${DEPLOY_RC}" >&2
  diag_output "${DEPLOY_OUT}"
  exit 1
fi
scan_verbose_output "phase 1 deploy" "${DEPLOY_OUT}"

CHILD_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_KEY}" - --region "${REGION}")"
PARENT_STATE="$(aws s3 cp "s3://${STATE_BUCKET}/${PARENT_KEY}" - --region "${REGION}")"

jq_state() { # jq_state <state-json> <filter>
  printf '%s' "$1" | jq -r "$2"
}

# --- #1903: the CHILD's state holds the EXPRESSION, not the plaintext -------
echo "==> #1903: child state persists the expression, AWS holds the concrete value"
assert_eq "child StageParam persists the secretsmanager EXPRESSION" \
  "$(jq_state "${CHILD_STATE}" '.resources.StageParam.properties.Value')" "${STAGE_EXPR}"
assert_eq "child SecureParam persists the SecureString EXPRESSION" \
  "$(jq_state "${CHILD_STATE}" '.resources.SecureParam.properties.Value')" "${SECURE_EXPR}"

LIVE_STAGE=$(aws ssm get-parameter --name "${CHILD_STAGE_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
assert_eq "the LIVE child stage parameter holds the resolved secret" "${LIVE_STAGE}" "${SECRET_STAGE_VALUE}"
LIVE_SECURE=$(aws ssm get-parameter --name "${CHILD_SECURE_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
assert_eq "the LIVE child SecureString consumer holds the resolved secret" "${LIVE_SECURE}" "${SECURE_PW_VALUE}"

# --- #2087: the unrelated literal survives VERBATIM -------------------------
echo "==> #2087: an unrelated literal containing the plaintext is not rewritten"
assert_eq "child UnrelatedParam persists its literal VERBATIM" \
  "$(jq_state "${CHILD_STATE}" '.resources.UnrelatedParam.properties.Value')" "${UNRELATED_LITERAL}"

# --- No plaintext anywhere else in the child's record -----------------------
assert_child_state_carries_no_plaintext "after the first deploy" "${CHILD_STATE}"

# --- #2055: the parent's consumer gets the RESOLVED value on AWS ------------
echo "==> #2055: the child's redacted output is re-resolved before it reaches AWS"
assert_eq "the child's persisted OUTPUT is the expression" \
  "$(jq_state "${CHILD_STATE}" '.outputs.ChildSecretOutput')" "${STAGE_EXPR}"
LIVE_PARENT=$(aws ssm get-parameter --name "${PARENT_CONSUMER_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
assert_eq "the LIVE parent consumer holds the RESOLVED secret, not the token" \
  "${LIVE_PARENT}" "${SECRET_STAGE_VALUE}"
assert_eq "the parent consumer's own state holds the EXPRESSION" \
  "$(jq_state "${PARENT_STATE}" '.resources.ParentConsumer.properties.Value')" "${STAGE_EXPR}"
assert_eq "the parent's nested-stack row keeps the input parameter as its EXPRESSION" \
  "$(jq_state "${PARENT_STATE}" '.resources.Child.properties.Parameters.SecretStage')" "${STAGE_EXPR}"

# --- #2270: the Fn::Sub spelling of the same read reaches AWS RESOLVED -------
# The assertion is on the LIVE parameter, and that is the point: a fix that
# resolved at persist time but not on the wire would pass a state-only check.
# SSM accepts any string, so a pre-fix cdkd created this parameter holding the
# placeholder TEXT and still exited 0 -- the value is the only witness.
echo "==> #2270: an Fn::Sub over a child output resolves instead of shipping the placeholder"
assert_eq "the child's persisted NON-secret output is the plain value" \
  "$(jq_state "${CHILD_STATE}" '.outputs.ChildPlainOutput')" "${CHILD_PLAIN_OUTPUT_VALUE}"
LIVE_PARENT_SUB=$(aws ssm get-parameter --name "${PARENT_SUB_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
# The named-defect test runs BEFORE the equality one, and the order is the whole
# reason it exists: `assert_eq` exits on any mismatch, so placing this after it
# would make this branch DEAD -- reachable only when the two values are already
# equal. First name the ONE value the pre-fix binary produced, then let the
# equality assert catch everything else. The value is echoed unmasked, unlike
# `assert_eq`'s, because this arm reads a NON-secret output by construction; if
# it is ever re-pointed at `ChildSecretOutput`, mask it.
if [ "${LIVE_PARENT_SUB}" = "${PARENT_SUB_PLACEHOLDER}" ]; then
  echo "FAIL: the LIVE Fn::Sub consumer holds the UNRESOLVED placeholder (issue #2270)" >&2
  echo "      value: ${LIVE_PARENT_SUB}" >&2
  exit 1
fi
assert_eq "the LIVE Fn::Sub consumer holds the RESOLVED child output" \
  "${LIVE_PARENT_SUB}" "${PARENT_SUB_EXPECTED}"
assert_eq "the Fn::Sub consumer's own state holds the resolved value too" \
  "$(jq_state "${PARENT_STATE}" '.resources.SubConsumer.properties.Value')" "${PARENT_SUB_EXPECTED}"

# --- #2270 round 3: the collapse the round-2 fix CREATED ---------------------
# `SubConsumer` above reads a NON-secret output, so it is blind to this. Once
# `${Child.Outputs.X}` resolves, a SECRET-bearing one needs POSITIONING and had
# none: `crossStackSourceKey` refused every `Fn::Sub` and `intrinsicSkeletonPattern`
# cannot cross a `{{resolve:...}}` token's `}}`, so the leaves fell to the
# plaintext-keyed value scan. That scan collapses two references resolving to
# ONE plaintext onto whichever expression was recorded last, and
# `resolveReplayProps` applies the WRONG one to the live resource on rollback /
# `cdkd drift --revert`.
#
# BOTH LEAVES ARE ONE RESOURCE'S: `SubSecretPair`'s Value and its Description.
# `perResourceSecrets` is keyed by logical id, so two separate resources would
# get two separate bags, each holding a single pair, and would redact correctly
# WITH OR WITHOUT the fix -- the arm would prove nothing. One resource is the
# only shape in which positioning decides the answer.
echo "==> #2270 round 3: two Fn::Sub secret leaves of ONE resource keep their OWN expressions"

# The collapse PREMISE, asserted rather than assumed: both live leaves must hold
# the SAME plaintext. If they differed, the value scan could tell them apart and
# the whole arm would pass vacuously.
LIVE_SUBPAIR_VALUE=$(aws ssm get-parameter --name "${PARENT_SUBPAIR_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
LIVE_SUBPAIR_DESC=$(aws ssm describe-parameters --region "${REGION}" \
  --parameter-filters "Key=Name,Values=${PARENT_SUBPAIR_PARAM}" \
  --query 'Parameters[0].Description' --output text)
assert_eq "the LIVE Fn::Sub Value holds the resolved shared secret" \
  "${LIVE_SUBPAIR_VALUE}" "${SHARED_PW_VALUE}"
assert_eq "the LIVE Fn::Sub Description holds the SAME resolved shared secret" \
  "${LIVE_SUBPAIR_DESC}" "${SHARED_PW_VALUE}"

# THE DISCRIMINATOR: each persisted leaf back on ITS OWN expression. Under the
# collapse both carry the SURVIVOR's, so whichever lost reads as the other.
SUBPAIR_VALUE_STATE="$(jq_state "${PARENT_STATE}" '.resources.SubSecretPair.properties.Value')"
SUBPAIR_DESC_STATE="$(jq_state "${PARENT_STATE}" '.resources.SubSecretPair.properties.Description')"
assert_eq "SubSecretPair.Value persists the DEFAULT-stage expression" \
  "${SUBPAIR_VALUE_STATE}" "${SHARED_EXPR_A}"
assert_eq "SubSecretPair.Description persists the AWSCURRENT-spelled expression" \
  "${SUBPAIR_DESC_STATE}" "${SHARED_EXPR_B}"
if [ "${SUBPAIR_VALUE_STATE}" = "${SUBPAIR_DESC_STATE}" ]; then
  echo "FAIL: both Fn::Sub secret leaves persisted the SAME expression (collapse, issue #2270)" >&2
  exit 1
fi

# READ THE TWO COUNTS AS A PAIR. "no plaintext" alone is satisfied by an arm
# that did nothing at all -- if the resource were missing, or its leaves empty,
# the plaintext count is zero for the wrong reason. Requiring the expressions to
# be PRESENT is what makes the absence mean something.
SUBPAIR_PLAINTEXT_HITS=$(printf '%s' "${SUBPAIR_VALUE_STATE}${SUBPAIR_DESC_STATE}" \
  | grep -c "${SHARED_PW_VALUE}" || true)
SUBPAIR_EXPR_HITS=0
case "${SUBPAIR_VALUE_STATE}" in *"{{resolve:secretsmanager:"*) SUBPAIR_EXPR_HITS=$(( SUBPAIR_EXPR_HITS + 1 ));; esac
case "${SUBPAIR_DESC_STATE}" in *"{{resolve:secretsmanager:"*) SUBPAIR_EXPR_HITS=$(( SUBPAIR_EXPR_HITS + 1 ));; esac
if [ "${SUBPAIR_PLAINTEXT_HITS}" -ne 0 ] || [ "${SUBPAIR_EXPR_HITS}" -ne 2 ]; then
  echo "FAIL: expected 0 plaintext hits AND 2 expression hits across SubSecretPair's two leaves" >&2
  echo "      plaintext hits: ${SUBPAIR_PLAINTEXT_HITS}, expression hits: ${SUBPAIR_EXPR_HITS}" >&2
  exit 1
fi
echo "    OK: 0 plaintext / 2 expressions, each leaf on its own"

# The CHILD's two shared outputs must themselves be redacted and DISTINCT: the
# parent's positioning can only be right if the producer kept them apart. These
# are LITERAL tokens the child resolves itself, so the child's own position pass
# certifies each against its own whole-token source -- which is precisely why
# the pair is NOT routed through the child's `Parameters` (a plaintext-keyed
# inherited bag collapses two expressions before the child ever runs).
assert_eq "the child's shared output A is its own expression" \
  "$(jq_state "${CHILD_STATE}" '.outputs.ChildSharedOutputA')" "${SHARED_EXPR_A}"
assert_eq "the child's shared output B is its own expression" \
  "$(jq_state "${CHILD_STATE}" '.outputs.ChildSharedOutputB')" "${SHARED_EXPR_B}"

if printf '%s' "${PARENT_STATE}" | grep -qE "${SECRET_STAGE_VALUE}|${SECURE_PW_VALUE}|${SHARED_PW_VALUE}"; then
  echo "FAIL: the parent's state.json carries a resolved secret plaintext" >&2
  exit 1
fi
echo "    OK: no resolved plaintext in the parent's state.json"

# --- Phase 2: the perpetual-UPDATE class, checked by EXIT CODE --------------
# This is the half that a text grep cannot answer. Both #1903 and #2087 turn
# into a change that never converges when they are wrong: the desired side and
# the persisted side disagree at a leaf on every run.
echo "==> Phase 2: a freshly-deployed tree reports NO change"
set +e
DIFF_OUT="$(node "${LOCAL_DIST}" diff "${STACK}" --recursive --fail \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DIFF_RC=$?
set -e
if [ "${DIFF_RC}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --recursive --fail' exited ${DIFF_RC} on an unchanged tree (expected 0)" >&2
  diag_output "${DIFF_OUT}"
  exit 1
fi
echo "    OK: cdkd diff --recursive --fail exited 0"
if printf '%s' "${DIFF_OUT}" | grep -qE "${SECRET_STAGE_VALUE}|${SECURE_PW_VALUE}|${SHARED_PW_VALUE}"; then
  echo "FAIL: the diff output printed a resolved secret plaintext" >&2
  exit 1
fi
echo "    OK: the diff printed no resolved plaintext"

echo "==> Phase 2b: a second deploy is a no-op and does not rewrite the redaction"
node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --yes

CHILD_STATE2="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_KEY}" - --region "${REGION}")"
assert_eq "child StageParam is STILL the expression after a second deploy" \
  "$(jq_state "${CHILD_STATE2}" '.resources.StageParam.properties.Value')" "${STAGE_EXPR}"
assert_eq "child UnrelatedParam is STILL verbatim after a second deploy" \
  "$(jq_state "${CHILD_STATE2}" '.resources.UnrelatedParam.properties.Value')" "${UNRELATED_LITERAL}"
assert_child_state_carries_no_plaintext "after the second deploy" "${CHILD_STATE2}"

set +e
DIFF_OUT2="$(node "${LOCAL_DIST}" diff "${STACK}" --recursive --fail \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DIFF_RC2=$?
set -e
if [ "${DIFF_RC2}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --recursive --fail' exited ${DIFF_RC2} after the second deploy (expected 0)" >&2
  diag_output "${DIFF_OUT2}"
  exit 1
fi
echo "    OK: still no change after a second deploy"

# --- Phase 2c: the UPDATE arm (NestedStackProvider.update) ------------------
# THE ARM #1903's OWN COMMENT NAMES and this fixture could not previously reach:
# "a nested stack that already exists silently keeps persisting the parent's
# plaintext". Phases 1-2b only ever exercise `NestedStackProvider.create` and a
# no-op, so the deploy engine's UPDATE call site -- the one that binds the
# secrets scope the provider seeds the child engine from -- never ran here at
# all. Deleting that binding left the whole suite AND this fixture green.
#
# `CDKD_TEST_UPDATE=child-property` changes the child's `StageParam`
# DESCRIPTION, which (a) makes the child's own resource an UPDATE and (b) moves
# the nested template's asset hash, so the parent's `Child` row changes and the
# parent provisions it through `NestedStackProvider.update`.
echo "==> Phase 2c: a genuine CHILD change drives NestedStackProvider.update"
CHILD_STAGE_DESC_UPDATED="cdkd nested-stack-secret integ - child consumer of the secretsmanager parameter (updated)"
set +e
UPDATE_OUT="$(CDKD_TEST_UPDATE=child-property node "${LOCAL_DIST}" deploy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --region "${REGION}" \
  --verbose \
  --yes 2>&1)"
UPDATE_RC=$?
set -e
if [ "${UPDATE_RC}" -ne 0 ]; then
  echo "FAIL: phase 2c deploy exited ${UPDATE_RC}" >&2
  diag_output "${UPDATE_OUT}"
  exit 1
fi

# PROOF THE ARM ACTUALLY RAN, from AWS rather than from the log: if the parent
# had treated `Child` as NO_CHANGE, the child engine would never have run and
# this description would still be the phase-1 one. Everything below would then
# pass VACUOUSLY -- an untouched state.json is trivially still redacted.
LIVE_STAGE_DESC=$(aws ssm describe-parameters --region "${REGION}" \
  --parameter-filters "Key=Name,Values=${CHILD_STAGE_PARAM}" \
  --query 'Parameters[0].Description' --output text)
assert_eq "the child's StageParam description was UPDATED (so the update arm ran)" \
  "${LIVE_STAGE_DESC}" "${CHILD_STAGE_DESC_UPDATED}"

# The log SENTINEL, checked only after AWS has already confirmed the update.
# Ordered this way on purpose: a grep that matches nothing cannot distinguish
# "the arm did not run" from "the log wording drifted", and AWS has just settled
# the first. So a miss here is a DRIFT report, not a silent pass.
if ! printf '%s' "${UPDATE_OUT}" | grep -q "Updating nested stack ${CHILD_STACK}"; then
  echo "FAIL: AWS shows the child WAS updated, but the deploy log has no" >&2
  echo "      'Updating nested stack ${CHILD_STACK}' line -- NestedStackProvider's" >&2
  echo "      wording drifted, so this fixture can no longer see which arm ran" >&2
  exit 1
fi
echo "    OK: the parent provisioned Child through NestedStackProvider.update"

scan_verbose_output "phase 2c deploy" "${UPDATE_OUT}"

CHILD_STATE3="$(aws s3 cp "s3://${STATE_BUCKET}/${CHILD_KEY}" - --region "${REGION}")"
PARENT_STATE3="$(aws s3 cp "s3://${STATE_BUCKET}/${PARENT_KEY}" - --region "${REGION}")"
# THE ASSERTION THE UPDATE ARM EXISTS FOR. `StageParam` was genuinely rewritten
# by this deploy, so an unbound secrets scope would have re-persisted the
# DECRYPTED value here with nothing recorded to redact it back to.
assert_eq "child StageParam is the EXPRESSION after an UPDATE-driven redeploy" \
  "$(jq_state "${CHILD_STATE3}" '.resources.StageParam.properties.Value')" "${STAGE_EXPR}"
assert_eq "child SecureParam is the EXPRESSION after an UPDATE-driven redeploy" \
  "$(jq_state "${CHILD_STATE3}" '.resources.SecureParam.properties.Value')" "${SECURE_EXPR}"
assert_eq "child UnrelatedParam is STILL verbatim after an UPDATE-driven redeploy" \
  "$(jq_state "${CHILD_STATE3}" '.resources.UnrelatedParam.properties.Value')" "${UNRELATED_LITERAL}"
assert_child_state_carries_no_plaintext "after the UPDATE-driven redeploy" "${CHILD_STATE3}"
if printf '%s' "${PARENT_STATE3}" | grep -qE "${SECRET_STAGE_VALUE}|${SECURE_PW_VALUE}|${SHARED_PW_VALUE}"; then
  echo "FAIL: the parent's state.json carries a resolved secret plaintext after the update" >&2
  exit 1
fi
echo "    OK: no resolved plaintext in the parent's state.json after the update"

# ...and the live values are untouched by the description change.
LIVE_STAGE3=$(aws ssm get-parameter --name "${CHILD_STAGE_PARAM}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)
assert_eq "the LIVE child stage parameter still holds the resolved secret" \
  "${LIVE_STAGE3}" "${SECRET_STAGE_VALUE}"

set +e
DIFF_OUT3="$(CDKD_TEST_UPDATE=child-property node "${LOCAL_DIST}" diff "${STACK}" --recursive --fail \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" 2>&1)"
DIFF_RC3=$?
set -e
if [ "${DIFF_RC3}" -ne 0 ]; then
  echo "FAIL: 'cdkd diff --recursive --fail' exited ${DIFF_RC3} after the update (expected 0)" >&2
  diag_output "${DIFF_OUT3}"
  exit 1
fi
echo "    OK: the updated tree also converges"

# --- Phase 3: destroy -------------------------------------------------------
echo "==> Phase 3: destroy"
node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --region "${REGION}" --force

for p in "${CHILD_STAGE_PARAM}" "${CHILD_SECURE_PARAM}" "${CHILD_UNRELATED_PARAM}" \
         "${PARENT_CONSUMER_PARAM}" "${PARENT_SUB_PARAM}" "${PARENT_SUBPAIR_PARAM}"; do
  assert_gone "SSM parameter '${p}' still exists after destroy" \
    aws ssm get-parameter --name "${p}" --region "${REGION}"
done
echo "    OK: all six stack-owned SSM parameters are gone"

# The out-of-band pair is NOT in the stack, so destroy must have left it alone
# -- deleting a resource cdkd does not manage would be the real failure. Then
# remove both here and prove they are gone, so the run ends with no orphan (the
# cleanup trap is a backstop, not the proof).
if gone_probe aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"; then
  echo "FAIL: destroy deleted the out-of-band SecureString parameter '${SECURE_PARAM_NAME}'" >&2
  exit 1
fi
if gone_probe aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"; then
  echo "FAIL: destroy deleted the out-of-band secret '${SECRET_NAME}'" >&2
  exit 1
fi
# `describe-secret` SUCCEEDS for a secret that is merely SCHEDULED for deletion,
# so "the probe did not report not-found" does not discriminate on its own: a
# destroy that called DeleteSecret without force would pass the check above
# while having removed the resource for every practical purpose. `DeletedDate`
# is what separates the two.
SECRET_DELETED_DATE=$(aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" \
  --region "${REGION}" --query 'DeletedDate' --output text)
assert_eq "the out-of-band secret is not SCHEDULED for deletion either" \
  "${SECRET_DELETED_DATE}" "None"
echo "    OK: destroy left both unmanaged out-of-band resources intact"

aws ssm delete-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}" >/dev/null
assert_gone_eventually 60 "out-of-band SecureString parameter '${SECURE_PARAM_NAME}' still exists after its explicit delete" \
  aws ssm get-parameter --name "${SECURE_PARAM_NAME}" --region "${REGION}"
aws secretsmanager delete-secret --secret-id "${SECRET_NAME}" \
  --force-delete-without-recovery --region "${REGION}" >/dev/null
assert_gone_eventually 60 "out-of-band secret '${SECRET_NAME}' still exists after its force-delete" \
  aws secretsmanager describe-secret --secret-id "${SECRET_NAME}" --region "${REGION}"
echo "    OK: both out-of-band resources removed"

assert_gone "parent state file s3://${STATE_BUCKET}/${PARENT_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${PARENT_KEY}"
assert_gone "child state file s3://${STATE_BUCKET}/${CHILD_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${CHILD_KEY}"
echo "    OK: both state files are gone"

# --- Teardown + VERSION sweep, ON THE SUCCESS PATH --------------------------
# "state file is gone" above is a head-object on the CURRENT object, and the
# bucket is VERSIONED -- so without this the earlier versions of the child's
# state.json would stay readable via GetObjectVersion (issue #2096). That is
# exactly the wrong thing to leave behind for a fixture about secret redaction.
echo "==> Final teardown + state-version sweep"
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${PARENT_PREFIX}" all || true
s3_purge_prefix_versions "${STATE_BUCKET}" "${CHILD_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${PARENT_PREFIX}" "nested-stack-secret parent state teardown"
s3_assert_versions_swept "${STATE_BUCKET}" "${CHILD_PREFIX}" "nested-stack-secret child state teardown"

echo ""
echo "[verify] PASS - nested-stack secret flow redacted in both directions, scoped per resource, redacted on the CREATE and the UPDATE arm, never printed at --verbose, no change on re-deploy, clean destroy with zero surviving state versions"
