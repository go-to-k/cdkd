#!/usr/bin/env bash
#
# `cdkd import` must persist the `observedProperties` baseline of a
# secret-bearing property as the `{{resolve:...}}` EXPRESSION, never as the
# decrypted value (issue #2828).
#
# WHY THIS FIXTURE EXISTS. The unit suite around
# `captureObservedForImportedResources` mocks the provider, so it pins what
# `import.ts` DOES with a readback rather than what a real provider's
# `readCurrentState` RETURNS. The value that reaches the redaction in
# production is a live AWS bag whose shape those mocks assert nothing about.
#
# THE DIVERGENCE THIS RESTS ON, and the reason the fixture is honest:
# CloudFormation resolves `{{resolve:secretsmanager:...}}` AT DEPLOY, so the
# live SSM parameter holds the DECRYPTED value while the template keeps the
# token. `cdkd import` then re-resolves the template (fetching the secret),
# redacts `properties` back to the token, and captures a readback that really
# does contain the plaintext. If any of those three stopped happening the
# assertions below would pass while testing nothing, so PHASE 2 proves the
# premise -- the live parameter really holds the plaintext -- before PHASE 4
# reads the state file.
#
# The deploy is upstream `cdk deploy`, matching the advertised adoption
# scenario and matching `import-auto-mode`; `cdkd import` is run with NEITHER
# `--resource` NOR `--migrate-from-cloudformation`, so the physical id comes
# from the CloudFormation lookup rather than a short-circuit.
#
# A SECOND ARM (issue #2745, third site): a parameter whose `Value` EMBEDS a
# TWO-character reference in the L2 `Fn::Join` shape. Below the redaction value
# scan's needle floor only a span arm on a bag whose provenance is proven can
# persist the leaf as its token, and import's own resolution bag was never
# marked -- so `properties.Value` persisted `port:q7`. The framed plaintext is
# refused anywhere in `state.json`, and the leaf must hold the ARN-form
# expression exactly.

set -euo pipefail
cd "$(dirname "$0")"

# A pager on any `aws` call would block a non-interactive run forever.
export AWS_PAGER=""

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

. ../s3-versions.sh

STACK="CdkdImportSecretObservedExample"
REGION="${AWS_REGION:-us-east-1}"
STATE_KEY="cdkd/${STACK}/${REGION}/state.json"
STATE_PREFIX="cdkd/${STACK}/${REGION}/"
LOCAL_DIST="$(cd ../../../dist && pwd)/cli.js"

# The needle. MUST stay in sync with `SECRET_PLAINTEXT` in
# lib/import-secret-observed-stack.ts -- PHASE 2 fails loudly if it drifts,
# rather than letting a stale needle turn every leak assertion vacuous.
SECRET_PLAINTEXT='cdkd-integ-2828-DECRYPTED-NEEDLE'
# The two-character value and its framed form (issue #2745). MUST stay in sync
# with `SUB_FLOOR_PLAINTEXT` in the stack; PHASE 2 fails loudly if it drifts.
SUB_FLOOR_PLAINTEXT='q7'
SUB_FLOOR_FRAMED="port:${SUB_FLOOR_PLAINTEXT}"
# THE INVARIANT, not the instance: the value must sit BELOW the redaction value
# scan's four-character needle floor, or the scan alone would redact the leaf
# and the arm would pass with or without import's mark. A stack and script
# edited together to a longer value would keep every equality below green.
case "${#SUB_FLOOR_PLAINTEXT}" in
  1|2|3) ;;
  *) echo "FAIL: premise: SUB_FLOOR_PLAINTEXT must be 1-3 characters (got ${#SUB_FLOOR_PLAINTEXT}) -- above the needle floor this arm proves nothing" >&2; exit 1 ;;
esac

# Bumped by each substantive assertion; floored at the end (see the floor).
ASSERTIONS_RUN=0

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET must be set" >&2
  exit 1
fi
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found -- run 'vp run build' first" >&2
  exit 1
fi

# Vendored cdk CLI (issue #1485): install the fixture's deps when absent
# (node_modules is gitignored and the repo-root pnpm install does NOT populate
# fixture dirs), otherwise the PATH prepend is inert and `npx cdk` falls
# through to a possibly stale global CLI whose cloud-assembly schema no longer
# matches the fixture's aws-cdk-lib.
if [ ! -d node_modules ]; then
  echo "==> installing fixture deps"
  npm install --silent
fi
export PATH="${PWD}/node_modules/.bin:${PATH}"

