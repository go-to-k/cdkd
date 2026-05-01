import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Minimal stack for the legacy-state-migration integration test.
 *
 * The test seeds a `version: 1` state.json at the legacy
 * `cdkd/{stackName}/state.json` key in S3, then runs `cdkd deploy`. cdkd is
 * expected to (a) read the legacy state, (b) write the new state at
 * `cdkd/{stackName}/{region}/state.json` with `version: 2`, and (c) delete
 * the legacy key — all while still successfully deploying this stack.
 *
 * A single SSM Parameter is enough: it's free, fast to create/destroy, and
 * doesn't require special IAM beyond what the integ harness already grants.
 */
export class LegacyMigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    new ssm.StringParameter(this, 'Marker', {
      parameterName: `${this.stackName}-marker`,
      stringValue: 'legacy-state-migration-fixture',
      description: 'Sentinel parameter used by the legacy-state-migration integ test',
    });
  }
}
