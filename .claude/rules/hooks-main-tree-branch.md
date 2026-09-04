---
description: cdkd main-tree-branch-gate - what it blocks and passes, and the measured defects behind each arm
paths:
  - '.claude/hooks/main-tree-branch-gate.sh'
  - '.claude/hooks/main-tree-branch-gate.test.sh'
---

# `main-tree-branch-gate.sh`

Split out of [hooks.md](hooks.md) on 2026-09-01 (that file loads WHOLE on
every `.claude/hooks/**` touch and had hit its byte cap; the `paths:` here is
the gate and its suite only).

**Blocks branch-switching commands in the MAIN worktree** so concurrent
agents don't race on the shared `/Users/goto/pc/github/cdkd` slot. Cwd-aware
(same resolution as `branch-gate.sh`); fires only when the canonicalized
target dir matches `git worktree list --porcelain`'s first entry. Closes the
2026-05-24 cross-agent contention incidents (memory
`feedback_cross_agent_main_tree_contention.md`). macOS-safe (`cd && pwd -P`
canonicalizes `/tmp` ↔ `/private/tmp`).

- **Allowed** in the main tree: `git switch main|master`,
  `git checkout main|master`, `git checkout [<tree-ish>] -- <pathspec>` AND
  `git checkout <tree-ish> <pathspec>` (file restores — HEAD unmoved),
  `git checkout -p|--patch|--ours|--theirs …`, `git checkout <sha>`
  (detached HEAD — see the rationale correction below), `git checkout HEAD`,
  `--help` under either verb, `git worktree add ...` (sanctioned escape).
- **Blocked**: `git switch <not-main>`; the create pair under both verbs in
  every spelling — `-c|-C|--create|--force-create <b>` (switch), `-b|-B <b>`
  (checkout), `--orphan <b>` (both), glued `-c<b>` / `-C<b>` / `-b<b>` /
  `-B<b>` / `--create=<b>` / `--force-create=<b>` / `--orphan=<b>`, bundles
  like `-qb<b>`; `-t|--track|--track=<mode> <remote-ref>` (git DWIMs a
  create + switch); `git checkout <name>` when `<name>` is the ONLY
  positional and names a LOCAL branch or a branch on some REMOTE;
  `git switch --detach`; `-` / `@{-1}` under BOTH verbs (previous branch —
  unknowable without running git, blocked conservatively).
- Inside any `.claude/worktrees/<x>/` subtree everything passes.

**BYPASSABLE by chaining until 2026-08-31** — an awk walker skipped to the
FIRST `git` token, so `git fetch origin && git switch -c <b> origin/main`
read `sub=fetch`, fail-open (measured: bare `git switch -c` rc=2, chained
twin rc=0). Now it judges the SEGMENT that matched, one ERE per verb, EVERY
matching segment read.

**The TREE was resolved once per command until 2026-09-01** — segment 1
decided every segment. Measured: `git -C <wt> switch -c a && git switch -c b`
rc=0 (want 2); the `checkout -b` twin rc=0 (want 2);
`git switch main && git -C <wt> switch -c a` rc=2 (want 0 — refusing a
branch creation IN a linked worktree, the mandated shape). Tree and
arguments now come from ONE walk (`gate_verb_rest_each_dir` in
`lib/command-match.sh`, emitting `<dir>TAB<rest>` per matching segment); a
`cd` persists into later segments, a `-C` binds only its own command, an
unreadable per-segment tree is REFUSED per segment. Stated LIMIT:
`gate_segments` flattens a subshell, so
`(cd <wt> && git switch -c a) && git switch -c b` from the main tree passes
(measured rc=0, want 2 — pre-existing, same against the pre-fix hook).

**The ARGUMENTS were read as "token 1 and token 2" until 2026-09-01** —
thirteen defects, all live, every `want` settled against real git 2.53.0
first (grammar from `git checkout -h` / `git switch -h`, not memory):

```text
git checkout <branch> -- <paths>            rc=2  want 0  <- false block (restore)
git checkout <branch> <paths>               rc=2  want 0  <- false block (restore)
git switch --help                           rc=2  want 0  <- false block
git checkout --pathspec-from-file <f> <b>   rc=2  want 0  <- false block (restore)
git checkout -f <branch>                    rc=0  want 2  <- bypass
git checkout --orphan <branch>              rc=0  want 2  <- bypass
git checkout -bfeat / -Bfeat / -qbfeat      rc=0  want 2  <- bypass (glued / bundled)
git checkout --orphan=feat                  rc=0  want 2  <- bypass (glued)
git checkout --conflict merge <branch>      rc=0  want 2  <- bypass (a count is not a parse)
git checkout --recurse-submodules <branch>  rc=0  want 2  <- bypass
git checkout <remote-only branch>           rc=0  want 2  <- bypass (DWIM create + switch)
git checkout -t origin/<b> / --track=direct rc=0  want 2  <- bypass (DWIM create + switch)
git checkout - / git checkout @{-1}         rc=0  want 2  <- bypass (previous branch)
```

