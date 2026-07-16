import * as cdk from 'aws-cdk-lib';
import * as cfninc from 'aws-cdk-lib/cloudformation-include';
import type { Construct } from 'constructs';

/**
 * CfnInclude — a raw CloudFormation template embedded in a CDK app (the
 * common CFn -> CDK migration shape). Raw templates carry notations CDK
 * itself rarely emits: Parameters with defaults, Mappings + Fn::FindInMap
 * keyed by a parameter Ref, Conditions on resources AND outputs, and
 * Fn::Sub over parameters + GetAtt.
 *
 * CDKD_TEST_UPDATE=true inlines RetentionSeconds=600 via CfnInclude's
 * `parameters` option (the real in-place UPDATE the fixture asserts).
 */
export class RawCfnStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const update = process.env['CDKD_TEST_UPDATE'] === 'true';

    new cfninc.CfnInclude(this, 'Included', {
      templateFile: 'raw-template.json',
      parameters: update ? { RetentionSeconds: 600 } : undefined,
    });
  }
}