cleanup() {
  rc=$?
  set +eu
  echo "==> cleanup (rc=${rc})"

  # SCOPE GUARD. Everything below deletes what a `${STACK}`-filtered listing
  # returns, so an empty STACK would make the filters match everything. The
  # accepting arm comes first and the catch-all RETURNS (re-arming `set -eu`
  # first), so nothing can fall through into the sweeps.
  case "${STACK}" in
    CdkdImportSecretObserved?*) ;;
    *)
      echo "WARN: teardown sweep refused -- STACK='${STACK}' is outside this fixture's scope" >&2
      # RE-ARM before returning. This `return` skips the function's tail, where
      # the re-arm lives, so without this line the guard-rejection path would
      # leave the CALLER running with `set +eu` -- the very hole the tail re-arm
      # exists to close, reachable by the branch that is supposed to be the safe
      # one.
      set -eu
      return
      ;;
  esac

  AWS_REGION="${REGION}" node "${LOCAL_DIST}" state destroy "${STACK}" \
    --state-bucket "${STATE_BUCKET:-}" --yes >/dev/null 2>&1 || true

  npx cdk destroy "${STACK}" --force >/dev/null 2>&1 || true

  aws cloudformation delete-stack --stack-name "${STACK}" --region "${REGION}" >/dev/null 2>&1 || true

  # FORCE-DELETE THE SECRET. Only `cdkd destroy` force-deletes; `cdk destroy`
  # and `delete-stack` leave the secret in a 30-day RECOVERY WINDOW, so every
  # NON-SUCCESS path would otherwise leave this fixture's known plaintext
  # restorable. The ARN comes from the stack output while the stack still
  # exists, captured before teardown; if the stack is already gone the
  # name-prefix scan finds it. Deletion is async, but this is best-effort
  # teardown -- Phase 5's assertion is where the wait that MATTERS lives, and
  # duplicating it here would add an intermediate capture whose failure this
  # `set +eu` context could not propagate.
  if [ -n "${SECRET_ARN:-}" ]; then
    aws secretsmanager delete-secret --secret-id "${SECRET_ARN}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  fi
  for sid in $(aws secretsmanager list-secrets --region "${REGION}" \
      --include-planned-deletion \
      --query "SecretList[?contains(Name,'${STACK}') || contains(Name,'SecretA720EF05')].ARN" \
      --output text 2>/dev/null); do
    aws secretsmanager delete-secret --secret-id "${sid}" \
      --force-delete-without-recovery --region "${REGION}" >/dev/null 2>&1 || true
  done

  s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX:-}" noncurrent || true
  aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" >/dev/null 2>&1 || true
  aws s3api delete-object --bucket "${STATE_BUCKET}" \
    --key "cdkd/${STACK}/${REGION}/lock.json" >/dev/null 2>&1 || true

  # Lambda auto-creates log groups on invoke and neither CFn nor cdkd deletes
  # them. This fixture deploys no Lambda, but the sweep stays: a future arm that
  # adds one would otherwise leak silently.
  for lg in $(aws logs describe-log-groups \
      --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
      --query 'logGroups[].logGroupName' --output text 2>/dev/null); do
    aws logs delete-log-group --log-group-name "${lg}" --region "${REGION}" >/dev/null 2>&1 || true
  done

  rm -f "${IMPORT_LOG:-}" "${STATE_JSON_FILE:-}" "${LOG_PROBE:-}"

  # RE-ARM, and it must be the LAST line of this function rather than something
  # the call site does. `cleanup` runs `set +eu` at the top, and the pre-run
  # `cleanup || true` executes in the CURRENT shell -- so without this every
  # line after it runs with errexit and nounset OFF, and an assertion that exits
  # non-zero without an explicit `exit` is simply stepped over. Measured:
  # `c(){ rc=$?; set +eu; }; c || true; false; echo REACHED` prints REACHED.
  # At the call site a later `|| true` invocation would reopen the hole; here it
  # cannot. Matches `secrets-dynamic-ref`'s own re-arm.
  set -eu
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> pre-run cleanup"
cleanup || true

# ---------------------------------------------------------------------------
echo "==> Phase 1: deploy with upstream cdk deploy"
# ---------------------------------------------------------------------------
npx cdk deploy "${STACK}" --require-approval never

PARAM_NAME="$(aws cloudformation describe-stacks --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='ParameterName'].OutputValue" \
  --output text)"
if [ -z "${PARAM_NAME}" ] || [ "${PARAM_NAME}" = "None" ]; then
  echo "FAIL: could not read the ParameterName output" >&2
  exit 1
fi
SECRET_ARN="$(aws cloudformation describe-stacks --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='SecretArn'].OutputValue" \
  --output text)"
if [ -z "${SECRET_ARN}" ] || [ "${SECRET_ARN}" = "None" ]; then
  echo "FAIL: could not read the SecretArn output -- cleanup could not then" >&2
  echo "      force-delete the secret, leaving the needle recoverable." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # SecretArn captured (cleanup can force-delete)
