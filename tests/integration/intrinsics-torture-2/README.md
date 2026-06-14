# Intrinsics Torture Test #2

A second torture fixture for cdkd's CloudFormation intrinsic-function resolver
(`src/deployment/intrinsic-function-resolver.ts`). The sibling
`intrinsic-functions` / `intrinsics-torture` fixtures cover the common shapes;
the first torture run surfaced bug **#838** (`Fn::Join` over a list-returning
intrinsic crashed). This fixture goes after the NEXT tier — the harder /
less-common arg shapes that siblings likely lurk in.

Each torture intrinsic feeds a real `AWS::SSM::Parameter.Value`, written via
the raw L1 `ssm.CfnParameter` + `addPropertyOverride('Value', <intrinsic>)`
escape hatch so the synthesized template carries the **literal** intrinsic
(not a value CDK pre-folded at synth time). `verify.sh` deploys, reads each
parameter back via `aws ssm get-parameter`, and asserts it equals the concrete
value computed in-script from account/region. A wrong/failed resolution FAILS
the run naming the offending intrinsic.

## Intrinsic arg-shapes exercised

| SSM parameter         | Intrinsic shape                                                          | Expected value                          |
| --------------------- | ------------------------------------------------------------------------ | --------------------------------------- |
| `select-getazs`       | `Fn::Select[1, Fn::GetAZs('')]`                                          | 2nd sorted available AZ of the region   |
| `select-split`        | `Fn::Select[0, Fn::Split(',', {Ref: CsvParam})]`                         | `alpha`                                 |
| `findinmap-refkey`    | `Fn::FindInMap[RegionMap, {Ref: AWS::Region}, theKey]`                   | `nvirginia-hit` (in `us-east-1`)        |
| `findinmap-default`   | `Fn::FindInMap[RegionMap, 'eu-west-3', theKey, {DefaultValue: '...'}]`   | `fallback-value` (4th-arg default)      |
| `getatt-refattr`      | `Fn::GetAtt[Topic, {Ref: AttrNameParam='TopicArn'}]`                     | the SNS topic ARN                       |
| `sub-escape`          | `Fn::Sub 'before-${!NotAVar}-after'`                                     | `before-${NotAVar}-after` (escape)      |
| `base64-intrinsic`    | `Fn::Base64[{Ref: Base64SourceParam}]`                                   | base64 of `cdkd-base64-source`          |
| `nested-if-sub-join`  | `Fn::Join['-', ['head', Fn::Sub('seg-${V}'), Fn::If[Cond,'yes','no']]]`  | `head-seg-mid-yes`                      |
| `cidr-ipv6`           | `Fn::Select[0, Fn::Cidr['2001:db8::/56', 4, 64]]`                        | `2001:db8:0:0:0:0:0:0/64`               |
| `cidr-ipv4`           | `Fn::Select[2, Fn::Cidr['10.0.0.0/24', 4, 4]]`                           | `10.0.0.32/28`                          |

## Skipped on purpose

- **`Fn::ImportValue` with `Fn::Sub` export name** — requires a sibling
  producer stack/export, which would make this a multi-stack fixture. Out of
  scope for this single-stack torture fixture; covered conceptually by
  `import-value-strong-ref`.
- **`Fn::Cidr` IPv6 is INCLUDED** (the resolver supports IPv6 — see
  `resolveCidr`'s `isIpv6` branch), so the "IPv4-only fallback" alternative was
  not needed. A 2nd IPv4 edge (`cidr-ipv4`, different `cidrBits`) is included
  alongside it.

## Resources

- 1 `AWS::SNS::Topic` (the only real dependency, for the `Fn::GetAtt` case)
- 10 `AWS::SSM::Parameter` (String) — one per torture intrinsic

No VPC, no Lambda, no IAM beyond what SNS implies — cheap and fast.

## Run

```bash
/run-integ intrinsics-torture-2
# or:
bash tests/integration/intrinsics-torture-2/verify.sh
```

`verify.sh` deploys, asserts every value, destroys, and verifies cdkd state +
all SSM parameters are gone (no orphans). If deploy fails — the likely outcome
when a real resolver bug is hit — it prints triage context (cdkd state + the
synth template's intrinsic blocks) before exiting non-zero.
