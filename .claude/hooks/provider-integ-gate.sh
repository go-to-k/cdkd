#!/usr/bin/env bash
# provider-integ-gate.sh
#
# PreToolUse hook. Blocks `git commit` when newly-added
# `registry.register('AWS::Service::Type', ...)` lines in
# `src/provisioning/register-providers.ts` lack a matching staged
# integration test fixture under `tests/integration/<name>/lib/*.ts`
# or `tests/integration/<name>/bin/*.ts`.
#
# WHY: A new SDK Provider can be merged today with unit tests + docs
# but NO real-AWS verification. The existing roundtrip-test-gate +
# provider-docs-gate enforce unit tests + docs entries respectively;
# this hook closes the structural gap that lets a provider live in
# production for months without an integ test ever exercising it
# against real AWS. See issue #392.
#
# Detection: a registered type AWS::Foo::Bar is considered "covered"
# in this commit when ONE of the staged integ files contains:
#
#   1. The literal string 'AWS::Foo::Bar' (covers CfnResource and
#      addPropertyOverride patterns + explicit type-id documentation
#      in comments).
#   2. The L1 class name `Cfn<Bar>(` (covers `new <ns>.CfnBar(...)`
#      L1 construct usage).
#
# Pure-L2 fixtures (e.g. `new sqs.Queue(...)` -> AWS::SQS::Queue) are
# NOT auto-detected by the shell hook — the L1/literal signals above
# are the rigorous-but-cheap tier. When a contributor genuinely wants
# to back a pure-L2 fixture, they can either:
#   - leave a comment in the fixture that contains the literal
#     `AWS::Foo::Bar` (one line documenting what the fixture covers
#     is good practice anyway), OR
#   - mark the registration line with `// allow-no-integ: <reason>`.
#
# The richer L2 lookup happens in `scripts/build-integ-coverage-matrix.ts`
# which contributors run via `vp run integ-coverage` to refresh
# `docs/integ-coverage.md`. The shell hook deliberately stays simple.
#
# Carve-out: each entry in `.claude/integ-coverage-allowlist.json`
# (key = `AWS::Service::Type`, value = non-empty rationale string)
# exempts that registration from the gate. The sidecar file lives
# outside `src/provisioning/register-providers.ts` so that allow-list
# updates do not trigger the integ-broad gate (which would force a
# real-AWS broad integ run on every metadata edit).
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only fires when register-providers.ts has staged diff lines
#     introducing a new `registry.register('AWS::...'` call.
#   - Refactor-only diffs (remove + re-add same type) pass through.
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / provider-docs-gate.sh / roundtrip-test-gate.sh.

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

# If the resolved target dir is not a git repo, silently pass — we
# can't audit what we can't see (mirrors branch-gate.sh).
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

REG_FILE="src/provisioning/register-providers.ts"

# Pull the staged diff for register-providers.ts. If the file isn't
# staged, nothing to check.
diff=$(git -C "$target_dir" diff --cached -- "$REG_FILE" 2>/dev/null || true)
if [[ -z "$diff" ]]; then
  exit 0
fi

# Collect the resource types being ADDED and REMOVED. A type that is
# both removed and re-added in the same diff is a no-op refactor and
# should not trigger the gate.
extract_types() {
  local prefix="$1" diff_text="$2"
  printf '%s\n' "$diff_text" \
    | grep -E "^${prefix} *registry\.register\(['\"]AWS::[A-Za-z0-9]+::[A-Za-z0-9]+['\"]" \
    | sed -E "s/^${prefix} *registry\.register\(['\"](AWS::[A-Za-z0-9]+::[A-Za-z0-9]+)['\"].*/\1/" \
    | sort -u
}

added_types=$(extract_types '\+' "$diff")
removed_types=$(extract_types '-' "$diff")

if [[ -z "$added_types" ]]; then
  exit 0
fi

# Subtract: only types in added but NOT in removed are net-new.
net_new=$(comm -23 <(printf '%s\n' "$added_types") <(printf '%s\n' "$removed_types"))
if [[ -z "$net_new" ]]; then
  exit 0
fi

