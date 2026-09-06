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
#   --body-file <p> / =<p>, -F <p>, -F/--field body=@<p>,
#   --notes-file <p>                                                 (files)
#   --body, --title, --notes                                         (inline)
#   -f/--field/--raw-field body=<text> / title=<text>                (inline)
# Inline forms ARE scanned, unlike pr-body-item-number-gate.sh, which
# deliberately leaves inline as its escape hatch. That trade does not
# apply here: there is no legitimate reason to publish Japanese in a body.
#
# The long flags above are ones no other common command defines, so a
# match anywhere in the command can be attributed to the gh invocation
# and NO shell parsing is needed. That is the whole design; section 2
# records what it cost to learn. Two honest qualifications:
#   - `-F` is NOT gh-unique (`git commit -F`, `awk -F`, `grep -F`,
#     `curl -F`). What keeps that from false-blocking is the `[ -f "$f" ]`
#     existence check plus the character-class test, not flag uniqueness;
#   - the trade runs in the FALSE-POSITIVE direction, which is the safe
#     one but is still a cost: a non-gh command later in the same chain
#     that carries a literal `--body` / `--title` / `--notes` with
#     non-English text blocks, e.g.
#     `gh issue create ... && echo "use --body <non-English>"`.
#     Loud and fixable, unlike a silent miss.
#
# Known limits (silent misses), all measured rather than assumed:
#   - the SHORT flags `-b` / `-t` / `-n` are NOT scanned. They collide
#     with other commands (`echo -n`, `grep -n`, `sed -n`, `sort -t`),
#     so covering them requires attributing a flag to the right command
#     in a chain, and every attempt at that shell parsing shipped a
#     worse bug than the gap it closed (section 2). `gh issue comment
#     -b "..."` therefore passes; `--body` is caught. Agent-authored
#     commands in this repo use `--body-file` or the long flags;
#   - text the shell assembles at run time (`--body "$(cat jp.txt)"`) is
#     invisible to a static scan. The related window -- a body file the
#     SAME command has not written yet at PreToolUse time -- is CLOSED
#     for the heredoc shape (go-to-k/cdkd#2397, see the extraction
#     below). What remains of it is narrower: a one-call body written by
#     something other than a heredoc redirect (`printf > f`,
#     `python3 -c ... > f`) cannot be extracted, so the scan falls back
#     to whatever is on disk, which is the PREVIOUS body. This list used
#     to say that was ALL that remained, and it was not: the extraction
#     was handed the RESOLVED absolute path while it matches against the
#     raw command text, so a body written and consumed under a RELATIVE
#     or `~/` spelling was never scanned at all (rc=0 against rc=2 for
#     the absolute twin, measured). That one is CLOSED -- both spellings
#     are now offered to the matchers -- and it is named here because
#     the list claiming to be complete is what let it sit;
#   - a QUOTED DECOY can supersede the real body file: the heredoc extraction
#     scans RAW command text, so `--title 'x > /p/jp.md <<EOF ... EOF'` makes
#     the gate read a heredoc the command never runs and skip the file on disk
#     (measured rc=0, and the same on the pre-`GATE_PERL_WORD` hook -- the word
#     class changed WHICH spellings reach it, not that quoting is ignored).
#     Closing it means running the write-detection over quote-aware SEGMENTS,
#     the same change `pr-body-item-number-gate`'s bare-`-F` limit waits on;
#   - an unquoted inline value STOPS at an unquoted shell metacharacter
#     (`; | & ( ) < >` and a backtick), which is what a shell does with it --
#     the word ends there. A metacharacter meant as DATA has to be quoted, and
#     then it is inside the value and kept;
#   - `gh api --input <file>` and `--body-file -` (stdin) are not scanned;
#   - a quoted path CONTAINING A SPACE (`--body-file "/a/b c/x.md"`) and the
#     glued `-F<path>` / `-fbody=<text>` shorthands USED to be listed here as
#     not extracted. Both are FIXED (2026-09-05): the first was a live
#     bypass of the English-only rule -- measured rc=0 on a Japanese body at
#     a spaced path where the unquoted spelling gave 2 -- and a known-limit
#     line is not a licence to leave a bypass standing. See
#     `GATE_PERL_WORD` in lib/command-match.sh;
#   - a gh call nested in a command substitution, a subshell, an `if`, a
#     loop body, or behind `xargs` (`URL=$(gh issue create ...)`) never
#     arms the gate at all -- that is the shared `cmd_matches_verb`
#     command-position anchor, common to all 16 sourcing gates. So is an
#     unbalanced apostrophe earlier in the command (`# don'\''t`), which
#     makes the shared stripper swallow the rest as one quoted span.
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
  || ! declare -F cmd_last_cd_target >/dev/null \
  || [ -z "${GATE_RE_GH_PROSE_CARRIER:-}" ] \
  || [ -z "${GATE_PERL_WORD:-}" ]; then
  # FAIL CLOSED: without the helper the verb guard below would see exit
  # 127, take the `!` branch and exit 0 -- silently disabling the gate.
  # The constant is checked for the same reason: a library that predates
  # it leaves VERB_ERE empty, and an empty ERE matches EVERY segment.
  # `GATE_PERL_WORD` is checked because an empty one leaves the `$GW` the
  # extractions interpolate as the EMPTY string, `($GW)` then matches empty
  # everywhere, and every body path and inline value comes back empty --
  # a silent pass rather than a loud 127.
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
# The flag absorber is the SHARED one (go-to-k/cdkd#2156). The local copy
# enumerated `-C` / `-R` / `--repo` and one unquoted value shape, so any other
# gh global flag ahead of the verb -- `gh --template "a b" issue create ...` --
# left the gate unarmed. `-R` / `--repo` still pass, absorbed by GATE_GH_C
# along with every other flag: that is THE shape section 10-c's cross-repo
# mirror flow uses, which is the flow whose cdk-local incident this hook was
# written for.
VERB_ERE="$GATE_RE_GH_PROSE_CARRIER"
if ! cmd_matches_verb "$cmd" "$VERB_ERE"; then
  exit 0
