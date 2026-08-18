#!/usr/bin/env bash
# Smoke test for lib/foreign-repo.sh (issue 1961).
#
# Builds throwaway git repos rather than mocking git: the whole decision is
# what `git rev-parse --git-common-dir` reports for two directories, so a
# mock would be testing the mock. Worktrees are real ones too, because the
# same-repo-across-worktrees case is exactly what a toplevel comparison
# would have got wrong.
#
# Run from the repo root: `bash .claude/hooks/lib/foreign-repo.test.sh`.

set -u

LIB_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

pass=0
fail=0
fail_log=""

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

# --- fixtures -------------------------------------------------------------
# `own` stands in for the repo whose session loaded the hooks; the library
# under test is copied in so its BASH_SOURCE-derived identity is `own`.
mk_repo() { # dir
  mkdir -p "$1/.claude/hooks/lib"
  git -C "$1" init -q -b main 2>/dev/null || { mkdir -p "$1" && git -C "$1" init -q; }
  git -C "$1" config user.email t@t
  git -C "$1" config user.name t
  : > "$1/seed"
  git -C "$1" add -A >/dev/null 2>&1
  git -C "$1" commit -qm init >/dev/null 2>&1
}

mk_counterpart() { # repo_dir, hook_name, exit_code
  cat > "$1/.claude/hooks/$2" <<EOF
#!/usr/bin/env bash
cat > "$TMP/received-payload"
echo "counterpart-ran" > "$TMP/counterpart-ran"
exit $3
EOF
  chmod +x "$1/.claude/hooks/$2"
}

OWN="$TMP/own"; mk_repo "$OWN"
FOREIGN="$TMP/foreign"; mk_repo "$FOREIGN"
cp "$LIB_DIR/foreign-repo.sh" "$OWN/.claude/hooks/lib/foreign-repo.sh"

# A linked worktree of OWN: different toplevel, same common dir.
OWN_WT="$TMP/own-wt"
git -C "$OWN" worktree add -q "$OWN_WT" -b side >/dev/null 2>&1

# A caller that sources the library exactly the way a real gate does.
CALLER="$OWN/.claude/hooks/caller-gate.sh"
cat > "$CALLER" <<'EOF'
#!/usr/bin/env bash
set -u
input=$(cat 2>/dev/null || true)
__fr_dir="${BASH_SOURCE[0]%/*}"
[ "$__fr_dir" = "${BASH_SOURCE[0]}" ] && __fr_dir="."
. "$__fr_dir/lib/foreign-repo.sh"
hook_delegate_if_foreign "$TARGET_DIR" "caller-gate.sh" "$input" || true
echo "own-policy-ran"
exit 7
EOF
chmod +x "$CALLER"

run_caller() { # target_dir  -> prints "<exit>|<stdout>"; stderr to $TMP/err
  local out rc
  rm -f "$TMP/counterpart-ran" "$TMP/received-payload"
  out=$(printf 'PAYLOAD-123' | TARGET_DIR="$1" "$CALLER" 2>"$TMP/err")
  rc=$?
  printf '%s|%s' "$rc" "$out"
}

check() { # name, want, got
  if [ "$2" = "$3" ]; then
    pass=$((pass + 1)); printf 'OK   %s\n' "$1"
  else
    fail=$((fail + 1)); printf 'FAIL %s (want %s, got %s)\n' "$1" "$2" "$3"
    fail_log="${fail_log}FAIL $1: want '$2' got '$3'\n"
  fi
}

# --- same repo: never delegate -------------------------------------------
check "own repo -> own policy runs" "7|own-policy-ran" "$(run_caller "$OWN")"

# The case a toplevel comparison gets wrong: a linked worktree IS the same
# repo, and gate work legitimately runs from `.claude/worktrees/<branch>/`.
check "own repo via a linked worktree -> own policy" "7|own-policy-ran" "$(run_caller "$OWN_WT")"

# --- foreign repo WITHOUT a counterpart: fall back, never silently pass ---
check "foreign, no counterpart -> own policy" "7|own-policy-ran" "$(run_caller "$FOREIGN")"
if grep -q 'no counterpart' "$TMP/err"; then
  pass=$((pass + 1)); printf 'OK   %s\n' "foreign, no counterpart -> says so on stderr"
else
  fail=$((fail + 1)); printf 'FAIL %s\n' "foreign, no counterpart -> says so on stderr"
  fail_log="${fail_log}FAIL stderr note missing; got: $(cat "$TMP/err")\n"
fi

# --- foreign repo WITH a counterpart: delegate ---------------------------
mk_counterpart "$FOREIGN" "caller-gate.sh" 0
check "foreign + counterpart passes -> exit 0, own policy skipped" "0|" "$(run_caller "$FOREIGN")"
check "  counterpart actually ran" "counterpart-ran" "$(cat "$TMP/counterpart-ran" 2>/dev/null)"
check "  payload reached it intact" "PAYLOAD-123" "$(cat "$TMP/received-payload" 2>/dev/null)"

# A blocking verdict must propagate, not be swallowed into our own exit 7.
mk_counterpart "$FOREIGN" "caller-gate.sh" 2
check "foreign + counterpart blocks -> exit 2 propagates" "2|" "$(run_caller "$FOREIGN")"

# --- recursion guard ------------------------------------------------------
out=$(printf 'x' | CDKD_HOOK_DELEGATED=1 TARGET_DIR="$FOREIGN" "$CALLER" 2>/dev/null); rc=$?
check "already delegated -> no second hop, own policy" "7|own-policy-ran" "$rc|$out"

# --- unrunnable counterpart is not a verdict -----------------------------
# Non-executable: we must not read "cannot run" as "passed".
chmod -x "$FOREIGN/.claude/hooks/caller-gate.sh"
check "counterpart not executable -> own policy" "7|own-policy-ran" "$(run_caller "$FOREIGN")"
chmod +x "$FOREIGN/.claude/hooks/caller-gate.sh"

# Bad interpreter (exit 126/127) is likewise not a verdict.
printf '#!/nonexistent/interpreter\n' > "$FOREIGN/.claude/hooks/caller-gate.sh"
chmod +x "$FOREIGN/.claude/hooks/caller-gate.sh"
check "counterpart unrunnable (bad interpreter) -> own policy" "7|own-policy-ran" "$(run_caller "$FOREIGN")"

# --- target is not a git repo at all --------------------------------------
mkdir -p "$TMP/plain"
check "target not a repo -> own policy" "7|own-policy-ran" "$(run_caller "$TMP/plain")"
check "target does not exist -> own policy" "7|own-policy-ran" "$(run_caller "$TMP/no-such-dir")"

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
