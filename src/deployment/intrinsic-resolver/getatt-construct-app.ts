import type { IntrinsicFunctionResolver } from '../intrinsic-function-resolver.js';
import type { ResourceState } from '../../types/state.js';
import { type ResolverContext } from './support.js';
import { NOT_CONSTRUCTED } from './getatt-construct-core.js';
import {
  describeFailureObserved,
  guardedPhysicalIdFallback,
  refuseUnconstructibleAttribute,
  refuseUndefinedAttribute,
  refuseUnservedAttribute,
} from './getatt-refusals.js';
import { healBeforeConstructing } from './getatt-heal.js';
import { noteAttributeSecrecy } from './getatt.js';
import { graphQLSchemaCfnId } from './ref-values.js';
import { DescribeAvailabilityZonesCommand } from '@aws-sdk/client-ec2';
import { secretPhysicalIdSegment } from '../../provisioning/secret-physical-id.js';

/**
 * `constructAttribute`'s per-type handlers for AWS::Events::Rule through AWS::SNS::Topic, moved
 * verbatim and in order (issue #4337). Returns {@link NOT_CONSTRUCTED} when none
 * matched. Keep the `constructAttributeFor*` name and the `getatt-construct-*.ts`
 * file name: `scripts/gen-sdk-attr-coverage.ts` finds handled types by both.
 */
