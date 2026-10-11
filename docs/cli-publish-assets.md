---
title: cdkd publish-assets
description: "Synthesize, build, and publish file and Docker assets without deploying, with cdkd publish-assets."
---

# cdkd publish-assets

`cdkd publish-assets` runs the asset half of a deploy and then stops. It
synthesizes the CDK app, builds any Docker images, uploads file assets to S3
and pushes images to ECR. Use it when one CI job builds and uploads the assets
and a separate job deploys.

```bash
# the only stack in the app
cdkd publish-assets

# specific stacks
cdkd publish-assets MyStack ApiStack

# every stack, Stage stacks included
cdkd publish-assets --all

# the stacks inside one stage
cdkd publish-assets 'MyStage/*'

# skip synthesis; read an existing assembly
cdkd publish-assets -a cdk.out
```

The command provisions nothing, writes no state and takes no stack lock.

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | the only stack | Stacks to publish assets for: CDK display paths with wildcards, or exact physical names. |
| `--stack <name>` | | One stack name, as an alternative to the positional argument. |
| `--all` | `false` | Publish assets for every stack in the app, Stage stacks included. |
| `--use-cdk-bootstrap-assets` | `false` | Publish to the CDK bootstrap destinations in the asset manifest, even in a region opted in to cdkd asset storage. |
| `--asset-publish-concurrency <number>` | `8` | Maximum concurrent asset publishes (S3 uploads and ECR pushes). |
| `--image-build-concurrency <number>` | `4` | Maximum concurrent Docker image builds. |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to a synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | | Context values. Repeatable. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json` | Bucket to read the region's bootstrap marker from. Never written. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix for state files. |
| `--profile <profile>` | | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `-y`, `--yes` | `false` | Answer prompts automatically. |
| `--verbose` | `false` | Debug-level logging. |

The two concurrency flags have the same defaults as on
[`cdkd deploy`](cli-deploy.md#options).

## Stack selection

Name the stacks whose assets you want published. cdkd matches the names as it
does on `deploy`, `diff` and `destroy`; see
[Selecting stacks](cli-list.md#selecting-stacks).

| You pass | What is published |
| --- | --- |
| Nothing, and the app has one stack | That stack's assets. |
| Nothing, and the app has several stacks | Nothing. The command lists the stacks and exits `1`. |
| Stack names or patterns | The matching stacks' assets. |
| `--all` | Every stack's assets, Stage stacks included. |

`--all` behaves here as it does on `cdk publish-assets --all`. That differs
from `deploy`, `destroy` and `diff`, where `--all` takes the top-level stacks
only.

A CDK Stage that failed to load stops the run, whatever you selected. See
[A pre-synthesized assembly is trusted input](cli-deploy-safety-assembly-checks.md#a-pre-synthesized-assembly-is-trusted-input).

## Publishing from an existing assembly

To publish without running the CDK app, point `-a` / `--app` at a directory
that `cdkd synth` already wrote:

```bash
cdkd synth --output build/assembly
cdkd publish-assets --all -a build/assembly
```

`-a` takes a shell command or a directory, as on `cdkd deploy`:

| Value | What cdkd does |
| --- | --- |
| A command, such as `"node app.ts"` | Runs it to synthesize the app. |
| A synthesized assembly directory, such as `cdk.out` | Skips synthesis and reads the manifest. |

There is no separate flag for a manifest path.

## Asset destinations

Assets go either to storage that cdkd owns or to the destinations the CDK app
named in its asset manifest. Which one depends on whether the region is opted
in to cdkd asset storage. A region is opted in when `cdkd bootstrap`, or a
first deploy, wrote a bootstrap marker for it in the state bucket, and
`publish-assets` reads that marker to find out.

| Situation | Destination |
| --- | --- |
| The region is opted in | The cdkd-owned storage, where a later `cdkd deploy` expects them. |
| The region is not opted in | The destinations in the asset manifest. |
| No state bucket resolves | The destinations in the asset manifest, with an info line. |
| `--use-cdk-bootstrap-assets` | The destinations in the asset manifest. |

The full rules are under
[Asset destinations after opt-in](cli-bootstrap.md#asset-destinations-after-opt-in-cdkd-assets-mode).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected stack's assets were published. |
| `1` | The command failed: auth, a synthesis crash, bad arguments. |
| `2` | Partial failure. One or more stacks failed and the rest published. |

After exit `2`, the run summary lists each stack's outcome. Run the command
again to retry.

[Exit codes](cli-reference-exit-codes.md) has the table for every command.

## Related

- [`cdkd bootstrap`](cli-bootstrap.md): the asset storage this command publishes into
- [cdkd deploy](cli-deploy.md): the concurrency flags it shares with deploy
- [`cdkd gc`](cli-gc.md): collecting assets nothing references any more
- [CLI Reference](cli-reference.md): every command and the shared options
