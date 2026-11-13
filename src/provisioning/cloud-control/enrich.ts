import type { CloudControlProvider } from '../cloud-control-provider.js';
import { dbInstanceAttributes } from '../providers/rds/instance-attributes.js';
import { DescribeTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DescribeDBClustersCommand,
  DescribeDBInstancesCommand,
  RDSClient,
} from '@aws-sdk/client-rds';
import { GetRestApiCommand } from '@aws-sdk/client-api-gateway';
import { GetCloudFrontOriginAccessIdentityCommand } from '@aws-sdk/client-cloudfront';
import { GetFunctionUrlConfigCommand } from '@aws-sdk/client-lambda';
import {
  DescribeConnectionCommand,
  DescribeApiDestinationCommand,
} from '@aws-sdk/client-eventbridge';
import { DescribeReplicationGroupsCommand, ElastiCacheClient } from '@aws-sdk/client-elasticache';
import { DescribeClustersCommand, RedshiftClient } from '@aws-sdk/client-redshift';
import { DescribeDomainCommand, OpenSearchClient } from '@aws-sdk/client-opensearch';
import { canonicalizeRegion, derivePartitionAndUrlSuffix } from '../../utils/aws-partition.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { s3BucketArn } from '../../utils/s3-endpoints.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import type { IdLogSink } from './id-log.js';

/**
 * Enrich resource attributes with computed values
 *
 * This method adds fallback attributes for edge cases where CC API
 * may not return certain values.
 *
 * It passes every other key through AS-IS and sees the WHOLE resource
 * model: its gates read attributes, and some compute from the model. The
 * narrowing to `Fn::GetAtt` attributes happens AFTER it, in
 * {@link maskDeployedNonAttributeKeys} (issue #2925), so a computed value
 * is built from real inputs and a key it adds is never masked.
 */
