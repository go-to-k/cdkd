#!/usr/bin/env bash
# Smoke tests for gh-body-english-gate.sh
#
# Asserts:
#   - BLOCKS Japanese in a --body-file
#   - BLOCKS Japanese in an inline --body / --title / --notes
#   - does NOT scan the short flags -b / -t / -n (documented limit)
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

# KNOWN LIMIT, asserted rather than implied: short flags are not scanned.
run "known limit: inline -b is NOT scanned" \
  'gh issue comment 5 -b "対応しました"' 0

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

# --- regression cases: every blocker found in review (issue #1993) -----
# Each of these EXITED 0 against the first implementation. They are the
# proof that the fix landed, not a restatement of it.

# A multi-line inline body is the NORMAL inline shape, and `perl -ne`
# could not span the newline -- the headline case was wide open.
run "multi-line inline --body blocks (was open: perl -ne is line-wise)" \
  'gh issue create --title "x" --body "line one
line two 対応しました
line three"' 2

run "multi-line body with japanese only on the last line blocks" \
  'gh issue comment 5 --body "english
english
最後の行"' 2

# CLAUDE.md claims review comments are covered; the verb set omitted them.
run "gh pr comment blocks" 'gh pr comment 5 --body "日本語"' 2
run "gh pr review blocks"  'gh pr review 5 --approve --body "日本語"' 2
run "gh release create --notes blocks" \
  'gh release create v1.0.0 --notes "リリースノート"' 2

# `-f title=` is this repo's own blessed title-edit form (the
# gh-pr-edit-deprecation-gate prescribes it), and it passed.
run "gh api -f title= blocks" \
  'gh api -X PATCH repos/o/r/pulls/5 -f title=タイトル' 2
run "gh api --raw-field body= blocks" \
  'gh api repos/o/r/issues/5/comments --raw-field body=日本語' 2

# Alternate spellings that all passed before.
run "--body-file= equals form blocks" \
  "gh issue create --title x --body-file=$JP_BODY" 2
run "--field body=@ form blocks" \
  "gh api repos/o/r/issues -F body=@$JP_BODY" 2
run "single-quoted inline body blocks" \
  "gh issue comment 5 --body '対応しました'" 2
run "--body= equals form blocks" \
  'gh issue comment 5 --body="対応しました"' 2
run "unquoted inline body blocks" \
  'gh issue comment 5 --body 対応' 2
run "escaped quote inside body does not truncate the scan" \
  'gh issue create --title x --body "he said \"hi\" then 日本語"' 2
run "gh issue edit blocks" 'gh issue edit 5 --body "日本語"' 2
run "gh -C <path> routing blocks" \
  "gh -C /tmp issue create --title x --body-file $JP_BODY" 2
run "chained command still blocks (command-position match)" \
  "echo hi && gh issue create --title x --body-file $JP_BODY" 2

# Relative --body-file resolves against the payload cwd, not the hook's.
REL=$(mktemp -d)
printf 'これは日本語\n' > "$REL/rel-body.md"
relin=$(jq -nc --arg c "gh issue create --title x --body-file rel-body.md" --arg d "$REL" \
  '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')
relrc=0; echo "$relin" | "$HOOK" >/dev/null 2>&1 || relrc=$?
if [[ "$relrc" -eq 2 ]]; then
  echo "PASS: relative --body-file resolves against payload cwd (exit 2)"; PASS=$((PASS+1))
else
  echo "FAIL: relative --body-file resolves against payload cwd (exit $relrc, expected 2)"; FAIL=$((FAIL+1))
fi
rm -rf "$REL"

# --- round-2 review regressions (issue #1993) --------------------------
# `-F <file>` is gh's OWN short form for --body-file / --notes-file, and
# is this repo's preferred shape ("gh body-file over heredoc").
run "-F <file> short form blocks (gh's own --body-file alias)" \
  "gh issue create --title x -F $JP_BODY" 2
run "-F <file> on pr create blocks" \
  "gh pr create --title x -F $JP_BODY" 2
run "-F <file> on issue comment blocks" \
  "gh issue comment 5 -F $JP_BODY" 2
run "-F <file> on release create blocks (--notes-file alias)" \
  "gh release create v1 -F $JP_BODY" 2

# The quote after `=` is the COMMON gh api shape; only the whole-arg
# quoting was matched.
run "gh api -f body=\"...\" (quote after =) blocks" \
  'gh api repos/o/r/issues/5/comments -f body="これはテスト"' 2
run "gh api -f title=\"...\" blocks (the blessed title-edit form)" \
  'gh api -X PATCH repos/o/r/pulls/5 -f title="タイトル"' 2
run "gh api -F body=\"...\" blocks" \
  'gh api repos/o/r/issues -F body="日本語"' 2

