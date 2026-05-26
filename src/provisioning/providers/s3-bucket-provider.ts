/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  DeleteBucketTaggingCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketCorsCommand,
  DeleteBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  DeleteBucketLifecycleCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketLoggingCommand,
  PutBucketWebsiteCommand,
  DeleteBucketWebsiteCommand,
  PutBucketAccelerateConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  DeleteBucketMetricsConfigurationCommand,
  PutBucketAnalyticsConfigurationCommand,
  DeleteBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  DeleteBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  DeleteBucketInventoryConfigurationCommand,
  PutBucketReplicationCommand,
  DeleteBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
  GetBucketEncryptionCommand,
  GetBucketTaggingCommand,
  GetBucketVersioningCommand,
  GetPublicAccessBlockCommand,
  GetBucketLifecycleConfigurationCommand,
  GetBucketCorsCommand,
  GetBucketWebsiteCommand,
  GetBucketLoggingCommand,
  GetBucketNotificationConfigurationCommand,
  GetBucketReplicationCommand,
  GetObjectLockConfigurationCommand,
  GetBucketAccelerateConfigurationCommand,
  ListBucketMetricsConfigurationsCommand,
  ListBucketAnalyticsConfigurationsCommand,
  ListBucketIntelligentTieringConfigurationsCommand,
  ListBucketInventoryConfigurationsCommand,
  NoSuchBucket,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type BucketLocationConstraint,
  type ObjectOwnership,
  type CORSRule,
} from '@aws-sdk/client-s3';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::S3::Bucket
 *
 * Uses S3 SDK directly instead of CC API for synchronous bucket creation.
 * S3's CreateBucket is synchronous - no polling needed, unlike CC API which
 * requires async polling (1s→1.5s→2.25s...) adding seconds per resource.
 */
