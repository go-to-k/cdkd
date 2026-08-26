# s3-versions.sh - shared S3 VERSION-sweep helpers for cdkd integ fixtures.
#
# Source it from a verify.sh, after the `cd "$(dirname "$0")"` that puts the
# shell in the fixture directory:
#
#     . ../s3-versions.sh
#
# IT IS A FLAT FILE, NOT `lib/s3-versions.sh`, AND THAT IS DELIBERATE. Three
# generators enumerate `tests/integration/*` and treat every DIRECTORY there as
# a fixture (`listFixtures` in scripts/build-{integ,cli-flag,scenario}-coverage-
# matrix.ts skips only dot-prefixed names), so a `lib/` directory silently
# becomes a 283rd "fixture" in all three committed coverage matrices. A plain
# file is ignored by all of them with no exclusion list to keep in sync. If a
# second shared helper ever justifies a directory, teach those three
# `listFixtures` to require a fixture marker (cdk.json / bin) first.
#
# WHY THIS FILE EXISTS
# --------------------
# `cdkd bootstrap` turns VERSIONING ON for the state bucket
# (src/cli/commands/bootstrap.ts). On a versioned bucket `aws s3 rm` writes a
# DELETE MARKER; it does not remove content. So a fixture can destroy its
# stack, assert `head-object` reports the state file gone, exit 0 - and leave
# every byte it ever wrote into state.json readable forever to anyone with
# `s3:GetObjectVersion`.
#
# For most fixtures that is litter. For a fixture that puts a KNOWN SECRET
# PLAINTEXT into state - `unsafePlainText` in its own template, a literal
# `masterUserPassword`, an IAM `SecretAccessKey` cached in `attributes`, or a
# deliberately seeded pre-GHSA record - it is a disclosure that outlives the
# run. Measured on 2026-08-20 for issue #2096, immediately after two GREEN
# runs that both asserted "state file is gone":
#
#   cdkd/CdkdSecretsDynamicRefExample/us-east-1/state.json  304 versions + 43 markers
#                                                           carrying cdkd-known-pw-123
#   cdkd/CdkdSecretsArrayNestedExample/us-east-1/state.json   7 versions + 3 markers,
#                                                           5 of the 7 carrying
#                                                           cdkd-array-nested-pw-789
#
# Both fixtures "passed" every time. Nothing in either script had ever issued
# a `list-object-versions` or a `delete-object --version-id`.
#
# THE THREE TRAPS THIS FILE EXISTS TO MAKE UNREPEATABLE
# ----------------------------------------------------
# Each one produces a SILENT PARTIAL sweep - the run still exits 0, and the
# script still reads as if it cleaned up. All three were observed live.
#
# All three are now EXECUTED against this file by
# `tests/unit/scripts/integ-s3-versions-harness.test.ts` (issue #2106), which
# runs it under /bin/bash with a fake `aws` on PATH and reintroduces each trap
# as a mutation probe. Until that landed the only automated coverage was
# `bash -n` plus a static bash-4-ism scan, i.e. review.
#
#   1. Sweeping only from the EXIT trap. A fixture that ends with
#      `trap - EXIT INT TERM` disarms the trap on the success path, so a
#      trap-only sweep runs on the FAILURE path and never on the normal one.
#      One key had reached 30 versions that way (2026-08-19).
#      => Callers must sweep on the SUCCESS path too, and ASSERT.
#
#   2. Iterating with `printf '%s' | tr | while read`. `out=$(aws ...)` strips
#      the trailing newline, so the final field has no terminator, `read`
#      returns non-zero on it, and the loop body never runs for the LAST
#      version. Verified against real S3 on 2026-08-20: on a key holding one
#      version, the broken form saw 0 of 1; on a 347-entry listing it swept
#      346. Repeated passes take a key to 1 and then stop - which is what a
#      silent off-by-one looks like from outside.
#      => `printf '%s\n'` plus `|| [ -n "${key}" ]`, both, below.
#
#   3. Counting with `length(...)` under `--output text`. The AWS CLI applies
#      `--query` PER PAGE and concatenates, so a >1000-entry listing prints
#      one number per page: measured `1000\n189`, not `1189`. `[ "$n" -ne 0 ]`
#      on that is a bash syntax error, not a count.
#      => Count ROWS of a `[Key,VersionId]` projection instead (page-safe:
#      the pages concatenate into one row stream). Never use `length()` here.
#
# Auto-pagination itself is fine and is relied upon: with `--page-size 50`
# forced over the same 347-entry key the row stream still carried all 347
# ids, all unique. Do NOT add `--max-items` (it truncates).
#
# QUERY SHAPE
# -----------
# `([Versions, DeleteMarkers][])[...]` - the parentheses are load-bearing.
# `[Versions, DeleteMarkers][][?...]` returns EMPTY, because the flatten
# projection swallows the filter. Both forms were run against the real
# bucket; the unparenthesised one reported 0 where the parenthesised one
# reported 347.
#
# All four query variants below were executed against real S3 on 2026-08-20
# over a 1189-entry (multi-page) prefix:
#   all         1189
#   noncurrent  1064
#   latest-only  125   (1064 + 125 == 1189: the IsLatest axis really does
#                       partition the response, so `noncurrent` is not a no-op)

