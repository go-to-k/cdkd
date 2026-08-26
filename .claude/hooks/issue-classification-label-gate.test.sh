#!/usr/bin/env bash
# Smoke tests for issue-classification-label-gate.sh
#
# The gate blocks `gh issue create` / `gh issue edit` when the BODY states a
# `Severity:` / `Effort:` value that the issue's labels do not carry. Asserts,
# in both directions:
#   - PASS  when the command carries the matching `--label` / `--add-label`
#   - BLOCK when it carries none, or carries a DIFFERENT value (a label that
#           disagrees with the body is the failure mode this exists to stop)
#   - PASS  when the body states no classification at all, and when the old
#           packed shape writes `Effort: ~1-3 h` -- a DURATION, which
#           /work-issues section 3 says must NOT be read as the new `Effort`
#   - PASS  when the LABEL SPELLING appears in the command but no body line
#           does. The label form has no space after the colon and the body form
#           does. Precedence does most of the work -- the body FILE outranks the
#           segment text, so a `--title 'Severity: high ...'` cannot outrank the
#           body's own line -- and the space rule guards the LAST-RESORT segment
#           scan, the only path where the two spellings still meet
#   - PASS  for `-F <path>` and `-l`, gh's short `--body-file` and `--label`.
#           Missing the first meant the body was never scanned at all; missing
#           the second was a false BLOCK on a command already carrying the label
#   - edit: the lookup must use the `issue edit` ARGUMENT, not a `/issues/N`
#           URL the body happens to cite, and it must reach the `-R` repo. The
#           stub records its argv so a case can pin WHICH issue was asked about
#   - edit: PASS when gh reports the label is ALREADY on the issue, BLOCK when
#           it reports none, PASS when gh cannot answer (fail open -- a
#           transient gh failure must not stop a body edit)
#   - PASS  for verbs deliberately not gated (`gh issue comment`), for a command
#           that merely QUOTES the trigger, and in a repo that never opted in
#
# Measured rather than asserted (2026-08-26), and re-measured after each fix:
# an always-`exit 0` stub fails 14 of these and an always-`exit 2` stub fails 39
# of 40, so neither direction can pass vacuously. Targeted mutants: the scan's
# `[[:space:]]+` relaxed to `*` fails exactly 1 (the no-body space-rule case);
# reverting the body-file precedence fails exactly 2 (both `--title` cases);
# dropping the bare `-F <path>` arm fails exactly 1.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/issue-classification-label-gate.sh"
PASS=0
FAIL=0

# Two fixture trees, because the gate is repo-opt-in:
#   $TMPROOT  -- a git repo carrying `.markgate.yml`, so the gate fires
#   $NOOPTIN  -- a git repo without it, so the gate must stay silent
TMPBASE=$(mktemp -d)
trap 'rm -rf "$TMPBASE"' EXIT
TMPROOT="$TMPBASE/optin"
NOOPTIN="$TMPBASE/no-optin"
for d in "$TMPROOT" "$NOOPTIN"; do
  mkdir -p "$d"
  git -C "$d" init -q 2>/dev/null
done
printf 'gates: {}\n' > "$TMPROOT/.markgate.yml"

# A PATH-stubbed `gh`, because the edit arm asks the real service what labels an
# issue already carries. The stub answers from GH_STUB_LABELS and fails when
# GH_STUB_FAIL is set, which is the only way to exercise the fail-open arm.
STUBDIR="$TMPBASE/bin"
mkdir -p "$STUBDIR"
cat > "$STUBDIR/gh" <<'STUB'
#!/usr/bin/env bash
# The stub RECORDS its argv and answers PER ISSUE NUMBER. Both matter: a stub
# that ignores the invocation cannot tell a lookup of the right issue from a
# lookup of the wrong one, so rewriting `existing_labels` to `gh issue view 1`
# -- dropping the number AND the `-R` -- left the suite fully green while real
# gh would answer about a different issue.
[ -n "${GH_CALL_LOG:-}" ] && printf '%s\n' "$*" >> "$GH_CALL_LOG"
if [ -n "${GH_STUB_FAIL:-}" ]; then exit 1; fi
if [ "$1 $2" = "issue view" ]; then
  n="$3"
  case "$n" in ''|*[!0-9]*) n="" ;; esac
  if [ -n "$n" ]; then
    # `${VAR-...}` without the colon, so `ISSUE_42=""` means "the issue exists
    # and carries NO labels" -- a distinct state from "gh could not answer".
    v=$(eval "printf '%s' \"\${ISSUE_$n-__UNSET__}\"")
    if [ "$v" != "__UNSET__" ]; then printf '%s\n' $v; exit 0; fi
  fi
