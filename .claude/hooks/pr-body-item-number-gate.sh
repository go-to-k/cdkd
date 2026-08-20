#!/usr/bin/env bash
# pr-body-item-number-gate.sh
#
# PreToolUse hook. Blocks `gh pr create` / `gh pr edit` / `gh issue
# create` / `gh issue comment` / `gh api -X PATCH ... pulls|issues`
# invocations when the body file they pass via `--body-file <FILE>`
# (or `--field body=@<FILE>` / `-F body=@<FILE>`) contains `#N`
# tokens that GitHub will auto-link to issue/PR #N.
#
# This is the "review-fix #4 → linked to unrelated PR #4" trap. PR
# #237 (cdkd local start-api authorizers) shipped with `Must-fix #1`,
# `review-fix #4`, etc. in the body; GitHub's auto-link rendered each
# `#N` as a hyperlink to that issue/PR, which were 3-week-old
# unrelated changes. A reviewer clicked one, landed on the wrong PR,
# and asked "is this mixed into the release?"
#
# Memory:
#   ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_body_no_hash_for_item_numbers.md
#
# Detection rules:
#
#   ALLOWED (do NOT block):
#     - Issue-closing keywords (case-insensitive):
#         close[s]? #N, closed #N, fix[es]? #N, resolve[s]? #N
#       These are load-bearing for GitHub's auto-close behavior.
#     - Soft references: refs: #N, ref: #N, references #N, see #N
#     - Fully-qualified cross-repo refs: owner/repo#N. Unambiguous by
#       construction, and the form /work-issues section 10-c mandates
#       for every citation in the mirrored skill files.
#     - Parenthetical: (#N)   — used by squash-merge commit messages
#       like `feat(...): subject (#231)`.
#     - Inside fenced code blocks (between matching ``` lines).
#     - Inside markdown URLs: github.com/.../issues/N, /pull/N,
#       /commit/<sha>. These don't render as `#N` auto-links.
#
#   BLOCKED:
#     - Item-number prefixes: Must-fix #N, review-fix #N, decision #N,
#       step #N, item #N, point #N, number #N, bullet #N, entry #N
#       (case-insensitive).
#     - Plain `#N` in prose without an allow-listed prefix or context.
#
# Override: there is no marker-based bypass. The fix is trivial
# (replace `#N` with `N`); a bypass would defeat the gate. Users who
# need to bypass can pass the body inline via `--body 'foo'` (the
# hook only inspects `--body-file` / `body=@<file>` shapes).

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate gh invocations that pass a body file. Cheap pre-filter before the
# more expensive extraction, run through the shared matcher
# (.claude/hooks/_command-match.sh, issue #2129) so a chained invocation is seen
# and a quoted mention is not.
# shellcheck source=_command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_command-match.sh"
[ -r "$_gate_lib" ] || exit 0
. "$_gate_lib"
gate_matches "$cmd" "$GATE_RE_GH_BODY_CARRIER" || exit 0
if ! printf '%s' "$cmd" | grep -qE '(--body-file|body=@)'; then
  exit 0
fi

# Extract the body file path from the command. Two shapes to handle:
#   --body-file <PATH>      (gh pr create / gh issue create / etc.)
#   --body-file=<PATH>      (alternate form)
#   --field body=@<PATH>    (gh api long form)
#   -F body=@<PATH>         (gh api short form)
#   --field "body=@<PATH>"  (quoted)
#
# We want a single best-effort extraction. If multiple body files are
# referenced, scan all of them.

