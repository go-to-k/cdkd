#!/usr/bin/env bash
# verify.sh - cdkd dynamic-ref-cross-region integ (issues #1933 + #1957).
#
# Failure-seeking test for the REGION dimension of cdkd's resolved
# dynamic-reference cache. `{{resolve:ssm:...}}` / `{{resolve:secretsmanager:...}}`
# values are REGIONAL: the same NAME in us-east-1 and us-west-2 is two
# different values. cdkd's cache used to be a process-global map keyed by the
# expression STRING alone, so in a run spanning regions the first region to
# resolve an expression won it for every later stack in every other region.
#
# The fixture:
#   1. creates the SAME SSM parameter name in TWO regions, with DIFFERENT
#      values (region A: cdkd-dynref-region-a / region B: cdkd-dynref-region-b);
#   2. deploys TWO stacks — one per region — in ONE cdkd process, each
#      declaring an SSM String parameter whose Value is the identical literal
#      `{{resolve:ssm:<shared name>}}` expression;
#   3. asserts each region's echo parameter carries ITS OWN region's value.
#
# Pre-fix, step 3 fails on the second stack: its resolution hits the cache
# populated by the first stack and writes the first region's value into the
# second region's resource.
#
# DEPLOY IS SERIAL HERE (`--stack-concurrency 1`) AND MUST STAY SERIAL. That is
# a safety requirement, not a leftover from #1933 — read this before "modernising"
# it to the default concurrency, which is the obvious-looking change:
#
#   cdkd installs the per-stack region-pinned AWS clients into a PROCESS-GLOBAL
#   singleton (`setAwsClients`, src/cli/commands/deploy.ts:655) and re-points
#   `process.env.AWS_REGION` with it (`switchRegion`). Serially that is fine —
#   both are re-pinned before each stack. Concurrently (the default is 4) two
#   multi-region stacks race for them, and the race is NOT confined to the
#   dynamic-reference lookups: 42 provider files read `getAwsClients()`, most of
#   them at CALL time, and `switchRegion` mutates `process.env.AWS_REGION` for
#   the whole process. So a lost race CREATES this fixture's echo parameters IN
#   THE WRONG REGION — resources this script's region-keyed cleanup would not
#   delete, i.e. billed orphans, on a run whose purpose is to prove correctness.
#
#   (An earlier version of this note offered `SSMParameterProvider`'s
#   CONSTRUCTOR capture as the proof. That was WRONG and is corrected here:
#   `setAwsClients` and `registerAllProviders` are synchronous neighbours with
#   no `await` between them, and the registry is per stack, so the constructor
#   capture is the one shape that is IMMUNE to the race. The race lives in the
#   call-time readers and in the env mutation. The conclusion is unchanged.)
#
#   Issue #1957 fixed the RESOLVER half of that singleton problem (each lookup
#   is now bound to its resolver's own region — `clientsForRegion` in
#   src/deployment/intrinsic-function-resolver.ts). It deliberately did NOT
#   touch the PROVISIONING half, which lives in deploy.ts and is filed
#   separately as issue #1981. Until that one is fixed, a cross-region deploy at
#   the default concurrency is unsafe to run at all, so this fixture does not
#   run one and #1957's "default concurrency" acceptance criterion cannot be met
#   by a deploy-shaped arm.
#
#   If you come back to build that arm after the provisioning half lands: vary
#   which stack goes first through the DECLARATION order in bin/app.ts, not the
#   argv order — `matchStacks` (src/cli/stack-matcher.ts) walks the cloud
#   assembly's own order and ignores the order the names were typed, so
#   `cdkd deploy B A` deploys in exactly the same order as `cdkd deploy A B`.
#   And run it more than once: a race that interleaves harmlessly once proves
#   nothing.
#
# WHAT PINS #1957 HERE INSTEAD is `cdkd scrub` (phase 3d), which is the issue's
# OTHER site and needs no concurrency to reach the same defect: scrub installs
# its clients ONCE from the CLI region (`scrub.ts:126`) and then resolves stacks
# in SEVERAL regions, so the wrong-region read is structural rather than
# timing-dependent. It also writes no AWS resources, so a failure there cannot
# orphan anything. That makes it both the safer and the STRICTER arm: the
# failure it catches is a DISCLOSURE (plaintext left in state.json), not a wrong
# value.
#
# FOUR arms run per region, and each proves something the others cannot. The
# `String` arm proves the resolved VALUE is region-local. The `SecureString` arm
# (seeded out of band by this script — CloudFormation cannot create one)
# additionally reaches the REDACTION path: cdkd hands the provider the decrypted
# value while persisting the unresolved expression (issue #1901), which is the
# half the cache's per-entry secret verdict decides. Without it the
# verdict-carrying logic gets no real-AWS coverage at all. A THIRD resource
# repeats the SecureString reference EMBEDDED in a longer string and DependsOn
# the second, so it resolves on a cache HIT whose leaf cannot be repositioned
# from the template — the only arm that fails if the cache entry stops carrying
# its secret verdict. The FOURTH arm is the MIXED-TYPE one: one name that is a
# plain `String` in region A and a `SecureString` in region B. It is the only
# arm whose failure mode is a DISCLOSURE — secret-ness is decided by the
# parameter's TYPE (issue #1901), so a lookup answered by the wrong region
# misclassifies as well as mis-resolves, and region B's value is persisted in
# PLAINTEXT. That is #1957's acceptance criterion 3 and the shape
# `cdkd scrub --all` hits.
#
# SECURITY: three of the seeded values are SecureString plaintexts (the shared
# secure name in both regions, plus the mixed-type name's region-B value). They
# are test data, but they are never printed — assertions compare them and report
# PASS/FAIL only. Anyone extending this file must keep that property: never add
# one to an `echo`, and never let one reach a failure message.
#
# Required env vars:
#   STATE_BUCKET - cdkd state bucket (e.g. cdkd-state-{accountId})
#   AWS_REGION   - region A, defaults to us-east-1
#   SECOND_REGION - region B, defaults to us-west-2 (auto-flips if it equals A)

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

