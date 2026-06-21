# DynamoDB Stream -> Lambda with FilterCriteria

A DynamoDB stream consumed by a Lambda via `DynamoEventSource` with `filters`,
`bisectBatchOnError` and `reportBatchItemFailures` — a daily CDK pattern. The
synthesized `AWS::Lambda::EventSourceMapping` carries `FilterCriteria`,
`BisectBatchOnFunctionError` and `FunctionResponseTypes`, which cdkd must forward
to `CreateEventSourceMapping`.

## What it verifies

1. **ESM properties reached AWS**: `get-event-source-mapping` returns a
   `FilterCriteria` pattern of `{eventName:["INSERT"]}`,
   `BisectBatchOnFunctionError == true`, and
   `FunctionResponseTypes == ["ReportBatchItemFailures"]`.
2. **Clean destroy**: the table, the ESM and cdkd state are gone afterward.

## Run

```bash
AWS_REGION=us-east-1 STATE_BUCKET=cdkd-state-<accountId> bash verify.sh
```
