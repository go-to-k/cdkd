# sdk-ccapi-crossref

Integration test fixture for the cdkd **SDK-Provider <-> Cloud Control API
cross-reference boundary**.

## Background

cdkd prefers its fast **SDK Providers** and uses the generic **Cloud Control
API** for everything else. A resource on the Cloud Control path differs from
one on the SDK path in ways a cross-reference can trip over:

- No SDK Provider `create()` runs, so there is no typed attribute write —
  `Fn::GetAtt` values come from a Cloud Control read-back.
- The physical id is whatever Cloud Control returns (usually the resource
  **name**, sometimes a compound `idA|idB`), so a `Fn::GetAtt` miss that falls
  back to the physical id yields a name where an ARN was expected.
- On destroy the SDK Provider's `delete()` is **bypassed** — the Cloud Control
  delete path runs instead, even for a type that has an SDK Provider.

## How the Cloud Control layer is reached

Deliberately **not** through a property the SDK Provider leaves unhandled (the
[#614](https://github.com/go-to-k/cdkd/issues/614) auto-route). The fixture
used to do that (`DesiredShardLevelMetrics` on `AWS::Kinesis::Stream`,
`RuntimeManagementConfig` on `AWS::Lambda::Function`); both properties were
later wired into their providers, both resources silently landed on `sdk`, and
the run failed at its baseline. The two mechanisms used now depend on no
property-coverage table:

1. **A type with no SDK Provider** — `AWS::EventSchemas::Discoverer` is pure
   Cloud Control fallback on a plain fresh deploy. Only a newly registered SDK
   Provider for it changes that, and the baseline FAIL line says so and says
   what to swap. (The fixture used `AWS::Events::Archive` until
   [#6578](https://github.com/go-to-k/cdkd/issues/6578) gave it an SDK
   Provider.)
2. **The explicit `--recreate-via-cc-api` flag** — moves `CcLambda`, an
   SDK-registered type, onto Cloud Control in Phase 2.

## Fixture

One stack (`CdkdSdkCcApiCrossrefExample`), no VPC / NAT, deterministic
physical names. `CDKD_INTEG_PHASE` = `base` (default) | `seed`.

| Logical id           | Type                             | AWS name                        | Routing                       |
| -------------------- | -------------------------------- | ------------------------------- | ----------------------------- |
| `Discoverer`         | `AWS::EventSchemas::Discoverer`  | (none; found by its bus ARN)    | `cc-api` (no SDK Provider)    |
| `CcLambda`           | `AWS::Lambda::Function`          | `cdkd-crossref-fn`              | `sdk` -> `cc-api` in `seed`   |
| `ExecRole`           | `AWS::IAM::Role`                 | `cdkd-crossref-exec-role`       | `sdk`                         |
| `Bus`                | `AWS::Events::EventBus`          | `cdkd-crossref-bus`             | `sdk`                         |
| `DiscovererIdParam`  | `AWS::SSM::Parameter`            | `/cdkd/crossref/discoverer-id`  | `sdk`                         |
| `DiscovererArnParam` | `AWS::SSM::Parameter`            | `/cdkd/crossref/discoverer-arn` | `sdk`                         |
| `FnArnParam`         | `AWS::SSM::Parameter`            | `/cdkd/crossref/fn-arn`         | `sdk` (exists in `seed` only) |

### Cross-references (consumer -> producer)

| Id  | Direction | Reference                                                  |
| --- | --------- | ---------------------------------------------------------- |
| A   | SDK -> CC | `DiscovererIdParam.Value = Fn::GetAtt(Discoverer, 'DiscovererId')` |
| B   | SDK -> CC | `DiscovererArnParam.Value = Ref(Discoverer)` (its ARN)     |
| C   | CC -> SDK | `Discoverer.SourceArn = Fn::GetAtt(Bus, 'Arn')`            |
| D   | CC -> SDK | `Discoverer.Description` embeds `Ref(Bus)`                 |
| E   | CC -> SDK | `CcLambda.Role = Fn::GetAtt(ExecRole, 'Arn')` (`seed`)     |
| F   | SDK -> CC | `FnArnParam.Value = Fn::GetAtt(CcLambda, 'Arn')` (`seed`)  |

`Discoverer.DiscovererId` is a read-only attribute, so (A) only holds if the
Cloud Control read-back recorded it. `FnArnParam` is ADDED in `seed` so its create resolves
(F) against the record the Cloud Control create just wrote.

`RuntimeManagementConfig` toggles on `seed` as the AWS-side witness of the
recreate. It was also the property delta a recreate flag needed before
[#2651](https://github.com/go-to-k/cdkd/issues/2651) was fixed, when a flagged
resource whose diff was NO_CHANGE was never provisioned. Both layers handle the
property; it is not a routing trigger.

## Automated run (`verify.sh`)

Env: `AWS_REGION` (default `us-east-1`), `STATE_BUCKET` (required).

1. **Phase 1** — plain `cdkd deploy` (`base`). Assert from state, keyed on the
   AWS name (the bus ARN for the discoverer), that `Discoverer` is `cc-api` and everything else (including
   `CcLambda`) is `sdk`; assert cross-refs A-D on AWS.
2. **Phase 2** — `cdkd deploy --recreate-via-cc-api CcLambda` (`seed`). Assert
   `CcLambda` flipped to `cc-api` and was really recreated (`LastModified`
   changed, `UpdateRuntimeOn == FunctionUpdate` on AWS), the rest of the routing
   is unchanged, cross-refs E and F hold, and A-D still hold.
3. **Phase 3** — `cdkd destroy --force` (the Lambda and the discoverer leave
   through the Cloud Control delete path). Assert every named resource and the
   state file are gone, with not-found tri-state probes.

Every routing FAIL line names its likely cause and where to look. Teardown
sweeps every fixed physical name (consumers before producers) before dropping
state, and also sweeps the resources of the older fixture shapes (the Kinesis
stream, and the archive used before #6578).

The script is BSD/macOS-portable (no `grep -P`, no `date -d`) and prints
`[verify] PASS` only on full success.

## Local routing check (no AWS)

`cdkd synth` each phase and feed the synthesized resources to the real
`ProviderRegistry.getProviderFor` with every provider registered. Expected:
`base` -> `Discoverer` `cc-api`, the rest `sdk`; `seed` with `CcLambda` forced
-> `Discoverer` + `CcLambda` `cc-api`, the rest `sdk`.
