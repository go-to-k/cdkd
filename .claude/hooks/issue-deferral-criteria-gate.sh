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
# RE-MEASURED after the 2026-09-05 quoted-value / bold-value / vocabulary /
# boundary round, because widening a vocabulary can move the fire count and a
# coverage claim taken before the widening is not evidence for the code after
# it. Same command, later the same day: the population is 259 (the corpus MOVED
# under a `--limit 300` window -- four more bodies carry the field line), and
# the gate fires on 66, the SAME 66 as the pre-fix hook, by file. Nothing was
# newly refused and nothing stopped being refused. So all three widenings are
# LATENT rather than live: `separate review surface` appears in 0 of the 259, a
# bolded `**next**` value in 0, and no fired body's reason wrapped over a line
# carrying a stray colon. They close shapes the corpus has not written yet --
# which is the point of fixing them while they are cheap, and the reason the
# regression cases are synthetic.
#
# Corpus reading, so the coverage claim is a number rather than an impression.
# This is the EARLIER of the two same-day readings (the paragraph above is the
# later one, taken after the widenings); both are kept because the difference
# between them is the point -- the denominator moves under a `--limit 300`
# window while the fire count did not.
# Over `gh issue list --state all --limit 300 --json number,body` (2026-09-05),
# 255 of the 300 bodies carried a `Session-fit: next` FIELD LINE and the gate
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
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_PERL_WORD:-}" ]; then
  # `GATE_PERL_WORD` is checked for the same reason as the constant above, and
  # its absence is WORSE than a missing function: left undefined, the `$GW` the
  # extraction interpolates becomes the EMPTY string, `($GW)` matches empty at
  # every position, and every body path comes back empty -- a silent fail-open
  # rather than a 127.
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
# `PR` and `pull request` are the SAME term, and so is a hyphen in place of the
# space -- these are SPELLINGS of one noun, not the "third spelling in a third
# round" the note below refuses to chase (which is about reasoning that never
# names a PR at all). Measured before this alternation: `its own pull request`
# and `its own-PR` both filed at rc=0 while `its own PR` gave 2.
PR_SHAPE_RE='(own|separate)[[:space:]-]+(prs?|pull[[:space:]-]+requests?)([^[:alnum:]]|$)'
PR_SHAPE_RE="$PR_SHAPE_RE"'|shar(e|es|ing)[[:space:]]+((a|an|the|its|their)[[:space:]]+)?(prs?|pull[[:space:]-]+requests?)([^[:alnum:]]|$)'
# `(independent|separate)` rather than `independent` alone. `a separate review
# surface` is as PR-shaped as `an independent` one, and the divergence was
# measured against cdk-local's port of this gate, which already carried both:
# the same body answered rc=0 here and blocked there. The three repos answering
# differently on one deferral is the failure this whole family exists to
# prevent, so the vocabulary is kept in sync deliberately rather than by
# coincidence.
PR_SHAPE_RE="$PR_SHAPE_RE"'|(independent|separate)[[:space:]]+review[[:space:]]+surface'
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
  #
  # The key is the NAMED FIELD SET, not `any word followed by a colon`. The
  # loose spelling `[A-Za-z][A-Za-z_-]*:` read an ordinary English sentence
  # wrapping onto a line that merely CONTAINS a colon as the next field and cut
  # the reason there. Measured 2026-09-05, rc=0 where the reason is plainly
  # PR-shaped:
  #
  #   Session-fit: next (not this session) -- a different subsystem
  #   entirely: it needs its own PR.
  #
  # `entirely:` ended the continuation, so `it needs its own PR` was never
  # scanned. Truncating the reason is the FAIL-OPEN direction, and the comment
  # at this spot already claimed the boundary was the sibling FIELDS
  # (`Severity:` / `Effort:` / `Estimate:` / `Dup-check:`) -- the code just did
  # not say so. `Notes:` is in the list because session-report.md's TODO block
  # adds it; `nocasematch` is on, so one lowercase spelling covers every casing.
  local key_re='^[[:space:]]*([-*+>][[:space:]]+)?[*_]*(session-fit|severity|effort|estimate|notes|dup-check)[*_]*:'
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
      # `[*_]*` before `next` for the same reason the KEY accepts it, and the
      # asymmetry was a measured silent pass: a body that bolds one field bolds
      # them all, and `Session-fit: **next** (not this session) -- it needs its
      # own PR` gave rc=0 while `**Session-fit:** next ...` with the identical
      # reason gave 2. No corpus instance today, so this is latent rather than
      # live -- and a gate that silently passes the bolded VALUE while refusing
      # the bolded KEY is the shape nobody would trust once they found it.
      if [[ $rest =~ ^[[:space:]]*[*_]*next([^[:alpha:]]|$) ]]; then
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
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # See the note on the sibling matcher in this file: the redirect TARGET is
    # matched as a shell WORD and unquoted before comparison, because
    # `$ENV{TARGET}` has already been through `gate_unq` and the retired
    # `(["\x27]?)$t\1` class could only match spellings that need no
    # unquoting -- notably NOT `> /a\ b/x.md`.
    my $c = $ENV{CMD};
    my $want = $ENV{TARGET};
    # The trailing class covers the TIGHT spellings -- `>f<<EOF`, `>f;`,
    # `>f&&` -- which a `(?:\s|$)` terminator misses, and `>f<<EOF` is the
    # very shape this exists for.
    exit 0 if line_writes($c, $want, 1);
    exit 1;
  ' 2>/dev/null
}

