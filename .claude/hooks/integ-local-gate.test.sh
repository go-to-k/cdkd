#!/usr/bin/env bash
# Smoke test for integ-local-gate.sh.
#
# Exercises the cwd-aware command-matching against fixture git
# working trees, asserting the matcher correctly distinguishes
# gated commands (gh pr merge / git merge) from pass-through ones
# (gh pr create / git status / etc.). The marker-freshness branch
# is exercised end-to-end against the repo's own markgate state.
#
# Run from the repo root: `bash .claude/hooks/integ-local-gate.test.sh`.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/integ-local-gate.sh"

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


# Per-run scratch dir; cleaned on EXIT.
TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

# A fixture git working tree on a feature branch. The hook never
# itself touches the branch, but `git -C` checks (rev-parse --git-dir)
# need a real repo to pass.
fixture_repo="$TMPDIR/fixture-repo"
git init -q -b feature/x "$fixture_repo"
declare_gate "$fixture_repo" integ-local
git -C "$fixture_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
  got=$?
  # The above always evaluates to 0 (`|| true`), so capture status
  # via a separate run.
  printf '%s' "$payload" | "$HOOK" >/dev/null 2>&1
  got=$?
  if [[ "$got" == "$want" ]]; then
    pass=$((pass + 1))
    printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name: want exit $want, got $got\n"
    fail_log+="  payload: $payload\n"
    fail_log+="  output : $out\n"
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
  fi
}

# --- PASS-THROUGH cases (matcher must NOT fire) ---

# 1. Non-merge git command always passes through.
run_case "git status always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git status"}}' "$fixture_repo")"

# 2. `gh pr create` is intentionally NOT gated.
run_case "gh pr create always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr create --title foo"}}' "$fixture_repo")"

# 3. `gh pr view` is not gated.
run_case "gh pr view always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr view 42"}}' "$fixture_repo")"

# 4. `gh pr edit` is not gated.
run_case "gh pr edit always allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr edit 42 --title bar"}}' "$fixture_repo")"

# 5. Non-git-repo target dir → silent pass (we can't audit what we
#    can't see; mirrors branch-gate.sh).
run_case "non-git target dir allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge"}}' "$TMPDIR")"

# 6. Plain `ls` passes through.
run_case "non-gh non-git command allowed" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"ls -la"}}' "$fixture_repo")"

# 7. Empty stdin → cmd empty → allowed (nothing to gate).
run_case "empty stdin allowed" 0 \
  ''

# --- MATCHER cases (hook MUST fire and reach the markgate check) ---
#
# We can't easily mock markgate's output, but we CAN verify the hook
# reaches the markgate step rather than short-circuiting at the
# command-matcher. The fixture repo is not the cdkd repo (no
# .markgate.yml), so markgate verify will fail — exit 2 is the
# expected "matched + marker stale or unavailable" outcome.

# 8. `gh pr merge` matches.
run_case "gh pr merge matches (gate fires → exit 2)" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge"}}' "$fixture_repo")"

# 9. `gh pr merge --auto` matches.
run_case "gh pr merge --auto matches" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --auto"}}' "$fixture_repo")"

# 10. `git merge <branch>` matches.
run_case "git merge <branch> matches" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge origin/main"}}' "$fixture_repo")"

# 11. `cd <fixture> && gh pr merge` resolves via cd target.
run_case "cd <fixture> && gh pr merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"cd %s && gh pr merge"}}' "$fixture_repo")"

# 12. `git -C <fixture> merge` resolves via -C.
run_case "git -C <fixture> merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"git -C %s merge origin/main"}}' "$fixture_repo")"

# 13. `gh -C <fixture> pr merge` resolves via gh -C (cdkd #559).
#     Previously this hook only parsed `git -C`; the #559 fix adds
#     parallel `gh -C` parsing so cross-worktree gh invocations route
#     to the right markgate state.
run_case "gh -C <fixture> pr merge matches" 2 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"gh -C %s pr merge"}}' "$fixture_repo")"

