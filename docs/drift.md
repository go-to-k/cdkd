---
title: Drift Detection
description: "Find out whether a deployed stack still matches what cdkd deployed, and accept or revert the difference, with cdkd drift."
---

# Drift detection

Drift is a difference between what cdkd deployed and what is in AWS now,
usually because someone edited or deleted a resource outside cdkd. `cdkd
drift` reads each resource of a stack back from AWS, reports what changed,
and can resolve it in either direction. It reads the state record only, so it
needs no CDK app.

```bash
cdkd drift MyStack                    # report drift; exit 1 if there is any
cdkd drift --all --json               # every stack in the bucket, for CI
cdkd drift MyStack --revert --dry-run # preview undoing the AWS-side change
cdkd drift MyStack --revert --yes     # AWS <- state: undo it
cdkd drift MyStack --accept --yes     # state <- AWS: keep it
```

## Drift or diff?

```text diagram=guide-drift-vs-diff
  Template             what your CDK app asks for now
      │
      │  cdkd diff compares these two
      ▼
  cdkd state record    what cdkd last deployed, with the properties
      │                it read back from AWS then
      │  cdkd drift compares these two
      ▼
  AWS                  what exists now, console edits included
```

| | `cdkd diff` | `cdkd drift` |
| --- | --- | --- |
| Question | What will my next deploy change? | Did someone change this outside cdkd? |
| Compares | Template with state record | State record with AWS |
| Needs the CDK app | Yes | No |

A console edit does not show up in `cdkd diff`, because neither the template
nor the state record changed. Use `cdkd drift` for that.

## Read the result

Every resource ends in one of five outcomes:

| Outcome | Meaning |
| --- | --- |
| drifted | A property differs between state and AWS. Listed as `~ <logicalId> (<type>)` with one line per property. |
| deleted | AWS reports the resource is gone. Counts as drift. |
| clean | Every recorded property was compared and matched. |
| not compared | Nothing differed, but cdkd could not compare every property. |
| drift unknown | cdkd has no way to read this type back, or the read could not tell. |

The exit code tells a CI job which case it is in:

| Code | Meaning |
| --- | --- |
| `0` | Nothing drifted |
| `1` | Drift on at least one resource, or the command failed |
| `2` | Nothing drifted, but a comparison did not happen for a reason you can act on |

Which resource types have a read-back, and the full exit-code rules, are in
[`cdkd drift`](cli-drift.md).

## Resolve drift: `--accept` or `--revert`

The two flags are mutually exclusive. Both take the stack lock, and both
prompt unless you pass `--yes`.

| Flag | Direction | Use it when | Changes AWS |
| --- | --- | --- | --- |
| `--accept` | state ← AWS | The AWS-side change is what you want, and cdkd should stop reporting it | No |
| `--revert` | AWS ← state | The AWS-side change was a mistake | Yes |

`--revert` pushes back only the properties the report listed as drifted.
Preview either one with `--dry-run`, which prints the planned changes and
writes nothing.

## The baseline drift compares against

After each create or update, `cdkd deploy` reads the resource back from AWS
and stores the result in the state record. This **observed state** is the
drift baseline. Because it holds properties you never templated, drift can
report a console change to one of them, such as an S3 public-access-block
setting, an IAM role tag or a Lambda environment variable.

A resource without observed state is compared against its templated
properties only, so changes to other keys go unnoticed. That is the case when
the deploy ran with `--no-capture-observed-state`. Populate the baseline
without redeploying:

```bash
cdkd state refresh-observed MyStack
```

## Related

- [`cdkd drift`](cli-drift.md): every flag, the exit codes, the per-type
  coverage, and how secret values are reported
- [`cdkd diff`](cli-diff.md): comparing your template against state
- [Deploy: tuning](cli-deploy-tuning.md): `--no-capture-observed-state`
- [State Management](state-management.md): where the baseline is stored
