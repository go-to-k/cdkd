import { deleteSignalReceiver } from '../../../deployment/deploy-engine/signal-receiver.js';
import type { DeleteResourceFrame } from './delete-resource.js';

/**
 * A finished destroy's last step: the stack's CloudFormation signal receiver
 * (go-to-k/cdkd#6705; best-effort, a failure warns with the delete-stack
 * command), then the state record. `true` once the record is deleted.
 */
export async function deleteStateAndReceiver(
  frame: Pick<DeleteResourceFrame, 'ctx' | 'state' | 'stackName' | 'logger' | 'destroyAwsClients'>,
  region: string
): Promise<true> {
  const { ctx, state, stackName, logger } = frame;
  if (typeof state.signalReceiverStackId === 'string') {
    await deleteSignalReceiver(
      (frame.destroyAwsClients ?? ctx.baseAwsClients).cloudFormation,
      state.signalReceiverStackId,
      logger
    );
  }
  await ctx.stateBackend.deleteState(stackName, region);
  logger.debug('State deleted');
  return true;
}