# Short flags were absent from the UNQUOTED arm, so `--body x` was
# caught while `-b x` was not.
run "known limit: unquoted -b is NOT scanned" 'gh issue comment 5 -b 対応しました' 0
run "known limit: -t is NOT scanned" 'gh issue create -t バグ修正 --body "english"' 0
run "known limit: -n is NOT scanned" \
  'gh release create v1 -n "リリースノート"' 0

# A `cd` AFTER the verb must not hijack the target dir. VERB_ERE ended in
# `\b`, which grep honours but AWK reads as a backspace -- so the helper's
# stop-at-the-verb guard never fired and the relative body file was looked
# for in the wrong directory.
CDDIR=$(mktemp -d); OTHER=$(mktemp -d)
printf 'これは日本語\n' > "$CDDIR/body.md"
cdin=$(jq -nc --arg c "cd $CDDIR && gh issue create --title x --body-file body.md && cd $OTHER && git pull" --arg d "$OTHER" \
  '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')
cdrc=0; echo "$cdin" | "$HOOK" >/dev/null 2>&1 || cdrc=$?
if [[ "$cdrc" -eq 2 ]]; then
  echo "PASS: a trailing cd does not hijack the body-file lookup (exit 2)"; PASS=$((PASS+1))
else
  echo "FAIL: a trailing cd does not hijack the body-file lookup (exit $cdrc, expected 2)"; FAIL=$((FAIL+1))
fi
rm -rf "$CDDIR" "$OTHER"

# The unquoted gh api field arm ran to the next quote / end of command,
# swallowing later arguments into the "body" and reporting the wrong one.
run "gh api unquoted field does not swallow a later argument" \
  'gh api repos/o/r/issues -f body=ok -f label=日本語' 0
run "gh api unquoted field stops at the command separator" \
  'gh api repos/o/r/issues -f body=ok ; echo done' 0

# --- round-3 review regressions (issue #1993) --------------------------
# `gh -R o/r <verb>` is THE shape section 10-c's cross-repo mirror flow
# uses -- the very flow whose cdk-local incident this hook cites.
run "gh -R <repo> before the verb blocks" \
  'gh -R go-to-k/cdkd issue comment 5 --body "日本語"' 2
run "gh --repo <repo> before the verb blocks" \
  "gh --repo go-to-k/cdkd issue create --title x -F $JP_BODY" 2
run "gh --repo=<repo> before the verb blocks" \
  'gh --repo=go-to-k/cdkd issue create --title x --body "日本語"' 2

# Short flags (-b / -t / -n) are common on OTHER commands, so scanning
# the whole chained command hard-blocked legitimate shapes. These four
# were a REGRESSION introduced by the round-2 fix.
run "chained echo -n with non-English passes" \
  "gh issue create --title x --body-file $EN_BODY && echo -n \"完了\"" 0
run "chained grep -n with non-English passes" \
  "gh issue create --title x --body-file $EN_BODY && grep -n \"日本語\" README.md" 0
run "chained sed -n with non-English passes" \
  "gh issue create --title x --body-file $EN_BODY && sed -n \"/日本語/p\" f" 0
run "chained sort -t with non-English passes" \
  "gh issue create --title x --body-file $EN_BODY && sort -t \"、\" f" 0

# ...but a `&&` INSIDE the body must not end the segment early.
run "a && inside the body does not truncate the scan" \
  'gh issue comment 5 --body "run a && b then 日本語"' 2

# --- round-4 review regressions (issue #1993) --------------------------
# EVERY gh publish invocation must be scanned, not just the first. The
# last case is the three-repo mirror flow itself.
run "second chained gh invocation is scanned" \
  'gh issue create --title x --body "ok" && gh issue comment 5 --body "日本語です"' 2
run "second gh after a semicolon is scanned" \
  'gh issue create --title x --body "ok"; gh pr comment 5 --body "日本語です"' 2
run "second gh after || is scanned" \
  'gh issue create --title x --body "ok" || gh issue create --title x --body "日本語"' 2
run "cross-repo mirror: the SECOND repo's body is scanned" \
  'gh -R go-to-k/cdkd issue create --title x --body "ok" && gh -R go-to-k/cdk-local issue create --title x --body "日本語です"' 2

# A newline and a bare `|` end a command just like `&&`.
run "newline-separated echo -n with non-English passes" \
  'gh issue create --title x --body "ok"
echo -n "日本語"' 0
run "piped grep -n with non-English passes" \
  'gh api repos/o/r/issues --jq ".[].title" | grep -n 日本語' 0

# VERB_ERE and the segment regex must spell the flags identically.
run "gh -R=<repo> equals form blocks" \
  'echo hi && gh -R=o/r issue create --title x --body "日本語"' 2
run "gh -C=<path> equals form blocks" \
  'echo hi && gh -C=/tmp issue create --title x --body "日本語"' 2
run "preceding sort -t with non-English does not false-block" \
  'sort -t 日 f.txt && gh -R=o/r issue create --title x --body ok' 0

