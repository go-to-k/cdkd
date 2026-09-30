import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Nested-stack cross-region SECRET rollback-replay fixture — issue
 * [#4174](https://github.com/go-to-k/cdkd/issues/4174), the nested twin of
 * `rollback-cross-region-secret` (issue #2057).
 *
 * THE DEFECT. The PARENT reads the producer's redacted output across a region
 * boundary and passes the value into a nested stack as a Parameter. The child
 * records the parent's region-LESS `{{resolve:...}}` spelling
 * (`inheritedSecrets`), but its OWN `outputReads` never name the producer's
 * region. A rollback of the child classified the reference against the
 * child's reads alone, answered `local`, and resolved it against the
 * same-named secret in the CONSUMER's region — writing that value onto the
 * live parameter.
 *
 * TOPOLOGY (driven by verify.sh):
 *
 *   PRODUCER `CdkdRbNestedXregionProducer` in us-west-2
 *     - `ProducerProbe`, an ordinary SSM String parameter.
 *     - `CfnOutput` `SharedSecret`: the SecureString dynamic reference,
 *       persisted REDACTED (the expression) in the producer's state.
 *
 *   CONSUMER `CdkdRbNestedXregionConsumer` in us-east-1
 *     - Nested stack row `Child` (logical id pinned, so the child state key is
 *       `CdkdRbNestedXregionConsumer~Child`). Its `SharedValue` Parameter is
 *       `Fn::GetStackOutput` of the producer's `SharedSecret` with
 *       `Region: us-west-2` when `WITH_XREGION=true`, else a local literal.
 *     - In the child, `SecretEcho`: an SSM String parameter whose `Value` is
 *       `Ref SharedValue` and whose `Description` carries `MARKER_VALUE`, so a
 *       v1 -> v2 change is an UPDATE of this resource inside the child (and an
 *       UPDATE of the parent's `Child` row).
 *     - `FailingQueue` (only with `INJECT_FAIL=true`): an out-of-range
 *       `MessageRetentionPeriod`, depending on the `Child` row so the child's
 *       update completes first.
 *     - In the child, `ChildFailingQueue` (only with `INJECT_CHILD_FAIL=true`):
 *       the same injection INSIDE the child, depending on `SecretEcho`, so the
 *       child engine's own automatic rollback reverts the echo.
 *
 * WHAT THE ROLLBACK MUST DO. Refuse the child's replay of `SecretEcho` and
 * leave the live parameter holding the PRODUCER region's value. Pre-fix it
 * overwrites it with the CONSUMER region's secret.
 */

export const PRODUCER_STACK_NAME = 'CdkdRbNestedXregionProducer';
export const CONSUMER_STACK_NAME = 'CdkdRbNestedXregionConsumer';
export const PRODUCER_REGION = 'us-west-2';
export const CONSUMER_REGION = 'us-east-1';
export const PRODUCER_OUTPUT_NAME = 'SharedSecret';

/** Seeded out of band by verify.sh in BOTH regions, with DIFFERENT values. */
export const SHARED_SECURE_PARAM_NAME = '/cdkd/rollback-nested-xregion/shared-secret';
export const PRODUCER_PROBE_PARAM_NAME = '/cdkd/rollback-nested-xregion/producer-probe';
export const CHILD_ECHO_PARAM_NAME = '/cdkd/rollback-nested-xregion/echo';
/** The `SharedValue` Parameter with `WITH_XREGION` off: no cross-stack read. */
export const LOCAL_LITERAL_VALUE = 'local-literal-no-cross-region-read';
/** The child's injected failing queue (ARM C); never created. */
export const CHILD_FAILING_QUEUE_PREFIX = 'CdkdRbNestedXregionChildFailing';
/** The dynamic reference itself — region-LESS, which is the whole point. */
export const SHARED_SECRET_EXPRESSION = `{{resolve:ssm:${SHARED_SECURE_PARAM_NAME}}}`;

export class RbNestedXregionProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    cdk.Tags.of(this).add('cdkd:integ-fixture', 'rollback-nested-cross-region-secret');

    new ssm.StringParameter(this, 'ProducerProbe', {
      parameterName: PRODUCER_PROBE_PARAM_NAME,
      stringValue: 'producer-probe (rollback nested cross-region secret fixture)',
      description: 'Created by tests/integration/rollback-nested-cross-region-secret (producer)',
    });

    new cdk.CfnOutput(this, PRODUCER_OUTPUT_NAME, {
      value: SHARED_SECRET_EXPRESSION,
      description:
        'SecureString dynamic reference, resolved in the producer region and consumed cross-region',
    });
  }
}

class ChildNestedStack extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pin the row's logical id so the child state key is `<Parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const shared = new cdk.CfnParameter(this, 'SharedValue', { type: 'String' });
    const markerValue = process.env.MARKER_VALUE ?? 'v1';

    // L1 so the logical id is exactly `SecretEcho`.
    const echo = new ssm.CfnParameter(this, 'SecretEcho', {
      type: 'String',
      name: CHILD_ECHO_PARAM_NAME,
      value: shared.valueAsString,
      // The v1 -> v2 delta: an UPDATE of THIS resource puts a revert op whose
      // previous Value is the region-less expression into the child's journal.
      description: `nested cross-region secret echo (${markerValue})`,
    });

    // ARM C: a failure INSIDE the child, after its echo UPDATE, so the CHILD
    // engine's own in-process rollback reverts the echo (not the parent's
    // journal replay of the row).
    if (process.env.INJECT_CHILD_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'ChildFailingQueue', {
        queueName: `${CHILD_FAILING_QUEUE_PREFIX}-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(echo);
    }
  }
}

export class RbNestedXregionConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // No stack-wide `cdk.Tags` aspect: it would tag the nested-stack row too,
    // and cdkd refuses `AWS::CloudFormation::Stack` `Tags` as CFn-only.
    const child = new ChildNestedStack(this, 'Child', {
      parameters: { SharedValue: LOCAL_LITERAL_VALUE },
    });

    // `Fn::GetStackOutput` has no typed helper in aws-cdk-lib, so it is
    // injected as an override of the row's Parameters, as the sibling fixture
    // does for a resource property.
    if (process.env.WITH_XREGION === 'true') {
      (child.nestedStackResource as cdk.CfnResource).addPropertyOverride(
        'Parameters.SharedValue',
        {
          'Fn::GetStackOutput': {
            StackName: PRODUCER_STACK_NAME,
            OutputName: PRODUCER_OUTPUT_NAME,
            Region: PRODUCER_REGION,
          },
        }
      );
    }

    if (process.env.INJECT_FAIL === 'true') {
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: `${this.stackName}-failing-queue`,
        messageRetentionPeriod: 9999999,
      });
      failing.node.addDependency(child.nestedStackResource!);
    }
  }
}
