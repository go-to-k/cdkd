#!/usr/bin/env bash
# gh-body-english-gate — block non-English text in the issue / PR text
# this flow PUBLISHES to GitHub.
#
# Why this exists as a separate gate from non-english-text-gate.sh:
# that hook's subject is the PR DIFF (`gh pr diff <N> --name-only`,
# then a scan of the changed FILES). It therefore cannot see a body or
# a title, which are never files in the repo. The two hooks share only
# the character-class test; their subjects are disjoint.
#
# The gap this closes (issue #1993): CLAUDE.md's English-only rule
# enumerates committed artifacts and then narrows itself with "this
# rule applies only to files that land in the repository". An issue
# body is not a committed file, so it fell OUTSIDE the rule by that
# clause rather than merely being unmentioned -- while `/work-issues`
# and `/hunt-bugs` both FILE issues as a normal step, and those bodies
# are public OSS artifacts exactly like a PR body. Seen live in
# cdk-local: a run filed its follow-up with both halves of the
# `Session-fit` line glossed in the session's chat language, and had to
# patch the body after creation because nothing caught it.
#
# Subject: the text handed to the command, from four shapes --
#   --body-file <p> / --body-file=<p>     (gh pr create / gh issue create)
#   -F body=@<p> / --field body=@<p>      (gh api, file form)
#   --body <text> / -b <text>             (inline)
#   --title <text> / -t <text>            (inline)
# Inline forms ARE scanned here, unlike pr-body-item-number-gate.sh,
# which deliberately leaves inline as its escape hatch. That trade does
# not apply to this rule: there is no legitimate reason to publish
# Japanese in a body, and leaving inline unscanned would leave the
# commonest shape (`gh issue comment -b "..."`) uncovered.
#
# Known limit: text assembled by the shell at run time is invisible to
# a static scan of the command string -- `-b "$(cat jp.txt)"` passes.
# The file and inline-literal forms are what an agent actually emits.
#
# No bypass marker, matching non-english-text-gate.sh: the fix is to
# translate the text, which is trivial and is the point.

set -u

cmd=$(jq -r '.tool_input.command // ""' 2>/dev/null || echo "")

# Only gate gh invocations that PUBLISH text. `gh issue list`,
# `gh pr view`, and a read-only `gh api ... --jq` are untouched.
if ! printf '%s' "$cmd" | grep -qE '\bgh([[:space:]]+-C[[:space:]]+[^[:space:]]+)?[[:space:]]+(pr[[:space:]]+(create|edit)|issue[[:space:]]+(create|comment|edit)|api)\b'; then
  exit 0
fi

# ...and only when a body / title is actually being sent. This keeps
# `gh api repos/{owner}/{repo}/issues/5 --jq .body` (a READ whose flag
# merely names the field) out of scope.
if ! printf '%s' "$cmd" | grep -qE '(--body-file|--body|-b[[:space:]]|--title|-t[[:space:]]|body=@|body=)'; then
  exit 0
fi

# U+3000-303F CJK punctuation, U+3040-309F hiragana, U+30A0-30FF
# katakana, U+4E00-9FFF kanji / Chinese, U+AC00-D7AF hangul.
# Kept character-for-character in sync with non-english-text-gate.sh.
#
# Matched with perl rather than `grep -P` because BSD grep on macOS has
# no PCRE, and ALWAYS with `-CSD` so the input is decoded as UTF-8 --
# without it perl reads the bytes as latin-1 and these ranges never
# match, so the gate silently passes everything it exists to catch.
# That failure is invisible from the passing cases alone: every PASS
# case still passes, which is why the suite drives the BLOCK direction.
NON_ENGLISH_RE='[\x{3000}-\x{303F}\x{3040}-\x{309F}\x{30A0}-\x{30FF}\x{4E00}-\x{9FFF}\x{AC00}-\x{D7AF}]'

declare -a OFFENDERS=()
MAX_REPORT=10

# --- 1. file-borne bodies ---------------------------------------------
while IFS= read -r f; do
  [[ -z "$f" ]] && continue
  [[ -f "$f" ]] || continue
  while IFS= read -r hit; do
    [[ -z "$hit" ]] && continue
    OFFENDERS+=("$f:$hit")
  done < <(perl -CSD -ne "print \"\$.: \$_\" if /$NON_ENGLISH_RE/" "$f" 2>/dev/null | head -"$MAX_REPORT")
done < <(printf '%s' "$cmd" | perl -ne '
    while (/--body-file[=[:space:]]+(["\x27]?)([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
    while (/(?:--field|-F)[[:space:]]+(["\x27]?)body=@([^"\x27[:space:]]+)\1/g) { print "$2\n"; }
  ' 2>/dev/null)

# --- 2. inline bodies and titles --------------------------------------
# Pull the quoted value that follows an inline text flag, then test
# just that value. Scanning the whole command would flag a Japanese
# PATH or an unrelated argument.
while IFS= read -r val; do
  [[ -z "$val" ]] && continue
  matched=$(printf '%s' "$val" | perl -CSD -ne "print 'x' if /$NON_ENGLISH_RE/" 2>/dev/null)
  [[ -z "$matched" ]] && continue
  OFFENDERS+=("inline: $(printf '%s' "$val" | cut -c1-60)")
done < <(printf '%s' "$cmd" | perl -ne '
    # The flag must start at a word boundary that is not itself a dash,
    # so the `-b` alternative cannot match inside `--body`.
    while (/(?:^|\s)(?:--body|--title|-b|-t)[=\s]+"([^"]*)"/g)         { print "$1\n"; }
    while (/(?:^|\s)(?:--body|--title|-b|-t)[=\s]+\x27([^\x27]*)\x27/g) { print "$1\n"; }
    while (/(?:^|\s)(?:--field|-F|-f)\s+(["\x27]?)(?:body|title)=([^"\x27@][^"\x27]*)\1/g) { print "$2\n"; }
  ' 2>/dev/null)

if [[ ${#OFFENDERS[@]} -eq 0 ]]; then
  exit 0
fi

{
  echo "Blocked by gh-body-english-gate:"
  echo
  echo "This command publishes non-English text to GitHub. Issue and PR"
  echo "bodies, titles and comments are public OSS artifacts and must be"
  echo "English, exactly like the files in the repo."
  echo
  echo "Found:"
  for entry in "${OFFENDERS[@]}"; do
    echo "  $entry"
  done
  echo
  echo "(hiragana / katakana / kanji / Chinese / hangul / CJK punctuation)"
  echo
  echo "Fix:"
  echo "  - Translate the body / title to English and re-run."
  echo "  - A Session-fit gloss is text like any other: write"
  echo "    'Session-fit: next (not this session)', not a localized gloss."
  echo "  - Chat with the user stays in whatever language you like; this"
  echo "    gate covers only what gets PUBLISHED."
  echo
  echo "Rule: CLAUDE.md -> Workflow Rules -> English-only"
} >&2
exit 2
