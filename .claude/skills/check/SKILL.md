---
name: check
description: Run local quality checks (typecheck, lint, build, tests). Quick check during development.
---

# Local Quality Check

Run all local quality checks. Use during development to verify the current
state quickly.

## Steps

Run these sequentially and report results:

0. **Worktree pre-flight**: `git fetch -q origin || echo 'FETCH FAILED --
   budget verdicts below are LOCAL-only'` first, then `mise trust` and
   `[ -d node_modules ] || pnpm install --frozen-lockfile`. The fetch is
   BEST-EFFORT and must not fail the step (offline, or no `origin`, exits
   128), but its failure is not free either: say so in the report, because
   the cumulative-budget verdict in step 4 then attests to your local ref
   rather than to the merge.

   **The fetch is what makes step 4's CUMULATIVE-BUDGET check mean anything.**
   `rule-file-payload.test.ts` projects this branch's delta onto the LOCAL
   `origin/main` ref (`skill-file-payload.test.ts` does NOT project — it
   measures the working tree, so its per-file caps carry this risk with no
   projection at all). A ref predating a peer's merge projects a merge that
   cannot happen. **A CI run carries the same staleness, because its base is
   frozen when the run STARTS**: measured 2026-09-06, go-to-k/cdkd#2695's run
   started 08:20:59Z, go-to-k/cdkd#2700 merged 08:22:04Z — 65 s later — and
   the run went green at 08:31:43Z having never seen it. Nothing re-ran it,
   and #2695 merged at 08:34:08Z, putting `main` 172 B over the rules-corpus
   ceiling with both PRs' CI green. So a green check attests to the base at
   its START, not at your merge: fetch and re-run before the LAST `/check` of
   a lane, and treat a summed-budget verdict as stale the moment a peer
   merges.

   `git worktree add` does NOT copy `node_modules`, and in a fresh worktree
   `vp check` fails with an UNNAMED `typescript(tsconfig-error): Invalid
   tsconfig — Cannot find type definition file for 'node'`, which reads like a
   broken fixture tsconfig. (`/verify-pr` step 0 has the same pre-flight; this
   copy exists because `/check` is usually the FIRST skill run in a fresh
   worktree.)

   **`mise trust` belongs here for the same reason, and its failure is worse
   because it lands on the LAST step rather than the first.** A fresh
   worktree's `.mise.toml` is untrusted, `node_modules` says nothing about
   that, and every check below passes — then the marker step's
   `mise exec -- markgate set check` dies with a config-PARSE error that names
   no file and never says "trust". The natural next move is to go and read
   `.mise.toml`, which is a dead end, and the lane cannot commit until it
   guesses. It is unconditional rather than guarded on a probe: `mise trust`
   on an already-trusted config is a no-op that prints
   `No untrusted config files found.`

   **Verify the marker by `markgate status`, never by an exit code** — the
   `mise ERROR` lines go to stderr and a pipeline's rc hides them, so a failed
   `markgate set` reads as a success and the next `git commit` is the first
   thing that disagrees.

   Every other skill that records a marker inherits this — `/check-docs`,
   `/verify-pr`, `/run-integ` and `/review-pr` all end in
   `mise exec -- markgate set`, so each carries a one-line pointer back here
   rather than a fifth copy of the paragraph.

