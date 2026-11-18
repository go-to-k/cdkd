import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Cloud Control API context lookups (issue #6542).
 *
 * `ec2.PrefixList.fromLookup` and `iam.Role.fromLookup` resolve through the
 * `cc-api-provider` context provider, which must answer with an ARRAY (one
 * object per match, each carrying `Identifier`). The looked-up values are
 * written into two SSM parameters so the deploy proves they reached AWS.
 *
 * covers: AWS::SSM::Parameter
 */
export class CcApiLookupStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const roleName = process.env.CDKD_CC_LOOKUP_ROLE_NAME;
    if (!roleName) {
      throw new Error(
        'CDKD_CC_LOOKUP_ROLE_NAME must be set to the name of an existing IAM role (verify.sh creates it)'
      );
    }

    // AWS-managed prefix list, present in every region.
    const prefixList = ec2.PrefixList.fromLookup(this, 'S3PrefixList', {
      prefixListName: `com.amazonaws.${this.region}.s3`,
    });

    const role = iam.Role.fromLookup(this, 'LookedUpRole', { roleName });

    new ssm.StringParameter(this, 'PrefixListIdParam', {
      parameterName: `/cdkd-test/cc-api-lookup/${this.stackName}/prefix-list-id`,
      stringValue: prefixList.prefixListId,
    });

    new ssm.StringParameter(this, 'RoleArnParam', {
      parameterName: `/cdkd-test/cc-api-lookup/${this.stackName}/role-arn`,
      stringValue: role.roleArn,
    });
  }
}
