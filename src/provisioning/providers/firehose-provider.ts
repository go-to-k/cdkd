import {
  FirehoseClient,
  CreateDeliveryStreamCommand,
  DeleteDeliveryStreamCommand,
  DescribeDeliveryStreamCommand,
  ListDeliveryStreamsCommand,
  ListTagsForDeliveryStreamCommand,
  ResourceNotFoundException,
  UpdateDestinationCommand,
  TagDeliveryStreamCommand,
  UntagDeliveryStreamCommand,
  type CreateDeliveryStreamCommandInput,
  type S3DestinationConfiguration,
  type ExtendedS3DestinationConfiguration,
  type ExtendedS3DestinationUpdate,
  type RedshiftDestinationUpdate,
  type S3DestinationUpdate,
  type Tag,
  type HttpEndpointDestinationConfiguration,
  type RedshiftDestinationConfiguration,
  type ElasticsearchDestinationConfiguration,
  type AmazonopensearchserviceDestinationConfiguration,
  type SplunkDestinationConfiguration,
  type AmazonOpenSearchServerlessDestinationConfiguration,
  type DeliveryStreamEncryptionConfigurationInput,
} from '@aws-sdk/client-firehose';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError, ResourceUpdateNotSupportedError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  matchesCdkPath,
  normalizeAwsTagsToCfn,
  resolveExplicitPhysicalId,
} from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS Kinesis Firehose resources
 *
 * Supports:
 * - AWS::KinesisFirehose::DeliveryStream
 *
 * CreateDeliveryStream is synchronous - the CC API adds unnecessary
 * polling overhead for an operation that completes immediately.
 */
