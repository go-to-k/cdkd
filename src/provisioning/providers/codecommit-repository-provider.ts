import {
  CodeCommitClient,
  GetRepositoryCommand,
  type RepositoryMetadata,
  type RepositoryTrigger,
} from '@aws-sdk/client-codecommit';
import { S3Client } from '@aws-sdk/client-s3';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  IndeterminateGuard,
  ResourceDeleteResult,
  ResourceProvider,
  CreateContext,
  ResourceCreateResult,
  ResourceUpdateResult,
  ResourceImportInput,
  ResourceImportResult,
  UpdateContext,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { definedAttributes } from '../attribute-map.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { isAuxiliaryFailure } from '../auxiliary-failure.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import { s3ClientDefaults } from '../../utils/s3-client-defaults.js';
import { create, seedInitialCommit, bestEffortDelete } from './codecommit-repository/create.js';
import {
  update,
  readDesiredLists,
  assertRecordedHolder,
  wrapHolderReadError,
  readLiveTriggers,
  verifyRenamedRepository,
  wrapNotThisRepositoryError,
} from './codecommit-repository/update.js';
import {
  deleteImpl,
  confirmDeleteTarget,
  proceedUnconfirmed,
} from './codecommit-repository/delete.js';
import { readCurrentState, importImpl } from './codecommit-repository/read-state.js';
import type { CfnCode, RepoListKind } from './codecommit-repository/shared.js';

