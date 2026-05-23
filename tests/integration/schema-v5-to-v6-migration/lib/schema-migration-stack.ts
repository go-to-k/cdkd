import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { Construct } from 'constructs';

/**
 * Schema v5 → v6 migration integ fixture (issue #459 prep PR). A minimal
 * single-stack, single-resource CDK app — just enough to exercise the
 * cdkd state-write / state-read path against real AWS. The integ runs
 * `cdkd deploy` first under the latest v5 published binary
 * (`@go-to-k/cdkd@0.139.0`) to produce a `version: 5` state file, then
 * runs `cdkd deploy` again under the local v6 binary to verify
 * (a) the v6 reader auto-migrates the v5 state silently and
 * (b) the next write persists `version: 6` cleanly.
 *
 * SSM Parameter is the cheapest, fastest cdkd-supported resource —
 * one synchronous API call to create + delete, no eventual-consistency
 * window, no IAM dependencies, no per-region quirks. The string value
 * carries a timestamp suffix so a re-run after a flaky destroy doesn't
 * collide on `cdkd state destroy` cleanup.
 */
export class SchemaMigrationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `CDKD_TEST_SCHEMA_PHASE` env var lets `verify.sh` toggle the
    // parameter value between Phase 1 (deploy with v5 binary) and Phase 3
    // (re-deploy with v6 binary) so the v6-binary deploy ACTUALLY writes
    // state. Without a real change, cdkd's deploy short-circuits with
    // "No changes detected. Stack is up to date." and skips the state
    // write entirely — leaving the on-disk version at 5 and breaking
    // the integ's transparent-auto-migration assertion. Phase 2's
    // read-only `state show` correctly leaves the v5 state in place
    // (read-only never writes); Phase 3 needs an actual update to
    // exercise the write path.
    const phase = process.env['CDKD_TEST_SCHEMA_PHASE'] ?? 'v5';

    new ssm.StringParameter(this, 'MigrationProbe', {
      parameterName: '/cdkd/schema-v5-to-v6-migration/probe',
      stringValue: `cdkd schema v5 -> v6 migration probe (phase=${phase})`,
      description: 'Created by tests/integration/schema-v5-to-v6-migration',
    });
  }
}
