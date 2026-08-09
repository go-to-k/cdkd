#!/usr/bin/env bash
# Smoke test for worktree-owner-gate.sh.
#
# Uses a REAL git repo with a REAL linked worktree, because the hook's whole
# discrimination is "linked worktree vs main tree", which only a real
# `git worktree add` produces (`--git-dir` resolving to
# `<common>/worktrees/<name>`).

set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/worktree-owner-gate.sh"
pass=0; fail=0
ok(){ echo "  ok: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
chk(){ [ "$1" = "$2" ] && ok "$3" || no "$3 (rc=$1 want $2)"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
main="$tmp/main"
mkdir -p "$main"
git -C "$main" init -q -b main
git -C "$main" config user.email t@t; git -C "$main" config user.name t
# Repo opt-in signal (issue #1259 convention shared with branch-gate.sh).
touch "$main/.markgate.yml"
echo base > "$main/f.txt"
git -C "$main" add -A; git -C "$main" commit -qm init
wt="$tmp/wt"
git -C "$main" worktree add -q "$wt" -b feat/x >/dev/null 2>&1
WGD=$(git -C "$wt" rev-parse --absolute-git-dir)

pl(){ # $1 session ($2 empty => omit), $2 file path
  python3 -c "
import json,sys
d={'tool_input':{'file_path':sys.argv[2]}, 'cwd':sys.argv[3]}
if sys.argv[1]: d['session_id']=sys.argv[1]
print(json.dumps(d))" "$1" "$2" "$wt"; }

rm -f "$WGD/session-owner"

echo "== claim / re-entry =="
pl sessA "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "first edit allowed"
grep -q sessA "$WGD/session-owner" 2>/dev/null && ok "sentinel records the owner" || no "no sentinel"
pl sessA "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "same session re-edits"

echo "== the incident: a second session =="
pl sessB "$wt/f.txt" | bash "$HOOK" 2>"$tmp/err"; chk $? 2 "foreign session BLOCKED"
grep -q "owned by another session" "$tmp/err" && ok "message names the cause" || no "message unclear"
grep -q "session-owner" "$tmp/err" && ok "message gives the release command" || no "no release command"
grep -q "sessA" "$tmp/err" && ok "message names the owner" || no "owner not named"

echo "== fail-open cases =="
pl "" "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "no session_id => pass"
pl sessB "$main/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "MAIN tree is not gated here"
pl sessB "$tmp/outside.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "path outside any repo => pass"

echo "== non-opted-in repo (no .markgate.yml) =="
# The opt-in marker is resolved from the TARGET's own toplevel, which for a
# linked worktree is the worktree's checkout — not the main tree's. Removing
# it from `$main` alone leaves `$wt/.markgate.yml` in place and the gate
# (correctly) still fires; the first version of this test made exactly that
# mistake and read as a hook bug.
rm -f "$wt/.markgate.yml"
pl sessB "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "repo without .markgate.yml => pass"
git -C "$wt" checkout -q -- .markgate.yml

echo "== stale owner takeover =="
printf 'sessOLD 2020-01-01T00:00:00Z\n' > "$WGD/session-owner"
pl sessB "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "owner past TTL => allowed"
grep -q sessB "$WGD/session-owner" && ok "ownership transferred" || no "ownership not transferred"

echo "== fresh owner is NOT stolen =="
printf 'sessA %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$WGD/session-owner"
pl sessB "$wt/f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 2 "recent owner still blocks"

echo "== explicit bypass =="
CDKD_SKIP_WORKTREE_OWNER_GATE=1 bash -c "printf '%s' '$(pl sessB "$wt/f.txt")' | bash '$HOOK'" >/dev/null 2>&1
chk $? 0 "CDKD_SKIP_WORKTREE_OWNER_GATE=1 bypasses"

echo ""
echo "worktree-owner-gate.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
