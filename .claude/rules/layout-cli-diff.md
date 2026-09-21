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
of template nested rows (CREATE/UPDATE) and state-only rows (DELETE, diffed
against an empty template).

**It refuses a nested template already on the root-to-node path** — a REFUSAL,
not a depth cap, since a cyclic assembly has no correct diff; keyed on the
ANCESTOR CHAIN, not a global visited set, since two siblings may name one child
([#3239](https://github.com/go-to-k/cdkd/issues/3239)).

`loadStateOrEmpty` holds the read-only container repairs
([state-malformed-properties.md](state-malformed-properties.md)).
`readNestedTemplate` / `indexNestedChildTemplates` duplicate
`NestedStackProvider`'s copies to keep the CLI off provisioning; their refusals
use `displaySafe`, as does the synth-time twin in `assembly-reader.ts`
([#3277](https://github.com/go-to-k/cdkd/issues/3277)). This file's OWN
`Nested template file not found` throw does not yet.

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
