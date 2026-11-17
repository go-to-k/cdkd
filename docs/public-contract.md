---
title: Compatibility Promise
description: "What cdkd keeps compatible from v1.0.0 on: commands, flags, exit codes, JSON output, the state bucket, configuration, bootstrap resources and supported runtimes, and which changes need a major version."
---

# Compatibility Promise

cdkd follows semantic versioning from v1.0.0 on. This page lists what a
minor or patch release keeps compatible, which changes wait for the next
major version, and what is not covered at all.

> [!IMPORTANT]
> This promise applies from v1.0.0. It makes no promise about 0.x releases,
> where a minor release can still change any of the items below.

```bash
cdkd --version                          # the version you are on
cdkd diff --all --json | jq '.[].stack'  # a covered JSON shape
cdkd deploy MyStack; echo "exit $?"      # a covered exit code
```

## What a release may change

| Release | May contain |
| --- | --- |
| Patch | Bug fixes that keep every covered item as documented. |
| Minor | New commands, flags, JSON fields, configuration keys and environment variables; a state schema bump, migrated automatically; a feature that needs a newer bootstrap (`cdkd bootstrap`), or a security fix that needs a bootstrap re-run (`cdkd bootstrap --force` when it changes existing resources); dropping an end-of-life Node.js major; deprecations. |
| Major | Anything that removes or changes a covered item, including a changed default. |

A bug fix can still change behaviour that contradicts these docs. The docs
describe the intended behaviour, and the fix brings cdkd back to it.

## What is covered

### Commands and flags

