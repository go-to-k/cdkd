import { DeleteBudgetCommand, NotFoundException } from '@aws-sdk/client-budgets';
import type { BudgetsBudgetProvider } from '../budgets-budget-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { assertRegionMatch, type DeleteContext } from '../../region-check.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';

/**
 * Delete a budget (`DeleteBudget` also deletes all of its notifications
 * and subscribers). NotFound is idempotent success — after the standard
 * region assertion (see the class doc for why the guard stays uniform
 * even though the Budgets namespace is global).
 */
export async function deleteImpl(
  this: BudgetsBudgetProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  _properties?: Record<string, unknown>,
  context?: DeleteContext
): Promise<void> {
  this.logger.debug(`Deleting budget ${logicalId}: ${physicalId}`);

  try {
    const accountId = await this.resolveAccountId();
    await this.getClient().send(
      new DeleteBudgetCommand({ AccountId: accountId, BudgetName: physicalId })
    );
    this.logger.debug(`Successfully deleted budget ${logicalId}`);
  } catch (error) {
    if (error instanceof NotFoundException) {
      const clientRegion = await this.getClient().config.region();
      assertRegionMatch(clientRegion, context?.expectedRegion, resourceType, logicalId, physicalId);
      this.logger.debug(`Budget ${physicalId} does not exist, skipping deletion`);
      return;
    }
    const cause = error instanceof Error ? error : undefined;
    throw this.wrapMaskedError(
      maskerOrIdentity(context?.maskSecrets),
      error,
      (text) =>
        new ProvisioningError(
          `Failed to delete budget ${logicalId}: ${text}`,
          resourceType,
          logicalId,
          physicalId,
          cause
        )
    );
  }
}
