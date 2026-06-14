import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Cross-region `Fn::GetStackOutput` failure-seeking integ fixture.
 *
 * Exercises cdkd's UNIQUE same-account / CROSS-REGION `Fn::GetStackOutput`
 * intrinsic: a CONSUMER stack deployed in one region reads a PRODUCER
 * stack's output from ANOTHER region. The architecture doc claims this
 * works out of the box because cdkd's state bucket is account-scoped
 * (not region-scoped), so the consumer's resolver can read the
 * producer's `cdkd/{Producer}/{producerRegion}/state.json` record even
 * though the consumer itself deploys to a different region. That path
 * is likely under-tested — this fixture is the real-AWS regression net
 * for it.
 *
 * Topology (driven by verify.sh):
 *
 *   1. Deploy PRODUCER (CdkdGsoProducer) in region X (us-west-2) — an
 *      SSM parameter whose ARN is exported via CfnOutput `ProducerArn`.
 *      Writes `cdkd/CdkdGsoProducer/us-west-2/state.json`.
 *
 *   2. Deploy CONSUMER (CdkdGsoConsumer) in region Y (us-east-1) — an
 *      SSM parameter whose Value is `Fn::GetStackOutput` of the
 *      producer's `ProducerArn` output WITH an explicit
 *      `Region: us-west-2` argument. The cross-region read must
 *      resolve the producer's real output value from the
 *      account-scoped state bucket. Writes
 *      `cdkd/CdkdGsoConsumer/us-east-1/state.json`.
 *
 *   3. verify.sh asserts the consumer's SSM parameter on AWS (in
 *      us-east-1) carries the producer's REAL ARN value (which itself
 *      names us-west-2) — proving the cross-region read worked and
 *      resolved the correct value.
 *
 *   4. Destroy consumer first, then producer; assert both AWS resources
 *      AND both region-prefixed state files are gone.
 *
 * `Fn::GetStackOutput` is a WEAK reference, so destroy order does not
 * strictly matter (the producer is deletable independently of the
 * consumer); verify.sh destroys consumer-first anyway to mirror the
 * recommended real-world order.
 *
 * SSM Parameter is the cheapest, fastest cdkd-supported resource — one
 * synchronous API call to create + delete, no eventual-consistency
 * window, no IAM dependencies, no VPC. Same skeleton as
 * `tests/integration/schema-v7-to-v8-migration` (consistent integ
 * shape for every `Fn::GetStackOutput` variant).
 */

export const PRODUCER_STACK_NAME = 'CdkdGsoProducer';
export const PRODUCER_REGION = 'us-west-2';
export const CONSUMER_REGION = 'us-east-1';
export const PRODUCER_OUTPUT_NAME = 'ProducerArn';
const PRODUCER_PARAM_NAME = '/cdkd/getstackoutput-crossregion/producer';
const CONSUMER_PARAM_NAME = '/cdkd/getstackoutput-crossregion/consumer';

export class GsoProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const producer = new ssm.StringParameter(this, 'ProducerProbe', {
      parameterName: PRODUCER_PARAM_NAME,
      stringValue: 'producer-value (cross-region gso fixture)',
      description: 'Created by tests/integration/getstackoutput-crossregion (producer, us-west-2)',
    });

    // Exported via CfnOutput so the consumer (in another region) can
    // read it via Fn::GetStackOutput. The OutputName is the
    // CloudFormation logical id of the CfnOutput, NOT an Export.Name —
    // Fn::GetStackOutput reads cdkd's S3 state directly, no CFn Export
    // is required (and CFn Exports are region-scoped anyway, which is
    // exactly the limitation this cdkd-specific intrinsic sidesteps).
    //
    // The ARN value itself embeds the producer's region (us-west-2), so
    // a wrong-region read would resolve a value with the wrong region
    // segment (or no value at all) and verify.sh would catch it.
    new cdk.CfnOutput(this, PRODUCER_OUTPUT_NAME, {
      value: producer.parameterArn,
      description: 'ARN of the producer SSM parameter — consumed cross-region via Fn::GetStackOutput',
    });
  }
}

export class GsoConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Fn::GetStackOutput is injected via addPropertyOverride because
    // aws-cdk-lib does not ship a typed helper for the intrinsic; the
    // synthesized template ends up identical (matches the
    // cross-stack-references / schema-v7-to-v8-migration fixtures'
    // pattern).
    const consumer = new ssm.CfnParameter(this, 'ConsumerProbe', {
      type: 'String',
      name: CONSUMER_PARAM_NAME,
      value: 'placeholder-replaced-at-deploy-time',
      description: "Consumer probe — reads producer's ARN cross-region via Fn::GetStackOutput",
    });

    // The load-bearing line: the consumer (us-east-1) reads the
    // producer's output FROM us-west-2 by passing an explicit `Region`
    // argument. Same-account cross-region works because cdkd's state
    // bucket is account-scoped — the resolver reads
    // `cdkd/CdkdGsoProducer/us-west-2/state.json` from the same bucket
    // the consumer's own state lives in.
    consumer.addPropertyOverride('Value', {
      'Fn::GetStackOutput': {
        StackName: PRODUCER_STACK_NAME,
        OutputName: PRODUCER_OUTPUT_NAME,
        Region: PRODUCER_REGION,
      },
    });
  }
}
