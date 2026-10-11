---
title: Assembly paths in local execution
description: "Which directories and files named by a cloud assembly cdkd local refuses to mount, build or serve, and which it accepts with a warning."
---

# Assembly paths in local execution

A cloud assembly names directories for cdkd to mount into containers, build
images from and serve files from. `-a <dir>` can point at an assembly that
someone else built, so cdkd checks each of those paths against the app's
output directory (`cdk.out` by default) before it uses the path.

Running a local command against an assembly also runs code from it. The
handler runs in a container, and a Docker asset's build command runs on your
machine. Treat an assembly you did not synthesize yourself as untrusted input.

Read this page when a command refuses a path or prints a warning about one.

## Paths that are refused

cdkd refuses a path that resolves outside the app's output directory, whether
it gets there through `..` or through a symbolic link. The check covers these
paths:

| Path in the assembly | Applies to |
| --- | --- |
| A Lambda's relative `Metadata['aws:asset:path']`, for function code and same-stack layers | `invoke`, `start-api`, `start-alb`, `start-cloudfront` |
| The module path in a Lambda's `Handler`, for inline `Code.ZipFile` | Wherever inline code is run |
| A Docker asset's `source.directory` | Every command that builds an image, on each build and each `--watch` rebuild |
| The directory a `--watch` reload copies into a running container | `start-service`, `start-alb`, `invoke-agentcore`, `start-agentcore` |
| A code asset's `source.path` | `invoke-agentcore`, `start-agentcore` |
| A relative `BucketDeployment` source served as an S3 origin | `start-cloudfront` |
| A stack name that would place `<stack>.assets.json` outside the assembly | Wherever a command reads it |

Four details about those rows:

- An absolute `source.directory` or `source.path` is placed under the
  manifest's directory, so it cannot leave that directory.
- When a `--watch` copy is refused, cdkd either rebuilds the image in full or
  skips the reload. It never copies the directory.
- `--no-build` reuses a cached image and opens no directory.
- `start-cloudfront` also checks every file it serves. A symbolic link inside
  an origin directory that points elsewhere is not served.

### A stack inside a `cdk.Stage`

A stack inside a `cdk.Stage` passes the check. CDK stages the Stage's assets
into the app's output directory, so the `../asset.<hash>` path that CDK writes
resolves inside it.

The check fails when you point `-a` at the Stage's own sub-assembly, as in
`-a cdk.out/assembly-MyStage`. The check is then bounded to that directory,
and the Stage's assets live one level above it, so they are refused. Point
`-a` at the app's `cdk.out` and select the resource by its display path:

```bash
cdkd local invoke MyStage/MyStack/Handler -a cdk.out
```

The deploy path follows the same rule; see
[Deploy safety](cli-deploy-safety.md).

## Paths that are accepted with a warning

Three kinds of path are used even though they lead outside the output
directory. cdkd prints a warning for each.

| Path in the assembly | Why it is accepted |
| --- | --- |
| An absolute `Metadata['aws:asset:path']` outside the output directory | `cdk synth --no-staging` writes the asset's absolute source directory there. |
| A Docker asset's `source.executable` | It is the build command the manifest chose. cdkd runs it on your machine to produce the image. |
| An absolute `BucketDeployment` source outside the output directory | `cdk synth --no-staging` also writes this one. |

`start-cloudfront` serves an absolute `BucketDeployment` source only when it
is a folder inside your project; see
[`cdkd local start-cloudfront`](local-start-cloudfront.md#absolute-bucketdeployment-sources).

> [!WARNING]
> If you did not synthesize with `--no-staging`, a warning that cdkd is about
> to mount a directory outside the output directory means the assembly chose
> that directory. Treat the assembly as untrusted.

### Build commands from the assembly

Before cdkd runs a `source.executable` build, it prints the command and how
many arguments the command takes. It prints the arguments themselves only
under `--verbose`, because a build script's flags may include a password. Each
distinct command is announced once per run.

### BuildKit paths

`start-service`, `start-alb`, `start-cloudfront` and `start-agentcore` also
warn, on every image they build, about a BuildKit path outside the assembly.
That covers a build secret, an SSH key, a build context, and a cache or output
directory.

## Related

- [Local Execution](local-emulation.md): choosing a command and the flags
  every command shares
- [Deploy safety](cli-deploy-safety.md): the same checks on the deploy path
