import {
  CodeBuildClient,
  type CreateProjectCommandInput,
  type ProjectSource,
} from '@aws-sdk/client-codebuild';
import { getLogger, type ConsoleLogger } from '../../utils/logger.js';
import type { ProvisioningError } from '../../utils/error-handler.js';
import type { DeleteContext } from '../region-check.js';
import type {
  ResourceProvider,
  ResourceCreateResult,
  ResourceUpdateResult,
  UpdateContext,
  CreateContext,
  ResourceImportInput,
  ResourceImportResult,
  ResourceNotFound,
} from '../../types/resource.js';
import { ambientClientDefaults } from '../../utils/ambient-client-defaults.js';
import { ambientRegion } from '../../utils/stack-aws-scope.js';
import { withoutServerErrorRetries } from './ambiguous-create.js';
import { describeAwsFailure } from '../../utils/aws-failure-text.js';
import {
  markRedactedCause,
  relayedNameCollision,
  wrapMaskedAwsError,
} from '../../deployment/retryable-errors.js';
import type { MaskerFn } from '../masked-retry-logger.js';
import {
  relayedConnectionRace,
  type TriggersRead,
  type VisibilityRead,
} from './codebuild/shared.js';
import { mapSource, mapArtifacts, mapProperties } from './codebuild/map-properties.js';
import { create, createWebhook, createWebhookOnNewProject } from './codebuild/create.js';
import { reconcileWebhook, applyVisibility, update } from './codebuild/update.js';
import { deleteImpl } from './codebuild/delete.js';
import { readCurrentState, importImpl } from './codebuild/read-state.js';

/**
 * SDK Provider for AWS CodeBuild resources
 *
 * Supports:
 * - AWS::CodeBuild::Project
 *
 * CodeBuild CreateProject/UpdateProject are synchronous - the CC API adds
 * unnecessary polling overhead for operations that complete immediately.
 */
export class CodeBuildProvider implements ResourceProvider {
  private client: CodeBuildClient | undefined;
  private createClient: CodeBuildClient | undefined;
  private readonly providerRegion = ambientRegion();
  logger: ConsoleLogger = getLogger().child('CodeBuildProvider');

  /**
   * `AWS::CodeBuild::Project` is `ProvisioningType: NON_PROVISIONABLE` — Cloud
   * Control has no handlers for it — so the #614 SDK-unwired auto-route must
   * not send a template using an unhandled property to CC, where it
   * fails mid-deploy with an opaque UnsupportedActionException. With this
   * opt-out the registry refuses such a template pre-flight (issue #3866).
   */
  readonly disableCcApiFallback = true;

  handledProperties = new Map<string, ReadonlySet<string>>([
    [
      'AWS::CodeBuild::Project',
      new Set([
        'Name',
        'Source',
        'Environment',
        'ServiceRole',
        'Artifacts',
        'Tags',
        'Description',
        'TimeoutInMinutes',
        'QueuedTimeoutInMinutes',
        'EncryptionKey',
        'Cache',
        'VpcConfig',
        'LogsConfig',
        'ConcurrentBuildLimit',
        'SecondaryArtifacts',
        'SecondarySources',
        'SecondarySourceVersions',
        'FileSystemLocations',
        'BuildBatchConfig',
        'BadgeEnabled',
        'SourceVersion',
        'AutoRetryLimit',
        // go-to-k/cdkd#2762: through `UpdateProjectVisibility`, see
        // `applyVisibility`.
        'Visibility',
        'ResourceAccessRole',
        // go-to-k/cdkd#5627: through the webhook calls, see `readTriggers`.
        'Triggers',
      ]),
    ],
  ]);

  getClient(): CodeBuildClient {
    if (!this.client) {
      // Built together with the create client, so both capture the identity
      // active at this ONE call (issue #4639).
      this.client = new CodeBuildClient({
        ...ambientClientDefaults(),
        ...(this.providerRegion ? { region: this.providerRegion } : {}),
      });
      this.createClient = withoutServerErrorRetries(
        new CodeBuildClient({
          ...ambientClientDefaults(),
          ...(this.providerRegion ? { region: this.providerRegion } : {}),
        })
      );
    }
    return this.client;
  }

  /**
   * The client `CreateProject` goes through: SDK retries on, except a 5xx
   * (`withoutServerErrorRetries`, issue #4639). Separate so every other call
   * keeps the full SDK retry.
   *
   * `CreateProject` carries no idempotency token and a project name is unique
   * per account and region, so the SDK's own replay of a 5xx whose request had
   * succeeded collides with the project the first send made, and that
   * `ResourceAlreadyExistsException` surfaced from the engine's FIRST attempt
   * as a name somebody else holds. Refused here, the 5xx reaches the deploy
   * engine's retry, which marks the create as possibly replayed (`withRetry`,
   * #3978). Nothing is adopted on that collision: a name is not attribution
   * (`docs/provider-rules.md`, "Adopt only on EXACT attribution").
   */
  getCreateClient(): CodeBuildClient {
    this.getClient();
    return this.createClient as CodeBuildClient;
  }