# --- internals --------------------------------------------------------------

# _s3v_check_prefix <prefix> - refuse anything that is not a single stack's
# own key space. This is a SAFETY guard, not a style check: these helpers are
# called from `cleanup`, which runs under `set +eu`, so an unset `STACK` would
# otherwise expand to an over-broad prefix and the sweep would delete other
# stacks' LIVE state - including a concurrent lane's. `""` (whole bucket) is
# the worst case and is the one this makes impossible.
_s3v_check_prefix() {
  local prefix="$1" rest stack region
  case "${prefix}" in
    */) ;;
    *) echo "FAIL: s3-versions: prefix must end in '/' (got '${prefix}')" >&2; return 1 ;;
  esac
  rest="${prefix#cdkd/}"
  if [ "${rest}" = "${prefix}" ]; then
    echo "FAIL: s3-versions: prefix must start with 'cdkd/' (got '${prefix}')" >&2
    return 1
  fi
  stack="${rest%%/*}"
  rest="${rest#*/}"
  region="${rest%%/*}"
  if [ -z "${stack}" ] || [ -z "${region}" ]; then
    echo "FAIL: s3-versions: refusing to sweep '${prefix}' - stack and region segments must both be non-empty" >&2
    return 1
  fi
  return 0
}

# _s3v_rows <bucket> <prefix|key> <query> - echo "<key><TAB><versionId>" rows.
# Returns 1 (with a WARN) when the LIST ITSELF failed. Captured rather than
# piped on purpose: piping into `while` hides the exit status, so a transient
# throttle would look exactly like "there is nothing here" and the sweep would
# purge nothing while the run carried on.
#
# stderr goes to its own file, NOT `2>&1`. Merging them puts any benign CLI
# warning INTO THE ROW STREAM, where it becomes a phantom row: the count then
# reports a surviving version on an empty bucket (assertion fails for no
# reason), and the delete path hands that warning text to
# `delete-object --key`. The message is still wanted for the WARN, hence the
# temp file rather than `2>/dev/null`.
_s3v_rows() {
  local bucket="$1" scope="$2" query="$3" rows err errfile rc
  errfile="$(mktemp 2>/dev/null)" || errfile=""
  if [ -n "${errfile}" ]; then
    rows="$(aws s3api list-object-versions --bucket "${bucket}" \
      --prefix "${scope}" --query "${query}" --output text 2>"${errfile}")"
    rc=$?
    err="$(cat "${errfile}" 2>/dev/null)"
    rm -f "${errfile}"
  else
    rows="$(aws s3api list-object-versions --bucket "${bucket}" \
      --prefix "${scope}" --query "${query}" --output text 2>/dev/null)"
    rc=$?
    err="<stderr unavailable: mktemp failed>"
  fi
  if [ "${rc}" -ne 0 ]; then
    echo "WARN: s3-versions: could not list versions under s3://${bucket}/${scope}: ${err}" >&2
    return 1
  fi
  [ -n "${rows}" ] || return 0
  printf '%s\n' "${rows}"
  return 0
}

