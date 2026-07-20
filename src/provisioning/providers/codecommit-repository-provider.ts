import {
  CodeCommitClient,
  CreateCommitCommand,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  GetRepositoryCommand,
  ListRepositoriesCommand,
  ListTagsForResourceCommand,
  PutRepositoryTriggersCommand,
  TagResourceCommand,
  UntagResourceCommand,
  UpdateRepositoryDescriptionCommand,
  UpdateRepositoryEncryptionKeyCommand,
  UpdateRepositoryNameCommand,
  RepositoryDoesNotExistException,
  type PutFileEntry,
  type RepositoryMetadata,
  type RepositoryTrigger,
  type RepositoryTriggerEventEnum,
} from '@aws-sdk/client-codecommit';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import AdmZip from 'adm-zip';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { importTagWalk } from '../import-tag-walk.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
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

/** Order-independent equality for two SDK tag maps. */
function tagMapsEqual(a: Record<string, string>, b: Record<string, string>): boolean {
  const aKeys = Object.keys(a);
  if (aKeys.length !== Object.keys(b).length) return false;
  return aKeys.every((k) => b[k] === a[k]);
}

/**
 * CFn `Code` property shape (create-only seed content). CFn unpacks the S3
 * ZIP into the repository's first commit on `BranchName` (default `main`).
 */
interface CfnCode {
  BranchName?: unknown;
  S3?: {
    Bucket?: unknown;
    Key?: unknown;
    ObjectVersion?: unknown;
  };
}

/** CFn `Triggers[]` entry shape (PascalCase); mapped to the SDK's camelCase. */
interface CfnTrigger {
  Name?: unknown;
  DestinationArn?: unknown;
  CustomData?: unknown;
  Branches?: unknown;
  Events?: unknown;
}

/** Default branch for the `Code` seed commit when `BranchName` is omitted. */
const DEFAULT_SEED_BRANCH = 'main';

/**
 * Coerce a CFn scalar value to a string. Post-intrinsic-resolution values are
 * strings in practice; numbers / booleans are stringified and any other shape
 * (object / null / undefined) collapses to `''` — avoids stringifying an
 * object to the useless `'[object Object]'`.
 */
function scalarToString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

/**
 * Convert the CFn `Triggers` list shape to the CodeCommit SDK's
 * `RepositoryTrigger[]` (PascalCase → camelCase). `Branches` is ALWAYS
 * emitted (defaulting to `[]` when the template omits it) — CodeCommit's
 * `PutRepositoryTriggers` rejects a trigger whose `branches` is null with
 * "Repository trigger branch name list cannot be null", and an empty array
 * means "all branches" (matching CFn's default when `Branches` is absent).
 * `CustomData` is truly optional (emitted only when present) so a re-order /
 * equality comparison stays stable. `Events` / `Branches` are coerced to
 * string arrays.
 */
function toSdkTriggers(triggers: CfnTrigger[] | undefined): RepositoryTrigger[] {
  // CFn always resolves `Triggers` to a list, but guard defensively against a
  // non-array (hand-written / malformed template) so update()'s unguarded call
  // site can't hit a raw `.map is not a function` TypeError.
  if (!Array.isArray(triggers) || triggers.length === 0) return [];
  return triggers.map((t) => {
    const events: unknown[] = Array.isArray(t?.Events) ? t.Events : [];
    const branches: unknown[] = Array.isArray(t?.Branches) ? t.Branches : [];
    const trigger: RepositoryTrigger = {
      name: scalarToString(t?.Name),
      destinationArn: scalarToString(t?.DestinationArn),
      // The SDK types `events` as a string-literal enum union; the CFn values
      // are the same wire strings (`all` / `createReference` / ...), so the
      // coerced strings are cast to the enum type.
      events: events.map((e) => scalarToString(e)) as RepositoryTriggerEventEnum[],
      branches: branches.map((b) => scalarToString(b)),
    };
    if (t?.CustomData !== undefined && t.CustomData !== null) {
      trigger.customData = scalarToString(t.CustomData);
    }
    return trigger;
  });
}

