import {
  CloudFormationClient,
  DeleteStackCommand,
  waitUntilStackDeleteComplete,
} from '@aws-sdk/client-cloudformation';
import { getLogger } from '../../../utils/logger.js';
import { displaySafe, safeMsg } from '../../../utils/display-safe.js';
import { cfnFailureText } from './failure-text.js';

/**
 * Step 4 of the retirement {@link prepareCloudFormationStackRetirement}
 * describes: `DeleteStack`, after the caller has written cdkd state from the
 * physical ids CloudFormation holds once the Retain update completed. Every
 * resource carries `DeletionPolicy: Retain` by then, so CloudFormation deletes
 * only the stack record.
 */
export async function deleteRetiredCloudFormationStack(
  cfnStackName: string,
  cfnClient: CloudFormationClient
): Promise<void> {
  const logger = getLogger();
  logger.info(`[4/4] Deleting CloudFormation stack '${cfnStackName}' (resources retained)...`);
  try {
    await cfnClient.send(new DeleteStackCommand({ StackName: cfnStackName }));
    await waitUntilStackDeleteComplete(
      // Minutes-scale CFn operation: 10s polling is dense enough and stays
      // within the repo-wide waiter cap (issue #1291 item 5).
      { client: cfnClient, maxWaitTime: 1800, minDelay: 5, maxDelay: 10 },
      { StackName: cfnStackName }
    );
  } catch (err) {
    const error = new Error(
      safeMsg`CloudFormation stack ${displaySafe(cfnStackName)} was NOT confirmed deleted: ` +
        safeMsg`${cfnFailureText(err)}. cdkd state is written and correct, and every resource ` +
        `carries DeletionPolicy=Retain, so deleting the stack deletes no resource. Delete the ` +
        `stack by hand once its cause is resolved (for example an export another stack ` +
        `still imports).`
    );
    (error as Error & { cause?: unknown }).cause = err;
    throw error;
  }
  logger.info(
    `✓ CloudFormation stack '${cfnStackName}' retired. AWS resources are now ` +
      `solely managed by cdkd.`
  );
}