# _s3v_prefix_query [noncurrent] - JMESPath for the prefix-scoped listing.
_s3v_prefix_query() {
  if [ "${1:-all}" = "noncurrent" ]; then
    printf '%s' '([Versions, DeleteMarkers][])[?IsLatest==`false`][].[Key,VersionId]'
  else
    printf '%s' '([Versions, DeleteMarkers][])[].[Key,VersionId]'
  fi
}

# _s3v_key_query <key> [noncurrent] - JMESPath for an EXACT-key listing.
# `--prefix` matches by prefix, so the `?Key==` term is what stops a sibling
# key (`state.json.bak`, `state.json.tmp`) from being swept along with it.
_s3v_key_query() {
  if [ "${2:-all}" = "noncurrent" ]; then
    printf '%s' "([Versions, DeleteMarkers][])[?Key=='$1' && IsLatest==\`false\`][].[Key,VersionId]"
  else
    printf '%s' "([Versions, DeleteMarkers][])[?Key=='$1'][].[Key,VersionId]"
  fi
}

# _s3v_flush_batch <bucket> <objects-json-body> - one DeleteObjects call.
# `Quiet: true` makes a fully successful call return `{}` and list ONLY the
# failures, so any non-empty `Errors` in the output is a per-object failure the
# call itself reported as overall success. Surfaced as a WARN rather than
# swallowed: the caller retries, and the zero-assertion is the backstop.
#
# `--output json` is PINNED, and that is load-bearing rather than tidy. This
# function greps the response for `"Errors"`, which is a JSON spelling. The AWS
# CLI's output format is ambient - `AWS_DEFAULT_OUTPUT=text`, or `output = text`
# / `output = yaml` in the active profile - so without the flag the same failure
# arrives as `ERRORS<TAB>...` or `Errors:`, the case never matches, and a
# per-object delete failure is swallowed with no WARN at all. On the success
# path the zero-assertion would still catch the under-sweep; from `cleanup` it
# would not, because that purges `noncurrent` and asserts nothing. `_s3v_rows`
# pins `--output text` for the same reason: neither reader may inherit a format
# it does not parse.
_s3v_flush_batch() {
  local bucket="$1" objects="$2" out
  if ! out="$(aws s3api delete-objects --bucket "${bucket}" --output json \
      --delete "{\"Objects\":[${objects}],\"Quiet\":true}" 2>&1)"; then
    echo "WARN: s3-versions: delete-objects batch failed on s3://${bucket}: ${out}" >&2
    return 1
  fi
  case "${out}" in
    *'"Errors"'*)
      echo "WARN: s3-versions: delete-objects reported per-object errors: ${out}" >&2
      return 1
      ;;
  esac
  return 0
}

