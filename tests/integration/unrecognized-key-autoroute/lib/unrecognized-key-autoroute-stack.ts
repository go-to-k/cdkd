import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as sns from 'aws-cdk-lib/aws-sns';

/**
 * A top-level template key absent from cdkd's committed CFn schema snapshot
 * routes the resource through Cloud Control, which REJECTS a key the registry
 * schema does not know -- as CloudFormation does -- instead of the SDK route
 * dropping it while the deploy reports success (issue
 * [3713](https://github.com/go-to-k/cdkd/issues/3713)).
 *
 * covers: AWS::SNS::Topic
 *
 * WHY `AWS::SNS::Topic`. It has an SDK provider (a fresh deploy records
 * `provisionedBy: 'sdk'`), its Cloud Control route is available
 * (`ccRouteUnavailable: false`), its physical id is the TopicArn on BOTH
 * layers (so a Cloud Control UPDATE against an SDK-minted id is well formed),
 * it has a read-only attribute (`TopicArn`) for the exclusion arm, and it is
 * free and instant.
 *
 * `CdkdIntegUnknownKey` is a deliberate typo: no schema will ever carry it, so
 * the premise cannot rot the way a "not yet published" property would.
 *
 * Mode tokens in `CDKD_TEST_UPDATE` (comma-separated, cumulative -- every later
 * phase carries every earlier token, so nothing that exists is ever dropped):
 *   (none)   -- base: DisplayName v1, recognized properties only.
 *   typo     -- PLUS `CdkdIntegUnknownKey: v1` and DisplayName v2.
 *   display3 -- DisplayName v3; the key is unchanged. ZERO-REGRESSION arm.
 *   readonly -- PLUS a `TopicArn` override (the topic's own ARN) and
 *               DisplayName v4.
 *   fresh    -- PLUS a SECOND topic carrying the typo key from creation.
 *
 * Every phase that must reach a provider changes DisplayName: routing is
 * decided while PROVISIONING, so a NO_CHANGE resource never routes at all.
 */
export class UnrecognizedKeyAutorouteStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const updateMode = (process.env.CDKD_TEST_UPDATE ?? '').split(',').filter(Boolean);

    const displayName = updateMode.includes('readonly')
      ? 'cdkd-integ-v4'
      : updateMode.includes('display3')
        ? 'cdkd-integ-v3'
        : updateMode.includes('typo')
          ? 'cdkd-integ-v2'
          : 'cdkd-integ-v1';

    const topicName = `${this.stackName}-topic`;
    const topic = new sns.CfnTopic(this, 'Topic', { topicName, displayName });

    if (updateMode.includes('typo')) {
      topic.addPropertyOverride('CdkdIntegUnknownKey', 'v1');
    }

    if (updateMode.includes('readonly')) {
      // The topic's OWN ARN, built rather than referenced: `attrTopicArn`
      // would be a self-reference cycle. A read-only key must stay on the SDK
      // route whatever its value, since CloudFormation ignores one.
      topic.addPropertyOverride(
        'TopicArn',
        this.formatArn({
          service: 'sns',
          resource: topicName,
          arnFormat: cdk.ArnFormat.NO_RESOURCE_NAME,
        })
      );
    }

    if (updateMode.includes('fresh')) {
      // Never created: its CREATE is routed via Cloud Control and rejected.
      const fresh = new sns.CfnTopic(this, 'FreshTopic', {
        topicName: `${this.stackName}-fresh`,
        displayName: 'cdkd-integ-fresh',
      });
      fresh.addPropertyOverride('CdkdIntegUnknownKey', 'v1');
    }

    new cdk.CfnOutput(this, 'TopicArnOutput', { value: topic.ref });
  }
}
