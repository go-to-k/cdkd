import { ModifyInstanceAttributeCommand, type EC2Client } from '@aws-sdk/client-ec2';

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
 * deleted).
 */
export async function disableInstanceApiTermination(
  client: EC2Client,
  instanceId: string,
  logger: DebugLogger
): Promise<void> {
  try {
    await client.send(
      new ModifyInstanceAttributeCommand({
        InstanceId: instanceId,
        DisableApiTermination: { Value: false },
      })
    );
    logger.debug(`Disabled DisableApiTermination on EC2 Instance ${instanceId} before deletion`);
  } catch (flipError) {
    logger.debug(
      `Could not disable DisableApiTermination on ${instanceId}: ${flipError instanceof Error ? flipError.message : String(flipError)}`
    );
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
