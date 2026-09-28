import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for issue #2927: a `cdkd import --resource <id>=<physicalId>
 * --force` re-import of a Cloud-Control-routed resource must not replace a
 * good recorded attribute with the redaction mask.
 *
 * covers: AWS::StepFunctions::Activity
 * covers: AWS::SSM::Parameter
 *
 * WHY THIS TYPE. `AWS::StepFunctions::Activity` has no SDK provider, so both
 * the deploy and `cdkd import` go through Cloud Control. Its `Fn::GetAtt`
 * attribute `Name` is a WRITABLE property: the registry schema's
 * `readOnlyProperties` holds only `Arn` (issue #3735 is the general gap), so
 * `CloudControlProvider.import` masks `Name`, while the deploy path records the
 * whole model, `Name` included (issue #2925). An activity is free and creates
 * and deletes instantly.
 *
 * The SSM parameter is the CONSUMER: its `Value` reads `Fn::GetAtt [Act, Name]`,
 * so a masked `Name` in state makes its next update fail with the
 * redacted-attribute refusal. Its `Description` follows the `phase` context
 * value so verify.sh can force that update without touching the activity.
 */
export class ImportReimportMaskedAttrsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const phase = String(this.node.tryGetContext('phase') ?? '1');

    const activity = new sfn.CfnActivity(this, 'Act', {
      name: 'cdkd-import-reimport-masked-attrs-activity',
    });
    // Pinned so verify.sh can pass `--resource Act=<arn>` and index state.
    activity.overrideLogicalId('Act');

    const param = new ssm.CfnParameter(this, 'NameParam', {
      name: '/cdkd-integ/import-reimport-masked-attrs/activity-name',
      type: 'String',
      value: activity.attrName,
      description: `cdkd issue 2927 consumer, phase ${phase}`,
    });
    param.overrideLogicalId('NameParam');
  }
}
