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
  nested child back to CloudFormation via a per-stack IMPORT loop
  (leaf-first; see §4.3) — each cdkd-managed stack becomes its own CFn
  stack, and non-leaf parents adopt their just-created CFn child stacks
  as nested references via the AWS-docs "Nest an existing stack" pattern.
  AWS resources are unchanged across the migration. The original
  "one atomic `--include-nested-stacks` IMPORT changeset" design was
  found infeasible by the 2026-05-24 spike (§4.0).

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
- **`CreateChangeSet --change-set-type IMPORT --include-nested-stacks`** —
  **NOT SUPPORTED by AWS** (empirically confirmed 2026-05-24 spike — see
  §4.0): AWS rejects this combination with
  `ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT`.
  The original §4.3 design ("one atomic --include-nested-stacks IMPORT
  changeset adopts the whole tree") is therefore infeasible. PR B2 uses
  the per-stack IMPORT loop in §4.3 instead, which submits a separate
  IMPORT changeset per stack in leaf-first order and uses the AWS-docs
  ["Nest an existing stack"](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html)
  pattern for non-leaf parents to adopt their just-created CFn child
  stacks as nested references.
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

### 4.0. AWS-side constraint discovered by 2026-05-24 spike

**Important:** the original §4.3 ("single atomic `--include-nested-stacks`
IMPORT changeset adopts the whole tree") is **infeasible** — empirically
verified against real AWS:

```text
$ aws cloudformation create-change-set \
    --stack-name SpikeCfnNestedAdopt \
    --change-set-name spike-test \
    --change-set-type IMPORT \
    --include-nested-stacks \
    --template-body file://parent.json \
    --resources-to-import file://leaf-resources.json \
    --region us-east-1

ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT.
```

The AWS docs page [resource-import-nested-stacks.html](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html)
states verbatim: "**CloudFormation only supports one level of nesting using
`resource import`.** This means that you can't import a stack into a child
stack or import a stack that has children."

What IS supported by AWS:

- "Nest an existing stack" pattern: an existing parent CFn stack can ADOPT
  an existing child CFn stack as a nested resource via IMPORT changeset. The
  parent's template is updated to add an `AWS::CloudFormation::Stack` resource
  with `DeletionPolicy: Retain`, and the IMPORT changeset's
  `ResourcesToImport[]` entry maps the row to the existing child's `StackId`.
- Plain per-stack IMPORT: each cdkd-managed stack can be IMPORTed into a
  fresh top-level CFn stack via a regular IMPORT changeset (the existing
  cdkd export code path for non-nested stacks already does this).

What is NOT supported:

- `--include-nested-stacks true` on an IMPORT changeset (AWS hard-rejects).
- Creating NEW nested-stack CFn records (via TemplateURL) in the same
  changeset that ADOPTS leaf resources.
- Importing a stack hierarchy beyond one level of nesting.

This rules out the original "one atomic changeset" design entirely. PR B2
must use the **per-stack IMPORT loop** in §4.3 below — submit a SEPARATE
IMPORT changeset for each stack in the tree, leaf-first, using the
AWS-docs "Nest an existing stack" pattern for non-leaf parents to bind
their just-created CFn child stacks as nested references.

PR B1 (#571) already shipped the state-tree walker
(`buildCdkdStateStackTree` / `flattenCdkdStateTreeLeafFirst`) and the
`nestedStackRows` branch in `buildImportPlan`. PR B2's per-stack loop
reuses both — they were designed compatibly with whichever submission
strategy AWS supports.

### 4.1. Walk

**Status: SHIPPED in PR B1 (#571)** — `buildCdkdStateStackTree(rootStackName, region, stateBackend)`
in [src/cli/commands/export.ts](../../src/cli/commands/export.ts)
recursively loads every child state file from
`cdkd/<parent>~<childLogicalId>/<region>/state.json`, fails fast on a
torn tree, and `flattenCdkdStateTreeLeafFirst` returns the tree in
leaf-first order — same order PR B2's per-stack IMPORT loop will use.

The `buildImportPlan` extension surfacing
`nestedStackRows: NestedStackRow[]` shipped in PR B1 too. Each row
carries `{ logicalId, childStackName }` — sufficient to drive the
per-stack loop.

### 4.2. Removal of `NEVER_IMPORTABLE_TYPES` gate

**Status: SHIPPED in PR B1 (#571)** — `AWS::CloudFormation::Stack` was
lifted from `NEVER_IMPORTABLE_TYPES` in
[src/cli/commands/export.ts](../../src/cli/commands/export.ts) and
routed through the dedicated branch in `buildImportPlan` that populates
`nestedStackRows: NestedStackRow[]`. The orchestrator currently
hard-errors (warns in `--dry-run`) with a clear PR B2 pointer when
`nestedStackRows.length > 0`.

PR B2 replaces the hard-error with the per-stack IMPORT loop in §4.3.

### 4.3. Per-stack IMPORT loop (REVISED 2026-05-24 per §4.0 spike)

**Algorithm**:

```text
walk leaf-first across the tree (using flattenCdkdStateTreeLeafFirst):
  for each stack S in leaf-first order:
    if S is a LEAF (no nested children of its own):
      submit a single-stack IMPORT changeset for S — same code path
      as today's non-nested export, no changes needed beyond:
        - the CFn stack name is derived from S.stackName via a
          configurable mapping (proposal: identity by default;
          `--cfn-stack-name <pattern>` can override per-child)
      record the resulting child CFn stack ARN keyed by S.stackName
    else (S is a NON-LEAF parent):
      synthesize S's template AS-IS from cdk.out
      for each `AWS::CloudFormation::Stack` row R in S.template.Resources:
        verify the corresponding child stack S' (where S'.parentLogicalId = R.logicalId)
          has been successfully IMPORTed in this loop iteration
        rewrite R.TemplateURL → the just-deployed child stack's actual
          template URL (cdk.out path uploaded via uploadCfnTemplate)
        add R to ResourcesToImport[] with:
          ResourceType: AWS::CloudFormation::Stack
          LogicalResourceId: R.logicalId  (bare — the row's own id in S.template)
          ResourceIdentifier: { StackId: <child stack ARN from prior loop step> }
        inject DeletionPolicy: Retain on R (so a parent-side rollback
          does NOT cascade-delete the child stack — design §3.4)
      add S's own leaf resources to ResourcesToImport[] via the
        existing buildImportPlan path
      submit single-stack IMPORT changeset for S
      record the resulting parent CFn stack ARN keyed by S.stackName
  on success of every stack: delete cdkd state leaf-first
```

This pattern matches the AWS-docs ["Nest an existing
stack"](https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/resource-import-nested-stacks.html#resource-import-nested-stacks-cli)
flow exactly — adopting an existing child CFn stack as a nested
reference of a (just-created via IMPORT) parent CFn stack.

**Per-changeset template handling**:

- Phase-1 preprocessing (Outputs strip, DeletionPolicy: Delete on leaves,
  ResourceIdentifier overlay) — applied PER stack, NOT once for the
  whole tree.
- Per-child template upload via `uploadCfnTemplate` — same helper PR A
  uses for the retire-CFn flow. Each stack's child-rewritten template is
  uploaded under `cdkd-migrate-tmp/<root-parent>/<ts>-<child-path>.{json,yaml}`
  for traceability; the cleanup contract is the same accumulator pattern
  PR A's `RecursiveRetainInjectionError` uses.

### 4.4. Phase 2 UPDATE (per stack)

For each stack S that contains Custom Resources (`Custom::*` or
`AWS::CloudFormation::CustomResource`), submit a phase-2 UPDATE
changeset for S alone — same as today's per-stack behavior. The
per-stack loop in §4.3 means phase-2 is also per-stack; no tree-wide
coordination needed.

### 4.5. State cleanup

**Order**: same leaf-first DFS as §4.3 — for each successfully-IMPORTed
stack, `stateBackend.deleteState(stackName, region)` after the parent's
IMPORT confirms.

**Failure semantics**: each per-stack IMPORT is independent. If leaf A
succeeds but its parent fails:

- A is now a standalone CFn stack (no longer nested under what was the
  cdkd parent)
- A's cdkd state IS deleted
- The cdkd parent's state IS preserved
- The error message names: A is on CFn; B (the parent) is still on cdkd
  with all its other leaf resources intact
- User recovery: re-run `cdkd export <parent>` once the underlying
  cause is fixed. The parent's `AWS::CloudFormation::Stack` row pointing
  at A will now adopt A as a nested reference (since A is an existing
  CFn stack).

This is strictly more user-friendly than the all-or-nothing atomic
design — partial success is observable AND recoverable.

### 4.6. Cross-stack consumer scan

**Status: scope-compatible with PR B1's existing
`scanCrossStackReferences`** — no design change. The scan walks every
cdkd stack in the CDK app and flags `Fn::GetStackOutput` references to
any stack in the family-being-exported (root or any child or
grandchild). Default warn; `--strict-cross-stack` refuses.

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

Hard-error at plan time. Message: ``Child stack `<ChildLogicalId>` uses
the `<MacroName>` macro. cdkd's export / import doesn't yet pre-expand
macros — tracking under issue W4-3. Remove the macro or wait for W4-3.``

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

## 9. Open questions — resolution log

### Blocked on #459 — all RESOLVED by #459 shipping

- Q1: Final separator in v6 state key — **RESOLVED**: `~` (per #459 PR
  #548 + verified in PR A integ).
- Q2: Exact shape of the synthesized cdkd-local ARN that
  `NestedStackProvider.create` writes for `Ref <NestedStack>` —
  **RESOLVED**: `arn:cdkd-local:<region>:<account>:nested-stack/<parent>/<logicalId>`
  (the `cdkd-local` partition is load-bearing per #459 design).
- Q3: Whether `cdkd state list` renders the tree (parent → child) or
  flat — **DEFERRED**: PR B does not need this; tree-rendering follow-up
  tracked under a separate issue.

### Independent of #459

- Q4: Upstream `cdk import` nested-stack semantics — **RESOLVED by PR A
  (#564) side-effect**: upstream `cdk import` does NOT walk recursively
  (per-stack invocation); cdkd's recursive walk is a deliberate
  divergence already documented under "Nested CloudFormation stacks"
  in [docs/import.md](../import.md).
- Q5: ~~Whether `cdkd export --include-nested-stacks` flag should be
  explicit or implicit~~ — **MOOT per 2026-05-24 spike** (§4.0): AWS
  rejects `IncludeNestedStacks` on IMPORT changesets entirely
  (`ValidationError: IncludeNestedStacks is not supported for changeSet
  type: IMPORT`). The flag does not exist in cdkd's surface as a result.
- Q6: Confirm `AWS::CloudFormation::Stack` `primaryIdentifier` is
  single-field `[StackId]` — **RESOLVED by PR A**: empirically confirmed
  single-field; no `COMPOSITE_ID_SPLITTERS` entry needed for
  AWS::CloudFormation::Stack.
- Q7: Test strategy for the post-import recursive
  `injectRetainPolicies` walk — **RESOLVED by PR A**: shipped at
  [tests/unit/cli/retire-cfn-stack.test.ts](../../tests/unit/cli/retire-cfn-stack.test.ts)
  (9 added tests covering flat / 3-level / parallel sibling fetch /
  partial-cleanup propagation) + real-AWS integ at
  [tests/integration/import-nested-stack/](../../tests/integration/import-nested-stack/).

### New open questions for PR B2 (per-stack IMPORT loop)

- Q8: CFn stack name mapping. Each cdkd-managed stack in the tree
  becomes its own CFn stack via PR B2's per-stack IMPORT loop. The
  cdkd stack name for a child is `<parent>~<childLogicalId>`. Does
  that name shape work for the CFn stack name field? CFn stack names
  must match `[a-zA-Z][-a-zA-Z0-9]*` (no `~` permitted). So a literal
  pass-through fails. **Proposal**: replace `~` with `-` for the CFn
  side: `<parent>-<childLogicalId>` (matches CFn's own auto-naming
  scheme `<Parent>-<ChildLogicalId>-<RandomSuffix>` minus the suffix).
  PR B2 must also surface a `--cfn-stack-name <root-name>=<cfn-name>`
  override per child for users who want explicit names.
- Q9: AWS-docs "Nest an existing stack" pattern requires the parent
  template's `AWS::CloudFormation::Stack` resource to have
  `DeletionPolicy: Retain`. PR B2's parent-IMPORT changeset must inject
  this. Does CFn validate that the row's `TemplateURL` matches the
  existing child stack's CURRENT template (the AWS-docs page implies
  "template-match validation" in §"Nested stack import validation")?
  PR B2 must upload each child stack's actual current template (read
  via CFn `GetTemplate` after the child IMPORT completes) to the
  parent's nested-stack `TemplateURL` field. The first integ run of
  `tests/integration/export-nested-stack/` will confirm.
- Q10: Phase-2 ordering. When stack S has Custom Resources AND nested
  children, does S's phase-2 UPDATE run before or after each child's
  phase-2 UPDATE? The natural extension of the per-stack loop is:
  each stack runs phase-1 IMPORT followed by phase-2 UPDATE before
  moving to the next stack. PR B2 should confirm this is correct
  via the integ (a fixture with a Custom Resource in a deeply-nested
  child).

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

Implementable PRs after #459 landed. Each is self-contained and
mergeable independently — `cdkd import` and `cdkd export` users have
disjoint migration directions.

1. **PR A** ✅ **shipped as #564**: `cdkd import --migrate-from-cloudformation`
   recursive support. Walks `DescribeStackResources` recursively, writes
   child state under v6 keys, recursively retires CFn at the end. ~400 LOC
   in `src/cli/commands/import.ts` + `src/cli/commands/retire-cfn-stack.ts`.
2. **PR B1** ✅ **shipped as #571**: `cdkd export` partial nested-stack
   support — state-tree walker + plan branch + hard-error UX. Lifts
   `AWS::CloudFormation::Stack` from `NEVER_IMPORTABLE_TYPES`; adds
   dedicated branch in `buildImportPlan` populating
   `nestedStackRows: NestedStackRow[]`; adds `buildCdkdStateStackTree`
   recursive state walker + `flattenCdkdStateTreeLeafFirst`; orchestrator
   hard-errors (warns in `--dry-run`) when nested-stack rows present.
   No CFn-side write path. ~700 LOC in `src/cli/commands/export.ts` + tests.
3. **PR B2** 🔄 **redesigned 2026-05-24 per §4.0 spike**: full `cdkd export`
   recursive support — per-stack IMPORT loop per §4.3 (leaf-first). NOT
   the original "one atomic --include-nested-stacks IMPORT changeset"
   design (AWS rejects that combination with
   `ValidationError: IncludeNestedStacks is not supported for changeSet type: IMPORT`).
   Each cdkd-managed stack in the tree becomes its own CFn stack via a
   separate IMPORT changeset; non-leaf parents use the AWS-docs "Nest
   an existing stack" pattern to adopt the just-created child CFn stacks
   as nested references. Estimated ~1000-1500 LOC + new
   `tests/integration/export-nested-stack/` real-AWS fixture + 3-axis
   review. Splittable into B2a (leaf-only IMPORT) + B2b (parent-with-nested
   IMPORT) if reviewer-load needs trimming.

PR B2 requires (a) CLAUDE.md updates removing the nested-stack deferral
comments from the `cdkd export` bullet, (b) a new entry in
[docs/changelog-cdkd.md](../changelog-cdkd.md), and (c) the integ
fixture above. The `NEVER_IMPORTABLE_TYPES` / `isPhase2CreatableType`
lift (§4.2) is ALREADY done in PR B1.

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
