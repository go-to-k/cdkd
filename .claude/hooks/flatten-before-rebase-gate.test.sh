#!/usr/bin/env bash
# Smoke suite for flatten-before-rebase-gate.sh.
#
# The subject SHELLS OUT to git, so every case needs a real repository:
# a fixture with N commits on a branch, some of which touch an
# append-shaped generated file. Fixtures are built once and reused.
#
# `pwd -P` on the sandbox is load-bearing. macOS spells `mktemp -d` under
# /var while git canonicalises to /private/var, and a case whose subject
# is a path would then pass unconditionally.

set -u

HOOK_DIR="${BASH_SOURCE[0]%/*}"
[ "$HOOK_DIR" = "${BASH_SOURCE[0]}" ] && HOOK_DIR="."
HOOK_DIR=$(cd "$HOOK_DIR" && pwd -P)
HOOK="$HOOK_DIR/flatten-before-rebase-gate.sh"
# Follow the harness shell. `run-tests.sh` exports HOOK_BASH so the SUBJECT is
# exercised under macOS system bash 3.2 too; without honouring it the hook is
# `#!/usr/bin/env bash` and resolves the 5.x on PATH whatever ran the suite.
HOOK_BASH="${HOOK_BASH:-bash}"

pass=0
fail=0

SANDBOX=$(cd "$(mktemp -d)" && pwd -P)
cleanup() { rm -rf "$SANDBOX"; }
trap cleanup EXIT
NO_TREE="$SANDBOX/not-a-work-tree"
mkdir -p "$NO_TREE"

# mkrepo <name> <n-extra-commits> <file-touched-by-the-extra-commits>
# Leaves `main` at the base commit and the checkout on `lane`.
mkrepo() {
  local name="$1" n="$2" file="$3" d="$SANDBOX/$1" i
  mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" config user.email t@example.com
  git -C "$d" config user.name t
  mkdir -p "$d/docs/_generated"
  echo base > "$d/README.md"
  git -C "$d" add -A
  git -C "$d" commit -qm base
  git -C "$d" switch -q -c lane
  for i in $(seq 1 "$n"); do
    mkdir -p "$d/$(dirname "$file")"
    echo "entry $i" >> "$d/$file"
    git -C "$d" add -A
    git -C "$d" commit -qm "lane $i"
  done
  printf '%s' "$d"
}

# run <expected-rc> <label> <command-string> [cwd]
#
# The `cwd` field is NOT optional decoration. The hook falls back to it when a
# segment names no tree, and `run-tests.sh` cds to the REPO ROOT -- so a suite
# that omits it silently judges whatever state this checkout happens to be in.
# Measured while reviewing: with the repo root itself a 2-commit lane touching
# `docs/changelog-cdkd.md`, the `-C`-without-a-space case flipped rc=0 -> rc=2
# and the suite self-red. Every case now pins its own cwd; NO_TREE is a
# directory that is deliberately not a work tree.
run() {
  local want="$1" label="$2" cmd="$3" cwd="${4:-$NO_TREE}" got
  printf '%s' "{\"cwd\":$(printf '%s' "$cwd" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' "$cmd" | jq -Rs .)}}" \
    | "$HOOK_BASH" "$HOOK" >/dev/null 2>&1
  got=$?
  if [ "$got" = "$want" ]; then
    pass=$((pass + 1))
  else
    fail=$((fail + 1))
    echo "FAIL: $label (want rc=$want, got rc=$got)"
  fi
}

TWO_CHANGELOG=$(mkrepo two-changelog 2 docs/changelog-cdkd.md)
FOUR_CHANGELOG=$(mkrepo four-changelog 4 docs/changelog-cdkd.md)
ONE_CHANGELOG=$(mkrepo one-changelog 1 docs/changelog-cdkd.md)
TWO_LEDGER=$(mkrepo two-ledger 2 docs/_generated/integ-last-run.tsv)
TWO_SRC=$(mkrepo two-src 2 src/thing.ts)