# 14. `gh -C <side> pr merge --auto` from main-cwd → routes to side.
side_repo="$TMPDIR/side-repo"
git init -q -b feature/y "$side_repo"
declare_gate "$side_repo" integ-local
git -C "$side_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
run_case "gh -C <side> pr merge --auto from main cwd" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh -C %s pr merge --auto"}}' "$fixture_repo" "$side_repo")"

# --- LINE-START ANCHORING cases (issue #563) ---
#
# The matcher MUST NOT fire when the literal substrings `gh pr merge`
# / `git merge` appear inside a quoted argument body of an unrelated
# command. Per memory rule feedback_hook_command_match_line_start.md,
# applied to integ-local-gate.sh in issue #563 (mirroring the PR #562
# fix to check-gate.sh).

# 15. `gh issue create --body "...gh pr merge..."`: body mentions
#     `gh pr merge` but the line starts with `gh issue create`.
#     MUST pass through.
run_case "gh issue body quoting 'gh pr merge' passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh issue create --body \"next step: gh pr merge --squash\""}}' "$fixture_repo")"

# 16. `echo "...git merge..."`: body mentions `git merge` but the
#     command starts with `echo`. MUST pass through.
run_case "echo body quoting 'git merge' passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"echo \"reminder: git merge origin/main when ready\""}}' "$fixture_repo")"

# --- PR-DIFF SCOPE-CHECK cases (mirrors integ-destroy / integ-broad gates) ---
#
# For `gh pr merge <N>` WITH a PR number, the gate fetches the PR's file
# list via `gh pr view <N> --json files` and passes through when no file
# touches local-execution scope (src/local/** / src/cli/commands/local-*.ts
# / tests/integration/local-*). A stub `gh` on PATH returns a controlled
# file list; the real markgate (stale in this checkout) drives the
# fires-when-relevant case to exit 2.
GH_STUB_DIR="$TMPDIR/ghstub"
mkdir -p "$GH_STUB_DIR"
GH_FILES_PAYLOAD="$TMPDIR/gh-files.json"
cat > "$GH_STUB_DIR/gh" <<'GH_EOF'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "pr view" ]; then
  if [ "${GH_STUB_FAIL:-}" = "1" ]; then exit 1; fi
  cat "$GH_FILES_PAYLOAD"
  exit 0
fi
exit 0
GH_EOF
chmod +x "$GH_STUB_DIR/gh"
export GH_FILES_PAYLOAD
OLD_PATH="$PATH"
export PATH="$GH_STUB_DIR:$PATH"

# 17. PR with a number whose files are all NON-local -> scope check
#     passes the merge through (exit 0) even though integ-local is stale.
printf '{"files":[{"path":"src/provisioning/cloud-control-provider.ts"},{"path":"docs/changelog-cdkd.md"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> non-local files passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash --delete-branch"}}' "$fixture_repo")"

# 18. PR with a number whose files include a local-execution file ->
#     scope check engages, the (stale) marker blocks the merge (exit 2).
printf '{"files":[{"path":"src/local/docker-runner.ts"},{"path":"docs/changelog-cdkd.md"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> with src/local file gate fires" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash"}}' "$fixture_repo")"

# 19. PR with a number whose files include a tests/integration/local-*
#     fixture -> scope check engages, stale marker blocks (exit 2).
printf '{"files":[{"path":"tests/integration/local-invoke/verify.sh"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="" run_case "gh pr merge <N> with tests/integration/local- file gate fires" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999"}}' "$fixture_repo")"

# 20. `gh pr view` failure -> fail-open (exit 0), an infra outage must
#     not block merges (mirrors integ-broad-gate.sh).
printf '{"files":[{"path":"src/local/docker-runner.ts"}]}' > "$GH_FILES_PAYLOAD"
GH_STUB_FAIL="1" run_case "gh pr view failure fails open" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 999 --squash"}}' "$fixture_repo")"

