---
layout: entry
lastUpdated: false
title: cdkd
description: Deploy AWS CDK apps directly via AWS APIs — up to 15x faster, no CloudFormation.
hero:
  name: cdkd
  text: The fastest way to deploy AWS CDK.
  tagline: Drop-in CDK CLI for existing CDK apps — up to 15x faster dev/test deploys via direct AWS SDK calls instead of CloudFormation.
  image:
    src: /brand/logo-light.svg
    lightSrc: /brand/logo-light.svg
    darkSrc: /brand/logo-dark.svg
    alt: cdkd
    width: 826
    height: 725
  actions:
    - theme: brand
      text: Get Started
      link: /getting-started/
    - theme: alt
      text: Why cdkd?
      link: /introduction/
    - theme: alt
      text: GitHub
      link: https://github.com/go-to-k/cdkd
features:
  - icon: lucide:gauge
    title: Up to 15x faster deploys
    details: Direct AWS API calls, parallel deploys, and the --no-wait option.
  - icon: lucide:plug
    title: No code changes
    details: Your CDK app runs as-is — just replace cdk deploy with cdkd deploy.
  - icon: lucide:handshake
    title: Works alongside CDK CLI
    details: cdkd for dev/test, CloudFormation for staging and production — one CDK app serves both.
---

<div data-ox-island="cdkd-key-visual" data-cdkd-slot="hero-image"></div>

<div data-ox-island="cdkd-command" data-cdkd-slot="hero-content" data-ox-props='{"label":"Install cdkd","group":"pkg-manager","initial":"npm","tabs":[{"label":"npm","lines":["npm i -g @go-to-k/cdkd"]},{"label":"pnpm","lines":["pnpm add -g @go-to-k/cdkd"]},{"label":"yarn","lines":["yarn global add @go-to-k/cdkd"]},{"label":"bun","lines":["bun add -g @go-to-k/cdkd"]},{"label":"vp","lines":["vp install -g @go-to-k/cdkd"]}]}'></div>

## Benchmarks

cdkd deploys up to 15x faster than AWS CDK (CloudFormation) on SDK-Provider-handled stacks; the per-stack speedup widens with size and parallelism.

<div data-ox-island="cdkd-benchmark" data-ox-props='{"title":"VPC + CloudFront + Lambda stack","rows":[{"label":"AWS CDK (CFn)","seconds":599},{"label":"cdkd","seconds":96,"ratio":"~6x"},{"label":"cdkd","flag":"--no-wait","seconds":40,"ratio":"15.0x"}],"note":"Deploy phase only. The 15x figure requires cdkd deploy --no-wait, which returns as soon as each Create call returns and lets AWS finish NAT Gateway stabilization in the background too.","href":"/benchmarks/","linkText":"Benchmarks"}'></div>

## Where to start

::: card-grid

::: card Deploy your CDK app
Install, bootstrap, and run a first deploy. [Getting Started](getting-started.md)
:::

::: card See how it works
The pipeline, state, and how changes are decided. [Core Concepts](concepts.md)
:::

::: card Recover from a failure
Undo a failed deploy with [Roll Back a Failed Deploy](rollback.md), or look up the error in
[Troubleshooting](troubleshooting.md).
:::

::: card Use it next to CloudFormation
One CDK app, two tools. [Run Beside CloudFormation](mixed-estates.md)
:::

::: card Run it on your machine
Lambda functions, APIs and ECS tasks, locally. [Local Execution](local-emulation.md)
:::

::: card Look up a command
Every command and flag. [CLI Reference](cli-reference.md)
:::

:::
