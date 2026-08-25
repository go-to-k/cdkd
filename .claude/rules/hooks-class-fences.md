---
description: cdkd hook CLASS fences - the suites whose subject is every hook at once, not one of them
paths:
  - '.claude/hooks/unresolved-target-class.test.sh'
  - '.claude/hooks/markgate-gate-name-class.test.sh'
  - '.claude/hooks/lib/command-match.sh'
  - '.claude/hooks/lib/command-match.test.sh'
  - '.claude/hooks/lib/command-match-differential.test.sh'
---

# Hook CLASS fences

A class fence's subject is EVERY hook at once rather than one of them. Per-hook
cases are necessary and cannot stop the hook written next month by someone
copying a neighbour, and this repo has shipped several fences that went inert by
deriving their population from the very thing they were checking. Both fences
below therefore take their population from what the repo DECLARES -- the
directory listing, or `.claude/settings.json` -- never from the defect.

Per-hook detail lives in [hooks.md](hooks.md).

## Unresolved target directory (issue 2027)

**Fenced at the CLASS level, not per hook** — `.claude/hooks/unresolved-target-class.test.sh`. Per-hook cases are necessary but cannot stop the hook written next month that copies a scan from a neighbour, and this repo has shipped four fences that went inert by deriving their population from the thing they were checking. All three fences take their population from the DIRECTORY LISTING (39 hooks, floor 25 asserted so a glob matching nothing is loud rather than vacuous). **They are not interchangeable, and a green fence 2 is the easiest thing here to over-trust**: (1) a static lint that no hook outside `lib/` may hand-roll a `(git|gh) -C` scan, guarded by three planted VARIANT spellings it must all catch — an earlier version keyed on one byte-exact fragment and 4 of 6 realistic variants walked past it; (2) a fixture-free dynamic sweep feeding every hook 60 attack payloads through `git`/`gh`/`mise`/`markgate` shims, recording every `-C <path>` asked for and asserting none carries a `$` or a backtick — this CANNOT see a gate that stopped firing, since a hook that exits early calls no `git -C` and satisfies the assertion vacuously; (3) a self-calibrating pair test — for every hook and verb, IF the gate blocks the plain literal target THEN it must refuse all six unreadable spellings AND still block the same target quoted with a space. Fence 3 is the only one that discriminates a gate going quiet, so its fixture stages a violation in the `-C` TARGET while leaving the payload cwd clean; without that the eleven content-judging gates never blocked the control, their pairs were skipped, and reverting one to the pre-fix defect left the whole file green. Its baseline is per-hook and recorded from measurement (16 named hooks), because an aggregate floor cannot say WHICH gate went quiet — the previous `>= 6` against an actual 9 stayed green with `check-gate` AND `branch-gate` reduced to `exit 0`.

Measured against a materialised `origin/main` hook directory, all four property assertions go red — fence 1: 17 hooks; fence 2: 16 poisoned resolutions; fence 3: 472 leaking hook/command/spelling pairs across 17 distinct hooks, plus 50 misses of a determinate quoted target path — while the population, floor and guard assertions stay green, which is what makes them evidence rather than decoration. The `origin/main` run also reports 681 `git -C` calls against 84 on the fixed tree: the fixed gates refuse before resolving, so the drop is the fix working, not the fence going quiet.

**THE SHAPE, and it is the finding that outlives this fix.** Three review rounds each ended the same way: a spelling the parser did not know about. Round 1 was `$VAR`; round 2 was a quoted path containing a space and `$( )`; round 3 was `gh -R` and a multi-line `$( )`. That is not bad luck. **These gates decide policy by pattern-matching shell TEXT, and shell grammar is not a regular language**, so the set of spellings that slip past is unbounded and each round removes only the ones someone thought to try. Every miss is silent, and every miss lands in the FAIL-OPEN direction, because a gate that does not recognise a command does not fire. The mitigation direction is to **over-approximate the TRIGGER and be strict on RESOLUTION**: a spelling-independent "does this segment contain a gated verb at all" test that errs toward considering the command, with `gate_target_dir_strict` — which already refuses whatever it cannot read — deciding the outcome. Today the trigger is the narrow half and the resolver is the strict half, which is exactly backwards, and it is why a narrowing bug in the trigger reads as "no problem found". The known remaining gaps below are instances of this one shape, not separate curiosities.

