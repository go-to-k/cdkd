---
title: Exporting to CloudFormation
description: Hand a cdkd-managed stack back to CloudFormation with cdkd export — IMPORT changesets, Custom Resource 2-phase migration, and nested-stack support.
---

# Exporting a stack back to CloudFormation

`cdkd export` is the mirror of [`cdkd import`](import.md): it hands a
cdkd-managed stack back to CloudFormation via a CFn
`ChangeSetType=IMPORT` changeset. AWS resources are unchanged across
the migration; cdkd state for the exported stack is deleted on success.
From then on the stack is managed by `cdk deploy` /
`aws cloudformation`. Accepts JSON and YAML templates (shorthand
intrinsics round-trip).

```bash
cdkd export MyStack                           # confirmation prompt; CFn stack name = cdkd stack name
cdkd export MyStack --cfn-stack-name MyStack-CFn
cdkd export MyStack --dry-run                 # print the import plan, do not call CFn
cdkd export MyStack --include-non-importable  # 2-phase: IMPORT importable + CFn-CREATE Custom Resources
cdkd export MyApp                             # nested-stack tree: leaf-first per-stack IMPORT loop
```

**Lambda-backed Custom Resources** (`Custom::*` /
`AWS::CloudFormation::CustomResource`) are NOT directly CFn-importable.
`--include-non-importable` opts into a 2-phase migration that re-CREATEs
them through CFn — the Custom Resource Lambda must be idempotent.
**Nested stacks** are supported via a leaf-first per-stack IMPORT loop
(AWS rejects `--include-nested-stacks` for IMPORT changesets).
**Some resource types CloudFormation cannot import at all** (`AWS::Glue::Table`,
`AWS::Route53::RecordSet` / `::RecordSetGroup`, `AWS::AppSync::ApiKey`,
`AWS::EC2::NetworkAclEntry`, `AWS::SQS::QueuePolicy`,
`AWS::SNS::TopicPolicy`, …). cdkd detects those from the resource type's
CloudFormation registry schema and names every affected resource at once —
before acquiring the stack lock, and before submitting anything — so you fix
them in one pass instead of one per re-run.
`--skip-import-support-preflight` bypasses the check if AWS has since made a
type importable.

See **[`cdkd export`](cli-export.md)** for the full reference — every flag,
the Custom Resource 2-phase flow, and nested-stack adoption mechanics
(`--cfn-child-stack-name` per-child overrides, AWS's "Nest an existing
stack" pattern). The design rationale is in the
[nested-stack export/import design note](design/464-nested-stacks-export-import.md).
For the opposite direction — bringing CloudFormation-managed resources
under cdkd — see [`cdkd import`](import.md).
