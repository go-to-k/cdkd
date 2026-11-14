import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sns from 'aws-cdk-lib/aws-sns';
import type { Construct } from 'constructs';

/**
 * Issue #6242, measured against CloudFormation: `trail.trailSnsTopicArn`
 * (`Fn::GetAtt [Trail, SnsTopicArn]`) is the notified topic's ARN, and an
 * AppSync API's `GraphQLEndpointArn` / `RealtimeUrl` are built on its ENDPOINT
 * id (the first label of its GraphQL host), not its api id. Before, the trail
 * attribute fell back to the trail's own ARN and the AppSync two were refused.
 * Under `CDKD_TEST_UPDATE=true` the trail notifies a second topic, so the
 * recorded `SnsTopicArn` must follow the update.
 *
 * covers: AWS::CloudTrail::Trail
 * covers: AWS::AppSync::GraphQLApi
 */
export class GetattCloudtrailAppsyncStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const isUpdate = process.env.CDKD_TEST_UPDATE === 'true';

    const first = new sns.Topic(this, 'TopicA', { topicName: `${id}-a` });
    const second = new sns.Topic(this, 'TopicB', { topicName: `${id}-b` });
    const bucket = new s3.Bucket(this, 'TrailBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const trail = new cloudtrail.Trail(this, 'Trail', {
      trailName: `${id}-trail`,
      bucket,
      snsTopic: isUpdate ? second : first,
      isMultiRegionTrail: false,
      includeGlobalServiceEvents: false,
    });

    const api = new appsync.CfnGraphQLApi(this, 'Api', { name: `${id}-api`, authenticationType: 'API_KEY' });

    new cdk.CfnOutput(this, 'TrailSnsTopicArn', { value: trail.trailSnsTopicArn! });
    new cdk.CfnOutput(this, 'ApiId', { value: api.attrApiId });
    new cdk.CfnOutput(this, 'GraphQLEndpointArn', { value: api.attrGraphQlEndpointArn });
    new cdk.CfnOutput(this, 'RealtimeUrl', { value: api.attrRealtimeUrl });
  }
}
