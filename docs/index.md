---
layout: entry
title: cdkd
description: Deploy AWS CDK apps directly via AWS APIs — up to 15x faster, no CloudFormation.
hero:
  name: cdkd
  text: Deploy CDK apps directly. Skip CloudFormation.
  tagline: Drop-in CDK CLI for existing CDK apps — up to 15x faster dev/test deploys via direct AWS SDK calls instead of CloudFormation.
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: Introduction
      link: /introduction/
    - theme: alt
      text: GitHub
      link: https://github.com/go-to-k/cdkd
features:
  - icon: ⚡
    title: Up to 15x faster deploys
    details: Direct SDK calls, aggressive parallelization, and --no-wait to skip slow stabilization waits — faster than Terraform and CloudFormation Express mode too.
    link: /introduction/
    linkText: See the benchmarks
  - icon: 🪣
    title: S3-based state management
    details: No DynamoDB required — state lives in S3 with optimistic locking via S3 conditional writes, keyed by stack name and region.
    link: /state-management/
    linkText: State management
  - icon: 🔀
    title: Event-driven parallel DAG
    details: Ref / Fn::GetAtt dependencies become a dependency graph; each resource dispatches the moment its dependencies complete — no level barriers.
    link: /architecture/
    linkText: How it works
  - icon: 🔄
    title: Bidirectional CloudFormation migration
    details: Adopt existing CFn stacks with cdkd import --migrate-from-cloudformation, and hand a stack back to CloudFormation with cdkd export when it's production-ready.
    link: /import/
    linkText: Import & export
  - icon: 🐳
    title: Local execution
    details: cdkd local runs your Lambdas, API Gateway routes, ECS tasks, ALBs, and CloudFront distributions on your machine — resolving env vars and secrets from your real deployed stack.
    link: /local-emulation/
    linkText: Local execution
  - icon: 🔍
    title: Drift, rollback, and diff
    details: CloudFormation-parity safety without CloudFormation — property-level diff, drift detection with accept/revert, and automatic rollback on failed deploys.
    link: /cli-reference/
    linkText: CLI reference
---

cdkd is a drop-in CDK CLI for existing CDK apps: your CDK code runs as-is, and you just replace `cdk deploy` with `cdkd deploy`. It deploys directly via AWS SDK and Cloud Control API calls instead of CloudFormation, which makes dev/test iteration dramatically faster. Use cdkd for rapid iteration alongside the AWS CDK CLI, which stays in charge of production.

> **IMPORTANT**: cdkd is for dev/test workflows only — early in development, not yet production-ready.
