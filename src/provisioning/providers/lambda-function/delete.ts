import type { LambdaFunctionProvider } from '../lambda-function-provider.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import {
  UpdateFunctionConfigurationCommand,
  DeleteFunctionCommand,
  GetFunctionCommand,
  ResourceNotFoundException,
} from '@aws-sdk/client-lambda';
import {
  DescribeNetworkInterfacesCommand,
  DeleteNetworkInterfaceCommand,
} from '@aws-sdk/client-ec2';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { isRefusedByName, markDeleteStarted } from '../../delete-started.js';
import { markNotGone } from '../../not-gone.js';
import { enclosingDeadlineRemainingMs } from '../../../deployment/resource-deadline.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { safeMsg } from '../../../utils/display-safe.js';
import { createMaskedLogSinks, type MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * Delete a Lambda function
 *
 * For VPC-enabled Lambda functions, AWS detaches the hyperplane ENIs
 * asynchronously after DeleteFunction returns. If we let downstream
 * resource deletion (Subnet / SecurityGroup) proceed immediately, those
 * deletions fail with "has dependencies" / "has a dependent object".
 *
 * To smooth this out, when properties carry a VpcConfig with subnets or
 * security groups, we poll DescribeNetworkInterfaces for the function's
 * managed ENIs and only return once they are gone (or the timeout elapses).
 */
export async function deleteImpl(
  this: LambdaFunctionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting Lambda function ${logicalId}: ${physicalId}`);

  const hasVpcConfig = this.hasVpcConfig(properties?.['VpcConfig']);
  // go-to-k/cdkd#4946: set once the VPC detach may have landed, so a refused
  // `DeleteFunction` is never read as a whole survivor.
  let stripped = false;

  // For VPC-attached functions, detach the VPC config BEFORE deletion.
  // DeleteFunction does not synchronously release Lambda hyperplane ENIs;
  // AWS reclaims them eventually, often well past any reasonable wait
  // window. UpdateFunctionConfiguration with empty SubnetIds / SecurityGroupIds
  // triggers an explicit ENI release that completes in seconds-to-minutes,
  // letting downstream Subnet / SecurityGroup deletes proceed.
  if (hasVpcConfig) {
    try {
      stripped = true;
      await this.lambdaClient.send(
        new UpdateFunctionConfigurationCommand({
          FunctionName: physicalId,
          VpcConfig: { SubnetIds: [], SecurityGroupIds: [] },
        })
      );
      this.logger.debug(`Detached VPC config from Lambda ${physicalId} before deletion`);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        const clientRegion = await this.lambdaClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        // Function is already gone — nothing more to do, including ENI wait
        // (AWS owns the cleanup at this point).
        this.logFunctionGone(logicalId, physicalId, context);
        return;
      }
      // Best-effort: don't fail the entire delete if pre-detach errors.
      // The post-DeleteFunction ENI wait below remains as a safety net.
      // A swallowed failure may still have landed, unless AWS refused it by
      // name (go-to-k/cdkd#4946).
      if (isRefusedByName(error)) stripped = false;
      this.logger.warn(
        `Pre-delete VPC detach failed for ${physicalId}: ${
          describeAwsFailure(error).detail
        } — continuing with delete`
      );
    }

    // Wait for the UpdateFunctionConfiguration to fully apply before
    // calling DeleteFunction. Lambda processes the VPC detach
    // asynchronously: LastUpdateStatus transitions InProgress -> Successful,
    // and the hyperplane ENIs only flip from `in-use` to `available` once
    // that completes. Calling DeleteFunction while LastUpdateStatus is
    // still `InProgress` aborts the detach mid-flight, leaving ENIs
    // attached and blocking downstream Subnet / SG deletion.
    await this.waitForLambdaUpdateCompleted(physicalId);
  }

  try {
    await this.lambdaClient.send(new DeleteFunctionCommand({ FunctionName: physicalId }));
    this.logger.debug(`Successfully deleted Lambda function ${logicalId}`);
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      const clientRegion = await this.lambdaClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logFunctionGone(logicalId, physicalId, context);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const wrapped = this.wrapMaskedError(
      createMaskedLogSinks(this.logger, context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete Lambda function ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // The wrap names an AWS failure by its CLASS, and the delete classifiers
    // read `NotFoundException` in a message as "already deleted": only the
    // typed not-found above means this function is gone (go-to-k/cdkd#2319).
    const failure =
      error instanceof Error && error.name.includes('NotFound') ? markNotGone(wrapped) : wrapped;
    throw stripped ? markDeleteStarted(failure) : failure;
  }

  if (hasVpcConfig) {
    // The engine's own clock, read here rather than recomputed: it started
    // before this delete (a create-first replacement's create, an earlier
    // retry of this delete) and pauses for prompts. Infinity outside any
    // deadline (a rollback replay), leaving the per-ENI budget alone.
    await this.cleanupLambdaEnis(
      physicalId,
      Date.now() + enclosingDeadlineRemainingMs() - this.eniDeadlineMarginMs
    );
  }

  if (properties?.['CapacityProviderConfig'] !== undefined) {
    await this.waitForFunctionGone(
      { logicalId, resourceType, functionName: physicalId },
      createMaskedLogSinks(this.logger, context?.maskSecrets)
    );
  }
}

/**
 * A Managed Instances function stays `Deleting` after `DeleteFunction` (69s
 * measured, go-to-k/cdkd#5637). What is deleted next, and a create reusing the
 * name, would meet it. The delete has landed, so a read that fails only warns.
 * Expiry throws with `markDeleteStarted`: reporting a function gone while it is
 * not would release what depends on it, and the retry finds it not found.
 */
export async function waitForFunctionGone(
  this: LambdaFunctionProvider,
  target: { logicalId: string; resourceType: string; functionName: string },
  log: MaskedLogSinks
): Promise<void> {
  const { logicalId, resourceType, functionName } = target;
  const deadline =
    Date.now() +
    Math.min(
      this.functionUpdateMaxWaitSeconds * 1000,
      enclosingDeadlineRemainingMs() - this.latestPublishedDeadlineMarginMs
    );
  for (;;) {
    try {
      await this.lambdaClient.send(new GetFunctionCommand({ FunctionName: functionName }));
    } catch (error) {
      if (error instanceof ResourceNotFoundException) return;
      const failure = describeAwsFailure(error);
      log.debug(log.mask(`Waiting for Lambda function ${logicalId} to go: ${failure.detail}`));
      log.warn(`Waiting for Lambda function ${logicalId} to go failed: ${failure.summary}`);
      return;
    }
    if (Date.now() >= deadline) {
      const stillDeleting = new ProvisioningError(
        `Lambda function ${logicalId} is still being deleted`,
        resourceType,
        logicalId,
        functionName
      );
      markDeleteStarted(stillDeleting);
      throw stillDeleting;
    }
    await new Promise((resolve) => setTimeout(resolve, this.latestPublishedPollMs));
  }
}

/**
 * `deadline` is where the ENI phase must END (go-to-k/cdkd#5276): the engine
 * fails the whole delete at the per-resource deadline, so a give-up after it
 * never runs and a slow hyperplane ENI release fails the function's delete
 * instead of handing the ENI to the Subnet / SecurityGroup deletes.
 */
export async function cleanupLambdaEnis(
  this: LambdaFunctionProvider,
  functionName: string,
  deadline: number
): Promise<void> {
  this.logger.debug(`Cleaning up Lambda VPC ENIs for function ${functionName}`);

  // Mirror delstack's ENI cleanup pattern: an unconditional initial sleep
  // gives AWS time to register the post-detach ENI state in the API plane
  // (DescribeNetworkInterfaces can transiently return an empty list right
  // after UpdateFunctionConfiguration, even though ENIs still exist), then
  // delete each matched ENI in parallel with a per-ENI retry budget.
  await this.sleep(this.eniInitialSleepMs);

  let enis: { id: string; status: string }[] = [];
  try {
    enis = await this.listLambdaEnis(functionName);
  } catch (error) {
    this.logger.warn(
      `DescribeNetworkInterfaces failed for ${functionName}: ${
        describeAwsFailure(error).detail
      } — downstream Subnet/SG deletion will fall back to its own ENI cleanup`
    );
    return;
  }

  if (enis.length === 0) {
    this.logger.debug(`No Lambda ENIs found for ${functionName} after initial sleep`);
    return;
  }

  // Per-ENI parallel delete with retry. An in-use ENI cannot be deleted
  // until AWS finishes the asynchronous detach triggered by the prior
  // UpdateFunctionConfiguration; budget gives that detach time to land.
  await Promise.all(enis.map((eni) => this.deleteEniWithRetry(eni.id, functionName, deadline)));
}

export async function deleteEniWithRetry(
  this: LambdaFunctionProvider,
  eniId: string,
  functionName: string,
  deadline: number
): Promise<void> {
  const start = Date.now();
  const giveUpAt = Math.min(start + this.eniDeleteRetryBudgetMs, deadline);
  for (;;) {
    try {
      await this.ec2Client.send(new DeleteNetworkInterfaceCommand({ NetworkInterfaceId: eniId }));
      this.logger.debug(`Deleted Lambda ENI ${eniId} for ${functionName}`);
      return;
    } catch (error) {
      const msg = describeAwsFailure(error).detail;
      if (msg.includes('InvalidNetworkInterfaceID.NotFound') || msg.includes('does not exist')) {
        // Already gone — treat as success.
        return;
      }
      const now = Date.now();
      if (now >= giveUpAt) {
        this.logger.warn(
          `Gave up deleting ENI ${eniId} for ${functionName} after ${now - start}ms: ${msg} — ` +
            `downstream Subnet/SG deletion will retry`
        );
        return;
      }
      await this.sleep(Math.min(this.eniDeleteRetryIntervalMs, giveUpAt - now));
    }
  }
}

/**
 * List Lambda-managed ENIs for the given function, paginating through
 * DescribeNetworkInterfaces and filtering on Description.
 *
 * We filter directly on `description=AWS Lambda VPC ENI-*` (the EC2 API
 * supports `*` wildcards on this filter — same approach as delstack). An
 * earlier attempt narrowed with `requester-id=*:awslambda_*`, but real
 * Lambda hyperplane ENIs carry a RequesterId of the form
 * `AROAXXX...:<account-id>` (no literal "awslambda" substring), so that
 * filter matched nothing and the cleanup loop quietly listed zero ENIs.
 */
export async function listLambdaEnis(
  this: LambdaFunctionProvider,
  functionName: string
): Promise<{ id: string; status: string }[]> {
  const enis: { id: string; status: string }[] = [];
  const descriptionPrefix = 'AWS Lambda VPC ENI-';
  let nextToken: string | undefined;
  do {
    const resp = await this.ec2Client.send(
      new DescribeNetworkInterfacesCommand({
        Filters: [{ Name: 'description', Values: [`${descriptionPrefix}*`] }],
        NextToken: nextToken,
      })
    );

    for (const ni of resp.NetworkInterfaces ?? []) {
      const desc = ni.Description ?? '';
      if (!ni.NetworkInterfaceId || !desc.startsWith(descriptionPrefix)) {
        continue;
      }
      // The portion after `AWS Lambda VPC ENI-` is the function-name token
      // AWS uses on the ENI. It usually omits the CDK auto-generated 8-char
      // suffix at the end of the physical function name, so match by
      // checking that physicalId starts with `<token>-` (allowing the
      // suffix) or equals it exactly. This is hyphen-bounded so a function
      // named `fn` does NOT match an ENI whose token is `myfn`.
      const token = desc.slice(descriptionPrefix.length);
      if (functionName === token || functionName.startsWith(`${token}-`)) {
        enis.push({ id: ni.NetworkInterfaceId, status: ni.Status ?? 'unknown' });
      }
    }
    nextToken = resp.NextToken;
  } while (nextToken);
  return enis;
}

/**
 * The not-found arm of `delete`. A journaled failed-CREATE orphan already
 * gone settles with exit 0 (go-to-k/cdkd#4606), so it is said once at info;
 * a record's own delete keeps the quiet debug line. The name is interpolated
 * verbatim for the caller's printing bag to mask.
 */
export function logFunctionGone(
  this: LambdaFunctionProvider,
  logicalId: string,
  physicalId: string,
  context: DeleteContext | undefined
): void {
  if (context?.failedCreateOrphan === true) {
    this.logger.info(
      safeMsg`  Lambda function ${physicalId} (${logicalId}), which a failed deploy created, is already gone; nothing to delete`
    );
  } else {
    this.logger.debug(`Lambda function ${physicalId} does not exist, skipping deletion`);
  }
}