export { RECORDED_IDENTITY_DELETE_GUARD } from './codecommit-repository/shared.js';

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
  private createClient?: CodeCommitClient;
  private s3Client?: S3Client;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('CodeCommitRepositoryProvider');
  /**
   * Renames this provider instance STARTED, keyed by the old name, with the
   * repository id read just before the rename (go-to-k/cdkd#4042): the
   * same-run evidence a retry's probe accepts beside the recorded
   * `RepositoryId` (`UpdateContext.recordedAttributes`, go-to-k/cdkd#4051),
   * and the only evidence for a record that holds none. The deploy engine's
   * retry re-invokes `update()` on this same instance.
   */
  readonly renamesStarted = new Map<string, string>();

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

  getClient(): CodeCommitClient {
    if (!this.client) {
      this.client = new CodeCommitClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
    }
    return this.client;
  }

  /**
   * The client `CreateRepository` and the seed `CreateCommit` go through: SDK
   * retries on, except a 5xx (`withoutServerErrorRetries`, issue #2080).
   * Separate so every other call keeps the full SDK retry.
   *
   * Neither call carries an idempotency token, but neither can DUPLICATE: a
   * repository name is unique per account and region, and a `CreateCommit`
   * without a parent commit is refused once the branch exists. What the SDK's
   * own replay of a 5xx whose request had succeeded does instead is FAIL the
   * replay where cdkd cannot see why -- a `RepositoryNameExistsException`
   * read as somebody else's repository, or a `ParentCommitIdRequiredException`
   * that is not retried, after `create()`'s post-create catch has deleted
   * the repository.
   * Refused here, the 5xx reaches the deploy engine's retry, which marks the
   * create as possibly replayed: a later name collision is then never
   * credited to another holder (`withRetry`, #3978), and a failed seed
   * commit, its repository deleted by that catch, is created again.
   */
  getCreateClient(): CodeCommitClient {
    if (!this.createClient) {
      this.createClient = withoutServerErrorRetries(
        new CodeCommitClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.createClient;
  }

  getS3Client(): S3Client {
    if (!this.s3Client) {
      this.s3Client = new S3Client({
        ...ambientClientDefaults(),
        ...s3ClientDefaults(),
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
  toAttributes(metadata: RepositoryMetadata | undefined): Record<string, unknown> {
    return definedAttributes({
      Arn: metadata?.Arn,
      CloneUrlHttp: metadata?.cloneUrlHttp,
      CloneUrlSsh: metadata?.cloneUrlSsh,
      Name: metadata?.repositoryName,
      KmsKeyId: metadata?.kmsKeyId,
      RepositoryId: metadata?.repositoryId,
    });
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  update(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    previousProperties: Record<string, unknown>,
    context?: UpdateContext
  ): Promise<ResourceUpdateResult> {
    return update.call(
      this,
      logicalId,
      physicalId,
      resourceType,
      properties,
      previousProperties,
      context
    );
  }

  readDesiredLists(
    logicalId: string,
    resourceType: string,
    values: Record<RepoListKind, unknown>,
    physicalId: string | undefined
  ): Record<RepoListKind, Record<string, unknown>[]> {
    return readDesiredLists.call(this, logicalId, resourceType, values, physicalId);
  }

  assertRecordedHolder(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    recordedId: string,
    mask: MaskerFn
  ): Promise<void> {
    return assertRecordedHolder.call(this, logicalId, resourceType, physicalId, recordedId, mask);
  }

  /**
   * The failure wrap the create / update / delete catches throw.
   *
   * An AWS-authored failure reaches `build` as its CLASS plus the `--verbose`
   * pointer (go-to-k/cdkd#2319): a thrown message is persisted to
   * `deployments/{runId}.jsonl`, and an `AccessDeniedException` names the
   * caller's assumed-role ARN. AWS's own text goes to `debug` through `mask`,
   * and the wrap is stamped `markRedactedCause`, so the retry classifiers read
   * the withheld text on the `cause` chain. An "already exists" is restated
   * ({@link relayedNameCollision}), except from a post-create step's failure
   * ({@link markAuxiliaryFailure}), where "it" would read as the repository. A
   * non-`Error` throw is withheld the same way, unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4259). The delete
   * checks `RepositoryDoesNotExistException` by type before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (maskedText: string) => ProvisioningError
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const relay = isAuxiliaryFailure(error) ? '' : relayedNameCollision(failure.detail);
    const wrapped = build(`${mask(failure.summary)}${relay}`);
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  wrapHolderReadError(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    error: unknown,
    mask: MaskerFn
  ): ProvisioningError {
    return wrapHolderReadError.call(this, logicalId, resourceType, physicalId, error, mask);
  }

  readLiveTriggers(
    logicalId: string,
    repositoryName: string,
    renamedTo: string | undefined,
    recordedId: string | undefined,
    resourceType: string
  ): Promise<RepositoryTrigger[]> {
    return readLiveTriggers.call(
      this,
      logicalId,
      repositoryName,
      renamedTo,
      recordedId,
      resourceType
    );
  }

  verifyRenamedRepository(
    logicalId: string,
    resourceType: string,
    oldName: string,
    newName: string,
    recordedId: string | undefined
  ): Promise<void> {
    return verifyRenamedRepository.call(
      this,
      logicalId,
      resourceType,
      oldName,
      newName,
      recordedId
    );
  }

  wrapNotThisRepositoryError(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    which: 'recorded-name' | 'desired-name'
  ): ProvisioningError {
    return wrapNotThisRepositoryError.call(this, logicalId, resourceType, physicalId, which);
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void | ResourceDeleteResult> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  confirmDeleteTarget(
    logicalId: string,
    resourceType: string,
    physicalId: string,
    recordedId: string,
    mask: MaskerFn
  ): Promise<IndeterminateGuard | undefined> {
    return confirmDeleteTarget.call(this, logicalId, resourceType, physicalId, recordedId, mask);
  }

  proceedUnconfirmed(logicalId: string, reason: string): IndeterminateGuard {
    return proceedUnconfirmed.call(this, logicalId, reason);
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

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
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

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }

  seedInitialCommit(repositoryName: string, code: CfnCode): Promise<void> {
    return seedInitialCommit.call(this, repositoryName, code);
  }

  bestEffortDelete(repositoryName: string, mask: MaskerFn): Promise<boolean> {
    return bestEffortDelete.call(this, repositoryName, mask);
  }

  /**
   * Fetch the repository's metadata via `GetRepository`. Throws
   * `RepositoryDoesNotExistException` through to the caller.
   */
  async getRepositoryMetadata(repositoryName: string): Promise<RepositoryMetadata | undefined> {
    const resp = await this.getClient().send(new GetRepositoryCommand({ repositoryName }));
    return resp.repositoryMetadata;
  }
}
