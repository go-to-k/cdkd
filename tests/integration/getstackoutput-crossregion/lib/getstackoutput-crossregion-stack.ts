import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sqs from 'aws-cdk-lib/aws-sqs';
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

/**
 * go-to-k/cdkd#4847 arm. Secrets Manager secrets verify.sh seeds BEFORE any
 * deploy, under the SAME name in both regions with DIFFERENT values (the
 * us-west-2 one names the queue; a us-east-1 answer would name another):
 *
 * - `cdkd-gso-4847-<suffix>`: the main arm's queue (CdkdGsoConsumer);
 * - `cdkd-gso-4847-pre-<suffix>`: a queue deployed by the last v11 binary;
 * - `cdkd-gso-4847-rot-<suffix>`: the same, rotated BEFORE the upgrade.
 *
 * The producer publishes each as a `{{resolve:...}}` output, which cdkd
 * stores as the reference (#1899); a consumer in us-east-1 names a queue from
 * it through `Fn::GetStackOutput` with `Region: us-west-2`, so the queue's
 * record holds `arn:aws:sqs:us-east-1:<acct>:{{resolve:...}}`. The suffix (a
 * context value verify.sh passes) keeps every run's queue names unique.
 */
export function gso4847SecretNames(scope: Construct): {
  main: string;
  pre: string;
  rot: string;
  iam: string;
} {
  const suffix = (scope.node.tryGetContext('gso4847Suffix') as string | undefined) ?? 'local';
  return {
    main: `cdkd-gso-4847-${suffix}`,
    pre: `cdkd-gso-4847-pre-${suffix}`,
    rot: `cdkd-gso-4847-rot-${suffix}`,
    // go-to-k/cdkd#4879: a ROLE name (`{"role": ...}`), same-name-two-values too.
    iam: `cdkd-gso-4847-iam-${suffix}`,
  };
}

/** go-to-k/cdkd#4879: the inline policy `CdkdGsoConsumer4879` puts on that role. */
export const GSO_4879_POLICY_NAME = 'cdkd-gso-4879-inline';
const queueNameRef = (secretName: string): string =>
  `{{resolve:secretsmanager:${secretName}:SecretString:queue}}`;

/** A queue named from a us-west-2 output of `CdkdGsoProducer`, read cross-region. */
function queueNamedFromProducer(scope: Construct, id: string, outputName: string): sqs.CfnQueue {
  const queue = new sqs.CfnQueue(scope, id);
  queue.addPropertyOverride('QueueName', {
    'Fn::GetStackOutput': {
      StackName: PRODUCER_STACK_NAME,
      OutputName: outputName,
      Region: PRODUCER_REGION,
    },
  });
  return queue;
}

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

    // go-to-k/cdkd#4847: secret-derived queue names, published as references.
    const names = gso4847SecretNames(this);
    new cdk.CfnOutput(this, 'QueueName', { value: queueNameRef(names.main) });
    new cdk.CfnOutput(this, 'QueueNamePre', { value: queueNameRef(names.pre) });
    new cdk.CfnOutput(this, 'QueueNameRot', { value: queueNameRef(names.rot) });
    new cdk.CfnOutput(this, 'RoleName4879', {
      value: `{{resolve:secretsmanager:${names.iam}:SecretString:role}}`,
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

    // go-to-k/cdkd#4847 main arm. `Queue` is deployed with the stack; the
    // reader of its `Arn` arrives in a LATER deploy, so it reads the queue's
    // RECORDED attribute while the queue is NO_CHANGE. `gso4847Reader` is the
    // reader's revision (absent: no reader); `gso4847Fail` adds a parameter
    // AWS refuses, created after the reader, for the rollback phase.
    const queue = queueNamedFromProducer(this, 'Queue', 'QueueName');
    const revision = this.node.tryGetContext('gso4847Reader') as string | undefined;
    if (revision !== undefined) {
      const reader = new ssm.CfnParameter(this, 'QueueArnReader', {
        type: 'String',
        name: '/cdkd/getstackoutput-crossregion/reader',
        value: queue.attrArn,
        description: `reader rev ${revision}`,
      });
      if (this.node.tryGetContext('gso4847Fail') === '1') {
        const failing = new ssm.CfnParameter(this, 'FailProbe', {
          type: 'String',
          name: '/cdkd/getstackoutput-crossregion/fail-probe',
          value: 'does-not-match',
          allowedPattern: '^never$',
        });
        failing.addDependency(reader);
      }
    }
  }
}

/**
 * go-to-k/cdkd#4847 pre-upgrade arm (us-east-1): two queues first deployed by
 * the last v11 binary, so their records carry no provenance until the first
 * v12 deploy's one-time capture writes it. `QueueRotated`'s secret is rotated
 * BEFORE the upgrade, so the capture records its region and no version.
 * `gso4847PreReaders` adds the readers in a later deploy: a parameter holding
 * `QueueStill`'s `Arn`, and an output holding `QueueRotated`'s (an output is
 * never sent to AWS, so a value served as recorded fails nothing).
 */
export class GsoConsumerPreStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const still = queueNamedFromProducer(this, 'QueueStill', 'QueueNamePre');
    const rotated = queueNamedFromProducer(this, 'QueueRotated', 'QueueNameRot');
    if (this.node.tryGetContext('gso4847PreReaders') === '1') {
      new ssm.CfnParameter(this, 'QueueStillReader', {
        type: 'String',
        name: '/cdkd/getstackoutput-crossregion/reader-pre',
        value: still.attrArn,
      });
      new cdk.CfnOutput(this, 'RotatedArn', { value: rotated.attrArn });
    }
  }
}

/**
 * go-to-k/cdkd#4879 arm (us-east-1): an inline `AWS::IAM::Policy` whose
 * `Roles` names a role through the producer's `RoleName4879` output, read
 * with `Region: us-west-2`. Its record holds the region-less
 * `{{resolve:...}}` reference, and the stack reads another region, so a
 * destroy without the v12 recorded region skips it as ambiguous (exit 2, the
 * policy left on the role). Its own stack, so the main consumer's drift and
 * scrub phases are unchanged.
 */
export class GsoConsumer4879Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const policy = new iam.CfnPolicy(this, 'Policy4879', {
      policyName: GSO_4879_POLICY_NAME,
      policyDocument: {
        Version: '2012-10-17',
        Statement: [{ Effect: 'Allow', Action: 'logs:DescribeLogGroups', Resource: '*' }],
      },
    });
    policy.addPropertyOverride('Roles', [
      {
        'Fn::GetStackOutput': {
          StackName: PRODUCER_STACK_NAME,
          OutputName: 'RoleName4879',
          Region: PRODUCER_REGION,
        },
      },
    ]);
  }
}
