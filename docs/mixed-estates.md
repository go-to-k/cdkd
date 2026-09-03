---
title: Mixed Estates
description: Reference CloudFormation-managed stacks from cdkd — the CFn fallback for Fn::ImportValue and Fn::GetStackOutput lets consumers resolve producer outputs with zero producer changes.
---

# Reference CloudFormation-managed stacks (mixed estates)

You don't have to migrate a producer stack to reference it. When an
`Fn::ImportValue` / `Fn::GetStackOutput` reference is not found in cdkd
state, cdkd falls back to CloudFormation — `ListExports` for
`Fn::ImportValue` (CFn's own semantic for the intrinsic), the stack's
outputs via `DescribeStacks` for `Fn::GetStackOutput` — so a
cdkd-deployed stack can consume values from a stack still managed by
`cdk deploy` / raw CloudFormation, with zero changes on the producer
side.

This makes the recommended split work out of the box: shared
infrastructure (VPC, domains, IAM) stays on the CDK CLI, while dev/test
app stacks iterate via cdkd.

```typescript
// Producer: deployed with `cdk deploy` (stays CloudFormation-managed).
new cdk.CfnOutput(this, 'SharedVpcId', {
  value: vpc.vpcId,
  exportName: 'SharedVpcId',
});

// Consumer: deployed with `cdkd deploy`. Resolution order is cdkd state
// first, then CloudFormation — same syntax either way.
const vpcId = cdk.Fn.importValue('SharedVpcId');
```

How it behaves:

- **cdkd-first precedence.** The fallback fires only after cdkd state
  misses, so cdkd-to-cdkd references are untouched and a name collision
  resolves to the cdkd export.
- **Weak reference.** A CFn-sourced value is not recorded into cdkd
  state, and neither engine blocks deleting the CFn producer while cdkd
  consumers reference it (CloudFormation's export-in-use protection
  cannot see cdkd consumers). Check downstream consumers before deleting
  a producer.
- **IAM**: the deploying credentials need `cloudformation:ListExports` /
  `cloudformation:DescribeStacks` for the fallback. Without them, cdkd
  warns and fails with the ordinary not-found error.
- **Opt-out**: `--no-cfn-fallback` (on `deploy` / `diff`) pins
  cdkd-state-only resolution — minimal IAM, and an export-name typo
  fails fast instead of matching an unrelated CloudFormation export.
- This also works mid-migration: after [`cdkd export`](export.md) hands
  a producer back to CloudFormation, remaining cdkd consumers keep
  resolving its outputs through the fallback (no leaf-first ordering
  requirement).

See **[cross-stack-references.md](cross-stack-references.md)**
for the full design (resolution order, weak-vs-strong reference
semantics, cross-region / cross-account forms).
