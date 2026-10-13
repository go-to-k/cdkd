---
title: Region resolution
description: "Which AWS region a cdkd command works in, where --region is still a supported flag, and how cdkd treats an upper-cased region."
---

# Region resolution

Choose the region with `AWS_REGION` or your AWS profile. This page gives the
order cdkd reads those sources in, how a region cdkd inferred keeps working
with stacks and storage that an older cdkd created in `us-east-1`, and how
cdkd treats a region typed in upper case.

```bash
AWS_REGION=us-west-2 cdkd deploy MyStack
cdkd deploy MyStack --profile staging     # the profile's region
```

## `--region` is deprecated on most commands

`--region` is a supported flag on two commands only, where it names the region
to act on:

```bash
cdkd bootstrap --region us-west-2
cdkd gc --region us-west-2
```

On every other command the flag is deprecated. It is hidden from `--help`, it
prints a deprecation warning, and a future release will remove it. Until then
it still works, and it outranks the environment variable and the profile.

## Resolution order

cdkd takes the first source in the list that has a value.

| Commands | Order |
| --- | --- |
| `cdkd local` commands | Per command. Each command's page gives its order. |
| Every other command | `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, the profile's region, `us-east-1` |

A stack with `env.region` set in your CDK app always uses that region. The
order above applies to an env-agnostic stack, and to commands that are not
about one stack, such as finding the state bucket.

The AWS SDK for JavaScript does not read `AWS_DEFAULT_REGION`. When cdkd
takes the region from it, cdkd copies it into `AWS_REGION` for its own AWS
calls, so they go to the same region as the state. The CDK app does not see
that copy and gets your environment as you set it, as under the AWS CDK CLI;
neither does a Docker image asset's own build command (`executable`). The
`docker` commands cdkd runs itself (build, login, push) do see it.

Earlier cdkd releases skipped `AWS_DEFAULT_REGION` and the profile on every
command outside `cdkd bootstrap`, `cdkd bootstrap --destroy` and `cdkd gc`,
and used `us-east-1` when neither `--region` nor `AWS_REGION` was set. The next
section is how cdkd keeps working with what that default created.

## An inferred region yields to what already exists

When cdkd took the region from `AWS_DEFAULT_REGION` or your profile, and what
it is about to read or write already exists only in `us-east-1`, cdkd keeps
using `us-east-1`, so that a bare command does not strand it. A region you name
yourself, with `--region` or `AWS_REGION`, is always used as given.

The rule covers:

- **A stack's state.** An env-agnostic stack that has state in `us-east-1` and
  none in your profile's region stays in `us-east-1`. A stack with no state
  anywhere goes to your profile's region, unless every other env-agnostic
  stack of the same app that has state stays in `us-east-1` (by the rules on
  this page): then it goes to `us-east-1` with them, so the app stays in one
  region. A legacy
  state record that names no region counts as `us-east-1`.
- **A stack's lock**, for `cdkd force-unlock` on a stack with no state record.
- **The exports index**, the file in the state bucket that `Fn::ImportValue`
  reads first. A command uses one such file for all its stacks: the
  `us-east-1` one whenever it exists, otherwise your profile region's.
- **Asset storage**, for `cdkd bootstrap`, `cdkd bootstrap --destroy` and
  `cdkd gc`. These three work on the same per-region record: `cdkd bootstrap`
  writes the **bootstrap marker**, a small file in the state bucket that
  records a region's asset bucket and ECR repository, and the other two read
  it.
- **The legacy state bucket name.** cdkd also looks for
  `cdkd-state-<account>-us-east-1`, and uses it when the legacy bucket for
  your profile's region does not exist, or when the `us-east-1` one holds any
  object. One exception: when the `us-east-1` name answers `403` (another
  owner, or a policy denies it) and the bucket for your profile's region
  answers normally, cdkd uses the latter. `cdkd state migrate` with no
  `--region` picks its source the same way.
- **A stack with state in both regions.** cdkd keeps using `us-east-1`, as a
  command with no region named did before, and prints a line naming both.

For a stack:

| Your profile | Existing state for the stack | cdkd uses |
| --- | --- | --- |
| `ap-northeast-1` | In `ap-northeast-1` | `ap-northeast-1` |
| `eu-west-1` | Only in `us-east-1` | `us-east-1`, and says so |
| `eu-west-1` | None anywhere | `eu-west-1` |

In the second row, cdkd prints:

```text
Stack 'MyStack' has existing state in us-east-1, but your AWS profile resolves
eu-west-1. Continuing to use us-east-1 so the existing stack is not duplicated.
Set AWS_REGION=us-east-1 to silence this message, or AWS_REGION=eu-west-1 to
work in eu-west-1 instead (where this stack has no state).
```

Setting `AWS_REGION=eu-west-1` for that stack does not move it. cdkd finds no
state in `eu-west-1` and creates a second copy of the stack there.

For asset storage:

| Your profile | Existing asset storage | cdkd uses |
| --- | --- | --- |
| `ap-northeast-1` | Marker in `ap-northeast-1` | `ap-northeast-1` |
| `eu-west-1` | Marker only in `us-east-1` | `us-east-1`, and says so |
| `eu-west-1` | None anywhere | `eu-west-1` |

In the second row, cdkd prints:

```text
cdkd asset storage exists in us-east-1, but your AWS profile resolves eu-west-1.
Continuing to use us-east-1 so the existing storage is not orphaned. Pass
'--region eu-west-1' to target your profile's region, or '--region us-east-1'
to silence this message.
```

## Region spelling is lower-cased

cdkd lower-cases a region before it reaches an AWS client, so
`AWS_REGION=US-EAST-1` behaves as `us-east-1`. cdkd does this because request
signing, endpoint resolution and ARNs are all case-sensitive, and an
upper-cased region breaks each of them.

Which inputs are lower-cased depends on the command:

| Command | What is lower-cased |
| --- | --- |
| Every command outside `cdkd local` | `--region`, `AWS_REGION` and `AWS_DEFAULT_REGION` |
| `local invoke`, `local run-task`, `local invoke-agentcore` | The flag and both environment variables |
| `local start-api` | The flag only |
| `local start-service`, `local start-alb`, `local start-cloudfront`, `local start-agentcore` | The flag, `--stack-region` and both environment variables |

### Edge cases

- **`local start-api` and the environment variables.** An upper-cased
  `AWS_REGION` is not lower-cased there, so it reaches the Lambda containers
  that the command starts.
- **`--stack-region` on the four `local start-*` commands in the last row.**
  The value is lower-cased, but your exact spelling is still used to match
  the state record.
- **The bootstrap marker keeps the spelling you typed.** `cdkd bootstrap`
  builds the marker's key and the default asset-storage names from the region
  as you wrote it. Commands that read the marker try the lower-case key first
  and your spelling second, so a marker written under either is found.
  [`cdkd gc`](cli-gc.md#which-region-is-collected) and
  [`cdkd bootstrap --destroy`](cli-bootstrap-teardown.md#finding-the-marker-for-a-region)
  describe their own reads.

## Related

- [CLI Reference](cli-reference.md): every command and the shared options
- [`cdkd bootstrap`](cli-bootstrap.md): the per-region asset storage and its marker
- [`cdkd gc`](cli-gc.md): collecting one region's asset storage