# _s3v_delete_rows <bucket> - read "<key><TAB><versionId>" rows on stdin and
# delete them in DeleteObjects batches of 1000 (the API maximum). Batched
# rather than one `delete-object` per version because a single 347-version key
# then costs 1 CLI process instead of 347; a real sweep of 455 objects went
# from 455 calls to 7.
#
# See trap 2 in the header for why the caller must feed this with
# `printf '%s\n'` and why the `|| [ -n "${key}" ]` guard is here as well.
#
# The payload is assembled by hand rather than through `jq`, so that sourcing
# this file does not add a `jq` dependency to sixteen fixtures. That is safe for
# cdkd's key space (stack names, regions, ISO timestamps, hashes) but not for
# arbitrary text, so a key or version id carrying a quote or a backslash is
# routed to a single-object `delete-object` instead of being interpolated into
# JSON. A TAB or a NEWLINE cannot reach here at all - either would have split
# the row before this point.
_s3v_delete_rows() {
  local bucket="$1" key vid objects="" n=0 _s3v_out
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    if [ -z "${key}" ] || [ -z "${vid}" ]; then continue; fi
    if [ "${vid}" = "None" ]; then continue; fi
    case "${key}${vid}" in
      *'"'* | *'\'*)
        # WARN on failure rather than `|| true`. This is the only single-object
        # call left, it is unreachable for cdkd's key shapes, and that is
        # exactly why it would stay silent forever if it ever did fire -- in a
        # file whose whole premise is that a quiet sweep is the bug.
        if ! _s3v_out="$(aws s3api delete-object --bucket "${bucket}" --key "${key}" \
            --version-id "${vid}" --output json 2>&1)"; then
          echo "WARN: s3-versions: single-object delete failed for a quoted key under s3://${bucket}: ${_s3v_out}" >&2
        fi
        continue
        ;;
    esac
    objects="${objects}${objects:+,}{\"Key\":\"${key}\",\"VersionId\":\"${vid}\"}"
    n=$((n + 1))
    if [ "${n}" -ge 1000 ]; then
      _s3v_flush_batch "${bucket}" "${objects}" || true
      objects=""
      n=0
    fi
  done
  if [ "${n}" -gt 0 ]; then
    _s3v_flush_batch "${bucket}" "${objects}" || true
  fi
  return 0
}

# --- public API -------------------------------------------------------------

# s3_stack_prefix <stack> <region> - the key space one cdkd stack owns.
#
# WHY A PREFIX AND NOT A LIST OF KEYS. Sweeping `state.json` by name is the
# obvious first instinct and it UNDER-SWEEPS, because the plaintext is not only
# there. Under one prefix cdkd writes at least four things:
#
#   state.json             the record everyone thinks of
#   rollback-journal.json  failedOperations[].attemptedProperties - the
#                          PROPERTIES OF THE FAILED WRITE, verbatim. Measured
#                          2026-08-20 on CdkdDeletionPolicySnapshotHeavyExample:
#                          four versions carrying a literal
#                          `"MasterUserPassword": "Cdkdcf2f..."`. A per-key
#                          sweep of state.json leaves every one of them.
#   lock.json              no secret, but it accumulates faster than anything
#                          else (452 versions on one key)
#   deployments/**         the event store; sampled clean of plaintext, and its
#                          objects are NOT delete-markered by `cdkd destroy`,
#                          so they survive as CURRENT objects
#
# So the prefix form is the whole point of this helper, not a convenience: a
# reviewer's manual remediation swept state.json by name and left the journal
# behind, which is the mistake this comment exists to stop repeating.
#
# The trailing '/' is what keeps `CdkdFoo` from matching `CdkdFooBar`.
#
# BLIND SPOT, stated because it is invisible from here: a NESTED STACK child
# lives at `cdkd/<Parent>~<Child>/<region>/`, which is a SIBLING prefix, not a
# descendant of the parent's. One call to this function does not reach it, so a
# fixture with a nested stack must derive a SECOND prefix and sweep both.
#
# This comment used to add "no fixture in the swept set creates one today
# (verified)". That has since stopped being true and the line was not revisited:
# `nested-stack-secret` is in the swept set, builds a real `cdk.NestedStack`,
# and does the right thing already -- PARENT_PREFIX plus
# `s3_stack_prefix "${STACK}~Child"`, both purged and both asserted. Copy that
# fixture. Tracked with the wider fixture-tree work in issue #2107.
#
# SECOND BLIND SPOT, same shape: the shared EXPORTS INDEX at
# `cdkd/_index/<region>/exports.json` holds RESOLVED Output values and is a
# sibling prefix no `s3_stack_prefix` reaches. It is SHARED with every other
# stack in the region, so it must never be swept with a prefix-scoped `all` --
# that would take a concurrent lane's live index. Use `s3_purge_key_versions`
# with the exact key and `noncurrent`, which leaves whatever is CURRENT intact
# while the historical versions go (`cross-stack-secret-import` does this).
#
# THIRD, stated so nobody re-derives it: `custom-resource-responses/<id>.json`
# is a sidecar under a stack's OWN prefix, so the prefix sweep DOES reach it.
# Only `stack-lock-renewal` in the swept set uses a custom resource, and it
# carries no secret.
s3_stack_prefix() {
  printf 'cdkd/%s/%s/\n' "${1:-}" "${2:-}"
}

