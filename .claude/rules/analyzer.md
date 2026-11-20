---
description: cdkd analyzer layer (intrinsic resolution, dependency analysis, DAG)
paths:
  - 'src/analyzer/**'
  - 'src/deployment/intrinsic-resolver/ref-values.ts'
  - 'src/deployment/intrinsic-resolver/refs.ts'
---

# Analyzer

## Intrinsic function resolution

`IntrinsicFunctionResolver` lives in
`src/deployment/intrinsic-function-resolver.ts`, none under `src/analyzer/`; a
new intrinsic extends its `resolveValue()`.

`Ref` resolves to the CFn `Ref` value (`cfnRefValueFromPhysicalId` holds the
exceptions; `refStateLookupFromResource` recovers a few from a STATE KEY). That
lookup's `SECRET_MASK` skip is **OPT-IN**: without an `onMaskedValue` callback
it returns the mask, since the fall-through emits a raw physical id no guard
recognises (a Glue table's is a first-`|` guess). Only `resolveRefValue` (`refs.ts`) opts in, when
`context.redactedAttributeReads` exists, so `deploy` refuses while `diff` /
`scrub` / `import` are unchanged.

## `Condition:` exclusion

`TemplateParser.filterResourcesByCondition` prunes `Condition: false` resources
right after `evaluateConditions`, so later stages see the CFn-effective set. A
pruned resource in state takes the diff's DELETE path; an UNKNOWN condition is
KEPT (absent is not `=== false`).

## Dependency analysis

`DagBuilder` scans `Ref` / `Fn::GetAtt` / `DependsOn` and topologically sorts a
graphlib graph. On top:

- **Custom Resource edge** — an IAM policy on a Custom Resource's ServiceToken
  Lambda role gets an edge to it, so the handler does not run before the
  attachment returns. Skipped for a policy the resource already reaches (a
  `DependsOn` chain of `AwsCustomResource`s sharing one handler): it would
  close a cycle CloudFormation never sees.
- **Lambda `VpcConfig` edge** (`lambda-vpc-deps.ts`) — subnets and SGs in
  `VpcConfig` get edges to the Lambda, so the reversed delete removes the
  Lambda first and the async ENI detach finishes before EC2 refuses.
- **WaitCondition signaller edge** (#6704) — every resource referencing a
  `WaitCondition`'s `Handle` gets an edge to it, so a small `--concurrency`
  cannot run the wait before the instance that signals it. Skipped for a
  resource the wait already reaches.
- **Alias `UpdatePolicy` edge** — `--update-policy` only: an alias depends on
  what its `CodeDeployLambdaAliasUpdate` names (#6437).
- **Type-based deletion ordering** (`implicit-delete-deps.ts`) — type-pair rules
  (VPC after Subnet, Subnet after Lambda, IGW after NatGateway) shared by the
  deploy DELETE phase and destroy.
- **Per-resource delete edges** — `computeImplicitDeleteEdges` handles what no
  type pair can: a `CompositeAlarm` names its children inside the `AlarmRule`
  STRING, so the DAG sees no edge and the composite must delete FIRST.
- **CDK-defensive `DependsOn` relaxation, default ON**
  (`cdk-defensive-deps.ts`) — an allowlist of type pairs CDK adds defensively
  for VPC-Lambda egress; `--no-aggressive-vpc-parallel` opts out. Only
  allowlisted pairs drop.
