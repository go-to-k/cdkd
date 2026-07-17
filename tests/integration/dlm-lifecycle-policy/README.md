# dlm-lifecycle-policy

Integration test for the `AWS::DLM::LifecyclePolicy` SDK provider
(issue #1040). The type is `ProvisioningType: NON_PROVISIONABLE`, so no
Cloud Control fallback exists — this fixture is the end-to-end proof of
the SDK provider.

## Resources

- `AWS::DLM::LifecyclePolicy` — minimal EBS-snapshot lifecycle policy
  (daily schedule, retain 1). Targets tag `cdkd-integ-dlm=true`, which no
  volume in the account carries, so it never actually creates snapshots.
- `AWS::IAM::Role` — the DLM execution role (`cdkd-integ-dlm-role`,
  deterministic name so cleanup can delete it directly).

## Phases (verify.sh)

1. **Deploy** the baseline policy (ENABLED, 3 tags) and assert via
   `aws dlm get-lifecycle-policy` that the configuration reached AWS and
   that state routes the resource via the SDK provider
   (`provisionedBy=sdk`).
2. **Update** (`CDKD_TEST_UPDATE=true`): description change + State
   `ENABLED -> DISABLED` (UpdateLifecyclePolicy), tag value change AND
   tag removal (TagResource / UntagResource — the #981 regression
   class). Asserts the PolicyId is unchanged (in-place, no replacement).
3. **Destroy** and assert the policy + role are gone from AWS and the
   cdkd state file is removed.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
