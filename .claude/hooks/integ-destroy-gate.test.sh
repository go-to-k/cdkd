#!/usr/bin/env bash
# Smoke test for integ-destroy-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees and asserts that the markgate verify runs against
# the RESOLVED target directory — not the script's location. This
# is the post-#559 contract.
#
# The hook's hunk-level diff filter (delete-touching symbol grep
# against origin/main) is intentionally NOT exercised here — those
# fixture repos have no `origin/main`, so the hook's diff_base
# fallback skips the filter and proceeds straight to markgate verify.
# That's the path we care about: did the hook resolve the right
# worktree before consulting markgate?
#
# Run from the repo root: `bash .claude/hooks/integ-destroy-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-destroy-gate.sh"

# go-to-k/cdkd#2236: a fixture repo must DECLARE the gate the hook asks about,
# the way the real repo does. The gates now read the target repo's own
# `.markgate.yml` to tell "this repo does not have that gate" (unsatisfiable --
# the sibling-repo defect) from "the marker is stale", so a fixture with no
# config takes the no-equivalent-gate refusal and never reaches markgate at all.
# Without this the cwd assertions below go green-to-red, and worse, the exit-2
# cases would pass for the wrong reason.
declare_gate() {
  printf 'gates:\n  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$2" > "$1/.markgate.yml"
}


TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Isolate git's configuration. Several cases now turn on git DEFAULTS -- the
# rename fence needs detection ON to have something to defeat -- so a
# maintainer with `diff.renames=false` (or a different `core.quotePath`) in
# their global config would see those cases pass without the fix in place: a
# green tally attesting to their machine rather than to the hook. Pointing the
# global and system config at an empty file costs nothing and makes every case
# answer the same question everywhere.
export GIT_CONFIG_GLOBAL="$TMPDIR/gitconfig-global"
export GIT_CONFIG_SYSTEM="$TMPDIR/gitconfig-system"
: > "$GIT_CONFIG_GLOBAL"
: > "$GIT_CONFIG_SYSTEM"

# ...and PROVE the two exports above are honoured. Both variables date from git
# 2.32; an older git ignores them SILENTLY, and exported-but-ignored is
# indistinguishable from working -- the suite would go straight back to
# attesting to the developer's `diff.renames`, which is the failure the block
# above claims to end. Same shape as this repo's "registration is not
# execution" rule for the hooks themselves.
#
# A POSITIVE probe, not "is the global config empty?": that one passes trivially
# on a machine with no global config, which is exactly the machine that can tell
# you nothing. Lifted from `branch-gate.test.sh`, the only other suite here that
# neutralises git config.
_ni_probe="$TMPDIR/ni-probe.gitconfig"
printf '[hooktest]\n\tmarker = seen\n' > "$_ni_probe"
for _ni_var in GIT_CONFIG_GLOBAL GIT_CONFIG_SYSTEM; do
  if [ "$(env "$_ni_var=$_ni_probe" git config --get hooktest.marker 2>/dev/null)" != "seen" ]; then
    printf 'FATAL: this git ignores %s, so the config isolation above is inert\n' "$_ni_var" >&2
    printf '       and this suite would be reading the developer config.\n' >&2
    printf '       Needs git >= 2.32; this is %s\n' "$(git --version)" >&2
    exit 1
  fi
done
unset _ni_probe _ni_var

side_repo="$TMPDIR/side-repo"
main_repo="$TMPDIR/main-repo"
git init -q -b feature/x "$side_repo"
declare_gate "$side_repo" integ-destroy
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$main_repo"
declare_gate "$main_repo" integ-destroy
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
CWD_TRACE_FILE="$TMPDIR/cwd-trace"

cat > "$SHIM_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$SHIM_DIR/mise"

# The `state:` VOCABULARY below is markgate 0.4.1's, verified against the pinned
# binary and against `internal/cli/status.go`: `match`, `mismatch (<reason>)`,
# `no marker`. markgate never prints the word `stale`. An earlier revision of
# this mock did, and it inverted the suite: narrowing the hook's reason
# extraction to `/^state: +stale/` -- which kills the whole #3010 diagnostic in
# production, since no real markgate emits that -- left every case GREEN, while
# aligning it with the real word reddened eight. A mock that speaks a dialect
# the subject never hears fences the mock. Re-check these strings against
# `markgate status` before editing them.
cat > "$SHIM_DIR/markgate" <<MARKGATE_EOF
#!/usr/bin/env bash
echo "\$PWD" >> "$CWD_TRACE_FILE"
verdict="\${MARKGATE_MOCK_VERDICT:-stale}"
case "\$1" in
  verify)
    [ "\$verdict" = "fresh" ] && exit 0
    # markgate 0.4 \`hash: diff\` exits 2 when it cannot EVALUATE the gate
    # (unresolvable base ref, empty delta) as opposed to 1 for a stale
    # marker. Different remedy, so the hook must branch on it.
    [ "\$verdict" = "error" ] && exit 2
    exit 1
    ;;
  status)
    if [ "\$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    elif [ "\$verdict" = "error" ]; then
      # Real 0.4 behavior on this path: the message goes to stderr and
      # stdout carries no \`state:\` line at all, so the hook's awk reason
      # extraction comes back empty.
      echo "markgate: hash=diff: base ref does not resolve" >&2
      exit 2
    elif [ "\$verdict" = "ttl" ]; then
      # \`integ-destroy\` carries \`ttl: 14d\`, so a marker can be stale with
      # NOTHING in scope having moved. The hook's message must not explain
      # this one as a code change (issue 3010 review, B2).
      printf 'key:        %s\nstate:      mismatch (expired by ttl: 14d, marker is 17d old)\n' "\$2"
    elif [ "\$verdict" = "no_marker" ]; then
      # The hook's reason extraction "fails open to the pre-0.3 generic
      # message" when \`status\` carries no PARENTHESIZED reason. On 0.4.1 that
      # is the \`no marker\` state, and it is live: markers are per-worktree,
      # so a fresh lane hits it before its first \`/run-integ\`.
      printf 'key:        %s\nstate:      no marker\n' "\$2"
    else
      printf 'key:        %s\nstate:      mismatch (digest differs)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$SHIM_DIR/markgate"

export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0
fail_log=""

run_case() {
  local name="$1"; local want="$2"; local verdict="$3"; local expect_cwd="$4"; local payload="$5"
  : > "$CWD_TRACE_FILE"
  local got
  printf '%s' "$payload" | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" >/dev/null 2>&1
  got=$?

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  if [[ "$got" == "$want" ]] && [ "$cwd_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    fail_log+="\n  payload: $payload\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- PASS-THROUGH cases ---

run_case "git status passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$side_repo")"

run_case "gh pr create not gated" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title x"}}' "$side_repo")"

run_case "non-git target dir allowed" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$TMPDIR")"

run_case "empty stdin passes through" 0 stale "" ''

# --- CWD-AWARE cases (the fixture repos have no origin/main, so the
#     diff filter is skipped and markgate is consulted directly). ---

# `gh pr merge` from side worktree → markgate runs in side.
# Load-bearing #559 case.
run_case "gh pr merge in side worktree → markgate runs there" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$side_repo")"

# `gh pr merge` from main worktree → markgate runs in main.
run_case "gh pr merge in main worktree → markgate runs there" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$main_repo")"

# `cd <side> && gh pr merge` from main cwd → markgate in side.
run_case "cd <side> && gh pr merge from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr merge 42 --auto"}}' "$main_repo" "$side_repo")"

