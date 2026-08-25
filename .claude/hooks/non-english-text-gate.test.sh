#!/usr/bin/env bash
# Smoke test for non-english-text-gate.sh.
#
# Verifies the hook's trigger surface and Unicode-range matcher
# against fixture git repos. The PR-mode path is exercised via a
# stub `gh` injected through $GH_BIN — same pattern as
# post-merge-orphan-push-gate.test.sh.

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/non-english-text-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

init_repo() {
  local dir="$1"
  git init -q -b main "$dir"
  mkdir -p "$dir/src" "$dir/docs" "$dir/.claude/hooks"
  cat > "$dir/README.md" <<'EOF'
# project
Baseline.
EOF
  cat > "$dir/src/foo.ts" <<'EOF'
export const foo = 1;
EOF
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m baseline
  # Mock origin/main so the local-diff fallback (`merge-base
  # origin/main HEAD`) has a base. We use a non-tracking ref to keep
  # the fixture self-contained.
  git -C "$dir" update-ref refs/remotes/origin/main HEAD
  git -C "$dir" symbolic-ref refs/remotes/origin/HEAD refs/remotes/origin/main
}

commit_all() {
  local dir="$1"
  git -C "$dir" add -A
  git -C "$dir" -c user.email=t@t -c user.name=t commit -q -m wip
}

# Stub `gh`. The hook calls:
#   gh -C <dir> auth status            -> rc 0 = authed
#   gh -C <dir> pr view --json number  -> "" (no PR; local-diff fallback)
#   gh -C <dir> pr view <N> --json...  -> rejects (we use local-diff)
#   gh pr diff <N> --name-only -> N/A here
#   (NO `-C`: real gh has no such flag, and the stub now refuses it too)
make_gh_stub() {
  local out="$TMPDIR/gh-stub"
  cat > "$out" <<'EOF'
#!/usr/bin/env bash
# REJECT `-C` exactly as the real `gh` does. This stub used to STRIP it, with
# a comment saying so, and that single line hid the defect this suite exists to
# catch: `gh` has no `-C` flag, so `gh -C <dir> auth status` exits 1 with
# `unknown shorthand flag: 'C' in -C` (measured, gh 2.89.0), the hook's
# "unauthenticated -> fail open" guard fired unconditionally, and the gate
# scanned nothing while this suite reported 15/15.
#
# A mock more permissive than production does not merely fail to catch a bug --
# it certifies the bug as fixed. Any future stub here must reject what real gh
# rejects.
for a in "$@"; do
  if [[ "$a" == "-C" || "$a" == -C* ]]; then
    echo "unknown shorthand flag: 'C' in -C" >&2
    exit 1
  fi
done
args=("$@")

case "${args[*]}" in
  "auth status") exit 0 ;;
  # Each PR-mode answer is keyed on the value the PREVIOUS call supplies, so a
  # case can only reach a blocking verdict by traversing the whole chain. That
  # is the acceptance bar this suite failed twice before (go-to-k/cdkd#2197):
  # a case whose expectation is reachable WITHOUT a call site fences nothing,
  # and the first attempt's `exit 0` expectation was reachable either way,
  # since a `pr diff` returning no files finds no offending text either.
  "pr view --json number -q .number") echo "${STUB_PR_NUMBER:-}" ;;
  "pr diff "*" --name-only")
    # Only answer for the PR number the previous call handed out.
    if [ -n "${STUB_PR_NUMBER:-}" ] && [ "${args[2]}" = "${STUB_PR_NUMBER}" ]; then
      echo "${STUB_PR_FILES:-}"
    fi
    ;;
  "pr view "*" --json headRefOid -q .headRefOid")
    if [ -n "${STUB_PR_NUMBER:-}" ] && [ "${args[2]}" = "${STUB_PR_NUMBER}" ]; then
      # VERBATIM, with no default: a default here makes both sides of the
      # comparison below fall back to the same value, so breaking this call
      # still serves the offending content and the case cannot fail.
      echo "${STUB_PR_SHA:-}"
    fi
    ;;
  "api repos/{owner}/{repo}/contents/"*)
    # Serve the offending content ONLY at the sha the headRefOid call returns.
    # With that call broken the hook falls back to `?ref=HEAD` (its own
    # `${pr_head_sha:-HEAD}` default) and gets the ASCII body, so the case goes
    # green -- which is what makes it a fence for that call site rather than
    # for the chain in general.
    _ep="${args[1]}"
    case "$_ep" in
      *"?ref=${STUB_EXPECT_SHA:-cafebabe}") printf '%s' "${STUB_PR_CONTENT_B64:-}" ;;
      *) printf '%s' "${STUB_PR_ASCII_B64:-}" ;;
    esac
    ;;
  *) echo "" ;;
