# Design: recursive nested-stack support in `cdkd export` and `cdkd import`

Tracking issue: [#464](https://github.com/go-to-k/cdkd/issues/464)
Prerequisite: [#459](https://github.com/go-to-k/cdkd/issues/459) (nested-stack
deploy support, state schema v6 with `parentStack` / `parentLogicalId`
fields, `AWS::CloudFormation::Stack` SDK provider, state-key shape
`cdkd/<parent>~<child-logical-id>/<region>/state.json`).

This document extends the #459 baseline to the cdkd ↔ CloudFormation
migration paths (`cdkd import` and `cdkd export`). It does **not** redesign
nested-stack deploy / destroy semantics — those land first via #459 and are
assumed throughout.

## 1. Goal & non-goals

### Goal

After #459 lands, both `cdkd import --migrate-from-cloudformation` and
`cdkd export` walk nested-stack children recursively so that:

- **`cdkd import --migrate-from-cloudformation <ParentStack>`** adopts the
  parent CFn stack AND every nested child into cdkd state under the v6
  state-key shape, then runs the existing post-state-write retire-CFn dance
  on every nested stack in dependency order (leaves first, parent last).
- **`cdkd export <ParentStack>`** hands the cdkd-managed parent + every
  nested child back to CloudFormation in one atomic `--include-nested-stacks`
  IMPORT changeset; AWS resources are unchanged across the migration.

Both directions support arbitrary nesting depth (parent → child → grandchild).

### Non-goals (v1)

- **Partial migration** of one direction's children (e.g. exporting the
  parent but leaving one child as-cdkd, or importing the parent without one
  child). The cdkd ↔ CFn boundary is per-tree, not per-stack-in-tree —
  semantically inconsistent and rejected up front.
- **Child stacks whose template carries `Transform:`** macros. Chains into
  W4-3 (CFn round-trip pre-expansion). If W4-3 hasn't shipped, hard-error
  with a clear pointer to that issue.
