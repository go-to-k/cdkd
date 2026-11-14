import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import {
  EXPORT_NAME,
  SECRET_JSON_FIELD,
  SECRET_NAME,
  SSM_PARAMETER_NAME,
  integSecretPlaintext,
  integSsmParameterValue,
  secretReference,
} from './shared.ts';

/**
 * Producer for the secret-bearing cross-stack arm (issue #2056).
 *
 * A Secrets Manager secret with a known JSON value, and an exported output
 * whose value is the `{{resolve:secretsmanager:...}}` reference to it. cdkd
 * resolves the output at deploy time and PERSISTS it REDACTED back to the
 * expression (#1899), so the consumer's `cdkd local invoke --from-state` reads
 * the TOKEN out of the exports index — the value that used to reach the
 * container verbatim.
 */
export class LocalInvokeFromStateProducerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new secretsmanager.Secret(this, 'FixtureSecret', {
      secretName: SECRET_NAME,
      secretStringValue: cdk.SecretValue.unsafePlainText(
        JSON.stringify({ [SECRET_JSON_FIELD]: integSecretPlaintext() })
      ),
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Issue #6307: the parameter the consumer's EchoBucketHandler reads through
    // `valueForStringParameter`. Here, not in the consumer, so it exists before
    // the consumer's deploy resolves it.
    new ssm.StringParameter(this, 'FixtureParameter', {
      parameterName: SSM_PARAMETER_NAME,
      stringValue: integSsmParameterValue(),
    });

    // Spelled by name, the same shape `cross-stack-secret-import` exports.
    new cdk.CfnOutput(this, 'SecretPasswordOutput', {
      value: secretReference(),
      exportName: EXPORT_NAME,
      description: 'A secret-bearing export: persisted by cdkd as its dynamic-reference expression.',
    });
  }
}