esac
EOF
  chmod +x "$out"
  echo "$out"
}

run_hook() {
  local dir="$1"
  local cmd="${2:-gh pr create}"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$dir" \
    '{"tool_input":{"command":$cmd},"cwd":$cwd}')
  printf '%s' "$payload" | GH_BIN="$(make_gh_stub)" bash "$HOOK" >/dev/null 2>&1
}

# PR-MODE runner. The suite drove only 2 of the hook's 5 `gh` call sites for as
# long as `pr view --json number` answered "" -- every case then took the
# LOCAL-DIFF branch and `pr diff`, `headRefOid` and `api ... contents` never
# executed. Those three were rewritten by the fix that made this hook work at
# all (it was inert: `gh` has no `-C` flag), and were verified by hand rather
# than by this suite, which is uncomfortably close to the defect the same fix
# removes.
#
# Every fixture here keeps its LOCAL diff pure ASCII, so a blocking verdict is
# reachable only through the PR chain.
run_hook_pr() {
  local dir="$1" cmd="${2:-gh pr merge 552}"
  local payload
  payload=$(jq -n --arg cmd "$cmd" --arg cwd "$dir" \
    '{"tool_input":{"command":$cmd},"cwd":$cwd}')
  printf '%s' "$payload" | GH_BIN="$(make_gh_stub)" bash "$HOOK" >/dev/null 2>&1
}

PASS=0
FAIL=0
case_label() { printf '  case: %s\n' "$1"; }
ok() { PASS=$((PASS + 1)); printf '    PASS\n'; }
ng() { FAIL=$((FAIL + 1)); printf '    FAIL: expected exit %s, got %s\n' "$1" "$2"; }

# --- Case 1: ASCII-only diff --> pass ---
case_label "ASCII-only diff --> pass"
D="$TMPDIR/case1"; init_repo "$D"
printf '\nNew line.\n' >> "$D/README.md"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 2: hiragana --> block ---
case_label "Hiragana in diff --> block"
D="$TMPDIR/case2"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\223\343\202\223\343\201\253\343\201\241\343\201\257')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 3: katakana --> block ---
case_label "Katakana in diff --> block"
D="$TMPDIR/case3"; init_repo "$D"
printf '\nNote: %s\n' "$(printf '\343\202\271\343\202\261\343\202\270\343\203\245\343\203\274\343\203\253')" > "$D/docs/notes.md"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 4: kanji --> block ---
case_label "Kanji in diff --> block"
D="$TMPDIR/case4"; init_repo "$D"
printf '\n// %s\n' "$(printf '\344\277\235\350\250\274')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 5: hangul --> block ---
case_label "Hangul in diff --> block"
D="$TMPDIR/case5"; init_repo "$D"
printf '\n# %s\n' "$(printf '\354\225\210\353\205\225')" >> "$D/README.md"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 6: CJK punctuation --> block ---
case_label "CJK punctuation in diff --> block"
D="$TMPDIR/case6"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\200\214label\343\200\215')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 7: em-dash + box-drawing + curly quotes --> pass ---
case_label "Em-dash + box-drawing + curly quotes --> pass"
D="$TMPDIR/case7"; init_repo "$D"
cat >> "$D/README.md" <<'EOF'

