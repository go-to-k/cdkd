#!/usr/bin/env bash
# unresolved-target-class.test.sh
#
# A CLASS-LEVEL fence for go-to-k/cdkd#2027, not a per-hook one.
#
# The defect it fences was never about one hook. Twelve gates each carried a
# hand-rolled copy of the same `-C <path>` scan, and every copy captured the raw
# token with no guard for an unexpanded `$VAR`. So the spelling this repo's own
# instructions hand people for worktree commits --
#
#     git -C "$W" add -A && git -C "$W" commit -F <file>
#
# -- resolved to the literal `<cwd>/$W`, failed the gate's own `git -C ...
# rev-parse` probe, and exited 0. The gate was weakest on exactly the path the
# documentation steers everyone onto. A second family (the gates that called the
# library's `gate_target_dir`) did not bail but silently judged the PAYLOAD CWD
# instead, which passes a violation living in the target tree.
#
# Per-hook cases are necessary and live in each gate's own suite. They are not
# sufficient: a hook WRITTEN NEXT MONTH will reintroduce this the moment someone
# copies the scan from a neighbour, and no existing suite would notice. So the
# three fences below take their population from what the hooks DECLARE -- the
# directory listing and the library's exported API -- never from a hand-written
# list, and never from the defect itself (a hook that stops resolving `-C`
# altogether stays in the population and simply passes, rather than dropping out
# of it silently, which is how four earlier fences in this repo went inert).
#
# Run from the repo root: `bash .claude/hooks/unresolved-target-class.test.sh`.

set -u

HOOKS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_GIT="$(command -v git)"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

pass=0
fail=0
fail_log=""
ok()   { pass=$((pass + 1)); printf 'OK   %s\n' "$1"; }
ng()   { fail=$((fail + 1)); fail_log+="FAIL $1\n"; printf 'FAIL %s\n' "$1"; }

# --- the population -----------------------------------------------------------
# Every executable hook in the directory. Not a list in this file: a new hook is
# in scope the moment it lands, which is the entire point.
HOOKS=()
for f in "$HOOKS_DIR"/*.sh; do
  case "$f" in
    *.test.sh|*/run-tests.sh) continue ;;
  esac
  HOOKS+=("$f")
done

# A FLOOR on the population. Without this, a glob that silently matches nothing
# turns every assertion below into a vacuous pass -- the exact way a fence goes
# quiet while still reporting green.
if [ "${#HOOKS[@]}" -ge 25 ]; then
  ok "population: ${#HOOKS[@]} hooks enumerated (floor 25)"
else
  ng "population: only ${#HOOKS[@]} hooks enumerated, expected >= 25 -- the enumeration is broken, every case below is vacuous"
fi

# =============================================================================
# FENCE 1 (static): no hook may hand-roll a `(git|gh) -C <path>` scan.
# =============================================================================
# This is the root cause itself, and the only fence that can stop a hook written
# next month. Resolution belongs to lib/command-match.sh, which is the one place
# the `$`/backtick guard lives.
HANDROLLED_RE='=~[^=]*\((git|gh)\||=~[[:space:]]*(git|gh)\[\[:space:\]\]\+-C'

offenders=""
for h in "${HOOKS[@]}"; do
  if grep -qE '(git|gh)\[\[:space:\]\]\+-C\[\[:space:\]\]\+\(\[\^' "$h"; then
    offenders="$offenders $(basename "$h")"
  fi
done
if [ -z "$offenders" ]; then
  ok "fence 1: no hook hand-rolls a '(git|gh) -C <path>' capture"
else
  ng "fence 1: hand-rolled -C scan in:$offenders -- use gate_target_dir_strict (blocking) or gate_target_dir (detectors) instead"
fi