cmd_replaces() { # <path as the command spells it>
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # See the note on the sibling matcher in this file: the redirect TARGET is
    # matched as a shell WORD and unquoted before comparison, because
    # `$ENV{TARGET}` has already been through `gate_unq` and the retired
    # `(["\x27]?)$t\1` class could only match spellings that need no
    # unquoting -- notably NOT `> /a\ b/x.md`.
    my $c = $ENV{CMD};
    my $want = $ENV{TARGET};
    exit 0 if line_writes($c, $want, 0);
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
  CMD="$cmd" TARGET="$1" perl -0777 -e "$GATE_PERL_WORD"'
    # See the note on the sibling matcher in this file: the redirect TARGET is
    # matched as a shell WORD and unquoted before comparison, because
    # `$ENV{TARGET}` has already been through `gate_unq` and the retired
    # `(["\x27]?)$t\1` class could only match spellings that need no
    # unquoting -- notably NOT `> /a\ b/x.md`.
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
#   3. this SEGMENT plus every OTHER segment that WRITES the path, when such a
#      path was named, cannot be read, and no heredoc writes it -- a
#      `printf > f` body, or an unresolvable `$VAR` path. Not the whole
#      command: that refuses a filing whose sibling `git commit -m` message
#      merely QUOTES a PR-shaped line, and it does so even when a writer is
#      present, so "is there a writer" is the wrong question and "WHICH segment
#      is the writer" is the right one. NOTE this arm carries the writer`s
#      COMMAND TEXT, not its output -- a `printf`-written body is only seen
#      because the text appears in the command, so a writer over a READABLE
#      file is not consulted at all (arm 2 wins, and arm 1 covers heredocs
#      only).
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
# `gh api ... --input <file>`: the REST mint`s body lives in a JSON payload on
# disk, which is a body CHANNEL none of the `--body-file` / `-F` / `-f body=`
# arms above recognises. Extract `.body` from it.
#
# The path goes through the SAME resolution as the `--body-file` arms, and for
# the same reasons: a relative path is joined to the resolved cwd, a literal
# `~/` is expanded, and a payload the command WRITES in this very call is read
# out of its heredoc rather than off disk (writing the payload with a heredoc
# in the same command is this repo`s own documented filing recipe). Resolving
# only absolute, already-existing paths closed the narrowest third of the hole:
# measured, `--input rel.json` and a `cat > x.json <<JSON` payload both filed a
# PR-shaped `next` at rc=0 while the `--body-file` twin of each gave rc=2.
#
# Failure at any step (no `--input`, unreadable path, not JSON, no `body` key)
# prints nothing, which the caller treats as "channel not recognised" and
# passes -- this gate demands nothing be PRESENT, so "cannot read" is never
# evidence of a violation.
input_body_text() { # <segment>
  local seg="$1" f_raw f hd have_hd
  f_raw=$(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
    if (/(?:^|\s)--input[=\s]+($GW)/) { print gate_unq($1), "\n"; }
  ' 2>/dev/null)
  [ -n "$f_raw" ] || return 0
  # A `$VAR` path cannot be resolved to disk -- but a heredoc in THIS command is
  # keyed on the RAW spelling and needs no resolution, and writing the payload
  # with a heredoc in the same call is the documented recipe. Measured before
  # this arm: `cat > "$P" <<JSON ... JSON && gh api ... --input "$P"` filed at
  # rc=0 while the `--body-file` twin gave 2.
  case "$f_raw" in
    *'$'*|*'`'*)
      hd=$(heredoc_bodies_either "$f_raw" "$f_raw") || hd=""
      [ -n "$hd" ] && printf '%s' "$hd" | jq -r '.body // empty' 2>/dev/null
      return 0 ;;
  esac
  # shellcheck disable=SC2088
  f="$f_raw"
  case "$f" in
    /*) ;;
    "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
    *) f="$target_dir/$f" ;;
  esac
  # The STATUS, not the OUTPUT. An empty heredoc body is legal, and reading
  # emptiness as "no heredoc" falls through to the STALE file on disk -- so
  # `cat > p.json <<JSON` with an empty body judged the PREVIOUS payload
  # (measured rc=2 where the `--body-file` twin gives 0).
  have_hd=0
  if [ ! -r "$f" ] || cmd_writes_either "$f_raw" "$f"; then
    hd=$(heredoc_bodies_either "$f_raw" "$f") && have_hd=1
  fi
  if [ "$have_hd" = "1" ]; then
    printf '%s' "$hd" | jq -r '.body // empty' 2>/dev/null || true
    return 0
  fi
  [ -r "$f" ] || return 0
  jq -r '.body // empty' "$f" 2>/dev/null || true
}

# Restore the line structure `gate_segments` flattened, for the values the
# caller extracted from THIS segment.
#
# The lookup is scoped to the segment's own bytes, and the segmenter makes that
# exact rather than approximate: it rewrites a newline to a SPACE and leaves
# every other byte alone, so collapsing the whole command the same way produces
# a string of identical LENGTH in which the segment appears verbatim. Its byte
# offset there is its byte offset in the raw command, and the raw slice is that
# offset plus the segment's length.
#
# Scoping matters because an unscoped table decides this segment's verdict from
# ANOTHER segment's text: a `gh issue comment --body` whose collapsed form
# equals the create's body handed the create its own newline placement, and the
# create alone reached the opposite verdict. Not a bounded fail-open either --
# added line structure can expose a LATER `Session-fit:` that the flat line hid,
# because `scan_text` reads the first match per line.
#
# Restoration is not a safety direction, it is ACCURACY: the gate should judge
# the body gh will send. A value the slice does not contain is left flat.
restore_inline_newlines() { # <extracted values, one per line> <raw command> <segment>
  local values="$1" raw="$2" seg="$3" restored
  restored=$(GATE_RAW="$raw" GATE_SEG="$seg" GATE_COLLAPSED="$values" perl -e "$GATE_PERL_WORD"'
    my $raw = $ENV{GATE_RAW};
    my $seg = $ENV{GATE_SEG};
    (my $flat = $raw) =~ s/\n/ /g;
    my $off = index($flat, $seg);
    # No slice means the segment did not come from this command text (a caller
    # passing something else, or a segmenter that rewrote more than newlines).
    # Print the input unchanged rather than guess.
    my $slice = $off < 0 ? "" : substr($raw, $off, length($seg));
    my %raw;
    my $keep = sub {
      my ($v) = @_;
      return unless $v =~ /\n/;
      (my $c = $v) =~ s/\n/ /g;
      $raw{$c} = $v unless exists $raw{$c};
    };
    # MIRROR the extractor exactly: `--body` needs a separator, `-b` does not.
    # Demanding one for both false-blocks the GLUED `-b<multi-line body>` -- it
    # is extracted flattened and then never restored, which is precisely the
    # defect this function exists to prevent (measured rc=2 on a legitimate
    # two-field body).
    for ($slice) {
      while (/(?:^|\s)--body[=\s]+($GW)/g) { $keep->(gate_unq($1)); }
      while (/(?:^|\s)-b[=\s]*($GW)/g)     { $keep->(gate_unq($1)); }
      while (/(?:^|\s)(?:-f|--field|--raw-field)[=\s]*($GW)/g) {
        my $v = gate_unq($1);
        next unless $v =~ s/^body=//;
        next if $v =~ /^\@/;
        $keep->($v);
      }
    }
    for my $l (split /\n/, $ENV{GATE_COLLAPSED}, -1) {
      print exists $raw{$l} ? $raw{$l} : $l, "\n";
    }
  ' 2>/dev/null)
  # Fail SAFE, not open: if perl produced nothing the caller keeps the
  # flattened text it already had, which is the pre-fix behaviour.
  if [ -n "$restored" ]; then printf '%s' "$restored"; else printf '%s' "$values"; fi
}

# The body-file fallback text: the `gh` SEGMENT, plus every OTHER segment that
# WRITES the path -- never the whole command.
#
# Three shapes, and only this rule gets all three right. Measured, each on a
# body whose PR-shaped text is in the place named:
#
#   `$seg` only    lost the writer: `printf <PR-shaped> > b.md && gh issue
#                  create --body-file b.md` (b.md unreadable) went 2 -> 0.
#   `$cmd` whole   refused a filing whose sibling `git commit -m` message
#                  merely QUOTES a PR-shaped line: 0 -> 2.
#   `$cmd` when a  still refuses it the moment BOTH exist in one chain --
#   writer exists  `git commit -m <PR-shaped> && printf <clean> > b.md &&
#                  gh issue create --body-file b.md` gave 2.
#
# So the question is not "is there a writer somewhere" but "WHICH segment is
# the writer", and the segmenter already answers it. `cmd_writes` reads the
# global `$cmd`, so each segment is tested with that global rebound inside a
# SUBSHELL -- rebinding it in place would corrupt every later scan.
fallback_body_text() { # <raw spelling> <resolved path> <gh segment>
  local f_raw="$1" f="$2" seg="$3" s out
  out="$seg"
  while IFS= read -r s; do
    [ -n "$s" ] || continue
    [ "$s" = "$seg" ] && continue
    if ( cmd="$s"; cmd_writes_either "$f_raw" "$f" ); then
      out="$out
$s"
    fi
  done < <(gate_segments "$cmd")
  printf '%s' "$out"
}

segment_body_text() { # <segment>
  local seg="$1" f f_raw out="" hd have_hd
  while IFS= read -r f_raw; do
    [ -n "$f_raw" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back to the whole command
    # rather than refusing: unlike dup-check, this gate demands nothing be
    # PRESENT, so "cannot read" is not evidence of a violation.
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back rather than refuse:
    # unlike dup-check, this gate demands nothing be PRESENT, so "cannot read"
    # is not evidence of a violation. Both spellings passed to the writer probe
    # are the RAW one -- there is no resolved path here, which is the point.
    case "$f_raw" in
      *'$'*|*'`'*) out="$out
$(fallback_body_text "$f_raw" "$f_raw" "$seg")"; continue ;;
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
      # Same rule as the unresolvable-path arm above.
      out="$out
$(fallback_body_text "$f_raw" "$f" "$seg")"
    fi
  # `body=@` is matched FIRST so an `-F body=@path` is not also read as a bare
  # `-F path`. The bare `-F <path>` arm is not optional: `-F` is gh's short
  # `--body-file`.
  #
  # The value class is `$GW` from the SHARED `GATE_PERL_WORD` prelude, not a
  # local `(["\x27]?)([^"\x27\s]+)\1`. That local shape could not span a QUOTED
  # PATH CONTAINING A SPACE, so it extracted NOTHING and this gate judged an
  # empty body -- measured 2026-09-05, `--body-file "<dir with space>/x.md"`
  # carrying a PR-shaped deferral gave rc=0 where the unquoted spelling gave 2.
  # See lib/command-match.sh -> GATE_PERL_WORD for the other hole it closes and
  # why the class is defined once rather than per hook.
  done < <(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
      while (/(?:--field|--raw-field|-F)[=\s]*($GW)/g) {
        my $v = gate_unq($1);
        next unless $v =~ s/^body=\@//;
        print "$v\n";
      }
      while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
      # A bare `-F <path>` carries no `key=`, which is what distinguishes it
      # from the `gh api -F body=@p` form handled above.
      while (/(?:^|\s)-F[=\s]*($GW)(?=\s|$)/g) {
        my $v = gate_unq($1);
        next if $v =~ /=/;
        print "$v\n";
      }
    ' 2>/dev/null)

  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  # ARM 4, and the `-f body=` half of it had its own measured fail-open. The
  # old value alternative was tried AFTER the literal `body=`, so gh's OWN
  # documented spelling -- `-f body='<text>'`, quote INSIDE the value -- fell
  # through to `\S+` and captured `body='a`. Measured 2026-09-05: rc=0 on a
  # PR-shaped deferral, where `-f 'body=<same text>'` (quote OUTSIDE, the only
  # shape this suite covered) gave 2; `-f body="..."` and `--field body='...'`
  # were rc=0 too. `$GW` takes the whole shell WORD first and `gate_unq` then
  # removes the quoting wherever it sat, so all four spellings land on the same
  # value.
  printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
    while (/(?:^|\s)--body[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
    # `-b` is gh`s documented short `--body`, and this scan is already scoped
    # to the `gh issue create` SEGMENT, so it cannot collide with a `-b`
    # belonging to another command. Without it the gate was INERT on that
    # spelling: measured, the same PR-shaped reason gave rc=0 through `-b` and
    # rc=2 through `--body`.
    while (/(?:^|\s)-b[=\s]*($GW)/g) { print gate_unq($1), "\n"; }
    while (/(?:^|\s)(?:-f|--field|--raw-field)[=\s]*($GW)/g) {
      my $v = gate_unq($1);
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
# The load guard above tests only that GATE_PERL_WORD is NON-EMPTY, which cannot
# see a prelude that is present but does not COMPILE -- and that failure is
# SILENT, because every extraction runs perl with stderr discarded, so the gate
# would extract nothing and PASS what it exists to refuse. Probe it functionally,
# once, here: after arming (so ordinary Bash calls pay nothing) and at TOP LEVEL.
# TOP LEVEL is load-bearing -- the extraction helpers are called inside `$( )`,
# where `exit 2` ends only the substitution subshell: measured, an in-function
# guard PRINTED its refusal and the hook still returned 0.
gate_perl_word_or_die issue-deferral-criteria-gate || exit 2

while IFS= read -r seg; do
  if ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    if [ -z "$GATE_RE_API_MINT" ] || ! gate_matches "$seg" "$GATE_RE_API_MINT"; then
      continue
    fi
  fi
  body_text=$(segment_body_text "$seg")
  # An extraction that comes back EMPTY is not evidence of a clean body -- it
  # means no arm recognised the body CHANNEL. `--input <file>` is one: the REST
  # mint (`gh api repos/o/r/issues`) that `GATE_RE_API_MINT` already arms on
  # carries its whole payload as JSON on disk, and no arm above reads it.
  # Measured: `gh api repos/o/r/issues -f title=t --input p.json` with a
  # PR-shaped `Session-fit: next` in `p.json` filed at rc=0.
  #
  # Read `.body` out of it, with the same "cannot read is not evidence" rule as
  # the `--body-file` arms: an unreadable or non-JSON file leaves `body_text`
  # empty and the segment passes.
  if [ -z "$body_text" ]; then
    body_text=$(input_body_text "$seg")
  fi
  [ -n "$body_text" ] || continue
  body_text=$(restore_inline_newlines "$body_text" "$cmd" "$seg")
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
