---
title: Exporting to CloudFormation
description: Hand a cdkd-managed stack back to CloudFormation with cdkd export — IMPORT changesets, Custom Resource 2-phase migration, and nested-stack support.
---

# Exporting to CloudFormation

`cdkd export` is the mirror of [`cdkd import`](import.md): it hands a
cdkd-managed stack back to CloudFormation via a `ChangeSetType=IMPORT`
changeset. AWS resources are unchanged across the migration, and cdkd state for
the exported stack is deleted on success. From then on the stack is managed by
`cdk deploy` / `aws cloudformation`. JSON and YAML templates are both accepted,
and shorthand intrinsics round-trip.

```bash
cdkd export MyStack                           # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                 # print the import plan, do not call CFn
cdkd export MyStack --include-non-importable  # 2-phase: IMPORT importable + CFn-CREATE Custom Resources
cdkd export MyApp                             # nested-stack tree: leaf-first per-stack IMPORT loop
```

## What to know before you export

- **Custom Resources need an opt-in.** Lambda-backed Custom Resources
  (`Custom::*` and `AWS::CloudFormation::CustomResource`) are not
  CloudFormation-importable. `--include-non-importable` opts into a 2-phase
  migration that re-creates them through CloudFormation, which re-invokes each
  backing Lambda's `onCreate` handler — so that handler must be idempotent.
- **Nested stacks are supported** via a leaf-first per-stack IMPORT loop. Each
  cdkd child stack becomes its own CloudFormation stack. AWS rejects
  `IncludeNestedStacks` on an IMPORT changeset, so a single atomic changeset is
  not an option.
- **Some resource types CloudFormation cannot import at all.** cdkd detects
  them from the type's CloudFormation registry schema and names every affected
  resource at once — before acquiring the stack lock and before submitting
  anything — so you fix them in one pass rather than one per re-run.
  `--skip-import-support-preflight` bypasses the check if AWS has since made a
  type importable.
- **CLI `-c` context overrides are refused by default,** because they are not
  persisted and a later `cdk deploy` without them would synthesize a different
  template. Move them into `cdk.json`, or pass `--accept-transient-context`.

### Types CloudFormation refuses to import

These are the types seen so far. The check itself is derived from each type's
CloudFormation registry schema rather than from a fixed list, so it catches
types not named here — and stops catching one the moment AWS makes it
importable.

| Resource type | What to do instead |
| --- | --- |
| `AWS::Glue::Table` | Remove it from the stack before exporting — it stays in AWS and can be re-declared in CloudFormation afterwards — or destroy it and let CloudFormation create it fresh. |
| `AWS::Route53::RecordSet` | Same. |
| `AWS::Route53::RecordSetGroup` | Same. |
| `AWS::AppSync::ApiKey` | Same. |
| `AWS::EC2::NetworkAclEntry` | Same. |
| `AWS::SQS::QueuePolicy` | Same. |
| `AWS::SNS::TopicPolicy` | Same. |

## Related

- [`cdkd export`](cli-export.md) — the full reference: every flag, the blocked
  set, identifier resolution, template preprocessing, the Custom Resource
  2-phase flow, and the nested-stack adoption mechanics.
- [`cdkd import`](import.md) — the opposite direction, bringing
  CloudFormation-managed resources under cdkd.
- [nested-stack export/import design note](design/464-nested-stacks-export-import.md)
  — the design rationale behind the per-stack loop.
