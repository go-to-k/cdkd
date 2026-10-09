---
title: Introduction
description: What cdkd is for, how it complements the AWS CDK CLI, and how much faster it is — benchmarked against CloudFormation, Express mode, and Terraform.
---

# Introduction

cdkd is a drop-in CDK CLI for existing CDK apps — up to 15x faster deploys via direct AWS SDK calls instead of CloudFormation.

- **Drop-in CDK compatible**: your existing CDK app code runs as-is; just replace `cdk deploy` with `cdkd deploy`.
- **Up to 15x faster deploys**: direct SDK calls, aggressive parallelization, and `--no-wait` to skip slow stabilization waits; **faster than Terraform and CloudFormation Express mode** too (see [Benchmarks](benchmarks.md)).

![cdk deploy vs cdkd deploy](https://raw.githubusercontent.com/go-to-k/cdkd/main/assets/cdk-vs-cdkd.gif)

**cdkd complements the AWS CDK CLI rather than replacing it.** Use cdkd in dev/test for rapid iteration; use the AWS CDK CLI in production for full CloudFormation tooling. Install cdkd alongside an existing `cdk deploy` workflow: no migration needed. You can also [import](import.md) existing stacks into cdkd or [export](export.md) back to CloudFormation anytime.

**A natural fit for AI-driven development.** AI coding agents iterate in tight spin-up / tear-down loops — and cdkd keeps each turn short, with fast deploys and an equally fast `cdkd destroy` that deletes via direct SDK calls instead of polling a CloudFormation stack-delete. See [Using cdkd with AI coding agents](ai-agents.md).

**Local execution from your deployed stack.** `cdkd local` runs your functions, APIs, and ECS tasks on your machine. It can resolve env vars, secrets, and resource references from your real deployed stack: no hand-written `.env` files, no hand-seeded test data (see [Local execution](local-emulation.md)).

> **IMPORTANT**: cdkd is for dev/test workflows only — early in development, not yet production-ready.

## Next steps

- [Getting Started](getting-started.md) — install cdkd and run your first deploy
- [Benchmarks](benchmarks.md) — vs CloudFormation, Express mode, and Terraform
- [Core Concepts](concepts.md) — how cdkd works under the hood
