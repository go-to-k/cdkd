---
title: CLI Reference
description: "Every cdkd command grouped by task, the options all commands share, and how --role-arn and --profile choose the identity cdkd runs as."
---

# CLI Reference

This page is the index of the CLI section. The first table sends you to the
page for a command. The rest of the page covers the options every command
accepts and `--role-arn`, which chooses the AWS identity cdkd runs as.

```bash
cdkd bootstrap          # once per account: state bucket and asset storage
cdkd diff MyStack       # what a deploy would change
cdkd deploy MyStack     # create or update the stack
cdkd destroy MyStack    # delete its resources

# stop before a change that would lose a resource
cdkd diff --all --fail-on=destructive
cdkd deploy MyStack --require-approval=destructive
```

For a guided first run, see [Getting Started](getting-started.md). The last
two commands are explained in
[Stop on Destructive Changes](destructive-changes.md).

## CLI reference pages

| You want to | Command | Page |
| --- | --- | --- |
| **Set up** | [`cdkd bootstrap`](cli-bootstrap.md) | Create the state bucket and a region's asset storage. |
| **Preview** | [`cdkd list`](cli-list.md) | List the stacks in the app. Also explains how stack arguments are matched. |
| | [`cdkd synth`](cli-synth.md) | Synthesize the app and print a stack's template. |
| | [`cdkd diff`](cli-diff.md) | Show what a deploy would change. |
| **Deploy** | `cdkd deploy` | [cdkd deploy](cli-deploy.md): every flag, and how long a deploy waits. |
| | | [cdkd deploy: tuning](cli-deploy-tuning.md): timeouts, resource names and CDK annotations. |
| | | [cdkd deploy: safety & compatibility flags](cli-deploy-safety.md): replacements and the guards around them. |
| | [`cdkd publish-assets`](cli-publish-assets.md) | Build and upload assets without deploying. |
| | `cdkd import` | [Import Existing Resources](import.md): adopt resources that already exist. |
| **Tear down** | `cdkd destroy` | [cdkd destroy](cli-destroy.md): data guards, snapshots and prompts. |
| | `cdkd orphan` | [Orphan Instead of Destroy](orphan-vs-destroy.md): stop managing a resource without deleting it. |
| **Recover** | [`cdkd rollback`](cli-rollback.md) | Revert a deploy that failed or was interrupted. |
| | [`cdkd force-unlock`](cli-force-unlock.md) | Delete a lock that a crashed or cancelled run left behind. |
| **Inspect** | [`cdkd events`](cli-events.md) | Read what past deploys and destroys did. |
| | [`cdkd state`](cli-state.md) | Read and operate on the state bucket, with no CDK app. |
| | [`cdkd drift`](cli-drift.md) | Compare recorded state against live AWS resources. |
| **Maintain** | [`cdkd gc`](cli-gc.md) | Delete assets no stack references any more. |
| | [`cdkd scrub`](cli-scrub.md) | Remove resolved secret values from stored state. |
| | [`cdkd export`](cli-export.md) | Hand a stack over to CloudFormation. |
| **Run locally** | `cdkd local` | [Local Execution](local-emulation.md): run Lambda, API, ECS and other workloads on your machine. |

`cdkd <command> --help` prints the flags of any command.

## In this section

These pages cover behaviour that is the same for every command:

- [Credentials and --role-arn](cli-reference-credentials.md): the permissions
  an assumed role needs, what changes when the role is in another account, and
  how the role interacts with `cdkd local`.
- [Region resolution](cli-reference-region.md): which region a command works
  in, and where `--region` is still a supported flag.
- [Output streams](cli-reference-output.md): which commands write only a
  machine-readable document to stdout, so that you can pipe it.
- [Exit codes](cli-reference-exit-codes.md): what `0`, `1`, `2`, `3`, `70` and
  `130` mean, and how a script should react to each.

## Options every command takes

| Flag | Default | Description |
| --- | --- | --- |
| `--profile <profile>` | default credential chain | AWS profile for your credentials and config settings. |
| `--role-arn <arn>` | `CDKD_ROLE_ARN` | IAM role to assume for cdkd's AWS calls. See [`--role-arn`](#role-arn). |
| `-y`, `--yes` | `false` | Answer confirmation prompts with the recommended response. |
| `--verbose` | `false` | Debug-level logging. |
| `-V`, `--version` | | Print the cdkd version (top level only). |
| `-h`, `--help` | | Print help for the command. |

Commands that read a CDK app also take the flags below. Those commands are
`deploy`, `diff`, `synth`, `list`, `publish-assets` and the others that
synthesize.

| Flag | Default | Description |
| --- | --- | --- |
| `-a`, `--app <command>` | `CDKD_APP`, then `cdk.json` | The CDK app command, or a path to a synthesized assembly directory. |
| `--output <path>` | `cdk.out` | Directory to synthesize into. |
| `-c`, `--context <key=value...>` | | Context values. Repeatable. |

Commands that read or write state also take:

| Flag | Default | Description |
| --- | --- | --- |
| `--state-bucket <bucket>` | `CDKD_STATE_BUCKET`, then `cdk.json`, then `cdkd-state-{accountId}` | The S3 bucket holding state. |
| `--state-prefix <prefix>` | `cdkd` | Key prefix for state files in that bucket. |