# s3_purge_prefix_versions <bucket> <prefix> [noncurrent]
#
# Best-effort: never aborts its caller, because it runs inside `cleanup`.
# Proof that it worked is `s3_assert_versions_swept`, not this function's
# exit code.
#
# MODE matters, and picking the wrong one is a live foot-gun:
#   noncurrent  Safe on ANY path, including a FAILED run: it leaves whatever
#               is CURRENT alone, so a live state.json that a later
#               `cdkd state destroy` still needs survives, while the
#               historical versions (where a seeded plaintext lives) go.
#               Use this from `cleanup`, which cannot know whether the run
#               failed with resources still standing.
#   all         Removes every version AND every delete marker. Only correct
#               once nothing needs the state any more - i.e. on the SUCCESS
#               path, after destroy has been asserted. It must NOT be
#               filtered to noncurrent there: after `aws s3 rm` the DELETE
#               MARKER is the entry carrying IsLatest==true, so a
#               noncurrent-only sweep would leave one marker per key behind
#               forever and the zero-assertion would never pass.
#
# THE MODE FOLLOWS THE DESTROY, NOT THE SCRIPT'S EXIT STATUS (issue #2225).
# This is a CALLER contract, and it lives here rather than in any one fixture
# because getting it wrong is invisible from inside the fixture that has it.
#
# The failing shape: a `cleanup` that opens with `rc=$?`, runs the destroy as
#
#     ${CDKD} destroy "${STACK}" ... 2>&1 | tail -5 || true
#
# and then branches on `rc`. The pipe (and the `|| true`) throw the DESTROY's
# status away, while `rc` is the SCRIPT's status on entry to `cleanup`. So a
# run whose assertions ALL PASSED and whose destroy then FAILED arrives here
# with `rc` 0 and resources still standing, takes the `all` branch, and deletes
# the current state.json -- the one record a later `cdkd state destroy` would
# have worked from. The result is orphan AWS resources with no way to reach
# them, which is precisely the hazard the two modes above exist to avoid.
#
# The correct form captures the destroy's OWN status and gates on BOTH:
#
#     ${CDKD} destroy "${STACK}" ... 2>&1 | tail -5 || true
#     destroy_rc=${PIPESTATUS[0]}
#     ...
#     if [ "${rc}" -eq 0 ] && [ "${destroy_rc}" -eq 0 ]; then
#       s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" all || true
#       s3_assert_versions_swept  "${STATE_BUCKET}" "${PREFIX}" "..."
#     else
#       s3_purge_prefix_versions "${STATE_BUCKET}" "${PREFIX}" noncurrent || true
#     fi
#
# `${PIPESTATUS[0]}` rather than `$?`: the pipe to `tail` is what hid the
# failure in the first place, so reading the wrong status reproduces the bug
# inside the fix. The capture must sit on the line IMMEDIATELY after the
# pipeline -- any command in between overwrites PIPESTATUS. (Measured on bash
# 3.2 and 5.x: a trailing `|| true` does NOT clobber PIPESTATUS, so the house
# belt-and-braces form is safe to keep.)
#
# MOST CALLERS DO NOT NEED THIS, and that is why the rule is stated rather than
# assumed. Of the sixteen fixtures sourcing this file, fourteen purge `all` on
# the SUCCESS PATH -- after an UNPIPED, `set -e`-guarded destroy that simply
# cannot be reached if it failed -- and purge only `noncurrent` from `cleanup`.
# That shape needs no status capture at all. The rule binds for the two whose
# `cleanup` ITSELF chooses between the modes (`local-run-task-from-state` and
# `rollback-cross-region-secret`), because `cleanup` runs under `set +e` on
# every exit path and therefore knows nothing unless it asks.
# `tests/unit/scripts/integ-s3-versions-harness.test.ts` enforces this.
#
# The retry loop is insurance against any future truncation of the listing:
# a sweep that is only ever measured by its own listing cannot tell "I am
# done" from "I was handed a short page". It exits as soon as a pass sees
# nothing, so the normal cost is one extra LIST.
s3_purge_prefix_versions() {
  local bucket="$1" prefix="$2" mode="${3:-all}" query pass rows
  [ -n "${bucket}" ] || return 0
  _s3v_check_prefix "${prefix}" || return 1
  query="$(_s3v_prefix_query "${mode}")"
  for pass in 1 2 3 4 5; do
    rows="$(_s3v_rows "${bucket}" "${prefix}" "${query}")" || return 1
    [ -n "${rows}" ] || return 0
    printf '%s\n' "${rows}" | _s3v_delete_rows "${bucket}"
  done
  return 0
}

