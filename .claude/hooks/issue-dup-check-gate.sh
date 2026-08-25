#!/usr/bin/env bash
# issue-dup-check-gate.sh — block `gh issue create` unless the body carries a
# `Dup-check:` line recording that the OPEN issue list was searched for an
# issue already covering this root cause.
#
# WHY (measured 2026-08-25, go-to-k/cdkd):
#
#   open issues                                    115
#   closed (last 835-issue window)                 720
#   time-to-close                     median 0.17d, p90 0.96d
#   open issues carrying `Session-fit: next`    94 / 115
#   `Session-fit: now` in the last 400 issues         3
#   created vs closed, W33 / W34            244:203 / 166:111
#   open issues older than a month                    2
#   umbrella-shaped open issues                  13 / 115
#   of the FOUR oldest open issues, umbrella-shaped   4
#
# "Umbrella-shaped" is /work-issues section 3's OWN predicate -- title or body
# says `umbrella`, `audit:`, `Backfill`, or `N entries` -- rather than a
# pattern invented for this comment.
#
# The backlog is not rotting: median time-to-close is four hours and exactly
# two open issues are older than a month. But BOTH of those two, and all four
# of the oldest, are umbrella-shaped -- #609 (90d, "Backfill silent-drop
# properties into providers' handledProperties"), #1160 (33d, "Audit:
# absent-field removal silent drop across SDK providers"), #1225 (30d) and
# #1393 (16d). In a repo that closes a median issue in four hours, the issues
# that do not close are the ones naming N sites, because no single lane can
# close one.
#
# That is the shape of the problem. The unit of an issue drifted from "one
# root cause" to "one affected site", and this codebase's site space is types
# x properties wide, so an umbrella either sits open for months or is split
# into forty issues that each pay the full fixed cost.
#
# /work-issues section 5 already says the right thing --
#
#   "N sites of one root cause is ONE issue and ONE PR, never N issues. This
#    is the single largest source of unbounded backlog growth."
#
# -- and section 10-c already carries a rigorous three-window duplicate check
# (merged file, then open PRs, then open issues). But 10-c's check is scoped to
# MIRRORING A SKILL LESSON into the sibling repos. The path that files a defect
# follow-up mid-lane -- the path that produces most of the volume -- runs no
# duplicate check at all. That gap is what this gate closes: registration is
# not execution, and section 5's rule has been registered for months while the
# numbers above are what it actually produced.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create      -- the only verb that MINTS a new issue
#   not gated:  gh issue edit        -- folding a finding into an existing
#               gh issue comment        issue is the outcome this gate steers
#                                       toward; taxing it would penalise the
#                                       cheap path and leave the costly one free
#
# THIS GATE DOES NOT SUPPRESS FINDINGS, AND MUST NEVER BE USED TO.
# /work-issues section 10-0 is explicit that `filed <= closed` is not a target
# and that an unfiled finding is strictly worse than a filed one, because it
# removes the defect from the record while leaving it in the product. Nothing
# here changes the threshold for writing a defect down. It changes only WHERE
# it gets written: into the open issue that already names its root cause, as a
# checklist row, rather than into a new issue number. Every defect stays on the
# record either way; what changes is that an open issue then counts one
# unresolved ROOT CAUSE instead of one unfixed SITE -- and root causes are
# bounded by the codebase, so that number can actually converge.
#
# If the search genuinely finds nothing, say so on the line and file: that is a
# PASS, and it is the expected outcome for a real new root cause.
#
# ACCEPTED FORMS (any line in the body starting with `Dup-check:`)
#
#   Dup-check: searched open issues for `observedProperties` + `silent drop`
#     -- none covers this root cause
#   Dup-check: searched open issues for `nested key divergence` -- #1393 is the
#     same AREA but a different root cause (it is about the critic's blind
#     spots, this is the mapper emitting the wrong key)
#
# No bypass marker, matching non-english-text-gate.sh and
# closes-paren-form-gate.sh: running the search and writing one line is the
# entire ask, and a bypass would defeat the gate.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-dup-check-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."
# shellcheck source=lib/command-match.sh
# FAIL CLOSED: a gate that cannot evaluate the command must not wave it
# through. `|| exit 0` here is what silently disabled ten sibling gates
# (go-to-k/cdkd#2130 review).
if ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  || ! declare -F gate_matches >/dev/null \
  || ! declare -F cmd_last_cd_target >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_RE_GH_API_ISSUE_CREATE:-}" ]; then
  echo "Blocked: .claude/hooks/lib/command-match.sh is missing, unloadable, or" >&2
  echo "predates GATE_RE_GH_ISSUE_CREATE, so issue-dup-check-gate cannot" >&2
  echo "evaluate the command. Restore the file; do not work around the gate." >&2
  exit 2
