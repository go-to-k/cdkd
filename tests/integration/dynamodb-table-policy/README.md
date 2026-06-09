# DynamoDB Table policy / Kinesis / Contributor Insights backfill (#609)

Integ probe for the three silent-drop `AWS::DynamoDB::Table` properties wired
into `DynamoDBTableProvider` by the issue #609 backfill slice:

- **`ResourcePolicy`** — rides on `CreateTable` (the SDK takes the policy
  document as a JSON string); managed on update via
  `PutResourcePolicy` / `DeleteResourcePolicy`; read back via
  `GetResourcePolicy`.
- **`KinesisStreamSpecification`** — a post-ACTIVE control-plane call
  (`EnableKinesisStreamingDestination` / `DisableKinesisStreamingDestination`,
  NOT a field on `CreateTable`); read back via
  `DescribeKinesisStreamingDestination`.
- **`ContributorInsightsSpecification`** — a post-ACTIVE control-plane call
  (`UpdateContributorInsights`); read back via `DescribeContributorInsights`.

The 4th #609 property, `ImportSourceSpecification`, is declared
`unhandledByDesign` (S3 import uses the separate `ImportTable` API, not
`CreateTable`, and is create-only with no readback) so it is intentionally
not exercised here.

## Resources

- **Kinesis Stream** (`cdkd-table-policy-test-stream`) — the streaming target.
- **DynamoDB Table** (`cdkd-table-policy-test-table`) — PAY_PER_REQUEST, with
  `kinesisStream`, `contributorInsightsSpecification`, and a
  `resourcePolicy` (added via `addToResourcePolicy`).

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> AWS_REGION=us-east-1 bash verify.sh
```

`verify.sh` deploys, asserts each property reached AWS, then destroys and
verifies the table + stream + state are gone.
