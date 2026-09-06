---
description: cdkd hook CLASS fences - the suites whose subject is every hook at once, not one of them
paths:
  - '.claude/hooks/unresolved-target-class.test.sh'
  - '.claude/hooks/markgate-gate-name-class.test.sh'
  - '.claude/hooks/lib/command-match.sh'
  - '.claude/hooks/lib/command-match.test.sh'
  - '.claude/hooks/lib/command-match-differential.test.sh'
  - '.claude/hooks/lib/command-match-mutants.sh'
---

# Hook CLASS fences

A class fence's subject is EVERY hook at once rather than one of them. Per-hook
cases are necessary and cannot stop the hook written next month by someone
copying a neighbour, and this repo has shipped several fences that went inert by
deriving their population from the very thing they were checking. Both fences
below therefore take their population from what the repo REGISTERS in
`.claude/settings.json` -- never from the directory listing, which iterates the
real set by coincidence, nor from the defect.

Per-hook detail lives in [hooks.md](hooks.md).

## Unresolved target directory (issue 2027)

**Fenced at the CLASS level, not per hook** — `.claude/hooks/unresolved-target-class.test.sh`. Per-hook cases are necessary but cannot stop the hook written next month that copies a scan from a neighbour, and this repo has shipped four fences that went inert by deriving their population from the thing they were checking. All three fences take their population from REGISTRATION -- `.claude/settings.json` (the registered set, floored at 30 rather than pinned to a number this sentence would drift against; a registered hook with no file, and a hook file nobody registered, each fail). **They are not interchangeable, and a green fence 2 is the easiest thing here to over-trust**: (1) a static lint that no hook outside `lib/` may hand-roll a `(git|gh) -C` scan, guarded by three planted VARIANT spellings it must all catch — an earlier version keyed on one byte-exact fragment and 4 of 6 realistic variants walked past it; (2) a fixture-free dynamic sweep feeding every hook 60 attack payloads through `git`/`gh`/`mise`/`markgate` shims, recording every `-C <path>` asked for and asserting none carries a `$` or a backtick — this CANNOT see a gate that stopped firing, since a hook that exits early calls no `git -C` and satisfies the assertion vacuously; (3) a self-calibrating pair test — for every hook and verb, IF the gate blocks the plain literal target THEN it must refuse all six unreadable spellings AND still block the same target quoted with a space. Fence 3 is the only one that discriminates a gate going quiet, so its fixture stages a violation in the `-C` TARGET while leaving the payload cwd clean; without that the eleven content-judging gates never blocked the control, their pairs were skipped, and reverting one to the pre-fix defect left the whole file green. Its baseline is per-hook and recorded from measurement (25 named hooks), because an aggregate floor cannot say WHICH gate went quiet — the previous `>= 6` against an actual 9 stayed green with `check-gate` AND `branch-gate` reduced to `exit 0`.

Measured against a materialised `origin/main` hook directory, all four property assertions go red — fence 1: 17 hooks; fence 2: 16 poisoned resolutions; fence 3: 472 leaking hook/command/spelling pairs across 17 distinct hooks, plus 50 misses of a determinate quoted target path — while the population, floor and guard assertions stay green, which is what makes them evidence rather than decoration. The `origin/main` run also reports 681 `git -C` calls against 84 on the fixed tree: the fixed gates refuse before resolving, so the drop is the fix working, not the fence going quiet.

