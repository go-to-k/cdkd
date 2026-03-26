import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';

/**
 * Consumer stack that imports values from the exporter stack
 *
 * This stack uses Fn::ImportValue to reference values exported
 * by the ExporterStack, demonstrating cross-stack references.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Import bucket name using Fn::ImportValue
    const importedBucketName = cdk.Fn.importValue('SharedBucketName');

    // Import bucket ARN using Fn::ImportValue
    const importedBucketArn = cdk.Fn.importValue('SharedBucketArn');

    // Output the imported values to verify they were resolved correctly
    new cdk.CfnOutput(this, 'ImportedBucketName', {
      value: importedBucketName,
      description: 'Bucket name imported via Fn::ImportValue',
    });

    new cdk.CfnOutput(this, 'ImportedBucketArn', {
      value: importedBucketArn,
      description: 'Bucket ARN imported via Fn::ImportValue',
    });

    // Create a parameter that uses the imported bucket name
    // This tests that Fn::ImportValue works in resource properties
    new cdk.CfnParameter(this, 'VerifyImport', {
      type: 'String',
      default: importedBucketName,
      description: 'Parameter using imported bucket name to verify resolution',
    });
  }
}
