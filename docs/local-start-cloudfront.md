---
title: cdkd local start-cloudfront
description: "Serve a CloudFront distribution from your CDK app on localhost: its CloudFront Functions, cache-behaviour routing, S3 origins, Lambda Function URL origins and Lambda@Edge."
---

# cdkd local start-cloudfront

`cdkd local start-cloudfront [target]` serves one CloudFront distribution on a
local port: viewer request, origin, viewer response. Use it to check a
rewrite function, a cache-behaviour path pattern or a single-page-app fallback
in seconds.

A distribution made of S3 origins and CloudFront Functions needs no Docker. A
Lambda Function URL origin or a Lambda@Edge association runs in a local
container and does.

## Serve a distribution

Given a static site in `MyStack`, deployed from the local `site/` directory:

```ts
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';

const bucket = new s3.Bucket(this, 'SiteBucket');
new s3deploy.BucketDeployment(this, 'DeploySite', {
  sources: [s3deploy.Source.asset('site')],
  destinationBucket: bucket,
});
new cloudfront.Distribution(this, 'MyDistribution', {
  defaultBehavior: { origin: origins.S3BucketOrigin.withOriginAccessControl(bucket) },
  defaultRootObject: 'index.html',
});
```

serve it on a fixed port:

```bash
cdkd local start-cloudfront MyStack/MyDistribution --port 8080
```

cdkd prints a `CloudFront distribution serving on` line with the address. The
files come from `site/` as staged in the cloud assembly, so nothing is read
from AWS:

```bash
curl -i http://127.0.0.1:8080/            # the default root object
curl -i http://127.0.0.1:8080/app.js      # any file under site/
```

More invocations:

