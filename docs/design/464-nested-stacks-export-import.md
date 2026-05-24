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

**Status: SHIPPED in PR B1 (#571)** — `AWS::CloudFormation::Stack` was
lifted from `NEVER_IMPORTABLE_TYPES` in
[src/cli/commands/export.ts](../../src/cli/commands/export.ts) and
routed through the dedicated branch in `buildImportPlan` that populates
`nestedStackRows: NestedStackRow[]`. The orchestrator's PR B1 hard-error
on `nestedStackRows.length > 0` has been replaced (PR B2) by the
per-stack IMPORT loop in §4.3.

### 4.3. Per-stack IMPORT loop (REVISED 2026-05-24 per §4.0 spike, FURTHER REVISED 2026-05-24 per real-AWS integ)

```text
walk leaf-first across the tree (using flattenCdkdStateTreeLeafFirst):
  for each stack S in leaf-first order:
    # ---- Phase 1A: leaves-only CREATE-via-IMPORT ----
    # Submit a single IMPORT changeset for S that includes ONLY S's leaf
    # resources (nested-stack rows excluded). S becomes a standalone CFn
    # stack in IMPORT_COMPLETE.
    submit a CREATE-via-IMPORT changeset:
      template = filterTemplateForImport(S.template, S.phase1Imports)
      ResourcesToImport[] = S.phase1Imports
      ChangeSetType = IMPORT
    record S's CFn stack ARN keyed by S.stackName

    # ---- Status flip to UPDATE_COMPLETE (non-root only) ----
    # AWS rejects IMPORT_COMPLETE as a non-importable status when
    # adopting S as a nested member of its own parent. A no-op tag-only
    # UpdateStack with --use-previous-template flips the status without
    # mutating any resources (only the stack-level Tags collection
    # changes — adds `cdkd:nested-export-flip: <ISO-timestamp>`).
    if S is not the root:
      UpdateStack(S.cfnName, UsePreviousTemplate=true,
                  Tags=[{cdkd:nested-export-flip: <now>}])

    # ---- Phase 1B: UPDATE-via-IMPORT to adopt nested children ----
    # Skipped for leaf stacks (no nested-stack rows in S.template).
    if S has nested-stack rows in its template:
      for each AWS::CloudFormation::Stack row R in S.template.Resources:
        verify the corresponding child stack S' (where S'.parentLogicalId = R.logicalId)
          has been successfully IMPORTed AND status-flipped in prior iterations
        fetch S'.cfnStack.currentTemplate via GetTemplate(TemplateStage=Processed)
        upload S' template via uploadCfnTemplate, get S3 URL
        fetch S'.cfnStack.currentTags via DescribeStacks  # includes the flip tag
        rewrite R.Properties.TemplateURL → uploaded S3 URL
        rewrite R.Properties.Tags → S'.cfnStack.currentTags  # AWS-side "Nested
          stack import validation" requires exact tag match — the flip-tag
          on S' must be forwarded into R.Properties.Tags or AWS rejects with
          "Tags of resource [<id>] defined in the template don't match..."
        inject DeletionPolicy: Retain on R  # AWS-docs "Nest an existing
          stack" requirement — a parent-side rollback must NOT cascade-
          delete the just-imported child stack
        add R to ResourcesToImport[] with:
          ResourceType: AWS::CloudFormation::Stack
          LogicalResourceId: R.logicalId
          ResourceIdentifier: { StackId: S'.cfnStackArn }
      submit IMPORT changeset against the EXISTING S.cfnName:
        template = phase1ATemplate + the rewritten nested-stack rows
        ResourcesToImport[] = only the nested-stack rows (S's leaves
          are already owned by S from Phase 1A and must NOT be re-listed)
        ChangeSetType = IMPORT  # AWS infers UPDATE-IMPORT from the existing stack

      # ---- Status flip back to UPDATE_COMPLETE (non-root only) ----
      # Phase 1B's IMPORT leaves S in IMPORT_COMPLETE again. If S is
      # itself a non-leaf child (will be adopted by ITS parent later),
      # flip back to UPDATE_COMPLETE the same way.
      if S is not the root:
        UpdateStack(S.cfnName, UsePreviousTemplate=true,
                    Tags=[{cdkd:nested-export-flip: <now>}])

  # ---- After every stack succeeds ----
  delete cdkd state leaf-first across the tree
```

**Why two phases per non-leaf parent (vs. one combined CREATE-via-IMPORT
that includes the nested-stack adoption)**:

The 2026-05-24 spike against real AWS surfaced two independent constraints
that ruled out the original "one IMPORT per stack" shape:

1. **AWS rejects CREATE-via-IMPORT with nested-stack adoption in the same
   changeset**: the AWS-docs ["Nest an existing
   stack"](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html)
   procedure explicitly assumes the parent stack is "an existing standalone
   stack" before the adoption changeset. Submitting `ChangeSetType: IMPORT`
   against a non-existent parent that includes both leaf-creation AND
   nested-stack adoption fails at changeset-create with `Stack <child-arn>
   is not in an importable status, current stack status is IMPORT_COMPLETE`.

2. **AWS rejects adopting a child stack in IMPORT_COMPLETE status**: the
   acceptable status set for "Nest an existing stack" is
   `CREATE_COMPLETE` / `UPDATE_COMPLETE` — NOT `IMPORT_COMPLETE`. Since
   our per-stack leaf IMPORT lands every child in `IMPORT_COMPLETE`, the
   child must be flipped to `UPDATE_COMPLETE` before its parent's Phase
   1B fires. A no-op tag-only `UpdateStack --use-previous-template`
   achieves the flip without mutating any underlying resources.

3. **AWS validates Tag equality on nested adoption**: the AWS-docs
   "Nested stack import validation" section requires "The tags for the
   nested AWS::CloudFormation::Stack definition in the parent stack
   template match the tags for the actual nested stack resource." The
   flip-tag added in step 2 lives on the child stack; the parent's
   nested-stack row's `Properties.Tags` must forward that tag verbatim
   or AWS rejects with `Tags of resource [<id>] defined in the template
   don't match...`. Phase 1B fetches the child's current tags via
   `DescribeStacks` and stitches them into the parent template's row.

- Phase-1A preprocessing (Outputs strip, DeletionPolicy: Delete on
  leaves, ResourceIdentifier overlay) — applied PER stack, NOT once
  for the whole tree.
- Per-child template upload via `uploadCfnTemplate` — same helper PR A
  uses for the retire-CFn flow. Each stack's child-rewritten template is
  uploaded under `cdkd-migrate-tmp/<parent>__nested__<childLogicalId>/<ts>.{json,yaml}`
  for traceability; the cleanup contract is the same accumulator pattern
  PR A's `RecursiveRetainInjectionError` uses.
- Phase-1B template = Phase-1A template + the nested-stack rows rewritten
  with `DeletionPolicy: Retain` + new `TemplateURL` + forwarded child Tags.
  Phase-1B's `ResourcesToImport[]` lists ONLY the nested-stack rows
  (the leaves are already owned by the parent from Phase 1A; re-listing
  them would cause AWS to reject the changeset).
- The transient S3 upload set is drained in `finally` (success AND every
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

### 4.3.2. Revised submission design (RESOLVED — SHIPPED in PR B2 via §4.3)

> **Status: superseded by §4.3 above.** PR B2 implemented candidate
> direction (A) below — empty UPDATE on the child between IMPORTs
> via the new `flipStackToUpdateComplete` helper. The flip uses a
> tag-only `UpdateStack --use-previous-template` to transition
> `IMPORT_COMPLETE` → `UPDATE_COMPLETE` without mutating any
> resources. AWS accepts the post-flip status as importable for
> nested-child adoption. The full 2-pass algorithm
> (Phase 1A CREATE-via-IMPORT leaves-only + Phase 1B
> UPDATE-via-IMPORT adoption) is documented in §4.3 and verified
> end-to-end against real AWS in
> [tests/integration/export-nested-stack/](../../tests/integration/export-nested-stack/).
> The section below is preserved for historical context — the
> deferral language is no longer current.

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
2. **PR B1** ✅ **shipped as #571**: `cdkd export` partial nested-stack
   support — state-tree walker + plan branch + hard-error UX. Lifts
   `AWS::CloudFormation::Stack` from `NEVER_IMPORTABLE_TYPES`; adds
   dedicated branch in `buildImportPlan` populating
   `nestedStackRows: NestedStackRow[]`; adds `buildCdkdStateStackTree`
   recursive state walker + `flattenCdkdStateTreeLeafFirst`; orchestrator
   hard-errors (warns in `--dry-run`) when nested-stack rows present.
   No CFn-side write path. ~700 LOC in `src/cli/commands/export.ts` + tests.
3. **PR B2** ✅ **shipped**: full `cdkd export` recursive support —
   per-stack IMPORT loop per §4.3 (leaf-first). NOT the original "one
   atomic --include-nested-stacks IMPORT changeset" design (AWS rejects
   that combination with
   `ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT`).
   Each cdkd-managed stack in the tree becomes its own CFn stack: leaf
   stacks via a single CREATE-via-IMPORT changeset; non-leaf parents via
   2 IMPORT changesets per parent (Phase 1A leaves-only CREATE-via-IMPORT
   to materialize the parent as a standalone CFn stack, Phase 1B
   UPDATE-via-IMPORT against the existing parent to adopt the
   already-IMPORTed children via the AWS-docs "Nest an existing stack"
   pattern — `DeletionPolicy: Retain` plus
   `ResourceIdentifier: { StackId: <child-cfn-arn> }` plus a rewritten
   `TemplateURL` pointing at the child's `GetTemplate(Processed)`
   output plus child-Tag forwarding per AWS's "Nested stack import
   validation"). Between Phase 1A and any adoption that references the
   stack as a child, cdkd flips the stack's status from
   `IMPORT_COMPLETE` to `UPDATE_COMPLETE` via a no-op tag-only
   `UpdateStack --use-previous-template` (the only status set AWS accepts
   for adoption is `CREATE_COMPLETE` / `UPDATE_COMPLETE`). Shipped: `runPerStackImportLoop` orchestrator in
   [src/cli/commands/export.ts](../../src/cli/commands/export.ts) plus
   the helper surface (`cdkd2cfnStackName` / `parseCfnChildStackNameOverrides`
   / `extractChildImportParameters` / `injectRetainAndRewriteTemplateUrl`
   / `buildPerStackImportNodes` / `submitImportChangeSet` /
   `fetchCfnStackTemplate`); new `--cfn-child-stack-name` CLI flag for
   per-child name overrides; new
   [tests/integration/export-nested-stack/](../../tests/integration/export-nested-stack/)
   real-AWS fixture (parent + 1 nested child, 2 SSM Parameters per
   stack) that asserts the IMPORT loop ends with both CFn stacks
   adopted via `DescribeStackResources(Child)` PhysicalResourceId =
   child stack ARN AND `DescribeStacks(<child-arn>).ParentId` /
   `RootId` matching the parent's ARN. Per-child Parameter resolution
   is literal-string-only for v1 — intrinsic-valued Parameters from
   the parent's `Properties.Parameters` block are skipped with a
   warning, and the child template's Parameter Defaults must cover
   them; full intrinsic resolution at leaf-IMPORT time is tracked as
   a follow-up.

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
