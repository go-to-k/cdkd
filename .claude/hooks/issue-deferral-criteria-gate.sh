#!/usr/bin/env bash
# issue-deferral-criteria-gate.sh — block `gh issue create` when the body's
# `Session-fit: next` line defers the work for a PR-SHAPED reason.
#
# WHY
#
# `Session-fit` answers ONE question: do I finish this in THIS session? The
# criteria are in .claude/rules/session-report.md's `### Session-fit` section,
# and NONE of them is about the pull request. Splitting work across several PRs
# is normal, needs no permission and costs no session -- a lane can open two
# PRs in the same hour.
#
# That has been written down three times over -- /work-issues section 3-b
# ("'It needs its own PR' is NOT a `next` reason"), section 5-f, and the rule
# file's own paragraph -- and on 2026-09-04 an agent deferred THREE findings in
# one session on exactly that reasoning anyway (go-to-k/cdkd#2587 /
# go-to-k/cdkd#2588 / go-to-k/cdkd#2590). All three were re-classified
# `Session-fit: now` later the same day and finished in that same session, so
# the deferrals bought nothing and cost three issue numbers plus the context to
# re-acquire.
#
# /work-issues references/retro.md section 10-b is explicit about what happens
# next: a rule already in the text and violated anyway escalates to a MECHANISM.
# This is that mechanism.
#
# WHAT IT ASKS FOR, AND WHAT IT DELIBERATELY DOES NOT
#
# It does NOT ask for a ritual. An earlier design required the body to carry a
# "criteria audit" line; that is satisfiable by boilerplate, and a gate a
# sentence can satisfy measures typing, not thinking. This one refuses the
# specific defect instead: a `next` line whose REASON is PR-shaped. Everything
# else passes untouched, including every legitimate `next` --
#
#   Session-fit: next (not this session) -- a NEW integ fixture must be written
#   Session-fit: next (not this session) -- blocked on an AWS quota increase
#   Session-fit: next (not this session) -- an independent subsystem, no file
#     overlap, and no `now` criterion fires
#
# and it never argues with a `Session-fit: now`, whatever that line says.
#
# It is also NOT a filing threshold: nothing here makes a finding harder to
# write down (/work-issues section 10-0 -- an unfiled finding is strictly worse
# than a filed one). It changes one word in one line, or -- the outcome it
# actually steers toward -- it makes you notice that the item is a `now`.
#
# WHAT IT ACTUALLY CATCHES -- MEASURED, INCLUDING ON ITS OWN MOTIVATING CASE
#
# Run against the three issues named above, as they were actually filed
# (`gh issue view <n> --json body -q .body`, 2026-09-05):
#
#   go-to-k/cdkd#2590   exit 2   "it wants its own PR and review"
#   go-to-k/cdkd#2587   exit 0   "a fixture redesign plus its own real-AWS run
#                                 and review round"
#   go-to-k/cdkd#2588   exit 0   "a separate decision with its own blast radius
#                                 across future PRs"
#
# ONE of the three. That is not a defect to be patched -- widening the needle
# to `own .* review round` and `own blast radius` is the third spelling in the
# third round, which /work-issues references/implement.md names as the signal
# to change INSTRUMENT rather than to chase one more phrase. The two misses
# reason about a PR without ever making a PR-shaped CLAIM this vocabulary can
# recognise, and no closed list ever will.
#
# The complementary force ships in the same PR and is the half that covers
# them: the PR-shaped `next` criteria are REMOVED from
# .claude/rules/session-report.md, so "this is its own reviewable unit" stops
# being a criterion a reader can believe they are satisfying. The rule change
# addresses reasoning that never says "PR"; the gate makes the cheap, reusable
# spelling loud at the moment of filing. Neither alone is the mechanism.
#
# Corpus reading, so the coverage claim is a number rather than an impression.
# Over `gh issue list --state all --limit 300 --json number,body` (2026-09-05),
# 255 of the 300 bodies carry a `Session-fit: next` FIELD LINE and the gate
# fires on 66 of them (26%). The denominator depends on the predicate and the
# difference is not noise: an anchored field-line match (what this gate reads --
# line start, optional bold, optional list marker) gives 255, a bare
# `grep -l 'Session-fit: next'` gives 256, and a reviewer counting prose
# mentions too reported 257. 255 is the population that actually MAKES a
# deferral decision; the extras are bodies QUOTING the phrase, which is exactly
# the shape the fence strip exists to leave alone. State the predicate with the
# number or the number cannot be reproduced. Every one of the 66 fires on a literal vocabulary term --
# `own review` x30, `own PR` x25, `unreviewable` x14, `share a PR` x3,
# `separate PR` x3 (bodies can carry more than one); eight sampled by hand are
# genuine PR-shaped deferrals, none is a body arguing about the rule. So: a
# quarter of real deferrals reach for the cheap spelling, and the gate is loud
# on exactly that quarter. It is not, and does not claim to be, a filter that
# every PR-shaped deferral must pass through.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create   -- the site where a deferral is FIRST decided
#               gh api repos/<o>/<r>/issues -- the same mint through REST
#   not gated:  gh issue edit     -- re-classification is the outcome this gate
#               gh issue comment     wants; taxing it would penalise the fix
#
# Same split, and the same reasoning, as issue-dup-check-gate.sh.
#
# KNOWN LIMITS, all measured rather than assumed:
#
#   - A body passed INLINE as one physical line has no line structure, so the
#     reason runs to the end of that line and a PR-shaped phrase belonging to a
#     later field is read as part of it. That is the over-approximating
#     direction (a loud, clearable block), and the file-borne shape this repo
#     mandates for issue bodies does not have it.
#   - A body file written by a PREVIOUS tool call and then DELETED before this
#     one is unreadable, and an unreadable path falls back to the whole command
#     rather than refusing (see `segment_body_text`).
#   - A one-call body written to an EXISTING path by something other than a
#     heredoc (`printf > f`, `python3 -c ... > f`) cannot be extracted from the
#     command text, so the scan falls back to what is on disk -- the PREVIOUS
#     body. The heredoc shape, which is the one this repo mandates, is CLOSED
#     (see `segment_body_text` arm 1); this remainder is the same limit
#     gh-body-english-gate.sh carries, and it is the shape of the fail-open
#     that made this gate INERT before the port, so it is named rather than
#     left to be rediscovered.
#   - The vocabulary is a closed list, so a reworded PR-shaped reason passes --
#     measured at one of its own three motivating issues, see "WHAT IT ACTUALLY
#     CATCHES" above. Deliberate: see the note on PR_SHAPE_RE.
#   - A PR-shaped reason quoted INLINE, in running prose, to argue against it
#     still needs the bypass. A quote inside a ``` fence does not: fenced
#     blocks are stripped before the scan.
#
# ESCAPE HATCH: CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1, honored from the hook's own
# process env AND from a leading assignment in the COMMAND TEXT -- an agent's
# Bash call cannot populate a PreToolUse hook's environment, so the text channel
# is the only one the refusal can advertise (the go-to-k/cdkd#2368 lesson, where
# an advertised remediation silently did nothing). The text check runs through
# `strip_noncommand_spans` + command position, so a QUOTED mention does not
# bypass anything. It exists for the case this gate cannot see: a body quoting
# someone else's PR-shaped reasoning in order to argue against it -- and it is
# for the INLINE quote only. The commonest shape of that body, a ``` fenced
# exhibit, is handled without a bypass (see `scan_text`): a body should not
# have to disarm a gate to talk about the rule the gate enforces.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-deferral-criteria-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# FAIL CLOSED: a gate that cannot evaluate the command must not wave it
# through. `|| exit 0` here is what silently disabled ten sibling gates
# (go-to-k/cdkd#2130 review).
# shellcheck source=lib/command-match.sh
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing, unloadable, or" >&2
  echo "predates GATE_RE_GH_ISSUE_CREATE, so issue-deferral-criteria-gate" >&2
  echo "cannot evaluate the command. Restore the file; do not work around the" >&2
  echo "gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

