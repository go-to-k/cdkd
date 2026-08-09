#!/usr/bin/env bash
# Smoke test for restore-backup.sh.
#
# Runs against a REAL throwaway git repo (not fixtures-in-a-string) so the
# snapshot + recovery path is exercised end to end — the whole value of the
# hook is that `git apply` of its output actually restores wiped work, and
# only a real repo proves that.

set -u
HOOK="$(cd "$(dirname "$0")" && pwd)/restore-backup.sh"
pass=0; fail=0
ok(){ echo "  ok: $1"; pass=$((pass+1)); }
no(){ echo "  FAIL: $1"; fail=$((fail+1)); }
chk(){ [ "$1" = "$2" ] && ok "$3" || no "$3 (rc=$1 want $2)"; }

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
repo="$tmp/repo"
mkdir -p "$repo"
git -C "$repo" init -q
git -C "$repo" config user.email t@t; git -C "$repo" config user.name t
# Repo opt-in marker is NOT required by this hook (it protects any repo), but
# create a realistic tree.
echo "base" > "$repo/f.txt"
git -C "$repo" add f.txt; git -C "$repo" commit -qm init

payload(){ python3 -c "
import json,sys
print(json.dumps({'tool_input':{'command':sys.argv[1]},'cwd':sys.argv[2]}))" "$1" "$repo"; }
gd(){ git -C "$repo" rev-parse --absolute-git-dir; }
snapcount(){ ls "$(gd)/wipe-backups" 2>/dev/null | wc -l | tr -d ' '; }

echo "== matching =="
echo "dirty" >> "$repo/f.txt"

payload "git checkout -- f.txt" | bash "$HOOK" >/dev/null 2>&1; chk $? 0 "checkout -- : non-blocking"
[ "$(snapcount)" -ge 1 ] && ok "checkout -- : snapshot taken" || no "checkout -- : no snapshot"

payload "git restore f.txt" | bash "$HOOK" >/dev/null 2>&1
[ "$(snapcount)" -ge 2 ] && ok "restore: snapshot taken" || no "restore: no snapshot"

payload "git reset --hard" | bash "$HOOK" >/dev/null 2>&1
[ "$(snapcount)" -ge 3 ] && ok "reset --hard: snapshot taken" || no "reset --hard: no snapshot"

payload "git stash" | bash "$HOOK" >/dev/null 2>&1
[ "$(snapcount)" -ge 4 ] && ok "stash: snapshot taken" || no "stash: no snapshot"

echo "== NON-matching (must not snapshot) =="
before=$(snapcount)
payload "git checkout -b feat/x" | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "$before" "branch create is not a restore"
payload "git checkout main" | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "$before" "branch switch is not a restore"
payload "git status" | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "$before" "read-only command"
# Quoted-body false positive (cdkd#563 convention).
payload 'gh pr create --body "do not run git checkout -- . in main"' | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "$before" "quoted body does not trigger"
payload 'echo "git reset --hard is dangerous"' | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "$before" "echoed text does not trigger"

echo "== clean tree =="
git -C "$repo" checkout -q -- f.txt
rm -rf "$(gd)/wipe-backups"
payload "git checkout -- f.txt" | bash "$HOOK" >/dev/null 2>&1
chk "$(snapcount)" "0" "nothing uncommitted => no snapshot"

echo "== end-to-end recovery (the point of the hook) =="
printf 'PRECIOUS\n' >> "$repo/f.txt"
payload "git checkout -- f.txt" | bash "$HOOK" >/dev/null 2>&1
git -C "$repo" checkout -- f.txt                      # the destructive command really runs
grep -q PRECIOUS "$repo/f.txt" && no "wipe did not happen (test is meaningless)" || ok "work was wiped"
d=$(ls -dt "$(gd)"/wipe-backups/*checkout | head -1)
git -C "$repo" apply --include=f.txt "$d/tracked.patch" 2>/dev/null
grep -q PRECIOUS "$repo/f.txt" && ok "work RECOVERED from the snapshot" || no "recovery failed"

echo "== git clean also archives untracked =="
git -C "$repo" checkout -q -- f.txt
echo "scratch" > "$repo/untracked.txt"
payload "git clean -fd" | bash "$HOOK" >/dev/null 2>&1
d=$(ls -dt "$(gd)"/wipe-backups/*clean 2>/dev/null | head -1)
[ -n "$d" ] && tar -tf "$d/untracked.tar" 2>/dev/null | grep -q untracked.txt \
  && ok "untracked file archived" || no "untracked file not archived"

echo ""
echo "restore-backup.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
