import * as cdk from 'aws-cdk-lib';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Small CloudFormation stack — its synthesized template is well under the
 * 51,200-byte UpdateStack TemplateBody limit, so retireCloudFormationStack
 * submits the Retain-injected template inline (no S3 round-trip).
 *
 * Resources are deliberately ones cdkd has SDK Provider support for, so the
 * post-migrate `cdkd destroy` exercises the full provider path rather than
 * the Cloud Control API fallback.
 */
export class MigrateSmallStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new s3.Bucket(this, 'ExampleBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: false,
      versioned: true,
    });

    // Deliberately NO custom `name` on the Document. SSM Documents with a
    // custom Name + custom Content fail UpdateStack with "custom-named
    // resource requires replacing" because CFn re-serializes Content
    // internally and detects the round-trip as a Content change — and a
    // custom-named Document can't be replaced (the name would collide
    // with itself). Real-user impact is documented in
    // retire-cfn-stack.ts's "fall back to the manual 3-step procedure"
    // failure model. Letting CFn auto-name keeps this test focused on
    // the migrate flow itself rather than that downstream CFn quirk.
    new ssm.CfnDocument(this, 'TestDocument', {
      content: {
        schemaVersion: '2.2',
        description: 'cdkd integ — migrate-from-cfn small path',
        mainSteps: [
          {
            action: 'aws:runShellScript',
            name: 'noop',
            inputs: { runCommand: ['echo "migrate-from-cfn small"'] },
          },
        ],
      },
      documentType: 'Command',
    });
  }
}