# --- round-5 review regressions (issue #1993) --------------------------
# A `\`-continued gh command is a normal shape; treating the newline as a
# separator without honouring the backslash truncated the segment at the
# continuation and left the body unscanned (a round-4 regression).
run "backslash-continued --body is scanned" \
  'gh issue create \
  --title x \
  --body "日本語"' 2
run "backslash-continued -b is scanned" \
  'gh issue create --title x \
  --body "日本語"' 2

# A quoted MENTION of one of these commands in an earlier argument used
# to seed the segment scanner's quote state at the wrong polarity, which
# both hid real bodies and hard-blocked legitimate ones.
run "quoted mention before a real gh does not hide the real body" \
  'echo "gh issue create" && gh issue create --title x --body "A && B 日本語"' 2
run "quoted mention with a pipe in the real body still blocks" \
  'echo "gh issue create" && gh issue create --title x --body "A | B 日本語"' 2
run "quoted mention does not cause a false block on a later echo -n" \
  'echo "gh issue create" && gh issue create --title x --body "ok" && echo -n "日本語"' 0

# --- round-6 regression: the case that stopped the merge ---------------
# An apostrophe in a heredoc body or a `#` comment left the old segment
# scanner's quote state open, so every later invocation was discarded as
# prose. That silently defeated `heredoc -> file -> --body-file`, this
# repo's commonest publishing shape, and was APOSTROPHE-PARITY dependent.
# Deleting the segment scanner (there is no shell parsing left) is what
# fixes it, so this case is the proof that the simplification landed.
APOS="$TMP/apos-en.md"
printf "It's fixed now.\n" > "$APOS"
run "apostrophe in an English body file does not hide a non-English title" \
  "gh pr create --title \"バグ修正\" --body-file $APOS" 2
# An UNBALANCED APOSTROPHE anywhere earlier in the command (`don't` in a
# comment or in prose) makes the shared `strip_noncommand_spans` treat the
# rest of the command as one quoted span, so `cmd_matches_verb` never sees
# the verb and the gate does not arm. It is the apostrophe-parity class
# again, but living in `lib/command-match.sh`, shared by all 16 sourcing
# gates -- NOT something deleting this hook's own scanner could fix.
# Asserted so a change to the shared matcher shows up as these cases
# flipping rather than as silence. The position of the comment is
# irrelevant; the apostrophe is the whole mechanism -- the control below
# proves it.
run "known limit (shared matcher): an unbalanced apostrophe stops the gate arming" \
  "# don't
gh issue create --title y --body \"日本語\"" 0
run "control: the same comment WITHOUT an apostrophe blocks normally" \
  "# file the issue
gh issue create --title y --body \"日本語\"" 2

# --- each Unicode range in ISOLATION ----------------------------------
# Without these, deleting any single range from the character class
# still passed every case.
run "hiragana alone blocks"       'gh issue comment 5 --body "ありがとう"' 2
run "katakana alone blocks"       'gh issue comment 5 --body "テスト"' 2
run "kanji alone blocks"          'gh issue comment 5 --body "修正"' 2
run "hangul alone blocks"         'gh issue comment 5 --body "테스트"' 2
run "CJK punctuation alone blocks" 'gh issue comment 5 --body "hello、world"' 2

# --- quoted-body / heredoc false positives (repo convention cdkd#563) --
# Prose that DESCRIBES one of these commands must not fire the gate;
# commit messages and PR bodies routinely quote the commands they are
# about, which is why the shared matcher strips those spans.
run "quoted prose mentioning the gated command passes" \
  'echo "do not run: gh issue create --body \"日本語\""' 0

run "git commit message quoting the gated command passes" \
  'git commit -m "explain: gh issue comment 5 --body \"日本語\" is blocked"' 0

# --- pass cases that can only pass for the RIGHT reason ----------------
# Both would break if anyone "simplified" the hook to scan the whole
# command string instead of just the published field.
JPDIR=$(mktemp -d)/日本語ディレクトリ
mkdir -p "$JPDIR"
printf 'All English content here.\n' > "$JPDIR/en.md"
run "japanese in the PATH but english body passes" \
  "gh issue create --title x --body-file $JPDIR/en.md" 0
rm -rf "$(dirname "$JPDIR")"

run "japanese outside the published field passes" \
  'gh issue create --title x --body "english body" && echo "完了"' 0

# --- registration ------------------------------------------------------
# The suite invokes $HOOK directly, so unregistering the hook from
# settings.json would otherwise be invisible here.
SETTINGS="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)/.claude/settings.json"
if grep -q 'gh-body-english-gate\.sh' "$SETTINGS" 2>/dev/null; then
  echo "PASS: hook is registered in .claude/settings.json"
  PASS=$((PASS + 1))
else
  echo "FAIL: hook is NOT registered in .claude/settings.json"
  FAIL=$((FAIL + 1))
fi

# --- summary ----------------------------------------------------------
echo
echo "pass: $PASS  fail: $FAIL"
[[ "$FAIL" -eq 0 ]]
