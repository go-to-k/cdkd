#!/usr/bin/env bash
# issue-classification-label-gate.sh — block `gh issue create` / `gh issue edit`
# when the issue BODY states a `Severity:` / `Effort:` value that the issue's
# LABELS do not carry.
#
# WHY
#
# CLAUDE.md's four classification fields (`Session-fit` / `Severity` / `Effort`
# / `Estimate`) live in the issue BODY as prose lines. That is the right place
# for the one-line reason each of them carries, and nothing here changes how
# they are written or displayed. But prose is invisible to every query the
# backlog is actually triaged with: `/work-issues` section 3's ranking rule 3
# ("higher `Severity` first, when BOTH candidates carry the line") can only be
# applied by opening each body, which is why it sits below a title-prefix
# heuristic rather than above it. `gh issue list --label severity:high` answers
# the same question in one call.
#
# So the two values that have a CLOSED set of tokens are mirrored onto labels:
#
#   Severity: high | medium | low   ->  severity:high | severity:medium | severity:low
#   Effort:   small | medium | large ->  effort:small  | effort:medium  | effort:large
#
# ONLY those two. `Session-fit` is re-decided when an issue is claimed (section
# 3 requires the claim comment to say why a recorded classification no longer
# applies), and a label that silently disagrees with the body is worse than no
# label at all. `Estimate` is a free-form duration with no closed value set --
# CLAUDE.md's own rule that it "must name what actually eats the time" is
# exactly what a label cannot hold.
#
# The prefixed full words are deliberate, and they are CLAUDE.md's own "no bare
# tokens" rule applied to a label: `Severity` and `Effort` share the token
# `medium`, and their initials collide in the dangerous direction (`L` is
# severity *low*, the least urgent thing there is, and effort *large*, the
# biggest). `severity:medium` / `effort:medium` cannot be confused; `M` can.
#
# WHAT IS AND IS NOT GATED
#
#   gated:      gh issue create   -- the filing site, where the four lines are
#                                    first written
#               gh api repos/<o>/<r>/issues -- the same mint through the REST
#                                    verb, when the matcher exposes the constant
#               gh issue edit     -- the CLAIM site: section 3 says most open
#                                    bodies are still in the old packed shape
#                                    and are upgraded to the four-line shape
#                                    when claimed, which is the moment
#                                    `Severity` first exists for them
#   not gated:  gh issue comment  -- a comment is not the issue's classification
#
# On `gh issue edit` the gate asks gh what labels the issue ALREADY carries, so
# re-editing an issue that is already labelled is not taxed; only a body whose
# stated value has no matching label is refused, and one `--add-label` clears
# it. That is also how the pre-existing backlog gets labelled: on touch, by the
# lane that is already holding the evidence, rather than by a bulk sweep that
# would manufacture guesses (section 3 forbids that sweep for the same reason).
#
# NO BYPASS MARKER, matching issue-dup-check-gate.sh: copying a value that is
# already written one line above onto a flag is the entire ask.

set -u

__hook_dir="${BASH_SOURCE[0]%/*}"
# `%/*` leaves the string unchanged when the path has no slash (invoked as
# `bash issue-classification-label-gate.sh` from inside the hooks dir).
[ "$__hook_dir" = "${BASH_SOURCE[0]}" ] && __hook_dir="."

# The shared matcher lives at `lib/command-match.sh` in cdkd and at
# `_command-match.sh` in the sibling repos this hook is mirrored into. Try both
# rather than forking the file: the two spellings are the ONLY difference
# between the three copies, and a fork is how they drift.
# shellcheck source=lib/command-match.sh
if { ! . "$__hook_dir/lib/command-match.sh" 2>/dev/null \
  && ! . "$__hook_dir/_command-match.sh" 2>/dev/null; } \
  || [ -z "${GATE_PERL_WORD:-}" ]; then
  # `GATE_PERL_WORD` is checked because a library that predates it leaves the
  # `$GW` the extraction interpolates as the EMPTY string: `($GW)` then matches
  # empty everywhere and every body path comes back empty -- a silent
  # fail-open rather than a loud 127.
  echo "Blocked: the shared command matcher (lib/command-match.sh or" >&2
  echo "_command-match.sh) is missing, unloadable or predates" >&2
  echo "GATE_PERL_WORD, so" >&2
  echo "issue-classification-label-gate cannot evaluate the command." >&2
  echo "Restore the file; do not work around the gate." >&2
  exit 2