export class FirehoseProvider implements ResourceProvider {
  private client: FirehoseClient | undefined;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('FirehoseProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::KinesisFirehose::DeliveryStream',
      new Set([
        'DeliveryStreamName',
        'DeliveryStreamType',
        'S3DestinationConfiguration',
        'ExtendedS3DestinationConfiguration',
        'KinesisStreamSourceConfiguration',
        'Tags',
        'HttpEndpointDestinationConfiguration',
        'RedshiftDestinationConfiguration',
        'ElasticsearchDestinationConfiguration',
        'AmazonopensearchserviceDestinationConfiguration',
        'SplunkDestinationConfiguration',
        'AmazonOpenSearchServerlessDestinationConfiguration',
        'DeliveryStreamEncryptionConfigurationInput',
      ]),
    ],
  ]);

  private getClient(): FirehoseClient {
    if (!this.client) {
      this.client = new FirehoseClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Create a Firehose delivery stream
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating Firehose delivery stream ${logicalId}`);

    const deliveryStreamName = properties['DeliveryStreamName'] as string | undefined;
    const deliveryStreamType =
      (properties['DeliveryStreamType'] as string | undefined) || 'DirectPut';

    try {
      const input: CreateDeliveryStreamCommandInput = {
        DeliveryStreamName: deliveryStreamName || logicalId,
        DeliveryStreamType: deliveryStreamType as
          | 'DirectPut'
          | 'KinesisStreamAsSource'
          | 'MSKAsSource',
      };

      // Map S3DestinationConfiguration (CFn PascalCase -> SDK format)
      if (properties['S3DestinationConfiguration']) {
        const s3Config = properties['S3DestinationConfiguration'] as Record<string, unknown>;
        input.S3DestinationConfiguration = this.mapS3DestinationConfiguration(s3Config);
      }

      // Map ExtendedS3DestinationConfiguration
      if (properties['ExtendedS3DestinationConfiguration']) {
        const extS3Config = properties['ExtendedS3DestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ExtendedS3DestinationConfiguration =
          this.mapExtendedS3DestinationConfiguration(extS3Config);
      }

      // Map KinesisStreamSourceConfiguration
      if (properties['KinesisStreamSourceConfiguration']) {
        const kinesisConfig = properties['KinesisStreamSourceConfiguration'] as Record<
          string,
          unknown
        >;
        input.KinesisStreamSourceConfiguration = {
          KinesisStreamARN: (kinesisConfig['KinesisStreamArn'] ||
            kinesisConfig['KinesisStreamARN']) as string,
          RoleARN: (kinesisConfig['RoleArn'] || kinesisConfig['RoleARN']) as string,
        };
      }

      // Map HttpEndpointDestinationConfiguration
      if (properties['HttpEndpointDestinationConfiguration']) {
        const httpConfig = properties['HttpEndpointDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        const endpointConfig = httpConfig['EndpointConfiguration'] as
          | Record<string, unknown>
          | undefined;
        input.HttpEndpointDestinationConfiguration = {
          EndpointConfiguration: endpointConfig
            ? {
                Url: endpointConfig['Url'] as string,
                Name: endpointConfig['Name'] as string | undefined,
                AccessKey: endpointConfig['AccessKey'] as string | undefined,
              }
            : undefined,
          RoleARN: (httpConfig['RoleArn'] || httpConfig['RoleARN']) as string | undefined,
          BufferingHints: httpConfig['BufferingHints'] as
            | HttpEndpointDestinationConfiguration['BufferingHints']
            | undefined,
          CloudWatchLoggingOptions: httpConfig['CloudWatchLoggingOptions'] as
            | HttpEndpointDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          RequestConfiguration: httpConfig['RequestConfiguration'] as
            | HttpEndpointDestinationConfiguration['RequestConfiguration']
            | undefined,
          ProcessingConfiguration: httpConfig['ProcessingConfiguration'] as
            | HttpEndpointDestinationConfiguration['ProcessingConfiguration']
            | undefined,
          RetryOptions: httpConfig['RetryOptions'] as
            | HttpEndpointDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: httpConfig['S3BackupMode'] as string | undefined,
          S3Configuration: httpConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                httpConfig['S3Configuration'] as Record<string, unknown>
              )
            : undefined,
        } as HttpEndpointDestinationConfiguration;
      }

      // Map RedshiftDestinationConfiguration
      if (properties['RedshiftDestinationConfiguration']) {
        const rsConfig = properties['RedshiftDestinationConfiguration'] as Record<string, unknown>;
        input.RedshiftDestinationConfiguration = {
          ClusterJDBCURL: rsConfig['ClusterJDBCURL'] as string,
          RoleARN: (rsConfig['RoleArn'] || rsConfig['RoleARN']) as string,
          CopyCommand: rsConfig['CopyCommand'] as RedshiftDestinationConfiguration['CopyCommand'],
          Username: rsConfig['Username'] as string | undefined,
          Password: rsConfig['Password'] as string | undefined,
          S3Configuration: rsConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                rsConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: rsConfig['CloudWatchLoggingOptions'] as
            | RedshiftDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: rsConfig['ProcessingConfiguration'] as
            | RedshiftDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as RedshiftDestinationConfiguration;
      }

      // Map ElasticsearchDestinationConfiguration
      if (properties['ElasticsearchDestinationConfiguration']) {
        const esConfig = properties['ElasticsearchDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.ElasticsearchDestinationConfiguration = {
          DomainARN: (esConfig['DomainArn'] || esConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: esConfig['ClusterEndpoint'] as string | undefined,
          IndexName: esConfig['IndexName'] as string,
          TypeName: esConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: esConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (esConfig['RoleArn'] || esConfig['RoleARN']) as string,
          BufferingHints: esConfig['BufferingHints'] as
            | ElasticsearchDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: esConfig['RetryOptions'] as
            | ElasticsearchDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: esConfig['S3BackupMode'] as string | undefined,
          S3Configuration: esConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                esConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: esConfig['CloudWatchLoggingOptions'] as
            | ElasticsearchDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: esConfig['ProcessingConfiguration'] as
            | ElasticsearchDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as ElasticsearchDestinationConfiguration;
      }

      // Map AmazonopensearchserviceDestinationConfiguration
      if (properties['AmazonopensearchserviceDestinationConfiguration']) {
        const aosConfig = properties['AmazonopensearchserviceDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.AmazonopensearchserviceDestinationConfiguration = {
          DomainARN: (aosConfig['DomainArn'] || aosConfig['DomainARN']) as string | undefined,
          ClusterEndpoint: aosConfig['ClusterEndpoint'] as string | undefined,
          IndexName: aosConfig['IndexName'] as string,
          TypeName: aosConfig['TypeName'] as string | undefined,
          IndexRotationPeriod: aosConfig['IndexRotationPeriod'] as string | undefined,
          RoleARN: (aosConfig['RoleArn'] || aosConfig['RoleARN']) as string,
          BufferingHints: aosConfig['BufferingHints'] as
            | AmazonopensearchserviceDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aosConfig['RetryOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aosConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aosConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aosConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aosConfig['CloudWatchLoggingOptions'] as
            | AmazonopensearchserviceDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aosConfig['ProcessingConfiguration'] as
            | AmazonopensearchserviceDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as AmazonopensearchserviceDestinationConfiguration;
      }

      // Map SplunkDestinationConfiguration
      if (properties['SplunkDestinationConfiguration']) {
        const splunkConfig = properties['SplunkDestinationConfiguration'] as Record<
          string,
          unknown
        >;
        input.SplunkDestinationConfiguration = {
          HECEndpoint: splunkConfig['HECEndpoint'] as string,
          HECEndpointType: splunkConfig['HECEndpointType'] as string,
          HECToken: splunkConfig['HECToken'] as string,
          HECAcknowledgmentTimeoutInSeconds: splunkConfig['HECAcknowledgmentTimeoutInSeconds'] as
            | number
            | undefined,
          S3BackupMode: splunkConfig['S3BackupMode'] as string | undefined,
          S3Configuration: splunkConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                splunkConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          RetryOptions: splunkConfig['RetryOptions'] as
            | SplunkDestinationConfiguration['RetryOptions']
            | undefined,
          CloudWatchLoggingOptions: splunkConfig['CloudWatchLoggingOptions'] as
            | SplunkDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: splunkConfig['ProcessingConfiguration'] as
            | SplunkDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as SplunkDestinationConfiguration;
      }

      // Map AmazonOpenSearchServerlessDestinationConfiguration
      if (properties['AmazonOpenSearchServerlessDestinationConfiguration']) {
        const aossConfig = properties[
          'AmazonOpenSearchServerlessDestinationConfiguration'
        ] as Record<string, unknown>;
        input.AmazonOpenSearchServerlessDestinationConfiguration = {
          CollectionEndpoint: aossConfig['CollectionEndpoint'] as string,
          IndexName: aossConfig['IndexName'] as string,
          RoleARN: (aossConfig['RoleArn'] || aossConfig['RoleARN']) as string,
          BufferingHints: aossConfig['BufferingHints'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['BufferingHints']
            | undefined,
          RetryOptions: aossConfig['RetryOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['RetryOptions']
            | undefined,
          S3BackupMode: aossConfig['S3BackupMode'] as string | undefined,
          S3Configuration: aossConfig['S3Configuration']
            ? this.mapS3DestinationConfiguration(
                aossConfig['S3Configuration'] as Record<string, unknown>
              )
            : (undefined as unknown as S3DestinationConfiguration),
          CloudWatchLoggingOptions: aossConfig['CloudWatchLoggingOptions'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['CloudWatchLoggingOptions']
            | undefined,
          ProcessingConfiguration: aossConfig['ProcessingConfiguration'] as
            | AmazonOpenSearchServerlessDestinationConfiguration['ProcessingConfiguration']
            | undefined,
        } as AmazonOpenSearchServerlessDestinationConfiguration;
      }

      // Map DeliveryStreamEncryptionConfigurationInput
      if (properties['DeliveryStreamEncryptionConfigurationInput']) {
        const encConfig = properties['DeliveryStreamEncryptionConfigurationInput'] as Record<
          string,
          unknown
        >;
        input.DeliveryStreamEncryptionConfigurationInput = {
          KeyARN: (encConfig['KeyArn'] || encConfig['KeyARN']) as string | undefined,
          KeyType: encConfig['KeyType'] as
            | DeliveryStreamEncryptionConfigurationInput['KeyType']
            | undefined,
        } as DeliveryStreamEncryptionConfigurationInput;
      }

      // Map Tags
      const tags = properties['Tags'] as Array<{ Key: string; Value: string }> | undefined;
      if (tags && tags.length > 0) {
        input.Tags = tags.map((t) => ({ Key: t.Key, Value: t.Value })) as Tag[];
      }

      const response = await this.getClient().send(new CreateDeliveryStreamCommand(input));

      const physicalId =
        deliveryStreamName ||
        input.DeliveryStreamName ||
        response.DeliveryStreamARN?.split('/').pop() ||
        '';
      const arn = response.DeliveryStreamARN;

      this.logger.debug(
        `Successfully created Firehose delivery stream ${logicalId}: ${physicalId}`
      );

      // Wait for delivery stream to become ACTIVE before returning.
      // SubscriptionFilter and other dependents fail if the stream is still CREATING.
      await this.waitForActive(physicalId, logicalId);

      return {
        physicalId,
        attributes: {
          Arn: arn,
        },
      };
    } catch (error) {
      if (error instanceof ProvisioningError) {
        throw error;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create Firehose delivery stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Apply in-place updates to a Firehose delivery stream via the per-shape
   * AWS APIs (#477):
   *
   *   - **Tags** (`TagDeliveryStream` / `UntagDeliveryStream`) — always
   *     supported; runs first since it is destination-independent.
   *   - **`ExtendedS3DestinationConfiguration`** (`UpdateDestination` with
   *     an `ExtendedS3DestinationUpdate` payload) — recovers
   *     `CurrentDeliveryStreamVersionId` + `DestinationId` from a
   *     `DescribeDeliveryStream` call, then applies the diff. Only fires
   *     when the destination shape actually differs.
   *
   *   - `RedshiftDestinationConfiguration` (#549) — same flow as
   *     ExtendedS3: `DescribeDeliveryStream` recovers VersionId +
   *     DestinationId, then `UpdateDestinationCommand` issues the
   *     diff with a `RedshiftDestinationUpdate` payload produced by
   *     {@link mapRedshiftConfigToUpdate}. Handles `CopyCommand`,
   *     `RetryOptions`, `S3Configuration` → `S3Update`,
   *     `S3BackupConfiguration` → `S3BackupUpdate`,
   *     `ProcessingConfiguration`, `S3BackupMode`,
   *     `CloudWatchLoggingOptions`, `Username` / `Password` /
   *     `RoleARN` / `ClusterJDBCURL`.
   *
   * Other destination types (`S3DestinationConfiguration`,
   * `HttpEndpointDestinationConfiguration`,
   * `ElasticsearchDestinationConfiguration`,
   * `AmazonopensearchserviceDestinationConfiguration`,
   * `SplunkDestinationConfiguration`,
   * `AmazonOpenSearchServerlessDestinationConfiguration`,
   * `IcebergDestinationConfiguration`,
   * `SnowflakeDestinationConfiguration`) stay rejected with a tightened
   * error message naming the AWS API. Each one is a follow-up to (#549)
   * — AWS provides `UpdateDestination` for them too, but the per-shape
   * reverse-mappers are deep and each warrants its own focused PR.
   * Re-deploy with `cdkd deploy --replace` until they land.
   *
   * Destination-type SWITCHES (e.g. ExtendedS3 → Redshift) are immutable
   * on AWS; cdkd surfaces `ResourceUpdateNotSupportedError` so the caller
   * can `cdkd deploy --replace`.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating Firehose delivery stream ${logicalId}: ${physicalId}`);

    // Validate destination shape BEFORE issuing any mutating call so a
    // Tags+rejected-destination combined diff does not write Tags then
    // throw — otherwise AWS would carry new tags while cdkd state was
    // never updated (m1 in PR review).
    const destKey = this.findDestinationKey(properties);
    const prevDestKey = this.findDestinationKey(previousProperties);

    // Destination-type switch is immutable on AWS (UpdateDestination only
    // accepts the SAME destination type; switching types requires replace).
    if (destKey && prevDestKey && destKey !== prevDestKey) {
      throw new ResourceUpdateNotSupportedError(
        resourceType,
        logicalId,
        `Switching Firehose destination type from '${prevDestKey}' to '${destKey}' is not supported in-place — AWS UpdateDestination requires the same destination type as the original CreateDeliveryStream. Re-deploy with cdkd deploy --replace.`
      );
    }

    const activeDest = destKey ?? prevDestKey;
    const SUPPORTED_DESTINATIONS = new Set([
      'ExtendedS3DestinationConfiguration',
      'RedshiftDestinationConfiguration',
    ]);
    if (activeDest && !SUPPORTED_DESTINATIONS.has(activeDest)) {
      // Some other destination type — check whether it actually changed,
      // and reject only if it did. Tags-only diffs against e.g. a Splunk
      // delivery stream should NOT throw.
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        throw new ResourceUpdateNotSupportedError(
          resourceType,
          logicalId,
          `In-place update for '${activeDest}' on AWS::KinesisFirehose::DeliveryStream is not yet implemented in cdkd (AWS exposes UpdateDestination for it; the per-shape reverse-mapper is a follow-up to #549). Re-deploy with cdkd deploy --replace.`
        );
      }
    }

    // Now that destination validity is established, apply Tags
    // (TagDeliveryStream / UntagDeliveryStream is independent of
    // destination type but must not run BEFORE the rejection branches —
    // otherwise a partial AWS write strands tags on a stream whose
    // destination diff was rejected).
    await this.applyTagsDiff(physicalId, properties['Tags'], previousProperties['Tags']);

    if (activeDest === 'ExtendedS3DestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyExtendedS3DestinationUpdate(physicalId, nextDest);
      }
    }

    if (activeDest === 'RedshiftDestinationConfiguration') {
      const nextDest = (properties[activeDest] ?? {}) as Record<string, unknown>;
      const prevDest = (previousProperties[activeDest] ?? {}) as Record<string, unknown>;
      if (JSON.stringify(nextDest) !== JSON.stringify(prevDest)) {
        await this.applyRedshiftDestinationUpdate(physicalId, nextDest);
      }
    }

    // Pull current AWS state for the result envelope.
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        ...(desc?.DeliveryStreamARN !== undefined && { Arn: desc.DeliveryStreamARN }),
      },
    };
  }

  /**
   * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
   * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
   * ExtendedS3 shape. The reverse-mapper at
   * {@link mapExtendedS3ConfigToUpdate} produces the
   * `ExtendedS3DestinationUpdate` payload (CFn property names →
   * SDK camelCase, omitting `Prefix` / `BufferingHints` / etc. when the
   * source is undefined so an empty diff doesn't clear AWS-side fields).
   */
  private async applyExtendedS3DestinationUpdate(
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const currentDestination = desc?.Destinations?.[0];
    const destinationId = currentDestination?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        ExtendedS3DestinationUpdate: this.mapExtendedS3ConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Diff and apply changes to a Firehose delivery stream's Tags via the
   * `TagDeliveryStream` / `UntagDeliveryStream` AWS APIs.
   *
   * Tags shape is `[{Key, Value}]`. Removed keys go through
   * `UntagDeliveryStream` (key-only); added / modified entries go through
   * `TagDeliveryStream` (full {Key, Value}). No-op when before/after JSON
   * is identical.
   */
  private async applyTagsDiff(physicalId: string, next: unknown, prev: unknown): Promise<void> {
    if (JSON.stringify(next ?? []) === JSON.stringify(prev ?? [])) return;
    type CfnTag = { Key?: string; Value?: string };
    const nextEntries = (Array.isArray(next) ? next : []) as CfnTag[];
    const prevEntries = (Array.isArray(prev) ? prev : []) as CfnTag[];
    const nextByKey = new Map<string, CfnTag>();
    for (const t of nextEntries) {
      if (t.Key) nextByKey.set(t.Key, t);
    }
    const prevByKey = new Map<string, CfnTag>();
    for (const t of prevEntries) {
      if (t.Key) prevByKey.set(t.Key, t);
    }
    const tagKeysToRemove: string[] = [];
    for (const key of prevByKey.keys()) {
      if (!nextByKey.has(key)) tagKeysToRemove.push(key);
    }
    if (tagKeysToRemove.length > 0) {
      await this.getClient().send(
        new UntagDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
          TagKeys: tagKeysToRemove,
        })
      );
    }
    const tagsToUpsert: CfnTag[] = [];
    for (const [key, tag] of nextByKey) {
      const before = prevByKey.get(key);
      if (JSON.stringify(before) === JSON.stringify(tag)) continue;
      tagsToUpsert.push(tag);
    }
    if (tagsToUpsert.length > 0) {
      await this.getClient().send(
        new TagDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
          Tags: tagsToUpsert.map((t) => ({
            Key: t.Key as string,
            ...(t.Value !== undefined && { Value: t.Value }),
          })),
        })
      );
    }
  }

  /**
   * Return the key of the destination property present on a properties
   * record, or `undefined` if none is present. AWS allows exactly one
   * destination configuration per delivery stream, so the first match is
   * authoritative; the ordering walks the most-common types first.
   */
  private findDestinationKey(properties: Record<string, unknown>): string | undefined {
    const destinationKeys = [
      'ExtendedS3DestinationConfiguration',
      'S3DestinationConfiguration',
      'HttpEndpointDestinationConfiguration',
      'RedshiftDestinationConfiguration',
      'ElasticsearchDestinationConfiguration',
      'AmazonopensearchserviceDestinationConfiguration',
      'SplunkDestinationConfiguration',
      'AmazonOpenSearchServerlessDestinationConfiguration',
      // Newer destination types (Iceberg / Snowflake) — current cdkd
      // does not implement reverse-mappers for them, so they hit the
      // non-ExtendedS3 reject branch with a clear message. Tracked as
      // follow-ups to #477. Listed here so a stream USING one of them
      // isn't silently treated as "no destination", which would let
      // tag-only diffs proceed without surfacing the unsupported-update.
      'IcebergDestinationConfiguration',
      'SnowflakeDestinationConfiguration',
    ];
    for (const key of destinationKeys) {
      if (properties[key] !== undefined) return key;
    }
    return undefined;
  }

  /**
   * Delete a Firehose delivery stream
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting Firehose delivery stream ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteDeliveryStreamCommand({
          DeliveryStreamName: physicalId,
        })
      );
      this.logger.debug(`Successfully deleted Firehose delivery stream ${logicalId}`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(
          `Firehose delivery stream ${physicalId} does not exist, skipping deletion`
        );
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete Firehose delivery stream ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  // ─── Helpers ───────────────────────────────────────────────────────

  /**
   * Map CFn S3DestinationConfiguration to SDK format
   *
   * CFn uses PascalCase (BucketArn, RoleArn) while SDK uses uppercase ARN
   * (BucketARN, RoleARN).
   */
  private mapS3DestinationConfiguration(
    config: Record<string, unknown>
  ): S3DestinationConfiguration {
    const result: S3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as S3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as S3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as S3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    return result;
  }

  /**
   * Map CFn ExtendedS3DestinationConfiguration to SDK format
   */
  private mapExtendedS3DestinationConfiguration(
    config: Record<string, unknown>
  ): ExtendedS3DestinationConfiguration {
    const result: ExtendedS3DestinationConfiguration = {
      BucketARN: (config['BucketArn'] || config['BucketARN']) as string,
      RoleARN: (config['RoleArn'] || config['RoleARN']) as string,
    };

    if (config['Prefix'] !== undefined) {
      result.Prefix = config['Prefix'] as string;
    }

    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }

    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as ExtendedS3DestinationConfiguration['CompressionFormat'];
    }

    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }

    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as ExtendedS3DestinationConfiguration['EncryptionConfiguration'];
    }

    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ExtendedS3DestinationConfiguration['CloudWatchLoggingOptions'];
    }

    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ExtendedS3DestinationConfiguration['ProcessingConfiguration'];
    }

    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config[
        'S3BackupMode'
      ] as ExtendedS3DestinationConfiguration['S3BackupMode'];
    }

    if (config['S3BackupConfiguration'] !== undefined) {
      const backupConfig = config['S3BackupConfiguration'] as Record<string, unknown>;
      result.S3BackupConfiguration = this.mapS3DestinationConfiguration(backupConfig);
    }

    if (config['DataFormatConversionConfiguration'] !== undefined) {
      result.DataFormatConversionConfiguration = config[
        'DataFormatConversionConfiguration'
      ] as ExtendedS3DestinationConfiguration['DataFormatConversionConfiguration'];
    }

    return result;
  }

  /**
   * Map CFn `ExtendedS3DestinationConfiguration` to the
   * `ExtendedS3DestinationUpdate` shape expected by AWS
   * `UpdateDestinationCommand` (#477). Shape is structurally identical
   * to `ExtendedS3DestinationConfiguration` but every field is optional
   * — only the fields present in `config` are forwarded so undefined
   * keys do not clobber AWS-side state.
   *
   * `S3BackupConfiguration` is mapped through {@link mapS3ConfigToUpdate}
   * so its own optional fields likewise round-trip cleanly.
   */
  private mapExtendedS3ConfigToUpdate(
    config: Record<string, unknown>
  ): ExtendedS3DestinationUpdate {
    const result: ExtendedS3DestinationUpdate = {};
    const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
    if (bucketArn !== undefined) result.BucketARN = bucketArn;
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }
    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as ExtendedS3DestinationUpdate['CompressionFormat'];
    }
    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }
    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as ExtendedS3DestinationUpdate['EncryptionConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as ExtendedS3DestinationUpdate['CloudWatchLoggingOptions'];
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as ExtendedS3DestinationUpdate['ProcessingConfiguration'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as ExtendedS3DestinationUpdate['S3BackupMode'];
    }
    if (config['S3BackupConfiguration'] !== undefined) {
      // CFn property is `S3BackupConfiguration`; SDK's Update shape uses
      // `S3BackupUpdate`. The reverse-mapper consumes CFn-shaped input,
      // so only the CFn key needs to be handled.
      result.S3BackupUpdate = this.mapS3ConfigToUpdate(
        config['S3BackupConfiguration'] as Record<string, unknown>
      );
    }
    if (config['DataFormatConversionConfiguration'] !== undefined) {
      result.DataFormatConversionConfiguration = config[
        'DataFormatConversionConfiguration'
      ] as ExtendedS3DestinationUpdate['DataFormatConversionConfiguration'];
    }
    return result;
  }

  /**
   * Recover `CurrentDeliveryStreamVersionId` + `DestinationId` from
   * `DescribeDeliveryStream` and issue `UpdateDestination` with the new
   * Redshift shape. The reverse-mapper at
   * {@link mapRedshiftConfigToUpdate} produces the
   * `RedshiftDestinationUpdate` payload — only fields present in the
   * input are forwarded so omitted CFn keys don't clobber AWS-side
   * state. Mirrors {@link applyExtendedS3DestinationUpdate} (#549).
   */
  private async applyRedshiftDestinationUpdate(
    physicalId: string,
    nextConfig: Record<string, unknown>
  ): Promise<void> {
    const description = await this.getClient().send(
      new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
    );
    const desc = description.DeliveryStreamDescription;
    const currentVersionId = desc?.VersionId;
    const currentDestination = desc?.Destinations?.[0];
    const destinationId = currentDestination?.DestinationId;
    if (!currentVersionId || !destinationId) {
      throw new ProvisioningError(
        `DescribeDeliveryStream for ${physicalId} did not return VersionId or DestinationId; UpdateDestination cannot proceed.`,
        'AWS::KinesisFirehose::DeliveryStream',
        physicalId
      );
    }
    await this.getClient().send(
      new UpdateDestinationCommand({
        DeliveryStreamName: physicalId,
        CurrentDeliveryStreamVersionId: currentVersionId,
        DestinationId: destinationId,
        RedshiftDestinationUpdate: this.mapRedshiftConfigToUpdate(nextConfig),
      })
    );
  }

  /**
   * Map CFn `RedshiftDestinationConfiguration` to the
   * `RedshiftDestinationUpdate` shape used by AWS
   * `UpdateDestinationCommand` (#549). Every field is `!== undefined`
   * gated so omitted CFn keys do not clobber AWS-side state. The CFn
   * `S3Configuration` field is mapped through
   * {@link mapS3ConfigToUpdate} into the SDK-side `S3Update` slot;
   * `S3BackupConfiguration` likewise into `S3BackupUpdate`.
   */
  private mapRedshiftConfigToUpdate(config: Record<string, unknown>): RedshiftDestinationUpdate {
    const result: RedshiftDestinationUpdate = {};
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    const clusterJdbcUrl = (config['ClusterJDBCURL'] ?? config['ClusterJdbcUrl']) as
      | string
      | undefined;
    if (clusterJdbcUrl !== undefined) result.ClusterJDBCURL = clusterJdbcUrl;
    if (config['CopyCommand'] !== undefined) {
      result.CopyCommand = config['CopyCommand'] as RedshiftDestinationUpdate['CopyCommand'];
    }
    if (config['Username'] !== undefined) result.Username = config['Username'] as string;
    if (config['Password'] !== undefined) result.Password = config['Password'] as string;
    if (config['RetryOptions'] !== undefined) {
      result.RetryOptions = config['RetryOptions'] as RedshiftDestinationUpdate['RetryOptions'];
    }
    // CFn property is `S3Configuration`; SDK Update shape uses `S3Update`.
    if (config['S3Configuration'] !== undefined) {
      result.S3Update = this.mapS3ConfigToUpdate(
        config['S3Configuration'] as Record<string, unknown>
      );
    }
    if (config['ProcessingConfiguration'] !== undefined) {
      result.ProcessingConfiguration = config[
        'ProcessingConfiguration'
      ] as RedshiftDestinationUpdate['ProcessingConfiguration'];
    }
    if (config['S3BackupMode'] !== undefined) {
      result.S3BackupMode = config['S3BackupMode'] as RedshiftDestinationUpdate['S3BackupMode'];
    }
    // CFn property is `S3BackupConfiguration`; SDK Update shape uses
    // `S3BackupUpdate`. Mirrors the ExtendedS3 pattern.
    if (config['S3BackupConfiguration'] !== undefined) {
      result.S3BackupUpdate = this.mapS3ConfigToUpdate(
        config['S3BackupConfiguration'] as Record<string, unknown>
      );
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as RedshiftDestinationUpdate['CloudWatchLoggingOptions'];
    }
    return result;
  }

  /**
   * Map CFn `S3DestinationConfiguration` to the `S3DestinationUpdate`
   * shape used by AWS `UpdateDestinationCommand` (#477; consumed by
   * {@link mapExtendedS3ConfigToUpdate} for the `S3BackupUpdate` field).
   * Every field optional — only present keys are forwarded.
   */
  private mapS3ConfigToUpdate(config: Record<string, unknown>): S3DestinationUpdate {
    const result: S3DestinationUpdate = {};
    const bucketArn = (config['BucketArn'] ?? config['BucketARN']) as string | undefined;
    if (bucketArn !== undefined) result.BucketARN = bucketArn;
    const roleArn = (config['RoleArn'] ?? config['RoleARN']) as string | undefined;
    if (roleArn !== undefined) result.RoleARN = roleArn;
    if (config['Prefix'] !== undefined) result.Prefix = config['Prefix'] as string;
    if (config['ErrorOutputPrefix'] !== undefined) {
      result.ErrorOutputPrefix = config['ErrorOutputPrefix'] as string;
    }
    if (config['CompressionFormat'] !== undefined) {
      result.CompressionFormat = config[
        'CompressionFormat'
      ] as S3DestinationUpdate['CompressionFormat'];
    }
    if (config['BufferingHints'] !== undefined) {
      const hints = config['BufferingHints'] as Record<string, unknown>;
      result.BufferingHints = {
        ...(hints['SizeInMBs'] !== undefined && { SizeInMBs: hints['SizeInMBs'] as number }),
        ...(hints['IntervalInSeconds'] !== undefined && {
          IntervalInSeconds: hints['IntervalInSeconds'] as number,
        }),
      };
    }
    if (config['EncryptionConfiguration'] !== undefined) {
      result.EncryptionConfiguration = config[
        'EncryptionConfiguration'
      ] as S3DestinationUpdate['EncryptionConfiguration'];
    }
    if (config['CloudWatchLoggingOptions'] !== undefined) {
      result.CloudWatchLoggingOptions = config[
        'CloudWatchLoggingOptions'
      ] as S3DestinationUpdate['CloudWatchLoggingOptions'];
    }
    return result;
  }

  /**
   * Adopt an existing Kinesis Firehose delivery stream into cdkd state.
   *
   * Lookup order:
   *  1. `--resource <id>=<name>` override or `Properties.DeliveryStreamName`
   *     → verify with `DescribeDeliveryStream`.
   *  2. Walk `ListDeliveryStreams` (paged via `ExclusiveStartDeliveryStreamName`)
   *     and match the `aws:cdk:path` tag via
   *     `ListTagsForDeliveryStream(DeliveryStreamName)`.
   *
   * Firehose tags use the standard `Tag[]` array shape (`Key`/`Value`).
   */
  /**
   * Read the AWS-current Firehose delivery stream configuration in CFn-property shape.
   *
   * Surfaces top-level configuration that has a clean 1:1 mapping back to
   * cdkd state — `DeliveryStreamName`, `DeliveryStreamType`, and the
   * `KinesisStreamSourceConfiguration` parent fields when present (the
   * `DescribeDeliveryStream` response splits source under `Source.KinesisStreamSourceDescription`).
   *
   * **Destination configurations**: full coverage for S3 / ExtendedS3.
   * AWS returns destination config under `Destinations[0].*DestinationDescription`
   * (note: `Description`, not `Configuration`); the SDK reuses the same
   * type as the corresponding `*Configuration` input for the inner
   * sub-shapes, so reverse-mapping is a `pickDefinedDeep` pass-through.
   *
   * Surfaced top-level fields: `BucketARN`, `RoleARN`, `Prefix`,
   * `ErrorOutputPrefix`, `BufferingHints`, `CompressionFormat`, plus
   * `S3BackupMode` for Extended. Surfaced inner nested fields:
   * `EncryptionConfiguration`, `CloudWatchLoggingOptions` (both shapes);
   * additionally for Extended `ProcessingConfiguration`,
   * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
   * `S3BackupConfiguration` (reverse-mapped from the AWS-side
   * `S3BackupDescription`). Each inner subtree is always emitted (even
   * as `{}` placeholder) so the v3 `observedProperties` baseline catches
   * console-side ADDs to a previously-default sub-shape.
   *
   * Non-S3 destination types
   * (`Redshift`/`Elasticsearch`/`Amazonopensearchservice`/`Splunk`/`HttpEndpoint`/`AmazonOpenSearchServerless`)
   * are reverse-mapped via `mapRedshiftDescriptionToCfn` /
   * `mapHttpEndpointDescriptionToCfn` / `mapNonS3DestinationToCfn`. The
   * SDK reuses field names between Description and Configuration for
   * these destinations, so a `pickDefinedDeep` pass-through produces a
   * CFn-compatible shape. AWS-managed read-only `VpcId` is stripped
   * from `VpcConfigurationDescription`. Write-only fields AWS strips
   * from descriptions (`RedshiftDestinationConfiguration.Password`,
   * `HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey`)
   * stay drift-unknown via `getDriftUnknownPaths` — no AWS API recovers them.
   *
   * `DeliveryStreamEncryptionConfigurationInput` is also surfaced. AWS
   * returns the read-side shape `DeliveryStreamEncryptionConfiguration`
   * (with extra `Status` / `FailureDescription` fields); we reverse-map
   * to the CFn input shape (`KeyARN` + `KeyType`) and always emit a
   * `{}` placeholder so the v3 baseline catches console-side encryption
   * enables on a previously-default stream.
   *
   * Tags are surfaced via a follow-up `ListTagsForDeliveryStream` call
   * with `aws:*` filtered out and always emitted as `[]` placeholder when
   * no user tags remain.
   *
   * Returns `undefined` when the stream is gone (`ResourceNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let desc;
    try {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      desc = resp.DeliveryStreamDescription;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      throw err;
    }
    if (!desc) return undefined;

    const result: Record<string, unknown> = {};
    if (desc.DeliveryStreamName !== undefined) {
      result['DeliveryStreamName'] = desc.DeliveryStreamName;
    }
    if (desc.DeliveryStreamType !== undefined) {
      result['DeliveryStreamType'] = desc.DeliveryStreamType;
    }

    // Source: only KinesisStreamSourceDescription has a clean CFn analogue.
    if (desc.Source?.KinesisStreamSourceDescription) {
      const src = desc.Source.KinesisStreamSourceDescription;
      const srcOut: Record<string, unknown> = {};
      if (src.KinesisStreamARN !== undefined) srcOut['KinesisStreamARN'] = src.KinesisStreamARN;
      if (src.RoleARN !== undefined) srcOut['RoleARN'] = src.RoleARN;
      if (Object.keys(srcOut).length > 0) {
        result['KinesisStreamSourceConfiguration'] = srcOut;
      }
    }

    // Destinations: Firehose holds at most one destination on a delivery
    // stream. CDK constructs typically emit ExtendedS3 (the modern shape)
    // even for plain S3 use cases; legacy `S3DestinationDescription` is
    // still surfaced separately for templates that pin the legacy shape.
    // The two shapes are mutually exclusive on AWS responses.
    const dest = desc.Destinations?.[0];
    if (dest?.ExtendedS3DestinationDescription) {
      result['ExtendedS3DestinationConfiguration'] = mapExtendedS3DescriptionToCfn(
        dest.ExtendedS3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.S3DestinationDescription) {
      result['S3DestinationConfiguration'] = mapS3DescriptionToCfn(
        dest.S3DestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.RedshiftDestinationDescription) {
      result['RedshiftDestinationConfiguration'] = mapRedshiftDescriptionToCfn(
        dest.RedshiftDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.ElasticsearchDestinationDescription) {
      result['ElasticsearchDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.ElasticsearchDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonopensearchserviceDestinationDescription) {
      result['AmazonopensearchserviceDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonopensearchserviceDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.AmazonOpenSearchServerlessDestinationDescription) {
      result['AmazonOpenSearchServerlessDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.AmazonOpenSearchServerlessDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.SplunkDestinationDescription) {
      result['SplunkDestinationConfiguration'] = mapNonS3DestinationToCfn(
        dest.SplunkDestinationDescription as unknown as Record<string, unknown>
      );
    } else if (dest?.HttpEndpointDestinationDescription) {
      result['HttpEndpointDestinationConfiguration'] = mapHttpEndpointDescriptionToCfn(
        dest.HttpEndpointDestinationDescription as unknown as Record<string, unknown>
      );
    }

    // DeliveryStreamEncryptionConfigurationInput: AWS returns the read-side
    // shape `DeliveryStreamEncryptionConfiguration` with extra status /
    // failure fields. CFn input shape carries `KeyARN` + `KeyType` only.
    // Surface those when AWS reports them; emit `{}` placeholder always so
    // the v3 baseline catches a console-side enable on a previously-default
    // stream (PR #145 always-emit pattern).
    const enc = desc.DeliveryStreamEncryptionConfiguration;
    const encOut: Record<string, unknown> = {};
    if (enc?.KeyARN !== undefined) encOut['KeyARN'] = enc.KeyARN;
    if (enc?.KeyType !== undefined) encOut['KeyType'] = enc.KeyType;
    result['DeliveryStreamEncryptionConfigurationInput'] = encOut;

    // Tags via ListTagsForDeliveryStream.
    // Always emit `Tags` (even as `[]`) per docs/provider-development.md
    // § 3b "always emit user-controllable top-level keys": omitting the
    // key on the failure path means the comparator's state-keys-only
    // walk skips Tags forever, hiding console-side tag adds from drift.
    try {
      const tagsResp = await this.getClient().send(
        new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: physicalId })
      );
      result['Tags'] = normalizeAwsTagsToCfn(tagsResp.Tags);
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return undefined;
      this.logger.debug(
        `Firehose ListTagsForDeliveryStream(${physicalId}) failed: ${err instanceof Error ? err.message : String(err)}`
      );
      result['Tags'] = [];
    }

    return result;
  }

  /**
   * Drift-unknown paths for `AWS::KinesisFirehose::DeliveryStream`.
   *
   * The drift comparator skips these state property paths so they never
   * fire false-positive drift on every run. See the `readCurrentState`
   * docstring for the full rationale per category.
   *
   * Only write-only fields AWS strips from descriptions remain:
   * Redshift `Password`, HttpEndpoint `EndpointConfiguration.AccessKey`.
   * State that carries these would otherwise fire drift on every run —
   * declaring them as drift-unknown is the cleanest fix because there
   * is no AWS read API to recover their values.
   *
   * S3 / ExtendedS3 inner nested fields, non-S3 destination types
   * (Redshift / Elasticsearch / Amazonopensearchservice / Splunk /
   * HttpEndpoint / AmazonOpenSearchServerless), and
   * `DeliveryStreamEncryptionConfigurationInput` are all reverse-mapped
   * by `readCurrentState` and no longer drift-unknown.
   */
  getDriftUnknownPaths(): string[] {
    return [
      // Write-only fields AWS does not return on read — no API workaround.
      'RedshiftDestinationConfiguration.Password',
      'HttpEndpointDestinationConfiguration.EndpointConfiguration.AccessKey',
    ];
  }

  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'DeliveryStreamName');
    if (explicit) {
      try {
        await this.getClient().send(
          new DescribeDeliveryStreamCommand({ DeliveryStreamName: explicit })
        );
        return { physicalId: explicit, attributes: {} };
      } catch (err) {
        if (err instanceof ResourceNotFoundException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let exclusiveStartDeliveryStreamName: string | undefined;
    // ListDeliveryStreams paginates via `ExclusiveStartDeliveryStreamName`
    // (last name from previous page) when `HasMoreDeliveryStreams` is true.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const list = await this.getClient().send(
        new ListDeliveryStreamsCommand({
          ...(exclusiveStartDeliveryStreamName && {
            ExclusiveStartDeliveryStreamName: exclusiveStartDeliveryStreamName,
          }),
        })
      );
      const names = list.DeliveryStreamNames ?? [];
      for (const name of names) {
        const tagsResp = await this.getClient().send(
          new ListTagsForDeliveryStreamCommand({ DeliveryStreamName: name })
        );
        if (matchesCdkPath(tagsResp.Tags, input.cdkPath)) {
          return { physicalId: name, attributes: {} };
        }
      }
      if (!list.HasMoreDeliveryStreams || names.length === 0) break;
      exclusiveStartDeliveryStreamName = names[names.length - 1];
    }
    return null;
  }

  /**
   * Wait for a delivery stream to become ACTIVE.
   * Firehose CreateDeliveryStream returns immediately while the stream is still CREATING.
   */
  private async waitForActive(streamName: string, logicalId: string): Promise<void> {
    const maxAttempts = 30;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const resp = await this.getClient().send(
        new DescribeDeliveryStreamCommand({ DeliveryStreamName: streamName })
      );
      const status = resp.DeliveryStreamDescription?.DeliveryStreamStatus;
      if (status === 'ACTIVE') {
        this.logger.debug(`Firehose ${logicalId} is ACTIVE`);
        return;
      }
      this.logger.debug(
        `Firehose ${logicalId} status: ${status} (attempt ${attempt}/${maxAttempts})`
      );
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
    this.logger.warn(`Firehose ${logicalId} did not reach ACTIVE after ${maxAttempts} attempts`);
  }
}