export PATH="$OLD_PATH"

# --- GIT-MERGE INCOMING-DIFF SCOPE-CHECK cases (issue #1204) ---
#
# For `git merge [flags] <ref>` the hook enumerates the incoming range
# locally (`git diff --name-only HEAD...<ref>`) and passes through when
# no incoming file touches local-execution scope — the post-squash
# `git merge --ff-only origin/main` sync must not be blocked by a stale
# marker when the incoming commits touch no local code. Unparsable /
# unresolvable shapes still fall through to the (stale-here) verify.
merge_repo="$TMPDIR/merge-repo"
git init -q -b main "$merge_repo"
declare_gate "$merge_repo" integ-local
git -C "$merge_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m base
git -C "$merge_repo" branch -q incoming-nonlocal
git -C "$merge_repo" branch -q incoming-local
git -C "$merge_repo" switch -q incoming-nonlocal
mkdir -p "$merge_repo/src/provisioning"
echo x > "$merge_repo/src/provisioning/foo.ts"
git -C "$merge_repo" add -A
git -C "$merge_repo" -c user.email=t@t -c user.name=t commit -q -m nonlocal
git -C "$merge_repo" switch -q incoming-local
mkdir -p "$merge_repo/src/local"
echo x > "$merge_repo/src/local/docker-runner.ts"
git -C "$merge_repo" add -A
git -C "$merge_repo" -c user.email=t@t -c user.name=t commit -q -m local
git -C "$merge_repo" switch -q main

# 21. ff-merge of a NON-local incoming range passes through even though
#     the marker is stale (the #1204 symptom shape).
run_case "git merge --ff-only <non-local range> passes through" 0 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge --ff-only incoming-nonlocal"}}' "$merge_repo")"

# 22. Merge of a range that DOES touch src/local -> scope check engages,
#     the (stale) marker blocks (exit 2).
run_case "git merge <local-touching range> gate fires" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge incoming-local"}}' "$merge_repo")"

# 23. `git -C <merge_repo> merge --ff-only <non-local>` from another cwd
#     resolves the diff in the target dir and passes through. The repo
#     dir is named "merge-repo", so this also proves the subcommand
#     locator is token-based and not fooled by "merge" in a path.
run_case "git -C <merge_repo> merge non-local range passes through" 0 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"git -C %s merge --ff-only incoming-nonlocal"}}' "$merge_repo")"

# 23b. `cd <merge_repo> && git merge --ff-only <non-local>` resolves via
#      the cd target and passes through.
run_case "cd <merge_repo> && git merge non-local range passes through" 0 \
  "$(printf '{"cwd":"/tmp","tool_input":{"command":"cd %s && git merge --ff-only incoming-nonlocal"}}' "$merge_repo")"

# 24. Unresolvable ref (no `origin` remote here) -> conservative
#     fall-through to the unconditional (stale) verify (exit 2).
run_case "git merge --ff-only unresolvable ref still blocks" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge --ff-only origin/main"}}' "$merge_repo")"

# 25. `git merge --abort` -> no incoming range; conservative
#     fall-through (exit 2).
run_case "git merge --abort falls through to verify" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge --abort"}}' "$merge_repo")"

# 26. Octopus merge (2+ refs) -> conservative fall-through (exit 2)
#     even though one ref's range is non-local.
run_case "git merge octopus falls through to verify" 2 \
  "$(printf '{"cwd":"%s","tool_input":{"command":"git merge incoming-nonlocal incoming-local"}}' "$merge_repo")"

