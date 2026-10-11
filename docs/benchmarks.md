---
title: Benchmarks
description: "Measured deploy times for cdkd against CloudFormation, CloudFormation Express mode and Terraform, per stack, with how each number was taken."
---

# Benchmarks

cdkd deploys up to 15x faster than the AWS CDK CLI (CloudFormation). The gap
grows with the size of the stack and with how much of it can run in parallel.

| Compared with | Stack | Result |
| --- | --- | ---: |
| CloudFormation | 5 independent resources, SDK providers | 5.5x faster |
| CloudFormation | VPC + CloudFront + Lambda, with `--no-wait` | 15x faster |
| CloudFormation | Types on the Cloud Control fallback | 1.6x faster |
| CloudFormation Express mode | VPC + CloudFront + Lambda, with `--no-wait` | 9x faster |
| Terraform | Wide and serverless stacks | 2.2x to 2.3x faster |
| Terraform | Stacks dominated by one slow resource | 1.2x to 1.3x faster, or a tie |

cdkd does not make AWS itself faster. It removes orchestration time, so the
gain is largest where orchestration is most of the wall clock.

## How to read these numbers

There are two campaigns, measured differently. Do not compare a number from
one with a number from the other.

| | vs CloudFormation | vs Terraform |
| --- | --- | --- |
| What is timed | Deploy phase only | Cold end-to-end wall clock |
| Includes synth / plan | No | Yes |
| Runs per cell | See below | Median of 7 |
| Region | See below | `us-east-1` |

Times are in seconds, and the `Speedup` columns are ratios. On the
CloudFormation side, only the Express-mode table records a run count and
region for the whole table: best of 3, `us-west-2`. The other three tables
state neither.

Synth is left out of the CloudFormation comparison because it is identical on
both sides: cdkd and the AWS CDK CLI run the same code through the same
`aws-cdk-lib` synthesizer. The Terraform campaign includes it, because
Terraform's `plan` has no cdkd counterpart to cancel it out. One-time setup
(`npm install`, `cdk bootstrap`, `terraform init`) is excluded everywhere.

The Terraform campaign follows three rules. Dropping any of them changes a
number.

- **Every run is a first deploy.** Each run gives every tool resource names
  AWS has never seen. An IAM instance profile re-created under a used name
  reaches EC2 about 5x faster than a fresh one (1.5s against a 7.9s median).
  cdkd waits for the real propagation and Terraform pays a fixed wait, so a
  fixed-name benchmark would favor cdkd by seconds no first deploy sees.
- **A win is claimed only where the run distributions separate.** Overlapping
  ranges are reported as ties, with the direction the median leans.
- **Both tools are held to the same definition of "done".** Where their
  defaults disagree, the scenario gets one row per definition, and a cell
  that is not its tool's default names the flag that selects it.

For parity, CDK-only extras (the `restrictDefaultSecurityGroup` custom
resource and CDK-managed log groups) were disabled, so cdkd and
CloudFormation do not carry resources the Terraform configuration lacks.

## vs CloudFormation

### SDK provider path: 5.5x faster

Stack: S3 bucket, DynamoDB table, SQS queue, SNS topic and SSM parameter.
The five resources are independent, so cdkd runs them in parallel.

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **94.4s** | **17.0s** | **5.5x** |

### VPC + CloudFront + Lambda: 15x faster with `--no-wait`

Stack: 1 VPC (2 AZs, NAT gateway, public and private subnets), a Lambda
function with `VpcConfig`, a Lambda function URL (AWS_IAM), a CloudFront
distribution (OAC, caching disabled), an SQS queue, an event source mapping
and a consumer Lambda.

| | AWS CDK (CFn) | cdkd | cdkd `--no-wait` |
| --- | ---: | ---: | ---: |
| Deploy | **599s** | 96s (~6x) | **40s (15.0x)** |

The default already leaves CloudFront's propagation (about 5 minutes) to
finish in the background, and runs the distribution, the function URL and the
VPC Lambda in parallel with NAT gateway propagation. That gives about 6x,
with NAT stabilization as the remaining critical path.
`--no-aggressive-vpc-parallel` turns that parallelism off.

The 15x figure needs `cdkd deploy --no-wait`, which also returns before the
NAT gateway stabilizes.

The cdkd default cell was re-measured on cdkd 0.272.0 (96 / 107 / 115s, best
of 3). The CloudFormation and `--no-wait` cells are from an earlier round, so
read the ~6x ratio as approximate.

### Cloud Control API fallback path: 1.6x faster

Stack: 3 SSM documents and 2 Athena workgroups. Neither type has an SDK
provider, so both go through the Cloud Control API.

| | AWS CDK (CFn) | cdkd | Speedup |
| --- | ---: | ---: | ---: |
| Deploy | **64.9s** | **40.9s** | **1.6x** |

### Reproduce

From the repository root:

```bash
./tests/benchmark/run-benchmark.sh all
```

