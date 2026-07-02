---
description: cdkd analyzer layer (intrinsic function resolution, dependency analysis, DAG building)
paths:
  - 'src/analyzer/**'
---

# Analyzer

## Intrinsic Function Resolution

- Implemented in `IntrinsicFunctionResolver` class (`src/deployment/intrinsic-function-resolver.ts`)
- Ref: References another resource. Resolves to the CFn `Ref` value — the physicalId for most types; see `cfnRefValueFromPhysicalId` in `src/deployment/intrinsic-function-resolver.ts` for the exceptions (compound `<parent>|<child>` CC ids, ARN-stored SDK ids like `AWS::Events::Rule` / `AWS::CloudTrail::Trail` whose `Ref` is the name)
- Fn::GetAtt: Gets resource attributes (from state.attributes)
- Fn::Join: String concatenation
- Fn::Sub: Template string substitution

### Supporting a New Intrinsic Function

1. Extend `resolve()` method in `src/analyzer/intrinsic-resolver.ts`
2. Implement recursive resolution
3. Write tests (`tests/unit/analyzer/intrinsic-resolver.test.ts`)

## Resource-level `Condition:` exclusion (issue #840)

`TemplateParser.filterResourcesByCondition(template, conditions)` returns a copy of the template with every resource whose `Condition:` key resolved to `false` removed from `Resources`. CloudFormation does NOT strip condition-gated resources at synth time — CDK emits them into `Resources` carrying a `Condition:` key regardless of the condition's value — so the deploy engine calls this prune step right after `IntrinsicFunctionResolver.evaluateConditions`, and every downstream consumer (type/property validation, DAG build, diff, provisioning) operates on the CFn-effective resource set. A condition-false resource is therefore never created, and one present in prior state but condition-excluded from the effective template flows through the diff's existing "present in state, absent from desired -> DELETE" path (mirroring CFn removal). A resource whose `Condition:` names an unevaluated/unknown condition is kept (absent-from-map is not `=== false`).

## Dependency Analysis

- Implemented in `DagBuilder` class (`src/analyzer/dag-builder.ts`)
- Scans template to detect `Ref` / `Fn::GetAtt` / `DependsOn`
- Builds DAG with graphlib
- Determines execution order with topological sort
- **Implicit edge for Custom Resources**: any `AWS::IAM::Policy` / `AWS::IAM::RolePolicy` / `AWS::IAM::ManagedPolicy` attached to a Custom Resource's ServiceToken Lambda execution role automatically gets an edge to the Custom Resource, preventing the handler from being invoked before inline policy attachment returns (avoids mid-deploy AccessDenied race)
- **Implicit edge for Lambda VpcConfig**: every `AWS::EC2::Subnet` / `AWS::EC2::SecurityGroup` referenced by a Lambda's `Properties.VpcConfig.SubnetIds` / `SecurityGroupIds` gets an explicit edge to the Lambda (`src/analyzer/lambda-vpc-deps.ts`). Defense-in-depth on top of `extractDependencies`; for the reversed deletion traversal this guarantees Lambda is removed before its Subnet/SG so the asynchronous ENI detach has time to complete before EC2 rejects the subnet/SG delete with `DependencyViolation`.
- **Type-based deletion ordering rules**: `src/analyzer/implicit-delete-deps.ts` centralizes type-pair rules (e.g. VPC after Subnet, Subnet after Lambda, IGW + VPCGatewayAttachment after NatGateway) shared by the deploy DELETE phase and the standalone destroy command. The IGW / VPCGatewayAttachment after NatGateway edge (issue [#817](https://github.com/go-to-k/cdkd/issues/817)) mirrors the NAT-before-IGW ordering CloudFormation enforces: a NAT Gateway holds an Elastic IP mapped to the VPC's public address space, so detaching the IGW before the NAT is gone fails with `Network vpc-xxx has some mapped public address(es)` and the IGW delete then hangs (~19 min observed). No type-based rule is needed for the EIP itself — the NAT Ref's its EIP via `AllocationId`, so the reversed delete traversal already deletes the NAT before the EIP is released. The same module also exposes `computeImplicitDeleteEdges(resources)` for per-RESOURCE delete-ordering edges no type-pair rule can express: an `AWS::CloudWatch::CompositeAlarm` references its child alarms (metric `AWS::CloudWatch::Alarm` or other composite alarms) by NAME inside its `AlarmRule` string (`ALARM("name")` / `OK(name)` / `INSUFFICIENT_DATA(name)`, plus the `arn:...:alarm:<name>` form) — a plain string, so cdkd's DAG sees no `Ref` / `Fn::GetAtt` edge. `extractReferencedAlarmNames` parses those names and the helper emits an edge making the composite alarm delete BEFORE each referenced alarm (matched by `AlarmName` property or physical id), since CloudWatch rejects deleting a metric alarm while a composite alarm still references it (`Cannot delete <alarm> as there are composite alarm(s) depending on it.`). The per-AlarmRule edge handles composite-of-composite chains; both delete consumers add these edges alongside the type-pair rules.
- **CDK-defensive DependsOn relaxation (default-on)**: `src/analyzer/cdk-defensive-deps.ts` lists the (depender, dependee) type pairs CDK adds defensively for VPC-Lambda runtime egress (IAM Role / Policy / Lambda::Function / Lambda::Url / Lambda::EventSourceMapping → EC2 Route / SubnetRouteTableAssociation). The deploy code path constructs `DagBuilder({ relaxCdkVpcDefensiveDeps: true })` by default; the matching DependsOn edges are dropped at graph-build time so CloudFront Distribution + Lambda::Url + VPC Lambda dispatch in parallel with NAT Gateway stabilization (~55% faster on `bench-cdk-sample`). Pass `cdkd deploy --no-aggressive-vpc-parallel` to opt out (escape hatch for stacks where the user wants the strict CDK-defensive ordering — e.g. a Custom Resource that synchronously invokes a VPC Lambda outside cdkd's Lambda-ServiceToken Active wait). Only DependsOn entries in the allowlist are dropped — Ref / GetAtt and other DependsOn pairs are untouched.
