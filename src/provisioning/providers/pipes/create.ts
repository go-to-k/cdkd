import type { PipesPipeProvider } from '../pipes-provider.js';
import {
  CreatePipeCommand,
  DeletePipeCommand,
  NotFoundException,
  type DescribePipeCommandOutput,
  type PipeEnrichmentParameters,
  type PipeLogConfigurationParameters,
} from '@aws-sdk/client-pipes';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markCreatedBeforeFailure } from '../../auxiliary-failure.js';
import { reportCreatedResource, retractCreatedResource } from '../../created-resource-sink.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { generatedNameFor } from '../../resource-name.js';
import { maskerOrIdentity, type MaskerFn } from '../../masked-retry-logger.js';
import { waitForGoneAfterDelete } from '../../delete-gone-wait.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { orphanCommandRegionArg } from '../orphan-report.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import {
  PIPE_CLEANUP_MAX_WAIT_MS,
  PIPE_POLL_INTERVAL_MS,
  PIPE_TYPE,
  deleteFailureClassifier,
  desiredTagMap,
  pipeIdentityToken,
  toSdkSourceParameters,
  toSdkTargetParameters,
} from './shared.js';

export async function create(
  this: PipesPipeProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  const mask = maskerOrIdentity(context?.maskSecrets);
  // Pipe names: 1-64 chars of [.\-_A-Za-z0-9]. generateResourceName's
  // stack-prefixed output keeps to that charset and `maxLength` caps it.
  const name =
    (properties['Name'] as string | undefined) ?? generatedNameFor('AWS::Pipes::Pipe', logicalId);
  const tags = desiredTagMap(properties['Tags'], logicalId);
  this.logger.debug(mask(`Creating Pipe ${logicalId}: ${name}`));

  // go-to-k/cdkd#4606: the token a failed settle's mark carries, from
  // CreatePipe's own answer: a settle that failed because DescribePipe
  // cannot run fails the engine's journaling-time read too.
  let createdIdentity: string | undefined;
  try {
    const created = await this.getCreateClient().send(
      new CreatePipeCommand({
        Name: name,
        RoleArn: properties['RoleArn'] as string,
        Source: properties['Source'] as string,
        Target: properties['Target'] as string,
        ...(properties['Description'] !== undefined && {
          Description: properties['Description'] as string,
        }),
        ...(properties['DesiredState'] !== undefined && {
          DesiredState: properties['DesiredState'] as 'RUNNING' | 'STOPPED',
        }),
        ...(properties['SourceParameters'] !== undefined && {
          SourceParameters: toSdkSourceParameters(properties['SourceParameters']),
        }),
        ...(properties['Enrichment'] !== undefined && {
          Enrichment: properties['Enrichment'] as string,
        }),
        ...(properties['EnrichmentParameters'] !== undefined && {
          EnrichmentParameters: properties['EnrichmentParameters'] as PipeEnrichmentParameters,
        }),
        ...(properties['TargetParameters'] !== undefined && {
          TargetParameters: toSdkTargetParameters(properties['TargetParameters']),
        }),
        ...(properties['LogConfiguration'] !== undefined && {
          LogConfiguration: properties['LogConfiguration'] as PipeLogConfigurationParameters,
        }),
        ...(properties['KmsKeyIdentifier'] !== undefined && {
          KmsKeyIdentifier: properties['KmsKeyIdentifier'] as string,
        }),
        ...(Object.keys(tags).length > 0 && { Tags: tags }),
      })
    );
    createdIdentity = pipeIdentityToken(name, created?.Arn, created?.CreationTime);
    // go-to-k/cdkd#5511: reported before the settle wait.
    reportCreatedResource(logicalId, resourceType, name, createdIdentity);
  } catch (error) {
    const cause = error instanceof Error ? error : undefined;
    // AWS echoes resolved inputs into its text: masked like the settle
    // reason (`waitForSettled`).
    throw this.wrapCaughtError(
      mask,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to create Pipe ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          undefined,
          cause
        )
    );
  }

  // The pipe now EXISTS. A failed settle (a *_FAILED state, the cap, a
  // Ctrl-C) would otherwise leave it alive with nothing recorded: invisible
  // to `cdkd destroy`, and holding the name the next deploy creates.
  let settled: DescribePipeCommandOutput;
  try {
    settled = await this.waitForSettled(name, logicalId, resourceType, 'create', mask);
  } catch (error) {
    throw await this.retireFailedCreate(
      name,
      logicalId,
      resourceType,
      error,
      mask,
      createdIdentity
    );
  }
  return { physicalId: name, attributes: this.attributesOf(settled) };
}

/**
 * After `CreatePipe` succeeded and the settle wait failed: delete the pipe
 * so it does not survive unrecorded, then return the ORIGINAL error (an
 * AWS-authored one wrapped first), extended with what happened to the pipe.
 * The gone wait is SHORT (a failed create must not also spend the full
 * delete wait), so the message claims the pipe is gone only when a read
 * confirmed it.
 */
