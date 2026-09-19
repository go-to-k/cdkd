---
description: cdkd analyzer layer (intrinsic resolution, dependency analysis, DAG)
paths:
  - 'src/analyzer/**'
---

# Analyzer

## Intrinsic function resolution

`IntrinsicFunctionResolver` lives in
`src/deployment/intrinsic-function-resolver.ts` — there is NO resolver under
`src/analyzer/`, and a new intrinsic extends its `resolveValue()`.

`Ref` resolves to the CFn `Ref` value (`cfnRefValueFromPhysicalId` holds the
exceptions; `refStateLookupFromResource` recovers a few from a STATE KEY). That
lookup's `SECRET_MASK` skip is **OPT-IN**: without an `onMaskedValue` callback
it returns the mask, since the fall-through emits a raw physical id no guard
recognises. Only `resolveRefValue` opts in, when
`context.redactedAttributeReads` exists, so `deploy` refuses while `diff` /
`scrub` / `import` are unchanged.

## `Condition:` exclusion

`TemplateParser.filterResourcesByCondition` prunes `Condition: false` resources
right after `evaluateConditions`, so validation, DAG build, diff and
provisioning see the CFn-effective set. A pruned resource still in state takes
the diff's DELETE path; an UNKNOWN condition is KEPT (absent-from-map is not
`=== false`).

## Dependency analysis

`DagBuilder` scans `Ref` / `Fn::GetAtt` / `DependsOn` and topologically sorts a
graphlib graph. On top:

- **Custom Resource edge** — an IAM policy on a Custom Resource's ServiceToken
  Lambda role gets an edge to the Custom Resource, so the handler is not invoked
  before the attachment returns.
- **Lambda `VpcConfig` edge** (`lambda-vpc-deps.ts`) — subnets and SGs in
  `VpcConfig` get explicit edges to the Lambda, so the reversed delete traversal
  removes the Lambda first and the async ENI detach finishes before EC2 refuses.
- **Type-based deletion ordering** (`implicit-delete-deps.ts`) — type-pair rules
  (VPC after Subnet, Subnet after Lambda, IGW + VPCGatewayAttachment after
  NatGateway) shared by the deploy DELETE phase and the standalone destroy.
- **Per-resource delete edges** — `computeImplicitDeleteEdges` handles what no
  type pair can: a `CompositeAlarm` names its children inside the `AlarmRule`
  STRING, so the DAG sees no edge and the composite must delete FIRST.
- **CDK-defensive `DependsOn` relaxation, default ON**
  (`cdk-defensive-deps.ts`) — an allowlist of type pairs CDK adds defensively
  for VPC-Lambda egress; the deploy path passes `relaxCdkVpcDefensiveDeps: true`
  and `--no-aggressive-vpc-parallel` opts out. ONLY allowlisted entries drop.