# --- CROSS-REPO GATE NAMING (go-to-k/cdkd#2236) ---
#
# These hooks fire on every Bash call the session makes, including merges whose
# target is a SIBLING repository -- deliberate policy. The gate then asked that
# repo about a gate named `integ-local`, which cdk-local does not declare (it
# names the same Docker local-execution gate `integ`), and markgate exits 1 for
# an undeclared gate exactly as it does for a stale marker. The merge was
# therefore UNSATISFIABLE by any legitimate action: hit live merging
# go-to-k/cdk-local#558 with cdk-local's own `integ` marker verified fresh.
#
# BOTH DIRECTIONS are driven below, and the ACCEPT direction is the one that
# matters here: a guard fenced only on "refuses what it must" cannot see an
# over-tightening, and this defect IS an over-tightening. Case A is the only
# case that would have failed against the pre-fix hook by PASSING a merge.
#
# The cases assert the markgate ARGV, not only the exit code. A gate pointed at
# the wrong marker is indistinguishable from a working one by exit code, message
# and cwd alike -- the lesson `markgate-gate-name-class.test.sh` exists for.
#
# HERMETIC AXES, pinned rather than normalised:
#   git history -- every fixture is a fresh `git init` + one empty commit, and
#                  the declared gates use `hash: files`, so no origin/main,
#                  merge base or fetch state is read.
#   cwd         -- passed explicitly in each payload; never inherited.
#   env         -- PATH is prefixed with a shim dir for this section only and
#                  restored after; the marker verdict comes from MG_VERDICT
#                  rather than from any real marker store.
#   $HOME       -- not read: markgate is shimmed for every case in this section,
#                  so no user-level markgate config or state is consulted.
#   clock       -- the fixture gates declare no `ttl`, and the shim's verdict is
#                  fixed, so no case can age.

X_SHIM="$TMPDIR/x2236-bin"
mkdir -p "$X_SHIM"
MG_ARGV="$TMPDIR/x2236-mg-argv"

cat > "$X_SHIM/markgate" <<MG_EOF
#!/usr/bin/env bash
echo "\$*" >> "$MG_ARGV"
case "\$1" in
  verify) [ "\${MG_VERDICT:-stale}" = fresh ] && exit 0; exit 1 ;;
  status)
    if [ "\${MG_VERDICT:-stale}" = fresh ]; then
      printf 'key:        %s\nstate:      match\n' "\$2"
    else
      printf 'key:        %s\nstate:      stale (digest differs)\n' "\$2"
    fi
    exit 0 ;;
esac
exit 1
MG_EOF

cat > "$X_SHIM/mise" <<'MISE_EOF'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then
  shift 2
  exec "$@"
fi
exit 1
MISE_EOF
chmod +x "$X_SHIM"/markgate "$X_SHIM/mise"

