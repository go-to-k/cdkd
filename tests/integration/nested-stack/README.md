# Nested Stack Example

Integration test for [issue #459](https://github.com/go-to-k/cdkd/issues/459) —
`AWS::CloudFormation::Stack` (via CDK's `cdk.NestedStack`) deployed and
destroyed through cdkd's recursive `NestedStackProvider`.

## Configuration

```
NestedStackExample (parent)
├─ ParentReferenceToChildBucket  (AWS::SSM::Parameter, references child output)
└─ Child  (AWS::CloudFormation::Stack)
   ├─ Bucket  (AWS::S3::Bucket)
   ├─ Role    (AWS::IAM::Role)
   └─ Param   (AWS::SSM::Parameter)
```

- 1 nested stack (`Child`) containing exactly 3 resources (S3 Bucket /
  IAM Role / SSM Parameter), matching the design doc's minimum-shape
  verification surface ([docs/design/459-nested-stacks.md](../../../docs/design/459-nested-stacks.md) §13).
- 1 parent-side SSM Parameter that references the child bucket's name
  via `Fn::GetAtt: [Child, 'Outputs.<key>']` — verifies cdkd resolves
  nested-stack outputs into the parent's intrinsic-resolution path.

## Features tested in cdkd

1. **Recursive deploy** — `NestedStackProvider.create` reads the child
   template (via `Metadata['aws:asset:path']` on the parent's
   `AWS::CloudFormation::Stack` resource), constructs a child
   `DeployEngine`, and runs the child's full deploy synchronously
   before returning to the parent's DAG.
2. **Child state-key derivation** —
   `cdkd/<parent>~<NestedStackLogicalId>/<region>/state.json` (the `~`
   separator avoids collision with CDK Stage paths). Verified by
   checking the child's state file exists after deploy at
   `s3://cdkd-state-{accountId}/cdkd/NestedStackExample~Child/{region}/state.json`.
3. **Parent → child `Fn::GetAtt` across the boundary** — CDK emits
   `Fn::GetAtt: [Child, 'Outputs.<key>']` and cdkd's
   `IntrinsicFunctionResolver` fast-paths it through the child's
   recorded `attributes['Outputs.<key>']` map.
4. **Recursive destroy** — `cdkd destroy <parent>` walks the parent's
   reverse-DAG; the `AWS::CloudFormation::Stack` node triggers
   `NestedStackProvider.delete` which routes through
   `runDestroyForStack` against the child's state for a regular
   reverse-DAG destroy of the 3 child resources before deleting the
   child's state file.
5. **Schema v6 `parentStack` / `parentLogicalId` / `parentRegion`** —
   populated on the child's state record so `cdkd state list` /
   `state show` can surface the parent → child tree (follow-up PR
   consumes these fields for the tree rendering).

## Deploy / destroy

```bash
# From the worktree root:
/run-integ nested-stack
```

The skill runs `cdkd deploy` then `cdkd destroy` and verifies no
orphan AWS resources remain at `s3://cdkd-state-{accountId}/cdkd/`.

## Notes

- The bucket is created with `RemovalPolicy.DESTROY` (no
  `autoDeleteObjects` — the integ leaves the bucket empty so destroy
  works without invoking the bucket-empty Custom Resource and
  expanding the scope to 3+ extra resources).
- Cross-region nested stacks are out of scope per design §1 (AWS
  doesn't support them either) — the child inherits the parent's
  region.
