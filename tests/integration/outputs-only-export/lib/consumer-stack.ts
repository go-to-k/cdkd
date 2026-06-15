import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Consumer fixture: imports the producer bucket ARN via `Fn::ImportValue`
 * and stores it in an SSM Parameter so verify.sh can assert the value
 * resolved end-to-end.
 *
 * The export it imports is added to the producer ONLY when this consumer
 * exists (see bin/app.ts). So the consumer's first deploy resolves an
 * export that the producer wrote on its preceding no-op deploy — which
 * only works after the #875 fix persists Outputs-only changes.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const importedBucketArn = cdk.Fn.importValue('CdkdOutputsOnlyBucketArn');

    new ssm.StringParameter(this, 'ImportedArnParam', {
      parameterName: '/cdkd-integ/outputs-only-export/imported-bucket-arn',
      stringValue: importedBucketArn,
      description: 'Stores the bucket ARN imported from the Producer via Fn::ImportValue.',
    });
  }
}
