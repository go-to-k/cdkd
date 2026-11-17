import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as events from 'aws-cdk-lib/aws-events';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';

/**
 * Integ probe for go-to-k/cdkd#6499: an `AWS::Events::Connection` (Cloud
 * Control routed) keeps its API key at the write-only
 * `AuthParameters/ApiKeyAuthParameters/ApiKeyValue`, nested under the readable
 * `AuthParameters`. `cdkd drift --revert` sent the readback's `AuthParameters`,
 * which lacks the key, and Cloud Control refused the model, so no revert of a
 * connection could succeed.
 *
 * Two connections: one whose key is a literal, and one whose key is a
 * `{{resolve:secretsmanager:...}}` dynamic reference, which the revert must
 * resolve rather than send as text.
 */
export class DriftRevertNestedWriteOnlyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new events.Connection(this, 'PlainConn', {
      description: 'integ',
      authorization: events.Authorization.apiKey(
        'x-api-key',
        cdk.SecretValue.unsafePlainText('plain-key-1')
      ),
    });

    const keySecret = new secretsmanager.Secret(this, 'KeySecret', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      secretObjectValue: { key: cdk.SecretValue.unsafePlainText('secret-key-1') },
    });
    new events.Connection(this, 'SecretConn', {
      description: 'integ',
      authorization: events.Authorization.apiKey(
        'x-api-key',
        keySecret.secretValueFromJson('key')
      ),
    });
  }
}