fi

# ...and only when a body / title / notes is actually being sent. This
# keeps `gh api repos/{owner}/{repo}/issues/5 --jq .body` (a READ whose
# flag merely names the field) out of scope.
# `-F` / `-f` accept a GLUED value (`-F/abs/p`, `-F"/a b/x.md"`), so the
# terminator has to admit a non-separator character too -- i.e. ANY character,
# which is what the alternation below spells. Written out rather than as `-F.`
# only because the two halves say what each is for; it is NOT narrower. (An
# earlier version of this comment claimed it excluded matches inside a longer
# word. That is false -- `-F.` matches there too; the only thing a terminator
# buys over a bare `-F` is refusing end-of-string.)
# Over-arming is cheap and safe here anyway --
# `cmd_matches_verb` above has already established this is a gh PUBLISHING
# invocation, so `grep -F pattern file` never reaches this line (verified: rc=0
# with and without the widening), and an armed command with no extractable body
# just exits 0. Under-arming is NOT cheap: the glued spelling was a live
# English-only bypass (rc=0 on a Japanese body where the spaced form gave 2).
if ! printf '%s' "$cmd" | grep -qE '(--body|--title|--notes|-F([[:space:]=]|[^[:space:]=])|-f([[:space:]=]|[^[:space:]=])|body=|title=|notes=)'; then
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
# --- go-to-k/cdkd#2397 helpers -------------------------------------------
# `cmd_writes <path>` and `cmd_replaces <path>` answer two DIFFERENT questions,
# and collapsing them into one was a regression that made this gate weaker than
# the code it replaced. `>>` / `tee -a` APPEND: the file is not superseded, it is
# the FIRST HALF of the body being submitted, so its content must still be
# scanned. Treating an append as a rewrite skipped it entirely -- measured as
# rc=0 where both origin/main and the first fix answered rc=2.
#
#   writes   -> `>`, `>>`, `tee`, `tee -a`. Look at the command's heredoc chunks.
#   replaces -> `>`, `tee` only. ONLY then may what is on disk be ignored.
#
# A heredoc body is written through exactly these redirects (`cat > f <<EOF`), so
# matching the redirect covers the heredoc shape without parsing heredocs twice.
cmd_writes() {
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
    # `(?:\s|$)` alone missed `>f<<EOF` -- the TIGHT spelling of the very shape
    # this exists for -- and `>f;` / `>f&&`.
    exit 0 if line_writes($c, $want, 1);
    exit 1;
  ' 2>/dev/null
}