// ─── Description → CFn nested-shape helpers ──────────────────────────
//
// The AWS Firehose SDK returns destination configuration under
// `*DestinationDescription` types. For most of the inner sub-shapes
// (`EncryptionConfiguration`, `CloudWatchLoggingOptions`,
// `ProcessingConfiguration`, `DataFormatConversionConfiguration`,
// `DynamicPartitioningConfiguration`) the SDK reuses the same type as
// the corresponding `*Configuration` input — so reverse-mapping is a
// pass-through that strips `undefined` fields. Per docs/provider-development.md
// § 3b "always emit user-controllable top-level keys": even though
// these are nested rather than top-level, surfacing them on every
// readCurrentState call (as `{}` placeholder when AWS reports nothing)
// keeps the v3 observedProperties baseline consistent so console-side
// ADDs to a previously-undefined sub-shape surface as drift.

type Defined<T> = { [K in keyof T]-?: T[K] extends undefined ? never : Exclude<T[K], undefined> };

/**
 * Strip `undefined` fields (and empty resulting objects) from an AWS-SDK
 * Description object so it round-trips cleanly through cdkd's drift
 * comparator. Recursive — descends through nested objects but leaves
 * arrays as-is (positional compare on AWS-returned order is stable for
 * Firehose's response shapes).
 */