SUB_FLOOR_PARAM_NAME="$(aws cloudformation describe-stacks --stack-name "${STACK}" \
  --region "${REGION}" \
  --query "Stacks[0].Outputs[?OutputKey=='SubFloorParameterName'].OutputValue" \
  --output text)"
if [ -z "${SUB_FLOOR_PARAM_NAME}" ] || [ "${SUB_FLOOR_PARAM_NAME}" = "None" ]; then
  echo "FAIL: could not read the SubFloorParameterName output" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # SubFloorParameterName captured
# The expression `cdkd import` must persist for the framed leaf: the L2 join
# resolves the secret's `Ref` to its ARN, so the token is the ARN-form,
# 6-field spelling with empty version stage / id.
EXPECTED_SUB_FLOOR_EXPR="port:{{resolve:secretsmanager:${SECRET_ARN}:SecretString:pin::}}"
# PREMISE: the sub-floor parameter's Value SYNTHESIZED as the L2 `Fn::Join`
# (empty delimiter; the prefix fused into the token's opening part; a `Ref` to
# the stack's secret INSIDE the token; the closing part ending the 6-field
# token). Folded to the literal expression it would exercise the LITERAL arm
# and pass the same persisted-equality assertion below while proving nothing
# about the intrinsic one. Read from the assembly `cdk deploy` just wrote.
SYNTH_TEMPLATE="cdk.out/${STACK}.template.json"
if [ ! -f "${SYNTH_TEMPLATE}" ]; then
  echo "FAIL: premise: no synthesized template at ${SYNTH_TEMPLATE} after cdk deploy" >&2
  exit 1
fi
SUB_FLOOR_SHAPE=$(jq -r '
  (.Resources | to_entries | map(select(.value.Type=="AWS::SecretsManager::Secret")) | map(.key)) as $secrets
  | [.Resources[] | select(.Type=="AWS::SSM::Parameter") | select(.Properties.Description == "cdkd integ 2745: Value embeds a two-character dynamic reference") | .Properties.Value] | first
  | if type=="object" and has("Fn::Join") and (.["Fn::Join"][0] == "") and ((.["Fn::Join"][1] | length) == 3)
       and (.["Fn::Join"][1][0] == "port:{{resolve:secretsmanager:")
       and ((.["Fn::Join"][1][1] | type) == "object" and (.["Fn::Join"][1][1] | has("Ref")) and (.["Fn::Join"][1][1].Ref | IN($secrets[])))
       and (.["Fn::Join"][1][2] == ":SecretString:pin::}}")
    then "l2-join" else (type) end' "${SYNTH_TEMPLATE}")
if [ "${SUB_FLOOR_SHAPE}" != "l2-join" ]; then
  echo "FAIL: premise: the sub-floor parameter's Value synthesized as a '${SUB_FLOOR_SHAPE}', not the L2 Fn::Join -- the intrinsic arm (#2745) is not what this import exercises" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # premise: the sub-floor leaf is the L2 Fn::Join
echo "==> Phase 1 ok: deployed, parameter=${PARAM_NAME}, sub-floor parameter=${SUB_FLOOR_PARAM_NAME}"

# ---------------------------------------------------------------------------
echo "==> Phase 2: PREMISE -- the live parameter really holds the PLAINTEXT"
# ---------------------------------------------------------------------------
# Without this the fixture is vacuous in the most dangerous way: if
# CloudFormation had NOT resolved the dynamic reference, AWS would hold the
# token, the readback would carry no plaintext, and every assertion in Phase 4
# would pass while the redaction was never exercised. That is the `0 leaks AND
# 0 masks` shape, and it is why the premise is asserted before the outcome.
LIVE_VALUE="$(aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${LIVE_VALUE}" != "${SECRET_PLAINTEXT}" ]; then
  echo "FAIL: the live parameter does not hold the expected plaintext." >&2
  echo "      This fixture's needle must match SECRET_PLAINTEXT in the stack;" >&2
  echo "      neither value is printed (got ${#LIVE_VALUE} characters, expected ${#SECRET_PLAINTEXT})." >&2
  exit 1
fi
echo "==> Phase 2 ok: AWS holds the decrypted value, the template holds the token"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # premise: live value is the plaintext
# The same premise for the framed leaf (issue #2745): the live parameter holds
# `port:q7`, so import's readback and its own resolution both carry the
# two-character value at that offset. Without this, an unresolved reference
# would leave nothing sub-floor to mishandle and the arm would pass vacuously.
# Neither side is printed on a mismatch: the expected value IS the framed
# plaintext.
SUB_FLOOR_LIVE="$(aws ssm get-parameter --name "${SUB_FLOOR_PARAM_NAME}" --region "${REGION}" \
  --query 'Parameter.Value' --output text)"
