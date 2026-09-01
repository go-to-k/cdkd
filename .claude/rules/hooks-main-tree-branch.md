---
description: cdkd main-tree-branch-gate - what it blocks and passes, and the measured defects behind each arm
paths:
  - '.claude/hooks/main-tree-branch-gate.sh'
  - '.claude/hooks/main-tree-branch-gate.test.sh'
---

# `main-tree-branch-gate.sh`

Split out of [hooks.md](hooks.md) on 2026-09-01. That file is loaded WHOLE by
every `.claude/hooks/**` touch and had reached its per-file byte cap, while this
entry is only wanted when the gate itself is under the knife, so the `paths:`
glob here is the gate and its suite and nothing wider.

**`.claude/hooks/main-tree-branch-gate.sh`** — blocks branch-switching commands in the MAIN worktree so concurrent agents don't race on the shared `/Users/goto/pc/github/cdkd` slot. Cwd-aware (same resolution as `branch-gate.sh`); compares the canonicalized target dir against `git worktree list --porcelain`'s first entry (the main tree) and only fires when they match. **Allowed** in the main tree: `git switch main|master`, `git checkout main|master`, `git checkout [<tree-ish>] -- <pathspec>` AND `git checkout <tree-ish> <pathspec>` (both are file restores that leave HEAD alone), `git checkout -p|--patch|--ours|--theirs …` (restore modes), `git checkout <sha>` (detached HEAD — see the rationale correction below), `git checkout HEAD`, `--help` under either verb, `git worktree add ...` (sanctioned escape). **Blocked**: `git switch <not-main>`, the create pair under both verbs in every spelling — `-c|-C|--create|--force-create <b>` for switch, `-b|-B <b>` for checkout, `--orphan <b>` for both, plus the GLUED forms `-c<b>` / `-C<b>` / `-b<b>` / `-B<b>` / `--create=<b>` / `--force-create=<b>` / `--orphan=<b>` and short-flag BUNDLES like `-qb<b>` — `-t|--track|--track=<mode> <remote-ref>` (git DWIMs it into a create + switch), `git checkout <name>` when `<name>` is the ONLY positional and names either a LOCAL branch or a branch on some REMOTE, `git switch --detach`, and `-` / `@{-1}` under BOTH verbs (previous branch, unknowable without running git — block conservatively). Inside any `.claude/worktrees/<x>/` subtree everything passes through — feature-branch work is meant to live there. Closes the cross-agent main-tree-contention incidents on 2026-05-24 (see memory `feedback_cross_agent_main_tree_contention.md`): PR #459 agent stashed PR #547 fix-back work; PR #549 (Splunk) agent created their feature branch in the main tree. Both would now be blocked at the source. macOS-safe — symlink-canonicalizes `/tmp` ↔ `/private/tmp` etc. via `cd && pwd -P`.

**It was BYPASSABLE by chaining until 2026-08-31.** An awk walker read the subcommand by skipping to the FIRST `git` token in the whole command, so `git fetch origin && git switch -c <b> origin/main` read `sub=fetch` and took the "unrecognised subcommand, fail open" arm. Measured on the real main checkout: the bare `git switch -c` rc=2, the chained twin rc=0. It now judges the SEGMENT that matched, with a separate ERE per verb and EVERY matching segment read — taking only the first leaves the same hole one operator along.

**The TREE was still resolved once for the whole command until 2026-09-01**, outside that walk, so segment 1 decided every segment: a bypass in one direction and a false block in the other, both live and both measured against the real main checkout and its real linked worktree with the payload cwd set to the main tree — `git -C <wt> switch -c a && git switch -c b` rc=0 (want 2), the `checkout -b` twin rc=0 (want 2), and `git switch main && git -C <wt> switch -c a` rc=2 (want 0), which refuses a branch creation IN a linked worktree, the shape the whole convention mandates. Both the tree and the arguments now come out of ONE walk (`gate_verb_rest_each_dir` in `lib/command-match.sh`, emitting `<dir>TAB<rest>` per matching segment), so they cannot be read from different segments; a `cd` persists into later segments while a `-C` binds only its own command, and a segment whose tree is unreadable is REFUSED per segment rather than for the command. LIMIT, stated: `gate_segments` flattens a subshell, so `(cd <wt> && git switch -c a) && git switch -c b` from the main tree resolves segment 3 to `<wt>` and passes (measured rc=0, want 2 — and the same against the pre-fix hook, so it is pre-existing).