/**
 * Order-sensitive structural equality for two mapped SDK trigger lists, used
 * to skip a redundant `PutRepositoryTriggers` when the template `Triggers`
 * block is unchanged. Compared as canonical JSON so `undefined` optional
 * fields (`customData` / `branches`) collapse identically on both sides.
 */
function triggersEqual(a: RepositoryTrigger[], b: RepositoryTrigger[]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
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
  private s3Client?: S3Client;
  private readonly providerRegion = process.env['AWS_REGION'];
  private logger = getLogger().child('CodeCommitRepositoryProvider');

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CodeCommit::Repository',
      new Set<string>([
        'RepositoryName',
        'RepositoryDescription',
        'KmsKeyId',
        'Tags',
        // `Code`: create-only S3-zip seed content, unpacked into the initial
        // commit (see `seedInitialCommit`). `Triggers`: mutable repository
        // event triggers, wired on create + update via PutRepositoryTriggers.
        'Code',
        'Triggers',
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

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client(this.providerRegion ? { region: this.providerRegion } : {});
    }
    return this.s3Client;
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
      const createdName = metadata.repositoryName;

      // Post-create orchestration (`Code` seed + `Triggers`). If either
      // fails, the repository already exists on AWS but the deploy engine's
      // rollback cannot delete it — `create()` throwing before returning a
      // physicalId means the engine never recorded one to roll back. So
      // self-clean: delete the just-created repository before re-throwing,
      // mirroring CloudFormation's rollback-deletes-the-repo behavior.
      try {
        const code = properties['Code'] as CfnCode | undefined;
        if (code) {
          await this.seedInitialCommit(createdName, code);
        }
        const triggers = properties['Triggers'] as CfnTrigger[] | undefined;
        if (Array.isArray(triggers) && triggers.length > 0) {
          await this.getClient().send(
            new PutRepositoryTriggersCommand({
              repositoryName: createdName,
              triggers: toSdkTriggers(triggers),
            })
          );
          this.logger.debug(`Applied ${triggers.length} trigger(s) to ${createdName}`);
        }
      } catch (postCreateError) {
        this.logger.warn(
          `Post-create step failed for CodeCommit Repository ${logicalId}; deleting the ` +
            `just-created repository ${createdName} to avoid an orphan`
        );
        await this.bestEffortDelete(createdName);
        throw postCreateError;
      }

      this.logger.debug(`Successfully created CodeCommit Repository ${logicalId}: ${createdName}`);

      return {
        physicalId: createdName,
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
   * see the ECR Tags regression class in issue #981), Triggers
   * (PutRepositoryTriggers — a full-set replace, so a dropped or fully-removed
   * `Triggers` property is applied by putting the new/empty set; issue #1066).
   * `Code` is create-only seed content (CFn ignores it on update) and is NOT
   * re-applied here.
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
        try {
          await this.getClient().send(
            new UpdateRepositoryNameCommand({ oldName: physicalId, newName })
          );
        } catch (err) {
          // Retry safety: the deploy engine's outer `withRetry` re-invokes
          // update() with the OLD physicalId. If a previous attempt already
          // renamed the repository and then failed on a later step, the
          // rename call now sees a gone oldName. Probe the NEW name — if it
          // exists, the rename already happened; continue instead of
          // turning a transient retry into a permanent failure.
          if (!(err instanceof RepositoryDoesNotExistException)) throw err;
          await this.getRepositoryMetadata(newName); // throws if truly gone
          this.logger.debug(
            `Rename ${physicalId} -> ${newName} already applied by a previous attempt`
          );
        }
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
      // The diff compares the SDK-shaped tag MAPS (key-sorted by
      // construction order-independence) so a pure re-order of the CFn
      // `Tags` list does not trigger needless API churn.
      const newTags = properties['Tags'] as CfnTag[] | undefined;
      const oldTags = previousProperties['Tags'] as CfnTag[] | undefined;
      const newTagMap = toSdkTagMap(newTags) ?? {};
      const oldTagMap = toSdkTagMap(oldTags) ?? {};
      let metadata: RepositoryMetadata | undefined;
      if (!tagMapsEqual(newTagMap, oldTagMap)) {
        metadata = await this.getRepositoryMetadata(currentName);
        const repoArn = metadata?.Arn;
        if (repoArn) {
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
        } else {
          // GetRepository returning metadata without an Arn is unexpected;
          // surface it instead of silently dropping the tag reconcile.
          this.logger.warn(
            `Could not resolve ARN for CodeCommit Repository ${currentName}; tag update skipped`
          );
        }
      }

      // Update Triggers if changed. `PutRepositoryTriggers` REPLACES the full
      // trigger set, so a template that dropped an entry — or removed the
      // `Triggers` property entirely (`newTriggers === undefined`) — is
      // handled by putting the new set (empty array = clear all). `Code` is
      // create-only seed content and is intentionally NOT re-applied here
      // (CFn ignores `Code` on update).
      const newSdkTriggers = toSdkTriggers(properties['Triggers'] as CfnTrigger[] | undefined);
      const oldSdkTriggers = toSdkTriggers(
        previousProperties['Triggers'] as CfnTrigger[] | undefined
      );
      if (!triggersEqual(newSdkTriggers, oldSdkTriggers)) {
        await this.getClient().send(
          new PutRepositoryTriggersCommand({
            repositoryName: currentName,
            triggers: newSdkTriggers,
          })
        );
        this.logger.debug(
          `Updated triggers for ${currentName} (${newSdkTriggers.length} trigger(s))`
        );
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
   * `DeleteRepository` is idempotent on the AWS side: for an
   * already-deleted repository it does NOT throw — it returns a null
   * `repositoryId`. That silent-success shape would bypass the shared
   * region check entirely (the exact scenario `assertRegionMatch` exists
   * for: a client pointed at region B while the state says the repo lives
   * in region A), so a null `repositoryId` runs the region check before
   * being treated as idempotent success. A
   * `RepositoryDoesNotExistException` is additionally handled (same
   * check) for defense in depth.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    this.logger.debug(`Deleting CodeCommit Repository ${logicalId}: ${physicalId}`);

    let deletedRepositoryId: string | undefined;
    try {
      const response = await this.getClient().send(
        new DeleteRepositoryCommand({ repositoryName: physicalId })
      );
      deletedRepositoryId = response.repositoryId;
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

    if (!deletedRepositoryId) {
      // Repository did not exist — verify we were even looking in the right
      // region before calling this an idempotent success. Outside the try
      // block so a region-mismatch error propagates unwrapped.
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`CodeCommit Repository ${physicalId} does not exist, skipping deletion`);
      return;
    }
    this.logger.debug(`Successfully deleted CodeCommit Repository ${logicalId}`);
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
   * Read the currently-deployed properties for `cdkd drift`.
   *
   * Maps the CodeCommit read side back to the flat CFn inputs cdkd stores
   * in state:
   *   - `repositoryName`        -> `RepositoryName`
   *   - `repositoryDescription` -> `RepositoryDescription` (placeholder `''`)
   *   - `kmsKeyId`              -> `KmsKeyId`
   *   - `ListTagsForResource`   -> `Tags` (CFn `[{Key, Value}]` list)
   *
   * Every user-controllable top-level key `update()` can mutate is emitted
   * ALWAYS — with a `?? ''` / `?? []` placeholder when AWS returns the field
   * as undefined / empty (docs/provider-development.md §3b). Omitting the key
   * on the empty path would let a resource deployed WITHOUT a description
   * never carry `RepositoryDescription` in `observedProperties`, making a
   * console-side ADD of a description invisible to drift forever. `Tags` are
   * returned in the CFn list shape and the comparator canonicalizes tag lists
   * order-independently (`drift-normalize.ts`), so a tag reorder never
   * surfaces as phantom drift. `aws:*` tags (CDK's `aws:cdk:path` etc.) are
   * dropped by `normalizeAwsTagsToCfn` so a CDK-deployed repository does not
   * report drift on the metadata tag cdkd never templated.
   *
   * Returns `undefined` when the repository no longer exists (or
   * `GetRepository` returns no metadata) so the caller reports it as
   * drift-unknown rather than throwing — mirrors the optional `import`
   * method's incremental opt-in shape. A repository deleted BETWEEN the
   * `GetRepository` and `ListTagsForResource` calls (a race with a
   * concurrent destroy) is handled the same way rather than aborting the
   * whole `cdkd drift` run.
   *
   * Caveat: `KmsKeyId` is returned as AWS resolves it — the full key ARN.
   * On the normal drift path the baseline is `observedProperties` (captured
   * via this same method at deploy time), so ARN == ARN and there is no
   * phantom drift; but on the `properties`-fallback path (older state with
   * no `observedProperties`) a template that set `KmsKeyId` as an alias or
   * bare key id would phantom-drift against the returned ARN. This is a
   * general fallback-path limitation shared with other providers.
   */
  async readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | undefined> {
    let metadata: RepositoryMetadata | undefined;
    try {
      metadata = await this.getRepositoryMetadata(physicalId);
    } catch (err) {
      if (err instanceof RepositoryDoesNotExistException) return undefined;
      throw err;
    }
    if (!metadata) return undefined;

    // Tags via ListTagsForResource (needs the repository ARN — CodeCommit's
    // tag map is a flat `Record<string, string>`, normalized back to the CFn
    // list shape). GetRepository does not return tags inline. `?? []` when
    // the ARN is somehow absent so `Tags` is always emitted. A repo deleted
    // between the two reads throws NotFound here — treat that as drift-unknown
    // (return undefined) instead of letting one racing delete abort the run.
    let tags: Array<{ Key: string; Value: string }> = [];
    if (metadata.Arn) {
      try {
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: metadata.Arn })
        );
        tags = normalizeAwsTagsToCfn(tagsResp.tags);
      } catch (err) {
        if (err instanceof RepositoryDoesNotExistException) return undefined;
        throw err;
      }
    }

    return {
      RepositoryName: metadata.repositoryName ?? '',
      RepositoryDescription: metadata.repositoryDescription ?? '',
      // AWS always assigns an encryption key (the AWS-managed
      // `aws/codecommit` key when none was requested), so `kmsKeyId` is
      // effectively never undefined; the `?? ''` placeholder satisfies the
      // always-emit convention for this mutable field regardless.
      KmsKeyId: metadata.kmsKeyId ?? '',
      Tags: tags,
    };
  }

  /**
   * State property paths this provider cannot read back from AWS, skipped by
   * the drift comparator to avoid a guaranteed false positive.
   *
   * `Code` is create-only S3-zip seed content unpacked into the initial
   * commit — there is no read-back to compare against (the commit is git
   * history, not a repository attribute), so it can never meaningfully drift.
   * `Triggers` IS wired on the write side (create + update via
   * `PutRepositoryTriggers`), but `readCurrentState` does not yet fetch
   * `GetRepositoryTriggers`, so comparing a state that carries `Triggers`
   * against an `observedProperties` that omits it would be a guaranteed false
   * positive. Both are therefore excluded here; a follow-up can add
   * `GetRepositoryTriggers` read-back and drop `Triggers` from this list.
   */
  getDriftUnknownPaths(_resourceType: string): string[] {
    return ['Code', 'Triggers'];
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

    const match = await importTagWalk({
      cdkPath: input.cdkPath,
      logicalId: input.logicalId,
      listPage: async (marker) => {
        const list = await this.getClient().send(
          new ListRepositoriesCommand({ ...(marker && { nextToken: marker }) })
        );
        return { items: list.repositories, nextMarker: list.nextToken };
      },
      // Two reads per candidate: GetRepository for the ARN (and the attributes
      // the caller needs on a hit), then ListTagsForResource. Both live inside
      // the retried `describe` so a throttle on either is backed off.
      describe: async (repo) => {
        if (!repo.repositoryName) return undefined;
        let metadata: RepositoryMetadata | undefined;
        try {
          metadata = await this.getRepositoryMetadata(repo.repositoryName);
        } catch (err) {
          // Deleted between the list and the describe — skip the candidate.
          if (err instanceof RepositoryDoesNotExistException) return undefined;
          throw err;
        }
        if (!metadata?.Arn) return undefined;
        const tagsResp = await this.getClient().send(
          new ListTagsForResourceCommand({ resourceArn: metadata.Arn })
        );
        return { metadata, tags: tagsResp.tags };
      },
      // CodeCommit returns tags as a MAP, not a {Key,Value} list.
      tagsOf: (detail) => Object.entries(detail.tags ?? {}).map(([Key, Value]) => ({ Key, Value })),
    });
    if (!match) return null;
    // Non-null by construction: `describe` skips summaries without a name.
    return {
      physicalId: match.summary.repositoryName!,
      attributes: this.toAttributes(match.detail.metadata),
    };
  }

  /**
   * Seed the repository's initial commit from the CFn `Code` property.
   *
   * CFn's `Code` orchestration downloads the S3 ZIP, unpacks it, and creates
   * the repository's first commit on `BranchName` (default `main`). cdkd
   * reproduces that here: `GetObject` the ZIP, unpack every file entry
   * (directories are implied by file paths — CodeCommit has no empty-dir
   * concept), and issue a single `CreateCommit` carrying all files as
   * `putFiles`. This is create-only: CFn ignores `Code` on update, and so
   * does cdkd (`update()` never calls this).
   *
   * A ZIP with no file entries is a no-op (warn + skip) rather than a hard
   * failure — CodeCommit rejects a `CreateCommit` with an empty `putFiles`.
   */
  private async seedInitialCommit(repositoryName: string, code: CfnCode): Promise<void> {
    const bucket = code.S3?.Bucket;
    const key = code.S3?.Key;
    if (typeof bucket !== 'string' || typeof key !== 'string' || !bucket || !key) {
      throw new Error('Code.S3 requires string Bucket and Key');
    }
    const versionId =
      typeof code.S3?.ObjectVersion === 'string' ? code.S3.ObjectVersion : undefined;
    const branchName =
      typeof code.BranchName === 'string' && code.BranchName
        ? code.BranchName
        : DEFAULT_SEED_BRANCH;

    // The S3 client is bound to the deploy region (`AWS_REGION`). CDK always
    // uploads a `Code` asset to the same-region bootstrap bucket, so a
    // cross-region `Code.S3.Bucket` (PermanentRedirect) is not expected here.
    const obj = await this.getS3Client().send(
      new GetObjectCommand({ Bucket: bucket, Key: key, ...(versionId && { VersionId: versionId }) })
    );
    if (!obj.Body) {
      throw new Error(`Code.S3 object s3://${bucket}/${key} returned an empty body`);
    }
    const zipBytes = await obj.Body.transformToByteArray();

    const zip = new AdmZip(Buffer.from(zipBytes));
    const putFiles: PutFileEntry[] = [];
    for (const entry of zip.getEntries()) {
      if (entry.isDirectory) continue;
      putFiles.push({ filePath: entry.entryName, fileContent: entry.getData() });
    }
    if (putFiles.length === 0) {
      this.logger.warn(
        `Code.S3 object s3://${bucket}/${key} contained no files; skipping seed commit for ${repositoryName}`
      );
      return;
    }

    await this.getClient().send(
      new CreateCommitCommand({
        repositoryName,
        branchName,
        commitMessage: 'Initial commit',
        putFiles,
      })
    );
    this.logger.debug(
      `Seeded ${repositoryName} with ${putFiles.length} file(s) on branch ${branchName}`
    );
  }

  /**
   * Best-effort delete used to roll back a just-created repository when a
   * post-create step (`Code` seed / `Triggers`) fails. Never throws — the
   * original post-create error is what the caller re-throws; a cleanup
   * failure is logged so the orphan is surfaced.
   */
  private async bestEffortDelete(repositoryName: string): Promise<void> {
    try {
      await this.getClient().send(new DeleteRepositoryCommand({ repositoryName }));
    } catch (cleanupError) {
      this.logger.warn(
        `Failed to clean up CodeCommit Repository ${repositoryName} after a post-create failure: ` +
          `${cleanupError instanceof Error ? cleanupError.message : String(cleanupError)}`
      );
    }
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
