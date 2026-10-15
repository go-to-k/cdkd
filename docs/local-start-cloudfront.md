---
title: cdkd local start-cloudfront
description: "Serve a CloudFront distribution from your CDK app on localhost: its CloudFront Functions, cache-behaviour routing, S3 origins, Lambda Function URL origins and Lambda@Edge."
---

# cdkd local start-cloudfront

`cdkd local start-cloudfront [target]` serves one CloudFront distribution on a
local port. Each request goes through the same stages as on CloudFront: the
viewer-request function, the origin, then the viewer-response function. Use it
to check a rewrite function, a cache-behaviour path pattern or a
single-page-app fallback in seconds.

A distribution made of S3 origins and CloudFront Functions needs no Docker.
Docker is needed only when the distribution has a Lambda Function URL origin
or a Lambda@Edge function, because cdkd runs those Lambda functions in local
containers.

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
  defaultBehavior: {
    origin: origins.S3BucketOrigin.withOriginAccessControl(bucket),
  },
  defaultRootObject: 'index.html',
});
```

serve it on a fixed port:

```bash
cdkd local start-cloudfront MyStack/MyDistribution --port 8080
```

cdkd prints a `CloudFront distribution serving on` line with the address. From
another terminal:

```bash
curl -i http://127.0.0.1:8080/            # the default root object
curl -i http://127.0.0.1:8080/app.js      # any file under site/
```

The files come from the copy of `site/` that synthesis placed in the app's
output directory (`cdk.out`), so nothing is read from AWS and the stack does
not have to be deployed.

More invocations:

```bash
# pick a distribution from a list
cdkd local start-cloudfront

# serve an origin from a directory
cdkd local start-cloudfront MyStack/MyDistribution --origin SiteOrigin=./dist

# back cf.kvs() with a file
cdkd local start-cloudfront MyStack/MyDistribution \
  --kvs-file RoutesKvs=./routes.json

