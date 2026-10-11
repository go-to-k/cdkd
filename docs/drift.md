---
title: Drift Detection
description: "Find out whether a deployed stack still matches what cdkd deployed, and accept or revert the difference, with cdkd drift."
---

# Drift detection

Drift is a difference between what cdkd deployed and what is in AWS now. It
usually appears because someone edited or deleted a resource outside cdkd, for
example in the AWS console. `cdkd drift` reads each resource of a stack back
from AWS and reports what changed. It can then resolve the difference in
either direction.

```bash
cdkd drift MyStack                    # report drift; exit 1 if there is any
cdkd drift --all --json               # every stack in the bucket, for CI
cdkd drift MyStack --revert --dry-run # preview undoing the AWS-side change
cdkd drift MyStack --revert --yes     # undo the AWS-side change
cdkd drift MyStack --accept --yes     # keep the AWS-side change
```

`cdkd drift` works from cdkd's state, its record of what it deployed, so it
does not need your CDK app.

## An example

Suppose someone suspends versioning on a bucket in the console and deletes a
topic. `cdkd drift MyStack` then prints:

```text
⚠ MyStack (us-east-1): drift detected on 2 resources

  - LegacyTopic (AWS::SNS::Topic) — DELETED outside cdkd: AWS reports it does not exist.

  ~ AssetsBucket (AWS::S3::Bucket)
    - VersioningConfiguration.Status: Enabled
    + VersioningConfiguration.Status: Suspended
```

A `-` line is the value cdkd recorded, and a `+` line is the value AWS holds
now. The command exits `1` because it found drift.

## Drift or diff?

`cdkd drift` and `cdkd diff` compare different pairs of things:

```text diagram=guide-drift-vs-diff
  Template             what your CDK app asks for now
      │
      │  cdkd diff compares these two
      ▼
  cdkd state           what cdkd last deployed, with the properties
      │                it read back from AWS then
      │  cdkd drift compares these two
      ▼
  AWS                  what exists now, console edits included
```

| | `cdkd diff` | `cdkd drift` |
| --- | --- | --- |
| Question | What will my next deploy change? | What changed outside cdkd? |
| Compares | Template with state | State with AWS |
| Needs the CDK app | Yes | No |

A console edit does not show up in `cdkd diff`, because the edit changes
neither your template nor cdkd's state. Use `cdkd drift` to find it.

## Read the result

`cdkd drift` puts every resource in one of five outcomes:

| Outcome | Meaning |
| --- | --- |
| drifted | A property differs between state and AWS |
| deleted | AWS reports that the resource is gone; this counts as drift |
| clean | Every recorded property was compared and matched |
| not compared | Nothing differed, but cdkd could not compare every property |
| drift unknown | cdkd cannot read this resource type back, or the read was inconclusive |

A drifted resource is printed as `~ <logicalId> (<type>)`, followed by a pair
of lines for each property that differs.

The exit code tells a CI job which case it is in:

| Code | Meaning |
| --- | --- |
| `0` | Nothing drifted |
| `1` | At least one resource drifted, or the command failed |
| `2` | Nothing drifted, but a comparison is missing for a reason you can fix |

[`cdkd drift`](cli-drift.md) lists which resource types cdkd can read back and
gives the full exit-code rules.

## Resolve drift

Once drift is reported, you decide which side is right. `--revert` makes AWS
match state again, and `--accept` makes state match AWS.

```text
--revert    AWS <- state    undo the change in AWS
--accept    state <- AWS    keep the change and record it
```

Preview either one with `--dry-run`, which prints the planned changes and
writes nothing. Without `--dry-run`, both flags lock the stack while they
run, and both ask for confirmation unless you pass `--yes`. You cannot pass
both flags in one command.

### `--revert`: undo the change in AWS

Use `--revert` when the change in AWS was a mistake. cdkd updates the
resource in AWS so that the drifted properties hold the recorded values
again. It changes only the properties the report listed as drifted.

```bash
cdkd drift MyStack --revert --dry-run
cdkd drift MyStack --revert
```

### `--accept`: keep the change

Use `--accept` when the change in AWS is what you want, and cdkd should stop
reporting it. cdkd writes the values AWS holds into state. It does not change
AWS.

```bash
cdkd drift MyStack --accept
```

## What drift compares against

After `cdkd deploy` creates or updates a resource, it reads the resource back
from AWS and stores what AWS returned in state. `cdkd drift` compares a fresh
read against that stored copy.

The stored copy includes properties you never set in your template. So drift
can report a console change to a property your CDK code does not mention,
such as an S3 public-access-block setting, an IAM role tag or a Lambda
environment variable.

### A resource deployed without the stored copy

A deploy run with `--no-capture-observed-state` skips the read-back. For such
a resource, `cdkd drift` can only compare the properties in your template, so
a change to any other property goes unnoticed. To store the copy without
redeploying, run:

```bash
cdkd state refresh-observed MyStack
```

## Related

- [`cdkd drift`](cli-drift.md): every flag, the exit codes, the per-type
  coverage, and how secret values are reported
- [`cdkd diff`](cli-diff.md): comparing your template against state
- [cdkd deploy: tuning](cli-deploy-tuning.md): `--no-capture-observed-state`
- [State Management](state-management.md): where the stored copy lives