# `gh -C <side> pr merge` from main cwd → markgate in side.
run_case "gh -C <side> pr merge from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr merge 42"}}' "$main_repo" "$side_repo")"

# Fresh marker in side worktree → pass.
run_case "fresh marker in side worktree passes" 0 fresh "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

# `gh pr merge --auto` shape.
run_case "gh pr merge --auto matches" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --auto"}}' "$side_repo")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substring `gh pr merge`
# appears inside a quoted argument body of an unrelated command. Per
# memory rule feedback_hook_command_match_line_start.md, applied to
# integ-destroy-gate.sh in issue #563 (mirroring the PR #562 fix to
# check-gate.sh).

# `gh issue create --body "...gh pr merge..."`: body mentions
# `gh pr merge` but the line starts with `gh issue create`. MUST
# pass through.
run_case "gh issue body quoting 'gh pr merge' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"next step: gh pr merge --squash\""}}' "$side_repo")"

# `echo "...gh pr merge..."`: body mentions `gh pr merge` but the
# command starts with `echo`. MUST pass through.
run_case "echo body quoting 'gh pr merge' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"after CI green: gh pr merge --auto\""}}' "$side_repo")"

# --- markgate 0.4 exit-2 (cannot EVALUATE) cases ---
#
# The stale path and the evaluation-error path BOTH exit 2, so an
# exit-code-only assertion cannot tell them apart -- and telling them
# apart is the entire point, because their remedies are opposite:
# `/run-integ` fixes a stale marker and is useless (and expensive --
# it is a real-AWS deploy + destroy) against an unresolvable base ref,
# where `markgate set` fails identically. So assert on the MESSAGE.
run_msg_case() {
  local name="$1"; local verdict="$2"; local want_re="$3"; local reject_re="$4"; local payload="$5"
  local err
  err=$(printf '%s' "$payload" | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" 2>&1 >/dev/null)
  if printf '%s' "$err" | grep -qE "$want_re" && ! printf '%s' "$err" | grep -qE "$reject_re"; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$name"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: stderr did not match /$want_re/ (or matched forbidden /$reject_re/)\n  stderr: $err\n"
    printf 'FAIL %s\n' "$name"
  fi
}

# Evaluation error names the base-ref remedy and must NOT advise an integ run.
run_msg_case "exit-2 names git fetch, not /run-integ" error \
  'could not EVALUATE' 'Required action' \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

# The converse: a genuinely stale marker must still advise the integ run
# and must NOT claim an evaluation error. Without this the case above
# could pass while the hook printed the error text unconditionally.
# Needles the COMMAND, not the `Required action` heading it sits under. Named
# "advises /run-integ" while asserting the heading, it passed with the
# `/run-integ <test-name>` line deleted -- the gate's one actionable command,
# unfenced under a case named for it.
run_msg_case "stale marker still advises /run-integ" stale \
  '/run-integ <test-name>' 'could not EVALUATE' \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

# The two conditions that make a marker legitimate. Deleting either bullet left
# the suite green, and they are the whole reason the skill is the only setter.
run_msg_case "stale message keeps the marker's preconditions" stale \
  'destroy completed with 0 errors' 'could not EVALUATE' \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

run_msg_case "stale message keeps the orphan precondition" stale \
  '0 orphan resources after the post-destroy' 'could not EVALUATE' \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

# --- The stale message must be SELF-DIAGNOSING (issue #3010) ---
#
# Needles are held in variables so each is written ONCE and every case below
# anchors on the same string. Two of the three are anchored deliberately wider
# than the sentence they belong to:
#
#   - N_EXPLAIN keeps the `mise exec -- ` prefix. Without it the needle is a
#     strict SUBSTRING of the advised command, so deleting the prefix -- the
#     one part of that line the paragraph itself calls load-bearing, since a
#     bare `markgate` on PATH can be an older build that cannot parse a
#     `hash: diff` gate -- left the suite green (measured).
#   - N_SCOPE covers the sentence explaining what `--explain` PRINTS. Without
#     it, deleting that whole paragraph left the suite green: the command line
#     alone survived and nothing said what to read in its output.
#
# #3010 reported this gate invalidating on a peer's merge with nothing in
# scope on the branch. A peer's merge alone does not: `hash: diff` digests the
# branch's delta from merge-base(origin/main, HEAD), and a peer's merge does
# not move that merge base (reproduced against markgate 0.4.1). What actually
# happened is that the include list was hand-expanded as git pathspecs and one
# entry -- `src/provisioning/provider-registry.ts`, added by #2721 and really
# changed by that branch -- was missed, so a legitimate refusal read as a
# broken gate. Both remedies that follow from that reading are bad: a
# real-AWS run the branch does not need, or setting the marker by hand, which
# the paragraph below this one forbids.
#
# So the message names the command that answers the question without any
# hand-expansion. Asserted on the hook's OWN stderr rather than on a
# re-statement: a case driving a predicate the suite declares stays green when
# the text is reverted (.claude/rules/hooks-authoring.md).
N_EXPLAIN='mise exec -- markgate status integ-destroy --explain'
N_SCOPE='writes the `scope:` block'
N_CAUSE='does not stale this marker by itself'
payload_merge="$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

# NOTE: there is no separate "names the command" case. `$N_EXPLAIN` is a strict
# substring of the resolved-tree case's needle further down, which asserts the
# whole emitted line including the `cd <resolved>` prefix, so a standalone case
# on the substring fences nothing the longer one does not.

run_msg_case "stale message says what --explain prints (#3010)" stale \
  "$N_SCOPE" 'could not EVALUATE' "$payload_merge"

# The claim that makes the command actionable: a peer's merge is NOT by itself
# a cause of staleness here. Separate from the cases above because the command
# tells the reader what to run, not what to conclude from the answer.
run_msg_case "stale message rules out a bare peer merge as the cause (#3010)" stale \
  "$N_CAUSE" 'could not EVALUATE' "$payload_merge"

# ONE CASE PER CAUSE. The paragraph names three, and the regression to guard
# against is a TRIM -- which leaves grammatical prose and satisfies every needle
# aimed at a different clause. Measured: with only the include-list cause
# fenced, deleting EITHER of the other two left the suite at 35/0, in a PR whose
# whole subject is that the list must not close early.
#
# Each cause is also a measurement against markgate 0.4.1, not a reading of the
# code:
#   worktree   an untracked non-ignored in-scope file, a chmod +x with zero
#              content change, and an uncommitted edit each flip `verify` 0 -> 1,
#              while `git diff origin/main...HEAD -- <scope>` shows none of them.
#              That gap IS the #3010 failure mode, so the message says
#              WORKING-TREE rather than "on this branch".
#   include    widening `include:` while not one byte under the scope changes
#              flips `verify` 0 -> 1 with `(digest differs)`, reaching this very
#              branch of the message.
# Control for both: the same mutation on an out-of-scope path leaves it fresh.
run_msg_case "stale message says the delta is the WORKING TREE (#3010)" stale \
  'uncommitted edits, mode changes and untracked' 'could not EVALUATE' "$payload_merge"

run_msg_case "stale message names the worktree cause (#3010)" stale \
  'in-scope file changing in THIS WORKING TREE' 'could not EVALUATE' "$payload_merge"

run_msg_case "stale message names the merge-base cause (#3010)" stale \
  'rebasing this branch onto it' 'could not EVALUATE' "$payload_merge"

run_msg_case "stale message names the include-list cause (#3010)" stale \
  'changes WHICH files are digested' 'could not EVALUATE' "$payload_merge"

# The sentence that joins the three causes back to the command at the top. It
# was unanchored, and deleting it left the suite green.
run_msg_case "stale message says what --explain can and cannot settle (#3010)" stale \
  'narrows it to the files actually digested' 'could not EVALUATE' "$payload_merge"

# --- An UNQUOTED heredoc is invisible to every needle above ---
#
# `.claude/rules/hooks-authoring.md`: `cat >&2 <<EOF` (no quotes) expands
# `$( )` and backticks in the BODY at refusal time, so every backtick span is
# executed and deleted and the reader gets `command not found` lines instead of
# the advice. This PR adds two backtick-dense heredocs, and measured, swapping
# both to the unquoted form left the suite at 35/0: the needles above are all
# backtick-free, so they survive the mangling verbatim.
#
# One needle per heredoc, each spanning a backtick pair, because the two blocks
# are quoted independently and a needle in one cannot see the other.
run_msg_case "scope heredoc stays QUOTED (#3010)" stale \
  '`include:` globs in `.markgate.yml`' 'could not EVALUATE' "$payload_merge"

run_msg_case "causes heredoc stays QUOTED (#3010)" stale \
  '`hash: diff` digests this branch' 'could not EVALUATE' "$payload_merge"

# The THIRD heredoc is the dangerous one to leave unfenced: its body carries
# `markgate set integ-destroy` inside backticks, twice. Unquoted, the refusal
# RUNS the marker set it exists to forbid -- the gate would clear itself while
# printing a message about not clearing it by hand. This block predates the PR;
# the PR is what split the message into three independently quoted heredocs, so
# it is the change that makes a per-block fence meaningful.
run_msg_case "remedy heredoc stays QUOTED (#3010)" stale \
  '`markgate set integ-destroy` if BOTH' 'could not EVALUATE' "$payload_merge"

# --- Two readings that are NOT a broken gate, and were missing ---
#
# Both measured against markgate 0.4.1, and both are states an agent reaches and
# misreads as a markgate defect -- which is the whole subject of #3010.
#
# merge base: is written by `set`, so ANY later merge or rebase makes it differ
# from the live one whatever the actual cause. Measured: marker set at base
# e9a7a59; branch merges origin/main (an unrelated in-scope file); `verify` rc 0,
# FRESH, recorded e9a7a59 vs live 36a4766. Then a plain worktree edit -> rc 1,
# same base mismatch, cause #1. So equality excludes cause 2 and inequality says
# nothing; the message must not sell it as a discriminator.
run_msg_case "merge-base advice is stated as ONE-WAY (#3010)" stale \
  'ONE-WAY test' 'could not EVALUATE' "$payload_merge"

# An EMPTY scope: beside (digest differs). Measured: branch changes one in-scope
# and one out-of-scope file, `set`, then reverts the in-scope one -> `scope:`
# prints nothing and `state:` is `mismatch (digest differs)`, rc 1.
# `refuseDeadScope` does not fire, because it globs CandidateNames and the
# include still matches the tree. This is #3010's reported symptom exactly, so
# the message owes it a reading rather than leaving it to look like a defect.
run_msg_case "empty scope beside digest-differs has a reading (#3010)" stale \
  'in-scope delta emptied AFTER the marker was set' 'could not EVALUATE' "$payload_merge"

# That reading is itself a list, and its first version closed at two entries --
# omitting the one the SAME refusal recommends twenty lines later ("narrow
# `.markgate.yml` integ-destroy scope"). Measured: narrowing `include:` so the
# changed file drops out gives an empty `scope:` with `(digest differs)`, so a
# reader who follows the remedy would have been told their change was reverted.
run_msg_case "empty-scope reading includes the narrowing cause (#3010)" stale \
  'stopped matching the file' 'could not EVALUATE' "$payload_merge"

# ONE CASE PER CAUSE applies to this list too, and did not at first: two of its
# three were fenced, so deleting the first entry left the suite green.
run_msg_case "empty-scope reading includes the revert cause (#3010)" stale \
  'change was reverted' 'could not EVALUATE' "$payload_merge"

# ...and the sentence that says WHY an emptied delta mismatches, without which
# the three causes are a list with no conclusion.
run_msg_case "empty-scope reading says why it mismatches (#3010)" stale \
  'taken over a non-empty delta' 'could not EVALUATE' "$payload_merge"

# ...and its "landed upstream" entry contradicted the peer-merge sentence six
# lines above it, which says a peer's merge does not move the merge base.
# Measured on the squash shape this repo allows: landing the identical content
# on `origin/main` left the merge base and the scope untouched, `verify` rc 0.
# Only the branch merging or rebasing afterwards empties it.
run_msg_case "empty-scope reading does not contradict the peer-merge line (#3010)" stale \
  'landing alone is not enough' 'could not EVALUATE' "$payload_merge"

# --- ORDER: the thing to DO comes before the explanation ---
#
# The refusal is read at the moment of a blocked merge. The diagnostic block
# grew across four review rounds and pushed `Required action` to line ~37 of a
# ~54-line message before this was fixed; nothing asserted the order, so it
# could drift back silently. Its own case because want/reject needles cannot
# express "before".
order_out=$(printf '%s' "$payload_merge" | MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
action_line=$(printf '%s' "$order_out" | grep -n '^Required action' | head -1 | cut -d: -f1)
diag_line=$(printf '%s' "$order_out" | grep -n '^What put this branch in scope' | head -1 | cut -d: -f1)
if [ -n "$action_line" ] && [ -n "$diag_line" ] && [ "$action_line" -lt "$diag_line" ]; then
  pass=$((pass + 1)); printf 'OK   required action precedes the diagnostic (#3010)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL required action precedes the diagnostic (#3010): action at line ${action_line:-none}, diagnostic at line ${diag_line:-none}\n"
  printf 'FAIL required action precedes the diagnostic (#3010)\n'
fi

# The advised command is EMITTED, not hard-coded, so it names the tree this gate
# actually checked -- a `cd` / `-C` in the blocked command can make that a
# different worktree from the caller's cwd, and markgate's markers are
# per-worktree, so a diagnostic run in the wrong tree answers about the wrong
# marker.
#
# Driven from a payload whose cwd is main_repo and whose command `cd`s to
# side_repo, and it REJECTS main_repo. A payload where the two coincide fences
# nothing: substituting the payload cwd for the resolved target left the suite
# green, so the case asserted only that SOME path was printed.
run_msg_case "diagnostic names the RESOLVED tree, not the cwd (#3010)" stale \
  "cd $side_repo && mise exec -- markgate status integ-destroy --explain" \
  "cd $main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && gh pr merge 42"}}' "$main_repo" "$side_repo")"

