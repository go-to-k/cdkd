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
#   - BLOCKS a QUOTED `--body-file` path CONTAINING A SPACE, and the GLUED
#     short-flag spellings `-F<path>` / `-fbody=<text>`. Both were listed in
#     the HOOK's header as known limits and both were live bypasses of the
#     English-only rule -- measured rc=0 on a Japanese body where the plain
#     spelling gave 2 -- so each has a case here now, paired with an
#     English-body control at the same spelling.
#   - BLOCKS the GLUED `-F<path>` when the command carries only SHORT flags.
#     The pre-existing glued cases all also carried `--title`, which is itself
#     in the ARMING grep, so they armed through `--title` and attested nothing
#     about `-F`; the short-flag spelling gh equally accepts was rc=0.
#   - BLOCKS a body-file path followed by an unquoted `;` / `|` / `&&`. The
#     value class used to swallow the separator, so the path `<file>;` did not
#     exist, nothing was read, and the gate passed.
#   - BLOCKS an ANSI-C `$'...'` body in all three escape families (`\u`, `\x`,
#     octal), and one containing an ESCAPED QUOTE. bash expands these before gh
#     sees them, so they send Japanese; the gate used to read the escape TEXT,
#     which is pure ASCII.
#   - BLOCKS a heredoc rewriting a BACKSLASH-ESCAPED path over a stale English
#     file, with the English-heredoc twin as the polarity control.
#   - FAILS CLOSED when `GATE_PERL_WORD` is present but does not COMPILE.
#
# MUTATION-PROBED rather than asserted, every number RE-taken on the 144-case
# suite. The header carried 129/86/42/32 after the suite had grown to 144 --
# stale tallies read as measured ones, so re-take them whenever a case is added,
# not only when a fence changes:
#
#   always-`exit 0` stub                  fails 95   (nothing passes vacuously)
#   always-`exit 2` stub                  fails 48   (nor blocks vacuously)
#   `$GW` -> the retired class (below)    fails 38
#   `gate_perl_word_ok` -> always true    fails  1   -- the load-guard case
#   short-flag `[=\s]*` -> `[=\s]+`       fails  4   -- the GLUED spellings
#   arming grep back to `-F[[:space:]=]`  fails  2   -- exactly the two
#                                                      short-flag-only glued
#                                                      cases, which is the fence
#                                                      that ARMING is separate
#                                                      from extraction
#   heredoc write-detection -> raw
#     substring compare                   fails  1   -- the backslash-escaped
#                                                      heredoc target
#   ANSI-C arm dropped from `$GW`         fails  1   -- exactly the escaped-quote
#                                                      case, which is why that
#                                                      arm is not redundant with
#                                                      `gate_ansi_c`
#   `gate_ansi_c` decoding neutered       fails  3   -- the three escape families
#
# THE `$GW` REVERT NUMBER DEPENDS ON THE SPELLING, so the spelling is stated
# rather than the intent: the retired class CAPTURED, while call sites now write
# `($GW)`, so any capture inside the prelude shifts `$1` everywhere and three
# faithful-looking reverts give three different tallies. The number above is for
# exactly this backref-free one-line prelude edit:
#
#     my $GW = qr/["\x27]?[^"\x27\s]+["\x27]?/;
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

