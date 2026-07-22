# lambda-config-field-removal

cdkd Lambda config-field removal reset integration test (issue #1155).

`UpdateFunctionConfiguration` treats an **absent** field as "no change", so a
template that drops a previously-set config field must send the CloudFormation
default reset value or AWS silently keeps the old one. cdkd previously passed
`Timeout` / `MemorySize` / `Description` / `Environment` / `Layers` /
`TracingConfig` / `EphemeralStorage` straight through as `undefined` on update —
the deploy reported success, state dropped the field, and the next `cdkd diff`
said "No changes" while AWS still held the old value (invisible, permanent
drift). Found live by the 2026-07-22 `/hunt-bugs` sweep.

The fix routes those fields through the provider's existing
`clearOnUpdateRemoval` helper (already used by `DeadLetterConfig` / `KMSKeyArn` /
`FileSystemConfigs` / `ImageConfig` / `SnapStart` / `LoggingConfig`) with their
CFn-default reset values: Timeout `3`, MemorySize `128`, Description `''`,
Environment `{Variables: {}}`, Layers `[]`, TracingConfig
`{Mode: 'PassThrough'}`, EphemeralStorage `{Size: 512}`.

## What it covers

- `AWS::Lambda::Function`

## Phases

1. **Deploy** with Timeout 30 / MemorySize 256 / Description / env `{FOO}` /
   EphemeralStorage 1024 / Tracing ACTIVE — assert all six live on AWS.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` (all six fields removed) —
   assert AWS shows the CFn defaults: Timeout 3, MemorySize 128, empty
   Description, no env vars, EphemeralStorage 512, TracingConfig PassThrough
   (a pre-fix run keeps the old values).
3. **Destroy** — assert the function is gone and the cdkd state file is removed.

`Layers` removal is covered by unit tests only: an integ layer would need an
extra `LayerVersion` resource for no additional coverage of the reset
mechanism, which is shared across all seven fields.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