**The ARGUMENTS were still read as "token 1 and token 2" until 2026-09-01**, and that is thirteen more defects, all live in the real main checkout and all settled against real git 2.53.0 first (HEAD and the local branch list printed before and after each command; the option grammar taken from `git checkout -h` / `git switch -h` rather than from memory):

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

Thirteen is the row count above, and the prose, the table and the PR text must all say thirteen: this entry read "nine" over a table of thirteen rows while the commit that shipped it said "five bypasses and three false blocks" (eight) in its title and "nineteen command shapes" in its body. Four spellings of one set. Count the rows; do not recall the number.

The `--pathspec-from-file` row is a CORRECTION rather than a new find: the first pass filed that flag with `--conflict` as merely value-taking and pinned `rc=2` in a test, and the row here said `want 2`. Backwards — the pathspecs come FROM THE FILE, so the trailing token is the tree-ish and the command is a RESTORE. Measured with a real one-line pathspec file: "Updated 1 path from <sha>", HEAD stayed on `main`, for the spaced and the `=` spelling alike. A wrong `want` in a table is worse than a missing row, because the test written from it then defends the defect.

Three of the thirteen are load-bearing rather than tidiness. `git checkout -f <branch>` is a LIVE BYPASS of the protection the whole worktree discipline rests on: `-f` was read AS the branch name, `refs/heads/-f` does not resolve, and the gate passed a switch that really happens. `git checkout <branch> -- <paths>` is the documented integration step in a sibling repo, so the false block refused a mandated flow. And `git checkout <name>` for a branch that exists only on a remote is how a lane's branch usually FIRST appears in a checkout, so a local-only `show-ref` was blind to the commonest spelling of the thing the gate guards.

**That parse then shipped a REGRESSION and five more holes, closed 2026-09-02.** The first four rows below were RIGHT on `origin/main` and wrong after the parse landed, which is what makes them regressions rather than gaps; `git switch -- main` was wrong in both. Measured against a fixture main checkout carrying a configured `origin`, a SLASH-named remote `a/b`, a ref under an UNCONFIGURED remote, and a real local branch — with every `want` settled against real git first:

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

Four causes, and the fix is to each cause rather than to the fourteen spellings.

**1. The input is ARGV, not shell WORDS.** `gate_tokens` splits SHELL words, and a redirection, its spaced target, a trailing `&` and a `#` comment are all words the SHELL owns — git never sees any of them. Feeding them to an option parse inflated the positional count and read a real switch as a file restore. The gate now reads `gate_argv`, a new sibling in `lib/command-match.sh` that drops exactly those. The comment strip is deliberately NOT in `gate_segments`: that splitter feeds every gate in the library, and widening it is a change to all of them.