  mapSource(source: Record<string, unknown> | undefined, containerPath: string): ProjectSource {
    return mapSource.call(this, source, containerPath);
  }

  mapArtifacts(
    artifacts: Record<string, unknown> | undefined,
    containerPath: string
  ): ReturnType<typeof mapArtifacts> {
    return mapArtifacts.call(this, artifacts, containerPath);
  }

  mapProperties(
    undeclaredName: () => string,
    properties: Record<string, unknown>
  ): CreateProjectCommandInput {
    return mapProperties.call(this, undeclaredName, properties);
  }

  create(
    logicalId: string,
    resourceType: string,
    properties: Record<string, unknown>,
    context?: CreateContext
  ): Promise<ResourceCreateResult> {
    return create.call(this, logicalId, resourceType, properties, context);
  }

  createWebhook(
    projectName: string,
    read: Extract<TriggersRead, { kind: 'enabled' }>
  ): Promise<void> {
    return createWebhook.call(this, projectName, read);
  }

  createWebhookOnNewProject(
    projectName: string,
    read: Extract<TriggersRead, { kind: 'enabled' }>
  ): Promise<void> {
    return createWebhookOnNewProject.call(this, projectName, read);
  }

  sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  reconcileWebhook(projectName: string, read: TriggersRead, liveWebhook: boolean): Promise<void> {
    return reconcileWebhook.call(this, projectName, read, liveWebhook);
  }

  applyVisibility(
    projectArn: string,
    read: Extract<VisibilityRead, { kind: 'usable' }>
  ): Promise<void> {
    return applyVisibility.call(this, projectArn, read);
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
   * recognises the collision. A non-`Error` throw is withheld the same way,
   * unstamped: it has no chain.
   *
   * A cdkd-authored or transport error keeps its text, masked, stamped exactly
   * when the mask changed it (`wrapMaskedAwsError`, issue #4244). The delete
   * tests its typed not-found before it wraps.
   *
   * `build` must thread `error` as `cause`, and runs twice, so it must stay a
   * side-effect-free constructor call. `retryConnectionRace` opts in to
   * {@link relayedConnectionRace}: the paths where running the operation again
   * is safe and the service role is in play.
   */
  wrapCaughtError(
    mask: MaskerFn,
    error: unknown,
    build: (text: string) => ProvisioningError,
    retryConnectionRace: boolean
  ): ProvisioningError {
    const failure = describeAwsFailure(error);
    if (!failure.redacted) return wrapMaskedAwsError(mask, error, build);
    this.logger.debug(mask(build(mask(failure.detail)).message));
    const wrapped = build(
      `${mask(failure.summary)}${relayedNameCollision(failure.detail)}` +
        (retryConnectionRace ? relayedConnectionRace(error, failure.detail) : '')
    );
    return error instanceof Error ? markRedactedCause(wrapped) : wrapped;
  }

  delete(
    logicalId: string,
    physicalId: string,
    resourceType: string,
    _properties?: Record<string, unknown>,
    context?: DeleteContext
  ): Promise<void> {
    return deleteImpl.call(this, logicalId, physicalId, resourceType, _properties, context);
  }

  getAttribute(
    _physicalId: string,
    _resourceType: string,
    attributeName: string
  ): Promise<unknown> {
    // Arn is stored in attributes during create
    return Promise.resolve(attributeName);
  }

  readCurrentState(
    physicalId: string,
    _logicalId: string,
    _resourceType: string
  ): Promise<Record<string, unknown> | ResourceNotFound | undefined> {
    return readCurrentState.call(this, physicalId, _logicalId, _resourceType);
  }

  getDriftUnknownPaths(): string[] {
    return [
      // `readCurrentState` deliberately does NOT reverse-map `Source.Auth`:
      // BatchGetProjects echoes the source-credential block back only
      // partially, so emitting a partial shape would fire phantom drift on
      // every project that sets it (issue #1386). Declaring it here is the
      // repo's mechanism for "state key the provider can never read back" —
      // without it, a baseline that falls back to `properties` (an imported
      // project, or a failed observed capture) reports permanent drift on it.
      'Source.Auth',
      // Write-only in the CloudFormation schema. `project.webhook` is readable
      // but not in the declared shape: AWS fills in `excludeMatchedPattern`,
      // `buildType` and a default `pullRequestBuildPolicy`, and a removed
      // `Triggers` keeps the webhook (go-to-k/cdkd#5627).
      'Triggers',
    ];
  }

  import(input: ResourceImportInput): Promise<ResourceImportResult | null> {
    return importImpl.call(this, input);
  }
}
