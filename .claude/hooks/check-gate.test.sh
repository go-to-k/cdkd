#!/usr/bin/env bash
# Smoke test for check-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees and asserts that the markgate verify runs against
# the RESOLVED target directory — not the script's location. This
# is the post-#559 contract: markers land in the worktree where the
# `git commit` actually runs, not always in the main tree.
#
# Since #2027 it also fences the FAIL-CLOSED contract: every state in
# which the hook cannot evaluate the markers must REFUSE, not pass
# through. The reproduced bug was `git -C "$W" commit` reaching the hook
# with `$W` unexpanded, which resolved to a non-repo path and took the
# old "not a git repo -> silent exit 0" branch. Each fail-closed case
# below was verified to return 0 (i.e. to go RED) against the pre-#2027
# hook.
#
# Run from the repo root: `bash .claude/hooks/check-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/check-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# Fixture git working trees. They have no markgate state of their
# own; we stub markgate via PATH and pin its verdict via env var.
side_repo="$TMPDIR/side-repo"
main_repo="$TMPDIR/main-repo"
plain_repo="$TMPDIR/plain-repo"
git init -q -b feature/x "$side_repo"
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
git init -q -b main "$main_repo"
git -C "$main_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
# A git repo WITHOUT `.markgate.yml`: not a markgate repo, so the gate must
# stay out of its way — including for the fail-closed refusals.
git init -q -b feature/y "$plain_repo"
git -C "$plain_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

# Repo opt-in signal (mirrors branch-gate.test.sh): the gate only fires in a
# repo carrying a `.markgate.yml` at its top level, so the fixtures must have
# one or every case would pass through untested.
touch "$side_repo/.markgate.yml" "$main_repo/.markgate.yml"

# Shim dir for mise + markgate. markgate's verdict comes from
# $MARKGATE_MOCK_VERDICT:
#   fresh          -> verify exits 0
#   stale          -> verify exits 1 (a real VERDICT)
#   badconfig      -> verify exits 2 (markgate could not evaluate at all;
#                     real markgate 0.2.0 and 0.4.1 both use 2 for an
#                     unparseable .markgate.yml)
#   broken-binary  -> even `--version` fails, i.e. markgate cannot run
# Each call appends $PWD to $CWD_TRACE_FILE so the test asserts the
# resolved target dir.
SHIM_DIR="$TMPDIR/bin"
mkdir -p "$SHIM_DIR"
CWD_TRACE_FILE="$TMPDIR/cwd-trace"

cat > "$SHIM_DIR/mise" <<'MISE_EOF'
#!/usr/bin/env bash
# Pass-through `mise exec -- <cmd> <args>`, unless the fixture asks us to
# behave like a fresh worktree whose `.mise.toml` was never trusted — the
# exact environment of go-to-k/cdkd#2027.
if [ -n "${MISE_MOCK_UNTRUSTED:-}" ]; then
  echo "mise ERROR error parsing config file: $PWD/.mise.toml" >&2
  echo "mise ERROR Config files in $PWD/.mise.toml are not trusted." >&2
  echo "Trust them with \`mise trust\`." >&2
  exit 1