[ "${CDKD_SKIP_DEFERRAL_CRITERIA_GATE:-}" = "1" ] && exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate (.claude/rules/hooks.md).
GATE_RE_API_MINT="${GATE_RE_GH_API_ISSUE_CREATE:-}"
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || { [ -n "$GATE_RE_API_MINT" ] && gate_matches "$cmd" "$GATE_RE_API_MINT"; } || exit 0

# The text channel for the bypass, in COMMAND POSITION only. Guarded on the
# helper existing: an older matcher simply leaves the channel un-honored, which
# fails toward BLOCKING, never toward a silent pass.
if declare -F strip_noncommand_spans >/dev/null 2>&1; then
  if strip_noncommand_spans "$cmd" \
    | grep -qE '(^|[|;&(][[:space:]]*)CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1([[:space:]]|$)'; then
    exit 0
  fi
fi

# --- resolve the target directory ONCE --------------------------------------
# Both the opt-in check and the relative `--body-file` resolution need the same
# directory and must agree. The verb ERE is DERIVED from the shared constant
# rather than hand-rolled: a local copy drops GATE_FLAGS' quoted alternative, so
# `gh -C "/a b" issue create` matches no verb, `cmd_last_cd_target` stops at
# nothing, and a TRAILING `cd` steers the lookup (the cdk-local#542 class).
# Passing a bare `gh` is worse still: the lookup then breaks at the FIRST gh
# segment, so the `gh issue list --search x && cd <repo> && gh issue create`
# chain the filing flow prescribes never sees the `cd`.
target_dir="${hook_cwd:-$PWD}"
if declare -F cmd_last_cd_target >/dev/null 2>&1; then
  _cd_target=$(cmd_last_cd_target "$cmd" "$target_dir" \
    "${GATE_RE_GH_ISSUE_CREATE#^}" 2>/dev/null || true)
  [ -n "$_cd_target" ] && target_dir="$_cd_target"
