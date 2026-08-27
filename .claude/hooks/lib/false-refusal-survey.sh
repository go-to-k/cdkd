#!/usr/bin/env bash
# false-refusal-survey.sh -- MEASURE the trigger's false-refusal surface.
#
# WHY THIS EXISTS (go-to-k/cdkd#2156). Inverting the trigger from narrow to
# over-approximate trades a SILENT class of bypasses for a LOUD class of false
# refusals. That trade is only defensible if the second number is known, and the
# issue's acceptance criterion says so in as many words: measure it against this
# repo's own recent commit messages and PR bodies rather than reasoning about it.
#
# WHAT IT MEASURES. A commit message or a PR body is the text this repo most
# often hands a gated command as an ARGUMENT, and those texts routinely quote
# the very commands they describe -- this file's own commit does. So for each
# corpus text T the survey builds the two shapes an agent actually runs:
#
#   git commit -m "<T>"                      and   gh pr create --title x --body "<T>"
#
# and asks, for EVERY shared verb constant, whether the matcher considers it.
# A cell that is 0 under `origin/main` and 1 here is a command that the widened
# trigger NEWLY considers. For the commit shape the commit constants are
# excluded from the count: those SHOULD fire (it really is a commit), and
# counting them would report the gate working as a regression.
#
# THE NUMBER, so the rules file can point here instead of carrying it.
# Measured 2026-08-27 on the go-to-k/cdkd#2156 branch, `bash
# .claude/hooks/lib/false-refusal-survey.sh` with its defaults:
#
#   corpus            : 400 texts (300 commit messages, 100 PR bodies)
#   probed            : 36000 (text, shape, verb) cells per side
#   NEWLY CONSIDERED  : 0 cells
#   LOST, self verb   : 0 cells
#   LOST, other verb  : 13 cells  (removed false refusals -- see the split below)
#
# THE CELL COUNT IS PART OF THE FIGURE, because this number has now been wrong
# twice by being carried across a change in what was measured. 11,600 was the
# two-shape run; 28,400 the five-shape run that still SKIPPED self verbs; 36,000
# is this one, which emits them. A `0` copied from any of those onto another is
# not a measurement, and both earlier copies were caught in review rather than
# here. Re-run and re-paste all of it, never just the zero.
#
# The non-self count also MOVES WITH THE TRIGGER and is not a quality score: it
# was 27 before review round 5 restored the quote-blind fallback for later
# words, and 13 after, because a wider trigger keeps more prose matching. Lower
# is not worse; the number that must be 0 is the self-verb one above it.
#
# READ THE ZERO CORRECTLY, AND NOT THE WAY THIS COMMENT FIRST DID. The first
# version explained it as "quoted spans are neutralised before the prefix is
# matched". THAT IS FALSE: `neutralise()` rewrites only separator CHARACTERS,
# so a quoted span survives intact and a widened prefix CAN tile through one.
# Review round 1 proved it from both sides -- a reviewer got 2 newly-considered
# cells by re-running with SINGLE-quoted bodies, and the same root cause showed
# up independently as a live false refusal (the quote-close-escape-reopen
# apostrophe idiom reaching GATE_RE_GH_PR_MERGE).
#
# So the zero was a property of the SHAPES this survey asked about, not of the
# trigger. It now asks in five: double-quoted, SINGLE-quoted, and one carrying a
# global flag before the verb -- the last because with no flag at all the prefix
# must be empty and the old and new patterns agree by construction, so a
# flagless corpus cannot exercise the change.
#
# What the zero DOES say, stated so nobody re-derives the wrong reason: over
# this repo's own recent prose, in every shape probed, the widened prefix
# reaches nothing it did not already reach. The surface it adds is UNQUOTED
# argument position (`git -c k=v log --grep commit`), which no commit message or
# PR body produces, and which `origin/main` already had through
# `git --no-pager log --grep commit`.
#
# NOT VACUOUS, checked: feed it a text that breaks out of its own quoting and it
# reports newly-considered cells, so the harness can produce a nonzero.
#
# WHAT THIS SURVEY STRUCTURALLY CANNOT SEE, so its zero is never read as wider
# than it is: every text here lands in ARGUMENT position, never in the FLAG
# PREFIX between the command word and the verb. The regressions of review
# rounds 3, 4 and 5 all lived in that prefix, so a clean run here says nothing
# about them. The fence for that population is the GENERATED grid in
# command-match-differential.test.sh, which crosses apostrophe count x dash-led
# x span position x verb; this survey and that grid cover disjoint halves.
#
# NOT A FENCE, and deliberately not one. It reads git history and (optionally)
# the network, neither of which a test may depend on -- CI shallow-clones, so
# `git show origin/main:...` is not guaranteed to resolve. It prints a count and
# exits; nothing consumes its verdict. The fence for the same code is
# command-match-differential.test.sh, which is hermetic.
#
# Usage, from the repo root:
#   bash .claude/hooks/lib/false-refusal-survey.sh            # 300 commits + 100 PRs
#   bash .claude/hooks/lib/false-refusal-survey.sh 50 0       # 50 commits, no PRs