# --- BLOCK: the measured shape -- unflattened branch, append-shaped file ---
run 2 'two commits touching the changelog' "git -C $TWO_CHANGELOG rebase main"
run 2 'four commits touching the changelog' "git -C $FOUR_CHANGELOG rebase main"
run 2 'the integ ledger is append-shaped too' "git -C $TWO_LEDGER rebase main"
run 2 'after another command' "git fetch origin && git -C $TWO_CHANGELOG rebase main"
run 2 'with a leading cd' "cd /tmp && git -C $TWO_CHANGELOG rebase main"
# KNOWN LIMITATION, pinned rather than left silent: the shared
# `gate_leading_c_value` reads `-C <path>` and not git's equally valid
# `-C<path>`, so that spelling resolves to the payload cwd instead. Every gate
# on the shared matcher inherits it (go-to-k/cdkd#2455). Here the consequence is
# a pass-through, which is this gate's stated failure direction; for the
# BLOCKING gates it is a wrong-tree verdict, which is why it is filed.
# The cwd is pinned to a tree that does NOT fire, and the `-C` names one that
# WOULD. So rc=0 can only mean the hook fell back to the cwd, i.e. the `-C`
# value went unread -- which is the claim. Pinning the cwd to a FIRING tree
# instead would give rc=2 whether or not the value was read, i.e. vacuous. Left
# ambient (no cwd at all), it passed for whatever state the repo root was in.
run 0 'KNOWN: -C without a space is not read (go-to-k/cdkd#2455)' "git -C$TWO_CHANGELOG rebase main" "$TWO_SRC"
run 2 'no -C, resolved from the cd' "cd $TWO_CHANGELOG && git rebase main"
run 2 'no -C and no cd, resolved from the payload cwd' "git rebase main" "$TWO_CHANGELOG"
run 2 'a double-quoted -C value' "git -C \"$TWO_CHANGELOG\" rebase main"
run 2 "a single-quoted -C value" "git -C '$TWO_CHANGELOG' rebase main"

# --- PASS: already flat ---
run 0 'a single commit needs no flattening' "git -C $ONE_CHANGELOG rebase main"

# --- PASS: cannot hit the measured conflict ---
run 0 'two commits, no append-shaped file' "git -C $TWO_SRC rebase main"

# --- PASS: never block the way OUT of a rebase ---
# These take no upstream, so a gate keyed on the upstream cannot reach them --
# but the failure would be catastrophic (a wedged rebase with no exit), so each
# spelling is pinned rather than argued.
run 0 'rebase --continue' "git -C $TWO_CHANGELOG rebase --continue"
run 0 'rebase --abort' "git -C $TWO_CHANGELOG rebase --abort"
run 0 'rebase --skip' "git -C $TWO_CHANGELOG rebase --skip"
run 0 'rebase --quit' "git -C $TWO_CHANGELOG rebase --quit"
run 0 'rebase --edit-todo' "git -C $TWO_CHANGELOG rebase --edit-todo"
run 0 'bare rebase, no upstream' "git -C $TWO_CHANGELOG rebase"

# --- PASS: deliberate history operations ---
run 0 '--onto is a deliberate history rewrite' "git -C $TWO_CHANGELOG rebase --onto main main lane"

# --- PASS: not this command ---
# The first four are the false-BLOCK class a review round found in the first
# cut: `GATE_FLAGS` let any words sit between `git` and the verb, so a
# read-only query MENTIONING rebase was refused with `reset --soft` advice.
run 0 'a different git subcommand' "git -C $TWO_CHANGELOG merge main"
run 0 'log --grep rebase is a READ, not a rebase' "git -C $TWO_CHANGELOG log --grep rebase main"
run 0 'log with more flags before the needle' "git -C $TWO_CHANGELOG log --oneline --grep rebase main"
run 0 'config naming a rebase key' "git -C $TWO_CHANGELOG config pull.rebase main"
run 0 'pull --rebase is not the gated verb' "git -C $TWO_CHANGELOG pull --rebase main"
run 0 'not git at all' "vp run build"

