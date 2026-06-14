# Cross-region `Fn::GetStackOutput` Example

This integ test exercises cdkd's UNIQUE same-account / **cross-region**
`Fn::GetStackOutput` intrinsic: a CONSUMER stack deployed in one region
reads a PRODUCER stack's output from ANOTHER region.

CloudFormation `Fn::ImportValue` Exports are region-scoped — you cannot
import an Export across regions. cdkd's `Fn::GetStackOutput` sidesteps
that because cdkd reads the producer's output directly from its S3 state
record, and the cdkd state bucket is **account-scoped** (not
region-scoped). The consumer's resolver reads
`cdkd/{Producer}/{producerRegion}/state.json` from the same bucket its
own state lives in, so a different deploy region just changes which
region-prefixed key the resolver reads.

## Architecture

Two stacks in one CDK app, pinned to different regions via `env.region`:

1. **CdkdGsoProducer** (region X — `us-west-2`)
   - An SSM `StringParameter`.
   - Exports the parameter ARN via `CfnOutput` `ProducerArn`. The ARN
     embeds the `us-west-2` region segment, so a wrong-region read is
     detectable.

2. **CdkdGsoConsumer** (region Y — `us-east-1`)
   - An SSM parameter whose `Value` is set (via `addPropertyOverride`,
     because `aws-cdk-lib` ships no typed helper) to:

     ```json
     {
       "Fn::GetStackOutput": {
         "StackName": "CdkdGsoProducer",
         "OutputName": "ProducerArn",
         "Region": "us-west-2"
       }
     }
     ```

   - The explicit `Region` argument is what makes this a cross-region
     read. cdkd resolves it from the producer's region-`us-west-2`
     state record in the account-scoped bucket.

`Fn::GetStackOutput` is a **weak** reference, so the producer is
deletable independently of the consumer; the test destroys the consumer
first anyway to mirror the recommended real-world order.

## What `verify.sh` asserts

1. Deploy PRODUCER in `us-west-2`; assert its state lands at
   `cdkd/CdkdGsoProducer/us-west-2/state.json` and its `ProducerArn`
   output ARN names `us-west-2`.
2. Deploy CONSUMER in `us-east-1`; assert its state lands at
   `cdkd/CdkdGsoConsumer/us-east-1/state.json`. (A failed cross-region
   read fails the deploy here with "stack not found in region
   'us-west-2'".)
3. Assert the consumer's SSM parameter on AWS (in `us-east-1`) holds the
   producer's **real** ARN value (from `us-west-2`) — proving the
   cross-region read both worked and resolved the **correct** value. A
   second check confirms the resolved value names the PRODUCER's region,
   not the consumer's (guards against a silent same-region fallback).
4. Destroy consumer (`us-east-1`) then producer (`us-west-2`); assert
   both AWS resources AND both region-prefixed state files are gone.

The cleanup trap drops both regions' SSM parameters and both
region-prefixed `state.json` / `lock.json` sidecars from the
account-scoped bucket, so a failed run leaves nothing behind in either
region.

## Run

```bash
cd "$(git rev-parse --show-toplevel)"
vp run build
STATE_BUCKET="cdkd-state-<accountId>" bash tests/integration/getstackoutput-crossregion/verify.sh
```

Prefer the `/run-integ getstackoutput-crossregion` skill — it records
the run into the integ ledger and runs the post-run orphan sweep.