# --- state-content assertions ----------------------------------------------
# DEFINED HERE, WITH EVERY OTHER HELPER, AND NOT NEXT TO THEIR FIRST USE.
# bash binds a function name when the definition STATEMENT runs, so a helper
# defined further down the file than its first call is a `command not found`
# under `set -e` — rc 127, mid-run, after the deploy has already created real
# AWS resources. That is not hypothetical here: these two were originally
# defined beside phase 3c and called from phase 3b-3 eleven lines earlier, which
# aborted every run before phase 3d — the only arm covering issue #1957 — ever
# executed. `bash -n` does NOT catch it. Keep ALL helpers in this block.
assert_state_redacted() { # usage: assert_state_redacted <stack> <region> <plaintext> [source-param]
  # The 4th argument names WHICH source parameter's expression must be present;
  # it defaults to the shared SecureString one so the phase-3c calls read
  # exactly as they did before the mixed-type arm was added.
  local stack="$1" region="$2" plaintext="$3" param="${4:-${SECURE_PARAM}}"
  local state_json
  state_json="$(${CLI} state show "${stack}" --state-bucket "${STATE_BUCKET}" \
    --region "${region}" --json)"
  if printf '%s' "${state_json}" | grep -F -q "${plaintext}"; then
    echo "FAIL: ${stack} (${region}) persisted the decrypted SecureString plaintext in state.json" >&2
    exit 1
  fi
  if ! printf '%s' "${state_json}" | grep -F -q "{{resolve:ssm:${param}}}"; then
    echo "FAIL: ${stack} (${region}) state.json does not carry the unresolved" >&2
    echo "      {{resolve:ssm:...}} expression for the SecureString reference" >&2
    exit 1
  fi
}

assert_state_lacks() { # usage: assert_state_lacks <stack> <region> <plaintext> <description>
  # A one-sided check for values that must never appear, where no matching
  # expression is required to be present. Used for the cross-region leak
  # assertions on the region whose own copy of the value is PUBLIC.
  local stack="$1" region="$2" plaintext="$3" desc="$4"
  local state_json
  state_json="$(${CLI} state show "${stack}" --state-bucket "${STATE_BUCKET}" \
    --region "${region}" --json)"
  if printf '%s' "${state_json}" | grep -F -q "${plaintext}"; then
    echo "FAIL: ${desc}" >&2
    exit 1
  fi
}
purge_s3_versions() { # usage: purge_s3_versions <key> [noncurrent]
  # `cdkd bootstrap` enables bucket VERSIONING (src/cli/commands/bootstrap.ts),
  # so `aws s3 rm` writes a DELETE MARKER and leaves every prior version
  # readable. Phase 3d deliberately writes a SecureString plaintext into a
  # state.json, so a run that only `s3 rm`s it leaves a real secret recoverable
  # in the bucket after a "clean" teardown — the exact class this fixture
  # exists to test.
  #
  # TWO MODES, and picking the wrong one is a live foot-gun rather than a
  # nicety — the two callers care about DIFFERENT DIMENSIONS of the response:
  #
  #   noncurrent  MID-RUN, while the stack is still deployed. Removes the
  #               historical versions (including the seeded plaintext) and
  #               MUST leave the current one, which is StackB's LIVE state.
  #               Delete it and `cdkd destroy` reports "No state found for
  #               stack ..., skipping", StackB's parameters are never deleted,
  #               and the teardown assertions fail ~30 minutes in.
  #   (default)   TEARDOWN, from `cleanup`, when nothing needs the state any
  #               more. Removes EVERY version and EVERY delete marker. The
  #               filter must NOT be applied here: after `aws s3 rm` the
  #               DELETE MARKER is the one carrying `IsLatest: true`, so a
  #               noncurrent-only sweep would leave it behind forever.
  #
  # Two independent query bugs have already been caught here, and each was
  # invisible to the other's test, which is why both dimensions are now
  # spelled out. (1) The parenthesisation: `[Versions, DeleteMarkers][][?...]`
  # returns EMPTY because the flatten projection swallows the filter. (2) The
  # `IsLatest` axis: the first round validated five responses that all varied
  # WHICH KEYS came back and none of which varied `IsLatest`, so a query that
  # deleted the live object passed every one of them. Verified with the AWS
  # CLI's own jmespath against a post-scrub shape (v3 current / v2 seeded /
  # v1 original) and a post-`s3 rm` shape (delete marker current).
  #
  # `--prefix` matches by prefix, so the `?Key==` filter is what keeps a
  # sibling key (`state.json.bak`) from being swept too.
  local key="$1" mode="${2:-all}" filter="" vid versions
  if [ "${mode}" = "noncurrent" ]; then
    filter=" && IsLatest==\`false\`"
  fi
  # Captured rather than piped so a listing FAILURE is visible: piping into
  # `while` hides the exit status, and with stderr discarded a transient
  # throttle would silently purge nothing while the run continued.
  if ! versions="$(aws s3api list-object-versions --bucket "${STATE_BUCKET}" \
    --prefix "${key}" \
    --query "([Versions, DeleteMarkers][])[?Key=='${key}'${filter}].VersionId" \
    --output text 2>&1)"; then
    echo "WARN: could not list versions of ${key}: ${versions}" >&2
    return 0
  fi
  # `printf '%s\n'`, NOT `printf '%s'`. Without the trailing newline the final
  # field has no line terminator, `read` returns non-zero on it, and the `while`
  # body never runs for the LAST version — so exactly one version survived every
  # sweep. Measured against real S3: repeated passes took a key from 30 to 1 and
  # then stopped, which is what a silent off-by-one looks like from outside.
  # `|| [ -n "${vid}" ]` is the belt to that braces, so a future edit that drops
  # the newline again cannot reintroduce it.
  printf '%s\n' "${versions}" | tr '\t' '\n' | while read -r vid || [ -n "${vid}" ]; do
    [ -n "${vid}" ] || continue
    [ "${vid}" = "None" ] && continue
    aws s3api delete-object --bucket "${STATE_BUCKET}" --key "${key}" \
      --version-id "${vid}" >/dev/null 2>&1 || true
  done
}
# ---------------------------------------------------------------------------