# s3_purge_key_versions <bucket> <key> [noncurrent] - same, scoped to ONE key.
# Use when the sweep runs MID-RUN and a sibling key under the same prefix must
# survive.
s3_purge_key_versions() {
  local bucket="$1" key="$2" mode="${3:-all}" query pass rows
  [ -n "${bucket}" ] || return 0
  if [ -z "${key}" ]; then
    echo "FAIL: s3-versions: s3_purge_key_versions needs a key" >&2
    return 1
  fi
  query="$(_s3v_key_query "${key}" "${mode}")"
  for pass in 1 2 3 4 5; do
    rows="$(_s3v_rows "${bucket}" "${key}" "${query}")" || return 1
    [ -n "${rows}" ] || return 0
    printf '%s\n' "${rows}" | _s3v_delete_rows "${bucket}"
  done
  return 0
}

# s3_count_versions <bucket> <prefix> [noncurrent] - print the number of
# surviving versions + delete markers. Returns 1 if the prefix is malformed OR
# the LIST failed, so a caller can tell "zero" from "could not tell" (the same
# tri-state the gone_probe helpers use). Counts ROWS, never `length()` - trap 3.
#
# The prefix check is NOT only a purge-path concern, even though nothing here
# deletes. `cdkd///` lists nothing, so without it this returns a truthful 0 for
# a prefix that names no stack, and `s3_assert_versions_swept` below then
# announces a clean teardown for a bucket it never really looked at. A refusing
# purge cannot abort its caller either - MOST wrap it in `|| true`, and the three
# that do not (nested-stack-secret twice, stack-lock-renewal) sit inside
# `cleanup` under `set +e`, so the effect is the same - and a mis-derived prefix
# would print the purge's refusal to stderr and still let the run PASS, which is
# precisely the vacuous green this file exists to remove.
s3_count_versions() {
  local bucket="$1" prefix="$2" mode="${3:-all}" rows
  _s3v_check_prefix "${prefix}" || return 1
  rows="$(_s3v_rows "${bucket}" "${prefix}" "$(_s3v_prefix_query "${mode}")")" || return 1
  printf '%s\n' "${rows}" | awk 'NF{n++} END{print n+0}'
  return 0
}

