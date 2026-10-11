---
title: "cdkd drift: nested stacks"
description: "How cdkd drift checks nested stacks, how they appear in the report, and what a RECORD MISSING row means."
---

# cdkd drift: nested stacks

`cdkd drift` checks a stack's nested stacks whenever it checks the stack. You
do not pass a flag for it, and each nested stack gets its own block in the
report.

```bash
# Parent, then Parent~Child, then any stack below it
cdkd drift Parent

# the nested stack and the stacks below it, not Parent
cdkd drift 'Parent~Child'
```

## How a nested stack is stored and checked

cdkd deploys the resources of a nested stack itself. No CloudFormation stack
exists in AWS for it, so there is no stack to read back. cdkd keeps the nested
stack's resources in a state record of their own, named `<parent>~<child>`, in
the parent's region. Drift reads that record and compares its resources one by
one, as it does for any stack.

The consequences:

- Drift inside a nested stack makes the run exit `1`.
- A record is checked once, however it was selected.
- `--accept` and `--revert` act on the drifted resources of each nested stack,
  and take the lock of that nested stack's own record.

## How nested stacks appear in the report

The parent's template has one `AWS::CloudFormation::Stack` resource per nested
stack. In the parent's block that resource is counted as skipped, because the
nested stack's own block reports on it.

A parent that holds nothing but nested stacks prints:

```text
✓ Parent (us-east-1): no drift detected here — 2 nested stacks, each checked in its own block
```

## A nested stack whose record is missing

When the parent's state lists a nested stack and the nested stack's own record
is not in the state bucket, drift cannot check anything inside it. It reports
the parent's `AWS::CloudFormation::Stack` resource as deleted, with the words
`RECORD MISSING`:

```text
  - Child (AWS::CloudFormation::Stack) — RECORD MISSING: its nested stack's own state record Parent~Child is not in state.
```

This is drift, so the run exits `1`. A record goes missing in one of two ways,
and the fix differs.

### An import that stopped part-way

A `cdkd import --migrate-from-cloudformation` records the parent first and its
nested stacks afterwards. If it stopped in between, the nested stack's
resources are still live in the source CloudFormation stack. Run the same
import again with `--force`.

### A record removed after a deploy

Someone removed the record, by hand or with `cdkd state orphan`. The resources
the nested stack held are no longer tracked by cdkd, and they may still exist
in AWS. Check for them before you recreate the nested stack, because the new
resources can collide with the old ones.

### `--accept` and `--revert`

Both flags refuse a `RECORD MISSING` row by name, as they refuse any
[deleted resource](cli-drift-accept-revert.md#deleted-resources).

## Related

- [`cdkd drift`](cli-drift.md): the report, the exit codes and the options
- [cdkd drift: JSON output](cli-drift-json.md): the `nestedStackRecordMissing` field
- [State Management](state-management.md): the state bucket layout and the state schema
