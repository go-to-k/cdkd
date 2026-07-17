import {
  CodeCommitClient,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  GetRepositoryCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateRepositoryDescriptionCommand,
  UpdateRepositoryEncryptionKeyCommand,
  UpdateRepositoryNameCommand,
  RepositoryDoesNotExistException,
  type RepositoryMetadata,
} from '@aws-sdk/client-codecommit';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { CDK_PATH_TAG, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * CFn `Tags` entry shape (`[{Key, Value}]`). CodeCommit's SDK tag APIs use a
 * flat `Record<string, string>` map instead, so the provider converts on
 * every write.
 */
interface CfnTag {
  Key?: unknown;
  Value?: unknown;
}

/**
 * Convert the CFn `Tags` list shape to CodeCommit's `Record<string, string>`
 * map. Entries without a string `Key` are skipped; non-string values are
 * stringified (post-intrinsic-resolution values can be numbers/booleans).
 * Returns `undefined` for an absent/empty list so callers can omit the field.
 */
function toSdkTagMap(tags: CfnTag[] | undefined): Record<string, string> | undefined {
  if (!tags || tags.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const tag of tags) {
    if (typeof tag?.Key !== 'string' || tag.Key.length === 0) continue;
    const value = tag.Value;
    out[tag.Key] =
      typeof value === 'string'
        ? value
        : typeof value === 'number' || typeof value === 'boolean'
          ? String(value)
          : '';
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * AWS CodeCommit Repository Provider
 *
 * Implements resource provisioning for AWS::CodeCommit::Repository using the
 * CodeCommit SDK. The type is `ProvisioningType: NON_PROVISIONABLE`, so the
 * Cloud Control fallback cannot handle it — without this SDK provider cdkd's
 * pre-flight rejects the type outright (issue #1045). CodeCommit returned to
 * full General Availability on 2025-11-24, so the service is fully usable for
 * new sign-ups again.
 *
 * Physical id: the repository NAME (every CodeCommit API is name-based;
 * there is no lookup-by-id API). CloudFormation's `Ref` returns the
 * repository ID (a GUID), so `create()` stores `RepositoryId` in attributes
 * and the intrinsic resolver's `cfnRefValueFromPhysicalId` recovers it via
 * `stateLookup` for CFn `Ref` parity.
 */
export class CodeCommitRepositoryProvider implements ResourceProvider {
  private client?: CodeCommitClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CodeCommitRepositoryProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CodeCommit::Repository',
      new Set<string>(['RepositoryName', 'RepositoryDescription', 'KmsKeyId', 'Tags']),
    ],
  ]);

  unhandledByDesign = new Map<string, ReadonlyMap<string, string>>([
    [
      'AWS::CodeCommit::Repository',
      new Map<string, string>([
        [
          'Code',
          'CFn-only seed-content orchestration (S3 zip unpacked into an initial commit on a chosen branch); not wired in v1 — pre-flight rejects templates carrying it so nothing is silently dropped; a follow-up could implement it via CreateCommit/PutFile',
        ],
        [
          'Triggers',
          'repository trigger management not wired in v1 — pre-flight rejects templates carrying it so nothing is silently dropped; a follow-up could implement it via PutRepositoryTriggers',
        ],
      ]),
    ],
  ]);

  private getClient(): CodeCommitClient {
    if (!this.client) {
      this.client = new CodeCommitClient(
        this.providerRegion ? { region: this.providerRegion } : {}
      );
    }
    return this.client;
  }

  /**
   * Build the `Fn::GetAtt` attribute map from a `RepositoryMetadata`
   * response. `RepositoryId` is additionally stored so the intrinsic
   * resolver can recover CFn's `Ref` value (the repository ID) from state.
   */
  private toAttributes(metadata: RepositoryMetadata | undefined): Record<string, unknown> {
    return {
      Arn: metadata?.Arn ?? '',
      CloneUrlHttp: metadata?.cloneUrlHttp ?? '',
      CloneUrlSsh: metadata?.cloneUrlSsh ?? '',
      Name: metadata?.repositoryName ?? '',
      KmsKeyId: metadata?.kmsKeyId ?? '',
      RepositoryId: metadata?.repositoryId ?? '',
    };
  }

  /**
   * Create a CodeCommit Repository
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating CodeCommit Repository ${logicalId}`);

    // `RepositoryName` is required by the CFn schema, but generate a
    // defensive default for hand-written templates that omit it.
    // CodeCommit allows [A-Za-z0-9._-]{1,100}.
    const repositoryName =
      (properties['RepositoryName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 100 });

    try {
      const tags = toSdkTagMap(properties['Tags'] as CfnTag[] | undefined);
      const description = properties['RepositoryDescription'] as string | undefined;
      const kmsKeyId = properties['KmsKeyId'] as string | undefined;

      const response = await this.getClient().send(
        new CreateRepositoryCommand({
          repositoryName,
          ...(description !== undefined ? { repositoryDescription: description } : {}),
          ...(kmsKeyId !== undefined ? { kmsKeyId } : {}),
          ...(tags ? { tags } : {}),
        })
      );

      const metadata = response.repositoryMetadata;
      if (!metadata?.repositoryName) {
        throw new Error('CreateRepository did not return repository metadata');
      }

      this.logger.debug(
        `Successfully created CodeCommit Repository ${logicalId}: ${metadata.repositoryName}`
      );

      return {
        physicalId: metadata.repositoryName,
        attributes: this.toAttributes(metadata),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create CodeCommit Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        repositoryName,
        cause
      );
    }
  }

  /**
   * Update a CodeCommit Repository
   *
   * Mutable properties: RepositoryName (UpdateRepositoryName — CFn's docs
   * mark the property "Update requires: No interruption" and the registry
   * schema's createOnlyProperties is empty, so CFn parity is an IN-PLACE
   * rename that preserves the repository's git history; the repository ID —
   * CFn's `Ref` value — survives the rename), RepositoryDescription
   * (UpdateRepositoryDescription), KmsKeyId (UpdateRepositoryEncryptionKey),
   * Tags (TagResource / UntagResource — full tag removal handled explicitly,
   * see the ECR Tags regression class in issue #981).
   *
   * A rename returns the NEW repository name as `physicalId` with
   * `wasReplaced: false`; the deploy engine persists the returned physical
   * id into state unconditionally.
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CodeCommit Repository ${logicalId} (${physicalId})`);

    // Rename first so every subsequent call targets the current name.
    // `previousProperties.RepositoryName` is not consulted — the physical id
    // IS the deployed name (a template without an explicit name got a
    // generated one at create time that no longer matches the property).
    let currentName = physicalId;

    try {
      const newName = properties['RepositoryName'] as string | undefined;
      if (newName && newName !== physicalId) {
        await this.getClient().send(
          new UpdateRepositoryNameCommand({ oldName: physicalId, newName })
        );
        currentName = newName;
        this.logger.debug(`Renamed CodeCommit Repository ${physicalId} -> ${newName}`);
      }

      // Update RepositoryDescription if changed. An empty string clears the
      // description, matching CFn's behavior when the property is removed.
      const newDescription = properties['RepositoryDescription'] as string | undefined;
      const oldDescription = previousProperties['RepositoryDescription'] as string | undefined;
      if (newDescription !== oldDescription) {
        await this.getClient().send(
          new UpdateRepositoryDescriptionCommand({
            repositoryName: currentName,
            repositoryDescription: newDescription ?? '',
          })
        );
        this.logger.debug(`Updated description for ${currentName}`);
      }

      // Update KmsKeyId if changed. When the property is removed from the
      // template, CFn reverts the repository to the AWS-managed key
      // (`aws/codecommit`) — mirror that by passing the managed-key alias
      // (UpdateRepositoryEncryptionKey requires a kmsKeyId argument).
      const newKmsKeyId = properties['KmsKeyId'] as string | undefined;
      const oldKmsKeyId = previousProperties['KmsKeyId'] as string | undefined;
      if (newKmsKeyId !== oldKmsKeyId) {
        await this.getClient().send(
          new UpdateRepositoryEncryptionKeyCommand({
            repositoryName: currentName,
            kmsKeyId: newKmsKeyId ?? 'alias/aws/codecommit',
          })
        );
        this.logger.debug(`Updated encryption key for ${currentName}`);
      }

      // Update Tags if changed. `TagResource` is additive-only, so a tag
      // dropped from the template (partial removal) — or the entire `Tags`
      // property removed (full removal, `newTags === undefined`) — would
      // survive on AWS unless we explicitly `UntagResource` the removed keys.
      const newTags = properties['Tags'] as CfnTag[] | undefined;
      const oldTags = previousProperties['Tags'] as CfnTag[] | undefined;
      let metadata: RepositoryMetadata | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        metadata = await this.getRepositoryMetadata(currentName);
        const repoArn = metadata?.Arn;
        if (repoArn) {
          const newTagMap = toSdkTagMap(newTags) ?? {};
          const oldTagMap = toSdkTagMap(oldTags) ?? {};
          // Untag keys present in the old set but absent from the new set.
          // `newTags === undefined` is treated as "remove all old tags".
          const removedKeys = Object.keys(oldTagMap).filter((k) => !(k in newTagMap));
          if (removedKeys.length > 0) {
            await this.getClient().send(
              new UntagResourceCommand({ resourceArn: repoArn, tagKeys: removedKeys })
            );
          }
          // Apply added / changed tags. Skip the call when the new set is
          // empty (a pure removal has nothing left to add).
          if (Object.keys(newTagMap).length > 0) {
            await this.getClient().send(
              new TagResourceCommand({ resourceArn: repoArn, tags: newTagMap })
            );
          }
          this.logger.debug(`Updated tags for ${currentName}`);
        }
      }

      // Get current attributes (re-read so rename / description / key
      // updates above are reflected).
      metadata = await this.getRepositoryMetadata(currentName);

      return {
        physicalId: currentName,
        wasReplaced: false,
        attributes: this.toAttributes(metadata),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CodeCommit Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        _resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete a CodeCommit Repository
   *
   * `DeleteRepository` is idempotent on the AWS side, but a
   * `RepositoryDoesNotExistException` is still treated as idempotent success
   * (after the shared region check) for defense in depth.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CodeCommit Repository ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(new DeleteRepositoryCommand({ repositoryName: physicalId }));
      this.logger.debug(`Successfully deleted CodeCommit Repository ${logicalId}`);
    } catch (error) {
      if (error instanceof RepositoryDoesNotExistException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`CodeCommit Repository ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete CodeCommit Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Get repository attributes for Fn::GetAtt resolution.
   *
   * Supported: `Arn`, `CloneUrlHttp`, `CloneUrlSsh`, `Name`, `KmsKeyId`
   * (the CFn-documented attribute set).
   */
  async getAttribute(
    physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    switch (attributeName) {
      case 'Name':
        // Physical id IS the repository name — no API call needed.
        return physicalId;
      case 'Arn':
      case 'CloneUrlHttp':
      case 'CloneUrlSsh':
      case 'KmsKeyId': {
        const metadata = await this.getRepositoryMetadata(physicalId);
        return this.toAttributes(metadata)[attributeName];
      }
      default:
        return undefined;
    }
  }

  /**
   * Adopt an existing CodeCommit repository into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RepositoryName` → verify via
   *     `GetRepository`.
   *  2. `ListRepositories` paginated, then `ListTagsForResource(arn)` per
   *     repository to match `aws:cdk:path` (CodeCommit uses the
   *     `Record<string, string>` tag-map shape).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RepositoryName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new GetRepositoryCommand({ repositoryName: explicit })
        );
        return resp.repositoryMetadata?.repositoryName
          ? { physicalId: explicit, attributes: this.toAttributes(resp.repositoryMetadata) }
          : null;
      } catch (err) {
        if (err instanceof RepositoryDoesNotExistException) return null;
        throw err;
      }
    }

    if (!input.cdkPath) return null;

    let nextToken: string | undefined;
    do {
      const list = await this.getClient().send(
        new ListRepositoriesCommand({ ...(nextToken && { nextToken }) })
      );
      for (const repo of list.repositories ?? []) {
        if (!repo.repositoryName) continue;
        let metadata: RepositoryMetadata | undefined;
        try {
          metadata = await this.getRepositoryMetadata(repo.repositoryName);
        } catch (err) {
          if (err instanceof RepositoryDoesNotExistException) continue;
          throw err;
        }
        if (!metadata?.Arn) continue;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: metadata.Arn })
        );
        if (tagsResp.tags?.[CDK_PATH_TAG] === input.cdkPath) {
          return {
            physicalId: repo.repositoryName,
            attributes: this.toAttributes(metadata),
          };
        }
      }
      nextToken = list.nextToken;
    } while (nextToken);
    return null;
  }

  /**
   * Fetch the repository's metadata via `GetRepository`. Throws
   * `RepositoryDoesNotExistException` through to the caller.
   */
  private async getRepositoryMetadata(
    repositoryName: string
  ): Promise<RepositoryMetadata | undefined> {
    const resp = await this.getClient().send(new GetRepositoryCommand({ repositoryName }));
    return resp.repositoryMetadata;
  }
}
