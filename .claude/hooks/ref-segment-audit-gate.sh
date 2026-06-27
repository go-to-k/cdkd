#!/usr/bin/env bash
# ref-segment-audit-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a newly-added entry in the
# `REF_RETURNS_SEGMENT_AFTER_PIPE` Set in
# `src/deployment/intrinsic-function-resolver.ts` lacks a matching staged /
# tracked unit test that references the type literal.
#
# WHY: that Set lists Cloud-Control-provisioned resource types whose compound
# physicalId (`<parent>|<child>`) must have its CFn `Ref` resolved to the
# trailing `<child>` segment. Getting an entry WRONG (or omitting a sibling
# in the same service family) ships a latent bug where `Ref` leaks the whole
# compound id and AWS rejects the downstream resource (the
# `AWS::Cognito::UserPoolResourceServer` bug, PR #930). The maintenance
# comment above the Set already says "AUDIT THE WHOLE SERVICE FAMILY ... pin
# each addition with a unit test" — this hook is the mechanical enforcement of
# the unit-test half, and the block message re-states the family-audit half
# (which is judgmental and cannot be checked mechanically).
#
# Detection: a type 'AWS::Foo::Bar' added to the Set is "covered" when any
# staged-or-tracked file under tests/unit/deployment/ contains the literal
# string 'AWS::Foo::Bar'.
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only fires when intrinsic-function-resolver.ts has a staged diff adding
#     a bare 'AWS::...' string-literal array element (the Set-entry shape).
#   - Refactor-only diffs (remove + re-add same type) pass through.
#
# git-cwd resolution mirrors provider-integ-gate.sh / branch-gate.sh.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\bcommit\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `git -C <path>` wins.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

RESOLVER_FILE="src/deployment/intrinsic-function-resolver.ts"

diff=$(git -C "$target_dir" diff --cached -- "$RESOLVER_FILE" 2>/dev/null || true)
if [[ -z "$diff" ]]; then
  exit 0
fi

# Collect bare 'AWS::Service::Type' string-literal array elements being
# ADDED / REMOVED. The Set entries are one-per-line `  'AWS::Foo::Bar',`;
# code uses of a type literal carry more context on the line, so anchoring on
# a near-bare line keeps this to genuine Set additions.
extract_types() {
  local prefix="$1" diff_text="$2"
  printf '%s\n' "$diff_text" \
    | grep -E "^${prefix}[[:space:]]*['\"]AWS::[A-Za-z0-9]+::[A-Za-z0-9]+['\"],?[[:space:]]*$" \
    | sed -E "s/.*['\"](AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)['\"].*/\1/" \
    | sort -u
}

added_types=$(extract_types '\+' "$diff")
removed_types=$(extract_types '-' "$diff")

if [[ -z "$added_types" ]]; then
  exit 0
fi

net_new=$(comm -23 <(printf '%s\n' "$added_types") <(printf '%s\n' "$removed_types"))
net_new=$(printf '%s\n' "$net_new" | grep -vE '^[[:space:]]*$' || true)
if [[ -z "$net_new" ]]; then
  exit 0
fi

# Build the corpus of unit-test text under tests/unit/deployment/ (staged
# blobs preferred; fall back to tracked HEAD content).
staged_test_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=ACMR \
  -- 'tests/unit/deployment/*' 2>/dev/null | sort -u)
tracked_test_files=$(git -C "$target_dir" ls-files 'tests/unit/deployment/*' 2>/dev/null | sort -u)
all_test_files=$(printf '%s\n%s\n' "$staged_test_files" "$tracked_test_files" \
  | grep -vE '^[[:space:]]*$' | sort -u)

read_test_blob() {
  local rel="$1"
  if printf '%s\n' "$staged_test_files" | grep -qFx -- "$rel"; then
    git -C "$target_dir" show ":$rel" 2>/dev/null || true
  else
    git -C "$target_dir" show "HEAD:$rel" 2>/dev/null || true
  fi
}

test_corpus=""
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  test_corpus+=$(read_test_blob "$f")
  test_corpus+=$'\n'
done <<< "$all_test_files"

uncovered=""
while IFS= read -r t; do
  [[ -z "$t" ]] && continue
  if ! printf '%s' "$test_corpus" | grep -qF "$t"; then
    uncovered+="  - $t"$'\n'
  fi
done <<< "$net_new"

if [[ -z "$uncovered" ]]; then
  exit 0
fi

cat >&2 <<EOF
BLOCKED by ref-segment-audit-gate.

New entries were added to REF_RETURNS_SEGMENT_AFTER_PIPE in
$RESOLVER_FILE but have NO unit test under tests/unit/deployment/ that
references the type literal:

$uncovered
Each addition to that Set MUST:
  1. Be pinned by a unit test (e.g. in tests/unit/deployment/intrinsic-functions.test.ts)
     asserting Ref returns the trailing '<child>' segment of the CC compound id.
  2. Be the result of auditing the WHOLE service family, not just the one
     type a bug surfaced — CC compound-id types cluster by service:
       a. aws cloudformation describe-type --type RESOURCE --type-name AWS::<Svc>::<T>
          -> Schema.primaryIdentifier confirms it is compound + the segment order.
       b. Read the type's AWS-docs "Return values / Ref" — add ONLY if Ref
          returns the trailing <child> segment.
       c. EXCLUDE types whose Ref returns a synthetic / prefixed string.

Add the unit test(s) and re-commit. See the maintenance comment above the
Set definition for the full procedure.
EOF
exit 2
