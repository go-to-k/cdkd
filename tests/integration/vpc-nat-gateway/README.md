# vpc-nat-gateway

Integration test for the `AWS::EC2::NatGateway` SDK provider added in
v0.31.

## What it covers

| Code path | How |
|-----------|-----|
| `CreateNatGateway` + `applyTags` | Default deploy |
| `waitUntilNatGatewayAvailable` | Default deploy (no `--no-wait`) |
| `--no-wait` skip on create | Deploy with `--no-wait` |
| `DeleteNatGateway` + `waitUntilNatGatewayDeleted` | Destroy (always waits — `--no-wait` is deploy-only) |
| Multi-route / shared-NAT topology | 2 AZs, single NAT, both PrivateEgress subnets route through it |
| `MaxDrainDurationSeconds` auto-route (issue #1411) | Second, L1-only NAT gateway sets it; must be provisioned via Cloud Control API |
| Heterogeneous routing in one stack | The L2 NAT stays on the SDK provider while the L1 NAT routes via Cloud Control |

## Stack shape

```text
VPC (10.50.0.0/16, 2 AZs)
├─ Public Subnet × 2  (one carries the NAT)
├─ PrivateEgress Subnet × 2  (default route → NAT)
├─ Internet Gateway
├─ EIP
├─ NAT Gateway × 1  (public, L2 — the SDK provider path)
└─ NAT Gateway × 1  (private, L1 `CfnNatGateway` with
                     `MaxDrainDurationSeconds` — the Cloud Control path)
```

No Lambda or EC2 — keeps the test focused on the NAT provider. The
`vpc-lambda-cr-race` integ already covers Lambda + Custom Resource
race conditions.

## `MaxDrainDurationSeconds` (issue #1411)

`MaxDrainDurationSeconds` is declared `unhandledByDesign` on
`EC2Provider`: `CreateNatGateway` has no such input member, EC2 has no
`ModifyNatGateway*` operation, and the only SDK calls that accept it
(`DisassociateNatGatewayAddress` / `UnassignPrivateNatGatewayAddress`)
are ones cdkd never issues because NAT gateway updates are rejected
outright. Declaring the drop makes the #614 pre-flight route the
resource through Cloud Control API, where AWS's own resource handler
applies the value.

`verify.sh` asserts that routing rather than the value itself: the
CloudFormation registry schema lists
`/properties/MaxDrainDurationSeconds` under `writeOnlyProperties` and no
EC2 read API returns it, so a "read it back and compare" assertion is
structurally impossible. What is asserted instead:

1. the drain gateway is recorded `provisionedBy == 'cc-api'`,
2. the plain gateway stays `provisionedBy == 'sdk'`,
3. both gateways are live on AWS and the drain gateway reports the
   submitted `ConnectivityType` (proof the CC route forwarded the full
   property map),
4. both are deleted cleanly on destroy.

## Run

```bash
# Default (waits for NAT available state on deploy, deleted state on destroy):
/run-integ vpc-nat-gateway

# Manual --no-wait verification on deploy (CFN parity is bypassed on
# deploy; NAT continues provisioning asynchronously after cdkd returns).
# `--no-wait` is deploy-only — `cdkd destroy` does not accept it.
cd tests/integration/vpc-nat-gateway
vp install
node ../../../dist/cli.js deploy -y --no-wait
node ../../../dist/cli.js destroy -y
```

## Expected timing (us-east-1)

- Default deploy: ~125s (dominated by `waitUntilNatGatewayAvailable`)
- `--no-wait` deploy: ~30s (skips the NAT available-state wait — 5x speedup)
- Destroy: ~95s (always waits for `deleted` state so VPC / IGW delete
  doesn't race with `DependencyViolation` from a still-`deleting`
  gateway holding ENI / EIP / route-table associations)