1. `vp check --fix` — typecheck + lint + Prettier, with auto-fix. Then
   `vp run check` — the EXACT command CI's `check-build-test` job runs. The
   two are NOT equivalent: `vp check --fix` has passed 0-errors while
   `vp run check` failed with a TS7053 on the same tree (PR #1372). **Use
   this, not `vp run lint:fix`** — `lint:fix` does not touch Prettier, so a
   `lint:fix`-only run passes locally while CI fails `Formatting issues
   found` (PR #363). Run both; CI parity comes from the second.

2. `vp run typecheck:test` — type-checks `tsconfig.test.json` (`tests/**`).
   **`vp check` only type-checks `tsconfig.json` (src + types), which
   excludes `**/*.test.ts`** — a wrong `import type` or stale mock shape in a
   test file passes `vp check` AND `vp test` (whose "Type Errors" line covers
   only `*.test-d.ts`). This step matches how CI fails them (issue #1133).

3. `vp run build`

   **Before step 4, regenerate the generated artifacts — UNCONDITIONALLY,
   offline, seconds**:
   `vp run gen:all-matrices && vp run audit:coverage:check && vp run format`.
   The suite carries a byte-for-byte guard per generated matrix, and the
   trigger set is wider than any condition you would write — renaming a
   PRIVATE provider method stales `handled-property-wiring.json` (issue
   #1417's class); a `verify.sh` edit with no src change stales
   `cli-flag-coverage` (measured 2026-09-03: one private helper, two red
   cases, green after regeneration).

4. `vp test run` — the whole unit suite. **Prefer this over `vp run test`**:
   nothing sits between the caller and the verdict (the cached `vp run test`
   historically replayed without executing and could exit 0 having run
   NOTHING; both gone since `cache: false`, but the direct spelling stays the
   rule). Read the summary line, not just the exit code — and read its NUMBER,
   not its colour. **`Test Files N passed (N)` is self-consistent over a suite
   that LOST files before they ran**, so it cannot report its own shortfall:
   measured 2026-09-17 with several sessions loading the host,
   `Test Files 916 passed (916)` beside `Errors 148`, every one
   `[vitest-pool]: Failed to start forks worker`, against the 1065 the same
   tree collected once the host was quiet. The count's only external reference
   is the tree, so the block below DERIVES it rather than pinning a threshold
   that would drift (it also subsumes "no `Test Files` line at all": the
   extraction comes back empty and the comparison fails).
   `vp test run --maxWorkers=4` cleared it.

   **And check WHICH PROJECT the summary belongs to — the summary line cannot
   tell you.** Measured 2026-09-02 with several sessions running suites at
   once: three consecutive `vp test run` invocations from cdkd's worktree
   printed a **cdk-local worktree's** suite (246 files, a fraction of cdkd's),
   with `pwd` correct throughout. The tells: the `RUN <root>` header far above the
   summary, and a stray `vp run: cdk-local#test` line at the end. **The
   MECHANISM is unconfirmed — do not repeat a guess as fact** (ruled out:
   workspace links, an unpinned `vp`). Acting on the wrong summary sets the
   `check` marker (and through `requires`, `verify-pr`) over a suite that
   never ran — so assert the root in the same command that produces the
   verdict, and read the suite's own rc, not the trailing grep's:

   ```bash
   # Subshell so the `exit`s are safe to paste into an interactive shell.
   (
     log=$(mktemp)                     # NOT a fixed path: concurrent lanes
                                       # share /tmp, and a shared log lets one
                                       # lane read another's summary as its own.
     echo "log: $log"                  # print BEFORE the exits, or a failing
                                       # run's output is unrecoverable.
     vp test run > "$log" 2>&1; rc=$?
     # Exactly ONE header: two projects interleaved would let -m1 bind cdkd's
     # header while the summary grep prints both; zero means it never started.
     runs=$(grep -c 'RUN  v' "$log")
     [ "$runs" = 1 ] || { echo "expected 1 RUN header, found $runs -- attests to nothing; log: $log"; exit 1; }
     run_root=$(grep -m1 -oE "RUN  v[0-9.]+ .*" "$log" | sed 's/^RUN  v[0-9.]* //')
     [ "$run_root" = "$(pwd -P)" ] || { echo "WRONG PROJECT ($run_root) -- attests to nothing; log: $log"; exit 1; }
     # `Errors` is a DIFFERENT line from `Type Errors` (that one covers
     # *.test-d.ts alone), and it is where a dead pool worker reports. Without
     # it the grep reproduces three reassuring lines and hides the count that
     # explains the rc.
     #
     # Every alternative here is chosen against the COLOURED bytes, which is
     # the class `ci.yml`'s test-ran guard already failed a green run on.
     # vitest pads the label (`str.padStart(11) + ' '`) INSIDE the dim escape,
     # so `      Tests ` survives colouring while the tighter `Tests +[0-9]`
     # does NOT -- an escape sits between the label and the count. Same for
     # `Errors`: the `.*` is what crosses that escape, and `Errors +[0-9]+`
     # matches nothing. Measured both ways; do not "tighten" either one.
     grep -E "Test Files|      Tests |Type Errors|Errors.*[0-9]+ error" "$log"
     # rc FIRST, and the LOST-WORKER remedy belongs on THIS arm rather than on
     # the count arm below. vitest sets a non-zero exit for an unhandled error
     # and prints the `Errors` line only when there is one, so the founding
     # incident -- `Test Files 916 passed (916)` beside `Errors 148`, every one
     # `[vitest-pool]: Failed to start forks worker` -- ALWAYS lands here.
     #
     # The predicate is the pool's own PREFIX, and both halves of that are
     # measured rather than chosen. Anchoring on `[vitest-pool]` is what keeps
     # cdkd's `Failed to start metadata-endpoints sidecar: ...`
     # (src/local/ecs-network.ts, which interpolates a docker argv that can
     # carry `worker`) from claiming an ordinary test failure was a pool
     # problem. Matching the whole prefix rather than one message is what
     # covers the REST of the family, which a host under load produces just as
     # readily: `Failed to start <pool> worker`, `Timeout starting <pool>
     # runner`, `Worker <pool> emitted error`, `Timeout terminating <pool>
     # worker`, and `[vitest-pool-runner]: Timeout waiting for worker to
     # respond`. `--maxWorkers=4` is the remedy for all of them.
     if [ "$rc" != 0 ]; then
       echo "SUITE FAILED rc=$rc; log: $log"
       grep -qE '\[vitest-pool(-runner)?\]: ' "$log" \
         && echo "  the pool lost workers before their files ran, so the passing counts above cover only what survived -- re-run with --maxWorkers=4"
       exit 1
     fi
     # Only a run that exited 0 reaches here, so this is NOT the lost-worker
     # case. What it still catches is a run that collected fewer files than the
     # tree holds -- a stray filter left on the command line, or a narrowed
     # `include` -- which `Test Files N passed (N)` cannot report, being
     # self-consistent over whatever it did collect.
     #
     # Unanchored, and the LAST `(N)` on the line: the coloured summary ends in
     # `\e[39m`, not in `)`, so a `$` anchor extracts nothing and the comparison
     # below then false-FAILS a green suite. `tail -1` because a multi-line
     # value makes `[` a syntax error rather than a verdict.
     collected=$(grep 'Test Files' "$log" | grep -oE '\([0-9]+\)' | tail -1 | tr -d '()')
     # `:(glob)` on every pathspec: git's bare `**` demands an intervening `/`
     # while vitest's does not, so a depth-1 `tests/foo.test.ts` would be
     # collected and not listed, weakening the floor by one, silently.
     ondisk=$(git ls-files ':(glob)tests/**/*.test.ts' ':(glob)src/**/*.test.ts' \
       ':(glob)tests/**/*.test-d.ts' ':(glob)src/**/*.test-d.ts' | wc -l | tr -d ' ')
     # `-ge`, not `=`: an UNTRACKED new test file is collected but not listed,
     # which is legitimate and must not red. The direction that matters is
     # collected < tracked.
     [ "${collected:-0}" -ge "$ondisk" ] || { echo "COLLECTED ${collected:-none} of $ondisk tracked test files over a run that exited 0 -- attests to nothing. Usually a filter left on the command line or a narrowed include; a test deleted but not committed reads the same here. log: $log"; exit 1; }
   )
   ```

   It is contention-dependent, not sticky — re-running usually lands right. A
   single-FILE run reported the right project every time in the same window,
   so it can confirm which project you are addressing — **but it does NOT
   substitute for this step**: the marker requires a full-suite run that
   passed AND was rooted here.

## Output

Report as a table:

| Check | Result |
|-------|--------|
| typecheck + lint + format (`vp check --fix`) | pass/fail |
| test-project typecheck (`vp run typecheck:test`) | pass/fail |
| build | pass/fail |
| tests (N files, M tests) (`vp test run`) | pass/fail |

If all pass, confirm "All checks passed." If any fail, show the error output
and STOP — do not write the commit-gate marker.

## Commit-gate marker (on success only)

After all four checks pass, record the marker so the `check-gate` hook allows
the next `git commit`. The marker captures the working-tree state; subsequent
edits invalidate it.

**Merely CREATING a file inside a gate's scope stales that gate** — an
untracked file counts (the digest covers the scope's file SET; measured:
creating `tests/_probe.ts` flipped `markgate verify check` rc 0→1, deleting
it flipped it back; `docs` stayed 0 throughout because `tests/**` is not in
its scope). Correct behaviour, but the symptom is a `check-gate` refusal that
reads as "my markers randomly expired" — **re-run the skill; do not
investigate**. `/verify-pr` re-sets both markers in one shot.

Run from the repo root (`mise exec` because cdkd pins markgate via mise):

```bash
mise trust                          # unconditional; see step 0
mise exec -- markgate set check
mise exec -- markgate status | grep '^check' \
  || echo 'NO check LINE — markgate status itself failed' >&2
```

Skip this step if any check failed.
