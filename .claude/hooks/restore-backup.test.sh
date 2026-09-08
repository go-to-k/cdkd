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

echo "== a lagging library: SKIP with a note, never a refusal (go-to-k/cdkd#2729) =="
#
# This hook is the only member of the non-blocking half of the constant-liveness
# partition that HAS a suite of its own -- the three detectors beside it in that
# partition do not -- so it is the one place the `gate_require_const_soft` path
# can be asserted where the reader of a non-blocking hook will look. The class
# fence that would cover it too is split out into go-to-k/cdkd#2826, so for
# now these cases are the ONLY coverage -- and a property this hook's own
# header states -- "fail OPEN and SILENT on anything unexpected. A backup helper
# that blocks the user's command when the snapshot fails would be worse than no
# helper at all" -- should have a case in this hook's own suite. Refusing here
# would BLOCK `git reset --hard` / `git clean -f` / `git stash`, which no other
# gate covers.
lagging="$tmp/lagging"
mkdir -p "$lagging/lib"
cp "$HOOK" "$lagging/restore-backup.sh"
# A single-LINE delete, which is sound for THIS constant and not in general:
# `GATE_FLAGS=` is one line, so the span ends where the line does. The class
# fence needs a real quote SCAN because it strips every constant including
# multi-line ones like `GATE_PERL_WORD`, where counting lines takes neighbours
# with it. The `grep -q` below is the guard that this delete actually landed.
grep -v '^GATE_FLAGS=' "$(dirname "$HOOK")/lib/command-match.sh" > "$lagging/lib/command-match.sh"
if grep -q '^GATE_FLAGS=' "$lagging/lib/command-match.sh"; then
  no "could not stage a library without GATE_FLAGS (anchor drifted)"
else
  printf 'PRECIOUS\n' >> "$repo/f.txt"
  # Payload via a FILE, not a pipe. This hook exits 0 at the constant guard
  # before it reads stdin, so a pipe leaves `payload`'s python writing into a
  # closed descriptor and the suite prints a BrokenPipeError that looks like a
  # failure and is not. Every other case here reaches the read.
  payload "git checkout -- f.txt" > "$lagging/payload.json"
  out=$(bash "$lagging/restore-backup.sh" < "$lagging/payload.json" 2>&1); rc=$?
  [ "$rc" -eq 0 ] && ok "a lagging library SKIPS (exit 0), it does not refuse" \
    || no "a lagging library exited $rc; this hook must never block [$out]"
  # The needle is the HELPER'S message plus the name, not the name alone.
  # bash's own `set -u` diagnostic -- `command-match.sh: line N: GATE_FLAGS:
  # unbound variable` -- contains the name too, so a name-only assertion passes
  # with this hook's guard DELETED. Measured: guard removed, rc=1 for
  # `GATE_FLAGS` and rc=0 for `GATE_SEP_AMP`, and a name-only check said PASS
  # both times. `does not define` is emitted by `gate_require_const_soft` and by
  # nothing bash prints.
  printf '%s' "$out" | grep -q 'does not define' \
    && printf '%s' "$out" | grep -q 'GATE_FLAGS' \
    && ok "the skip REPORTS the missing constant (helper's own message, not bash's)" \
    || no "the skip said nothing the hook itself emitted [$out]"
  # And the refusal wording must NOT leak in from the blocking sibling.
  printf '%s' "$out" | grep -q 'Blocked' \
    && no "a NON-BLOCKING hook printed a 'Blocked' message [$out]" \
    || ok "the note does not claim to have blocked anything"
  git -C "$repo" checkout -q -- f.txt
fi

echo ""
echo "restore-backup.test: $pass passed, $fail failed"
[ "$fail" -eq 0 ]
