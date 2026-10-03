import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResourceState } from '../../types/state.js';
import { type ResolverContext } from './support.js';
import { NOT_CONSTRUCTED } from './getatt-construct-core.js';

/**
 * `constructAttribute`'s per-type handlers for AWS::Events::Rule through AWS::SNS::Topic, moved
 * verbatim and in order (issue #4337). Returns {@link NOT_CONSTRUCTED} when none
 * matched.
 */
export async function constructAttributeForAppTypes(
  this: IntrinsicFunctionResolver,
  resource: ResourceState,
  attributeName: string,
  context: ResolverContext,
  logicalId: string,
  resourceType: ResourceState['resourceType'],
  physicalId: ResourceState['physicalId'],
  accountId: string,
  partition: string,
  region: string
): Promise<unknown> {
  // EventBridge Rule. Custom event bus ARN: rule/{busName}/{ruleName};
  // default bus ARN: rule/{ruleName}. By the time constructAttribute runs,
  // properties.EventBusName (if templated) has been resolved to a literal
  // string or ARN by the deploy engine. Treat 'default' / unset as default bus.
  if (resourceType === 'AWS::Events::Rule') {
    switch (attributeName) {
      case 'Arn': {
        // The SDK provider stores the rule ARN as the physical id; only
        // construct an ARN when the stored id is a bare rule name.
        if (physicalId.startsWith('arn:')) {
          return physicalId;
        }
        // Noted before it is EMBEDDED (go-to-k/cdkd#2936's audit): the
        // built ARN holds a masked bus name as an inner span, which the
        // whole-leaf `carriesSecretMask` test cannot see, so the note has to
        // read the persisted leaf itself. Its OTHER half (a NoEcho-declared
        // resource's value becoming a mask-only needle) would therefore
        // register the bus name, not the built ARN; inert, since nothing
        // declares an Events rule NoEcho.
        const busRaw = this.noteAttributeSecrecy(
          logicalId,
          attributeName,
          resource.properties?.['EventBusName'],
          context
        );
        const bus = typeof busRaw === 'string' && busRaw && busRaw !== 'default' ? busRaw : '';
        // If EventBusName resolved to an ARN, extract the bus name segment
        const busName = bus.startsWith('arn:') ? bus.split('/').pop() || '' : bus;
        return busName
          ? `arn:${partition}:events:${region}:${accountId}:rule/${busName}/${physicalId}`
          : `arn:${partition}:events:${region}:${accountId}:rule/${physicalId}`;
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EventBridge EventBus
  if (resourceType === 'AWS::Events::EventBus') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:events:${region}:${accountId}:event-bus/${physicalId}`;
      case 'Name':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // EFS FileSystem
  if (resourceType === 'AWS::EFS::FileSystem') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:elasticfilesystem:${region}:${accountId}:file-system/${physicalId}`;
      case 'FileSystemId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Kinesis Data Firehose DeliveryStream
  if (resourceType === 'AWS::KinesisFirehose::DeliveryStream') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:firehose:${region}:${accountId}:deliverystream/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CodeBuild Project
  if (resourceType === 'AWS::CodeBuild::Project') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:codebuild:${region}:${accountId}:project/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudTrail Trail
  if (resourceType === 'AWS::CloudTrail::Trail') {
    switch (attributeName) {
      case 'Arn':
        // The SDK provider stores the trail ARN as the physical id; only
        // construct an ARN when the stored id is a bare trail name.
        if (physicalId.startsWith('arn:')) {
          return physicalId;
        }
        return `arn:${partition}:cloudtrail:${region}:${accountId}:trail/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // AppSync GraphQLApi (physicalId is the apiId)
  if (resourceType === 'AWS::AppSync::GraphQLApi') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:appsync:${region}:${accountId}:apis/${physicalId}`;
      case 'ApiId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // `AWS::ApiGatewayV2::Api` (physicalId is the bare api id). The provider
  // RECORDS `ExecuteApiArn` on create / import / update (issue
  // [#2833](https://github.com/go-to-k/cdkd/issues/2833)), so the cached-attribute
  // read above answers for every resource cdkd has touched since. This
  // branch is for the ones it has NOT: a record written by an earlier
  // binary carries no `ExecuteApiArn`, and an API whose own properties are
  // unchanged diffs NO_CHANGE, so `update()` never runs and the heal never
  // fires — the HEADLINE case, since adding an `Fn::GetAtt` to a consumer
  // changes the consumer, not the API. Without this the read reached
  // `guardedPhysicalIdFallback`, which hard-throws on an `*Arn` whose
  // fallback is a bare api id (the #1179 class), and told the user to file
  // an issue for an attribute cdkd can construct from what it already holds.
  // Constructed rather than fetched: no ApiGatewayV2 API returns this ARN.
  // `constructGuardedAttribute` refuses the result when STS did not report
  // the real account, so a fabricated account cannot be baked in here any
  // more than in the provider's own builder.
  if (resourceType === 'AWS::ApiGatewayV2::Api') {
    switch (attributeName) {
      case 'ExecuteApiArn':
        return `arn:${partition}:execute-api:${region}:${accountId}:${physicalId}`;
      case 'ApiId':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ServiceDiscovery namespaces (physicalId is the namespace id). All
  // three kinds share the ARN shape; the DNS kinds additionally expose
  // `HostedZoneId` (the Route 53 hosted zone AWS creates alongside the
  // namespace), which is NOT constructible — fetch it live and REFUSE on a
  // miss rather than falling back to the namespace id (a silently wrong
  // value baked into dependent resources) or answering `undefined` (which a
  // `Fn::Join` / `Fn::Sub` rendered as the text `undefined`, issue #4077).
  // `HttpNamespace` has no `HostedZoneId` in the CloudFormation schema.
  if (
    resourceType === 'AWS::ServiceDiscovery::PrivateDnsNamespace' ||
    resourceType === 'AWS::ServiceDiscovery::HttpNamespace' ||
    resourceType === 'AWS::ServiceDiscovery::PublicDnsNamespace'
  ) {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:servicediscovery:${region}:${accountId}:namespace/${physicalId}`;
      case 'Id':
        return physicalId;
      case 'HostedZoneId': {
        if (resourceType === 'AWS::ServiceDiscovery::HttpNamespace') {
          this.refuseUndefinedAttribute({
            logicalId,
            attributeName,
            resourceType,
            context,
            defined: 'Arn, Id',
          });
        }
        let hostedZoneId: string | undefined;
        try {
          const { GetNamespaceCommand } = await import('@aws-sdk/client-servicediscovery');
          // Region-sensitive: a namespace id only resolves in its own region
          // (issue #1994). See {@link serviceDiscoveryClient} for why this
          // one service is built here instead of read off the bag.
          const sd = await this.serviceDiscoveryClient();
          const resp = await sd.send(new GetNamespaceCommand({ Id: physicalId }));
          hostedZoneId = resp.Namespace?.Properties?.DnsProperties?.HostedZoneId;
        } catch (err) {
          // Unmarked (time-dependent): a throttled or denied read can
          // succeed on a later attempt. AWS's text stays behind --verbose
          // (`describeFailureObserved`), since `NamespaceNotFound` can echo
          // a state-record id (issue #3479).
          this.refuseUnservedAttribute({
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: this.describeFailureObserved('GetNamespace', err, context),
            remedy:
              'Fix the read (the servicediscovery:GetNamespace permission, or the region) and deploy again.',
          });
        }
        if (hostedZoneId) return hostedZoneId;
        this.refuseUnservedAttribute({
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context,
          observed: 'GetNamespace reported no DnsProperties.HostedZoneId for the namespace',
          remedy: 'Check the namespace in the Cloud Map console, and deploy again.',
        });
      }
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // ServiceDiscovery Service (physicalId is the service id)
  if (resourceType === 'AWS::ServiceDiscovery::Service') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:servicediscovery:${region}:${accountId}:service/${physicalId}`;
      case 'Id':
        return physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudWatch Alarm (note: 'alarm:' separator, not '/')
  if (resourceType === 'AWS::CloudWatch::Alarm') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // CloudWatch CompositeAlarm. CompositeAlarm has no SDK provider, so it is
  // routed via the Cloud Control API; its `Arn` is not always captured in
  // attributes, so synthesize it here. The ARN format is identical to a
  // metric alarm (`:alarm:<AlarmName>`), so it is fully derivable from the
  // physical id (the alarm name) — no AWS call is needed.
  if (resourceType === 'AWS::CloudWatch::CompositeAlarm') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:cloudwatch:${region}:${accountId}:alarm:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBInstance (DocDB and Neptune share the same rds: service prefix and db: separator)
  if (
    resourceType === 'AWS::RDS::DBInstance' ||
    resourceType === 'AWS::DocDB::DBInstance' ||
    resourceType === 'AWS::Neptune::DBInstance'
  ) {
    switch (attributeName) {
      case 'DBInstanceArn':
      case 'Arn':
        return `arn:${partition}:rds:${region}:${accountId}:db:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // RDS DBCluster (DocDB and Neptune share the same rds: service prefix and cluster: separator)
  if (
    resourceType === 'AWS::RDS::DBCluster' ||
    resourceType === 'AWS::DocDB::DBCluster' ||
    resourceType === 'AWS::Neptune::DBCluster'
  ) {
    switch (attributeName) {
      case 'DBClusterArn':
      case 'Arn':
        return `arn:${partition}:rds:${region}:${accountId}:cluster:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // S3 Express Directory Bucket
  if (resourceType === 'AWS::S3Express::DirectoryBucket') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:s3express:${region}:${accountId}:bucket/${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // Lambda Function
  if (resourceType === 'AWS::Lambda::Function') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:lambda:${region}:${accountId}:function:${physicalId}`;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // SQS Queue
  if (resourceType === 'AWS::SQS::Queue') {
    // Physical ID for SQS Queue is the queue URL
    // Extract queue name from URL: https://sqs.region.amazonaws.com/accountId/queueName
    let queueName = physicalId;
    if (physicalId.startsWith('https://')) {
      const parts = physicalId.split('/');
      queueName = parts[parts.length - 1] || physicalId;
    }

    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:sqs:${region}:${accountId}:${queueName}`;
      case 'QueueUrl':
        return physicalId; // Physical ID is already the queue URL
      case 'QueueName':
        return queueName;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // SNS Topic
  if (resourceType === 'AWS::SNS::Topic') {
    switch (attributeName) {
      // `SNSTopicProvider` and Cloud Control both record the topic ARN as
      // the physical id; a bare NAME is kept for any record that holds one.
      // Reading an ARN as a name served a doubled ARN and an ARN-valued
      // `TopicName`, with no warning (issue #3627).
      case 'TopicArn':
        return physicalId.startsWith('arn:')
          ? physicalId
          : `arn:${partition}:sns:${region}:${accountId}:${physicalId}`;
      case 'TopicName':
        return physicalId.startsWith('arn:') ? physicalId.split(':').pop() : physicalId;
      default:
        return this.guardedPhysicalIdFallback(
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }
  return NOT_CONSTRUCTED;
}