fi

# --- repo opt-in (issue #1259's scoping) ------------------------------------
# A cdkd session regularly files issues in unrelated personal repos, where this
# repo's `Session-fit` vocabulary does not exist and a refusal is pure friction
# (the 2026-07-27 shape, where a main-tree hook blocked a user-requested edit to
# a personal blog draft). So the gate fires only in a repo that opts in by
# carrying `.markgate.yml` at its root. The CWD's repo decides, not any
# `-R <owner/repo>`: `-R` names where the issue LANDS, the cwd names whose
# policy the session is operating under.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# --- the PR-shaped reason vocabulary ----------------------------------------
# Deliberately a SHORT closed list of the spellings this failure actually used,
# not an attempt to enumerate every way a person could say "PR". The threat
# model is an agent reaching for the cheap justification it has seen before, not
# one evading a regex: someone who rewords the reason to dodge this has had to
# read the criteria list to do it, which is the entire ask.
#
# `prs?` is bounded by `([^[:alnum:]]|$)` rather than `\b` -- `\b` is a GNU
# extension that BSD regcomp does not carry, so on macOS it would match nothing
# and the gate would be inert.
PR_SHAPE_RE='(own|separate)[[:space:]]+prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|shar(e|es|ing)[[:space:]]+((a|an|the|its|their)[[:space:]]+)?prs?([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|independent[[:space:]]+review[[:space:]]+surface'
PR_SHAPE_RE="$PR_SHAPE_RE"'|unreviewable'
PR_SHAPE_RE="$PR_SHAPE_RE"'|own[[:space:]]+review([^[:alnum:]]|$)'

OFFENDING_REASON=""

