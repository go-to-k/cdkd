---
description: cdkd diff and its nested-stack walk
paths:
  - 'src/cli/commands/diff.ts'
  - 'src/cli/commands/diff-recursive.ts'
---

# `cdkd diff`

`diff-recursive.ts` holds the recursive helpers; `diff.ts` is glue (synth,
`buildDiffTree` per stack, render / JSON / `--fail`). `--fail` exits 1 on any
change; plain `cdkd diff` exits 0, **or 3** when the preview finds a condition
that would make `cdkd deploy` refuse to start (`DeployRefusalPreviewError`, on
`blockingCount > 0`, ranked ABOVE `--fail`).

`buildDiffTree` walks each `AWS::CloudFormation::Stack` row to the child
template and its state at
`cdkd/<parent>~<childId>/<region>/state.json`. Children are the **union**
of CONDITION-PRUNED template nested rows (CREATE/UPDATE) and state-only rows
(DELETE, diffed against an empty template).

**It refuses a nested template already on the root-to-node path** — a REFUSAL,
not a depth cap, since a cyclic assembly has no correct diff; keyed on the
ANCESTOR CHAIN, not a global visited set, since two siblings may name one child
([#3239](https://github.com/go-to-k/cdkd/issues/3239)).

`loadStateOrEmpty` holds the read-only container repairs
([state-malformed-properties.md](state-malformed-properties.md)). Every
container it repairs or drops is a refusal on the deploy, so each returns a
`deployRefusals` reason; a DROPPED one (the `resources` bag or an entry, the
`orphans` container, and in `computeStackDiff` an `orphans` row) ALSO keeps its
`unreadable` row, so `--fail` and exit 3 overlap and exit 3 wins
([#3512](https://github.com/go-to-k/cdkd/issues/3512)). `computeStackDiff`'s SECOND
`properties` repair, over the records the rollback-orphan splice brought in,
returns its own under the same name. The TOP-LEVEL node puts one reason per
(REPAIR PASS × damaged container) on `blocking`, and `countBlocking` sums them:
a record whose `properties` maps and whose `outputs` bag are both torn reports
two from the load alone, and a record torn in both the load and the splice
reports two `properties` reasons. Each carries its own pass's record COUNT, so
two `properties` reasons read alike only when those counts match. That count is
what makes exit 3 rather than a silent 0
when the template declares nothing in the damaged container
([#3335](https://github.com/go-to-k/cdkd/issues/3335)). The splice arm is
returned rather than appended to `blocking` in place precisely so that ONE gate
governs both, and the root test is the explicit `isNestedChild` argument rather
than `ancestorTemplatePaths` being empty — that set is for CYCLE detection, and
keying the exit code on it would let a future caller unset exit 3 by seeding a
parameter that has nothing to do with the decision. One case diffs a damaged
ROOT with that set already populated, so the inference cannot be restored
silently. Nested nodes are excluded as a CONSERVATIVE choice rather than because
reachability is unknowable: the deploy skips an unchanged nested-stack row and
an attribute-only UPDATE, so a reason there would report a refusal over a deploy
that succeeds — while a CREATE row, a DELETE row or a property-changing UPDATE
does say the child is reached, which is where a later lane should start.
`readNestedTemplate` / `indexNestedChildTemplates` duplicate
`NestedStackProvider`'s copies to keep the CLI off provisioning; their refusals
use `displaySafe`, as does the synth-time twin in `assembly-reader.ts`
([#3277](https://github.com/go-to-k/cdkd/issues/3277)). Both twins run
`resolveAssemblyPath` beside their absolute-path tripwire, against the PARENT
TEMPLATE's directory — CDK emits nested templates as siblings, so the base is
that directory and not the assembly root
([#3489](https://github.com/go-to-k/cdkd/issues/3489)). This file's OWN
`Nested template file not found` throw does not yet.

`indexNestedChildTemplates` builds onto `nullPrototypeRecord()`, never a `{}`
literal, as does `diff.ts`'s `??` fallback for a stack with no indexable row: a
plain object drops a row named `__proto__` AND answers `buildDiffTree`'s
`if (!childTemplatePath)` with an inherited member, which `defineOwnKey` would
not fix ([own-keys.md](own-keys.md),
[#3480](https://github.com/go-to-k/cdkd/issues/3480)).

`computeStackDiff` is the per-stack state-vs-template diff shared by the
top-level loop and the walker. Its `Outputs` delta is computed HERE, not behind
a second entry point, because parameter binding and condition evaluation issue
SSM calls a second pass would pay twice. It mirrors the deploy engine's
preprocessing best-effort, falling back to the raw template on failure.

- `nodeHasChanges` / `treeHasChanges` power `--fail`, and are true for an
  Outputs-ONLY delta too — else it prints `No changes detected` while the apply
  persists it and republishes exports.
- `renderOutputChangeLines` draws one row per PERSISTED bag key, so an
  `Export.Name` adds an `[export]` row; its counts get their OWN summary line,
  since an Outputs write drives no resource op.
- A property side whose WHOLE value is an unresolved intrinsic renders as that
  raw intrinsic marked `(known after deploy)`, not `undefined`.
- Nested-object changes are pruned to the changed keys JOINTLY over both sides
  (`stripUnchangedValuePair`), so a key addition renders `old: {}` /
  `new: {AddedKey}`, not as a removal.