function pickDefinedDeep<T>(input: T | undefined): Partial<Defined<T>> | undefined {
  if (input === undefined || input === null) return undefined;
  if (typeof input !== 'object') return input as unknown as Partial<Defined<T>>;
  if (Array.isArray(input)) {
    return input.map((v) => pickDefinedDeep(v)) as unknown as Partial<Defined<T>>;
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input as Record<string, unknown>)) {
    if (v === undefined) continue;
    const cleaned = pickDefinedDeep(v as unknown);
    if (cleaned === undefined) continue;
    if (
      cleaned !== null &&
      typeof cleaned === 'object' &&
      !Array.isArray(cleaned) &&
      Object.keys(cleaned as Record<string, unknown>).length === 0
    ) {
      // Drop empty nested objects to avoid `{}` clutter — except at the
      // top level, the caller decides whether to surface a placeholder.
      continue;
    }
    out[k] = cleaned;
  }
  return out as Partial<Defined<T>>;
}

/**
 * Map S3DestinationDescription → CFn S3DestinationConfiguration.
 * Surfaces the top-level subset that has a clean reverse-mapping plus
 * the inner nested complex fields (EncryptionConfiguration /
 * CloudWatchLoggingOptions) that the SDK reuses across both shapes.
 *
 * Typed as `Record<string, unknown>` to side-step the SDK's strict
 * required/optional discriminator on `RoleARN` / `BucketARN` that
 * `exactOptionalPropertyTypes` rejects when passing a sub-object whose
 * own RoleARN/BucketARN may be undefined (e.g. the deprecated
 * S3BackupDescription form). Behavior unchanged.
 */