# --- The remaining prose this PR added, one needle each ---
#
# Every sentence below was measured as deletable with the suite green. They are
# fenced individually for the reason the per-cause cases exist: a trim leaves
# grammatical prose, and each of these carries a claim whose loss reinstates a
# wrong reading the refusal was written to prevent.
# Needle stops at the wrap. It read `... an older build` and went red when a
# reword moved "build" onto the next line -- the second time that happened in
# this file, so: keep every needle inside one rendered line.
run_msg_case "diagnostic keeps the stale-binary warning (#3010)" stale \
  'a bare `markgate` can pick up an older' 'could not EVALUATE' "$payload_merge"

# markgate SPLITS `--explain` across streams: the `scope:` block goes to stderr
# and everything else, `merge base:` included, to stdout (measured on 0.4.1).
# A reader who pipes stdout -- the ordinary thing to do with a diagnostic --
# loses exactly the half the message sent them for.
run_msg_case "diagnostic says --explain splits its streams (#3010)" stale \
  'to stderr, while `merge base:` goes to stdout' 'could not EVALUATE' "$payload_merge"

# The include-list cause is CONDITIONAL and was stated flatly. Measured:
# widening `include:` onto globs that match only files this branch has not
# touched leaves `verify` at 0; only adding or removing a path that is IN the
# delta moves the digest.
run_msg_case "include-list cause is qualified, not flat (#3010)" stale \
  'widening onto paths this branch has not touched' 'could not EVALUATE' "$payload_merge"

