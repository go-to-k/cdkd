import {
  IAMClient,
  CreateAccessKeyCommand,
  UpdateAccessKeyCommand,
  DeleteAccessKeyCommand,
  ListAccessKeysCommand,
  GetAccessKeyLastUsedCommand,
  NoSuchEntityException,
  type StatusType,
} from '@aws-sdk/client-iam';
import { getLogger } from '../../utils/logger.js';
import { getAwsClients } from '../../utils/aws-clients.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { requireConfigString } from '../config-shape.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS IAM AccessKey Provider (issue #1323)
 *
 * Implements resource provisioning for AWS::IAM::AccessKey using the IAM SDK.
 * The type is NON_PROVISIONABLE in the CloudFormation registry (no Cloud
 * Control handlers), so without this provider cdkd's pre-flight rejects any
 * template that declares it — including the documented CDK pattern for CI
 * credentials (`iam.AccessKey` + piping `secretAccessKey` into a Secrets
 * Manager secret).
 *
 * `SecretAccessKey` is a CREATE-TIME-ONLY attribute: `CreateAccessKey` is the
 * only API call that ever returns the secret, and there is no read-back. The
 * provider therefore captures it from the create response into the returned
 * `attributes`, exactly like CloudFormation does — `Fn::GetAtt` resolution
 * reads the cached value from cdkd state. This means the secret is persisted
 * in the S3 state file; that is the same trust boundary as the rest of cdkd
 * state (and CloudFormation likewise embeds the resolved value into whatever
 * resource consumed the `Fn::GetAtt`). `update()` deliberately omits
 * `attributes` so the create-time secret is preserved in state (a partial
 * attribute set would REPLACE the stored attributes, not merge).
 *
 * `Serial` is a replacement trigger with no API counterpart: the registry
 * schema marks it createOnly, so the diff layer classifies any change as a
 * REPLACEMENT (a new key is minted); the integer itself is never sent to IAM
 * (see the `handledProperties` note for why it is still declared handled).
 */
export class IAMAccessKeyProvider implements ResourceProvider {
  private iamClient: IAMClient;
  private logger = getLogger().child('IAMAccessKeyProvider');

  /**
   * NON_PROVISIONABLE type: Cloud Control has no handlers for it, so the
   * #614 unhandled-property auto-route must never send an AccessKey
   * template to the CC path (it would fail at deploy time with no handler).
   */
  readonly disableCcApiFallback = true;

  /**
   * `Serial` is listed as HANDLED even though it is never sent to IAM: its
   * entire CloudFormation semantic is "changing it forces a new key", which
   * the diff layer implements via the registry-schema createOnly
   * classification. Declaring it `unhandledByDesign` instead would put it in
   * the silent-drop set, and on a NON_PROVISIONABLE type with
   * `disableCcApiFallback` the #614 auto-route viability guard turns every
   * silent drop into a pre-flight HARD REJECT — wrongly refusing any
   * template that uses `serial`.
   */
  handledProperties = new Map<string, ReadonlySet<string>>([
    ['AWS::IAM::AccessKey', new Set(['UserName', 'Serial', 'Status'])],
  ]);

  constructor() {
    const awsClients = getAwsClients();
    this.iamClient = awsClients.iam;
  }

  /**
   * Create an IAM access key via `CreateAccessKey`.
   *
   * `Status: Inactive` is applied with a follow-up `UpdateAccessKey` (the
   * create API always mints Active keys). If that follow-up fails, the
   * just-created key is deleted before rethrowing — otherwise the key would
   * exist on AWS without a cdkd state record, and the next deploy's re-CREATE
   * would burn the user's 2-keys-per-user quota.
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating IAM access key ${logicalId}`);

    const userName = properties['UserName'] as string | undefined;
    if (!userName) {
      throw new ProvisioningError(
        `AccessKey ${logicalId} requires UserName`,
        resourceType,
        logicalId
      );
    }
    const status = requireConfigString(
      properties['Status'],
      'Active',
      'AWS::IAM::AccessKey Status'
    );

    try {
      const response = await this.iamClient.send(
        new CreateAccessKeyCommand({ UserName: userName })
      );

      const accessKeyId = response.AccessKey?.AccessKeyId;
      const secretAccessKey = response.AccessKey?.SecretAccessKey;
      if (!accessKeyId || !secretAccessKey) {
        // A partial response with an AccessKeyId means a real key WAS minted —
        // clean it up best-effort before failing, or the retry / next deploy
        // hits the 2-keys-per-user quota with a key cdkd never recorded.
        if (accessKeyId) {
          try {
            await this.iamClient.send(
              new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up IAM access key ${logicalId} (${accessKeyId}) minted by a partial CreateAccessKey response: ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
            );
          }
        }
        throw new Error('CreateAccessKey returned no AccessKeyId/SecretAccessKey');
      }

      if (status === 'Inactive') {
        try {
          await this.iamClient.send(
            new UpdateAccessKeyCommand({
              UserName: userName,
              AccessKeyId: accessKeyId,
              Status: 'Inactive' as StatusType,
            })
          );
        } catch (innerError) {
          try {
            await this.iamClient.send(
              new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: accessKeyId })
            );
            this.logger.debug(
              `Cleaned up partially-created IAM access key ${logicalId} (${accessKeyId}) after status wiring failure`
            );
          } catch (cleanupError) {
            this.logger.warn(
              `Failed to clean up partially-created IAM access key ${logicalId} (${accessKeyId}): ${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}. Manual deletion may be required before the next deploy: aws iam delete-access-key --user-name ${userName} --access-key-id ${accessKeyId}`
            );
          }
          throw innerError;
        }
      }

      this.logger.debug(`Successfully created IAM access key ${logicalId}: ${accessKeyId}`);

      return {
        physicalId: accessKeyId,
        attributes: {
          // Create-time-only: CreateAccessKey is the ONLY source of the
          // secret. Cached here so `Fn::GetAtt [<key>, SecretAccessKey]`
          // resolves from state, like CloudFormation.
          SecretAccessKey: secretAccessKey,
          // Registry-schema read-only primaryIdentifier.
          Id: accessKeyId,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        undefined,
        cause
      );
    }
  }

  /**
   * Update an IAM access key.
   *
   * `UserName` / `Serial` are createOnly (replacement — this method never
   * sees them change), so the only in-place change is `Status`. A template
   * that REMOVES `Status` resets to the CFn default `Active` (absent-field
   * removal semantics), so the desired status is always sent explicitly.
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    _previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating IAM access key ${logicalId}: ${physicalId}`);

    const userName = properties['UserName'] as string | undefined;
    // WARN, not throw: a rollback replays through `update()` with a historical
    // cdkd STATE record as the desired bag, so refusing here could leave a
    // resource un-rollbackable with no template-side remedy (issue #1513).
    const status = requireConfigString(
      properties['Status'],
      'Active',
      'AWS::IAM::AccessKey Status',
      {
        onUnusable: (message) => this.logger.warn(message),
      }
    ) as StatusType;

    try {
      await this.iamClient.send(
        new UpdateAccessKeyCommand({
          UserName: userName,
          AccessKeyId: physicalId,
          Status: status,
        })
      );

      this.logger.debug(`Successfully updated IAM access key ${logicalId}`);

      // No `attributes`: the create-time SecretAccessKey cached in state must
      // survive (a partial attribute set would replace, not merge).
      return {
        physicalId,
        wasReplaced: false,
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an IAM access key via `DeleteAccessKey`.
   *
   * `UserName` comes from the state-recorded properties; when absent (e.g. a
   * hand-edited state record), it is recovered via `GetAccessKeyLastUsed`,
   * which resolves the owning user from the key id alone.
   * `NoSuchEntityException` is treated as idempotent success (after the
   * shared region check).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting IAM access key ${logicalId}: ${physicalId}`);

    try {
      let userName = properties?.['UserName'] as string | undefined;
      if (!userName) {
        const lastUsed = await this.iamClient.send(
          new GetAccessKeyLastUsedCommand({ AccessKeyId: physicalId })
        );
        userName = lastUsed.UserName;
      }
      if (!userName) {
        // Never send DeleteAccessKey without UserName — IAM would resolve it
        // against the CALLING identity's own keys, not this resource.
        throw new Error(`cannot resolve the owning user for access key ${physicalId}`);
      }

      await this.iamClient.send(
        new DeleteAccessKeyCommand({ UserName: userName, AccessKeyId: physicalId })
      );

      this.logger.debug(`Successfully deleted IAM access key ${logicalId}`);
    } catch (error) {
      if (error instanceof NoSuchEntityException) {
        const clientRegion = await this.iamClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Access key ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete IAM access key ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Resolve a `Fn::GetAtt` attribute.
   *
   * `Id` is the physical id. `SecretAccessKey` can NEVER be re-fetched from
   * AWS (create-time-only) — deploy-time resolution reads it from the cached
   * state attributes and never reaches this method; a live fetch (e.g.
   * `cdkd orphan` reference rewriting on a state record missing the cached
   * value) fails with an explicit error instead of a silent wrong answer.
   */
  // eslint-disable-next-line @typescript-eslint/require-await -- Id is local; SecretAccessKey is unreadable by design
  async getAttribute(
    physicalId: string,
    resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    if (attributeName === 'Id') return physicalId;
    if (attributeName === 'SecretAccessKey') {
      throw new ProvisioningError(
        `SecretAccessKey for ${physicalId} cannot be read back from AWS — IAM returns it only from CreateAccessKey. ` +
          `cdkd resolves it from the attributes cached in state at create time; this record has no cached value.`,
        resourceType,
        physicalId
      );
    }
    throw new ProvisioningError(
      `Unknown attribute ${attributeName} for ${resourceType} (only 'Id' and 'SecretAccessKey' are defined)`,
      resourceType,
      physicalId
    );
  }

  /**
   * Read the AWS-current access key configuration in CFn-property shape.
   *
   * Resolves the owning user via `GetAccessKeyLastUsed(AccessKeyId)`, then
   * finds the key's `Status` in `ListAccessKeys(UserName)`. Returns
   * `undefined` when the key is gone.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let userName: string | undefined;
    try {
      const lastUsed = await this.iamClient.send(
        new GetAccessKeyLastUsedCommand({ AccessKeyId: physicalId })
      );
      userName = lastUsed.UserName;
    } catch (err) {
      if (err instanceof NoSuchEntityException) return undefined;
      throw err;
    }
    if (!userName) return undefined;

    let marker: string | undefined;
    do {
      let page;
      try {
        page = await this.iamClient.send(
          new ListAccessKeysCommand({ UserName: userName, ...(marker && { Marker: marker }) })
        );
      } catch (err) {
        if (err instanceof NoSuchEntityException) return undefined;
        throw err;
      }
      for (const key of page.AccessKeyMetadata ?? []) {
        if (key.AccessKeyId === physicalId) {
          const result: Record<string, unknown> = { UserName: userName };
          if (key.Status !== undefined) result['Status'] = key.Status;
          return result;
        }
      }
      marker = page.IsTruncated ? page.Marker : undefined;
    } while (marker);
    return undefined;
  }

  /**
   * `Serial` has no read API (it is a template-side replacement trigger, never
   * stored by IAM), so it can never be verified against AWS.
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    if (resourceType === 'AWS::IAM::AccessKey') return ['Serial'];
    return [];
  }

  /**
   * Adopt an existing IAM access key into cdkd state.
   *
   * **Explicit override only** (`--resource <logicalId>=<AccessKeyId>`): the
   * template carries no property equal to the key id, and IAM access keys
   * support no tags. The override is verified via `GetAccessKeyLastUsed`.
   *
   * The imported record has NO cached `SecretAccessKey` (IAM never returns it
   * again), so `Fn::GetAtt [<key>, SecretAccessKey]` cannot resolve for an
   * imported key — mint a new key via replacement if the secret is needed.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    if (!input.knownPhysicalId) return null;
    try {
      await this.iamClient.send(
        new GetAccessKeyLastUsedCommand({ AccessKeyId: input.knownPhysicalId })
      );
      return {
        physicalId: input.knownPhysicalId,
        attributes: { Id: input.knownPhysicalId },
      };
    } catch (err) {
      if (err instanceof NoSuchEntityException) return null;
      throw err;
    }
  }
}
