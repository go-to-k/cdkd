# Nested Stacks (`AWS::CloudFormation::Stack`) — Design

Tracking: [#459](https://github.com/go-to-k/cdkd/issues/459)
Status: **Design only — no code change in the same PR.**

This document grounds the implementation against (a) the AWS
`AWS::CloudFormation::Stack` resource type contract, (b) CDK 2.x
`cdk.NestedStack`'s actual synthesis output (verified via `cdk synth` on
2026-05-22 against `/Users/goto/pc/github/cdk-agc/test-cdk/cdk.out`),
and (c) the existing cdkd architecture documented in [CLAUDE.md](../../CLAUDE.md).
Where AWS / CDK semantics differ from a tempting "natural" cdkd shape,
the divergence is called out explicitly per the project's
"don't invent divergence" rule.

---

## 1. Goal & non-goals

### Goal (v1, this issue)

A CDK app containing `new cdk.NestedStack(this, 'Child', ...)` (or any other
construct that synthesizes `AWS::CloudFormation::Stack` — CDK CLI splits
big stacks implicitly when they exceed the 51,200-byte inline ceiling)
deploys cleanly via `cdkd deploy`. Specifically:

- `cdkd deploy <parent>` provisions the parent's own resources AND the
  child's resources, recursively.
- `cdkd destroy <parent>` removes both, in reverse-DAG order.
- `Ref <NestedStackLogicalId>` / `Fn::GetAtt: [<NestedStackLogicalId>,
  'Outputs.<Key>']` resolve correctly from the parent's resources.
- Recursive nesting (parent → child → grandchild) works.
- The CC API fallback that currently rejects this type with
  `Type AWS::CloudFormation::Stack is not supported` is gone.

### Non-goals (v1)

- **No `cdkd import` / `cdkd export` support for nested stacks** — the
  hard-block stays in the import / export commands; lifting it is the
  W4-6 follow-up. The block message is updated to point at this
  capability rather than at "not supported."
- **No `cdkd drift` cross-child summary** — drift works on a per-child
  basis (each child has its own state file, so `cdkd drift <child-state-key>`
  already works once the state is written), but a `cdkd drift <parent>`
  invocation that recursively shows every child's drift is deferred.
- **No real CloudFormation rollback-on-failure semantics** — CFn's
  contract is "if any nested-stack resource fails, the parent rollback
  cascades into every child." cdkd's per-resource partial-state-save
  semantics replace this: a child-resource failure leaves the rest of
  the child's already-completed resources alone, the user re-runs
  `cdkd deploy`. The divergence is documented in
  `docs/state-management.md` under "Nested stacks."
- **No `cdkd local invoke` / `local start-api` / `local run-task`
  targeting changes** — the existing CDK display-path matcher already
  supports `MyStack/MyNestedStack/MyHandler` shape paths once the
  child's resources are discoverable. Explicit verification + an integ
  fixture for it is deferred (covered transitively by the new
  nested-stack integ).
- **No cross-account / cross-region nested stacks** — AWS doesn't
  support them either; mention as out-of-scope so the implementation
  doesn't accidentally try.
- **No custom `NotificationARNs` / `TimeoutInMinutes`** — AWS
  `AWS::CloudFormation::Stack` accepts both as Properties. cdkd doesn't
  go through CFn so neither has any semantic equivalent here. The
  provider's `handledProperties` set explicitly excludes both (they
  become CC API fallback fodder — but since the provider is dedicated,
  the fallback never fires; instead the deploy engine surfaces a clear
  "unhandled property" warning).

### Won't do

- Adopting an existing CFn-managed nested stack into cdkd without
  destruction. The migration story is `cdk deploy` → `cdkd import` of
  the top-level stack only → leave the nested children to CFn until the
  W4-6 follow-up lands.

---

## 2. Decision matrix

The issue body argues for option A (treat as top-level stacks under
derived names) and rejects B (inline into parent state) + C (hybrid
CFn-for-nested). The design adopts A. The matrix is reproduced here so
the trade-offs are explicit for future readers.

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **A. Child = derived top-level stack** | Reuses cdkd's per-stack pipeline (lock, state, DAG, diff). No state-schema change beyond a parent pointer. `cdkd state list` / `state show` work out of the box for children. | Parent + child have linked-but-separate state files. The `Ref <NestedStack>` semantic is synthesized (no real CFn ARN). | **Chosen.** |
| B. Inline child resources into parent state | Single state file = simpler mental model. | Breaks every per-stack tool (`state list`, `state show`, `state destroy <child-only>`), and rebuilding DAG / diff to mix parent + child resources in one graph is a large refactor. | Reject. |
| C. cdkd provisions parent, CFn provisions children | Conceptually clean separation of concerns. | Two state systems in one deploy. Concurrent failure modes (cdkd locks the parent, CFn changeset is pending on the child). Requires cdkd bootstrap of a per-stack CFn role. | Reject. |

