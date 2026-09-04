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
  surface a failure). The rule of thumb: where CloudFormation and
  Terraform agree on what "done" means, cdkd matches them; where they
  disagree, cdkd's default takes the faster side — so, for example, ECS
  Service steady state is NOT waited for by default (Terraform does not
  wait either; `--full-wait` restores the CloudFormation behavior). The
  one case where both engines wait and cdkd still returns early is
  CloudFront Distribution: it returns as soon as `CreateDistribution`
  is accepted (nothing in-deploy needs the 3–15 min edge propagation,
  and the wait cannot detect a failure).
- **`--full-wait`** additionally waits everywhere CloudFormation does —
  the exact per-type set is the wait-semantics table in the
  [CLI reference](cli-deploy.md#wait-behaviour-by-resource-type).

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

## What "done" means per resource type

The single source of truth is the wait-semantics table in the
[CLI reference](cli-deploy.md#wait-behaviour-by-resource-type): what each mode does
per resource type, next to what CloudFormation and Terraform do, plus
the caveats (NAT egress, RDS final-snapshot timing, etc.). cdkd is
template-compatible with CloudFormation but not
wait-semantics-identical.

## Related

- [Deploy: tuning](cli-deploy-tuning.md) — the per-resource timeout overrides, and observed-state capture
- [Benchmarks](benchmarks.md) — what each mode costs in wall clock
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
