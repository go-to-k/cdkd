import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Schema v8 → v9 migration integ fixture (issue #2193). THREE stacks, because
 * the v9 field exists to settle a three-party question — "which stack does
 * this export name belong to?" — that v8 state could not answer:
 *
 *   - Producer EXPORTS `SHARED_NAME` (its own output is called `ProducerArn`;
 *     the export alias is what lands under `SHARED_NAME` in `state.outputs`).
 *   - Decoy declares a PLAIN output whose NAME is `SHARED_NAME` — no
 *     `Export` — holding a different value. Under v8 that plain name was
 *     indexed as an export, and as the LAST writer it shadowed the Producer.
 *   - Consumer reads `Fn::ImportValue SHARED_NAME` into an SSM parameter, so
 *     the value it received is observable in AWS.
 *
 * Round-trip the verify.sh exercises:
 *
 *   1. Deploy Producer, then Decoy, then Consumer under the last v8 cdkd
 *      binary. The Consumer's parameter holds the DECOY's value — the bug,
 *      reproduced on real AWS. All three state files are `version: 8` with
 *      no `exportNames`.
 *
 *   2. The v9 binary's `state show` reads the v8 state files cleanly, and
 *      reading alone does not rewrite them.
 *
 *   3. Re-deploy Producer, Decoy, then Consumer under the local v9 binary
 *      (the phase env var bumps a description so each deploy actually
 *      writes). The v9 writer must:
 *        - upgrade each state to `version: 9`
 *        - write `exportNames: [SHARED_NAME]` on the Producer and
 *          `exportNames: []` on the Decoy (written, not omitted)
 *        - rebind the Consumer to the PRODUCER's value
 *
 *   4. Destroy all three under the v9 binary. State + AWS resources gone.
 *
 * SSM Parameter is the cheapest, fastest cdkd-supported resource — one
 * synchronous API call to create + delete, no eventual-consistency window.
 * Same skeleton as `tests/integration/schema-v7-to-v8-migration`.
 */

export const SHARED_NAME = 'CdkdSchemaV8ToV9SharedName';
export const PRODUCER_PARAM_NAME = '/cdkd/schema-v8-to-v9-migration/producer';
export const DECOY_PARAM_NAME = '/cdkd/schema-v8-to-v9-migration/decoy';
export const CONSUMER_PARAM_NAME = '/cdkd/schema-v8-to-v9-migration/consumer';

function phase(): string {
  return process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'v8';
}

export class SchemaMigrationProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const producer = new ssm.StringParameter(this, 'ProducerProbe', {
      parameterName: PRODUCER_PARAM_NAME,
      stringValue: `producer-value (phase=${phase()})`,
      description: `Created by tests/integration/schema-v8-to-v9-migration (producer, phase=${phase()})`,
    });

    // The EXPORT. The output's own name (`ProducerArn`) is deliberately NOT
    // the shared name — the alias is what carries `SHARED_NAME`, so the
    // fixture discriminates "export alias" from "plain output name".
    new cdk.CfnOutput(this, 'ProducerArn', {
      value: producer.parameterArn,
      exportName: SHARED_NAME,
      description: 'ARN of the producer SSM parameter — exported under SHARED_NAME',
    });
  }
}

export class SchemaMigrationDecoyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const decoy = new ssm.StringParameter(this, 'DecoyProbe', {
      parameterName: DECOY_PARAM_NAME,
      stringValue: `decoy-value (phase=${phase()})`,
      description: `Created by tests/integration/schema-v8-to-v9-migration (decoy, phase=${phase()})`,
    });

    // A PLAIN output whose NAME equals the producer's export name. No
    // `exportName`: CloudFormation would never serve this to an
    // Fn::ImportValue; v8 cdkd did.
    new cdk.CfnOutput(this, SHARED_NAME, {
      value: decoy.parameterArn,
      description: 'ARN of the decoy SSM parameter — a plain output, NOT an export',
    });
  }
}

export class SchemaMigrationConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.CfnParameter(this, 'ConsumerProbe', {
      type: 'String',
      name: CONSUMER_PARAM_NAME,
      value: cdk.Fn.importValue(SHARED_NAME),
      description: `Consumer probe — reads SHARED_NAME via Fn::ImportValue (phase=${phase()})`,
    });
  }
}