# GUARD THE GUARD. A grep that matches nothing looks identical to a grep that
# found nothing wrong, so plant a violation and require fence 1 to see it.
planted="$TMPDIR/planted-gate.sh"
cat > "$planted" <<'PLANT'
#!/usr/bin/env bash
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  target_dir="${BASH_REMATCH[1]}"
fi
PLANT
if grep -qE '(git|gh)\[\[:space:\]\]\+-C\[\[:space:\]\]\+\(\[\^' "$planted"; then
  ok "fence 1 guard: the pattern DOES catch a planted hand-rolled scan"
else
  ng "fence 1 guard: the pattern missed a planted hand-rolled scan -- fence 1 is inert"
fi

# =============================================================================
# FENCE 2 (dynamic): no hook may ever hand git an unexpanded path.
# =============================================================================
# Population-wide and fixture-free: every hook is fed the attack payloads, and a
# `git` shim records every `-C <path>` any of them asks for. Whether a given hook
# fires, refuses, or ignores the command does not matter -- what is asserted is
# that no hook ever RESOLVES a target containing a `$` or a backtick. A hook that
# refuses early passes; one that falls back to the payload cwd passes; only one
# that resolved the poisoned token fails.
SHIM="$TMPDIR/bin"; mkdir -p "$SHIM"
TRACE="$TMPDIR/git-c-trace"; : > "$TRACE"
cat > "$SHIM/git" <<SHIM_EOF
#!/usr/bin/env bash
if [ "\$1" = "-C" ]; then printf '%s\n' "\$2" >> "$TRACE"; fi
exec "$REAL_GIT" "\$@"
SHIM_EOF
chmod +x "$SHIM/git"

probe_repo="$TMPDIR/probe-repo"
"$REAL_GIT" init -q -b main "$probe_repo"
"$REAL_GIT" -C "$probe_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$probe_repo/.markgate.yml"

ATTACKS=(
  'git -C "$W" commit -m x'
  'git -C "$W" add -A && git -C "$W" commit -F /tmp/msg'
  'git -C $W push origin HEAD'
  'git -C "${WORKTREE}" switch -c feat/x'
  'git -C "$W" merge origin/main'
  'git -C "$W" checkout -- f.txt'
  'gh -C "$W" pr merge 42 --squash'
  'gh -C "$W" pr create --title x'
  'cd "$W" && git commit -m x'
  'cd "$W" && gh pr merge 42 --squash'
)

for h in "${HOOKS[@]}"; do
  for atk in "${ATTACKS[@]}"; do
    payload=$(printf '{"cwd":"%s","tool_name":"Bash","session_id":"fence","tool_input":{"command":"%s"}}' \
      "$probe_repo" "$(printf '%s' "$atk" | sed 's/\\/\\\\/g; s/"/\\"/g')")
    printf '%s' "$payload" | PATH="$SHIM:$PATH" timeout 30 bash "$h" >/dev/null 2>&1
  done
done

# The shim must have been USED, or this fence proves nothing about anything.
traced=$(wc -l < "$TRACE" | tr -d ' ')
if [ "$traced" -ge 10 ]; then
  ok "fence 2: git -C observed $traced times across the population (floor 10)"
else
  ng "fence 2: only $traced git -C calls observed -- the shim was not exercised, so the assertion below is vacuous"
fi

poisoned=$(grep -c '[$`]' "$TRACE" || true)
if [ "$poisoned" -eq 0 ]; then
  ok "fence 2: no hook resolved a target containing an unexpanded \$ or backtick"
else
  ng "fence 2: $poisoned resolved target(s) still carry an unexpanded token: $(grep '[$`]' "$TRACE" | sort -u | head -5 | tr '\n' ' ')"
fi

