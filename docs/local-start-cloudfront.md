---
title: local start-cloudfront
description: "Serve a CloudFront distribution locally — CloudFront Functions in a node:vm sandbox, S3 origins from local assets, and Lambda Function URL origins via the RIE container."
---

# `local start-cloudfront` (run a CloudFront distribution locally)

`cdkd local start-cloudfront [target]` serves a CloudFront
distribution's **viewer-request -> S3 / Lambda Function URL origin ->
viewer-response** pipeline locally so a routing-function change is
verifiable in seconds instead of a deploy round-trip. Models cdk-local's
`cdkl start-cloudfront`, inherited into cdkd's command tree as a thin
pass-through to `cdk-local`'s command factory. A CloudFront-Functions +
S3-origin-only distribution is pure-local (no Docker); a distribution
with a Lambda Function URL origin runs that origin's backing Lambda via
the RIE container (Docker required). It binds a Function URL origin's
backing Lambda + a deployed-S3 origin's bucket name to deployed state via
cdkd's S3-backed `--from-state` (after a prior `cdkd deploy`) OR
cdk-local's inherited `--from-cfn-stack` / `--stack-region` /
`--assume-role` (CloudFormation-deployed stacks). The two state sources
are mutually exclusive.

As of cdk-local 0.128.0 the start-cloudfront factory
accepts the `extraStateProviders` seam, so cdkd threads its `--from-state`
factory in and layers `--from-state` / `--state-bucket` / `--state-prefix`
on top — the same wiring as `start-agentcore` / `start-alb` /
`start-service` (`start-cloudfront` was `--from-state`-exempt
before the seam landed).

### `local start-cloudfront` target resolution

Names one `AWS::CloudFront::Distribution` by its CDK display path
(`MyStack/MyDistribution`). Omit the target in a TTY for an interactive
picker over every distribution in the synthesized app. A single
distribution is served per invocation.

### `local start-cloudfront` what runs locally

- **CloudFront Functions** (`cloudfront-js-1.0` / `2.0`) — the inline
  rewrite JS associated as `viewer-request` / `viewer-response` runs
  in-process in a `node:vm` sandbox (async 2.0 handlers awaited). A
  viewer-request function that returns a `statusCode` short-circuits with
  a generated response (redirect / fixed body); otherwise the rewritten
  request continues to the origin, then the viewer-response function runs
  over the origin response.
- **S3 origin content** — resolved out of the cloud assembly: the
  origin's bucket -> its `BucketDeployment` custom resource ->
  `SourceObjectKeys` -> the staged asset directory (or, under
  `--from-cfn-stack`, the deployed bucket served from real S3 on demand).
  Served with `DefaultRootObject` (root only — sub-paths are NOT
  auto-indexed, matching CloudFront) and `CustomErrorResponses` (the SPA
  fallback).
- **Lambda Function URL origins** — the origin's backing Lambda is run
  locally via the RIE container (the same path as `local invoke`), so a
  distribution that fronts a Function URL is served end-to-end.
- **Routing** — path patterns route across the `DefaultCacheBehavior` +
  ordered `CacheBehaviors[]` (CloudFront `*` / `?` glob matching).

### `local start-cloudfront` options

- `--port <n>` — listener port (default `0` = collision-bumped).
- `--host <ip>` — bind IP (default `127.0.0.1`).
- `--tls` / `--tls-cert <p>` / `--tls-key <p>` — terminate real HTTPS
  (user-supplied PEM pair or an auto-generated self-signed cert).
- `--origin <id>=<dir>` — point an origin at a local directory when
  `BucketDeployment` resolution can't (content uploaded out of band,
  non-CDK bucket). Repeatable.
- `--kvs-file <key>=<file>` — supply a CloudFront KeyValueStore's contents
  from a local JSON file (the AWS-free alternative to `--from-cfn-stack`,
  which reads the deployed store on demand). `<key>` is a KeyValueStore
  handle — its `AWS::CloudFront::KeyValueStore` resource logical id, its
  construct path (`MyStack/RoutesKvs`), or its bare construct id
  (`RoutesKvs`) — so you no longer have to synth + grep for the
  hash-suffixed logical id. An unrecognized key (or an ambiguous bare id)
  fails fast with an error listing the distribution's KeyValueStore
  candidates. Repeatable.
- `--cache-origin` — keep fetched deployed-S3 origin objects in memory
  (only meaningful under `--from-cfn-stack`). Setting it without
  `--from-cfn-stack` is a no-op and now logs a boot-time WARN saying so
  (a local BucketDeployment / `--origin <id>=<dir>` origin serves from
  disk and is never cached).
- `--no-pull` — skip `docker pull` for a Lambda Function URL origin's
  base image (no-op for a Function-URL-free distribution).
- `--from-state` / `--state-bucket <bucket>` / `--state-prefix <prefix>`
  — bind a Function URL origin's backing Lambda + a deployed-S3 origin's
  bucket name to cdkd's S3 state (after a prior `cdkd deploy`). Mutually
  exclusive with `--from-cfn-stack`. `--state-prefix` defaults to `cdkd`.
- `--from-cfn-stack [name]` / `--stack-region <region>` /
  `--assume-role [arn]` — the CloudFormation-deployed-stack counterpart of
  `--from-state` (for apps deployed via the upstream CDK CLI).
- `--watch` — re-synth + atomically swap the in-memory routing model
  under the live socket on every CDK source edit.

### `local start-cloudfront` scope

S3 origins + Lambda Function URL origins. A custom (non-S3, non-Function-URL)
origin, a `LambdaFunctionAssociations` Lambda@Edge association, and the
2.0 `cf.fetch` origin API are warn-and-skip (custom / unresolved origins
return 502).

