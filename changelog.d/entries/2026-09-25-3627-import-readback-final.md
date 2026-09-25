- **`cdkd import` now records the attributes `create()` records for Step Functions state machines, WAFv2 web ACLs, Cognito user pools, RDS DB clusters and S3 Vectors buckets, and accepts CloudFormation's physical ids for the web ACL and vector bucket (issue [#3627](https://github.com/go-to-k/cdkd/issues/3627))** -- `src/provisioning/providers/{stepfunctions,wafv2,cognito,rds,s3-vectors}-provider.ts`, their unit tests, and the new `tests/integration/import-attribute-readback-final/` fixture. Before this fix, `cdkd import`, including `--migrate-from-cloudformation`, did the following:
  - **State machine `Name` / `StateMachineRevisionId`**: resolved to the ARN.
  - **Web ACL `Id` / `LabelNamespace`**: resolved to the ARN, and the import **threw** on CloudFormation's `name|id|scope` physical id.
  - **User pool `ProviderName` / `ProviderURL`**: resolved to the pool id.
  - **DB cluster endpoints**: resolved to the cluster identifier.
  - **Vector bucket `VectorBucketArn`**: refused, and the import **threw** on CloudFormation's ARN physical id, because it sent the ARN to `GetVectorBucket` as a name.

  A failed import left those resources running after the CloudFormation stack was retired. Each `import()` now reads these attributes back. The web ACL and vector bucket accept CloudFormation's id and record cdkd's own form.

  `create()` changes too:
  - A web ACL now records `LabelNamespace`, read with `GetWebACL`. `WebACLSummary` has no such member, so the value was always absent.
  - A state machine now records its `StateMachineRevisionId` from `DescribeStateMachine`. Before, it recorded `stateMachineVersionArn`, a version ARN that is null unless the machine is published. A machine that was never updated reports `INITIAL`, as CloudFormation does (measured live).