# --- Without mise, the advice must still be the command that exists ---
#
# The hook resolves `mise exec -- markgate` when mise is on PATH and a bare
# `markgate` otherwise (the `elif` in its resolver). The message used to say
# "prefer the `mise exec --` form", which in the second environment both
# misdescribes the line printed one paragraph above it and recommends a spelling
# the reader cannot run. Asserted by RENDERING with mise removed from PATH,
# because the prose alone cannot be told apart from the wrong prose.
nomise_dir="$TMPDIR/bin-nomise"
mkdir -p "$nomise_dir"
cp "$SHIM_DIR/markgate" "$nomise_dir/markgate"
# Symlinked tools rather than `/usr/bin:/bin`, for the reason spelled out at the
# markgate-missing case below: `jq` is only in `/usr/bin` on macOS 15+.
for tool in bash env jq git awk sed grep dirname basename cat tr head tail wc cut sort uniq comm mktemp rm printf; do
  tool_path=$(command -v "$tool" 2>/dev/null) && ln -sf "$tool_path" "$nomise_dir/$tool"
done
nomise_out=$(printf '%s' "$payload_merge" \
  | PATH="$nomise_dir" MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
nomise_cd=$(printf '%s' "$nomise_out" | grep -m1 '^  cd ')
if printf '%s' "$nomise_cd" | grep -q '&& markgate status integ-destroy --explain' \
   && ! printf '%s' "$nomise_out" | grep -q 'mise exec'; then
  pass=$((pass + 1)); printf 'OK   advice matches the resolved binary without mise (#3010)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL advice matches the resolved binary without mise (#3010): emitted '$nomise_cd'; 'mise exec' still present: $(printf '%s' "$nomise_out" | grep -c 'mise exec')\n"
  printf 'FAIL advice matches the resolved binary without mise (#3010)\n'
fi

# --- The emitted `cd` line must survive a PASTE ---
#
# `$target_dir` is interpolated into the advice, and this repo's worktrees can
# sit under a directory with a space or an apostrophe. Unquoted, `cd` there
# takes two arguments; with an apostrophe the pasted line leaves the reader at a
# continuation prompt. Asserted by EXECUTING the `cd` half rather than by
# matching the escape, so the case survives any future change of quoting style
# and fails on a broken one. (go-to-k/cdkd#2027 is the 24-site precedent for
# this class in these hooks.)
space_repo="$TMPDIR/side repo"
git init -q -b feature/x "$space_repo"
declare_gate "$space_repo" integ-destroy
git -C "$space_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
space_out=$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$space_repo" \
  | MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
space_cd=$(printf '%s' "$space_out" | grep -m1 '^  cd ' | sed 's/ && .*//; s/^  //')
space_want=$(cd "$space_repo" && pwd -P)
space_got=$( (eval "$space_cd" >/dev/null 2>&1 && pwd -P) 2>/dev/null )
if [ -n "$space_cd" ] && [ "$space_got" = "$space_want" ]; then
  pass=$((pass + 1)); printf 'OK   emitted cd survives a path with a space (#3010)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL emitted cd survives a path with a space (#3010): line '$space_cd' landed in '${space_got:-nowhere}', want '$space_want'\n"
  printf 'FAIL emitted cd survives a path with a space (#3010)\n'
fi

# Needle kept on ONE line: `grep` matches per line, so a needle spanning the
# message's 80-column wrap matches nothing and the case fails for a reason that
# has nothing to do with the hook. It did, on first writing.
run_msg_case "diagnostic says merge base: is the SET-time value (#3010)" stale \
  'appears only when a marker exists' 'could not EVALUATE' "$payload_merge"

# Named for what it asserts. It read "narrowing alone does not clear it" while
# needling text that says the opposite -- the same name/assertion drift this PR
# fixed one case earlier. The claim is also CONDITIONAL: narrowing clears a
# digest mismatch and cannot clear a TTL expiry or a missing marker (measured),
# so the sentence names its condition and the two states it does not cover.
run_msg_case "remedy admits narrowing CAN clear a digest mismatch (#3010)" stale \
  'Narrowing CAN clear' 'could not EVALUATE' "$payload_merge"

run_msg_case "remedy names the states narrowing cannot clear (#3010)" stale \
  'cannot clear a TTL expiry or a' 'could not EVALUATE' "$payload_merge"

# ...and the ORDER of markgate's own reporting, which makes the TTL warning
# above reachable in a state that does not look like it. `evaluate()` returns at
# `ownDigestDiff` BEFORE the TTL block, so a marker both aged past `ttl: 14d`
# and digest-changed prints `(digest differs)`. A reader who sees that reason
# cannot conclude their TTL is intact, and narrowing leaves them refused.
run_msg_case "remedy says digest-differs outranks an expired TTL (#3010)" stale \
  'reported AHEAD of an expired TTL' 'could not EVALUATE' "$payload_merge"

# The fourth heredoc. Its body carries `integ-destroy` in backticks; unquoted,
# the header the reason-LESS path prints is mangled the same way as the others.
run_msg_case "fallback-header heredoc stays QUOTED (#3010)" no_marker \
  '`integ-destroy` marker is stale' 'could not EVALUATE' "$payload_merge"

# --- ...and it must NOT be offered where it would be FALSE ---
#
# The causal paragraph explains a DIGEST mismatch. This gate also carries
# `ttl: 14d`, so a marker goes stale while the branch sits perfectly still, and
# there the paragraph would send the reader to `--explain` hunting a file that
# never changed. Same for the reason-less stale spelling, where the cause is
# simply unknown. The `--explain` command itself stays offered on both, so each
# state needs BOTH halves asserted -- a single "is it absent" case passes just
# as well when the whole block vanished.
#
# The first case of each pair also pins that the mock really drove that path:
# `expired by ttl` comes only from the reason branch, and the
# IMPLICIT_DELETE_DEPENDENCIES header only from the reason-LESS fallback. Without
# them a mock verdict that silently fell through to the ordinary stale path
# would satisfy the absence assertions for the wrong reason.
run_msg_case "ttl expiry is not explained as a code change (#3010)" ttl \
  'expired by ttl' "$N_CAUSE" "$payload_merge"

run_msg_case "ttl expiry still offers the scope diagnostic (#3010)" ttl \
  "$N_EXPLAIN" "$N_CAUSE" "$payload_merge"

run_msg_case "no-marker state takes the fallback header (#3010)" no_marker \
  'IMPLICIT_DELETE_DEPENDENCIES' "$N_CAUSE" "$payload_merge"

run_msg_case "no-marker state still offers the scope diagnostic (#3010)" no_marker \
  "$N_EXPLAIN" "$N_CAUSE" "$payload_merge"

# Placement: the diagnostic belongs in the block shared by every stale path,
# not in the evaluation-error path, whose remedy is a base ref rather than a
# scope question. This case fences ADDITION, and a move is not a substitute for
# measuring that: MOVING the block into `gate_refuse_unevaluable_marker` reddens
# four cases -- this one plus the three stale cases that lose the text -- so it
# cannot show what this case alone catches. DUPLICATING it there reddens this
# case and nothing else, which is the probe that justifies keeping it.
run_msg_case "exit-2 path does not offer the scope diagnostic (#3010)" error \
  'could not EVALUATE' "$N_EXPLAIN" "$payload_merge"

# --- DIFF-FILTER cases (issue #2042) ---
#
# Every case above deliberately runs against fixture repos WITHOUT an
# `origin/main`, so the hook's `diff_base` stays empty and the delete-touch
# filter is skipped entirely. That is the right isolation for the cwd
# contract, but it means nothing here exercised WHICH paths the filter
# considers delete-touching -- so `src/deployment/retry.ts` could be added to
# `.markgate.yml`'s `integ-destroy.include` (making the MARKER go stale on a
# retry change) while the merge-time hook kept passing the PR through, and no
# case would have noticed. That combination is the worst of both: an
# invalidated marker plus a gate that never consults it.
#
# These cases build a repo that DOES carry `refs/remotes/origin/main`, so the
# filter runs for real. The pass case is load-bearing: it proves the fixture
# actually drives the filter rather than falling through the empty-diff_base
# escape, which would make every block case below pass for the wrong reason.

filter_repo="$TMPDIR/filter-repo"
git init -q -b feature/x "$filter_repo"
declare_gate "$filter_repo" integ-destroy
mkdir -p "$filter_repo/src/deployment" "$filter_repo/docs"
echo "base" > "$filter_repo/docs/readme.md"
git -C "$filter_repo" add -A
git -C "$filter_repo" -c user.email=t@t -c user.name=t commit -q -m base
git -C "$filter_repo" update-ref refs/remotes/origin/main "$(git -C "$filter_repo" rev-parse HEAD)"

# stage_filter_change <relative-path> <content-line>
#  Commits a single-file change on top of the origin/main baseline. The
#  content carries none of the delete-symbol vocabulary (delete / rollback /
#  ENI / detach / ...), so a file that reaches the gate does so because it is
#  in the STRICT set, not because the hunk filter matched words.
stage_filter_change() {
  local rel="$1"; local line="$2"
  # The docstring above states that the content carries no delete-symbol
  # vocabulary, and EVERY strict-vs-filtered case depends on it: those cases
  # prove a file trips the gate because it is STRICT, and the only thing
  # distinguishing that from "the hunk filter matched a word" is this content.
  # Unpinned, a future edit adding `delete` / `ENI` / `rollback` to one of these
  # strings leaves every case GREEN while silently deleting the discrimination
  # -- the case would then pass under either bucket. Measured: moving
  # provider-registry.ts from strict_delete to filtered_delete currently fails
  # its case (25/1), and that is the ONLY executable fence on the bucket choice
  # (tests/unit/scripts/cross-cutting-list-sync.test.ts compares the MERGED
  # activation set and stays 15/15 green through the move). So the invariant is
  # asserted rather than described. Kept in sync with the hook's own
  # `delete_symbol_pattern` by hand. Drift can make this guard LOOSER (the hook
  # GAINS an alternative this list lacks: a poisoned fixture slips through and
  # the case it feeds silently stops discriminating) or OVER-STRICT (the hook
  # LOSES one: a content line that is delete-symbol-free by the hook's own
  # definition is refused here anyway -- measured, dropping `|detach` from the
  # hook and putting `detach` in a content line gives Fail: 1). It cannot fail
  # open in the dangerous direction, because over-strict is a loud,
  # self-correcting suite failure. The guard is also stricter than the hook by
  # construction: the hook's `^[-+][^-+]` skips the first content character,
  # this scans the whole string.
  case "$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')" in
    *delete*|*rollback*|*hyperplane*|*dependencyviolation*|*eni*|*detach*)
      fail=$((fail + 1))
      fail_log+="FAIL stage_filter_change fixture for $rel carries delete-symbol vocabulary "
      fail_log+="in its content line, so any case using it passes on the HUNK FILTER rather "
      fail_log+="than on bucket membership: $line\n"
      printf 'FAIL stage_filter_change fixture content is not delete-symbol-free: %s\n' "$rel"
      ;;
  esac
  git -C "$filter_repo" reset -q --hard refs/remotes/origin/main
  mkdir -p "$filter_repo/$(dirname "$rel")"
  printf '%s\n' "$line" > "$filter_repo/$rel"
  git -C "$filter_repo" add -A
  git -C "$filter_repo" -c user.email=t@t -c user.name=t commit -q -m "change $rel"
}