# mk_repo <dir> <origin-url|-> <gate...>
#   A fixture checkout declaring exactly the gates named. `-` for the origin
#   URL leaves the repo remote-less; no gate names leaves `.markgate.yml` out
#   entirely (a checkout that is not a markgate repo at all).
mk_repo() {
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

# run_x <name> <want_exit> <verdict> <want-in-stderr|-> <must-NOT-be-in-stderr|-> <want-argv|-> <payload>
run_x() {
  local name="$1" want="$2" verdict="$3" want_txt="$4" deny_txt="$5" want_argv="$6" payload="$7"
  local out got argv detail=""
  : > "$MG_ARGV"
  out=$(printf '%s' "$payload" | MG_VERDICT="$verdict" PATH="$X_SHIM:$PATH" "$HOOK" 2>&1)
  got=$?
  argv=$(tr '\n' '|' < "$MG_ARGV" 2>/dev/null)
  [ "$got" = "$want" ] || detail="$detail; want exit $want, got $got"
  if [ "$want_txt" != "-" ] && ! printf '%s' "$out" | grep -qF "$want_txt"; then
    detail="$detail; stderr missing [$want_txt]"
  fi
  if [ "$deny_txt" != "-" ] && printf '%s' "$out" | grep -qF "$deny_txt"; then
    detail="$detail; stderr must NOT contain [$deny_txt]"
  fi
  if [ "$want_argv" != "-" ]; then
    if [ "$want_argv" = "NONE" ]; then
      [ -z "$argv" ] || detail="$detail; markgate must not be called, got argv [$argv]"
    elif ! printf '%s' "$argv" | grep -qF "$want_argv"; then
      detail="$detail; markgate argv [$argv] missing [$want_argv]"
    fi
  fi
  if [ -z "$detail" ]; then
    pass=$((pass + 1)); printf 'OK   %s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    fail_log+="FAIL $name$detail\n  output: $out\n"
    printf 'FAIL %s%s\n' "$name" "$detail"
  fi
}

sib_repo="$TMPDIR/x-sibling"          # go-to-k/cdk-local: declares `integ`, not `integ-local`
mk_repo "$sib_repo" "https://github.com/go-to-k/cdk-local.git" check docs integ
unknown_repo="$TMPDIR/x-unknown"      # same gate NAME, unmapped repo
mk_repo "$unknown_repo" "https://github.com/someone-else/other.git" check docs integ
nogate_repo="$TMPDIR/x-nogate"        # mapped repo, but declares no equivalent
mk_repo "$nogate_repo" "https://github.com/go-to-k/cdk-local.git" check docs
bare_repo="$TMPDIR/x-bare"            # not a markgate repo at all
mk_repo "$bare_repo" "https://github.com/go-to-k/cdk-local.git"
empty_cfg_repo="$TMPDIR/x-emptycfg"   # config present but no parsable gates block
mk_repo "$empty_cfg_repo" "https://github.com/go-to-k/cdk-local.git" check
: > "$empty_cfg_repo/.markgate.yml"
own_repo="$TMPDIR/x-owngate"          # a sibling slug that DOES declare integ-local
mk_repo "$own_repo" "https://github.com/go-to-k/cdk-local.git" check integ-local integ

# A. THE DEFECT. Sibling repo, its own equivalent gate FRESH -> the merge must
#    proceed. Pre-fix this asked for `integ-local`, which cannot exist there, so
#    it exited 2 no matter what had been verified.
run_x "sibling with fresh equivalent gate ACCEPTS the merge" 0 fresh - - "verify integ" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$sib_repo")"

# A2. And it asked about THAT gate rather than acquiring a second marker: a gate
#     that verifies both passes whenever EITHER is fresh.
run_x "sibling accept does not also ask about integ-local" 0 fresh - - - \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$sib_repo")"
if grep -q 'integ-local' "$MG_ARGV" 2>/dev/null; then
  fail=$((fail + 1)); printf 'FAIL sibling accept must not verify integ-local too\n'
  fail_log+="FAIL sibling accept must not verify integ-local too: argv $(tr '\n' '|' < "$MG_ARGV")\n"
else
  pass=$((pass + 1)); printf 'OK   sibling accept asks about `integ` ONLY\n'
fi

# B. Sibling repo, its equivalent gate STALE -> still refused, but with a
#    SATISFIABLE instruction naming the gate that repo actually has.
run_x "sibling with stale equivalent gate refuses, naming ITS gate" 2 stale \
  "its gate    : integ" "the \`integ-local\` marker is stale" "verify integ" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$sib_repo")"

# B2. The refusal must carry the command that refreshes it in that repo.
run_x "sibling stale refusal names the command to run there" 2 stale \
  "/run-integ local-" - - \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$sib_repo")"

# C. SAFETY: the mapping is keyed on the repo, not on the gate name. An unmapped
#    repo that happens to declare a gate called `integ` must NOT have its merge
#    accepted on that marker -- the name says nothing about what it verified.
run_x "unmapped repo declaring 'integ' is NOT accepted on it" 2 fresh \
  "declares no gate" - NONE \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$unknown_repo")"

# D. Mapped repo that declares no equivalent -> refused, and the refusal must
#    not name a gate that cannot exist there.
run_x "mapped repo with no equivalent gate refuses actionably" 2 fresh \
  "GATE_MARKER_ALIASES" "Required action" NONE \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$nogate_repo")"

# E. A checkout with no `.markgate.yml` declares nothing, so the same refusal
#    applies -- the exit code is what it always was; only the message changed.
run_x "checkout with no .markgate.yml refuses actionably" 2 fresh \
  "declares no gate" - NONE \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$bare_repo")"

# F. FAIL CLOSED. A config present but unparsable (no gates block) is
#    UNDETERMINABLE, not "no such gate": the hook keeps the cdkd gate name, so a
#    config this parser does not understand can never route a merge elsewhere.
run_x "unparsable config keeps the cdkd gate name (fail closed)" 2 stale \
  "integ-local" - "verify integ-local" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$empty_cfg_repo")"

# G. A repo that DOES declare integ-local uses it, mapping row or not.
run_x "target declaring integ-local uses it, not the alias" 0 fresh - - "verify integ-local" \
  "$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge --squash"}}' "$own_repo")"

