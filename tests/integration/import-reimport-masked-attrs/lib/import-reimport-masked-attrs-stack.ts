import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Integ probe for issues #3735, #2925 and #2927: Cloud Control records an
 * `Fn::GetAtt` attribute that is also a writable property in the clear and
 * masks every other model key, on deploy as on import, and a
 * `cdkd import --resource <id>=<physicalId> --force` re-import never replaces
 * a good recorded attribute with the redaction mask.
 *
 * covers: AWS::StepFunctions::Activity
 * covers: AWS::SSM::Parameter
 *
 * WHY THIS TYPE. `AWS::StepFunctions::Activity` has no SDK provider, so both
 * the deploy and `cdkd import` go through Cloud Control. Its `Fn::GetAtt`
 * attribute `Name` is a WRITABLE property: the registry schema's
 * `readOnlyProperties` holds only `Arn`, so only the generated
 * resource-specification table (#3735) certifies `Name`. Its other writable
 * keys are not attributes and are masked by both paths (#2925), which is what
 * the #2927 phases exercise. An activity is free and creates and deletes instantly.
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
      // A writable NON-attribute key in the model the create returns, so the
      // deploy-side narrowing (#2925) has something to mask even when the
      // create event carries no `EncryptionConfiguration`.
      tags: [{ key: 'cdkd-integ', value: 'import-reimport-masked-attrs' }],
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
