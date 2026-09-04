import {
  CloudFrontClient,
  CreateOriginAccessControlCommand,
  DeleteOriginAccessControlCommand,
  GetOriginAccessControlCommand,
  UpdateOriginAccessControlCommand,
  NoSuchOriginAccessControl,
  type OriginAccessControlConfig,
} from '@aws-sdk/client-cloudfront';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { CdkdError, ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * SDK Provider for AWS::CloudFront::OriginAccessControl
 *
 * An Origin Access Control (OAC) is the modern replacement for an Origin
 * Access Identity and is what `S3BucketOrigin.withOriginAccessControl()`
 * synthesizes, so it appears in essentially every CloudFront + S3 CDK stack.
 * Before this provider it was the only resource in such a stack without an
 * SDK Provider and therefore routed through the Cloud Control API, paying
 * ProgressEvent polling (measured ~2.3s on the deploy critical path) for a
 * `CreateOriginAccessControl` call that returns synchronously. Because the
 * Distribution references the OAC, that latency delayed everything downstream.
 *
 * All four CloudFront OAC APIs are synchronous; `Update`/`Delete` additionally
 * require the resource's current `ETag` as `IfMatch`, fetched with
 * `GetOriginAccessControl`.
 */
export class CloudFrontOACProvider implements ResourceProvider {
  private cloudFrontClient: CloudFrontClient;
  private logger = getLogger().child('CloudFrontOACProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::CloudFront::OriginAccessControl', new Set(['OriginAccessControlConfig'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.cloudFrontClient = awsClients.cloudFront;
  }

  /**
   * Create a CloudFront Origin Access Control.
   *
   * `CreateOriginAccessControl` is synchronous — the response already carries
   * the generated `Id`, so there is nothing to poll or wait for.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CloudFront Origin Access Control ${logicalId}`);

    try {
      const response = await this.cloudFrontClient.send(
        new CreateOriginAccessControlCommand({
          OriginAccessControlConfig: this.toSdkConfig(
            properties['OriginAccessControlConfig'],
            logicalId,
            resourceType
          ),
        })
      );

      const oacId = response.OriginAccessControl?.Id;
      if (!oacId) {
        throw new Error('CreateOriginAccessControl returned no OriginAccessControl.Id');
      }

      this.logger.debug(`Created CloudFront Origin Access Control: ${oacId}`);

      return {
        physicalId: oacId,
        attributes: {
          Id: oacId,
        },
      };
    } catch (error) {
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CloudFront Origin Access Control ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update a CloudFront Origin Access Control.
   *
   * `UpdateOriginAccessControl` overwrites the whole
   * `OriginAccessControlConfig` and requires the resource's current `ETag` as
   * `IfMatch`, so the update is a `Get` (for the ETag) followed by the
   * `Update` itself. Every field of the config is mutable in place — an OAC
   * is never replaced by a property change.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CloudFront Origin Access Control ${logicalId}: ${physicalId}`);

    try {
      const getResponse = await this.cloudFrontClient.send(
        new GetOriginAccessControlCommand({ Id: physicalId })
      );
      const etag = getResponse.ETag;
      if (!etag) {
        throw new Error('GetOriginAccessControl did not return ETag');
      }

      await this.cloudFrontClient.send(
        new UpdateOriginAccessControlCommand({
          Id: physicalId,
          IfMatch: etag,
          OriginAccessControlConfig: this.toSdkConfig(
            properties['OriginAccessControlConfig'],
            logicalId,
            resourceType,
            physicalId
          ),
        })
      );

      this.logger.debug(`Successfully updated CloudFront Origin Access Control ${logicalId}`);

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Id: physicalId,
        },
      };
    } catch (error) {
      // Pass through cdkd-typed errors untouched (#1272): re-labelling an inner
      // ProvisioningError replaces its precise message with this outer one.
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CloudFront Origin Access Control ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a CloudFront Origin Access Control.
   *
   * `DeleteOriginAccessControl` requires the current `ETag` as `IfMatch`, so
   * the delete is a `Get` followed by the `Delete`. A `NoSuchOriginAccessControl`
   * from EITHER call is treated as idempotent success, but only after
   * `assertRegionMatch()` confirms the client is pointed at the region the
   * resource was created in (a region mismatch would otherwise silently
   * "succeed" while leaving the real resource behind).
   *
   * A `Get` that succeeds but carries no `ETag` is a hard error here for the
   * same reason it is in {@link update}: `IfMatch: undefined` reaches AWS as
   * a missing required parameter, and the resulting SDK/AWS rejection says
   * nothing about the `Get` being what came back short. On the DELETE path
   * that opacity is worse than on update — the failure surfaces during
   * `cdkd destroy`, where the user's next question is "is the OAC still
   * there?", so the message has to name the actual cause.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CloudFront Origin Access Control ${logicalId}: ${physicalId}`);

    try {
      let etag: string | undefined;
      try {
        const getResponse = await this.cloudFrontClient.send(
          new GetOriginAccessControlCommand({ Id: physicalId })
        );
        etag = getResponse.ETag;
      } catch (error) {
        if (error instanceof NoSuchOriginAccessControl) {
          await this.assertDeleteRegion(resourceType, logicalId, physicalId, context);
          this.logger.debug(
            `Origin Access Control ${physicalId} does not exist, skipping deletion`
          );
          return;
        }
        throw error;
      }

      if (!etag) {
        throw new Error('GetOriginAccessControl did not return ETag');
      }

      await this.cloudFrontClient.send(
        new DeleteOriginAccessControlCommand({
          Id: physicalId,
          IfMatch: etag,
        })
      );

      this.logger.debug(`Successfully deleted CloudFront Origin Access Control ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchOriginAccessControl) {
        await this.assertDeleteRegion(resourceType, logicalId, physicalId, context);
        this.logger.debug(`Origin Access Control ${physicalId} does not exist, skipping deletion`);
        return;
      }
      if (error instanceof CdkdError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CloudFront Origin Access Control ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get resource attribute (for Fn::GetAtt resolution).
   *
   * `Id` is the type's only read-only attribute in the CFn schema, and it IS
   * the physical id, so no AWS call is needed.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- Id is the physicalId; no AWS call needed
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') {
      return physicalId;
    }

    throw new Error(
      `Unsupported attribute: ${attributeName} for AWS::CloudFront::OriginAccessControl`
    );
  }

  /**
   * Read the AWS-current OAC configuration in CFn-property shape.
   *
   * The CFn `OriginAccessControlConfig` field names and the SDK's are
   * identical, so the reverse mapping is a straight per-field copy.
   *
   * Every field is emitted unconditionally, with `?? ''` standing in for an
   * AWS response that omits it (docs/provider-rules.md "readCurrentState() for drift detection"): the
   * optional `Description` is user-controllable and mutable, so dropping the
   * key when AWS returns nothing would leave it out of `observedProperties`
   * on a stack that never templated it — and the drift comparator's
   * keys-from-state walk would then never notice a console-side edit. The
   * `properties` fallback baseline is unaffected, since that walk only
   * descends into keys the template itself carries.
   *
   * Returns `undefined` when the OAC is gone (`NoSuchOriginAccessControl`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    if (resourceType !== 'AWS::CloudFront::OriginAccessControl') return undefined;

    try {
      const response = await this.cloudFrontClient.send(
        new GetOriginAccessControlCommand({ Id: physicalId })
      );
      const config = response.OriginAccessControl?.OriginAccessControlConfig;
      if (!config) return undefined;

      return {
        OriginAccessControlConfig: {
          Name: config.Name ?? '',
          Description: config.Description ?? '',
          OriginAccessControlOriginType: config.OriginAccessControlOriginType ?? '',
          SigningBehavior: config.SigningBehavior ?? '',
          SigningProtocol: config.SigningProtocol ?? '',
        },
      };
    } catch (error) {
      if (error instanceof NoSuchOriginAccessControl) return undefined;
      throw error;
    }
  }

  /**
   * Adopt an existing CloudFront Origin Access Control into cdkd state.
   *
   * **Explicit override only.** An OAC carries no tags (CloudFront's tagging
   * APIs cover distributions / streaming distributions, not OACs) and has no
   * template-supplied physical name — the physical id is the AWS-generated
   * `E...` id, while the config's `Name` is a display field that AWS does not
   * accept as a lookup key. Users adopting an existing OAC pass
   * `--resource <logicalId>=<oacId>`; the id is verified with a single
   * `GetOriginAccessControl` so a typo reports not-found instead of poisoning
   * state.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) return null;

    try {
      await this.cloudFrontClient.send(
        new GetOriginAccessControlCommand({ Id: input.knownPhysicalId })
      );
      return { physicalId: input.knownPhysicalId, attributes: { Id: input.knownPhysicalId } };
    } catch (error) {
      if (error instanceof NoSuchOriginAccessControl) return null;
      throw error;
    }
  }

  /**
   * Map the CFn `OriginAccessControlConfig` property onto the SDK's
   * `OriginAccessControlConfig` shape.
   *
   * The two shapes use identical field names, so this is a field-by-field
   * copy that exists to (a) fail loudly when a required field is missing
   * rather than letting the SDK reject with an opaque serialization error,
   * and (b) keep unknown extra keys out of the request.
   *
   * All four required fields are checked for a NON-EMPTY string, not merely
   * for `typeof === 'string'`. `''` is the shape an unresolved intrinsic or a
   * `Fn::Sub` over a missing value most often collapses into, and CloudFront
   * rejects it just as surely as it rejects an absent field — so letting it
   * through would defeat the whole point of (a): the user would get AWS's
   * `InvalidArgument` instead of a message naming the field cdkd could see
   * was blank. The three type/behavior fields are additionally CFn enums
   * (`s3` / `mediastore` / `lambda` / `mediapackagev2`; `always` / `never` /
   * `no-override`; `sigv4`), for which the empty string is never a member.
   * `Description` is deliberately not in this set — it is genuinely optional
   * and `''` is a legitimate value that clears it.
   */
  private toSdkConfig(
    value: unknown,
    logicalId: string,
    resourceType: string,
    physicalId?: string
  ): OriginAccessControlConfig {
    const config = (value ?? {}) as Record<string, unknown>;

    const name = config['Name'];
    const originType = config['OriginAccessControlOriginType'];
    const signingBehavior = config['SigningBehavior'];
    const signingProtocol = config['SigningProtocol'];

    const nonEmpty = (value: unknown): boolean => typeof value === 'string' && value.length > 0;

    const missing = [
      nonEmpty(name) ? undefined : 'Name',
      nonEmpty(originType) ? undefined : 'OriginAccessControlOriginType',
      nonEmpty(signingBehavior) ? undefined : 'SigningBehavior',
      nonEmpty(signingProtocol) ? undefined : 'SigningProtocol',
    ].filter((field): field is string => field !== undefined);

    if (missing.length > 0) {
      throw new ProvisioningError(
        `CloudFront Origin Access Control ${logicalId}: OriginAccessControlConfig is missing required field(s): ${missing.join(', ')}`,
        resourceType,
        logicalId,
        physicalId
      );
    }

    const description = config['Description'];

    return {
      Name: name as string,
      OriginAccessControlOriginType:
        originType as OriginAccessControlConfig['OriginAccessControlOriginType'],
      SigningBehavior: signingBehavior as OriginAccessControlConfig['SigningBehavior'],
      SigningProtocol: signingProtocol as OriginAccessControlConfig['SigningProtocol'],
      ...(typeof description === 'string' ? { Description: description } : {}),
    };
  }

  /**
   * Shared region guard for the two delete-path not-found branches: a
   * `*NotFound` may only be treated as idempotent success when the client's
   * region matches the region the resource was recorded in.
   */
  private async assertDeleteRegion(
    resourceType: string,
    logicalId: string,
    physicalId: string,
    context?: DeleteContext
  ): Promise<void> {
    const clientRegion = await this.cloudFrontClient.config.region();
    assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
  }
}
