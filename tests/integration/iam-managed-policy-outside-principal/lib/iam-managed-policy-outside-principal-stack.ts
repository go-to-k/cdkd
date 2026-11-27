import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import type { Construct } from 'constructs';

/**
 * go-to-k/cdkd#7117. `CDKD_TEST_UPDATE=removed` drops `Removed` and
 * `RoleSide` from the template:
 * - `Removed` declares no principals; verify.sh attaches it to a role outside
 *   the stack, so its delete must refuse rather than detach it there;
 * - `RoleSide` is attached from the principal side (`Role.ManagedPolicyArns`),
 *   so the role's update lets go of it before its delete;
 * - `Declared` names `Role` in its own `Roles`; verify.sh attaches it to the
 *   outside role too, so `cdkd destroy` must refuse over that one only.
 */
export class IamManagedPolicyOutsidePrincipalStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const removed = (process.env['CDKD_TEST_UPDATE'] ?? '').split(',').includes('removed');
    const statements = [new iam.PolicyStatement({ actions: ['s3:ListAllMyBuckets'], resources: ['*'] })];

    const role = new iam.Role(this, 'Role', { assumedBy: new iam.AccountRootPrincipal() });
    new iam.ManagedPolicy(this, 'Declared', { statements, roles: [role] });

    if (!removed) {
      new iam.ManagedPolicy(this, 'Removed', { statements });
      role.addManagedPolicy(new iam.ManagedPolicy(this, 'RoleSide', { statements }));
    }
  }
}
