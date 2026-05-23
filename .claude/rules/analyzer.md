---
description: cdkd analyzer layer (intrinsic function resolution, dependency analysis, DAG building)
paths:
  - 'src/analyzer/**'
---

# Intrinsic Function Resolution

- Implemented in `IntrinsicResolver` class (`src/analyzer/intrinsic-resolver.ts`)
- Ref: References other resource's PhysicalId
- Fn::GetAtt: Gets resource attributes (from state.attributes)
- Fn::Join: String concatenation
- Fn::Sub: Template string substitution

## Supporting a New Intrinsic Function

1. Extend `resolve()` method in `src/analyzer/intrinsic-resolver.ts`
2. Implement recursive resolution
3. Write tests (`tests/unit/analyzer/intrinsic-resolver.test.ts`)

# Dependency Analysis

- Implemented in `DagBuilder` class (`src/analyzer/dag-builder.ts`)
- Scans template to detect `Ref` / `Fn::GetAtt` / `DependsOn`
- Builds DAG with graphlib
- Determines execution order with topological sort
- **Implicit edge for Custom Resources**: any `AWS::IAM::Policy` / `AWS::IAM::RolePolicy` / `AWS::IAM::ManagedPolicy` attached to a Custom Resource's ServiceToken Lambda execution role automatically gets an edge to the Custom Resource, preventing the handler from being invoked before inline policy attachment returns (avoids mid-deploy AccessDenied race)
- **Implicit edge for Lambda VpcConfig**: every `AWS::EC2::Subnet` / `AWS::EC2::SecurityGroup` referenced by a Lambda's `Properties.VpcConfig.SubnetIds` / `SecurityGroupIds` gets an explicit edge to the Lambda (`src/analyzer/lambda-vpc-deps.ts`). Defense-in-depth on top of `extractDependencies`; for the reversed deletion traversal this guarantees Lambda is removed before its Subnet/SG so the asynchronous ENI detach has time to complete before EC2 rejects the subnet/SG delete with `DependencyViolation`.
- **Type-based deletion ordering rules**: `src/analyzer/implicit-delete-deps.ts` centralizes type-pair rules (e.g. VPC after Subnet, Subnet after Lambda) shared by the deploy DELETE phase and the standalone destroy command.
- **CDK-defensive DependsOn relaxation (default-on)**: `src/analyzer/cdk-defensive-deps.ts` lists the (depender, dependee) type pairs CDK adds defensively for VPC-Lambda runtime egress (IAM Role / Policy / Lambda::Function / Lambda::Url / Lambda::EventSourceMapping → EC2 Route / SubnetRouteTableAssociation). The deploy code path constructs `DagBuilder({ relaxCdkVpcDefensiveDeps: true })` by default; the matching DependsOn edges are dropped at graph-build time so CloudFront Distribution + Lambda::Url + VPC Lambda dispatch in parallel with NAT Gateway stabilization (~55% faster on `bench-cdk-sample`). Pass `cdkd deploy --no-aggressive-vpc-parallel` to opt out (escape hatch for stacks where the user wants the strict CDK-defensive ordering — e.g. a Custom Resource that synchronously invokes a VPC Lambda outside cdkd's Lambda-ServiceToken Active wait). Only DependsOn entries in the allowlist are dropped — Ref / GetAtt and other DependsOn pairs are untouched.
