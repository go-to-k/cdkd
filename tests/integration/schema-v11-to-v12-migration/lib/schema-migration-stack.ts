import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * State schema v11 -> v12 migration fixture (issues #4847 / #4852).
 *
 * v12 records, per `{{resolve:...}}` token a record holds, the region that
 * resolved it and the secret's version ids (`ResourceState.referenceProvenance`,
 * `StackState.outputReferenceProvenance`). A v11 binary (the npm pin in
 * verify.sh) writes none; the first v12 deploy of an UNCHANGED stack must add
 * them through its one-time capture WITHOUT sending, updating or replacing
 * anything.
 *
 * Every input is an ENVIRONMENT variable verify.sh sets, read at synth time,
 * so the v11 and the v12 binary synthesize the same template:
 *
 *   CDKD_V12_SECRET   the per-run Secrets Manager secret's name, holding
 *                     `{"queue": <queue name>, "password": <value>}`
 *   CDKD_V12_PREFIX   the per-run SSM parameter name prefix
 *   CDKD_V12_READER_EDIT  `1` edits `Reader`'s description: the v11 redeploy
 *                     that rewrites it from the then-unchanged queue, so its
 *                     value is stored as the `arn:...:{{resolve:...}}` token
 *                     form (a reader of a queue created in the same run
 *                     stores the plaintext ARN once, go-to-k/cdkd#4802)
 *
 * Resources:
 *
 * - `Queue`: an SQS queue NAMED from the secret, so its physical id holds the
 *   value and the capture can prove the version (`versions`);
 * - `Reader`: an SSM parameter storing `Queue.Arn` (a value READ through
 *   `Fn::GetAtt`): the capture records its region, never `readVersions`;
 * - `PasswordHolder`: an SSM parameter whose value is the secret's `password`
 *   (no name holds it): region only, and the no-plaintext scan's needle;
 * - `Plain`: a token-free control, which gains no field.
 */
export class SchemaV11ToV12MigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const secret = process.env.CDKD_V12_SECRET ?? 'cdkd-integ/schema-v11-to-v12/unset';
    const prefix = process.env.CDKD_V12_PREFIX ?? '/cdkd-integ/schema-v11-to-v12/unset';

    const queue = new sqs.CfnQueue(this, 'Queue', {
      queueName: `{{resolve:secretsmanager:${secret}:SecretString:queue}}`,
    });
    queue.overrideLogicalId('Queue');

    const reader = new ssm.CfnParameter(this, 'Reader', {
      name: `${prefix}/reader`,
      type: 'String',
      value: queue.attrArn,
      description:
        process.env.CDKD_V12_READER_EDIT === '1' ? 'cdkd integ: edited' : 'cdkd integ: initial',
    });
    reader.overrideLogicalId('Reader');

    const holder = new ssm.CfnParameter(this, 'PasswordHolder', {
      name: `${prefix}/password-holder`,
      type: 'String',
      value: `{{resolve:secretsmanager:${secret}:SecretString:password}}`,
    });
    holder.overrideLogicalId('PasswordHolder');

    const plain = new ssm.CfnParameter(this, 'Plain', {
      name: `${prefix}/plain`,
      type: 'String',
      value: 'schema-v12-plain-control',
    });
    plain.overrideLogicalId('Plain');

    new cdk.CfnOutput(this, 'QueueArn', { value: queue.attrArn });
  }
}
