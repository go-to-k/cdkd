import { CreateBudgetCommand } from '@aws-sdk/client-budgets';
import type { BudgetsBudgetProvider } from '../budgets-budget-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import { generateResourceName } from '../../resource-name.js';
import type { CreateContext, ResourceCreateResult } from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';

/**
 * Create a budget via `CreateBudget` (a single call carries the budget,
 * its notifications with subscribers, and resource tags — no post-create
 * wiring to clean up on partial failure).
 */
export async function create(
  this: BudgetsBudgetProvider,
  logicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  context?: CreateContext
): Promise<ResourceCreateResult> {
  // Issue #2178: `toSdkDate` quotes the offending `TimePeriod` value back at
  // the user, and `properties` arrives RESOLVED. Absent means unmasked, the
  // back-compatible default the SecretMaskingContext contract mandates.
  const mask = maskerOrIdentity(context?.maskSecrets);

  this.logger.debug(`Creating budget ${logicalId}`);

  const rawBudget = (properties['Budget'] ?? {}) as Record<string, unknown>;
  const rawName = rawBudget['BudgetName'];
  // A user-supplied BudgetName is a user contract: Budgets accepts nearly
  // every printable character except `:` and `\`, so it passes through
  // VERBATIM (no sanitize, no stack prefix) — running it through the name
  // generator would silently mutate names like "My Team Budget" and desync
  // the physical id from the template (breaking import's explicit-name
  // lookup). Only the logical-id fallback goes through the conservative
  // generator.
  const name =
    typeof rawName === 'string' && rawName.length > 0
      ? rawName
      : generateResourceName(logicalId, {
          maxLength: 100,
          allowedPattern: /[^a-zA-Z0-9\-_.]/g,
        });

  // go-to-k/cdkd#3989: refused before any call, so a malformed list never
  // creates a budget missing the alerts or tags the template declares.
  const lists = this.readDesiredLists(
    logicalId,
    resourceType,
    {
      NotificationsWithSubscribers: properties['NotificationsWithSubscribers'],
      ResourceTags: properties['ResourceTags'],
    },
    undefined
  );

  try {
    const accountId = await this.resolveAccountId();
    const notifications = this.toSdkNotificationsWithSubscribers(
      lists.NotificationsWithSubscribers
    );
    const resourceTags = this.toSdkResourceTags(lists.ResourceTags);
    // Read before CreateBudget, so nothing can fail once the budget exists
    // (go-to-k/cdkd#4583).
    const arn = await this.budgetArn(accountId, name);

    await this.getCreateClient().send(
      new CreateBudgetCommand({
        AccountId: accountId,
        Budget: this.toSdkBudget(properties['Budget'], name, logicalId, resourceType, mask),
        ...(notifications.length > 0 && { NotificationsWithSubscribers: notifications }),
        ...(resourceTags.length > 0 && { ResourceTags: resourceTags }),
      })
    );

    this.logger.debug(`Successfully created budget ${logicalId}: ${name}`);
    return {
      physicalId: name,
      attributes: {
        Arn: arn,
      },
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw this.wrapBudgetError(mask, error, 'create', logicalId, resourceType, undefined);
  }
}
