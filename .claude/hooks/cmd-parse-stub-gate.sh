#!/usr/bin/env bash
# cmd-parse-stub-gate.sh
#
# PreToolUse hook. Blocks `git commit` when a staged test file calls
# `cmd.parse([...])` without a nearby `cmd.action(() => {})` stub.
#
# WHY: Commander's `cmd.parse(...)` executes the registered `.action`
# handler. When a test uses `cmd.parse(...)` solely to populate
# `cmd.opts()` and the underlying CLI's `.action(handler)` is real
# code that calls `process.exit(...)` or has uncaught promise
# rejections, Node 24 surfaces the rejection (a regression from
# Node 20's looser handling) and the test process crashes after
# the assertion passes. The fix is to register a no-op
# `cmd.action(() => {})` stub before `cmd.parse(...)` so the test
# never invokes the real handler.
#
# Closes the Node-24-unhandled-rejection trap PR #266 hit retroactively
# in `tests/unit/cli/local-run-task.test.ts`.
#
# Scope:
#   - Only fires on `git commit` (passes through anything else).
#   - Only scans staged `tests/**/*.test.ts` files (the trap is
#     test-side; production code calling `cmd.parse(...)` is intentional).
#   - Skips test files that don't call `cmd.parse(...)` at all
#     (most of them — `cmd.parseAsync(...)` is the common path).
#   - `cmd.parseAsync(...)` does NOT trigger the gate; only the
#     synchronous `cmd.parse(...)` variant has the bug-prone shape.
#
# Heuristic for "is there a nearby stub": look up to ~30 lines above
# each `cmd.parse(...)` for `.action(...)`. Tighter than file-scope
# (per-call locality matters — a test might have one stubbed parse and
# one unstubbed parse) and looser than line-immediate (the stub often
# sits a few helper lines above).
#
# Resolution of "where will the git command actually run" mirrors
# branch-gate.sh / roundtrip-test-gate.sh:
#   1. Explicit `git -C <path> commit` — last `-C` wins.
#   2. Leading `cd <path> && ...` — the cd target.
#   3. The hook input's `cwd` field.
#   4. The hook process's own $PWD.

set -u

input=$(cat 2>/dev/null || true)

cmd=$(printf '%s' "$input" | jq -r '.tool_input.command // ""' 2>/dev/null || echo "")
hook_cwd=$(printf '%s' "$input" | jq -r '.cwd // ""' 2>/dev/null || echo "")

# Only gate git commit — anything else passes through.
if ! printf '%s' "$cmd" | grep -qE '\bgit[^|;&]*\bcommit\b'; then
  exit 0
fi

target_dir="${hook_cwd:-$PWD}"