fi
# FAIL CLOSED on a matcher that loaded but predates the constants this gate
# needs -- `|| exit 0` here is what silently disabled ten sibling gates
# (go-to-k/cdkd#2130 review).
if ! declare -F gate_matches >/dev/null \
  || ! declare -F gate_segments >/dev/null \
  || [ -z "${GATE_RE_GH_ISSUE_CREATE:-}" ] \
  || [ -z "${GATE_RE_GH_ISSUE_EDIT:-}" ]; then
  echo "Blocked: the shared command matcher loaded but is missing gate_matches," >&2
  echo "gate_segments, GATE_RE_GH_ISSUE_CREATE or GATE_RE_GH_ISSUE_EDIT, so" >&2
  echo "issue-classification-label-gate cannot evaluate the command." >&2
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
# The REST mint is the same act as `gh issue create` through another verb:
# `gh api repos/<o>/<r>/issues` with a `title=` field creates an issue. Sibling
# issue-dup-check-gate.sh already covers it, and omitting it here would leave
# the trigger under-approximated against the "over-approximate the TRIGGER, be
# strict on RESOLUTION" rule in .claude/rules/hooks.md.
GATE_RE_API_MINT="${GATE_RE_GH_API_ISSUE_CREATE:-}"
gate_matches "$cmd" "$GATE_RE_GH_ISSUE_CREATE" \
  || gate_matches "$cmd" "$GATE_RE_GH_ISSUE_EDIT" \
  || { [ -n "$GATE_RE_API_MINT" ] && gate_matches "$cmd" "$GATE_RE_API_MINT"; } || exit 0

target_dir="${hook_cwd:-$PWD}"
# A leading `cd <repo>` steers BOTH the opt-in check and the relative
# `--body-file` resolution, and the two must agree. The search-then-`cd`-then-
# file chain is a documented shape here, and without this the opt-in resolved
# against the payload cwd -- the same fail-open issue-dup-check-gate.sh closed.
# Guarded by `declare -F`: the sibling repos this hook is mirrored into carry an
# older matcher with no `cmd_last_cd_target`, where the gate degrades to the
# payload cwd rather than failing to load.
if declare -F cmd_last_cd_target >/dev/null 2>&1; then
  # The verb ERE is DERIVED from the shared constants rather than hand-rolled:
  # a local copy drops GATE_FLAGS' quoted alternative, so `gh -C "/a b" issue
  # create` matches no verb and a TRAILING `cd` steers the lookup instead.
  _cd_target=$(cmd_last_cd_target "$cmd" "$target_dir" \
    "(${GATE_RE_GH_ISSUE_CREATE#^})|(${GATE_RE_GH_ISSUE_EDIT#^})" 2>/dev/null || true)
  [ -n "$_cd_target" ] && target_dir="$_cd_target"
fi

# --- repo opt-in (issue #1259's scoping) ------------------------------------
# A session in one of these repos regularly files issues in unrelated personal
# repos, where this classification discipline is not the local convention and a
# refusal is pure friction. So the gate fires only in a repo that opts in by
# carrying `.markgate.yml` at its root. The CWD's repo decides, not any
# `-R <owner/repo>` in the command: `-R` names where the issue LANDS, while the
# cwd names whose policy the session is operating under -- and the cross-repo
# mirror flow (/work-issues section 10-c) files into a sibling from here,
# which is exactly a filing this repo wants classified.
optin_top=$(git -C "$target_dir" rev-parse --show-toplevel 2>/dev/null || true)
[ -n "$optin_top" ] || exit 0
[ -f "$optin_top/.markgate.yml" ] || exit 0