cmd_replaces() {
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # The redirect TARGET is matched as a shell WORD and unquoted before the
    # comparison, for the same reason the flag values are: `$ENV{TARGET}` has
    # already been through `gate_unq`, so a `(["\x27]?)$t\1` class could only
    # ever match the spellings that need no unquoting. It could not see
    # `> /a\ b/x.md`, which meant the heredoc-write window reopened for exactly
    # the backslash-escaped paths this PR taught the flag side to read
    # (measured: a heredoc writing Japanese to a backslash-escaped path over a
    # stale English file on disk gave rc=0; the quoted spelling gave 2).
    sub line_writes {
      my ($l, $want, $any) = @_;
      my $re = $any ? qr/(?:>>?|\btee\b(?:\s+-a)?)\s*($GW)(?:[\s;&|)<]|$)/
                    : qr/(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*($GW)(?:[\s;&|)<]|$)/;
      while ($l =~ /$re/g) { return 1 if gate_unq($1) eq $want; }
      return 0;
    }
    my $c = $ENV{CMD};
    my $want = $ENV{TARGET};
    # Through the shared `line_writes`, like its two siblings. It is
    # behaviourally identical spelled inline, and that is exactly why it must
    # not be: an eighth private copy of a matcher is the shape this whole
    # change exists to retire, and it is the copy that will drift.
    exit 0 if line_writes($c, $want, 0);
    exit 1;
  ' 2>/dev/null
}

# `heredoc_bodies_for <path>` -- EVERY heredoc body that writes that path, in
# order. Both orders are handled (`cat > f <<EOF` and `cat <<EOF > f`), quoted
# and unquoted delimiters, and `<<-`. Exits non-zero when the command writes the
# path through no heredoc at all, which leaves the pre-#2397 behaviour for every
# shape this cannot see.
heredoc_bodies_for() {
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # The redirect TARGET is matched as a shell WORD and unquoted before the
    # comparison, for the same reason the flag values are: `$ENV{TARGET}` has
    # already been through `gate_unq`, so a `(["\x27]?)$t\1` class could only
    # ever match the spellings that need no unquoting. It could not see
    # `> /a\ b/x.md`, which meant the heredoc-write window reopened for exactly
    # the backslash-escaped paths this PR taught the flag side to read
    # (measured: a heredoc writing Japanese to a backslash-escaped path over a
    # stale English file on disk gave rc=0; the quoted spelling gave 2).
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
        # Terminator matching follows bash, not intuition: a plain `<<` needs
        # the delimiter ALONE on the line, and only `<<-` allows leading
        # whitespace -- TABS only. Stripping all leading whitespace
        # unconditionally made an indented `  EOF` inside the body end the
        # extraction early, so everything after it went unscanned while bash
        # still submitted it. That is a silent miss, the one direction a gate
        # must not fail in.
        my $probe = $lines[$j];
        $probe =~ s/^\t+// if $dash;
        last if $probe eq $delim;
        push @out, $lines[$j];
        $j++;
      }
      # Resume AFTER this body, and do NOT stop at the first: a path can be
      # written by more than one heredoc in one command (`> f <<A ... A;
      # >> f <<B ... B`), and stopping left the SECOND chunk -- just as much of
      # the submitted body -- unscanned.
      $i = $j;
    }
    print join("\n", @out), "\n" if @out;
    # The STATUS, not the output, reports whether a heredoc was found. An EMPTY
    # heredoc body is legal and prints nothing, so inferring "no heredoc" from
    # empty output made an empty heredoc REWRITING an offending file fall
    # through to the stale file and FALSE-BLOCK -- quoting a line that will not
    # exist, which the author cannot clear.
    exit($found ? 0 : 1);
  ' 2>/dev/null
}

