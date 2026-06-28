import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as kinesis from 'aws-cdk-lib/aws-kinesis';
import * as secrets from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Immutable-Name replacement coverage.
 *
 * `AWS::Kinesis::Stream` and `AWS::SecretsManager::Secret` `Name` are immutable in
 * CloudFormation ("Update requires: Replacement"). cdkd previously had no
 * replacement rule for either type, so a rename was attempted as an in-place
 * update — AWS has no rename API, so the change was silently dropped and cdkd's
 * state diverged from AWS (deploy reported success while the resource kept its
 * old name). This fixture renames both on UPDATE and asserts cdkd REPLACES
 * (DELETE old + CREATE new) rather than no-op-updating.
 *
 *   covers: AWS::Kinesis::Stream, AWS::SecretsManager::Secret
 *
 * removalPolicy DESTROY (-> UpdateReplacePolicy: Delete) so the OLD resource is
 * deleted on replacement instead of CDK's default Retain (which would orphan it).
 */
export class ReplacementImmutableNameStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const suffix = process.env.CDKD_TEST_UPDATE === 'true' ? 'v2' : 'v1';

    const stream = new kinesis.Stream(this, 'Stream', {
      streamName: `${this.stackName}-stream-${suffix}`,
      shardCount: 1,
      streamMode: kinesis.StreamMode.PROVISIONED,
    });
    stream.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new secrets.Secret(this, 'Secret', {
      secretName: `${this.stackName}-secret-${suffix}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    new cdk.CfnOutput(this, 'StreamName', { value: stream.streamName });
  }
}