# --- value extraction -------------------------------------------------------
# The key must be followed by at least one SPACE, and that is load-bearing
# rather than incidental: the label spelling is `severity:high` with no space,
# so this scan reads the BODY's `Severity: high` and never the `--label`
# argument sitting in the same command string. Without the space rule a
# `--label severity:low` would satisfy its own requirement.
classification_value() {
  local text="$1" key="$2" allowed="$3"
  printf '%s' "$text" \
    | grep -oiE "${key}:[[:space:]]+(${allowed})([^[:alnum:]]|\$)" \
    | head -1 \
    | grep -oiE "(${allowed})" \
    | head -1 \
    | tr '[:upper:]' '[:lower:]'
}

# Every `--label` / `--add-label` value in one segment, comma-split. The
# extraction is the same one gh-label-validity-gate.sh uses: the unquoted value
# is terminated by whitespace or a shell metacharacter, so a chained
# `--label X; other-cmd` captures `X`, not `X;`.
# `-l` IS matched here, unlike gh-label-validity-gate.sh which excludes it.
# There the scan spans `gh issue|pr create|edit` where `-l` is also short for
# `--limit`; here every segment is a `gh issue create` or `gh issue edit`, where
# `-l` can only be `--label`. The cost directions differ too: missing a label
# there costs a skipped check, while missing one HERE costs a false BLOCK on a
# command that already carries what the gate asks for, and there is no bypass.
segment_labels() {
  printf '%s' "$1" \
    | grep -oE -- '(--(add-)?label|(^|[[:space:]])-l)[= ]("[^"]+"|'\''[^'\'']+'\''|[^ ;&|()<>"'\'']+)' \
    | sed -E -e 's/^[[:space:]]*//' -e 's/^(--(add-)?label|-l)[= ]//' -e 's/^["'\'']//' -e 's/["'\'']$//' \
    | tr ',' '\n' \
    | sed 's/^ *//;s/ *$//' \
    | grep -v '^$' || true
}

# The BODY text of a segment, in descending order of specificity. Precedence is
# load-bearing rather than tidy: `classification_value` takes the FIRST match,
# so concatenating the whole segment in front of the body let an unrelated
# mention outrank the real line. Measured: `--title \'Severity: high pages
# fail\'` with a body stating `Severity: low` and a correct `--label
# severity:low` was REFUSED, quoting a value the body never states.
#
#   1. the contents of a readable `--body-file` / `-F <path>` / `-F body=@path`
#   2. the WHOLE command, when such a path was named but cannot be read -- the
#      `heredoc -> file -> --body-file` publishing shape this repo mandates,
#      whose file does not exist yet at PreToolUse time (issue-dup-check-gate.sh
#      documents the same window)
#   3. the inline `--body` value, quote-aware so a multi-word body is one token
#   4. the whole segment, as a last resort
segment_body_text() {
  local seg="$1" f out=""
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    # An unexpanded `$VAR` or a substitution cannot be resolved from command
    # TEXT; treat it like an unreadable path and fall back to the whole command.
    case "$f" in
      *'$'*|*'`'*) out="$out