cd "$(dirname "$0")"

REGION_A="${AWS_REGION:-us-east-1}"
REGION_B="${SECOND_REGION:-us-west-2}"
if [ "${REGION_A}" = "${REGION_B}" ]; then
  # The whole point is the region difference; flip B if the caller's base
  # region happens to be us-west-2.
  REGION_B="us-east-1"
fi
export AWS_REGION="${REGION_A}"

if [ -z "${STATE_BUCKET:-}" ]; then
  echo "FAIL: STATE_BUCKET env var is required" >&2
  exit 1
fi

REPO_ROOT="$(git rev-parse --show-toplevel)"
TEST_DIR="${REPO_ROOT}/tests/integration/dynamic-ref-cross-region"
LOCAL_DIST="${REPO_ROOT}/dist/cli.js"
if [ ! -f "${LOCAL_DIST}" ]; then
  echo "FAIL: ${LOCAL_DIST} not found — run 'vp run build' first" >&2
  exit 1
fi
CLI="node ${LOCAL_DIST}"

ACCOUNT_ID="$(aws sts get-caller-identity --query Account --output text)"

STACK_A="CdkdDynamicRefCrossRegionAStack"
STACK_B="CdkdDynamicRefCrossRegionBStack"
ECHO_PARAM_A="${STACK_A}-echo"
ECHO_PARAM_B="${STACK_B}-echo"
SECURE_ECHO_PARAM_A="${STACK_A}-secure-echo"
SECURE_ECHO_PARAM_B="${STACK_B}-secure-echo"
# The cache-HIT resource: same expression, EMBEDDED in a longer string, and
# DependsOn the bare one so it always resolves second. See the stack comment for
# why both properties are needed to make phase 3c discriminating.
EMBEDDED_ECHO_PARAM_A="${STACK_A}-secure-embedded-echo"
EMBEDDED_ECHO_PARAM_B="${STACK_B}-secure-embedded-echo"
# The MIXED-TYPE arm (issue #1957): one shared NAME whose TYPE differs by region.
MIXED_ECHO_PARAM_A="${STACK_A}-mixed-echo"
MIXED_ECHO_PARAM_B="${STACK_B}-mixed-echo"

SOURCE_PARAM="/cdkd-test/dynref-cross-region-${ACCOUNT_ID}"
EXPECTED_A="cdkd-dynref-region-a"
EXPECTED_B="cdkd-dynref-region-b"

# The SecureString counterpart. Same name in both regions, different values, and
# created by THIS script — CloudFormation cannot create a SecureString, so the
# stacks only reference it (same shape as secrets-dynamic-ref). It is what gives
# the fix's verdict-carrying half real-AWS coverage: a `String` value is never
# redacted, so the String arms above cannot exercise it. Test data, but treated
# as secret throughout — never echoed, only compared.
SECURE_PARAM="/cdkd-test/dynref-cross-region-secure-${ACCOUNT_ID}"
EXPECTED_SECURE_A="cdkd-dynref-secure-a"
EXPECTED_SECURE_B="cdkd-dynref-secure-b"

# The MIXED-TYPE source (issue #1957 acceptance criterion 3): the SAME name,
# seeded as a plain `String` in region A and as a `SecureString` in region B.
# Region A's value is public test data and may be printed; region B's is treated
# as secret throughout and is never echoed. The asymmetry is the whole point —
# a lookup answered by the wrong region gets the wrong TYPE, and the type is
# what decides whether the resolved value is persisted in plaintext.
MIXED_PARAM="/cdkd-test/dynref-cross-region-mixed-${ACCOUNT_ID}"
EXPECTED_MIXED_PUBLIC_A="cdkd-dynref-mixed-public-a"
EXPECTED_MIXED_SECRET_B="cdkd-dynref-mixed-secret-b"