**2. A positional COUNT relaxed a verdict on an incomplete parse — twice.** First `--conflict merge <branch>` (a flag's VALUE read as a positional), then `<branch> 2>/dev/null` (a shell WORD read as one). The count itself is not the defect and cannot be removed: git's own grammar is `git checkout [<options>] <branch>` OR `git checkout [<options>] [<branch>] -- <file>...`, so `git checkout <b> <path>` restores a file while `git checkout <b>` switches, and only the extra OPERAND tells them apart. What the parse asks now is a boolean — `first_pos` (the target) and `pathspec_seen` (an operand follows it) — over a fully parsed ARGV, and the general rule is that **an incomplete parse may not ALLOW**. A long name that resolves to no entry or to more than one, or an unknown cluster letter, sets `parse_certain=0` and the verdict is a conservative block naming the option. Today that arm fires only on commands git itself refuses ("error: unknown option" / "error: ambiguous option"), so it costs nothing now; it is what stops a FUTURE git option re-opening the same hole silently.

**3. git accepts any unambiguous PREFIX of a long name, and `-h` does not show it.** Measured: `git checkout --orph newb` and `--or newb` both create `newb` and switch, `--trac origin/<b>` creates the local branch. So the grammar's SOURCE was incomplete, not its transcription. Each verb now carries its COMPLETE long-option table — every `--[no-]x` line contributing both `x` and `no-x`, with arity `0` / `1` (required) / `?` (optional, and the SPACED form of an optional-value flag consumes nothing) — because a prefix can only be resolved against the WHOLE name set.

**4. `--` is checkout's pathspec separator and switch's end-of-options.** `git checkout <b> --` has a `--` and no operand, and it SWITCHES (measured, HEAD moved), so "a `--` was seen" is the wrong rule. And `git switch` has no pathspec form at all (`usage: git switch [<options>] [<branch>]`) — measured, `git switch -- main` prints "Already on 'main'" while `git switch -- some-feature` switches — so applying checkout's grammar to both verbs false-blocked the first as "no resolvable target".

**The DWIM list is the CONFIGURED remotes, stripped per remote**, which is what git actually does and what cdk-real-drift's copy of this gate already did while both siblings used a fixed `lstrip=3` over `refs/remotes/`. Two measured consequences of the old scan: a remote NAME may contain a slash (`git remote add a/b <url>` is accepted), so `deep-only` on it lstrips to `b/deep-only` while git DWIMs the bare name — a FAIL-OPEN; and a ref can sit under `refs/remotes/<x>/` with no remote `<x>` configured, where git answers "pathspec did not match" and HEAD stays — a FALSE BLOCK. Dropping SYMREFS replaces the old literal `HEAD` exclusion and is the same rule stated properly. `--no-guess` turns the DWIM off entirely (measured), and the arm is skipped for it. What the list does NOT do is check UNIQUENESS: with the same name on two remotes git REFUSES ("matched multiple remote tracking branches", HEAD stays) while the list still offers it and the gate blocks. That is the conservative direction so the behaviour stays — but an earlier comment claiming the list held only names "exactly one remote carries" is retired.

**A truncated argument list is refused, not parsed.** An UNBALANCED quote cannot be split into words at all, and `gate_tokens` returned the prefix it managed, silently: `-b agent's-branch` yielded the single token `-b`, which read as a bare `git checkout` and PASSED — a fail-open on a command that creates a branch. `gate_tokens` now REPORTS the truncation and `gate_argv` propagates it; the gate blocks with a message naming the cause. The text is a shell syntax error in the first place, so nothing legitimate is lost.

**Two wordings retired rather than carried.** `git checkout -d <branch>` / `--detach <branch>` really DETACHES (measured: HEAD went to a raw sha), and the block announced it as "switches to feature branch '<b>'" — a right verdict describing an operation git does not perform; it now says so. And the fail-closed guard's note claimed that with an empty `GATE_EMBEDDING_TOKEN` "the match then succeeds on any input with `${BASH_REMATCH[1]}` empty" — the conclusion (name the constants, fail closed) is right, the mechanism is not: an empty ERE matches EVERY string at position 0, and the loop terminates only because `gate_tokens` breaks on an empty rest.

**KNOWN BOUND, in the message rather than the verdict**: `gate_segments` truncates a segment at a `}`, so `git switch -c 'feat/{id}'` blocks correctly while the message and its `git worktree add … -b feat/{id` recipe name a TRUNCATED branch. The cause is in the shared splitter every gate in the library calls, so it is recorded rather than worked around here — the same property the `@{-*` pattern already documents.

Two allowances look like gaps and are not — `git checkout HEAD` creates nothing (measured: "Your branch is up to date"), and it is excluded by the SYMREF rule above rather than by a literal, since `refs/remotes/origin/HEAD` is a symref in essentially every clone and a branch cannot be NAMED `HEAD` anyway; and `-p` / `--ours` / `--theirs` / `--pathspec-from-file` leave HEAD alone, so blocking them would be the same false block as the restore one. `--pathspec-file-nul` is deliberately NOT in that restore set: real git refuses it without `--pathspec-from-file` ("fatal: the option '--pathspec-file-nul' requires '--pathspec-from-file'"), so it never appears in an accepted command this arm would have to judge.

**Correction to an older rationale**: `git checkout <sha>` was justified as "read-only inspection". False — it rewrites the shared working tree and leaves a detached HEAD, and the detached HEAD disarms `branch-gate.sh`, which reads `git -C <dir> symbolic-ref --short HEAD` (EMPTY while detached) and falls through to `exit 0`. Measured in a throwaway repo carrying a `.markgate.yml`, driving branch-gate with `git commit -m x`: rc=2 on `main`, rc=0 once detached. The verdict is unchanged — blocking it would refuse a legitimate inspection spelling across three repos and belongs in its own PR — but the claim is retired.

**The one-entry `main_tree_of` memo was dead until the same date**: it was read as `seg_main=$(main_tree_of "$dir")`, a COMMAND SUBSTITUTION, so both memo variables were written into a subshell that exited immediately and a 3-segment same-tree command forked `git worktree list` three times under a comment claiming the saving. The answer now comes back in a global and a fork-counting case pins the count at 1 — asserting `rc=2` BESIDE the count, because a mutation that stops the walk after segment 1 also forks once, so the count alone is satisfied by a gate that judged one segment instead of three.

**cdk-local's copy of this gate has no memo at all** and forks `git worktree list` once per matching segment; cdkd's has the memo plus the out-variable above. That divergence lived only in a commit message, so a reader of either repo could not see it. It is stated in `main_tree_of`'s own header on both sides now.

**The three repos put this gate's cases in different FILES**, which matters to whoever ports the next one: cdkd and cdk-real-drift each keep a per-gate `main-tree-branch-gate.test.sh`, while cdk-local folds them into the shared `gate-command-recognition.test.sh`. Both choices are defensible and cdk-local's is reasoned in its own `hooks.md`; the consequence is that a case added in one repo has no same-named home in the other, so a port has to be told where to land.

Smoke test at `.claude/hooks/main-tree-branch-gate.test.sh` (142 cases, both polarities incl. the chained blocking and chained ALLOWED spellings, the per-segment pair in both directions, the cd-persists / `-C`-binds pair, every argument shape in both tables above with its false-block control beside it, the quoted-branch-name pair, the fork count, and the message cases that stop a FLAG being named as the branch). The fixture carries CONFIGURED remotes rather than bare `update-ref`s, plus a SLASH-named one and a ref under an unconfigured one — without that, the DWIM rows assert a block for a command real git refuses, and the two that measure the per-remote strip cannot exist.

**One case is written around a bash 3.2 DEFECT, not a style preference.** Under 3.2.57 a `'` inside a DOUBLE-quoted word inside a `$(...)` opens a quote span that the NEXT single-quoted argument closes, so a `jq` filter written after an apostrophe-bearing command is split, jq fails, and the remaining arguments shift by one — measured, the same line yields `argc=4` with two empty arguments under 3.2 and `argc=3` under 5.3.9. The suite runs under BOTH shells (`run-tests.sh`), so the unbalanced-quote cases build their apostrophe with `printf '\047'`; written directly they report a hook defect that does not exist.

Where the exit code cannot discriminate — a dropped create-flag still names the branch correctly, it merely calls the creation a switch — the case asserts the whole message PHRASE rather than the name. Every added assertion was mutation-proven; three that fenced nothing when first written were a `-C`-carrying CHECKOUT (dropping `${GATE_FLAGS}` from `GATE_RE_GIT_CHECKOUT` left the suite green), the memo (turning it off left the suite green — only a fork count sees it), and the previous-branch arm under `checkout`.

**A case can also pass for the WRONG reason, and three did.** `git checkout --help` is vacuous under `checkout`: deleting the `--help` arm leaves it green, because a bare `--help` has no positional and passes on the "no target" arm instead — it is paired now with `--help <local branch>` and with the short `-h`, which had no case at all. The `--ours` / `--theirs` cases used `README.md` as the pathspec, which resolves to no branch, so deleting those flags from the restore list also left the suite green; they use a real branch name now. Both belong to the same family as the memo: an assertion whose subject never varies between the fixed and the broken code.

**Sixteen mutations, sixteen tallies**, run against a scratch copy of the hooks dir (142/0 unmutated): shell-word dropping off `7 FAIL`; silent truncation restored `2`; prefix matching removed `6`; `--unified` arity 1 -> 0 `1`; `--inter-hunk-context` arity 1 -> 0 `1`; the `-U` cluster arm removed `2`; `parse_certain` forced true `4`; `--` alone treated as a pathspec `1`; checkout's pathspec rule applied to switch `1`; the old `lstrip=3` DWIM scan restored `2`; `--no-guess` ignored `2`; `--pathspec-from-file` dropped from the restore set `3`; the detach wording removed `2`; `--track` made to consume its next token `3`; the bare-`git switch` arm removed `1`; the `--help` arm removed `4`.

No bypass flag — the error message names the resolved target dir + the operation + the corrective `git worktree add .claude/worktrees/<branch> -b <branch> origin/main` recipe; if the user genuinely needs to operate on a feature branch IN the main tree (release surgery, history rewrite), confirm with the user explicitly first.