- **Count the rows; do not recall the number** — this entry once said "nine"
  over thirteen rows while the shipping commit said eight and nineteen: four
  spellings of one set.
- **A wrong `want` is worse than a missing row** — the test written from it
  defends the defect. The `--pathspec-from-file` row is that CORRECTION: the
  pathspecs come FROM THE FILE, the trailing token is the tree-ish, the
  command is a RESTORE (measured, spaced and `=` spellings alike).
- Three rows are load-bearing: `-f <branch>` was a LIVE BYPASS (`-f` read AS
  the branch name, `refs/heads/-f` unresolvable, the switch really
  happened); `<branch> -- <paths>` is a sibling repo's documented
  integration step (mandated flow, false-blocked); `<remote-only>` is how a
  lane's branch usually FIRST appears, invisible to a local-only `show-ref`.

**That parse shipped a REGRESSION and five more holes, closed 2026-09-02**
(the first four rows were RIGHT on `origin/main` and wrong after —
regressions, not gaps; `git switch -- main` wrong in both). Fixture: a main
checkout with a configured `origin`, a SLASH-named remote `a/b`, a ref under
an UNCONFIGURED remote, a real local branch; every `want` settled against
real git first:

```text
command                                     OLD  NEW  now  want
git checkout <branch> 2>/dev/null             2    0    2     2
git checkout <branch> >/dev/null 2>&1         2    0    2     2
git checkout <branch> # switch lane           2    0    2     2
git checkout <branch> --                      2    0    2     2
git checkout -q <branch> 2>&1                 0    0    2     2
git checkout - 2>/dev/null                    0    0    2     2
git checkout --orph <b> / --or <b>            0    0    2     2
git checkout --trac origin/<b>                0    0    2     2
git checkout <b on a SLASH-named remote>      0    0    2     2
git switch -- main                            2    2    0     0
git checkout <ref under an UNCONFIGURED rem>  0    2    0     0
git checkout --no-guess <remote-only>         0    2    0     0
git checkout --pathspec-from-file <f> <b>     0    2    0     0
control: git checkout <branch>                2    2    2     2
```

Four causes; the fix is to each cause, not the fourteen spellings:

1. **The input is ARGV, not shell WORDS.** A redirection, its spaced target,
   a trailing `&` and a `#` comment are the SHELL's words — they inflated
   the positional count and read a real switch as a file restore. The gate
   reads `gate_argv` (library sibling) that drops exactly those; the comment
   strip is deliberately NOT in `gate_segments`, which feeds every gate.
2. **A positional COUNT relaxed a verdict on an incomplete parse — twice**
   (`--conflict merge <branch>`; `<branch> 2>/dev/null`). The count cannot
   go — only the extra OPERAND tells checkout's restore form from its switch
   form — so the parse asks a boolean (`first_pos`, `pathspec_seen`) over a
   fully parsed ARGV, under the rule **an incomplete parse may not ALLOW**:
   an unresolvable/ambiguous long name or unknown cluster letter sets
   `parse_certain=0` → conservative block naming the option. **The cost is
   not zero — measured**: the arm fired on `--end-of-options main` (rc=0,
   HEAD stays), `--end-of-options -- f.txt` (rc=0, restores),
   `--git-completion-helper` (rc=0, prints the list) — `parse-options`
   built-ins absent from `-h`, the tables' source; with
   `--git-completion-helper-all` (rc=0) and `--help-all` (rc=129) all five
   are in the tables now, arity 0. `--end-of-options` sets `end_opts` but
   NOT `dashdash_seen` — `git checkout --end-of-options some-feature` really
   SWITCHES (measured); the `--` mapping would turn it into an allow.
   Residual, stated: an unknown option blocks even when git would run it —
   a guessed arity moves every positional after it.
3. **git accepts any unambiguous PREFIX of a long name, and `-h` does not
   show it** (measured: `--orph newb` / `--or newb` create and switch;
   `--trac origin/<b>` creates the branch). Each verb carries its COMPLETE
   long-option table — every `--[no-]x` contributing `x` and `no-x`, arity
   `0` / `1` / `?` (the SPACED form of an optional-value flag consumes
   nothing) — a prefix resolves only against the WHOLE set.
