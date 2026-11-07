import { CreateProjectCommand, CreateWebhookCommand } from '@aws-sdk/client-codebuild';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { ResourceCreateResult, CreateContext } from '../../../types/resource.js';
import {
  isAmbiguousOutcomeError,
  isRetryableTransientError,
  markNonRetryable,
} from '../../../deployment/retryable-errors.js';
import { markAuxiliaryFailure, markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource } from '../../created-resource-sink.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { generatedNameFor } from '../../resource-name.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import type { CodeBuildProvider } from '../codebuild-provider.js';
import {
  DEFAULT_PROJECT_VISIBILITY,
  readVisibility,
  NEW_PROJECT_WEBHOOK_ATTEMPTS,
  NEW_PROJECT_WEBHOOK_RETRY_BASE_MS,
  type TriggersRead,
  readTriggers,
} from './shared.js';

export async function create(
  this: CodeBuildProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  this.logger.debug(`Creating CodeBuild Project ${logicalId}`);
  const mask = maskerOrIdentity(context?.maskSecrets);

  // go-to-k/cdkd#2762: the visibility call runs AFTER `CreateProject`, so an
  // unusable value is refused before it, where nothing exists yet. A state
  // replay leaves the project at the default (PRIVATE, no role) with a
  // warning instead of refusing the restore: the narrower exposure.
  const visibilityRead = readVisibility(properties, mask);
  if (visibilityRead.kind === 'unusable') {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(visibilityRead.reason, resourceType, logicalId);
    }
    this.logger.warn(
      mask(
        `${visibilityRead.reason}. Replaying a state record, so CodeBuild Project ${logicalId} ` +
          `is left ${DEFAULT_PROJECT_VISIBILITY} with no resource access role rather than ` +
          `refusing the restore`
      )
    );
  }

  // go-to-k/cdkd#5627: the same shape for the webhook, whose call also runs
  // after `CreateProject`. A replay gets no webhook and a warning.
  const triggersRead = readTriggers(properties, mask);
  if (triggersRead.kind === 'unusable') {
    if (context?.replayingState !== true) {
      throw new ProvisioningError(triggersRead.reason, resourceType, logicalId);
    }
    this.logger.warn(
      mask(
        `${triggersRead.reason}. Replaying a state record, so CodeBuild Project ${logicalId} ` +
          `gets no webhook rather than refusing the restore`
      )
    );
  }

  // Set once CreateProject returns: a later failure is the webhook or
  // visibility call's, against a project no state record will hold.
  let createdName: string | undefined;
  try {
    // go-to-k/cdkd#5095: an un-named project gets the generated name a
    // stack with an instance id gives every type; a legacy stack keeps the
    // bare logical id it always sent.
    const input = this.mapProperties(
      () => generatedNameFor('AWS::CodeBuild::Project', logicalId),
      properties
    );

    const result = await this.getCreateClient().send(new CreateProjectCommand(input));

    const projectName = result.project!.name!;
    const projectArn = result.project!.arn!;
    createdName = projectName;
    // go-to-k/cdkd#5511: report before the visibility call.
    reportCreatedResource(logicalId, resourceType, createdName);

    if (triggersRead.kind === 'enabled') {
      await this.createWebhookOnNewProject(projectName, triggersRead);
    }

    // Only a declaration other than the default needs the call: a new
    // project is already PRIVATE with no role.
    if (
      visibilityRead.kind === 'usable' &&
      (visibilityRead.visibility !== DEFAULT_PROJECT_VISIBILITY ||
        visibilityRead.resourceAccessRole !== undefined)
    ) {
      await this.applyVisibility(projectArn, visibilityRead);
    }

    this.logger.debug(`Successfully created CodeBuild Project ${logicalId}: ${projectName}`);

    return {
      physicalId: projectName,
      attributes: {
        Arn: projectArn,
      },
    };
  } catch (error) {
    if (createdName !== undefined) markAuxiliaryFailure(error, logicalId);
    const cause = error instanceof Error ? error : undefined;
    // Past `CreateProject` a retry of `create()` collides with the project it
    // made, so only that call's connection race may read as retryable.
    const thrown = this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create CodeBuild Project ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        ),
      createdName === undefined
    );
    // The project exists and no state record will hold it, so name it for
    // the failed-CREATE journal — only once CreateProject returned.
    if (createdName !== undefined) {
      markCreatedBeforeFailure(thrown, logicalId, resourceType, createdName);
    }
    throw thrown;
  }
}

/**
 * `CreateWebhook` (go-to-k/cdkd#5627), on the create client: it carries no
 * idempotency token, so the SDK's replay of a 5xx whose request had succeeded
 * answers `ResourceAlreadyExistsException` (the `getCreateClient` hazard).
 * The answer is discarded unread: it can hold the webhook's secret.
 */
export async function createWebhook(
  this: CodeBuildProvider,
  projectName: string,
  read: Extract<TriggersRead, { kind: 'enabled' }>
): Promise<void> {
  await this.getCreateClient().send(
    new CreateWebhookCommand({
      projectName,
      ...(read.filterGroups !== undefined && { filterGroups: read.filterGroups }),
      ...(read.buildType !== undefined && { buildType: read.buildType }),
      ...(read.scopeConfiguration !== undefined && {
        scopeConfiguration: read.scopeConfiguration,
      }),
      ...(read.pullRequestBuildPolicy !== undefined && {
        pullRequestBuildPolicy: read.pullRequestBuildPolicy,
      }),
    })
  );
}

/**
 * `CreateWebhook` inside `create()`, retried HERE (go-to-k/cdkd#5627). The
 * project exists by now, so a retry of `create()` would collide with it and
 * never reach the webhook: every failure leaves this loop marked terminal.
 * Four runs on a just-created role never failed this call, because
 * `CreateProject` had already waited out the role, so the loop covers a 5xx or
 * a throttle rather than a measured race.
 *
 * A new project has no webhook, so `ResourceAlreadyExistsException` after an
 * AMBIGUOUS attempt means that attempt landed. After a throttle or a denial,
 * which did nothing, it is a real failure.
 */
export async function createWebhookOnNewProject(
  this: CodeBuildProvider,
  projectName: string,
  read: Extract<TriggersRead, { kind: 'enabled' }>
): Promise<void> {
  const watch = startInterruptWatch(`The webhook of CodeBuild Project ${projectName}`);
  let mayHaveLanded = false;
  try {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.createWebhook(projectName, read);
        return;
      } catch (error) {
        if (!(error instanceof Error)) throw error;
        if (mayHaveLanded && error.name === 'ResourceAlreadyExistsException') return;
        const ambiguous = isAmbiguousOutcomeError(error);
        mayHaveLanded ||= ambiguous;
        const retryable = ambiguous || isRetryableTransientError(error, error.message);
        if (!retryable || attempt === NEW_PROJECT_WEBHOOK_ATTEMPTS) {
          throw markNonRetryable(error);
        }
        // A second apart at most, as `withRetry` probes.
        let remaining = NEW_PROJECT_WEBHOOK_RETRY_BASE_MS * 2 ** (attempt - 1);
        while (remaining > 0) {
          if (watch.isInterrupted()) throw watch.onInterrupted();
          const chunk = Math.min(1_000, remaining);
          await this.sleep(chunk);
          remaining -= chunk;
        }
        if (watch.isInterrupted()) throw watch.onInterrupted();
      }
    }
  } finally {
    watch.dispose();
  }
}