# Leading `cd <path> && ...` shifts the target dir.
if [[ "$cmd" =~ ^[[:space:]]*cd[[:space:]]+([^[:space:]\&\;\|]+) ]]; then
  cd_target="${BASH_REMATCH[1]}"
  cd_target="${cd_target%\"}"; cd_target="${cd_target#\"}"
  cd_target="${cd_target%\'}"; cd_target="${cd_target#\'}"
  if [[ "$cd_target" != /* ]]; then
    cd_target="$target_dir/$cd_target"
  fi
  target_dir="$cd_target"
fi

# Last `git -C <path>` wins.
if [[ "$cmd" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; then
  c_target=""
  remaining="$cmd"
  while [[ "$remaining" =~ git[[:space:]]+-C[[:space:]]+([^[:space:]]+) ]]; do
    c_target="${BASH_REMATCH[1]}"
    remaining="${remaining#*"${BASH_REMATCH[0]}"}"
  done
  c_target="${c_target%\"}"; c_target="${c_target#\"}"
  c_target="${c_target%\'}"; c_target="${c_target#\'}"
  if [[ "$c_target" != /* ]]; then
    c_target="$target_dir/$c_target"
  fi
  target_dir="$c_target"
fi

# If the resolved target dir is not a git repo, silently pass.
if ! git -C "$target_dir" rev-parse --git-dir >/dev/null 2>&1; then
  exit 0
fi

# List staged (added or modified) files in the index.
staged_files=$(git -C "$target_dir" diff --cached --name-only --diff-filter=AM 2>/dev/null || true)

# Filter to test files. Tests live under `tests/**/*.test.ts`.
test_files=$(printf '%s\n' "$staged_files" | grep -E '^tests/.*\.test\.ts$' || true)

if [[ -z "$test_files" ]]; then
  exit 0
fi

# How many lines above a `cmd.parse(...)` call do we look for the stub.
# 60 covers the common `describe(...) { const cmd = ...; cmd.action(()
# => {}); it(...) { cmd.parse(...); } it(...) { cmd.parse(...); } }`
# shape where a single stub at the top of the suite pairs with several
# parses inside individual `it(...)` blocks below — `local-run-task.test.ts`
# stubs at line 13 and parses at lines 50, 55, 63 (the prototype the
# Node-24 trap was first caught in). Looser than file-scope still: a
# far-away stub that isn't actually paired is unlikely to land here
# because Commander tests group cmd creation + stub + parse close
# together.
LOOKBACK=60

# Bold-red ANSI for the blocking header. Falls back to plain text when
# stderr isn't a TTY.
if [[ -t 2 ]]; then
  RED_BOLD=$'\033[1;31m'
  RESET=$'\033[0m'
else
  RED_BOLD=""
  RESET=""
fi

violations=()

while IFS= read -r test_path; do
  [[ -z "$test_path" ]] && continue

  # Read the staged blob (the version that will be committed) rather
  # than the working-tree copy, so the gate is consistent with what
  # actually lands in the repo.
  blob=$(git -C "$target_dir" show ":$test_path" 2>/dev/null || true)
  if [[ -z "$blob" ]]; then
    if [[ -f "$target_dir/$test_path" ]]; then
      blob=$(cat "$target_dir/$test_path")
    else
      continue
    fi
  fi

  # Find every `cmd.parse(` occurrence (line + line-number).
  # The `cmd\.parse\(` pattern matches `cmd.parse(...)` but NOT
  # `cmd.parseAsync(...)` (the trailing `(` rules out the async
  # variant — `parseAsync` has letters between `parse` and `(`).
  # Comment lines (`//`, `*`, `#` introducers) are filtered out so
  # references inside docstrings like `// cmd.parse([...]) runs ...`
  # don't trigger false positives.
  parse_hits=$(printf '%s\n' "$blob" \
    | grep -nE '\bcmd\.parse\(' \
    | grep -vE '^[0-9]+:[[:space:]]*(\*|/\*|//|#)' \
    || true)

  if [[ -z "$parse_hits" ]]; then
    # No `cmd.parse(...)` in this file → pass-through.
    continue
  fi

  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    # `grep -n` prefixes each match with `<line>:<content>`.
    line_no="${hit%%:*}"

    # Compute the window: [max(1, line_no - LOOKBACK), line_no].
    start=$((line_no - LOOKBACK))
    [[ "$start" -lt 1 ]] && start=1

    # Extract the lookback window via sed and grep for `.action(...)`.
    # We accept any `.action(...)` call (not just `cmd.action`) because
    # tests sometimes alias the Command instance to `program` / `sub` /
    # etc.; the key signal is "an action handler is registered before
    # the parse call", and `.action(` is unambiguous enough.
    window=$(printf '%s\n' "$blob" | sed -n "${start},${line_no}p")
    if ! printf '%s' "$window" | grep -qE '\.action\('; then
      violations+=("$test_path:$line_no")
    fi
  done <<< "$parse_hits"
done <<< "$test_files"

if [[ ${#violations[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo "${RED_BOLD}Blocked by cmd-parse-stub-gate: cmd.parse(...) without a nearby .action() stub.${RESET}"
  echo
  echo "Commander's \`cmd.parse(...)\` executes the registered \`.action\` handler."
  echo "When a unit test uses \`cmd.parse(...)\` to populate \`cmd.opts()\` without"
  echo "first registering a no-op \`.action(() => {})\` stub, Node 24 surfaces"
  echo "any uncaught rejection from the real CLI's action body and the test"
  echo "process crashes after the assertion passes (PR #266 trap)."
  echo
  echo "Fix: register \`cmd.action(() => {})\` before \`cmd.parse(...)\` in:"
  for v in "${violations[@]}"; do
    echo "  - $v"
  done
  echo
  echo "Example:"
  echo "  cmd.action(() => {});           // no-op stub — prevents the real handler"
  echo "  cmd.parse(['node', 'cli', ...], { from: 'user' });"
  echo
  echo "If you genuinely want the real handler to run, use \`cmd.parseAsync(...)\`"
  echo "and \`await\` it so any rejection surfaces as a test failure rather than"
  echo "an unhandled-rejection process crash."
} >&2

exit 2
