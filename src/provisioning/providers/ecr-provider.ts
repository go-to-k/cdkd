import {
  ECRClient,
  CreateRepositoryCommand,
  DeleteLifecyclePolicyCommand,
  DeleteRepositoryCommand,
  DeleteRepositoryPolicyCommand,
  DescribeRepositoriesCommand,
  GetLifecyclePolicyCommand,
  PutLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  TagResourceCommand,
  UntagResourceCommand,
  ListTagsForResourceCommand,
  LifecyclePolicyNotFoundException,
  RepositoryNotFoundException,
  type ImageScanningConfiguration,
  type EncryptionConfiguration,
  type ImageTagMutability,
  type Tag,
} from '@aws-sdk/client-ecr';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import { importTagWalk } from '../import-tag-walk.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
} from '../../types/resource.js';

/**
 * AWS ECR Repository Provider
 *
 * Implements resource provisioning for AWS::ECR::Repository using the ECR SDK.
 * WHY: The CC API cannot force-delete repositories that contain images.
 * This SDK provider uses DeleteRepositoryCommand with `force: true` to delete
 * repositories along with all their images, supporting CDK's `emptyOnDelete: true`.
 */
export class ECRProvider implements ResourceProvider {
  private client?: ECRClient;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('ECRProvider');
  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::ECR::Repository',
      new Set([
        'RepositoryName',
        'ImageScanningConfiguration',
        'ImageTagMutability',
        'EncryptionConfiguration',
        'LifecyclePolicy',
        'RepositoryPolicyText',
        'Tags',
        'EmptyOnDelete',
        'ImageTagMutabilityExclusionFilters',
      ]),
    ],
  ]);

  private getClient(): ECRClient {
    if (!this.client) {
      this.client = new ECRClient(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.client;
  }

  /**
   * Map CFn `ImageScanningConfiguration` (PascalCase `{ ScanOnPush }`) to the
   * SDK shape (camelCase `{ scanOnPush }`). The SDK input keys are camelCase;
   * forwarding the CFn-cased object verbatim makes the SDK ignore the unknown
   * `ScanOnPush` key and silently default `scanOnPush` to `false` — so
   * `imageScanOnPush: true` never reached AWS. Returns `undefined` for an
   * absent config so the caller can omit the field.
   */
  private toSdkScanningConfig(
    cfn: Record<string, unknown> | undefined
  ): ImageScanningConfiguration | undefined {
    if (!cfn) return undefined;
    return { scanOnPush: Boolean(cfn['ScanOnPush']) };
  }

  /**
   * Map CFn `EncryptionConfiguration` (PascalCase `{ EncryptionType, KmsKey }`)
   * to the SDK shape (camelCase `{ encryptionType, kmsKey }`). Same casing trap
   * as scanning config — a KMS repo's `KmsKey` would be silently dropped (and
   * the type would fall back to AES256) without this mapping.
   */
  private toSdkEncryptionConfig(
    cfn: Record<string, unknown> | undefined
  ): EncryptionConfiguration | undefined {
    if (!cfn) return undefined;
    const encryptionType = cfn['EncryptionType'] as string | undefined;
    if (!encryptionType) return undefined;
    const out: EncryptionConfiguration = {
      encryptionType: encryptionType as EncryptionConfiguration['encryptionType'],
    };
    if (encryptionType === 'KMS' && cfn['KmsKey']) {
      out.kmsKey = cfn['KmsKey'] as string;
    }
    return out;
  }

  /**
   * Create an ECR Repository
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECR Repository ${logicalId}`);

    const repositoryName =
      (properties['RepositoryName'] as string | undefined) ||
      generateResourceName(logicalId, { maxLength: 256 }).toLowerCase();

    try {
      // Convert CFn Tags format to SDK tags format
      const tags = properties['Tags'] as Tag[] | undefined;

      const scanningConfig = this.toSdkScanningConfig(
        properties['ImageScanningConfiguration'] as Record<string, unknown> | undefined
      );
      const encryptionConfig = this.toSdkEncryptionConfig(
        properties['EncryptionConfiguration'] as Record<string, unknown> | undefined
      );

      const response = await this.getClient().send(
        new CreateRepositoryCommand({
          repositoryName,
          ...(scanningConfig ? { imageScanningConfiguration: scanningConfig } : {}),
          ...(properties['ImageTagMutability']
            ? {
                imageTagMutability: properties['ImageTagMutability'] as ImageTagMutability,
              }
            : {}),
          ...(encryptionConfig ? { encryptionConfiguration: encryptionConfig } : {}),
          ...(tags ? { tags } : {}),
        })
      );

      const repo = response.repository;
      if (!repo?.repositoryName) {
        throw new Error('CreateRepository did not return repository name');
      }

      const arn = repo.repositoryArn ?? '';
      const repositoryUri = repo.repositoryUri ?? '';

      // Apply lifecycle policy (separate API call)
      const lifecyclePolicy = properties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      if (lifecyclePolicy?.LifecyclePolicyText) {
        await this.getClient().send(
          new PutLifecyclePolicyCommand({
            repositoryName: repo.repositoryName,
            lifecyclePolicyText: lifecyclePolicy.LifecyclePolicyText,
          })
        );
        this.logger.debug(`Applied lifecycle policy to ${repo.repositoryName}`);
      }

      // Apply repository policy (separate API call)
      const repositoryPolicyText = properties['RepositoryPolicyText'];
      if (repositoryPolicyText) {
        const policyText =
          typeof repositoryPolicyText === 'string'
            ? repositoryPolicyText
            : JSON.stringify(repositoryPolicyText);
        await this.getClient().send(
          new SetRepositoryPolicyCommand({
            repositoryName: repo.repositoryName,
            policyText,
          })
        );
        this.logger.debug(`Applied repository policy to ${repo.repositoryName}`);
      }

      this.logger.debug(`Successfully created ECR Repository ${logicalId}: ${repo.repositoryName}`);

      return {
        physicalId: repo.repositoryName,
        attributes: {
          Arn: arn,
          RepositoryUri: repositoryUri,
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to create ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        repositoryName,
        cause
      );
    }
  }

  /**
   * Update an ECR Repository
   *
   * Mutable properties: ImageScanningConfiguration, ImageTagMutability,
   * LifecyclePolicy, RepositoryPolicyText, Tags.
   * Immutable: RepositoryName, EncryptionConfiguration (require replacement).
   */
  async update(
    logicalId: string,
    physicalId: string,
    _resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECR Repository ${logicalId} (${physicalId})`);

    try {
      // Update ImageScanningConfiguration if changed. CFn properties are
      // PascalCase (`{ ScanOnPush }`); map to the SDK's camelCase
      // (`{ scanOnPush }`) — forwarding the CFn-cased object verbatim would
      // make the SDK ignore `ScanOnPush` and reset scanOnPush to false.
      const newScanConfig = properties['ImageScanningConfiguration'] as
        | Record<string, unknown>
        | undefined;
      const oldScanConfig = previousProperties['ImageScanningConfiguration'] as
        | Record<string, unknown>
        | undefined;
      if (JSON.stringify(newScanConfig) !== JSON.stringify(oldScanConfig)) {
        await this.getClient().send(
          new PutImageScanningConfigurationCommand({
            repositoryName: physicalId,
            imageScanningConfiguration: this.toSdkScanningConfig(newScanConfig) ?? {
              scanOnPush: false,
            },
          })
        );
        this.logger.debug(`Updated image scanning configuration for ${physicalId}`);
      }

      // Update ImageTagMutability if changed
      const newMutability = properties['ImageTagMutability'] as ImageTagMutability | undefined;
      const oldMutability = previousProperties['ImageTagMutability'] as
        | ImageTagMutability
        | undefined;
      if (newMutability !== oldMutability) {
        await this.getClient().send(
          new PutImageTagMutabilityCommand({
            repositoryName: physicalId,
            imageTagMutability: newMutability ?? 'MUTABLE',
          })
        );
        this.logger.debug(`Updated image tag mutability for ${physicalId}`);
      }

      // Update LifecyclePolicy if changed.
      //
      // The truthy gate `newLifecycle?.LifecyclePolicyText` covers both
      // (a) the no-policy state (`undefined`) and (b) the placeholder
      // shape `{}`/`{ LifecyclePolicyText: '' }`. When the diff is
      // "old=Set / new=Cleared", we explicitly issue
      // `DeleteLifecyclePolicy` instead of silently dropping the change
      // — otherwise `cdkd drift --revert` reports `✓ reverted` while AWS
      // still has the old policy attached.
      const newLifecycle = properties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      const oldLifecycle = previousProperties['LifecyclePolicy'] as
        | { LifecyclePolicyText?: string }
        | undefined;
      if (JSON.stringify(newLifecycle) !== JSON.stringify(oldLifecycle)) {
        if (newLifecycle?.LifecyclePolicyText) {
          await this.getClient().send(
            new PutLifecyclePolicyCommand({
              repositoryName: physicalId,
              lifecyclePolicyText: newLifecycle.LifecyclePolicyText,
            })
          );
          this.logger.debug(`Updated lifecycle policy for ${physicalId}`);
        } else if (oldLifecycle?.LifecyclePolicyText) {
          try {
            await this.getClient().send(
              new DeleteLifecyclePolicyCommand({ repositoryName: physicalId })
            );
            this.logger.debug(`Deleted lifecycle policy for ${physicalId}`);
          } catch (err) {
            if (!(err instanceof LifecyclePolicyNotFoundException)) throw err;
          }
        }
      }

      // Update RepositoryPolicyText if changed. `!== undefined` (not
      // truthy) so a deliberate clear (`null` / `''`) reaches the delete
      // path instead of silently no-oping.
      const newPolicy = properties['RepositoryPolicyText'];
      const oldPolicy = previousProperties['RepositoryPolicyText'];
      if (JSON.stringify(newPolicy) !== JSON.stringify(oldPolicy)) {
        if (newPolicy !== undefined && newPolicy !== null && newPolicy !== '') {
          const policyText = typeof newPolicy === 'string' ? newPolicy : JSON.stringify(newPolicy);
          await this.getClient().send(
            new SetRepositoryPolicyCommand({
              repositoryName: physicalId,
              policyText,
            })
          );
          this.logger.debug(`Updated repository policy for ${physicalId}`);
        } else if (oldPolicy !== undefined && oldPolicy !== null && oldPolicy !== '') {
          try {
            await this.getClient().send(
              new DeleteRepositoryPolicyCommand({ repositoryName: physicalId })
            );
            this.logger.debug(`Deleted repository policy for ${physicalId}`);
          } catch (err) {
            // If the policy is already gone, this is idempotent.
            const code =
              (err as { name?: string } | undefined)?.name ??
              (err as { __type?: string } | undefined)?.__type ??
              '';
            if (!code.includes('RepositoryPolicyNotFound')) throw err;
          }
        }
      }

      // Update Tags if changed. `TagResource` is additive-only, so a tag
      // dropped from the template (partial removal) — or the entire `Tags`
      // property removed (full removal, `newTags === undefined`) — would
      // survive on AWS unless we explicitly `UntagResource` the removed keys.
      const newTags = properties['Tags'] as Tag[] | undefined;
      const oldTags = previousProperties['Tags'] as Tag[] | undefined;
      if (JSON.stringify(newTags) !== JSON.stringify(oldTags)) {
        // Get repository ARN for tagging
        const describeResponse = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
        );
        const repoArn = describeResponse.repositories?.[0]?.repositoryArn;
        if (repoArn) {
          // Untag keys present in the old set but absent from the new set.
          // `newTags === undefined` is treated as "remove all old tags".
          const newKeys = new Set(
            (newTags ?? []).map((t) => t.Key).filter((k): k is string => !!k)
          );
          const removedKeys = (oldTags ?? [])
            .map((t) => t.Key)
            .filter((k): k is string => !!k && !newKeys.has(k));
          if (removedKeys.length > 0) {
            await this.getClient().send(
              new UntagResourceCommand({
                resourceArn: repoArn,
                tagKeys: removedKeys,
              })
            );
          }
          // Apply added / changed tags. Skip the call when the new set is
          // empty (a pure removal has nothing left to add).
          if (newTags && newTags.length > 0) {
            await this.getClient().send(
              new TagResourceCommand({
                resourceArn: repoArn,
                tags: newTags,
              })
            );
          }
          this.logger.debug(`Updated tags for ${physicalId}`);
        }
      }

      // Get current attributes
      const response = await this.getClient().send(
        new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
      );
      const repo = response.repositories?.[0];

      return {
        physicalId,
        wasReplaced: false,
        attributes: {
          Arn: repo?.repositoryArn ?? '',
          RepositoryUri: repo?.repositoryUri ?? '',
        },
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        _resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Delete an ECR Repository
   *
   * Uses `force: true` to delete the repository even if it contains images.
   * This supports CDK's `emptyOnDelete: true` / `removalPolicy: DESTROY` pattern.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting ECR Repository ${logicalId}: ${physicalId}`);

    try {
      await this.getClient().send(
        new DeleteRepositoryCommand({
          repositoryName: physicalId,
          force: true,
        })
      );
      this.logger.debug(`Successfully deleted ECR Repository ${logicalId}`);
    } catch (error) {
      if (error instanceof RepositoryNotFoundException) {
        const clientRegion = await this.getClient().config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`ECR Repository ${physicalId} does not exist, skipping deletion`);
        return;
      }
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to delete ECR Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the AWS-current ECR repository configuration in CFn-property shape.
   *
   * Issues `DescribeRepositories(filtered=[name])` for the repository's
   * configuration, then a separate `GetLifecyclePolicy` for `LifecyclePolicy`
   * (which `DescribeRepositories` doesn't return).
   *
   * Surfaced keys: `RepositoryName`, `ImageTagMutability`,
   * `ImageScanningConfiguration`, `EncryptionConfiguration`, `LifecyclePolicy`
   * (when configured — `LifecyclePolicyNotFoundException` is caught and the
   * key omitted, NOT propagated as repo-gone).
   *
   * Intentionally omitted:
   *   - `RepositoryPolicyText`: requires a separate `GetRepositoryPolicy`
   *     round-trip; cdkd state holds the policy as either a string or an
   *     object (depending on user input), and the comparator round-trip
   *     is not yet handled here.
   *   - `EmptyOnDelete` / `ImageTagMutabilityExclusionFilters`: not part
   *     of the persisted AWS state visible via standard Describe.
   *
   * `Tags` is surfaced via a follow-up `ListTagsForResource(arn)` call
   * (using the repository ARN that `DescribeRepositories` returns). CDK's
   * `aws:*` auto-tags are filtered out; the result key is omitted entirely
   * when AWS reports no user tags.
   *
   * Returns `undefined` when the repository is gone (`RepositoryNotFoundException`).
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let repo: {
      repositories?: Array<{
        repositoryName?: string;
        repositoryArn?: string;
        imageTagMutability?: string;
        imageScanningConfiguration?: { scanOnPush?: boolean };
        encryptionConfiguration?: { encryptionType?: string; kmsKey?: string };
      }>;
    };
    try {
      repo = (await this.getClient().send(
        new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
      )) as unknown as typeof repo;
    } catch (err) {
      if (err instanceof RepositoryNotFoundException) return undefined;
      throw err;
    }
    const r = repo.repositories?.[0];
    if (!r) return undefined;

    const result: Record<string, unknown> = {};
    if (r.repositoryName !== undefined) result['RepositoryName'] = r.repositoryName;
    if (r.imageTagMutability !== undefined) result['ImageTagMutability'] = r.imageTagMutability;
    result['ImageScanningConfiguration'] = {
      ScanOnPush: r.imageScanningConfiguration?.scanOnPush ?? false,
    };
    {
      // Class 1 guard — `KmsKey` is only valid on `EncryptionType=KMS`.
      // AWS rejects `KmsKey` (including the empty string) on AES256
      // repositories, and `EncryptionConfiguration` is immutable so the
      // round-trip path doesn't actually re-submit it; even so, we don't
      // want to leak `KmsKey: ''` into observedProperties because the
      // drift comparator would surface a false positive against any
      // template that omits the field.
      const encType = r.encryptionConfiguration?.encryptionType ?? 'AES256';
      const enc: Record<string, unknown> = { EncryptionType: encType };
      if (encType === 'KMS' && r.encryptionConfiguration?.kmsKey) {
        enc['KmsKey'] = r.encryptionConfiguration.kmsKey;
      }
      result['EncryptionConfiguration'] = enc;
    }

    // LifecyclePolicy: separate API call. "Not configured" omits the key;
    // do NOT treat as repo-gone.
    try {
      const lp = await this.getClient().send(
        new GetLifecyclePolicyCommand({ repositoryName: physicalId })
      );
      if (lp.lifecyclePolicyText) {
        result['LifecyclePolicy'] = { LifecyclePolicyText: lp.lifecyclePolicyText };
      }
    } catch (err) {
      if (!(err instanceof LifecyclePolicyNotFoundException)) {
        throw err;
      }
    }

    // Tags via ListTagsForResource (uses the repository ARN from
    // DescribeRepositories).
    if (r.repositoryArn) {
      try {
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: r.repositoryArn })
        );
        const tags = normalizeAwsTagsToCfn(tagsResp.tags);
        result['Tags'] = tags;
      } catch (err) {
        if (!(err instanceof RepositoryNotFoundException)) throw err;
      }
    }

    return result;
  }

  /**
   * Adopt an existing ECR repository into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RepositoryName` → verify via
   *     `DescribeRepositories`.
   *  2. `DescribeRepositories` paginated, then `ListTagsForResource(arn)`
   *     per repository to match `aws:cdk:path` (`Tag[]` array shape).
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RepositoryName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [explicit] })
        );
        return resp.repositories?.[0]?.repositoryName
          ? { physicalId: explicit, attributes: {} }
          : null;
      } catch (err) {
        if (err instanceof RepositoryNotFoundException) return null;
        throw err;
      }
    }

    // Tag-based fallback via the shared throttle-tolerant walk: the N+1
    // ListTagsForResource burst is retried with exponential backoff when AWS
    // throttles it instead of aborting the whole import.
    const match = await importTagWalk({
      cdkPath: input.cdkPath,
      logicalId: input.logicalId,
      listPage: async (marker) => {
        const list = await this.getClient().send(
          new DescribeRepositoriesCommand({ ...(marker && { nextToken: marker }) })
        );
        return { items: list.repositories, nextMarker: list.nextToken };
      },
      describe: async (repo) => {
        if (!repo.repositoryArn || !repo.repositoryName) return undefined;
        try {
          return await this.getClient().send(
            new ListTagsForResourceCommand({ resourceArn: repo.repositoryArn })
          );
        } catch (err) {
          // Deleted between the list and the tag read — skip the candidate.
          if (err instanceof RepositoryNotFoundException) return undefined;
          throw err;
        }
      },
      tagsOf: (tagsResp) => tagsResp.tags,
    });
    if (!match) return null;
    // Non-null by construction: `describe` skips summaries without a name.
    return { physicalId: match.summary.repositoryName!, attributes: {} };
  }
}