if [ "${SUB_FLOOR_LIVE}" != "${SUB_FLOOR_FRAMED}" ]; then
  echo "FAIL: the live sub-floor parameter does not hold the expected framed two-character value." >&2
  echo "      This fixture's SUB_FLOOR_PLAINTEXT must match the stack's; neither side is printed." >&2
  exit 1
fi
echo "==> Phase 2 ok: the sub-floor parameter holds the framed two-character value"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # premise: live sub-floor value is the framed plaintext

# ---------------------------------------------------------------------------
echo "==> Phase 3: adopt with cdkd import (auto mode, no short-circuit flags)"
# ---------------------------------------------------------------------------
# `import` is the one command that does not accept --region (issue #1097), so
# the region rides on AWS_REGION.
IMPORT_LOG="$(mktemp)"
AWS_REGION="${REGION}" node "${LOCAL_DIST}" import "${STACK}" \
  --state-bucket "${STATE_BUCKET}" \
  --yes \
  --verbose 2>&1 | tee "${IMPORT_LOG}" \
  | sed -e "s/${SECRET_PLAINTEXT}/<needle>/g" -e "s/${SUB_FLOOR_FRAMED}/port:**/g" -e "s/\"pin\":\"${SUB_FLOOR_PLAINTEXT}\"/\"pin\":\"**\"/g"
# `set -o pipefail` is on AND `cleanup` re-arms `set -eu`, so a non-zero import
# really does abort here despite the tee. Before the re-arm it did not. The
# `sed` masks the two known values on the TERMINAL only; the log FILE the
# checks below read is the raw one, so a leak is still detected -- and is
# not echoed by the tee that detected it.

# EMPTINESS FIRST, and the order is the whole point. Every check below is a
# `grep` that a zero-byte log satisfies for the wrong reason, so this must
# precede them or it can never fire -- an earlier revision placed it AFTER the
# two greps, where both already required non-empty content and this was
# strictly weaker than either. It then counted an unfalsifiable check toward
# the assertion floor, which is the shape this fixture keeps correcting.
if [ ! -s "${IMPORT_LOG}" ]; then
  echo "FAIL: the import log is empty -- every check below would pass" >&2
  echo "      vacuously." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # import log is non-empty

# An INDEPENDENT sentinel next: grepping only cdkd's own summary wording means
# a reword makes this read as "the condition did not occur" rather than "the
# assertion broke". The state file is the artifact, and it is checked below --
# this grep is the cheap early signal, not the proof.
if ! grep -qE "Summary:" "${IMPORT_LOG}"; then
  echo "FAIL: the import printed no Summary line at all -- the assertion below" >&2
  echo "      greps for wording that may have changed; check the log." >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # sentinel: a Summary line exists
if ! grep -qE "3 imported, 0 not found" "${IMPORT_LOG}"; then
  echo "FAIL: import summary is not '3 imported, 0 not found'" >&2
  # Masked like the tee above: this runs BEFORE the leak checks, so a raw line
  # could carry what they have not yet refused.
  grep -iE "Summary:" "${IMPORT_LOG}" \
    | sed -e "s/${SECRET_PLAINTEXT}/<needle>/g" -e "s/${SUB_FLOOR_FRAMED}/port:**/g" -e "s/\"pin\":\"${SUB_FLOOR_PLAINTEXT}\"/\"pin\":\"**\"/g" >&2 || true
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # all three resources adopted
# THE LOG IS AN ARTIFACT TOO. Issue #2829 was exactly a plaintext reaching
# stderr through resolver error text, and `--verbose` output is already in hand
# here -- not asserting it would leave the cheapest check in the fixture unmade.
if grep -qF "${SECRET_PLAINTEXT}" "${IMPORT_LOG}"; then
  echo "FAIL: the decrypted secret appears in the import log (issue #2829 class); log line(s): $(grep -nF "${SECRET_PLAINTEXT}" "${IMPORT_LOG}" | cut -d: -f1 | head -3 | tr '\n' ' ')" >&2
  exit 1
fi
# A `grep -qF` SANITY CHECK, and that is all it is. It plants the same variable
# it greps into a COPY, so it cannot detect needle drift, and it would pass over
# an empty log -- which is why the non-empty check above is what actually
# guards that case. It does NOT have the standing of the state-file negative
# control below, which plants into the real document and re-runs the real
# predicate. Narrowed deliberately: an earlier comment credited it with
# catching a changed needle, a truncated log and an emptied redirect, and it
# catches none of the three.
LOG_PROBE="$(mktemp)"
cat "${IMPORT_LOG}" > "${LOG_PROBE}"
printf '%s\n' "planted ${SECRET_PLAINTEXT} for the control" >> "${LOG_PROBE}"
if ! grep -qF "${SECRET_PLAINTEXT}" "${LOG_PROBE}"; then
  echo "FAIL: the import-log needle check cannot detect a planted plaintext," >&2
  echo "      so its passing verdict above means nothing." >&2
  rm -f "${LOG_PROBE}"
  exit 1