export CDKD_IT_DYNREF_REGION_A="${REGION_A}"
export CDKD_IT_DYNREF_REGION_B="${REGION_B}"
export CDKD_IT_DYNREF_SOURCE_PARAM="${SOURCE_PARAM}"
export CDKD_IT_DYNREF_SECURE_PARAM="${SECURE_PARAM}"
export CDKD_IT_DYNREF_MIXED_PARAM="${MIXED_PARAM}"

echo "[verify] region-a=${REGION_A} region-b=${REGION_B} source-param=${SOURCE_PARAM}"

cd "${TEST_DIR}"
if [ ! -d node_modules ]; then
  vp install
fi

# Seed an `rc` so a signal-triggered cleanup does not read an unset variable
# as success and skip its own teardown.
rc=0
cleaned=0
# Scratch files that may hold a SecureString PLAINTEXT (the phase-3d legacy-state
# seed). Declared here, before the trap is armed, so `cleanup` can always shred
# them: an abort during the `aws s3 cp` would otherwise leave the plaintext in
# /tmp, which is exactly what this file's SECURITY note forbids. The phase
# clears the variables after its own `rm -f`, so a normal run's cleanup is a
# no-op rather than a double delete.
SEEDED_STATE=""
LEGACY_STATE=""
cleanup() {
  rc=$?
  # The INT / TERM traps call `cleanup` and then `exit`, which re-fires the EXIT
  # trap — so without this guard every signalled run destroys twice (the second
  # pass racing the first through `cdkd destroy` and the delete-parameter calls).
  if [ "${cleaned}" -eq 1 ]; then
    exit "${rc}"
  fi
  cleaned=1
  echo "[verify] cleanup (exit ${rc})"
  # Shred the plaintext-bearing scratch files FIRST — before the AWS teardown,
  # which is slow and can itself fail. `|| true` matches the rest of this
  # function: a cleanup step must never abort the steps after it.
  rm -f "${SEEDED_STATE}" "${LEGACY_STATE}" >/dev/null 2>&1 || true
  # Best-effort stack teardown first, so the echo parameters go with their
  # stacks and cdkd state is not left pointing at deleted resources.
  ${CLI} destroy "${STACK_A}" "${STACK_B}" \
    --state-bucket "${STATE_BUCKET}" --force >/dev/null 2>&1 || true
  # Then direct AWS cleanup in case destroy itself is what broke.
  aws ssm delete-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SECURE_ECHO_PARAM_A}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SECURE_ECHO_PARAM_B}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${EMBEDDED_ECHO_PARAM_A}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${EMBEDDED_ECHO_PARAM_B}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${MIXED_ECHO_PARAM_A}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${MIXED_ECHO_PARAM_B}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SECURE_PARAM}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${SECURE_PARAM}" --region "${REGION_B}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${MIXED_PARAM}" --region "${REGION_A}" >/dev/null 2>&1 || true
  aws ssm delete-parameter --name "${MIXED_PARAM}" --region "${REGION_B}" >/dev/null 2>&1 || true
  # Stale state/lock keys, in case the destroy above could not run.
  for region in "${REGION_A}" "${REGION_B}"; do
    for stack in "${STACK_A}" "${STACK_B}"; do
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${region}/state.json" >/dev/null 2>&1 || true
      aws s3 rm "s3://${STATE_BUCKET}/cdkd/${stack}/${region}/lock.json" >/dev/null 2>&1 || true
      # ...and purge the NON-CURRENT versions the delete markers above leave
      # behind. Unconditional rather than only for the seeded key: a destroy
      # that ran normally still leaves earlier versions, and one of this
      # fixture's states held a plaintext for part of the run.
      purge_s3_versions "cdkd/${stack}/${region}/state.json" || true
      purge_s3_versions "cdkd/${stack}/${region}/lock.json" || true
    done
  done
  exit "${rc}"
}
trap cleanup EXIT
trap '(exit 130); cleanup; exit 130' INT
trap '(exit 143); cleanup; exit 143' TERM

echo "==> Phase 1: seed the SAME parameter name in both regions with DIFFERENT values"
aws ssm put-parameter --name "${SOURCE_PARAM}" --type String \
  --value "${EXPECTED_A}" --overwrite --region "${REGION_A}" >/dev/null
aws ssm put-parameter --name "${SOURCE_PARAM}" --type String \
  --value "${EXPECTED_B}" --overwrite --region "${REGION_B}" >/dev/null
echo "    OK: ${SOURCE_PARAM} = ${EXPECTED_A} (${REGION_A}) / ${EXPECTED_B} (${REGION_B})"

aws ssm put-parameter --name "${SECURE_PARAM}" --type SecureString \
  --value "${EXPECTED_SECURE_A}" --overwrite --region "${REGION_A}" >/dev/null
aws ssm put-parameter --name "${SECURE_PARAM}" --type SecureString \
  --value "${EXPECTED_SECURE_B}" --overwrite --region "${REGION_B}" >/dev/null
