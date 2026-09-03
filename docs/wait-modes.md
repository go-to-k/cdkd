---
title: Wait Modes
description: Choose what "done" means for a cdkd deploy — --no-wait, the load-bearing default, and CloudFormation-parity --full-wait.
---

# `--no-wait` / `--full-wait`: choose what "done" means

CloudFront / RDS / ElastiCache / NAT Gateway / EC2 Instance / ELBv2
LoadBalancer typically take 1–15 minutes to fully provision. Three
modes, least to most waiting:

- **`--no-wait`** returns as soon as the create call returns and lets
  AWS finish in the background.
- **default** waits where the wait is load-bearing (something the same
  deploy resolves or verifies needs the settled state, or the wait can
  surface a failure) — in practice, where CloudFormation and Terraform
  agree, with one measured exception: CloudFront Distribution returns
  as soon as `CreateDistribution` is accepted (nothing in-deploy needs
  the 3–15 min edge propagation, and the wait cannot detect a failure).
- **`--full-wait`** additionally waits everywhere CloudFormation does —
  the exact per-type set is the wait-semantics table in the
  [CLI reference](cli-reference.md#wait-semantics).

## How to pick

Pick by whether anything downstream needs the resource to actually be
serving, not by where the deploy runs — cutting billed CI minutes is a
perfectly good reason to use `--no-wait` in CI, and a local smoke test
(or a pipeline that wants CloudFormation-parity completion as a standing
setting) is a good reason to use `--full-wait`. The two flags are
opposite ends of one axis and cannot be combined.

## Destroy always waits

**Deploy-only**: `cdkd destroy` always waits (NAT in `deleting` state
holds ENIs and would `DependencyViolation` sibling deletes).

## Per-resource-type table

See [cli-reference.md](cli-reference.md#wait-semantics) for
the per-resource table (what each mode does, next to what
CloudFormation and Terraform do) and caveats (NAT egress, RDS
final-snapshot timing, etc.). cdkd is template-compatible with
CloudFormation but not wait-semantics-identical; that table is the
single source of truth for what "done" means per resource type.
