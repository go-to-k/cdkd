# Nested Stack Deep (3-level recursive)

Integration test for [issue #555](https://github.com/go-to-k/cdkd/issues/555) A1 —
3-level recursive `cdk.NestedStack` (parent → child → grandchild)
deployed and destroyed through cdkd's recursive `NestedStackProvider`.

Verifies the depth-of-nesting guarantee promised by issue [#459](https://github.com/go-to-k/cdkd/issues/459)
([design doc](../../../docs/design/459-nested-stacks.md) §1 "Recursive
nesting (parent → child → grandchild) works") that the single-level
`nested-stack` integ does not exercise — the recursion shape is the same
at any depth, but the v1 main PR shipped a 1-level test, leaving the
recursive case unverified against real AWS.

## Configuration

```
NestedStackDeep (parent, depth=0)
├─ ParentRef                       (AWS::SSM::Parameter — value = child.Param.parameterName)
└─ Child                           (AWS::CloudFormation::Stack, depth=1)
   ├─ Param                        (AWS::SSM::Parameter — value = grandchild.Param.parameterName)
   └─ Grandchild                   (AWS::CloudFormation::Stack, depth=2)
      └─ Param                     (AWS::SSM::Parameter)
```

- 3 SSM Parameters across 3 nesting levels — the cheapest cdkd-supported
  resource shape (synchronous create/delete, no IAM dependencies, no
  eventual-consistency window) so the deep run completes in well under
  a minute.
- 2 `Fn::GetAtt` boundaries: parent → middle (`Outputs.<child-param-name-key>`)
  AND middle → grandchild (`Outputs.<grandchild-param-name-key>`). Both
  exercise cdkd's `attributes['Outputs.<key>']` flat-key fast path.

## Features tested in cdkd

1. **Recursive deploy at depth = 2** — the `NestedStackProvider.create`
   that fires on the parent's `AWS::CloudFormation::Stack` node calls
   into a child `DeployEngine`. When THAT engine reaches the middle
   child's own nested-stack node, a second `NestedStackProvider.create`
   fires for the grandchild. Verifies the recursion does not depend on
   a fixed depth assumption anywhere in the code path.
2. **State key derivation across depths** — the v6 state schema uses
   `<parent>~<NestedStackLogicalId>` as the join, so the 3 state files
   land at:
   - `s3://cdkd-state-{accountId}/cdkd/NestedStackDeep/{region}/state.json`
   - `s3://cdkd-state-{accountId}/cdkd/NestedStackDeep~Child/{region}/state.json`
   - `s3://cdkd-state-{accountId}/cdkd/NestedStackDeep~Child~Grandchild/{region}/state.json`

   Verifies `~` nests naturally — the grandchild's parent name
   (`NestedStackDeep~Child`) already contains the prior `~`, and the
   join `${parentStackName}~${nestedLogicalId}` produces the expected
   compound key without ambiguity.
3. **Output propagation across two boundaries** — `parent.ParentRef`
   transitively pulls the grandchild's parameter name through the
   middle child via two CDK-synthesized `Fn::GetAtt` references.
   Verifies the child's `attributes` map is refreshed correctly at
   each level so the parent's intrinsic resolver sees a fully-resolved
   value (not an unresolved intrinsic) by the time its own resource
   deploys.
4. **Recursive destroy at depth = 2** — `cdkd destroy NestedStackDeep`
   walks the parent's reverse-DAG; its `NestedStackProvider.delete`
   recurses into the middle child's destroy, which in turn recurses
   into the grandchild's destroy. All 3 state files are removed.
5. **Schema v6 `parentStack` / `parentLogicalId` / `parentRegion`
   populated at each level** — both children record their parent (one
   level up), so a future `cdkd state list` tree view (A3) and
   `state show --show-nested` (A4) can reconstruct the full tree from
   the v6 fields alone.

## Deploy / destroy

```bash
# From the worktree root:
/run-integ nested-stack-deep
```

The skill runs `cdkd deploy` then `cdkd destroy` and verifies no
orphan AWS resources remain at `s3://cdkd-state-{accountId}/cdkd/`.

## Notes

- No `RemovalPolicy.DESTROY` is needed on SSM Parameters — they are
  unconditionally removable at no charge, matching the broader integ
  fixture choice of SSM over S3/IAM/etc. for minimal-cost depth tests
  (the single-level `nested-stack` integ adds S3 + IAM to exercise
  attribute-path resolution, which is already covered by the existing
  fixture; this integ targets the depth axis specifically).
- Cross-region nested stacks are out of scope per design §1 (AWS
  doesn't support them) — the entire tree inherits the parent's
  region.
- Parent template's `AWS::CloudFormation::Stack` for `Child` carries
  `Metadata['aws:asset:path']` pointing at the middle child's
  `.nested.template.json`; the middle child's `aws:asset:path` for
  `Grandchild` lives in the middle child's own template (NOT in the
  parent's). `NestedStackProvider.indexGrandchildTemplates` walks each
  level's template at runtime, so the recursion descends naturally.
