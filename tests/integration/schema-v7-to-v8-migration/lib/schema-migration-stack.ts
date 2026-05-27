import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Schema v7 → v8 migration integ fixture (issue #668). Two-stack
 * producer + consumer pair so that the v8 binary's deploy actually
 * resolves an `Fn::GetStackOutput` reference and pushes a
 * `StateOutputReadEntry` into the consumer's `state.outputReads[]`
 * field — the load-bearing v8 schema change.
 *
 * Round-trip the verify.sh exercises:
 *
 *   1. Deploy Producer + Consumer under the latest v7 cdkd binary so
 *      AWS has real resources AND both stacks' state files are
 *      `version: 7`. The Consumer's state has NO `outputReads` field
 *      (v7 doesn't know about it).
 *
 *   2. v8 binary's `state show` reads both v7 state files cleanly.
 *
 *   3. Re-deploy the Consumer under the local v8 binary (Phase env
 *      var bumps the description so cdkd doesn't short-circuit with
 *      "No changes detected"). The v8 writer must:
 *        - upgrade the consumer state to `version: 8`
 *        - populate `state.outputReads[]` with the producer/output ref
 *
 *   4. Destroy both stacks under the v8 binary. State + AWS resources
 *      both gone.
 *
 * SSM Parameter is the cheapest, fastest cdkd-supported resource —
 * one synchronous API call to create + delete, no eventual-consistency
 * window, no IAM dependencies. Same shape as
 * `tests/integration/schema-v6-to-v7-migration` (consistent integ
 * skeleton for every schema bump).
 */

const PRODUCER_STACK_NAME = 'CdkdSchemaV7ToV8MigrationProducer';
const PRODUCER_PARAM_NAME = '/cdkd/schema-v7-to-v8-migration/producer';
const CONSUMER_PARAM_NAME = '/cdkd/schema-v7-to-v8-migration/consumer';

export class SchemaMigrationProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'v7';

    const producer = new ssm.StringParameter(this, 'ProducerProbe', {
      parameterName: PRODUCER_PARAM_NAME,
      stringValue: `producer-value-v8-fixture (phase=${phase})`,
      description: 'Created by tests/integration/schema-v7-to-v8-migration (producer)',
    });

    // Exported via CfnOutput so the consumer can read it via
    // Fn::GetStackOutput. The OutputName is the CloudFormation logical
    // id of the CfnOutput, NOT an Export.Name (Fn::GetStackOutput
    // reads cdkd's S3 state directly, no CFn Export is required).
    new cdk.CfnOutput(this, 'ProducerArn', {
      value: producer.parameterArn,
      description: 'ARN of the producer SSM parameter — consumed via Fn::GetStackOutput',
    });
  }
}

export class SchemaMigrationConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `CDKD_TEST_SCHEMA_PHASE` lets verify.sh toggle the consumer's
    // description between Phase 1 (deploy with v7 binary) and Phase 3
    // (re-deploy with v8 binary) so the v8 deploy ACTUALLY writes
    // state. Without a real change, cdkd short-circuits with
    // "No changes detected. Stack is up to date." and skips the
    // state write entirely — leaving the on-disk version at 7 and
    // breaking the transparent-auto-migration assertion.
    const phase = process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'v7';

    // Fn::GetStackOutput is injected via addPropertyOverride because
    // the aws-cdk-lib version pinned for this integ does not ship a
    // typed helper for the intrinsic; the synthesized template ends
    // up identical (matches the cross-stack-references fixture's
    // pattern).
    const consumer = new ssm.CfnParameter(this, 'ConsumerProbe', {
      type: 'String',
      name: CONSUMER_PARAM_NAME,
      value: 'placeholder-replaced-at-deploy-time',
      description: `Consumer probe — reads producer's ARN via Fn::GetStackOutput (phase=${phase})`,
    });
    consumer.addPropertyOverride('Value', {
      'Fn::GetStackOutput': {
        StackName: PRODUCER_STACK_NAME,
        OutputName: 'ProducerArn',
      },
    });
  }
}
