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
      printf 'key:        %s\nstate:      stale (expired by ttl: 14d, marker is 17d old)\n' "\$2"
    elif [ "\$verdict" = "stale_noreason" ]; then
      # The hook's reason extraction "fails open to the pre-0.3 generic
      # message" -- an older or odd markgate whose \`status\` carries no
      # parenthesized reason. \`verify\` still says stale, so this is a LIVE
      # second stale spelling, and it is the one a user with a mismatched
      # markgate reaches. Nothing else in this suite produces it.
      printf 'key:        %s\nstate:      stale\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
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
run_msg_case "stale marker still advises /run-integ" stale \
  'Required action' 'could not EVALUATE' \
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
N_SCOPE='the exact file list markgate digests'
N_CAUSE='does not stale this marker by itself'
payload_merge="$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 42"}}' "$side_repo")"

run_msg_case "stale message names markgate --explain (#3010)" stale \
  "$N_EXPLAIN" 'could not EVALUATE' "$payload_merge"

run_msg_case "stale message says what --explain prints (#3010)" stale \
  "$N_SCOPE" 'could not EVALUATE' "$payload_merge"

# The claim that makes the command actionable: a peer's merge is NOT by itself
# a cause of staleness here. Separate from the cases above because the command
# tells the reader what to run, not what to conclude from the answer.
run_msg_case "stale message rules out a bare peer merge as the cause (#3010)" stale \
  "$N_CAUSE" 'could not EVALUATE' "$payload_merge"

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

run_msg_case "reason-less stale takes the fallback header (#3010)" stale_noreason \
  'IMPLICIT_DELETE_DEPENDENCIES' "$N_CAUSE" "$payload_merge"

run_msg_case "reason-less stale still offers the scope diagnostic (#3010)" stale_noreason \
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
