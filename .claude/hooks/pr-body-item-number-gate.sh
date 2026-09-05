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
#     - Fully-qualified cross-repo refs: owner/repo#N, bare or wrapped
#       in markdown emphasis / quotes (**owner/repo#N**, "owner/repo#N").
#       Unambiguous by construction, and the form /work-issues section
#       10-c mandates for every citation in the mirrored skill files.
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
# (.claude/hooks/lib/command-match.sh, issue #2129) so a chained invocation is seen
# and a quoted mention is not.
# shellcheck source=lib/command-match.sh
_gate_lib="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/lib/command-match.sh"
# Fail CLOSED: a gate that cannot evaluate the command must not wave it through.
# `|| exit 0` silently disabled the gate whenever the library was unreadable or
# truncated, while ten of these files carried a comment claiming the opposite
# (go-to-k/cdkd#2130 review). The 18 gates that predate this convergence already
# exit 2 here; these now match them.
if [ ! -r "$_gate_lib" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unreadable, so this gate cannot evaluate the command." >&2
  exit 2
fi
# shellcheck source=/dev/null
. "$_gate_lib"
if ! declare -F gate_matches >/dev/null 2>&1; then
  echo "Blocked: .claude/hooks/lib/command-match.sh loaded but gate_matches is undefined (truncated file?)." >&2
  exit 2
fi
# `GATE_PERL_WORD` is the shared value class `extract_files` interpolates.
# Undefined, `$GW` becomes the EMPTY string, `($GW)` matches empty at every
# position, every extracted path is empty and the gate scans nothing -- a
# silent fail-open, so it fails CLOSED like the two checks above.
if [ -z "${GATE_PERL_WORD:-}" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh predates GATE_PERL_WORD, so this gate cannot extract a body path." >&2
  exit 2
fi
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
  # One path per line, through the SHARED `GATE_PERL_WORD` value class
  # (`$GW` = one shell WORD that may EMBED quoted spans; `gate_unq` = the
  # shell's own unquoting). The local `(["\x27]?)([^"\x27\s]+)\1` this
  # replaces ENUMERATED where a quote may sit and lost two families, both
  # measured 2026-09-05 against this hook, both FAIL-OPEN (an unextracted path
  # is a body nobody scans):
  #
  #   --body-file "<dir with space>/bad.md"   rc=0, plain spelling rc=2
  #   -F body=@<path>  glued as `-Fbody=@…`   rc=0
  #
  # This is the FIFTH site of one root cause; the other four are
  # gh-body-english / issue-dup-check / issue-deferral-criteria /
  # issue-classification-label. If you fix a path-extraction bug in any of
  # them, check the rest.
  #
  # KNOWN LIMIT, deliberately NOT closed here: a bare `-F <path>` (gh's short
  # `--body-file`) is still not extracted, and the arming grep above does not
  # even let it reach this function. The four siblings do read it, but they
  # scope their scan to the `gh` SEGMENT; this gate scans the WHOLE command, so
  # a bare `-F` arm would also read `git commit -F <msg>` and `awk -F ,` — and
  # this gate BLOCKS on what it FINDS, so a commit message mentioning `#4`
  # would become a false refusal. Closing it means segment-scoping first.
  printf '%s' "$cmd" | perl -ne "$GATE_PERL_WORD"'
    while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
    while (/(?:--field|--raw-field|-F)[=\s]*($GW)/g) {
      my $v = gate_unq($1);
      next unless $v =~ s/^body=\@//;
      print "$v\n";
    }
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
      # It also admits the MARKDOWN EMPHASIS and quoting characters * ~ |
      # and the double quote, for the same reason one hop later: a PR body
      # writes a qualified ref bolded far more often than bare, and
      # `**go-to-k/cdkd#2367**` was refused twice on 2026-08-29 by an
      # otherwise-correct body, with the gate error telling the author to use
      # the very form it had just blocked. None of these characters can occur
      # INSIDE a slug (the segment class is [A-Za-z0-9._-]), so widening the
      # boundary cannot admit a new item-number shape -- "step 1/2#3" is
      # still blocked by the letter requirement, bolded or not.
      # `_` is deliberately NOT here: it is already in the SEGMENT class, so
      # `_owner/repo#N` parses as a slug whose owner starts with an
      # underscore and was allowed before this widening. Adding it would be
      # dead -- measured by dropping each added character in turn and
      # re-running this hook test suite: * ~ | and the double quote each
      # redden a case, `_` reddens none.
      # NOTE: no apostrophes in this block -- it sits inside a single-quoted
      # shell string, so one would terminate the perl program.
      next if $left =~ m{(?:^|[\s(\[*~|"])[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*/[A-Za-z0-9._-]*[A-Za-z][A-Za-z0-9._-]*$};
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

# When the named body file cannot be READ, the HEREDOC BODY that writes it is
# extracted and scanned instead of skipping (go-to-k/cdkd#2397). The hook runs
# BEFORE the command does, so whenever the heredoc that writes the body and the
# `gh` call that consumes it sit in ONE Bash call -- the shape this repo
# mandates for `gh issue create`, which `gated-command-preamble-gate.sh`
# deliberately does not cover -- the path does not exist yet.
# `[[ ! -f "$f" ]] && continue` made that a SILENT PASS.
#
# NOT the whole command, which is what the first draft did and what this
# paragraph used to describe. `issue-dup-check-gate.sh` and
# `issue-classification-label-gate.sh` DO fall back to the command, and that is
# safe for them and not for this gate: they need one anchored marker to be
# PRESENT, so extra text can only make them pass, while this gate objects to
# content it FINDS, so extra text makes it BLOCK. Measured on that draft --
# `gh issue create --title 'follow-up to #2397 discussion' --body-file <absent>`
# went 0 -> 2, and so did
# `git commit -m 'address review #3' && gh pr create --body-file <clean>`. The
# retraction is argued in full at the extraction loop below; it is stated here
# too because this is where a reader arrives first, and two header comments
# describing the REJECTED draft sat 130 lines above the comment retracting it.
#
# Measured, and the evidence is a matched pair on ONE body text:
# go-to-k/cdk-real-drift#1841 was created by a single call carrying both the
# heredoc and the create command; its body holds bare `#1319` and `#1066`, and
# this gate did not fire. go-to-k/cdk-real-drift#1844 was attempted from a
# SEPARATE call while that same file still sat at the path, and the gate blocked
# quoting those two references back.
#
# A file that EXISTS is scanned too when the command rewrites it, because then
# what is on disk is the PREVIOUS body -- the other half of the same window, and
# the one that reads as a working gate while judging text nobody submitted.
# `cmd_writes_path` and `cmd_replaces_path` answer two DIFFERENT questions, and
# collapsing them was a regression that made this gate weaker than the code it
# replaced. `>>` / `tee -a` APPEND: the file is not superseded, it is the FIRST
# HALF of the body being submitted, so its content must still be scanned.
# Treating an append as a rewrite skipped it entirely -- measured in the sibling
# repo as rc=0 where both origin/main and the first fix answered rc=2.
#
#   writes   -> `>`, `>>`, `tee`, `tee -a`. Look at the command's heredoc chunks.
#   replaces -> `>`, `tee` only. ONLY then may what is on disk be ignored.
#
# A heredoc body is written through exactly these redirects (`cat > f <<EOF`), so
# matching the redirect covers the heredoc shape without parsing heredocs.
# The terminator class is not decoration. `(?:\s|$)` alone missed the TIGHT
# spelling of the very shape this exists for -- `>f<<EOF` -- as well as `>f;` and
# `>f&&`, so a one-call heredoc written without spaces passed unscanned.
cmd_writes_path() {
  local path="$1"
  CMD="$cmd" TARGET="$path" perl -0777 -e "$GATE_PERL_WORD"'
    # The redirect TARGET is matched as a shell WORD and unquoted before the
    # comparison, for the same reason the flag values are: `$ENV{TARGET}` has
    # already been through `gate_unq`, so the retired `(["\x27]?)$t\1` class
    # could only ever match spellings that need no unquoting -- notably NOT
    # `> /a\ b/x.md`, which reopened the heredoc-write window for exactly the
    # backslash-escaped paths the flag side now reads.
    sub line_writes {
      my ($l, $want, $any) = @_;
      my $re = $any ? qr/(?:>>?|\btee\b(?:\s+-a)?)\s*($GW)(?:[\s;&|)<]|$)/
                    : qr/(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*($GW)(?:[\s;&|)<]|$)/;
      while ($l =~ /$re/g) { return 1 if gate_unq($1) eq $want; }
      return 0;
    }
    my $cmd  = $ENV{CMD};
    my $want = $ENV{TARGET};
    exit 0 if line_writes($cmd, $want, 1);
    exit 1;
  ' 2>/dev/null
}

# The TRUNCATING half. `>>` and `tee -a` are deliberately absent.
cmd_replaces_path() {
  local path="$1"
  CMD="$cmd" TARGET="$path" perl -0777 -e "$GATE_PERL_WORD"'
    # The redirect TARGET is matched as a shell WORD and unquoted before the
    # comparison, for the same reason the flag values are: `$ENV{TARGET}` has
    # already been through `gate_unq`, so the retired `(["\x27]?)$t\1` class
    # could only ever match spellings that need no unquoting -- notably NOT
    # `> /a\ b/x.md`, which reopened the heredoc-write window for exactly the
    # backslash-escaped paths the flag side now reads.
    sub line_writes {
      my ($l, $want, $any) = @_;
      my $re = $any ? qr/(?:>>?|\btee\b(?:\s+-a)?)\s*($GW)(?:[\s;&|)<]|$)/
                    : qr/(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*($GW)(?:[\s;&|)<]|$)/;
      while ($l =~ /$re/g) { return 1 if gate_unq($1) eq $want; }
      return 0;
    }
    my $cmd  = $ENV{CMD};
    my $want = $ENV{TARGET};
    exit 0 if line_writes($cmd, $want, 0);
    exit 1;
  ' 2>/dev/null
}

# EVERY heredoc body that writes a given path, in order. Same extraction as
# `gh-body-english-gate.sh`, and the two are deliberately identical: both gates
# object to CONTENT they find, so both must scan the text being SUBMITTED and
# nothing else. Handles both orders (`cat > f <<EOF` / `cat <<EOF > f`), quoted
# and unquoted delimiters, and `<<-`'s tab-stripped terminator. Exits non-zero
# when the command writes the path through no heredoc at all.
heredoc_bodies_for() {
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # See the note on the sibling matcher in this file: the redirect TARGET is
    # matched as a shell WORD and unquoted before comparison, because
    # `$ENV{TARGET}` has already been through `gate_unq` and the retired
    # `(["\x27]?)$t\1` class could only match spellings that need no
    # unquoting -- notably NOT `> /a\ b/x.md`.
    sub line_writes {
      my ($l, $want, $any) = @_;
      my $re = $any ? qr/(?:>>?|\btee\b(?:\s+-a)?)\s*($GW)(?:[\s;&|)<]|$)/
                    : qr/(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*($GW)(?:[\s;&|)<]|$)/;
      while ($l =~ /$re/g) { return 1 if gate_unq($1) eq $want; }
      return 0;
    }
    my $c = $ENV{CMD};
    my $want = $ENV{TARGET};
    my @lines = split /\n/, $c, -1;
    my @out;
    my $found = 0;
    for (my $i = 0; $i <= $#lines; $i++) {
      my $l = $lines[$i];
      next unless line_writes($l, $want, 1);
      next unless $l =~ /(<<-?)\s*(["\x27]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
      my $dash  = ($1 eq "<<-");
      my $delim = $3;
      $found = 1;
      my $j = $i + 1;
      while ($j <= $#lines) {
        my $probe = $lines[$j];
        # Terminator matching follows bash, not intuition: a plain `<<` needs
        # the delimiter ALONE on the line, and only `<<-` allows leading
        # whitespace -- TABS only. Stripping all leading whitespace made an
        # indented `  EOF` inside the body end the extraction early, so
        # everything after it went unscanned while bash still submitted it.
        $probe =~ s/^\t+// if $dash;
        last if $probe eq $delim;
        push @out, $lines[$j];
        $j++;
      }
      # Resume AFTER this body, and do NOT stop: a path can be written by more
      # than one heredoc in one command (`> f <<A ... A; >> f <<B ... B`), and
      # stopping at the first left the SECOND chunk -- which is just as much of
      # the submitted body -- unscanned.
      $i = $j;
    }
    print join("\n", @out), "\n" if @out;
    # The STATUS, not the output, says whether a heredoc was found. An EMPTY
    # heredoc body is legal and prints nothing, so inferring "no heredoc" from
    # empty output made an empty heredoc REWRITING an offending file fall
    # through to the stale file and FALSE-BLOCK -- quoting a line that will not
    # exist, which the author cannot clear.
    exit($found ? 0 : 1);
  ' 2>/dev/null
}

# `scan_stream <label>` -- read `<lineno><TAB><content>` rows from fd 0 and
# append any offending line to OFFENDERS. Reading from fd 0 rather than taking
# the text as an argument is what lets BOTH callers share it: the file arm
# streams `strip_code_blocks < "$f"` and the heredoc arm streams a string, and
# neither may run in a SUBSHELL, because `OFFENDERS+=` there would be lost. So
# call sites use `< <(...)`, never a pipe.
#
# It replaces two byte-identical loops ten lines apart -- `scan_text` was
# extracted for one call site while the other kept its copy -- which is the
# shape where a fix lands in one and not the other.
#
# `local` on every variable: `hit`, `ln` and `content` used to leak into the
# caller's scope from the duplicated loop.
scan_stream() {
  local label="$1" line ln content hit
  while IFS= read -r line; do
    # Split at the FIRST tab only. `IFS=$'\t' read -r ln content` folds a TAB
    # RUN -- a tab is IFS whitespace -- so a tab-indented body line arrived
    # stripped of its indentation and the offender report quoted a line that is
    # not the line in the file.
    ln="${line%%$'\t'*}"
    content="${line#*$'\t'}"
    [[ -z "$content" ]] && continue
    hit=$(find_offender "$content")
    if [[ -n "$hit" ]]; then
      OFFENDERS+=("$label:$ln: $content")
      if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
        return
      fi
    fi
  done
}

# A file the command REWRITES holds the PREVIOUS body, so reading it judges text
# nobody is submitting -- in both directions. It can miss (the stale copy is
# clean, the new one is not) and it can BLOCK a clean submission while quoting a
# line that will not exist, which the author cannot clear because the offending
# text is not in what they are submitting. So the text being SUBMITTED is
# extracted from the heredoc instead.
#
# The first attempt scanned the WHOLE COMMAND here, copying `issue-dup-check-
# gate.sh`. That is safe for THAT gate and not for this one, and the difference
# is what each looks for: it needs one anchored marker to be PRESENT, so extra
# text can only make it pass; this gate objects to content it FINDS, so extra
# text makes it BLOCK. Measured on the first attempt --
# `gh issue create --title 'follow-up to #2397 discussion' --body-file <absent>`
# went from 0 to 2, and so did
# `git commit -m 'address review #3' && gh pr create --body-file <clean>`. Both
# are ordinary. `gh-body-english-gate.sh` had already refused whole-command
# scanning for exactly this reason; this gate now matches it line for line.
#
# Known miss, stated rather than hidden: a one-call body written by something
# other than a heredoc redirect (`printf > f`, `python3 -c ... > f`) cannot be
# extracted, so it falls back to whatever is on disk -- and to nothing at all
# when the path does not exist yet.
# The load guard above tests only that GATE_PERL_WORD is NON-EMPTY, which cannot
# see a prelude that is present but does not COMPILE -- and that failure is
# SILENT, because every extraction runs perl with stderr discarded, so the gate
# would extract nothing and PASS what it exists to refuse. Probe it functionally,
# once, here: after arming (so ordinary Bash calls pay nothing) and at TOP LEVEL.
# TOP LEVEL is load-bearing -- the extraction helpers are called inside `$( )`,
# where `exit 2` ends only the substitution subshell: measured, an in-function
# guard PRINTED its refusal and the hook still returned 0.
gate_perl_word_or_die pr-body-item-number-gate || exit 2

while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  body_text=""
  have_body=0
  if [[ ! -f "$f" ]] || cmd_writes_path "$f"; then
    body_text=$(heredoc_bodies_for "$f") && have_body=1
  fi
  if [[ "$have_body" == "1" ]]; then
    scan_stream "$f (heredoc, not yet written)" < <(printf '%s' "$body_text" | strip_code_blocks)
    if [[ "${#OFFENDERS[@]}" -ge "$MAX_REPORT" ]]; then
      break
    fi
  fi
  # The file is read UNLESS the command truncates it AND a body was extracted.
  # An APPEND leaves the existing content as the first half of what is being
  # submitted, so it must still be scanned; only a `>` / `tee` supersedes it.
  if [[ "$have_body" == "1" ]] && cmd_replaces_path "$f"; then
    continue
  fi
  [[ -f "$f" ]] || continue

  scan_stream "$f" < <(strip_code_blocks < "$f")

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