4. **`--` is checkout's pathspec separator and switch's end-of-options.**
   `git checkout <b> --` SWITCHES (measured), so "a `--` was seen" is the
   wrong rule; `git switch` has no pathspec form at all (measured:
   `git switch -- main` prints "Already on 'main'") — checkout's grammar
   applied to both verbs false-blocked it.

## Round 4 — the stripper's default is inverted, not extended

Three rounds each modelled more of the shell/git grammar from the outside;
each next round found the part still unmodelled. Measured (`OLD` =
`origin/main`'s hook, `NEW` = round-3, `AFTER` = this one; every `want`
confirmed against git 2.53.0, HEAD printed before and after):

```
command                                     OLD  NEW  AFTER  want
git checkout <branch> $EMPTY                   2    0      2     2   HEAD MOVED
git checkout <branch> ${EMPTY}                 2    0      2     2   HEAD MOVED
git checkout <branch> {fd}>/dev/null           2    0      2     2   HEAD MOVED
git checkout <branch> {fd}<f.txt               2    0      2     2   HEAD MOVED
git checkout main # don't switch lanes         0    2      0     0   HEAD stays
git checkout main -- f.txt # agent's file      0    2      0     0   HEAD stays
git checkout --end-of-options main             0    2      0     0   HEAD stays
git checkout --end-of-options -- f.txt         0    2      0     0   HEAD stays
git checkout --git-completion-helper           0    2      0     0   prints a list
control: git checkout <branch>                 2    2      2     2
```