---

## 3. State layout

### Child state key

The issue proposes `<parent>~<NestedStackLogicalId>` as the child's
`stackName`-equivalent (using `~` as separator to avoid ambiguity with
CDK Stage paths which use `/`). This design adopts that proposal with
one refinement.

**Key shape:** `cdkd/<parentStackName>~<NestedStackLogicalId>/<region>/state.json`

Rationale:
- `~` is rare in CDK logical IDs (which are alphanumeric per the CDK
  contract). `/` was rejected because the S3 key already uses `/` as
  the region/path separator — `cdkd/MyStack/MyNested/us-east-1/state.json`
  would be ambiguous with a Stage-pathed top-level stack
  `MyStage/MyStack`. CDK Stage paths use `/` but never reach the S3
  state key because cdkd's existing layout uses the **physical** stack
  name (Stage-flattened to `MyStage-MyStack`) for that segment, never
  the display path.
- The parent's region is inherited. AWS does not support cross-region
  nested stacks (the `AWS::CloudFormation::Stack` resource lives in
  the same region as its parent), so this is safe.

### Schema bump: `version: 6`

New fields on `StackState` (additive — pre-v6 readers see undefined
and degrade gracefully):

```typescript
interface StackState {
  // ... existing fields ...
  /** Parent stack's physical name when this state record is a child. */
  parentStack?: string;
  /** The `AWS::CloudFormation::Stack` logical ID in the parent's template. */
  parentLogicalId?: string;
  /**
   * Region of the parent stack. Always equals `region` in v1 (AWS
   * cross-region nested stacks are unsupported) but recorded
   * explicitly so a future cross-region capability doesn't require
   * another schema bump.
   */
  parentRegion?: string;
}
```

**Migration:** v5 readers tolerate the missing fields (they default to
undefined), v6 writers always emit. An old binary reading v6 fails
clearly with the existing "Upgrade cdkd" error (the
`STATE_SCHEMA_VERSIONS_READABLE` mechanism already covers this — see
[src/types/state.ts](../../src/types/state.ts) `parseStateBody`).

`STATE_SCHEMA_VERSION_CURRENT` bumps to 6;
`STATE_SCHEMA_VERSIONS_READABLE` extends to `[1, 2, 3, 4, 5, 6]`.

### Parent's view of the child

In the parent's state record, the `AWS::CloudFormation::Stack` resource
is a normal entry under `resources[<NestedStackLogicalId>]`:

```typescript
{
  physicalId: 'arn:cdkd-local:us-east-1:123456789012:nested-stack/MyParent/MyChild',
  resourceType: 'AWS::CloudFormation::Stack',
  properties: { TemplateURL: '<resolved S3 URL>', Parameters: { ... } },
  attributes: {
    // Mirrors the child's `state.outputs` shape so Fn::GetAtt
    // 'Outputs.<Key>' resolves through the resolver's existing flat-key
    // lookup. Refreshed at the end of every child deploy.
    'Outputs.SomeKey': '<resolved value>',
    'Outputs.OtherKey': '<resolved value>',
  },
  dependencies: [ /* sibling parent-resources the child depends on */ ],
}
```

`physicalId` is a **synthesized ARN** with a fake `cdkd-local`
partition. AWS-side, `Ref` on a nested stack returns the real
`arn:aws:cloudformation:...:stack/MyChild-...UUID/...` ARN; cdkd does
not have a real ARN (no CFn stack exists). The fake partition is
load-bearing: any downstream resource that accidentally uses the value
as an AWS-side ARN fails loudly (`Invalid ARN partition: cdkd-local`)
rather than silently using a non-ARN string. Documented as a known
divergence under "Caveats."

---

## 4. Synthesis assembly walk

### Where the child template lives

Verified via `cdk synth` on 2026-05-22:

