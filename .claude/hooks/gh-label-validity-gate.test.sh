#!/usr/bin/env bash
# Smoke test for gh-label-validity-gate.sh.
#
# Written for go-to-k/cdkd#2130's test review: this gate is the ONLY consumer of
# `GATE_RE_GH_LABEL_CARRIER`, a regex the convergence introduced, and it BLOCKS —
# so a wrong-regex or disabled-guard mutation there was undetectable by anything
# in the repo. `gh` is stubbed on PATH, because without it the gate exits 0 on the
# `gh label list` failure and every case would pass vacuously.
#
# Run from the repo root: bash .claude/hooks/gh-label-validity-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-label-validity-gate.sh"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
cat > "$SHIM/gh" <<'GH'
#!/usr/bin/env bash
# `gh label list --json name -q .[].name` is the only call the gate makes.
if [ "${1:-}" = "label" ] && [ "${2:-}" = "list" ]; then
  printf 'bug\nenhancement\n'
  exit 0
fi
exit 0
GH
chmod +x "$SHIM/gh"

pass=0; fail=0; fail_log=""

# run_case <name> <expect_exit> <command>
run_case() {
  local name="$1" want="$2" cmd="$3" got out payload
  payload=$(printf '{"cwd":"%s","tool_input":{"command":"%s"}}' "$PWD" "$cmd")
  out=$(printf '%s' "$payload" | env PATH="$SHIM:$PATH" "$HOOK" 2>&1); got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1)); printf 'OK   %-56s (exit %s)\n' "$name" "$got"
  else
    fail=$((fail + 1))
    printf 'FAIL %s (want %s, got %s)\n' "$name" "$want" "$got"
    fail_log="${fail_log}FAIL ${name}: ${out}"$'\n'
  fi
}

# A missing label blocks — the whole point of the gate.
run_case "unknown label blocks"                 2 'gh issue create --title t --label nope'
run_case "unknown label after a chain blocks"   2 'git push && gh issue create --title t --label nope'
run_case "unknown --add-label blocks"           2 'gh issue edit 1 --add-label nope'
run_case "unknown label in a subshell blocks"   2 '(gh pr create --title t --label nope)'
# Known labels pass.
run_case "known label passes"                   0 'gh issue create --title t --label bug'
run_case "comma list of known labels passes"    0 'gh issue create --title t --label bug,enhancement'
# Not a label-carrying command at all.
run_case "no --label flag passes"               0 'gh pr create --title t --body b'
run_case "gh issue list passes"                 0 'gh issue list --limit 5'
# A quoted MENTION is not an invocation — the shared matcher's job.
run_case "quoted mention passes"                0 'echo "gh issue create --label nope"'

printf '\npass: %s  fail: %s\n' "$pass" "$fail"
if [ "$fail" -gt 0 ]; then printf '%s' "$fail_log"; exit 1; fi