# --- PASS: argument shapes the gate deliberately declines to judge ---
# Enumerating value-taking flags loses to the next unlisted one, so anything
# outside `rebase [valueless-flags] <one-bare-token>` stands the gate down.
run 0 'a value-taking flag could hide the upstream (--exec)' "git -C $TWO_CHANGELOG rebase --exec 'make test' main"
run 0 'a value-taking flag could hide the upstream (-X)' "git -C $TWO_CHANGELOG rebase -X ours main"
run 0 'a value-taking flag could hide the upstream (--strategy)' "git -C $TWO_CHANGELOG rebase --strategy recursive main"
run 0 '--root takes no upstream' "git -C $TWO_CHANGELOG rebase --root"
run 0 'interactive is a deliberate history rewrite' "git -C $TWO_CHANGELOG rebase -i main"
run 0 'the 3-arg form names a branch that is not HEAD' "git -C $TWO_CHANGELOG rebase main lane"
run 0 'an unexpanded upstream is not a ref we can resolve' "git -C $TWO_CHANGELOG rebase \$UPSTREAM"
# ...and that case alone does NOT fence the guard: an unresolvable ref also
# fails `merge-base`, so the hook stands down either way. A branch REALLY NAMED
# `up$ref` resolves, so only the guard can stand the gate down -- measured,
# deleting the guard flips this one to rc=2 while the case above stays green.
git -C "$TWO_CHANGELOG" branch 'up$ref' main >/dev/null 2>&1
run 0 'a REAL ref containing $ still stands the gate down' "git -C $TWO_CHANGELOG rebase up\$ref"
# Flags may FOLLOW the positional, and that order is what makes the
# unknown-flag stand-down load-bearing: with the flag first the loop breaks
# before any bare token is seen, so the one-bare-token rule alone would cover
# it. Measured -- without this case, deleting the `unknown` guard reddened
# nothing.
run 0 'a value-taking flag AFTER the upstream' "git -C $TWO_CHANGELOG rebase main --exec 'make test'"

# --- BLOCK: valueless flags do NOT stand the gate down ---
run 2 'a valueless flag before the upstream' "git -C $TWO_CHANGELOG rebase --autostash main"
run 2 'two valueless flags' "git -C $TWO_CHANGELOG rebase -q --no-ff main"
run 2 'the upstream double-quoted' "git -C $TWO_CHANGELOG rebase \"main\""
run 2 'the upstream single-quoted' "git -C $TWO_CHANGELOG rebase 'main'"

# --- PASS: quoted mentions must not arm the gate ---
run 0 'quoted in a gh body' "gh issue create --body \"flatten before git rebase origin/main\""
run 0 'quoted in a commit message' "git commit -m \"docs: say why git rebase main re-conflicts\""

# --- PASS: an UNREADABLE target dir stands the gate down ---
# Load-bearing, not theoretical: with the guard removed, `git -C ""` resolves to
# the HOOK PROCESS's cwd, so the gate would judge an ambient tree and refuse.
# Measured -- deleting the empty-dir guard flips this case rc=0 -> rc=2.
run 0 'an unexpanded -C value is not a tree we can resolve' 'git -C "$WT" rebase main' "$TWO_CHANGELOG"
run 0 'an unexpanded cd target is not one either' 'cd "$WT" && git rebase main' "$TWO_CHANGELOG"
# The two above do NOT fence the guard on their own: with it removed, `git -C ""`
# falls back to the HOOK PROCESS's cwd, which under the harness is this repo --
# usually a one-commit branch that stands down anyway, so the probe reds nothing
# and the guard reads as fenced. Run the hook FROM a firing tree instead, which
# is the only channel that decides `git -C ""`. Measured: with the guard, rc=0;
# without it, rc=2 against a tree nobody named.
ediff=$(cd "$TWO_CHANGELOG" && printf '%s' "{\"cwd\":$(printf '%s' "$NO_TREE" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' 'git -C "$WT" rebase main' | jq -Rs .)}}" \
  | "$HOOK_BASH" "$HOOK" >/dev/null 2>&1; echo $?)
