# guardduty-detector-update

cdkd Cloud Control update integration test for `AWS::GuardDuty::Detector`
(go-to-k/cdkd#4910).

cdkd has no SDK provider for the detector, so it updates it through Cloud
Control, which applies the JSON patch on top of its read model. For a detector
that model carries `DataSources` and the full `Features` list, and
`UpdateDetector` refuses both beside the declared `Features` (`both data sources
and features were provided`, `EKS_RUNTIME_MONITORING and RUNTIME_MONITORING
cannot be provided in the same request`). Before the fix every update failed.
When the template declares `Features` and no `DataSources`, the fix appends
`add /Features` (the desired list) and `remove /DataSources` to a non-empty
patch, each unless the patch already has an op on that key.

## What it covers

- `AWS::GuardDuty::Detector`

## Phases

1. **Deploy** a detector declaring only `RDS_LOGIN_EVENTS`; require
   `RDS_DATA_RISK: ENABLED` (GuardDuty's default) and record the status of every
   feature the template omits.
2. **Scalar update** (`CDKD_TEST_UPDATE=scalar`): `FindingPublishingFrequency:
   ONE_HOUR` reaches AWS, the detector id is unchanged, `RDS_DATA_RISK` is still
   `ENABLED`, the omitted features are unchanged and `cdkd drift` is clean.
3. **Features update** (`CDKD_TEST_UPDATE=scalar,features`): `EKS_AUDIT_LOGS:
   DISABLED` reaches AWS, with the same in-place checks.
4. **Destroy**: the detector and the cdkd state file are gone.

## Region requirement

GuardDuty allows one detector per region. The run refuses when `AWS_REGION`
already holds a detector without this fixture's `cdkd-integ` tag, and cleanup
deletes only a detector carrying that tag.