# The load guard above tests only that GATE_PERL_WORD is NON-EMPTY, which
# cannot see a prelude that is present but does not compile -- and that
# failure is SILENT (every extraction discards perl stderr), so the gate
# would extract nothing and pass. Probe it functionally here, where the
# gate has already armed, rather than on every Bash call at load time.
gate_perl_word_or_die gh-body-english-gate || exit 2
while IFS= read -r f_raw; do
  [ -n "$f_raw" ] || continue
  # BOTH spellings are kept, and that is load-bearing rather than tidy.
  # `f` is the path to READ; `f_raw` is the path as the command spells it AFTER
  # `gate_unq` -- quotes and backslash escapes removed, nothing else changed, so
  # a relative or `~/` spelling survives while `"/a b/x.md"` and `/a\ b/x.md`
  # both arrive as `/a b/x.md`. That is what the write-detection compares
  # against, which is why those matchers take a shell WORD and unquote it rather
  # than matching the raw text: the raw text and this string differ for every
  # spelling that needed quoting. It is NOT the untouched command text, and
  # the write-detection below (`cmd_writes` / `cmd_replaces` /
  # `heredoc_bodies_for`) matches its argument against the RAW COMMAND TEXT.
  # Handed the resolved absolute path, those matched nothing whenever the
  # command wrote a RELATIVE or `~/` path -- `have_body` stayed 0, the
  # `[ -f "$f" ] || continue` below then passed silently, and a heredoc body
  # full of non-English text was never scanned. Measured before this, with the
  # payload cwd as the write target:
  #
  #   cd <d>; cat > body.md <<EOF … EOF; gh issue create --body-file body.md
  #                                                            rc=0, want 2
  #   cat > <abs>/b.md <<EOF … EOF;  gh issue create --body-file <abs>/b.md
  #                                                            rc=2
  #   cat > ~/p.md <<EOF … EOF;      gh issue create --body-file ~/p.md
  #                                                            rc=0, want 2
  #
  # The twin `pr-body-item-number-gate.sh` does not normalise at all and so
  # never had the gap, while both files advertise the two extractions as
  # deliberately identical. They are matched here rather than there, because
  # reading the file still needs the resolved path.
  f="$f_raw"
  # The `~/` branch matches a LITERAL tilde in the command string: the
  # shell would have expanded a real one before gh ran, so what survives
  # here is text to match, not something to expand. SC2088's warning is
  # inverted for that case.
  # shellcheck disable=SC2088
  case "$f" in
    /*) ;;
    "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
    *) f="$target_dir/$f" ;;
  esac
  # Both spellings are offered to each matcher: the command may write the path
  # one way and pass it to gh the other (`cat > /abs/b.md … --body-file b.md`),
  # and either half alone leaves that shape unscanned.
  # `[ "$f_raw" = "$f" ]` short-circuits the second probe on the common ABSOLUTE
  # spelling, where the two are the same string: each of these is a `perl`
  # spawn, and this gate already carries a timeout that a timed-out PreToolUse
  # hook turns into a silent pass.
  cmd_writes_either() {
    cmd_writes "$f_raw" && return 0
    [ "$f_raw" = "$f" ] && return 1
    cmd_writes "$f"
  }
  cmd_replaces_either() {
    cmd_replaces "$f_raw" && return 0
    [ "$f_raw" = "$f" ] && return 1
    cmd_replaces "$f"
  }
  heredoc_bodies_either() {
    heredoc_bodies_for "$f_raw" && return 0
    [ "$f_raw" = "$f" ] && return 1
    heredoc_bodies_for "$f"
  }
  # The hook runs BEFORE the command, so when the heredoc that WRITES the body
  # and the `gh` call that consumes it sit in ONE Bash call, the path is either
  # absent or still holds what a previous call left there. The header documents
  # that window as a known limit costing "a missed scan"; go-to-k/cdkd#2397
  # observed it costing a real one, so it is closed here.
  #
  # It is closed by extracting the HEREDOC BODY that writes this path, NOT by
  # scanning the whole command the way `issue-dup-check-gate.sh` and
  # `pr-body-item-number-gate.sh` do. Those two look for a specific anchored
  # pattern, so the extra surface is small. This gate's subject is ANY
  # non-English character anywhere, and the command legitimately carries some:
  # a body file under a Japanese-named directory is a documented PASS case
  # ("japanese in the PATH but english body passes"), which a whole-command scan
  # would turn into a block. Extracting the body scans exactly the text being
  # published and nothing else.
  #
  # A readable file is re-read from the heredoc too when the command REWRITES
  # it, because then what is on disk is the PREVIOUS body -- the same window,
  # in the shape that looks like a working gate while judging text nobody is
  # submitting.
  #
  # PRECEDENCE, and the third arm is the one that matters. The extracted body is
  # the best evidence when it exists; the FILE is the fallback, not a skip. A
  # first revision skipped whenever no heredoc body was found, which silently
  # LOST a scan the pre-#2397 hook performed: `printf %s "$B" > f` followed by
  # `--body-file f` matched `cmd_rewrites`, extracted nothing (it is not a
  # heredoc), and passed a file that used to block. A fix that makes a gate
  # weaker than the code it replaces is the worst outcome available here, so the
  # skip now happens only when there is genuinely nothing to read: no body AND
  # no file.
  body_text=""
  have_body=0
  if [ ! -f "$f" ] || cmd_writes_either; then
    body_text=$(heredoc_bodies_either) && have_body=1
  fi
  if [ "$have_body" = "1" ]; then
    while IFS= read -r hit; do
      [ -n "$hit" ] || continue
      OFFENDERS+=("$f (heredoc, not yet written):$hit")
    done < <(printf '%s\n' "$body_text" | perl -CSD -ne "print \"\$.: \$_\" if /$NON_ENGLISH_RE/" 2>/dev/null | head -"$MAX_REPORT")
  fi
  # The file is read UNLESS the command truncates it AND a body was extracted.
  # An APPEND leaves the existing content as the first half of what is being
  # submitted, so it must still be scanned; only a `>` / `tee` supersedes it.
  if [ "$have_body" = "1" ] && cmd_replaces_either; then
    continue
  fi
  [ -f "$f" ] || continue
  while IFS= read -r hit; do
    [ -n "$hit" ] || continue
    OFFENDERS+=("$f:$hit")
  done < <(perl -CSD -ne "print \"\$.: \$_\" if /$NON_ENGLISH_RE/" "$f" 2>/dev/null | head -"$MAX_REPORT")
# The value class is `$GW` from the SHARED `GATE_PERL_WORD` prelude in
# lib/command-match.sh, not a local `(["\x27]?)([^"\x27\s]+)\1`. That local
# shape could not span a QUOTED PATH CONTAINING A SPACE -- it extracted
# NOTHING, so this gate scanned no body at all. Measured 2026-09-05:
# `--body-file "<dir with space>/jp.md"` with a JAPANESE body gave rc=0 where
# the unquoted spelling gave 2, i.e. the English-only rule was bypassable by
# putting the body file in a directory whose name has a space. The header's
# known-limit list said "not extracted" and that line is now wrong, so it is
# gone from there too.
#
# `[=\s]*` rather than `[=\s]+` on the SHORT flag: gh accepts the GLUED
# spelling `-F/abs/p` as readily as `-F /abs/p`, and requiring a separator
# silently dropped the glued half of the family (measured on
# issue-deferral-criteria-gate, whose polarity makes the same miss a
# fail-open: `-F /abs/bad.md` rc=2, `-F/abs/bad.md` rc=0).
done < <(printf '%s' "$cmd" | perl -0777 -ne "$GATE_PERL_WORD"'
    while (/--(?:body|notes)-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
    while (/(?:--field|--raw-field|-F)[=\s]*($GW)/g) {
      my $v = gate_unq($1);
      next unless $v =~ s/^(?:body|title|notes)=\@//;
      print "$v\n";
    }
    # `-F <path>` is gh subcommand shorthand for --body-file / --notes-file
    # (and is this repo`s preferred shape). A bare -F whose value carries no
    # `key=` is a FILE, which distinguishes it from the gh api `-F body=@p`
    # form handled above.
    while (/(?:^|\s)-F[=\s]*($GW)(?=\s|$)/g) {
      my $v = gate_unq($1);
      next if $v =~ /=/;
      print "$v\n";
    }
  ' 2>/dev/null)

# --- 2. inline bodies, titles and notes --------------------------------
# Pull the value that follows an inline text flag, then test just that
# value. Scanning the whole command would flag a Japanese PATH or an
# unrelated argument. `-0777` slurps the WHOLE command so a multi-line
# quoted body -- the normal inline shape -- is matched; a line-by-line
# `perl -ne` cannot span the newline and silently passed every one.
# Values are NUL-separated on output so an embedded newline does not
# split one value into two.
# The character-class test runs INSIDE the extraction perl, so only
# offending values cross the pipe. Testing each value with its own
# `perl -CSD` spawn instead cost 3.8 s for 500 values and would pass the
# hook's own 15 s timeout -- a timeout being, for a gate, a silent pass.
while IFS= read -r -d '' val; do
  [ -n "$val" ] || continue
  first=$(printf '%s' "$val" | tr '\n' ' ' | cut -c1-60)
  OFFENDERS+=("inline: $first")
done < <(printf '%s' "$cmd" | NER="$NON_ENGLISH_RE" perl -CSD -0777 -ne "$GATE_PERL_WORD"'
    my $re = qr/$ENV{NER}/;
    # DECODE HERE. `gate_unq` hands back the BYTE string bash would pass (it is
    # representation-uniform on purpose -- see its header), and this is the one
    # caller that needs characters, because `$re` is a CHARACTER class and this
    # perl runs under `-CSD`. `gate_utf8_lenient` decodes maximal valid
    # sequences and emits one U+FFFD per un-decodable byte, so a stray byte
    # cannot switch the class test off for the rest of the value.
    sub emit { my $v = gate_utf8_lenient(shift); print "$v\0" if $v =~ $re; }
    # NO shell parsing. Every flag matched here is one that only gh
    # defines, so a match anywhere in the command belongs to the gh
    # invocation and needs no segment bounding.
    #
    # This is deliberate and was arrived at the hard way. An earlier
    # version also matched the SHORT flags `-b` / `-t` / `-n`, which are
    # common on other commands (`echo -n`, `grep -n`, `sed -n`,
    # `sort -t`), so a chained command needed the flag attributed to the
    # right invocation. That attribution required bounding each gh
    # invocation with a hand-rolled quote / separator scanner, and four
    # review rounds each found a new shell-parsing case it got wrong --
    # three of them regressions introduced by the previous round"s fix
    # (a `\`-continued line, a quoted MENTION of one of these commands in
    # an earlier argument inverting the quote polarity, and finally an
    # apostrophe in a heredoc body or `#` comment leaving the quote state
    # open so every later invocation was discarded as prose -- which
    # silently defeated `heredoc -> file -> --body-file`, this repo"s
    # commonest publishing shape).
    #
    # Dropping the short flags deletes that entire class. What it costs
    # is stated in the header as a known limit rather than hidden.
    # ONE arm per flag family, over the shared `$GW` shell WORD, rather than
    # one arm per QUOTE PLACEMENT. The three-arm shape it replaces enumerated
    # "quoted", "single-quoted" and "unquoted", which is the same enumeration
    # that lost the quoted `--body-file` path a few lines up.
    #
    # `[=\s]+` here and `[=\s]*` on the field flags below is not an
    # inconsistency: `--body` is a PREFIX of `--body-file`, so allowing an
    # empty separator would make `--body-file "<jp path>/x.md"` parse as an
    # inline `--body` value of `-file/<jp path>/x.md` and block the
    # japanese-in-the-PATH case this gate deliberately passes. The short
    # flags have no such prefix twin and DO have a glued spelling gh accepts.
    while (/(?:^|\s)(?:--body|--title|--notes)[=\s]+($GW)/g) { emit(gate_unq($1)); }
    # gh api field forms carrying a literal (not @file) value. The quote may
    # wrap the WHOLE `body=...` or sit after the `=`; `gate_unq` removes it
    # from either position, so both are one case now.
    while (/(?:--field|--raw-field|-F|-f)[=\s]*($GW)/g) {
      my $v = gate_unq($1);
      next unless $v =~ s/^(?:body|title|notes)=//;
      next if $v =~ /^\@/;
      emit($v);
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