**The mitigation actually taken is a DIFFERENTIAL fence** — `.claude/hooks/lib/command-match-differential.test.sh`, per `/work-issues` section 5, which says a change to a CLASSIFIER cannot be fenced by hand-picked cases. The segmenter is exactly that: command text in, "which gates consider this and where does it resolve" out. Five rounds of hand-picked cases each changed the verdict for spellings nobody enumerated, and both regressions that reached review were found by diffing against the parent commit rather than by any test here. The fence runs the pre-#2027 implementation and the current one over a 127-input corpus — every shape from all five rounds plus families nobody had exercised (concatenated assignments, process substitution, heredocs, multi-line bodies, both quote characters unbalanced together, globs, degenerate inputs) — and compares the two observables a gate consumes: does each guarded verb ERE match, and what target does it resolve to. **Any differing cell that is not in an enumerated table fails**, and each allowed cell is pinned as `id + observable + NEW VALUE` rather than by input, because bucketing by input is how a regression gets waved through under a heading that says "intended". Per-class floors (NOW_MATCH 55, NOW_MISS 5, TARGET 8, SEGCOUNT 12) mean a corpus that stops covering a class is loud instead of reading like a clean run, and the baseline is a **vendored golden file** at `.claude/hooks/lib/testdata/command-match.baseline.sh`, pinned to a SHA rather than to `origin/main` — once this work merges, a ref-based baseline would compare the code to itself and report zero differences forever. It is VENDORED rather than read with `git show <sha>` because CI shallow-clones and the object is not in its store: the fence correctly refused to run there and said so in one line, but a fence that cannot run in CI is not a fence. The fixture is byte-identical to the blob (verified: sha256 `2af09c64…`) and its hash is re-checked on every run, so a drifted copy fails loudly instead of silently redefining what "unchanged" means. It lives under `testdata/` so neither `run-tests.sh` (globs `lib/*.test.sh`) nor the class fence (globs the hooks directory) picks it up — checked, and the class fence's population floor still counts 39. The table doubles as the changelog of intentional behaviour changes to the classifier: 88 cells across 32 inputs, all declared.

One assertion in that file is an INVARIANT rather than a case: **no non-empty command may segment to ZERO.** Zero segments means every gate considers nothing and all of them exit 0 at once, which is what one unbalanced apostrophe in a `--body` did after round 4 — `gh pr comment 1 --body "don't merge yet` + a newline + `git commit -m x` disarmed the entire system, a strictly worse failure than the bug this work was filed for. Three separate defects combined: a line ending inside a quoted span left the accumulator with no trailing separator, `gate_segments`' reader discarded that unterminated last line, and the END-rule retry cleared only ONE quote character so text with an unbalanced apostrophe AND an unbalanced double quote never recovered. All three are fixed; the invariant is what keeps them fixed.

**Remaining known gaps** (measured, deliberately not fixed here — a structural fix taken mid-cascade is how the next round happens):

- **Multi-line `$( )` still truncates.** `close_paren` scans within a single line, so `git -C $(<newline> git rev-parse --show-toplevel <newline>) commit -m x` splits into three segments, no verb matches, and `branch-gate` / `check-gate` both return 0. This is round 1's truncation surviving for the multi-line spelling; closing it means joining substitutions across lines in the segmenter, a third rewrite of the component that has already produced two rounds of blockers.
- **Substitution nesting deeper than 8** stops being scanned. The drain is bounded so a pathological input cannot spin; it now prints how many bytes went unscanned to stderr rather than dropping them silently, which makes the gap loud rather than invisible.
- **Ten hooks are exercised by no fence and have no per-hook case** — `cmd-parse-stub-gate`, `commit-prefix-scope-gate`, `integ-coverage-matrix-gate`, `internal-pr-labels-gate`, `pr-title-prefix-scope-gate`, `roundtrip-test-gate`, `bughunt-clean-gate`, `restore-backup`, `worktree-owner-gate`, `gh-label-validity-gate` — because no literal control could be constructed that makes them block from a clean cwd. Their conversion to the shared resolver is verified by reading, not by measurement.
- **`main-tree-branch-gate` reads the branch NAME out of a collapsed quoted span**, so `git switch "main"` blocks (safe direction) and `git checkout "feat/x"` passes. Quoted spellings nobody writes, stated rather than claimed away.
- **A bare `gh` segments to zero** — on the pre-#2027 implementation as well as the current one, so it is pre-existing rather than introduced. It is harmless (a bare `gh` runs nothing) and is the one case the zero-segment invariant excludes by name, so the exclusion cannot quietly widen.

Two classes are NO LONGER gaps, having been closed in review round 5. A **glob, a brace expansion or a `~user` prefix** in a `-C` or a `cd` is now treated as unreadable exactly like `$VAR`: the shell expands them and the commit lands in a real repo, while the parser cannot say which one, and the reverted "not a git repository" branch had been letting them through (`cd <wt>/.claude/worktrees/*/ && git commit` and `cd ~nobody/wt && git commit` both measured rc=0, now rc=2). A **leading `~/` or a bare `~` is deliberately NOT in that set**, because HOME is expanded here correctly and refusing it would be a false refusal.

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
