# Circular Security Group Reference

Integration test that surfaces create/destroy DAG-ordering bugs with a
**circular Security Group reference**: SG-A allows ingress from SG-B AND SG-B
allows ingress from SG-A — the classic CloudFormation cycle.

## How the cycle is modeled (the CFn-safe way)

If both ingress rules were declared INLINE (inside each SG's
`SecurityGroupIngress` property), the two `AWS::EC2::SecurityGroup` resources
would reference each other and form a genuine dependency cycle that neither
CloudFormation nor cdkd's DAG builder can order.

CDK breaks the cycle the same way the AWS docs recommend: when
`sgA.addIngressRule(sgB, ...)` would create a cross-reference, CDK emits the
rule as a **standalone `AWS::EC2::SecurityGroupIngress` resource** (not inline).
Each standalone ingress resource `Fn::GetAtt`s both SGs (`GroupId` = the SG it
attaches to, `SourceSecurityGroupId` = the other SG), but the two SGs
themselves no longer reference each other:

```
VPC ─┬─> SgA ─┐
     │        ├─> SgAfromB  (ingress on SgA, source SgB)
     └─> SgB ─┤
              └─> SgBfromA  (ingress on SgB, source SgA)
```

which is acyclic. `verify.sh` confirms this via `cdkd synth` (>= 2 standalone
`AWS::EC2::SecurityGroupIngress` resources, each with a `SourceSecurityGroupId`,
and zero inline ingress on either SG).

## Resources Created

- **VPC** — single AZ, `natGateways: 0` (cheapest VPC; an SG must live in a VPC)
- **SG-A**, **SG-B** — two security groups, `allowAllOutbound: false`
- **2x SecurityGroupIngress** — the standalone cross-referencing ingress rules

No EC2 instances are launched — the cross-SG reference alone exercises the
create/destroy ordering.

## What it stresses in cdkd

1. **DEPLOY** — the DAG builder (`src/analyzer/dag-builder.ts`) must NOT raise a
   false `DependencyError`. The standalone ingress resources break what would
   otherwise look like a cycle.
2. **DESTROY (the key test)** — the ingress rules must be revoked BEFORE the SGs
   are deleted. An SG still referenced by a live cross-SG ingress rule cannot be
   deleted; AWS rejects `DeleteSecurityGroup` with
   `DependencyViolation: resource sg-xxx has a dependent object`. cdkd's
   reversed-traversal delete order plus the
   `AWS::EC2::SecurityGroup -> AWS::EC2::SecurityGroupIngress`
   implicit-delete-dep edge (`src/analyzer/implicit-delete-deps.ts`) must put
   both ingress deletes before both SG deletes.

## Run

```bash
/run-integ sg-circular-dependency
```

`verify.sh` deploys, asserts both SGs exist with the live cross-reference,
destroys, and asserts both SGs + the VPC + the state file are gone. Resources
are located by the `cdkd:integ-fixture=sg-circular-dependency` tag. The cleanup
trap revokes-then-deletes directly so a destroy-ordering bug never leaks
resources.
