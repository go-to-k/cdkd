---
title: Benchmarks
description: "Measured deploy times for cdkd against CloudFormation, CloudFormation Express mode and Terraform, per stack, with how each number was taken."
---

# Benchmarks

cdkd deploys up to 15x faster than the AWS CDK CLI, which deploys through
CloudFormation. The gap grows with the size of the stack and with how much of
the stack can be created in parallel.

| Compared with | Stack | Result |
| --- | --- | ---: |
| CloudFormation | 5 independent resources | 5.5x faster |
| CloudFormation | VPC + CloudFront + Lambda, with `--no-wait` | 15x faster |
| CloudFormation | Types deployed through the Cloud Control API | 1.6x faster |
| CloudFormation Express mode | VPC + CloudFront + Lambda, with `--no-wait` | 9x faster |
| Terraform | Wide and serverless stacks | 2.2x to 2.3x faster |
| Terraform | Stacks dominated by one slow resource | 1.2x to 1.3x faster, or a tie |

cdkd does not make AWS itself faster. It removes the time a deploy tool spends
between API calls, so the gain is largest where that time is most of the
deploy.

## How the numbers were measured

All times are in seconds, and every deploy ran against real AWS. One-time
setup (`npm install`, `cdk bootstrap`, `terraform init`) is excluded
everywhere.

The CloudFormation and Terraform comparisons were measured in different ways,
so do not compare a number from one with a number from the other.

- **Against CloudFormation**, only the deploy phase is timed. Synthesis is
  left out because cdkd and the AWS CDK CLI run the same CDK code through the
  same synthesizer, so it costs the same on both sides.
- **Against Terraform**, the whole run is timed from a cold start, including
  synthesis and Terraform's `plan`. Each number is the median of 7 runs in
  `us-east-1`.

The Terraform comparison follows two more rules. Every run is a first deploy
with resource names AWS has not seen before, because some resources become
ready sooner under a name that was used before. A result is called a win only when no cdkd run overlaps any
Terraform run, and anything else is reported as a tie.

## vs CloudFormation

### 5 independent resources: 5.5x faster

The stack has an S3 bucket, a DynamoDB table, an SQS queue, an SNS topic and
an SSM parameter. None depends on another, so cdkd creates all five in
parallel. Each type has an SDK provider, which is cdkd's own code for calling
that service directly.

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **94.4s** | **17.0s** | **5.5x** |

### VPC + CloudFront + Lambda: 15x faster with `--no-wait`

The stack has a VPC (2 AZs, a NAT gateway, public and private subnets), a
Lambda function inside the VPC, a Lambda function URL, a CloudFront
distribution, an SQS queue, an event source mapping and a consumer Lambda.

| | AWS CDK (CFn) | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: |
| Deploy | **599s** | 96s (~6x) | **40s (15.0x)** |

By default, cdkd does not wait for CloudFront to finish propagating, which
takes about 5 minutes. It also creates the distribution, the function URL and
the VPC Lambda while the NAT gateway is still coming up. The NAT gateway is
then the slowest part of the deploy. `--no-aggressive-vpc-parallel` turns that
parallelism off.

`cdkd deploy --no-wait` also returns before the NAT gateway is ready, which
gives the 15x figure.

The ~6x ratio is approximate, because the cdkd default was measured in a later
round than the other two cells.

### Types deployed through the Cloud Control API: 1.6x faster

The stack has 3 SSM documents and 2 Athena workgroups. cdkd has no SDK
provider for either type, so it deploys them through the Cloud Control API,
AWS's generic resource API. That path is slower per call.

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **64.9s** | **40.9s** | **1.6x** |

## vs CloudFormation Express mode: up to 9x faster

CloudFormation's
[Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/)
is a fast-deploy option that skips the wait for resources to stabilize. It is
similar in spirit to cdkd's `--no-wait`.

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

Best of 3 runs, in `us-west-2`. The first row is the VPC + CloudFront + Lambda
stack from the previous section.

- On most stacks cdkd is about 1.5x to 2x faster than Express. SQS finishes in
  9s against Express's 22s (~2.4x).
