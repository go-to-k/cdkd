import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';

/**
 * go-to-k/cdkd#4606, the Lambda function arm: a fix-forward deploy deletes
 * the function a failed CREATE left in AWS, and keeps one whose name was
 * re-used.
 *
 * - The baseline holds `ExecRole` (the functions' execution role) and
 *   `BaseFn`.
 * - `WITH_ORPHANS=true` adds `OrphanA`, `OrphanC` and `OrphanD`, each declaring a
 *   `RecursiveLoop`. verify.sh deploys that template as a role that may
 *   create a function but may not delete it, so each CREATE makes the
 *   function, fails on a post-create call, and cannot clean up: the journal
 *   records each as a proven orphan with the `<FunctionArn>@<LastModified>`
 *   its `CreateFunction` answered with. `OrphanA` and `OrphanC` fail on
 *   `PutFunctionRecursionConfig`, which the role denies them. `OrphanD` also
 *   declares `ReservedConcurrentExecutions`, and the role allows its
 *   recursion config, so its CREATE fails on the later, denied
 *   `PutFunctionConcurrency`, after a successful Put.
 * - `ORPHAN_FIX_FORWARD=true` keeps every orphan logical id under another name
 *   (`-b`), so the fix-forward deploy creates three new functions. Before it,
 *   verify.sh deletes `OrphanC`'s function and re-creates the name itself
 *   (one made outside the stack, under another `LastModified`): the
 *   fix-forward must delete `OrphanA`'s and `OrphanD`'s functions and keep that one.
 *
 * L1 functions with explicit names and inline code (no asset to publish, so
 * the restricted role needs no asset-bucket access), using only properties
 * the Lambda SDK provider handles, so every function stays on the SDK route
 * (`provisionedBy: sdk`), where `isSameResource` / `resourceIdentity` live.
 */
export class LambdaFixForwardOrphanStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const execRole = new iam.CfnRole(this, 'ExecRole', {
      assumeRolePolicyDocument: {
        Version: '2012-10-17',
        Statement: [
          {
            Effect: 'Allow',
            Principal: { Service: 'lambda.amazonaws.com' },
            Action: 'sts:AssumeRole',
          },
        ],
      },
    });

    const fn = (
      logicalId: string,
      functionName: string,
      recursiveLoop: boolean,
      reservedConcurrency = false
    ): void => {
      new lambda.CfnFunction(this, logicalId, {
        functionName,
        role: execRole.attrArn,
        runtime: 'nodejs22.x',
        handler: 'index.handler',
        code: { zipFile: 'exports.handler = async () => ({});' },
        ...(recursiveLoop && { recursiveLoop: 'Allow' }),
        ...(reservedConcurrency && { reservedConcurrentExecutions: 1 }),
      });
    };

    fn('BaseFn', 'cdkd-lffo-base', false);

    if (process.env.WITH_ORPHANS === 'true') {
      const suffix = process.env.ORPHAN_FIX_FORWARD === 'true' ? '-b' : '';
      fn('OrphanA', `cdkd-lffo-a${suffix}`, true);
      fn('OrphanC', `cdkd-lffo-c${suffix}`, true);
      // Reserved concurrency only on the failed CREATE, whose
      // PutFunctionConcurrency is denied: the fix-forward's `-b` function
      // drops it, so no account's unreserved floor can refuse the run.
      fn('OrphanD', `cdkd-lffo-d${suffix}`, true, suffix === '');
    }
  }
}
