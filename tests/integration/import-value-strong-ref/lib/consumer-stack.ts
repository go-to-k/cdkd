import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Consumer fixture: stores the imported producer-bucket ARN in an SSM
 * Parameter. The Parameter resource is cheap to deploy / destroy and
 * lets us assert the resolved value end-to-end.
 *
 * The `Fn::ImportValue` reference here is what cdkd's resolver records
 * into `state.imports[]` (schema v4). Strong-reference checks at
 * producer destroy time then refuse the destroy until this consumer is
 * removed.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const importedBucketArn = cdk.Fn.importValue('IntegBucketArn');

    new ssm.StringParameter(this, 'ImportedArnParam', {
      parameterName: '/cdkd-integ/import-value-strong-ref/imported-bucket-arn',
      stringValue: importedBucketArn,
      description:
        'Stores the bucket ARN imported from the Producer stack via ' +
        'Fn::ImportValue. Existence of this resource’s state.imports[] ' +
        'entry is what triggers cdkd’s strong-reference destroy refusal.',
    });
  }
}
