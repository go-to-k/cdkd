---
layout: entry
title: cdkd
description: Deploy AWS CDK apps directly via AWS APIs — up to 15x faster, no CloudFormation.
hero:
  name: cdkd
  text: Deploy CDK apps directly. Skip CloudFormation.
  tagline: Drop-in CDK CLI for existing CDK apps — up to 15x faster dev/test deploys via direct AWS SDK calls instead of CloudFormation.
  image:
    src: /brand/logo-dark.svg
    lightSrc: /brand/logo-light.svg
    darkSrc: /brand/logo-dark.svg
    alt: cdkd
    width: 192
    height: 192
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
    link: /benchmarks/
    linkText: See the benchmarks
  - icon: 🔌
    title: No code changes
    details: Your existing CDK app runs as-is — replace cdk deploy with cdkd deploy and that's the whole migration. No new DSL, no rewrite, no lock-in.
    link: /getting-started/
    linkText: Get started
  - icon: 🐳
    title: Local execution
    details: cdkd local runs your Lambdas, API Gateway routes, ECS tasks, ALBs, and CloudFront distributions on your machine — resolving env vars and secrets from your real deployed stack.
    link: /local-emulation/
    linkText: Local execution
  - icon: 🤝
    title: Use it alongside the CDK CLI
    details: cdkd for dev/test iteration, CloudFormation for staging and production — the same CDK app serves both, and cdkd import / export moves a stack between them anytime.
    link: /introduction/
    linkText: How they fit together
---