**The asymmetry, and the fix.** "An incomplete parse may not ALLOW" was
implemented for unknown GIT OPTIONS only; `gate_argv` did the opposite for
SHELL WORDS — an unmodelled word became a phantom second positional,
`pathspec_seen=1`, verdict relaxed to "file restore". Same fence, other
grammar: **a word `gate_argv` cannot fully account for sets
`parse_certain=0`.** `gate_word_is_literal` (shared library) admits a word
only when every character outside a quoted span is on `GATE_INERT_CHARS`, a
closed list of shell-inert characters, each with its reason recorded
(single-quoted spans refuse nothing; double-quoted only `$`, backtick, `\`).
An unthought-of construct lands on BLOCK because it is SPELLED with a
character the list does not hold — refused without being enumerated. The
audit surface is the LIST, not a catalogue of shell forms (`{fd}>/dev/null`
is caught by `>` and `{` without naming redirection).

**ONE exemption, proved**: a word beginning with the literal `@{-`. No
expansion can produce or remove those three characters, so the word can
never VANISH (the only direction turning a switch into a restore), and its
verdict is the previous-branch BLOCK, which only MORE positionals relax —
which an expansion can only add. Without it
`git checkout @{-1} -- README.md` (a restore, measured) would block.

**The cost was measured, not assumed.** Replaying every `git checkout` /
`git switch` in the three repos' committed files: 206 distinct texts, 32
newly blocked — **30 documentation metasyntax** (`<branch>`, `[<options>]`,
table rows) — 2 newly ALLOWED (the `#`-comment fix). Lines that EXECUTE:
exactly two, both `git checkout -- "${WATCH_SRC}"` in
`tests/integration/local-start-api/verify.sh`, neither reachable by this
hook (inside a script, from a fixture subdir). **Measured false blocks on
commands this repo actually runs: zero.**

**`--help` no longer skips the fence** — `saw_help` returned ahead of the
`parse_certain` check, the one relaxing verdict bypassing the design's rule
(`git checkout --frobnicate --help` allowed — harmless there, but an
exemption with no argument behind it is what the next round finds). The
check now comes first.

**Nothing pins the option TABLES to the installed git** — a real residual. A
wholly new option blocks on `parse_certain=0` (verified with
`--frobnicate`); a newly ambiguous prefix is moot (git refuses too). What
passes silently is an ARITY CHANGE to a known name (`--track` optional →
required): the walk consumes the wrong token and could ALLOW. Regenerating
from `--git-completion-helper-all` catches a new NAME, not an arity change.

**The DWIM list is the CONFIGURED remotes, stripped per remote** — what git
does (both siblings used a fixed `lstrip=3` over `refs/remotes/`). Measured
old-scan defects: a remote NAME may contain a slash (`git remote add a/b
<url>` is accepted), so `deep-only` lstripped to `b/deep-only` while git
DWIMs the bare name — FAIL-OPEN; a ref under `refs/remotes/<x>/` with no
remote `<x>` configured gets "pathspec did not match", HEAD stays — FALSE
BLOCK. Dropping SYMREFS replaces the old literal `HEAD` exclusion.
`--no-guess` turns the DWIM off (measured); the arm is skipped for it. The
list does NOT check UNIQUENESS: same name on two remotes → git REFUSES while
the gate blocks — conservative, kept; the old "exactly one remote carries"
comment is retired.

**A truncated argument list is refused, not parsed.** An UNBALANCED quote
cannot be split; `gate_tokens` used to return the prefix silently —
`-b agent's-branch` yielded the lone token `-b`, read as bare
`git checkout`, PASSED: fail-open on a branch creation. It now REPORTS the
truncation, `gate_argv` propagates it, the gate blocks naming the cause.
**The old justification was itself false and is retired**: splittability was
computed on the WHOLE text while the `#` comment was dropped later, so an
apostrophe INSIDE a comment counted as a quote —
`git checkout main # don't switch lanes` is VALID bash (measured, HEAD
unmoved) and the gate blocked it. `gate_argv` now cuts the comment BEFORE it
splits (`gate_strip_comment`, plus `gate_segments_raw`'s `ignore_q` second
pass for a never-closing quote). `-b agent's-branch` still refuses — no
comment to cut.

**Two wordings retired.** `git checkout -d|--detach <branch>` really
DETACHES (measured: HEAD → raw sha); the block used to say "switches to
feature branch '<b>'" — right verdict, wrong operation; fixed. And the
fail-closed guard's note claimed an empty `GATE_EMBEDDING_TOKEN` makes the
match "succeed on any input with `${BASH_REMATCH[1]}` empty" — right
conclusion (name the constants, fail closed), wrong mechanism: an empty ERE
matches EVERY string at position 0; the loop terminates only because
`gate_tokens` breaks on an empty rest.

**KNOWN BOUND, in the message rather than the verdict**: `gate_segments`
truncates a segment at `}`, so `git switch -c 'feat/{id}'` blocks correctly
while the message's `git worktree add … -b feat/{id` recipe names a
TRUNCATED branch — the cause is the shared splitter every gate calls;
recorded, not worked around here.

Two allowances look like gaps and are not: `git checkout HEAD` creates
nothing (measured) and is excluded by the SYMREF rule (a branch cannot be
NAMED `HEAD`); `-p` / `--ours` / `--theirs` / `--pathspec-from-file` leave
HEAD alone. `--pathspec-file-nul` is deliberately NOT in the restore set:
real git refuses it without `--pathspec-from-file`, so it never appears in
an accepted command this arm would judge.

**Correction to an older rationale**: `git checkout <sha>` was justified as
"read-only inspection". False — it rewrites the shared tree, leaves a
detached HEAD, and the detached HEAD disarms `branch-gate.sh`
(`symbolic-ref --short HEAD` EMPTY while detached → `exit 0`; measured:
`git commit` rc=2 on `main`, rc=0 once detached). **This gate's verdict is
unchanged** (blocking the sha spelling would refuse legitimate inspection —
its own PR), but the CONSEQUENCE is gone: issue
[#2402](https://github.com/go-to-k/cdkd/issues/2402) taught `branch-gate.sh`
to block a detached HEAD in the MAIN checkout while a detached LINKED
worktree stays allowed (the lane-clearing state
`stop-unmerged-lane-warn.sh` prescribes). Re-measured: rc=2 detached in the
main checkout, rc=0 in a linked worktree.

**The one-entry `main_tree_of` memo was dead until the same date**: read via
COMMAND SUBSTITUTION, both memo variables died in the subshell, and a
3-segment same-tree command forked `git worktree list` three times under a
comment claiming the saving. The answer now returns in a global; a
fork-counting case pins the count at 1 — asserting `rc=2` BESIDE the count
(a mutation stopping the walk after segment 1 also forks once).
**cdk-local's copy has no memo** and forks once per matching segment — the
divergence is stated in `main_tree_of`'s own header on both sides. **The
three repos put this gate's cases in different FILES** (cdkd /
cdk-real-drift: per-gate `main-tree-branch-gate.test.sh`; cdk-local: the
shared `gate-command-recognition.test.sh`) — a port has to be told where a
case lands.

Smoke test at `.claude/hooks/main-tree-branch-gate.test.sh` (166 cases, both
polarities: chained blocking AND chained allowed spellings, the per-segment
pair both directions, cd-persists / `-C`-binds, every argument shape in both
tables with its false-block control, the quoted-branch-name pair, the fork
count, the message cases that stop a FLAG being named as the branch). The
fixture carries CONFIGURED remotes (plus a SLASH-named one and a ref under
an unconfigured one) rather than bare `update-ref`s — without that the DWIM
rows assert a block for a command real git refuses, and the two
per-remote-strip cases cannot exist.

**One case is written around a bash 3.2 DEFECT — and the mechanism first
recorded for it was wrong.** Under 3.2.57 a `'` inside a DOUBLE-quoted word
inside `$(...)` loses the quoting on the NEXT single-quoted argument; the
observable is NOT an argument shift (`argc=4` under both shells) but
**brace expansion**: with quotes gone,
`'{cwd:$d,tool_input:{command:$c}}'` expands to two words, the command runs
twice, and real `jq` answers two compile errors where 5.3.9 prints the
object (a filter with no comma cannot show it — why an earlier probe found
nothing). The suite runs under BOTH shells, so cdkd's unbalanced-quote cases
build their apostrophe with `printf '\047'` — **proven load-bearing**: a
literal apostrophe leaves the suite 168/0 under 5.3.9, 166/2 under 3.2.57.
The siblings were measured immune (cdk-real-drift routes the payload through
a `payload()` function; cdk-local passes the command as a plain argument) —
the workaround exists in cdkd only.

Where the exit code cannot discriminate (a dropped create-flag still names
the branch, merely calling the creation a switch), the case asserts the
whole message PHRASE. Every added assertion was mutation-proven; three
fenced nothing when first written: a `-C`-carrying CHECKOUT (dropping
`${GATE_FLAGS}` from `GATE_RE_GIT_CHECKOUT` left the suite green), the memo
(only a fork count sees it), the previous-branch arm under `checkout`.
**Three more passed for the WRONG reason**: `git checkout --help` was
vacuous under `checkout` (a bare `--help` has no positional, passes on the
"no target" arm — now paired with `--help <local branch>` and the short
`-h`, which had no case at all); the `--ours` / `--theirs` cases used
`README.md` as pathspec (resolves to no branch — they use a real branch name
now).

**Round-3's sixteen mutations, sixteen tallies** (142/0 unmutated at the
time): shell-word dropping off `7 FAIL`; silent truncation restored `2`;
prefix matching removed `6`; `--unified` arity 1 -> 0 `1`;
`--inter-hunk-context` arity 1 -> 0 `1`; `-U` cluster arm removed `2`;
`parse_certain` forced true `4`; `--` alone treated as a pathspec `1`;
checkout's pathspec rule applied to switch `1`; old `lstrip=3` DWIM scan
restored `2`; `--no-guess` ignored `2`; `--pathspec-from-file` dropped from
the restore set `3`; detach wording removed `2`; `--track` made to consume
its next token `3`; bare-`git switch` arm removed `1`; `--help` arm removed
`4`.

**Round-4's mutations** (gate 168/0, library 461/0 unmutated). Gate:
literal-word check disabled `6 FAIL`; `@{-` exemption removed `2`;
`--end-of-options` mapped onto `--` `1`; `end-of-options` dropped from the
tables `4`; BOTH `git-completion-helper` names dropped `1`; `--help` allowed
to bypass the fence again `1`; `pending` skip made to assign like value `1`;
short `-h` arm removed `2`; `-2`/`-3` restore arm removed `2`; `--track`
pathspec guard removed `1`; `--track` `npos == 1` guard removed `1`;
`dashdash_seen` reverted to `end_opts` `1`; `--guess` arm inverted `2`;
empty-argv guard removed `3`. Library: `#` dropped from the inert class `1`;
inert check made permissive `15`; `>>` `1`, `>|` `1`, `>&` `1`, `<&` `1`,
`&>` `1`, `&>>` `1` dropped from `GATE_REDIR_TOKEN`; comment strip disabled
`3`; `ignore_q` second pass disabled `1`; comment cut made to ignore single
quotes `1`. **Three are labelled CONTROLS, not fences** (nothing reddens):
dropping ONE of `git-completion-helper` / `git-completion-helper-all` (the
other resolves as a unique PREFIX, as real git does); dropping `help-all`;
removing the no-`#` fast path in `gate_strip_comment` (pure optimisation).
Re-gating `saw_help` behind `parse_certain == 1` also stays green,
correctly — the same predicate written the other way round.

**No bypass flag** — the error names the resolved target dir + the operation
+ the corrective
`git worktree add .claude/worktrees/<branch> -b <branch> origin/main`
recipe. If the user genuinely needs a feature branch IN the main tree
(release surgery, history rewrite), confirm with the user explicitly first.