# deployed bucket and store, reload on edits
cdkd local start-cloudfront MyStack/MyDistribution --from-cfn-stack --watch
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[target]` | picker | The distribution to serve. |
| `--port <port>` | `0` (auto) | Port the server listens on. |
| `--host <host>` | `127.0.0.1` | Address the server binds to. |
| `--origin <originId=dir>` | — | Serve one origin from a local directory. Repeatable. |
| `--kvs-file <key=file.json>` | — | Answer `cf.kvs()` reads from a local JSON file. Repeatable. |
| `--tls` | off | Serve HTTPS. |
| `--tls-cert <path>` | — | PEM server certificate. Requires `--tls-key`. |
| `--tls-key <path>` | — | PEM private key. Requires `--tls-cert`. |
| `--from-state` | off | Read the stack from cdkd's S3 state. |
| `--from-cfn-stack [name]` | off | Read the deployed CloudFormation stack. |
| `--cache-origin` | off | Keep objects read from a deployed S3 origin in memory. |
| `--assume-role [arn]` | off | Run a Lambda origin under its deployed execution role. |
| `--no-assume-role` | — | Explicitly decline the role assumption. |
| `--watch` | off | Reload the distribution when the source changes. |
| `--no-pull` | off | Skip `docker pull` for a Lambda's base image. |

Each of these flags is explained in the section for the feature it belongs to:
[Origins](#origins), [`cf.kvs()`](#cf-kvs-keyvaluestore-reads),
[State sources](#state-sources) and
[`--watch`](#watch-hot-reload-of-the-routing-model). The rest need only a
line each:

- `--tls` alone uses a self-signed certificate that cdkd generates, which
  requires `openssl` on `PATH`. `--tls-cert` and `--tls-key` supply your own
  certificate, and each implies `--tls`.
- Without `--assume-role`, a Lambda container gets your own credentials.
- `--no-pull` has no effect on a distribution without a Lambda function.

The command also accepts the common flags listed in
[Local Execution](local-emulation.md), with these differences: it does not
accept `--env-vars` or `--container-host`. The flags that read cdkd's own
state work as [State sources](#state-sources) describes.

> [!WARNING]
> Do not pass `--role-arn` here without the `--profile` flag. `--role-arn` is
> the role cdkd assumes for its own AWS calls. On this command the role's
> credentials also reach the Function URL and Lambda@Edge containers, so your
> code runs as that role. An exported `AWS_PROFILE` does not prevent this.
> Under `--from-state` or `--from-cfn-stack`, a deployed S3 origin's objects
> and KeyValueStore entries are also read as that role.
> cdkd warns at startup when this applies. See the `--role-arn` section of
> the [CLI Reference](cli-reference.md).

## Target resolution

The target names one `AWS::CloudFront::Distribution`. You can write it as a
CDK construct path (`MyStack/MyDistribution`), as a prefix of one, or as a
stack-qualified logical ID (`MyStack:MyDistribution`).
Each run serves one distribution. [Local Execution](local-emulation.md)
describes the target forms in full.

## What runs locally

cdkd reproduces the parts of a distribution that decide which response a
viewer gets: routing, functions and origins. It does not reproduce the
content-delivery network itself, so nothing is cached at an edge.

| Part of the distribution | How it is served | Docker |
| --- | --- | --- |
| CloudFront Functions | Inside the cdkd process, in a sandbox | No |
| Lambda@Edge, all four stages | One warm container per function | Yes |
| Lambda Function URL origins | The Lambda function in a container | Yes |
| S3 origins | From local files, or from the deployed bucket | No |
| Path routing | By the cache behaviours' path patterns | No |
| `DefaultRootObject`, `CustomErrorResponses` | Applied | No |
| Other custom origins | Not fetched | — |
| CDN caching, edge locations, cache keys | Not reproduced | — |

Routing follows the distribution: a request is matched against the ordered
`CacheBehaviors[]` and falls back to `DefaultCacheBehavior`, with the `*` and
`?` wildcards CloudFront uses in path patterns.

`CustomErrorResponses` are what give a single-page app its fallback, where an
unknown path returns `index.html`. That works locally as it does deployed.

As on CloudFront, a URI that ends in `/` is not given an index document. Only
the root path resolves to `DefaultRootObject`.

## Origins

cdkd serves an S3 origin from the files your app deploys to the bucket. It
finds them by following the template from the origin to its bucket, from the
bucket to the `BucketDeployment` that fills it, and from there to the copy of
the source directory in `cdk.out`. In the example above that chain ends at
`site/`, and no flag is needed.

When the chain cannot be followed, cdkd prints a warning at startup and
answers requests for that origin with `502`. There are two such cases, and the
same flag handles both:

- **An S3 bucket with no `BucketDeployment` in the app**, because the files
  are uploaded some other way.
- **A custom origin that is neither S3 nor a Lambda Function URL**, such as
  an API on another domain. cdkd does not fetch from it.

`--origin <id>=<dir>` serves that origin from a local directory:

```bash
cdkd local start-cloudfront MyStack/MyDistribution --origin SiteOrigin=./dist
```

`<id>` is the origin's `Origins[].Id` in the distribution, matched exactly.
CDK generates these IDs with a hash suffix, so copy the ID from the startup
warning: for an unresolved S3 origin, the warning prints the whole flag with
the ID filled in.

For an S3 bucket you can also pass `--from-state` or `--from-cfn-stack`, which
reads the files from the deployed bucket. See [State sources](#state-sources).

### Files outside the origin directory

A file is served only when it resolves inside its origin directory. A `../` in
the request path and a symbolic link that leads out of the directory are not
followed.

The origin directory itself must be inside the app's output directory, with
the one exception described next. [Local Execution](local-emulation.md) has
the rules on what cdkd trusts in the synthesized output for every command.

### Absolute `BucketDeployment` sources

This section applies only if you synthesize with `cdk synth --no-staging`.
That option makes a `BucketDeployment` source an absolute path to your
original folder, outside the output directory, where a normal synthesis copies
the folder in.

cdkd serves such an origin, with a warning that names it, only when the folder
passes all four of these checks:

1. The folder is inside your project. The project is the git work tree that
   holds the output directory. It can also be the current directory, when the
   current directory contains the output directory or is itself the root of a
   git work tree.
2. The project root is not your home directory or a directory that contains
   it.
3. No directory between the project root and the folder is a credential or
   version-control directory. The list is given below.
4. The folder is not one of these: `/`, your home directory or a directory
   that contains it, the project root itself, or a directory that contains
   the output directory. These are compared as real paths, after symbolic
   links are resolved.

The directories in check 3 are `.git`, `.hg`, `.svn`, `.ssh`, `.aws`,
`.gnupg`, `.docker`, `.kube`, `.config`, `.azure`, `.gcloud`, `.terraform`,
`.npm`, `.pnpm-store`, `.yarn`, `.cache` and `.local`, compared without regard
to letter case. Other hidden build folders, such as `docs/.vitepress/dist`,
are accepted.

An origin accepted this way never serves a hidden entry such as `/.env` or
`/.git/...`. The one exception is a `.well-known` path segment.

> [!WARNING]
> These checks limit which folder can be served. They do not prove the folder
> is yours. If you run cdkd from a folder that holds several repositories, a
> sibling repository's folders are in scope, and the list of credential
> directories is not exhaustive.

## CloudFront Functions

cdkd runs the distribution's CloudFront Functions inside its own process, so
they need no Docker and no deployment. Both the `cloudfront-js-1.0` and
`cloudfront-js-2.0` runtimes are supported, and an `async` handler under `2.0`
is awaited.

A `viewer-request` function runs before the origin, and what it returns
decides what happens next:

- **A request object.** The request, as the function rewrote it, goes to the
  origin.
- **An object with a `statusCode`.** cdkd sends that response, for example a
  redirect or a fixed body, and does not contact the origin.

A `viewer-response` function runs on the origin's response before it is sent
to the client.

### Function errors and limits

- **A function returns nothing, or something that is not an object.** The
  request or response continues unchanged.
- **The code declares no `handler` function.** It fails to compile, and the
  error names the function.
- **Synchronous code runs longer than 5 seconds.** That request fails. The
  server keeps running.
- **The code calls `cf.fetch`.** This `cloudfront-js-2.0` API is not
  available locally.

## `cf.kvs()`: KeyValueStore reads

A CloudFront Function reads its KeyValueStore through `cf.kvs()`. Locally you
choose where those reads are answered from:

| Source | Flag |
| --- | --- |
| A local JSON file, with no AWS calls | `--kvs-file <key>=<file.json>` |
| The deployed store, read on demand | `--from-state` or `--from-cfn-stack` |

The file is one JSON object that maps each key to its value:

```json
{ "/old-path": "/new-path", "/promo": "/campaigns/2026" }
```

```bash
cdkd local start-cloudfront MyStack/MyDistribution \
  --kvs-file RoutesKvs=./routes.json
