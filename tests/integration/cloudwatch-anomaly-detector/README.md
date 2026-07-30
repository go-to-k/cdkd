# cloudwatch-anomaly-detector

Integration test for issue [#1304](https://github.com/go-to-k/cdkd/issues/1304):
the `AWS::CloudWatch::AnomalyDetector` SDK provider.

The type is `NON_PROVISIONABLE` in the CloudFormation registry (no Cloud
Control handlers), so before the SDK provider cdkd's pre-flight rejected any
template declaring it. `PutAnomalyDetector` is an upsert keyed by the metric
descriptor; `DeleteAnomalyDetector` takes the same descriptor; there is no
server-generated identifier, so cdkd derives a deterministic physical id from
the descriptor.

## Phases

1. **Deploy**: SQS queue + a single-metric anomaly detection model on its
   `NumberOfMessagesSent` metric; assert `DescribeAnomalyDetectors` returns it.
2. **Update** (`CDKD_TEST_UPDATE=true`): add a `Configuration`
   (MetricTimeZone + ExcludedTimeRanges) — the only in-place-mutable property
   per the registry schema (all descriptor fields are createOnly and classify
   as replacement). Both values are asserted via readback. Casing trap: the
   CFn property is `MetricTimeZone` (capital Z) but the SDK / wire field is
   `MetricTimezone` (lowercase z) — the provider re-keys it, and passing the
   CFn key through verbatim is a client-side silent drop (found live
   2026-07-31 when the first integ run's readback came back empty).
3. **Destroy**: detector gone, queue gone, state file gone.

## Run

```bash
STATE_BUCKET=cdkd-state-<accountId> ./verify.sh
```
