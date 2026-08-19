#!/usr/bin/env bash
# Smoke tests for gh-body-english-gate.sh
#
# Asserts:
#   - BLOCKS Japanese in a --body-file
#   - BLOCKS Japanese in an inline --body / -b / --title
#   - BLOCKS Japanese in a gh api -f body= inline field
#   - BLOCKS a localized Session-fit gloss (the shape seen live)
#   - PASSES an all-English body in every one of those shapes
#   - PASSES a READ-shaped `gh api ... --jq .body` (names the field, sends nothing)
#   - PASSES commands outside the gated verb set (issue list / pr view)
#   - PASSES when the body file does not exist (offline / typo tolerance)
#
# NOTE: run this from BESIDE the hook, not from a /tmp copy -- HOOK is
# resolved from ${BASH_SOURCE[0]}, so a copied harness points at a
# subject that does not exist and every case fails for the wrong
# reason (issue #1993, lesson 2).

set -uo pipefail

HOOK="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/gh-body-english-gate.sh"
PASS=0
FAIL=0
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT INT TERM

run() {
  local name="$1" cmd="$2" expect_exit="$3"
  local input exit_code err
  input=$(jq -nc --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}')
  err="$TMP/err.$$"
  echo "$input" | "$HOOK" >/dev/null 2>"$err" && exit_code=0 || exit_code=$?
  if [[ "$exit_code" -eq "$expect_exit" ]]; then
    echo "PASS: $name (exit $exit_code)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: $name (exit $exit_code, expected $expect_exit)"
    sed 's/^/    /' "$err"
    FAIL=$((FAIL + 1))
  fi
}

JP_BODY="$TMP/jp-body.md"
printf '## Summary\n\nThis is fine.\nSession-fit: next (今回はやらない)\n' > "$JP_BODY"
EN_BODY="$TMP/en-body.md"
printf '## Summary\n\nAll English here.\nSession-fit: next (not this session)\n' > "$EN_BODY"

# --- BLOCK cases ------------------------------------------------------
run "japanese in --body-file blocks" \
  "gh issue create --title 'x' --body-file $JP_BODY" 2

run "japanese in inline --body blocks" \
  'gh issue comment 5 --body "対応しました"' 2

run "japanese in inline -b blocks" \
  'gh issue comment 5 -b "対応しました"' 2

run "japanese in --title blocks" \
  'gh issue create --title "バグ修正" --body "english body"' 2

run "japanese in gh api -f body= blocks" \
  'gh api repos/o/r/issues/5/comments -f body=これはテスト' 2

run "localized Session-fit gloss blocks" \
  'gh issue create --title "x" --body "Session-fit: next (今セッションではやらない) / Effort: 30m"' 2

run "japanese in pr create body-file blocks" \
  "gh pr create --title 'x' --body-file $JP_BODY" 2

# --- PASS cases -------------------------------------------------------
run "english --body-file passes" \
  "gh issue create --title 'x' --body-file $EN_BODY" 0

run "english inline --body passes" \
  'gh issue comment 5 --body "Fixed in the latest push."' 0

run "english --title passes" \
  'gh issue create --title "fix(deploy): a real bug" --body "details"' 0

run "read-shaped gh api --jq .body passes" \
  'gh api repos/o/r/issues/1993 --jq .body' 0

run "gh issue list with japanese search passes (not a publish)" \
  'gh issue list --search "日本語"' 0

run "gh pr view passes" \
  'gh pr view 100 --json body -q .body' 0

run "missing body file passes (offline tolerance)" \
  "gh issue create --title 'x' --body-file $TMP/does-not-exist.md" 0

run "non-gh command passes" \
  'echo "日本語"' 0

# --- summary ----------------------------------------------------------
echo
echo "pass: $PASS  fail: $FAIL"
[[ "$FAIL" -eq 0 ]]