fi
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
  --version)
    if [ "\$verdict" = "broken-binary" ]; then
      echo "markgate: not executable" >&2
      exit 127
    fi
    echo "0.4.1"
    exit 0
    ;;
  verify)
    case "\$verdict" in
      fresh) exit 0 ;;
      badconfig)
        echo "markgate: parse .markgate.yml: yaml: line 1: did not find expected ',' or ']'" >&2
        exit 2
        ;;
      *) exit 1 ;;
    esac
    ;;
  status)
    if [ "\$verdict" = "fresh" ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
    fi
    exit 0
    ;;
esac
exit 1
MARKGATE_EOF
chmod +x "$SHIM_DIR/markgate"

# Drop pre-existing mise / markgate from PATH so our shims win.
export PATH="$SHIM_DIR:$PATH"

pass=0
fail=0
fail_log=""

# Optional per-case environment, reset by run_case after every call.
CASE_HOME=""
CASE_UNTRUSTED_MISE=""

# run_case <name> <expect_exit> <mg_verdict> <expect_cwd> <stdin_json> [expect_msg]
#   expect_cwd: empty string skips the cwd assertion (used for
#   pass-through cases that should never reach markgate).
#   expect_msg: when non-empty, stderr must contain this literal
#   substring — the fail-closed cases all exit 2, so the message is what
#   tells "cannot evaluate" apart from "the marker is stale".
run_case() {
  local name="$1"; local want="$2"; local verdict="$3"; local expect_cwd="$4"; local payload="$5"
  local expect_msg="${6:-}"
  : > "$CWD_TRACE_FILE"
  local got err
  err=$(printf '%s' "$payload" | env \
    MARKGATE_MOCK_VERDICT="$verdict" \
    ${CASE_HOME:+HOME="$CASE_HOME"} \
    ${CASE_UNTRUSTED_MISE:+MISE_MOCK_UNTRUSTED=1} \
    "$HOOK" 2>&1 >/dev/null)
  got=$?
  CASE_HOME=""
  CASE_UNTRUSTED_MISE=""

  local cwd_ok=1
  if [ -n "$expect_cwd" ]; then
    if ! grep -qFx "$expect_cwd" "$CWD_TRACE_FILE" 2>/dev/null; then
      cwd_ok=0
    fi
  fi

  local msg_ok=1
  if [ -n "$expect_msg" ]; then
    if ! printf '%s' "$err" | grep -qF "$expect_msg"; then
      msg_ok=0
    fi
  fi

  if [[ "$got" == "$want" ]] && [ "$cwd_ok" -eq 1 ] && [ "$msg_ok" -eq 1 ]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got"
    if [ "$cwd_ok" -eq 0 ]; then
      fail_log+="; cwd mismatch (want '$expect_cwd', trace: $(cat "$CWD_TRACE_FILE" 2>/dev/null | tr '\n' '|'))"
    fi
    if [ "$msg_ok" -eq 0 ]; then
      fail_log+="; message mismatch (want substring '$expect_msg', got: $(printf '%s' "$err" | tr '\n' '|'))"
    fi
    fail_log+="\n  payload: $payload\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- PASS-THROUGH cases (matcher must NOT fire) ---

# 1. Non-commit git command always passes through.
run_case "git status passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$side_repo")"

# 2. Empty command passes through.
run_case "empty stdin passes through" 0 stale "" ''

# 3. Non-git cwd AND non-git target → silent pass. The session is not in a
#    markgate repo, so the gate has no standing to refuse (this is the bound
#    that keeps the #2027 fail-closed refusals off unrelated checkouts).
run_case "non-git cwd + non-git target allowed" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$TMPDIR")"

# --- CWD-AWARE cases: marker verdict pinned to "stale" so the hook
#     MUST reach the markgate step (exit 2) and the trace MUST show
#     the resolved target dir. With fresh marker → exit 0.

# 4. Invoked from side worktree → markgate runs in side worktree.
#    This is the load-bearing #559 case: pre-fix, the hook always
#    landed in the main tree regardless of cwd.
run_case "side worktree cwd → markgate runs there" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")"

# 5. Invoked from main worktree → markgate runs in main worktree.
run_case "main worktree cwd → markgate runs there" 2 stale "$main_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$main_repo")"

# 6. `cd <side> && git commit` from main-cwd → markgate runs in side.
run_case "cd <side> && git commit from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd %s && git commit -m x"}}' "$main_repo" "$side_repo")"

# 7. `git -C <side> commit` from main-cwd → markgate runs in side.
run_case "git -C <side> commit from main cwd → side wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s commit -m x"}}' "$main_repo" "$side_repo")"

# 8. Fresh marker in side worktree → pass-through.
run_case "fresh marker passes" 0 fresh "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")"

# --- LINE-START ANCHORING cases: the matcher MUST NOT fire when the
#     literal substring `git commit` appears inside a quoted argument
#     body of an unrelated command. Per memory rule
#     feedback_hook_command_match_line_start.md — surfaced by the
#     PR #562 code review.