# Control: an out-of-scope file must pass through. If this ever blocks, the
# fixture is not driving the filter and every case below is vacuous.
stage_filter_change "docs/guide.md" "some prose"
run_case "diff filter: docs-only change passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# Second control, closer in: a deployment sibling that is NOT in any scope
# list. This is what distinguishes "the strict list gained three entries"
# from "the strict pattern matches all of src/deployment".
stage_filter_change "src/deployment/retry-helpers.ts" "export const timeoutMs = 1;"
run_case "diff filter: unscoped src/deployment sibling passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# Third control: the UNIT TEST for a scoped file. A unit-test-only PR carries no
# real-AWS risk and must not be blocked on an integ run it cannot need. The
# broad suite has this case; the destroy suite did not.
#
# WHAT PROTECTS IT, measured rather than assumed. Two mutations were run against
# `strict_delete`:
#   - dropping the leading `^` (`|src/deployment/(retry|...)\.ts$`): all 20 cases
#     still pass. This case does NOT discriminate that, because the pattern still
#     demands the literal `src/deployment/` segment and a `tests/...` path has
#     none. So the `^` anchor is NOT fenced by anything here -- stated because a
#     comment claiming otherwise would suppress the next person's probe.
#   - loosening to a bare `retry.*\.ts$`: this case fails (exit 2, want 0), along
#     with the sibling control and the rollback-executor case.
# The DIRECTORY PREFIX is therefore what holds, and that is the realistic
# loosening -- someone widening the alternation to catch a new retry file.
stage_filter_change "tests/unit/deployment/retry-transient-server-error.test.ts" "// test only"
run_case "diff filter: unit test for a scoped file passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# The three files issue #2042 brought into scope, each ALONE so that dropping
# any single alternative from `strict_delete` fails a case. The content lines
# deliberately avoid every delete-symbol word, which is exactly why these
# files must be STRICT rather than hunk-filtered: a real change here adds an
# HTTP status code or an error name, text the symbol grep cannot see.
stage_filter_change "src/deployment/retryable-errors.ts" "const RETRYABLE_STATUS = [500, 502, 504];"
run_case "diff filter: retryable-errors.ts is delete-touching (#2042)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_change "src/deployment/retry.ts" "const MAX_ATTEMPTS = 5;"
run_case "diff filter: retry.ts is delete-touching (#2042)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_change "src/deployment/rollback-executor.ts" "const REPLAY_LIMIT = 3;"
run_case "diff filter: rollback-executor.ts is delete-touching (#2042)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# issue #2720: the SDK-vs-Cloud-Control routing decision. `getProviderFor`
# picks the provider that DELETES a resource -- deploy-engine's plain delete
# and its replacement old-delete, destroy-runner, and seven sites in
# rollback-executor all read it -- so a routing regression reroutes DELETE for
# every resource in a template at once.
#
# STRICT rather than hunk-filtered, and this case is the evidence: the content
# line below is a realistic routing edit (a type added to the sticky-exemption
# set) and carries NONE of the delete-symbol vocabulary. Under the filtered
# bucket it would pass through -- a fail-open for exactly the change the gate
# was added for. Measured before the move: five such mutations matched the
# symbol filter 0 times, while a control line naming `deleteProvider` matched.
stage_filter_change "src/provisioning/provider-registry.ts" \
  "const STICKY_CC_MIGRATION_EXEMPT = new Set(['AWS::Scheduler::Schedule']);"
