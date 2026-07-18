# CodeCommit Repository Example

Minimal integ probe for the `AWS::CodeCommit::Repository` SDK provider
(issue #1045). The type is `ProvisioningType: NON_PROVISIONABLE`, so cdkd's
Cloud Control fallback cannot handle it — pre-fix, the pre-flight rejected it
outright. CodeCommit returned to General Availability on 2025-11-24.

## Configuration

One stack with a single resource:

- **CodeCommit Repository**: description + two tags (`env`, `team`). Free
  (no per-repository charge at this scale).

## Features Tested in cdkd

1. **Create**: `CreateRepository` with `RepositoryDescription` + `Tags`
   (CFn `Tag[]` list converted to CodeCommit's `Record<string, string>` map).
2. **Ref parity**: CFn's `Ref` returns the repository ID (a GUID), while the
   provider's physical id is the repository NAME (all CodeCommit APIs are
   name-based). The `RepositoryId` attribute stored at create time is
   recovered by the intrinsic resolver; the stack output pins the GUID.
3. **In-place rename**: CFn marks `RepositoryName` "Update requires: No
   interruption" (the registry schema's `createOnlyProperties` is empty), so
   an UPDATE with a new name must issue `UpdateRepositoryName` — verified by
   asserting the repository ID survives the rename.
4. **Drift** (issue #1065): `readCurrentState` maps `GetRepository` +
   `ListTagsForResource` back to the flat CFn `RepositoryDescription` /
   `KmsKeyId` / `Tags` inputs. A freshly-deployed repo reports zero drift; an
   out-of-band `UpdateRepositoryDescription` is detected as drift (exit 1),
   then reverted so state and AWS realign.
5. **Update**: `UpdateRepositoryDescription`, plus tag change AND tag
   REMOVAL via `UntagResource` (the ECR issue #981 regression class).
6. **Destroy**: `DeleteRepository` + state cleanup.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```

Phases: (1) deploy + assert description/tags/Ref-id, (1b) drift clean after
deploy → out-of-band description change detected as drift → revert,
(2) `CDKD_TEST_UPDATE=true` re-deploy with rename + description change + `env`
tag change + `team` tag removal, (3) destroy + assert the repository and state
file are gone.

If Phase 1 fails with a new-customer access error, the AWS account has not
been (re-)enabled for CodeCommit — the provider cannot be integ-verified on
that account.