- Parent template `cdk.out/<ParentStack>.template.json` contains an
  `AWS::CloudFormation::Stack` resource whose `Properties.TemplateURL`
  is a `Fn::Join` over the bootstrap S3 asset bucket URL +
  `<sha-256-hash>.json`.
- Each resource carries `Metadata['aws:asset:path']: '<filename>.nested.template.json'`
  and `Metadata['aws:asset:property']: 'TemplateURL'`. These are the
  same hints CDK gives `cdk-assets-lib` to know which Properties field
  to overlay the resolved S3 URL onto.
- The actual child template is at
  `cdk.out/<filename>.nested.template.json` (next to the parent's
  template).
- The child's assets — its own Lambda bundles, Docker images, etc. —
  live in the **parent stack's** `.assets.json`. The nested template
  itself is also recorded as a `files` entry there (same shape Lambda
  zip files use).

### AssemblyReader changes

`StackInfo` gains an optional `nestedTemplates` field — a map from
`<NestedStackLogicalId>` to the local file path of the child template:

```typescript
interface StackInfo {
  // ... existing fields ...
  /**
   * Per-logical-id local file paths for every `AWS::CloudFormation::Stack`
   * resource in this stack's template. Resolved at synth-read time by
   * walking `template.Resources` and reading each resource's
   * `Metadata['aws:asset:path']`. Empty / undefined when the stack has
   * no nested stacks.
   *
   * Read recursively: a nested template can itself contain
   * `AWS::CloudFormation::Stack` resources whose `aws:asset:path`
   * points at a grand-nested template file in the same `cdk.out` dir.
   */
  nestedTemplates?: Record<string, string>;
}
```

`AssemblyReader.getAllStacks` does NOT recurse into nested templates
at synth-read time — they are siblings of the parent in `cdk.out`, not
separate Cloud Assembly artifacts (only CDK Stages are
`cdk:cloud-assembly`-typed nested manifests, which the existing code
already handles). The `NestedStackProvider` reads the nested template
itself when it fires, mirroring how `LambdaFunctionProvider` reads the
asset directory.

### Asset publish ordering

The parent's nested template is an entry in the parent's
`.assets.json`. cdkd's existing `AssetPublisher` already uploads every
file asset before the deploy DAG's first resource fires; no change
needed. By the time the `NestedStackProvider.create()` runs, the
resolved S3 URL (CDK substitutes it into `Properties.TemplateURL` via
`Fn::Join` over `Ref: AWS::URLSuffix` etc.) is a valid template the
child can fetch.

**The child's own assets** (Lambda bundles etc. that the child's
template references) are ALSO recorded in the parent's
`.assets.json` — CDK collapses every descendant's assets into the
top-level stack's asset manifest. So a single `AssetPublisher` pass
before the parent's DAG fires is sufficient for any depth of nesting.

---

## 5. Deploy lifecycle

### Order of operations

```
1. cdkd deploy MyParent
2. AssetPublisher uploads:
   - MyParent's own assets
   - MyChild's nested template (.nested.template.json) → S3 → resolved URL
   - MyChild's own assets (Lambda zips etc.) → S3
   - Any grandchild templates / assets
3. Parent's DAG fires:
   - Parent's own resources provision in event-driven DAG order
   - When the `AWS::CloudFormation::Stack` node's deps complete:
     - NestedStackProvider.create() reads the child template,
       acquires the child's lock at
       cdkd/MyParent~MyChild/us-east-1/lock.json,
       constructs a child DeployEngine,
       runs the child's full deploy synchronously (event-driven DAG,
         per-resource state saves, etc.),
       writes the child's state.json with parentStack=MyParent +
         parentLogicalId=MyChild,
       reads back the child's state.outputs into the parent's
         attributes map (for Fn::GetAtt: Outputs.<Key>),
       releases the child's lock,
       returns the synthesized ARN as physicalId.
   - Parent's remaining resources (those that depend on the nested
     stack via Ref / Fn::GetAtt: Outputs.X) proceed.
4. Parent's state.json is saved.
```

### Concurrency: parent / child locks

- Parent's lock is held throughout — cdkd's existing single-stack
  `LockManager.acquire(MyParent)` runs.
- Child's lock is acquired when the nested-stack DAG node fires,
  released when its deploy finishes. Concurrent `cdkd deploy MyParent`
  invocations are blocked at the parent's lock; concurrent
  `cdkd deploy <some-other-stack>` runs that happen to share no nested
  children proceed normally.
