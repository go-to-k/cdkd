import {
  DescribeInstanceAttributeCommand,
  ModifyInstanceAttributeCommand,
  type EC2Client,
} from '@aws-sdk/client-ec2';
import { describeAwsFailure } from '../utils/aws-failure-text.js';
import type { Logger } from '../types/config.js';
import {
  observeThenDisableProtection,
  type ProtectionFlipRecord,
  type ProtectionGuardSite,
} from './providers/deletion-protection-compensation.js';
import { pasteableAwsCommand } from './replacement-protection-advice.js';

/** Minimal logger surface used here (avoids coupling to the full Logger type). */
type DebugLogger = { debug(message: string): void };

/**
 * Shared EC2 instance termination-protection helpers, used by BOTH the SDK
 * `EC2Provider.deleteInstance` path and the Cloud Control `delete` path (an
 * `AWS::EC2::Instance` routes through Cloud Control whenever its template trips
 * the #614 silent-drop routing, so the protection flip-off must live on both
 * delete paths).
 *
 * The core problem: `destroy --remove-protection` flips `DisableApiTermination`
 * off (`ModifyInstanceAttribute`) and then deletes the instance, but AWS's
 * modify WRITE lags the terminate READ — empirically a manual modify reports
 * success while `describe-instance-attribute` still reads `true` for ~25s, yet
 * a terminate immediately after succeeds. cdkd's fast SDK path outruns the
 * propagation window (same family as the IAM / Route53 eventual-consistency
 * races), so the terminate / Cloud Control delete 400s with "The instance ...
 * may not be terminated. Modify its 'disableApiTermination' instance attribute
 * and try again." Callers re-flip + retry the delete to close the window.
 */

/** Number of delete attempts (incl. the first) when racing the flip-off propagation. */
export const TERMINATION_PROTECTION_MAX_ATTEMPTS = 5;

/**
 * Flip `DisableApiTermination` off on an instance. Idempotent — EC2 accepts the
 * call when the attribute is already false. Non-fatal: a NotFound (already
 * gone) or any other error is swallowed at debug so the actual delete still
 * proceeds (it will surface the real failure if the instance truly cannot be
 * deleted). Resolves `true` when the flip was accepted and `false` when it was
 * swallowed, for a caller that retries only the instances not yet flipped.
 */
export async function disableInstanceApiTermination(
  client: EC2Client,
  instanceId: string,
  logger: DebugLogger
): Promise<boolean> {
  try {
    await client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        DisableApiTermination: { Value: false },
      })
    );
    logger.debug(`Disabled DisableApiTermination on EC2 Instance ${instanceId} before deletion`);
    return true;
  } catch (flipError) {
    logger.debug(
      `Could not disable DisableApiTermination on ${instanceId}: ${describeAwsFailure(flipError).detail}`
    );
    return false;
  }
}

/**
 * Does this error message indicate the terminate / delete raced the
 * `DisableApiTermination` flip-off propagation (so re-flipping + retrying is
 * the right move)? Matches both the SDK `TerminateInstances` 400 and the Cloud
 * Control `DeleteResource` wrapper of the same underlying EC2 error.
 */
export function isTerminationProtectionPropagationError(message: string): boolean {
  return /may not be terminated|disableApiTermination/i.test(message);
}

/**
 * The FIRST flip-off of a delete, through the compensation mechanism
 * (issue #2204): read `DisableApiTermination` first, then flip it off, and
 * record the flip on `flip` only when the read saw it ON and EC2 accepted the
 * flip. Both delete routes call this once, before their first delete attempt,
 * and pass what it resolves — whether the read saw the guard ON — to
 * {@link reDisableInstanceApiTermination} for every propagation-race re-flip:
 * a first flip that was swallowed leaves the record unset, and a re-flip that
 * then lands is what turned the guard off.
 *
 * Non-fatal like the flip it wraps: a failed read is "do not know" (nothing is
 * recorded), and a swallowed flip-off records nothing and lets the delete
 * surface the real failure.
 */
export async function observeThenDisableInstanceApiTermination(
  client: EC2Client,
  instanceId: string,
  flip: ProtectionFlipRecord,
  logger: Logger
): Promise<boolean> {
  let observedOn = false;
  try {
    await observeThenDisableProtection({
      flip,
      logger,
      physicalId: instanceId,
      guardName: 'DisableApiTermination',
      observe: async () => {
        const response = await client.send(
          new DescribeInstanceAttributeCommand({
            InstanceId: instanceId,
            Attribute: 'disableApiTermination',
          })
        );
        observedOn = response.DisableApiTermination?.Value === true;
        return observedOn;
      },
      disable: async () => {
        if (!(await disableInstanceApiTermination(client, instanceId, logger))) {
          // Already logged at debug by the flip itself; this only tells
          // `observeThenDisableProtection` not to record a flip that did not land.
          throw new Error('the DisableApiTermination flip-off was not accepted');
        }
      },
    });
  } catch {
    // The flip-off was not accepted: nothing recorded, the delete proceeds.
  }
  return observedOn;
}

/**
 * A propagation-race re-flip: {@link disableInstanceApiTermination}, plus the
 * record latch when the pre-flip read saw the guard ON (`observedOn`, from
 * {@link observeThenDisableInstanceApiTermination}) and this re-flip landed.
 */
export async function reDisableInstanceApiTermination(
  client: EC2Client,
  instanceId: string,
  flip: ProtectionFlipRecord,
  observedOn: boolean,
  logger: Logger
): Promise<void> {
  if ((await disableInstanceApiTermination(client, instanceId, logger)) && observedOn) {
    flip.flippedOffByThisRun = true;
  }
}

/**
 * The compensating write: turn `DisableApiTermination` back ON. Throws on
 * failure, which `compensateProtectionFlip` turns into the secondary log line.
 */
export async function reEnableInstanceApiTermination(
  client: EC2Client,
  instanceId: string
): Promise<void> {
  await client.send(
    new ModifyInstanceAttributeCommand({
      InstanceId: instanceId,
      DisableApiTermination: { Value: true },
    })
  );
}

/**
 * The {@link ProtectionGuardSite} for an `AWS::EC2::Instance`, shared by the
 * SDK and the Cloud Control delete routes.
 */
export function ec2InstanceProtectionSite(
  instanceId: string,
  region: string | undefined
): ProtectionGuardSite {
  return {
    subject: 'EC2 Instance',
    guardName: 'DisableApiTermination',
    noun: 'instance',
    isNotFound: (error) =>
      typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'InvalidInstanceID.NotFound',
    notFoundMeaning:
      'EC2 answered InvalidInstanceID.NotFound. That most commonly means the instance is ' +
      'gone, and it can also mean it is not in this region or account.',
    commands: () => {
      const aws = pasteableAwsCommand();
      const regionArg = region ? aws` --region ${region}` : aws``;
      const restore = aws`aws ec2 modify-instance-attribute --instance-id ${instanceId}${regionArg} --disable-api-termination`;
      return {
        check:
          aws`aws ec2 describe-instance-attribute --instance-id ${instanceId}${regionArg} --attribute disableApiTermination`.render(),
        restoreAfterNotFound: restore.render(),
        restoreLive: restore.render(),
      };
    },
  };
}
