# stale-attribute-heal

Integration test for issue
[#1852](https://github.com/go-to-k/cdkd/issues/1852): a state record written
before its provider recorded an attribute is healed by the deploy that first
needs it.

`AWS::SSM::Parameter.Arn` has been recorded since issue #1824. A parameter an
older binary deployed holds `attributes: {Type, Value}` and no `Arn`, and adding
an output that reads `param.attrArn` changes no resource property — so the
no-change skip never re-ran the provider, the record never gained the key, and
the deploy hit the resolver's `*Arn` shape refusal on every run.

## Stack

`CdkdStaleAttributeHealExample`:

- `Param` — one L1 `AWS::SSM::Parameter` (`/cdkd-test/stale-attribute-heal/param`).
  An L1 on purpose: the L2's `parameterArn` is an `Fn::Join` over the name and
  never asks cdkd for the `Arn` attribute.
- `ParamArn` — an output reading `Fn::GetAtt [Param, Arn]`, declared only under
  `CDKD_TEST_UPDATE=true`. It is the ONLY difference between the two templates.

## What `verify.sh` asserts

1. v1 deploys, and this binary records the `Arn` AWS reports.
2. `attributes.Arn` is stripped from the state record out of band (the
   pre-#1824 record), and the strip is read back before anything else runs.
3. `cdkd diff` of v2 writes no state: the state object's `VersionId` + `ETag`
   are unchanged and the record still lacks `Arn`.
4. The v2 deploy exits 0 on the no-change path; the output equals the ARN AWS
   reports; the record holds `attributes.Arn` again beside its other attributes;
   `properties` / `physicalId` are untouched; the parameter's `Version` and
   `LastModifiedDate` equal the values captured before (it was not updated).
5. A second no-change deploy writes nothing more — the heal persisted.
6. Destroy; the parameter and the state file are gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 \
  tests/integration/stale-attribute-heal/verify.sh
```

Through `/run-integ stale-attribute-heal` in an agent session.
