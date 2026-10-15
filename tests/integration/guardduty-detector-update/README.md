# guardduty-detector-update

cdkd Cloud Control update integration test for `AWS::GuardDuty::Detector`
(go-to-k/cdkd#4910).

cdkd has no SDK provider for the detector, so it updates it through Cloud
Control, which applies the JSON patch on top of its read model. For a detector
that model carried both `DataSources` and the full `Features` list on every read
measured (us-east-1 and us-west-2), and
`UpdateDetector` refuses them together (`both data sources and features were
provided`, `EKS_RUNTIME_MONITORING and RUNTIME_MONITORING cannot be provided in
the same request`). Before the fix a scalar-only update failed, because the
read-back `Features` holds both runtime features, and a `Features` update
failed, because the read-back `DataSources` rode along, whichever of the two
keys the template declared. For each key the patch has no op on, the fix
appends `add /<key>` with the declared value, or `remove /<key>` when the
template does not declare it, to a non-empty patch. `cdkd drift --revert`
takes a different arm, described in `withGuardDutyDetectorReadBackOps`'s
docstring.

## What it covers

- `AWS::GuardDuty::Detector`

## Phases

1. **Deploy** a detector declaring only `RDS_LOGIN_EVENTS`; require
   `RDS_DATA_RISK: ENABLED` (GuardDuty's default) and record the status and
   additional configurations of every feature the template omits.
2. **Scalar update** (`CDKD_TEST_UPDATE=scalar`): `FindingPublishingFrequency:
   ONE_HOUR` reaches AWS, the detector id is unchanged, `RDS_DATA_RISK` is still
   `ENABLED`, the omitted features are unchanged and `cdkd drift` is clean.
3. **Features update** (`CDKD_TEST_UPDATE=scalar,features`): `EKS_AUDIT_LOGS:
   DISABLED` reaches AWS, with the same in-place checks.
3b. **`cdkd drift --revert`** (go-to-k/cdkd#4921): drift
   `FindingPublishingFrequency` through the GuardDuty API, revert it, and assert
   `ONE_HOUR` is back with the same in-place checks; then the same for a
   feature, `EKS_AUDIT_LOGS` drifted to `ENABLED` and reverted to `DISABLED`.
4. **Destroy**: the detector and the cdkd state file are gone.
5. **`DataSources` shape** (`CDKD_TEST_SHAPE=datasources`, `S3Logs` disabled):
   deploy, scalar update, destroy; `ONE_HOUR` reaches AWS, the id is
   unchanged, `S3Logs` stays `DISABLED`, every feature but `RDS_LOGIN_EVENTS`
   keeps its status and additional configurations, and `cdkd drift` is clean.
6. **Bare shape** (`CDKD_TEST_SHAPE=bare`, neither key declared): the same
   cycle.

## Region requirement

GuardDuty allows one detector per region. The run refuses when `AWS_REGION`
already holds a detector without this fixture's `cdkd-integ` tag, and cleanup
deletes only a detector carrying that tag.