# H. The scope guard still runs FIRST: a sibling PR touching no local file
#    passes through without any marker question at all.
X_GH="$TMPDIR/x2236-gh"
mkdir -p "$X_GH"
cat > "$X_GH/gh" <<'XGH_EOF'
#!/usr/bin/env bash
if [ "${1:-} ${2:-}" = "pr view" ]; then
  printf '{"files":[{"path":"src/utils/logger.ts"}]}'
  exit 0
fi
exit 0
XGH_EOF
chmod +x "$X_GH/gh"
: > "$MG_ARGV"
x_out=$(printf '{"cwd":"%s","tool_input":{"command":"gh pr merge 7 --squash"}}' "$sib_repo" \
  | MG_VERDICT=stale PATH="$X_GH:$X_SHIM:$PATH" "$HOOK" 2>&1)
x_rc=$?
if [ "$x_rc" = 0 ] && [ ! -s "$MG_ARGV" ]; then
  pass=$((pass + 1)); printf 'OK   sibling PR out of local scope passes before any gate lookup (exit 0)\n'
else
  fail=$((fail + 1)); printf 'FAIL sibling PR out of local scope (rc=%s argv=%s)\n' "$x_rc" "$(tr '\n' '|' < "$MG_ARGV")"
  fail_log+="FAIL sibling PR out of local scope: rc=$x_rc out=$x_out\n"
fi

# I. PARSER FENCE against the REAL config this repo ships. A parser that
#    answered "not declared" for cdkd's own `integ-local` would silently route
#    every cdkd merge onto some other marker, and no case above would see it,
#    since they all build their own config. It must also DISCRIMINATE: cdkd
#    declares no gate called `integ`, so a parser saying yes to everything fails
#    the second half.
X_REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck source=lib/command-match.sh
. "$(dirname "${BASH_SOURCE[0]}")/lib/command-match.sh"
if gate_markgate_declares "$X_REPO_ROOT" integ-local; then
  pass=$((pass + 1)); printf "OK   parser reads this repo's own .markgate.yml: integ-local IS declared\n"
else
  fail=$((fail + 1)); printf 'FAIL parser does not see integ-local in the shipped .markgate.yml\n'
  fail_log+="FAIL parser does not see integ-local in the shipped .markgate.yml\n"
fi
gate_markgate_declares "$X_REPO_ROOT" integ; x_declares_integ=$?
if [ "$x_declares_integ" = 1 ]; then
  pass=$((pass + 1)); printf 'OK   parser discriminates: cdkd declares no gate called `integ`\n'
else
  fail=$((fail + 1)); printf 'FAIL parser returned %s for a gate cdkd does not declare\n' "$x_declares_integ"
  fail_log+="FAIL parser returned $x_declares_integ for a gate cdkd does not declare\n"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