# Assert the type really is SecureString before proceeding: a parameter that
# silently came back `String` would make the whole secret arm vacuous (it would
# resolve and pass every value assertion while redacting nothing).
for region in "${REGION_A}" "${REGION_B}"; do
  SECURE_TYPE="$(aws ssm get-parameter --name "${SECURE_PARAM}" --region "${region}" \
    --query 'Parameter.Type' --output text)"
  if [ "${SECURE_TYPE}" != "SecureString" ]; then
    echo "FAIL: ${SECURE_PARAM} in ${region} has Type '${SECURE_TYPE}', expected SecureString" >&2
    exit 1
  fi
done
echo "    OK: ${SECURE_PARAM} seeded as SecureString in both regions (values not shown)"

# The MIXED-TYPE source: SAME name, DIFFERENT TYPE per region (issue #1957).
aws ssm put-parameter --name "${MIXED_PARAM}" --type String \
  --value "${EXPECTED_MIXED_PUBLIC_A}" --overwrite --region "${REGION_A}" >/dev/null
aws ssm put-parameter --name "${MIXED_PARAM}" --type SecureString \
  --value "${EXPECTED_MIXED_SECRET_B}" --overwrite --region "${REGION_B}" >/dev/null
# Assert BOTH types, for the same reason the block above asserts one: if region
# B's copy came back `String` the disclosure arm would be vacuous, and if region
# A's came back `SecureString` the two regions would agree and the arm would
# stop discriminating a wrong-region CLASSIFICATION from a right one.
MIXED_TYPE_A="$(aws ssm get-parameter --name "${MIXED_PARAM}" --region "${REGION_A}" \
  --query 'Parameter.Type' --output text)"
MIXED_TYPE_B="$(aws ssm get-parameter --name "${MIXED_PARAM}" --region "${REGION_B}" \
  --query 'Parameter.Type' --output text)"
if [ "${MIXED_TYPE_A}" != "String" ]; then
  echo "FAIL: ${MIXED_PARAM} in ${REGION_A} has Type '${MIXED_TYPE_A}', expected String" >&2
  exit 1
fi
if [ "${MIXED_TYPE_B}" != "SecureString" ]; then
  echo "FAIL: ${MIXED_PARAM} in ${REGION_B} has Type '${MIXED_TYPE_B}', expected SecureString" >&2
  exit 1
fi
echo "    OK: ${MIXED_PARAM} seeded String in ${REGION_A} / SecureString in ${REGION_B}"

echo "==> Phase 2: deploy BOTH stacks in ONE cdkd process (serial)"
${CLI} deploy "${STACK_A}" "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" \
  --stack-concurrency 1 \
  --yes

echo "==> Phase 3: assert each region's echo carries ITS OWN region's value"
ACTUAL_A="$(aws ssm get-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}" \
  --query 'Parameter.Value' --output text)"
ACTUAL_B="$(aws ssm get-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}" \
  --query 'Parameter.Value' --output text)"

echo "    ${REGION_A}: ${ECHO_PARAM_A} = ${ACTUAL_A}"
echo "    ${REGION_B}: ${ECHO_PARAM_B} = ${ACTUAL_B}"

if [ "${ACTUAL_A}" != "${EXPECTED_A}" ]; then
  echo "FAIL: ${ECHO_PARAM_A} (${REGION_A}) resolved to '${ACTUAL_A}', expected '${EXPECTED_A}'" >&2
  exit 1
fi
if [ "${ACTUAL_B}" = "${EXPECTED_A}" ]; then
  echo "FAIL: ${ECHO_PARAM_B} (${REGION_B}) carries region A's value '${ACTUAL_A}' — the" >&2
  echo "      dynamic-reference cache leaked one region's value into another (issue #1933)." >&2
  exit 1
fi
if [ "${ACTUAL_B}" != "${EXPECTED_B}" ]; then
  echo "FAIL: ${ECHO_PARAM_B} (${REGION_B}) resolved to '${ACTUAL_B}', expected '${EXPECTED_B}'" >&2
  exit 1
fi
echo "    OK: each region resolved its own value"

echo "==> Phase 3b: same assertion for the SecureString arm (values never printed)"
ACTUAL_SECURE_A="$(aws ssm get-parameter --name "${SECURE_ECHO_PARAM_A}" --region "${REGION_A}" \
  --query 'Parameter.Value' --output text)"
ACTUAL_SECURE_B="$(aws ssm get-parameter --name "${SECURE_ECHO_PARAM_B}" --region "${REGION_B}" \
  --query 'Parameter.Value' --output text)"

if [ "${ACTUAL_SECURE_A}" != "${EXPECTED_SECURE_A}" ]; then
  echo "FAIL: ${SECURE_ECHO_PARAM_A} (${REGION_A}) did not resolve to its own region's SecureString value" >&2
  exit 1
fi
if [ "${ACTUAL_SECURE_B}" = "${EXPECTED_SECURE_A}" ]; then
  echo "FAIL: ${SECURE_ECHO_PARAM_B} (${REGION_B}) carries region A's SECRET — the dynamic-reference" >&2
  echo "      cache leaked one region's decrypted SecureString into another (issue #1933)." >&2
  exit 1