- **Lock-ordering hazard:** if user code (or a future feature) ever
  permits parent A → child X AND parent B → child X simultaneously, the
  two parents could deadlock. v1 is safe by construction (CDK
  `NestedStack` always belongs to exactly one parent, and the
  derived-name `<parent>~<logicalId>` is unique per parent), but the
  child lock acquisition uses the existing `LockManager.acquire`
  timeout (default 10s) so any future violation surfaces as a clean
  `LockAcquireTimeoutError` rather than a hang.

### DAG: parent → nested-stack node → consumers

The parent's `DagBuilder` treats the `AWS::CloudFormation::Stack`
resource as one DAG node — the child's sub-DAG is opaque to the
parent. Edges:

- **Outgoing from the nested-stack node:** every parent resource that
  has a `Ref <NestedStackLogicalId>` or `Fn::GetAtt:
  [<NestedStackLogicalId>, 'Outputs.X']` automatically gets an edge.
  This works today via `TemplateParser.extractRefsFromValue` — no
  change needed because the logical ID is just another resource ref.
- **Incoming to the nested-stack node:** every resource the child
  depends on via `Ref` / `Fn::GetAtt` in the child's
  `Properties.Parameters` block. The parent's resource → child-Parameter
  binding is on the `AWS::CloudFormation::Stack` resource's
  `Properties.Parameters` map, which `extractRefsFromValue` already
  handles transparently.

The `NestedStackProvider.create()` returns synchronously only after the
child's entire sub-DAG has completed (success or failure). This
preserves cdkd's "DAG node = atomic provision" contract from the
parent's perspective. If the child's deploy throws, the
nested-stack node throws, and the parent's normal rollback /
partial-state-save path runs.

### Pre-rollback state save

The child's state is saved via the child's own DeployEngine BEFORE
control returns to the parent. So even if the parent fails mid-flight
AFTER a child completes, the child's state survives — re-running
`cdkd deploy` continues from where it left off (child is `NO_CHANGE`,
parent retries its own failed resources).

---

## 6. `Ref` / `Fn::GetAtt` semantics

### Inside the parent

For `Ref <NestedStackLogicalId>`:
- AWS-side: returns the child stack's real ARN.
- cdkd-side: returns the synthesized ARN
  `arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<logicalId>`
  (from `state.resources[<logicalId>].physicalId`).
- The `IntrinsicFunctionResolver.constructAttribute` switch table gains
  no entry — `Ref` already falls through to `physicalId` correctly.

For `Fn::GetAtt: [<NestedStackLogicalId>, 'Outputs.<Key>']`:
- AWS-side: returns the child's CFn `Outputs.<Key>` value.
- cdkd-side: the parent's `state.resources[<logicalId>].attributes`
  carries a flat-key map (e.g. `'Outputs.BucketName': 'my-bucket-123'`),
  populated by `NestedStackProvider.create()` after the child's deploy
  finishes. The existing flat-dot-key lookup in
  `IntrinsicFunctionResolver.resolveGetAtt` resolves it without code
  change.
- The fallback nested-path walk (added in PR #381) covers the
  defense-in-depth case where the attributes are stored as a nested
  object (CC API shape) — the provider deliberately uses the flat-key
  shape so the fast path wins.

### Inside the child (Parameters)

The child's `Parameters` are populated from the parent's
`Properties.Parameters` map. cdkd already supports CloudFormation
Parameters (see "CloudFormation Parameters support" in
[docs/changelog-cdkd.md](../changelog-cdkd.md)), so the child DeployEngine instance just gets
the parent-resolved Parameters map as its `parameters` option.

### `Fn::ImportValue` from inside a nested child

A nested child can `Fn::ImportValue` an export from any cdkd-managed
stack — same plumbing as a top-level stack. The
`recordedImports` / `ExportIndexStore` mechanism records the import on
the CHILD's state record (so the child's destroy refusal works), but
the matching producer destroy refusal mechanism only walks state
records — it discovers the child's record naturally via `listStacks`.
No special-case needed.

### `Fn::GetStackOutput` cross-stack reads INTO a nested child

Same as above — `Fn::GetStackOutput { StackName: 'OtherStack' }` from
inside a child reads the producer's state record exactly as a
top-level stack would. The producer doesn't care whether its consumer
is a top-level or nested stack.

