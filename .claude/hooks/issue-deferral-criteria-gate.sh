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
#     rather than refusing (see `segment_body_text`). A body file written by a
#     heredoc IN this command is caught through that same fallback.
#   - The vocabulary is a closed list, so a reworded PR-shaped reason passes.
#     Deliberate: see the note on PR_SHAPE_RE.
#
# ESCAPE HATCH: CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1, honored from the hook's own
# process env AND from a leading assignment in the COMMAND TEXT -- an agent's
# Bash call cannot populate a PreToolUse hook's environment, so the text channel
# is the only one the refusal can advertise (the go-to-k/cdkd#2368 lesson, where
# an advertised remediation silently did nothing). The text check runs through
# `strip_noncommand_spans` + command position, so a QUOTED mention does not
# bypass anything. It exists for the case this gate cannot see: a body quoting
# someone else's PR-shaped reasoning in order to argue against it.

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
# `Estimate:` / `Dup-check:`, list-prefixed or not), or at a markdown heading --
# so a wrapped reason is read whole while the SIBLING fields, which are nobody's
# reason, are not folded in.
#
# `nocasematch` is enabled for the duration of this function and restored on the
# way out rather than set once at the top of the file, and that scoping is
# load-bearing: the shared matcher's `gate_matches` is a `[[ =~ ]]` too, so a
# file-wide `nocasematch` would silently widen EVERY gate verb this hook matches
# (`GH ISSUE CREATE` would arm it). It is used instead of a `[Ss]`-class regex
# or a `tr` pass because the reason has to be REPORTED BACK in its original
# casing, and lowercasing to match would mean carrying two copies of every line.
scan_text() { # <body text> -> 0 when the body carries a PR-shaped deferral
  local text="$1" line rest active=0 reason="" rc=1 nocase_was=0
  case "$(shopt -p nocasematch)" in *-s*) nocase_was=1 ;; esac
  shopt -s nocasematch
  while IFS= read -r line; do
    if [ "$active" = "1" ]; then
      if [[ $line =~ ^[[:space:]]*$ ]] \
        || [[ $line =~ ^[[:space:]]*([-*+>][[:space:]]+)?[A-Za-z][A-Za-z_-]*: ]] \
        || [[ $line =~ ^[[:space:]]*\# ]]; then
        active=0
        if pr_shaped "$reason"; then rc=0; break; fi
      else
        reason="$reason $line"
      fi
    fi
    if [[ $line =~ session-fit:(.*)$ ]]; then
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
  done < <(printf '%s\n' "$text")
  if [ "$rc" != "0" ] && [ "$active" = "1" ]; then
    pr_shaped "$reason" && rc=0
  fi
  [ "$nocase_was" = "1" ] || shopt -u nocasematch
  return "$rc"
}

# The BODY text of ONE segment, in descending order of specificity:
#
#   1. the contents of a readable `--body-file` / `-F <path>` / `-F body=@path`
#   2. the WHOLE command, when such a path was named but cannot be read -- the
#      `heredoc -> file -> --body-file` publishing shape this repo mandates,
#      whose file does not exist yet at PreToolUse time (issue-dup-check-gate.sh
#      and gh-body-english-gate.sh document the same window)
#   3. the inline `--body` value, plus the `-f`/`--field` `body=` forms the REST
#      mint uses, quote-aware so a multi-word body stays one value
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
  local seg="$1" f out=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Treat it like an unreadable path and fall back to the whole command
    # rather than refusing: unlike dup-check, this gate demands nothing be
    # PRESENT, so "cannot read" is not evidence of a violation.
    case "$f" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    if [ -r "$f" ]; then
      out="$out
$(cat "$f" 2>/dev/null || true)"
    else
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
  echo "  Session-fit:${OFFENDING_REASON}"
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
  echo "Deliberate exception (a body QUOTING PR-shaped reasoning to argue"
  echo "against it):"
  echo ""
  echo "  CDKD_SKIP_DEFERRAL_CRITERIA_GATE=1 gh issue create ..."
  echo ""
  echo "Rule: .claude/rules/session-report.md -> ### Session-fit; /work-issues"
  echo "section 3-b (\"'It needs its own PR' is NOT a \`next\` reason\")."
} >&2
exit 2