**THE SHAPE, and it is the finding that outlives this fix.** Three review rounds each ended the same way: a spelling the parser did not know about. Every one is now a case in `command-match.test.sh` named for its round, so the inventory lives where it executes. That is not bad luck. **These gates decide policy by pattern-matching shell TEXT, and shell grammar is not a regular language**, so the set of spellings that slip past is unbounded and each round removes only the ones someone thought to try. Every miss is silent, and every miss lands in the FAIL-OPEN direction, because a gate that does not recognise a command does not fire. The fix is to **over-approximate the TRIGGER and stay strict on RESOLUTION**, with `gate_target_dir_strict` — which already refuses whatever it cannot read — deciding the outcome, and go-to-k/cdkd#2156 did it: `GATE_FLAGS` no longer enumerates flag spellings, the prefix being EITHER empty (verb next to the command word) OR one flag token then ANY tokens, so no flag VALUE has to parse and an unlisted spelling WIDENS rather than loses the match. A bare token in FIRST position stops it -- that IS the subcommand, so `git log --grep commit` settles with no name list to go stale; after a flag it stays ambiguous. Not the ONLY stopper: a QUOTED structural token used to evade every gate (go-to-k/cdkd#2333), CLOSED 2026-09-05 — and NOT by widening `GATE_FLAGS`, which is where the first attempt went and why it was withdrawn. Quoting is a load-bearing BRAKE on this very over-approximation: after a flag any later token can occupy the verb slot, and a quoted one happening not to match is the only thing keeping ordinary read-only work out of the gates, so a blanket dequote took 16 measured commands (`git -C <wt> log --grep "commit"` and siblings) from rc=0 to rc=2. `gate_dequote_structural` rewrites POSITIONS instead — the command word, the leading global-flag NAMES and the SUBCOMMAND slot, nothing after the verb — in `gate_segments`, so every reader that decides a gate outcome from a segment is covered at one point, without the segment TEXT changing for any consumer that parses its own arguments. (The issue's findings said EIGHT reader sites; `grep -c '\[\[ "\$segment" =~ '` says nine. The count is not the property — taking the same stream is — so it is not restated in the code either.) SUPERSET, now ENFORCED: a pinned pre-2156 baseline, any lost cell enumerated WITH ITS INPUT, 0 today. A category hid seven balanced commands; an enumerated cell hid three gates until its verb variants landed. False-refusal surface: see `.claude/hooks/lib/false-refusal-survey.sh`.

**The mitigation actually taken is a DIFFERENTIAL fence** — `.claude/hooks/lib/command-match-differential.test.sh`, per `/work-issues` section 5, which says a change to a CLASSIFIER cannot be fenced by hand-picked cases. The segmenter is exactly that: command text in, "which gates consider this and where does it resolve" out. Five rounds of hand-picked cases each changed the verdict for spellings nobody enumerated, and both regressions that reached review were found by diffing against the parent commit rather than by any test here. The fence runs the pre-#2027 implementation and the current one over its corpus — every shape from all five rounds plus families nobody had exercised (concatenated assignments, process substitution, heredocs, multi-line bodies, both quote characters unbalanced together, globs, degenerate inputs) — and compares the two observables a gate consumes: does each guarded verb ERE match, and what target does it resolve to. **Any differing cell that is not in an enumerated table fails**, and each allowed cell is pinned as `id + observable + NEW VALUE` rather than by input, because bucketing by input is how a regression gets waved through under a heading that says "intended". Per-class floors at the OBSERVED count (slack let a probe delete 25 cells and pass) mean a corpus that stops covering a class is loud instead of reading like a clean run, and the baseline is a **vendored golden file** at `.claude/hooks/lib/testdata/command-match.baseline.sh`, pinned to a SHA rather than to `origin/main` — once this work merges, a ref-based baseline would compare the code to itself and report zero differences forever. It is VENDORED rather than read with `git show <sha>` because CI shallow-clones and the object is not in its store: the fence correctly refused to run there and said so in one line, but a fence that cannot run in CI is not a fence. The fixture is byte-identical to the blob (verified: sha256 `2af09c64…`) and its hash is re-checked on every run, so a drifted copy fails loudly instead of silently redefining what "unchanged" means. It lives under `testdata/` so neither `run-tests.sh` (globs `lib/*.test.sh`) nor the class fence picks it up — checked. The table doubles as the changelog of intentional behaviour changes to the classifier, every cell declared. **Read the counts off the run, not off this sentence** — the fence prints inputs, cells and per-class floors on every invocation. The figures that used to sit here are GONE rather than refreshed: they were restated once per change, drifted three times anyway, and a wrong number in a file about fences is worse than no number. The two go-to-k/cdkd#2156 classes are keyed to the CHANGE, not the verdict.

One assertion in that file is an INVARIANT rather than a case: **no non-empty command may segment to ZERO.** Zero segments means every gate considers nothing and all of them exit 0 at once, which is what one unbalanced apostrophe in a `--body` did after round 4 — `gh pr comment 1 --body "don't merge yet` + a newline + `git commit -m x` disarmed the entire system, a strictly worse failure than the bug this work was filed for. Three separate defects combined: a line ending inside a quoted span left the accumulator with no trailing separator, `gate_segments`' reader discarded that unterminated last line, and the END-rule retry cleared only ONE quote character so text with an unbalanced apostrophe AND an unbalanced double quote never recovered. All three are fixed; the invariant is what keeps them fixed.

