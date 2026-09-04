---
title: cdkd publish-assets
description: "Synthesize, build, and publish file and Docker assets without deploying — cdkd publish-assets."
---

# cdkd publish-assets

`cdkd publish-assets` runs the asset half of the deploy pipeline — synthesize the
CDK app, build any Docker images, upload file assets to S3, push images to ECR —
and then **stops**. No state writes, no provisioning, no lock acquisition. This
is the "CI builds and uploads the assets, a separate runner deploys" split that
pipelines often want.

```bash
cdkd publish-assets                          # every stack in the app (or the single one)
cdkd publish-assets MyStack MyOtherStack     # specific stacks
cdkd publish-assets --all                    # every stack in the app, explicitly
cdkd publish-assets 'My*'                    # wildcard
cdkd publish-assets -a cdk.out               # skip synth — read a pre-synthesized assembly
```

## Options

| Flag | Default | Description |
| --- | --- | --- |
| `[stacks...]` | — | Stack name(s) to publish assets for. Physical names, CDK display paths, or wildcards. |
| `--stack <name>` | — | A single stack name, as an alternative to the positional argument. |
| `--all` | off | Publish assets for every stack in the CDK app. |
| `--use-cdk-bootstrap-assets` | off | Publish to the CDK bootstrap destinations named by the asset manifest, even in a region opted in to cdkd asset storage. |
| `--asset-publish-concurrency <n>` | `8` | Maximum concurrent asset publishes (S3 upload + ECR push). |
| `--image-build-concurrency <n>` | `4` | Maximum concurrent Docker image builds. |
| `-a`, `--app <command>` | `cdk.json` / `CDKD_APP` | CDK app command, or a pre-synthesized cloud assembly directory. |
| `--output <path>` | `cdk.out` | Synthesis output directory. |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET` / `cdk.json` | S3 bucket to read the per-region bootstrap marker from. Never written. |
| `--state-prefix <prefix>` | `cdkd` | S3 key prefix for state files. |
| `-c`, `--context <key=value...>` | — | Context values, repeatable. |
| `--profile <profile>` | — | AWS profile. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for AWS API calls. |
| `--verbose` | off | Verbose logging. |

The concurrency defaults are the same as `cdkd deploy`'s; see
[Deploy: waits & concurrency](cli-deploy.md#options).

## Stack selection

- The CDK app is synthesized via the standard `--app` / `CDKD_APP` / `cdk.json`
  chain.
- Stack-name matching is the same as `deploy`, `diff` and `destroy`: a positional
  argument containing `/` is matched against the CDK display path, one without it
  against the physical CloudFormation name. `*` wildcards work in both forms.
- With no argument, `publish-assets` covers every stack in the app, or the single
  stack when the app defines only one.
- Each selected stack's asset manifest is fed into the same work graph `deploy`
  uses, with stack concurrency set to zero so no stack-deploy work runs.

## `-a` / `--app`: a command or a directory

`-a` / `--app` accepts either form, with the same dual semantics as
`cdkd deploy`:

- a **shell command** (`"node app.ts"`), which cdkd runs to synthesize; or
- a path to an **already-synthesized cloud assembly directory** (`cdk.out`), in
  which case synthesis is skipped and the manifest is read directly.

Re-using a pre-synthesized assembly is therefore covered by `-a <dir>`.
`publish-assets` has no `--path <manifest>` flag of its own.

## Asset destinations

Asset destinations follow the region's asset mode:

- The command reads the per-region bootstrap marker from the state bucket,
  resolved via the standard `--state-bucket` / `CDKD_STATE_BUCKET` / `cdk.json` /
  default chain. It never writes state.
- When the region is **opted in**, assets go to the cdkd-owned storage, so a
  subsequent `cdkd deploy` finds them where its rewritten templates point.
- When **no state bucket resolves at all**, the command falls back to the
  manifest destinations verbatim, with an info line.
- `--use-cdk-bootstrap-assets` pins the legacy destinations explicitly.

The full rules are under
[Asset destinations after opt-in](cli-bootstrap.md#asset-destinations-after-opt-in-cdkd-assets-mode).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | Every selected stack's assets published cleanly. |
| `1` | Command-level failure: auth, a synth crash, bad arguments. |
| `2` | Partial failure — one or more stacks failed and the rest published. Re-run to retry the failed ones; per-stack outcomes are listed in the run summary. |

The full cross-command table is in the [CLI Reference](cli-reference.md#exit-codes).

## Related

- [`cdkd bootstrap`](cli-bootstrap.md) — the asset storage this command publishes into
- [Deploy: waits & concurrency](cli-deploy.md) — the concurrency knobs it shares with deploy
- [`cdkd gc`](cli-gc.md) — collecting assets nothing references any more
- [CLI Reference](cli-reference.md) — every command and the full exit-code table
