# import-heal-prefix-record

The last row of issue [#3627](https://github.com/go-to-k/cdkd/issues/3627):
`cdkd deploy` heals `Fn::GetAtt` attributes missing from a record that an
**older** cdkd imported.

These resolver arms answered without reaching the #1852 heal:

- DynamoDB `StreamArn` and IAM Role `RoleId` returned `undefined`;
- IAM Role / User `Arn` built a path-less ARN.

A record imported before the `import()` read-backs therefore stayed wrong on
every deploy.

## Flow

1. `cdk deploy`. CloudFormation's resolved `Fn::GetAtt` values, written into
   the SSM parameters, are the oracle.
2. `cdkd import --migrate-from-cloudformation` with **cdkd 0.291.13**. The run
   asserts the imported records are wrong, so a heal is observable at all.
3. `cdkd deploy` with this checkout. Every parameter record and its live value
   must equal the oracle.
4. A second deploy changes nothing. Then a destroy with gone-probes.

## Run

```bash
STATE_BUCKET=<your-cdkd-state-bucket> ./verify.sh
```