function mapS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (desc['BucketARN'] !== undefined) out['BucketARN'] = desc['BucketARN'];
  if (desc['RoleARN'] !== undefined) out['RoleARN'] = desc['RoleARN'];
  if (desc['Prefix'] !== undefined) out['Prefix'] = desc['Prefix'];
  if (desc['ErrorOutputPrefix'] !== undefined) {
    out['ErrorOutputPrefix'] = desc['ErrorOutputPrefix'];
  }
  if (desc['CompressionFormat'] !== undefined) {
    out['CompressionFormat'] = desc['CompressionFormat'];
  }
  if (desc['BufferingHints']) {
    const hints = pickDefinedDeep(desc['BufferingHints']);
    if (hints && typeof hints === 'object' && Object.keys(hints).length > 0) {
      out['BufferingHints'] = hints;
    }
  }
  // EncryptionConfiguration: surface always so a console-side enable on a
  // previously-default destination shows as drift on v3 baseline.
  out['EncryptionConfiguration'] = pickDefinedDeep(desc['EncryptionConfiguration']) ?? {};
  // CloudWatchLoggingOptions: same pattern.
  out['CloudWatchLoggingOptions'] = pickDefinedDeep(desc['CloudWatchLoggingOptions']) ?? {};
  return out;
}

/**
 * Map ExtendedS3DestinationDescription → CFn ExtendedS3DestinationConfiguration.
 * Adds the Extended-only inner fields (`ProcessingConfiguration`,
 * `DataFormatConversionConfiguration`, `DynamicPartitioningConfiguration`,
 * `S3BackupConfiguration`) on top of the S3 base set.
 *
 * `S3BackupDescription` (note: Description, not Configuration) is
 * delegated to `mapS3DescriptionToCfn` since AWS uses the deprecated
 * S3DestinationDescription shape for backup, but CFn input expects
 * S3DestinationConfiguration — same field names work.
 */