# s3_count_key_versions <bucket> <key> [noncurrent] - the number of surviving
# versions + delete markers for ONE key. Same tri-state as s3_count_versions:
# returns 1 when the key is empty OR the LIST failed, so a caller can tell
# "zero" from "could not tell". Counts ROWS, never `length()` - trap 3.
s3_count_key_versions() {
  local bucket="$1" key="$2" mode="${3:-all}" rows
  if [ -z "${key}" ]; then
    echo "FAIL: s3-versions: s3_count_key_versions needs a key" >&2
    return 1
  fi
  rows="$(_s3v_rows "${bucket}" "${key}" "$(_s3v_key_query "${key}" "${mode}")")" || return 1
  printf '%s\n' "${rows}" | awk 'NF{n++} END{print n+0}'
  return 0
}

# s3_assert_key_versions_swept <bucket> <key> [mode] [description]
#
# The KEY-scoped twin of s3_assert_versions_swept, for a key this fixture does
# not exclusively own - the shared exports index being the case that forced it.
# MODE MATTERS AND DEFAULTS TO noncurrent HERE, the opposite of the prefix
# assertion's default: a shared key's CURRENT object belongs to whoever wrote it
# last and must survive, so what this certifies is that no HISTORICAL version
# this run wrote is left behind. Asserting `all` on a shared key would demand a
# state no correct run can reach.
s3_assert_key_versions_swept() {
  local bucket="$1" key="$2" mode="${3:-noncurrent}" desc="${4:-key teardown}" n
  if ! n="$(s3_count_key_versions "${bucket}" "${key}" "${mode}")"; then
    echo "FAIL: ${desc}: could not count ${mode} versions of s3://${bucket}/${key}." >&2
    echo "      An unverified sweep is not a clean teardown - failing rather than assuming." >&2
    exit 1
  fi
  if [ "${n}" -ne 0 ]; then
    echo "FAIL: ${desc}: ${n} ${mode} version(s) survive for s3://${bucket}/${key}." >&2
    echo "      Inspect with:" >&2
    echo "        aws s3api list-object-versions --bucket ${bucket} --prefix ${key}" >&2
    exit 1
  fi
  echo "    OK: ${desc}: 0 ${mode} versions for s3://${bucket}/${key}"
}

# s3_assert_versions_swept <bucket> <prefix> [description]
#
# HARD-FAILS the run when anything survives. This is the point of the file:
# issue #2096 regressed silently precisely because the fixtures asserted on
# the CURRENT object ("state file is gone") and never on what the bucket
# still held. A sweep with no assertion is indistinguishable from no sweep.
# Call it on the SUCCESS path, as the LAST thing that looks at the bucket.
s3_assert_versions_swept() {
  local bucket="$1" prefix="$2" desc="${3:-state teardown}" n
  # Checked HERE as well as inside s3_count_versions, so the failure names the
  # assertion's own description rather than surfacing as a bare helper WARN.
  if ! _s3v_check_prefix "${prefix}"; then
    echo "FAIL: ${desc}: refusing to certify a teardown against the malformed prefix '${prefix}'." >&2
    echo "      A prefix that names no stack lists nothing, so the count would be a truthful 0" >&2
    echo "      about the wrong key space - a vacuous pass, which is the failure this assertion exists to catch." >&2
    exit 1
  fi
  if ! n="$(s3_count_versions "${bucket}" "${prefix}")"; then
    echo "FAIL: ${desc}: could not list object versions under s3://${bucket}/${prefix}." >&2
    echo "      An unverified sweep is not a clean teardown - failing rather than assuming." >&2
    exit 1
  fi
  if [ "${n}" -ne 0 ]; then
    echo "FAIL: ${desc}: ${n} object version(s)/delete marker(s) survive under s3://${bucket}/${prefix}." >&2
    echo "      The state bucket is VERSIONED, so 'aws s3 rm' only wrote a delete marker: everything" >&2
    echo "      this fixture ever put in state - including any seeded secret plaintext - is still" >&2
    echo "      readable via GetObjectVersion. Inspect with:" >&2
    echo "        aws s3api list-object-versions --bucket ${bucket} --prefix ${prefix}" >&2
    exit 1
  fi
  echo "    OK: ${desc}: 0 surviving object versions under s3://${bucket}/${prefix}"
}