Em-dash here — followed by "smart quotes" and 'curly apostrophes'.

```
┌─────────────────────────────────────────────┐
│ 1. Layer (src/cli/)                         │ → entry
└─────────────────────────────────────────────┘
```
EOF
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 8: PNG with non-ASCII bytes --> skip ---
case_label "PNG binary --> skip"
D="$TMPDIR/case8"; init_repo "$D"
mkdir -p "$D/docs"
printf '\x89PNG\r\n\x1a\n%s' "$(printf '\343\201\202')" > "$D/docs/image.png"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 9: pnpm-lock.yaml --> skip ---
case_label "pnpm-lock.yaml with hiragana --> skip"
D="$TMPDIR/case9"; init_repo "$D"
printf '# %s\n' "$(printf '\343\201\202')" > "$D/pnpm-lock.yaml"
commit_all "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 10: git commit (not gh pr) --> pass-through ---
case_label "git commit --> pass-through"
D="$TMPDIR/case10"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\202')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D" "git -C $D commit -m test"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 11: gh pr merge <N> --> block ---
case_label "gh pr merge --> block"
D="$TMPDIR/case11"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\202')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D" "gh -C $D pr merge --squash --delete-branch"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 12: gh pr edit --> block ---
case_label "gh pr edit --> block"
D="$TMPDIR/case12"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\202')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D" "gh -C $D pr edit --add-label test"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 13: cd <path> && gh pr create routing --> block ---
case_label "cd <path> && gh pr create routing --> block"
D="$TMPDIR/case13"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\202')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D" "cd $D && gh pr create --fill"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

# --- Case 14: non-git directory --> pass ---
case_label "non-git directory --> pass"
D="$TMPDIR/case14"; mkdir -p "$D"
run_hook "$D"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Case 15: gh missing --> pass (fail-open) ---
case_label "gh missing --> fail-open pass"
D="$TMPDIR/case15"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\202')" >> "$D/src/foo.ts"
commit_all "$D"
# --- PR MODE: exercise the call sites the local-diff branch never reaches ----
# KNOWN COVERAGE GAP, stated rather than left to be discovered.
#
# This suite drives only 2 of the 5 `gh` call sites in the hook. The stub
# returns "" for `pr view --json number`, so every case below takes the
# LOCAL-DIFF branch; `pr diff` (line ~178), `headRefOid` (~212) and
# `api ... | base64 -d` (~226) are never executed. They were rewritten in the
# same change that made this hook work at all, and they were verified BY HAND
# with a PR-mode stub -- not by this suite.
#
# That is uncomfortably close to the defect this suite exists to prevent, so it
# is written down rather than implied. Two attempts to add a PR-mode case are
# recorded because each failed in an instructive way:
#
#   1. A case expecting exit 0 passed whether or not `pr diff` was reached --
#      a call returning no files finds no offending text either. Measured:
#      breaking the `pr diff` call left the suite green. It fenced nothing.
#   2. A case expecting exit 2 on committed hiragana never reached the scan;
#      driving the fixture into the PR branch needs more stub surface than the
#      local-diff helpers here provide.
#
# The lesson from (1) is the general one: for a case to fence a CALL SITE, the
# expectation must be one that is only reachable THROUGH that call site.
#
# Tracked as go-to-k/cdkd#2197.


# Override GH_BIN to a non-existent binary.
payload=$(jq -n --arg cmd "gh -C $D pr create" --arg cwd "$D" \
  '{"tool_input":{"command":$cmd},"cwd":$cwd}')