fi
rm -f "${LOG_PROBE}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # import log is needle-free (control-backed)
# NOT asserted for the framed two-character value, and stated rather than
# skipped: the MASKING channel shares the value scan's four-character floor
# (`maskSecretsInText`'s substring arm), so a verbose line quoting the assembled
# join can carry `port:q7` -- the pre-existing #2453 residual, not this arm's
# subject. Reported without the value so a reader knows the channel is open.
if grep -qF "${SUB_FLOOR_FRAMED}" "${IMPORT_LOG}"; then
  echo "    NOTE: the verbose import log carries the framed two-character value (the #2453 masking-floor residual; not asserted here)"
fi
echo "==> Phase 3 ok: all three resources adopted, and the import log is needle-free"

# ---------------------------------------------------------------------------
echo "==> Phase 4: the persisted baseline holds the EXPRESSION, not the value"
# ---------------------------------------------------------------------------
STATE_JSON_FILE="$(mktemp)"
aws s3api get-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}" \
  --region "${REGION}" "${STATE_JSON_FILE}" >/dev/null

# THE LEAK ASSERTION, and the ONE position that is excluded from it.
#
# A plaintext LITERAL in a template is persisted to `state.json` verbatim, by
# design and independent of this PR: `cdkd import` records the template's
# Properties, so `SecretValue.unsafePlainText` puts the needle at the SECRET's
# own `properties.SecretString`. That is not issue #2828 and not a defect --
# but it means a raw grep of the file can never pass, so the check parses the
# record and excludes exactly that one path.
#
# The exclusion is PINNED in both directions: the excluded value must actually
# be the needle-bearing literal (so the exclusion cannot point at nothing), and
# it must be the ONLY path excluded (so it cannot silently widen). A negative
# control then plants the needle at a NON-excluded path and requires the check
# to fire, which is what makes a passing run distinguishable from a blind one.
python3 - "${STATE_JSON_FILE}" "${SECRET_PLAINTEXT}" <<'PY'
import json, sys

path, needle = sys.argv[1], sys.argv[2]
with open(path) as fh:
    state = json.load(fh)

resources = state.get('resources', {})
secret_rows = [lid for lid, r in resources.items()
               if r.get('resourceType') == 'AWS::SecretsManager::Secret']
if len(secret_rows) != 1:
    print(f'FAIL: expected exactly one secret row, got {len(secret_rows)}', file=sys.stderr)
    sys.exit(1)
secret_lid = secret_rows[0]

def strip_excluded(doc):
    """Remove ONLY resources.<secret>.properties.SecretString."""
    clone = json.loads(json.dumps(doc))
    props = clone['resources'][secret_lid].get('properties', {})
    return clone, props.pop('SecretString', None)

stripped, excluded = strip_excluded(state)

# EXACTLY ONE PATH EXCLUDED, asserted structurally rather than claimed in prose.
# The single `pop` is the only thing implementing it today; if a future edit
# widened `strip_excluded`, nothing else would notice.
def paths(doc, prefix=()):
    if isinstance(doc, dict):
        for k, v in doc.items():
            yield from paths(v, prefix + (str(k),))
    elif isinstance(doc, list):
        for i, v in enumerate(doc):
            yield from paths(v, prefix + (str(i),))
    else:
        yield prefix, doc

before = dict(paths(state))
after = dict(paths(stripped))
removed = sorted(set(before) - set(after))
changed = sorted(k for k in set(before) & set(after) if before[k] != after[k])
expected_removed = [('resources', secret_lid, 'properties', 'SecretString')]
if removed != expected_removed or changed:
    print(f'FAIL: the exclusion is not exactly one path. removed={removed} '
          f'changed={changed}; expected removed={expected_removed}, no changes.',
          file=sys.stderr)
    sys.exit(1)

# The exclusion must point at something real, or it is silently vacuous.
if not isinstance(excluded, str) or needle not in excluded:
    shape = 'absent' if excluded is None else f'{type(excluded).__name__} of length {len(str(excluded))}'
    print(f'FAIL: the excluded position did not hold the needle ({shape}; not printed). '
          'The template no longer carries the plaintext where this check '
          'expects it, so the exclusion is pointing at nothing.', file=sys.stderr)
    sys.exit(1)