export async function retireFailedCreate(
  this: PipesPipeProvider,
  name: string,
  logicalId: string,
  resourceType: string,
  error: unknown,
  mask: MaskerFn,
  createdIdentity: string | undefined
): Promise<Error> {
  // A settle read can rethrow an AWS-authored failure (a denied
  // DescribePipe), whose text names the caller: wrap it like the CreatePipe
  // failure (go-to-k/cdkd#2319) so the notes below join a message that
  // carries its class, not AWS's text. cdkd's own settle errors stay as
  // they are.
  const original = describeAwsFailure(error).redacted
    ? this.wrapCaughtError(
        mask,
        error,
        (text) =>
          new ProvisioningError(
            `Failed to create Pipe ${logicalId}: ${text}`,
            resourceType,
            logicalId,
            name,
            error instanceof Error ? error : undefined
          )
      )
    : (error as Error);
  // go-to-k/cdkd#4583: CreatePipe returned, so `name` (the id delete() takes)
  // is this create's pipe; name it for the failed-CREATE journal whenever it
  // may still be there, with CreatePipe's identity token (#4606). Terminal:
  // the pipe left behind holds the name, so a replayed CreatePipe can only
  // collide with it, and the engine's retry (an AccessDenied settle read
  // matches its IAM-propagation pattern) would replace this message, and
  // the delete advice in it, with "already exists".
  const leftBehind = (): Error =>
    markNonRetryable(
      markCreatedBeforeFailure(original, logicalId, resourceType, name, createdIdentity)
    );
  // The pipe survives, live and journaled: say so and how to delete it,
  // named with the client's region (the name alone would address a
  // same-named pipe in the profile's default region).
  const orphaned = async (why: string): Promise<Error> => {
    const aws = pasteableAwsCommand(mask);
    const region = await orphanCommandRegionArg(this.getClient(), aws);
    const command = aws`aws pipes delete-pipe --name ${name}${region}`;
    original.message +=
      ` (cdkd could not delete the pipe it had created: ${why}; outside a rollback's re-create, the failed deploy's rollback ` +
      `journal records it for \`cdkd rollback --revert-failed\`. ` +
      (command.text !== undefined
        ? `Otherwise delete it yourself with: ${command.text})`
        : `Otherwise delete it yourself from the EventBridge Pipes console.)`);
    return leftBehind();
  };
  try {
    await this.getClient().send(new DeletePipeCommand({ Name: name }));
  } catch (cleanupError) {
    if (cleanupError instanceof NotFoundException) {
      retractCreatedResource(logicalId, resourceType, name);
      return original;
    }
    return orphaned(describeAwsFailure(cleanupError).summary);
  }
  let gone = false;
  let sawDeleting = false;
  try {
    await waitForGoneAfterDelete({
      what: `Pipe ${name}`,
      resourceType: PIPE_TYPE,
      describe: async () => {
        const state = await this.readStateForDelete(name);
        if (state === undefined) gone = true;
        if (state === 'DELETING') sawDeleting = true;
        return state;
      },
      failedStatus: deleteFailureClassifier(PIPE_TYPE, logicalId, name),
      logger: this.logger,
      pollIntervalMs: PIPE_POLL_INTERVAL_MS,
      maxWaitMs: PIPE_CLEANUP_MAX_WAIT_MS,
      sleep: this.sleep,
      now: this.now,
    });
  } catch {
    // Only a terminal delete state throws here: AWS will not finish it.
    return orphaned('its delete did not complete (AWS reports a failed or rolled-back delete)');
  }
  if (gone) {
    retractCreatedResource(logicalId, resourceType, name);
    original.message += ' (cdkd deleted the pipe it had created, so nothing is left behind)';
    return original;
  }
  // Not confirmed gone: the wait ended on its cap, a Ctrl-C (which can mean
  // no read at all), or a status read that failed. Only a DELETING read
  // shows the delete progressing; without one, cdkd cannot say it did.
  if (sawDeleting) {
    retractCreatedResource(logicalId, resourceType, name);
    original.message +=
      ' (cdkd started deleting the pipe it had created; a re-deploy may report the ' +
      'name in use until AWS finishes)';
    return original;
  }
  const aws = pasteableAwsCommand(mask);
  const region = await orphanCommandRegionArg(this.getClient(), aws);
  const describe = aws`aws pipes describe-pipe --name ${name}${region}`;
  const remove = aws`aws pipes delete-pipe --name ${name}${region}`;
  original.message +=
    ' (cdkd asked AWS to delete the pipe it had created but could not confirm the delete ' +
    'progressed; ' +
    (describe.text !== undefined && remove.text !== undefined
      ? // No backticks around the command: pasted, they would run it.
        `if ${describe.text} still shows it, delete it with: ${remove.text})`
      : 'if the EventBridge Pipes console still shows it, delete it there.)');
  return leftBehind();
}
