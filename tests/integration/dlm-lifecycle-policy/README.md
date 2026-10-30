# dlm-lifecycle-policy

Integration test for the `AWS::DLM::LifecyclePolicy` SDK provider
(issue #1040). The type is `ProvisioningType: NON_PROVISIONABLE`, so no
Cloud Control fallback exists — this fixture is the end-to-end proof of
the SDK provider.

## Resources

- `AWS::DLM::LifecyclePolicy` — minimal EBS-snapshot lifecycle policy
  (daily schedule, retain 1). Targets tag `cdkd-integ-dlm=true`, which no
  volume in the account carries, so it never actually creates snapshots.
- `AWS::DLM::LifecyclePolicy` (default policy) — an always-DISABLED VOLUME
  default policy carrying every UpdateLifecyclePolicy shorthand field at a
  non-default value (issue #1160 removal-reset coverage). DISABLED means it
  never snapshots anything.
- `AWS::IAM::Role` — the DLM execution role (`cdkd-integ-dlm-role`,
  deterministic name so cleanup can delete it directly).

## Phases (verify.sh)

1. **Deploy** the baseline policy (ENABLED, 3 tags) and assert via
   `aws dlm get-lifecycle-policy` that the configuration reached AWS and
   that state routes the resource via the SDK provider
   (`provisionedBy=sdk`).
1b. **Drift (zero)**: assert `cdkd drift` exits 0 on the freshly-deployed
   policy. `GetLifecyclePolicy` returns `PolicyDetails` with server-injected
   defaults (e.g. `PolicyLanguage: SIMPLIFIED`) the template never set; the
   provider's `readCurrentState` + `getDriftUnknownPaths` exclude those so
   they never register as phantom drift (issue #1067). A no-op deploy must
   be drift-free.
2. **Update** (`CDKD_TEST_UPDATE=true`): description change + State
   `ENABLED -> DISABLED` (UpdateLifecyclePolicy), tag value change AND
   tag removal (TagResource / UntagResource — the #981 regression
   class). Asserts the PolicyId is unchanged (in-place, no replacement).
2b. **Removal retained** (`CDKD_TEST_REMOVAL=true`, issues #1160 / #5004): the
   default policy drops CreateInterval / RetainInterval / CopyTags /
   ExtendDeletion / CrossRegionCopyTargets / Exclusions. CloudFormation keeps
   the live value of a removed shorthand field, so cdkd sends no reset;
   asserts AWS still reads back the baseline `2 / 3 / true / true / 1 / true / 1`
   (CreateInterval / RetainInterval / CopyTags / ExtendDeletion / #CrossRegionCopyTargets /
   ExcludeBootVolumes / #ExcludeTags) with the policy id unchanged. The same
   redeploy drops the standard policy's Description beside a RetainRule count
   change (issue #5546): asserts AWS keeps the Description and applies the
   count, that the deploy prints each policy's kept-removal warning exactly
   once, and that no "CloudFormation would reset it" line names either policy.
3. **Destroy** and assert both policies + the role are gone from AWS and
   the cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