pr_shaped() { # <reason text> -> 0 when it is PR-shaped, and records it
  [[ $1 =~ $PR_SHAPE_RE ]] || return 1
  OFFENDING_REASON=$(printf '%s' "$1" | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')
  return 0
}

# Scan a body for a `Session-fit: next` line whose reason is PR-shaped.
#
# The reason continues onto WRAPPED lines, and that is not a refinement: an
# issue body written to 76 columns puts "needs its own PR" on the line AFTER
# `Session-fit: next (not this session) -- this touches a different subsystem
# and`, and a line-only scan would read the first half and pass. A continuation
# ends at a blank line, at the next `Key:` field (`Severity:` / `Effort:` /
# `Estimate:` / `Dup-check:`, list-prefixed or not), at a LIST ITEM, or at a
# markdown heading -- so a wrapped reason is read whole while the SIBLING
# fields, which are nobody's reason, are not folded in.
#
# The LIST-ITEM boundary is not decoration either. A body reading
#
#   Session-fit: next (not this session) -- blocked on an AWS quota increase
#   - the sibling cleanup would need its own PR, so it is filed separately
#
# folded the bullet into the reason and refused a deferral whose stated reason
# is a documented criterion. A bullet starts a new block in markdown exactly
# like a blank line or a heading does; it is a boundary for the same reason.
#
# FENCED CODE BLOCKS are removed before the scan (the same allow-list
# `pr-body-item-number-gate.sh` applies, and for the same reason). A body
# arguing ABOUT this rule quotes the refused line to do it, and quoting it
# inside a ```text fence is how a markdown body says "this is an exhibit, not
# an assertion". Without the strip, the FIRST `Session-fit:` match wins and
# `break`s, so a body whose own classification is `Session-fit: now` was
# refused over the exhibit above it -- and the advertised remedy (the bypass
# variable) is exactly what a body of that shape should not have to reach for.
# The bypass remains for the case a fence cannot express: PR-shaped reasoning
# quoted INLINE, in running prose.
#
# A `**Session-fit:**` / `**Session-fit**:` spelling is read like the bare one.
# Measured across 120 real issue bodies it appears zero times, so this is a
# latent gap rather than an observed miss -- it is one character class, and a
# gate that silently passes a bolded key teaches the wrong lesson when someone
# eventually writes one.
#
# `nocasematch` is enabled for the duration of this function and restored on the
# way out rather than set once at the top of the file, and that scoping is
# load-bearing: the shared matcher's `gate_matches` is a `[[ =~ ]]` too, so a
# file-wide `nocasematch` would silently widen EVERY gate verb this hook matches
# (`GH ISSUE CREATE` would arm it). It is used instead of a `[Ss]`-class regex
# or a `tr` pass because the reason has to be REPORTED BACK in its original
# casing, and lowercasing to match would mean carrying two copies of every line.
scan_text() { # <body text> -> 0 when the body carries a PR-shaped deferral
  local text="$1" line rest active=0 reason="" rc=1 nocase_was=0 fence=0 fence_mark=""
  # A fence line is `` ``` `` or `~~~`, indented or not. The CONTENT of the
  # block is invisible to the scan; the fence line itself also closes an open
  # continuation, because a fenced block starts a new markdown block exactly
  # like a heading does.
  # A fence OPENS only when its own closer appears later, and closes only on the
  # SAME marker. Both halves are load-bearing and both were missing at first:
  # latching on any opener with no look-ahead makes an UNCLOSED fence blank
  # every remaining line (rc=0 where the pre-fence hook said 2), and ignoring
  # the marker type lets a ``` line inside a ~~~ block close it early. This is
  # the exact class .claude/rules/hooks.md documents for heredoc openers --
  # "latching onto any <<WORD blanks every remaining line, fail open" -- so the
  # look-ahead is copied from that solution rather than re-derived.
  local fence_open_re='^[[:space:]]*(```|~~~)'
  # `[*_]*` on both sides of the colon accepts `**Severity:**` and
  # `**Severity**:`. Keeping the two boundary tests in sync with the key
  # spelling `session_fit_re` accepts is load-bearing: a body that bolds one
  # field bolds them all, so a bold-blind boundary would fold the whole field
  # block into the reason.
  local key_re='^[[:space:]]*([-*+>][[:space:]]+)?[*_]*[A-Za-z][A-Za-z_-]*[*_]*:'
  local item_re='^[[:space:]]*([-*+]|[0-9]+[.)])[[:space:]]+'
  local session_fit_re='session-fit[*_]*:[*_]*(.*)$'
  case "$(shopt -p nocasematch)" in *-s*) nocase_was=1 ;; esac
  shopt -s nocasematch
  # Buffered into an array rather than streamed, because the opener has to look
  # AHEAD for its own closer. Built with a read loop, not `mapfile` -- the hook
  # suites run under macOS bash 3.2, where `mapfile` does not exist and would be
  # a runtime error, which for a gate is a silent pass.
  local -a lines=()
  local n=0
  while IFS= read -r line; do
    lines[$n]="$line"
    n=$((n + 1))
  done <<EOF
$text
EOF
  local i=0 j
  while [ "$i" -lt "$n" ]; do
    line="${lines[$i]}"
    i=$((i + 1))
    if [[ $line =~ $fence_open_re ]]; then
      local mark="${BASH_REMATCH[1]}" closes=0
      if [ "$fence" = "1" ]; then
        # Close only on the marker that opened it.
        if [ "$mark" = "$fence_mark" ]; then fence=0; fence_mark=""; fi
        continue
      fi
      # Open only if this same marker recurs LATER; a stray fence line must not
      # swallow the rest of the body.
      j=$i
      while [ "$j" -lt "$n" ]; do
        case "${lines[$j]}" in
          *"$mark"*)
            if [[ ${lines[$j]} =~ ^[[:space:]]*"$mark" ]]; then closes=1; break; fi
            ;;
        esac
        j=$((j + 1))
      done
      if [ "$closes" = "1" ]; then
        fence=1
        fence_mark="$mark"
        if [ "$active" = "1" ]; then
          active=0
          if pr_shaped "$reason"; then rc=0; break; fi
        fi
        continue
      fi
      # Not a real fence -- fall through and treat it as ordinary text.
    fi
    if [ "$fence" = "1" ]; then
      continue
    fi
    if [ "$active" = "1" ]; then
      if [[ $line =~ ^[[:space:]]*$ ]] \
        || [[ $line =~ $key_re ]] \
        || [[ $line =~ $item_re ]] \
        || [[ $line =~ ^[[:space:]]*\# ]]; then
        active=0
        if pr_shaped "$reason"; then rc=0; break; fi
      else
        reason="$reason $line"
      fi
    fi
    if [[ $line =~ $session_fit_re ]]; then
      # A second `Session-fit:` closes whatever the first one opened.
      if [ "$active" = "1" ]; then
        if pr_shaped "$reason"; then rc=0; break; fi
      fi
      rest="${BASH_REMATCH[1]}"
      # ONLY `next` is gated. `now` is never refused, whatever its reason says
      # -- an agent talking itself INTO finishing the work needs no supervision.
      # A line stating neither token (an old packed body, a `Session-fit` in
      # prose) is not a deferral decision this gate can read, so it passes.
      if [[ $rest =~ ^[[:space:]]*next([^[:alpha:]]|$) ]]; then
        reason="$rest"
        active=1
      else
        active=0
        reason=""
      fi
    fi
  done
  if [ "$rc" != "0" ] && [ "$active" = "1" ]; then
    pr_shaped "$reason" && rc=0
  fi
  [ "$nocase_was" = "1" ] || shopt -u nocasematch
  return "$rc"
}

# --- go-to-k/cdkd#2397's heredoc extraction, ported -------------------------
# These three are a near-copy of gh-body-english-gate.sh's, which solved this
# exact window first; the comments there carry the full derivation, and the
# subtleties are restated here only where this gate would break without them.
#
# `cmd_writes` and `cmd_replaces` answer DIFFERENT questions and must not be
# collapsed: `>>` / `tee -a` APPEND, so what is on disk is the FIRST HALF of
# the body being submitted and still has to be scanned; only `>` / `tee`
# supersede it.
cmd_writes() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    # The trailing class covers the TIGHT spellings -- `>f<<EOF`, `>f;`,
    # `>f&&` -- which a `(?:\s|$)` terminator misses, and `>f<<EOF` is the
    # very shape this exists for.
    exit 0 if $c =~ /(?:>>?|\btee\b(?:\s+-a)?)\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

cmd_replaces() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    exit 0 if $c =~ /(?:(?<!>)>(?!>)|\btee\b(?!\s+-a\b))\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
    exit 1;
  ' 2>/dev/null
}