run_case "diff filter: provider-registry.ts is delete-touching (#2720)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# Near-miss control for the #2720 entry: the pattern is anchored at BOTH ends,
# so a provisioning sibling whose basename merely STARTS with the scoped one is
# out of scope. Without this, a loose `provider-registry.*` would satisfy the
# case above while silently gating unrelated files.
stage_filter_change "src/provisioning/provider-registry-helpers.ts" "export const NOOP = 1;"
run_case "diff filter: provider-registry-helpers.ts passes through (#2720 anchor)" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"


# --- CROSS-REPO GATE NAMING (go-to-k/cdkd#2236) ---
#
# This hook fires on every Bash call the session makes, including merges whose
# target is a SIBLING repository -- deliberate policy. It then asked that repo
# about `integ-destroy`, a cdkd-only gate name, and markgate exits 1 for an
# UNDECLARED gate exactly as it does for a stale marker (measured with markgate
# 0.4.1: `status` prints `state: no marker` in both cases). The refusal was
# therefore unsatisfiable by any legitimate action -- hit live on
# `integ-local-gate`, and structurally identical here.
#
# Case 2 is the load-bearing one for THIS gate: unlike `integ-local` there is
# deliberately NO alias row for `integ-destroy`, because neither sibling verifies
# anything equivalent. It drives a FRESH verdict, so a hook that had guessed an
# alias by name would exit 0 and the case would fail.
x2236_mk_repo() {
  local dir="$1" origin="$2"; shift 2
  git init -q -b feature/x "$dir"
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
  [ "$origin" = "-" ] || git -C "$dir" remote add origin "$origin"
  if [ "$#" -gt 0 ]; then
    printf 'gates:\n' > "$dir/.markgate.yml"
    local g
    for g in "$@"; do
      printf '  %s:\n    hash: files\n    include:\n      - "src/**"\n' "$g" >> "$dir/.markgate.yml"
    done
  fi
}

x2236_declares="$TMPDIR/x2236-declares"
x2236_mk_repo "$x2236_declares" "https://github.com/go-to-k/cdkd.git" check integ-destroy
x2236_other="$TMPDIR/x2236-other"
x2236_mk_repo "$x2236_other" "https://github.com/go-to-k/cdk-local.git" check docs integ
x2236_bare="$TMPDIR/x2236-bare"
x2236_mk_repo "$x2236_bare" "https://github.com/go-to-k/cdk-local.git"
x2236_emptycfg="$TMPDIR/x2236-emptycfg"
x2236_mk_repo "$x2236_emptycfg" "https://github.com/go-to-k/cdk-local.git" check
: > "$x2236_emptycfg/.markgate.yml"

# x2236_case <name> <want_exit> <verdict> <CALLED|NOT_CALLED> <want-stderr|-> <repo>
#   The marker expectation reads $CWD_TRACE_FILE, which the mocked markgate
#   appends to on every call: an empty trace means the gate answered without
#   consulting a marker at all, which is what the no-equivalent refusal must do.
x2236_case() {
  local name="$1" want="$2" verdict="$3" mg="$4" want_txt="$5" repo="$6"
  local out got detail=""
  : > "$CWD_TRACE_FILE"
  out=$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$repo" \
    | MARKGATE_MOCK_VERDICT="$verdict" "$HOOK" 2>&1)
  got=$?
  [ "$got" = "$want" ] || detail="$detail; want exit $want, got $got"
  if [ "$mg" = "NOT_CALLED" ] && [ -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate must not be consulted, trace: $(tr '\n' '|' < "$CWD_TRACE_FILE")"
  fi
  if [ "$mg" = "CALLED" ] && [ ! -s "$CWD_TRACE_FILE" ]; then
    detail="$detail; markgate was never consulted"
  fi
  if [ "$want_txt" != "-" ] && ! printf '%s' "$out" | grep -qF "$want_txt"; then
    detail="$detail; stderr missing [$want_txt]"
  fi
  if [ -z "$detail" ]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log="${fail_log}FAIL $name$detail\n  output: $out\n"
    printf 'FAIL %s%s\n' "$name" "$detail"
  fi
}

# --- The HUNK filter itself, which nothing above exercised ---
#
# Every diff-filter case above drives `strict_delete` (any change to a listed
# file blocks) or an out-of-scope control. The OTHER half of the decision --
# `provider_pattern` / `filtered_delete` gated on `delete_symbol_pattern`, which
# is what decides a change to a provider or to an orchestration command -- had
# no case at all. Measured: neutering `delete_symbol_pattern` to a never-match
# string, or dropping `provider_pattern`, or replacing the whole
# `grep -qE "$filtered_delete|$provider_pattern"` with `false`, each left the
# suite at 60/0 while turning every provider verdict from 2 into 0. That is a
# merge allowed with a stale marker for a PR rewriting a provider's `delete()`
# -- a fail-open, and the dangerous direction.
#
# Its own staging helper because `stage_filter_change` REFUSES delete-symbol
# vocabulary by design: the strict cases depend on their content being
# symbol-free, and these two cases depend on the opposite.
# stage_filter_hunk <relative-path> <content-line-CARRYING-a-delete-symbol>
#
# The mirror of `stage_filter_change`'s guard, and needed for the same reason:
# that helper REFUSES delete vocabulary because its cases prove a file trips the
# gate on bucket membership; these cases prove the opposite, so the line must
# carry one. Unasserted, stripping the symbol from a call below turns the
# arming/pass-through PAIR into two pass-throughs and both stay green.
stage_filter_hunk() {
  local rel="$1"; local line="$2"
  case "$(printf '%s' "$line" | tr '[:upper:]' '[:lower:]')" in
    *delete*|*rollback*|*hyperplane*|*dependencyviolation*|*eni*|*detach*) ;;
    *)
      fail=$((fail + 1))
      fail_log+="FAIL stage_filter_hunk fixture for $rel carries NO delete-symbol "
      fail_log+="vocabulary, so the case it feeds cannot arm the hunk filter and "
      fail_log+="silently becomes a second pass-through: $line\n"
      printf 'FAIL stage_filter_hunk fixture content carries no delete symbol: %s\n' "$rel"
      ;;
  esac
  git -C "$filter_repo" reset -q --hard refs/remotes/origin/main
  mkdir -p "$filter_repo/$(dirname "$rel")"
  printf '%s\n' "$line" > "$filter_repo/$rel"
  git -C "$filter_repo" add -A
  git -C "$filter_repo" -c user.email=t@t -c user.name=t commit -q -m "hunk $rel"
}

# A provider whose diff ADDS a delete symbol: the hunk filter must arm the gate.
stage_filter_hunk "src/provisioning/providers/sqs-queue-provider.ts" \
  "  async deleteResource(physicalId: string) { return this.client.send(cmd); }"
