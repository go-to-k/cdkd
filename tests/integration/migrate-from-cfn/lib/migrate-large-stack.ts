import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

/**
 * Large CloudFormation stack — its synthesized template exceeds the
 * 51,200-byte UpdateStack TemplateBody ceiling, forcing
 * retireCloudFormationStack onto the cdkd-state-bucket TemplateURL upload
 * path added in PR #113.
 *
 * The bloat comes from a single Lambda with ~60 KB of padded inline code —
 * one resource, one IAM role, no SSM rate-limit pressure (which we hit
 * earlier with 200 SSM Parameters).
 */
export class MigrateLargeStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Padding lives in a comment block so the function still parses and
    // can run a smoke handler. The exact byte target (60,000) is chosen so
    // the Retain-injected template is comfortably above 51,200 bytes
    // (about 67–69 KB in practice) but well below the 1 MB TemplateURL
    // ceiling.
    const padding = '/* '.padEnd(60000, 'x') + ' */';
    const code = `exports.handler = async () => ({ ok: true });\n${padding}\n`;

    new lambda.Function(this, 'BigLambda', {
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(code),
      description: 'cdkd integ — migrate-from-cfn large (>51,200B) path',
    });
  }
}