# EVERY heredoc body that writes the path, in order. Both orders
# (`cat > f <<EOF` and `cat <<EOF > f`), quoted and unquoted delimiters, and
# `<<-`, whose terminator may be indented by TABS only -- stripping all leading
# whitespace makes an indented `  EOF` INSIDE the body end the extraction
# early, so everything after it goes unscanned while bash still submits it.
# The STATUS, not the output, reports whether a heredoc was found: an empty
# heredoc body is legal and prints nothing.
heredoc_bodies_for() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e '
    my $c = $ENV{CMD};
    my $t = quotemeta($ENV{TARGET});
    my @lines = split /\n/, $c, -1;
    my @out;
    my $found = 0;
    for (my $i = 0; $i <= $#lines; $i++) {
      my $l = $lines[$i];
      next unless $l =~ /(?:>>?|\btee\b(?:\s+-a)?)\s*(["\x27]?)$t\1(?:[\s;&|)<]|$)/;
      next unless $l =~ /(<<-?)\s*(["\x27]?)([A-Za-z_][A-Za-z0-9_]*)\2/;
      my $dash  = ($1 eq "<<-");
      my $delim = $3;
      $found = 1;
      my $j = $i + 1;
      while ($j <= $#lines) {
        my $probe = $lines[$j];
        $probe =~ s/^\t+// if $dash;
        last if $probe eq $delim;
        push @out, $lines[$j];
        $j++;
      }
      # Resume AFTER this body and do NOT stop at the first: one path can be
      # written by more than one heredoc in one command.
      $i = $j;
    }
    print join("\n", @out), "\n" if @out;
    exit($found ? 0 : 1);
  ' 2>/dev/null
}

# Each matcher is offered BOTH spellings of the path -- the one the command
# writes and the one it hands to gh -- because they need not be the same
# string (`cat > /abs/b.md ... --body-file b.md`), and either half alone leaves
# that shape unscanned. The short-circuit on equality saves a perl spawn on the
# common absolute spelling.
cmd_writes_either() { # <raw spelling> <resolved path>
  cmd_writes "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_writes "$2"
}
cmd_replaces_either() { # <raw spelling> <resolved path>
  cmd_replaces "$1" && return 0
  [ "$1" = "$2" ] && return 1
  cmd_replaces "$2"
}
heredoc_bodies_either() { # <raw spelling> <resolved path>
  heredoc_bodies_for "$1" && return 0
  [ "$1" = "$2" ] && return 1
  heredoc_bodies_for "$2"
}

# The BODY text of ONE segment, in descending order of specificity:
#
#   1. the HEREDOC BODY that this command writes to the named `--body-file`,
#      when it writes one -- see below; this is the arm that closes the
#      fail-open
#   2. the contents of the file at that path, unless arm 1 fired AND the
#      command TRUNCATES the path (an APPEND leaves the existing content as
#      the first half of the submitted body)
#   3. the WHOLE command, when such a path was named, cannot be read, and no
#      heredoc writes it -- a `printf > f` / `python3 -c ... > f` body, or an
#      unresolvable `$VAR` path
#   4. the inline `--body` value, plus the `-f`/`--field` `body=` forms the REST
#      mint uses, quote-aware so a multi-word body stays one value
#
# ARM 1 IS NOT AN OPTIMISATION. The hook runs BEFORE the command, so in the
# one-call `heredoc -> file -> --body-file` shape this repo MANDATES, the path
# either does not exist yet or still holds what a PREVIOUS call left there. A
# file-first read judged that previous body, so a stale-but-clean file made the
# gate INERT against the body actually being submitted -- measured on this
# hook before the port:
#
#   stale clean file + heredoc carrying "needs its own PR"   rc=0  (INERT)
#   same command with the file ABSENT                        rc=2
#   gh-body-english-gate.sh on the identical shape           rc=2
#
# That last row is why this is a port rather than a design: the sibling had
# already closed the window (go-to-k/cdkd#2397) and this gate shipped with the
# pre-#2397 shape. Arm 3 stays for everything the extraction cannot see.
#
# There is deliberately NO last-resort "scan the whole segment" arm, which is
# where this diverges from issue-classification-label-gate.sh. That gate must
# find a value SOMEWHERE or its labels mean nothing; this one objects to content
# it FINDS, so a fallback that folds `--title` and `--label` text in can only
# manufacture false blocks -- a title reading `Session-fit: next handling for
# its own PR` is a title about the rule, not a deferral.
#
# The extraction below is a near-copy of issue-classification-label-gate.sh's
# and issue-dup-check-gate.sh's, deliberately not shared: each caller treats an
# unreadable path differently (that one falls back, dup-check REFUSES, this one
# falls back), and reconciling the three would mean picking one. Stated rather
# than left to be discovered: if you fix a path-extraction bug in any of them,
# check the other two.
segment_body_text() { # <segment>
  local seg="$1" f f_raw out="" hd have_hd
  while IFS= read -r f_raw; do
    [ -n "$f_raw" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back to the whole command
    # rather than refusing: unlike dup-check, this gate demands nothing be
    # PRESENT, so "cannot read" is not evidence of a violation.
    case "$f_raw" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
    # BOTH spellings are kept. `f` is the path to READ; `f_raw` is the path as
    # the command SPELLS it, and the write-detection above matches against the
    # RAW COMMAND TEXT -- handed only the resolved absolute path it matches
    # nothing whenever the command writes a RELATIVE or `~/` path, which is the
    # gap the sibling gate had to close separately.
    #
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    f="$f_raw"
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    hd=""
    have_hd=0
    if [ ! -r "$f" ] || cmd_writes_either "$f_raw" "$f"; then
      hd=$(heredoc_bodies_either "$f_raw" "$f") && have_hd=1
    fi
    if [ "$have_hd" = "1" ]; then
      out="$out
$hd"
      # Only a TRUNCATING write supersedes what is on disk. After an append the
      # file is still the first half of the submitted body.
      if cmd_replaces_either "$f_raw" "$f"; then
        continue
      fi
    fi
    if [ -r "$f" ]; then
      out="$out
$(cat "$f" 2>/dev/null || true)"
    elif [ "$have_hd" != "1" ]; then
      out="$out
$cmd"
    fi
  # `body=@` is matched FIRST so an `-F body=@path` is not also read as a bare
  # `-F path`. The bare `-F <path>` arm is not optional: `-F` is gh's short
  # `--body-file`.
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
    ' 2>/dev/null)

  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  printf '%s' "$seg" | perl -0777 -ne '
    while (/(?:^|\s)--body[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      print "$v\n";
    }
    while (/(?:^|\s)(?:-f|--field|--raw-field)[=\s]+("(?:[^"\\]|\\.)*"|\x27[^\x27]*\x27|\S+)/g) {
      my $v = $1;
      $v =~ s/^["\x27]//; $v =~ s/["\x27]$//;
      next unless $v =~ s/^body=//;
      next if $v =~ /^\@/;
      print "$v\n";
    }' 2>/dev/null
}

# EVERY scan is scoped to the SEGMENT that is the `gh issue create`, never to
# the whole command, and the scoping is load-bearing in BOTH directions here.
# `-F` is `git commit`'s flag as well as gh's short `--body-file`, so an
# unscoped extraction reads the COMMIT MESSAGE -- and commit messages quote the
# lines they describe (the commit introducing this gate quotes a PR-shaped
# `Session-fit: next` line as the thing it refuses). Unscoped, that commit's own
# `git commit -F <msg> && gh issue create --body-file <clean>` would have been
# refused over text that is not the issue body at all.
offending_seg=""
while IFS= read -r seg; do
  if ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    if [ -z "$GATE_RE_API_MINT" ] || ! gate_matches "$seg" "$GATE_RE_API_MINT"; then
      continue
    fi
  fi
  body_text=$(segment_body_text "$seg")
  [ -n "$body_text" ] || continue
  if scan_text "$body_text"; then
    offending_seg="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending_seg" ] || exit 0

{
  echo "Blocked by issue-deferral-criteria-gate: this \`gh issue create\` body"
  echo "defers the work with a PR-SHAPED reason:"
  echo ""
  echo "  Session-fit: ${OFFENDING_REASON}"
  echo ""
  echo "PR shape is not a \`Session-fit\` criterion. \`Session-fit\` answers one"
  echo "question -- do I finish this in THIS session? -- and splitting the work"
  echo "across several PRs is normal, needs no permission, and costs no session:"
  echo "one lane can open two PRs in the same hour. Decide the SPLIT on review"
  echo "surface; decide \`Session-fit\` on the criteria list."
  echo ""
  echo "The legitimate \`next\` criteria, in full (.claude/rules/session-report.md"
  echo "-> ### Session-fit):"
  echo ""
  echo "  - a NEW integ fixture must be WRITTEN (running an EXISTING one is"
  echo "    never a deferral reason -- measured median 85 s over the ledger)"
  echo "  - external input: a quota, a maintainer decision, an upstream fix"
  echo "  - an independent subsystem with no file overlap AND no \`now\`"
  echo "    criterion firing"
  echo ""
  echo "If none of those fires, this is a \`now\`. Check the \`now\` list too --"
  echo "it lands in files this session already has open; main is left"
  echo "self-inconsistent without it; it blocks another lane; it rides an"
  echo "EXISTING integ fixture; its evidence exists only in this session; the"
  echo "user cannot use the result yet."
  echo ""
  echo "Two ways out, both of which leave the gate doing its job:"
  echo ""
  echo "  - re-classify: \`Session-fit: now\` -- and do it in this session"
  echo "  - re-state the real reason, if one of the three above genuinely"
  echo "    fires, and NAME the next session's verification command beside it"
  echo ""
  echo "Measured 2026-09-04: three findings were deferred in one session on this"
  echo "exact reasoning (go-to-k/cdkd#2587 / go-to-k/cdkd#2588 /"
  echo "go-to-k/cdkd#2590); all three were re-classified \`now\` and finished in"
  echo "that same session. This gate is /work-issues retro section 10-b applied"
  echo "to a rule that was already written down three times and violated anyway."
  echo ""
  echo "Deliberate exception (a body QUOTING PR-shaped reasoning INLINE, in"
  echo "prose, in order to argue against it -- a quote inside a \`\`\` fenced"
  echo "block needs no bypass; fenced blocks are not scanned):"
  echo ""
  echo "  CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create ..."
  echo ""
  echo "Rule: .claude/rules/session-report.md -> ### Session-fit; /work-issues"
  echo "section 3-b (\"'It needs its own PR' is NOT a \`next\` reason\")."
} >&2
exit 2
