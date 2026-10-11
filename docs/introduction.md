---
title: Introduction
description: What cdkd is, when to use it next to the AWS CDK CLI, and where to go in these docs for what you want to do.
---

# Introduction

cdkd is a CDK CLI that deploys your existing CDK app by calling AWS APIs
directly, without going through CloudFormation. Deploys are up to 15x faster,
and your CDK code does not change: you run `cdkd deploy` where you ran
`cdk deploy`.

![cdk deploy vs cdkd deploy](https://raw.githubusercontent.com/go-to-k/cdkd/main/assets/cdk-vs-cdkd.gif)

## Where the speed comes from

`cdk deploy` hands a template to CloudFormation and waits for the service to
work through it. cdkd reads the same template and does the work itself:

- It calls each service's API directly, through the AWS SDK or the Cloud
  Control API.
- It runs resources in parallel, starting each one the moment the resources it
  depends on are done.
- With `--no-wait` it returns as soon as each create call returns, and lets
  AWS finish slow resources such as CloudFront and RDS in the background.

`cdkd destroy` is fast for the same reasons. The [Benchmarks](benchmarks.md)
compare cdkd with CloudFormation, CloudFormation Express mode and Terraform.

## When to use it

Use cdkd where you deploy often and want the loop short: your own dev stacks,
test environments, per-pull-request environments in CI, and the spin-up and
tear-down loops of AI coding agents.

Keep using the AWS CDK CLI for production. cdkd complements it and does not
replace it: CloudFormation gives production change sets, stack policies and
the rest of its tooling, and one CDK app can be deployed by both tools to
different environments. You can also move a stack between them at any time,
[importing](import.md) a CloudFormation stack into cdkd or
[exporting](export.md) a cdkd stack back.

> [!IMPORTANT]
> cdkd is for dev and test workflows only. It is early in development and not
> yet production-ready.

## What else it does

- **Local execution.** `cdkd local` runs your Lambda functions, APIs and ECS
  tasks on your machine, and can take environment variables, secrets and
  resource references from the real deployed stack, so you do not write a
  `.env` file by hand. See [Local Execution](local-emulation.md).
- **Recovery and inspection.** Rollback of a failed deploy, drift detection
  against live AWS, and a per-run event history are built in.

## Find your way

::: card-grid

::: card Try it on your CDK app
Install, bootstrap, deploy, tear down. [Getting Started](getting-started.md)
:::

::: card Understand what a deploy does
The pipeline, state, and how changes are decided.
[Core Concepts](concepts.md)
:::

::: card Make deploys faster
What `--no-wait` skips and when it is safe. [Wait Modes](wait-modes.md)
:::

::: card Recover from a failed deploy
What is undone and what you run. [Rollback](rollback.md), and
[Troubleshooting](troubleshooting.md) for a specific error.
:::

::: card Use cdkd next to CloudFormation
One app, two tools. [Mixed Estates](mixed-estates.md),
[Importing Existing Resources](import.md),
[Exporting to CloudFormation](export.md)
:::

::: card Give every pull request an environment
Deploy on open, destroy on close. [Per-PR Environments in CI](ci-per-pr.md)
:::

::: card Run your app locally
Functions, APIs and tasks on your machine.
[Local Execution](local-emulation.md)
:::

::: card Work with an AI coding agent
Install the cdkd skill. [Use with AI Coding Agents](ai-agents.md)
:::

::: card Look something up
Every command and flag in the [CLI Reference](cli-reference.md); which
resource types work in [Supported Resources](supported-resources.md).
:::

:::
