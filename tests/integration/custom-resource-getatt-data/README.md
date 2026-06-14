# Custom Resource `Data` GetAtt -> dependent property (failure-seeking)

Surfaces bugs where a Custom Resource's response `Data` — consumed by
`Fn::GetAtt(CustomResource, '<key>')` (a.k.a. `Data.<key>`) — must flow into
ANOTHER resource's property. The CR response-`Data` attribute path is fragile
(issues [#756](https://github.com/go-to-k/cdkd/issues/756) /
[#804](https://github.com/go-to-k/cdkd/issues/804)) because CR attributes only
exist AFTER the CR's backing Lambda runs and returns a SUCCESS response.

## What it tests

- An inline Lambda-backed `AWS::CloudFormation::CustomResource` whose handler
  returns `Data: { ComputedValue, Another, NumericValue }` directly in its
  response payload.
- Three `AWS::SSM::Parameter` dependents whose `Value` is
  `Fn::GetAtt(MyCustomResource, '<key>')` — one per Data key. Multiple keys
  catch a resolver that only wires the first attribute; the stringified-number
  key catches a resolver that mishandles non-text Data.
- An explicit `addDependency(cr)` on one parameter, so the DAG ordering
  (CR must complete and have its `attributes` populated BEFORE the dependent
  is provisioned) is exercised.

No VPC. No Provider framework (the simple synchronous direct-payload-return
path — the cheapest way to surface a GetAtt-of-CR-Data resolution bug).

## Architecture

```
MyCustomResource (inline Lambda; returns Data: {ComputedValue, Another, NumericValue})
    |
    +--> SSM Parameter .../computed   Value = Fn::GetAtt(CR, 'ComputedValue')
    +--> SSM Parameter .../another    Value = Fn::GetAtt(CR, 'Another')
    +--> SSM Parameter .../numeric    Value = Fn::GetAtt(CR, 'NumericValue')
```

## verify.sh

Deploys, then reads each SSM parameter back from AWS with
`aws ssm get-parameter` and asserts its `Value` equals the value the CR
handler returned (`computed-integ` / `another-<region>` / `42`). This proves
the CR `Data` attribute resolved THROUGH the intrinsic resolver INTO the
dependent resource's property — a blank / wrong value would otherwise pass
unnoticed because nothing else reads it. Then destroys and asserts the state
file, both SSM parameters, and the backing Lambda are gone.

## Deploy / Destroy

```bash
cdkd deploy CdkdCrGetAttDataExample
cdkd destroy CdkdCrGetAttDataExample
```