export async function constructAttributeForAppTypes(
  resolver: IntrinsicFunctionResolver,
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
        const busRaw = noteAttributeSecrecy(
          resolver,
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
      case 'RuleName':
        // go-to-k/cdkd#6242: the plain rule name, on a custom bus too
        // (measured against CloudFormation). The physical id is the rule ARN
        // (`rule/[<bus>/]<name>`), which the physical-id fallback served whole.
        return physicalId.startsWith('arn:')
          ? physicalId.slice(physicalId.lastIndexOf('/') + 1)
          : physicalId;
      default:
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
      case 'GraphQLEndpointArn':
      case 'RealtimeUrl': {
        // go-to-k/cdkd#6242, measured against CloudFormation: both are built
        // on the API's ENDPOINT id (the first label of its GraphQL host, not
        // the api id): `arn:...:appsync:<region>:<account>:endpoints/graphql-api/<id>`
        // and `wss://<id>.appsync-realtime-api.<region>.<suffix>/graphql`. The
        // provider records `RealtimeUrl`; both are read off the recorded
        // GraphQL host otherwise, else heal, then refuse.
        const host =
          typeof resource.attributes?.['GraphQLDns'] === 'string'
            ? (resource.attributes['GraphQLDns'] as string)
            : urlHost(resource.attributes?.['GraphQLUrl']);
        const match = host === undefined ? null : /^([a-z0-9]+)\.appsync-api\.(.+)$/.exec(host);
        if (match) {
          const [, endpointId, rest] = match;
          return attributeName === 'GraphQLEndpointArn'
            ? `arn:${partition}:appsync:${region}:${accountId}:endpoints/graphql-api/${endpointId}`
            : `wss://${endpointId}.appsync-realtime-api.${rest}/graphql`;
        }
        healBeforeConstructing(resolver, context);
        refuseUnconstructibleAttribute(resolver, {
          logicalId,
          attributeName,
          resourceType,
          context,
          why: "it is built on the endpoint id of the API's GraphQL host, which the record does not hold",
        });
      }
      case 'GraphQLDns':
      case 'RealtimeDns': {
        // go-to-k/cdkd#6242: the provider records both from AWS's `dns` map;
        // neither is built from the api id (measured: AppSync serves an
        // endpoint id of its own), which the physical-id fallback served.
        // A record written before that still holds `GraphQLUrl`, whose host
        // IS the GraphQL one; otherwise heal, then refuse.
        if (attributeName === 'GraphQLDns') {
          const host = urlHost(resource.attributes?.['GraphQLUrl']);
          if (host !== undefined) {
            return noteAttributeSecrecy(resolver, logicalId, attributeName, host, context);
          }
        }
        healBeforeConstructing(resolver, context);
        refuseUnconstructibleAttribute(resolver, {
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'AppSync serves the host under an endpoint id that is not the api id',
        });
      }
      default:
        return guardedPhysicalIdFallback(
          resolver,
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // go-to-k/cdkd#6242: the key id, read out of the physical id; the
  // fallback served the whole id.
  if (resourceType === 'AWS::AppSync::ApiKey' && attributeName === 'ApiKeyId') {
    // Both recorded forms: `<apiId>|<keyId>`, and the key ARN an earlier
    // record holds. The parser answers the WHOLE id for any other form.
    const keyId = secretPhysicalIdSegment(resourceType, physicalId);
    if (keyId !== undefined && keyId !== physicalId) return keyId;
    refuseUnconstructibleAttribute(resolver, {
      logicalId,
      attributeName,
      resourceType,
      context,
      why: 'the physical id is neither the `<apiId>|<keyId>` pair nor the key ARN it is read from',
    });
  }

  // AppSync GraphQLSchema: `Id` is the registry schema's primaryIdentifier,
  // so it takes the same value as its `Ref`, `<apiId>GraphQLSchema` (issue
  // #5540). CloudFormation itself never serves it: a stack reading it ended
  // `Internal Failure` with every resource created (measured 2026-10-30).
  if (resourceType === 'AWS::AppSync::GraphQLSchema' && attributeName === 'Id') {
    return graphQLSchemaCfnId(physicalId);
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
  // the real account, so a wrong account cannot be baked in here any more
  // than in the provider's own builder.
  if (resourceType === 'AWS::ApiGatewayV2::Api') {
    switch (attributeName) {
      case 'ExecuteApiArn':
        return `arn:${partition}:execute-api:${region}:${accountId}:${physicalId}`;
      case 'ApiId':
        return physicalId;
      default:
        return guardedPhysicalIdFallback(
          resolver,
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
          refuseUndefinedAttribute(resolver, {
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
          // (issue #1994). See `ResolverClients.serviceDiscoveryClient` for why this
          // one service is built here instead of read off the bag.
          const sd = await resolver.clients.serviceDiscoveryClient();
          const resp = await sd.send(new GetNamespaceCommand({ Id: physicalId }));
          hostedZoneId = resp.Namespace?.Properties?.DnsProperties?.HostedZoneId;
        } catch (err) {
          // Unmarked (time-dependent): a throttled or denied read can
          // succeed on a later attempt. AWS's text stays behind --verbose
          // (`describeFailureObserved`), since `NamespaceNotFound` can echo
          // a state-record id (issue #3479).
          refuseUnservedAttribute(resolver, {
            logicalId,
            attributeName,
            resourceType,
            physicalId,
            context,
            observed: describeFailureObserved(resolver, 'GetNamespace', err, context),
            remedy:
              'Fix the read (the servicediscovery:GetNamespace permission, or the region) and deploy again.',
          });
        }
        if (hostedZoneId) return hostedZoneId;
        refuseUnservedAttribute(resolver, {
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // AutoScaling group. go-to-k/cdkd#6242: CloudFormation's ARN attribute is
  // spelled `AutoScalingGroupARN`; the provider records the same ARN under
  // `Arn`. Its upper-case suffix also slipped past the physical-id fallback's
  // `*Arn` guard, which then served the group NAME.
  if (
    resourceType === 'AWS::AutoScaling::AutoScalingGroup' &&
    attributeName === 'AutoScalingGroupARN'
  ) {
    const recorded = resource.attributes?.['Arn'];
    if (typeof recorded === 'string' && recorded.startsWith('arn:')) {
      return noteAttributeSecrecy(resolver, logicalId, attributeName, recorded, context);
    }
    healBeforeConstructing(resolver, context);
    refuseUnconstructibleAttribute(resolver, {
      logicalId,
      attributeName,
      resourceType,
      context,
      why: 'its ARN carries a group id cdkd cannot build from the group name',
    });
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
      case 'DbiResourceId':
      case 'Endpoint.HostedZoneId':
      case 'ListenerEndpoint.Address':
      case 'ListenerEndpoint.Port':
      case 'ListenerEndpoint.HostedZoneId':
      case 'CertificateDetails.CAIdentifier':
      case 'CertificateDetails.ValidTill':
        // go-to-k/cdkd#6242: the RDS provider records these from the
        // instance it describes (`dbInstanceAttributes`); a record written
        // before that lacks them, so heal first. None can be built from the
        // instance identifier, which the physical-id fallback used to serve —
        // for `DbiResourceId` that put the identifier into `grantConnect`'s
        // `rds-db:connect` ARN.
        if (resourceType !== 'AWS::RDS::DBInstance') break;
        healBeforeConstructing(resolver, context);
        refuseUnconstructibleAttribute(resolver, {
          logicalId,
          attributeName,
          resourceType,
          context,
          why: 'cdkd cannot build it from the DB instance identifier',
          // A completed read that reports none: for a listener endpoint the
          // instance has none (only some configurations, such as SQL Server
          // Multi-AZ, do); otherwise it is not available yet.
          remedyWhenHealCompleted: attributeName.startsWith('ListenerEndpoint.')
            ? 'This DB instance has no listener endpoint, and CloudFormation cannot return one for it either: remove the reference, or use Endpoint.Address.'
            : 'RDS does not report it for the instance yet (it may still be creating): deploy again once the instance is available.',
        });
    }
    return guardedPhysicalIdFallback(
      resolver,
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context
    );
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
        return guardedPhysicalIdFallback(
          resolver,
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // S3 Express Directory Bucket
  // go-to-k/cdkd#6242: the bucket name carries the zone ID
  // (`<base>--<zone-id>--x-s3`); its NAME is account-specific, so it is read
  // live. The fallback served the bucket name. The LAST `--<zone-id>--x-s3`
  // is taken: a base name may itself contain `--`.
  if (
    resourceType === 'AWS::S3Express::DirectoryBucket' &&
    attributeName === 'AvailabilityZoneName'
  ) {
    const zoneId = /--([a-z0-9]+(?:-[a-z0-9]+)*)--x-s3$/.exec(physicalId)?.[1];
    if (zoneId === undefined) {
      refuseUnservedAttribute(resolver, {
        logicalId,
        attributeName,
        resourceType,
        physicalId,
        context,
        observed: 'the bucket name carries no --<zone-id>--x-s3 suffix',
        remedy: 'Check the directory bucket in the console.',
      });
    }
    let zoneName: string | undefined;
    try {
      const ec2 = resolver.clients.clientsForRegion(resolver.explicitRegion).ec2;
      const resp = await ec2.send(new DescribeAvailabilityZonesCommand({ ZoneIds: [zoneId] }));
      zoneName = resp.AvailabilityZones?.[0]?.ZoneName;
    } catch (err) {
      refuseUnservedAttribute(resolver, {
        logicalId,
        attributeName,
        resourceType,
        physicalId,
        context,
        observed: describeFailureObserved(resolver, 'DescribeAvailabilityZones', err, context),
        remedy:
          'Fix the read (the DescribeAvailabilityZones permission, or the region) and deploy again.',
      });
    }
    if (zoneName) return zoneName;
    refuseUnservedAttribute(resolver, {
      logicalId,
      attributeName,
      resourceType,
      physicalId,
      context,
      observed: 'DescribeAvailabilityZones returned no zone for that zone ID',
      remedy:
        'Check the directory bucket in the console, or reference the attribute from a later deploy.',
    });
  }

  if (resourceType === 'AWS::S3Express::DirectoryBucket') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:s3express:${region}:${accountId}:bucket/${physicalId}`;
      default:
        return guardedPhysicalIdFallback(
          resolver,
          logicalId,
          attributeName,
          resourceType,
          physicalId,
          context
        );
    }
  }

  // go-to-k/cdkd#6242: the provider records these from GetTable; a record
  // written before that lacks them, so heal first. Neither can be built.
  if (
    resourceType === 'AWS::S3Tables::Table' &&
    (attributeName === 'WarehouseLocation' || attributeName === 'VersionToken')
  ) {
    healBeforeConstructing(resolver, context);
    refuseUnconstructibleAttribute(resolver, {
      logicalId,
      attributeName,
      resourceType,
      context,
      why: 'only GetTable reports it',
    });
  }

  // Lambda Function
  if (resourceType === 'AWS::Lambda::Function') {
    switch (attributeName) {
      case 'Arn':
        return `arn:${partition}:lambda:${region}:${accountId}:function:${physicalId}`;
      default:
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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
        return guardedPhysicalIdFallback(
          resolver,
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

/**
 * The host of a recorded `https://<host>/...` URL, or `undefined` for any
 * other value, an unparseable one included (a hand-edited record must reach
 * the heal-then-refuse path, never a raw `TypeError`).
 */
function urlHost(value: unknown): string | undefined {
  if (typeof value !== 'string' || !/^https:\/\/[^/]+\//.test(value)) return undefined;
  try {
    return new URL(value).host;
  } catch {
    return undefined;
  }
}
