#!/usr/bin/env bash
# Smoke test for pr-body-item-number-gate.sh.
#
# Mirrors branch-gate.test.sh structure: stdin JSON payload + exit
# code is the contract under test. Run from the repo root:
#
#   bash .claude/hooks/pr-body-item-number-gate.test.sh

set -u

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pr-body-item-number-gate.sh"

# Per-run scratch dir; cleaned on EXIT.
TMPDIR_FIX="$(mktemp -d)"
trap 'rm -rf "$TMPDIR_FIX"' EXIT

write_file() {
  local name="$1"
  local content="$2"
  printf '%s' "$content" > "$TMPDIR_FIX/$name"
  echo "$TMPDIR_FIX/$name"
}

pass=0
fail=0
fail_log=""

# run_case <name> <expect_exit> <stdin_json>
run_case() {
  local name="$1"; local want="$2"; local payload="$3"
  local got out
  out=$(printf '%s' "$payload" | "$HOOK" 2>&1) || true
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

# --- Fixture body files ---

# A: bare-number item list (allowed).
A=$(write_file A.md "# Title

Must-fix 1: thing one
Must-fix 2: thing two
review-fix 3: another
")

# B: '#N' item-number patterns (blocked).
B=$(write_file B.md "# Title

Must-fix #1: thing one
review-fix #4: another
")

# C: mixed — has 'closes #234' (allowed) AND 'Must-fix #1' (blocked).
C=$(write_file C.md "# Title

closes #234
Must-fix #1: thing one
")

# D: 'review-fix #4' for the gh api PATCH path.
D=$(write_file D.md "# Title

review-fix #4: a thing
")

# E: blocked content but inside a fenced code block.
E=$(write_file E.md "# Title

Some prose.

\`\`\`
Must-fix #1
review-fix #4
\`\`\`

End of prose.
")

# F: parenthetical (#231) only — squash-merge style — allowed.
F=$(write_file F.md "# Title

Squashed from feat(...): subject (#231)
References: (#232) and closes #233
")

# G: URL containing /pull/4 — should not be flagged.
G=$(write_file G.md "# Title

See https://github.com/owner/repo/pull/4 for context.
And https://github.com/owner/repo/issues/99 too.
")

# H: bare '#N' in prose without an allowed prefix — blocked.
H=$(write_file H.md "# Title

This depends on the change in #4 to land first.
")

# I: code span with #N — should not be flagged.
I=$(write_file I.md "# Title

Use the literal token \`#1\` in your config.
")

# --- ALLOW cases ---

# 1. PR create with bare-number body (A) → exit 0.
run_case "gh pr create with bare-numbers allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --title foo --body-file %s"}}' "$A")"

# 5. PR create with code-block #N (E) → exit 0.
run_case "gh pr create with #N inside code block allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$E")"

# 6. File doesn't exist → exit 0.
run_case "gh pr create with missing body file allowed (silent pass)" 0 \
  '{"tool_input":{"command":"gh pr create --body-file /tmp/does-not-exist-9999"}}'

# 7. Unrelated bash command → exit 0.
run_case "non-gh command allowed" 0 \
  '{"tool_input":{"command":"ls -la"}}'

# 8. Body with parenthetical (#231) only → exit 0.
run_case "gh pr create with parenthetical (#N) allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$F")"

# Extra: URL containing /pull/N → exit 0.
run_case "gh pr create with URL containing /pull/N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$G")"

# Extra: code span `#1` → exit 0.
run_case "gh pr create with code-span #N allowed" 0 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$I")"

# Extra: gh pr create without --body-file (inline --body) → exit 0
# (the hook deliberately does not inspect inline bodies).
run_case "gh pr create with inline --body not inspected" 0 \
  '{"tool_input":{"command":"gh pr create --title foo --body \"Must-fix #1\""}}'

# Extra: gh other subcommand (e.g. gh pr view) → exit 0.
run_case "gh pr view not gated" 0 \
  '{"tool_input":{"command":"gh pr view 123"}}'

# --- BLOCK cases ---

# 2. PR create with #N body (B) → exit 2.
run_case "gh pr create with #N item-numbers blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --title foo --body-file %s"}}' "$B")"

# 3. Mixed body (C): has both allowed `closes #234` and blocked
# `Must-fix #1` → exit 2 (only blocked entry surfaces).
run_case "gh pr create with mixed allowed+blocked → blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$C")"

# 4. gh api -X PATCH with --field "body=@<FILE>" form → exit 2.
run_case "gh api PATCH pulls with --field body=@FILE blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh api -X PATCH repos/owner/repo/pulls/123 --field \\"body=@%s\\""}}' "$D")"

# Extra: gh api PATCH with -F body=@<FILE> short form → exit 2.
run_case "gh api PATCH pulls with -F body=@FILE blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh api -X PATCH repos/owner/repo/pulls/123 -F body=@%s"}}' "$D")"

# Extra: gh issue create with #N body → exit 2.
run_case "gh issue create with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh issue create --title foo --body-file %s"}}' "$B")"

# Extra: gh issue comment with #N body → exit 2.
run_case "gh issue comment with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh issue comment 123 --body-file %s"}}' "$B")"

# Extra: bare '#N' in prose (no item-number prefix, no allow context) → exit 2.
run_case "gh pr create with bare #N in prose blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr create --body-file %s"}}' "$H")"

# Extra: gh pr edit --body-file (deprecated form, but still possible) → exit 2.
run_case "gh pr edit with #N body-file blocked" 2 \
  "$(printf '{"tool_input":{"command":"gh pr edit 123 --body-file %s"}}' "$B")"

echo
echo "Pass: $pass  Fail: $fail"
if [[ "$fail" -gt 0 ]]; then
  echo
  printf '%b' "$fail_log"
  exit 1
fi