```

`<key>` in the flag names the `AWS::CloudFront::KeyValueStore` resource. It
can be the resource's logical ID, its construct path (`MyStack/RoutesKvs`) or
its construct ID (`RoutesKvs`).

### Edge cases

- **The key matches no store, or a construct ID matches several.** cdkd fails
  at startup and lists the candidates.
- **Neither flag is given.** `cf.kvs()` still returns a handle, and the error
  appears on the first read.
- **Methods other than `get` and `exists`.** `meta()` and `count()` reject
  with an error.

## State sources

`--from-state` (a stack deployed with `cdkd deploy`) and `--from-cfn-stack
[name]` (a deployed CloudFormation stack) make cdkd read the deployed stack,
for the parts of a distribution that exist only after a deploy. The two are
mutually exclusive. With either, cdkd:

- reads an S3 origin's files from the deployed bucket,
- answers `cf.kvs()` reads from the deployed KeyValueStore,
- resolves the environment variables of Function URL origin Lambda functions
  and Lambda@Edge functions.

```bash
cdkd local start-cloudfront MyStack/MyDistribution --from-state
cdkd local start-cloudfront MyStack/MyDistribution --from-cfn-stack
```

`--state-bucket` and `--state-prefix` choose where `--from-state` reads cdkd's
state. `--stack-region` sets the region of the state record, and of the
CloudFormation client under `--from-cfn-stack`.

### Caching objects from the deployed bucket

Under a state source, cdkd reads an S3 origin's object from S3 on every
request, so you always see the bucket's current content. `--cache-origin`
keeps each object in memory after the first read, which is faster. The cache
lasts until a `--watch` reload or a restart.

Without a state source there is nothing to cache, so `--cache-origin` does
nothing and a warning says so.

## `--watch`: hot reload of the routing model

`--watch` synthesizes the app again on every source change and swaps in the
new routing without closing the port, so a browser tab or a test run keeps its
address.

```bash
cdkd local start-cloudfront MyStack/MyDistribution --port 8080 --watch
```

A reload replaces the cache behaviours, the origins and the CloudFront
Functions. It also reads the `--kvs-file` files again and clears the
`--cache-origin` cache.

Changes under `cdk.out`, `node_modules` and `.git` are ignored. The
`watch.include` and `watch.exclude` settings in `cdk.json` are honoured.

### What a reload does not change

- **Lambda containers.** The containers behind Function URL origins and
  Lambda@Edge functions are not rebuilt. Restart the command to pick up a
  change to their code.
- **A Lambda@Edge association added since startup.** It is skipped with a
  warning. Restart to pick it up.
- **Anything, when synthesis fails.** cdkd prints a warning and the previous
  version keeps serving.

## Limitations

- Custom origins that are neither S3 nor a Lambda Function URL are not
  fetched. Point `--origin` at a directory to stand in for one.
- The `cloudfront-js-2.0` `cf.fetch` API is not available.
- A Lambda@Edge function that cannot be started is skipped with a warning, and
  its stage does not run. The rest of the distribution is served.
- CloudFront's caching, edge locations and cache keys are not modelled.
  `--cache-origin` is a read cache for S3 objects only.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Stopped by `SIGTERM`. |
| `1` | An error. |
| `130` | Stopped by {kbd:ctrl+c}, or the picker was cancelled. |

An error here is a distribution that does not exist, a synthesis failure, a
`--kvs-file` key that cannot be resolved, a Lambda container that failed to
start, or a refused state flag.

Stopping the command closes the server and removes every Lambda container. The
[CLI Reference](cli-reference.md) has the exit-code table for every command.

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