function mapExtendedS3DescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out = mapS3DescriptionToCfn(desc);
  if (desc['S3BackupMode'] !== undefined) out['S3BackupMode'] = desc['S3BackupMode'];
  // Inner nested complex fields. SDK reuses the *Configuration types in
  // *Description responses, so a deep `pickDefinedDeep` produces a CFn-
  // compatible shape.
  out['ProcessingConfiguration'] = pickDefinedDeep(desc['ProcessingConfiguration']) ?? {};
  out['DataFormatConversionConfiguration'] =
    pickDefinedDeep(desc['DataFormatConversionConfiguration']) ?? {};
  out['DynamicPartitioningConfiguration'] =
    pickDefinedDeep(desc['DynamicPartitioningConfiguration']) ?? {};
  // S3BackupConfiguration: AWS returns S3BackupDescription (deprecated
  // shape); reverse-map to the modern Configuration shape via the same
  // top-level helper. Field names align since the deprecated shape and
  // the modern shape share the BucketARN / RoleARN / Prefix / etc.
  // surface, just with the EncryptionConfiguration / CloudWatchLoggingOptions
  // inner placeholders included.
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  } else {
    out['S3BackupConfiguration'] = {};
  }
  return out;
}

/**
 * Map a non-S3 destination description (Elasticsearch /
 * Amazonopensearchservice / AmazonOpenSearchServerless / Splunk) to
 * its CFn `*Configuration` shape.
 *
 * AWS reuses field names between Description and Configuration for
 * these destinations, so a `pickDefinedDeep` pass-through produces a
 * CFn-compatible shape. The exception is `VpcConfigurationDescription`
 * which carries an AWS-managed read-only `VpcId` not present in the
 * CFn `VpcConfiguration` input shape — strip it so the comparator
 * doesn't fire false drift on the read-only field.
 *
 * Always-emit pattern: every nested complex sub-shape AWS reports
 * (BufferingHints / RetryOptions / ProcessingConfiguration /
 * CloudWatchLoggingOptions / VpcConfiguration / DocumentIdOptions /
 * SecretsManagerConfiguration) that the SDK reuses across both shapes
 * is surfaced via `pickDefinedDeep`. Non-templated sub-shapes are
 * dropped to avoid `{}` clutter; the v3 baseline catches console-side
 * ADDs at the top-level destination key, not at every leaf.
 */
