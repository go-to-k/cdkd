import {
  GlueClient,
  CreateSecurityConfigurationCommand,
  DeleteSecurityConfigurationCommand,
  GetSecurityConfigurationCommand,
  EntityNotFoundException,
} from '@aws-sdk/client-glue';
import {
  ProvisioningError,
  ResourceUpdateNotSupportedError,
} from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import type { MaskerFn } from '../../masked-retry-logger.js';
import {
  type CreateContext,
  type ResourceCreateResult,
  type ResourceUpdateResult,
  type ResourceImportInput,
  type ResourceImportResult,
  type UpdateContext,
  type ResourceNotFound,
  RESOURCE_NOT_FOUND,
} from '../../../types/resource.js';
import { markNotGone } from '../../not-gone.js';
import type { GlueSecurityConfigurationProvider } from '../glue-provider.js';
import { wrapGlueError, newGlueClients, glueOperationSinks, secretNamePairs } from './names.js';
import { buildEncryptionConfiguration, mapEncryptionConfigurationToCfn } from './shared.js';

/** {@link GlueProvider}'s `wrapMaskedError` (issue #4244). */
export function securityConfigurationWrapMaskedError(
  this: GlueSecurityConfigurationProvider,
  mask: MaskerFn,
  error: unknown,
  build: (maskedText: string) => ProvisioningError
): ProvisioningError {
  return wrapGlueError(mask, (message) => this.logger.debug(message), error, build);
}

export function securityConfigurationGetClient(
  this: GlueSecurityConfigurationProvider
): GlueClient {
  if (!this.client) {
    ({ client: this.client, createClient: this.createClient } = newGlueClients(
      this.providerRegion
    ));
  }
  return this.client;
}

/** The main create's client (issue #4639); see {@link newGlueClients}. */
export function securityConfigurationGetCreateClient(
  this: GlueSecurityConfigurationProvider
): GlueClient {
  this.getClient();
  return this.createClient as GlueClient;
}

