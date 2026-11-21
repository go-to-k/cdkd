import {
  ECRClient,
  CreateRepositoryCommand,
  DeleteLifecyclePolicyCommand,
  DeleteRepositoryCommand,
  DeleteRepositoryPolicyCommand,
  DescribeRepositoriesCommand,
  PutLifecyclePolicyCommand,
  SetRepositoryPolicyCommand,
  PutImageScanningConfigurationCommand,
  PutImageTagMutabilityCommand,
  TagResourceCommand,
  UntagResourceCommand,
  LifecyclePolicyNotFoundException,
  RepositoryNotEmptyException,
  RepositoryNotFoundException,
  type ImageScanningConfiguration,
  type EncryptionConfiguration,
  type ImageTagMutability,
  type ImageTagMutabilityExclusionFilter,
  type Tag,
} from '@aws-sdk/client-ecr';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { identityTimestamp } from '../../deployment/recorded-identity-attributes.js';
import {
  assertRecordedIdentity,
  recordedIdentityId,
  RecordedIdentityError,
} from '../recorded-identity.js';
import { deniedIdentityReadRefusal } from '../identity-read-denied.js';
import { generatedNameFor } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import {
  ECR_AUTO_DELETE_IMAGES_TAG,
  hasCdkAutoDeleteTag,
  isTruthyCfnBoolean,
} from '../data-delete-intent.js';
import { resolveExplicitPhysicalId } from '../import-helpers.js';
import { planTagDiff, tagPlanWarning, refuseMalformedDesiredTags } from '../tag-list.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  CreateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
  ReadCurrentStateContext,
} from '../../types/resource.js';
import { RESOURCE_NOT_FOUND } from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { definedAttributes } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import {
  isAuxiliaryFailure,
  markAuxiliaryFailure,
  markCreatedBeforeFailure,
} from '../auxiliary-failure.js';
import { reportCreatedResource } from '../created-resource-sink.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { markNotGone } from '../not-gone.js';
import { maskerOrIdentity, type MaskerFn } from '../masked-retry-logger.js';
import { declaredMemberDocument, OWN_WRITE_REREAD_DELAYS_MS } from '../settle-after-own-write.js';
import { readCurrentState } from './ecr/read-state.js';

/**
 * AWS ECR Repository Provider
 *
 * Implements resource provisioning for AWS::ECR::Repository using the ECR SDK.
 * WHY: The CC API cannot force-delete repositories that contain images.
 * This SDK provider implements CDK's `emptyOnDelete: true` by passing
 * `force: true` to DeleteRepositoryCommand — gated on the user's opt-in
 * (`EmptyOnDelete: true`, the `aws-cdk:auto-delete-images` tag, or
 * `--force-stateful-recreation` on a replacement), never unconditionally
 * (issue #1340; CloudFormation parity for repositories without the opt-in).
 */
export class ECRProvider implements ResourceProvider {
  private client?: ECRClient;
  private createClient?: ECRClient;
  private readonly providerRegion = ambientRegion();
  readonly logger: ConsoleLogger = getLogger().child('ECRProvider');
  /** Re-read schedule of the post-write baseline capture; tests set it to zeros. */
  ownWriteRereadDelaysMs: readonly number[] = OWN_WRITE_REREAD_DELAYS_MS;
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