---

## 7. Destroy lifecycle

### `cdkd destroy <parent>`

```
1. Acquire parent's lock.
2. Load parent's state.
3. Walk parent.resources in reverse-DAG order:
   - For every AWS::CloudFormation::Stack entry:
     - Acquire child's lock (cdkd/<parent>~<childLogicalId>/...).
     - Load child's state.
     - Construct a child DeployEngine in DELETE mode.
     - Run child's full destroy (reverse-DAG, per-resource state saves).
     - Delete child's state.json + lock.json from S3.
     - Release child's lock.
   - Other resource types delete normally.
4. Delete parent's state.json.
5. Release parent's lock.
```

### `cdkd destroy <child-only>` rejection

Match CFn's "you can't directly destroy a nested stack" semantic. When
the user runs `cdkd destroy MyParent~MyChild` (or the equivalent state
key), the CLI refuses with a clear error pointing at the parent:

```
Error: stack 'MyParent~MyChild' is a nested child of 'MyParent';
       destroy the parent instead to cascade-delete this child, or
       run `cdkd state destroy MyParent~MyChild` (the state-only path)
       if you intentionally want to leave the parent's reference
       dangling.
```

The check fires in `destroy.ts` BEFORE lock acquisition by reading the
state's `parentStack` field (the v6 schema field). For pre-v6 state
written by a future migration tool, the check degrades gracefully —
state without `parentStack` is assumed to be a top-level stack
(matches every pre-v6 record). The `cdkd state destroy` escape hatch
deliberately bypasses the check (matches the existing "I know what
I'm doing" semantic).

### Destroy ordering inside the child

The child's reverse-DAG runs against its own resources only. Any
parent → child resource references (the parent has no resources that
the child depends on in the typical case, but the reverse is normal:
parent passes a Bucket name as a child Parameter; child consumes it)
are already on the parent side — destroying the parent's bucket
happens AFTER the child's destroy by virtue of the parent's
reverse-DAG node ordering. No new cross-stack ordering rules needed.

### `cdkd state destroy <parent>` (no synth, template-less)

Mirror behavior: walks parent's `state.resources` in reverse order,
and for each `AWS::CloudFormation::Stack` entry derives the child's
state key (`<parent>~<logicalId>` + `<region>`) and recurses into
`runDestroyForStack` against the child. Per `destroy-runner.ts`'s
existing single-source structure, this is one method addition rather
than a parallel implementation.

---

## 8. Update semantics

### Child template diff

The parent's DAG sees the `AWS::CloudFormation::Stack` resource's diff
as a `Properties.TemplateURL` + `Properties.Parameters` change (the
template URL changes when the child template's content hash changes,
because the S3 key embeds the hash). `DiffCalculator` already produces
this diff naturally.

`NestedStackProvider.update()` handles the change by:
1. Re-loading the new child template from `aws:asset:path`.
2. Constructing a child DeployEngine in UPDATE mode (the engine
   already runs CREATE / UPDATE / DELETE against the diff between
   child state + child template).
3. The child engine's own per-resource diff runs — adds, removes,
   updates resources individually.
4. If a child resource flips immutable property, it's CREATE → DELETE
   per cdkd's existing replacement-detection path.
5. The child's `state.outputs` is re-resolved, the parent's
   `attributes` map is refreshed.

### `Properties.Parameters` change without template change

If only the parent's `Properties.Parameters` map changes (template URL
unchanged), `DiffCalculator` still reports an UPDATE on the
nested-stack resource. The child engine runs against its existing
state + the new Parameters — most resources are NO_CHANGE (parameters
substitute into the same resolved property values most of the time),
but any resource whose Properties literally references a changed
parameter via `Ref` re-resolves.

### Whole-child replacement

If the user removes the `cdk.NestedStack` from CDK code entirely, the
parent's diff reports DELETE on the `AWS::CloudFormation::Stack`
resource. `NestedStackProvider.delete()` recursively destroys the
child (same as the destroy lifecycle above). State is cleaned up.

If the user adds a NEW nested stack, the parent's diff reports CREATE.
The child has no prior state — the child DeployEngine sees every
resource as a CREATE — same as a fresh deploy.

If the user renames a nested stack (changes the logical ID), it's a
template-side CREATE + DELETE pair. The parent's DAG sees both. The
new child is created (new state key), the old child is destroyed. AWS
resources are NOT reused — there is no rename semantic for nested
stacks today, matching CFn's own behavior.