Every command and flag listed in the [CLI Reference](cli-reference.md),
except those in [Experimental features](#experimental-features), is covered:
its name, its arguments, and its default value. A minor release does
not remove or rename one, and does not change what an existing flag does or
defaults to.

A minor release may add a command, a flag or a new value for an existing
flag. `cdkd <command> --help` lists the flags of the version you run.

### Exit codes

The meaning of each code in [Exit codes](cli-reference-exit-codes.md) is
covered. A situation that exits with one code keeps exiting with that code;
moving it to another code needs a major release.

### JSON output

The documented fields of each machine-readable output are covered: their
names, their types and their meaning.

| Output | Shape |
| --- | --- |
| `cdkd diff --json` | [cdkd diff: JSON output](cli-diff-json.md) |
| `cdkd drift --json` | [cdkd drift: JSON output](cli-drift-json.md) |
| `cdkd list --long --json`, `--show-dependencies --json` | [The structured document](cli-list.md#the-structured-document) |
| `cdkd state info --json` | [`cdkd state info`](cli-state.md#cdkd-state-info) |
| `cdkd state list --json` | [`--json` on its own](cli-state.md#json-on-its-own) |
| `cdkd state list --long --json`, `--tree --json` | [`cdkd state list`](cli-state.md#cdkd-state-list) |
| `cdkd state resources --json` | [`cdkd state resources`](cli-state.md#cdkd-state-resources) |
| `cdkd state show --json` | [`cdkd state show`](cli-state.md#cdkd-state-show): `{state, lock}`, the [state record](state-management.md#what-a-state-record-contains) and its lock |
| `cdkd events <stack> --json` | [The run list](cli-events.md#the-run-list) |
| `cdkd events <stack> --run <id> --json` | [Deployment Event Format](deployment-events-format.md): an array, one object per event |
| Which commands print only the document to stdout | [Output streams](cli-reference-output.md) |

A minor release may add a field, and may add a value to a field that holds
one of a set of values. A script should ignore fields it does not know.
Removing or renaming a field, changing its type, or changing what an existing
value means needs a major release.

An output or a field that this table's pages do not document is not covered.

### The state bucket and the state schema

The bucket layout in
[What is in the bucket](state-management.md#what-is-in-the-bucket) and the
fields in [What a state record contains](state-management.md#what-a-state-record-contains)
are covered. Outside a state schema bump, a minor release only adds objects
to the bucket and fields to a record.

A state schema bump lands in a minor release and migrates automatically: a
newer cdkd reads every older record and saves it in the format
[Schema versions and upgrades](state-management-schema-versions.md) describes
the next time it writes, with no command to run.

From v1.0.0, a cdkd release can read a record that a newer release wrote
when that record's schema bump only added fields. A command that would write
such a record fails before it changes anything, with an error that names the
newer version and says to upgrade cdkd. Any other bump is still refused by an older cdkd, so upgrade every
machine and CI job that deploys the stack, or reads its outputs, together.
[Schema versions and upgrades](state-management-schema-versions.md) lists the
versions and what each added.

### Configuration: `cdk.json` and environment variables

These `cdk.json` keys are covered:

| Key | Page |
| --- | --- |
| `app` | [Options every command takes](cli-reference.md#options-every-command-takes) |
| `context` (passed to the app) | [Running the app](architecture-deploy-pipeline.md#running-the-app) |
| `requireApproval` | [`--require-approval`](cli-deploy-safety-ci-flags.md#require-approval-deploy) |
| `outputsFile` | [Read Stack Outputs](stack-outputs.md) |
| `context.cdkd.stateBucket` | [Which bucket cdkd uses](state-management.md#which-bucket-cdkd-uses) |
| `context.cdkd.autoAssetStorage` | [Auto-create on first deploy](cli-bootstrap.md#auto-create-on-first-deploy) |
| `context.cdkd.useCdkBootstrapAssets` | [Keeping CDK bootstrap destinations](cli-bootstrap.md#keeping-cdk-bootstrap-destinations) |
| `context.cdkd.prefixUserSuppliedNames` | [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names) |
| `context.cdkd.captureObservedState` | [`--no-capture-observed-state`](cli-deploy-tuning.md#no-capture-observed-state) |
| `context.cdkd.noPrefixUserSuppliedNames` (deprecated) | [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names) |

These environment variables are covered:

| Variable | Page |
| --- | --- |
| `CDKD_APP` | [Options every command takes](cli-reference.md#options-every-command-takes) |
| `CDKD_STATE_BUCKET` | [Which bucket cdkd uses](state-management.md#which-bucket-cdkd-uses) |
| `CDKD_ROLE_ARN` | [`--role-arn`](cli-reference.md#role-arn) |
| `CDKD_PREFIX_USER_SUPPLIED_NAMES` | [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names) |
| `CDKD_NO_PREFIX_USER_SUPPLIED_NAMES` (deprecated) | [`--prefix-user-supplied-names`](cli-deploy-tuning.md#prefix-user-supplied-names) |
| `CDKD_NO_LIVE` | [Troubleshooting](troubleshooting.md) |
| `CDKD_PHASE_TIMINGS` | [Slow deploys, throttling and retries](troubleshooting-slow-deploys.md) |
| `CDKD_CR_AUTHZ_MAX_RETRIES` | [Slow deploys, throttling and retries](troubleshooting-slow-deploys.md) |
| `CDKD_ACM_POLL_ATTEMPTS`, `CDKD_ACM_POLL_INTERVAL_MS` | [Failures during a deploy](troubleshooting-deploy.md) |
| `CDKD_CR_S3_ENDPOINT_URL` | [The custom-resource response endpoint](troubleshooting-internals.md#the-custom-resource-response-endpoint) |
| `CDKD_ALLOW_SECRETS_ON_ARGV` | [Local Execution](local-emulation.md) |
| `CDKD_SHADOW_READY_TIMEOUT_MS` | [`cdkd local start-service`](local-start-service.md) |

A covered key or variable keeps its name and meaning. The default of a poll,
retry or timeout variable is not covered, and neither is the report
`CDKD_PHASE_TIMINGS` prints. A `cdk.json` key or `CDKD_*` variable that is not
in these two tables, including one cdkd sets for itself, is not covered.

### Bootstrap resources

The resources in
[What bootstrap creates](cli-bootstrap.md#what-bootstrap-creates) are
covered: what bootstrap creates and the default names. A minor release may
tighten their configuration, such as a bucket policy. An existing resource
gets the tightened configuration when you run `cdkd bootstrap --force`
([Re-running bootstrap](cli-bootstrap.md#re-running-bootstrap)).

From v1.0.0, re-running `cdkd bootstrap` after an upgrade follows these
rules:

- A minor release never makes an existing deploy stop working only because
  you did not re-run `cdkd bootstrap`.
- A minor release may add a feature that needs a resource or setting newer
  than your bootstrap. Using that feature without it fails with an error
  telling you to re-run `cdkd bootstrap`. Deploys that do not use the feature
  keep working.
- A minor release may require re-running bootstrap to apply a security fix.
  Its release notes say so and name the command, and cdkd warns you. A fix
  that changes resources bootstrap already created needs
  `cdkd bootstrap --force`, because a plain re-run leaves them untouched.
  When the fix cannot wait, cdkd may stop before a deploy changes anything,
  with an error that names the command to run.

### The CLI is the interface

From v1.0.0, the supported interface is the `cdkd` command. The modules
inside the npm package are not part of this promise and can change in any
release. Do not import them from a program.

## Supported runtimes

| Runtime | Supported | Note |
| --- | --- | --- |
| Node.js | 22.12 or later (`engines`: `>=22.12.0`) | Node.js 22 reaches end of life on 2027-04-30. |
| AWS CDK | Cloud assemblies synthesized by AWS CDK v2 (`aws-cdk-lib` v2) | See the schema note below. |

Dropping a Node.js major that has reached end of life is a minor release, and
its release notes say so.

A cloud assembly whose schema version is newer than any the cdkd release was
tested with is outside the supported range. cdkd does not check
the version of the assembly it reads, so such an assembly may deploy, fail or
behave differently, and the result is not covered by this page.

## Experimental features

From v1.0.0, a feature that these docs explicitly mark as experimental is
outside this promise. A minor release can change or remove it, and the
release notes call that out. These are marked experimental:

| Feature | Page |
| --- | --- |
| The AWS Emulator target: `--aws-emulator`, `CDKD_AWS_EMULATOR` and mixed mode | [Develop Locally with AWS Emulator](aws-emulator.md) |
| `cdkd refactor` | [`cdkd refactor`](cli-refactor.md) |
| `cdkd orphan` | [Orphan Instead of Destroy](orphan-vs-destroy.md) |
| `cdkd publish-assets` | [`cdkd publish-assets`](cli-publish-assets.md) |

`cdkd refactor`, `cdkd orphan` and `cdkd publish-assets` follow AWS CDK CLI
commands that the CDK CLI still marks unstable, so cdkd changes with them.

## Deprecation

A deprecated command, flag, key or variable keeps working for the rest of its
major version, and prints a warning when you use it. It is removed only in the
next major release, and that release's notes list it. There is no minimum
time between the deprecation and the removal beyond that.

## What is not covered

- Human-readable output: log lines, progress text, warnings, prompts, error
  message wording, and the formatted views printed without `--json`.
- `--verbose` output and anything written to stderr.
- Timing and performance, including how many AWS calls a command makes.
- Outputs, fields and objects that the linked pages do not document, and keys or variables not in the tables above.
- The modules inside the npm package (see [The CLI is the interface](#the-cli-is-the-interface)).
- The order in which a deploy or destroy works through a stack's resources.

## Related

- [CLI Reference](cli-reference.md): every command and the options all of them take
- [Exit codes](cli-reference-exit-codes.md): what each code means
- [State Store](state-management.md): the bucket and the record format
- [Schema versions and upgrades](state-management-schema-versions.md): mixing cdkd versions on one stack
- [`cdkd bootstrap`](cli-bootstrap.md): what bootstrap creates and how to re-run it
