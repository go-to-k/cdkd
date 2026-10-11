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
cdkd publish-assets                          # the only stack in the app
cdkd publish-assets MyStack ApiStack         # specific stacks
cdkd publish-assets --all                    # every stack, Stage stacks included
cdkd publish-assets 'MyStage/*'              # the stacks inside one stage
cdkd publish-assets -a cdk.out               # skip synthesis; read an existing assembly
```

It provisions nothing, writes no state and takes no stack lock.

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

Stack names are matched as on `deploy`, `diff` and `destroy`. See
[Selecting stacks](cli-list.md#selecting-stacks).

| You pass | What is published |
| --- | --- |
| Nothing, and the app has one stack | That stack's assets. |
| Nothing, and the app has several stacks | Nothing. The command lists the stacks and exits `1`. |
| Stack names or patterns | The matching stacks' assets. |
| `--all` | Every stack's assets, Stage stacks included. |

`--all` here matches `cdk publish-assets --all`. On `deploy`, `destroy` and
`diff`, `--all` takes the top-level stacks only.

A CDK Stage that failed to load stops the run, whatever was selected. See
[A pre-synthesized assembly is trusted input](cli-deploy-safety.md#a-pre-synthesized-assembly-is-trusted-input).

## Publishing from an existing assembly

`-a` / `--app` takes a shell command or a directory, as on `cdkd deploy`:

| Value | What cdkd does |
| --- | --- |
| A command, such as `"node app.ts"` | Runs it to synthesize the app. |
| A synthesized assembly directory, such as `cdk.out` | Skips synthesis and reads the manifest. |

```bash
cdkd synth --output build/assembly
cdkd publish-assets --all -a build/assembly
```

There is no separate flag for a manifest path.

## Asset destinations

Where assets go depends on whether the region is opted in to cdkd asset
storage. The command reads the region's bootstrap marker from the state bucket
to find out.

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
| `2` | Partial failure. One or more stacks failed and the rest published. The run summary lists each stack's outcome; run again to retry. |

The table for every command is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd bootstrap`](cli-bootstrap.md): the asset storage this command publishes into
- [Deploy: waits & concurrency](cli-deploy.md): the concurrency flags it shares with deploy
- [`cdkd gc`](cli-gc.md): collecting assets nothing references any more
- [CLI Reference](cli-reference.md): every command and the exit-code table
