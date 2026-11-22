import * as cdk from 'aws-cdk-lib';
import * as redshiftserverless from 'aws-cdk-lib/aws-redshiftserverless';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#6824: a Cloud Control update leaves an unchanged write-only
 * password passed as a `{{resolve:secretsmanager:...}}` reference out of the
 * patch only when the secret version this deploy resolved is the one the state
 * record attests was last sent.
 *
 * A CDK-generated secret (`username` + `password`, the shape the Redshift Data
 * API's `--secret-arn` logs in with) feeds a Redshift Serverless namespace's
 * `AdminUserPassword`, whose re-send makes `UpdateNamespace` re-set it
 * (go-to-k/cdkd#6788). A workgroup on the namespace lets `verify.sh` log in with
 * the secret's CURRENT value, so "the new password is in effect" is measured,
 * not inferred.
 *
 * Environment (each phase sets it inline):
 *   WOS_TAG   the namespace's `phase` tag value: a Tags-only change per phase.
 *   WOS_FAIL  'after': a queue AWS refuses, created after the namespace update
 *             (the rollback then reverts the namespace).
 *
 * covers: AWS::RedshiftServerless::Namespace
 * covers: AWS::RedshiftServerless::Workgroup
 * covers: AWS::SecretsManager::Secret
 */
export class CcWriteOnlySecretVersionStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const tag = process.env.WOS_TAG ?? 'one';
    const fail = process.env.WOS_FAIL;

    const secret = new secretsmanager.Secret(this, 'AdminSecret', {
      generateSecretString: {
        secretStringTemplate: JSON.stringify({ username: 'cdkdadmin' }),
        generateStringKey: 'password',
        excludePunctuation: true,
        requireEachIncludedType: true,
        passwordLength: 32,
      },
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const tags: cdk.CfnTag[] = [{ key: 'phase', value: tag }];

    const namespace = new redshiftserverless.CfnNamespace(this, 'Ns', {
      namespaceName: 'cdkd-wo-secret-ns',
      adminUsername: 'cdkdadmin',
      adminUserPassword: secret.secretValueFromJson('password').unsafeUnwrap(),
      dbName: 'dev',
      tags,
    });
    namespace.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    const workgroup = new redshiftserverless.CfnWorkgroup(this, 'Wg', {
      workgroupName: 'cdkd-wo-secret-wg',
      namespaceName: namespace.namespaceName,
      baseCapacity: 8,
      publiclyAccessible: false,
    });
    workgroup.addDependency(namespace);
    workgroup.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    if (fail === 'after') {
      // L1, so CDK does not reject the out-of-range value at synth.
      const failing = new sqs.CfnQueue(this, 'FailingQueue', {
        queueName: 'CdkdCcWriteOnlySecretVersion-failing',
        messageRetentionPeriod: 10,
      });
      failing.addDependency(namespace);
    }

    new cdk.CfnOutput(this, 'SecretArn', { value: secret.secretArn });
    new cdk.CfnOutput(this, 'NamespaceName', { value: namespace.namespaceName });
    new cdk.CfnOutput(this, 'WorkgroupName', { value: workgroup.workgroupName });
  }
}
