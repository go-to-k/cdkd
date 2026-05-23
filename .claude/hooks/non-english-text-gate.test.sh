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
#   gh -C <dir> pr diff <N> --name-only -> N/A here
make_gh_stub() {
  local out="$TMPDIR/gh-stub"
  cat > "$out" <<'EOF'
#!/usr/bin/env bash
# Strip optional `-C <dir>` so we can pattern-match against the
# remaining args.
args=()
i=1
while [[ $i -le $# ]]; do
  if [[ "${!i}" == "-C" ]]; then
    i=$((i + 2))
    continue
  fi
  args+=("${!i}")
  i=$((i + 1))
done

case "${args[*]}" in
  "auth status") exit 0 ;;
  "pr view --json number -q .number") echo "" ;;
  *) echo "" ;;
esac
EOF
  chmod +x "$out"
  echo "$out"
}

run_hook() {
  local dir="$1"
  local cmd="${2:-gh -C $dir pr create}"
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
# Override GH_BIN to a non-existent binary.
payload=$(jq -n --arg cmd "gh -C $D pr create" --arg cwd "$D" \
  '{"tool_input":{"command":$cmd},"cwd":$cwd}')
printf '%s' "$payload" | GH_BIN="/nonexistent/gh" bash "$HOOK" >/dev/null 2>&1
rc=$?
if [[ $rc -eq 0 ]]; then ok; else ng 0 "$rc"; fi

echo
printf 'Total: %d pass, %d fail\n' "$PASS" "$FAIL"
[[ "$FAIL" -eq 0 ]] || exit 1