---

## 9. Out-of-scope items (verbatim from issue + a few additions)

Per the issue's "Won't do" section:

- Real CFn rollback-on-failure cascades. cdkd's per-resource
  partial-state-save replaces it. Documented in
  `docs/state-management.md`.

Additions from this design:

- `NotificationARNs` Property — AWS CFn-only. cdkd has no SNS-on-stack-event
  surface and doesn't go through CFn. `handledProperties` excludes it;
  a value in the template surfaces a one-line warn at deploy time.
- `TimeoutInMinutes` Property — AWS CFn waits up to this duration for
  the child stack to complete. cdkd's equivalent is the per-resource
  `--resource-timeout` flag, which applies to each child resource
  individually. The parent's nested-stack DAG node inherits the global
  / per-type deadline like any other resource. A template-level
  `TimeoutInMinutes` is silently ignored (warn at deploy time).
- Cross-account / cross-region nested stacks. AWS doesn't support
  either. The provider rejects at create time with a clear error.

---

## 10. Migration story

### Stack already deployed via `cdk deploy`

A user wanting to switch a CDK app from `cdk deploy` to `cdkd deploy`
where the app has nested stacks:

**v1 path (this issue):** `cdk deploy` the stack, then run
`cdkd import --migrate-from-cloudformation <parent>`. The import
command's existing nested-stack rejection (`AWS::CloudFormation::Stack`
in the unsupported set) fires — same as today. The user is told:

> Nested stacks (`AWS::CloudFormation::Stack`) cannot be imported into
> cdkd in this release. Either: (a) refactor the CDK code to flatten
> the nested stack into the parent, redeploy via `cdk deploy`, then
> retry `cdkd import`; or (b) wait for the W4-6 follow-up to land
> nested-stack import support.

The reject path is preserved as-is. The block-message text is updated
to drop "not supported" — it IS supported for fresh deploys, just not
for adoption.

**W4-6 path (future PR):** `cdkd import --migrate-from-cloudformation
<parent>` recursively descends — for each nested stack in the parent's
CFn template, recovers the child stack's name from CFn's
`PhysicalResourceId` field, runs the import flow against the child,
writes the child's cdkd state record under `<parent>~<logicalId>`.
The post-state-write `retireCloudFormationStack` pass needs to inject
Retain on every nested child too, then DeleteStack on the parent (which
CASCADE-deletes the children's CFn records without touching AWS-side
resources).

### Stack already deployed via `cdkd deploy` (this design)

No migration needed — every deploy from v1 of this design forward uses
the new state schema and the new key layout. State written by an
earlier cdkd version has no nested stacks (because the type was
unsupported), so there's nothing to migrate from.

---

## 11. Caveats / known divergences from AWS

1. **Synthesized `Ref` ARN.** A resource that ingests the `Ref`
   value as a real AWS ARN will fail with `Invalid ARN partition:
   cdkd-local`. This is intentional — the cdkd-local-prefixed value
   should never reach an AWS API.
2. **No rollback cascade.** A child-resource failure leaves the child's
   already-completed resources in place (per-resource state save).
   The user re-runs `cdkd deploy` to converge. Documented under
   "Known Limitations" in CLAUDE.md.
3. **`TimeoutInMinutes` / `NotificationARNs` Properties silently
   ignored.** Documented above.
4. **No CFn-side change-set preview for the child.** `cdkd diff
   <parent>` shows the parent's `AWS::CloudFormation::Stack` diff
   (TemplateURL change, Parameters change). It does NOT recursively
   diff the child against the deployed child state in v1. This is a
   real gap relative to `cdk diff` and is filed as a v2 follow-up
   under the W4-6 umbrella.

---

## 12. Open questions

1. **Should the child's S3 lock be a separate object or piggyback on
   the parent's lock?** Design above uses a separate child lock. The
   alternative is to extend the parent's `lock.json` to cover all
   descendants. Sep-lock is simpler (each lock object is small,
   `IfMatch` semantics already work) but produces N lock objects per
   deploy. The recommendation is sep-lock + a follow-up to consolidate
   if S3 PUT cost becomes measurable on benchmarks.
