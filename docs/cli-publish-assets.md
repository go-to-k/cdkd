---
title: publish-assets
description: "Synthesize, build, and publish file and Docker assets without deploying — cdkd publish-assets."
---

## `publish-assets` (synth + build + publish, no deploy)

`cdkd publish-assets` runs the asset half of the deploy pipeline —
synthesize the CDK app, build any Docker images, upload file assets to
S3, push images to ECR — and then **stops**. No state writes, no
provisioning, no lock acquisition. This is the "CI builds and uploads
assets, a separate runner deploys" split that pipelines often want.

```bash
cdkd publish-assets                          # synth + publish all stacks (or auto-detect single stack)
cdkd publish-assets <stack> [<stack>...]     # synth + publish specific stack(s)
cdkd publish-assets --all                    # synth + publish every stack in the app
cdkd publish-assets 'My*'                    # wildcard
cdkd publish-assets -a cdk.out               # skip synth — read a pre-synthesized cloud assembly
```

Synthesizes the CDK app via the standard `--app` / `CDKD_APP` /
`cdk.json` chain, applies the same stack-name matching as
`deploy` / `diff` / `destroy` (positional arg routes by `/` to display
path or physical name; supports `*` wildcards), and feeds each selected
stack's asset manifest into the same `WorkGraph` pipeline that `deploy`
uses (with `stack: 0` concurrency so no stack-deploy nodes run).

`-a/--app` accepts either a shell command (`"node app.ts"`) or
a path to an already-synthesized cloud assembly directory (`cdk.out`);
when a directory is given, synthesis is skipped and the manifest is
read directly. Same dual semantics as `cdkd deploy`. Re-using a
pre-synthesized assembly is therefore covered by `-a <dir>` and
`publish-assets` does NOT have its own `--path <manifest>` flag.

Asset destinations follow the region's asset mode: the command reads the
per-region bootstrap marker from the state bucket (resolved via the standard
`--state-bucket` / `CDKD_STATE_BUCKET` / `cdk.json` / default chain — the
command never writes state) and, when the region is opted in, publishes to
the cdkd-owned storage so a subsequent `cdkd deploy` finds the assets where
its rewritten templates point. When no state bucket is resolvable at all,
the command falls back to the manifest destinations verbatim with an info
line. `--use-cdk-bootstrap-assets` pins the legacy destinations explicitly.

Concurrency knobs (same defaults as `deploy`):

| Option | Default | Description |
| --- | --- | --- |
| `--asset-publish-concurrency` | 8 | Maximum concurrent S3 uploads + ECR pushes |
| `--image-build-concurrency` | 4 | Maximum concurrent Docker image builds |

Exit codes:

- `0` — every selected stack's assets published cleanly.
- `1` — command-level failure (auth, synth crash, bad arguments).
- `2` — **partial failure**: one or more stacks failed but the rest
  published. Re-run to retry the failed stacks. Per-stack outcomes are
  listed in the run summary.