# bash 3.2 is NOT exercised on the HOOK by running THIS FILE under /bin/bash.
# The hook's shebang is `#!/usr/bin/env bash`, which resolves through PATH and
# finds whatever bash is first there -- Homebrew 5.x on a dev Mac -- so
# `/bin/bash <suite>` measured the SUITE under 3.2 and the SUBJECT under 5.x.
# `HOOK_BASH=/bin/bash` puts a `bash` shim first on PATH, so the shebang, the
# explicit `bash "$HOOK"` calls and any `bash` the hook itself spawns all run
# that interpreter instead. Run the suite BOTH ways; the tallies must match.
if [ -n "${HOOK_BASH:-}" ]; then
  # Resolved to an ABSOLUTE path first. `HOOK_BASH=bash` would otherwise make
  # `ln -sf bash <shim>/bash` a symlink pointing at ITSELF, and every hook
  # invocation would then die on ELOOP -- a suite-wide red with a cause nowhere
  # near the hook.
  HOOK_BASH_BIN="$(command -v "$HOOK_BASH" 2>/dev/null || printf '%s' "$HOOK_BASH")"
  case "$HOOK_BASH_BIN" in /*) ;; *) HOOK_BASH_BIN="$PWD/$HOOK_BASH_BIN" ;; esac
  HOOK_BASH_SHIM="$TMP/bash32-shim"
  mkdir -p "$HOOK_BASH_SHIM"
  ln -sf "$HOOK_BASH_BIN" "$HOOK_BASH_SHIM/bash"
  PATH="$HOOK_BASH_SHIM:$PATH"
  export PATH
fi

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
  'gh issue create --title "x" --body "Session-fit: next (今セッションではやらない)"' 2

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
# comment or in prose) used to leave the shared matcher's quote state open, so
# the rest of the command read as one quoted span, `cmd_matches_verb` never saw
# the verb, and the gate did not arm. It was the apostrophe-parity class living
# in `lib/command-match.sh`, shared by every sourcing gate -- NOT something
# deleting this hook's own scanner could fix, and issue #2093 recorded it
# alongside the subshell gap because it lands in the same place.
#
# FIXED by the #2129 convergence: an unterminated quote makes the segmenter
# re-run treating that character as literal, so the command fails LOUD instead
# of going quiet. Asserted in the blocking direction now, with the control
# below still proving the apostrophe is the whole mechanism.
run "an unbalanced apostrophe no longer stops the gate arming" \
  "# don't
gh issue create --title y --body \"日本語\"" 2
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

# --- go-to-k/cdkd#2397: the body file the command is about to WRITE ----
# The hook runs before the command, so in the one-call
# `heredoc -> file -> --body-file` shape the path is absent (or stale) at hook
# time. The header called that a known limit costing "a missed scan"; these
# cases close it. The fallback reads the HEREDOC BODY rather than the whole
# command, which is what keeps the japanese-in-the-PATH case above passing --
# so that case is now load-bearing rather than incidental.
ABSENT="$TMP/never-written.md"

run "heredoc body with japanese blocks even though the file does not exist yet" \
  "cat > $ABSENT <<EOF
# Title

日本語の本文
EOF
gh issue create --title x --body-file $ABSENT" 2

# The false-BLOCK direction: this is the publishing shape the rules prescribe,
# so an English body written the same way must still pass.
run "heredoc body in english still passes" \
  "cat > $ABSENT <<EOF
# Title

All English content here.
EOF
gh issue create --title x --body-file $ABSENT" 0

# The two halves together: a japanese PATH and an english heredoc body. This
# passes only if the fallback scans the BODY; a whole-command fallback blocks it.
JPDIR2=$(mktemp -d)/日本語ディレクトリ
mkdir -p "$JPDIR2"
run "a japanese path with an english heredoc body still passes" \
  "cat > $JPDIR2/en.md <<EOF
All English content here.
EOF
gh issue create --title x --body-file $JPDIR2/en.md" 0
rm -rf "$(dirname "$JPDIR2")"

# The path EXISTS and holds an ENGLISH body, and the command rewrites it with a
# japanese one. Reading the file alone passes while judging text nobody submits.
STALE="$TMP/stale.md"
printf 'All English content here.\n' > "$STALE"
run "a stale english body file does not excuse a japanese rewrite" \
  "cat > $STALE <<EOF
日本語の本文
EOF
gh issue create --title x --body-file $STALE" 2

# The control that keeps the case above honest: the same file, NOT rewritten.
run "an english body file the command does not rewrite still passes" \
  "gh issue create --title x --body-file $STALE" 0

# `-F` is not gh-unique (`git commit -F`, `awk -F`, `grep -F`, `curl -F`), and
# the header says the file-existence check is what keeps that from false-
# blocking. The fallback must not undo that: an `awk -F ,` names a path that
# will never exist and that the command does not write, so it stays a skip.
run "a non-gh -F value does not arm the fallback" \
  "awk -F , '{print \$1}' /dev/null && gh issue create --title x --body-file $STALE" 0

# --- the `-F ,` case above cannot tell "gate not armed" from "armed, found
# nothing": both answer 0. Its TWIN makes the difference observable -- same
# `awk -F ,` prefix, a JAPANESE body file, and a required BLOCK. A hook that
# bails out of the whole command on an unresolvable `-F` value (a tempting
# "fix" for the false-block worry) passes the case above and fails this one.
run "...and the gate IS armed on that same command, it simply found nothing" \
  "awk -F , '{print \$1}' /dev/null && gh issue create --title x --body-file $JP_BODY" 2

# --- KNOWN LIMIT, both directions: a one-call body written by something other
# than a heredoc redirect. The extraction reads HEREDOC bodies only.
#
#   path ABSENT  -> nothing to read at all, so a non-English body written by
#                   `printf > f` passes. That is the gap; pinning it is what
#                   stops it widening silently.
#   path EXISTS  -> the scan falls back to the FILE, so it still blocks. This
#                   half is the REGRESSION a reviewer measured against the
#                   first draft, which skipped whenever no heredoc body was
#                   found: `printf %s "$B" > f` matched `cmd_rewrites`,
#                   extracted nothing, and returned 0 where the pre-#2397 hook
#                   returned 2 -- a fix that made the gate WEAKER than the code
#                   it replaced.
PRINTF_ABSENT="$TMP/printf-absent.md"
run "known limit: a printf-written body at an ABSENT path is not extracted" \
  "printf '%s\\n' '日本語の本文' > $PRINTF_ABSENT
gh issue create --title x --body-file $PRINTF_ABSENT" 0

run "...but an EXISTING non-English file is still read when printf rewrites it" \
  "printf '%s\\n' 'All English content here.' > $JP_BODY
gh issue create --title x --body-file $JP_BODY" 2

# --- HEREDOC TERMINATOR MATCHING follows bash, not intuition, and both halves
# are load-bearing. A plain `<<` needs the delimiter ALONE on its line, so an
# indented `  EOF` sitting INSIDE the body is body text; a first draft stripped
# all leading whitespace before comparing, ended the extraction there, and left
# everything after it unscanned while bash still submitted it. That is a silent
# miss, the one direction a gate must not fail in.
INDENTED="$TMP/indented-eof.md"
run "an indented EOF inside a plain << body does not end the extraction" \
  "cat > $INDENTED <<EOF
# Title

  EOF

これは日本語
EOF
gh issue create --title x --body-file $INDENTED" 2

# ...and the converse: `<<-` DOES accept a TAB-indented terminator, so the body
# ends there and the non-English text AFTER it is not part of what is being
# published. Without the tab strip the extraction runs to the end of the command
# and swallows that text, blocking a body that is entirely English.
DASHED="$TMP/dashed-eof.md"
run "a tab-indented terminator DOES end a <<- body" \
  "cat > $DASHED <<-EOF
	All English content here.
	EOF
gh issue create --title x --body-file $DASHED && echo '完了'" 0

# --- An APPEND is NOT a rewrite. `>>` / `tee -a` leave what is on disk in
# place: it is the FIRST HALF of the body being submitted, not a superseded
# copy. Scanning the heredoc chunk INSTEAD of the file left the non-English text
# already on disk unread -- rc=0 where both the pre-#2397 hook and the first fix
# answered rc=2, the same "must not SKIP a scan the pre-fix hook performed"
# class a reviewer had already caught once here.
APPEND_JP="$TMP/append-jp.md"
printf '日本語の本文\n' > "$APPEND_JP"
run "an append does not excuse the non-English text already on disk" \
  "cat >> $APPEND_JP <<EOF
All English appended here.
EOF
gh pr create --title x --body-file $APPEND_JP" 2

APPEND_EN="$TMP/append-en.md"
printf 'All English content here.\n' > "$APPEND_EN"
run "a clean append over an english file still passes" \
  "cat >> $APPEND_EN <<EOF
More English appended here.
EOF
gh pr create --title x --body-file $APPEND_EN" 0

# --- EVERY heredoc writing the path is extracted, not just the first.
TWO_CHUNK="$TMP/two-chunk.md"
run "non-English in the SECOND heredoc chunk is still found" \
  "cat > $TWO_CHUNK <<A
All English here.
A
cat >> $TWO_CHUNK <<B
これは日本語
B
gh issue create --title x --body-file $TWO_CHUNK" 2

run "...and two English chunks still pass" \
  "cat > $TWO_CHUNK <<A
All English here.
A
cat >> $TWO_CHUNK <<B
Still English here.
B
gh issue create --title x --body-file $TWO_CHUNK" 0

# --- An EMPTY heredoc body is legal and is not the same thing as "no heredoc".
# Inferring the latter from empty OUTPUT made an empty heredoc REWRITING a
# non-English file fall through to the stale file and FALSE-BLOCK, quoting a
# line that will not exist -- the unclearable block this change exists to end.
EMPTY_OVER_JP="$TMP/empty-over-jp.md"
printf '日本語の本文\n' > "$EMPTY_OVER_JP"
run "an EMPTY heredoc rewriting a non-English file does not false-block" \
  "cat > $EMPTY_OVER_JP <<EOF
EOF
gh issue create --title x --body-file $EMPTY_OVER_JP" 0

# --- The other two widened terminator characters. Only `>f<<EOF` had a case, so
# narrowing the class back to `[\s<]` left the suite green for `>f;` / `>f&&`.
SEMI_ABSENT="$TMP/semi-absent.md"
run "the >f; redirect spelling is still extracted and blocked" \
  "cat <<EOF >$SEMI_ABSENT; gh issue create --title x --body-file $SEMI_ABSENT
これは日本語
EOF" 2

AND_ABSENT="$TMP/and-absent.md"
run "the >f&& redirect spelling is still extracted and blocked" \
  "cat <<EOF >$AND_ABSENT&& gh issue create --title x --body-file $AND_ABSENT
これは日本語
EOF" 2


# --- The path as the command SPELLS it. `f` is normalised to an absolute path
# before `cmd_writes` / `heredoc_bodies_for` are asked about it, and those two
# match their argument against the RAW COMMAND TEXT -- so a body written and
# consumed under a RELATIVE or `~/` spelling matched nothing, `have_body` stayed
# 0, and the `[ -f "$f" ] || continue` guard passed a heredoc body full of
# non-English text in silence. Measured before the fix: the absolute spelling
# rc=2, the relative and `~/` twins rc=0. `pr-body-item-number-gate.sh` does not
# normalise and never had the gap, while both files advertise the two
# extractions as deliberately identical.
RELDIR="$TMP/spelled"
mkdir -p "$RELDIR"
relhd=$(jq -nc --arg c "cd $RELDIR; cat > spelled.md <<EOF
これは日本語
EOF
gh issue create --title x --body-file spelled.md" --arg d "$RELDIR" \
  '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')
relhdrc=0
echo "$relhd" | "$HOOK" >/dev/null 2>&1 || relhdrc=$?
if [[ "$relhdrc" -eq 2 ]]; then
  echo "PASS: a RELATIVE heredoc body path is still extracted and blocked (exit 2)"; PASS=$((PASS+1))
else
  echo "FAIL: a RELATIVE heredoc body path is still extracted and blocked (exit $relhdrc, expected 2)"; FAIL=$((FAIL+1))
fi
# ...and its false-BLOCK direction, so the case above is not satisfied by a
# hook that blocks every relative body file.
relok=$(jq -nc --arg c "cd $RELDIR; cat > ok.md <<EOF
All English content here.
EOF
gh issue create --title x --body-file ok.md" --arg d "$RELDIR" \
  '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')
relokrc=0
echo "$relok" | "$HOOK" >/dev/null 2>&1 || relokrc=$?
if [[ "$relokrc" -eq 0 ]]; then
  echo "PASS: an ENGLISH relative heredoc body still passes (exit 0)"; PASS=$((PASS+1))
else
  echo "FAIL: an ENGLISH relative heredoc body still passes (exit $relokrc, expected 0)"; FAIL=$((FAIL+1))
fi
# The `~/` spelling, with HOME pointed at the sandbox so nothing is written
# outside it. The command is never executed -- the hook sees text -- so the file
# genuinely does not exist and the heredoc body is the only evidence there is.
tildehd=$(jq -nc --arg c "cat > ~/tilde-body.md <<EOF
これは日本語
EOF
gh issue create --title x --body-file ~/tilde-body.md" --arg d "$TMP" \
  '{tool_name:"Bash",cwd:$d,tool_input:{command:$c}}')
tilderc=0
echo "$tildehd" | HOME="$TMP" "$HOOK" >/dev/null 2>&1 || tilderc=$?
if [[ "$tilderc" -eq 2 ]]; then
  echo "PASS: a ~/ heredoc body path is still extracted and blocked (exit 2)"; PASS=$((PASS+1))
else
  echo "FAIL: a ~/ heredoc body path is still extracted and blocked (exit $tilderc, expected 2)"; FAIL=$((FAIL+1))
fi

# --- The TIGHT redirect spelling `>f<<EOF`, with no space before the path. The
# character after the path is `<` rather than whitespace, so a terminator class
# of `(?:\s|$)` alone matched neither `cmd_writes` nor `heredoc_bodies_for` and
# the body went unscanned while the command still submitted it. The twin
# `pr-body-item-number-gate.test.sh` has carried this case since its own review
# and this suite had none, so only that twin could detect the regression.
TIGHT_ABSENT="$TMP/tight-absent.md"
run "the tight >f<<EOF redirect is still extracted and blocked" \
  "cat >$TIGHT_ABSENT<<EOF
これは日本語
EOF
gh issue create --title x --body-file $TIGHT_ABSENT" 2


# ...and the STRIP IS TABS ONLY, which neither this suite nor its twin pinned.
# `<<-` removes leading TABS and nothing else, so a SPACE-indented delimiter is
# still body text; widening the strip to `\s` ends the extraction at that line
# and leaves the rest of the submitted body unscanned. That is the silent-miss
# direction, and the case above does NOT catch it -- its terminator is
# tab-indented, so `\s` strips it just as `\t` does. Measured through the real
# hook with `s/^\t+//` widened to `s/^\s+//`: rc 2 -> rc 0 here and in
# pr-body-item-number-gate, with every other case in both suites still green.
SPACED="$TMP/spaced-eof.md"
run "a SPACE-indented terminator does NOT end a <<- body" \
  "cat > $SPACED <<-EOF
	# Title
    EOF

これは日本語
	EOF
gh issue create --title x --body-file $SPACED" 2

# --- the quoted-value holes (2026-09-05) -------------------------------
# Both were listed in this file's header as KNOWN LIMITS and both were live
# bypasses of the English-only rule, so the limit line was a licence rather
# than a boundary. MOST blocking cases below are rc=0 against the pre-fix hook
# checked out of `origin/main`, with the plain-spelling twin at 2 -- but not
# all, and the blanket claim that used to stand here was wrong. Measured
# against that hook, `trailing |` and `trailing &&` already gave rc=2: the old
# class stopped at the metacharacter for its own reasons, so those two are
# REGRESSION guards, not demonstrations of the hole. They are kept because the
# new grammar has to stop there too, for a different reason.
#
# (A) A quoted `--body-file` path CONTAINING A SPACE. The old value class
# `(["\x27]?)([^"\x27\s]+)\1` could not span the space, so NOTHING was
# extracted, no file was scanned, and a Japanese body reached GitHub.
SPACEDIR="$TMP/dir with space"
mkdir -p "$SPACEDIR"
SP_JP="$SPACEDIR/jp-body.md"
SP_EN="$SPACEDIR/en-body.md"
printf '## Summary\n\nThis is fine.\nSession-fit: next (今回はやらない)\n' > "$SP_JP"
printf '## Summary\n\nAll English content here.\n' > "$SP_EN"
run "spaced --body-file path, double-quoted, blocks" \
  "gh issue create --title x --body-file \"$SP_JP\"" 2
run "spaced --body-file path, single-quoted, blocks" \
  "gh issue create --title x --body-file '$SP_JP'" 2
run "spaced bare -F <path> blocks" \
  "gh issue create --title x -F \"$SP_JP\"" 2
run "spaced -F body=@<path> blocks" \
  "gh api repos/o/r/issues -F \"body=@$SP_JP\"" 2
# The polarity control, and it is the load-bearing one for this gate: an
# ENGLISH body at a spaced path must still pass, or the four blocks above
# would be satisfied by "any spaced path blocks".
run "spaced --body-file path, English body, passes" \
  "gh issue create --title x --body-file \"$SP_EN\"" 0

# (F) The GLUED short-flag spellings gh accepts as readily as the spaced ones.
run "glued -F<path> blocks"                "gh issue create --title x -F$JP_BODY" 2
run "glued -F<path>, English body, passes" "gh issue create --title x -F$SP_EN"   0
run "glued -fbody='...' blocks"            "gh api repos/o/r/issues -fbody='これはテスト'" 2

# (G) ARMING, not extraction. Every `-F` case above also carries `--title`,
# which is itself in the arming grep -- so they armed through `--title` and
# attested nothing about `-F`. Measured on the tip before this: the same
# command with the SHORT `-t` gave rc=0 while the `--title` spelling gave 2,
# because the arming grep required a separator after `-F` and the glued
# spelling has none. gh accepts `-t`, so this is an ordinary command.
run "glued -F<path>, SHORT -t only, blocks (arming, not extraction)" \
  "gh issue create -t x -F$JP_BODY" 2
run "glued -F<path>, SHORT -t only, English body, passes" \
  "gh issue create -t x -F$EN_BODY" 0
run "spaced -F <path>, SHORT -t only, blocks" \
  "gh issue create -t x -F $JP_BODY" 2
run "glued -F<quoted spaced path>, SHORT -t only, blocks" \
  "gh issue create -t x -F\"$SP_JP\"" 2

# (H) The value must STOP at an unquoted shell metacharacter. `$GW`'s bare
# alternative used to include them, so the word swallowed the separator, the
# path `<file>;` did not exist, nothing was read, and the gate passed.
run "trailing ; after a body-file path still blocks" \
  "gh issue create --title x --body-file $JP_BODY; echo done" 2
run "trailing | after a body-file path still blocks" \
  "gh issue create --title x --body-file $JP_BODY | cat" 2
run "trailing && after a body-file path still blocks" \
  "gh issue create --title x --body-file $JP_BODY && echo done" 2

# (I) ANSI-C quoting. bash expands `$'...'` before gh sees it, so these send
# Japanese; the gate used to read the escape TEXT, which is pure ASCII, and
# pass. All three escape families are here because they do not decode the same
# way -- `\u` yields a CHARACTER while `\x` and octal yield BYTES.
run "ANSI-C \$'\\u....' body blocks"   "gh issue create --title x --body \$'\\u65e5\\u672c\\u8a9e'" 2
run "ANSI-C \$'\\xNN' body blocks"     "gh issue create --title x --body \$'\\xe6\\x97\\xa5'" 2
run "ANSI-C \$'\\NNN' octal blocks"    "gh issue create --title x --body \$'\\346\\227\\245'" 2
run "ANSI-C \$'...' ASCII body passes" "gh issue create --title x --body \$'hello\\nworld'" 0
run "ANSI-C \$'...' quoted PATH blocks" \
  "gh issue create --title x --body-file \$'$SP_JP'" 2
# An ESCAPED QUOTE inside `$'...'` is what makes the ANSI-C arm of `$GW`
# load-bearing rather than cosmetic: a backslash escapes there, so the span does
# NOT end at that apostrophe. Without the arm the word stopped at it, the
# Japanese tail was never extracted, and the gate passed a body bash sends as
# `don't 日本語`. The English twin is the control -- it must still pass, or the
# case would be satisfied by a gate that refuses everything with an apostrophe.
run "ANSI-C \$'...' with an escaped quote, japanese, blocks" \
  "gh issue create --title x --body \$'don\'t \\u65e5\\u672c\\u8a9e'" 2
run "ANSI-C \$'...' with an escaped quote, english, passes" \
  "gh issue create --title x --body \$'don\'t ship'" 0

# (J) A backslash-escaped path is one shell WORD, and the write-detection has
# to see it as one too. Without that the heredoc rewrite is invisible, the gate
# reads the STALE file on disk, and a heredoc full of Japanese is submitted
# behind an English file. The English arm is the control: it must NOT block, or
# the case would pass for the wrong reason on a gate that blocks everything.
BSDIR="$TMP/bs dir"
mkdir -p "$BSDIR"
BS_ESC="${BSDIR// /\\ }/body.md"
printf 'All English on disk.\n' > "$BSDIR/body.md"
printf 'Session-fit: next (今回はやらない)\n' > "$BSDIR/jp.md"
run "backslash-escaped heredoc target, japanese heredoc, blocks" \
  "cat > $BS_ESC <<'XEOF'
Session-fit: next (今回はやらない)
XEOF
gh issue create --title x --body-file $BS_ESC" 2
printf 'All English on disk.\n' > "$BSDIR/body.md"
run "backslash-escaped heredoc target, english heredoc, passes" \
  "cat > $BS_ESC <<'XEOF'
All English in the heredoc too.
XEOF
gh issue create --title x --body-file $BS_ESC" 0
printf 'All English on disk.\n' > "$BSDIR/body.md"
run "backslash-escaped path, japanese ON DISK, blocks" \
  "gh issue create --title x --body-file ${BSDIR// /\\ }/jp.md" 2

# (K) The GATE_PERL_WORD load guard, fenced. The cheap `[ -z ]` half cannot see
# a prelude that is present but does not COMPILE, and every extraction runs
# perl with stderr discarded -- so the gate would extract nothing and PASS what
# it exists to refuse. Stage a library whose prelude is non-empty and broken.
BROKEN_LIB_DIR="$TMP/brokenlib"
mkdir -p "$BROKEN_LIB_DIR/lib"
cp "$(dirname "$HOOK")/gh-body-english-gate.sh" "$BROKEN_LIB_DIR/"
sed "s|^  my \$GW = qr/.*|  my \$GW = qr/(((unclosed/;|" \
  "$(dirname "$HOOK")/lib/command-match.sh" > "$BROKEN_LIB_DIR/lib/command-match.sh"
if grep -q 'unclosed' "$BROKEN_LIB_DIR/lib/command-match.sh" \
   && ! grep -q 'my \$GW = qr/(?:' "$BROKEN_LIB_DIR/lib/command-match.sh"; then
  bl_rc=0
  jq -nc --arg c "gh issue create --title x --body-file $EN_BODY" \
    '{tool_name:"Bash",tool_input:{command:$c}}' \
    | "$BROKEN_LIB_DIR/gh-body-english-gate.sh" >/dev/null 2>&1 || bl_rc=$?
  if [ "$bl_rc" = "2" ]; then
    echo "PASS: a non-compiling GATE_PERL_WORD fails CLOSED (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: a non-compiling GATE_PERL_WORD returned $bl_rc, expected 2"
    FAIL=$((FAIL + 1))
  fi
else
  # The staging did not take -- treat that as a failure, not a skip. A probe
  # that silently does not run is the failure mode this whole file is about.
  echo "FAIL: could not stage a broken GATE_PERL_WORD (sed anchor drifted)"
  FAIL=$((FAIL + 1))
fi

# (L) ENCODING. `$'...'` mixes representations -- bash's `\x` and octal emit
# BYTES while `\u` emits a CHARACTER -- and the body scan runs under `-CSD`,
# where the input is already decoded. A literal non-ASCII character next to an
# escape therefore produced a half-character half-byte string, the closing
# decode refused it, and the whole value stayed Latin-1, which the CJK class
# never matches. The carrier is an ordinary accent that is NOT itself blocked,
# so nothing looked wrong. Its own control is the last case.
ACC=$'\xc3\xa9'   # one Latin-1 accent, U+00E9, as UTF-8 bytes
run "ANSI-C literal accent + \\u escapes blocks"  "gh issue create --title x --body \$'$ACC\\u65e5\\u672c\\u8a9e'" 2
run "ANSI-C literal accent + \\x bytes blocks"    "gh issue create --title x --body \$'$ACC\\xe6\\x97\\xa5'" 2
run "ANSI-C literal accent alone passes"          "gh issue create --title x --body \$'$ACC'" 0
# A stray byte must not switch the class test off for the rest of the value.
# All-or-nothing decoding gave rc=0 here; so did decoding per malformed RUN,
# which swallowed the three bytes AFTER the bad one.
run "invalid byte BEFORE japanese still blocks"   "gh issue create --title x --body \$'\\xff\\xe6\\x97\\xa5'" 2
run "invalid byte AFTER japanese still blocks"    "gh issue create --title x --body \$'\\xe6\\x97\\xa5\\xff'" 2
run "invalid byte alone passes"                   "gh issue create --title x --body \$'\\xff'" 0
# bash truncates an octal escape to a byte and takes `\\` as one backslash.
run "ANSI-C \$'a\\\\b' is not blocked"              "gh issue create --title x --body \$'a\\\\b'" 0

# (M) The load guard must not be disable-able from the ENVIRONMENT. The memo is
# an ordinary shell variable, so without a reset at library load
# `__GATE_PW_OK=1` made the probe report a working prelude it never ran.
if grep -q 'unclosed' "$BROKEN_LIB_DIR/lib/command-match.sh" 2>/dev/null; then
  env_rc=0
  jq -nc --arg c "gh issue create --title x --body-file $JP_BODY" \
    '{tool_name:"Bash",tool_input:{command:$c}}' \
    | __GATE_PW_OK=1 "$BROKEN_LIB_DIR/gh-body-english-gate.sh" >/dev/null 2>&1 || env_rc=$?
  if [ "$env_rc" = "2" ]; then
    echo "PASS: __GATE_PW_OK=1 cannot disable the prelude guard (exit 2)"
    PASS=$((PASS + 1))
  else
    echo "FAIL: __GATE_PW_OK=1 disabled the prelude guard (exit $env_rc, expected 2)"
    FAIL=$((FAIL + 1))
  fi
else
  echo "FAIL: broken-library fixture missing for the __GATE_PW_OK case"
  FAIL=$((FAIL + 1))
fi

# (N) MID-WORD `$'...'`. `gate_unq`'s bare-run arm used to eat the `$` sigil
# greedily, so the ANSI-C arm only ever fired at word position 0 -- ONE ascii
# character before it defeated the whole decode, and `gh api -f body=$'...'`
# was bypassed unconditionally, since `body=` is always such a prefix. The two
# controls are what stop the fix from swallowing an ordinary `$`.
run "mid-word ANSI-C \$'\\u....' blocks" \
  "gh issue create --title x --body a\$'\\u65e5\\u672c\\u8a9e'" 2
run "mid-word ANSI-C \$'\\xNN' blocks" \
  "gh issue create --title x --body a\$'\\xe6\\x97\\xa5'" 2
run "gh api -f body=\$'...' blocks" \
  "gh api repos/o/r/issues -f body=\$'\\u65e5\\u672c\\u8a9e'" 2
run "an ordinary \$ in a value still passes (cost \$5)" \
  "gh issue create --title x --body 'cost \$5 total'" 0
run "an unexpanded \$VAR in a value still passes" \
  "gh issue create --title x --body 'hello\$USER'" 0

# (O) BYTE FIDELITY of the path extraction. `gate_unq` is representation-
# uniform: every arm returns the byte string bash would pass, and only the
# `-CSD` class test decodes. Decoding inside `gate_unq` instead turned each raw
# `\xNN` byte into U+FFFD, so a `$'...'` path containing any byte >= 0x80 came
# out wrong and the `[ -f ]` test silently skipped the file. The English twin is
# the control: it must still PASS at the same spelling.
HIDIR="$TMP/hi"
mkdir -p "$HIDIR"
HI_JP="$HIDIR/$(printf '\xc3\xa9').md"
HI_EN="$HIDIR/$(printf '\xc3\xa9')-en.md"
printf 'Session-fit: next (今回はやらない)\n' > "$HI_JP"
printf 'All English here.\n' > "$HI_EN"
run "ANSI-C path with a high byte, japanese body, blocks" \
  "gh issue create --title x --body-file \$'$HIDIR/\\xc3\\xa9.md'" 2
run "ANSI-C path with a high byte, english body, passes" \
  "gh issue create --title x --body-file \$'$HIDIR/\\xc3\\xa9-en.md'" 0

# --- summary ----------------------------------------------------------
echo
echo "pass: $PASS  fail: $FAIL"
[[ "$FAIL" -eq 0 ]]