export async function enrichResourceAttributes(
  this: CloudControlProvider,
  resourceType: string,
  physicalId: string,
  attributes: Record<string, unknown>,
  log: IdLogSink = this.logger
): Promise<Record<string, unknown>> {
  const enriched: Record<string, unknown> = { ...attributes };

  // Fallback: compute attributes that CC API may not return
  switch (resourceType) {
    case 'AWS::S3::Bucket':
      // S3 bucket ARN: arn:<partition>:s3:::bucket-name. The partition comes
      // from the CC client's own region through the same builder the SDK
      // `S3BucketProvider` records with (issue #1794), so the two routes
      // cannot record different ARNs for one template. A bucket ARN has no
      // account field, so no STS round trip is needed. Best-effort like the
      // KMS / ECR arms: the bucket already exists, so a region that cannot be
      // read leaves `Arn` ABSENT rather than failing the create.
      if (!enriched['Arn']) {
        try {
          enriched['Arn'] = s3BucketArn(physicalId, await this.cloudControlClient.config.region());
        } catch (error) {
          log.debug(
            `Failed to construct S3 Bucket Arn for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::RDS::DBCluster':
      // Issue #381: CC API's progressEvent.ResourceModel for RDS DBCluster
      // doesn't reliably surface Endpoint / Port / ReaderEndpoint until
      // the cluster reaches `available` AND a writer instance attaches.
      // Even when it does surface them, the shape is `Endpoint: <string>`
      // (NOT nested `Endpoint: { Address, Port }` as the CFn schema would
      // suggest). CDK's `Connections.allowDefaultPortFrom(...)` emits
      // `AWS::EC2::SecurityGroupIngress` rules with
      // `Fn::GetAtt: [<Cluster>, 'Endpoint.Port']` — pre-fix the resolver
      // fell through to `physicalId` and AWS rejected with
      // `Invalid integer value <cluster-id>`. Match the SDK provider's
      // flat-key shape (`'Endpoint.Port': '3306'`, `'Endpoint.Address':
      // '...'`, `'ReadEndpoint.Address': '...'`) by calling
      // `DescribeDBClusters` once after create and overlaying the
      // flat-key attributes. Best-effort: a failed Describe (e.g.
      // permissions gap) falls back to the unchanged CC-API attribute
      // shape, and `Fn::GetAtt` consumers will then hit the resolver's
      // own nested-path walk (Issue #381 part 1, same PR) — which still
      // misses for the not-nested-object case but at least doesn't
      // crash. The double-defence is intentional: enrichment populates
      // the canonical shape for the happy path; the resolver fallback
      // catches CC-API responses that DO have nested objects.
      try {
        // CC API client uses the cdkd-resolved region; the RDSClient
        // inherits via env / profile, same as DynamoDB / API Gateway
        // enrichment branches above.
        const rdsClient = new RDSClient({ ...ambientClientDefaults() });
        const describeResponse = await rdsClient.send(
          new DescribeDBClustersCommand({ DBClusterIdentifier: physicalId })
        );
        const cluster = describeResponse.DBClusters?.[0];
        if (cluster) {
          if (cluster.Endpoint) enriched['Endpoint.Address'] = cluster.Endpoint;
          if (cluster.Port !== undefined) enriched['Endpoint.Port'] = String(cluster.Port);
          if (cluster.ReaderEndpoint) enriched['ReadEndpoint.Address'] = cluster.ReaderEndpoint;
          if (cluster.DBClusterArn) enriched['Arn'] = cluster.DBClusterArn;
          if (cluster.DbClusterResourceId) {
            enriched['DBClusterResourceId'] = cluster.DbClusterResourceId;
          }
          log.debug(
            `Enriched RDS DBCluster ${physicalId} with Endpoint/Port/Arn from DescribeDBClusters`
          );
        }
      } catch (error) {
        // Best-effort: a failed Describe shouldn't fail the deploy.
        // The resolver's nested-path walk is the second line of defence.
        log.debug(
          `Failed to enrich RDS DBCluster ${physicalId}: ${describeAwsFailure(error).detail}`
        );
      }
      break;

    case 'AWS::RDS::DBInstance':
      // Sibling of the DBCluster branch above: a DBInstance whose template
      // sets an SDK-unwired top-level property (BackupRetentionPeriod /
      // CopyTagsToSnapshot / MultiAZ / PubliclyAccessible / StorageType /
      // etc. — see the `AWS::RDS::DBInstance` sdkUnwired set in
      // property-coverage.generated.ts) is routed entirely through CC API
      // by the #614 SDK-unwired routing rule, which bypasses
      // RDSProvider.create — so the flat-key `Endpoint.Address` /
      // `Endpoint.Port` attributes the SDK provider would have populated
      // never get set, and `Fn::GetAtt(<DBInstance>, 'Endpoint.Address')`
      // falls through the resolver's constructAttribute branch to
      // `physicalId` (the DB identifier, not the endpoint hostname).
      // SHAPE DIFFERENCE vs the DBCluster case: DescribeDBInstances returns
      // `Endpoint` as a NESTED object `{ Address, Port, HostedZoneId }`
      // (NOT a flat string like DBCluster's `Endpoint`). Flatten it into
      // the SDK provider's flat-key attribute shape so consumers resolve.
      // Best-effort: a failed Describe (e.g. permissions gap) leaves the
      // CC-API attribute shape unchanged and must not fail the deploy.
      try {
        // The RDSClient inherits the cdkd-resolved region via env / profile,
        // same as the DBCluster / DynamoDB / API Gateway branches.
        const rdsClient = new RDSClient({ ...ambientClientDefaults() });
        const describeResponse = await rdsClient.send(
          new DescribeDBInstancesCommand({ DBInstanceIdentifier: physicalId })
        );
        const inst = describeResponse.DBInstances?.[0];
        if (inst) {
          // The SDK provider's map (go-to-k/cdkd#6242), so both routes record
          // the same keys.
          Object.assign(enriched, dbInstanceAttributes(inst));
          log.debug(
            `Enriched RDS DBInstance ${physicalId} with Endpoint/Port/Arn from DescribeDBInstances`
          );
        }
      } catch (error) {
        // Best-effort: a failed Describe shouldn't fail the deploy.
        log.debug(
          `Failed to enrich RDS DBInstance ${physicalId}: ${describeAwsFailure(error).detail}`
        );
      }
      break;

    case 'AWS::DynamoDB::Table':
      // Fallback: CC API GetResource may not include StreamArn when streams are enabled.
      // Call DescribeTable to retrieve LatestStreamArn if not already present.
      if (!enriched['StreamArn']) {
        try {
          const dynamoDBClient = getAwsClients().dynamoDB;
          const describeResponse = await dynamoDBClient.send(
            new DescribeTableCommand({ TableName: physicalId })
          );
          const latestStreamArn = describeResponse.Table?.LatestStreamArn;
          if (latestStreamArn) {
            enriched['StreamArn'] = latestStreamArn;
            log.debug(`Enriched DynamoDB StreamArn for ${physicalId}: ${latestStreamArn}`);
          }
        } catch (error) {
          // Best-effort: don't fail the operation if DescribeTable fails
          log.debug(
            `Failed to get DynamoDB StreamArn for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::ApiGateway::RestApi':
      // Fallback: ensure RootResourceId is present.
      // CC API GetResource typically returns it, but retrieve via SDK if missing.
      if (!enriched['RootResourceId']) {
        try {
          const apiGatewayClient = getAwsClients().apiGateway;
          const getRestApiResponse = await apiGatewayClient.send(
            new GetRestApiCommand({ restApiId: physicalId })
          );
          if (getRestApiResponse.rootResourceId) {
            enriched['RootResourceId'] = getRestApiResponse.rootResourceId;
            log.debug(
              `Enriched RestApi RootResourceId for ${physicalId}: ${getRestApiResponse.rootResourceId}`
            );
          }
        } catch (error) {
          // Best-effort: don't fail the operation if GetRestApi fails
          log.debug(
            `Failed to get RestApi RootResourceId for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      // Ensure RestApiId is set (physical ID is the rest-api-id)
      if (!enriched['RestApiId']) {
        enriched['RestApiId'] = physicalId;
      }
      break;

    case 'AWS::CloudFront::CloudFrontOriginAccessIdentity':
      // Fallback: ensure S3CanonicalUserId is present.
      // CC API GetResource typically returns it, but retrieve via SDK if missing.
      if (!enriched['S3CanonicalUserId']) {
        try {
          const cloudFrontClient = getAwsClients().cloudFront;
          const oaiResponse = await cloudFrontClient.send(
            new GetCloudFrontOriginAccessIdentityCommand({ Id: physicalId })
          );
          const s3CanonicalUserId = oaiResponse.CloudFrontOriginAccessIdentity?.S3CanonicalUserId;
          if (s3CanonicalUserId) {
            enriched['S3CanonicalUserId'] = s3CanonicalUserId;
            log.debug(
              `Enriched CloudFront OAI S3CanonicalUserId for ${physicalId}: ${s3CanonicalUserId}`
            );
          }
        } catch (error) {
          // Best-effort: don't fail the operation
          log.debug(
            `Failed to get CloudFront OAI S3CanonicalUserId for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::KMS::Key':
      // CC API may not return Arn in ResourceModel.
      // Physical ID is the KeyId (UUID), so construct the ARN.
      if (!enriched['Arn']) {
        try {
          const kmsAccountInfo = await this.accountInfoForSynthesizedArn(
            resourceType,
            'Arn',
            physicalId,
            log
          );
          if (kmsAccountInfo) {
            // The region segment is FOLDED (issue #1850). The SOURCE folds too
            // (`effectiveAccountInfoRegion`, issue #1882), so this is defense
            // in depth rather than the only fold; both are kept, since
            // double-folding is a no-op. An earlier revision called
            // `accountInfo.region` "whatever spelling the caller supplied" and
            // said `cdkd deploy --region US-EAST-1` is REACHABLE because DNS
            // is case-insensitive "and the deploy SUCCEEDS" -- both false, and
            // corrected here with issue #1882's measurement: `foldRegionOption`
            // makes the flag canonical at every handler's entry (issue #2065),
            // so a raw spelling never gets that far, and SigV4 would refuse it
            // if it did. What IS reachable is a Cloud Assembly carrying a raw
            // region, whose clients cdkd folds. Unfolded, cdkd would record
            // `arn:aws:kms:US-EAST-1:...`, which no IAM policy matches
            // (policy matching IS case-sensitive) and every SDK call taking the
            // ARN rejects. The value is persisted into state.json, so it is
            // also what every later `Fn::GetAtt` / `cdkd drift` reads. The
            // PARTITION needs no fold — `derivePartitionAndUrlSuffix`
            // canonicalizes its own input (issue #1795) — and double-folding is
            // a no-op, which is what makes the two safe side by side.
            enriched['Arn'] =
              `arn:${kmsAccountInfo.partition}:kms:${canonicalizeRegion(kmsAccountInfo.region)}:${kmsAccountInfo.accountId}:key/${physicalId}`;
            log.debug(`Enriched KMS Key Arn for ${physicalId}: ${String(enriched['Arn'])}`);
          }
        } catch (error) {
          log.debug(
            `Failed to construct KMS Key Arn for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      if (!enriched['KeyId']) {
        enriched['KeyId'] = physicalId;
      }
      break;

    case 'AWS::CloudFront::OriginAccessControl':
      // CC API physicalId is the OAC ID
      if (!enriched['Id']) enriched['Id'] = physicalId;
      break;

    case 'AWS::Route53::HealthCheck':
      // CC API physicalId is the HealthCheck ID
      if (!enriched['HealthCheckId']) enriched['HealthCheckId'] = physicalId;
      break;

    case 'AWS::ECR::Repository':
      // CC API physicalId is the repository name, construct ARN
      if (!enriched['Arn']) {
        try {
          const ecrAccountInfo = await this.accountInfoForSynthesizedArn(
            resourceType,
            'Arn',
            physicalId,
            log
          );
          if (ecrAccountInfo) {
            // Region segment folded — see the KMS Key branch above (issue #1850).
            enriched['Arn'] =
              `arn:${ecrAccountInfo.partition}:ecr:${canonicalizeRegion(ecrAccountInfo.region)}:${ecrAccountInfo.accountId}:repository/${physicalId}`;
            log.debug(`Enriched ECR Repository Arn for ${physicalId}: ${String(enriched['Arn'])}`);
          }
        } catch (error) {
          log.debug(`Failed to construct ECR Repository Arn: ${describeAwsFailure(error).detail}`);
        }
      }
      if (!enriched['RepositoryUri']) {
        try {
          const ecrAccountInfo = await this.accountInfoForSynthesizedArn(
            resourceType,
            'RepositoryUri',
            physicalId,
            log
          );
          if (ecrAccountInfo) {
            // URL suffix derived, not hardcoded — `amazonaws.com.cn` in
            // `aws-cn` (issue #1730 review); mirrors the resolver's own
            // `RepositoryUri` branch so the two cannot disagree. That parity
            // is what issue #1850 had to RESTORE rather than assume: folding
            // the region here alone would have made the two disagree for an
            // upper-cased region, so the resolver folds at its own
            // `constructAttribute` destructure in the same change.
            //
            // The region label is FOLDED for the same reason the ARNs above are
            // (issue #1850), and this is the site where it matters MOST: the
            // recorded URI is handed to `docker` and parsed back by
            // `parseEcrRegistryHost` (`src/utils/ecr-uri.ts`), whose own
            // canonical-segment guards are what an upper-cased label has to get
            // past. Recording the canonical spelling is the half of that story
            // cdkd owns.
            const { urlSuffix } = derivePartitionAndUrlSuffix(ecrAccountInfo.region);
            enriched['RepositoryUri'] =
              `${ecrAccountInfo.accountId}.dkr.ecr.${canonicalizeRegion(ecrAccountInfo.region)}.${urlSuffix}/${physicalId}`;
          }
        } catch {
          /* best effort */
        }
      }
      break;

    case 'AWS::EC2::EIP':
      // CC API returns composite physicalId: "PublicIp|AllocationId"
      // Extract individual attributes for Fn::GetAtt resolution
      if (physicalId.includes('|')) {
        const [publicIp, allocationId] = physicalId.split('|');
        if (!enriched['AllocationId']) enriched['AllocationId'] = allocationId;
        if (!enriched['PublicIp']) enriched['PublicIp'] = publicIp;
        log.debug(`Enriched EIP attributes: AllocationId=${allocationId}, PublicIp=${publicIp}`);
      }
      break;

    case 'AWS::Lambda::Version':
      // CC API physicalId for Lambda Version is the full version ARN
      // (e.g., arn:aws:lambda:us-east-1:123456:function:MyFunc:1).
      // Lambda::Alias FunctionVersion property needs just the version number.
      if (!enriched['Version']) {
        const versionSegments = physicalId.split(':');
        const versionNumber = versionSegments[versionSegments.length - 1];
        enriched['Version'] = versionNumber;
        log.debug(`Enriched Lambda Version for ${physicalId}: ${versionNumber}`);
      }
      break;

    case 'AWS::Kinesis::Stream':
      // CC API physicalId for Kinesis Stream is the stream name, not the ARN.
      // Fn::GetAtt [Stream, Arn] needs the full ARN.
      if (!enriched['Arn']) {
        try {
          const kinesisAccountInfo = await this.accountInfoForSynthesizedArn(
            resourceType,
            'Arn',
            physicalId,
            log
          );
          if (kinesisAccountInfo) {
            // Region segment folded — see the KMS Key branch above (issue #1850).
            enriched['Arn'] =
              `arn:${kinesisAccountInfo.partition}:kinesis:${canonicalizeRegion(kinesisAccountInfo.region)}:${kinesisAccountInfo.accountId}:stream/${physicalId}`;
            log.debug(`Enriched Kinesis Stream Arn for ${physicalId}: ${String(enriched['Arn'])}`);
          }
        } catch (error) {
          log.debug(
            `Failed to construct Kinesis Stream Arn for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::Lambda::Url':
      // CC API CREATE response may not include FunctionUrl in ResourceModel.
      // Use Lambda SDK to retrieve it for Fn::GetAtt resolution.
      if (!enriched['FunctionUrl']) {
        try {
          const lambdaClient = getAwsClients().lambda;
          // physicalId is the FunctionArn for Lambda URL
          const urlConfig = await lambdaClient.send(
            new GetFunctionUrlConfigCommand({ FunctionName: physicalId })
          );
          if (urlConfig.FunctionUrl) {
            enriched['FunctionUrl'] = urlConfig.FunctionUrl;
            log.debug(
              `Enriched Lambda URL FunctionUrl for ${physicalId}: ${urlConfig.FunctionUrl}`
            );
          }
          if (urlConfig.FunctionArn) {
            enriched['FunctionArn'] = urlConfig.FunctionArn;
          }
        } catch (error) {
          log.debug(
            `Failed to get Lambda URL config for ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::Events::Connection':
      // AWS::Events::Connection has NO SDK provider, so it always routes
      // through Cloud Control. Its primaryIdentifier is `Name`, so the CC API
      // physicalId is the connection NAME, not the ARN. The readOnly
      // attributes `Arn` / `SecretArn` / `ArnForPolicy` therefore fall through
      // the resolver's `constructAttribute` to the physicalId (the name) — and
      // a downstream `AWS::Events::ApiDestination` whose `ConnectionArn` is
      // `Fn::GetAtt(<Connection>, 'Arn')` (the canonical CDK shape) gets the
      // bare name instead of an ARN, so the ApiDestination CREATE fails CC
      // model validation (`#/ConnectionArn: failed validation constraint for
      // keyword [pattern]`). The full connection ARN carries a random unique
      // suffix (`.../connection/<name>/<uuid>`) so it cannot be constructed
      // from account + region + name; call DescribeConnection to recover it.
      // Best-effort: a failed Describe leaves the CC-API attribute shape
      // unchanged and must not fail the deploy. Same enrichment-gap bug class
      // as #844 / #864 / #865 / #866.
      if (!enriched['Arn'] || !enriched['SecretArn'] || !enriched['ArnForPolicy']) {
        try {
          const eventBridgeClient = getAwsClients().eventBridge;
          const conn = await eventBridgeClient.send(
            new DescribeConnectionCommand({ Name: physicalId })
          );
          if (conn.ConnectionArn) {
            if (!enriched['Arn']) enriched['Arn'] = conn.ConnectionArn;
            // ArnForPolicy is the connection ARN WITHOUT the trailing unique
            // suffix (`arn:...:connection/<name>`), used in IAM policies.
            // DescribeConnection does not return it, so derive it from the
            // full ARN by stripping the last `/<segment>`.
            if (!enriched['ArnForPolicy']) {
              const lastSlash = conn.ConnectionArn.lastIndexOf('/');
              if (lastSlash > 0) {
                enriched['ArnForPolicy'] = conn.ConnectionArn.slice(0, lastSlash);
              }
            }
          }
          if (conn.SecretArn && !enriched['SecretArn']) {
            enriched['SecretArn'] = conn.SecretArn;
          }
          log.debug(
            `Enriched Events Connection ${physicalId} with Arn/SecretArn/ArnForPolicy from DescribeConnection`
          );
        } catch (error) {
          log.debug(
            `Failed to enrich Events Connection ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::Events::ApiDestination':
      // Sibling of the Events::Connection case: ApiDestination's
      // primaryIdentifier is `Name`, so the CC physicalId is the name and the
      // readOnly `Arn` / `ArnForPolicy` attributes fall through to it. An
      // `AWS::Events::Rule` target referencing the ApiDestination by
      // `Fn::GetAtt(<ApiDestination>, 'Arn')` would otherwise get the bare
      // name. The full ARN carries a unique suffix, so call
      // DescribeApiDestination to recover it. Best-effort.
      if (!enriched['Arn'] || !enriched['ArnForPolicy']) {
        try {
          const eventBridgeClient = getAwsClients().eventBridge;
          const dest = await eventBridgeClient.send(
            new DescribeApiDestinationCommand({ Name: physicalId })
          );
          if (dest.ApiDestinationArn) {
            if (!enriched['Arn']) enriched['Arn'] = dest.ApiDestinationArn;
            if (!enriched['ArnForPolicy']) {
              const lastSlash = dest.ApiDestinationArn.lastIndexOf('/');
              if (lastSlash > 0) {
                enriched['ArnForPolicy'] = dest.ApiDestinationArn.slice(0, lastSlash);
              }
            }
          }
          log.debug(
            `Enriched Events ApiDestination ${physicalId} with Arn/ArnForPolicy from DescribeApiDestination`
          );
        } catch (error) {
          log.debug(
            `Failed to enrich Events ApiDestination ${physicalId}: ${describeAwsFailure(error).detail}`
          );
        }
      }
      break;

    case 'AWS::ElastiCache::ReplicationGroup': {
      // ElastiCache ReplicationGroup has NO SDK provider, so it always routes
      // through Cloud Control — and the CC API GetResource model does not
      // surface the connection endpoints in the flat-key shape cdkd's
      // intrinsic resolver expects. `Fn::GetAtt(<RG>, 'PrimaryEndPoint.Address')`
      // (and the Reader / Configuration variants) would otherwise fall through
      // the resolver's `constructAttribute` to `physicalId` (the replication-
      // group id, NOT the Redis hostname), so a security-group rule / client
      // connection string built from it points at garbage.
      //
      // SHAPE NOTE: the CFn return-value attribute names use capital-P
      // `EndPoint` (`PrimaryEndPoint.Address`, `ReaderEndPoint.Address`,
      // `ConfigurationEndPoint.Address`, `ReadEndPoint.Addresses` list) while
      // the AWS SDK fields are `Endpoint` (lower p) on
      // `NodeGroups[].PrimaryEndpoint` / `NodeGroups[].ReaderEndpoint` and the
      // top-level `ConfigurationEndpoint` (cluster-mode). We populate the
      // flat-keys with the CFn casing so the resolver finds them.
      // Best-effort: a failed Describe leaves the CC-API attribute shape
      // unchanged and must not fail the deploy.
      try {
        const elastiCacheClient = new ElastiCacheClient({ ...ambientClientDefaults() });
        const describeResponse = await elastiCacheClient.send(
          new DescribeReplicationGroupsCommand({ ReplicationGroupId: physicalId })
        );
        const rg = describeResponse.ReplicationGroups?.[0];
        if (rg) {
          // Cluster-mode-disabled: NodeGroups[0] carries the primary/reader.
          const primaryNode = rg.NodeGroups?.[0];
          if (primaryNode?.PrimaryEndpoint?.Address) {
            enriched['PrimaryEndPoint.Address'] = primaryNode.PrimaryEndpoint.Address;
          }
          if (primaryNode?.PrimaryEndpoint?.Port !== undefined) {
            enriched['PrimaryEndPoint.Port'] = String(primaryNode.PrimaryEndpoint.Port);
          }
          if (primaryNode?.ReaderEndpoint?.Address) {
            enriched['ReaderEndPoint.Address'] = primaryNode.ReaderEndpoint.Address;
          }
          if (primaryNode?.ReaderEndpoint?.Port !== undefined) {
            enriched['ReaderEndPoint.Port'] = String(primaryNode.ReaderEndpoint.Port);
          }
          // Cluster-mode-enabled: a single ConfigurationEndpoint fronts all shards.
          if (rg.ConfigurationEndpoint?.Address) {
            enriched['ConfigurationEndPoint.Address'] = rg.ConfigurationEndpoint.Address;
          }
          if (rg.ConfigurationEndpoint?.Port !== undefined) {
            enriched['ConfigurationEndPoint.Port'] = String(rg.ConfigurationEndpoint.Port);
          }
          // ReadEndPoint.Addresses / .Ports are CFn comma-delimited LIST
          // attributes covering the read-capable endpoints. Per the CFn
          // return-value docs these list "the primary and the read-only
          // replicas", so collect BOTH the primary and reader endpoint of
          // every node group (a reader-only list would be empty for a
          // single-node cluster-mode-disabled RG, diverging from CFn).
          const readEndpoints = (rg.NodeGroups ?? []).flatMap((ng) => [
            ng.PrimaryEndpoint,
            ng.ReaderEndpoint,
          ]);
          const readAddrs = readEndpoints
            .map((ep) => ep?.Address)
            .filter((a): a is string => typeof a === 'string' && a.length > 0);
          const readPorts = readEndpoints
            .map((ep) => ep?.Port)
            .filter((p): p is number => p !== undefined);
          if (readAddrs.length > 0) {
            enriched['ReadEndPoint.Addresses'] = readAddrs.join(',');
          }
          if (readPorts.length > 0) {
            enriched['ReadEndPoint.Ports'] = readPorts.map(String).join(',');
          }
          log.debug(
            `Enriched ElastiCache ReplicationGroup ${physicalId} with endpoint attributes from DescribeReplicationGroups`
          );
        }
      } catch (error) {
        log.debug(
          `Failed to enrich ElastiCache ReplicationGroup ${physicalId}: ${describeAwsFailure(error).detail}`
        );
      }
      break;
    }

    case 'AWS::Redshift::Cluster': {
      // Redshift Cluster has no SDK provider, so it always routes through
      // Cloud Control. The CC API GetResource model does not reliably surface
      // the cluster endpoint, so `Fn::GetAtt(<Cluster>, 'Endpoint.Address')` /
      // `Endpoint.Port` (the JDBC/ODBC connection coordinates) would fall
      // through the resolver's constructAttribute to the physicalId (the
      // cluster identifier, NOT the endpoint hostname). Overlay the flat-key
      // Endpoint.Address / Endpoint.Port from DescribeClusters. The SDK
      // `Cluster.Endpoint` object uses the SAME `Endpoint.Address` /
      // `Endpoint.Port` names as the CFn return values (no casing quirk,
      // unlike ElastiCache). Best-effort: a failed Describe leaves the CC-API
      // attribute shape unchanged and never fails the deploy.
      try {
        const redshiftClient = new RedshiftClient({ ...ambientClientDefaults() });
        const describeResponse = await redshiftClient.send(
          new DescribeClustersCommand({ ClusterIdentifier: physicalId })
        );
        const cluster = describeResponse.Clusters?.[0];
        if (cluster?.Endpoint) {
          if (cluster.Endpoint.Address) {
            enriched['Endpoint.Address'] = cluster.Endpoint.Address;
          }
          if (cluster.Endpoint.Port !== undefined) {
            enriched['Endpoint.Port'] = String(cluster.Endpoint.Port);
          }
          log.debug(
            `Enriched Redshift Cluster ${physicalId} with Endpoint.Address/Port from DescribeClusters`
          );
        }
      } catch (error) {
        log.debug(
          `Failed to enrich Redshift Cluster ${physicalId}: ${describeAwsFailure(error).detail}`
        );
      }
      break;
    }

    case 'AWS::OpenSearchService::Domain': {
      // OpenSearch Service Domain has no SDK provider, so it always routes
      // through Cloud Control. The CC API GetResource model does not surface
      // the search endpoint / ARN in the flat-key shape cdkd's intrinsic
      // resolver expects, so `Fn::GetAtt(<Domain>, 'DomainEndpoint')` (the
      // https://search-... URL clients connect to) and
      // `Fn::GetAtt(<Domain>, 'Arn')` / 'DomainArn' would fall through the
      // resolver's constructAttribute to the physicalId (the domain NAME,
      // NOT the endpoint hostname / ARN). Overlay them from DescribeDomain.
      //
      // SHAPE NOTE: the CFn return-value names are `DomainEndpoint` (single,
      // public access) / `DomainEndpoints` (map, e.g. { vpc: '...' } for
      // VPC-deployed domains) / `Arn` (and the alias `DomainArn`) / `Id`.
      // The SDK `DomainStatus` fields are `Endpoint` (public) / `Endpoints`
      // (map) / `ARN` / `DomainId`. We populate the flat-keys with the CFn
      // names so the resolver finds them; for a VPC domain (no public
      // `Endpoint`) we fall back to the `vpc` entry of the `Endpoints` map.
      // Best-effort: a failed Describe leaves the CC-API attribute shape
      // unchanged and never fails the deploy.
      try {
        const openSearchClient = new OpenSearchClient({ ...ambientClientDefaults() });
        const describeResponse = await openSearchClient.send(
          new DescribeDomainCommand({ DomainName: physicalId })
        );
        const domain = describeResponse.DomainStatus;
        if (domain) {
          const endpoint = domain.Endpoint ?? domain.Endpoints?.['vpc'];
          if (endpoint) {
            enriched['DomainEndpoint'] = endpoint;
          }
          if (domain.ARN) {
            enriched['Arn'] = domain.ARN;
            enriched['DomainArn'] = domain.ARN;
          }
          if (domain.DomainId) {
            enriched['Id'] = domain.DomainId;
          }
          log.debug(
            `Enriched OpenSearch Domain ${physicalId} with DomainEndpoint/Arn from DescribeDomain`
          );
        }
      } catch (error) {
        log.debug(
          `Failed to enrich OpenSearch Domain ${physicalId}: ${describeAwsFailure(error).detail}`
        );
      }
      break;
    }

    case 'AWS::Backup::BackupVault': {
      // Backup types have NO SDK provider, so they always route through
      // Cloud Control. The CC API CREATE response's ResourceModel is sparse
      // for Backup and does not reliably surface the vault ARN, so
      // `Fn::GetAtt(<Vault>, 'BackupVaultArn')` (the canonical CDK shape,
      // emitted by `vault.backupVaultArn`) would fall through the resolver's
      // constructAttribute to the physicalId — which for BackupVault is the
      // vault NAME, not the ARN. AWS then rejects a BackupPlan rule /
      // selection that references the bare name where an ARN is required.
      // Overlay the ARN from a CC GetResource read-back on the physicalId.
      // The read-back is gated SOLELY on the ARN (the one real computed
      // GetAtt target) — BackupVaultName has a cheap physicalId fallback
      // below and does not justify a read-back on its own. Best-effort: a
      // failed read leaves the CC-API attribute shape unchanged and never
      // fails the deploy.
      if (!enriched['BackupVaultArn']) {
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (typeof model['BackupVaultArn'] === 'string') {
            enriched['BackupVaultArn'] = model['BackupVaultArn'];
          }
          // BackupVaultName Ref-return is the physicalId; surface it too so
          // Fn::GetAtt(<Vault>, 'BackupVaultName') resolves.
          if (!enriched['BackupVaultName'] && typeof model['BackupVaultName'] === 'string') {
            enriched['BackupVaultName'] = model['BackupVaultName'];
          }
          log.debug(
            `Enriched Backup BackupVault ${physicalId} with BackupVaultArn from CC GetResource`
          );
        }
      }
      if (!enriched['BackupVaultName']) {
        enriched['BackupVaultName'] = physicalId;
      }
      break;
    }

    case 'AWS::Backup::BackupPlan': {
      // Sibling of the BackupVault branch: the CC CREATE ResourceModel does
      // not reliably surface the plan ARN / version id, so
      // `Fn::GetAtt(<Plan>, 'BackupPlanArn')` / `'VersionId'` fall through to
      // the physicalId (the BackupPlanId). Overlay both from a CC
      // GetResource read-back. Best-effort.
      if (!enriched['BackupPlanArn'] || !enriched['VersionId']) {
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (!enriched['BackupPlanArn'] && typeof model['BackupPlanArn'] === 'string') {
            enriched['BackupPlanArn'] = model['BackupPlanArn'];
          }
          if (!enriched['VersionId'] && typeof model['VersionId'] === 'string') {
            enriched['VersionId'] = model['VersionId'];
          }
          if (!enriched['BackupPlanId'] && typeof model['BackupPlanId'] === 'string') {
            enriched['BackupPlanId'] = model['BackupPlanId'];
          }
          log.debug(
            `Enriched Backup BackupPlan ${physicalId} with BackupPlanArn/VersionId from CC GetResource`
          );
        }
      }
      if (!enriched['BackupPlanId']) {
        enriched['BackupPlanId'] = physicalId;
      }
      break;
    }

    case 'AWS::Backup::BackupSelection': {
      // BackupSelection's CC primaryIdentifier is a single `Id` whose VALUE
      // is the compound `<SelectionId>_<BackupPlanId>` joined by an UNDERSCORE
      // (both segments are UUIDs, so `_` is unambiguous) — CFn's Ref returns
      // the SelectionId. `Fn::GetAtt(<Selection>, 'SelectionId')` would
      // otherwise fall through to the compound physicalId. Extract the
      // SelectionId from the compound id (before the first underscore) as a
      // best-effort fallback, and prefer the CC read-back model's value when
      // available (issue #995 corrected the separator from `|` to `_`).
      if (!enriched['SelectionId'] || !enriched['BackupPlanId']) {
        const firstUnderscore = physicalId.indexOf('_');
        if (firstUnderscore > 0) {
          if (!enriched['SelectionId']) {
            enriched['SelectionId'] = physicalId.substring(0, firstUnderscore);
          }
          if (!enriched['BackupPlanId']) {
            enriched['BackupPlanId'] = physicalId.substring(firstUnderscore + 1);
          }
        }
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (typeof model['SelectionId'] === 'string') {
            enriched['SelectionId'] = model['SelectionId'];
          }
          if (typeof model['BackupPlanId'] === 'string') {
            enriched['BackupPlanId'] = model['BackupPlanId'];
          }
          log.debug(
            `Enriched Backup BackupSelection ${physicalId} with SelectionId from CC GetResource`
          );
        }
      }
      break;
    }

    case 'AWS::Pipes::Pipe': {
      // Pipes has had an SDK provider since issue #4423, and a cc-api
      // record moves to it (a 'cc-broken' sticky exemption). A pipe still
      // reaches Cloud Control when its template carries a schema-known
      // property that provider does not handle (the SDK-unwired auto-route
      // in `getProviderFor`). The CC CREATE ResourceModel is sparse there:
      // it does not surface the pipe ARN. `Fn::GetAtt(<Pipe>, 'Arn')` would fall
      // through the resolver's constructAttribute to the physicalId (the
      // pipe NAME), poisoning IAM policies / alarm actions / outputs that
      // need the ARN. Overlay the documented GetAtt attributes from a CC
      // GetResource read-back. Best-effort: a failed read leaves the
      // attribute shape unchanged and never fails the deploy. (issue #1103)
      if (!enriched['Arn']) {
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (typeof model['Arn'] === 'string') {
            enriched['Arn'] = model['Arn'];
          }
          if (!enriched['CurrentState'] && typeof model['CurrentState'] === 'string') {
            enriched['CurrentState'] = model['CurrentState'];
          }
          if (!enriched['StateReason'] && typeof model['StateReason'] === 'string') {
            enriched['StateReason'] = model['StateReason'];
          }
          if (!enriched['CreationTime'] && typeof model['CreationTime'] === 'string') {
            enriched['CreationTime'] = model['CreationTime'];
          }
          if (!enriched['LastModifiedTime'] && typeof model['LastModifiedTime'] === 'string') {
            enriched['LastModifiedTime'] = model['LastModifiedTime'];
          }
          log.debug(`Enriched Pipes Pipe ${physicalId} with Arn from CC GetResource`);
        }
      }
      break;
    }

    case 'AWS::S3::AccessPoint': {
      // Same class as the Pipes branch: the physicalId is the access point
      // NAME while Arn / Alias are readOnly attributes the sparse CREATE
      // ResourceModel omits. Alias is load-bearing for S3 data access (the
      // `...-s3alias` bucket-style name handed to S3 clients), so falling
      // back to the bare name breaks consumers silently. (issue #1103)
      if (!enriched['Arn'] || !enriched['Alias']) {
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (!enriched['Arn'] && typeof model['Arn'] === 'string') {
            enriched['Arn'] = model['Arn'];
          }
          if (!enriched['Alias'] && typeof model['Alias'] === 'string') {
            enriched['Alias'] = model['Alias'];
          }
          if (!enriched['NetworkOrigin'] && typeof model['NetworkOrigin'] === 'string') {
            enriched['NetworkOrigin'] = model['NetworkOrigin'];
          }
          log.debug(`Enriched S3 AccessPoint ${physicalId} with Arn/Alias from CC GetResource`);
        }
      }
      break;
    }

    case 'AWS::ResourceGroups::Group': {
      // Same class: the physicalId is the group NAME and Arn is the only
      // computed GetAtt attribute; the sparse CREATE ResourceModel omits
      // it, so the resolver would hand the bare name to consumers that
      // need the ARN (e.g. IAM policies). (issue #1103)
      if (!enriched['Arn']) {
        const model = await this.readCcResourceModel(resourceType, physicalId, log);
        if (model) {
          if (typeof model['Arn'] === 'string') {
            enriched['Arn'] = model['Arn'];
          }
          log.debug(`Enriched ResourceGroups Group ${physicalId} with Arn from CC GetResource`);
        }
      }
      break;
    }

    default:
      break;
  }

  return enriched;
}
