---
title: Benchmarks
description: "The full benchmark suite — cdkd vs CloudFormation, CloudFormation Express mode, and Terraform, with per-stack deploy-time comparisons."
---

# Benchmarks

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

Numbers below are deploy-phase only unless noted otherwise (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

## vs CloudFormation Express mode: up to 9x faster

CloudFormation's [Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/) is a fast-deploy option that skips resource stabilization waits, similar in spirit to cdkd's `--no-wait`. Even so, cdkd is faster than Express on nearly every stack, and with `--no-wait` it pulls dramatically ahead on stacks dominated by async resources.

| Stack | Normal (CFn) | Express | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: | ---: |
| VPC + Lambda + SQS + CloudFront | 562 | 366 | 96 | **40** |
| DynamoDB | 34 | 34 | 19 | 15 |
| DynamoDB + KMS | 71 | 55 | 27 | 27 |
| EC2 | 44 | 31 | 27 | 26 |
| Lambda | 55 | 34 | 23 | 22 |
| S3 | 39 | 22 | 23 | 24 |
| SQS | 83 | 22 | **9** | 9 |
| SQS + CloudWatch | 87 | 44 | 30 | 31 |

Best of 3 runs, deploy-phase only, seconds, `us-west-2`. The `VPC + Lambda + SQS + CloudFront` stack is 1 VPC (2 AZs, NAT Gateway, public + private subnets) + VPC Lambda + Lambda Function URL + CloudFront Distribution + SQS + EventSourceMapping + Consumer Lambda. Its cdkd default cell was re-measured 2026-07-31 on cdkd 0.272.0 (96 / 107 / 115s, best of 3): the default no longer waits for CloudFront `Deployed`, so NAT stabilization is the critical path. The other cells are from the original campaign.

- **~1.5–2x faster than Express on most stacks** — e.g. SQS finishes in 9s vs Express's 22s (~2.4x).
- **Async-heavy stacks are where the gap explodes.** On the VPC + CloudFront stack the cdkd default finishes in 96s vs Express's 366s (~3.8x) — the default already leaves CloudFront propagation to complete in the background — and `--no-wait` (40s, ~9x) additionally skips the NAT stabilization wait.
- **S3 is the one case where Express edges cdkd's default** (22s vs 23s). On a near-instant single-resource stack there is little left to parallelize, and `--no-wait` makes no difference there.

## SDK Provider path — **5.5x faster** (17.0s vs 94.4s)

Stack: S3 Bucket, DynamoDB Table, SQS Queue, SNS Topic, SSM Parameter (5 independent resources, fully parallelized by cdkd's DAG scheduler).

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **94.4s** | **17.0s** | **5.5x** |

## VPC + CloudFront + Lambda stack — **15x faster with `--no-wait`** (40s vs 599s)

Real-world stack: 1 VPC (2 AZs, NAT Gateway, public + private subnets) + Lambda Function (with `VpcConfig`) + Lambda Function URL (AWS_IAM) + CloudFront Distribution (OAC, caching disabled) + SQS Queue + EventSourceMapping + Consumer Lambda.

| | AWS CDK (CFn) | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: |
| Deploy | **599s** | 96s (~6x) | **40s (15.0x)** |

The 15x figure requires `cdkd deploy --no-wait`, which returns as soon as each Create call returns and lets AWS finish NAT Gateway stabilization in the background too. cdkd's default already leaves CloudFront's ~5min propagation to finish in the background, and the default scheduler parallelizes `CloudFront::Distribution` / `Lambda::Url` / VPC Lambda with NAT Gateway propagation (pass `--no-aggressive-vpc-parallel` to opt out) — on this stack the default gives ~6x, with NAT stabilization as the remaining critical path. The cdkd default cell was re-measured 2026-07-31 on cdkd 0.272.0 (96 / 107 / 115s, best of 3); the CFn and `--no-wait` cells are from the original campaign, so read the ~6x ratio as approximate across campaigns.

## Cloud Control API fallback path — **1.6x faster** (40.9s vs 64.9s)

Stack: SSM Document × 3 + Athena WorkGroup × 2 (no SDK provider — CC API fallback).

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **64.9s** | **40.9s** | **1.6x** |

Reproduce the SDK Provider path and VPC + CloudFront + Lambda benchmarks with `./tests/benchmark/run-benchmark.sh all` (from the repo root). See [tests/benchmark/README.md](https://github.com/go-to-k/cdkd/blob/main/tests/benchmark/README.md) for details.

## Reference point: Terraform

We also raced cdkd against Terraform: the same logical stacks expressed both as CDK apps and as Terraform HCL, deployed by all engines against real AWS. Full methodology, parity notes, and reproduction scripts live in [cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

| Scenario | Stack | cdkd | Terraform | CloudFormation | cdkd `--no-wait` | Terraform, waits skipped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| wide | 48 independent resources (S3 / DynamoDB / SQS / SNS / SSM / Logs, 8 each) | **20.0** | 46.1 | 89.1 | 21.1 | no opt-out exists |
| serverless | Lambda x3 + HTTP API + DynamoDB + SNS / SQS + EventBridge | **25.9** | 57.5 | 127.1 | 24.6 | no opt-out exists |
| ec2 | VPC + subnet + SG + IAM role + EC2 instance x3 (t3.micro + EBS) | **29.1** | 35.9 | 193.9 | 22.0 | no opt-out exists |
| webapp | VPC + NAT + subnets + DynamoDB + SQS + S3 + Lambda x2 + HTTP API | 109.7 | 127.3 | 166.1 | 23.4 | no opt-out exists |
| ecs | VPC x2 AZ + Fargate cluster / task / service + ALB + target group | **162.8** | 209.5 | 276.7 | 34.5 | 209.5 (already the default) |
| cloudfront — created (fire and forget) | S3 origin + CloudFront + OAC | 11.1 | no such mode (see `Deployed` row) | no such mode | 10.4 | 10.3 (`wait_for_deployment = false`) |
| cloudfront — `Deployed` | S3 origin + CloudFront + OAC | 174.0 (`--full-wait`) | 166.4 | 232.3 | n/a | n/a |

The cloudfront scenario is two rows because the tools' DEFAULTS differ in
what "done" means there: cdkd's default returns once
`CreateDistribution` is accepted (the fire-and-forget row) while Terraform's
default (`wait_for_deployment = true`) and CloudFormation wait for `Deployed`
(the second row). Each row compares tools held to the SAME completion
definition; a tool's cell in the row that is not its default names the flag
that selects the mode. Both rows are ties: fire-and-forget by 0.8s, and
`Deployed` by 7.6s with fully overlapping run distributions (cdkd
`--full-wait` 163.7-216.6s vs Terraform 155.7-188.4s at n=7). The cloudfront
rows were re-measured 2026-07-31 on cdkd 0.272.0 (all six modes interleaved
in one campaign); the other scenarios' numbers are from the original
campaign.

Cold end-to-end wall clock, median of **7 runs** per scenario, seconds, `us-east-1`, one cdkd binary for every number within a campaign. Unlike the tables above, these numbers include synth (cdkd / CDK) and plan (Terraform); one-time setup (`npm install` / `cdk bootstrap` / `terraform init`) is excluded for all tools. For parity, CDK-only extras (the `restrictDefaultSecurityGroup` custom resource and CDK-managed log groups) were disabled so cdkd / CloudFormation don't carry resources the Terraform config doesn't have.

**Every run is a first deploy.** Each run gives every tool resource names AWS has never seen. This is load-bearing rather than cosmetic: re-creating an IAM instance profile under a previously used name propagates to EC2 about 5x faster than a fresh one (measured 7.9s median cold vs 1.5s warm), and cdkd waits for the real propagation while Terraform pays a fixed wait regardless -- so a fixed-name benchmark silently favours cdkd by several seconds that no first deploy ever sees.

- **The winner depends on how much of the wall clock is orchestration.** On wide, parallel stacks (wide, serverless) cdkd is ~2.2-2.3x faster than Terraform, because almost the entire deploy is scheduling and API calls. Where a single slow resource dominates the wall clock the gap narrows toward the physical floor both tools share: ec2 1.23x, ecs 1.29x, and cloudfront -- pure CloudFront propagation delay under the `Deployed` definition, pure API accept under fire-and-forget -- a tie in both rows. Nothing here makes AWS itself faster.
- **A win is claimed only where the run distributions separate.** In the four bolded rows no cdkd run overlaps any Terraform run (exact Mann-Whitney p = 0.0006, the floor at n=7 vs n=7). The three ties disclose which way their medians lean, and the rule cuts both ways: webapp leans cdkd by 17.6s but its runs span 98-138s against Terraform's 106-138s, so n=7 cannot separate them (p = 0.24) -- NAT-gateway creation varies by more than the gap between the tools -- and both cloudfront rows lean Terraform (by 0.8s and 7.6s) inside fully overlapping ranges. Sizing the claim by the median gap instead would invert the webapp/ec2 pair, since ec2 separates completely on 6.8s while webapp's larger 17.6s does not. "Overlapping" means unproven at this sample size, not disproven -- for either side.
- **Skipping waits is not a like-for-like capability.** cdkd's `--no-wait` is one global flag covering every resource type. Terraform has no global equivalent -- the AWS provider exposes a per-resource argument only where its authors added one, here `aws_cloudfront_distribution.wait_for_deployment` and `aws_ecs_service.wait_for_steady_state` (already false by default, so that cell repeats the default number). `aws_nat_gateway`, `aws_instance`, and every type in wide / serverless have none. On cloudfront, where both tools have both modes, the fire-and-forget row (cdkd default 11.1 / `--no-wait` 10.4 vs Terraform `wait_for_deployment = false` 10.3) is a tie by the noise rule below.
- **This is not cdkd waiting for less.** Every comparison is held to a matching completion definition: `cdkd --full-wait` against Terraform's `wait_for_steady_state=true` on ecs is 227.7s vs 282.7s (1.24x), and the two cloudfront rows are same-definition pairs by construction (`--full-wait` 174.0 vs Terraform default 166.4 -- a tie). See [docs/cli-reference.md](cli-reference.md) for the per-resource-type wait semantics.
- **Differences of a few seconds are not meaningful.** Re-running a scenario with the same binary hours later moved the cdkd median by 1.1s on wide and 4.5s on serverless, with Terraform moving too. Single-digit-second gaps are ties regardless of which side they favour, which is why both cloudfront rows are reported as ties rather than a win either way.
- **This benchmark also made cdkd faster.** Chasing the initial webapp / cloudfront losses surfaced four real deploy-speed bugs (longest-pole scheduling, a missing EIP SDK provider, NAT Gateway and CloudFront polling intervals), all fixed before the final measurements. The numbers above are from the fixed version.