fi
printf '%s\n' ${GH_STUB_LABELS:-}
STUB
chmod +x "$STUBDIR/gh"
PATH="$STUBDIR:$PATH"
export PATH

# run <name> <command> <cwd> <expected-exit>
run() {
  local name="$1" command="$2" cwd="$3" expect="$4"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  if [ "$rc" -eq "$expect" ]; then
    echo "PASS: $name (exit $rc)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect)"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

# run_msg <name> <command> <cwd> <expected-exit> <substring the stderr must carry>
# The refusal names WHICH label is missing; asserting the exit code alone let an
# earlier draft report `effort:` for a missing `severity:` and stay green.
run_msg() {
  local name="$1" command="$2" cwd="$3" expect="$4" needle="$5"
  local payload out rc
  payload=$(jq -n --arg c "$command" --arg d "$cwd" \
    '{tool_name:"Bash", tool_input:{command:$c}, cwd:$d}')
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
  # `grep -qF -- "$needle"`: without the `--`, a needle that starts with a dash
  # (`--add-label`) is parsed as grep's own option and the case fails on a
  # message that carries exactly what it asked for.
  if [ "$rc" -eq "$expect" ] && printf '%s' "$out" | grep -qF -- "$needle"; then
    echo "PASS: $name (exit $rc, message matched)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $rc, expected $expect carrying '$needle')"
    printf '%s\n' "$out" | sed 's/^/      /' | head -6
    FAIL=$((FAIL + 1))
  fi
}

BODY_BOTH="$TMPROOT/both.md"
cat > "$BODY_BOTH" <<'B'
The provider drops the field.

Dup-check: searched open issues -- none covers this root cause
Session-fit: next (not this session) -- needs a new fixture
Severity: high -- deploy silently ships a resource missing the property
Effort: large (L) -- a new integ fixture has to be written
Estimate: ~3 h+ -- the fixture deploys a NAT gateway
B

BODY_PACKED="$TMPROOT/packed.md"
cat > "$BODY_PACKED" <<'B'
The old packed shape, from before the five-field split.

Session-fit: next (not this session) -- Effort: ~1-3 h
Severity: medium -- one provider is missing a property
B

BODY_NONE="$TMPROOT/none.md"
printf 'Just a feature request, no classification lines.\n' > "$BODY_NONE"

# --- create -----------------------------------------------------------------
run "create: both labels present" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
run_msg "create: no labels at all" \
  "gh issue create -t x --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"
run_msg "create: severity labelled, effort missing" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high" \
  "$TMPROOT" 2 "effort:large"
run_msg "create: label DISAGREES with the body" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:low --label effort:large" \
  "$TMPROOT" 2 "severity:high"
run "create: comma-separated labels" \
  "gh issue create -t x --body-file $BODY_BOTH --label severity:high,effort:large" \
  "$TMPROOT" 0
run "create: old packed body demands only severity" \
  "gh issue create -t x --body-file $BODY_PACKED --label severity:medium" \
  "$TMPROOT" 0
run "create: body with no classification lines" \
  "gh issue create -t x --body-file $BODY_NONE" \
  "$TMPROOT" 0
# The separation the whole gate rests on: a label carries no space after the
# colon, a body line does. Without it this command would demand the label its
# own `--label` names and every command would pass vacuously.
run "create: a bare --label does not satisfy itself" \
  "gh issue create -t x --body-file $BODY_NONE --label severity:high" \
  "$TMPROOT" 0
# The other half of the same separation: a label SPELLING quoted in a title is
# not a classification. Relaxing the space rule turns this into a refusal.
run "create: the label spelling in a TITLE is not a classification" \
  "gh issue create -t 'add a severity:high label to the tracker' --body-file $BODY_NONE" \
  "$TMPROOT" 0
# The same, with NO body at all, so the scan falls through to the whole segment
# -- the ONLY path on which the space rule can still be observed once the body
# file takes precedence over the segment text. Relaxing `[[:space:]]+` to `*`
# makes this a refusal, and it is the sole case that catches that mutation.
run "create: (space rule) a label spelling with no body is not a classification" \
  "gh issue create -t 'add a severity:high label to the tracker' --label bug" \
  "$TMPROOT" 0
run "create: inline --body carrying the lines" \
  "gh issue create -t x --body 'Broken. Severity: medium -- workaround exists. Effort: small (S) -- unit tests only.' --label severity:medium --label effort:small" \
  "$TMPROOT" 0
run_msg "create: inline --body, labels absent" \
  "gh issue create -t x --body 'Broken. Severity: medium -- workaround exists.'" \
  "$TMPROOT" 2 "severity:medium"
run "create: chained after another command" \
  "git status && gh issue create -t x --body-file $BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
run_msg "create: chained, labels absent" \
  "git status && gh issue create -t x --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"

# --- heredoc -> file -> --body-file in ONE command --------------------------
# The file does not exist at PreToolUse time, so the scan falls back to the
# whole command. This is the repo's mandated publishing shape.
HD_NO="cat > $TMPROOT/hd.md <<'EOF'
Severity: high -- users hit it in normal operation
EOF
gh issue create -t x --body-file $TMPROOT/hd.md"
HD_OK="cat > $TMPROOT/hd2.md <<'EOF'
Severity: high -- users hit it in normal operation
EOF
gh issue create -t x --body-file $TMPROOT/hd2.md --label severity:high"
run_msg "heredoc body, label absent" "$HD_NO" "$TMPROOT" 2 "severity:high"
run "heredoc body, label present"    "$HD_OK" "$TMPROOT" 0

# --- edit -------------------------------------------------------------------
GH_STUB_LABELS="bug severity:high" \
  run "edit: issue already carries the label" \
  "gh issue edit 42 --body-file $BODY_BOTH --add-label effort:large" \
  "$TMPROOT" 0
GH_STUB_LABELS="bug" \
  run_msg "edit: issue carries neither" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"
GH_STUB_LABELS="bug" \
  run "edit: both supplied on the command" \
  "gh issue edit 42 --body-file $BODY_BOTH --add-label severity:high --add-label effort:large" \
  "$TMPROOT" 0
GH_STUB_FAIL=1 \
  run "edit: gh cannot answer -- fail open" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 0
GH_STUB_LABELS="bug" \
  run "edit: issue number unresolvable -- fail open" \
  "gh issue edit --body-file $BODY_BOTH" \
  "$TMPROOT" 0
# The number must come from the `issue edit` ARGUMENT. An unanchored
# `/issues/N` scan reads a link the BODY happens to contain -- routine here --
# and a greedy `.*` takes the LAST one, so this looked up 999's labels and let
# an unlabelled 42 through. The stub answers for whatever number is asked, so
# the two arms below separate them: 42 carries only `bug` (BLOCK), 999 has both.
ISSUE_42="bug" ISSUE_999="severity:high effort:large" \
  run_msg "edit: a /issues/N URL in the body does not hijack the lookup" \
  "gh issue edit 42 --body-file $BODY_BOTH --body 'see https://github.com/other/repo/issues/999'" \
  "$TMPROOT" 2 "severity:high"
# Exit code alone cannot separate "asked about 42 and found nothing" from
# "asked about 999 and the answer was discarded", so assert the ARGV.
: > "$TMPBASE/calls.log"
GH_CALL_LOG="$TMPBASE/calls.log" ISSUE_42="bug" ISSUE_999="severity:high effort:large" \
  run "edit: (argv probe) the lookup runs at all" \
  "gh issue edit 42 -R go-to-k/cdkd --body-file $BODY_BOTH --body 'see https://github.com/other/repo/issues/999'" \
  "$TMPROOT" 2
if grep -q '^issue view 42 ' "$TMPBASE/calls.log" \
  && grep -q -- '-R go-to-k/cdkd' "$TMPBASE/calls.log" \
  && ! grep -q '^issue view 999' "$TMPBASE/calls.log"; then
  echo "PASS: edit: gh was asked about issue 42 in the -R repo, not the body's 999"
  PASS=$((PASS + 1))
else
  echo "FAIL: edit: wrong gh invocation"
  sed 's/^/      /' "$TMPBASE/calls.log"
  FAIL=$((FAIL + 1))
fi
# ...and the URL form of the ARGUMENT itself still resolves.
ISSUE_42="severity:high effort:large" \
  run "edit: the issue URL as the argument resolves" \
  "gh issue edit https://github.com/go-to-k/cdkd/issues/42 --body-file $BODY_BOTH" \
  "$TMPROOT" 0

# --- flag spellings and precedence ------------------------------------------
# `-F <path>` is gh's short `--body-file`. Missing it meant the body was never
# scanned and the gate exited 0 on a body stating `Severity: high`.
run_msg "create: bare -F <path> is read as the body" \
  "gh issue create -t x -F $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"
run "create: bare -F <path> with the labels" \
  "gh issue create -t x -F $BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
run "create: --body-file= equals form" \
  "gh issue create -t x --body-file=$BODY_BOTH --label severity:high --label effort:large" \
  "$TMPROOT" 0
# `-l` is gh's short `--label`, and on `gh issue create|edit` it is unambiguous.
# Missing it was a false BLOCK on a command already carrying what is asked for.
run "create: -l is accepted as --label" \
  "gh issue create -t x --body-file $BODY_BOTH -l severity:high -l effort:large" \
  "$TMPROOT" 0
# The body FILE outranks the segment text. Without that precedence a spaced
# mention in an unrelated flag was quoted back as though the body said it.
run "create: a --title mention does not outrank the body's own line" \
  "gh issue create -t 'Severity: high pages fail on retry' --body-file $BODY_PACKED --label severity:medium" \
  "$TMPROOT" 0
# ...and the same for an inline --body, which outranks the rest of the segment.
run "create: a --title mention does not outrank an inline --body" \
  "gh issue create -t 'Severity: high pages fail' --body 'Severity: low -- tidiness only' --label severity:low" \
  "$TMPROOT" 0
# The opt-in must follow a leading `cd`, or a chain that starts outside the repo
# files into it ungated. Degrades to the payload cwd on a matcher with no
# `cmd_last_cd_target`, so this case is skipped there rather than failing.
if grep -q 'cmd_last_cd_target' "$(dirname "$HOOK")/lib/command-match.sh" 2>/dev/null; then
  run_msg "create: a leading cd into the opted-in repo arms the gate" \
    "cd $TMPROOT && gh issue create -t x --body-file $BODY_BOTH" \
    "$NOOPTIN" 2 "severity:high"
fi
# The edit arm's remediation must name --add-label, not --label: an `edit`
# caller told to use `--label` reads it as "re-file the issue".
ISSUE_42="bug" \
  run_msg "edit: the refusal names --add-label" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "--add-label"
# Fail-open is about the LOOKUP FAILING, not about it returning nothing, so it
# must hold even when the command supplies some of the labels.
GH_STUB_FAIL=1 \
  run "edit: gh fails while the command supplies one label -- still open" \
  "gh issue edit 42 --body-file $BODY_BOTH --add-label severity:high" \
  "$TMPROOT" 0
# ...while an issue that genuinely carries NO labels is still refused.
ISSUE_42="" \
  run_msg "edit: an issue with no labels at all is refused" \
  "gh issue edit 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 2 "severity:high"

# --- not gated / not armed --------------------------------------------------
run "gh issue comment is not gated" \
  "gh issue comment 42 --body-file $BODY_BOTH" \
  "$TMPROOT" 0
run "a command that merely QUOTES the trigger" \
  "echo 'gh issue create -t x --body \"Severity: high\"'" \
  "$TMPROOT" 0
run "repo that never opted in" \
  "gh issue create -t x --body-file $BODY_BOTH" \
  "$NOOPTIN" 0
run "empty command passes" "" "$TMPROOT" 0

payload=$(jq -n '{tool_name:"Edit", tool_input:{file_path:"/tmp/x"}}')
out=$(printf '%s' "$payload" | "$HOOK" 2>&1) && rc=0 || rc=$?
if [ "${rc:-0}" -eq 0 ]; then echo "PASS: non-Bash tool passes (exit 0)"; PASS=$((PASS + 1))
else echo "FAIL: non-Bash tool passes (exit ${rc:-0})"; FAIL=$((FAIL + 1)); fi

echo ""
echo "Pass: $PASS  Fail: $FAIL"
[ "$FAIL" -eq 0 ]