printf '%s' "$payload" | GH_BIN="/nonexistent/gh" bash "$HOOK" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- Command matching (issue #2129) -----------------------------------------
# The gate must see its verb wherever it sits in the command list, and must NOT
# fire on a quoted MENTION of it. Both directions, or the matcher is untested.
case_label "compound: git push && gh pr create still blocks"
D="$TMPDIR/case_compound"; init_repo "$D"
printf '\n// %s\n' "$(printf '\343\201\223\343\202\223\343\201\253\343\201\241\343\201\257')" >> "$D/src/foo.ts"
commit_all "$D"
run_hook "$D" "git push && gh -C $D pr create"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

case_label "quoted mention of gh pr create does not fire"
run_hook "$D" "echo \"next: gh -C $D pr create\""; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

# --- PR MODE: one case per gh call site (go-to-k/cdkd#2197) ------------------
#
# Everything above takes the LOCAL-DIFF branch, because the stub answered
# `pr view --json number` with "". So `pr diff`, `headRefOid` and
# `api ... contents` -- three of the hook's five gh call sites, all rewritten by
# the fix that made this hook work at all -- executed in no case.
#
# The bar each case has to meet, and the one two earlier attempts missed: its
# expectation must be reachable ONLY THROUGH the call site it fences. So every
# fixture below keeps its LOCAL diff pure ASCII and puts the offending text
# only where the PR chain can find it. A case expecting exit 0 would fence
# nothing here -- a `pr diff` returning no files finds no offending text either.
export STUB_PR_NUMBER=552
export STUB_PR_FILES="src/foo.ts"
export STUB_PR_SHA=cafebabe
export STUB_PR_CONTENT_B64=Ly8g44GT44KM44Gv44OG44K544OI44Gn44GZCg==
export STUB_PR_ASCII_B64=Ly8gcGxhaW4gYXNjaWkgb25seQo=

PRD="$TMPDIR/case_prmode"; init_repo "$PRD"
printf '\n// ascii only, on purpose\n' >> "$PRD/src/foo.ts"
commit_all "$PRD"

case_label "PR mode: offending text reachable only via the PR chain --> blocks"
run_hook_pr "$PRD" "gh pr merge 552"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

case_label "control: the same fixture's LOCAL diff is clean"
# Without this, the case above is satisfied by a hook that ignored the PR
# entirely and scanned the working tree.
STUB_PR_NUMBER='' run_hook_pr "$PRD" "gh pr merge 552"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

case_label "PR mode: pr diff returning no files --> passes"
# Fences `pr diff <N> --name-only`: with no file list there is nothing to
# fetch, so the offending content is unreachable.
STUB_PR_FILES='' run_hook_pr "$PRD" "gh pr merge 552"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

case_label "PR mode: a wrong headRefOid serves the ASCII body --> passes"
# Fences `pr view <N> --json headRefOid`: the stub keys its content on the sha,
# and the hook falls back to `?ref=HEAD` when the call yields nothing.
STUB_PR_SHA='' run_hook_pr "$PRD" "gh pr merge 552"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

case_label "PR mode: empty contents payload --> passes"
# Fences `gh api .../contents/...`: the chain resolves but the body is empty.
STUB_PR_CONTENT_B64='' run_hook_pr "$PRD" "gh pr merge 552"; rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

case_label "PR mode: no number in the command --> resolved from the BRANCH"
# Fences `pr view --json number`, which the cases above cannot reach: they all
# carry an explicit number, so `gate_pr_selector` supplies it and the branch
# lookup never runs. A probe that breaks that call therefore left those cases
# green -- the mutation landed on a line they do not execute, which is a probe
# fault rather than a weak fence, and the fix is a case that HAS to take the
# branch path.
run_hook_pr "$PRD" "gh pr create --title t --body b"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

case_label "PR mode: the number comes from the COMMAND, not the branch"
# go-to-k/cdkd#2206 moved this resolution to `gate_pr_selector`, so the flag
# spellings the old adjacent-token regex read as no number at all must work.
run_hook_pr "$PRD" "gh pr merge --squash 552"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

case_label "PR mode: a flag that eats a number still finds the PR"
run_hook_pr "$PRD" "gh pr merge -t 42 552"; rc=$?
if [[ $rc -eq 2 ]]; then ok; else ng 2 "$rc"; fi

unset STUB_PR_NUMBER STUB_PR_FILES STUB_PR_SHA STUB_PR_CONTENT_B64 STUB_PR_ASCII_B64

echo
printf 'Total: %d pass, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