export class S3BucketProvider implements ResourceProvider {
  private s3Client: S3Client;
  private logger = getLogger().child('S3BucketProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::S3::Bucket',
      new Set([
        'BucketName',
        'VersioningConfiguration',
        'Tags',
        'OwnershipControls',
        'NotificationConfiguration',
        'CorsConfiguration',
        'LifecycleConfiguration',
        'PublicAccessBlockConfiguration',
        'BucketEncryption',
        'LoggingConfiguration',
        'WebsiteConfiguration',
        'AccelerateConfiguration',
        'MetricsConfigurations',
        'AnalyticsConfigurations',
        'IntelligentTieringConfigurations',
        'InventoryConfigurations',
        'ReplicationConfiguration',
        'ObjectLockConfiguration',
        'ObjectLockEnabled',
      ]),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::S3::Bucket',
      new Map<string, string>([
        [
          'AccessControl',
          'Legacy canned ACL; AWS disables ACLs by default since 2023-04 — use BucketOwnershipControls + BucketPolicy / PublicAccessBlockConfiguration instead',
        ],
      ]),
    ],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.s3Client = awsClients.s3;
  }

  /**
   * Get the region from the S3 client config
   */
  private async getRegion(): Promise<string> {
    const region = await this.s3Client.config.region();
    return region || 'us-east-1';
  }

  /**
   * Build attributes for an S3 bucket.
   *
   * Covers every CloudFormation `Fn::GetAtt` return value for
   * `AWS::S3::Bucket`. All fields are derivable from `bucketName` + region —
   * no extra AWS API call is needed. See:
   * https://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-properties-s3-bucket.html#aws-properties-s3-bucket-return-values
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    return {
      Arn: `arn:aws:s3:::${bucketName}`,
      DomainName: `${bucketName}.s3.amazonaws.com`,
      DualStackDomainName: `${bucketName}.s3.dualstack.${region}.amazonaws.com`,
      RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
      WebsiteURL: `http://${bucketName}.s3-website-${region}.amazonaws.com`,
    };
  }

  /**
   * Resolve a single `Fn::GetAtt` attribute for an existing bucket.
   *
   * Used by `cdkd orphan` to live-fetch attribute values that need to be
   * substituted into sibling references. All S3 Bucket attributes are
   * derivable from bucket name + region, so this avoids the round trip and
   * reuses the same templating as `buildAttributes`.
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    const attrs = await this.buildAttributes(physicalId);
    return attrs[attributeName];
  }

  /**
   * Apply versioning configuration if specified
   */
  private async applyVersioning(
    bucketName: string,
    versioningConfig: Record<string, unknown>
  ): Promise<void> {
    const status = (versioningConfig['Status'] as string) || 'Suspended';
    await this.s3Client.send(
      new PutBucketVersioningCommand({
        Bucket: bucketName,
        VersioningConfiguration: {
          Status: status as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied versioning (${status}) to bucket ${bucketName}`);
  }

  /**
   * Apply tags if specified
   */
  private async applyTags(
    bucketName: string,
    tags: Array<{ Key: string; Value: string }>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: {
          TagSet: tags,
        },
      })
    );
    this.logger.debug(`Applied ${tags.length} tags to bucket ${bucketName}`);
  }

  /**
   * Apply a diff between old and new CFn-shape Tags arrays via S3's
   * `PutBucketTagging` (full-replace) / `DeleteBucketTagging` APIs.
   *
   * S3's `PutBucketTagging` replaces the entire tag set in one call, so we
   * don't need separate add/remove API operations. When the new set is
   * empty, we issue `DeleteBucketTagging` to clear it. When old and new
   * are equal, we skip the call entirely.
   */
  private async applyTagDiff(
    bucketName: string,
    oldTagsRaw: Array<{ Key?: string; Value?: string }> | undefined,
    newTagsRaw: Array<{ Key?: string; Value?: string }> | undefined
  ): Promise<void> {
    const normalize = (
      tags: Array<{ Key?: string; Value?: string }> | undefined
    ): Array<{ Key: string; Value: string }> => {
      const out: Array<{ Key: string; Value: string }> = [];
      for (const t of tags ?? []) {
        if (t.Key !== undefined && t.Value !== undefined) out.push({ Key: t.Key, Value: t.Value });
      }
      return out;
    };

    const oldNorm = normalize(oldTagsRaw);
    const newNorm = normalize(newTagsRaw);
    if (JSON.stringify(oldNorm) === JSON.stringify(newNorm)) return;

    if (newNorm.length === 0) {
      // Clear tags. Use PutBucketTaggingCommand with empty TagSet — S3
      // does not have a public `DeleteBucketTagging` parity for the SDK
      // we use, so emit an empty Tagging set instead.
      try {
        await this.s3Client.send(
          new DeleteBucketTaggingCommand({
            Bucket: bucketName,
          })
        );
        this.logger.debug(`Cleared tags from bucket ${bucketName}`);
      } catch (err) {
        // Some S3 API versions reject empty TagSet on Put; fall back to
        // re-Put. The `NoSuchTagSet` (already-empty) response is fine.
        const e = err as { name?: string };
        if (e.name === 'NoSuchTagSet') return;
        throw err;
      }
      return;
    }
    await this.s3Client.send(
      new PutBucketTaggingCommand({
        Bucket: bucketName,
        Tagging: { TagSet: newNorm },
      })
    );
    this.logger.debug(`Replaced tag set on bucket ${bucketName} (${newNorm.length} tags)`);
  }

  /**
   * Apply CORS configuration
   *
   * CFn property: CorsConfiguration.CorsRules[]
   * SDK: PutBucketCors with CORSConfiguration.CORSRules[]
   *
   * CFn CorsRule fields map to SDK CORSRule fields:
   * - AllowedHeaders, AllowedMethods, AllowedOrigins, ExposedHeaders, MaxAge
   * SDK uses the same names except ExposedHeaders -> ExposeHeaders, MaxAge -> MaxAgeSeconds
   */
  private async applyCorsConfiguration(
    bucketName: string,
    corsConfig: { CorsRules: Array<Record<string, unknown>> }
  ): Promise<void> {
    const corsRules: CORSRule[] = corsConfig.CorsRules.map((rule) => ({
      ID: rule['Id'] as string | undefined,
      AllowedHeaders: rule['AllowedHeaders'] as string[] | undefined,
      AllowedMethods: rule['AllowedMethods'] as string[],
      AllowedOrigins: rule['AllowedOrigins'] as string[],
      ExposeHeaders: rule['ExposedHeaders'] as string[] | undefined,
      MaxAgeSeconds: rule['MaxAge'] as number | undefined,
    }));
    await this.s3Client.send(
      new PutBucketCorsCommand({
        Bucket: bucketName,
        CORSConfiguration: {
          CORSRules: corsRules,
        },
      })
    );
    this.logger.debug(`Applied CORS configuration to bucket ${bucketName}`);
  }

  /**
   * Apply lifecycle configuration
   *
   * CFn property: LifecycleConfiguration.Rules[]
   * SDK: PutBucketLifecycleConfiguration with LifecycleConfiguration.Rules[]
   *
   * CFn and SDK use the same structure with minor differences:
   * - CFn uses TagFilters, SDK uses Tag/Tags in Filter
   * - CFn Transition.TransitionInDays -> SDK Transition.Days
   * - CFn Transition.TransitionDate -> SDK Transition.Date
   */
  private async applyLifecycleConfiguration(
    bucketName: string,
    lifecycleConfig: { Rules: Array<Record<string, unknown>> }
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = lifecycleConfig.Rules.map((rule): any => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sdkRule: any = {
        ID: rule['Id'] as string | undefined,
        Status: (rule['Status'] as string) || 'Enabled',
        Prefix: rule['Prefix'] as string | undefined,
      };

      // Expiration
      const expiration = rule['ExpirationInDays'] || rule['ExpirationDate'] || rule['Expiration'];
      if (typeof expiration === 'number') {
        sdkRule.Expiration = { Days: expiration };
      } else if (typeof expiration === 'string') {
        sdkRule.Expiration = { Date: new Date(expiration) };
      } else if (expiration && typeof expiration === 'object') {
        const exp = expiration as Record<string, unknown>;
        sdkRule.Expiration = {
          Days: exp['Days'] as number | undefined,
          Date: exp['Date'] ? new Date(exp['Date'] as string) : undefined,
          ExpiredObjectDeleteMarker: exp['ExpiredObjectDeleteMarker'] as boolean | undefined,
        };
      }

      // NoncurrentVersionExpiration
      const nve = rule['NoncurrentVersionExpiration'] as Record<string, unknown> | undefined;
      if (nve) {
        sdkRule.NoncurrentVersionExpiration = {
          NoncurrentDays: nve['NoncurrentDays'] as number | undefined,
          NewerNoncurrentVersions: nve['NewerNoncurrentVersions'] as number | undefined,
        };
      }

      // NoncurrentVersionTransitions
      const nvts = rule['NoncurrentVersionTransitions'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (nvts && Array.isArray(nvts)) {
        sdkRule.NoncurrentVersionTransitions = nvts.map((nvt: Record<string, unknown>) => ({
          NoncurrentDays: nvt['NoncurrentDays'] as number | undefined,
          StorageClass: nvt['StorageClass'] as string | undefined,
          NewerNoncurrentVersions: nvt['NewerNoncurrentVersions'] as number | undefined,
        }));
      }

      // Transitions
      const transitions = rule['Transitions'] as Array<Record<string, unknown>> | undefined;
      if (transitions && Array.isArray(transitions)) {
        sdkRule.Transitions = transitions.map((t: Record<string, unknown>) => ({
          Days: (t['TransitionInDays'] ?? t['Days']) as number | undefined,
          Date:
            (t['TransitionDate'] ?? t['Date'])
              ? new Date((t['TransitionDate'] ?? t['Date']) as string)
              : undefined,
          StorageClass: t['StorageClass'] as string | undefined,
        }));
      }

      // AbortIncompleteMultipartUpload
      const abort = rule['AbortIncompleteMultipartUpload'] as Record<string, unknown> | undefined;
      if (abort) {
        sdkRule.AbortIncompleteMultipartUpload = {
          DaysAfterInitiation: abort['DaysAfterInitiation'] as number | undefined,
        };
      }

      // S3 requires either Filter or Prefix on each rule.
      // If neither is specified in CFn, we must provide an empty Filter.
      // Filter (CFn uses TagFilters, ObjectSizeGreaterThan, ObjectSizeLessThan, Prefix)
      const filter = rule['Filter'] as Record<string, unknown> | undefined;
      if (filter) {
        const tagFilters = filter['TagFilters'] as
          | Array<{ Key: string; Value: string }>
          | undefined;
        const prefix = filter['Prefix'] as string | undefined;
        const sizeGt = filter['ObjectSizeGreaterThan'] as number | undefined;
        const sizeLt = filter['ObjectSizeLessThan'] as number | undefined;

        // If multiple conditions, use And
        const hasMultiple =
          (tagFilters && tagFilters.length > 0 ? 1 : 0) +
            (prefix !== undefined ? 1 : 0) +
            (sizeGt !== undefined ? 1 : 0) +
            (sizeLt !== undefined ? 1 : 0) >
          1;

        if (hasMultiple) {
          sdkRule.Filter = {
            And: {
              Prefix: prefix,
              Tags: tagFilters,
              ObjectSizeGreaterThan: sizeGt,
              ObjectSizeLessThan: sizeLt,
            },
          };
        } else if (tagFilters && tagFilters.length > 0) {
          sdkRule.Filter = { Tag: tagFilters[0] };
        } else if (prefix !== undefined) {
          sdkRule.Filter = { Prefix: prefix };
        } else if (sizeGt !== undefined) {
          sdkRule.Filter = { ObjectSizeGreaterThan: sizeGt };
        } else if (sizeLt !== undefined) {
          sdkRule.Filter = { ObjectSizeLessThan: sizeLt };
        }
      } else if (sdkRule.Prefix === undefined) {
        // S3 requires either Filter or Prefix on each lifecycle rule.
        // When neither is specified in CFn template, provide an empty Filter.
        sdkRule.Filter = { Prefix: '' };
      }

      return sdkRule;
    });

    await this.s3Client.send(
      new PutBucketLifecycleConfigurationCommand({
        Bucket: bucketName,
        LifecycleConfiguration: { Rules: rules },
      })
    );
    this.logger.debug(`Applied lifecycle configuration to bucket ${bucketName}`);
  }

  /**
   * Apply public access block configuration
   *
   * CFn property: PublicAccessBlockConfiguration
   * SDK: PutPublicAccessBlock with PublicAccessBlockConfiguration
   * Field names are identical between CFn and SDK.
   */
  private async applyPublicAccessBlockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.s3Client.send(
      new PutPublicAccessBlockCommand({
        Bucket: bucketName,
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: config['BlockPublicAcls'] as boolean | undefined,
          BlockPublicPolicy: config['BlockPublicPolicy'] as boolean | undefined,
          IgnorePublicAcls: config['IgnorePublicAcls'] as boolean | undefined,
          RestrictPublicBuckets: config['RestrictPublicBuckets'] as boolean | undefined,
        },
      })
    );
    this.logger.debug(`Applied public access block configuration to bucket ${bucketName}`);
  }

  /**
   * Apply bucket encryption configuration
   *
   * CFn property: BucketEncryption.ServerSideEncryptionConfiguration[]
   * SDK: PutBucketEncryption with ServerSideEncryptionConfiguration.Rules[]
   *
   * CFn ServerSideEncryptionRule fields:
   * - ServerSideEncryptionByDefault.SSEAlgorithm, KMSMasterKeyID
   * - BucketKeyEnabled
   */
  private async applyBucketEncryption(
    bucketName: string,
    encryptionConfig: { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rules = encryptionConfig.ServerSideEncryptionConfiguration.map((rule): any => {
      const byDefault = rule['ServerSideEncryptionByDefault'] as
        | Record<string, unknown>
        | undefined;
      return {
        ApplyServerSideEncryptionByDefault: byDefault
          ? {
              SSEAlgorithm: byDefault['SSEAlgorithm'] as string,
              KMSMasterKeyID: byDefault['KMSMasterKeyID'] as string | undefined,
            }
          : undefined,
        BucketKeyEnabled: rule['BucketKeyEnabled'] as boolean | undefined,
      };
    });
    await this.s3Client.send(
      new PutBucketEncryptionCommand({
        Bucket: bucketName,
        ServerSideEncryptionConfiguration: { Rules: rules },
      })
    );
    this.logger.debug(`Applied encryption configuration to bucket ${bucketName}`);
  }

  /**
   * Apply logging configuration
   *
   * CFn property: LoggingConfiguration
   *   - DestinationBucketName -> SDK TargetBucket
   *   - LogFilePrefix -> SDK TargetPrefix
   * SDK: PutBucketLogging with BucketLoggingStatus.LoggingEnabled
   */
  private async applyLoggingConfiguration(
    bucketName: string,
    loggingConfig: Record<string, unknown> | undefined
  ): Promise<void> {
    // S3 supports clearing logging by sending an empty BucketLoggingStatus
    // (no LoggingEnabled field). When loggingConfig is undefined or has no
    // DestinationBucketName, we issue the clearing call.
    if (!loggingConfig || !loggingConfig['DestinationBucketName']) {
      await this.s3Client.send(
        new PutBucketLoggingCommand({
          Bucket: bucketName,
          BucketLoggingStatus: {},
        })
      );
      this.logger.debug(`Cleared logging configuration on bucket ${bucketName}`);
      return;
    }
    await this.s3Client.send(
      new PutBucketLoggingCommand({
        Bucket: bucketName,
        BucketLoggingStatus: {
          LoggingEnabled: {
            TargetBucket: loggingConfig['DestinationBucketName'] as string,
            TargetPrefix: (loggingConfig['LogFilePrefix'] as string) || '',
          },
        },
      })
    );
    this.logger.debug(`Applied logging configuration to bucket ${bucketName}`);
  }

  /**
   * Apply website configuration
   *
   * CFn property: WebsiteConfiguration
   *   - IndexDocument -> SDK IndexDocument.Suffix
   *   - ErrorDocument -> SDK ErrorDocument.Key
   *   - RoutingRules -> SDK RoutingRules[]
   *   - RedirectAllRequestsTo -> SDK RedirectAllRequestsTo
   * SDK: PutBucketWebsite with WebsiteConfiguration
   */
  private async applyWebsiteConfiguration(
    bucketName: string,
    websiteConfig: Record<string, unknown>
  ): Promise<void> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sdkConfig: any = {};

    const indexDoc = websiteConfig['IndexDocument'] as string | undefined;
    if (indexDoc) {
      sdkConfig['IndexDocument'] = { Suffix: indexDoc };
    }

    const errorDoc = websiteConfig['ErrorDocument'] as string | undefined;
    if (errorDoc) {
      sdkConfig['ErrorDocument'] = { Key: errorDoc };
    }

    const redirectAll = websiteConfig['RedirectAllRequestsTo'] as
      | Record<string, unknown>
      | undefined;
    if (redirectAll) {
      sdkConfig['RedirectAllRequestsTo'] = {
        HostName: redirectAll['HostName'] as string,
        Protocol: redirectAll['Protocol'] as string | undefined,
      };
    }

    const routingRules = websiteConfig['RoutingRules'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (routingRules && Array.isArray(routingRules)) {
      sdkConfig['RoutingRules'] = routingRules.map((rule) => {
        const condition = rule['RoutingRuleCondition'] as Record<string, unknown> | undefined;
        const redirect = rule['RedirectRule'] as Record<string, unknown> | undefined;
        return {
          Condition: condition
            ? {
                HttpErrorCodeReturnedEquals: condition['HttpErrorCodeReturnedEquals'] as
                  | string
                  | undefined,
                KeyPrefixEquals: condition['KeyPrefixEquals'] as string | undefined,
              }
            : undefined,
          Redirect: redirect
            ? {
                HostName: redirect['HostName'] as string | undefined,
                HttpRedirectCode: redirect['HttpRedirectCode'] as string | undefined,
                Protocol: redirect['Protocol'] as string | undefined,
                ReplaceKeyPrefixWith: redirect['ReplaceKeyPrefixWith'] as string | undefined,
                ReplaceKeyWith: redirect['ReplaceKeyWith'] as string | undefined,
              }
            : undefined,
        };
      });
    }

    await this.s3Client.send(
      new PutBucketWebsiteCommand({
        Bucket: bucketName,
        WebsiteConfiguration: sdkConfig,
      })
    );
    this.logger.debug(`Applied website configuration to bucket ${bucketName}`);
  }

  /**
   * Apply accelerate configuration
   *
   * CFn property: AccelerateConfiguration.AccelerationStatus
   * SDK: PutBucketAccelerateConfiguration with AccelerateConfiguration.Status
   */
  private async applyAccelerateConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    await this.s3Client.send(
      new PutBucketAccelerateConfigurationCommand({
        Bucket: bucketName,
        AccelerateConfiguration: {
          Status: config['AccelerationStatus'] as 'Enabled' | 'Suspended',
        },
      })
    );
    this.logger.debug(`Applied accelerate configuration to bucket ${bucketName}`);
  }

  /**
   * Apply notification configuration (full-replace via PutBucketNotificationConfiguration)
   *
   * CFn property: NotificationConfiguration with TopicConfigurations,
   *   QueueConfigurations, LambdaConfigurations, EventBridgeConfiguration.
   * SDK uses the same structure (PutBucketNotificationConfiguration replaces
   * the entire notification configuration in one call).
   */
  private async applyNotificationConfiguration(
    bucketName: string,
    notifConfig: Record<string, unknown> | undefined
  ): Promise<void> {
    // PutBucketNotificationConfiguration is a full-replace API; sending an
    // empty NotificationConfiguration clears all notifications.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const cfg: any = {};

    if (notifConfig) {
      const topics = notifConfig['TopicConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (topics && Array.isArray(topics) && topics.length > 0) {
        cfg.TopicConfigurations = topics.map((t) => ({
          Id: t['Id'] as string | undefined,
          TopicArn: (t['Topic'] ?? t['TopicArn']) as string,
          Events: t['Event'] !== undefined ? [t['Event'] as string] : (t['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(t['Filter']),
        }));
      }
      const queues = notifConfig['QueueConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (queues && Array.isArray(queues) && queues.length > 0) {
        cfg.QueueConfigurations = queues.map((q) => ({
          Id: q['Id'] as string | undefined,
          QueueArn: (q['Queue'] ?? q['QueueArn']) as string,
          Events: q['Event'] !== undefined ? [q['Event'] as string] : (q['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(q['Filter']),
        }));
      }
      const lambdas = notifConfig['LambdaConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined;
      if (lambdas && Array.isArray(lambdas) && lambdas.length > 0) {
        cfg.LambdaFunctionConfigurations = lambdas.map((l) => ({
          Id: l['Id'] as string | undefined,
          LambdaFunctionArn: (l['Function'] ?? l['LambdaFunctionArn']) as string,
          Events: l['Event'] !== undefined ? [l['Event'] as string] : (l['Events'] as string[]),
          Filter: this.cfnNotifFilterToSdk(l['Filter']),
        }));
      }
      const eb = notifConfig['EventBridgeConfiguration'] as Record<string, unknown> | undefined;
      if (eb !== undefined) {
        // CFn EventBridgeConfiguration is `{}` (empty object means enabled)
        // SDK expects the same empty object to enable.
        cfg.EventBridgeConfiguration = {};
      }
    }

    await this.s3Client.send(
      new PutBucketNotificationConfigurationCommand({
        Bucket: bucketName,
        NotificationConfiguration: cfg,
      })
    );
    this.logger.debug(`Applied notification configuration to bucket ${bucketName}`);
  }

  /**
   * Convert CFn notification Filter ({ S3Key: { Rules: [{ Name, Value }] } })
   * to SDK NotificationConfigurationFilter.Key.FilterRules.
   */
  private cfnNotifFilterToSdk(
    filter: unknown
  ): { Key: { FilterRules: Array<{ Name: string; Value: string }> } } | undefined {
    if (!filter || typeof filter !== 'object') return undefined;
    const f = filter as Record<string, unknown>;
    const s3Key = f['S3Key'] as Record<string, unknown> | undefined;
    if (!s3Key) return undefined;
    const rules = s3Key['Rules'] as Array<{ Name?: string; Value?: string }> | undefined;
    if (!rules || !Array.isArray(rules) || rules.length === 0) return undefined;
    return {
      Key: {
        FilterRules: rules
          .filter((r) => r.Name !== undefined && r.Value !== undefined)
          .map((r) => ({ Name: r.Name as string, Value: r.Value as string })),
      },
    };
  }

  /**
   * Apply metrics configurations
   *
   * CFn property: MetricsConfigurations[] (array of configurations)
   * SDK: PutBucketMetricsConfiguration (one per configuration, keyed by Id)
   */
  private async applyMetricsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const filter = config['TagFilters'] || config['Prefix'] || config['AccessPointArn'];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metricsConfig: any = {
        Id: id,
      };
      if (config['Prefix']) {
        metricsConfig.Filter = { Prefix: config['Prefix'] as string };
      } else if (config['TagFilters']) {
        const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }>;
        if (tagFilters.length === 1 && !config['Prefix'] && !config['AccessPointArn']) {
          metricsConfig.Filter = { Tag: tagFilters[0] };
        } else {
          metricsConfig.Filter = {
            And: {
              Prefix: config['Prefix'] as string | undefined,
              Tags: tagFilters,
              AccessPointArn: config['AccessPointArn'] as string | undefined,
            },
          };
        }
      } else if (config['AccessPointArn']) {
        metricsConfig.Filter = { AccessPointArn: config['AccessPointArn'] as string };
      } else if (filter === undefined) {
        // No filter - applies to all objects
      }
      await this.s3Client.send(
        new PutBucketMetricsConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          MetricsConfiguration: metricsConfig,
        })
      );
    }
    this.logger.debug(`Applied ${configs.length} metrics configuration(s) to bucket ${bucketName}`);
  }

  /**
   * Apply analytics configurations
   *
   * CFn property: AnalyticsConfigurations[] (array of configurations)
   * SDK: PutBucketAnalyticsConfiguration (one per configuration, keyed by Id)
   */
  private async applyAnalyticsConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const storageClassAnalysis = config['StorageClassAnalysis'] as
        | Record<string, unknown>
        | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const analyticsConfig: any = {
        Id: id,
        StorageClassAnalysis: {},
      };

      // Filter
      const prefix = config['Prefix'] as string | undefined;
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (prefix || (tagFilters && tagFilters.length > 0)) {
        const hasMultiple = (prefix ? 1 : 0) + (tagFilters && tagFilters.length > 0 ? 1 : 0) > 1;
        if (hasMultiple) {
          analyticsConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
        } else if (prefix) {
          analyticsConfig.Filter = { Prefix: prefix };
        } else if (tagFilters && tagFilters.length > 0) {
          analyticsConfig.Filter = { Tag: tagFilters[0] };
        }
      }

      // StorageClassAnalysis.DataExport
      if (storageClassAnalysis?.['DataExport']) {
        const dataExport = storageClassAnalysis['DataExport'] as Record<string, unknown>;
        const dest = dataExport['Destination'] as Record<string, unknown> | undefined;
        const s3Dest =
          dest?.['BucketAccountId'] || dest?.['BucketArn'] || dest?.['Format']
            ? dest
            : (dest?.['S3BucketDestination'] as Record<string, unknown> | undefined);
        analyticsConfig.StorageClassAnalysis = {
          DataExport: {
            OutputSchemaVersion: (dataExport['OutputSchemaVersion'] as string) || 'V_1',
            Destination: s3Dest
              ? {
                  S3BucketDestination: {
                    Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                    BucketAccountId: s3Dest['BucketAccountId'] as string | undefined,
                    Format: (s3Dest['Format'] as string) || 'CSV',
                    Prefix: s3Dest['Prefix'] as string | undefined,
                  },
                }
              : undefined,
          },
        };
      }

      await this.s3Client.send(
        new PutBucketAnalyticsConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          AnalyticsConfiguration: analyticsConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} analytics configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply intelligent tiering configurations
   *
   * CFn property: IntelligentTieringConfigurations[]
   * SDK: PutBucketIntelligentTieringConfiguration (one per configuration, keyed by Id)
   */
  private async applyIntelligentTieringConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const tierings = config['Tierings'] as Array<Record<string, unknown>> | undefined;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const itConfig: any = {
        Id: id,
        Status: (config['Status'] as string) || 'Enabled',
        Tierings: (tierings || []).map((t: Record<string, unknown>) => ({
          AccessTier: t['AccessTier'] as string,
          Days: t['Days'] as number,
        })),
      };

      // Filter
      const prefix = config['Prefix'] as string | undefined;
      const tagFilters = config['TagFilters'] as Array<{ Key: string; Value: string }> | undefined;
      if (prefix || (tagFilters && tagFilters.length > 0)) {
        const hasMultiple = (prefix ? 1 : 0) + (tagFilters && tagFilters.length > 0 ? 1 : 0) > 1;
        if (hasMultiple) {
          itConfig.Filter = { And: { Prefix: prefix, Tags: tagFilters } };
        } else if (prefix) {
          itConfig.Filter = { Prefix: prefix };
        } else if (tagFilters && tagFilters.length > 0) {
          itConfig.Filter = { Tag: tagFilters[0] };
        }
      }

      await this.s3Client.send(
        new PutBucketIntelligentTieringConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          IntelligentTieringConfiguration: itConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} intelligent tiering configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply inventory configurations
   *
   * CFn property: InventoryConfigurations[]
   * SDK: PutBucketInventoryConfiguration (one per configuration, keyed by Id)
   */
  private async applyInventoryConfigurations(
    bucketName: string,
    configs: Array<Record<string, unknown>>
  ): Promise<void> {
    for (const config of configs) {
      const id = config['Id'] as string;
      const dest = config['Destination'] as Record<string, unknown> | undefined;
      const s3Dest =
        dest?.['BucketArn'] || dest?.['Format']
          ? dest
          : (dest?.['S3BucketDestination'] as Record<string, unknown> | undefined);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const inventoryConfig: any = {
        Id: id,
        IsEnabled: (config['Enabled'] as boolean) ?? true,
        IncludedObjectVersions: (config['IncludedObjectVersions'] as string) || 'All',
        Schedule: {
          Frequency: (config['ScheduleFrequency'] ??
            (config['Schedule'] as Record<string, unknown> | undefined)?.['Frequency'] ??
            'Weekly') as string,
        },
        Destination: {
          S3BucketDestination: s3Dest
            ? {
                Bucket: (s3Dest['BucketArn'] ?? s3Dest['Bucket']) as string,
                AccountId: s3Dest['BucketAccountId'] as string | undefined,
                Format: (s3Dest['Format'] as string) || 'CSV',
                Prefix: s3Dest['Prefix'] as string | undefined,
              }
            : undefined,
        },
        OptionalFields: config['OptionalFields'] as string[] | undefined,
        Filter: config['Prefix'] ? { Prefix: config['Prefix'] as string } : undefined,
      };

      await this.s3Client.send(
        new PutBucketInventoryConfigurationCommand({
          Bucket: bucketName,
          Id: id,
          InventoryConfiguration: inventoryConfig,
        })
      );
    }
    this.logger.debug(
      `Applied ${configs.length} inventory configuration(s) to bucket ${bucketName}`
    );
  }

  /**
   * Apply replication configuration
   *
   * CFn property: ReplicationConfiguration
   *   - Role (IAM role ARN)
   *   - Rules[] (replication rules)
   * SDK: PutBucketReplication with ReplicationConfiguration
   */
  private async applyReplicationConfiguration(
    bucketName: string,
    replConfig: Record<string, unknown>
  ): Promise<void> {
    const rules = replConfig['Rules'] as Array<Record<string, unknown>> | undefined;
    await this.s3Client.send(
      new PutBucketReplicationCommand({
        Bucket: bucketName,
        ReplicationConfiguration: {
          Role: replConfig['Role'] as string,
          Rules: (rules || []).map((rule) => {
            const dest = rule['Destination'] as Record<string, unknown>;
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const sdkRule: any = {
              ID: rule['Id'] as string | undefined,
              Status: (rule['Status'] as string) || 'Enabled',
              Priority: rule['Priority'] as number | undefined,
              Destination: {
                Bucket: dest['Bucket'] as string,
                Account: dest['Account'] as string | undefined,
                StorageClass: dest['StorageClass'] as string | undefined,
              },
            };

            // Filter
            const filter = rule['Filter'] as Record<string, unknown> | undefined;
            if (filter) {
              const prefix = filter['Prefix'] as string | undefined;
              const tagFilter = filter['TagFilter'] as { Key: string; Value: string } | undefined;
              if (prefix && tagFilter) {
                sdkRule['Filter'] = { And: { Prefix: prefix, Tags: [tagFilter] } };
              } else if (prefix) {
                sdkRule['Filter'] = { Prefix: prefix };
              } else if (tagFilter) {
                sdkRule['Filter'] = { Tag: tagFilter };
              }
            } else if (rule['Prefix'] !== undefined) {
              sdkRule['Prefix'] = rule['Prefix'] as string;
            }

            // DeleteMarkerReplication
            if (rule['DeleteMarkerReplication']) {
              const dmr = rule['DeleteMarkerReplication'] as Record<string, unknown>;
              sdkRule['DeleteMarkerReplication'] = { Status: dmr['Status'] as string };
            }

            return sdkRule;
          }),
        },
      })
    );
    this.logger.debug(`Applied replication configuration to bucket ${bucketName}`);
  }

  /**
   * Apply object lock configuration
   *
   * CFn property: ObjectLockConfiguration
   *   - ObjectLockEnabled: 'Enabled'
   *   - Rule.DefaultRetention (Mode, Days, Years)
   * SDK: PutObjectLockConfiguration with ObjectLockConfiguration
   *
   * Note: ObjectLockEnabled at bucket level must be set at creation time.
   * This method only applies the rule/default retention config post-creation.
   */
  private async applyObjectLockConfiguration(
    bucketName: string,
    config: Record<string, unknown>
  ): Promise<void> {
    const rule = config['Rule'] as Record<string, unknown> | undefined;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const objectLockConfig: any = {
      ObjectLockEnabled: 'Enabled',
    };
    if (rule) {
      const retention = rule['DefaultRetention'] as Record<string, unknown> | undefined;
      if (retention) {
        objectLockConfig.Rule = {
          DefaultRetention: {
            Mode: retention['Mode'] as string | undefined,
            Days: retention['Days'] as number | undefined,
            Years: retention['Years'] as number | undefined,
          },
        };
      }
    }
    await this.s3Client.send(
      new PutObjectLockConfigurationCommand({
        Bucket: bucketName,
        ObjectLockConfiguration: objectLockConfig,
      })
    );
    this.logger.debug(`Applied object lock configuration to bucket ${bucketName}`);
  }

  /**
   * Apply additional bucket configuration after creation
   */
  private async applyConfiguration(
    bucketName: string,
    properties: Record<string, unknown>,
    skipTags = false
  ): Promise<void> {
    // Versioning
    const versioningConfig = properties['VersioningConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (versioningConfig) {
      await this.applyVersioning(bucketName, versioningConfig);
    }

    // Tags. Only applied at create time here (`applyTags` is full-replace, no
    // removal). For update, the caller passes `skipTags=true` and uses the
    // diff-aware `applyTagDiff` helper instead.
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (!skipTags && tags && Array.isArray(tags) && tags.length > 0) {
      await this.applyTags(bucketName, tags);
    }

    // Ownership Controls (e.g., BucketOwnerPreferred for CloudFront logs)
    const ownershipControls = properties['OwnershipControls'] as
      | { Rules: Array<{ ObjectOwnership: string }> }
      | undefined;
    if (ownershipControls?.Rules) {
      await this.s3Client.send(
        new PutBucketOwnershipControlsCommand({
          Bucket: bucketName,
          OwnershipControls: {
            Rules: ownershipControls.Rules.map((r) => ({
              ObjectOwnership: r.ObjectOwnership as ObjectOwnership,
            })),
          },
        })
      );
      this.logger.debug(`Applied ownership controls to bucket ${bucketName}`);
    }

    // Public Access Block Configuration
    const publicAccessBlock = properties['PublicAccessBlockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (publicAccessBlock) {
      await this.applyPublicAccessBlockConfiguration(bucketName, publicAccessBlock);
    }

    // Bucket Encryption. Skip empty-rules placeholder (Class 2): AWS
    // rejects `PutBucketEncryption` when the rules array is empty
    // (`ServerSideEncryptionConfiguration must contain at least one
    // Rule`). `readCurrentState` always-emits
    // `BucketEncryption: { ServerSideEncryptionConfiguration: [] }` for
    // buckets without explicit SSE — that placeholder must NOT be pushed
    // back through `update()` on a `cdkd drift --revert` round-trip.
    const bucketEncryption = properties['BucketEncryption'] as
      | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
      | undefined;
    if (
      bucketEncryption?.ServerSideEncryptionConfiguration &&
      Array.isArray(bucketEncryption.ServerSideEncryptionConfiguration) &&
      bucketEncryption.ServerSideEncryptionConfiguration.length > 0
    ) {
      await this.applyBucketEncryption(bucketName, bucketEncryption);
    }
  }

  /**
   * Diff CFn-shape sub-config values between previous and new state.
   *
   * Three transitions:
   * - undefined -> defined  (value differs from previous, OR previous undefined): Put
   * - defined -> undefined: Delete
   * - defined -> defined (different): Put
   * - unchanged: skip
   *
   * For the array-shaped configs (Metrics / Analytics / IntelligentTier /
   * Inventory) this is per-id rather than per-config — see the dedicated
   * helpers below.
   */
  private async diffSubConfig<T>(
    _bucketName: string,
    oldVal: T | undefined,
    newVal: T | undefined,
    onPut: (newVal: T) => Promise<void>,
    onDelete: () => Promise<void>
  ): Promise<void> {
    const same = JSON.stringify(oldVal ?? null) === JSON.stringify(newVal ?? null);
    if (same) return;
    if (newVal === undefined || newVal === null) {
      await onDelete();
      return;
    }
    await onPut(newVal);
  }

  /**
   * Per-id diff for the four array-shaped configs (MetricsConfigurations,
   * AnalyticsConfigurations, IntelligentTieringConfigurations,
   * InventoryConfigurations). Each AWS API operates on one config per
   * (bucket, id) pair: Put-on-add or Put-on-change, Delete-on-removed.
   */
  private async diffArrayConfigById(
    _bucketName: string,
    oldArr: Array<Record<string, unknown>> | undefined,
    newArr: Array<Record<string, unknown>> | undefined,
    onPut: (id: string, config: Record<string, unknown>) => Promise<void>,
    onDelete: (id: string) => Promise<void>
  ): Promise<void> {
    const oldById = new Map<string, Record<string, unknown>>();
    for (const c of oldArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) oldById.set(id, c);
    }
    const newById = new Map<string, Record<string, unknown>>();
    for (const c of newArr ?? []) {
      const id = c['Id'] as string | undefined;
      if (id) newById.set(id, c);
    }

    // Adds + changes
    for (const [id, cfg] of newById) {
      const old = oldById.get(id);
      if (!old || JSON.stringify(old) !== JSON.stringify(cfg)) {
        await onPut(id, cfg);
      }
    }
    // Deletes
    for (const id of oldById.keys()) {
      if (!newById.has(id)) {
        await onDelete(id);
      }
    }
  }

  /**
   * Apply the diff between previous and new sub-configs, issuing Put / Delete
   * SDK calls only for differing keys. Called from `update()`.
   *
   * Versioning / PublicAccessBlock / Tags / OwnershipControls / BucketEncryption
   * stay on `applyConfiguration` (the unconditional always-PUT path) because
   * their AWS APIs don't have a clean "delete" counterpart and they
   * round-trip safely as no-ops when state == AWS-current. The 12 sub-configs
   * below DO have proper Put/Delete pairs so the diff path is preferable.
   */
  private async applySubConfigDiffs(
    bucketName: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<void> {
    // Lifecycle
    await this.diffSubConfig(
      bucketName,
      previousProperties['LifecycleConfiguration'] as
        | { Rules: Array<Record<string, unknown>> }
        | undefined,
      properties['LifecycleConfiguration'] as { Rules: Array<Record<string, unknown>> } | undefined,
      async (cfg) => {
        // Skip empty-rules placeholder (Class 2)
        if (!cfg.Rules || !Array.isArray(cfg.Rules) || cfg.Rules.length === 0) return;
        await this.applyLifecycleConfiguration(bucketName, cfg);
      },
      async () => {
        await this.s3Client.send(new DeleteBucketLifecycleCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted lifecycle configuration on bucket ${bucketName}`);
      }
    );

    // CORS
    await this.diffSubConfig(
      bucketName,
      previousProperties['CorsConfiguration'] as
        | { CorsRules: Array<Record<string, unknown>> }
        | undefined,
      properties['CorsConfiguration'] as { CorsRules: Array<Record<string, unknown>> } | undefined,
      async (cfg) => {
        // Skip empty-rules placeholder (Class 2)
        if (!cfg.CorsRules || !Array.isArray(cfg.CorsRules) || cfg.CorsRules.length === 0) return;
        await this.applyCorsConfiguration(bucketName, cfg);
      },
      async () => {
        await this.s3Client.send(new DeleteBucketCorsCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted CORS configuration on bucket ${bucketName}`);
      }
    );

    // Website
    await this.diffSubConfig(
      bucketName,
      previousProperties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
      properties['WebsiteConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyWebsiteConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketWebsiteCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted website configuration on bucket ${bucketName}`);
      }
    );

    // Logging — no DeleteBucketLogging API; clearing is via PutBucketLogging
    // with empty BucketLoggingStatus.
    await this.diffSubConfig(
      bucketName,
      previousProperties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      properties['LoggingConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyLoggingConfiguration(bucketName, cfg),
      async () => this.applyLoggingConfiguration(bucketName, undefined)
    );

    // Notification — no DeleteBucketNotification API; clearing is via
    // PutBucketNotificationConfiguration with empty NotificationConfiguration.
    await this.diffSubConfig(
      bucketName,
      previousProperties['NotificationConfiguration'] as Record<string, unknown> | undefined,
      properties['NotificationConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyNotificationConfiguration(bucketName, cfg),
      async () => this.applyNotificationConfiguration(bucketName, undefined)
    );

    // Replication
    await this.diffSubConfig(
      bucketName,
      previousProperties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      properties['ReplicationConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyReplicationConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(new DeleteBucketReplicationCommand({ Bucket: bucketName }));
        this.logger.debug(`Deleted replication configuration on bucket ${bucketName}`);
      }
    );

    // Object Lock — no DeleteObjectLockConfiguration API; the bucket-level
    // ObjectLockEnabled flag is set at creation time and cannot be cleared
    // via Put. The Rule (default retention) can be reset via Put with no
    // Rule, so a transition from "configured" -> undefined just sends an
    // empty-Rule Put. AWS accepts this for buckets that already have
    // ObjectLockEnabled.
    await this.diffSubConfig(
      bucketName,
      previousProperties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
      properties['ObjectLockConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyObjectLockConfiguration(bucketName, cfg),
      async () => {
        await this.s3Client.send(
          new PutObjectLockConfigurationCommand({
            Bucket: bucketName,
            ObjectLockConfiguration: { ObjectLockEnabled: 'Enabled' },
          })
        );
        this.logger.debug(`Cleared object lock rule on bucket ${bucketName}`);
      }
    );

    // Accelerate — no DeleteBucketAccelerate API; clearing is via
    // PutBucketAccelerateConfiguration with Status='Suspended'.
    await this.diffSubConfig(
      bucketName,
      previousProperties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
      properties['AccelerateConfiguration'] as Record<string, unknown> | undefined,
      async (cfg) => this.applyAccelerateConfiguration(bucketName, cfg),
      async () => this.applyAccelerateConfiguration(bucketName, { AccelerationStatus: 'Suspended' })
    );

    // Metrics (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['MetricsConfigurations'] as Array<Record<string, unknown>> | undefined,
      async (_id, cfg) => this.applyMetricsConfigurations(bucketName, [cfg]),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketMetricsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted metrics configuration ${id} on bucket ${bucketName}`);
      }
    );

    // Analytics (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['AnalyticsConfigurations'] as Array<Record<string, unknown>> | undefined,
      async (_id, cfg) => this.applyAnalyticsConfigurations(bucketName, [cfg]),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketAnalyticsConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted analytics configuration ${id} on bucket ${bucketName}`);
      }
    );

    // IntelligentTiering (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['IntelligentTieringConfigurations'] as
        | Array<Record<string, unknown>>
        | undefined,
      properties['IntelligentTieringConfigurations'] as Array<Record<string, unknown>> | undefined,
      async (_id, cfg) => this.applyIntelligentTieringConfigurations(bucketName, [cfg]),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketIntelligentTieringConfigurationCommand({
            Bucket: bucketName,
            Id: id,
          })
        );
        this.logger.debug(
          `Deleted intelligent tiering configuration ${id} on bucket ${bucketName}`
        );
      }
    );

    // Inventory (per-id diff)
    await this.diffArrayConfigById(
      bucketName,
      previousProperties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
      properties['InventoryConfigurations'] as Array<Record<string, unknown>> | undefined,
      async (_id, cfg) => this.applyInventoryConfigurations(bucketName, [cfg]),
      async (id) => {
        await this.s3Client.send(
          new DeleteBucketInventoryConfigurationCommand({ Bucket: bucketName, Id: id })
        );
        this.logger.debug(`Deleted inventory configuration ${id} on bucket ${bucketName}`);
      }
    );
  }

  /**
   * Apply ALL sub-configs unconditionally on initial create. Used by
   * `create()` so the bucket starts out matching the template.
   */
  private async applyAllSubConfigsForCreate(
    bucketName: string,
    properties: Record<string, unknown>
  ): Promise<void> {
    // Notification (with EventBridge gate kept for backwards-compat with the
    // pre-existing single-EventBridge create path)
    const notifConfig = properties['NotificationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (notifConfig) {
      await this.applyNotificationConfiguration(bucketName, notifConfig);
    }

    // CORS — skip empty-rules placeholder
    const corsConfig = properties['CorsConfiguration'] as
      | { CorsRules: Array<Record<string, unknown>> }
      | undefined;
    if (
      corsConfig?.CorsRules &&
      Array.isArray(corsConfig.CorsRules) &&
      corsConfig.CorsRules.length > 0
    ) {
      await this.applyCorsConfiguration(bucketName, corsConfig);
    }

    // Lifecycle — skip empty-rules placeholder
    const lifecycleConfig = properties['LifecycleConfiguration'] as
      | { Rules: Array<Record<string, unknown>> }
      | undefined;
    if (
      lifecycleConfig?.Rules &&
      Array.isArray(lifecycleConfig.Rules) &&
      lifecycleConfig.Rules.length > 0
    ) {
      await this.applyLifecycleConfiguration(bucketName, lifecycleConfig);
    }

    // Logging
    const loggingConfig = properties['LoggingConfiguration'] as Record<string, unknown> | undefined;
    if (loggingConfig?.['DestinationBucketName']) {
      await this.applyLoggingConfiguration(bucketName, loggingConfig);
    }

    // Website
    const websiteConfig = properties['WebsiteConfiguration'] as Record<string, unknown> | undefined;
    if (websiteConfig) {
      await this.applyWebsiteConfiguration(bucketName, websiteConfig);
    }

    // Accelerate
    const accelerateConfig = properties['AccelerateConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (accelerateConfig) {
      await this.applyAccelerateConfiguration(bucketName, accelerateConfig);
    }

    // Metrics Configurations
    const metricsConfigs = properties['MetricsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (metricsConfigs && Array.isArray(metricsConfigs) && metricsConfigs.length > 0) {
      await this.applyMetricsConfigurations(bucketName, metricsConfigs);
    }

    // Analytics Configurations
    const analyticsConfigs = properties['AnalyticsConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (analyticsConfigs && Array.isArray(analyticsConfigs) && analyticsConfigs.length > 0) {
      await this.applyAnalyticsConfigurations(bucketName, analyticsConfigs);
    }

    // Intelligent Tiering Configurations
    const itConfigs = properties['IntelligentTieringConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (itConfigs && Array.isArray(itConfigs) && itConfigs.length > 0) {
      await this.applyIntelligentTieringConfigurations(bucketName, itConfigs);
    }

    // Inventory Configurations
    const inventoryConfigs = properties['InventoryConfigurations'] as
      | Array<Record<string, unknown>>
      | undefined;
    if (inventoryConfigs && Array.isArray(inventoryConfigs) && inventoryConfigs.length > 0) {
      await this.applyInventoryConfigurations(bucketName, inventoryConfigs);
    }

    // Replication Configuration
    const replConfig = properties['ReplicationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (replConfig) {
      await this.applyReplicationConfiguration(bucketName, replConfig);
    }

    // Object Lock Configuration (rule/retention, not the ObjectLockEnabled flag)
    const objectLockConfig = properties['ObjectLockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (objectLockConfig) {
      await this.applyObjectLockConfiguration(bucketName, objectLockConfig);
    }
  }

  /**
   * Create an S3 bucket
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating S3 bucket ${logicalId}`);

    const bucketName =
      (properties['BucketName'] as string | undefined) ||
      generateResourceName(logicalId, {
        maxLength: 63,
        lowercase: true,
        allowedPattern: /[^a-z0-9.-]/g,
      });

    try {
      // CreateBucket params
      const createParams: {
        Bucket: string;
        CreateBucketConfiguration?: { LocationConstraint: BucketLocationConstraint };
        ObjectLockEnabledForBucket?: boolean;
      } = {
        Bucket: bucketName,
      };

      // Add LocationConstraint for non-us-east-1 regions
      const region = await this.getRegion();
      if (region !== 'us-east-1') {
        createParams.CreateBucketConfiguration = {
          LocationConstraint: region as BucketLocationConstraint,
        };
      }

      // ObjectLockEnabled must be set at bucket creation time
      if (properties['ObjectLockEnabled'] === true || properties['ObjectLockEnabled'] === 'true') {
        createParams.ObjectLockEnabledForBucket = true;
      }

      // Track whether THIS call actually created the bucket (vs hit the
      // idempotent `BucketAlreadyOwnedByYou` fallback). Only the truly-
      // created case is eligible for partial-failure cleanup — deleting a
      // pre-existing bucket would destroy a user resource that lived
      // before this deploy ran.
      let createdNewBucket = false;
      try {
        await this.s3Client.send(new CreateBucketCommand(createParams));
        createdNewBucket = true;
        this.logger.debug(`Created S3 bucket: ${bucketName}`);
      } catch (createError) {
        // "BucketAlreadyOwnedByYou" is success (idempotent create)
        if (
          createError instanceof Error &&
          (createError.name === 'BucketAlreadyOwnedByYou' ||
            createError.message.includes('you already own it'))
        ) {
          this.logger.debug(`S3 bucket ${bucketName} already exists and is owned by you`);
        } else {
          throw createError;
        }
      }

      // Apply additional configuration in an inner try so a wiring
      // failure can be self-healed by issuing a best-effort `DeleteBucket`
      // cleanup. Without this, a sub-config failure leaves an orphan
      // bucket that AWS will reject on the next redeploy. The cleanup
      // is gated on `createdNewBucket` so we never delete a pre-existing
      // bucket. See Issue #376 for the cross-provider sweep.
      try {
        await this.applyConfiguration(bucketName, properties);
        await this.applyAllSubConfigsForCreate(bucketName, properties);
      } catch (innerError) {
        if (createdNewBucket) {
          try {
            await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
            this.logger.debug(
              `Cleaned up partially-created S3 bucket ${logicalId} (${bucketName}) after wiring failure`
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up partially-created S3 bucket ${logicalId} (${bucketName}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws s3api delete-bucket --bucket '${bucketName}'`
            );
          }
        }
        throw innerError;
      }

      const attributes = await this.buildAttributes(bucketName);

      this.logger.debug(`Successfully created S3 bucket ${logicalId}: ${bucketName}`);

      return {
        physicalId: bucketName,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        bucketName,
        cause
      );
    }
  }

  /**
   * Update an S3 bucket
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating S3 bucket ${logicalId}: ${physicalId}`);

    const newBucketName = properties['BucketName'] as string | undefined;

    // Bucket name is immutable - if changed, requires replacement
    if (newBucketName && newBucketName !== physicalId) {
      this.logger.debug(
        `Bucket name changed (${physicalId} -> ${newBucketName}), replacement required`
      );
      return {
        physicalId,
        wasReplaced: true,
      };
    }

    try {
      // Apply configuration changes (skip Tags - applyConfiguration only adds,
      // doesn't remove; we handle tags below to support removal too).
      // applyConfiguration is the always-PUT path for sub-configs that
      // don't have a clean Delete API counterpart (Versioning / PAB / SSE).
      await this.applyConfiguration(physicalId, properties, /* skipTags */ true);

      // Apply diff-aware Put/Delete for the 12 sub-configs that have proper
      // Put/Delete API pairs.
      await this.applySubConfigDiffs(physicalId, properties, previousProperties);

      // Apply tag diff. S3 uses PutBucketTagging (full-replace) and
      // DeleteBucketTagging when the new tag set is empty.
      await this.applyTagDiff(
        physicalId,
        previousProperties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined,
        properties['Tags'] as Array<{ Key?: string; Value?: string }> | undefined
      );

      const attributes = await this.buildAttributes(physicalId);

      this.logger.debug(`Successfully updated S3 bucket ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an S3 bucket
   *
   * Note: The bucket must be empty before deletion.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting S3 bucket ${logicalId}: ${physicalId}`);

    try {
      await this.deleteBucketWithEmptyRetry(logicalId, physicalId);
    } catch (error) {
      if (error instanceof NoSuchBucket) {
        const clientRegion = await this.s3Client.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Bucket ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete S3 bucket ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current S3 bucket configuration in CFn-property shape.
   *
   * Issues a small handful of independent S3 GET calls and stitches them
   * into a single CFn-shaped object. Each call can throw a "feature not
   * configured" error (`NoSuchBucketConfiguration`,
   * `ServerSideEncryptionConfigurationNotFoundError`, `NoSuchTagSet`,
   * `NoSuchPublicAccessBlockConfiguration`, etc.) — those are caught
   * individually and the corresponding key is emitted as a CFn-shape
   * placeholder (per docs/provider-development.md § 3b: always-emit
   * user-controllable top-level keys), NOT treated as the bucket being
   * absent.
   *
   * Only the bucket-gone case (`NoSuchBucket`, HTTP 404 from `HeadBucket`)
   * returns `undefined`.
   *
   * Coverage: `BucketName`, `VersioningConfiguration`, `BucketEncryption`,
   * `PublicAccessBlockConfiguration`, `Tags`, plus all 12 sub-configs:
   * `LifecycleConfiguration`, `CorsConfiguration`, `WebsiteConfiguration`,
   * `LoggingConfiguration`, `NotificationConfiguration`,
   * `ReplicationConfiguration`, `ObjectLockConfiguration`,
   * `AccelerateConfiguration`, `MetricsConfigurations`,
   * `AnalyticsConfigurations`, `IntelligentTieringConfigurations`,
   * `InventoryConfigurations`.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    // Fast existence check. Treat NotFound / NoSuchBucket as "drift unknown".
    try {
      await this.s3Client.send(new HeadBucketCommand({ Bucket: physicalId }));
    } catch (err) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (
        err instanceof NoSuchBucket ||
        e.name === 'NotFound' ||
        e.name === 'NoSuchBucket' ||
        e.$metadata?.httpStatusCode === 404
      ) {
        return undefined;
      }
      throw err;
    }

    // Fire all 15 GET / List calls in parallel. Each helper handles its own
    // "feature not configured" → placeholder fallback.
    const [
      versioning,
      encryption,
      pab,
      tags,
      lifecycle,
      cors,
      website,
      logging,
      notification,
      replication,
      objectLock,
      accelerate,
      metrics,
      analytics,
      intelligentTier,
      inventory,
    ] = await Promise.all([
      this.readVersioning(physicalId),
      this.readEncryption(physicalId),
      this.readPublicAccessBlock(physicalId),
      this.readTags(physicalId),
      this.readLifecycle(physicalId),
      this.readCors(physicalId),
      this.readWebsite(physicalId),
      this.readLogging(physicalId),
      this.readNotification(physicalId),
      this.readReplication(physicalId),
      this.readObjectLock(physicalId),
      this.readAccelerate(physicalId),
      this.readMetricsList(physicalId),
      this.readAnalyticsList(physicalId),
      this.readIntelligentTieringList(physicalId),
      this.readInventoryList(physicalId),
    ]);

    return {
      BucketName: physicalId,
      VersioningConfiguration: versioning,
      BucketEncryption: encryption,
      PublicAccessBlockConfiguration: pab,
      Tags: tags,
      LifecycleConfiguration: lifecycle,
      CorsConfiguration: cors,
      WebsiteConfiguration: website,
      LoggingConfiguration: logging,
      NotificationConfiguration: notification,
      ReplicationConfiguration: replication,
      ObjectLockConfiguration: objectLock,
      AccelerateConfiguration: accelerate,
      MetricsConfigurations: metrics,
      AnalyticsConfigurations: analytics,
      IntelligentTieringConfigurations: intelligentTier,
      InventoryConfigurations: inventory,
    };
  }

  // -------------------------------------------------------------------
  // readCurrentState helpers — one per sub-config. Each catches the
  // "feature not configured" error and returns the always-emit
  // placeholder shape per docs/provider-development.md § 3b.
  // -------------------------------------------------------------------

  private async readVersioning(bucket: string): Promise<Record<string, unknown>> {
    // VersioningConfiguration { Status }. Always emit a placeholder so a
    // console-side enable on a never-versioned bucket surfaces as drift.
    // 'Suspended' is the semantic "off" value in CFn.
    const resp = await this.s3Client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    return { Status: resp.Status ?? 'Suspended' };
  }

  private async readEncryption(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketEncryptionCommand({ Bucket: bucket }));
      const rules = resp.ServerSideEncryptionConfiguration?.Rules ?? [];
      return {
        ServerSideEncryptionConfiguration: rules.map((rule) => {
          const out: Record<string, unknown> = {};
          const sse = rule.ApplyServerSideEncryptionByDefault;
          if (sse) {
            const sseOut: Record<string, unknown> = {};
            if (sse.SSEAlgorithm !== undefined) sseOut['SSEAlgorithm'] = sse.SSEAlgorithm;
            if (sse.KMSMasterKeyID !== undefined) sseOut['KMSMasterKeyID'] = sse.KMSMasterKeyID;
            out['ServerSideEncryptionByDefault'] = sseOut;
          }
          if (rule.BucketKeyEnabled !== undefined) out['BucketKeyEnabled'] = rule.BucketKeyEnabled;
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ServerSideEncryptionConfigurationNotFoundError') {
        return { ServerSideEncryptionConfiguration: [] };
      }
      throw err;
    }
  }

  private async readPublicAccessBlock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetPublicAccessBlockCommand({ Bucket: bucket }));
      const cfg = resp.PublicAccessBlockConfiguration;
      return {
        BlockPublicAcls: cfg?.BlockPublicAcls ?? false,
        BlockPublicPolicy: cfg?.BlockPublicPolicy ?? false,
        IgnorePublicAcls: cfg?.IgnorePublicAcls ?? false,
        RestrictPublicBuckets: cfg?.RestrictPublicBuckets ?? false,
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchPublicAccessBlockConfiguration') {
        return {
          BlockPublicAcls: false,
          BlockPublicPolicy: false,
          IgnorePublicAcls: false,
          RestrictPublicBuckets: false,
        };
      }
      throw err;
    }
  }

  private async readTags(bucket: string): Promise<Array<{ Key: string; Value: string }>> {
    try {
      const resp = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: bucket }));
      return normalizeAwsTagsToCfn(resp.TagSet);
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchTagSet') return [];
      throw err;
    }
  }

  private async readLifecycle(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetBucketLifecycleConfigurationCommand({ Bucket: bucket })
      );
      const rules = resp.Rules ?? [];
      return {
        Rules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.Status !== undefined) out['Status'] = r.Status;
          if (r.Prefix !== undefined) out['Prefix'] = r.Prefix;

          // Expiration
          if (r.Expiration) {
            const exp: Record<string, unknown> = {};
            if (r.Expiration.Days !== undefined) exp['Days'] = r.Expiration.Days;
            if (r.Expiration.Date !== undefined) exp['Date'] = r.Expiration.Date.toISOString();
            if (r.Expiration.ExpiredObjectDeleteMarker !== undefined)
              exp['ExpiredObjectDeleteMarker'] = r.Expiration.ExpiredObjectDeleteMarker;
            out['Expiration'] = exp;
          }

          // Transitions
          if (r.Transitions && r.Transitions.length > 0) {
            out['Transitions'] = r.Transitions.map((t) => {
              const item: Record<string, unknown> = {};
              if (t.Days !== undefined) item['TransitionInDays'] = t.Days;
              if (t.Date !== undefined) item['TransitionDate'] = t.Date.toISOString();
              if (t.StorageClass !== undefined) item['StorageClass'] = t.StorageClass;
              return item;
            });
          }

          // NoncurrentVersionExpiration
          if (r.NoncurrentVersionExpiration) {
            const nve: Record<string, unknown> = {};
            if (r.NoncurrentVersionExpiration.NoncurrentDays !== undefined)
              nve['NoncurrentDays'] = r.NoncurrentVersionExpiration.NoncurrentDays;
            if (r.NoncurrentVersionExpiration.NewerNoncurrentVersions !== undefined)
              nve['NewerNoncurrentVersions'] =
                r.NoncurrentVersionExpiration.NewerNoncurrentVersions;
            out['NoncurrentVersionExpiration'] = nve;
          }

          // NoncurrentVersionTransitions
          if (r.NoncurrentVersionTransitions && r.NoncurrentVersionTransitions.length > 0) {
            out['NoncurrentVersionTransitions'] = r.NoncurrentVersionTransitions.map((nvt) => {
              const item: Record<string, unknown> = {};
              if (nvt.NoncurrentDays !== undefined) item['NoncurrentDays'] = nvt.NoncurrentDays;
              if (nvt.StorageClass !== undefined) item['StorageClass'] = nvt.StorageClass;
              if (nvt.NewerNoncurrentVersions !== undefined)
                item['NewerNoncurrentVersions'] = nvt.NewerNoncurrentVersions;
              return item;
            });
          }

          // AbortIncompleteMultipartUpload
          if (r.AbortIncompleteMultipartUpload) {
            out['AbortIncompleteMultipartUpload'] = {
              DaysAfterInitiation: r.AbortIncompleteMultipartUpload.DaysAfterInitiation,
            };
          }

          // Filter — reverse-map SDK Filter shape (Tag / Prefix / And / etc)
          // back to CFn TagFilters / Prefix / ObjectSize* form.
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              if (and['Prefix'] !== undefined) cfnFilter['Prefix'] = and['Prefix'];
              if (and['Tags']) cfnFilter['TagFilters'] = and['Tags'];
              if (and['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = and['ObjectSizeGreaterThan'];
              if (and['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = and['ObjectSizeLessThan'];
            } else if (tagOnly) {
              cfnFilter['TagFilters'] = [tagOnly];
            } else {
              if (f['Prefix'] !== undefined) cfnFilter['Prefix'] = f['Prefix'];
              if (f['ObjectSizeGreaterThan'] !== undefined)
                cfnFilter['ObjectSizeGreaterThan'] = f['ObjectSizeGreaterThan'];
              if (f['ObjectSizeLessThan'] !== undefined)
                cfnFilter['ObjectSizeLessThan'] = f['ObjectSizeLessThan'];
            }
            if (Object.keys(cfnFilter).length > 0) out['Filter'] = cfnFilter;
          }

          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchLifecycleConfiguration') return { Rules: [] };
      throw err;
    }
  }

  private async readCors(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketCorsCommand({ Bucket: bucket }));
      const rules = resp.CORSRules ?? [];
      return {
        CorsRules: rules.map((r) => {
          const out: Record<string, unknown> = {};
          if (r.ID !== undefined) out['Id'] = r.ID;
          if (r.AllowedHeaders !== undefined) out['AllowedHeaders'] = r.AllowedHeaders;
          if (r.AllowedMethods !== undefined) out['AllowedMethods'] = r.AllowedMethods;
          if (r.AllowedOrigins !== undefined) out['AllowedOrigins'] = r.AllowedOrigins;
          if (r.ExposeHeaders !== undefined) out['ExposedHeaders'] = r.ExposeHeaders;
          if (r.MaxAgeSeconds !== undefined) out['MaxAge'] = r.MaxAgeSeconds;
          return out;
        }),
      };
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchCORSConfiguration') return { CorsRules: [] };
      throw err;
    }
  }

  private async readWebsite(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketWebsiteCommand({ Bucket: bucket }));
      const out: Record<string, unknown> = {};
      if (resp.IndexDocument?.Suffix !== undefined) {
        out['IndexDocument'] = resp.IndexDocument.Suffix;
      }
      if (resp.ErrorDocument?.Key !== undefined) {
        out['ErrorDocument'] = resp.ErrorDocument.Key;
      }
      if (resp.RedirectAllRequestsTo) {
        const redirect: Record<string, unknown> = {};
        if (resp.RedirectAllRequestsTo.HostName !== undefined)
          redirect['HostName'] = resp.RedirectAllRequestsTo.HostName;
        if (resp.RedirectAllRequestsTo.Protocol !== undefined)
          redirect['Protocol'] = resp.RedirectAllRequestsTo.Protocol;
        out['RedirectAllRequestsTo'] = redirect;
      }
      if (resp.RoutingRules && resp.RoutingRules.length > 0) {
        out['RoutingRules'] = resp.RoutingRules.map((rr) => {
          const ruleOut: Record<string, unknown> = {};
          if (rr.Condition) {
            const c: Record<string, unknown> = {};
            if (rr.Condition.HttpErrorCodeReturnedEquals !== undefined)
              c['HttpErrorCodeReturnedEquals'] = rr.Condition.HttpErrorCodeReturnedEquals;
            if (rr.Condition.KeyPrefixEquals !== undefined)
              c['KeyPrefixEquals'] = rr.Condition.KeyPrefixEquals;
            ruleOut['RoutingRuleCondition'] = c;
          }
          if (rr.Redirect) {
            const r: Record<string, unknown> = {};
            if (rr.Redirect.HostName !== undefined) r['HostName'] = rr.Redirect.HostName;
            if (rr.Redirect.HttpRedirectCode !== undefined)
              r['HttpRedirectCode'] = rr.Redirect.HttpRedirectCode;
            if (rr.Redirect.Protocol !== undefined) r['Protocol'] = rr.Redirect.Protocol;
            if (rr.Redirect.ReplaceKeyPrefixWith !== undefined)
              r['ReplaceKeyPrefixWith'] = rr.Redirect.ReplaceKeyPrefixWith;
            if (rr.Redirect.ReplaceKeyWith !== undefined)
              r['ReplaceKeyWith'] = rr.Redirect.ReplaceKeyWith;
            ruleOut['RedirectRule'] = r;
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'NoSuchWebsiteConfiguration') return {};
      throw err;
    }
  }

  private async readLogging(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(new GetBucketLoggingCommand({ Bucket: bucket }));
    if (!resp.LoggingEnabled) return {};
    const out: Record<string, unknown> = {};
    if (resp.LoggingEnabled.TargetBucket !== undefined)
      out['DestinationBucketName'] = resp.LoggingEnabled.TargetBucket;
    if (resp.LoggingEnabled.TargetPrefix !== undefined)
      out['LogFilePrefix'] = resp.LoggingEnabled.TargetPrefix;
    return out;
  }

  private async readNotification(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketNotificationConfigurationCommand({ Bucket: bucket })
    );
    const out: Record<string, unknown> = {};
    if (resp.TopicConfigurations && resp.TopicConfigurations.length > 0) {
      out['TopicConfigurations'] = resp.TopicConfigurations.map((t) => {
        const e: Record<string, unknown> = {};
        if (t.Id !== undefined) e['Id'] = t.Id;
        if (t.TopicArn !== undefined) e['Topic'] = t.TopicArn;
        if (t.Events !== undefined) e['Events'] = t.Events;
        if (t.Filter) e['Filter'] = this.sdkNotifFilterToCfn(t.Filter);
        return e;
      });
    }
    if (resp.QueueConfigurations && resp.QueueConfigurations.length > 0) {
      out['QueueConfigurations'] = resp.QueueConfigurations.map((q) => {
        const e: Record<string, unknown> = {};
        if (q.Id !== undefined) e['Id'] = q.Id;
        if (q.QueueArn !== undefined) e['Queue'] = q.QueueArn;
        if (q.Events !== undefined) e['Events'] = q.Events;
        if (q.Filter) e['Filter'] = this.sdkNotifFilterToCfn(q.Filter);
        return e;
      });
    }
    if (resp.LambdaFunctionConfigurations && resp.LambdaFunctionConfigurations.length > 0) {
      out['LambdaConfigurations'] = resp.LambdaFunctionConfigurations.map((l) => {
        const e: Record<string, unknown> = {};
        if (l.Id !== undefined) e['Id'] = l.Id;
        if (l.LambdaFunctionArn !== undefined) e['Function'] = l.LambdaFunctionArn;
        if (l.Events !== undefined) e['Events'] = l.Events;
        if (l.Filter) e['Filter'] = this.sdkNotifFilterToCfn(l.Filter);
        return e;
      });
    }
    if (resp.EventBridgeConfiguration) {
      out['EventBridgeConfiguration'] = {};
    }
    return out;
  }

  private sdkNotifFilterToCfn(filter: unknown): Record<string, unknown> {
    if (!filter || typeof filter !== 'object') return {};
    const f = filter as Record<string, unknown>;
    const key = f['Key'] as Record<string, unknown> | undefined;
    if (!key) return {};
    const filterRules = key['FilterRules'] as Array<{ Name?: string; Value?: string }> | undefined;
    if (!filterRules) return {};
    return {
      S3Key: {
        Rules: filterRules.map((r) => ({ Name: r.Name, Value: r.Value })),
      },
    };
  }

  private async readReplication(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(new GetBucketReplicationCommand({ Bucket: bucket }));
      const cfg = resp.ReplicationConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.Role !== undefined) out['Role'] = cfg.Role;
      if (cfg.Rules) {
        out['Rules'] = cfg.Rules.map((r) => {
          const ruleOut: Record<string, unknown> = {};
          if (r.ID !== undefined) ruleOut['Id'] = r.ID;
          if (r.Status !== undefined) ruleOut['Status'] = r.Status;
          if (r.Priority !== undefined) ruleOut['Priority'] = r.Priority;
          if (r.Prefix !== undefined) ruleOut['Prefix'] = r.Prefix;
          if (r.Destination) {
            const d: Record<string, unknown> = {};
            if (r.Destination.Bucket !== undefined) d['Bucket'] = r.Destination.Bucket;
            if (r.Destination.Account !== undefined) d['Account'] = r.Destination.Account;
            if (r.Destination.StorageClass !== undefined)
              d['StorageClass'] = r.Destination.StorageClass;
            ruleOut['Destination'] = d;
          }
          if (r.Filter) {
            const f = r.Filter as Record<string, unknown>;
            const cfnFilter: Record<string, unknown> = {};
            const and = f['And'] as Record<string, unknown> | undefined;
            const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
            if (and) {
              if (and['Prefix'] !== undefined) cfnFilter['Prefix'] = and['Prefix'];
              const tags = and['Tags'] as Array<{ Key?: string; Value?: string }> | undefined;
              if (tags && tags.length > 0) cfnFilter['TagFilter'] = tags[0];
            } else if (tagOnly) {
              cfnFilter['TagFilter'] = tagOnly;
            } else if (f['Prefix'] !== undefined) {
              cfnFilter['Prefix'] = f['Prefix'];
            }
            if (Object.keys(cfnFilter).length > 0) ruleOut['Filter'] = cfnFilter;
          }
          if (r.DeleteMarkerReplication) {
            ruleOut['DeleteMarkerReplication'] = {
              Status: r.DeleteMarkerReplication.Status,
            };
          }
          return ruleOut;
        });
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (e.name === 'ReplicationConfigurationNotFoundError') return {};
      throw err;
    }
  }

  private async readObjectLock(bucket: string): Promise<Record<string, unknown>> {
    try {
      const resp = await this.s3Client.send(
        new GetObjectLockConfigurationCommand({ Bucket: bucket })
      );
      const cfg = resp.ObjectLockConfiguration;
      if (!cfg) return {};
      const out: Record<string, unknown> = {};
      if (cfg.ObjectLockEnabled !== undefined) out['ObjectLockEnabled'] = cfg.ObjectLockEnabled;
      if (cfg.Rule?.DefaultRetention) {
        const r = cfg.Rule.DefaultRetention;
        const retention: Record<string, unknown> = {};
        if (r.Mode !== undefined) retention['Mode'] = r.Mode;
        if (r.Days !== undefined) retention['Days'] = r.Days;
        if (r.Years !== undefined) retention['Years'] = r.Years;
        out['Rule'] = { DefaultRetention: retention };
      }
      return out;
    } catch (err) {
      const e = err as { name?: string };
      if (
        e.name === 'ObjectLockConfigurationNotFoundError' ||
        e.name === 'NoSuchBucketConfiguration'
      ) {
        return {};
      }
      throw err;
    }
  }

  private async readAccelerate(bucket: string): Promise<Record<string, unknown>> {
    const resp = await this.s3Client.send(
      new GetBucketAccelerateConfigurationCommand({ Bucket: bucket })
    );
    // Always-emit placeholder. AWS-side default is "no acceleration" which
    // surfaces as Status=undefined. We emit `Suspended` (the semantic "off"
    // that AWS accepts on Put) so a console-side enable surfaces.
    return { AccelerationStatus: resp.Status ?? 'Suspended' };
  }

  private async readMetricsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketMetricsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.MetricsConfigurationList ?? []) {
        out.push(this.metricsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private metricsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
        if (and['AccessPointArn'] !== undefined) out['AccessPointArn'] = and['AccessPointArn'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else {
        if (f['Prefix'] !== undefined) out['Prefix'] = f['Prefix'];
        if (f['AccessPointArn'] !== undefined) out['AccessPointArn'] = f['AccessPointArn'];
      }
    }
    return out;
  }

  private async readAnalyticsList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketAnalyticsConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.AnalyticsConfigurationList ?? []) {
        out.push(this.analyticsSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private analyticsSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    const sca = c['StorageClassAnalysis'] as Record<string, unknown> | undefined;
    if (sca?.['DataExport']) {
      const dataExport = sca['DataExport'] as Record<string, unknown>;
      const dest = dataExport['Destination'] as Record<string, unknown> | undefined;
      const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
      out['StorageClassAnalysis'] = {
        DataExport: {
          OutputSchemaVersion: dataExport['OutputSchemaVersion'],
          Destination: s3Dest
            ? {
                S3BucketDestination: {
                  BucketArn: s3Dest['Bucket'],
                  BucketAccountId: s3Dest['BucketAccountId'],
                  Format: s3Dest['Format'],
                  Prefix: s3Dest['Prefix'],
                },
              }
            : undefined,
        },
      };
    }
    return out;
  }

  private async readIntelligentTieringList(
    bucket: string
  ): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketIntelligentTieringConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.IntelligentTieringConfigurationList ?? []) {
        out.push(this.intelligentTieringSdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private intelligentTieringSdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['Status'] !== undefined) out['Status'] = c['Status'];
    if (c['Tierings']) {
      const tierings = c['Tierings'] as Array<Record<string, unknown>>;
      out['Tierings'] = tierings.map((t) => ({
        AccessTier: t['AccessTier'],
        Days: t['Days'],
      }));
    }
    const f = c['Filter'] as Record<string, unknown> | undefined;
    if (f) {
      const and = f['And'] as Record<string, unknown> | undefined;
      const tagOnly = f['Tag'] as { Key?: string; Value?: string } | undefined;
      if (and) {
        if (and['Prefix'] !== undefined) out['Prefix'] = and['Prefix'];
        if (and['Tags']) out['TagFilters'] = and['Tags'];
      } else if (tagOnly) {
        out['TagFilters'] = [tagOnly];
      } else if (f['Prefix'] !== undefined) {
        out['Prefix'] = f['Prefix'];
      }
    }
    return out;
  }

  private async readInventoryList(bucket: string): Promise<Array<Record<string, unknown>>> {
    const out: Array<Record<string, unknown>> = [];
    let continuationToken: string | undefined;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const resp = await this.s3Client.send(
        new ListBucketInventoryConfigurationsCommand({
          Bucket: bucket,
          ContinuationToken: continuationToken,
        })
      );
      for (const c of resp.InventoryConfigurationList ?? []) {
        out.push(this.inventorySdkToCfn(c as unknown as Record<string, unknown>));
      }
      if (!resp.IsTruncated) break;
      continuationToken = resp.NextContinuationToken;
    }
    return out;
  }

  private inventorySdkToCfn(c: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    if (c['Id'] !== undefined) out['Id'] = c['Id'];
    if (c['IsEnabled'] !== undefined) out['Enabled'] = c['IsEnabled'];
    if (c['IncludedObjectVersions'] !== undefined)
      out['IncludedObjectVersions'] = c['IncludedObjectVersions'];
    const schedule = c['Schedule'] as Record<string, unknown> | undefined;
    if (schedule?.['Frequency'] !== undefined) out['ScheduleFrequency'] = schedule['Frequency'];
    if (c['OptionalFields'] !== undefined) out['OptionalFields'] = c['OptionalFields'];
    const dest = c['Destination'] as Record<string, unknown> | undefined;
    const s3Dest = dest?.['S3BucketDestination'] as Record<string, unknown> | undefined;
    if (s3Dest) {
      const cfnDest: Record<string, unknown> = {};
      if (s3Dest['Bucket'] !== undefined) cfnDest['BucketArn'] = s3Dest['Bucket'];
      if (s3Dest['AccountId'] !== undefined) cfnDest['BucketAccountId'] = s3Dest['AccountId'];
      if (s3Dest['Format'] !== undefined) cfnDest['Format'] = s3Dest['Format'];
      if (s3Dest['Prefix'] !== undefined) cfnDest['Prefix'] = s3Dest['Prefix'];
      out['Destination'] = cfnDest;
    }
    const filter = c['Filter'] as Record<string, unknown> | undefined;
    if (filter?.['Prefix'] !== undefined) out['Prefix'] = filter['Prefix'];
    return out;
  }

  /**
   * Adopt an existing S3 bucket into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.BucketName` → use directly,
   *     verify with `HeadBucket`.
   *  2. `ListBuckets` + `GetBucketTagging`, match `aws:cdk:path` against the
   *     CDK construct path.
   *
   * Returns `null` when nothing matches — caller treats this as
   * "not deployed yet" rather than a failure.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'BucketName');
    if (explicit) {
      try {
        await this.s3Client.send(new HeadBucketCommand({ Bucket: explicit }));
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        const e = err as { name?: string };
        if (e.name === 'NotFound' || e.name === 'NoSuchBucket') {
          return null;
        }
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    const list = await this.s3Client.send(new ListBucketsCommand({}));
    for (const b of list.Buckets ?? []) {
      if (!b.Name) continue;
      try {
        const tagging = await this.s3Client.send(new GetBucketTaggingCommand({ Bucket: b.Name }));
        if (matchesCdkPath(tagging.TagSet, input.cdkPath)) {
          return { physicalId: b.Name, attributes: {} };
        }
      } catch (err) {
        // NoSuchTagSet / cross-region 301 / access denied → skip this bucket
        const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
        if (
          e.name === 'NoSuchTagSet' ||
          e.name === 'AccessDenied' ||
          e.$metadata?.httpStatusCode === 301
        ) {
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  /**
   * Delete a bucket, emptying it first if not empty.
   * Handles the race condition where objects (e.g., ALB logs) are written
   * after CustomResource cleanup but before bucket deletion.
   */
  private async deleteBucketWithEmptyRetry(logicalId: string, bucketName: string): Promise<void> {
    const maxAttempts = 3;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
        this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
        return;
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        if (msg.includes('not empty') || msg.includes('BucketNotEmpty')) {
          this.logger.debug(
            `Bucket ${bucketName} not empty (attempt ${attempt}/${maxAttempts}), emptying...`
          );
          await this.emptyBucket(bucketName);
          continue;
        }
        throw error;
      }
    }
    // Final attempt after emptying
    await this.s3Client.send(new DeleteBucketCommand({ Bucket: bucketName }));
    this.logger.debug(`Successfully deleted S3 bucket ${logicalId}`);
  }

  /**
   * Empty a bucket by deleting all object versions and delete markers.
   */
  private async emptyBucket(bucketName: string): Promise<void> {
    let keyMarker: string | undefined;
    let versionIdMarker: string | undefined;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const listResp = await this.s3Client.send(
        new ListObjectVersionsCommand({
          Bucket: bucketName,
          MaxKeys: 1000,
          ...(keyMarker && { KeyMarker: keyMarker }),
          ...(versionIdMarker && { VersionIdMarker: versionIdMarker }),
        })
      );

      const objects: Array<{ Key: string; VersionId: string }> = [];
      for (const v of listResp.Versions || []) {
        if (v.Key && v.VersionId) objects.push({ Key: v.Key, VersionId: v.VersionId });
      }
      for (const d of listResp.DeleteMarkers || []) {
        if (d.Key && d.VersionId) objects.push({ Key: d.Key, VersionId: d.VersionId });
      }

      if (objects.length > 0) {
        await this.s3Client.send(
          new DeleteObjectsCommand({
            Bucket: bucketName,
            Delete: { Objects: objects, Quiet: true },
          })
        );
        this.logger.debug(`Emptied ${objects.length} objects from ${bucketName}`);
      }

      if (!listResp.IsTruncated) break;
      keyMarker = listResp.NextKeyMarker;
      versionIdMarker = listResp.NextVersionIdMarker;
    }
  }
}