# Build the set of allow-no-integ types from the sidecar
# `.claude/integ-coverage-allowlist.json`. Each non-`$`-prefixed key
# is the AWS resource type; the value (non-empty string) is the
# rationale. Match the matrix script's parser exactly.
ALLOWLIST_FILE=".claude/integ-coverage-allowlist.json"
allowlist_staged=$(git -C "$target_dir" diff --cached --name-only -- "$ALLOWLIST_FILE" 2>/dev/null || true)
if [[ -n "$allowlist_staged" ]]; then
  # Staged blob is what would be in the working tree post-commit.
  allowlist_blob=$(git -C "$target_dir" show ":$ALLOWLIST_FILE" 2>/dev/null || true)
else
  allowlist_blob=$(git -C "$target_dir" show "HEAD:$ALLOWLIST_FILE" 2>/dev/null || true)
fi

# Parse the allow-list via `jq`. cdkd's hooks require `jq` globally —
# the input-payload parser at the top of this file already calls
# `jq -r '.tool_input.command'`, so a no-jq install would silently
# fail at the input-parsing step (cmd="" → grep miss → exit 0
# pass-through) and never reach this allow-list parser. Earlier
# revisions of this hook carried a regex-grep fallback for "jq
# missing"; removed in the PR #404 cleanup since (a) it was untestable
# (PATH strip kills input parsing first), (b) it was speculative
# defense-in-depth with no real failure mode the rest of the hook
# would notice, and (c) keeping two parsers in sync is its own
# correctness risk.
#
# Rationale validity rule: non-empty string after
# `gsub("^\\s+|\\s+$"; "")` — whitespace-only does NOT exempt the
# type. Keys starting with `$` are documentation metadata
# (`$schema-doc`, `$why-sidecar`) and are skipped. Mirrors the
# matrix script's `parseAllowNoIntegRationalesContent` in
# scripts/build-integ-coverage-matrix.ts so the two parsers agree
# on what counts as allow-listed.
if [[ -n "$allowlist_blob" ]]; then
  allow_listed=$(printf '%s' "$allowlist_blob" \
    | jq -r 'to_entries
        | map(select(.key | startswith("$") | not))
        | map(select(.value | type == "string" and (. | gsub("^\\s+|\\s+$"; "") | length > 0)))
        | .[].key' 2>/dev/null \
    | sort -u)
else
  allow_listed=""
fi

# Read the staged blob of every tests/integration/*/lib/*.ts and
# tests/integration/*/bin/*.ts file. Use staged content (post-commit
# state) when staged, fall back to the tracked version otherwise.
# Include both NEW files (status=A) and modified files (M) in the
# staged set, so a contributor can satisfy the gate by adding a fresh
# fixture in the same commit.
staged_integ_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=ACMR \
  -- 'tests/integration/*/lib/*.ts' 'tests/integration/*/bin/*.ts' 2>/dev/null \
  | sort -u)

# We also accept any tests/integration file already tracked in HEAD
# (= a previously-existing fixture that already covers the type). The
# gate's purpose is "is the type exercised by ANY integ", not "is the
# type exercised by an integ in THIS commit".
tracked_integ_files=$(git -C "$target_dir" ls-files 'tests/integration/*/lib/*.ts' 'tests/integration/*/bin/*.ts' 2>/dev/null | sort -u)

read_file_blob() {
  local rel="$1"
  # Prefer the staged blob (covers freshly-added fixtures and edits to
  # existing ones); fall back to HEAD for tracked-but-unstaged files.
  if printf '%s\n' "$staged_integ_files" | grep -qFx -- "$rel"; then
    git -C "$target_dir" show ":$rel" 2>/dev/null || true
  else
    git -C "$target_dir" show "HEAD:$rel" 2>/dev/null || true
  fi
}

# Combine staged + tracked into the search corpus.
all_integ_files=$(printf '%s\n%s\n' "$staged_integ_files" "$tracked_integ_files" | sort -u | grep -v '^$' || true)

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