set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../../.." && pwd)"
N_COMMITS="${1:-300}"
N_PRS="${2:-100}"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

if ! git -C "$ROOT" show "origin/main:.claude/hooks/lib/command-match.sh" > "$TMP/old.sh" 2>/dev/null; then
  echo "cannot read origin/main:.claude/hooks/lib/command-match.sh -- run 'git fetch origin' first" >&2
  exit 1
fi
cp "$HERE/command-match.sh" "$TMP/new.sh"

# --- the corpus --------------------------------------------------------------
# One base64 line per text, so newlines and both quote characters survive.
: > "$TMP/corpus.b64"
git -C "$ROOT" log --format='%H' -n "$N_COMMITS" | while IFS= read -r sha; do
  git -C "$ROOT" log -1 --format='%B' "$sha" | base64 | tr -d '\n'
  echo
done >> "$TMP/corpus.b64"
commit_n=$(grep -c . "$TMP/corpus.b64" | tr -d ' ')

pr_n=0
if [ "$N_PRS" -gt 0 ] && command -v gh >/dev/null 2>&1; then
  if gh -R go-to-k/cdkd pr list --state all --limit "$N_PRS" --json body \
       --jq '.[].body // "" | @base64' > "$TMP/pr.b64" 2>/dev/null; then
    grep -v '^$' "$TMP/pr.b64" >> "$TMP/corpus.b64"
    pr_n=$(grep -c . "$TMP/pr.b64" | tr -d ' ')
  fi
fi

# --- the probe ---------------------------------------------------------------
cat > "$TMP/probe.sh" <<'PROBE'
#!/usr/bin/env bash
set -u
. "$1"
# Every shared verb constant, so a newly considered command is counted whichever
# gate family it reaches.
ALL="GATE_RE_GIT_COMMIT GATE_RE_GIT_PUSH GATE_RE_GIT_COMMIT_OR_PUSH GATE_RE_GIT_MERGE GATE_RE_GIT_SWITCH GATE_RE_GIT_CHECKOUT GATE_RE_GIT_RESTORE GATE_RE_GIT_CHECKOUT_RESTORE GATE_RE_GH_PR_CREATE GATE_RE_GH_PR_EDIT GATE_RE_GH_PR_MERGE GATE_RE_GH_PR_CREATE_OR_MERGE GATE_RE_GH_PR_WRITE GATE_RE_GH_LABEL_CARRIER GATE_RE_GH_API GATE_RE_GH_BODY_CARRIER GATE_RE_GH_ISSUE_CREATE GATE_RE_GH_ISSUE_EDIT"
# The shape's OWN verbs, which are supposed to fire and are not false refusals.
SELF_COMMIT="GATE_RE_GIT_COMMIT GATE_RE_GIT_COMMIT_OR_PUSH"
SELF_PR="GATE_RE_GH_PR_CREATE GATE_RE_GH_PR_CREATE_OR_MERGE GATE_RE_GH_PR_WRITE GATE_RE_GH_LABEL_CARRIER GATE_RE_GH_BODY_CARRIER"
id=0
while IFS= read -r b64; do
  [ -n "$b64" ] || continue
  id=$((id + 1))
  t=$(printf '%s' "$b64" | base64 -d 2>/dev/null || printf '%s' "$b64" | base64 -D 2>/dev/null) || continue
  for shape in commit pr commit_sq pr_sq pr_flagged; do
    case "$shape" in
      commit) cmd="git commit -m \"$t\""; self="$SELF_COMMIT" ;;
      pr)     cmd="gh pr create --title x --body \"$t\""; self="$SELF_PR" ;;
      # SINGLE-quoted twins. The double-quoted shapes alone reported 0/0 and
      # that zero was read as "the trigger does not reach argument prose" --
      # wrong. It is a property of the QUOTING: `neutralise()` only rewrites
      # separator characters, so a quoted span is not blanked, and the widened
      # prefix CAN tile through a single-quoted one. Round 1 found exactly that
      # (the quote-escape-reopen apostrophe idiom), so the survey has to ask in
      # both quotings or its zero measures the shape rather than the trigger.
      commit_sq) cmd="git commit -m '$t'"; self="$SELF_COMMIT" ;;
      pr_sq)     cmd="gh pr create --title x --body '$t'"; self="$SELF_PR" ;;
      # A GLOBAL FLAG before the verb, which is the population the widened
      # prefix actually changed: with no flag the prefix must be empty and the
      # old and new patterns agree by construction.
      pr_flagged) cmd="gh -R go-to-k/cdkd --template 'a b' pr create --title x --body '$t'"; self="$SELF_PR" ;;
    esac
    for c in $ALL; do
      # SELF verbs are emitted too, with a flag, instead of being SKIPPED.
      # Skipping them made the LOST arm structurally blind (review round 2):
      # `SELF_PR` excludes GH_PR_CREATE / _WRITE / _BODY_CARRIER, which are
      # precisely the verbs the `pr_flagged` shape loses, so the survey could
      # not see a loss in the shape it had just been extended to measure. The
      # exclusion is only ever right for NEWLY -- a self verb firing is the gate
      # working -- and never for LOST, where a self verb going quiet is the
      # worst outcome there is.
      is_self=0
      case " $self " in *" $c "*) is_self=1 ;; esac
      eval "re=\${$c}"
      if gate_matches "$cmd" "$re" 2>/dev/null; then m=1; else m=0; fi
      printf '%s\t%s\t%s\t%s\t%s\n' "$id" "$shape" "$c" "$m" "$is_self"
    done
  done