run_case "hunk filter: provider delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# The SAME provider file with a string-only change: the filter must let it
# through. This is the half that proves the case above passes on the SYMBOL and
# not merely on the path -- without it, a `provider_pattern` promoted to strict
# would keep both green.
# Staged through `stage_filter_change`, not `stage_filter_hunk`: this is the
# NEGATIVE half, so its line must be symbol-FREE, which is exactly the
# invariant that helper asserts. The two guards are mirrors and each call site
# takes the one matching what it is proving.
stage_filter_change "src/provisioning/providers/sqs-queue-provider.ts" \
  "  private readonly label = 'queue provider';"
run_case "hunk filter: provider string-only change passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# ONE CASE PER ALTERNATIVE. The #2042 strict cases above state that standard
# ("each ALONE so that dropping any single alternative fails a case") -- an
# earlier revision of THIS comment claimed they all met it, which was false when
# written: 4 of `strict_delete`'s 7 did, and the analyzer trio did not until the
# loop further down was added. The first provider case covers only
# `providers/.*\.ts`; measured,
# `filtered_delete` could be replaced with a never-match string, and
# `provider_pattern` narrowed to `^src/provisioning/providers/.*\.ts$`, with the
# suite at 63/0 either way. That drops destroy.ts, destroy-runner.ts,
# deploy-engine.ts, cloud-control-provider.ts and region-check.ts out of the
# gate entirely -- the destroy ORCHESTRATION, more central to this gate than any
# single provider. The existing string-only case is the shared negative.
stage_filter_hunk "src/cli/commands/destroy.ts" \
  "  await runner.deleteStack({ stackName, force });"
run_case "hunk filter: destroy.ts delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_hunk "src/cli/commands/destroy-runner.ts" \
  "  const order = plan.deleteOrder();"
run_case "hunk filter: destroy-runner.ts delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_hunk "src/deployment/deploy-engine.ts" \
  "  await this.performRollback(failed);"
run_case "hunk filter: deploy-engine.ts delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_hunk "src/provisioning/cloud-control-provider.ts" \
  "  private async deleteRemnant(id: string) { return this.cc.send(cmd); }"
run_case "hunk filter: cloud-control-provider.ts delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# NOT a comment line: `comment_line_pattern` strips `//` lines before the symbol
# grep, so a commented delete symbol correctly does NOT arm the gate. Writing
# this fixture as a comment first is how that was confirmed -- it came back 0.
stage_filter_hunk "src/provisioning/region-check.ts" \
  "  assertRegionMatch(region, target, { onDetach: true });"
run_case "hunk filter: region-check.ts delete symbol arms the gate" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# --- markgate missing entirely ---
#
# The hook resolves `mise exec -- markgate`, else a bare `markgate`, else
# refuses. Measured: flipping that last `exit 2` to `exit 0` left the suite at
# 60/0 -- no case ran with neither binary on PATH, so the gate could be made to
# pass silently on any machine that had not run `mise install`.
# PATH derived from where `jq` and `git` actually live rather than hard-coded to
# `/usr/bin:/bin`: `jq` ships there only on macOS 15+, so the hard-coded form
# reddens this case on an older runner or a brew-only install for a reason that
# has nothing to do with the hook. A stub dir of symlinks keeps mise and
# markgate out without taking the rest of PATH with them.
nomg_dir="$TMPDIR/bin-nomarkgate"
mkdir -p "$nomg_dir"
for tool in bash env jq git awk sed grep dirname basename cat tr head tail wc cut sort uniq comm mktemp rm printf; do
  tool_path=$(command -v "$tool" 2>/dev/null) && ln -sf "$tool_path" "$nomg_dir/$tool"
done
nomg_out=$(printf '%s' "$payload_merge" \
  | PATH="$nomg_dir" MARKGATE_MOCK_VERDICT=stale "$HOOK" 2>&1 >/dev/null)
nomg_rc=$?
if [ "$nomg_rc" -eq 2 ] && printf '%s' "$nomg_out" | grep -q 'markgate is not installed'; then
  pass=$((pass + 1)); printf 'OK   refuses when markgate is not installed (exit 2)\n'
else
  fail=$((fail + 1))
  fail_log+="FAIL refuses when markgate is not installed: want exit 2 + 'markgate is not installed', got rc=$nomg_rc\n  output: $nomg_out\n"
  printf 'FAIL refuses when markgate is not installed (got %s)\n' "$nomg_rc"
fi

# --- The alternatives nothing was watching ---
#
# ONE CASE PER ALTERNATIVE is the standard this file claims, and measured, it
# was held by 4 of `strict_delete`'s 7 and by 3 of `delete_symbol_pattern`'s 7.
# Each group below could be deleted outright with the suite at 72/0.
#
# The analyzer trio first, because the hook's own header calls them "small
# high-stakes analyzer files": a PR touching only the deletion-order DAG merged
# with a stale or absent marker and nothing said so.
for analyzer_file in dag-builder implicit-delete-deps lambda-vpc-deps; do
  stage_filter_change "src/analyzer/$analyzer_file.ts" "const ORDER_SEED = 7;"
  run_case "diff filter: $analyzer_file.ts is strict" 2 stale "$filter_repo" \
    "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"
done

# Then the delete VOCABULARY. `delete`, `rollback` and `detach` were each
# reachable through an existing case; narrowing the pattern to just those three
# left the suite green, so the VPC/ENI teardown words the header names were
# unfenced. `IMPLICIT_DELETE` is deliberately not listed here -- it survives
# incidentally via `delete` under `grep -i`, so a case on it would fence nothing
# that the first one does not.
for delete_word in hyperplane DependencyViolation ENI; do
  stage_filter_hunk "src/provisioning/providers/vpc-attachment-provider.ts" \
    "  if (err.name === '$delete_word') { return this.retry(id); }"
  run_case "hunk filter: '$delete_word' is delete-symbol vocabulary" 2 stale "$filter_repo" \
    "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"
done

# --- Two jobs in one regex: the column-0 pair (issue 3046) ---
#
# `^[-+][^-+]` skipped the `+++` / `---` headers by CONSUMING the first content
# character, so a delete symbol at column 0 was invisible to the symbol grep and
# a column-0 `//` was invisible to the comment filter. Measured before the fix:
# `+deleteStack(name);` scored 0 while `+  deleteStack(name);` scored 2. The
# header skip is its own `grep -v` pass now, and both content patterns start at
# the first content character.
#
# Both directions, because the two patterns broke in OPPOSITE directions: the
# symbol one fails open (gate skipped), the comment one fails closed (an
# unrelated doc comment arms the gate, the PR-73 false positive the filter was
# added for).
stage_filter_hunk "src/cli/commands/destroy.ts" "deleteStack({ stackName });"
run_case "hunk filter: a column-0 delete symbol arms the gate (3046)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

stage_filter_hunk "src/cli/commands/destroy.ts" "// deleteStack is documented here, not called"
run_case "hunk filter: a column-0 comment does NOT arm the gate (3046)" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# The header-skipping pass is now separate, so it needs its own case -- and the
# case has to be a file whose PATH carries delete vocabulary, because that is
# the only way a `+++ b/<path>` line can match the content pattern. Content is
# symbol-free (staged through the guard that enforces it), so the ONLY thing
# that could arm this is the header line.
stage_filter_change "src/provisioning/providers/delete-marker-provider.ts" \
  "  private readonly label = 'marker';"
