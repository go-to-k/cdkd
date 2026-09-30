import {
  CodeCommitClient,
  CreateCommitCommand,
  CreateRepositoryCommand,
  DeleteRepositoryCommand,
  GetRepositoryCommand,
  GetRepositoryTriggersCommand,
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
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import AdmZip from 'adm-zip';
import { getLogger } from '../../utils/logger.js';
import { ProvisioningError } from '../../utils/error-handler.js';
import { generateResourceName } from '../resource-name.js';
import { assertRegionMatch, type DeleteContext } from '../region-check.js';
import { normalizeAwsTagsToCfn, resolveExplicitPhysicalId } from '../import-helpers.js';
import type {
  IndeterminateGuard,
  ResourceDeleteResult,
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { markAuxiliaryFailure } from '../auxiliary-failure.js';
import { pasteableCommand } from '../../utils/pasteable-command.js';
import {
  isThrottlingError,
  isTransientServerError,
  markNonRetryable,
} from '../../deployment/retryable-errors.js';
import { withIndeterminateGuard } from '../../deployment/delete-outcome.js';
import { safeMsg } from '../../utils/display-safe.js';
import { holdsSecretDerivedEntry } from '../iam-policy-targets.js';

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
  // Every caller passes a list `readRepoList` accepted (go-to-k/cdkd#3989).
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
 * The guard id a delete reports when it could not read the live repository's
 * id to compare with the recorded one (go-to-k/cdkd#4157), and deleted anyway.
 */
export const CODECOMMIT_DELETE_IDENTITY_GUARD = 'codecommit-delete-repository-identity';

/**
 * The `RepositoryId` cdkd recorded for the resource, or `undefined` for a
 * record that holds none (one from before the attribute existed).
 */
function recordedRepositoryId(
  attributes: Readonly<Record<string, unknown>> | undefined
): string | undefined {
  const value = attributes?.['RepositoryId'];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

// ─── List reads (go-to-k/cdkd#3989) ─────────────────────────────────
//
// `PutRepositoryTriggers` REPLACES the whole trigger set, and the tag diff
// untags every recorded key the desired map lacks. Reading a present-but-
// malformed desired value (or dropping a malformed entry) as empty therefore
// cleared every trigger / untagged every key: on a rollback or
// `drift --revert`, where the desired side is a recorded bag, `Triggers: {}`
// sent `triggers: []`. So `undefined` / `null` is ABSENT (an empty list), and
// anything else that is not a list of well-formed entries is MALFORMED. A
// malformed DESIRED side is refused before any call; a malformed RECORDED side
// is applied ADD-only (see `update`).

type RepoListKind = 'Triggers' | 'Tags';
type RepoListSide = 'desired' | 'recorded';

type RepoListRead =
  | { kind: 'list'; items: Record<string, unknown>[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an identity member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

const REPO_LIST_WHAT: Record<RepoListKind, string> = {
  Triggers: 'triggers with a Name, a string DestinationArn and list-valued Events / Branches',
  Tags: 'tags with a string Key',
};

function isScalar(value: unknown): boolean {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Absent, or a list of scalars (coerced to strings on the wire). */
function isScalarList(value: unknown): boolean {
  return value == null || (Array.isArray(value) && value.every(isScalar));
}

/**
 * An entry is checked for what a removal or an empty reading turns on: its
 * identity (a trigger's `Name` and `DestinationArn`, a tag's `Key`) and a
 * trigger's `Events` / `Branches`, whose empty reading means ALL branches.
 * Scalar values (`CustomData`, a tag `Value`) keep their existing coercion.
 *
 * `side` matters for identity members only. A DESIRED one holding a dynamic
 * reference or its mask names nothing CodeCommit holds, so it is malformed. A
 * RECORDED one is what cdkd writes for a value that came from a secret (cdkd
 * keeps the reference in state): it is read, and only differs from the desired
 * side.
 */
function isWellFormedRepoEntry(
  kind: RepoListKind,
  entry: unknown,
  side: RepoListSide,
  ignoreSecrets = false
): boolean {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) return false;
  const e = entry as Record<string, unknown>;
  // A trigger `Name` is coerced like the rest (`scalarToString`), so a number
  // names a trigger too.
  const identity = kind === 'Tags' ? [e['Key']] : [scalarToString(e['Name']), e['DestinationArn']];
  if (!identity.every(isNonEmptyString)) return false;
  if (side === 'desired' && !ignoreSecrets && identity.some((v) => holdsSecretDerivedEntry(v))) {
    return false;
  }
  return kind === 'Tags' || (isScalarList(e['Events']) && isScalarList(e['Branches']));
}

/** Read one list property; ABSENT (`undefined` / `null`) reads as the empty list. */
function readRepoList(kind: RepoListKind, value: unknown, side: RepoListSide): RepoListRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((e) => isWellFormedRepoEntry(kind, e, side))) {
    return { kind: 'list', items: value as Record<string, unknown>[] };
  }
  return {
    kind: 'malformed',
    onlySecret:
      Array.isArray(value) && value.every((e) => isWellFormedRepoEntry(kind, e, side, true)),
  };
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
  private readonly providerRegion = ambientRegion();
  private logger = getLogger().child('CodeCommitRepositoryProvider');
  /**
   * Renames this provider instance STARTED, keyed by the old name, with the
   * repository id read just before the rename (go-to-k/cdkd#4042): the
   * same-run evidence a retry's probe accepts beside the recorded
   * `RepositoryId` (`UpdateContext.recordedAttributes`, go-to-k/cdkd#4051),
   * and the only evidence for a record that holds none. The deploy engine's
   * retry re-invokes `update()` on this same instance.
   */
  private readonly renamesStarted = new Map<string, string>();

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
      this.client = new CodeCommitClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  private getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.s3Client;
  }

  /**
   * Build the `Fn::GetAtt` attribute map from a `RepositoryMetadata`
   * response. `RepositoryId` is additionally stored so the intrinsic
   * resolver can recover CFn's `Ref` value (the repository ID) from state.
   */
  private toAttributes(metadata: RepositoryMetadata | undefined): Record<string, unknown> {
    return definedAttributes({
      Arn: metadata?.Arn,
      CloneUrlHttp: metadata?.cloneUrlHttp,
      CloneUrlSsh: metadata?.cloneUrlSsh,
      Name: metadata?.repositoryName,
      KmsKeyId: metadata?.kmsKeyId,
      RepositoryId: metadata?.repositoryId,
    });
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

    // go-to-k/cdkd#3989: refused before CreateRepository, so a malformed list
    // never creates a repository missing the triggers or tags it declares.
    const lists = this.readDesiredLists(
      logicalId,
      resourceType,
      { Triggers: properties['Triggers'], Tags: properties['Tags'] },
      undefined
    );

    try {
      const tags = toSdkTagMap(lists.Tags as CfnTag[]);
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
        const triggers = lists.Triggers as CfnTrigger[];
        if (triggers.length > 0) {
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
        // The repository itself was created: an "already exists" from here is
        // an auxiliary object's, not this repository's name collision (#3826).
        throw markAuxiliaryFailure(postCreateError, logicalId);
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
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    this.logger.debug(`Updating CodeCommit Repository ${logicalId} (${physicalId})`);

    // go-to-k/cdkd#3989: a malformed desired list is refused before any call,
    // the rename included.
    const next = this.readDesiredLists(
      logicalId,
      resourceType,
      { Triggers: properties['Triggers'], Tags: properties['Tags'] },
      physicalId
    );
    const prevTriggers = readRepoList('Triggers', previousProperties['Triggers'], 'recorded');
    const prevTags = readRepoList('Tags', previousProperties['Tags'], 'recorded');
    // Every call below is addressed by a state-recorded NAME, so a client in
    // another region would act on a same-named repository cdkd does not manage.
    // The client's region is resolved only when there is one to compare with.
    assertRegionMatch(
      context?.expectedRegion ? await this.getClient().config.region() : undefined,
      context?.expectedRegion,
      resourceType,
      logicalId,
      physicalId,
      'pre-update'
    );
    // The repository id cdkd recorded for this resource (go-to-k/cdkd#4051):
    // the identity every call below is verified against.
    const recordedId = recordedRepositoryId(context?.recordedAttributes);
    const renameTo = properties['RepositoryName'];
    const renaming = typeof renameTo === 'string' && renameTo.length > 0 && renameTo !== physicalId;
    // An update that does not rename addresses the recorded name only, so the
    // repository holding it must be the recorded one before anything is read
    // for, or written to, it (go-to-k/cdkd#4157); the rename path checks the
    // same before renaming. A record with no RepositoryId keeps the historical
    // by-name update: nothing identifies a foreign holder.
    if (!renaming && recordedId !== undefined) {
      await this.assertRecordedHolder(logicalId, resourceType, physicalId, recordedId);
    }
    // A recorded Triggers cdkd cannot read is replaced by the live set, read
    // before the rename so a failed read changes nothing. A retry after a
    // rename that already landed finds the repository under the NEW name.
    const liveTriggers =
      prevTriggers.kind === 'malformed'
        ? await this.readLiveTriggers(
            logicalId,
            physicalId,
            renaming ? renameTo : undefined,
            recordedId,
            resourceType
          )
        : undefined;

    // Rename first so every subsequent call targets the current name.
    // `previousProperties.RepositoryName` is not consulted — the physical id
    // IS the deployed name (a template without an explicit name got a
    // generated one at create time that no longer matches the property).
    let currentName = physicalId;

    try {
      const newName = properties['RepositoryName'] as string | undefined;
      if (newName && newName !== physicalId) {
        // Read the repository's id BEFORE renaming, and remember it: a retry
        // then adopts the repository under the new name only when it is the
        // same one (go-to-k/cdkd#4042). A repository under the recorded name
        // whose id is not the recorded one (the recorded repository deleted
        // out of band and the name taken since) is refused before anything is
        // sent to it (go-to-k/cdkd#4051).
        let gone = false;
        try {
          const before = await this.getRepositoryMetadata(physicalId);
          // A read with no id leaves no evidence, never an earlier attempt's.
          this.renamesStarted.delete(physicalId);
          if (
            recordedId !== undefined &&
            before?.repositoryId !== undefined &&
            before.repositoryId !== recordedId
          ) {
            throw this.wrapNotThisRepositoryError(
              logicalId,
              resourceType,
              physicalId,
              'recorded-name'
            );
          }
          if (before?.repositoryId) {
            this.renamesStarted.set(physicalId, before.repositoryId);
          }
        } catch (err) {
          if (!(err instanceof RepositoryDoesNotExistException)) throw err;
          gone = true;
        }
        if (!gone) {
          try {
            await this.getClient().send(
              new UpdateRepositoryNameCommand({ oldName: physicalId, newName })
            );
          } catch (err) {
            if (!(err instanceof RepositoryDoesNotExistException)) throw err;
            gone = true;
          }
        }
        if (gone) {
          // Retry safety: the deploy engine's outer `withRetry` re-invokes
          // update() with the OLD physicalId. If a previous attempt (this run's
          // or an earlier deploy's) already renamed the repository and then
          // failed before recording the new name, the old name is gone. The
          // repository under the NEW name is adopted only when its id is the
          // recorded RepositoryId or the one this instance read before
          // renaming; any other holder is refused, with nothing sent to it.
          await this.verifyRenamedRepository(
            logicalId,
            resourceType,
            physicalId,
            newName,
            recordedId
          );
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
      //
      // A recorded `Tags` cdkd cannot read is applied ADD-only
      // (go-to-k/cdkd#3989): nothing is untagged, and the desired map is
      // tagged whenever it is non-empty. A recorded Key holding a dynamic
      // reference or its mask is left out of the untag set.
      const newTagMap = toSdkTagMap(next.Tags as CfnTag[]) ?? {};
      const oldTagMap =
        prevTags.kind === 'list'
          ? (toSdkTagMap(
              prevTags.items.filter((t) => !holdsSecretDerivedEntry(t['Key'])) as CfnTag[]
            ) ?? {})
          : {};
      if (prevTags.kind === 'malformed') {
        this.logger.warn(
          safeMsg`The recorded Tags of CodeCommit Repository ${logicalId} is not a list cdkd can read, so cdkd removed no tag and only applied the desired ones. Untag any key the template no longer names yourself.`
        );
      }
      let metadata: RepositoryMetadata | undefined;
      if (
        prevTags.kind === 'malformed'
          ? Object.keys(newTagMap).length > 0
          : !tagMapsEqual(newTagMap, oldTagMap)
      ) {
        metadata = await this.getRepositoryMetadata(currentName);
        const repoArn = metadata?.Arn;
        if (repoArn) {
          // Untag keys present in the old set but absent from the new set.
          // `newTags === undefined` is treated as "remove all old tags".
          const removedKeys = Object.keys(oldTagMap).filter((k) => !Object.hasOwn(newTagMap, k));
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
      //
      // A recorded `Triggers` cdkd cannot read is applied ADD-only
      // (go-to-k/cdkd#3989): the set put is the desired triggers plus every
      // live trigger whose name the desired side does not use, so nothing is
      // cleared on the strength of a record cdkd could not read.
      let newSdkTriggers = toSdkTriggers(next.Triggers as CfnTrigger[]);
      let oldSdkTriggers: RepositoryTrigger[] | undefined;
      let retainedCount = 0;
      if (liveTriggers === undefined) {
        oldSdkTriggers = toSdkTriggers(
          (prevTriggers.kind === 'list' ? prevTriggers.items : []) as CfnTrigger[]
        );
      } else {
        const names = new Set(newSdkTriggers.map((t) => t.name));
        const retained = liveTriggers.filter((t) => !names.has(t.name));
        if (retained.length > 0) {
          this.logger.warn(
            safeMsg`The recorded Triggers of CodeCommit Repository ${logicalId} is not a list cdkd can read, so cdkd read the triggers from CodeCommit; the repository holds ${retained.length} trigger(s) the desired Triggers does not name, and cdkd kept them. They stay only until the next change to Triggers, which replaces the whole set; list them with \`aws codecommit get-repository-triggers --repository-name\` and this repository's name, and remove any that are no longer wanted.`
          );
        }
        retainedCount = retained.length;
        newSdkTriggers = [...newSdkTriggers, ...retained];
        oldSdkTriggers = liveTriggers;
      }
      if (!triggersEqual(newSdkTriggers, oldSdkTriggers)) {
        try {
          await this.getClient().send(
            new PutRepositoryTriggersCommand({
              repositoryName: currentName,
              triggers: newSdkTriggers,
            })
          );
        } catch (error) {
          if (retainedCount === 0) throw error;
          // The kept live triggers count toward CodeCommit's per-repository
          // limit (10), so name them: removing them is the way out. A plain
          // Error carrying the AWS one as `cause`: the catch below wraps it,
          // and the retry classifies through the chain.
          throw new Error(
            `PutRepositoryTriggers failed with ${retainedCount} live trigger(s) the desired ` +
              `Triggers does not name kept beside the desired ones (the recorded Triggers is ` +
              `not a list cdkd can read; CodeCommit allows at most 10 triggers per ` +
              `repository): ${error instanceof Error ? error.message : String(error)}`,
            { cause: error }
          );
        }
        this.logger.debug(
          `Updated triggers for ${currentName} (${newSdkTriggers.length} trigger(s))`
        );
      }

      // Get current attributes (re-read so rename / description / key
      // updates above are reflected).
      metadata = await this.getRepositoryMetadata(currentName);
      this.renamesStarted.delete(physicalId);

      return {
        physicalId: currentName,
        wasReplaced: false,
        attributes: this.toAttributes(metadata),
      };
    } catch (error) {
      // A refusal (go-to-k/cdkd#4042) already names the resource and carries
      // its non-retryable mark.
      if (error instanceof ProvisioningError) throw error;
      const cause = error instanceof Error ? error : undefined;
      throw new ProvisioningError(
        `Failed to update CodeCommit Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        cause
      );
    }
  }

  /**
   * Read the DESIRED lists of a create or update, refusing a malformed one
   * before any call (go-to-k/cdkd#3989). The caller passes its own literal read
   * of each property so the handled-property wiring walk still sees which
   * property feeds the calls. `physicalId` is set on the update path.
   */
  private readDesiredLists(
    logicalId: string,
    resourceType: string,
    values: Record<RepoListKind, unknown>,
    physicalId: string | undefined
  ): Record<RepoListKind, Record<string, unknown>[]> {
    const kinds: RepoListKind[] = ['Triggers', 'Tags'];
    const out = {} as Record<RepoListKind, Record<string, unknown>[]>;
    const bad: RepoListKind[] = [];
    const secret: RepoListKind[] = [];
    for (const kind of kinds) {
      const read = readRepoList(kind, values[kind], 'desired');
      if (read.kind === 'list') {
        out[kind] = read.items;
      } else {
        bad.push(kind);
        if (read.onlySecret) secret.push(kind);
      }
    }
    if (bad.length === 0) return out;
    const updating = physicalId !== undefined;
    throw markNonRetryable(
      new ProvisioningError(
        `${updating ? 'desired ' : ''}${bad.join(' / ')} of CodeCommit Repository ${logicalId} ` +
          `is not a list of ${bad.map((k) => REPO_LIST_WHAT[k]).join(' / ')}` +
          (secret.length > 0
            ? ` (${secret.join(' / ')} holds a dynamic reference or its mask where a name ` +
              `belongs, which names nothing CodeCommit holds)`
            : '') +
          ` — the repository was not ${updating ? 'updated' : 'created'}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /**
   * Refuse an update whose recorded name is now held by a repository that is
   * not the recorded one (go-to-k/cdkd#4157): nothing is sent to it. Any other
   * failure to read it fails the update as before, retryable.
   */
  private async assertRecordedHolder(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    recordedId: string
  ): Promise<void> {
    let holder: RepositoryMetadata | undefined;
    try {
      holder = await this.getRepositoryMetadata(physicalId);
    } catch (error) {
      throw new ProvisioningError(
        `Failed to update CodeCommit Repository ${logicalId}: ${error instanceof Error ? error.message : String(error)}`,
        resourceType,
        logicalId,
        physicalId,
        error instanceof Error ? error : undefined
      );
    }
    if (holder?.repositoryId !== undefined && holder.repositoryId !== recordedId) {
      throw this.wrapNotThisRepositoryError(logicalId, resourceType, physicalId, 'recorded-name');
    }
  }

  /**
   * The live trigger set, for a recorded `Triggers` cdkd cannot read
   * (go-to-k/cdkd#3989). A failed read throws before any write; it is not
   * marked non-retryable, since a throttled read is worth the retry.
   */
  private async readLiveTriggers(
    logicalId: string,
    repositoryName: string,
    renamedTo: string | undefined,
    recordedId: string | undefined,
    resourceType: string
  ): Promise<RepositoryTrigger[]> {
    try {
      // A retry after the rename already landed finds the old name gone
      // (`undefined` here), so it reads under the new one.
      const first = await this.getClient()
        .send(new GetRepositoryTriggersCommand({ repositoryName }))
        .catch((error: unknown) => {
          if (renamedTo === undefined || !(error instanceof RepositoryDoesNotExistException)) {
            throw error;
          }
          return undefined;
        });
      if (first === undefined) {
        // Only this resource's own repository is read under the new name.
        await this.verifyRenamedRepository(
          logicalId,
          resourceType,
          repositoryName,
          renamedTo as string,
          recordedId
        );
      }
      const resp =
        first ??
        (await this.getClient().send(
          new GetRepositoryTriggersCommand({ repositoryName: renamedTo as string })
        ));
      return resp.triggers ?? [];
    } catch (error) {
      if (error instanceof ProvisioningError) throw error;
      throw new ProvisioningError(
        `the recorded Triggers of CodeCommit Repository ${logicalId} is not a list cdkd can ` +
          `read, and the triggers could not be read from CodeCommit instead — the repository ` +
          `was not updated`,
        resourceType,
        logicalId,
        repositoryName,
        error instanceof Error ? error : undefined
      );
    }
  }

  /**
   * The rename-retry probe's identity check (go-to-k/cdkd#4042,
   * go-to-k/cdkd#4051). The old name is gone; accept the repository holding
   * `newName` only when its id is one this resource is KNOWN to have: the
   * `RepositoryId` cdkd recorded for it (`UpdateContext.recordedAttributes`),
   * or the id this instance read just before starting the rename. A holder
   * with any other id is refused with nothing sent to it: adopting it would
   * overwrite its description, key, tags and triggers and record it as this
   * resource, which a later destroy deletes. With NO known id (a record from
   * before the attribute existed, and no rename started by this run) the
   * holder cannot be verified, so it is refused too, naming the manual
   * re-adoption.
   */
  private async verifyRenamedRepository(
    logicalId: string,
    resourceType: string,
    oldName: string,
    newName: string,
    recordedId: string | undefined
  ): Promise<void> {
    const known = [recordedId, this.renamesStarted.get(oldName)].filter(
      (id): id is string => id !== undefined
    );
    const holder = await this.getRepositoryMetadata(newName);
    // The id alone identifies the repository, whatever name it now holds.
    if (holder?.repositoryId !== undefined && known.includes(holder.repositoryId)) return;
    const intro =
      `CodeCommit Repository ${logicalId} no longer exists under the name cdkd recorded, and ` +
      `the repository holding the desired RepositoryName is not this resource's`;
    if (known.length > 0) {
      throw this.wrapNotThisRepositoryError(logicalId, resourceType, oldName, 'desired-name');
    }
    throw markNonRetryable(
      new ProvisioningError(
        `${intro} as far as cdkd can verify (its record holds no RepositoryId, and this run ` +
          `started no rename of this resource) — nothing was sent to that repository. If it is ` +
          `this resource's repository (an earlier deploy renamed it and stopped before ` +
          `recording the new name), first confirm it is yours (\`aws codecommit get-repository\` ` +
          `shows its id, ARN, description and creation date), and re-adopt it only then; ` +
          `otherwise choose a RepositoryName no other repository holds.\nRe-adopt with:\n` +
          // Unwrapped, on its own line, last; every value through the shared
          // gate (a hole when it cannot be printed exactly).
          pasteableCommand('cdkd import', [
            { hole: 'stack' },
            {
              flag: '--resource',
              value: `${logicalId}=${newName}`,
              hole: 'logicalId=repositoryName',
            },
            { literal: '--force' },
          ]).command,
        resourceType,
        logicalId,
        oldName
      )
    );
  }

  /**
   * The refusal for a repository whose id is KNOWN not to be this resource's
   * (go-to-k/cdkd#4042, go-to-k/cdkd#4051): nothing is sent to it, and no
   * re-adoption is offered. `which` names the repository by role, never by
   * name.
   */
  private wrapNotThisRepositoryError(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    which: 'recorded-name' | 'desired-name'
  ): ProvisioningError {
    // The remedy depends on WHICH name a foreign repository holds: a new
    // RepositoryName clears a collision on the desired name, but not one on the
    // recorded name, which every later update is addressed to.
    const remedy =
      which === 'desired-name'
        ? `The repository holding the desired RepositoryName is not this resource's (its ` +
          `repository id is not the one cdkd holds for this resource) — nothing was sent to ` +
          `that repository. If this resource's repository was renamed outside cdkd and you ` +
          `can find it, set RepositoryName to its current name: cdkd adopts it by the ` +
          `repository id it holds. If it was deleted outside cdkd, drop ` +
          `this resource's record and set RepositoryName to a name no repository holds, so the ` +
          `next deploy creates a new repository (fill in the resource's construct path):\n` +
          pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command
        : `The repository cdkd recorded for this resource no longer holds its recorded name ` +
          `(it was deleted or renamed outside cdkd), and the repository now holding that name ` +
          `is not this resource's (its repository id is not the one cdkd holds) — nothing was ` +
          `sent to that repository. Changing RepositoryName does not clear this. Leave that ` +
          `repository alone. If the recorded repository was renamed and you can find it, ` +
          `re-adopt it under its new name with cdkd import (--resource, --force) instead; ` +
          `otherwise drop this resource's record and set RepositoryName to a name no ` +
          `repository holds, so the next deploy creates a new repository (fill in the ` +
          `resource's construct path):\n` +
          pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command;
    return markNonRetryable(
      new ProvisioningError(
        `CodeCommit Repository ${logicalId}: ${remedy}`,
        resourceType,
        logicalId,
        physicalId
      )
    );
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
   *
   * `DeleteRepository` takes a NAME, so with a recorded `RepositoryId`
   * (`DeleteContext.recordedAttributes`, go-to-k/cdkd#4157) the repository
   * holding the name is read first and a holder with another id is REFUSED,
   * with nothing deleted: returning normally would drop the record while the
   * foreign repository stays, and deleting it destroys a repository the stack
   * never created. A read that cannot answer (a denied `GetRepository`)
   * proceeds and reports an `IndeterminateGuard`; a throttled one is retried.
   * A record with no `RepositoryId` keeps the historical by-name delete.
   */
  async delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    this.logger.debug(`Deleting CodeCommit Repository ${logicalId}: ${physicalId}`);

    const recordedId = recordedRepositoryId(context?.recordedAttributes);
    let guard: IndeterminateGuard | undefined;
    let deletedRepositoryId: string | undefined;
    try {
      if (recordedId !== undefined) {
        guard = await this.confirmDeleteTarget(logicalId, resourceType, physicalId, recordedId);
      }
      const response = await this.getClient().send(
        new DeleteRepositoryCommand({ repositoryName: physicalId })
      );
      deletedRepositoryId = response.repositoryId;
    } catch (error) {
      // The identity refusal: already named and marked non-retryable.
      if (error instanceof ProvisioningError) throw error;
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
        return withIndeterminateGuard(undefined, guard);
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
      return withIndeterminateGuard(undefined, guard);
    }
    this.logger.debug(`Successfully deleted CodeCommit Repository ${logicalId}`);
    return withIndeterminateGuard(undefined, guard);
  }

  /**
   * Before `DeleteRepository`, confirm the repository holding `physicalId` is
   * the recorded one (go-to-k/cdkd#4157). Three outcomes:
   *
   * - the recorded id, or the name held by nothing
   *   (`RepositoryDoesNotExistException`, rethrown to the idempotent arm):
   *   `undefined`, and the delete goes ahead;
   * - another id: THROWS a non-retryable refusal, and nothing is deleted;
   * - no answer (the read failed, or returned no id): the delete goes ahead
   *   and the guard is reported. A throttled or 5xx read is rethrown instead,
   *   so the caller's retry asks again.
   *
   * Name and id address the same repository only at the moment of the read:
   * CodeCommit has no delete-by-id, so a swap between the two calls is not
   * caught.
   */
  private async confirmDeleteTarget(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    recordedId: string
  ): Promise<IndeterminateGuard | undefined> {
    let holder: RepositoryMetadata | undefined;
    try {
      holder = await this.getRepositoryMetadata(physicalId);
    } catch (error) {
      if (
        error instanceof RepositoryDoesNotExistException ||
        isThrottlingError(error) ||
        isTransientServerError(error)
      ) {
        throw error;
      }
      // The class, never AWS's text (it quotes the caller's role and session).
      const failure = describeAwsFailure(error);
      this.logger.debug(
        `GetRepository failed while confirming CodeCommit Repository ${logicalId}: ${failure.detail}`
      );
      return this.proceedUnconfirmed(
        logicalId,
        `the repository could not be read to compare its id with the recorded one: ${failure.summary}`
      );
    }
    const liveId = holder?.repositoryId;
    if (liveId === undefined) {
      return this.proceedUnconfirmed(logicalId, 'GetRepository returned no repository id');
    }
    if (liveId === recordedId) return undefined;
    throw markNonRetryable(
      new ProvisioningError(
        `CodeCommit Repository ${logicalId}: the repository holding the name cdkd recorded for ` +
          `this resource is not this resource's (its repository id is not the one cdkd holds; ` +
          `the recorded repository was deleted or renamed outside cdkd) — cdkd did not delete ` +
          `it, and kept this resource's record. Leave that repository alone and drop the ` +
          `record, then re-run; a later deploy that creates this resource again needs a ` +
          `RepositoryName no repository holds (fill in the resource's construct path):\n` +
          pasteableCommand('cdkd orphan', [{ hole: 'constructPath' }]).command,
        resourceType,
        logicalId,
        physicalId
      )
    );
  }

  /** The proceed-anyway arm of {@link confirmDeleteTarget}, reported. */
  private proceedUnconfirmed(logicalId: string, reason: string): IndeterminateGuard {
    this.logger.warn(
      `Could not confirm that CodeCommit Repository ${logicalId} is the repository cdkd ` +
        `recorded: ${reason.replace(/[.\s]+$/, '')}. Proceeding with the delete.`
    );
    return { guard: CODECOMMIT_DELETE_IDENTITY_GUARD, reason };
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
   * as undefined / empty (docs/provider-rules.md#readcurrentstate-for-drift-detection). Omitting the key
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

    // No `aws:cdk:path` tag walk: AWS rejects `aws:`-prefixed tag writes, so
    // that tag never exists on a real resource and the walk could not match
    // (issue #1134). Auto-mode import resolves ids from CloudFormation's
    // DescribeStackResources or the template's physical-name property; a
    // repository reaching here needs an explicit `--resource` override.
    return null;
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
          `${describeAwsFailure(cleanupError).detail}`
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
