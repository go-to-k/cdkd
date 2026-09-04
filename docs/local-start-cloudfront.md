---
title: cdkd local start-cloudfront
description: "Serve a CloudFront distribution locally — CloudFront Functions in a node:vm sandbox, S3 origins from local assets, and Lambda Function URL origins via the RIE container."
---

# cdkd local start-cloudfront

`cdkd local start-cloudfront [target]` serves one CloudFront distribution's
**viewer-request → origin → viewer-response** pipeline on a local port. Reach
for it when a rewrite function, a cache-behaviour path pattern or an SPA
fallback needs to be checked in seconds instead of a deploy round-trip. A
distribution built from CloudFront Functions and S3 origins runs entirely
in-process and needs no Docker; a Lambda Function URL origin or a Lambda@Edge
association runs its function in a local RIE container, which does.

```bash
cdkd local start-cloudfront MyStack/MyDistribution                            # serve one distribution
cdkd local start-cloudfront                                                   # pick a distribution interactively (TTY)
cdkd local start-cloudfront MyStack/MyDistribution --port 8080                # pin the listener port
cdkd local start-cloudfront MyStack/MyDistribution --origin SiteOrigin=./dist # serve an origin from a local directory
cdkd local start-cloudfront MyStack/MyDistribution --kvs-file RoutesKvs=./routes.json  # back cf.kvs() from a local file
cdkd local start-cloudfront MyStack/MyDistribution --from-cfn-stack --watch   # bind deployed state, hot-reload on source edits
```

## Options

