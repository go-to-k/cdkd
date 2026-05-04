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

## Stack shape

```text
VPC (10.50.0.0/16, 2 AZs)
├─ Public Subnet × 2  (one carries the NAT)
├─ PrivateEgress Subnet × 2  (default route → NAT)
├─ Internet Gateway
├─ EIP
└─ NAT Gateway × 1  (the resource under test)
```

No Lambda or EC2 — keeps the test focused on the NAT provider. The
`vpc-lambda-cr-race` integ already covers Lambda + Custom Resource
race conditions.

## Run

```bash
# Default (waits for NAT available state on deploy, deleted state on destroy):
/run-integ vpc-nat-gateway

# Manual --no-wait verification on deploy (CFN parity is bypassed on
# deploy; NAT continues provisioning asynchronously after cdkd returns).
# `--no-wait` is deploy-only — `cdkd destroy` does not accept it.
cd tests/integration/vpc-nat-gateway
pnpm install
node ../../../dist/cli.js deploy -y --no-wait
node ../../../dist/cli.js destroy -y
```

## Expected timing (us-east-1)

- Default deploy: ~125s (dominated by `waitUntilNatGatewayAvailable`)
- `--no-wait` deploy: ~30s (skips the NAT available-state wait — 5x speedup)
- Destroy: ~95s (always waits for `deleted` state so VPC / IGW delete
  doesn't race with `DependencyViolation` from a still-`deleting`
  gateway holding ENI / EIP / route-table associations)
