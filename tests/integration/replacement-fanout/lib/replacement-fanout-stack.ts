import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';

/**
 * Replacement FAN-OUT example stack (issue #807, fan-out scale).
 *
 * #807 fixed the basic replacement-propagation case (ECS service picks up a
 * replaced TaskDefinition's new revision). This fixture stresses the SAME
 * propagation at FAN-OUT scale: ONE base resource that gets a NEW physical id
 * on replacement, referenced by MANY (10) dependents via `Fn::Sub` of its
 * `Ref`. cdkd's `promoteReplacementDependents` (src/analyzer/diff-calculator.ts)
 * must propagate the replacement to EVERY one of those dependents so each
 * re-resolves to the NEW base value — not the stale phase-a value.
 *
 * Phase flip via `-c phase=a|b` (read at synth time so a second deploy with
 * `-c phase=b` synthesizes the mutated template with no code change):
 *
 *   Base (replaced on phase b):
 *     - AWS::SNS::Topic  `TopicName` suffix `-a` -> `-b`. `TopicName` is in the
 *       SNS entry of cdkd's replacement-rules registry, so the rename forces
 *       delete + recreate -> a NEW topic ARN (SNS `Ref` resolves to the ARN).
 *
 *   Dependents (10x, each must pick up the new ARN):
 *     - 10x AWS::SSM::Parameter  `Value` = `Fn::Sub`("<arn>|idx=N", { arn: Ref(topic) }).
 *       Auto-named (no explicit `Name`), so the `Value` change is an IN-PLACE
 *       update on the SAME parameter physical id — only the resolved ARN inside
 *       changes. On phase b every parameter's Value must carry the NEW topic ARN.
 *
 *   Extra dependent (different reference shape / type):
 *     - 1x AWS::SNS::TopicPolicy  whose policy document `Resource` is the topic
 *       ARN via `Ref(topic)`. Must re-point at the new topic on phase b.
 *
 * All resources are cheap and free (SNS topic + SSM String parameters + a topic
 * policy). No VPC.
 */
export class ReplacementFanoutStack extends cdk.Stack {
  // Number of SSM Parameter dependents fanning out from the single base topic.
  // Kept >= 8 (issue #807 fan-out goal: "8-12 dependents").
  static readonly DEPENDENT_COUNT = 10;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // `-c phase=a` (default) vs `-c phase=b`. Anything other than 'b' is phase a.
    const phase = this.node.tryGetContext('phase') === 'b' ? 'b' : 'a';

    // --- Base: SNS Topic with an explicit, phase-keyed name --------------
    // TopicName is a replacement property for AWS::SNS::Topic, so flipping the
    // suffix forces delete + recreate -> a new topic ARN. The name is derived
    // from the (stable across deploys) region so it is unique per account/region
    // without a random suffix that would itself churn every synth.
    const topic = new sns.Topic(this, 'BaseTopic', {
      topicName: `cdkd-replacement-fanout-${this.region}-${phase}`,
    });

    // --- Dependents: N SSM Parameters each Fn::Sub'ing the topic Ref -----
    // Each parameter is AUTO-NAMED (no explicit Name) so it keeps its physical
    // id across the phase flip; only the resolved ARN inside Value changes. The
    // Value embeds the index so a parameter that kept a STALE ARN is trivially
    // attributable in verify.sh ("dependent N kept the phase-a ARN").
    for (let i = 0; i < ReplacementFanoutStack.DEPENDENT_COUNT; i++) {
      const param = new ssm.StringParameter(this, `Dependent${i}`, {
        // `${topic.topicArn}` synthesizes to a Fn::Sub embedding Ref(topic).
        stringValue: `arn=${topic.topicArn}|idx=${i}`,
      });
      new cdk.CfnOutput(this, `Dependent${i}Name`, { value: param.parameterName });
    }

    // --- Extra dependent: a different reference shape + type -------------
    // The topic policy's Resource is the topic ARN via Ref(topic). On phase b
    // it must re-point at the new topic (CloudFormation would replace the
    // policy's target; cdkd must update it to reference the new topic).
    const topicPolicy = new sns.TopicPolicy(this, 'BaseTopicPolicy', {
      topics: [topic],
    });
    topicPolicy.document.addStatements(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowPublishFromAccount',
        actions: ['sns:Publish'],
        principals: [new cdk.aws_iam.AccountRootPrincipal()],
        resources: [topic.topicArn],
      })
    );

    // --- Outputs the verify.sh queries ----------------------------------
    new cdk.CfnOutput(this, 'BaseTopicArn', { value: topic.topicArn });
    new cdk.CfnOutput(this, 'BaseTopicName', {
      value: `cdkd-replacement-fanout-${this.region}-${phase}`,
    });
    new cdk.CfnOutput(this, 'DependentCount', {
      value: String(ReplacementFanoutStack.DEPENDENT_COUNT),
    });
  }
}
