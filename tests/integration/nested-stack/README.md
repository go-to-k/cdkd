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

6. **Child-result propagation on destroy** (issues
   [#1752](https://github.com/go-to-k/cdkd/issues/1752) /
   [#1777](https://github.com/go-to-k/cdkd/issues/1777)) —
   `NestedStackProvider.delete` inspects the child `DestroyRunner`'s result
   instead of discarding it. A child that SKIPPED a resource or was
   INTERRUPTED comes back as `{ outcome: 'skipped' }`; a child whose
   resource genuinely FAILED to delete makes the provider THROW, so the
   parent's `AWS::CloudFormation::Stack` row fails, the parent's `state.json`
   and its `Child` row are preserved, and the run exits 2. Pre-fix all three
   were swallowed and the parent reported the live child stack as deleted
   while deleting its own state file.

## Deploy / destroy

```bash
# From the worktree root:
/run-integ nested-stack
```

The fixture ships a `verify.sh`, so `/run-integ` runs that instead of the
plain deploy-then-destroy flow. Its three phases:

- **Phase A — deploy.** Asserts the parent's and the child's state files both
  exist under `s3://<state-bucket>/cdkd/{NestedStackExample,NestedStackExample~Child}/{region}/state.json`,
  and reads the child's bucket name out of the child state record.
- **Phase B — a genuinely FAILING child delete (the #1777 positive arm).**
  PUTs one object into the child's bucket. The bucket is created WITHOUT
  `autoDeleteObjects`, so cdkd's CloudFormation-parity data guard (issue
  [#1340](https://github.com/go-to-k/cdkd/issues/1340)) refuses to delete a
  non-empty bucket and the child's destroy reports `errorCount: 1`. The
  destroy must then exit **2**, print NO `✓ Child (AWS::CloudFormation::Stack)
  deleted` line, name the child stack in its failure, and PRESERVE the parent's
  `state.json` (with its `Child` row intact) AND the child's own `state.json`.
  The state assertions are what discriminate: an exit-code-only check would
  pass against the un-fixed binary too, since pre-fix the run exited 0.
- **Phase C — the negative control.** Empties the bucket and re-destroys. The
  same run must now report `✓ Child (AWS::CloudFormation::Stack) deleted` and
  leave neither state file nor the child bucket behind — so "never report a
  nested stack deleted" cannot pass Phase B.

The skill's own post-run sweep still verifies no orphan AWS resources remain
at `s3://cdkd-state-{accountId}/cdkd/`.

## Notes

- The bucket is created with `RemovalPolicy.DESTROY` (no
  `autoDeleteObjects` — the integ leaves the bucket empty so destroy
  works without invoking the bucket-empty Custom Resource and
  expanding the scope to 3+ extra resources). That absence is now
  load-bearing rather than incidental: it is exactly what lets Phase B
  provoke a genuinely failing child delete without changing the CDK app.
  Adding `autoDeleteObjects: true` here would silently turn Phase B into
  a clean destroy and the #1777 assertions would stop testing anything.
- Cross-region nested stacks are out of scope per design §1 (AWS
  doesn't support them either) — the child inherits the parent's
  region.