export async function securityConfigurationCreate(
  this: GlueSecurityConfigurationProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2177: ONE masked sink per operation, every bag value masked RAW.
  const log = glueOperationSinks(
    this.logger,
    context?.maskSecrets,
    secretNamePairs([properties['Name']])
  );
  const { value: v } = log;
  log.debug(`Creating Glue SecurityConfiguration ${logicalId}`);

  const name = properties['Name'] as string | undefined;
  if (!name) {
    throw new ProvisioningError(
      `Name is required for Glue SecurityConfiguration ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  const encryptionConfiguration = properties['EncryptionConfiguration'] as
    | Record<string, unknown>
    | undefined;
  if (!encryptionConfiguration) {
    throw new ProvisioningError(
      `EncryptionConfiguration is required for Glue SecurityConfiguration ${logicalId}`,
      resourceType,
      logicalId
    );
  }

  try {
    await this.getCreateClient().send(
      new CreateSecurityConfigurationCommand({
        Name: name,
        EncryptionConfiguration: buildEncryptionConfiguration(encryptionConfiguration),
      })
    );

    log.debug(`Successfully created Glue SecurityConfiguration ${logicalId}: ${v(name)}`);
    return { physicalId: name, attributes: {} };
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      log.mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Glue SecurityConfiguration ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }
}

export async function securityConfigurationUpdate(
  this: GlueSecurityConfigurationProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties: Record<string, unknown>,
  _previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // go-to-k/cdkd#2613: this update sends nothing, but the refusal below is a
  // `ResourceUpdateNotSupportedError`, which `update-in-place.ts` turns into a
  // DELETE + CREATE under `--replace`. The physical id is the configuration
  // NAME, so with a client in another region than the state record that
  // replacement would act on a same-named configuration cdkd does not manage.
  // Refused first, so the error names the region rather than steering toward
  // a replacement. The client's region is resolved only when there is one to
  // compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-update'
  );
  // SecurityConfiguration is immutable per AWS — no `UpdateSecurity*`
  // command exists. `cdkd drift --revert` and replacement-detection
  // both end up here; the latter expects the CREATE→DELETE replacement
  // layer to handle it. Surface the error so revert reports a clean
  // "could not revert" outcome instead of silently succeeding.
  throw new ResourceUpdateNotSupportedError(
    resourceType,
    logicalId,
    'AWS Glue SecurityConfiguration is immutable on AWS — there is no UpdateSecurityConfiguration API; every change requires DeleteSecurityConfiguration + CreateSecurityConfiguration. Use cdkd deploy --replace, or destroy + redeploy with the new EncryptionConfiguration.'
  );
}

export async function securityConfigurationDelete(
  this: GlueSecurityConfigurationProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Glue SecurityConfiguration ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
  // region than the state record would delete a same-named
  // security configuration cdkd does not manage. Refuse before any call,
  // not only on NotFound; the client's region is resolved only when there
  // is one to compare with.
  assertRegionMatch(
    context?.expectedRegion ? await this.getClient().config.region() : undefined,
    context?.expectedRegion,
    resourceType,
    logicalId,
    physicalId,
    'pre-delete'
  );

  try {
    await this.getClient().send(new DeleteSecurityConfigurationCommand({ Name: physicalId }));
    this.logger.debug(`Successfully deleted Glue SecurityConfiguration ${logicalId}`);
  } catch (error) {
    if (error instanceof EntityNotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(
        `Glue SecurityConfiguration ${physicalId} does not exist, skipping deletion`
      );
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const thrown = this.wrapMaskedError(
      context?.maskSecrets ?? ((text: string) => text),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Glue SecurityConfiguration ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
    throw error instanceof Error && error.name.includes('NotFound') ? markNotGone(thrown) : thrown;
  }
}

// eslint-disable-next-line @typescript-eslint/require-await -- explicit-override-only intentionally has no AWS calls
export async function securityConfigurationGetAttribute(
  this: GlueSecurityConfigurationProvider,
  physicalId: string,
  _resourceType: string,
  attributeName: string
): Promise<unknown> {
  if (attributeName === 'Id' || attributeName === 'Ref' || attributeName === 'Name') {
    return physicalId;
  }
  return undefined;
}

/**
 * Read AWS-current SecurityConfiguration shape via
 * `GetSecurityConfiguration`. Always emits the three CFn-modeled
 * sub-configs (`S3Encryptions: []`, `CloudWatchEncryption: {}`,
 * `JobBookmarksEncryption: {}`) per PR #145 even when AWS reports
 * nothing — closes the "console-side encryption enable on a previously
 * default config" detection gap on the v3 baseline.
 *
 * `DataQualityEncryption` is silently dropped: the CFn schema for
 * `AWS::Glue::SecurityConfiguration` does not model it, so surfacing it
 * would fire false drift on every clean run for a key cdkd state can
 * never carry.
 */
export async function securityConfigurationReadCurrentState(
  this: GlueSecurityConfigurationProvider,
  physicalId: string,
  _logicalId: string,
  _resourceType: string
): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
  let cfg;
  try {
    const resp = await this.getClient().send(
      new GetSecurityConfigurationCommand({ Name: physicalId })
    );
    cfg = resp.SecurityConfiguration;
  } catch (err) {
    if (err instanceof EntityNotFoundException) return RESOURCE_NOT_FOUND;
    throw err;
  }
  if (!cfg) return undefined;

  return {
    Name: cfg.Name ?? physicalId,
    EncryptionConfiguration: mapEncryptionConfigurationToCfn(cfg.EncryptionConfiguration),
  };
}

export async function securityConfigurationImport(
  this: GlueSecurityConfigurationProvider,
  input: ResourceImportInput
): Promise<ResourceImportResult | null> {
  const explicitName = input.knownPhysicalId ?? (input.properties['Name'] as string | undefined);

  if (explicitName) {
    try {
      await this.getClient().send(new GetSecurityConfigurationCommand({ Name: explicitName }));
      return { physicalId: explicitName, attributes: {} };
    } catch (err) {
      if (err instanceof EntityNotFoundException) return null;
      throw err;
    }
  }

  // Nothing left to look up. SecurityConfiguration is not taggable at all
  // (the type has no ARN to hand to `GetTags`), so it never had even the
  // now-removed `aws:cdk:path` walk to fall back on — and without an
  // explicit name there is no other key to match a candidate against.
  // Import users must pass `--resource <logicalId>=<name>` for this type.
  //
  // This previously paginated all of `GetSecurityConfigurations` into a
  // loop whose body was an explicit no-op, burning a full listing on every
  // call to reach the same `null` (issue #1134).
  return null;
}
