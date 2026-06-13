# Nested Stack 3-Level (4-deep recursive, bidirectional refs)

Integration test for deep recursive `cdk.NestedStack` handling — a
**4-level** tree (root → child → grandchild → great-grandchild) with
**bidirectional** cross-level references, deployed and destroyed through
cdkd's recursive `NestedStackProvider` and the v6 `<parent>~<childLogicalId>`
state-key layout.

This fixture is a strictly deeper + wider + bidirectional **superset** of the
existing [`nested-stack-deep`](../nested-stack-deep) fixture. Where
`nested-stack-deep` stops at 3 levels with one resource per level and only
bottom-up `Fn::GetAtt` output references, this fixture goes one level deeper,
adds a sibling resource at the branching grandchild level, and threads a
value top-down via nested-stack `Parameters` in addition to the bottom-up
`Fn::GetAtt` chain. The recursion shape is the same at any depth, but each
extra dimension (depth, width, the downward `Parameters` direction) is a place
the shallower fixtures cannot surface a gap.

## Configuration

```
CdkdNestedStack3LevelExample (root, depth=0)
├─ RootTopic                       (AWS::SNS::Topic — source of the DOWNWARD reference)
├─ RootRef                         (AWS::SSM::Parameter — value = Fn::GetAtt[Child, Outputs.<child-param>])
└─ Child                           (AWS::CloudFormation::Stack, depth=1)
   ├─ Param                        (AWS::SSM::Parameter — value = Fn::GetAtt[Grandchild, Outputs.<gc-param>])
   └─ Grandchild                   (AWS::CloudFormation::Stack, depth=2 — BRANCHING node)
      ├─ Topic                     (AWS::SNS::Topic — sibling of the nested-stack node)
      ├─ Param                     (AWS::SSM::Parameter — value = Fn::GetAtt[GreatGrandchild, Outputs.<ggc-param>] + sibling topic name)
      └─ GreatGrandchild           (AWS::CloudFormation::Stack, depth=3 — DEEPER than nested-stack-deep)
         └─ Param                  (AWS::SSM::Parameter — value carries the root topic name passed DOWN three boundaries)
```

- **6 resources across 4 levels**: 4 SSM Parameters + 2 SNS Topics. SSM is the
  cheapest cdkd-supported resource (synchronous create/delete, no IAM
  dependency, no eventual-consistency window); the two SNS topics add a second
  type and a sibling-of-the-nested-node DAG edge at the grandchild level
  while staying free and fast.
- **Bidirectional cross-level references**:
  - **UP** (`Fn::GetAtt` on nested-stack `Outputs`): the great-grandchild's
    parameter name bubbles up through the grandchild → child → root, so the
    root's `RootRef` transitively pulls the full 4-level chain. Exercises
    cdkd's `attributes['Outputs.<key>']` flat-key fast path at three
    boundaries.
  - **DOWN** (nested-stack `Parameters`): the root `RootTopic` name is threaded
    down all three boundaries as a synthesized `Parameter` on each
    `AWS::CloudFormation::Stack`, exercising cdkd's `NestedStackProvider`
    `Parameters` extraction + `DeployEngineOptions.parameters` forwarding. The
    bottom-up-only `nested-stack-deep` fixture never touches this path.

## How this exceeds `nested-stack-deep`

| Dimension                | `nested-stack-deep` | `nested-stack-3level` (this) |
| ------------------------ | ------------------- | ---------------------------- |
| Nesting depth            | 3 levels (depth 2)  | **4 levels (depth 3)**       |
| Resources per level      | 1 (SSM only)        | up to **2 + a branch** (SSM + SNS at the grandchild) |
| Reference directions     | bottom-up GetAtt    | **bottom-up GetAtt AND top-down Parameters** |
| state parent-link assert | not asserted        | **per-level `parentStack` / `parentLogicalId` read from S3** |
| `state list --tree`      | not asserted        | **asserts the 4-level hierarchy renders** |
| destroy cascade assert   | state-key-only      | **every level's AWS resource AND state file gone** |

## Features tested in cdkd

1. **Recursive deploy at depth = 3** — each `AWS::CloudFormation::Stack` node
   fires a nested `NestedStackProvider.create` → child `DeployEngine`, three
   levels down. Verifies the recursion has no fixed-depth assumption.
2. **State key derivation across 4 depths** — the v6 `<parent>~<logicalId>`
   join nests naturally, producing:
   - `s3://cdkd-state-{accountId}/cdkd/CdkdNestedStack3LevelExample/{region}/state.json`
   - `…/cdkd/CdkdNestedStack3LevelExample~Child/{region}/state.json`
   - `…/cdkd/CdkdNestedStack3LevelExample~Child~Grandchild/{region}/state.json`
   - `…/cdkd/CdkdNestedStack3LevelExample~Child~Grandchild~GreatGrandchild/{region}/state.json`
3. **v6 `parentStack` / `parentLogicalId` populated at each level** — verify.sh
   reads each child state file directly from S3 and asserts its parent link
   points one level up (root has none).
4. **Bidirectional output / parameter propagation** — the UP `Fn::GetAtt`
   chain and the DOWN `Parameters` forwarding both resolve across all three
   boundaries; verify.sh asserts the root topic name actually reached the
   great-grandchild's parameter value.
5. **`cdkd diff --recursive`** — clean against the freshly-deployed tree, and a
   changed great-grandchild value (env override, no second deploy) surfaces a
   `[~]` UPDATE under the `Nested stack: …~GreatGrandchild` header.
6. **`cdkd state list --tree`** — renders the full 4-level hierarchy with
   `tree(1)`-style box-drawing branches.
7. **Recursive destroy cascade** — `cdkd destroy` walks the reverse-DAG at each
   level; verify.sh asserts every level's SSM Parameter / SNS Topic is gone on
   AWS and every level's state file is removed.

## Deploy / destroy

```bash
# From the worktree root:
/run-integ nested-stack-3level
```

The skill runs `cdkd deploy` then `cdkd destroy` and verifies no orphan AWS
resources remain at `s3://cdkd-state-{accountId}/cdkd/`.

## Notes

- No `RemovalPolicy.DESTROY` is needed on SSM Parameters or SNS Topics — both
  are unconditionally removable at no charge, matching the broader integ
  fixture choice of cheap, synchronous resource types for depth tests.
- Cross-region nested stacks are out of scope (AWS doesn't support them) — the
  entire tree inherits the root's region.
- The `AWS::CloudFormation::Stack` logical ids are pinned to `Child` /
  `Grandchild` / `GreatGrandchild` via `overrideLogicalId` so the cdkd state
  keys stay readable; without this CDK auto-generates a `<Name>NestedStack…`
  compound id (see memory rule `feedback_cdk_nested_stack_overridelogical_id.md`).
