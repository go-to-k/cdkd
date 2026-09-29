import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * Failure-seeking integ for go-to-k/cdkd#4009: cdkd never sends a secret's
 * PLAINTEXT to a custom-resource handler, including on the routes the #3976
 * template pre-flight cannot see.
 *
 * covers: AWS::CloudFormation::CustomResource
 * covers: AWS::CloudFormation::Stack
 * covers: AWS::Lambda::Function
 *
 * One handler, logging its whole event (the realistic hazard: a handler that
 * logs its event writes whatever cdkd sent to CloudWatch). The arms, each
 * gated on its own `CDKD_TEST_UPDATE` token and deployed on a FRESH stack:
 *
 *  - `ssm-secure` — `SsmReader` takes `Value` from a PLAIN
 *    `{{resolve:ssm:<name>}}` whose parameter verify.sh creates as a
 *    SecureString. The template spells `ssm`, so the #3976 pre-flight accepts
 *    it; the resolver decrypts it and records it as a secret.
 *  - `nested` — a nested child stack's `NestedReader` takes `Value` from
 *    `{Ref: SecretValue}`, a child parameter the PARENT fills with a
 *    `{{resolve:secretsmanager:...}}` reference (secret created by verify.sh).
 *    The child template holds only the `Ref`.
 *
 *  - `update-clean` / `update-secret` — `SsmUpdater` is deployed with a plain
 *    value, then UPDATED to the SecureString reference: the update is refused,
 *    and `cdkd rollback --revert-failed` (which re-resolves the failed op's
 *    attempted properties as the PREVIOUS side, `OldResourceProperties`) is
 *    refused too.
 *
 * Every refused reader must never run with the secret, so the secret value
 * appears in NO log event. The benign `PlainReader` always runs first (each
 * refused reader depends on it) and logs a per-arm marker, the positive
 * control that ingestion caught up. With no token the stack holds only the
 * handler and `PlainReader`, for the clean destroy the `integ-destroy` gate
 * reads.
 *
 * The secret values are fixed, inert literals chosen so verify.sh can grep
 * the log groups and every state version for them.
 */
class SecretReadingChild extends cdk.NestedStack {
  constructor(scope: Construct, id: string, props?: cdk.NestedStackProps) {
    super(scope, id, props);
    // Pinned so the child's state key is the documented `<parent>~Child`.
    (this.nestedStackResource as cdk.CfnResource).overrideLogicalId('Child');

    const secretValue = new cdk.CfnParameter(this, 'SecretValue', { type: 'String' });
    secretValue.overrideLogicalId('SecretValue');
    const handlerArn = new cdk.CfnParameter(this, 'HandlerArn', { type: 'String' });
    handlerArn.overrideLogicalId('HandlerArn');

    new cdk.CustomResource(this, 'NestedReader', {
      serviceToken: handlerArn.valueAsString,
      resourceType: 'Custom::CdkdNestedReader',
      properties: { Value: secretValue.valueAsString },
    });
  }
}

export class CustomResourceResolvedSecretStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const modes = (process.env.CDKD_TEST_UPDATE ?? '').split(',');

    const handler = new lambda.Function(this, 'EventLogger', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(30),
      code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  // Deliberately logs the WHOLE event: the hazard this fixture measures.
  console.log('CR event:', JSON.stringify(event));
  return { Status: 'SUCCESS', PhysicalResourceId: event.PhysicalResourceId || 'cr-resolved-secret' };
};
`),
    });

    // A benign reader. Every refused reader DEPENDS on it, so it has always
    // run (and logged) first: its event is verify.sh's positive control that
    // CloudWatch ingestion caught up before a secret's ABSENCE is trusted.
    const plainReader = new cdk.CustomResource(this, 'PlainReader', {
      serviceToken: handler.functionArn,
      resourceType: 'Custom::CdkdPlainReader',
      properties: { Value: `not-a-secret-${modes.filter((m) => m !== '').join('+') || 'plain'}` },
    });

    // allow-mode-gated-drop: every arm deploys a fresh stack that verify.sh tears down first, so omitting it drops nothing.
    if (modes.includes('ssm-secure')) {
      const ssmReader = new cdk.CustomResource(this, 'SsmReader', {
        serviceToken: handler.functionArn,
        resourceType: 'Custom::CdkdSsmReader',
        properties: { Value: `{{resolve:ssm:/cdkd-integ/${id}/secure}}` },
      });
      ssmReader.node.addDependency(plainReader);
    }

    // allow-mode-gated-drop: every arm deploys a fresh stack that verify.sh tears down first, so omitting it drops nothing.
    if (modes.includes('update-clean') || modes.includes('update-secret')) {
      const updater = new cdk.CustomResource(this, 'SsmUpdater', {
        serviceToken: handler.functionArn,
        resourceType: 'Custom::CdkdSsmUpdater',
        properties: {
          Value: modes.includes('update-secret')
            ? `{{resolve:ssm:/cdkd-integ/${id}/secure}}`
            : 'clean-before-update',
        },
      });
      updater.node.addDependency(plainReader);
    }

    // allow-mode-gated-drop: every arm deploys a fresh stack that verify.sh tears down first, so omitting it drops nothing.
    if (modes.includes('nested')) {
      const child = new SecretReadingChild(this, 'Child', {
        parameters: {
          SecretValue: `{{resolve:secretsmanager:cdkd-integ/${id}/nested:SecretString:::}}`,
          HandlerArn: handler.functionArn,
        },
      });
      child.node.addDependency(handler);
      child.node.addDependency(plainReader);
    }
  }
}
