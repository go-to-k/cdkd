#!/usr/bin/env bash
# gh-body-english-gate — block non-English text in the issue / PR text
# this flow PUBLISHES to GitHub.
#
# Why this exists as a separate gate from non-english-text-gate.sh:
# that hook's subject is the PR DIFF (`gh pr diff <N> --name-only`,
# then a scan of the changed FILES). It therefore cannot see a body or
# a title, which are never files in the repo. The two hooks share only
# the character-class test; their subjects are disjoint.
#
# The gap this closes (issue #1993): CLAUDE.md's English-only rule
# enumerated committed artifacts and then narrowed itself with "this
# rule applies only to files that land in the repository". An issue
# body is not a committed file, so it fell OUTSIDE the rule by that
# clause rather than merely being unmentioned -- while `/work-issues`
# and `/hunt-bugs` both FILE issues as a normal step, and those bodies
# are public OSS artifacts exactly like a PR body. Seen live in
# cdk-local: a run filed its follow-up with both halves of the
# `Session-fit` line glossed in the session's chat language, and had to
# patch the body after creation because nothing caught it.
#
# Subject: the text handed to the command --
#   --body-file <p> / =<p>, -F/--field body=@<p>, --notes-file <p>   (files)
#   --body / -b, --title / -t, --notes                               (inline)
#   -f/--field/--raw-field body=<text> / title=<text>                (inline)
# Inline forms ARE scanned, unlike pr-body-item-number-gate.sh, which
# deliberately leaves inline as its escape hatch. That trade does not
# apply here: there is no legitimate reason to publish Japanese in a
# body, and leaving inline unscanned would exempt the commonest shape
# (`gh issue comment -b "..."`).
#
# Known limits, all measured rather than assumed:
#   - text the shell assembles at run time (`-b "$(cat jp.txt)"`) is
#     invisible to a static scan, as is a body file a heredoc EARLIER
#     IN THE SAME command has not written yet at PreToolUse time;
#   - an unquoted inline value is matched, but one containing shell
#     metacharacters may be truncated at the first;
#   - `gh api --input <file>` is not scanned (arbitrary JSON shape).
#
# No bypass marker, matching non-english-text-gate.sh: the fix is to
# translate the text, which is trivial and is the point.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked
# as `bash gh-body-english-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# shellcheck source=lib/command-match.sh
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F cmd_matches_verb >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null; then
  # FAIL CLOSED: without the helper the verb guard below would see exit
  # 127, take the `!` branch and exit 0 -- silently disabling the gate.
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing or unloadable," >&2
  echo "so gh-body-english-gate cannot evaluate the command. Restore the file;" >&2
  echo "do not work around the gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Only gate gh invocations that PUBLISH text. Matched through the shared
# helper so a heredoc body or a quoted string that merely QUOTES one of
# these commands does not fire the gate -- commit messages and PR bodies
# routinely describe the commands they are about (.claude/rules/hooks.md,
# "Command-position matching").
# The terminator is spelled out rather than `\b`: `cmd_matches_verb` greps
# (where `\b` works) but `cmd_last_cd_target` feeds the same ERE to AWK,
# where `\b` is a BACKSPACE, so the "stop following `cd`s at the verb"
# guard silently never matched and a trailing `cd` hijacked the target
# dir. Every other caller of the helper spells it this way.
# `-R` / `--repo` must be tolerated between `gh` and the verb, not just
# `-C`: `gh -R go-to-k/<target> issue create ...` is THE shape section
# 10-c's cross-repo mirror flow uses, which is the very flow whose
# cdk-local incident this hook was written for. Allowing only `-C` let
# that case through silently.
VERB_ERE='gh([[:space:]]+(-C|-R|--repo)([[:space:]]+|=)[^[:space:]]+)*[[:space:]]+(pr[[:space:]]+(create|edit|comment|review)|issue[[:space:]]+(create|comment|edit)|release[[:space:]]+(create|edit)|api)([[:space:]]|$|[|;&`)])'
if ! cmd_matches_verb "$cmd" "$VERB_ERE"; then
  exit 0
fi

# ...and only when a body / title / notes is actually being sent. This
# keeps `gh api repos/{owner}/{repo}/issues/5 --jq .body` (a READ whose
# flag merely names the field) out of scope.
if ! printf '%s' "$cmd" | grep -qE '(--body|--title|--notes|-b[[:space:]=]|-t[[:space:]=]|-n[[:space:]=]|-F[[:space:]=]|-f[[:space:]=]|body=|title=|notes=)'; then
  exit 0
fi

# Resolve the directory a relative --body-file is written against: the
# payload cwd, then any `cd` in command position before the verb.
target_dir="${hook_cwd:-$PWD}"
cd_target=$(cmd_last_cd_target "$cmd" "$target_dir" "$VERB_ERE" 2>/dev/null || true)
[ -n "$cd_target" ] && target_dir="$cd_target"

