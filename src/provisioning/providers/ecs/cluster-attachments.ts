import { DescribeClustersCommand, type Cluster, type ECSClient } from '@aws-sdk/client-ecs';
import { isDeepStrictEqual } from 'node:util';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { logicalIdShown } from '../../composite-id.js';
import { commandHole } from '../../../utils/pasteable-command.js';
import { resolvedResourceTimeoutMs } from '../../resource-timeout-registry.js';
import { startInterruptWatch } from '../../interrupt-watch.js';
import type { MaskedLogSinks } from '../../masked-retry-logger.js';

/**
 * go-to-k/cdkd#6562: `PutClusterCapacityProviders` leaves the cluster's
 * attachments `UPDATE_IN_PROGRESS` for a few seconds, and ECS refuses the
 * next cluster write meanwhile — `UpdateCluster` with a `ServerException`
 * ("Service Unavailable"), another `PutClusterCapacityProviders` with
 * `UpdateInProgressException` ("Cluster attachments must be in
 * UPDATE_COMPLETE or UPDATE_FAILED state before they can be updated").
 * Both were observed on a real cluster. CloudFormation waits; so does cdkd,
 * but only where a write follows a write: no Describe is sent on an update
 * that sends no `PutClusterCapacityProviders`.
 */

/** Test seam: tests replace `sleep` to skip the poll interval and `now` to drive the deadline. */
export const clusterAttachmentsWait = {
  sleep: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

const CLUSTER_TYPE = 'AWS::ECS::Cluster';
const IN_PROGRESS = 'UPDATE_IN_PROGRESS';

/** The ECS error names a cluster write answers with while its attachments are updating. */
const BUSY_ERROR_NAMES = new Set(['UpdateInProgressException', 'ServerException']);

/**
 * Whether the template's capacity-provider members differ from the previous
 * side. `isDeepStrictEqual` ignores key order, so a readback-borne previous
 * side (`drift --revert`) spelling the same strategy entries in another order
 * compares equal; any other difference — an absent previous key included —
 * sends the Put, so the rollback replay and `drift --revert` (whose two sides
 * differ exactly where AWS must be put back) still restore the providers.
 */
export function capacityProvidersChanged(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>
): boolean {
  return (
    !isDeepStrictEqual(
      previousProperties['CapacityProviders'] ?? null,
      properties['CapacityProviders'] ?? null
    ) ||
    !isDeepStrictEqual(
      previousProperties['DefaultCapacityProviderStrategy'] ?? null,
      properties['DefaultCapacityProviderStrategy'] ?? null
    )
  );
}

/**
 * Whether a previous side held a NON-EMPTY capacity-provider member: a
 * template declaring neither then clears both, as CloudFormation does. An
 * empty or absent previous member has nothing to clear, so a readback-borne
 * `[]` never costs a Put.
 */
export function heldCapacityProviders(previousProperties: Record<string, unknown>): boolean {
  const held = (value: unknown): boolean => Array.isArray(value) && value.length > 0;
  return (
    held(previousProperties['CapacityProviders']) ||
    held(previousProperties['DefaultCapacityProviderStrategy'])
  );
}

async function describeAttachments(
  client: ECSClient,
  cluster: string
): Promise<Cluster | undefined> {
  const out = await client.send(
    new DescribeClustersCommand({ clusters: [cluster], include: ['ATTACHMENTS'] })
  );
  return out?.clusters?.[0];
}

async function attachmentsStatus(client: ECSClient, cluster: string): Promise<string | undefined> {
  return (await describeAttachments(client, cluster))?.attachmentsStatus;
}

/**
 * Wait until the cluster's attachments leave `UPDATE_IN_PROGRESS`. The cap is
 * 600s (the ECS waits' floor), lifted — never lowered — by an explicit
 * `--resource-timeout AWS::ECS::Cluster=...`; Ctrl-C ends it through the
 * shared interrupt watch. Returns the cluster as it settled (`UPDATE_FAILED`
 * included: ECS accepts the next write then, so only the caller that sent the
 * Put decides whether it failed).
 */
export async function waitForClusterAttachments(
  client: ECSClient,
  logicalId: string,
  cluster: string,
  log: MaskedLogSinks
): Promise<Cluster | undefined> {
  const maxWaitSeconds = Math.max(600, (resolvedResourceTimeoutMs(CLUSTER_TYPE) ?? 0) / 1000);
  const deadline = clusterAttachmentsWait.now() + maxWaitSeconds * 1000;
  const watch = startInterruptWatch(`ECS cluster ${logicalId} attachments wait`);
  let delay = 1_000;
  try {
    for (;;) {
      const described = await describeAttachments(client, cluster);
      if (described?.attachmentsStatus !== IN_PROGRESS) return described;
      if (clusterAttachmentsWait.now() >= deadline) {
        // Non-retryable: a deploy-engine retry would re-run this same wait.
        throw markNonRetryable(
          new ProvisioningError(
            `ECS cluster ${logicalIdShown(logicalId)}'s capacity provider attachments were still ${IN_PROGRESS} after ${maxWaitSeconds}s. ` +
              `Re-run once they settle, or raise the limit with --resource-timeout ${CLUSTER_TYPE}=${commandHole('duration')}.`,
            CLUSTER_TYPE,
            logicalId,
            cluster
          )
        );
      }
      if (watch.isInterrupted()) throw watch.onInterrupted();
      log.debug(`ECS cluster ${log.value(cluster)} attachments ${IN_PROGRESS}; waiting ${delay}ms`);
      await clusterAttachmentsWait.sleep(delay);
      if (watch.isInterrupted()) throw watch.onInterrupted();
      delay = Math.min(delay * 2, 5_000);
    }
  } finally {
    watch.dispose();
  }
}

/**
 * Send one cluster write; when ECS refuses it as busy AND the cluster's
 * attachments confirm `UPDATE_IN_PROGRESS`, wait them out and send it again.
 * Any other failure — or a busy-looking one over settled attachments — is
 * rethrown unchanged, so a genuine `ServerException` still reaches the deploy
 * engine's own retry. The happy path sends nothing extra.
 */
export async function sendWhenAttachmentsSettle<T>(
  client: ECSClient,
  logicalId: string,
  cluster: string,
  log: MaskedLogSinks,
  write: () => Promise<T>
): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await write();
    } catch (error) {
      const name = error instanceof Error ? error.name : undefined;
      if (attempt >= 3 || name === undefined || !BUSY_ERROR_NAMES.has(name)) throw error;
      // A failed read keeps the write's own error, not the read's.
      const status = await attachmentsStatus(client, cluster).catch(() => undefined);
      if (status !== IN_PROGRESS) throw error;
      log.debug(
        `ECS cluster ${log.value(cluster)} refused a write with ${name} while its attachments update; waiting`
      );
      await waitForClusterAttachments(client, logicalId, cluster, log);
    }
  }
}