# =============================================================================
# FENCE 3 (paired, self-calibrating): a gate that BLOCKS the literal spelling
# must not PASS the variable spelling of the same command.
# =============================================================================
# The pairing is what makes this honest. The literal payload is the control: if
# a hook does not block it, the hook is not gating that verb here and the pair
# is skipped rather than counted. So the fence needs no per-hook knowledge, and
# a hook that stops blocking cannot turn a failure into a silent pass -- it
# turns into a DROP, which the exercised-floor below catches.
MG="$TMPDIR/mgbin"; mkdir -p "$MG"
cat > "$MG/mise" <<'M'
#!/usr/bin/env bash
if [ "$1" = "exec" ] && [ "$2" = "--" ]; then shift 2; exec "$@"; fi
exit 1
M
cat > "$MG/markgate" <<'M'
#!/usr/bin/env bash
case "$1" in
  --version) echo 0.4.1; exit 0 ;;
  verify) exit 1 ;;
  status) printf 'key:        %s\nstate:      stale (digest differs)\n' "$2"; exit 0 ;;
esac
exit 1
M
cat > "$MG/gh" <<'M'
#!/usr/bin/env bash
exit 1
M
chmod +x "$MG"/*

pair_repo="$TMPDIR/pair-repo"
"$REAL_GIT" init -q -b main "$pair_repo"
"$REAL_GIT" -C "$pair_repo" -c user.email=t@t -c user.name=t commit -q --allow-empty -m init
touch "$pair_repo/.markgate.yml"
echo one > "$pair_repo/f.txt"
"$REAL_GIT" -C "$pair_repo" add f.txt
"$REAL_GIT" -C "$pair_repo" -c user.email=t@t -c user.name=t commit -q -m addf
echo two > "$pair_repo/f.txt"

# literal-spelling control | variable-spelling attack
PAIRS=(
  "git -C @R@ commit -m x|git -C \"\$W\" commit -m x"
  "git -C @R@ push origin HEAD|git -C \"\$W\" push origin HEAD"
  "git -C @R@ switch -c feat/x|git -C \"\$W\" switch -c feat/x"
  "git -C @R@ merge origin/main|git -C \"\$W\" merge origin/main"
  "git -C @R@ checkout -- f.txt|git -C \"\$W\" checkout -- f.txt"
  "gh -C @R@ pr merge 42 --squash|gh -C \"\$W\" pr merge 42 --squash"
  "gh -C @R@ pr create --title x|gh -C \"\$W\" pr create --title x"
)

run_hook() { # <hook> <cmd> -> exit code
  local payload
  payload=$(printf '{"cwd":"%s","tool_name":"Bash","session_id":"fence","tool_input":{"command":"%s"}}' \
    "$pair_repo" "$(printf '%s' "$2" | sed 's/\\/\\\\/g; s/"/\\"/g')")
  printf '%s' "$payload" | PATH="$MG:$PATH" timeout 30 bash "$1" >/dev/null 2>&1
  return $?
}

exercised=0
leaks=""
for h in "${HOOKS[@]}"; do
  for pair in "${PAIRS[@]}"; do
    lit="${pair%%|*}"; atk="${pair#*|}"
    lit="${lit//@R@/$pair_repo}"
    run_hook "$h" "$lit"; lit_rc=$?
    [ "$lit_rc" -eq 2 ] || continue      # not gating this verb here: no control, no claim
    exercised=$((exercised + 1))
    run_hook "$h" "$atk"; atk_rc=$?
    if [ "$atk_rc" -eq 0 ]; then
      leaks="$leaks\n  $(basename "$h"): blocks '$lit' but PASSES '$atk'"
    fi
  done
done

if [ "$exercised" -ge 6 ]; then
  ok "fence 3: $exercised literal/variable pairs had a red control (floor 6)"
else
  ng "fence 3: only $exercised pairs had a red control -- the fixture stopped making gates fire, so this fence is nearly vacuous"
fi

if [ -z "$leaks" ]; then
  ok "fence 3: every gate that blocks a literal target also refuses the variable one"
else
  ng "fence 3: gates still fail open on the variable spelling:$(printf '%b' "$leaks")"
fi

echo
echo "Pass: $pass  Fail: $fail"
if [ "$fail" -gt 0 ]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