done < "$2"
PROBE

LC_ALL=C bash "$TMP/probe.sh" "$TMP/old.sh" "$TMP/corpus.b64" > "$TMP/old.tsv" 2>/dev/null
LC_ALL=C bash "$TMP/probe.sh" "$TMP/new.sh" "$TMP/corpus.b64" > "$TMP/new.tsv" 2>/dev/null

texts=$(grep -c . "$TMP/corpus.b64" | tr -d ' ')
cells=$(wc -l < "$TMP/new.tsv" | tr -d ' ')
# `grep -c` exits 1 on a count of zero, which under `set -e` would look like a
# tool failure rather than the answer 0. `awk` counts without that hazard.
# Field 5 is the self flag; with two sides pasted the new side starts at 6.
#
# THE LOST ARM IS SPLIT BY SIGN, and that is a correction to the round-2 review
# instruction "do not exclude self verbs from the LOST arm". Including them is
# right; treating the total as "must be 0" is not, because over THIS corpus a
# lost match has OPPOSITE meanings depending on the verb:
#
#   * a SELF verb going quiet means the gate stopped recognising its own
#     command -- `git commit -m '...'` no longer reads as a commit. A bypass,
#     and the number that must be 0.
#   * a NON-SELF verb going quiet means a verb that has no business matching a
#     commit message stopped matching it -- a removed FALSE REFUSAL, i.e. the
#     improvement this work exists to make.
#
# Measured on the 40-text run the reviewer cited: all 14 lost cells were
# NON-self (GIT_CHECKOUT / GIT_SWITCH / GH_ISSUE_CREATE and friends firing on
# `git commit -m '<prose mentioning git checkout>'`), so the pre-2156 trigger
# was refusing them and this one does not. Reporting that as "must be 0" would
# publish a false alarm and, worse, invite someone to "fix" it by restoring the
# false refusals.
newly=$(paste "$TMP/old.tsv" "$TMP/new.tsv" | awk -F'\t' '$5=="0" && $4=="0" && $9=="1"' | tee "$TMP/newly.tsv" | awk 'END{print NR}')
lost=$(paste "$TMP/old.tsv" "$TMP/new.tsv" | awk -F'\t' '$5=="1" && $4=="1" && $9=="0"' | tee "$TMP/lost.tsv" | awk 'END{print NR}')
lostfp=$(paste "$TMP/old.tsv" "$TMP/new.tsv" | awk -F'\t' '$5=="0" && $4=="1" && $9=="0"' | tee "$TMP/lostfp.tsv" | awk 'END{print NR}')
affected=$(awk -F'\t' '{print $1"\t"$2}' "$TMP/newly.tsv" | sort -u | awk 'END{print NR}')

echo "corpus            : $texts texts ($commit_n commit messages, $pr_n PR bodies)"
echo "shapes            : commit / pr (double-quoted), commit_sq / pr_sq (single-quoted), pr_flagged"
echo "probed            : $cells (text, shape, verb) cells per side"
echo "NEWLY CONSIDERED  : $newly cells, across $affected (text, shape) commands"
echo "LOST, self verb   : $lost cells   <- must be 0; the gate stopped seeing its own command"
echo "LOST, other verb  : $lostfp cells   <- removed FALSE REFUSALS; higher is better"
# DETAIL FOR BOTH DIRECTIONS. An earlier version dumped only `newly`, which is
# the LOUD direction; `lost` -- the one that can hide a bypass -- printed a bare
# count. A number with no detail is exactly what let a mispriced loss ship.
if [ "$lost" -gt 0 ]; then
  echo ""
  echo "the LOST SELF cells -- each is a gate that stopped firing on its own command:"
  awk -F'\t' '{print "  text #"$1"  shape="$2"  "$3}' "$TMP/lost.tsv" | head -40
fi
if [ "$lostfp" -gt 0 ]; then
  echo ""
  echo "the LOST non-self cells, by shape and verb (removed false refusals):"
  awk -F'\t' '{print $2"\t"$3}' "$TMP/lostfp.tsv" | sort | uniq -c | sed 's/^/  /' | head -30
fi
if [ "$newly" -gt 0 ]; then
  echo ""
  echo "newly considered, BY SHAPE (the shape is the finding, not the count):"
  awk -F'\t' '{print $2}' "$TMP/newly.tsv" | sort | uniq -c | sed 's/^/  /'
  echo ""
  awk -F'\t' '{print "  text #"$1"  shape="$2"  "$3}' "$TMP/newly.tsv" | head -40
fi
