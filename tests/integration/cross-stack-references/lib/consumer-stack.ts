import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Consumer stack that imports values from the exporter stack
 *
 * Demonstrates two cross-stack reference mechanisms side-by-side:
 *  1. Fn::ImportValue via Export.Name (the classic pattern)
 *  2. Fn::GetStackOutput via OutputName (CFN's newer intrinsic; no Export
 *     required, supports cross-region in same-account, supports
 *     cross-account via RoleArn — cdkd implements 1 + 2 except
 *     RoleArn-based cross-account, which is rejected with a clear error)
 *
 * The Fn::GetStackOutput intrinsic is injected via addPropertyOverride
 * because the `cdk.Fn.getStackOutput` helper only ships in newer
 * aws-cdk-lib versions; the synthesized template ends up identical.
 */
export class ConsumerStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---- (1) Fn::ImportValue path -------------------------------------------
    const importedBucketName = cdk.Fn.importValue('SharedBucketName');
    const importedBucketArn = cdk.Fn.importValue('SharedBucketArn');

    new cdk.CfnOutput(this, 'ImportedBucketName', {
      value: importedBucketName,
      description: 'Bucket name imported via Fn::ImportValue',
    });

    new cdk.CfnOutput(this, 'ImportedBucketArn', {
      value: importedBucketArn,
      description: 'Bucket ARN imported via Fn::ImportValue',
    });

    new cdk.CfnParameter(this, 'VerifyImport', {
      type: 'String',
      default: importedBucketName,
      description: 'Parameter using imported bucket name to verify resolution',
    });

    // ---- (2) Fn::GetStackOutput path ----------------------------------------
    // Read the same output back through Fn::GetStackOutput (by logical id of
    // the CfnOutput on the producer side, NOT the Export.Name). cdkd resolves
    // it from the producer stack's S3 state record at deploy time. Region is
    // omitted -> defaults to the consumer's deploy region (same-account
    // same-region case here, which is the simplest of the three the new
    // intrinsic supports: same-region, same-account cross-region, and
    // cross-account-via-RoleArn).
    const bucketNameParam = new ssm.CfnParameter(this, 'BucketNameViaGetStackOutput', {
      type: 'String',
      value: 'placeholder-replaced-at-deploy-time',
      description: 'Bucket name resolved via Fn::GetStackOutput',
    });
    bucketNameParam.addPropertyOverride('Value', {
      'Fn::GetStackOutput': {
        StackName: 'CdkdExporterStack',
        OutputName: 'BucketNameExport',
      },
    });

    new cdk.CfnOutput(this, 'BucketNameViaGetStackOutputName', {
      value: bucketNameParam.ref,
      description: 'SSM Parameter name holding the Fn::GetStackOutput-resolved bucket name',
    });
  }
}
