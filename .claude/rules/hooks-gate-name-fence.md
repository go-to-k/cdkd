---
description: cdkd gate-name class fence (markgate-gate-name-class.test.sh) - which marker each markgate-backed hook actually asks about
paths:
  - '.claude/hooks/markgate-gate-name-class.test.sh'
---

# The gate-name class fence

Moved verbatim out of [hooks-class-fences.md](hooks-class-fences.md) by
go-to-k/cdkd#3273, when that file's payload took `lib/command-match.sh` past its
120,000 B cap. Its subject is the markgate-backed hooks, not the shared matcher,
so it has no business loading on every edit to the matcher; hooks-class-fences.md
keeps a one-line pointer. Same precedent as
[hooks-cwd-detector.md](hooks-cwd-detector.md).

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
never ran. **`verify-pr-gate` belongs in that green-under-mutant list too**, and
the sentence that used to exempt it was WRONG — worth reading, because it was
wrong in the direction that RETIRES a fence. It said issue 2199's argv trace and
gate-name case made that hook's own suite catch the mutant, "23/0 clean and 22/1
mutated". Re-measured 2026-09-16 (go-to-k/cdkd#3209) by rewriting
`verify verify-pr` to `verify check` in the hook: the suite is **green, every
case** — on that branch and at 43/43 on `origin/main` — because the refusal path calls
`markgate status verify-pr`, a later case reaches it, and the suite's
`grep -qE '(^| )verify-pr( |$)'` over the accumulated argv trace is satisfied by
the `status` call. Only `markgate-gate-name-class.test.sh` reds. The tallies are
DELETED rather than re-derived (`/work-issues` verify.md 8-g); run
`bash .claude/hooks/verify-pr-gate.test.sh` for today's case count. An earlier
draft led with a stale `22/22` — the same failure one size smaller, and the
reason a per-suite exemption in a CLASS fence has to be re-measured, never
inherited.

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
