# Benchmarks

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

Numbers below are deploy-phase only unless noted otherwise (CDK app synthesis is identical between cdkd and AWS CDK — both run the same user code through `aws-cdk-lib`'s synthesizer — so synth time is excluded from the speedup calculation).

## vs CloudFormation Express mode: up to 9x faster

CloudFormation's [Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/) is a fast-deploy option that skips resource stabilization waits, similar in spirit to cdkd's `--no-wait`. Even so, cdkd is faster than Express on nearly every stack, and with `--no-wait` it pulls dramatically ahead on stacks dominated by async resources.

| Stack | Normal (CFn) | Express | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: | ---: |
| VPC + Lambda + SQS + CloudFront | 562 | 366 | 168 | **40** |
| DynamoDB | 34 | 34 | 19 | 15 |
| DynamoDB + KMS | 71 | 55 | 27 | 27 |
| EC2 | 44 | 31 | 27 | 26 |
| Lambda | 55 | 34 | 23 | 22 |
| S3 | 39 | 22 | 23 | 24 |
| SQS | 83 | 22 | **9** | 9 |
| SQS + CloudWatch | 87 | 44 | 30 | 31 |

Best of 3 runs, deploy-phase only, seconds, `us-west-2`. The `VPC + Lambda + SQS + CloudFront` stack is 1 VPC (2 AZs, NAT Gateway, public + private subnets) + VPC Lambda + Lambda Function URL + CloudFront Distribution + SQS + EventSourceMapping + Consumer Lambda.

- **~1.5–2x faster than Express on most stacks** — e.g. SQS finishes in 9s vs Express's 22s (~2.4x).
- **Async-heavy stacks are where the gap explodes.** On the VPC + CloudFront stack, `cdkd --no-wait` finishes in 40s vs Express's 366s (~9x) — cdkd returns as soon as each create call returns, leaving CloudFront propagation and NAT Gateway stabilization to complete in the background.
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
| Deploy | **599s** | 197s (3.0x) | **40s (15.0x)** |

The 15x figure requires `cdkd deploy --no-wait`, which returns as soon as each Create call returns and lets AWS finish CloudFront's ~5min propagation + NAT Gateway stabilization in the background. cdkd's default scheduler already parallelizes `CloudFront::Distribution` / `Lambda::Url` / VPC Lambda with NAT Gateway propagation (pass `--no-aggressive-vpc-parallel` to opt out); on this stack the default gives ~3x. `--no-wait` adds the rest of the gap by skipping the propagation waits entirely.

## Cloud Control API fallback path — **1.6x faster** (40.9s vs 64.9s)

Stack: SSM Document × 3 + Athena WorkGroup × 2 (no SDK provider — CC API fallback).

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **64.9s** | **40.9s** | **1.6x** |

Reproduce the SDK Provider path and VPC + CloudFront + Lambda benchmarks with `./tests/benchmark/run-benchmark.sh all` (from the repo root). See [tests/benchmark/README.md](../tests/benchmark/README.md) for details.

## Reference point: Terraform

We also raced cdkd against Terraform: the same logical stacks expressed both as CDK apps and as Terraform HCL, deployed by all engines against real AWS. Full methodology, parity notes, and reproduction scripts live in [cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

| Scenario | Stack | cdkd | cdkd `--no-wait` | Terraform | CloudFormation |
| --- | --- | ---: | ---: | ---: | ---: |
| wide | 48 independent resources (S3 / DynamoDB / SQS / SNS / SSM / Logs, 8 each) | **25.4** | 25.3 | 50.4 | 85.9 |
| serverless | Lambda ×3 + HTTP API + DynamoDB + SNS / SQS + EventBridge | **31.4** | 31.8 | 57.9 | 124.2 |
| webapp | VPC + NAT + subnets + DynamoDB + SQS + S3 + Lambda ×2 + HTTP API | 127.0 | **32.4** | 127.8 | 161.9 |
| cloudfront | S3 origin + CloudFront + OAC | **171.2** | **17.8** | 191.1 | 208.1 |

Cold end-to-end wall clock, median of 3 runs, seconds, `us-east-1`, cdkd v0.260.10. Unlike the tables above, these numbers include synth (cdkd / CDK) and plan (Terraform); one-time setup (`npm install` / `cdk bootstrap` / `terraform init`) is excluded for all tools. For parity, CDK-only extras (the `restrictDefaultSecurityGroup` custom resource and CDK-managed log groups) were disabled so cdkd / CloudFormation don't carry resources the Terraform config doesn't have.

- **The winner depends on the stack's shape.** On wide, parallel stacks (wide, serverless) cdkd is ~2x faster than Terraform. Where a single slow resource dominates (webapp's NAT Gateway, cloudfront's propagation), physical provisioning time sets a common floor: webapp is a true tie (0.8s apart), and only `--no-wait` gets below the floor.
- **This benchmark also made cdkd faster.** Chasing the initial webapp / cloudfront losses surfaced four real deploy-speed bugs (longest-pole scheduling, a missing EIP SDK provider, NAT Gateway and CloudFront polling intervals), fixed in [#1175](https://github.com/go-to-k/cdkd/pull/1175) and [#1177](https://github.com/go-to-k/cdkd/pull/1177). The numbers above are from the fixed version.