fi
if [ "${ACTUAL_SECURE_B}" != "${EXPECTED_SECURE_B}" ]; then
  echo "FAIL: ${SECURE_ECHO_PARAM_B} (${REGION_B}) did not resolve to its own region's SecureString value" >&2
  exit 1
fi
echo "    OK: each region resolved its own SecureString value"

echo "==> Phase 3b-2: the CACHE-HIT resource resolved the same region's secret"
ACTUAL_EMBEDDED_A="$(aws ssm get-parameter --name "${EMBEDDED_ECHO_PARAM_A}" --region "${REGION_A}" \
  --query 'Parameter.Value' --output text)"
ACTUAL_EMBEDDED_B="$(aws ssm get-parameter --name "${EMBEDDED_ECHO_PARAM_B}" --region "${REGION_B}" \
  --query 'Parameter.Value' --output text)"
if [ "${ACTUAL_EMBEDDED_A}" != "db=${EXPECTED_SECURE_A};mode=test" ]; then
  echo "FAIL: ${EMBEDDED_ECHO_PARAM_A} (${REGION_A}) did not substitute its own region's secret" >&2
  exit 1
fi
if [ "${ACTUAL_EMBEDDED_B}" != "db=${EXPECTED_SECURE_B};mode=test" ]; then
  echo "FAIL: ${EMBEDDED_ECHO_PARAM_B} (${REGION_B}) did not substitute its own region's secret" >&2
  exit 1
fi
echo "    OK: the cache-hit arm substituted the region-local secret in both stacks"

echo "==> Phase 3b-3: the MIXED-TYPE arm resolved each region's own value"
# Deterministic in SERIAL mode both before and after the #1957 fix (the deploy
# re-pins the ambient clients per stack), so this is a PREMISE for phase 3d
# rather than a discriminator on its own: it establishes that each stack really
# did read its own region's copy, so that when phase 3d finds the wrong
# classification it can only have come from scrub's own ambient clients.
ACTUAL_MIXED_A="$(aws ssm get-parameter --name "${MIXED_ECHO_PARAM_A}" --region "${REGION_A}" \
  --query 'Parameter.Value' --output text)"
ACTUAL_MIXED_B="$(aws ssm get-parameter --name "${MIXED_ECHO_PARAM_B}" --region "${REGION_B}" \
  --query 'Parameter.Value' --output text)"
if [ "${ACTUAL_MIXED_A}" != "${EXPECTED_MIXED_PUBLIC_A}" ]; then
  echo "FAIL: ${MIXED_ECHO_PARAM_A} (${REGION_A}) resolved to '${ACTUAL_MIXED_A}', expected" >&2
  echo "      the region-local public String value '${EXPECTED_MIXED_PUBLIC_A}'" >&2
  exit 1
fi
if [ "${ACTUAL_MIXED_B}" = "${EXPECTED_MIXED_PUBLIC_A}" ]; then
  echo "FAIL: ${MIXED_ECHO_PARAM_B} (${REGION_B}) carries region A's PUBLIC String value —" >&2
  echo "      its reference was answered by the wrong region (issue #1957)." >&2
  exit 1
fi
if [ "${ACTUAL_MIXED_B}" != "${EXPECTED_MIXED_SECRET_B}" ]; then
  echo "FAIL: ${MIXED_ECHO_PARAM_B} (${REGION_B}) did not resolve to its own region's" >&2
  echo "      SecureString value" >&2
  exit 1
fi
# The deploy must ALSO have classified region B's copy as a secret, or the
# plaintext is sitting in state.json right now.
assert_state_redacted "${STACK_B}" "${REGION_B}" "${EXPECTED_MIXED_SECRET_B}" "${MIXED_PARAM}"
assert_state_lacks "${STACK_A}" "${REGION_A}" "${EXPECTED_MIXED_SECRET_B}" \
  "${STACK_A} (${REGION_A}) state.json carries region B's SecureString value"
echo "    OK: mixed-type arm resolved per region and region B's copy is redacted"
# NOTE deliberately absent: an assertion that region A's state still holds the
# mixed value RESOLVED. It usually does, but the secret VERDICT store
# (`recordedSecretExpressions`) is process-global by design (#1933), so region
# B classifying the shared expression as a secret can legitimately make region
# A persist the expression too. That direction is safe — it over-redacts a
# public value — and pinning it here would make this arm order-dependent.

echo "==> Phase 3c: persisted state holds the EXPRESSION, never the plaintext"
# The redaction half (issue #1901), which only a SecureString arm can reach: the
# provider got the decrypted value (asserted above) while state must store the
# unresolved reference.
#
# What each of the two secret resources contributes, because they prove
# DIFFERENT things and only one of them is about this PR:
#
#   - the BARE reference exercises the fresh-resolution recorder, and its leaf
#     would be repositioned from the template source even if nothing were
#     recorded — so it is a regression net for #1901, not a fence for #1933;
#   - the EMBEDDED reference is resolved on a cache HIT (it DependsOn the bare
#     one) and its leaf cannot be repositioned, so the only thing that can keep
#     its plaintext out of state is the cache-hit arm re-recording the secret
#     using the verdict carried on the cache entry. Drop that verdict and this
#     phase fails on the embedded record with the decrypted value in state.json.
assert_state_redacted "${STACK_A}" "${REGION_A}" "${EXPECTED_SECURE_A}"
assert_state_redacted "${STACK_B}" "${REGION_B}" "${EXPECTED_SECURE_B}"
# ...and neither stack's state may carry the OTHER region's secret either.
assert_state_redacted "${STACK_A}" "${REGION_A}" "${EXPECTED_SECURE_B}"
assert_state_redacted "${STACK_B}" "${REGION_B}" "${EXPECTED_SECURE_A}"
echo "    OK: both states hold the expression and neither plaintext"