This runs the SDK provider path and the VPC + CloudFront + Lambda benchmarks.
See the
[benchmark harness README](https://github.com/go-to-k/cdkd/blob/main/tests/benchmark/README.md)
for details.

## vs CloudFormation Express mode: up to 9x faster

CloudFormation's
[Express mode](https://aws.amazon.com/about-aws/whats-new/2026/06/aws-cloudformation-cdk/)
is a fast-deploy option that skips resource stabilization waits, similar in
spirit to cdkd's `--no-wait`.

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

Best of 3 runs, seconds, `us-west-2`. The first stack is the VPC + CloudFront
+ Lambda stack described above. Its cdkd default cell was re-measured on cdkd
0.272.0 (96 / 107 / 115s, best of 3); the other cells are from an earlier
round.

- **Most stacks: about 1.5x to 2x faster than Express.** SQS finishes in 9s
  against Express's 22s (~2.4x).
- **Stacks with slow asynchronous resources: much more.** On the VPC +
  CloudFront stack the cdkd default takes 96s against Express's 366s (~3.8x),
  and `--no-wait` takes 40s (~9x) by also skipping the NAT stabilization
  wait.
- **S3 is the one case where Express beats cdkd's default** (22s against
  23s). A single near-instant resource leaves little to parallelize, and
  `--no-wait` makes no difference there.

## vs Terraform

The same logical stacks were written both as CDK apps and as Terraform HCL
and deployed by every engine against real AWS. The methodology, parity notes
and reproduction scripts are in
[cdkd-bench-terraform](https://github.com/go-to-k/cdkd-bench-terraform).

| Scenario | Stack | cdkd | Terraform | CloudFormation | cdkd `--no-wait` | Terraform, waits skipped |
| --- | --- | ---: | ---: | ---: | ---: | ---: |
| wide | 48 independent resources (S3 / DynamoDB / SQS / SNS / SSM / Logs, 8 each) | **20.0** | 46.1 | 89.1 | 21.1 | no opt-out exists |
| serverless | Lambda x3 + HTTP API + DynamoDB + SNS / SQS + EventBridge | **25.9** | 57.5 | 127.1 | 24.6 | no opt-out exists |
| ec2 | VPC + subnet + SG + IAM role + EC2 instance x3 (t3.micro + EBS) | **29.1** | 35.9 | 193.9 | 22.0 | no opt-out exists |
| webapp | VPC + NAT + subnets + DynamoDB + SQS + S3 + Lambda x2 + HTTP API | 109.7 | 127.3 | 166.1 | 23.4 | no opt-out exists |
| ecs | VPC x2 AZ + Fargate cluster / task / service + ALB + target group | **162.8** | 209.5 | 276.7 | 34.5 | 209.5 (already the default) |
| cloudfront — created (fire and forget) | S3 origin + CloudFront + OAC | 11.1 | no such mode (see `Deployed` row) | no such mode | 10.4 | 10.3 (`wait_for_deployment = false`) |
| cloudfront — `Deployed` | S3 origin + CloudFront + OAC | 174.0 (`--full-wait`) | 166.4 | 232.3 | n/a | n/a |

Median of 7 runs, seconds, `us-east-1`. Bold marks a win: no cdkd run
overlaps any Terraform run. One cdkd binary produces every number within a
measurement round. The cloudfront rows were measured on cdkd 0.272.0, all six
modes interleaved in one round; the other scenarios are from an earlier
round.

### What the table shows

**The result depends on how much of the wall clock is orchestration.** On
wide, parallel stacks (wide, serverless) cdkd is about 2.2x to 2.3x faster
than Terraform, because nearly the whole deploy is scheduling and API calls.
Where one slow resource dominates, the gap narrows toward the floor both
tools share: ec2 1.23x, ecs 1.29x, and cloudfront a tie in both rows.

**Four rows are wins and three are ties.** In the bolded rows the run
distributions separate completely (exact Mann-Whitney p = 0.0006, the floor
at n=7 against n=7). The ties:

| Row | Median leans | Why it is a tie |
| --- | --- | --- |
| webapp | cdkd, by 17.6s | Runs span 98-138s against Terraform's 106-138s (p = 0.24); NAT gateway creation varies by more than the gap |
| cloudfront, fire and forget | Terraform, by 0.8s | Within noise |
| cloudfront, `Deployed` | Terraform, by 7.6s | Fully overlapping ranges: cdkd `--full-wait` 163.7-216.6s, Terraform 155.7-188.4s |

A tie means unproven at this sample size, for either side. The size of the
median gap is not the test: ec2 separates completely on 6.8s while webapp's
17.6s does not.

**Differences of a few seconds are not meaningful.** Re-running a scenario
with the same binary hours later moved the cdkd median by 1.1s on wide and
4.5s on serverless, and Terraform moved too.

### Why cloudfront has two rows

The tools' defaults disagree about what "done" means for a CloudFront
distribution. cdkd's default returns once `CreateDistribution` is accepted.
Terraform's default (`wait_for_deployment = true`) and CloudFormation wait
for `Deployed`. Each row compares the tools under one definition, and a cell
that is not its tool's default names the flag that selects that mode.

### Skipping waits is not a like-for-like capability

cdkd's `--no-wait` is one flag that covers every resource type. Terraform has
no global equivalent. The AWS provider offers a per-resource argument only
where one was added: here `aws_cloudfront_distribution.wait_for_deployment`
and `aws_ecs_service.wait_for_steady_state`. The second is already false by
default, so that cell repeats the default number. `aws_nat_gateway`,
`aws_instance` and every type in wide and serverless have none.

### cdkd is not winning by waiting for less

Every comparison uses a matching definition of "done". On ecs, `cdkd
--full-wait` against Terraform's `wait_for_steady_state = true` is 227.7s
against 282.7s (1.24x). The two cloudfront rows are same-definition pairs by
construction. [Deploy: waits & concurrency](cli-deploy.md) lists what cdkd
waits for per resource type.

## Related

- [Wait Modes](wait-modes.md): the flags most of these numbers turn on
- [Deploy: waits & concurrency](cli-deploy.md): what cdkd waits for, per
  resource type
- [Core Concepts](concepts.md): why the deploy is shaped the way it is
