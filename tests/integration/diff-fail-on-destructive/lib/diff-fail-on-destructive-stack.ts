import * as cdk from 'aws-cdk-lib';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

/**
 * Three SSM parameters whose changes cover each class `cdkd diff
 * --fail-on=destructive` and `cdkd deploy --require-approval=destructive`
 * tell apart (issue #4429). `CDKD_TEST_UPDATE` selects the phase:
 *
 * - unset: the baseline.
 * - `inplace`: `InPlace`'s value changes, an in-place update (not destructive).
 * - `destructive`: the same, plus `Renamed`'s `Name` changes (create-only, so a
 *   replacement) and the RETAIN parameter `Kept` leaves the template (an
 *   orphaning).
 *
 * covers: AWS::SSM::Parameter
 */
export class DiffFailOnDestructiveStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const mode = process.env.CDKD_TEST_UPDATE ?? '';
    const updated = mode === 'inplace' || mode === 'destructive';
    const destructive = mode === 'destructive';

    new ssm.StringParameter(this, 'InPlace', {
      parameterName: '/cdkd-integ/fail-on/inplace',
      stringValue: updated ? 'v2' : 'v1',
    });

    new ssm.StringParameter(this, 'Renamed', {
      parameterName: destructive ? '/cdkd-integ/fail-on/renamed-b' : '/cdkd-integ/fail-on/renamed-a',
      stringValue: 'renamed',
    });

    if (!destructive) {
      const kept = new ssm.StringParameter(this, 'Kept', {
        parameterName: '/cdkd-integ/fail-on/kept',
        stringValue: 'kept',
      });
      // RETAIN as a decision: removing it from the template must orphan it.
      kept.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN);
    }
  }
}
