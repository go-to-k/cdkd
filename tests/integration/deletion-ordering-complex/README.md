# deletion-ordering-complex

Failure-seeking integration test for cdkd's **ELBv2 destroy ordering**.

Goes beyond the SG/IGW/NAT delete-ordering cases already covered (issue
[#817](https://github.com/go-to-k/cdkd/issues/817), `vpc-nat-gateway`) by
exercising the richer ELBv2 dependency web, which has **no
`implicit-delete-deps` edge today**.

## Topology (`CdkdDeletionOrderingComplexExample`)

```text
VPC (10.60.0.0/16, 2 public subnets, natGateways:0 — no NAT cost)
├─ InternetGateway + VPCGatewayAttachment
├─ SecurityGroup (HTTP :80 ingress; shared by the ALB and the EC2 target)
├─ EC2 Instance (t3.nano)            — registered as the TargetGroup IP target
├─ ApplicationLoadBalancer           — internet-facing, in the 2 public subnets
├─ TargetGroup (TargetType: IP)      — one registered private-IP target
├─ Listener (:80 → forward → TargetGroup)
└─ ListenerRule (/app/* → TargetGroup)
```

## The ordering constraints it stresses

Each constraint is enforced by AWS but is **not** trivially visible as a
forward `Ref` / `DependsOn`, so it relies on cdkd's reverse-DAG + (missing)
type-based delete rules being correct:

| # | Constraint | How AWS rejects a wrong order | cdkd coverage |
|---|------------|-------------------------------|---------------|
| 1 | Listener / ListenerRule **before** TargetGroup | `DeleteTargetGroup` → `ResourceInUse` | Reverse-DAG (Listener/rule `Ref` the TG's ARN) |
| 2 | ListenerRule **before** Listener | rule belongs to the listener | Reverse-DAG (rule `Ref`s the Listener) |
| 3 | TargetGroup + Listener **before** the LoadBalancer | Listener `Ref`s the LB; the TG does **not** | Listener-vs-LB by `Ref`; TG-vs-LB rides on the Listener-vs-TG edge |
| 4 | LB hyperplane ENI release **before** Subnet / SG delete | `DeleteSubnet` / `DeleteSecurityGroup` → `DependencyViolation` | **No `implicit-delete-deps` edge for ELBv2** + `DeleteLoadBalancer` does not `waitUntilLoadBalancersDeleted` |
| 5 | EC2 target ENI release **before** Subnet / SG delete | `DependencyViolation` | Reverse-DAG (instance `Ref`s subnet/SG) |

Constraint **4** is the highest-risk: cdkd's `ELBv2Provider.deleteLoadBalancer`
fires `DeleteLoadBalancerCommand` and returns immediately (no
wait-for-deleted), while AWS tears the LB's ENIs out of the subnets
asynchronously. If the reverse-DAG dispatches the Subnet / SecurityGroup
delete before that finishes, EC2 rejects with `DependencyViolation` and the
destroy fails / orphans.

## What `verify.sh` asserts

1. **deploy** `CdkdDeletionOrderingComplexExample`.
2. The ALB + TargetGroup + Listener + non-default ListenerRule **exist**.
3. **THE TEST — `cdkd destroy --force` must exit 0.** A wrong delete order
   surfaces here as a non-zero exit; the script then prints the exact AWS
   `DependencyViolation` / `ResourceInUse` error (+ full destroy log) for
   triage.
4. cdkd state is gone.
5. **0 orphans** — the LoadBalancer, TargetGroup, SecurityGroup, subnets,
   IGW, VPC, and EC2 instance are all gone in AWS (checked by our own
   `cdkd:integ-fixture=deletion-ordering-complex` tag, since AWS reserves the
   `aws:` prefix so cdkd cannot set `aws:cdk:path`). State-empty alone is not
   trusted (#796 lesson: state-empty ≠ AWS-empty).

On any failure exit, the `EXIT` trap tears the leftovers down in **AWS-safe
order** (listener → TG → LB + wait → EC2 instance + wait → leftover ENIs → SG
→ subnets → IGW → VPC), so a failing run never orphans the cost-bearing ALB /
EC2 instance / VPC.

The script is BSD/macOS-portable (no `grep -P`, no `date -d`), captures real
exit codes, and prints `[verify] PASS` only on full success.

## Run

```bash
/run-integ deletion-ordering-complex
```

## Scenario coverage

Tags the canonical scenario `elbv2-listener-tg-lb-deletion-order`
(see `scripts/build-scenario-coverage-matrix.ts`).