echo "==> Phase 3d: 'cdkd scrub --all' classifies each stack against ITS OWN region"
# THE #1957 ARM. `cdkd scrub` installs its AWS clients ONCE, from the CLI region
# (src/cli/commands/scrub.ts:126), and then walks stacks in SEVERAL regions
# building one resolver per stack. So the wrong-region read is STRUCTURAL here —
# no concurrency, no race, nothing timing-dependent — which is what makes this
# arm a deterministic discriminator where a concurrent deploy would only be a
# probabilistic one (and, per the header, an unsafe one).
#
# The command is run with the ambient region = REGION_A and NO --region flag, so
# region A is what the ambient clients point at and region B is the stack whose
# reference must nonetheless be answered by its own region.
#
# WHY THE STATE HAS TO BE SEEDED FIRST. Scrub only rewrites a record that
# actually holds plaintext, and a correct deploy never leaves one — so against
# freshly-deployed state both a fixed and a broken binary find nothing and the
# arm would be vacuous. The seed below writes region B's CURRENT SecureString
# value into region B's record exactly where a pre-GHSA-p5qg-v9gv-hc7w binary
# would have left it, which is the population `cdkd scrub` exists to clean.
#
# Pre-fix, scrub resolves region B's `{{resolve:ssm:<mixed>}}` against region A's
# ambient client, where that name is a plain `String`; a String is public config,
# so nothing is recorded as a secret, the injected plaintext is not recognised,
# and it SURVIVES the scrub. Post-fix the lookup is answered by region B, comes
# back `SecureString`, and the record is rewritten to the expression.
MIXED_EXPRESSION="{{resolve:ssm:${MIXED_PARAM}}}"
STATE_KEY_B="cdkd/${STACK_B}/${REGION_B}/state.json"
SEEDED_STATE="$(mktemp)"
LEGACY_STATE="$(mktemp)"
# Both now hold, or are about to hold, region B's SecureString plaintext; the
# `cleanup` trap shreds them on every exit path from here on.
aws s3 cp "s3://${STATE_BUCKET}/${STATE_KEY_B}" "${SEEDED_STATE}"
# Rewrite by MATCHING the expression rather than by naming a logical id, so a
# CDK logical-id change cannot silently turn this into a no-op seed.
jq --arg expr "${MIXED_EXPRESSION}" --arg plain "${EXPECTED_MIXED_SECRET_B}" \
  '.resources |= with_entries(
     if .value.properties.Value == $expr
     then .value.properties.Value = $plain
     else . end)' "${SEEDED_STATE}" > "${LEGACY_STATE}"
# Fail loudly if the seed did not land: a silent no-op here would make the whole
# phase pass vacuously, which is the exact failure mode this fixture exists to
# avoid elsewhere.
#
# COUPLING, stated because it is invisible locally and someone will otherwise
# move one half: this grep proves the plaintext is PRESENT, which is only
# evidence that the SEED landed because phase 3b-3 already proved the same
# plaintext was ABSENT from this record a moment ago. Delete or reorder that
# earlier assertion and this one degenerates into "the file contains a string it
# may well have contained all along".
if ! grep -F -q "${EXPECTED_MIXED_SECRET_B}" "${LEGACY_STATE}"; then
  echo "FAIL: could not seed legacy plaintext into ${STACK_B} state — no record held" >&2
  echo "      the mixed-type expression, so the scrub arm would pass vacuously" >&2
  rm -f "${SEEDED_STATE}" "${LEGACY_STATE}"
  exit 1
fi
aws s3 cp "${LEGACY_STATE}" "s3://${STATE_BUCKET}/${STATE_KEY_B}"
rm -f "${SEEDED_STATE}" "${LEGACY_STATE}"
SEEDED_STATE=""
LEGACY_STATE=""
echo "    seeded: ${STACK_B} state holds the mixed-type value as legacy plaintext"

AWS_REGION="${REGION_A}" ${CLI} scrub --all --state-bucket "${STATE_BUCKET}"

# The assertion. Region B's record must no longer hold the plaintext, and must
# hold the expression instead.
assert_state_redacted "${STACK_B}" "${REGION_B}" "${EXPECTED_MIXED_SECRET_B}" "${MIXED_PARAM}"
# ...and scrub must not have carried region B's secret into region A's record.
assert_state_lacks "${STACK_A}" "${REGION_A}" "${EXPECTED_MIXED_SECRET_B}" \
  "${STACK_A} (${REGION_A}) state.json carries region B's SecureString value after scrub"