if [ "$ediff" = 0 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: an unreadable -C was judged against the hook's own cwd (rc=$ediff)"; fi

# --- The env-channel bypass, which the refusal message advertises ---
CDKD_SKIP_FLATTEN_GATE=1 run 0 'bypass from the ENVIRONMENT' "git -C $TWO_CHANGELOG rebase main"

# --- A valueless-flag-only rebase reaches nbare WITHOUT the unknown-flag path ---
# Six of the argument-shape cases above stand down at `unknown flag` and never
# reach the bare-token count, so without this one the `nbare` rule is only ever
# exercised through a confluence point.
run 0 'valueless flags but no upstream at all' "git -C $TWO_CHANGELOG rebase -q --autostash"

# --- PASS: fails OPEN on anything it cannot evaluate ---
run 0 'unresolvable upstream' "git -C $TWO_CHANGELOG rebase does-not-exist"
run 0 'not a work tree' "git -C $SANDBOX/nope rebase main"

# --- PASS: the documented bypass, from the command text ---
run 0 'bypass in the command text' "CDKD_SKIP_FLATTEN_GATE=1 git -C $TWO_CHANGELOG rebase main"
# ...but ONLY in command position. A mention inside an unrelated argument used
# to buy it, which is a bypass anyone could spend by accident.
run 2 'a MENTION of the bypass does not buy it' "git -C $TWO_CHANGELOG rebase main && echo \"then CDKD_SKIP_FLATTEN_GATE=1 if you must\""

# --- The append-shaped match is EXACT-LINE, not substring ---
# Both of these contain `docs/changelog-cdkd.md` as a substring of their path.
NEAR_MISS=$(mkrepo near-miss 2 docs/changelog-cdkd.md.bak)
NEAR_MISS2=$(mkrepo near-miss2 2 xdocs/changelog-cdkd.md)
run 0 'a longer path containing the needle is not a hit' "git -C $NEAR_MISS rebase main"
run 0 'a longer directory containing the needle is not a hit' "git -C $NEAR_MISS2 rebase main"

# --- The refusal names the file that actually matched ---
lmsg=$(printf '%s' "{\"cwd\":$(printf '%s' "$NO_TREE" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' "git -C $TWO_LEDGER rebase main" | jq -Rs .)}}" \
  | "$HOOK_BASH" "$HOOK" 2>&1 >/dev/null)
case "$lmsg" in
  *'docs/_generated/integ-last-run.tsv'*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: a ledger refusal does not name the ledger" ;;
esac
case "$lmsg" in
  *'docs/changelog-cdkd.md'*) fail=$((fail + 1)); echo "FAIL: a ledger refusal names the changelog instead" ;;
  *) pass=$((pass + 1)) ;;
esac

# --- The refusal must NAME the remedy, not just refuse ---
msg=$(printf '%s' "{\"cwd\":$(printf '%s' "$NO_TREE" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' "git -C $TWO_CHANGELOG rebase main" | jq -Rs .)}}" \
  | "$HOOK_BASH" "$HOOK" 2>&1 >/dev/null)
for needle in 'reset --soft' 'merge-base' 'docs/changelog-cdkd.md' 'CDKD_SKIP_FLATTEN_GATE=1' 'ship.md'; do
  case "$msg" in
    *"$needle"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); echo "FAIL: refusal message omits '$needle'" ;;
  esac
done
# The remedy must be runnable in the tree the command targeted, not in the
# hook's cwd -- the whole reason -C is parsed at all.
case "$msg" in
  *"git -C \"$TWO_CHANGELOG\" reset --soft"*) pass=$((pass + 1)) ;;
  *) fail=$((fail + 1)); echo "FAIL: refusal message does not carry a QUOTED -C into the remedy" ;;
esac

# A remedy that is not copy-pasteable for a path with a space is not a remedy.
SPACED=$(mkrepo 'spaced lane' 2 docs/changelog-cdkd.md)
smsg=$(printf '%s' "{\"cwd\":$(printf '%s' "$NO_TREE" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' "git -C \"$SPACED\" rebase main" | jq -Rs .)}}" \
  | "$HOOK_BASH" "$HOOK" 2>&1 >/dev/null)
# BOTH remedy lines, not just the first: they are printed by separate `echo`s,
# so quoting one and not the other is a live shape -- measured, unquoting only
# the `commit` line left this block green when it checked the `reset` line alone.
for remedy in 'reset --soft' 'commit -F'; do
  case "$smsg" in
    *"git -C \"$SPACED\" $remedy"*) pass=$((pass + 1)) ;;
    *) fail=$((fail + 1)); echo "FAIL: remedy line '$remedy' is not copy-pasteable for a path with a space" ;;
  esac
done

# --- The library load is the one FAIL-CLOSED path, and it had no case ---
# A missing helper must refuse rather than silently disable the check. Probed by
# running the hook from a copy with no lib/ beside it.
noline=$(mktemp -d)
cp "$HOOK" "$noline/hook.sh"
printf '%s' "{\"cwd\":$(printf '%s' "$NO_TREE" | jq -Rs .),\"tool_input\":{\"command\":$(printf '%s' "git -C $TWO_CHANGELOG rebase main" | jq -Rs .)}}" \
  | "$HOOK_BASH" "$noline/hook.sh" >/dev/null 2>&1
if [ $? -eq 2 ]; then pass=$((pass + 1)); else fail=$((fail + 1)); echo "FAIL: an unloadable lib/command-match.sh did not fail CLOSED"; fi
rm -rf "$noline"

echo "flatten-before-rebase-gate: $pass passed, $fail failed"
[ "$fail" = 0 ]