# For each net-new type, check coverage by per-type scan over the
# staged+tracked integ file set; first hit wins. The inner loop calls
# `git show` once per (file, type) pair until a match — O(types × files)
# but bounded: net-new types per commit is typically 1-2, and "files"
# is roughly the integ-fixture count (currently ~88). Per-commit cost
# stays in single-digit seconds, acceptable for a commit hook.
violations=()
while IFS= read -r type; do
  [[ -z "$type" ]] && continue

  # Allow-listed via per-line carve-out comment.
  if printf '%s\n' "$allow_listed" | grep -qFx -- "$type"; then
    continue
  fi

  # Compute the L1 class name: AWS::Service::TypeName -> CfnTypeName.
  # The L1 form is `new <ns>.Cfn<TypeName>(`, so the search needle is
  # the partial `Cfn<TypeName>(` — anchored on `(` to avoid matching
  # CfnTypeNameProps and similar.
  cfn_class=$(printf '%s\n' "$type" | sed -E 's/^AWS::[A-Za-z0-9]+:://')
  cfn_needle="Cfn${cfn_class}("

  found=""
  while IFS= read -r f; do
    [[ -z "$f" ]] && continue
    blob=$(read_file_blob "$f")
    if [[ -z "$blob" ]]; then continue; fi
    if printf '%s' "$blob" | grep -qF -- "$type"; then
      found="$f"
      break
    fi
    if printf '%s' "$blob" | grep -qF -- "$cfn_needle"; then
      found="$f"
      break
    fi
  done <<< "$all_integ_files"

  if [[ -z "$found" ]]; then
    violations+=("$type")
  fi
done <<< "$net_new"

if [[ ${#violations[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo "${RED_BOLD}Blocked by provider-integ-gate: new SDK provider registration missing integ coverage.${RESET}"
  echo
  echo "Every new resource type registered in src/provisioning/register-providers.ts"
  echo "must be exercised by at least one fixture under tests/integration/. Today's"
  echo "freshness-only integ-destroy / integ-broad / integ-local gates check that"
  echo "SOMETHING ran against real AWS recently — they don't check whether ANY integ"
  echo "covers the code path you just added. A provider can otherwise live in"
  echo "production for months without ever being verified end-to-end. See issue #392."
  echo
  echo "Missing integ coverage:"
  for v in "${violations[@]}"; do
    cfn_class=$(printf '%s\n' "$v" | sed -E 's/^AWS::[A-Za-z0-9]+:://')
    echo "  - $v"
    echo "      detected by ANY of:"
    echo "        - the literal string '$v' anywhere in tests/integration/<name>/lib/*.ts or bin/*.ts"
    echo "        - the L1 class 'Cfn${cfn_class}(' (i.e. 'new <ns>.Cfn${cfn_class}(...)')"
  done
  echo
  echo "Resolution paths (any one is sufficient per type):"
  echo
  echo "  1. Add a fixture covering the type. Either:"
  echo "       - extend an existing tests/integration/<name>/lib/*.ts to use the"
  echo "         L1 construct (e.g. 'new ns.${cfn_class}(this, \"X\", { ... })'), or"
  echo "       - scaffold a new fixture via /new-integ <name> and reference the type"
  echo "         literally in the lib file."
  echo
  echo "  2. The integ already exists but uses an L2 construct the gate can't see"
  echo "     (e.g. 'new sqs.Queue(...)' -> AWS::SQS::Queue). Add a one-line comment"
  echo "     to the fixture file that mentions the literal type id, e.g.:"
  echo "       // covers: ${violations[0]}"
  echo "     This also keeps docs/integ-coverage.md grep-friendly."
  echo
  echo "  3. The registration is intentionally not integ-tested (e.g. a CC-API"
  echo "     fallback or a sub-resource wired through another type's flow). Add"
  echo "     an entry to the sidecar .claude/integ-coverage-allowlist.json with a"
  echo "     non-empty rationale string:"
  echo "       \"${violations[0]}\": \"covered transitively via AWS::Foo::Bar\""
  echo "     (sidecar lives outside register-providers.ts so allow-list edits"
  echo "      do not trigger the integ-broad gate.)"
  echo
  echo "Run 'node --experimental-strip-types scripts/build-integ-coverage-matrix.ts'"
  echo "to refresh docs/integ-coverage.md and verify the new fixture is picked up."
} >&2

exit 2