# The pre-existing SecureString arms must survive the scrub untouched.
assert_state_redacted "${STACK_A}" "${REGION_A}" "${EXPECTED_SECURE_A}"
assert_state_redacted "${STACK_B}" "${REGION_B}" "${EXPECTED_SECURE_B}"
# Purge the plaintext-bearing VERSION now rather than waiting for cleanup: the
# assertions above are done with it, and every extra phase it survives is extra
# time a real secret is recoverable from the bucket.
#
# `noncurrent` is load-bearing here — StackB is still DEPLOYED and the current
# version is its live state.json. Sweeping that too makes Phase 4's destroy
# skip the stack entirely and Phase 5's leak assertions fail.
purge_s3_versions "${STATE_KEY_B}" noncurrent || true
echo "    OK: scrub classified region B's SecureString against region B (issue #1957)"

echo "==> Phase 4: destroy both stacks"
${CLI} destroy "${STACK_A}" "${STACK_B}" \
  --state-bucket "${STATE_BUCKET}" --force

echo "==> Phase 5: assert no leftovers"
assert_gone "${ECHO_PARAM_A} still exists in ${REGION_A} after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM_A}" --region "${REGION_A}"
assert_gone "${ECHO_PARAM_B} still exists in ${REGION_B} after destroy" \
  aws ssm get-parameter --name "${ECHO_PARAM_B}" --region "${REGION_B}"
assert_gone "${SECURE_ECHO_PARAM_A} still exists in ${REGION_A} after destroy" \
  aws ssm get-parameter --name "${SECURE_ECHO_PARAM_A}" --region "${REGION_A}"
assert_gone "${SECURE_ECHO_PARAM_B} still exists in ${REGION_B} after destroy" \
  aws ssm get-parameter --name "${SECURE_ECHO_PARAM_B}" --region "${REGION_B}"
assert_gone "${EMBEDDED_ECHO_PARAM_A} still exists in ${REGION_A} after destroy" \
  aws ssm get-parameter --name "${EMBEDDED_ECHO_PARAM_A}" --region "${REGION_A}"
assert_gone "${EMBEDDED_ECHO_PARAM_B} still exists in ${REGION_B} after destroy" \
  aws ssm get-parameter --name "${EMBEDDED_ECHO_PARAM_B}" --region "${REGION_B}"
assert_gone "${MIXED_ECHO_PARAM_A} still exists in ${REGION_A} after destroy" \
  aws ssm get-parameter --name "${MIXED_ECHO_PARAM_A}" --region "${REGION_A}"
assert_gone "${MIXED_ECHO_PARAM_B} still exists in ${REGION_B} after destroy" \
  aws ssm get-parameter --name "${MIXED_ECHO_PARAM_B}" --region "${REGION_B}"
assert_gone "state.json for ${STACK_A} still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_A}/${REGION_A}/state.json"
assert_gone "state.json for ${STACK_B} still present after destroy" \
  aws s3api head-object --bucket "${STATE_BUCKET}" --key "cdkd/${STACK_B}/${REGION_B}/state.json"

echo "==> Phase 6: delete the seeded source parameters"
aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}" >/dev/null
aws ssm delete-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}" >/dev/null
aws ssm delete-parameter --name "${SECURE_PARAM}" --region "${REGION_A}" >/dev/null
aws ssm delete-parameter --name "${SECURE_PARAM}" --region "${REGION_B}" >/dev/null
aws ssm delete-parameter --name "${MIXED_PARAM}" --region "${REGION_A}" >/dev/null
aws ssm delete-parameter --name "${MIXED_PARAM}" --region "${REGION_B}" >/dev/null
assert_gone "source parameter still exists in ${REGION_A}" \
  aws ssm get-parameter --name "${SOURCE_PARAM}" --region "${REGION_A}"
assert_gone "source parameter still exists in ${REGION_B}" \
  aws ssm get-parameter --name "${SOURCE_PARAM}" --region "${REGION_B}"
assert_gone "SecureString source parameter still exists in ${REGION_A}" \
  aws ssm get-parameter --name "${SECURE_PARAM}" --region "${REGION_A}"
assert_gone "SecureString source parameter still exists in ${REGION_B}" \
  aws ssm get-parameter --name "${SECURE_PARAM}" --region "${REGION_B}"
assert_gone "mixed-type source parameter still exists in ${REGION_A}" \
  aws ssm get-parameter --name "${MIXED_PARAM}" --region "${REGION_A}"
assert_gone "mixed-type source parameter still exists in ${REGION_B}" \
  aws ssm get-parameter --name "${MIXED_PARAM}" --region "${REGION_B}"

# The version sweep lives in `cleanup`, and `cleanup` runs from the TRAP — which
# the line below disarms. So on the SUCCESS path, the normal one, it never ran:
# every run left its state/lock versions behind (measured: 30 accumulated on one
# key before this was noticed, and a fresh run added 6 more). The seeded
# plaintext itself was never among them — phase 3d's `noncurrent` purge runs
# inline and was verified to leave zero versions containing it — so this is
# litter rather than a disclosure. It is still worth sweeping: a fixture that
# claims a clean teardown should have one, and a bucket that accumulates a
# stack's history makes the next run's leak assertions harder to read.
for region in "${REGION_A}" "${REGION_B}"; do
  for stack in "${STACK_A}" "${STACK_B}"; do
    purge_s3_versions "cdkd/${stack}/${region}/state.json" || true
    purge_s3_versions "cdkd/${stack}/${region}/lock.json" || true
  done
done

trap - EXIT INT TERM
echo "PASS: dynamic-ref-cross-region"
