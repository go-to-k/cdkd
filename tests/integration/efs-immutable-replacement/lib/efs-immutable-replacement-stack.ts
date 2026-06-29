import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as efs from 'aws-cdk-lib/aws-efs';

/**
 * An EFS FileSystem whose `PerformanceMode` is a createOnly (immutable)
 * property per the CloudFormation registry schema. `AWS::EFS::FileSystem` has
 * NO hand-authored ReplacementRulesRegistry rule, so before the createOnly
 * fallback cdkd mis-classified a PerformanceMode change as an in-place UPDATE
 * (`cdkd diff` showed "1 to update", and the deploy attempted a doomed update).
 *
 *   covers: AWS::EFS::FileSystem
 *
 * Phase 1 deploys with `maxIO`. Phase 2 (CDKD_TEST_UPDATE=true) requests
 * `generalPurpose` — an immutable change. EFS is a STATEFUL type, so the
 * property-driven replacement must be blocked unless --force-stateful-recreation
 * is passed (the verify.sh exercises both the blocked and the forced paths).
 */
export class EfsImmutableReplacementStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const mode = process.env.CDKD_TEST_UPDATE === 'true' ? 'generalPurpose' : 'maxIO';
    const fs = new efs.CfnFileSystem(this, 'Fs', {
      performanceMode: mode,
      fileSystemTags: [{ key: 'Name', value: `${cdk.Stack.of(this).stackName}-fs` }],
    });
    fs.applyRemovalPolicy(cdk.RemovalPolicy.DESTROY);

    new cdk.CfnOutput(this, 'FsId', { value: fs.ref });
    new cdk.CfnOutput(this, 'Mode', { value: mode });
  }
}