**Remaining known gaps**, measured (plus #2210 / #2334). go-to-k/cdkd#2650 closed two: `close_paren` counted a `)` inside a QUOTED span as a closer, so a substitution ended early and the rest of the line was re-split around it — `x=$(echo 'a)b'; cd /tmp) ; echo hi > <tracked>` came out as four scrambled fragments with the `cd` promoted to a top-level segment it never occupied; and `gate_segments` FLATTENED a plain subshell, so a consumer could not tell `( cd /tmp )` from `cd /tmp &&`. The first is fixed in the segmenter (priced by the differential's `QUOTED_PAREN` class, with three controls that must declare NO cell); the second by `gate_segments_marked`, a SEPARATE entry point so no `gate_segments` consumer has to opt in — which is weaker than the "leaves `gate_segments` byte-identical" this sentence carried until it was measured, and is the accurate claim: `gate_segments` differs from `origin/main` on a QUARTER of the corpus, every difference an enumerated cell. A third residue closed with them, found while checking that claim rather than by any case: `_gate_struct_next` split on whitespace alone, so `cd\ /tmp` — ONE shell word bash never acts on — became a `cd` the hooks honoured, moving the target for EVERY gate that resolves one. **Neither count is written here**: both were published, re-measured and disagreed on across four attempts, so read them off the run (apply the `odd-trailing-bs` mutant; the fence prints its own undeclared-cell list). go-to-k/cdkd#2333 left FIVE narrower residues, all enumerated on `gate_dequote_structural` and all failing in the same direction as before it: an unenumerated value-consuming global flag; a `gh` group absent from the second-verb-token list; a structural token past the length or span bound; more tokens than the count cap; and ANSI-C `$'...'` quoting. **The bounds are not optional and their cost is the residue** — unbounded, the dequote walk is quadratic in token length AND quote count together, and a 12 KB command took 154 s through `gate_segments`, killing the hook; a killed hook cannot emit exit 2, which disarms every gate at once, so one unmatched spelling is the cheaper failure. Its review also produced go-to-k/cdkd#2614 (`main-tree-edit-gate` parsed its own `cd` and missed a quoted command word — the one hook-local parser the audit found still outside the shared matcher), **CLOSED 2026-09-05** by deleting that parser rather than patching it: it now calls `gate_segments_marked` and walks the segments in order, which is the outcome this file already prefers ("the fix is one shared resolver, not 24 conditionals"). It briefly said `cmd_last_cd_target` here; that helper is deliberately NOT used, because it follows a `cd` that runs AFTER the write and re-opens this gate's founding incident. The audit's derivation is on `gate_dequote_structural` and reproduces its own answer — its REMEDY list is an enumeration too, and omitting `cmd_last_cd_target` from it made the loop report an already-ported hook as unported. Corrected, it returns two, both non-blocking and both out of scope: `main-tree-dirty-detector` (a PostToolUse observer with no verb grammar) and `integ-stale-base-detector` (hand-rolled command-position EREs for read verbs). After #2614 no BLOCKING hook parses a command outside the shared matcher. go-to-k/cdkd#2605 closed the other half — the false-refusal survey had only WRITE-verb shapes, so its zero could not see the read-only class that withdrew #2333's first attempt; a `read_grep` / `read_show` / `read_pathspec` family now covers it, proved against the withdrawn implementation rather than argued — the figures are on the script, which is also where the header now sends a reader asking what the current numbers are:

- **Substitution nesting deeper than 8** stops being scanned. The drain is bounded so a pathological input cannot spin; it now prints how many bytes went unscanned to stderr rather than dropping them silently, which makes the gap loud rather than invisible.
- **Three hooks are exercised by no literal control**, down from ten (go-to-k/cdkd#2156): `integ-coverage-matrix-gate` needs the real toolchain there, `restore-backup` refuses nothing by design, `worktree-owner-gate` fires on `Edit|Write|NotebookEdit`. The other seven have one now, from staged shapes plus a SECOND no-src tree. The exclusion is a DECLARED list, checked as a PARTITION: registered == exercised + declared, so one fails.
- ~~**`main-tree-branch-gate` reads the branch NAME out of a collapsed quoted span**, so `git switch "main"` blocks (safe direction) and `git checkout "feat/x"` passes.~~ **CLOSED 2026-09-01.** The gate now reads its arguments with a real option parse that keeps a quoted span as ONE token and unquotes it, so both directions are right. Measured in the real main checkout, before and after: `git switch "main"` rc=2 -> 0, `git switch 'main'` rc=2 -> 0, `git checkout "<local branch>"` rc=0 -> 2. Pinned by four cases in `.claude/hooks/main-tree-branch-gate.test.sh` including a branch name containing a SPACE; deleting the unquote reddens all four.
- **A bare `gh` segments to zero** — on the pre-#2027 implementation as well as the current one, so it is pre-existing rather than introduced. It is harmless (a bare `gh` runs nothing) and is the one case the zero-segment invariant excludes by name, so the exclusion cannot quietly widen.

Two classes are NO LONGER gaps, having been closed in review round 5. A **glob, a brace expansion or a `~user` prefix** in a `-C` or a `cd` is now treated as unreadable exactly like `$VAR`: the shell expands them and the commit lands in a real repo, while the parser cannot say which one, and the reverted "not a git repository" branch had been letting them through (`cd <wt>/.claude/worktrees/*/ && git commit` and `cd ~nobody/wt && git commit` both measured rc=0, now rc=2). A **leading `~/` or a bare `~` is deliberately NOT in that set**, because HOME is expanded here correctly and refusing it would be a false refusal.

**A THIRD class closed with them, and it is the one worth generalising: the
two bashes disagreed about a regex.** `gate_strip_prefix` stripped grouping
punctuation with the inline bracket expressions `[\(\{]` / `[\)\}]`. In a
POSIX bracket expression a backslash is an ORDINARY MEMBER rather than an
escape, so those sets contain a BACKSLASH -- bash 3.2's engine reads them that
way and bash 5.x's does not. The consequence was a fail-open in the direction
this file keeps warning about: `\\cd /tmp ; echo hi > <tracked>` left the
function as `cd /tmp` under 3.2, so every gate that resolves a target followed
a `cd` that REAL BASH DOES NOT RUN (measured under both: the shell stays put),
and the write escaped the protected tree. The backslashes were not gratuitous
-- the `[[ ]]` parser scans for the closing bracket before the regex engine
sees the word, so a bare `[)}]` written INLINE is a syntax error. That half is
NOT version-specific: 3.2 and 5.3 reject it identically (measured), and an
earlier revision of this paragraph blamed 3.2 for it.

The spelling adopted is to put each pattern in a VARIABLE and leave the
right-hand side of `=~` unquoted -- still matched as a regex, while the shell
parser never meets the `)`. It is not the ONLY spelling that works: an inline
alternation `(\)|\})` also parses and behaves identically on both engines
(measured). The variable is preferred because it scales to the negated classes
in the same function, where an alternation cannot express "any character except
these", and because it keeps all three patterns declared in one place.

**Three sites, not two.** The same construct sat three lines above, stripping a
`<pattern>)` case-arm label with `[^\(\)\|\;\&[:space:]]`. It was found by a
reviewer and then MEASURED rather than assumed: for `x\) pkill -f node`, 5.x
stripped the label and 3.2 did not, so `broad-process-kill-gate` answered rc=2
under 5.x and rc=0 -- fail-open -- under the version CI runs, against a control
that blocks on both. It is now the same variable treatment, and the payload is
a case in `broad-process-kill-gate.test.sh`, whose suite honours `HOOK_BASH`:
with the inline spelling restored it is green under 5.x and red under
`HOOK_BASH=/bin/bash`, which is the whole point of the shim.

**The reason it survived to CI is the more transferable half.** The local
reproduction ran the SUITE under `/bin/bash`, while the hook it invokes carries
`#!/usr/bin/env bash` and took whatever came first on `PATH` -- 5.x. So "passes
under bash 3.2" was true of the test and false of the thing under test, and the
divergence was invisible until a runner that has only 3.2 ran both halves under
it. Reproduce the runner by putting 3.2 FIRST on `PATH`
(`D=$(mktemp -d); ln -sf /bin/bash "$D/bash"; PATH="$D:$PATH" /bin/bash <suite>`),
not by invoking the suite with `/bin/bash`. The sibling suites that added a
`HOOK_BASH` shim are solving the same problem from the other end.

## The gate-name class fence (issue 2198)

`.claude/hooks/markgate-gate-name-class.test.sh` asserts, for every
markgate-backed hook, WHICH GATE it asks its verifier about. Nothing did before:
every per-hook suite asserted an exit code and a few asserted the cwd markgate
ran in, and a gate pointed at the wrong marker is **indistinguishable from a
working one from the outside** — same exit codes, same messages, same cwd. Only
the argv separates them. Measured by rewriting each hook's `markgate verify <gate>` to
`verify BOGUS-GATE` and running that hook's own suite: `check-gate` 33/33,
`integ-destroy-gate` 20/20, `integ-broad-gate` 24/24 — all green. Concretely,
swapping `verify verify-pr` for `verify check` in verify-pr-gate makes it pass
whenever `/check` alone is fresh, merging a PR whose `/verify-pr` checklist
never ran. `verify-pr-gate` is deliberately NOT in that list: issue 2199 gave
its suite an argv trace and a gate-name case of its own, so on a pristine clone
it is 23/0 clean and 22/1 mutated. An earlier draft led with its stale 22/22.

**The population is derived from BEHAVIOUR, not from the hook text**, and that is
the part worth copying. All three textual predicates were tried and all three are
wrong: `grep -l 'markgate verify'` finds 5 of the 8 (gates invoke the binary as
`"${markgate[@]}" verify <gate>`, and `stop-warn` builds that array so no literal
`markgate verify` appears on any line); `grep -l markgate` finds 20, because
almost every gate reads `.markgate.yml` for the repo opt-in check; and stripping
comments does NOT exclude `main-tree-git-cwd-detector`, which carries
`markgate[[:space:]]+(set|verify)` inside a REGEX STRING, since detecting
markgate commands is its job. So the CANDIDATE list comes from
`.claude/settings.json` — the only authoritative statement of what is a hook —
and each candidate is RUN under a markgate shim that records its argv. The
directory listing is deliberately NOT the candidate list: `run-tests.sh` is the
aggregate suite RUNNER, so driving it re-runs every suite once per probe payload,
and a first version of this file had to be killed after twenty minutes.

Three fences, and fence 3 is what makes the other two mean anything:

- **fence 1** — every hook in the table asks about the gate the table names.
- **fence 2** — the table and the observed population agree in BOTH directions,
  so a new markgate-backed hook with no table entry fails, and so does a table
  entry for a hook that no longer verifies anything.
- **fence 3** — the probes actually REACH the markgate call. Four gates
  scope-check the PR diff and return before verifying anything, so without this
  the file would report green over nothing.

**Reaching the call was most of the work, and four separate things blocked it** —
each one a failure in the green direction, and each caught by fence 3 rather than
passing as "verified":

1. The gates read their scope from `gh pr view --json files`, not from
   `gh pr diff --name-only`, so a generic `files` array made four of them decide
   the PR was out of scope.
2. `check-gate` probes `markgate --version` first — see 3. The matcher also
   accepts `status`, but NOT because `check-gate` asks with it: that hook asks
   with `verify check` / `verify docs`, and its `status` call pulls the
   staleness reason into a refusal only AFTER a verify fails, which the shim's
   default fresh verdict never produces. An earlier draft gave `status` as the
   reason `check-gate` was unreachable; the two were conflated.
3. `check-gate` probes `markgate --version` and fails CLOSED when it errors, so
   a shim that only knows `verify` / `status` never lets it reach the question.
4. `integ-schema-migration-gate` splits the diff into per-FILE hunks and greps
   the `src/types/state.ts` one, so a bare `+ version: ...` line with no
   `diff --git` header belongs to no file and matches nothing.

A fifth was in the fence's own instrument: the argv extraction used BRE
`\(verify\|status\)`, and `\|` is a GNU extension, so on macOS it silently
matched nothing and EVERY hook reported "asked about []" — the fence reporting
its own broken tool as a total failure of its subject. `sed -E` throughout.

Mutation-probed per gate rather than in aggregate: repointing each of the eight
at another marker fails fence 1 naming that gate and its wrong marker, with a
3/3 control before and after.
