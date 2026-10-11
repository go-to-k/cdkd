---
title: Region resolution
description: "Which AWS region a cdkd command works in, where --region is still a supported flag, and how cdkd treats an upper-cased region."
---

# Region resolution

Choose the region with `AWS_REGION` or your AWS profile. This page gives the
order cdkd reads those sources in, and the two places where the answer is not
obvious: the bootstrap commands, and a region typed in upper case.

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
| `cdkd bootstrap`, `cdkd bootstrap --destroy`, `cdkd gc` | `--region`, `AWS_REGION`, `AWS_DEFAULT_REGION`, the profile's region, `us-east-1` |
| `cdkd local` commands | Per command. Each command's page gives its order. |
| Every other command | `--region`, `AWS_REGION`, `us-east-1` |

The three commands in the first row share one order because they work on the
same per-region record. `cdkd bootstrap` writes the **bootstrap marker**, a
small file in the state bucket that records a region's asset bucket and ECR
repository, and the other two read it.

## An inferred region yields to existing asset storage

This rule applies to `cdkd bootstrap`, `cdkd bootstrap --destroy` and
`cdkd gc` only. When cdkd took the region from your profile, and asset storage
already exists in another region, cdkd uses the region that has the storage,
so that a bare command does not strand it. A region you name yourself is
always used as given.

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
