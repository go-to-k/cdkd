import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';

/**
 * Regression fixture for the `--no-prefix-user-supplied-names` migration-check
 * false positive: a Pattern B resource (IAM Role) whose USER-SUPPLIED physical
 * name itself starts with `${stackName}-` (the extremely common
 * `${this.stackName}-role` convention).
 *
 * Post-v0.94 cdkd takes the name verbatim, so the recorded physicalId already
 * equals the user name — there is NO pending rename. The migration check used
 * to blindly strip the `${stackName}-` prefix, mis-predict a rename
 * (`MyStack-role` -> `role`), and force a spurious REPLACEMENT confirm prompt
 * that BLOCKED every routine in-place UPDATE (e.g. adding an inline policy
 * statement) in non-interactive runs.
 *
 * The UPDATE (gated on CDKD_TEST_UPDATE) adds an inline-policy statement — an
 * in-place IAM update that must NOT be blocked by the migration prompt and must
 * NOT replace the role.
 *
 * The REMOVAL phase (gated on CDKD_TEST_REMOVAL, issue #1160 iam-role batch)
 * keeps the phase-2 inline policy and ADDITIONALLY drops `description` +
 * `maxSessionDuration` from the template. IAM UpdateRole MERGES (absent =
 * "no change"), so pre-fix the live role silently kept both values;
 * IAMRoleProvider.update() must reset them to the CFn defaults ('' / 3600).
 *
 * covers: AWS::IAM::Role
 */
export class IamRolePrefixedNameUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updating = process.env.CDKD_TEST_UPDATE === 'true';
    // CDKD_TEST_REMOVAL drops description + maxSessionDuration so the only
    // template diff vs phase 2 is the two removed fields (issue #1160).
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';

    const statements = [
      new iam.PolicyStatement({
        actions: ['logs:CreateLogGroup'],
        resources: ['*'],
      }),
    ];
    if (updating) {
      statements.push(
        new iam.PolicyStatement({
          actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
          resources: ['*'],
        })
      );
    }

    new iam.Role(this, 'Role', {
      // User-supplied name that starts with the stack name on purpose.
      roleName: `${cdk.Stack.of(this).stackName}-role`,
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      inlinePolicies: {
        own: new iam.PolicyDocument({ statements }),
      },
      ...(removal
        ? {}
        : {
            description: 'cdkd f1160 removal-reset probe',
            maxSessionDuration: cdk.Duration.hours(2),
          }),
    });
  }
}