function mapNonS3DestinationToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const cleaned = pickDefinedDeep(desc) as Record<string, unknown> | undefined;
  if (!cleaned) return {};
  // AWS returns VpcConfigurationDescription with a read-only VpcId; the
  // CFn VpcConfiguration shape does not include it. Strip if present.
  if (cleaned['VpcConfigurationDescription']) {
    const vpc = { ...(cleaned['VpcConfigurationDescription'] as Record<string, unknown>) };
    delete vpc['VpcId'];
    // Rename to the CFn key (`VpcConfiguration`).
    delete cleaned['VpcConfigurationDescription'];
    if (Object.keys(vpc).length > 0) cleaned['VpcConfiguration'] = vpc;
  }
  return cleaned;
}

/**
 * Map RedshiftDestinationDescription → CFn RedshiftDestinationConfiguration.
 *
 * Redshift carries a nested S3DestinationDescription (deprecated shape)
 * that's required as `S3Configuration` in the CFn input. Reverse-map via
 * the shared `mapS3DescriptionToCfn` helper. `S3BackupDescription` is
 * mapped to `S3BackupConfiguration` the same way.
 *
 * `Password` is write-only — AWS never returns it on read. State that
 * carries `Password` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 */
function mapRedshiftDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'RoleARN',
    'ClusterJDBCURL',
    'CopyCommand',
    'Username',
    'RetryOptions',
    'ProcessingConfiguration',
    'S3BackupMode',
    'CloudWatchLoggingOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  // Required nested S3 destination — reverse-map via the S3 helper.
  if (desc['S3DestinationDescription']) {
    out['S3Configuration'] = mapS3DescriptionToCfn(
      desc['S3DestinationDescription'] as Record<string, unknown>
    );
  }
  if (desc['S3BackupDescription']) {
    out['S3BackupConfiguration'] = mapS3DescriptionToCfn(
      desc['S3BackupDescription'] as Record<string, unknown>
    );
  }
  return out;
}

/**
 * Map HttpEndpointDestinationDescription → CFn HttpEndpointDestinationConfiguration.
 *
 * AWS returns `EndpointConfiguration: HttpEndpointDescription` (Url +
 * Name only). The CFn input `HttpEndpointConfiguration` additionally
 * accepts `AccessKey` (write-only — redacted from the Description).
 * State that carries `AccessKey` falls back to v2 baseline; declared in
 * `getDriftUnknownPaths`.
 *
 * `RequestConfiguration` and `SecretsManagerConfiguration` are pass-
 * through (SDK reuses the same shapes between Configuration and
 * Description).
 */
function mapHttpEndpointDescriptionToCfn(desc: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of [
    'BufferingHints',
    'CloudWatchLoggingOptions',
    'RequestConfiguration',
    'ProcessingConfiguration',
    'RoleARN',
    'RetryOptions',
    'SecretsManagerConfiguration',
  ]) {
    const v = pickDefinedDeep(desc[k]);
    if (v !== undefined) out[k] = v;
  }
  if (desc['EndpointConfiguration']) {
    const endpoint = pickDefinedDeep(desc['EndpointConfiguration']);
    if (endpoint !== undefined) out['EndpointConfiguration'] = endpoint;
  }
  return out;
}