2. **What's the right CLI surface for the user to view child state?**
   The derived name `<parent>~<logicalId>` works for `cdkd state
   show MyParent~MyChild`, but it's ugly. Options: (a) keep ugly,
   document; (b) add a `--show-nested` flag to `state show MyParent`
   that recursively prints children; (c) make `state show MyParent`
   ALWAYS recursively descend. Recommend (b) — least surprise for
   users who don't have nested stacks.
3. **Asset publishing of the child's TemplateURL — does cdkd's
   `AssetPublisher` already pick up the `aws:asset:path` →
   `aws:asset:property: TemplateURL` overlay?** Need to read
   `src/assets/asset-publisher.ts` (not loaded for this design doc)
   to confirm. The CDK convention is well-established (every nested
   stack uses this pair) so the existing publisher SHOULD work, but
   verification is the first implementation step.
4. **What happens when a child's deploy is interrupted (SIGINT)?**
   cdkd's existing SIGINT handler in DeployEngine catches the signal
   and triggers rollback. With nested children, SIGINT should cancel
   the child engine, run its rollback, then propagate up to the
   parent's engine. The plumbing exists (`InterruptedError`); the
   design just needs to make sure the parent's engine doesn't
   re-raise SIGINT before the child's rollback finishes. Defer the
   exact handshake to implementation.
5. **Should the v6 state schema bump be released independently before
   the NestedStackProvider lands?** Yes — schema changes are
   backward-compatible additions, and pre-releasing the reader gives
   users on older binaries a clean upgrade path before any v6 writer
   exists. Recommend a tiny prep PR that lands schema v6 +
   `parentStack` / `parentLogicalId` / `parentRegion` fields with no
   writer side, then the main PR adds the provider.

---

## 13. Implementation plan (sketch — not in scope for this PR)

To make the future implementation PR easier to review, the design
suggests this split:

1. **Prep PR — schema v6:** add `parentStack` / `parentLogicalId` /
   `parentRegion` to `StackState`. Update
   `STATE_SCHEMA_VERSION_CURRENT` + `STATE_SCHEMA_VERSIONS_READABLE`.
   No writer touches the new fields yet — they stay undefined.
2. **Main PR — `NestedStackProvider`:** create / update / delete /
   getAttribute. Register for `AWS::CloudFormation::Stack`. Recursive
   DeployEngine instantiation. Child lock acquisition. State key
   derivation. Real-AWS integ at `tests/integration/nested-stack/`
   (CDK app with one `cdk.NestedStack` containing 3 resources).
3. **Follow-up — recursive integ:** 3-level nesting integ at
   `tests/integration/nested-stack-deep/`.
4. **Follow-up — destroy guards:** `cdkd destroy <child-only>`
   rejection; `cdkd state list` parent→child tree rendering;
   `cdkd state show <parent> --show-nested`.
5. **Follow-up — W4-6:** nested-stack import / export.

---

## References

- AWS docs: [AWS::CloudFormation::Stack resource type](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-resource-cloudformation-stack.html)
- CDK 2.x source: `aws-cdk-lib/core/lib/nested-stack.ts` (verified
  synth output via `cdk synth` on 2026-05-22 against a real CDK 2.x
  app: parent's `AWS::CloudFormation::Stack` resource carries
  `Properties.TemplateURL: Fn::Join` + `Metadata['aws:asset:path']` +
  `Metadata['aws:asset:property']: 'TemplateURL'`; child template at
  `cdk.out/<filename>.nested.template.json`).
- cdkd architecture: [CLAUDE.md](../../CLAUDE.md), specifically the
  7-layer architecture diagram + the existing `IntrinsicFunctionResolver`
  / `DiffCalculator` / `LockManager` / `S3StateBackend` contracts.
- Related cdkd source surfaces:
  [src/types/state.ts](../../src/types/state.ts) (schema),
  [src/state/s3-state-backend.ts](../../src/state/s3-state-backend.ts)
  (key layout), [src/synthesis/assembly-reader.ts](../../src/synthesis/assembly-reader.ts)
  (artifact walk), [src/deployment/deploy-engine.ts](../../src/deployment/deploy-engine.ts)
  (engine), [src/provisioning/register-providers.ts](../../src/provisioning/register-providers.ts)
  (where the new provider registers),
  [src/cli/commands/import.ts](../../src/cli/commands/import.ts) +
  [src/cli/commands/export.ts](../../src/cli/commands/export.ts)
  (where the "nested stacks unsupported" hard-block currently lives).