# THE ASSERTION: nowhere else.
blob = json.dumps(stripped)
if needle in blob:
    print('FAIL: the decrypted secret is present in state.json OUTSIDE the '
          f'secret row\'s own SecretString (issue #2828). secret row={secret_lid}',
          file=sys.stderr)
    for lid, r in stripped.get('resources', {}).items():
        if needle in json.dumps(r):
            print(f'  leaking resource row: {lid}', file=sys.stderr)
    for key in ('outputs',):
        if needle in json.dumps(stripped.get(key, {})):
            print(f'  leaking top-level key: {key}', file=sys.stderr)
    sys.exit(1)

# NEGATIVE CONTROL: the same check must FIRE on a planted plaintext.
#
# The plant goes into a CLONE and happens BEFORE `strip_excluded`, so the
# exclusion is actually given its chance to remove it. Planting after the strip
# tested nothing: an exclusion that had widened to also pop `observedProperties`
# would still have shown the needle, because the strip never ran over it.
planted = json.loads(json.dumps(state))
planted['resources'][secret_lid].setdefault('attributes', {})['CdkdLeakProbe'] = needle
probe, _ = strip_excluded(planted)
if needle not in json.dumps(probe):
    print('FAIL: negative control did not fire -- the leak assertion cannot '
          'detect a planted plaintext, so its passing verdict means nothing.',
          file=sys.stderr)
    sys.exit(1)

print(f'  leak check ok (excluded exactly resources.{secret_lid}.properties.SecretString)')
PY
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # leak check (+ structural exclusion + neg control)

# THE FRAMED TWO-CHARACTER VALUE has no legitimate home ANYWHERE in the document
# (issue #2745): the secret's own SecretString carries `"pin":"q7"`, never
# `port:q7`, so unlike the needle above this check needs no exclusion and runs
# over the WHOLE file. A here-string, not `printf | grep -q`: under `pipefail`
# the builtin printf takes SIGPIPE when grep exits early on a multi-line text,
# and a leak check would then read "absent" over a leak. A negative control
# plants the framed value beside the document and requires the same predicate
# to fire.
if grep -qF "${SUB_FLOOR_FRAMED}" "${STATE_JSON_FILE}"; then
  echo "FAIL: the framed two-character value is somewhere in state.json (issue #2745, import site)" >&2
  exit 1
fi
if ! grep -qF "${SUB_FLOOR_FRAMED}" <<< "$(cat "${STATE_JSON_FILE}"; printf '\nplanted %s for the control\n' "${SUB_FLOOR_FRAMED}")"; then
  echo "FAIL: negative control did not fire -- the framed-value check cannot detect a planted value" >&2
  exit 1
fi
echo "  framed two-character value absent from the WHOLE state document (control-backed)"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # framed sub-floor value absent (control-backed)

# THE POSITIVE ASSERTION, and the reason "no plaintext" is not enough on its
# own: an absent baseline, an empty bag, and a capture that never ran all
# satisfy the leak check. This is the fact the whole fixture exists to
# establish -- that a REAL provider readback of a secret-bearing property lands
# in state.json as the assembled expression, at the position the property
# occupies.
python3 - "${STATE_JSON_FILE}" "${EXPECTED_SUB_FLOOR_EXPR}" <<'PY'
import json, sys

with open(sys.argv[1]) as fh:
    state = json.load(fh)
expected_sub_floor = sys.argv[2]

rows = [(lid, r) for lid, r in state.get('resources', {}).items()
        if r.get('resourceType') == 'AWS::SSM::Parameter']
if len(rows) != 2:
    print(f'FAIL: expected exactly two SSM parameter rows, got {len(rows)}', file=sys.stderr)
    sys.exit(1)

# The two rows are told apart by the SHAPE of `properties.Value`: the #2828 row
# holds a WHOLE token, the #2745 row the framed `port:` + token. Refuse anything
# else rather than guess -- a row holding the plaintext matches neither.
whole = [(lid, r) for lid, r in rows
         if str((r.get('properties') or {}).get('Value')).startswith('{{resolve:secretsmanager:')]
framed = [(lid, r) for lid, r in rows
          if str((r.get('properties') or {}).get('Value')).startswith('port:{{resolve:secretsmanager:')]
if len(whole) != 1 or len(framed) != 1:
    print(f'FAIL: expected one whole-token row and one framed row, got whole={len(whole)} '
          f'framed={len(framed)} (a row holding the plaintext matches neither)', file=sys.stderr)
    sys.exit(1)

# THE #2745 ROW: exact equality with the ARN-form expression the L2 join
# assembles -- never the plaintext, never a whole-token rewrite that drops the
# `port:` frame -- and the observed baseline positioned to the same string.
sf_lid, sf_row = framed[0]
sf_value = (sf_row.get('properties') or {}).get('Value')
# A mismatch is described, never PRINTED: an unexpected value here is exactly
# the shape that could carry the plaintext.
def describe(v):
    return 'absent' if v is None else f'{type(v).__name__} of length {len(str(v))}'
