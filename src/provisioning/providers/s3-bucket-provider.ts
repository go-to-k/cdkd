/* eslint-disable @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-return */
import {
  S3Client,
  CreateBucketCommand,
  DeleteBucketCommand,
  PutBucketVersioningCommand,
  PutBucketTaggingCommand,
  PutBucketOwnershipControlsCommand,
  PutBucketNotificationConfigurationCommand,
  PutBucketCorsCommand,
  PutBucketLifecycleConfigurationCommand,
  PutPublicAccessBlockCommand,
  PutBucketEncryptionCommand,
  PutBucketLoggingCommand,
  PutBucketWebsiteCommand,
  PutBucketAccelerateConfigurationCommand,
  PutBucketMetricsConfigurationCommand,
  PutBucketAnalyticsConfigurationCommand,
  PutBucketIntelligentTieringConfigurationCommand,
  PutBucketInventoryConfigurationCommand,
  PutBucketReplicationCommand,
  PutObjectLockConfigurationCommand,
  NoSuchBucket,
  ListObjectVersionsCommand,
  DeleteObjectsCommand,
  type BucketLocationConstraint,
  type ObjectOwnership,
  type CORSRule,
} from '@aws-sdk/client-s3';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { generateResourceName } from '../resource-name.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
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
   * Build attributes for an S3 bucket
   */
  private async buildAttributes(bucketName: string): Promise<Record<string, unknown>> {
    const region = await this.getRegion();
    return {
      Arn: `arn:aws:s3:::${bucketName}`,
      DomainName: `${bucketName}.s3.amazonaws.com`,
      RegionalDomainName: `${bucketName}.s3.${region}.amazonaws.com`,
      WebsiteURL: `http://${bucketName}.s3-website-${region}.amazonaws.com`,
    };
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
    loggingConfig: Record<string, unknown>
  ): Promise<void> {
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
    properties: Record<string, unknown>
  ): Promise<void> {
    // Versioning
    const versioningConfig = properties['VersioningConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (versioningConfig) {
      await this.applyVersioning(bucketName, versioningConfig);
    }

    // Tags
    const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
    if (tags && Array.isArray(tags) && tags.length > 0) {
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

    // Notification Configuration (EventBridge)
    const notifConfig = properties['NotificationConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (notifConfig?.['EventBridgeConfiguration']) {
      const ebConfig = notifConfig['EventBridgeConfiguration'] as { EventBridgeEnabled?: boolean };
      await this.s3Client.send(
        new PutBucketNotificationConfigurationCommand({
          Bucket: bucketName,
          NotificationConfiguration: {
            EventBridgeConfiguration: {
              EventBridgeEnabled: ebConfig.EventBridgeEnabled ?? true,
            },
          },
        })
      );
      this.logger.debug(`Applied EventBridge notification to bucket ${bucketName}`);
    }

    // CORS Configuration
    const corsConfig = properties['CorsConfiguration'] as
      | { CorsRules: Array<Record<string, unknown>> }
      | undefined;
    if (corsConfig?.CorsRules) {
      await this.applyCorsConfiguration(bucketName, corsConfig);
    }

    // Lifecycle Configuration
    const lifecycleConfig = properties['LifecycleConfiguration'] as
      | { Rules: Array<Record<string, unknown>> }
      | undefined;
    if (lifecycleConfig?.Rules) {
      await this.applyLifecycleConfiguration(bucketName, lifecycleConfig);
    }

    // Public Access Block Configuration
    const publicAccessBlock = properties['PublicAccessBlockConfiguration'] as
      | Record<string, unknown>
      | undefined;
    if (publicAccessBlock) {
      await this.applyPublicAccessBlockConfiguration(bucketName, publicAccessBlock);
    }

    // Bucket Encryption
    const bucketEncryption = properties['BucketEncryption'] as
      | { ServerSideEncryptionConfiguration: Array<Record<string, unknown>> }
      | undefined;
    if (bucketEncryption?.ServerSideEncryptionConfiguration) {
      await this.applyBucketEncryption(bucketName, bucketEncryption);
    }

    // Logging Configuration
    const loggingConfig = properties['LoggingConfiguration'] as Record<string, unknown> | undefined;
    if (loggingConfig) {
      await this.applyLoggingConfiguration(bucketName, loggingConfig);
    }

    // Website Configuration
    const websiteConfig = properties['WebsiteConfiguration'] as Record<string, unknown> | undefined;
    if (websiteConfig) {
      await this.applyWebsiteConfiguration(bucketName, websiteConfig);
    }

    // Accelerate Configuration
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

      try {
        await this.s3Client.send(new CreateBucketCommand(createParams));
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

      // Apply additional configuration
      await this.applyConfiguration(bucketName, properties);

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
    _previousProperties: Record<string, unknown>
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
      // Apply configuration changes
      await this.applyConfiguration(physicalId, properties);

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