- **Cross-account / cross-region nested children.** AWS itself forbids
  these (every child must be in the parent's account + region); cdkd
  doesn't need a guard, but the doc says so explicitly.
- **Standalone import / export of a leaf child** (`cdkd export
  ChildStackName`). Same shape as upstream CFn's "you can't directly
  operate on a nested stack" semantic — must start from the root parent.

## 2. Background: AWS contract recap

This section is the empirically-verifiable baseline that the design rests
on. Per memory rule `feedback_verify_cfn_semantics_empirically.md` and
`feedback_describe_type_before_cfn_handler.md`, each claim here must be
re-confirmed against AWS docs / API responses BEFORE implementation.

- **`AWS::CloudFormation::Stack` CFn schema**: `primaryIdentifier` is
  `[StackId]` (a single field — the stack's full ARN, e.g.
  `arn:aws:cloudformation:us-east-1:123456789012:stack/MyChild/abcd-uuid`).
  Not a composite, so no entry in `COMPOSITE_ID_SPLITTERS` is required.
  Mutable properties: `Parameters`, `NotificationARNs`, `Tags`,
  `TemplateURL`, `TimeoutInMinutes`. Pre-implementation: confirm via
  `aws cloudformation describe-type --type RESOURCE --type-name
  AWS::CloudFormation::Stack`.
- **`CreateChangeSet --change-set-type IMPORT --include-nested-stacks`**:
  CFn IMPORT changesets accept nested-stack children when
  `--include-nested-stacks` is passed. Each child's template is fetched
  from its `TemplateURL` (must be an S3 URL CFn can read with the caller's
  credentials, OR inline `TemplateBody` for the parent only). The
  changeset's `ResourcesToImport[]` lists EVERY adopted resource across
  the family, with each `ResourceIdentifier` mapping to the right
  resource. The whole tree IMPORTs atomically — partial failure rolls
  back the entire changeset.
- **`DescribeStackResources(<parent>)`** returns one row per top-level
  resource of `<parent>`, including each nested child as `ResourceType =
  'AWS::CloudFormation::Stack'` with `PhysicalResourceId = <child stack
  ARN>`. To enumerate grandchildren, recursively call
  `DescribeStackResources(<child ARN>)`.
- **Naming convention for nested children**: CFn auto-generates child
  stack names as `<Parent>-<ChildLogicalId>-<RandomSuffix>` (e.g.
  `MyApp-Database-1ABCDEF2GHIJ`). cdkd does NOT rely on the naming
  convention — it always uses the physical stack ARN returned by
  `DescribeStackResources`.

## 3. `cdkd import --migrate-from-cloudformation <ParentStack>` — recursive

### 3.1. Walk

After `getCloudFormationResourceMapping` recovers the parent's
`(logicalId, physicalId)` pairs:

1. For every row whose `ResourceType === 'AWS::CloudFormation::Stack'`,
   extract the `PhysicalResourceId` (the child's stack ARN) and the
   logical id (e.g. `Database`).
2. Recursively call `DescribeStackResources(<child ARN>)` to get the
   child's resource list. Repeat for grandchildren.
3. The synth template (input to `cdkd import`) must contain a matching
   `AWS::CloudFormation::Stack` resource at the same logical id; cdkd
   matches by logical id at every level. A mismatch (child exists on AWS
   but not in the synth template, or vice versa) hard-errors with the
   offending logical id named — same UX as upstream `cdk import` on a
   missing resource.

### 3.2. State writes

Each adopted CFn stack writes one cdkd state file:

- **Root parent**: `cdkd/<ParentStackName>/<region>/state.json` — same
  key shape `cdkd deploy` already uses, with new v6 fields
  `parentStack: undefined` / `parentLogicalId: undefined`.
- **Each nested child**: `cdkd/<ParentStackName>~<ChildLogicalId>/<region>/state.json`
  — the v6 state-key shape from #459. State carries `parentStack:
  '<ParentStackName>'` and `parentLogicalId: '<ChildLogicalId>'`.
- **Each grandchild**: `cdkd/<ParentStackName>~<ChildLogicalId>~<GrandchildLogicalId>/<region>/state.json`
  — recursion of the same shape. The `~` separator avoids ambiguity at
  every depth.

The root parent's state additionally records, for each nested child, a
state entry under the child's logical id whose `physicalId` is the
synthesized cdkd-local ARN (the same shape `NestedStackProvider.create`
would use post-#459 — `arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<LogicalId>`).
This is what `Ref <NestedStack>` in the parent's template resolves
against, and what the parent's destroy DAG walks to cascade.

### 3.3. Lock ordering

`cdkd import` acquires the lock per stack. The recursive walk must
acquire locks **leaves first, parent last** — same order the post-import
retire-CFn dance runs — so a concurrent `cdkd deploy` of a sibling can't
race the partial import. Per memory rule `feedback_destructive_state_test_coverage.md`,
the lock-release order on failure must be tested (a mid-walk error must
release every lock that was acquired).

### 3.4. Post-state-write CFn retirement

The existing `retireCloudFormationStack(...)` flow runs ONCE for the
root parent stack only:

- `DescribeStacks` → `GetTemplate` Original-stage → inject `DeletionPolicy:
  Retain` + `UpdateReplacePolicy: Retain` on every resource → `UpdateStack`
  → `DeleteStack` (CFn skips every resource because they're now Retain).
- AWS CFn's `DeleteStack` on a parent with nested children CASCADES into
  every child's DeleteStack call. Since every resource in every child also
  carries Retain (the Retain injection is recursive — see §3.4.1 below),
  the whole tree retires without deleting any AWS resource.

#### 3.4.1. Recursive Retain injection

`injectRetainPolicies` (in `retire-cfn-stack.ts`) walks the parent
template. When it encounters an `AWS::CloudFormation::Stack` resource:

1. It must ALSO `GetTemplate(<child stack name>)` and inject Retain on
   every resource in the child template.
2. The child template's resulting body is uploaded to S3 (the standard
   `uploadCfnTemplate` helper from `src/cli/upload-cfn-template.ts` — see
   the CLAUDE.md `cdkd export` bullet for the > 51,200-byte routing).
3. The parent template's `AWS::CloudFormation::Stack.Properties.TemplateURL`
   is rewritten to point at the new uploaded S3 URL.

Recursive: grandchildren go through the same dance. Every transient S3
upload is tracked in a single `cleanup[]` array that the parent's
`finally` block drains, so the success path AND every failure path
removes every transient object.

If injection touches NO resource in any template (every resource already
had both Retain policies), the parent's `UpdateStack` is skipped, exactly
like the non-nested case.

### 3.5. `--dry-run` semantics

Same as the non-nested case: incompatible with `--migrate-from-cloudformation`
(post-state-write retirement is a real side-effect). cdkd hard-errors at
parse time. Per memory rule `feedback_dry_run_permissive.md`, the rejection
is at parse-time so the user sees the gate before printPlan would run.

## 4. `cdkd export <ParentStack>` — recursive

### 4.1. Walk

After `buildImportPlan(...)` classifies the parent's resources, cdkd
walks `state.resources[<id>].resourceType === 'AWS::CloudFormation::Stack'`
entries:

1. For each nested child, derive its v6 state key
   (`<parent>~<child-logical-id>`) and load that child's state file.
2. Re-synth the child's template from the CDK app. (The cloud assembly
   already contains every nested child's template as a separate
   `<ChildAssetHash>.nested.template.json` file under `cdk.out` — see
   `AssemblyReader` for how cdkd already locates nested templates for
   deploy.)
3. Run `buildImportPlan` recursively against each child's state ×
   template.
4. Aggregate the plans into a single tree-shaped plan structure:
   `{ root: ParentPlan, children: { <ChildLogicalId>: ChildPlan, ... } }`.

### 4.2. Removal of `NEVER_IMPORTABLE_TYPES` gate

Two source-code sites currently hard-block `AWS::CloudFormation::Stack`:

- `src/cli/commands/import.ts` `NEVER_IMPORTABLE_TYPES` (line ~139).
- `src/cli/commands/export.ts` `isPhase2CreatableType` docstring (line
  ~1305) AND the parent `buildImportPlan` flow.

Both must be lifted post-#459, since `AWS::CloudFormation::Stack` IS
deployable (#459) AND importable into CFn via `--include-nested-stacks`
(this issue). The lift is gated: cdkd state schema v6 + at least one
nested-stack code path actually shipped. A pre-v6 binary attempting to
import a nested-stack-bearing template should fail clearly with an
"upgrade cdkd" error — same migration pattern as v1→v2 / v2→v3 / etc.

### 4.3. Submission

> **2026-05-24 update: the original "single `--include-nested-stacks`
> IMPORT changeset" design (numbered steps below) does NOT work
> against AWS. See §4.3.1 "AWS-API design constraints (empirically
> verified)" for the two constraints discovered, and §4.3.2 for the
> revised design follow-up issue.**

Original phase 1 IMPORT changeset design (does NOT work as of 2026-05-24):

1. The parent template gets the existing phase-1 preprocessing (strip
   Outputs, inject `DeletionPolicy: Delete`, overlay literal-mismatch
   `ResourceIdentifier` onto Properties — all unchanged).
2. Each child template gets the SAME phase-1 preprocessing.
3. Each child template is uploaded to S3 via the standard `uploadCfnTemplate`
   helper (single source of truth for the cdkd-migrate-tmp/ key prefix + the
   > 51,200-byte routing matrix — `<= 51,200` inline → reject (CFn requires
   `TemplateURL` for nested children), `(51,200, 1,048,576]` → S3 upload,
   `> 1,048,576` → hard-error). Nested children must always go via
   `TemplateURL` regardless of size, because CFn IMPORT's
   `--include-nested-stacks` requires each child's template to be
   reachable by URL.
4. The parent template's `AWS::CloudFormation::Stack.Properties.TemplateURL`
   is rewritten to the uploaded URL (parent goes inline OR via TemplateURL
   per the standard matrix).
5. `CreateChangeSet --change-set-type IMPORT --include-nested-stacks` is
   called with the parent's TemplateBody / TemplateURL and a single
   `ResourcesToImport[]` listing EVERY resource across the family (the
   root parent's resources + each nested child's resources, with each
   `LogicalResourceId` qualified by its parent stack path per CFn's
   nested-resource addressing). The CFn API resolves the addressing
   automatically when the parent template carries `AWS::CloudFormation::Stack`
   resources whose `TemplateURL` points at the child templates.
6. `waitUntilChangeSetCreateComplete` → `ExecuteChangeSet` →
   `waitUntilStackImportComplete` (a single waiter for the whole tree —
   AWS reports nested-stack IMPORT completion at the root only).

The transient S3 upload set is drained in `finally` (success AND every
failure path) — same cleanup contract the non-nested path already has.

### 4.3.1. AWS-API design constraints (empirically verified 2026-05-24)

The PR B2 implementation attempt against the live AWS API in
`us-east-1` surfaced **two hard constraints** that block both
candidate submission patterns:

1. **`CreateChangeSet --change-set-type IMPORT --include-nested-stacks true`
   is REJECTED** with the literal error:
   > `IncludeNestedStacks is not supported for changeSet type: IMPORT.`

   AWS only accepts `IncludeNestedStacks` on `CREATE` and `UPDATE`
   change set types, not on `IMPORT`. This rules out the original
   §4.3 design (single atomic changeset) entirely.

2. **Child-first IMPORT (the AWS-published alternative for adopting
   pre-existing CFn stacks as nested children) is REJECTED on the
   parent IMPORT** with the literal error:
   > `Stack arn:aws:cloudformation:<region>:<account>:stack/<child-name>/<uuid>`
   > `is not in an importable status, current stack status is IMPORT_COMPLETE.`

   AWS's "importable statuses" for an `AWS::CloudFormation::Stack`
   resource being IMPORTed as a nested child specifically EXCLUDE
   `IMPORT_COMPLETE` — the status a child stack lands in
   immediately after its own IMPORT changeset executes. The
   child-first pattern produces standalone children in exactly that
   excluded state, so the subsequent parent IMPORT fails.

Both constraints were verified by running the
[tests/integration/export-nested-stack/verify.sh](../../tests/integration/export-nested-stack/verify.sh)
fixture against real AWS — see the integ output captured under
issue tracking the PR B2 design follow-up.

### 4.3.2. Revised submission design (deferred to follow-up PR)

Until a working AWS-supported submission pattern is identified, PR B1
ships only the recursive cdkd-state-tree walker
(`buildCdkdStateStackTree` + `flattenCdkdStateTreeLeafFirst` + the
`nestedStackRows: NestedStackRow[]` branch in `buildImportPlan`) and
the orchestrator's hard-error path with a clear "PR B2 follow-up"
pointer + two workarounds (keep on cdkd, or destroy children
leaf-first and re-export the flattened parent).

PR B1.5 (this branch) adds the
[tests/integration/export-nested-stack/](../../tests/integration/export-nested-stack/)
real-AWS integ fixture that verifies the walker correctly handles a
real cdkd-state nested tree AND that the hard-error path surfaces
the documented "PR B2 follow-up" message — a regression test for
the deferred-submission UX so future code changes can't
accidentally re-block the path with a cryptic error.

Candidate follow-up directions to spike (none verified yet):

- **A) Empty UPDATE on the child between IMPORTs.** After IMPORT
  the child to `IMPORT_COMPLETE`, issue an empty UPDATE (e.g.
  re-submit the same template) to transition to `UPDATE_COMPLETE`,
  then attempt the parent IMPORT. Unverified whether
  `UPDATE_COMPLETE` is an acceptable "importable status" for
  nested-child adoption.
- **B) Delete + re-IMPORT into parent as a single operation.**
  Delete the standalone child stack (with `RetainResources`) and
  re-IMPORT its resources directly into the parent's IMPORT
  changeset (NOT as a nested-stack row). This loses the parent-child
  nested relationship at the CFn level — the parent ends up as a
  flat stack containing every leaf resource directly. Acceptable
  for users who don't need post-migration `cdk diff` parity with
  the CDK nested-stack code shape, but a semantic regression.
- **C) Manual CDK CLI fallback.** Document a multi-step user-driven
  recipe: `cdk import` each stack independently. Loses the
  bidirectional `cdkd export` ↔ `cdkd import` round-trip but
  unblocks users who need nested-stack stacks moved to CFn today.

The follow-up issue MUST run a spike against real AWS for each
candidate BEFORE attempting bulk implementation (per memory rule
`feedback_verify_cfn_semantics_empirically.md` — which the PR B2
attempt missed, and which directly caused the wasted
implementation-and-revert cycle documented here).

### 4.4. Phase 2 UPDATE

If any child contains a non-importable resource (`Custom::*`,
`AWS::CloudFormation::CustomResource`), the parent's phase-2 UPDATE
changeset re-submits the FULL synth template (Outputs restored, every
nested child's TemplateURL pointing at a fresh S3 upload). CFn CREATEs the
Custom Resources in whichever child they live in. This is just the
existing phase-2 behavior — the only extension is that the parent's
TemplateURL rewrite path must handle every nested child's template
upload, with the same `finally`-block cleanup.

### 4.5. State cleanup

On success, cdkd deletes state for every adopted stack in **leaf-first**
order — sibling-children, then deeper-children, then parent. Same lock
ordering as §3.3 (leaves first, parent last). On any failure mid-flow,
state is preserved for every stack whose CFn IMPORT didn't complete, and
the error message names exactly which stacks moved to CFn and which
remain on cdkd — so the user can finish manually.

### 4.6. Cross-stack consumer scan

The existing `Fn::GetStackOutput` cross-stack consumer scan extends to
the FULL family — any other cdkd stack referencing ANY stack in the
exported tree (root, child, grandchild) surfaces in the warn / strict
list. Default behavior is still warn; `--strict-cross-stack` refuses.

## 5. State schema dependency on #459

This design is bound to the state-key separator #459 picks. The design
assumes `~`, but the choice is owned by #459:

- The `~` separator avoids ambiguity with CDK Stage's `/` (already used
  in `<Stage>/<Stack>` display paths).
- The grandchild shape `<parent>~<child>~<grandchild>` keeps the
  separator consistent at every depth.
- `cdkd state list` (post-#459) is expected to render the tree shape:
  `MyApp` / `MyApp~Database` / `MyApp~Database~ReplicaShard` etc.

If #459 picks a different separator (e.g. `::` or `__`), every state-key
shape in this doc adopts that choice — no other change is required.

## 6. Resource IDs across nested boundary

- The `AWS::CloudFormation::Stack` resource itself has `physicalId =
  <stack ARN>` in the AWS world. In cdkd state, the root parent's state
  entry for the nested-stack resource carries the synthesized cdkd-local
  ARN (`arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<LogicalId>`)
  per #459's design — NOT the real AWS stack ARN. This is intentional:
  cdkd never invokes `Ref <NestedStack>` against AWS, only against state.
- For **import** (AWS → cdkd), the root parent's state entry for each
  nested-stack resource must be populated with the synthesized cdkd-local
  ARN (NOT the real AWS stack ARN recovered from `DescribeStackResources`).
  The real ARN is discarded after the walk — it's only used to navigate
  the recursion.
- For **export** (cdkd → CFn), the CFn IMPORT changeset's
  `ResourcesToImport[]` entry for each `AWS::CloudFormation::Stack`
  resource lists the field `StackId` mapped to the REAL AWS child stack
  ARN. cdkd has to discover the real ARN at export time — but since each
  child is ALREADY a CFn stack (we're handing cdkd state back to CFn,
  not creating new CFn stacks), the child ARN exists on AWS only AFTER
  the IMPORT changeset is executed. The `ResourcesToImport[]` entry for
  `AWS::CloudFormation::Stack` resources is the standard CFn "child stack
  will be created as part of this changeset" pattern — same as a normal
  `aws cloudformation create-stack` against a template with nested
  children. No pre-flight ARN lookup is needed.

## 7. Edge cases

### 7.1. Child stack with a `Transform:` macro

Hard-error at plan time. Message: "Child stack '<ChildLogicalId>' uses
the '<MacroName>' macro. cdkd's export / import doesn't yet pre-expand
macros — tracking under issue W4-3. Remove the macro or wait for W4-3."

### 7.2. Cyclic parent/child references

AWS's CFn API rejects cyclic nested-stack references at changeset create
time. cdkd does no preemptive validation — the changeset error message
is sufficient.

### 7.3. Mismatched depth between AWS and synth template

If `DescribeStackResources(<parent>)` reports a child at logical id `X`
that the synth template doesn't have, OR the synth template has a nested
stack at `Y` that AWS doesn't have, hard-error with the mismatched id
named. Same UX as upstream `cdk import` on a mismatched logical id.

### 7.4. Mixed Custom Resource locations

If a Custom Resource lives in a deeply-nested child (e.g. grandchild),
the `--include-non-importable` gate covers it the same way as a top-level
Custom Resource — phase 1 IMPORT skips it in whichever child it lives,
phase 2 UPDATE CREATEs it in the right child. The cdkd plan-printing
output groups Custom Resources by which child they live in for clarity.

### 7.5. Empty nested children

A `AWS::CloudFormation::Stack` resource with zero child resources is
legal on AWS (an "empty stack"). cdkd handles it: empty plan for that
child, the `AWS::CloudFormation::Stack` resource itself is the only
adopted entry at that level.

### 7.6. Partial import / export

If the user attempts to export the parent but the synth template's
nested child has a logical id mismatch from AWS, OR if cdkd state is
missing for a known nested child (suggesting an earlier partial import),
the run aborts with a clear pointer to either `cdkd import` (to recover
the missing child state) or `cdkd state orphan` (to drop the stale
child state and re-import).

## 8. Upstream `cdk import` parity check

Before implementation, verify upstream `cdk import`'s nested-stack
behavior empirically (per memory rule `feedback_cdk_cli_parity.md`):

- **Open question 1**: Does upstream `cdk import` walk nested children
  automatically, or does it require the user to invoke `cdk import` per
  child? Read `aws-cdk-cli`'s `import.ts` to confirm.
- **Open question 2**: What does upstream `cdk import` do when the
  parent stack contains a nested child whose template the user passes —
  does it submit one IMPORT changeset with `--include-nested-stacks`, or
  multiple per-child changesets?
- **Open question 3**: What `--resource` syntax does upstream use for
  nested-child resources? `cdk import --resource 'Database.UsersTable=arn:...'`
  with `.`-separator? Mirror the upstream syntax in cdkd's per-child
  resource override mapping so users have one less thing to learn.

If upstream operates per-stack (NOT recursive), cdkd's recursive behavior
is a deliberate divergence — document it in `docs/import.md` under the
"cdkd-specific" section alongside `auto` / `hybrid` modes and
`--migrate-from-cloudformation`, with rationale: "cdkd treats the
cdkd-managed boundary as the whole tree, not per-stack, because state
shape is one file per cdkd-managed CFn stack and partial migration would
leave the cdkd↔CFn boundary inside a parent-child relationship — a
state-consistency hazard."

## 9. Open questions (blocked on #459 vs independent)

### Blocked on #459

- Q1: Final separator in v6 state key (`~` vs `::` vs `__`). §5.
- Q2: Exact shape of the synthesized cdkd-local ARN that
  `NestedStackProvider.create` writes for `Ref <NestedStack>`. §6.
- Q3: Whether `cdkd state list` renders the tree (parent → child) or
  flat — affects how `cdkd export` plan-printing surfaces multi-level
  trees.

### Independent of #459

- Q4: Upstream `cdk import` nested-stack semantics (§8). Verify via
  `aws-cdk-cli` source before implementation.
- Q5: Whether `cdkd export --include-nested-stacks` flag should be
  explicit (matches CFn API surface; users may be familiar) or implicit
  (cdkd always passes it when any nested child is present). Default
  recommendation: **implicit** — fewer flags for users, matches
  `--include-non-importable`'s semantic.
- Q6: Confirm `AWS::CloudFormation::Stack` `primaryIdentifier` is
  single-field `[StackId]` via `aws cloudformation describe-type`
  (per memory rule `feedback_describe_type_before_cfn_handler.md`). If
  AWS publishes a composite primary identifier, add an entry to
  `COMPOSITE_ID_SPLITTERS` and update §2 + §6.
- Q7: Test strategy for the post-import recursive `injectRetainPolicies`
  walk — unit test with mocked `GetTemplate` returning a multi-level
  tree, plus the real-AWS integ described in §10.

## 10. Test strategy

### Unit tests

- `cdkd import --migrate-from-cloudformation`: mock `DescribeStacks` +
  `DescribeStackResources` returning a parent + 2 children (one of which
  has 1 grandchild); assert state written under all 4 keys with correct
  `parentStack` / `parentLogicalId` fields; assert lock acquire / release
  order is leaves-first; assert `injectRetainPolicies` is called for
  every template in the tree.
- `cdkd export`: mock CFn `CreateChangeSet` and assert the changeset is
  created with `IncludeNestedStacks: true`, the parent's TemplateURL is
  set, every child's template was uploaded to S3 under the
  `cdkd-migrate-tmp/<parent>/<ts>-<child-path>.{json,yaml}` prefix, and
  the transient S3 objects are deleted in `finally` (success AND failure
  paths).
- Edge cases per §7 (macro rejection, mismatched depth, empty children,
  mixed Custom Resource locations).

### Real-AWS integration

- New `tests/integration/export-nested-stack/`: CDK app with one
  `cdk.Stack` parent containing one `cdk.NestedStack` child (requires
  #459 for the initial deploy). Deploy → assert state written under
  both v6 keys → run `cdkd export` → assert both stacks present in CFn
  → run `aws cloudformation describe-stacks` to confirm nested
  relationship → run `cdk diff` to confirm clean → CFn `DeleteStack` to
  tear down.
- New `tests/integration/import-nested-stack/`: `cdk deploy` a parent +
  nested child → run `cdkd import --migrate-from-cloudformation
  <ParentName>` → assert state written under both v6 keys → run
  `cdkd destroy` → assert both CFn stacks deleted (the cdkd nested-stack
  delete path from #459 cascades).

Both integ tests are within the `integ-broad` gate's scope (touches
`src/cli/commands/import.ts` + `src/cli/commands/export.ts`) and must
flip both `integ-destroy` and `integ-broad` markers before the PR can
merge — per memory rule `feedback_cross_cutting_needs_broad_integ.md`.

## 11. Implementation order

Two implementable PRs after #459 lands. Each is self-contained and
mergeable independently — `cdkd import` and `cdkd export` users have
disjoint migration directions:

1. **PR A**: `cdkd import --migrate-from-cloudformation` recursive
   support. Walks `DescribeStackResources` recursively, writes child
   state under v6 keys, recursively retires CFn at the end. ~400 LOC
   in `src/cli/commands/import.ts` + `src/cli/commands/retire-cfn-stack.ts`.
2. **PR B**: `cdkd export` recursive support. Walks state +
   re-synth-fetches child templates, uploads each via `uploadCfnTemplate`,
   submits one `--include-nested-stacks` IMPORT changeset. ~500 LOC in
   `src/cli/commands/export.ts`.

Both PRs require:
- The `AWS::CloudFormation::Stack` removal from `NEVER_IMPORTABLE_TYPES`
  / `isPhase2CreatableType` (§4.2).
- CLAUDE.md updates removing the nested-stack deferral comments from
  both `cdkd import` and `cdkd export` bullets.
- One new entry in [docs/changelog-cdkd.md](../changelog-cdkd.md) per PR (the per-PR shipped-feature changelog, moved here from CLAUDE.md's "Recently Implemented" section).

## 12. Risks & mitigations

- **Risk: Recursive `GetTemplate` race during import retire.** If a
  human edits a nested child's CFn stack between `GetTemplate` and
  `UpdateStack`, the Retain injection is computed against stale template
  text. Mitigation: the import command already holds the cdkd state lock
  per stack; the CFn-side race is the same one the non-nested
  `--migrate-from-cloudformation` flow has and is documented in the
  existing rule "don't run concurrent operations against the migration
  target."
- **Risk: Atomic IMPORT changeset is hard to partially recover from.**
  AWS rolls back the whole tree on any failure — cdkd state is unchanged
  but the user may be left wondering which child failed. Mitigation: on
  IMPORT failure, cdkd fetches `DescribeStackEvents` for EVERY stack in
  the tree (root + each child by ARN) and surfaces per-stack failure
  reasons, not just the root rollback message. Same pattern the
  non-nested `cdkd export` already uses for surfacing per-resource
  failure reasons.
- **Risk: Templates over the 1 MB TemplateURL limit are unsubmittable.**
  Same hard-error as the non-nested case — cdkd surfaces the offending
  child template + size + the 1 MB ceiling, and the user must split or
  shrink. Mitigation: nothing automatic — this is structural.
- **Risk: A child template references the parent's `Ref` or `Fn::GetAtt`
  in a way the CFn IMPORT changeset can't resolve at adoption time.**
  CFn handles parent → child Ref / GetAtt natively via the parent's
  `Parameters` block on the `AWS::CloudFormation::Stack` resource —
  cdkd's job is to preserve the synth template's existing parameter
  passing, which the existing phase-1 preprocessing already does (it
  doesn't touch `AWS::CloudFormation::Stack.Properties.Parameters`).
  Mitigation: integ test covers this case end-to-end (§10).