if sf_value != expected_sub_floor:
    print(f'FAIL: {sf_lid} properties.Value is not the framed ARN-form expression '
          f'({describe(sf_value)}; expected the {len(expected_sub_floor)}-character '
          'ARN-form token, issue #2745)', file=sys.stderr)
    sys.exit(1)
sf_observed = sf_row.get('observedProperties')
if sf_observed is None or sf_observed.get('Value') != expected_sub_floor:
    got = None if sf_observed is None else sf_observed.get('Value')
    print(f'FAIL: {sf_lid} observedProperties.Value is not the framed expression '
          f'({describe(got)}, issue #2745)', file=sys.stderr)
    sys.exit(1)
print(f'  {sf_lid}: properties.Value = observedProperties.Value = {sf_value}')

lid, row = whole[0]
observed = row.get('observedProperties')
if observed is None:
    print(f'FAIL: {lid} has no observedProperties. A REFUSAL is a legitimate '
          'outcome for the shapes issue 2828 cannot position, but this one IS '
          'positionable -- the resolve succeeds and properties hold a '
          'whole-token string leaf -- so an absent baseline means the capture '
          'regressed into refusing what it can handle.', file=sys.stderr)
    sys.exit(1)

value = observed.get('Value')
if not isinstance(value, str) or not value.startswith('{{resolve:secretsmanager:'):
    print(f'FAIL: {lid} observedProperties.Value is not the dynamic reference '
          f'({describe(value)})', file=sys.stderr)
    sys.exit(1)

props_value = (row.get('properties') or {}).get('Value')
if props_value != value:
    print(f'FAIL: {lid} properties.Value ({describe(props_value)}) and '
          f'observedProperties.Value ({describe(value)}) disagree', file=sys.stderr)
    sys.exit(1)

print(f'  {lid}: observedProperties.Value = {value}')
PY
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # POSITIVE: the baseline holds the expression
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # POSITIVE: the framed row holds the ARN-form expression (#2745)

echo "==> Phase 4 ok: the baseline holds the expression at the right position"

# ---------------------------------------------------------------------------
echo "==> Phase 5: destroy and assert nothing is left"
# ---------------------------------------------------------------------------
AWS_REGION="${REGION}" node "${LOCAL_DIST}" destroy "${STACK}" \
  --state-bucket "${STATE_BUCKET}" --force

assert_gone "SSM parameter ${PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${PARAM_NAME}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # parameter gone
assert_gone "SSM parameter ${SUB_FLOOR_PARAM_NAME} still exists after destroy" \
  aws ssm get-parameter --name "${SUB_FLOOR_PARAM_NAME}" --region "${REGION}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # sub-floor parameter gone

assert_gone "state file ${STATE_KEY} still exists after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "${STATE_KEY}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # state file gone

# The SECRET, force-deleted by `cdkd destroy` (the provider passes
# `ForceDeleteWithoutRecovery: true`) rather than left in a recovery window.
# Without this the needle would stay restorable for 30 days and the run would
# still report PASS.
#
# POLLED, not probed once. `DeleteSecret` is ASYNCHRONOUS: measured on the first
# run of this assertion, `describe-secret` still resolved immediately after
# `cdkd destroy` returned and resolved to `ResourceNotFoundException` moments
# later. A single gone-probe therefore FALSE-FAILS -- it reports a leak that
# does not exist, which is the mirror of the defect `gone_probe` exists to
# prevent and just as damaging to trust in the fixture.
SECRET_GONE=0
for _ in 1 2 3 4 5 6 7 8 9 10 11 12; do
  if gone_probe aws secretsmanager describe-secret \
       --secret-id "${SECRET_ARN}" --region "${REGION}"; then
    SECRET_GONE=1
    break
  fi
  sleep 5
done
if [ "${SECRET_GONE}" -ne 1 ]; then
  echo "FAIL: secret ${SECRET_ARN} still exists 60s after destroy" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # secret force-deleted

# A plain STRICT capture: no `2>/dev/null`, no `|| true`. A throttled or
# unauthorized listing aborts under `set -e` -- which `cleanup`'s re-arm is what
# makes true -- rather than reading as "no leftovers". Capture-form of the
# gone-probe defect (issue #1120).
LEFTOVER_LOG_GROUPS="$(aws logs describe-log-groups \
  --log-group-name-prefix "/aws/lambda/${STACK}" --region "${REGION}" \
  --query 'logGroups[].logGroupName' --output text)"
if [ -n "${LEFTOVER_LOG_GROUPS}" ] && [ "${LEFTOVER_LOG_GROUPS}" != "None" ]; then
  echo "FAIL: leftover log group(s): ${LEFTOVER_LOG_GROUPS}" >&2
  exit 1
fi
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # no leftover log groups

