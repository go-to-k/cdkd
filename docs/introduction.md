---
title: Introduction
description: What cdkd is for, how it complements the AWS CDK CLI, and how much faster it is — benchmarked against CloudFormation, Express mode, and Terraform.
---

# Introduction

cdkd is a drop-in CDK CLI for existing CDK apps — up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation.

- **Drop-in CDK compatible**: your existing CDK app code runs as-is; just replace `cdk deploy` with `cdkd deploy`.
- **Up to 15x faster deploys**: direct SDK calls, aggressive parallelization, and `--no-wait` to skip slow stabilization waits; **faster than Terraform and CloudFormation Express mode** too (see [Benchmark](#benchmark)).

![cdk deploy vs cdkd deploy](https://raw.githubusercontent.com/go-to-k/cdkd/main/assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow: no migration needed. You can also [import](import.md) existing stacks into cdkd or [export](import.md) back to CloudFormation anytime.

**A natural fit for AI-driven development.** AI coding agents iterate in tight spin-up / tear-down loops — and cdkd keeps each turn short, with fast deploys and an equally fast `cdkd destroy` that deletes via direct SDK calls instead of polling a CloudFormation stack-delete. See [Using cdkd with AI coding agents](ai-agents.md).

**Local execution from your deployed stack.** `cdkd local` runs your functions, APIs, and ECS tasks on your machine. It can resolve env vars, secrets, and resource references from your real deployed stack: no hand-written `.env` files, no hand-seeded test data (see [Local execution](local-emulation.md)).

> **IMPORTANT**: cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Benchmark

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

Numbers below are deploy-phase only (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

### vs CloudFormation Express mode: up to 9x faster

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

Best of 3 runs, deploy-phase only, seconds, `us-west-2`. The `VPC + Lambda + SQS + CloudFront` stack is 1 VPC (2 AZs, NAT Gateway, public + private subnets) + VPC Lambda + Lambda Function URL + CloudFront Distribution + SQS + EventSourceMapping + Consumer Lambda. Its cdkd default cell was re-measured 2026-07-31 on cdkd 0.272.0 (96 / 107 / 115s, best of 3): since #1282 the default no longer waits for CloudFront `Deployed`, so NAT stabilization is the critical path. The other cells are from the original campaign.

- **~1.5–2x faster than Express on most stacks** — e.g. SQS finishes in 9s vs Express's 22s (~2.4x).
- **Async-heavy stacks are where the gap explodes.** On the VPC + CloudFront stack the cdkd default finishes in 96s vs Express's 366s (~3.8x) — since #1282 the default already leaves CloudFront propagation to complete in the background — and `--no-wait` (40s, ~9x) additionally skips the NAT stabilization wait.
- **S3 is the one case where Express edges cdkd's default** (22s vs 23s). On a near-instant single-resource stack there is little left to parallelize, and `--no-wait` makes no difference there.

### vs Terraform: cdkd deploys faster

We also raced cdkd against Terraform: the same logical stacks expressed both as CDK apps and as Terraform HCL, deployed against real AWS. **cdkd is clearly faster in four of six scenarios — 1.23x to 2.31x, with fully separated run distributions — and statistically tied in the rest.**

| Scenario | Stack | cdkd | Terraform | CloudFormation | cdkd `--no-wait` |
| --- | --- | ---: | ---: | ---: | ---: |
| wide | 48 independent resources (S3 / DynamoDB / SQS / SNS / SSM / Logs, 8 each) | **20.0** | 46.1 | 89.1 | 21.1 |
| serverless | Lambda ×3 + HTTP API + DynamoDB + SNS / SQS + EventBridge | **25.9** | 57.5 | 127.1 | 24.6 |
| ec2 | VPC + subnet + SG + IAM role + EC2 instance ×3 | **29.1** | 35.9 | 193.9 | 22.0 |
| webapp | VPC + NAT + subnets + DynamoDB + SQS + S3 + Lambda ×2 + HTTP API | 109.7 | 127.3 | 166.1 | 23.4 |
| ecs | VPC ×2 AZ + Fargate cluster / task / service + ALB | **162.8** | 209.5 | 276.7 | 34.5 |
| cloudfront — created (fire and forget) | S3 origin + CloudFront + OAC | 11.1 | 10.3 (`wait_for_deployment = false`) | no such mode | 10.4 |
| cloudfront — `Deployed` | S3 origin + CloudFront + OAC | 174.0 (`--full-wait`) | 166.4 | 232.3 | n/a |

Cold end-to-end wall clock including synth / plan, median of 7 runs, seconds, `us-east-1`; every run gets fresh resource names, so every run measures a first deploy. The cloudfront scenario is two rows because since #1282 the tools' DEFAULTS differ in what "done" means there — each row compares tools held to the same completion definition (cdkd's default is the fire-and-forget row; Terraform's default is the `Deployed` row), re-measured 2026-07-31 on cdkd 0.272.0.

- **The lead tracks how much of the wall clock is orchestration.** wide and serverless are almost pure orchestration and run ~2.2x faster; cloudfront is almost pure CDN propagation under the `Deployed` definition and pure API accept under fire-and-forget — a tie in both rows.
- **A win is claimed only where no cdkd run overlaps any Terraform run** — true of the four bolded rows. The ties disclose which way their medians lean, and the rule cuts both ways: webapp leans cdkd (by 17.6s), both cloudfront rows lean Terraform (by 0.8s and 7.6s) — in all three the run distributions overlap fully, so n=7 cannot separate them and neither side gets the row.
- **This is not cdkd waiting for less.** Held to the same completion definition — ECS `--full-wait` vs Terraform's `wait_for_steady_state=true` is 227.7 vs 282.7 (1.24x), and both cloudfront rows above are same-definition pairs by construction.

Distribution analysis, wait-skipping comparability (Terraform has no global `--no-wait` equivalent), and per-run data: [benchmarks.md](benchmarks.md) and [cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

### More benchmarks

The full benchmark suite lives in [benchmarks.md](benchmarks.md): the SDK Provider path (**5.5x**, 17.0s vs 94.4s), the VPC + CloudFront + Lambda stack behind the headline **15x** (40s vs 599s with `--no-wait`), the Cloud Control API fallback path (**1.6x**), and the Terraform comparison in full detail. Reproduction scripts: [tests/benchmark](https://github.com/go-to-k/cdkd/tree/main/tests/benchmark).

## Features

- **Synthesis orchestration**: CDK app subprocess execution, Cloud Assembly parsing, context provider loop
- **Asset handling**: Self-implemented asset publisher for S3 file assets (ZIP packaging) and Docker images (ECR)
- **Context resolution**: Self-implemented context provider loop for Vpc.fromLookup(), AZ, SSM, HostedZone, etc.
- **Hybrid provisioning**: SDK Providers for fast direct API calls, Cloud Control API fallback for broad resource coverage
- **Diff calculation**: Self-implemented resource/property-level diff between desired template and current state
- **S3-based state management**: No DynamoDB required, uses S3 conditional writes for locking
- **DAG-based parallelization**: Analyze `Ref`/`Fn::GetAtt` dependencies and execute in parallel
- **Rollback on failure**: When a deploy errors mid-stack, cdkd rolls back the resources it just created so the stack state stays consistent (CloudFormation parity — but cdkd does this without round-tripping through CFn). Pass `cdkd deploy --no-rollback` to skip rollback and keep the partial state for Terraform-style inspection / repair — then either fix forward with another `cdkd deploy`, revert with the standalone `cdkd rollback`, or `cdkd destroy` to clean up. See [`cdkd rollback` in the CLI reference](cli-reference.md#cdkd-rollback-revert-a-failed-deploy).
- **`--no-wait` / `--full-wait` for async resources**: `--no-wait` skips the multi-minute wait on RDS / ElastiCache / NAT Gateway / EC2 Instance / ELBv2 LoadBalancer / Lambda MicroVM Image and returns as soon as the create call returns (CloudFormation always blocks); `--full-wait` goes the other way and waits where cdkd's default does not (ECS Service steady state; CloudFront Distribution `Deployed` — the default returns as soon as `CreateDistribution` is accepted, since nothing in-deploy needs the 3–15 min edge propagation)
- **VPC route DependsOn relaxation (on by default)**: Drop CDK-injected defensive `DependsOn` edges from VPC Lambdas onto private-subnet routes so `CloudFront::Distribution` and `Lambda::Url` start their ~3-min propagation in parallel with NAT Gateway stabilization (~50% faster on VPC + Lambda + CloudFront stacks). Pass `--no-aggressive-vpc-parallel` to opt out.
- **Local execution** (`cdkd local invoke` / `start-api` / `run-task` / `start-service` / `start-alb` / `start-cloudfront` / `invoke-agentcore` / `start-agentcore`): run Lambdas, API Gateway routes, ECS tasks, long-running ECS services, CloudFront distributions, and Bedrock AgentCore Runtimes from your CDK code. All AWS Lambda runtimes, container Lambdas, REST v1 / HTTP v2 / Function URL routes, Service Connect / Cloud Map, AgentCore HTTP / MCP / A2A / AGUI / WebSocket protocols (one-shot `invoke-agentcore` and long-running warm serve via `start-agentcore`, which serves the native contract — `POST /invocations` + `GET /ping`, MCP `/mcp`, A2A `/` — plus the `/ws` bridge for HTTP / AGUI). The Docker-backed commands work for both `cdkd deploy`-managed (`--from-state`) AND `cdk deploy`-managed (`--from-cfn-stack`) stacks; `start-cloudfront` serves the viewer-request -> S3 / Lambda Function URL origin -> viewer-response pipeline (CloudFront-Functions + S3-only distributions run in-process with no Docker). See [Local execution](local-emulation.md).
- **Bidirectional CloudFormation migration**: `cdkd import --migrate-from-cloudformation` adopts existing CFn stacks (including `cdk deploy`-managed) into cdkd state without re-creating resources; `cdkd export` hands a cdkd stack back to CloudFormation when production-ready. See [Importing & exporting](import.md).
- **Mixed cdkd / CloudFormation estates**: a cdkd-deployed stack can reference a producer stack still managed by `cdk deploy` — `Fn::ImportValue` / `Fn::GetStackOutput` fall back to CloudFormation (`ListExports` / stack outputs) when the reference is not in cdkd state, so shared infrastructure stays on the CDK CLI while app stacks iterate on cdkd. See [Cross-stack references](cross-stack-references.md).

> **Note**: Resource types not covered by either SDK Providers or Cloud Control API cannot be deployed with cdkd. Deployment fails with a clear error message naming the type + a 1-click issue link.

Ready to try it? Head to [Getting started](getting-started.md).
