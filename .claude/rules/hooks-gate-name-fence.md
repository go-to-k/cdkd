---
description: cdkd gate-name class fence (markgate-gate-name-class.test.sh) - which marker each markgate-backed hook actually asks about
paths:
  - '.claude/hooks/markgate-gate-name-class.test.sh'
---

# The gate-name class fence

Moved out of [hooks-class-fences.md](hooks-class-fences.md) by
go-to-k/cdkd#3273, when that file's payload took `lib/command-match.sh` past its
120,000 B cap. Its subject is the markgate-backed hooks, not the shared matcher,
so it has no business loading on every edit to the matcher; hooks-class-fences.md
keeps a one-line pointer.

## The gate-name class fence (issue 2198)

`.claude/hooks/markgate-gate-name-class.test.sh` asserts, for every
markgate-backed hook, WHICH GATE it asks its verifier about. Nothing did before:
every per-hook suite asserted an exit code and a few asserted the cwd markgate
ran in, and a gate pointed at the wrong marker is **indistinguishable from a
working one from the outside** — same exit codes, same messages, same cwd. Only
the argv separates them.

Measured by rewriting each hook's `markgate verify <gate>` to `verify BOGUS-GATE`
and running that hook's own suite: every suite stayed GREEN, `integ-destroy-gate`
at 20/20 among them. Concretely, a gate swapped onto another repo-wide marker
passes whenever THAT marker is fresh, merging a PR whose own verification never
ran. The per-suite tallies of the retired gates are deleted rather than carried
(`/work-issues` verify.md 8-g); the point that survives is the SHAPE — an
exemption claimed for one hook's own suite was re-measured and found wrong,
because its refusal path made a second markgate call whose argv satisfied the
suite's own grep. **Re-measure a per-suite exemption in a CLASS fence; never
inherit one.**

**`integ-destroy` is the only markgate gate left**, so the table holds one row.
The fence is deliberately NOT retired for that: its whole value is catching the
SECOND one, written by someone who never read this file.

**The population is derived from BEHAVIOUR, not from the hook text**, and that is
the part worth copying. All three textual predicates were tried and all three are
wrong: `grep -l 'markgate verify'` misses gates that invoke the binary as
`"${markgate[@]}" verify <gate>`, where no literal `markgate verify` appears on
any line; `grep -l markgate` finds ~20, because almost every gate reads
`.markgate.yml` for the repo opt-in check; and stripping comments does NOT
exclude `main-tree-git-cwd-detector`, which carries
`markgate[[:space:]]+(set|verify)` inside a REGEX STRING, since detecting
markgate commands is its job (it is the one DECLARED non-verifier). So the
CANDIDATE list comes from `.claude/settings.json` — the only authoritative
statement of what is a hook — and each candidate is RUN under a markgate shim
that records its argv. The directory listing is deliberately NOT the candidate
list: `run-tests.sh` is the aggregate suite RUNNER, so driving it re-runs every
suite once per probe payload, and a first version of this file had to be killed
after twenty minutes.

Four fences, and fence 3 is what makes the first two mean anything:

- **fence 1** — every hook in the table asks about the gate the table names, and
  about NOTHING ELSE. Subset-only was the whole assertion until review: a gate
  that ACQUIRES a second marker (`verify integ-destroy || verify check`, the
  shape that turns a specific gate into a permissive one) was unfenced.
- **fence 2** — the table and the observed population agree in BOTH directions,
  so a new markgate-backed hook with no table entry fails, and so does a table
  entry for a hook that no longer verifies anything.
- **fence 3** — the probes actually REACH the markgate call. A gate that
  scope-checks the PR diff returns before verifying anything, so without this the
  file would report green over nothing.
- **fence 4** — the markgate rc-2 ("could not evaluate") branch sits at an
  EARLIER line than the alias refusal. Static by necessity; the reasoning is in
  [gate-sibling-repos.md](gate-sibling-repos.md).

**Reaching the call was most of the work**, and each blocker was a failure in the
green direction caught by fence 3 rather than passing as "verified". The
surviving instance: gates read their scope from `gh pr view --json files`, not
from `gh pr diff --name-only`, so a generic `files` array makes a gate decide the
PR is out of scope. The retired gates contributed three more, each a variation on
the same theme — a `markgate --version` probe the shim did not answer, a
per-FILE hunk split that a header-less diff line belongs to no file in, and a
`status` call conflated with a `verify` one.

A fifth blocker was in the fence's own instrument: the argv extraction used BRE
`\(verify\|status\)`, and `\|` is a GNU extension, so on macOS it silently
matched nothing and EVERY hook reported "asked about []" — the fence reporting
its own broken tool as a total failure of its subject. `sed -E` throughout.

Mutation-probed per gate rather than in aggregate: repointing a gate at another
marker fails fence 1 naming that gate and its wrong marker, with a clean control
before and after.