/** How many 1s re-reads a Put that never showed `UPDATE_IN_PROGRESS` gets before a FAILED counts as stale. */
const OWN_PUT_GRACE_READS = 3;

/** Attachment statuses that can mean the Put itself failed (a Put creates, updates and deletes attachments). */
const FAILED_ATTACHMENT = /^(CREATE|UPDATE|DELETE)_FAILED$|^FAILED$/;

/**
 * The wait after a `PutClusterCapacityProviders` THIS update sent, seeded
 * with the Put response's own cluster (measured: it reports
 * `UPDATE_IN_PROGRESS`, and so does a Describe sent right after it).
 *
 * `UPDATE_FAILED` fails the update only when it belongs to this Put: after
 * `UPDATE_IN_PROGRESS` was seen in the response or by a read here. A cluster a
 * PREVIOUS Put left `UPDATE_FAILED` that never shows in-progress within
 * {@link OWN_PUT_GRACE_READS} re-reads is stale: warned, not thrown, so a
 * corrected template is not refused over the broken one's attachments. A
 * rollback replay meeting a failure of its own Put fails that resource,
 * naming AWS's reason.
 */
export async function waitForOwnCapacityProviderPut(
  client: ECSClient,
  logicalId: string,
  cluster: string,
  log: MaskedLogSinks,
  putCluster: Cluster | undefined
): Promise<void> {
  let sawInProgress = putCluster?.attachmentsStatus === IN_PROGRESS;
  if (!sawInProgress) {
    for (let read = 0; ; read++) {
      const status = await attachmentsStatus(client, cluster);
      if (status === IN_PROGRESS) {
        sawInProgress = true;
        break;
      }
      if (status !== 'UPDATE_FAILED') return;
      if (read >= OWN_PUT_GRACE_READS) {
        log.warn(
          `ECS cluster ${log.value(cluster)} still reports UPDATE_FAILED attachments from before this update's PutClusterCapacityProviders, which never showed UPDATE_IN_PROGRESS; continuing`
        );
        return;
      }
      await clusterAttachmentsWait.sleep(1_000);
    }
  }
  const settled = await waitForClusterAttachments(client, logicalId, cluster, log);
  if (settled?.attachmentsStatus !== 'UPDATE_FAILED') return;
  // Only the attachments this Put touched (its response lists them), else
  // any whose status says a create / update / delete failed.
  const touched = new Set(
    (putCluster?.attachments ?? []).map((a) => a.id).filter((id): id is string => Boolean(id))
  );
  const failed = (settled.attachments ?? [])
    .filter((a) => FAILED_ATTACHMENT.test(a.status ?? ''))
    .filter((a) => touched.size === 0 || (a.id !== undefined && touched.has(a.id)))
    .map((a) => {
      const details = (a.details ?? []).map((d) => `${d.name ?? '?'}=${d.value ?? ''}`).join(', ');
      return `${a.type ?? 'attachment'} ${a.id ?? ''} ${a.status ?? ''}${details ? ` (${details})` : ''}`.trim();
    });
  const reason = failed.length > 0 ? `: ${log.mask(failed.join('; '))}` : '';
  throw markNonRetryable(
    new ProvisioningError(
      `ECS cluster ${logicalIdShown(logicalId)} (${log.value(cluster)}): PutClusterCapacityProviders ended with the capacity provider attachments UPDATE_FAILED${reason}. ` +
        'Check the capacity providers the template names (an Auto Scaling group provider needs its group and the ECS service-linked role), fix them, then re-run.',
      CLUSTER_TYPE,
      logicalId,
      cluster
    )
  );
}