# cdkd adopted and then deleted the resources, so the CloudFormation stack is
# left holding references to things that no longer exist. Drop it explicitly --
# leaving it behind fails the next run's pre-flight.
#
# THE ORDERING TRAP this fixture hits and `import-auto-mode` does not: the SSM
# parameter's `Value` is a dynamic reference to the secret, and `cdkd destroy`
# deletes the secret with a recovery window, so CloudFormation cannot re-resolve
# the reference while deleting the parameter and the stack lands in
# DELETE_FAILED (`You can't perform this operation on the secret because it was
# marked for deletion`). Both resources are ALREADY gone at this point --
# asserted above -- so retaining them in CloudFormation's bookkeeping leaks
# nothing. The retry is what makes teardown deterministic instead of leaving a
# DELETE_FAILED stack for the next run to trip over.
npx cdk destroy "${STACK}" --force >/dev/null 2>&1 || true

# `gone_probe` rather than a blind `if aws ...`: a throttled or unauthorized
# describe would otherwise read as "the stack is gone" and skip the retry,
# which is the capture-form of the #1097 defect.
if ! gone_probe aws cloudformation describe-stacks --region "${REGION}" \
     --stack-name "${STACK}"; then
  echo "==> stack survived the first delete; retrying with --retain-resources"
  # ONLY the DELETE_FAILED ids: CloudFormation rejects `--retain-resources`
  # naming a resource that is not in that state, and the rejection would be
  # swallowed by the `|| true` below -- which is exactly how the first run of
  # this fixture left a DELETE_FAILED stack behind.
  RETAIN="$(aws cloudformation describe-stack-resources --region "${REGION}" \
    --stack-name "${STACK}" \
    --query "StackResources[?ResourceStatus=='DELETE_FAILED'].LogicalResourceId" \
    --output text)"
  # shellcheck disable=SC2086
  aws cloudformation delete-stack --region "${REGION}" --stack-name "${STACK}" \
    ${RETAIN:+--retain-resources ${RETAIN}} >/dev/null 2>&1 || true
  aws cloudformation wait stack-delete-complete --region "${REGION}" \
    --stack-name "${STACK}" >/dev/null 2>&1 || true
fi

assert_gone "CloudFormation stack ${STACK} still exists after teardown" \
  aws cloudformation describe-stacks --region "${REGION}" --stack-name "${STACK}"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # CFn stack gone

echo "==> Phase 5 ok: parameter, secret, state file and stack are gone"

rm -f "${IMPORT_LOG}" "${STATE_JSON_FILE}"

# ---------------------------------------------------------------------------
echo "==> Phase 6: sweep every object VERSION and assert zero survive"
# ---------------------------------------------------------------------------
# The state bucket is VERSIONED, so `aws s3 rm` writes a delete marker and
# removes nothing: the Phase 4 grep proves the CURRENT object is clean while
# every prior version stays readable via `s3:GetObjectVersion`. For a fixture
# that seeds a known plaintext this is the disclosure that outlives the run.
#
# The canonical shape: run cleanup on the success path, THEN disarm, THEN the
# full sweep and the assertion. Order is load-bearing -- a sweep living only in
# the trap runs on the FAILURE path and never on the normal one.
cleanup
trap - EXIT INT TERM
s3_purge_prefix_versions "${STATE_BUCKET}" "${STATE_PREFIX}" all || true
s3_assert_versions_swept "${STATE_BUCKET}" "${STATE_PREFIX}" \
  "import-secret-observed state teardown"
ASSERTIONS_RUN=$((ASSERTIONS_RUN + 1))  # no state version survives

# THE EXECUTED-ASSERTION FLOOR. Re-arming `set -eu` above fixes "a failing
# assertion cannot abort"; this fixes the other half -- "the assertion block
# vanished and the run was still green". Each substantive check bumps the
# counter, and a literal floor here refuses a PASS that skipped any of them.
# The number is a LITERAL, maintained by hand and deliberately NOT derived from
# the bumps -- a derived total would move with the pool and a deleted check
# would lower the bar rather than red the run. It earned that on its first
# outing: an off-by-one in this literal is what it reported, which is the
# failure mode a self-derived floor could never produce. Same shape as the unit
# matrix's `proven` counter, and it has now bitten twice: a deleted assertion
# block that stayed green, and this fixture's own unsound harness.
if [ "${ASSERTIONS_RUN:-0}" -lt 20 ]; then
  echo "FAIL: only ${ASSERTIONS_RUN:-0} of 20 assertions executed -- a block was" >&2
  echo "      skipped, so this run proves less than it claims." >&2
  exit 1
fi

echo "[verify] PASS -- cdkd import persisted the expression, never the decrypted value (issues #2828, #2745); ${ASSERTIONS_RUN} assertions executed"
