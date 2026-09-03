# cdkd (CDK Direct)

[![npm version](https://img.shields.io/npm/v/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![Downloads](https://img.shields.io/npm/dw/@go-to-k/cdkd.svg)](https://www.npmjs.com/package/@go-to-k/cdkd)
[![License: Apache-2.0](https://img.shields.io/npm/l/@go-to-k/cdkd.svg)](./LICENSE)

Drop-in CDK CLI for existing CDK apps — up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation.

**📚 Documentation: [cdkd.dev](https://cdkd.dev)**

- **Drop-in CDK compatible**: your existing CDK app code runs as-is; just replace `cdk deploy` with `cdkd deploy`.
- **Up to 15x faster deploys**: direct SDK calls, aggressive parallelization, and `--no-wait` to skip slow stabilization waits; **faster than Terraform and CloudFormation Express mode** too (see [Benchmark](#benchmark)).

![cdk deploy vs cdkd deploy — side-by-side, 35s recording, real AWS deploy. cdkd finishes while cdk is still creating its CloudFormation changeset.](https://raw.githubusercontent.com/go-to-k/cdkd/main/assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow: no migration needed. You can also [import](https://cdkd.dev/import/) existing stacks into cdkd or [export](https://cdkd.dev/export/) back to CloudFormation anytime.

**A natural fit for AI-driven development.** AI coding agents iterate in tight spin-up / tear-down loops — and cdkd keeps each turn short, with fast deploys and an equally fast `cdkd destroy` that deletes via direct SDK calls instead of polling a CloudFormation stack-delete.

**Local execution from your deployed stack.** `cdkd local` runs your functions, APIs, and ECS tasks on your machine. It can resolve env vars, secrets, and resource references from your real deployed stack: no hand-written `.env` files, no hand-seeded test data (see [Local execution](https://cdkd.dev/local-emulation/)).

> [!IMPORTANT]
> cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Installation

```bash
npm i -g @go-to-k/cdkd          # latest release
npm i -g @go-to-k/cdkd@0.0.2    # pin to a specific version
```

The installed binary is `cdkd`.

## Quick Start

> **First-time setup**: run `cdkd bootstrap` once per AWS account before any
> other command; it replaces `cdk bootstrap`, which cdkd does not require
> (details in [Getting Started](https://cdkd.dev/getting-started/)).

```bash
# Bootstrap (creates S3 state bucket + asset storage — one-time setup per AWS account)
cdkd bootstrap

# List stacks in the CDK app
cdkd list

# Deploy your CDK app
cdkd deploy

# Deploy at maximum speed: skip slow stabilization waits
cdkd deploy --no-wait

# Check what would change
cdkd diff

# Tear down
cdkd destroy
```

## Benchmark

**cdkd deploys up to 15x faster than AWS CDK (CloudFormation)** on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

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

Best of 3 runs, deploy-phase only, seconds, `us-west-2`.

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

Cold end-to-end wall clock including synth / plan, median of 7 runs, seconds, `us-east-1`.

Full methodology, distribution analysis, per-run data, and the complete suite (SDK Provider path, Cloud Control fallback path, the 15x headline stack): **[cdkd.dev/benchmarks/](https://cdkd.dev/benchmarks/)**.

## Features

- **Hybrid provisioning** — SDK Providers for fast direct API calls, Cloud Control API fallback for broad coverage ([supported resources](https://cdkd.dev/supported-resources/))
- **DAG-based parallel deploys** with S3-backed state and optimistic locking — no CloudFormation, no DynamoDB ([concepts](https://cdkd.dev/concepts/))
- **`--no-wait` / `--full-wait`** — choose what "done" means for async resources ([wait modes](https://cdkd.dev/wait-modes/))
- **Rollback on failure** plus a standalone, synth-free `cdkd rollback` ([rollback](https://cdkd.dev/rollback/))
- **Local execution** — Lambda, API Gateway, ECS, ALB, CloudFront, and Bedrock AgentCore on your machine ([local execution](https://cdkd.dev/local-emulation/))
- **Bidirectional CloudFormation migration** — `cdkd import --migrate-from-cloudformation` adopts CFn stacks; `cdkd export` hands them back ([import](https://cdkd.dev/import/) / [export](https://cdkd.dev/export/))
- **Mixed cdkd / CloudFormation estates** — `Fn::ImportValue` / `Fn::GetStackOutput` fall back to CloudFormation for producer stacks still on `cdk deploy` ([mixed estates](https://cdkd.dev/mixed-estates/))
- **Drift detection** — `cdkd drift` with `--accept` / `--revert`, no synth needed ([drift](https://cdkd.dev/drift/))
- **Per-PR CI environments** — disposable stacks that deploy concurrently and tear down from state alone ([CI per PR](https://cdkd.dev/ci-per-pr/))

## Documentation

Full documentation lives at **[cdkd.dev](https://cdkd.dev)**:

- [Getting Started](https://cdkd.dev/getting-started/)
- [CLI Reference](https://cdkd.dev/cli-reference/)
- [Local Execution](https://cdkd.dev/local-emulation/)
- [Import / Export — CloudFormation migration](https://cdkd.dev/import/)
- [Troubleshooting](https://cdkd.dev/troubleshooting/)

## Use with AI Coding Agents

This repository ships a [`cdkd` skill](https://github.com/go-to-k/cdkd/blob/main/plugins/cdkd-skills/skills/cdkd/SKILL.md)
that teaches AI coding agents to use cdkd safely ([AI agents guide](https://cdkd.dev/ai-agents/)).

### Claude Code

Install it as a plugin (one-time setup) by running these inside a Claude Code session:

```text
/plugin marketplace add go-to-k/cdkd
/plugin install cdkd-skills@cdkd
```

Then ask Claude to deploy a dev/test CDK stack with cdkd — the skill
triggers automatically — or invoke it directly with `/cdkd`.

### Other agents (Codex, Cursor, and more)

Any agent that supports the SKILL.md format can use the skill. Install it
with the [GitHub CLI](https://github.blog/changelog/2026-04-16-manage-agent-skills-with-github-cli/)
(v2.90+) or [`npx skills`](https://github.com/vercel-labs/agent-skills):

```bash
gh skill install go-to-k/cdkd cdkd
# or
npx skills add go-to-k/cdkd --skill cdkd
```

### Contributors

To test the current checkout against another CDK project, clone this
repository and add it to a Claude Code session — the project-scoped
[`/use-cdkd`](.claude/skills/use-cdkd/SKILL.md) skill covers building and
linking the checkout:

```bash
claude --add-dir /path/to/cdkd
```

## License

Apache 2.0