$cmd"; continue ;;
    esac
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
  # The bare `-F <path>` arm is NOT optional: `-F` is gh's short `--body-file`,
  # so without it `gh issue create -F body.md` was never scanned and the gate
  # exited 0 on a body stating `Severity: high` with no label. Sibling
  # issue-dup-check-gate.sh already carries the same three arms. `body=@` is
  # matched FIRST so an `-F body=@path` is not also read as a bare `-F path`.
  #
  # The value class is `$GW` from the SHARED `GATE_PERL_WORD` prelude, not a
  # local `(["\x27]?)([^"\x27\s]+)\1`. That local shape could not span a
  # QUOTED PATH CONTAINING A SPACE, so it extracted NOTHING, the fallback chain
  # ended at the whole SEGMENT (which carries the path but not the body), and
  # the gate demanded no label at all. Measured 2026-09-05 on a body stating
  # `Severity: high` with no labels: `--body-file "<dir with space>/x.md"` gave
  # rc=0 where the unquoted spelling gave 2, and so did the GLUED `-F<path>`
  # spelling gh accepts as readily as `-F <path>` -- hence `[=\s]*` on the
  # short flags. This gate is the FOURTH site of one root cause; the note above
  # about checking the siblings is why it was found.
  done < <(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
      while (/(?:--field|--raw-field|-F)[=\s]*($GW)/g) {
        my $v = gate_unq($1);
        next unless $v =~ s/^body=\@//;
        print "$v\n";
      }
      while (/--body-file[=\s]+($GW)/g) { print gate_unq($1), "\n"; }
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

  out=$(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
    while (/(?:^|\s)--body[=\s]+($GW)/g) { print gate_unq($1), "\n"; }' 2>/dev/null)
  if [ -n "$out" ]; then
    printf '%s' "$out"
    return 0
  fi

  printf '%s' "$seg"
}

# The labels an EXISTING issue already carries, for the `gh issue edit` arm.
# Fails OPEN (prints nothing and lets the caller treat it as "unknown, do not
# block") on any gh error: this is a discipline aid, not a safety boundary, and
# a transient gh failure must not stop a body edit.
existing_labels() {
  local seg="$1" num repo_args
  # The number must come from the `issue edit` ARGUMENT, not from any
  # `/issues/N` URL in the command. An unanchored URL scan reads a link the
  # body happens to contain -- routine here -- and a greedy `.*` takes the
  # LAST one, so `gh issue edit 42 --body "see .../other/repo/issues/999 ...
  # Severity: high"` looked up 999's labels and let an unlabelled 42 through.
  # perl rather than sed: this needs a LEFTMOST match anchored to the verb, and
  # ERE has no non-greedy quantifier.
  num=$(printf '%s' "$seg" | perl -0777 -ne '
    if (/\bissue\s+edit\s+(?:["\x27])?\#?(?:https:\/\/github\.com\/[^\/\s]+\/[^\/\s]+\/issues\/)?(\d+)/) {
      print $1;
    }' 2>/dev/null)
  [ -n "$num" ] || return 1
  # Anchored to the verb for the same reason as `num` above: a greedy `.*` over
  # the segment takes the LAST `-R` in it, including one quoted inside a body,
  # which sends the lookup to another repo. Leftmost match after `issue edit`,
  # and a value starting with `-` is rejected rather than passed to gh as a
  # stray flag.
  # The SIXTH site of the value class, through the same shared `$GW` as the
  # other five. It differs from them in consequence, not in kind: this lookup
  # only decides WHICH repo's existing labels to read, and failing to extract
  # makes the gate demand labels it might not have needed -- a false BLOCK, not
  # a bypass. It is converted anyway, because "defined ONCE" was already this
  # file's claim while a private copy sat here, and because the false block is
  # real: `-R "owner/repo name"` is unusual but legal.
  repo_args=$(printf '%s' "$seg" | perl -0777 -ne "$GATE_PERL_WORD"'
    if (/\bissue\s+edit\b.{0,400}?\s(?:-R|--repo)[=\s]+($GW)/s) {
      my $v = gate_unq($1);
      print $v unless $v =~ /^-/;
    }' 2>/dev/null)
  if [ -n "$repo_args" ]; then
    gh issue view "$num" -R "$repo_args" --json labels -q '.labels[].name' 2>/dev/null
  else
    (cd "$target_dir" 2>/dev/null && gh issue view "$num" --json labels -q '.labels[].name' 2>/dev/null)
  fi
}

has_label() {
  printf '%s\n' "$2" | grep -qFx -- "$1"
}

offending_seg=""
missing=""
# The load guard above tests only that GATE_PERL_WORD is NON-EMPTY, which cannot
# see a prelude that is present but does not COMPILE -- and that failure is
# SILENT, because every extraction runs perl with stderr discarded, so the gate
# would extract nothing and PASS what it exists to refuse. Probe it functionally,
# once, here: after arming (so ordinary Bash calls pay nothing) and at TOP LEVEL.
# TOP LEVEL is load-bearing -- the extraction helpers are called inside `$( )`,
# where `exit 2` ends only the substitution subshell: measured, an in-function
# guard PRINTED its refusal and the hook still returned 0.
gate_perl_word_or_die issue-classification-label-gate || exit 2

while IFS= read -r seg; do
  is_edit=0
  if gate_matches "$seg" "$GATE_RE_GH_ISSUE_EDIT"; then
    is_edit=1
  elif ! gate_matches "$seg" "$GATE_RE_GH_ISSUE_CREATE"; then
    if [ -z "$GATE_RE_API_MINT" ] || ! gate_matches "$seg" "$GATE_RE_API_MINT"; then
      continue
    fi
  fi

  body_text=$(segment_body_text "$seg")
  sev=$(classification_value "$body_text" 'severity' 'high|medium|low')
  eff=$(classification_value "$body_text" 'effort' 'small|medium|large')
  # An old packed body writes `Effort: ~1-3 h`, which is a DURATION rather than
  # one of the three verification-cycle kinds (/work-issues section 3). No token
  # matches, so no label is demanded -- reading that field as the new `Effort`
  # is the misreading section 3 warns about, and this gate must not force it.
  [ -n "$sev" ] || [ -n "$eff" ] || continue

  known=$(segment_labels "$seg")
  if [ "$is_edit" = "1" ]; then
    # FAIL OPEN on the LOOKUP FAILING, not on it returning nothing. Those are
    # different states and conflating them broke the contract in both
    # directions: an issue that genuinely carries no labels (rc 0, empty
    # output) must still be refused, while a gh error or an unresolvable issue
    # number must pass through EVEN IF the command supplies some labels --
    # otherwise a half-labelled command was refused over a label the gate could
    # not see.
    prior_rc=0
    prior=$(existing_labels "$seg") || prior_rc=$?
    if [ "$prior_rc" != "0" ]; then
      continue
    fi
    known="$known
$prior"
  fi

  seg_missing=""
  if [ -n "$sev" ] && ! has_label "severity:$sev" "$known"; then
    seg_missing="${seg_missing}  - severity:${sev}   (body says \`Severity: ${sev}\`)"$'\n'
  fi
  if [ -n "$eff" ] && ! has_label "effort:$eff" "$known"; then
    seg_missing="${seg_missing}  - effort:${eff}   (body says \`Effort: ${eff}\`)"$'\n'
  fi
  if [ -n "$seg_missing" ]; then
    offending_seg="$seg"
    missing="$seg_missing"
    is_edit_offending="$is_edit"
    break
  fi
done < <(gate_segments "$cmd")

[ -n "$offending_seg" ] || exit 0

if [ "${is_edit_offending:-0}" = "1" ]; then
  flag="--add-label"
  verb="gh issue edit"
else
  flag="--label"
  verb="gh issue create"
fi

{
  echo "Blocked by issue-classification-label-gate: this \`${verb}\` states a"
  echo "classification in the body that the issue's labels do not carry."
  echo ""
  echo "Missing label(s):"
  printf '%s' "$missing"
  echo ""
  echo "Add them to the same command -- the body text stays exactly as written,"
  echo "the labels are a second copy of the SAME two values:"
  echo ""
  echo "  ${verb} ... ${flag} severity:<high|medium|low> ${flag} effort:<small|medium|large>"
  echo ""
  echo "Why: the four classification fields live in the body as prose, which no"
  echo "\`gh issue list\` query can read. /work-issues section 3's ranking rule 3"
  echo "(\"higher Severity first\") therefore costs one \`gh issue view\` per"
  echo "candidate, while \`gh issue list --label severity:high\` is one call."
  echo "Only Severity and Effort are mirrored: Session-fit is re-decided at claim"
  echo "time and a stale label would be worse than none, and Estimate is a"
  echo "free-form duration with no closed value set."
  echo ""
  echo "If the label does not exist yet in this repo, create it once:"
  echo "  gh label create 'severity:high' --description '...' --color 'b60205'"
  echo ""
  echo "Rule: CLAUDE.md -> the four TODO classification fields."
} >&2
exit 2