run_case "hunk filter: the +++ header is not read as content (3046)" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# --- Paths git does not hand back verbatim (issue 3047) ---
#
# Two mechanisms, one consequence: the changed-file list names a file the
# patterns cannot match, so the gate is skipped without consulting markgate.
#
# `core.quotePath` defaults to TRUE, so a non-ASCII path comes back C-quoted
# and the leading `"` defeats every `^src/` anchor. Note this case depends on
# git's DEFAULT, which is exactly what the config isolation at the top of this
# file makes reliable -- without it, a maintainer with `core.quotePath=false`
# globally would see it pass with the fix absent.
stage_filter_hunk "src/provisioning/providers/café-provider.ts" \
  "  async deleteResource(id: string) { return this.client.send(id); }"
run_case "a non-ASCII path still reaches the patterns (3047)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# A path carrying glob metacharacters is kept as a case even though it fences
# nothing, because the measurement behind it is worth not repeating: the review
# that found the quoting defect also reported that the per-file `-- "$f"`
# pathspec would fail to match `a[b]-provider.ts` and give an empty diff. It
# does not. Measured for `[`, `*` and `?` against git 2.49: the diff is
# byte-identical with and without `:(literal)`, because a pathspec equal to the
# path matches it literally; the `git ls-files -- 'kee[p].ts'` demo behind the
# report shows a glob matching a DIFFERENT file, which this call cannot do since
# `$f` comes from git's own changed-file list. `:(literal)` was added, measured
# to change no verdict, and removed.
stage_filter_hunk "src/provisioning/providers/a[b]-provider.ts" \
  "  async deleteResource(id: string) { return this.client.send(id); }"
run_case "a glob-magic path reaches the hunk filter (3047, regression guard)" 2 stale "$filter_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$filter_repo")"

# --- A FAILED diff is not an empty one ---
#
# `origin/main` can resolve while sharing no history with HEAD: a shallow clone,
# or an unrelated-history checkout. `git diff origin/main...HEAD` then exits 128
# with EMPTY stdout, which the pre-filter read as "no files changed" -> not
# delete-touching -> exit 0, with a STRICT file rewritten. The gate disabled by
# the one condition its own header calls out as needing exit 2, and no case saw
# it. The rc now decides and a failed diff falls through to markgate.
nohist_repo="$TMPDIR/nohist-repo"
git init -q -b main "$nohist_repo"
declare_gate "$nohist_repo" integ-destroy
mkdir -p "$nohist_repo/src/deployment"
echo "base" > "$nohist_repo/src/deployment/rollback-executor.ts"
git -C "$nohist_repo" add -A
git -C "$nohist_repo" -c user.email=t@t -c user.name=t commit -q -m base
git -C "$nohist_repo" update-ref refs/remotes/origin/main "$(git -C "$nohist_repo" rev-parse HEAD)"
# An ORPHAN branch: resolvable origin/main, no merge base with HEAD.
git -C "$nohist_repo" checkout -q --orphan feature/unrelated
echo "changed" > "$nohist_repo/src/deployment/rollback-executor.ts"
git -C "$nohist_repo" add -A
git -C "$nohist_repo" -c user.email=t@t -c user.name=t commit -q -m unrelated
run_case "unrelated history falls through to markgate, not through the gate" 2 stale "$nohist_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$nohist_repo")"

# --- A RENAME must not make a strict file disappear ---
#
# git's rename detection is ON by default, and `--name-only` then prints only
# the DESTINATION path. Measured: `git mv src/deployment/rollback-executor.ts`
# to a new name left the changed-file list with no strict path, `delete_touch`
# stayed 0, and the hook exited 0 WITHOUT consulting markgate -- on a branch
# markgate calls stale, since its own `DiffFrom` runs `--no-renames` and sees
# the deletion. Adding `--no-renames` to the hook takes this fixture 0 -> 2 and
# leaves the rest of the suite untouched, which is also the proof that nothing
# else covered it.
#
# The file body is long and repetitive on purpose: git scores similarity, and a
# one-line file is not detected as a rename at all, so a short fixture would
# pass for the wrong reason.
ren_repo="$TMPDIR/rename-repo"
git init -q -b main "$ren_repo"
declare_gate "$ren_repo" integ-destroy
mkdir -p "$ren_repo/src/deployment"
i=1
while [ "$i" -le 40 ]; do
  echo "export const line$i = $i;" >> "$ren_repo/src/deployment/rollback-executor.ts"
  i=$((i + 1))
done
git -C "$ren_repo" add -A
git -C "$ren_repo" -c user.email=t@t -c user.name=t commit -q -m base
git -C "$ren_repo" update-ref refs/remotes/origin/main "$(git -C "$ren_repo" rev-parse HEAD)"
git -C "$ren_repo" checkout -q -b feature/rename
git -C "$ren_repo" mv src/deployment/rollback-executor.ts src/deployment/rollback-runner.ts
git -C "$ren_repo" -c user.email=t@t -c user.name=t commit -q -m rename
run_case "renaming a strict file still consults the marker" 2 stale "$ren_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$ren_repo")"

# A renamed PROVIDER, which travels a different route: the destination path
# still matches `provider_pattern`, so it reaches the hunk filter and arms on
# the symbols the move carried.
#
# This case is a REGRESSION GUARD, not a fence, and saying so is the point: NO
# mutation of the current hook reddens it. Dropping `--no-renames` from the name
# list leaves it green (the destination alone is enough), and adding
# `--no-renames` to the hunk diff changes nothing either, because that diff is
# restricted to one path and git has no destination to pair the rename with. It
# is kept because the next person to touch rename handling -- the defect above
# is exactly that -- would otherwise have nothing asserting that a renamed
# provider still reaches markgate.
ren2_repo="$TMPDIR/rename-provider-repo"
git init -q -b main "$ren2_repo"
declare_gate "$ren2_repo" integ-destroy
mkdir -p "$ren2_repo/src/provisioning/providers"
echo "  async deleteResource(id: string) { return this.client.send(id); }" \
  > "$ren2_repo/src/provisioning/providers/old-provider.ts"
i=1
while [ "$i" -le 40 ]; do
  echo "export const line$i = $i;" >> "$ren2_repo/src/provisioning/providers/old-provider.ts"
  i=$((i + 1))
done
git -C "$ren2_repo" add -A
git -C "$ren2_repo" -c user.email=t@t -c user.name=t commit -q -m base
git -C "$ren2_repo" update-ref refs/remotes/origin/main "$(git -C "$ren2_repo" rev-parse HEAD)"
git -C "$ren2_repo" checkout -q -b feature/rename-provider
git -C "$ren2_repo" mv src/provisioning/providers/old-provider.ts \
  src/provisioning/providers/new-provider.ts
git -C "$ren2_repo" -c user.email=t@t -c user.name=t commit -q -m rename-provider
run_case "renaming a provider carrying a delete symbol arms the gate" 2 stale "$ren2_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42 --squash"}}' "$ren2_repo")"

x2236_case "target declaring integ-destroy consults that marker" 2 stale CALLED - "$x2236_declares"
x2236_case "sibling declaring only its own gate is NOT accepted on it" 2 fresh NOT_CALLED "declares no gate" "$x2236_other"
x2236_case "checkout with no .markgate.yml refuses actionably" 2 fresh NOT_CALLED "GATE_MARKER_ALIASES" "$x2236_bare"
x2236_case "unparsable config keeps the cdkd gate name (fail closed)" 2 stale CALLED "integ-destroy" "$x2236_emptycfg"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