fi

input=$(cat 2>/dev/null || true)
tool_name=$(printf '%s' "$input" | jq -r '.tool_name // ""' 2>/dev/null || echo "")
[ "$tool_name" = "Bash" ] || exit 0
cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")
[ -n "$cmd" ] || exit 0

# Command-position matching, so a body or comment that merely QUOTES
# `gh issue create` does not arm the gate (.claude/rules/hooks.md).
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || gate_matches "$cmd" "$GATE_RE_GH_API_ISSUE_CREATE" || exit 0

# --- 0. resolve the target directory ONCE -----------------------------------
# Both the opt-in check below and the relative `--body-file` resolution later
# need the same directory, and they must agree. The verb ERE is DERIVED from the
# shared constant rather than hand-rolled: a local copy drops GATE_FLAGS' quoted
# alternative, so `gh -C "/a b" issue create` matches no verb, `cmd_last_cd_target`
# stops at nothing, and a TRAILING `cd` steers the lookup -- the cdk-local#542
# class .claude/rules/hooks.md records.
#
# Passing a bare `gh` here (an earlier revision did) is worse than a hand-rolled
# copy: `cmd_last_cd_target` then breaks at the FIRST gh segment, so
# `gh issue list --search x && cd <repo> && gh issue create ...` -- the
# search-then-file chain this gate's own message prescribes -- never sees the
# `cd`, the opt-in resolves against the payload cwd, and the gate exits 0.
VERB_ERE="${GATE_RE_GH_ISSUE_CREATE#^}"
target_dir="${hook_cwd:-$PWD}"
cd_target=$(cmd_last_cd_target "$cmd" "$target_dir" "$VERB_ERE" 2>/dev/null || true)
[ -n "$cd_target" ] && target_dir="$cd_target"

# --- 0b. repo opt-in (issue #1259's scoping, applied to the ISSUE surface) ---
# A cdkd session regularly files issues in unrelated personal repos, where this
# repo's root-cause-unit discipline is not the local convention and a refusal is
# pure friction -- the shape of the 2026-07-27 incident, where a main-tree hook
# blocked a user-requested edit to a personal blog draft. So the gate fires only
# in a repo that opts in by carrying `.markgate.yml` at its root.
#
# The CWD's repo decides, not any `-R <owner/repo>` in the command, and that is
# deliberate: `-R` names where the issue LANDS, while the cwd names which
# project's policy the session is operating under. Section 10-c's cross-repo
# mirror flow is exactly the case that makes the difference matter -- it runs
# `gh -R go-to-k/<sibling> issue create` from a cdkd worktree, and those filings
# are precisely the ones this repo wants checked (that flow is itself a
# documented duplicate GENERATOR).
#
# Unresolvable cwd, or a cwd outside any repo, means NOT gated. This is a
# discipline aid, not a safety boundary, so a rare miss costs less than a
# refusal in a context that never opted in.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# TWO spellings of the same marker, and the difference is not cosmetic.
#
# In a body FILE the line structure is real, so the marker is anchored at the
# start of a line (optionally as a list item) -- which keeps a passing mention
# inside a sentence from satisfying the gate.
#
# In the raw COMMAND there is no such structure: an inline
# `--body 'Bug. Dup-check: ...'` is one line, so the same anchor never matches
# and the gate would refuse a body that carries exactly what it asks for. The
# command scan is therefore unanchored. The threat model is FORGETTING to run
# the search, not defeating the gate: someone who types the line without
# searching has already decided to, and no regex reaches that.
# `-i` on the greps rather than a `[Dd]` class, so `Dup-Check:` is accepted:
# refusing a capitalisation variant teaches people the gate is capricious, and
# nothing is gained by the strictness.
MARKER_RE_LINE='^[[:space:]]*([-*+>][[:space:]]+)?dup-check:'
MARKER_RE_LOOSE='dup-check:'

