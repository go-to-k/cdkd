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
- `AWS::Lambda::CodeSigningConfig`

## Issue #609 rider: four backfilled properties

The fixture also proves that four `AWS::Lambda::Function` properties backfilled
under issue #609 actually reach AWS. This matters because a property merely
declared in `handledProperties` clears the deploy-time pre-flight and then
deploys green while silently dropping the value — the declaration is a claim,
the readback is the evidence.

Two of them sit on the SAME removal axis this fixture already exercises,
because neither is a member of `UpdateFunctionConfiguration` and each needs its
own control-plane call:

| Property | Set by | Removal spelling |
| --- | --- | --- |
| `RuntimeManagementConfig` | `PutRuntimeManagementConfig` | reset to `UpdateRuntimeOn: Auto` |
| `CodeSigningConfigArn` | `CreateFunction` / `PutFunctionCodeSigningConfig` | `DeleteFunctionCodeSigningConfig` |

The other two are asserted on a separate `-durable-fn` function that keeps them
in **both** phases. That is deliberate: removing either is classified as a
REPLACEMENT rather than an in-place update — AWS refuses to add a durable
config to a function created without one and cannot express its removal at all
(an omitted block is kept), and `TenancyConfig` is create-only in both the CFn
registry schema and the SDK. Since this fixture pins its functions to fixed
names, a mid-run replacement would turn a property assertion into a
delete/create name-collision test of something else.

The code-signing config's allowed-publisher profile deliberately does not
exist: AWS validates the ARN's shape but not its existence, and
`UntrustedArtifactOnDeployment: Warn` lets it attach to an unsigned function —
so the fixture needs no real `AWS::Signer::SigningProfile`, which cannot be
deleted synchronously and would leak between runs.

## Phases

1. **Deploy** with Timeout 30 / MemorySize 256 / Description / env `{FOO}` /
   EphemeralStorage 1024 / Tracing ACTIVE — assert all six live on AWS.
2. **Re-deploy** with `CDKD_TEST_UPDATE=true` (all six fields removed) —
   assert AWS shows the CFn defaults: Timeout 3, MemorySize 128, empty
   Description, no env vars, EphemeralStorage 512, TracingConfig PassThrough
   (a pre-fix run keeps the old values).
3. **Destroy** — assert both functions and the code-signing config are gone and
   the cdkd state file is removed.

Each phase carries the matching #609 assertions: phase 1 also checks all four
properties reached AWS and that both functions were routed through the SDK
provider (`provisionedBy=sdk`, so a silent-drop re-route to Cloud Control would
fail the run); phase 2 also checks the two removal spellings above.

`Layers` removal is covered by unit tests only: an integ layer would need an
extra `LayerVersion` resource for no additional coverage of the reset
mechanism, which is shared across all seven fields.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
