import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Schema v6 → v7 migration integ fixture (issue #614). A minimal
 * single-stack, single-resource CDK app — just enough to exercise the
 * cdkd state-write / state-read path against real AWS. The integ runs
 * `cdkd deploy` first under the latest v6 published binary so AWS has a
 * real resource AND cdkd S3 state is written as `version: 6` with no
 * `provisionedBy` field on the resource. Then runs `cdkd deploy` again
 * under the local v7 binary to verify:
 *   (a) the v7 reader auto-migrates the v6 state silently
 *   (b) the next write persists `version: 7` cleanly
 *   (c) the resource gets `provisionedBy: 'sdk'` recorded explicitly
 *       (legacy default — the SSM Parameter has no silent-drop
 *        properties, so the auto-route does not fire)
 *
 * SSM Parameter is the cheapest, fastest cdkd-supported resource — one
 * synchronous API call to create + delete, no eventual-consistency
 * window, no IAM dependencies. Same shape as
 * `tests/integration/schema-v5-to-v6-migration` (consistent integ
 * skeleton for every schema bump).
 */
export class SchemaMigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `CDKD_TEST_SCHEMA_PHASE` env var lets `verify.sh` toggle the
    // parameter value between Phase 1 (deploy with v6 binary) and Phase 3
    // (re-deploy with v7 binary) so the v7-binary deploy ACTUALLY writes
    // state. Without a real change, cdkd's deploy short-circuits with
    // "No changes detected. Stack is up to date." and skips the state
    // write entirely — leaving the on-disk version at 6 and breaking
    // the integ's transparent-auto-migration assertion. Phase 2's
    // read-only `state show` correctly leaves the v6 state in place
    // (read-only never writes); Phase 3 needs an actual update to
    // exercise the write path.
    const phase = process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'v6';

    new ssm.StringParameter(this, 'MigrationProbe', {
      parameterName: '/cdkd/schema-v6-to-v7-migration/probe',
      stringValue: `cdkd schema v6 -> v7 migration probe (phase=${phase})`,
      description: 'Created by tests/integration/schema-v6-to-v7-migration',
    });
  }
}