`-a, --app`, `--no-pull` and `--stack-region` behave as they do on every
`cdkd local` subcommand; see
[Local Execution](local-emulation.md#common-flags). This command does **not**
accept `--env-vars` or `--container-host`, and its `--from-state` is inert — see
[State sources](#state-sources).

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | interactive picker | The distribution to serve, as a CDK construct path (`MyStack/MyDist`), an ancestor prefix, or a stack-qualified logical ID. Omit in a TTY to pick from a list. |
| `--port <port>` | `0` (auto-allocate) | Port the local HTTP server listens on. |
| `--host <host>` | `127.0.0.1` | Bind address. |
| `--origin <originId=dir>` | — | Serve one origin from a local directory. Repeatable. `<originId>` is the distribution's own `Origins[].Id` — see [Origins](#origins). |
| `--kvs-file <key=file.json>` | — | Back a CloudFront Function's `cf.kvs()` reads with a flat local JSON map. Repeatable. |
| `--tls` | off | Terminate real HTTPS. With `--tls-cert` / `--tls-key` it uses your PEM pair; otherwise it generates a self-signed certificate, which needs `openssl` on `PATH`. |
| `--tls-cert <path>` | — | PEM server certificate. Implies `--tls`; must be paired with `--tls-key`. |
| `--tls-key <path>` | — | PEM private key. Implies `--tls`; must be paired with `--tls-cert`. |
| `--no-pull` | off | Skip `docker pull` for a Lambda origin's base image and use the cached one. No-op for a distribution with no Lambda. |
| `--cache-origin` | off | Keep objects fetched from a deployed S3 origin in memory for the session instead of re-reading each request. |
| `--from-state` | off | Accepted, but **does nothing on this command**, and still conflicts with `--from-cfn-stack` — see [State sources](#state-sources). |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json`, then `cdkd-state-{accountId}` | S3 bucket holding cdkd state. Inert here, like `--from-state`. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. Inert here, like `--from-state`. |
| `--from-cfn-stack [name]` | off | Bind the same values to a deployed CloudFormation stack, for apps deployed with the CDK CLI. Bare form uses the resolved stack name. |
| `--stack-region <region>` | — | The CloudFormation client region under `--from-cfn-stack`. The state-record half does not apply here. |
| `--assume-role [arn]` | off | Assume a Lambda origin's deployed execution role and forward temporary credentials into its container. Omit the flag to keep your own shell credentials in the container. |
| `--watch` | off | Re-synth and re-resolve the distribution when the CDK source changes. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a path to a pre-synthesized cloud assembly. |
| `--output <path>` | `cdk.out` | Output directory for synthesis. |
| `-c`, `--context <key=value>` | — | Context value passed to synthesis. Repeatable. |
| `--region <region>` | `AWS_REGION` / stack / profile | AWS region for SDK calls. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | off | Answer interactive prompts with the recommended response. |
| `--verbose` | off | Verbose logging. |

**Spell the region lower-case.** This command does not fold an upper-cased
`--region` / `AWS_REGION` to its canonical spelling, and AWS rejects the raw
form at signature time (`SignatureDoesNotMatch`, `AuthorizationHeaderMalformed`).
See [`--region` / `AWS_REGION`](cli-reference.md#region-aws-region-every-command).

## State sources

**`--from-state` is inert on this command.** The three cdkd-state flags
(`--from-state`, `--state-bucket`, `--state-prefix`) parse and are then ignored:
the deployed-S3 origin reader and the KeyValueStore binding both look for
`--from-cfn-stack` specifically, and the Lambda origin and Lambda@Edge boot
paths resolve their environment without consulting cdkd state at all.

`--from-cfn-stack [name]` is the state source that works here. It binds a
deployed-S3 origin's bucket, backs `cf.kvs()` reads with the deployed
KeyValueStore, and resolves the environment of both Function URL origin Lambdas
and Lambda@Edge functions.

Passing `--from-state` and `--from-cfn-stack` together is still an error, so
drop `--from-state` rather than leaving it on as a no-op.

## Target resolution

The target names one `AWS::CloudFront::Distribution`, as a CDK construct path
(`MyStack/MyDistribution`), an ancestor prefix of one, or a stack-qualified
logical ID (`MyStack:MyDistribution`). Omitting it in a TTY opens an interactive
picker over every distribution in the synthesized app. One distribution is
served per invocation.

## What runs locally

| Piece of the distribution | How it is served |
| --- | --- |
| CloudFront Functions (`viewer-request` / `viewer-response`) | In-process, in a `node:vm` sandbox. No Docker. |
| Lambda@Edge associations (all four stages) | One warm RIE container per distinct function. Docker. |
| Lambda Function URL origins | The backing Lambda in a local RIE container. Docker. |
| S3 origin content | Read from the staged asset directory, or from real S3 under `--from-cfn-stack`. No Docker. |
| Path routing | In-process, across `DefaultCacheBehavior` plus the ordered `CacheBehaviors[]`, using CloudFront's `*` / `?` glob matching. |
| `DefaultRootObject` and `CustomErrorResponses` | Applied in-process — the root path resolves to the default root object, and error responses give the SPA fallback. |
| Custom (non-S3, non-Function-URL) origins | Not fetched. A warning at boot, `502` at request time — unless you point the origin at a directory with `--origin`. |
| CDN caching and edge locations | Not reproduced. `--cache-origin` is an origin read-through cache, not CloudFront's. |

### Origins

The `<originId>` in `--origin <originId=dir>` is matched verbatim against the
distribution's `Origins[].Id` in the synthesized template — not a construct
path and not a logical ID, and CDK generates those ids with a hash suffix. You
do not have to go looking for one: an S3 origin whose local source cannot be
resolved raises a boot-time warning that spells the flag out for you, including
`--origin <that id>=<dir>`. A custom (non-S3, non-Function-URL) origin warns
without naming the flag, but `--origin` works on it just the same — an override
is applied before the origin is classified, so pointing any origin at a
directory serves it from there.

S3 origin content is resolved out of the cloud assembly: the origin's bucket →
its `BucketDeployment` custom resource → `SourceObjectKeys` → the staged asset
directory. Reads are path-traversal safe — a resolved path that escapes the
origin directory, whether through `../` or a symlink, yields no read.

Two origins cannot be resolved that way, and each has a route out:

| Situation | Result | Remedy |
| --- | --- | --- |
| The bucket has no `BucketDeployment` in the app (files uploaded out of band, or a non-CDK bucket) | Warning at boot, `502` at request time | `--origin <id>=<dir>` to serve from disk, or `--from-cfn-stack` to read the deployed bucket from real S3 |
| The origin points at a custom domain that is neither S3 nor a Function URL | Warning at boot, `502` at request time | None — this origin shape is not served locally |

A URI ending in `/` is **not** auto-indexed, matching CloudFront: only the root
path resolves to `DefaultRootObject`, and a sub-path directory falls through to
a missing key unless a function rewrote it.

Under `--from-cfn-stack`, a deployed S3 origin is read from real S3 on every
request so out-of-band content changes are always current. `--cache-origin`
trades that for in-memory reuse across the session; the cache is cleared on a
`--watch` reload and on restart. Passing it without `--from-cfn-stack` is a
no-op, and a boot-time warning says so.

### CloudFront Functions

Both `cloudfront-js-1.0` and `cloudfront-js-2.0` are compiled and run. A `2.0`
async handler's promise is awaited. Each invocation gets a fresh sandbox, and
its synchronous portion is bounded at 5 seconds, so a runaway loop fails that
one request rather than wedging the server.

- A `viewer-request` function that returns an object with a `statusCode`
  short-circuits with a generated response — a redirect or a fixed body.
  Otherwise the rewritten request continues to the origin.
- A `viewer-response` function then runs over the origin response.
- A function that returns a non-object, or nothing, is treated as "continue
  unchanged", matching CloudFront's tolerance of an inspect-only function.
- A function with no `handler` function declared fails to compile, naming the
  function.

`cf.kvs()` reads are backed either by `--kvs-file <key>=<file.json>` (no AWS
calls) or by `--from-cfn-stack`, which reads the deployed store on demand. The
`<key>` is a KeyValueStore handle — the `AWS::CloudFront::KeyValueStore`
resource's logical ID, its construct path (`MyStack/RoutesKvs`), or its bare
construct ID (`RoutesKvs`) — so there is no need to synthesize and grep for a
hash-suffixed logical ID. An unrecognized key, or an ambiguous bare ID, fails at
boot with an error listing the distribution's KeyValueStore candidates. With no
binding resolved, `cf.kvs()` itself still returns a handle and the actionable
error surfaces on the first read.

## `--watch`: hot reload of the routing model

`--watch` re-synthesizes on every CDK source change and atomically swaps the
in-memory routing model under the live socket, so the port never closes.
`cdk.json`'s `watch.include` / `watch.exclude` are honored, and `cdk.out`,
`node_modules` and `.git` are always excluded. A reload also re-reads any
`--kvs-file` bindings and clears the deployed-S3 read-through cache. When
synthesis fails mid-reload, the previous version keeps serving and a warning is
printed.

Lambda containers — Function URL origins and Lambda@Edge alike — are booted once
at start-up and are **not** rebuilt by a reload. A Lambda@Edge association added
after start-up is skipped with a warning; restart to pick it up.

## Lifecycle

The server runs until it is signalled. `^C` (SIGINT) and SIGTERM close the
watcher and the HTTP server, stop every Lambda Function URL and Lambda@Edge
container, and close the deployed-S3 readers before exiting.

## Limitations

- Custom origins — anything that is neither an S3 origin nor a Lambda Function
  URL origin — are not served. They warn at boot and return `502`.
- The `cloudfront-js-2.0` `cf.fetch` origin API is not reproduced.
- `cf.kvs()` supports `get` and `exists`. `meta()` and `count()` reject with an
  error saying so.
- Lambda containers are booted once and are not rebuilt on a `--watch` reload.
- A Lambda@Edge function that cannot be booted is skipped with a warning, and its
  stage does not run; the rest of the distribution still serves.
- CloudFront's own CDN caching, edge locations and cache keys are not modelled.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Shut down on SIGTERM. |
| `1` | Hard error — no such distribution, synthesis failure, an unresolvable `--kvs-file` key, or a Lambda origin container that failed to boot. |
| `130` | Shut down on `^C` (SIGINT), or the interactive picker was cancelled. |

The full cross-command table is in the
[CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local invoke`](local-invoke.md) — one-shot Lambda invoke, the same RIE
  container a Function URL origin and a Lambda@Edge stage use
- [`cdkd local start-api`](local-start-api.md) — the API Gateway front door, for
  a distribution whose origin is an API rather than a bucket
- [`cdkd local start-alb`](local-start-alb.md) — the Application Load Balancer
  front door
- [Local Execution](local-emulation.md) — every `cdkd local` subcommand, Docker
  requirements, and the flags they share
- [CLI Reference](cli-reference.md) — every cdkd command, the output-stream
  contract, and the full exit-code table