# U+3000-303F CJK punctuation, U+3040-309F hiragana, U+30A0-30FF
# katakana, U+4E00-9FFF kanji / Chinese, U+AC00-D7AF hangul.
# Kept character-for-character in sync with non-english-text-gate.sh.
#
# Matched with perl rather than `grep -P` because BSD grep on macOS has
# no PCRE, and ALWAYS with `-CSD` so the input is decoded as UTF-8 --
# without it perl reads the bytes as latin-1 and these ranges never
# match, so the gate silently passes everything it exists to catch.
# That failure is invisible from the passing cases alone: every PASS
# case still passes, which is why the suite drives the BLOCK direction.
NON_ENGLISH_RE='[\x{3000}-\x{303F}\x{3040}-\x{309F}\x{30A0}-\x{30FF}\x{4E00}-\x{9FFF}\x{AC00}-\x{D7AF}]'

declare -a OFFENDERS=()
MAX_REPORT=10

# --- 1. file-borne bodies ---------------------------------------------
while IFS= read -r f; do
  [ -n "$f" ] || continue
  # The `~/` branch matches a LITERAL tilde in the command string: the
  # shell would have expanded a real one before gh ran, so what survives
  # here is text to match, not something to expand. SC2088's warning is
  # inverted for that case.
  # shellcheck disable=SC2088
  case "$f" in
    /*) ;;
    "~/"*) f="$HOME/${f#\~/}" ;;
    *) f="$target_dir/$f" ;;
  esac
  [ -f "$f" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    OFFENDERS+=("$f:$hit")
  done < <(perl -CSD -ne "print \"\$.: \$_\" if /$NON_ENGLISH_RE/" "$f" 2>/dev/null | head -"$MAX_REPORT")
done < <(printf '%s' "$cmd" | perl -0777 -ne '
    while (/--(?:body|notes)-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
    while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)(?:body|title|notes)=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
    # `-F <path>` is gh subcommand shorthand for --body-file / --notes-file
    # (and is this repo`s preferred shape). A bare -F whose value carries no
    # `key=` is a FILE, which distinguishes it from the gh api `-F body=@p`
    # form handled above.
    while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
  ' 2>/dev/null)

# --- 2. inline bodies, titles and notes --------------------------------
# Pull the value that follows an inline text flag, then test just that
# value. Scanning the whole command would flag a Japanese PATH or an
# unrelated argument. `-0777` slurps the WHOLE command so a multi-line
# quoted body -- the normal inline shape -- is matched; a line-by-line
# `perl -ne` cannot span the newline and silently passed every one.
# Values are NUL-separated on output so an embedded newline does not
# split one value into two.
while IFS= read -r -d '' val; do
  [ -n "$val" ] || continue
  matched=$(printf '%s' "$val" | perl -CSD -0777 -ne "print 'x' if /$NON_ENGLISH_RE/" 2>/dev/null)
  [ -n "$matched" ] || continue
  first=$(printf '%s' "$val" | tr '\n' ' ' | cut -c1-60)
  OFFENDERS+=("inline: $first")
done < <(printf '%s' "$cmd" | perl -0777 -ne '
    # Restrict the scan to the gh invocation itself: from the publish verb
    # to the next TOP-LEVEL separator. Short flags are the reason -- `-b`,
    # `-t` and `-n` are common on other commands (`echo -n`, `grep -n`,
    # `sed -n`, `sort -t`), so matching them across a whole chained command
    # made `gh issue create ... && echo -n "<non-English>"` a hard block
    # with no bypass. The separator scan tracks quote state, so a `&&`
    # INSIDE a body does not end the segment.
    # EVERY gh publish invocation gets its own segment, not just the
    # first: a chained `gh -R A issue create ... && gh -R B issue create
    # ...` is the three-repo mirror flow section 10-c prescribes, and
    # scanning only the first left the second silently unchecked.
    # The flag spelling here is kept identical to VERB_ERE above -- when
    # the two disagreed (`-R=x` matched there but not here), the gate
    # armed while this regex fell back to offset 0, so the segment
    # covered the PRECEDING command instead.
    my $s = $_;
    # ONE left-to-right pass over the whole command records (a) which
    # offsets sit inside a quoted span and (b) where the top-level
    # separators are. Scanning per match instead, seeded at the match
    # offset, got the quote polarity INVERTED whenever the first match
    # was a quoted MENTION of one of these commands in an earlier
    # argument -- which is precisely the shape the shared stripper
    # exists for, and which this perl cannot use because it needs the
    # RAW offsets.
    # chr(34) / chr(39) rather than literal quotes: this whole perl
    # program is inside a single-quoted bash string, so a literal
    # apostrophe would terminate it.
    my @inq = (0) x (length($s) + 2);
    my @seps;
    {
      my ($i, $q) = (0, "");
      while ($i < length $s) {
        my $c = substr($s, $i, 1);
        if ($q ne "") {
          $inq[$i] = 1;
          if ($c eq "\\" && $q eq chr(34)) { $inq[$i + 1] = 1; $i += 2; next; }
          $q = "" if $c eq $q;
          $i++; next;
        }
        # A backslash escapes the NEXT character, including a newline.
        # Without this, a `\`-continued `gh issue create \<nl> --body
        # "..."` ended at the continuation and its body went unscanned.
        if ($c eq "\\") { $i += 2; next; }
        if ($c eq chr(34) || $c eq chr(39)) { $q = $c; $inq[$i] = 1; $i++; next; }
        my $two = substr($s, $i, 2);
        # A newline and a bare `|` end a command just as `&&` does;
        # omitting them left the short-flag false positive alive in
        # multi-line blocks and pipelines.
        if ($two eq "&&" || $two eq "||" || $c eq ";" || $c eq "|" || $c eq "\n") {
          push @seps, $i; $i++; next;
        }
        $i++;
      }
    }
    my @segs;
    while ($s =~ /gh(?:\s+(?:-C|-R|--repo)(?:\s+|=)\S+)*\s+(?:pr\s+(?:create|edit|comment|review)|issue\s+(?:create|comment|edit)|release\s+(?:create|edit)|api)\b/gs) {
      my $start = $-[0];
      # A match inside a quoted span is prose describing the command,
      # not an invocation of it.
      next if $inq[$start];
      my $end = length $s;
      for my $p (@seps) { if ($p > $start) { $end = $p; last; } }
      push @segs, substr($s, $start, $end - $start);
    }
    for my $seg (@segs) {
    local $_ = $seg;

    # The flag must start at a word boundary that is not itself a dash,
    # so `-b` cannot match inside `--body-file`. `\\.` skips an escaped
    # quote so it does not terminate the span early; /s lets the value
    # span newlines.
    while (/(?:^|\s)(?:--body|--title|--notes|-b|-t|-n)[=\s]*"((?:[^"\\]|\\.)*)"/gs) { print "$1\0"; }
    while (/(?:^|\s)(?:--body|--title|--notes|-b|-t|-n)[=\s]*\x27([^\x27]*)\x27/gs)  { print "$1\0"; }
    # Unquoted value: stops at whitespace, which is all the shell would
    # have passed as one argument anyway. Short flags are listed here too --
    # omitting them let `-b <unquoted>` through while `--body <unquoted>`
    # was caught.
    while (/(?:^|\s)(?:--body|--title|--notes|-b|-t|-n)[=\s]+([^\s"\x27-][^\s]*)/g)  { print "$1\0"; }
    # gh api field forms carrying a literal (not @file) value. Split in two:
    # the quote may wrap the WHOLE `body=...` or follow the `=`, and the
    # unquoted branch must stop at whitespace -- a single `[^"\x27]*` arm ran
    # away to the next quote or end of command and swallowed later arguments.
    while (/(?:--field|--raw-field|-F|-f)[=\s]+["\x27](?:body|title|notes)=([^"\x27]*)["\x27]/gs) { print "$1\0"; }
    while (/(?:--field|--raw-field|-F|-f)[=\s]+(?:body|title|notes)=(["\x27])([^"\x27]*)\1/gs)    { print "$2\0"; }
    while (/(?:--field|--raw-field|-F|-f)[=\s]+(?:body|title|notes)=([^\s"\x27@][^\s]*)/g)        { print "$1\0"; }
    }
  ' 2>/dev/null)

if [ ${#OFFENDERS[@]} -eq 0 ]; then
  exit 0
fi

{
  echo "Blocked by gh-body-english-gate:"
  echo
  echo "This command publishes non-English text to GitHub. Issue and PR"
  echo "bodies, titles, comments and release notes are public OSS"
  echo "artifacts and must be English, exactly like the files in the repo."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    echo "  $entry"
  done
  echo
  echo "(hiragana / katakana / kanji / Chinese / hangul / CJK punctuation)"
  echo
  echo "Fix:"
  echo "  - Translate the body / title to English and re-run."
  echo "  - A Session-fit gloss is text like any other: write"
  echo "    'Session-fit: next (not this session)', not a localized gloss."
  echo "  - Chat with the user stays in whatever language you like; this"
  echo "    gate covers only what gets PUBLISHED."
  echo
  echo "Rule: CLAUDE.md -> Workflow Rules -> English-only"
} >&2
exit 2