extract_files() {
  local cmd="$1"
  # Use perl to handle quoted args robustly. Output is one path per
  # line. perl's regex is more permissive than bash's, and we
  # collapse single/double quotes around the value.
  printf '%s' "$cmd" | perl -ne '
    while (/--body-file[=[:space:]]+(["\x27]?)([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
    while (/(?:--field|-F)[[:space:]]+(["\x27]?)body=@([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
  '
}

# Read a file's contents and emit only the lines (with line numbers,
# 1-indexed) that are subject to scanning — i.e. NOT inside fenced
# code blocks. URLs and code spans are filtered later inside the
# offender check.
strip_code_blocks() {
  awk '
    BEGIN { in_block = 0; lineno = 0 }
    {
      lineno++
      # A line whose trimmed form starts with ``` toggles the fence.
      if ($0 ~ /^[[:space:]]*```/) { in_block = !in_block; next }
      if (in_block) next
      printf "%d\t%s\n", lineno, $0
    }
  '
}

# Decide if a single line, after stripping URL contexts, contains a
# blocked `#N` token.
#
# Returns the FIRST blocked offender's surrounding text on stdout if
# found, empty otherwise. Exit code is 0 either way; the caller
# checks for empty output.
find_offender() {
  local line="$1"

  # 1. Strip URLs that contain /issues/N, /pull/N, /commit/<sha>, or
  #    just any http(s)://... URL — those have no `#N` auto-link.
  local stripped
  stripped=$(printf '%s' "$line" | perl -pe 's|https?://\S+| |g')

  # 2. Strip backtick-quoted code spans: `...`. The content of code
  #    spans isn't auto-linked by GitHub. Replace with a SPACE rather
  #    than deleting: a deleted span closes the gap between its
  #    neighbours, so `analyzer/resolver` + `` `.ts` `` + `#2` collapses
  #    into a slug-adjacent hit that the owner/repo arm below then
  #    allows -- while GitHub still renders the raw text as a live link
  #    to an unrelated PR. Same reason for the URL strip above.
  stripped=$(printf '%s' "$stripped" | perl -pe 's|`[^`]*`| |g')

  # 3. Find the first `#N` that is NOT preceded by an allowed context.
  #    We use perl with a single pass that captures `#N` plus a few
  #    chars of left context, then evaluate each match.
  printf '%s' "$stripped" | perl -ne '
    while (/(.{0,32}?)(#\d+)\b/g) {
      my $left = $1;
      my $hit = $2;
      # ALLOWED: parenthetical like "(#231)" — left ends in "(".
      next if $left =~ /\($/;
      # ALLOWED: issue-closing keyword immediately before. The
      # keyword MUST start at a word boundary that is NOT a hyphen
      # (so "Must-fix" / "review-fix" do NOT match "fix"). We
      # require the keyword to be preceded by start-of-string or
      # whitespace (not -, _, etc.).
      #   close, closes, closed, fix, fixes, fixed, resolve, resolves, resolved
      next if $left =~ /(?i)(?:^|\s)(close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s*$/;
      # ALLOWED: soft reference keywords.
      #   refs:, ref:, references, see
      next if $left =~ /(?i)(?:^|\s)(refs?:?|references|see)\s*$/;
      # ALLOWED: a fully-qualified cross-repo reference whose left
      # context ends in an owner/repo slug -- go-to-k/cdkd#1992. It
      # names its repo explicitly, so it cannot auto-link to the wrong
      # REPO. (It can still name the wrong ITEM in the right repo --
      # `review-fix go-to-k/cdkd#4` is allowed and does render a link --
      # so this arm narrows the trap rather than eliminating it; and /work-issues section 10-c mandates this form for every
      # citation the mirrored skill files carry, so blocking it put the
      # hook and the skill in direct contradiction.
      # Both slug segments must contain a letter, so an item number
      # written as a fraction ("step 1/2#3") stays blocked. The leading
      # boundary admits `(` and `[` as well as whitespace: a qualified ref
      # is very often parenthesised or a markdown link label, and requiring
      # whitespace rejected `(go-to-k/cdkd#1476)` -- found by writing the
      # body of the very PR that ships this arm, against the patched hook.
      # NOTE: no apostrophes in this block -- it sits inside a single-quoted
      # shell string, so one would terminate the perl program.
      next if $left =~ m{(?:^|[\s(\[])[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*/[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*$};
      # Otherwise: BLOCKED. Print the hit and the full line context.
      print "$hit\n";
      last;
    }
  '
}

# Collect offenders: "<file>:<lineno>:<line>" entries, one per blocked
# line. We surface up to a small cap so the error stays readable.
declare -a OFFENDERS=()
MAX_REPORT=10

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ ! -f "$f" ]] && continue

  while IFS=$'\t' read -r ln content; do
    [[ -z "$content" ]] && continue
    hit=$(find_offender "$content")
    if [[ -n "$hit" ]]; then
      OFFENDERS+=("$f:$ln: $content")
      if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
        break
      fi
    fi
  done < <(strip_code_blocks < "$f")

  if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
    break
  fi
done < <(extract_files "$cmd")

if [[ "${#OFFENDERS[@]}" -eq 0 ]]; then
  exit 0
fi

{
  echo "Blocked by pr-body-item-number-gate:"
  echo
  echo "Body file contains #N patterns that GitHub auto-links to issue/PR"
  echo "#N. This is the \"review-fix #4 → linked to unrelated PR #4\" trap."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    echo "  $entry"
  done
  echo
  echo "Fix:"
  echo "  - Item numbers: use bare numbers (e.g. 'Must-fix 1' not 'Must-fix #1')"
  echo "  - Real issue refs: keep 'closes #NNN' / '(#NNN)' / full URLs (allow-listed)"
  echo "  - Cross-repo refs: use the qualified 'owner/repo#NNN' form (allow-listed)"
  echo
  echo "Memory: ~/.claude/projects/-Users-goto-pc-github-cdkd/memory/feedback_pr_body_no_hash_for_item_numbers.md"
} >&2
exit 2
