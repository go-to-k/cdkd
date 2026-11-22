import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as dms from 'aws-cdk-lib/aws-dms';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * covers: AWS::DMS::Endpoint, AWS::SecretsManager::Secret, AWS::SSM::Parameter
 *
 * State schema v17 -> v18 migration fixture (issue #6824).
 *
 * v18 is CONDITIONAL: a save writes it only for a state some record of which
 * carries `referenceProvenance[token].versionsSent`, the attestation a Cloud
 * Control create or update of a measured write-only key leaves when it SENT a
 * `{{resolve:...}}` reference at one version. A DMS endpoint's `Password`
 * (Cloud Control, no SDK provider; creating an endpoint needs no replication
 * instance and costs nothing) from a CDK-generated secret is such a key.
 *
 * - `CDKD_TEST_PARAM_VALUE` sets the SSM parameter's value: the ordinary change
 *   that makes a deploy write the state without touching the endpoint.
 * - `CDKD_TEST_ENDPOINT_TAG` sets the endpoint's `phase` tag: a Tags-only
 *   update of the endpoint, whose write attests the password's version.
 */
export class SchemaV17ToV18MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const secret = new secretsmanager.Secret(this, 'Secret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'cdkd' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        passwordLength: 24,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    (secret.node.defaultChild as secretsmanager.CfnSecret).overrideLogicalId('Secret');

    const endpoint = new dms.CfnEndpoint(this, 'Endpoint', {
      endpointIdentifier: 'cdkd-schema-v17-v18',
      endpointType: 'source',
      engineName: 'mysql',
      // Never connected to: an endpoint is only a connection definition.
      serverName: 'cdkd-schema-v17-v18.invalid',
      port: 3306,
      username: 'cdkd',
      password: secret.secretValueFromJson('password').unsafeUnwrap(),
      tags: [{ key: 'phase', value: process.env['CDKD_TEST_ENDPOINT_TAG'] ?? 'one' }],
    });
    endpoint.overrideLogicalId('Endpoint');
    endpoint.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const param = new ssm.StringParameter(this, 'Param', {
      parameterName: '/cdkd-schema-v17-v18/value',
      stringValue: process.env['CDKD_TEST_PARAM_VALUE'] ?? 'one',
      simpleName: false,
    });
    (param.node.defaultChild as ssm.CfnParameter).overrideLogicalId('Param');
  }
}
