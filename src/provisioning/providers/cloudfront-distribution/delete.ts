import type { CloudFrontDistributionProvider } from '../cloudfront-distribution-provider.js';
import { shownId, DEPENDENCY_MISSING_CLASS } from './shared.js';
import {
  UpdateDistributionCommand,
  DeleteDistributionCommand,
  GetDistributionCommand,
  GetDistributionConfigCommand,
  NoSuchDistribution,
} from '@aws-sdk/client-cloudfront';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markDeleteStarted } from '../../delete-started.js';
import { markNotGone } from '../../not-gone.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import { pasteableAwsCommand } from '../../replacement-protection-advice.js';
import { logicalIdShown } from '../../composite-id.js';
import { isPlainImportValue, VALUE_NOT_SHOWN } from '../../import-helpers.js';
import { commandHole } from '../../../utils/pasteable-command.js';

/**
 * Delete a CloudFront Distribution
 *
 * CloudFront requires distributions to be disabled before deletion.
 * Steps:
 * 1. Get current config + ETag
 * 2. If Enabled, update to Enabled=false and wait
 * 3. Delete with the latest ETag
 */
export async function deleteImpl(
  this: CloudFrontDistributionProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting CloudFront Distribution ${logicalId}: ${physicalId}`);
  // go-to-k/cdkd#4946: set once the disable is accepted, so a refused
  // `DeleteDistribution` is never read as a whole (serving) survivor.
  let stripped = false;

  try {
    // Step 1: Get current config
    let etag: string;
    let config;
    try {
      const getConfigResponse = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      etag = getConfigResponse.ETag!;
      config = getConfigResponse.DistributionConfig!;
    } catch (error) {
      if (error instanceof NoSuchDistribution) {
        const clientRegion = await this.cloudFrontClient.config.region();
        assertRegionMatch(
          clientRegion,
          context?.expectedRegion,
          resourceType,
          logicalId,
          physicalId
        );
        this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
        return;
      }
      throw error;
    }

    // Step 2: Disable the distribution if it is currently enabled
    if (config.Enabled) {
      this.logger.debug(`Disabling CloudFront Distribution ${physicalId} before deletion`);
      config.Enabled = false;

      const updateResponse = await this.cloudFrontClient.send(
        new UpdateDistributionCommand({
          Id: physicalId,
          IfMatch: etag,
          DistributionConfig: config,
        })
      );
      stripped = true;
      etag = updateResponse.ETag!;

      // Wait until the disable is fully propagated. We must check BOTH
      // Status==='Deployed' AND DistributionConfig.Enabled===false, because
      // CloudFront's read-after-write is eventually consistent: a GetDistribution
      // call made shortly after UpdateDistribution can still return the previous
      // (Enabled=true, Status=Deployed) snapshot, which would otherwise cause us
      // to exit the wait loop on the very first poll and fire DeleteDistribution
      // against an enabled distribution (yielding DistributionNotDisabled).
      const disabled = await this.waitForDistributionStable(physicalId, false);
      if (!disabled) {
        this.logger.warn(
          `Distribution ${shownId(physicalId)} disable did not settle (Deployed + disabled) within the wait budget; attempting delete anyway. ` +
            `If it fails with DistributionNotDisabled, retry the destroy or raise the budget with --resource-timeout AWS::CloudFront::Distribution=${commandHole('duration')}.`
        );
      }

      // Re-fetch ETag after waiting (state may have changed)
      const refreshResponse = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      etag = refreshResponse.ETag!;
    } else {
      // Already disabled — but the disable may still be PROPAGATING
      // (issue #1316): a prior interrupted destroy (or an out-of-band
      // console disable) flips the config to Enabled=false immediately
      // while Status stays InProgress for minutes, and DeleteDistribution
      // rejects until Status is Deployed ("has not been disabled"). Wait
      // for the same settled state the just-disabled arm waits for.
      const settled = await this.waitForDistributionStable(physicalId, false);
      if (!settled) {
        this.logger.warn(
          `Distribution ${shownId(physicalId)} is disabled but its propagation did not settle (Deployed) within the wait budget; attempting delete anyway. ` +
            `If it fails with DistributionNotDisabled, retry the destroy or raise the budget with --resource-timeout AWS::CloudFront::Distribution=${commandHole('duration')}.`
        );
      }

      // Re-fetch ETag after waiting (a completed propagation changes it)
      const refreshResponse = await this.cloudFrontClient.send(
        new GetDistributionConfigCommand({ Id: physicalId })
      );
      etag = refreshResponse.ETag!;
    }

    // Step 3: Delete the distribution
    await this.cloudFrontClient.send(
      new DeleteDistributionCommand({
        Id: physicalId,
        IfMatch: etag,
      })
    );

    this.logger.debug(`Successfully deleted CloudFront Distribution ${logicalId}`);
  } catch (error) {
    if (error instanceof NoSuchDistribution) {
      const clientRegion = await this.cloudFrontClient.config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Distribution ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    const failure = this.wrapCaughtError(
      context?.maskSecrets,
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete CloudFront Distribution ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
    // A missing-entity class here names a DEPENDENCY, never this distribution
    // (its own `NoSuchDistribution` returned above): the disable step's
    // `UpdateDistribution` answers `EntityNotFound`, `NoSuchCachePolicy`,
    // `NoSuchOrigin`, `TrustedKeyGroupDoesNotExist` and their siblings when a
    // referenced policy, function or key group is gone. The wrap carries the
    // class (or, unredacted, AWS's "does not exist" text), which satisfies the
    // "already deleted" classifiers' needles and would drop the record of a
    // live distribution, so mark it not gone: they check the marker first
    // (go-to-k/cdkd#5222, #5228). Retryability stays the retry classifiers'.
    if (error instanceof Error && DEPENDENCY_MISSING_CLASS.test(error.name)) {
      markNotGone(failure);
    }
    throw stripped ? markDeleteStarted(failure) : failure;
  }
}

/**
 * Settle a CloudFront Distribution according to the run's wait mode.
 *
 * cdkd does NOT wait for `Deployed` by default (issue #1282). Both
 * CloudFormation and Terraform (`wait_for_deployment`, default `true`) wait
 * here, so this is a deliberate divergence under the wait-semantics policy's
 * fast-side clause: every `Fn::GetAtt` (Id / DomainName) is final in the
 * Create/Update response so nothing in-deploy consumes `Deployed`, the wait
 * carries no failure signal (a distribution deploy cannot fail — a long
 * wait means slow edge propagation, not brokenness), and Terraform's
 * `wait_for_deployment` toggle keeps the benchmark comparison measurable in
 * both modes. `--full-wait` opts back into the CloudFormation behavior.
 */
export async function settleDistribution(
  this: CloudFrontDistributionProvider,
  logicalId: string,
  distributionId: string
): Promise<void> {
  if (process.env['CDKD_FULL_WAIT'] === 'true') {
    this.logger.debug(`Waiting for Distribution ${distributionId} to reach Deployed status...`);
    const stable = await this.waitForDistributionStable(distributionId);
    if (!stable) {
      // Unlike the ECS Service --full-wait timeout (which FAILS the deploy —
      // a never-stabilizing service signals a crash-looping rollout), a
      // CloudFront wait timeout only means propagation is slow, so failing
      // would hand auto-rollback a healthy distribution to disable-and-delete.
      // Warn and proceed instead.
      this.logger.warn(
        `CloudFront Distribution ${logicalIdShown(logicalId)} ${isPlainImportValue(distributionId) ? `(${distributionId})` : VALUE_NOT_SHOWN} did not reach Deployed within the wait budget; continuing (propagation finishes in the background). ` +
          `To wait manually: ${pasteableAwsCommand()`aws cloudfront wait distribution-deployed --id ${distributionId}`.render()}. ` +
          `Raise the budget with --resource-timeout AWS::CloudFront::Distribution=${commandHole('duration')}.`
      );
    }
    return;
  }

  // Mention --full-wait only when the invoking COMMAND actually declares it
  // (cdkd deploy sets CDKD_WAIT_FLAGS_AVAILABLE; `cdkd drift --revert`
  // reaches this same code through provider.update and does NOT — issue
  // #1291 pattern).
  const fullWaitHint =
    process.env['CDKD_WAIT_FLAGS_AVAILABLE'] === 'true' ? '; pass --full-wait to wait' : '';
  this.logger.info(
    `CloudFront Distribution ${logicalIdShown(logicalId)} accepted (not waiting for Deployed${fullWaitHint}). ` +
      `To wait manually: ${pasteableAwsCommand()`aws cloudfront wait distribution-deployed --id ${distributionId}`.render()}`
  );
}

/**
 * Poll until the distribution reports `Status: Deployed` (and, when
 * `expectedEnabled` is given, the matching `Enabled` value — the delete
 * path's disable-then-delete requirement).
 *
 * Returns `true` when the stable state was observed (or the wait was
 * interrupted by SIGINT — the caller is shutting down, so no timeout
 * warning applies), `false` on budget exhaustion.
 */
export async function waitForDistributionStable(
  this: CloudFrontDistributionProvider,
  distributionId: string,
  expectedEnabled?: boolean
): Promise<boolean> {
  // A CloudFront distribution reaches Deployed in ~3-6 min. The poll ramps
  // 5s * 1.5x but is capped tight (10s, not the old 30s) so detection lag
  // stays small — a sparse late poll is exactly what made cdkd trail
  // tight-polling tools on CloudFront-bound stacks (same class as the EC2
  // waiter fix). The ~20 min default budget is lifted by an explicit
  // `--resource-timeout` (per-type or global) so this inner waiter can never
  // undercut the outer per-resource deadline the same flag raises (issue
  // #1280) — but the flag never lowers it below the default.
  const budgetMs = Math.max(
    20 * 60 * 1000,
    resolvedResourceTimeoutMs('AWS::CloudFront::Distribution') ?? 0
  );
  const deadline = Date.now() + budgetMs;
  let delay = 5000; // start at 5s
  const maxDelay = 10000;
  let interrupted = false;

  const sigintHandler = () => {
    interrupted = true;
  };
  process.on('SIGINT', sigintHandler);

  try {
    while (Date.now() < deadline) {
      if (interrupted) {
        this.logger.debug(`Distribution ${distributionId} wait interrupted by SIGINT, proceeding`);
        return true;
      }

      let response;
      try {
        response = await this.cloudFrontClient.send(
          new GetDistributionCommand({ Id: distributionId })
        );
      } catch (error) {
        // A gone distribution is a terminal answer the caller must see (the
        // delete path's NotFound handling). Anything else (throttle, network
        // blip) must NOT escape: the wait has no failure signal by design,
        // and an escaped throw would fail an operation whose mutation
        // already succeeded — on create, the engine's outer retry would then
        // re-invoke create() over a distribution that already exists. Since
        // issue #2079 that no longer duplicates it (the CallerReference is
        // stable across attempts, so CloudFront refuses the replay), but the
        // refusal is a hard `DistributionAlreadyExists` failure over an
        // ORPHAN the user then has to delete by hand — still a failure this
        // wait must not manufacture. Log and keep polling; the deadline
        // bounds the loop either way.
        if (error instanceof NoSuchDistribution) throw error;
        this.logger.debug(
          `Distribution ${distributionId} status read failed (${describeAwsFailure(error).detail}); retrying`
        );
      }

      if (response) {
        const status = response.Distribution?.Status;
        const enabled = response.Distribution?.DistributionConfig?.Enabled;

        const enabledMatches = expectedEnabled === undefined || enabled === expectedEnabled;

        if (status === 'Deployed' && enabledMatches) {
          this.logger.debug(
            `Distribution ${distributionId} is stable (Status=Deployed, Enabled=${enabled})`
          );
          return true;
        }

        this.logger.debug(
          `Distribution ${distributionId} status: ${status}, enabled: ${enabled}` +
            (expectedEnabled === undefined ? '' : ` (waiting for Enabled=${expectedEnabled})`)
        );
      }

      // Interruptible sleep: check SIGINT every second
      const sleepEnd = Date.now() + delay;
      while (Date.now() < sleepEnd && !interrupted) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      delay = Math.min(delay * 1.5, maxDelay);
    }

    // A SIGINT that lands during the final sleep exits the loop via the
    // deadline check; it is still an interruption, not a timeout — return
    // true so the caller's timeout warning stays suppressed on shutdown.
    if (interrupted) {
      this.logger.debug(`Distribution ${distributionId} wait interrupted by SIGINT, proceeding`);
      return true;
    }

    this.logger.debug(
      `Distribution ${distributionId} did not reach stable state within timeout, proceeding with next step`
    );
    return false;
  } finally {
    process.removeListener('SIGINT', sigintHandler);
  }
}
