import * as path from 'path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3assets from 'aws-cdk-lib/aws-s3-assets';
import * as stepfunctions from 'aws-cdk-lib/aws-stepfunctions';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Step Functions DefinitionS3Location backfill fixture (issue #609).
 *
 * The state-machine definition (Amazon States Language) is NOT inline — it
 * lives in an `s3_assets.Asset` that cdkd uploads to the bootstrap asset
 * bucket. The L1 `CfnStateMachine` points at it via `definitionS3Location`,
 * the property this fixture exercises. CloudFormation (and now cdkd) fetches
 * the S3 object and inlines its contents as the state-machine definition.
 *
 * The definition contains a `${Greeting}` token resolved via
 * `definitionSubstitutions` — the intrinsic resolver cannot reach into S3
 * content, so cdkd's provider applies the substitution to the fetched body
 * itself (CloudFormation parity). The deployed state machine's definition
 * therefore proves BOTH the S3 fetch AND the substitution reached real AWS.
 *
 * L1 `CfnStateMachine` is used deliberately for the S3 machine (memory
 * `feedback_l1_over_l2_for_backfill_integ_fixture`): an L2
 * `stepfunctions.StateMachine` would synthesize the definition inline and
 * never set `DefinitionS3Location`, defeating the backfill verification.
 *
 * Issue #5298 widens the fixture to the INLINE forms, where
 * `DefinitionSubstitutions` used to be dropped:
 *   - `ChainMachine` — a string `DefinitionString` plus a SEPARATE
 *     `DefinitionSubstitutions` map (no `Fn::Sub`): the exact pair an L2
 *     `StateMachine` with a chain body synthesizes, the shape most CDK apps
 *     deploy.
 *   - `ObjectMachine` — an L1 `CfnStateMachine` with an inline object
 *     `Definition`.
 * The `phase` context (`-c phase=2`) changes ONLY the two inline machines'
 * substitution values, so the redeploy exercises the update path with a
 * byte-identical definition body.
 */
export class StepFunctionsS3Stack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The ASL definition file, uploaded to the bootstrap asset bucket by cdkd.
    const definitionAsset = new s3assets.Asset(this, 'DefinitionAsset', {
      path: path.join(__dirname, '../definition.asl.json'),
    });

    // Execution role for the state machine. A Pass-only state machine needs no
    // extra permissions, so the trust policy is all that matters.
    const role = new iam.Role(this, 'SfnRole', {
      assumedBy: new iam.ServicePrincipal('states.amazonaws.com'),
    });

    const phase = String(this.node.tryGetContext('phase') ?? '1');

    const stateMachine = new stepfunctions.CfnStateMachine(this, 'StateMachine', {
      roleArn: role.roleArn,
      stateMachineType: 'STANDARD',
      definitionS3Location: {
        bucket: definitionAsset.s3BucketName,
        key: definitionAsset.s3ObjectKey,
      },
      definitionSubstitutions: {
        Greeting: 'hello-from-cdkd',
      },
    });

    // Issue #5298: a string `DefinitionString` plus a separate
    // `DefinitionSubstitutions` map -- byte-for-byte the pair aws-cdk-lib's L2
    // `StateMachine` synthesizes for a chain body
    // (`DefinitionBody.fromChainable(new Pass(..., { result: Result.fromString('${InlineGreeting}') }))`).
    // Spelled as an L1 so the fixture's resource-coverage rows stay unchanged;
    // the template the provider receives is the same. `${InlineGreeting}` is
    // plain text here (no `Fn::Sub`); only DefinitionSubstitutions fills it.
    const chainMachine = new stepfunctions.CfnStateMachine(this, 'ChainMachine', {
      roleArn: role.roleArn,
      stateMachineType: 'STANDARD',
      definitionString:
        '{"StartAt":"InlineGreet","States":{"InlineGreet":{"Type":"Pass","Result":"${InlineGreeting}","ResultPath":"$.greeting","End":true}}}',
      definitionSubstitutions: {
        InlineGreeting: `inline-hello-v${phase}`,
      },
    });

    // Issue #5298: an L1 inline object `Definition`.
    const objectMachine = new stepfunctions.CfnStateMachine(this, 'ObjectMachine', {
      roleArn: role.roleArn,
      stateMachineType: 'STANDARD',
      definition: {
        StartAt: 'ObjectGreet',
        States: {
          ObjectGreet: {
            Type: 'Pass',
            Result: '${ObjectGreeting}',
            ResultPath: '$.greeting',
            End: true,
          },
        },
      },
      definitionSubstitutions: {
        ObjectGreeting: `object-hello-v${phase}`,
      },
    });

    new cdk.CfnOutput(this, 'StateMachineArn', {
      value: stateMachine.attrArn,
    });
    new cdk.CfnOutput(this, 'ChainMachineArn', {
      value: chainMachine.attrArn,
    });
    new cdk.CfnOutput(this, 'ObjectMachineArn', {
      value: objectMachine.attrArn,
    });
  }
}