Every command that takes stack arguments matches them the same way.
[Selecting stacks](cli-list.md#selecting-stacks) has the rules.

## `--role-arn`

`--role-arn` makes cdkd assume an IAM role when the command starts, and then
make its AWS calls as that role. Use it when the identity that deploys is a
role your own credentials are allowed to assume, such as a deploy role in
another account.

```bash
cdkd deploy --role-arn arn:aws:iam::123456789012:role/cdkd-deploy
CDKD_ROLE_ARN=arn:aws:iam::123456789012:role/cdkd-deploy cdkd deploy
```

`CDKD_ROLE_ARN` is the environment variable for the same setting. The flag
wins when both are set, and an empty `CDKD_ROLE_ARN` counts as unset.

The value must be a role ARN of the form
`arn:<partition>:iam::<account>:role/<name>`, at most 2048 characters long.
cdkd refuses anything else, including `--role-arn ""`, before it sends any
request.

cdkd assumes the role once, at command start. The session is named
`cdkd-<unix-ms>` and lasts 1 hour.

### Which calls run as the role

```text diagram=cli-role-arn-identities
        Your base credentials
  (--profile, AWS_PROFILE, default chain)
                   |
                   v
            STS AssumeRole            once, at command start; 1-hour session
                   |
        +----------+-----------------------+
        | passed to each client            | exported as AWS_* variables
        v                                  v
  AWS calls cdkd makes              Programs cdkd starts
  Always the role                   (your CDK app during synthesis)
                                    No profile selected: the role
                                    Profile selected:    the profile
```

cdkd uses the role's temporary credentials in two ways:

- It passes them to every AWS client it builds, so the calls cdkd makes itself
  always run as the role.
- It exports them as `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and
  `AWS_SESSION_TOKEN` for the programs it starts. Those programs are your CDK
  app during synthesis, and the emulation engine that `cdkd local` runs.

The second way has a limit. The AWS SDK ignores those exported variables once
a profile is selected. So with `--profile` or an exported `AWS_PROFILE`, a
program that cdkd starts runs as the profile, while cdkd's own calls still run
as the role. [`--profile` vs `--role-arn`](#profile-vs-role-arn) explains what
that means for your CDK app.

### When the `--role-arn` session expires

The session lasts 1 hour and cdkd does not refresh it. Credentials already in
use stay valid until they expire. If a deploy outlasts the session, run the
command again.

### `--profile` vs `--role-arn`

The two flags do different jobs, and you can pass both. `--profile` chooses
the credentials that make the `AssumeRole` call. `--role-arn` chooses the
identity that does the work afterwards.

```bash
# The ci profile authenticates the AssumeRole call; the role in 222222222222
# does the work.
cdkd deploy --profile ci --role-arn arn:aws:iam::222222222222:role/cdkd-deploy
```

| Setting | What it decides |
| --- | --- |
| `--profile` or `AWS_PROFILE` | The credentials that call `AssumeRole`, and your AWS config settings, the region above all. |
| `--role-arn` or `CDKD_ROLE_ARN` | The identity of every AWS call cdkd makes after that. |

For the combination to work, the profile's principal needs `sts:AssumeRole` on
the role, and the role's trust policy has to allow that principal.

Once the role is assumed, the profile no longer chooses the identity of any
call cdkd makes. That is also true of an `AWS_PROFILE` you exported without
passing the flag. cdkd still leaves the profile selected in the environment,
because the region and the rest of your AWS config come from it. When a
profile is selected and a role is assumed, cdkd prints a warning at the start
of the run.

#### Your CDK app can see two accounts

Suppose the `ci` profile belongs to account `111111111111` and the role
belongs to account `222222222222`. During synthesis, your CDK app learns the
account from two sources, and they now disagree:

| What the app reads | Resolved by | Account |
| --- | --- | --- |
| `CDK_DEFAULT_ACCOUNT`, which an env-agnostic stack uses | cdkd, through `sts:GetCallerIdentity` | The role's |
| `Vpc.fromLookup`, `HostedZone.fromLookup`, `StringParameter.valueFromLookup` | The app's own SDK chain | The profile's |

A stack with `env` unset, or with `account: process.env.CDK_DEFAULT_ACCOUNT`,
is therefore synthesized for the role's account. That is correct, because the
role's account is where cdkd deploys it. A lookup in the same app is the
problem: it fails, or it answers from the profile's account.

There are two ways out. Either drop `--profile`, pass the region yourself and
let `--role-arn` supply the identity, or set `env` on the stack explicitly:

```ts
new ApiStack(app, 'ApiStack', {
  env: { account: '222222222222', region: 'us-east-1' },
});
```

The role's account also decides which state bucket cdkd uses and who assumes
a cross-account producer role. See
[When the profile and the role are in different accounts](cli-reference-credentials.md#when-the-profile-and-the-role-are-in-different-accounts).

#### `cdkd local` and the role

`--role-arn` is meant for cdkd's own work, and the function or task that a
`cdkd local` command runs should keep your own identity. How well that holds
depends on the command, so read
[`--role-arn` with `cdkd local`](cli-reference-credentials.md#role-arn-with-cdkd-local)
before you combine them.

## Startup compile cache

cdkd turns on Node.js's on-disk compile cache, so every run after the first
starts faster. An upgraded cdkd never runs stale cached code: each version
caches into its own subdirectory, and the first run of a new version deletes
the others.

| To | Do |
| --- | --- |
| Find the cache | Look in `$XDG_CACHE_HOME/cdkd/compile-cache`, or `~/.cache/cdkd/compile-cache`. |
| Turn it off | Set `NODE_DISABLE_COMPILE_CACHE=1`. |
| Keep it somewhere else | Set `NODE_COMPILE_CACHE=<directory>`. Pick a directory only you can write to. |

cdkd never places the cache in the shared OS temp directory, because cached
code in a directory other users can write to is not safe to load. A relative
`XDG_CACHE_HOME` is ignored. With no home directory, the cache stays off.

## Related

- [Getting Started](getting-started.md): a first deploy, start to finish
- [Core Concepts](concepts.md): what cdkd stores and how it decides what to change
- [Troubleshooting](troubleshooting.md): common failures, by symptom
- [Supported Resources](supported-resources.md): provider coverage by resource type
