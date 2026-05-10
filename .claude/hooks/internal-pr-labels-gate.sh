#!/usr/bin/env bash
# internal-pr-labels-gate.sh
#
# PreToolUse hook. Blocks `git commit` when staged user-facing
# documentation files (README.md, docs/*.md) contain internal
# development-phase labels like `(PR 8b)` / `(PR 6 of #224)` /
# `(PR 6 of #224, issue #232)` in added/modified diff lines.
#
# WHY: PR #251 cleaned up README and docs/cli-reference.md of internal
# dev labels mirrored from agent dispatch prompts ("PR 8b" / "PR 6 of
# #224") into user-facing prose like:
#   ## Container Lambdas (PR 5 of #224)
#   ### Lambda Layers (PR 6 of #224, issue #232)
# These labels confuse end-users who don't track cdkd's internal PR
# roadmap. The existing pr-body-item-number-gate.sh catches `#N`
# autolinks in PR body files; this hook is the complementary check
# for prose-style labels in user-facing source code.
#
# Scope:
#   - Only fires on `git commit` (passes through everything else).
#   - Only inspects staged user-facing docs: README.md + docs/*.md
#     (recursive). CLAUDE.md is excluded (developer-facing, internal
#     labels are expected per project convention).
#     tests/integration/**/README.md is excluded (integ fixture
#     metadata). Anything under .claude/** is excluded.
#   - Only flags added/modified lines (diff lines starting with '+',
#     excluding the '+++' file marker).
#
# Allowed patterns (NOT blocked):
#   - `(#N)` style parenthetical issue/PR refs (handled by
#     pr-body-item-number-gate.sh for body files; here it's just
#     not the target).
#   - `closes #N` / `Refs: #N` and similar conventional refs.
#   - Fenced code blocks (between matching ``` lines).
#   - Inline code spans (single backtick segments).
#
# No bypass marker — the fix is trivial (delete the label). Users who
# genuinely need an internal label in a doc can split the commit.
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / provider-docs-gate.sh.

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

# Get the list of staged files (added or modified, not deleted).
staged_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=AM 2>/dev/null || true)
if [[ -z "$staged_files" ]]; then
  exit 0
fi