```bash
cdkd local start-cloudfront                                                   # pick a distribution from a list
cdkd local start-cloudfront MyStack/MyDistribution --origin SiteOrigin=./dist # serve an origin from a directory
cdkd local start-cloudfront MyStack/MyDistribution --kvs-file RoutesKvs=./routes.json  # back cf.kvs() with a file
cdkd local start-cloudfront MyStack/MyDistribution --from-cfn-stack --watch   # deployed bucket and store, reload on edits
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The distribution to serve. Omit in an interactive terminal to choose from a list. |
| `--port <port>` | `0` (auto) | Port the server listens on. |
| `--host <host>` | `127.0.0.1` | Address the server binds to. |
| `--origin <originId=dir>` | — | Serve one origin from a local directory. Repeatable. See [Origins](#origins). |
| `--kvs-file <key=file.json>` | — | Back a CloudFront Function's `cf.kvs()` reads with a local JSON map. Repeatable. |
| `--tls` | off | Serve HTTPS, with a generated self-signed certificate (needs `openssl` on `PATH`) or your own. |
| `--tls-cert <path>` | — | PEM server certificate. Implies `--tls`. Requires `--tls-key`. |
| `--tls-key <path>` | — | PEM private key. Implies `--tls`. Requires `--tls-cert`. |
| `--from-cfn-stack [name]` | off | Read the deployed stack. See [State sources](#state-sources). |
| `--cache-origin` | off | Keep objects read from a deployed S3 origin in memory for the session. |
| `--assume-role [arn]` | off | Run a Lambda origin under its deployed execution role. Without it the container gets your credentials. |
| `--no-assume-role` | — | Explicitly decline the role assumption. |
| `--watch` | off | Re-synthesize and reload the distribution when the source changes. |
| `--no-pull` | off | Skip `docker pull` for a Lambda's base image. No effect without a Lambda. |

It also accepts the [common flags](local-emulation.md#common-flags), with
three differences: it does not accept `--env-vars` or `--container-host`, and
it refuses `--from-state`, `--state-bucket` and `--state-prefix`.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. The role's
> credentials reach the Function URL and Lambda@Edge containers, so your code
> runs as that role. An exported `AWS_PROFILE` does not prevent this. cdkd
> warns at startup when this applies. See the `--role-arn` section of the
> [CLI Reference](cli-reference.md).

## State sources

`--from-state` is refused on this command. Passing `--from-state`,
`--state-bucket` or `--state-prefix` exits 1 with a message pointing at
`--from-cfn-stack`. Nothing in the CloudFront path reads cdkd's S3 state.

`--from-cfn-stack [name]` is the state source here. It:

- reads a deployed S3 origin's bucket from real S3,
- backs `cf.kvs()` reads with the deployed KeyValueStore,
- resolves the environment of Function URL origin Lambdas and Lambda@Edge
  functions.

`--stack-region` sets the CloudFormation client's region.

## Target resolution

The target names one `AWS::CloudFront::Distribution`, as a CDK construct path
(`MyStack/MyDistribution`), a prefix of one, or a stack-qualified logical ID
(`MyStack:MyDistribution`). One distribution is served per run. See
[Naming the target](local-emulation.md#naming-the-target).

## What runs locally

| Part of the distribution | How it is served | Docker |
| --- | --- | --- |
| CloudFront Functions (`viewer-request`, `viewer-response`) | In-process, in a sandbox | No |
| Lambda@Edge, all four stages | One warm container per function | Yes |
| Lambda Function URL origins | The Lambda in a container | Yes |
| S3 origins | From the staged asset directory, or real S3 under `--from-cfn-stack` | No |
| Path routing | `DefaultCacheBehavior` and the ordered `CacheBehaviors[]`, with CloudFront's `*` / `?` matching | No |
| `DefaultRootObject`, `CustomErrorResponses` | Applied. The error responses give the single-page-app fallback. | No |
| Other custom origins | Not fetched: a warning at boot and `502` per request, unless `--origin` points it at a directory | — |
| CDN caching, edge locations, cache keys | Not reproduced | — |

A URI ending in `/` is not auto-indexed, as on CloudFront. Only the root path
resolves to `DefaultRootObject`.

### Origins

An S3 origin's content is found through the cloud assembly: the origin's
bucket, its `BucketDeployment`, and that deployment's staged source directory.

| Origin | Result | What to do |
| --- | --- | --- |
| S3 bucket with a `BucketDeployment` in the app | Served from the staged files | Nothing |
| S3 bucket with no `BucketDeployment` (files uploaded another way) | Warning at boot, `502` per request | `--origin <id>=<dir>`, or `--from-cfn-stack` to read the deployed bucket |
| A custom domain that is neither S3 nor a Function URL | Warning at boot, `502` per request | `--origin <id>=<dir>` to serve a directory in its place |

`<id>` in `--origin <id>=<dir>` is the distribution's `Origins[].Id`, matched
exactly. CDK generates these with a hash suffix. The boot warning for an
unresolved S3 origin prints the full flag, `--origin <that id>=<dir>`, ready
to copy.

Under `--from-cfn-stack`, a deployed S3 origin is read from S3 on every
request, so it is always current. `--cache-origin` keeps objects in memory
until a `--watch` reload or a restart. Without `--from-cfn-stack`,
`--cache-origin` does nothing and a warning says so.

A file is served only when it resolves inside its origin directory, so `../`
and symbolic links leading out are not followed. The origin directory itself
must be inside the app's output directory, with one exception described next.
[What cdkd trusts in the assembly](local-emulation.md#what-cdkd-trusts-in-the-assembly)
has the rules for every command.

### Absolute `BucketDeployment` sources

`cdk synth --no-staging` writes a `BucketDeployment` source as an absolute
path outside the output directory. Such an origin is served, with a warning
naming it, only when all of these hold:

- It is inside your project: the git work tree holding the output directory,
  or the current directory when that contains the output directory or is
  itself a git work-tree root.
- The project root is not your home directory or a directory containing it.
- No directory between the project root and the folder is a credential or
  version-control directory: `.git`, `.hg`, `.svn`, `.ssh`, `.aws`, `.gnupg`,
  `.docker`, `.kube`, `.config`, `.azure`, `.gcloud`, `.terraform`, `.npm`,
  `.pnpm-store`, `.yarn`, `.cache`, `.local` (compared case-insensitively).
  Other hidden build folders, such as `docs/.vitepress/dist`, are accepted.
- It is not `/`, your home directory or a directory containing it, the project
  root itself, or a directory containing the output directory. All of these
  are judged on real paths.

An origin accepted this way never serves a hidden entry such as `/.env` or
`/.git/...`, except a `.well-known` path segment.

The rule limits the folder without proving it is yours. Running from a folder
that holds several repositories puts a sibling repository's folders in scope,
and the credential list is not exhaustive.

### CloudFront Functions

Both `cloudfront-js-1.0` and `cloudfront-js-2.0` run, and a `2.0` async
handler is awaited.

| Function behaviour | Result |
| --- | --- |
| `viewer-request` returns an object with a `statusCode` | That response is sent (a redirect or fixed body). The origin is not contacted. |
| `viewer-request` returns a request | The rewritten request goes to the origin. |
| `viewer-response` | Runs over the origin's response. |
| Returns a non-object, or nothing | The request or response continues unchanged. |
| No `handler` function is declared | Fails to compile, naming the function. |
| Synchronous code runs longer than 5 seconds | That request fails. The server keeps running. |

### `cf.kvs()`: KeyValueStore reads

| Source | Flag |
| --- | --- |
| A local JSON map, with no AWS calls | `--kvs-file <key>=<file.json>` |
| The deployed store, read on demand | `--from-cfn-stack` |

`<key>` names the `AWS::CloudFront::KeyValueStore`: its logical ID, its
construct path (`MyStack/RoutesKvs`) or its construct ID (`RoutesKvs`). An
unknown key, or an ambiguous construct ID, fails at boot with the list of
candidates.

```json
{ "/old-path": "/new-path", "/promo": "/campaigns/2026" }
```

With neither source, `cf.kvs()` still returns a handle and the error appears
on the first read. `get` and `exists` are supported. `meta()` and `count()`
reject with an error.

## `--watch`: hot reload of the routing model

`--watch` re-synthesizes on every source change and swaps in the new routing
without closing the port. `cdk.out`, `node_modules` and `.git` are ignored,
and `watch.include` / `watch.exclude` in `cdk.json` are honoured.

| On reload | Result |
| --- | --- |
| Behaviours, origins, CloudFront Functions | Replaced. |
| `--kvs-file` files | Read again. |
| The `--cache-origin` cache | Cleared. |
| Lambda containers (Function URL origins, Lambda@Edge) | Not rebuilt. Restart to pick up changes. |
| A Lambda@Edge association added since startup | Skipped with a warning. Restart to pick it up. |
| Synthesis fails | The previous version keeps serving, with a warning. |

## Limitations

- Custom origins that are neither S3 nor a Lambda Function URL are not
  fetched.
- The `cloudfront-js-2.0` `cf.fetch` API is not available.
- A Lambda@Edge function that cannot be booted is skipped with a warning and
  its stage does not run. The rest of the distribution is served.
- CloudFront's caching, edge locations and cache keys are not modelled.
  `--cache-origin` is a read cache for S3 objects only.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`. |
| `1` | An error: no such distribution, synthesis failure, an unresolvable `--kvs-file` key, a Lambda container that failed to boot, or a refused state flag. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |

Stopping closes the server and removes every Lambda container. The full
cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd local invoke`](local-invoke.md): how the Lambda behind a Function
  URL origin or a Lambda@Edge stage is run
- [`cdkd local start-api`](local-start-api.md): for a distribution whose
  origin is an API
- [`cdkd local start-alb`](local-start-alb.md): the Application Load Balancer
  front door
- [Local Execution](local-emulation.md): choosing a command, value
  resolution, and the flags every command shares
- [CLI Reference](cli-reference.md): every command and the full exit-code
  table