  getClient(): ECRClient {
    if (!this.client) {
      this.client = new ECRClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `CreateRepository` goes through (issue #4639): SDK retries on,
   * except a 5xx (`withoutServerErrorRetries`). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateRepository` carries no idempotency token, and a repository name is
   * unique per registry, so the SDK's own replay of a 5xx whose request ECR
   * completed fails `RepositoryAlreadyExistsException` against the repository
   * the first request made -- inside one `send`, where the deploy engine
   * cannot see it, so it credits the collision to another holder. Refused
   * here, the 5xx reaches the engine's retry, which marks a later collision as
   * possibly this create's own (`withRetry`, #3978).
   */
  private getCreateClient(): ECRClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new ECRClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
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
   * Map CFn `ImageTagMutabilityExclusionFilters`
   * (`[{ ImageTagMutabilityExclusionFilterType, ImageTagMutabilityExclusionFilterValue }]`)
   * to the SDK shape (`[{ filterType, filter }]`). The member NAMES diverge —
   * not just their casing — so forwarding the CFn-shaped array verbatim makes
   * the SDK drop every member and send `[{}]`, and AWS rejects the call (or,
   * worse, silently loses the exclusions). Returns `undefined` for an absent /
   * empty list so the caller can omit the field entirely.
   */
  private toSdkTagMutabilityExclusionFilters(
    cfn: unknown
  ): ImageTagMutabilityExclusionFilter[] | undefined {
    if (!Array.isArray(cfn) || cfn.length === 0) return undefined;
    return cfn.map((entry) => {
      const e = (entry ?? {}) as Record<string, unknown>;
      return {
        filterType: e['ImageTagMutabilityExclusionFilterType'] as
          | ImageTagMutabilityExclusionFilter['filterType']
          | undefined,
        filter: e['ImageTagMutabilityExclusionFilterValue'] as string | undefined,
      };
    });
  }

  /**
   * Create an ECR Repository
   */
  async create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    this.logger.debug(`Creating ECR Repository ${logicalId}`);
    // go-to-k/cdkd#3994: a malformed Tags is refused before any call.
    const desiredTags = refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId);

    const repositoryName =
      (properties['RepositoryName'] as string | undefined) ||
      generatedNameFor('AWS::ECR::Repository', logicalId);

    // Set once CreateRepository returns: a later failure is an auxiliary
    // call's, not this repository's name collision (#3826).
    let repositoryCreated = false;
    let createdAt: string | undefined;
    try {
      // CFn Tags and the SDK share the `[{ Key, Value }]` shape.
      const tags: Tag[] | undefined =
        properties['Tags'] !== undefined && properties['Tags'] !== null ? desiredTags : undefined;

      const scanningConfig = this.toSdkScanningConfig(
        properties['ImageScanningConfiguration'] as Record<string, unknown> | undefined
      );
      const encryptionConfig = this.toSdkEncryptionConfig(
        properties['EncryptionConfiguration'] as Record<string, unknown> | undefined
      );
      const exclusionFilters = this.toSdkTagMutabilityExclusionFilters(
        properties['ImageTagMutabilityExclusionFilters']
      );

      const response = await this.getCreateClient().send(
        new CreateRepositoryCommand({
          repositoryName,
          ...(scanningConfig ? { imageScanningConfiguration: scanningConfig } : {}),
          ...(properties['ImageTagMutability']
            ? {
                imageTagMutability: properties['ImageTagMutability'] as ImageTagMutability,
              }
            : {}),
          ...(exclusionFilters ? { imageTagMutabilityExclusionFilters: exclusionFilters } : {}),
          ...(encryptionConfig ? { encryptionConfiguration: encryptionConfig } : {}),
          ...(tags ? { tags } : {}),
        })
      );

      repositoryCreated = true;
      const repo = response.repository;
      // go-to-k/cdkd#6665: the `createdAt` a later delete compares (and the
      // failed-create journal's identity token), from the create's answer:
      // it equals what the delete's `DescribeRepositories` reads (the
      // `created-before-failure-revert` fixture's E1 compares the two), so no
      // describe is added here.
      createdAt = identityTimestamp(repo?.createdAt);
      // go-to-k/cdkd#5511: report before the policy calls.
      reportCreatedResource(logicalId, resourceType, repositoryName, createdAt);
      if (!repo?.repositoryName) {
        throw new Error('CreateRepository did not return repository name');
      }

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
        attributes: definedAttributes({
          Arn: repo.repositoryArn,
          RepositoryUri: repo.repositoryUri,
          CreatedAt: createdAt,
        }),
      };
    } catch (error) {
      if (repositoryCreated) markAuxiliaryFailure(error, logicalId);
      const cause = error instanceof Error ? error : undefined;
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create ECR Repository ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            repositoryName,
            cause
          )
      );
      // go-to-k/cdkd#4583: the repository exists with no state record; name it
      // for the failed-CREATE journal once CreateRepository has returned.
      if (repositoryCreated)
        markCreatedBeforeFailure(thrown, logicalId, resourceType, repositoryName, createdAt);
      throw thrown;
    }
  }

  /**
   * Update an ECR Repository
   *
   * Mutable properties: ImageScanningConfiguration, ImageTagMutability,
   * ImageTagMutabilityExclusionFilters, LifecyclePolicy, RepositoryPolicyText,
   * Tags.
   * Immutable: RepositoryName, EncryptionConfiguration (require replacement).
   */
  async update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating ECR Repository ${logicalId} (${physicalId})`);
    // go-to-k/cdkd#2613: the physical id is a NAME, so a client in another
    // region than the state record would act on a same-named resource cdkd
    // does not manage. Refuse before any call; the client's region is
    // resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // go-to-k/cdkd#3994: a malformed desired Tags is refused before any call.
    refuseMalformedDesiredTags(properties['Tags'], resourceType, logicalId, physicalId);

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

      // Update ImageTagMutability / ImageTagMutabilityExclusionFilters if
      // changed. Both members ride the SAME PutImageTagMutability call, so the
      // exclusion filters must be able to fire it on their own — a filters-only
      // edit (`IMMUTABLE_WITH_EXCLUSION` throughout, only the filter values
      // changing) would otherwise never reach AWS. `imageTagMutability` is a
      // REQUIRED member of that request, so the filters-only case re-sends the
      // current mutability value alongside the new filters.
      const newMutability = properties['ImageTagMutability'] as ImageTagMutability | undefined;
      const oldMutability = previousProperties['ImageTagMutability'] as
        | ImageTagMutability
        | undefined;
      const newExclusionFilters = this.toSdkTagMutabilityExclusionFilters(
        properties['ImageTagMutabilityExclusionFilters']
      );
      const oldExclusionFilters = this.toSdkTagMutabilityExclusionFilters(
        previousProperties['ImageTagMutabilityExclusionFilters']
      );
      if (
        newMutability !== oldMutability ||
        JSON.stringify(newExclusionFilters) !== JSON.stringify(oldExclusionFilters)
      ) {
        await this.getClient().send(
          new PutImageTagMutabilityCommand({
            repositoryName: physicalId,
            imageTagMutability: newMutability ?? 'MUTABLE',
            // Omitted on removal, on the expectation that
            // PutImageTagMutability is a full-replace setter rather than a
            // patch. NOT probed against real AWS, because the case is not
            // reachable: CFn/CDK reject filters without a `*_WITH_EXCLUSION`
            // mode and reject an exclusion mode without filters, so a removal
            // always rides a mutability change to a non-exclusion mode, where
            // any surviving filters are inert.
            ...(newExclusionFilters
              ? { imageTagMutabilityExclusionFilters: newExclusionFilters }
              : {}),
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
      // Both sides are read through `planTagDiff` (go-to-k/cdkd#3994): an
      // unreadable record untags nothing.
      const plan = planTagDiff(previousProperties['Tags'], properties['Tags']);
      const tagWarning = tagPlanWarning(plan, resourceType, logicalId);
      if (tagWarning !== undefined) {
        this.logger.warn(tagWarning);
      }
      if (plan.set.size > 0 || plan.remove.length > 0) {
        // Get repository ARN for tagging
        const describeResponse = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
        );
        const repoArn = describeResponse.repositories?.[0]?.repositoryArn;
        if (repoArn) {
          // Untag keys present in the old set but absent from the new set.
          // An absent desired `Tags` removes every recorded key.
          const removedKeys = plan.remove;
          if (removedKeys.length > 0) {
            await this.getClient().send(
              new UntagResourceCommand({
                resourceArn: repoArn,
                tagKeys: removedKeys,
              })
            );
          }
          // Apply added / changed tags. Skip the call when there are none
          // (a pure removal has nothing left to add).
          if (plan.set.size > 0) {
            await this.getClient().send(
              new TagResourceCommand({
                resourceArn: repoArn,
                tags: [...plan.set].map(([Key, Value]) => ({ Key, Value })),
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
        attributes: definedAttributes({
          Arn: repo?.repositoryArn,
          RepositoryUri: repo?.repositoryUri,
          // go-to-k/cdkd#6665: a record lacking one acquires it here.
          CreatedAt: identityTimestamp(repo?.createdAt),
        }),
      };
    } catch (error) {
      const cause = error instanceof Error ? error : undefined;
      throw this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to update ECR Repository ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
    }
  }

  /**
   * The failure wrap the create, update and delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDenied` names the caller's
   * assumed-role ARN. AWS's own text goes to `debug` through `mask`, and the
   * wrap is stamped `markRedactedCause`, so the retry classifiers read the
   * withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}) so a create-first replacement still
   * recognises the collision, except from a post-create step's failure
   * ({@link markAuxiliaryFailure}), where "it" would read as this resource. A
   * non-`Error` throw is withheld the same way, unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  private wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${mask(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  /**
   * Delete an ECR Repository
   *
   * `force: true` (delete the repository along with any images it still
   * contains) is applied ONLY when the user opted in (issue #1340):
   * `EmptyOnDelete: true` (CDK `emptyOnDelete`), CDK's legacy
   * `autoDeleteImages` tag, or the deploy engine's
   * `--force-stateful-recreation` consent on a replacement delete.
   * Without an opt-in, a repository that still contains images refuses
   * deletion with an actionable error — matching CloudFormation's
   * DELETE_FAILED (`RepositoryNotEmptyException`).
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting ECR Repository ${logicalId}: ${physicalId}`);

    const force =
      context?.forceDataDelete === true ||
      isTruthyCfnBoolean(properties?.['EmptyOnDelete']) ||
      hasCdkAutoDeleteTag(properties, ECR_AUTO_DELETE_IMAGES_TAG);

    try {
      // go-to-k/cdkd#6665: a record holding a `CreatedAt` refuses a repository
      // of the name created at another time, before the delete (which, with
      // `force`, would take its images too). One `DescribeRepositories`, made
      // only for such a record; its not-found is the typed one below.
      if (recordedIdentityId(resourceType, context) !== undefined) {
        const readCreatedAt = async () => {
          const repo = (
            await this.getClient().send(
              new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
            )
          ).repositories?.[0];
          // A response naming another repository carries no id of this one.
          return repo?.repositoryName === physicalId
            ? identityTimestamp(repo.createdAt)
            : undefined;
        };
        try {
          await assertRecordedIdentity({
            label: 'ECR repository',
            resourceType,
            logicalId,
            physicalId,
            liveId: await readCreatedAt(),
            reread: readCreatedAt,
            context,
          });
        } catch (readError) {
          throw (
            deniedIdentityReadRefusal(readError, {
              label: 'ECR repository',
              permission: 'ecr:DescribeRepositories',
              resourceType,
              logicalId,
              physicalId,
              context,
            }) ?? readError
          );
        }
      }
      if (force) {
        this.logger.debug(
          `Force-deleting ECR Repository ${logicalId} (empty-on-delete opt-in present)`
        );
      }
      await this.getClient().send(
        new DeleteRepositoryCommand({
          repositoryName: physicalId,
          force,
        })
      );
      this.logger.debug(`Successfully deleted ECR Repository ${logicalId}`);
    } catch (error) {
      // The identity refusals: already worded (no AWS text) and marked.
      if (error instanceof RecordedIdentityError) throw error;
      if (error instanceof RepositoryNotEmptyException) {
        throw new ProvisioningError(
          `Failed to delete ECR Repository ${logicalId}: repository ${physicalId} still ` +
            `contains images. Matching CloudFormation, cdkd does not force-delete an ` +
            `image-carrying repository unless it opted in via EmptyOnDelete: true (CDK's ` +
            `emptyOnDelete) or the '${ECR_AUTO_DELETE_IMAGES_TAG}' tag (CDK's autoDeleteImages). ` +
            `Either delete the images first (aws ecr batch-delete-image), or redeploy with ` +
            `emptyOnDelete: true and destroy again.`,
          resourceType,
          logicalId,
          physicalId,
          error
        );
      }
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
      const thrown = this.wrapCaughtError(
        maskerOrIdentity(context?.maskSecrets),
        error,
        (text) =>
          new ProvisioningError(
            `Failed to delete ECR Repository ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            physicalId,
            cause
          )
      );
      // The wrap names an AWS failure by its CLASS, and the delete classifiers
      // read `NotFoundException` in a message as "already deleted": only the
      // typed not-found above means this resource is gone (go-to-k/cdkd#2319).
      throw error instanceof Error && error.name.includes('NotFound')
        ? markNotGone(thrown)
        : thrown;
    }
  }

  /**
   * Read the AWS-current repository in CFn-property shape, `RepositoryPolicyText`
   * included (go-to-k/cdkd#6631). Lives in `./ecr/read-state.ts`.
   */
  readCurrentState(
    physicalId: string,
    logicalId: string,
    _resourceType: string,
    properties?: Record<string, unknown>,
    context?: ReadCurrentStateContext
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, logicalId, properties, context);
  }

  /**
   * `EmptyOnDelete` is a delete-time intent flag (the `force` of
   * `DeleteRepository`): AWS stores no value to read back, so drift never
   * compares it (go-to-k/cdkd#6631).
   */
  getDriftUnknownPaths(resourceType: string): string[] {
    return resourceType === 'AWS::ECR::Repository' ? ['EmptyOnDelete'] : [];
  }

  /**
   * A string `RepositoryPolicyText` (an L1 template may pass the JSON text) as
   * the document it parses to, the shape the read records, on both drift sides.
   * Anything else is returned by identity.
   */
  canonicalizeDriftProperties(
    resourceType: string,
    properties: Record<string, unknown>
  ): Record<string, unknown> {
    if (resourceType !== 'AWS::ECR::Repository') return properties;
    const policy = properties['RepositoryPolicyText'];
    if (typeof policy !== 'string') return properties;
    const parsed = declaredMemberDocument(policy);
    if (typeof parsed !== 'object' || parsed === null) return properties;
    return { ...properties, RepositoryPolicyText: parsed };
  }

  /**
   * go-to-k/cdkd#6665: the repository's `createdAt` as
   * {@link identityTimestamp}, the `CreatedAt` the create, update and import
   * record. A repository created again under the name repeats its ARN; the
   * creation time tells the two apart. `undefined` for another type, a client
   * in another region than `expectedRegion`, or a response without the
   * repository or the time; `RESOURCE_NOT_FOUND` on
   * `RepositoryNotFoundException`. Any other failure throws.
   */
  async resourceIdentity(
    physicalId: string,
    resourceType: string,
    context: { expectedRegion: string }
  ): Promise<string | ResourceNotFound | undefined> {
    if (resourceType !== 'AWS::ECR::Repository' || physicalId === '') return undefined;
    const clientRegion = await this.getClient().config.region();
    if (clientRegion !== context.expectedRegion) return undefined;
    try {
      const repo = (
        await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [physicalId] })
        )
      ).repositories?.[0];
      return repo?.repositoryName === physicalId ? identityTimestamp(repo.createdAt) : undefined;
    } catch (error) {
      if (error instanceof RepositoryNotFoundException) return RESOURCE_NOT_FOUND;
      throw error;
    }
  }

  /**
   * Adopt an existing ECR repository into cdkd state.
   *
   * Lookup order:
   *  1. `--resource` override or `Properties.RepositoryName` → verify via
   *     `DescribeRepositories`.
   */
  async import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    const explicit = resolveExplicitPhysicalId(input, 'RepositoryName');
    if (explicit) {
      try {
        const resp = await this.getClient().send(
          new DescribeRepositoriesCommand({ repositoryNames: [explicit] })
        );
        const repo = resp.repositories?.[0];
        // go-to-k/cdkd#6665: the `CreatedAt` a later delete compares, from
        // this same read (a record lacking one acquires it).
        return repo?.repositoryName
          ? {
              physicalId: explicit,
              attributes: definedAttributes({ CreatedAt: identityTimestamp(repo.createdAt) }),
            }
          : null;
      } catch (err) {
        if (err instanceof RepositoryNotFoundException) return null;
        throw err;
      }
    }

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so that
    // tag never exists on a real resource and the walk could not match (issue
    // #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // repository reaching here needs an explicit `--resource` override.
    return null;
  }
}
