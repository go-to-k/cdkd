import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

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
 * "no change"), so pre-fix the live role kept both values; since #5004
 * that is right for MaxSessionDuration (CloudFormation keeps it), while
 * IAMRoleProvider.update() still resets Description to ''.
 *
 * The PATH phases (gated on CDKD_TEST_ROLE_PATH, issue #4739) move an UNNAMED
 * role -- cdkd generates its name, `${stackName}-<logicalId>-<12 hex>` -- that a
 * named function runs as from the default path `/` to `/cdkd-4739/`. `Path` is
 * createOnly, so this is a replacement, which on a stack with a stack instance
 * id creates the new role at the next name generation (go-to-k/cdkd#5064): a
 * NEW name, created first, then the old role deleted. A plain deploy therefore
 * succeeds with no `--replace`, re-pointing the function and the policies
 * attached by name at the new role.
 *
 * covers: AWS::IAM::Role, AWS::Lambda::Function
 */
export class IamRolePrefixedNameUpdateStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updating = process.env.CDKD_TEST_UPDATE === 'true';
    // CDKD_TEST_REMOVAL drops description + maxSessionDuration so the only
    // template diff vs phase 2 is the two removed fields (issue #1160).
    const removal = process.env.CDKD_TEST_REMOVAL === 'true';
    // CDKD_TEST_ROLE_PATH moves PathRole to another path (issue #4739).
    const rolePath = process.env.CDKD_TEST_ROLE_PATH === 'true';

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

    // No roleName: cdkd generates the name, which a Path change moves to the
    // next name generation.
    const pathRole = new iam.Role(this, 'PathRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      ...(rolePath ? { path: '/cdkd-4739/' } : {}),
    });
    // Two resources attached to the role BY NAME from the outside, which the
    // replacement must move onto the new role (go-to-k/cdkd#4461): the
    // separate AWS::IAM::Policy
    // (DefaultPolicy) addToPolicy creates, and a customer managed policy whose
    // own `Roles` names the role.
    pathRole.addToPolicy(
      new iam.PolicyStatement({ actions: ['logs:CreateLogGroup'], resources: ['*'] })
    );
    new iam.ManagedPolicy(this, 'PathManaged', {
      managedPolicyName: `${cdk.Stack.of(this).stackName}-path-managed`,
      roles: [pathRole],
      statements: [
        new iam.PolicyStatement({ actions: ['logs:CreateLogStream'], resources: ['*'] }),
      ],
    });
    new lambda.Function(this, 'PathFn', {
      functionName: `${cdk.Stack.of(this).stackName}-path-fn`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ ok: true });'),
      role: pathRole,
    });
  }
}