# 9. `gh issue create --body "...git commit..."` — `git commit` is
#    inside a quoted body, line starts with `gh`. MUST NOT fire.
run_case "gh issue body quoting 'git commit' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"we should add a git commit hook later\""}}' "$side_repo")"

# 10. `echo "Run: git commit"` — quoted body, line starts with `echo`.
run_case "echo body quoting 'git commit' passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"Run: git commit -m x\""}}' "$side_repo")"

# 11. `git commit-tree` — `commit-tree` is a separate plumbing
#     subcommand; the trailing class must exclude `-`.
run_case "git commit-tree passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit-tree HEAD^{tree} -m x"}}' "$side_repo")"

# --- Repo opt-in scope (mirrors branch-gate.sh) ------------------------------
# A repo with no `.markgate.yml` at its top level is not a markgate repo: the
# gate must pass through rather than demand a marker the repo cannot have.
# Without this the gate blocked commits in unrelated checkouts a session
# happened to touch.
run_case "repo without .markgate.yml passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$plain_repo")"

# --- FAIL-CLOSED cases (issue #2027) ----------------------------------------
# Measured against the pre-#2027 hook, these split into two kinds, and the
# difference is worth stating rather than flattening into "they all failed":
#
#   - SILENT PASS (old exit 0, the actual defect): cases 12-15, 16b and 24.
#   - WRONG REMEDY (old exit 2, but naming the marker instead of the thing
#     that could not be evaluated): cases 16, 18, 19 and 20. #19 is the worst
#     of these — it told the user to run /check, which goes through the same
#     untrusted mise and fails the same way, i.e. a loop.
#
# So each case asserts the MESSAGE as well as the exit code; on the message-
# only ones the exit code alone cannot tell a refusal apart from a verdict.
#
# The rest (17, 17b, 21-23) are CONTROLS: green against both hooks by
# construction, since they fence the direction the fix must NOT go — the
# opt-in bound, an absolute `-C` overriding an unresolvable `cd`, and a `cd`
# that happens after the verb. Stated rather than counted as fences.

# 12. THE REPRODUCED BUG. The agent's standard commit form reaches the hook
#     with `$W` unexpanded; the old parse joined the literal `$W` onto the
#     payload cwd, `git -C '<cwd>/$W' rev-parse` failed, and the hook exited 0.
run_case "git -C \"\$W\" (unexpanded) refuses" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" add -A && git -C \\"$W\\" commit -F /tmp/msg"}}' "$side_repo")" \
  "unexpanded shell variable"

# 13. Same, unquoted — `git -C $W commit`.
run_case "git -C \$W (unquoted, unexpanded) refuses" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C $W commit -m x"}}' "$side_repo")" \
  "unexpanded shell variable"

# 14. Braced form — `git -C "${WORKTREE}" commit`.
run_case "git -C \"\${WORKTREE}\" refuses" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"${WORKTREE}\\" commit -m x"}}' "$side_repo")" \
  "unexpanded shell variable"

# 15. A literal but non-existent `git -C` path: the resolution may be right
#     (and the commit would fail anyway) or wrong (and the gate would be
#     verifying nothing) — either way the hook does not know.
run_case "git -C <nonexistent> refuses" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s/no-such-dir commit -m x"}}' "$side_repo" "$TMPDIR")" \
  "is not a git repository"

# 16. An unresolvable `cd` with no absolute `-C` to override it. The old hook
#     fell back to the payload cwd and verified a DIFFERENT tree than the one
#     the commit lands in — a pass earned by the wrong worktree's markers.
run_case "cd \"\$W\" && git commit refuses" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd \\"$W\\" && git commit -m x"}}' "$side_repo")" \
  "unexpanded shell variable"

# 16b. The same unresolvable `cd`, but with the SESSION's markers FRESH. This
#      is case 16's fail-open half: the old hook fell back to the payload cwd,
#      found fresh markers there, and let the commit through — a pass earned by
#      a worktree that is not the one being committed to. Old hook: exit 0.
run_case "cd \"\$W\" && git commit refuses even when the cwd's markers are fresh" 2 fresh "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd \\"$W\\" && git commit -m x"}}' "$side_repo")" \
  "unexpanded shell variable"

