# sdk-ccapi-crossref

Integration test fixture for the cdkd **SDK-Provider <-> Cloud Control API
cross-reference boundary** — the fragile seam created by cdkd's
[#614](https://github.com/go-to-k/cdkd/issues/614) silent-drop routing.

## Background

cdkd prefers its fast **SDK Providers** but falls back to the generic **Cloud
Control API** for types without one. Per the #614 routing rule, an
SDK-registered type ALSO flips to the CC path the moment its template sets a
top-level property the SDK Provider would silently drop
(`ProviderRegistry.getProviderFor`). When that happens:

- The SDK Provider's `create()` is **bypassed entirely** — typed attribute
  writes (e.g. `attributes.Arn`) never happen.
- The physical id becomes whatever CC API returns (often a compound
  `idA|idB` shape; for `AWS::Kinesis::Stream` it is the stream **name**).
- The SDK Provider's `delete()` is **also bypassed** on destroy — the CC
  delete path runs instead.

So `Fn::GetAtt` / `Ref` references that cross the SDK <-> CC boundary depend
on the intrinsic resolver's `constructAttribute` fallback deriving the right
value WITHOUT the SDK Provider's attribute write. This is a documented
fragile area (memory rules `feedback_silent_drop_forces_cc_api_routing` and
`feedback_cc_api_routing_bypasses_sdk_delete_logic`).

## Fixture

One stack (`CdkdSdkCcApiCrossrefExample`), four cheap resources, no VPC / NAT,
deterministic physical names:

| Logical id       | Type                     | Routing  | Why                                            |
| ---------------- | ------------------------ | -------- | ---------------------------------------------- |
| `KinesisStream`  | `AWS::Kinesis::Stream`   | `cc-api` | sets silent-drop `DesiredShardLevelMetrics`    |
| `CcLambda`       | `AWS::Lambda::Function`  | `cc-api` | sets silent-drop `RuntimeManagementConfig`     |
| `ExecRole`       | `AWS::IAM::Role`         | `sdk`    | no silent-drop property                        |
| `StreamArnParam` | `AWS::SSM::Parameter`    | `sdk`    | no silent-drop property                        |

The routing decision was confirmed against this cdkd version with the
`findActionableSilentDrops` registry helper on the synthesized template
(`KinesisStream` / `CcLambda` -> `cc-api`; `ExecRole` / `StreamArnParam` ->
`sdk`).

### Cross-references (both directions)

- **(A) SDK -> CC:** `StreamArnParam.Value = Fn::GetAtt(KinesisStream, 'Arn')`
  — an SDK-routed consumer reading a CC-routed producer's attribute.
- **(B) CC -> SDK:** `CcLambda.Role = Fn::GetAtt(ExecRole, 'Arn')` — a
  CC-routed consumer reading an SDK-routed producer's attribute.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. Build cdkd (root) + install fixture deps (`pnpm install --ignore-workspace`).
2. `cdkd deploy CdkdSdkCcApiCrossrefExample`.
3. Assert from state that **`KinesisStream` and `CcLambda` are
   `provisionedBy: 'cc-api'`** and **`ExecRole` and `StreamArnParam` are
   `provisionedBy: 'sdk'`** (proves the mixed routing).
4. Assert **cross-ref A**: the SSM parameter's value on AWS
   (`aws ssm get-parameter`) equals the real Kinesis stream ARN
   (`aws kinesis describe-stream-summary`).
5. Assert **cross-ref B**: the Lambda's configured role on AWS
   (`aws lambda get-function-configuration`) equals the real IAM role ARN
   (`aws iam get-role`).
6. Assert the silent-drop prop reached AWS: `RuntimeManagementConfig`
   (`aws lambda get-runtime-management-config` returns `FunctionUpdate`),
   proving the CC route forwarded the full property map.
7. `cdkd destroy --force` (exercises the CC delete path for the stream +
   Lambda) and assert every named resource (stream, function, role,
   parameter) and the state file are gone.

The script is BSD/macOS-portable (no `grep -P`, no `date -d`), captures real
exit codes, and prints `[verify] PASS` only on full success.

> NOTE: not yet run against real AWS — needs `/run-integ sdk-ccapi-crossref`
> before merge.