- On the stack with slow resources the gap is larger. The cdkd default takes
  96s against Express's 366s (~3.8x), and `--no-wait` takes 40s (~9x).
- S3 is the one stack where Express beats cdkd's default, 22s against 23s. A
  single near-instant resource leaves little to run in parallel.

## vs Terraform

The same stacks were written both as CDK apps and as Terraform configurations,
and each tool deployed them.

| Scenario | What it deploys |
| --- | --- |
| wide | 48 independent resources: S3, DynamoDB, SQS, SNS, SSM, Logs, 8 each |
| serverless | 3 Lambda functions, HTTP API, DynamoDB, SNS, SQS, EventBridge |
| ec2 | VPC, subnet, security group, IAM role, 3 EC2 instances (t3.micro + EBS) |
| webapp | VPC with NAT, DynamoDB, SQS, S3, 2 Lambda functions, HTTP API |
| ecs | VPC across 2 AZs, Fargate cluster, task and service, ALB, target group |
| cloudfront | S3 origin, CloudFront distribution, OAC |

| Scenario | cdkd | Terraform | CloudFormation | cdkd `--no-wait` |
| --- | ---: | ---: | ---: | ---: |
| wide | **20.0** | 46.1 | 89.1 | 21.1 |
| serverless | **25.9** | 57.5 | 127.1 | 24.6 |
| ec2 | **29.1** | 35.9 | 193.9 | 22.0 |
| webapp | 109.7 | 127.3 | 166.1 | 23.4 |
| ecs | **162.8** | 209.5 | 276.7 | 34.5 |
| cloudfront, until `Deployed` | 174.0 | 166.4 | 232.3 | n/a |

Bold marks a win over Terraform. The other two rows are ties.

cdkd's lead depends on how much of the deploy is the tool's own work. The wide
and serverless stacks are almost all scheduling and API calls, and there cdkd
is about 2.2x to 2.3x faster than Terraform. Where one slow resource takes
most of the time, both tools wait for the same thing and the gap narrows:
1.23x on ec2 and 1.29x on ecs.

On webapp the cdkd median is 17.6s lower, but the runs overlap (98-138s
against 106-138s), because NAT gateway creation varies by more than the gap.
On cloudfront the Terraform median is 7.6s lower and the ranges overlap fully.
Differences of a few seconds are not meaningful in any row: re-running a
scenario hours later moved the cdkd median by 1.1s on wide and 4.5s on
serverless.

### Both tools wait for the same thing

The first three columns compare the tools under the same definition of
"done", so cdkd is not ahead because it waits for less.

CloudFront needs care, because the defaults differ. cdkd's default returns
once the distribution is created. Terraform's default and CloudFormation wait
until the distribution is `Deployed`. The cloudfront row therefore uses
`cdkd deploy --full-wait`, which waits for `Deployed` too. When neither tool
waits, cdkd takes 11.1s and Terraform 10.3s (`wait_for_deployment = false`),
which is also a tie.

On ecs, cdkd's default does not wait for the service to reach a steady state,
and neither does Terraform's. With both tools waiting for it, `cdkd
--full-wait` takes 227.7s against Terraform's 282.7s (1.24x).

The `--no-wait` column has no Terraform counterpart. `cdkd deploy --no-wait`
skips the wait for every resource type, and Terraform offers a per-resource
argument on a few types only.

## Reproduce

For the CloudFormation comparison, run `./tests/benchmark/run-benchmark.sh
all` from the root of the cdkd repository. It runs the 5-resource and the
VPC + CloudFront + Lambda benchmarks, and the
[benchmark harness README](https://github.com/go-to-k/cdkd/blob/main/tests/benchmark/README.md)
has the details.

The Terraform comparison, with its full methodology and scripts, is in
[cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

## Related

- [Wait Modes](wait-modes.md): the flags most of these numbers depend on
- [Deploy: waits & concurrency](cli-deploy.md): what cdkd waits for, per
  resource type
- [Core Concepts](concepts.md): how a deploy works
