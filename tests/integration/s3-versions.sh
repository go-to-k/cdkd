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
_s3v_rows() {
  local bucket="$1" scope="$2" query="$3" rows
  if ! rows="$(aws s3api list-object-versions --bucket "${bucket}" \
      --prefix "${scope}" --query "${query}" --output text 2>&1)"; then
    echo "WARN: s3-versions: could not list versions under s3://${bucket}/${scope}: ${rows}" >&2
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

# _s3v_delete_rows <bucket> - read "<key><TAB><versionId>" rows on stdin and
# delete each. See trap 2 above for why the caller must feed this with
# `printf '%s\n'` and why the `|| [ -n "${key}" ]` guard is here as well.
_s3v_delete_rows() {
  local bucket="$1" key vid
  while IFS=$'\t' read -r key vid || [ -n "${key}" ]; do
    if [ -z "${key}" ] || [ -z "${vid}" ]; then continue; fi
    if [ "${vid}" = "None" ]; then continue; fi
    aws s3api delete-object --bucket "${bucket}" --key "${key}" \
      --version-id "${vid}" >/dev/null 2>&1 || true
  done
}

# --- public API -------------------------------------------------------------

# s3_stack_prefix <stack> <region> - the key space one cdkd stack owns.
# Covers state.json, lock.json, rollback-journal.json and deployments/**; the
# trailing '/' is what keeps `CdkdFoo` from matching `CdkdFooBar`.
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
# surviving versions + delete markers. Returns 1 if the LIST failed, so a
# caller can tell "zero" from "could not tell" (the same tri-state the
# gone_probe helpers use). Counts ROWS, never `length()` - see trap 3.
s3_count_versions() {
  local bucket="$1" prefix="$2" mode="${3:-all}" rows
  rows="$(_s3v_rows "${bucket}" "${prefix}" "$(_s3v_prefix_query "${mode}")")" || return 1
  printf '%s\n' "${rows}" | awk 'NF{n++} END{print n+0}'
  return 0
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
