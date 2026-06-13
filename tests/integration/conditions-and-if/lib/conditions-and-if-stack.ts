import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * CloudFormation Conditions + Fn::If stress fixture for cdkd.
 *
 * This stack is designed to SURFACE bugs in cdkd's own evaluation of the
 * `Conditions` section + the resource-level `Condition:` key + the
 * `Fn::If` / `Fn::Equals` / `Fn::And` / `Fn::Or` / `Fn::Not` intrinsics
 * (cdkd must evaluate all of these itself — there is no CloudFormation
 * engine underneath it).
 *
 * It goes BEYOND the existing `conditions` fixture, which only exercised a
 * single `Fn::And` + a conditionally-created S3 bucket + an Fn::If bucket
 * name. This fixture covers the gaps:
 *
 *   1. A `Conditions` section combining `Fn::Equals` with `Fn::And`,
 *      `Fn::Or`, AND `Fn::Not` (the existing fixture had no Or / Not).
 *   2. A resource (`PremiumOnlyParam`) carrying a `Condition:` so it is
 *      CREATED in one parameter setting and ABSENT in another — verified
 *      against AWS in BOTH settings (presence + absence).
 *   3. `Fn::If` inside a resource PROPERTY whose resolved branch differs
 *      by condition (`TierLabelParam`'s `Value`) — the value that reaches
 *      AWS is asserted to be the correct branch.
 *   4. `Fn::If` selecting `AWS::NoValue` to OMIT a property (the SNS topic's
 *      `DisplayName`) in one setting and SET it in the other — verified
 *      genuinely absent vs present on AWS.
 *
 * Drive: the `Tier` CfnParameter default is sourced from CDK context
 * (`-c tier=premium|basic`), so flipping the context between two `cdkd
 * deploy` runs flips every condition without a deploy-time --parameter flag
 * (cdkd has none; parameters resolve from the template Default at synth).
 */
export class ConditionsAndIfStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // The tier is read from CDK context at synth time and baked into the
    // CfnParameter's Default. cdkd resolves parameters from the template
    // Default (no --parameter override flag exists), so flipping
    // `-c tier=...` between deploys is the param-flip mechanism.
    const tierFromContext = (this.node.tryGetContext('tier') as string) ?? 'basic';

    const tierParam = new cdk.CfnParameter(this, 'Tier', {
      type: 'String',
      default: tierFromContext,
      allowedValues: ['basic', 'premium'],
      description: 'Service tier — drives every condition in this stack',
    });

    const regionParam = new cdk.CfnParameter(this, 'TargetRegionLabel', {
      type: 'String',
      default: this.node.tryGetContext('regionLabel') ?? 'primary',
      allowedValues: ['primary', 'secondary'],
      description: 'Region label — second axis for And/Or/Not conditions',
    });

    // ---- Conditions section -------------------------------------------
    // Fn::Equals on a CfnParameter.
    const isPremium = new cdk.CfnCondition(this, 'IsPremium', {
      expression: cdk.Fn.conditionEquals(tierParam.valueAsString, 'premium'),
    });

    const isPrimaryRegion = new cdk.CfnCondition(this, 'IsPrimaryRegion', {
      expression: cdk.Fn.conditionEquals(regionParam.valueAsString, 'primary'),
    });

    // Fn::Not — "is NOT primary region" (true for secondary).
    const isSecondaryRegion = new cdk.CfnCondition(this, 'IsSecondaryRegion', {
      expression: cdk.Fn.conditionNot(isPrimaryRegion),
    });

    // Fn::And — premium AND primary region.
    const isPremiumPrimary = new cdk.CfnCondition(this, 'IsPremiumPrimary', {
      expression: cdk.Fn.conditionAnd(isPremium, isPrimaryRegion),
    });

    // Fn::Or — premium OR secondary region. With the basic+primary default
    // this is false; with premium (any region) OR basic+secondary it is
    // true. The premium-default deploy makes it true via the premium arm,
    // exercising Or's short-circuit-to-true on the FIRST arm.
    const isPremiumOrSecondary = new cdk.CfnCondition(this, 'IsPremiumOrSecondary', {
      expression: cdk.Fn.conditionOr(isPremium, isSecondaryRegion),
    });

    // ---- Resource always created -------------------------------------
    // Its Value uses Fn::If on isPremium: asserts the resolved branch
    // (premium vs basic) reaches AWS. Also exercises Fn::If nested inside
    // a string via the value.
    const tierLabelParam = new ssm.CfnParameter(this, 'TierLabelParam', {
      type: 'String',
      name: `/cdkd-conditions-if/${this.account}/tier-label`,
      value: cdk.Fn.conditionIf(isPremium.logicalId, 'tier-is-premium', 'tier-is-basic').toString(),
      description: 'Always created; Value is an Fn::If branch result',
    });

    // ---- Resource with a Condition: (premium-only) -------------------
    // Created only when isPremium is true; ABSENT otherwise. This is the
    // condition-gated resource-creation case.
    const premiumOnlyParam = new ssm.CfnParameter(this, 'PremiumOnlyParam', {
      type: 'String',
      name: `/cdkd-conditions-if/${this.account}/premium-only`,
      value: 'present-only-in-premium',
      description: 'Created ONLY when the IsPremium condition is true',
    });
    premiumOnlyParam.cfnOptions.condition = isPremium;

    // ---- Resource with a compound-condition Condition: ---------------
    // Gated on the Fn::And condition (premium AND primary). With the
    // premium+primary deploy this is created; with basic+primary or
    // premium+secondary it is absent. Exercises a resource keyed off an
    // And condition (not just a bare Equals).
    const premiumPrimaryParam = new ssm.CfnParameter(this, 'PremiumPrimaryParam', {
      type: 'String',
      name: `/cdkd-conditions-if/${this.account}/premium-primary`,
      value: 'premium-and-primary',
      description: 'Created ONLY when IsPremiumPrimary (Fn::And) is true',
    });
    premiumPrimaryParam.cfnOptions.condition = isPremiumPrimary;

    // ---- Fn::If -> AWS::NoValue property omission --------------------
    // The SNS topic's DisplayName is SET in premium and OMITTED (NoValue)
    // in basic. Verify genuinely absent vs present on AWS.
    const topic = new sns.CfnTopic(this, 'NotificationTopic', {
      displayName: cdk.Fn.conditionIf(
        isPremium.logicalId,
        'Premium Notifications',
        cdk.Aws.NO_VALUE
      ).toString(),
      tags: [
        {
          key: 'Tier',
          // Another Fn::If property-value branch, on a tag value.
          value: cdk.Fn.conditionIf(isPremium.logicalId, 'premium', 'basic').toString(),
        },
        {
          // A tag whose value reflects the Fn::Or condition.
          key: 'PremiumOrSecondary',
          value: cdk.Fn.conditionIf(isPremiumOrSecondary.logicalId, 'yes', 'no').toString(),
        },
      ],
    });

    // ---- Outputs (with conditional values) ---------------------------
    new cdk.CfnOutput(this, 'TierLabelParamName', {
      value: tierLabelParam.ref,
      description: 'Name of the always-created tier-label SSM parameter',
    });

    new cdk.CfnOutput(this, 'TopicArn', {
      value: topic.ref,
      description: 'ARN of the SNS topic',
    });

    new cdk.CfnOutput(this, 'PremiumOnlyParamName', {
      value: cdk.Fn.conditionIf(
        isPremium.logicalId,
        premiumOnlyParam.ref,
        'not-created-in-basic-tier'
      ).toString(),
      description: 'Premium-only SSM parameter name (conditional)',
    });
  }
}
