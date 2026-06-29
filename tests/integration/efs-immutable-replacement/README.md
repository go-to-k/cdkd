# efs-immutable-replacement

cdkd createOnly-property replacement detection + stateful-replace guard integration test.

`AWS::EFS::FileSystem.PerformanceMode` is a **createOnly (immutable)** property
per the CloudFormation registry schema, and `AWS::EFS::FileSystem` has **no**
hand-authored `ReplacementRulesRegistry` rule. Before the createOnly fallback,
cdkd's diff classifier only knew the ~25 types with an explicit rule, so it
mis-classified a `PerformanceMode` change as an in-place UPDATE (`cdkd diff`
showed "1 to update" and the deploy attempted a doomed update).

This fixture verifies the full corrected flow:

- the diff now consults the CFn schema's `createOnlyProperties` and reports a
  **replacement**;
- EFS is a stateful type, so the property-driven replacement is **blocked**
  unless `--force-stateful-recreation` is passed (closing the data-loss footgun
  where stateful types were previously DELETE+CREATEd without confirmation);
- with the flag, the replacement performs a real DELETE+CREATE.

## What it covers

- `AWS::EFS::FileSystem`

## Phases

1. **Deploy** `PerformanceMode=maxIO`; capture the `FileSystemId`.
2. **`cdkd diff`** (maxIO → generalPurpose) must report a **replacement** (the
   createOnly fallback), not "1 to update".
3. **Deploy WITHOUT `--force-stateful-recreation`** must be **blocked**
   (`STATEFUL_REPLACE_BLOCKED`); assert the deploy fails and the filesystem is
   unchanged (same `FileSystemId`, still `maxIO`).
4. **Deploy WITH `--force-stateful-recreation`** performs the DELETE+CREATE;
   assert a **new** `FileSystemId` with `generalPurpose` and the old one gone.
5. **Destroy** — assert the filesystem is gone and the cdkd state is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 bash verify.sh
```