# BOTH scans are scoped to the SEGMENT that is the `gh issue create`, never to
# the whole command, and that scoping is load-bearing rather than tidy.
#
# Unscoped, the gate had a demonstrated FAIL-OPEN in the shape this repo writes
# most: `git commit -F <msg> && gh issue create --body-file <no-marker>` passed,
# because `-F` is `git commit`'s flag as well as gh's short `--body-file`, so the
# extraction read the COMMIT MESSAGE and found the marker there. Commit messages
# quote the lines they describe -- the commit that introduced this gate contains
# `Dup-check:` in its own body -- so the false pass was not exotic. The loose
# inline scan had the same hole for the same reason, in either command order.
#
# Every matching segment must carry the marker: a command opening two issues
# must record the search for both.
seg_has_marker() {
  local seg="$1" f

  # inline `--body '...'`: the marker is in the segment text itself.
  if printf '%s' "$seg" | grep -qiE "$MARKER_RE_LOOSE"; then
    return 0
  fi

  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT. Refuse, per the #2027 fail-closed convention, but through the
    # dedicated message arm below: a bare "check the path" is unclearable when
    # the file does carry the line.
    case "$f" in
      *'$'*|*'`'*) unresolvable_path="$f"; return 1 ;;
    esac
    # A literal `~` in the command string is text, not something to expand -- a
    # real tilde would already have been expanded by the shell before gh ran.
    # shellcheck disable=SC2088
    case "$f" in
      /*) ;;
      "~/"*) f="${HOME:-/nonexistent}/${f#\~/}" ;;
      *) f="$target_dir/$f" ;;
    esac
    if [ ! -f "$f" ]; then
      # The file may not exist YET. `heredoc -> file -> --body-file` in ONE
      # command is this repo's mandated publishing shape (memory rule
      # feedback_gh_body_file_over_heredoc.md), and at PreToolUse time the
      # heredoc has not run -- gh-body-english-gate.sh documents the same
      # window as a known limit. There it costs a missed scan; here, after the
      # segment scoping, it would cost a false BLOCK on the shape the flow
      # prescribes, which is the worse direction.
      #
      # So fall back to the WHOLE command, with the ANCHORED marker: a heredoc
      # body carries real line structure, so the same line-start rule applies
      # and a passing mention inside a sentence still does not satisfy it. This
      # is the one place a cross-segment read is allowed, and its window is
      # narrow by construction -- it opens only when the named body file cannot
      # be read at all.
      if printf '%s' "$cmd" | grep -qiE "$MARKER_RE_LINE"; then
        return 0
      fi
      continue
    fi
    found_body_file=1
    if grep -qiE "$MARKER_RE_LINE" "$f"; then
      return 0
    fi
  # This extraction is a NEAR-COPY of gh-body-english-gate.sh's (its "file-borne
  # bodies" block), deliberately not shared, and it has already DIVERGED in three
  # ways: it runs on one segment rather than the whole command, it omits the
  # `--notes-file` arm (a release note is not an issue body), and its caller
  # treats an unreadable path as a BLOCK where that hook treats it as a skip.
  # Sharing them would mean reconciling those three, and the third is a
  # deliberate opposite -- that gate only warns, so a missed scan costs a warning
  # while a missed scan here costs the gate. Stated rather than left to be
  # discovered: if you fix a path-extraction bug in either, check the other.
  done < <(printf '%s' "$seg" | perl -0777 -ne '
      while (/--body-file[=\s]+(["\x27]?)([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:--field|--raw-field|-F)[=\s]+(["\x27]?)body=\@([^"\x27\s]+)\1/g) { print "$2\n"; }
      while (/(?:^|\s)-F[=\s]+(["\x27]?)([^"\x27\s=]+)\1(?=\s|$)/g) { print "$2\n"; }
    ' 2>/dev/null)
  return 1
}

found_body_file=0
unresolvable_path=""
offending=""
while IFS= read -r seg; do
  [[ "$seg" =~ $GATE_RE_GH_ISSUE_CREATE ]] || [[ "$seg" =~ $GATE_RE_GH_API_ISSUE_CREATE ]] || continue
  if ! seg_has_marker "$seg"; then
    offending="$seg"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending" ] || exit 0

if [ -n "$unresolvable_path" ]; then
  {
    echo "Blocked by issue-dup-check-gate: the --body-file path \`$unresolvable_path\`"
    echo "carries an unexpanded variable or substitution, and this gate reads the"
    echo "command TEXT rather than the shell's expansion of it, so it cannot open"
    echo "the file to look for the \`Dup-check:\` line."
    echo ""
    echo "This refuses rather than guessing, per the fail-closed convention in"
    echo ".claude/rules/hooks.md (issue #2027). Two ways to clear it, both of which"
    echo "leave the gate doing its job:"
    echo ""
    echo "  - pass the path literally:  gh issue create --body-file /abs/path.md"
    echo "  - or carry the line inline: gh issue create --body \"...Dup-check: ...\""
  } >&2
  exit 2
fi

{
  echo "Blocked by issue-dup-check-gate: this \`gh issue create\` body carries no"
  echo "\`Dup-check:\` line, so nothing records that the OPEN issue list was"
  echo "searched for an issue already covering this root cause."
  if [ "$found_body_file" = "0" ]; then
    echo ""
    echo "(No readable --body-file was found in the command either. If you passed"
    echo " one, check the path: an unreadable body file is treated as a miss, not"
    echo " as a pass.)"
  fi
  echo ""
  echo "Run the search first -- search the CONCEPT, not this instance's spelling,"
  echo "because an existing umbrella was written from a different site and names"
  echo "a different provider:"
  echo ""
  echo "  gh issue list --state open --limit 200 --search '<root-cause concept>' \\"
  echo "    --json number,title"
  echo "  gh issue list --state open --limit 200 --json number,title,body \\"
  echo "    --jq '.[] | select((.body // \"\") | test(\"<shared symbol / call / assumption>\";\"i\"))"
  echo "          | \"\\(.number)\\t\\(.title)\"'"
  echo ""
  echo "On a HIT, do not create -- fold the finding into that issue as a"
  echo "checklist row, which keeps the defect on the record while the open count"
  echo "stays one-per-root-cause:"
  echo ""
  echo "  U=\$(mktemp)   # NOT a fixed /tmp path: parallel lanes share the scratchpad"
  echo "  gh issue view <hit> --json body -q .body > \"\$U\" \\"
  echo "    && [ -s \"\$U\" ] \\"
  echo "    && printf -- '- [ ] <site>: <one line, plus where the evidence is>\\n' >> \"\$U\" \\"
  echo "    && gh issue edit <hit> --body-file \"\$U\""
  echo ""
  echo "  The chaining and the -s test are load-bearing, not style: the redirect"
  echo "  truncates \$U before gh runs, so an unchained recipe whose \`view\` fails"
  echo "  (wrong number, transient error) replaces the umbrella's WHOLE body with"
  echo "  the single new row -- destroying every previously folded finding through"
  echo "  the very procedure meant to preserve them."
  echo ""
  echo "On a MISS, that is a real new root cause -- file it, and record the"
  echo "search in the body:"
  echo ""
  echo "  Dup-check: searched open issues for <terms> -- none covers this root cause"
  echo ""
  echo "This gate never asks you to drop a finding. /work-issues section 10-0 is"
  echo "explicit that \`filed <= closed\` is not a target and that an unfiled"
  echo "finding is worse than a filed one. It changes only WHERE the finding is"
  echo "written, so an open issue counts one unresolved root cause rather than"
  echo "one unfixed site."
  echo ""
  echo "Rule: .claude/skills/work-issues/SKILL.md section 5 (\"N sites of one root"
  echo "cause is ONE issue and ONE PR, never N issues\")."
} >&2
exit 2