# 17. Control for 16: an unresolvable `cd` is MOOT when an absolute `git -C`
#     follows it, because the `-C` decides where git runs. Must resolve to
#     side_repo and reach markgate normally.
run_case "unresolvable cd + absolute git -C → -C wins" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"cd \\"$W\\" && git -C %s commit -m x"}}' "$main_repo" "$side_repo")"

# 17b. A `cd` AFTER the verb must not trip the refusal: the standing
#      post-commit form `git commit ... && cd <repo> && git pull` cds only
#      once the commit has already run, so it says nothing about where the
#      commit landed. Pinned FRESH so a false refusal shows up as a plain
#      exit-code difference rather than hiding inside a stale verdict.
run_case "trailing cd after the verb does not refuse" 0 fresh "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x && cd \\"$W\\" && git pull"}}' "$side_repo")"

# 18. markgate cannot be EXECUTED at all → refuse naming the toolchain, not
#     the marker. (The old hook reported this as a stale-marker verdict.)
run_case "markgate binary unrunnable refuses" 2 broken-binary "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")" \
  "could not be executed"

# 19. The #2027 environment itself: a fresh worktree whose `.mise.toml` was
#     never trusted, so `mise exec` fails before markgate ever runs. The
#     remedy must be `mise trust`, not "run /check first" — /check runs
#     through the same untrusted mise and would send the user in a circle.
CASE_UNTRUSTED_MISE=1
run_case "untrusted .mise.toml refuses with 'mise trust'" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")" \
  "mise trust"

# 20. `.markgate.yml` unreadable: markgate exits 2 (its "could not evaluate"
#     code, distinct from 1 = stale). Refuse naming the config.
run_case "unparseable .markgate.yml refuses" 2 badconfig "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$side_repo")" \
  "markgate configuration"

# --- The BOUND on fail-closed, and where it MOVED --------------------------
# It used to ask the PAYLOAD CWD whether this is a markgate repo -- consulting
# the cwd exactly when the target is unknown, so a drifted cwd produced a silent
# pass on the very command the refusal exists for (go-to-k/cdkd#2027 review,
# minor 5). It now asks the HOOK's own checkout. Cases 21-23 therefore assert
# the OPPOSITE of what they did in the first round, and that is the point.

# 21. Unexpanded `git -C` with the session in a repo carrying no
#     `.markgate.yml` → still refused: the hook knows which repo IT belongs to.
run_case "unexpanded git -C refuses from a non-markgate cwd" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' "$plain_repo")" \
  "unexpanded shell variable"

# 22. Unexpanded `git -C` with a cwd that is not a git repo at all → refused.
run_case "unexpanded git -C refuses from outside any repo" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C \\"$W\\" commit -m x"}}' "$TMPDIR")" \
  "unexpanded shell variable"

# 23. A readable but nonexistent `-C` target, from a non-markgate cwd → refused
#     for the OTHER reason (not a git repository), which the message must say.
run_case "nonexistent git -C target refuses from a non-markgate cwd" 2 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C %s/no-such-dir commit -m x"}}' "$plain_repo" "$TMPDIR")" \
  "is not a git repository"

# 23b. The ORDINARY opt-in is untouched: a READABLE target in a repo with no
#      `.markgate.yml` still passes through, so unrelated checkouts stay ungated.
run_case "readable target in a non-markgate repo still passes through" 0 stale "" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git commit -m x"}}' "$plain_repo")"

# 24. A `~`-rooted path must still RESOLVE rather than trip the refusal: the
#     hook sees the command text, so `~` arrives as a literal segment and is
#     expanded here. HOME is pinned to the fixture root for this case.
CASE_HOME="$TMPDIR"
run_case "git -C ~/side-repo resolves (no false refusal)" 2 stale "$side_repo" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git -C ~/side-repo commit -m x"}}' "$main_repo")"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
