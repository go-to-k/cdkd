---
description: cdkd diff and its recursive nested-stack walk - the helpers, the Outputs delta, the renderer, and the cycle refusal
paths:
  - 'src/cli/commands/diff.ts'
  - 'src/cli/commands/diff-recursive.ts'
---

# Key Files and Directories - `cdkd diff`

Split out of [layout-cli.md](layout-cli.md) under issue [#3245](https://github.com/go-to-k/cdkd/issues/3245): that file globs all of `src/cli/**`, so every CLI path paid for this entry, and the payload it feeds had run down to ~15 B of headroom.

Index of every area: [code-layout.md](code-layout.md).

## `src/cli/commands/diff-recursive.ts`

Recursive nested-stack diff helpers backing `cdkd diff --recursive` (issue [#555](https://github.com/go-to-k/cdkd/issues/555) A5). `diff.ts` is thin glue on top of them: synth → `buildDiffTree` per target stack → render / JSON / `--fail`.

`cdkd diff --fail` exits 1 on any change (CDK parity with `cdk diff --fail`). Plain `cdkd diff` exits 0, **or 3** when the preview finds a condition that would make `cdkd deploy` refuse to start — `DeployRefusalPreviewError` (`diff.ts`), thrown on `blockingCount > 0` independently of `--fail` and ranked above it. The old one-line entry this was split from said "always exits 0", which predates that code. NOT in the `integ-destroy` markgate scope (diff never destroys).

### `buildDiffTree`

Walks each `AWS::CloudFormation::Stack` row → child synth template + child state at `cdkd/<parent>~<childLogicalId>/<region>/state.json`, recursing into grandchildren.

Children are the **union** of template nested rows (CREATE/UPDATE, descend via template) and state-only nested rows (DELETE, descend via state vs empty template), so the tree previews the full next deploy.

**It refuses a nested template already on the root-to-node path** (issue [#3239](https://github.com/go-to-k/cdkd/issues/3239)). `indexNestedChildTemplates` refuses an ABSOLUTE `aws:asset:path`; a RELATIVE one closing a cycle took the other branch and was joined unconditionally. Three things about that guard are decisions rather than mechanics, and the code comment carries the derivations:

- A REFUSAL, not a depth cap — a cyclic assembly has no correct diff to render, so truncating would under-report changes the next deploy still makes. `cdkd state list --tree` answers the opposite way because its contract is that every record appears; see [layout-cli.md](layout-cli.md).
- The ANCESTOR CHAIN, not a global visited set — two sibling rows may legitimately name one child template, and a global set would refuse that diamond as a cycle.
- What the cycle cost was a DIAGNOSIS, not termination. The walk was always bounded: `loadStateOrEmpty` runs at every node against a `childStackName` that grows one `~<childLogicalId>` per level, so the 1024-byte S3 key limit stopped it — measured live at ~190 levels with `Your key is too long`, naming a stack that does not exist.

### `computeStackDiff`

The per-stack state-vs-template diff, extracted so the top-level loop and the walker share one impl; returns `{changes, outputChanges}`.

The `Outputs` delta is computed HERE rather than behind a second entry point because the parameter binding / condition evaluation below can issue SSM calls a second pass would pay for twice.

Mirrors the deploy engine's parameter/condition preprocessing best-effort — binds template `Parameters` defaults via `resolveParameters` with the nested-stack input parameters as user values, evaluates `Conditions`, prunes condition-false resources via `filterResourcesByCondition`, and threads `parameters` + `conditions` into the resolver context so `Ref` / `Fn::Sub` / `Fn::FindInMap` / `Fn::If` resolve like they do on deploy (issue #1027). Binding failures fall back to the raw-template diff.

### Template loaders

`readNestedTemplate` / `indexNestedChildTemplates` mirror `NestedStackProvider`'s private copies — duplicated to keep the CLI layer off the provisioning layer. Both refusals in this file route their interpolations through `displaySafe`, because each fires only on a hand-modified assembly and so every value in its message is attacker-controlled.

**They are the only two of four that do.** Grepping `Refusing to load|Refusing to diff` across `src/` finds this file's two, plus `src/provisioning/providers/nested-stack-provider.ts` and `src/synthesis/assembly-reader.ts` — neither of which sanitizes (`displaySafe` appears in neither file). Issue [#3277](https://github.com/go-to-k/cdkd/issues/3277) covers the `assembly-reader` copy only, so closing it does NOT shut the class; `nested-stack-provider.ts` is the one this very sentence points the reader at as what these loaders mirror. Near-variants in `export.ts` and `import.ts` are unsanitized too. Re-run that grep rather than trusting this count.

### Change detection and JSON

`nodeHasChanges` / `treeHasChanges` are the real-change detectors powering `--fail`. Both are also true for an Outputs-only delta, which is what stops such a change from printing `No changes detected` while the apply persists it and republishes the exports index (issue [#1921](https://github.com/go-to-k/cdkd/issues/1921)).

`diffTreeToJson` is the nested `--json` shape: `NO_CHANGE` dropped, `children` + `outputChanges` always present.

### Renderers

`renderOutputChangeLines` draws the `Outputs:` block — one row per PERSISTED bag key, so an output carrying an `Export.Name` shows a second `[export]`-tagged row, which is the string a consumer's `Fn::ImportValue` resolves against. Its counts go on their OWN summary line, because an Outputs write drives no AWS resource operation and must not inflate create/update/delete.

`renderChangeLines` / `renderDiffTree` are the human text renderer, moved out of `diff.ts` so they are unit-testable without the synth/AWS-client pipeline. Two behaviours there are deliberate:

- A property side whose WHOLE value is an unresolved intrinsic — a `Ref` / `Fn::GetAtt` to a resource the same deploy will CREATE — renders as the compact raw intrinsic annotated `(known after deploy)` instead of collapsing to `undefined`. The diff's best-effort resolver contexts set `ResolverContext.bestEffort`, so the resolver's Ref-not-found log is debug there and warn on deploy-time resolution (issue #1017).
- Nested-object property changes are pruned to the changed keys JOINTLY over both sides via `stripUnchangedValuePair`, so a pure key addition renders `old: {}` / `new: {AddedKey}` rather than full-old-object vs added-key-only, which reads as a removal of everything else (issue #1608).