# Filter to user-facing docs only.
#   include: README.md (top-level), docs/**/*.md
#   exclude: CLAUDE.md, tests/integration/**/README.md, .claude/**
should_scan() {
  local f="$1"
  # Exclude .claude/ tree entirely + any CLAUDE.md anywhere + integ
  # fixture READMEs (which often reference their own implementation
  # PR numbers in prose).
  case "$f" in
    .claude/*) return 1 ;;
    CLAUDE.md|*/CLAUDE.md) return 1 ;;
    tests/integration/*) [[ "$f" == */README.md ]] && return 1 ;;
  esac
  # Include README.md at the repo root and any .md under docs/.
  case "$f" in
    README.md) return 0 ;;
    docs/*) [[ "$f" == *.md ]] && return 0 ;;
  esac
  return 1
}

# Strip fenced code blocks and inline code spans from a single line.
# Multi-line fences are handled at the diff-walk layer (we maintain
# in_fence across lines). Returns the cleaned line on stdout.
strip_inline_code() {
  local line="$1"
  # Strip backtick-quoted code spans (single backtick form).
  printf '%s' "$line" | perl -pe 's|`[^`]*`||g'
}

# Detect if a stripped, added line contains a blocked internal label.
# Patterns:
#   \(PR \d+[a-z]?\)                          e.g. (PR 8b), (PR 5)
#   \(PR \d+[a-z]?\s+of\s+#\d+(,\s*issue\s*#\d+)?\)
#                                              e.g. (PR 6 of #224)
#                                                   (PR 6 of #224, issue #232)
#   bare `PR \d+[a-z]?\s+of\s+#\d+`           outside of parens
#
# Returns the offender substring on stdout if found.
find_offender() {
  local line="$1"
  printf '%s' "$line" | perl -ne '
    # (PR 6 of #224, issue #232) or (PR 6 of #224)
    if (/(\(PR\s+\d+[a-z]?\s+of\s+#\d+(?:\s*,\s*issue\s*#\d+)?\))/i) {
      print "$1\n"; exit;
    }
    # (PR 8b) / (PR 5) / (PR 8a of ...) — paren-anchored bare PR token.
    if (/(\(PR\s+\d+[a-z]?(?:[^)]*)?\))/i) {
      my $hit = $1;
      # Skip URL-like content that may have ended up inside parens.
      next if $hit =~ m|https?://|i;
      print "$hit\n"; exit;
    }
    # Bare `PR \d+[a-z]? of #\d+` outside parens.
    if (/(\bPR\s+\d+[a-z]?\s+of\s+#\d+\b)/i) {
      print "$1\n"; exit;
    }
  '
}

declare -a OFFENDERS=()
MAX_REPORT=20

# Walk each filtered file's staged diff, tracking fenced-block state
# across lines (a fence opened in the file but unchanged in the diff
# would still hide content; but since we only inspect '+' lines, the
# state we care about is "is this '+' line inside a fence that the
# diff also added?". We approximate by reading the staged blob and
# walking its line numbers, then for each line check whether (a) it
# was added in the staged diff and (b) it's inside a fenced block in
# the staged version of the file.

scan_file() {
  local rel="$1"
  # Pull the staged contents (post-commit shape).
  local staged
  staged=$(git -C "$target_dir" show ":$rel" 2>/dev/null || true)
  [[ -z "$staged" ]] && return 0

  # Pull the set of line numbers that were added in the staged diff
  # for this file. We use `git diff --cached --unified=0` to get one
  # hunk per added line; the `@@` headers give us the new-file
  # starting line + count.
  local diff
  diff=$(git -C "$target_dir" diff --cached --unified=0 -- "$rel" 2>/dev/null || true)
  [[ -z "$diff" ]] && return 0

  # Build a set of added line numbers (in the new-file coordinate).
  # Uses perl rather than awk so POSIX / BSD awk on macOS works (BSD
  # awk lacks GNU awk's 3-arg match() form for the @@ -a,b +c,d @@
  # hunk header parse).
  local added_lines
  added_lines=$(printf '%s\n' "$diff" | perl -ne '
    if (/^\@\@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? \@\@/) {
      $base = $1 + 0;
      $offset = 0;
      $inhunk = 1;
      next;
    }
    next unless $inhunk;
    if (/^\+\+\+/) { next; }
    if (/^---/)    { next; }
    if (/^\+/)     { print +($base + $offset), "\n"; $offset++; next; }
    if (/^-/)      { next; }
    if (/^ /)      { $offset++; next; }
  ')

  [[ -z "$added_lines" ]] && return 0

  # Flatten the added-lines list to a comma-joined string so we can
  # pass it as a single awk -v argument (BSD awk does not like
  # newlines embedded in -v values).
  local added_csv
  added_csv=$(printf '%s' "$added_lines" | tr '\n' ',' | sed 's/,$//')

  # Walk the staged blob line-by-line, tracking fence state and
  # checking each line that's in the added-lines set.
  printf '%s' "$staged" | awk -v added="$added_csv" '
    BEGIN {
      n = split(added, arr, ",")
      for (i = 1; i <= n; i++) {
        if (arr[i] != "") added_set[arr[i] + 0] = 1
      }
      in_fence = 0
    }
    {
      lineno = NR
      # Toggle fence state on lines starting with ```.
      if ($0 ~ /^[[:space:]]*```/) {
        in_fence = !in_fence
        next
      }
      if (in_fence) next
      if (lineno in added_set) {
        # Emit the line for downstream processing, with the line number
        # prefix so we can report it.
        printf "%d\t%s\n", lineno, $0
      }
    }
  '
}

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  if ! should_scan "$f"; then
    continue
  fi

  while IFS=$'\t' read -r ln content; do
    [[ -z "$ln" ]] && continue
    # Strip backtick code spans before regex matching.
    cleaned=$(strip_inline_code "$content")
    hit=$(find_offender "$cleaned")
    if [[ -n "$hit" ]]; then
      OFFENDERS+=("$f:$ln:$hit:$content")
      if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
        break 2
      fi
    fi
  done < <(scan_file "$f")
done <<< "$staged_files"

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

{
  echo "${RED_BOLD}Blocked by internal-pr-labels-gate:${RESET}"
  echo
  echo "Staged user-facing doc contains internal development-phase labels"
  echo "('(PR 8b)' / '(PR 6 of #224, issue #232)' / etc.) in added/modified"
  echo "lines. These labels make sense for CLAUDE.md / commit messages but"
  echo "confuse end-users who don't track cdkd's internal PR roadmap."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    file="${entry%%:*}"
    rest="${entry#*:}"
    ln="${rest%%:*}"
    rest="${rest#*:}"
    # Everything after the third ':' is the offending line content.
    content="${rest#*:}"
    echo "  $file:$ln: $content"
  done
  echo
  echo "Fix:"
  echo "  - Drop the parenthetical label: '## Container Lambdas (PR 5 of #224)'"
  echo "    -> '## Container Lambdas'"
  echo "  - For dev-facing context like 'this feature ships in PR 8b', move it"
  echo "    to CLAUDE.md (which is excluded from this hook)."
  echo
  echo "Memory: ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_body_no_hash_for_item_numbers.md"
} >&2

exit 2
