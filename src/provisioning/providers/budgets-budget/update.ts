import {
  UpdateBudgetCommand,
  CreateNotificationCommand,
  DeleteNotificationCommand,
  CreateSubscriberCommand,
  DeleteSubscriberCommand,
  TagResourceCommand,
  UntagResourceCommand,
  NotFoundException,
  DuplicateRecordException,
  type Notification,
  type NotificationWithSubscribers,
  type ResourceTag,
  type Subscriber,
} from '@aws-sdk/client-budgets';
import type { BudgetsBudgetProvider } from '../budgets-budget-provider.js';
import { ProvisioningError } from '../../../utils/error-handler.js';
import type { ResourceUpdateResult, UpdateContext } from '../../../types/resource.js';
import { maskerOrIdentity } from '../../masked-retry-logger.js';
import { markNonRetryable } from '../../../deployment/retryable-errors.js';
import { safeMsg } from '../../../utils/display-safe.js';
import {
  BUDGET_LIST_WHAT,
  readBudgetList,
  removableRecorded,
  type BudgetListKind,
} from './shared.js';

/**
 * Update a budget: `UpdateBudget` for the budget definition, then
 * reconcile `NotificationsWithSubscribers` in place (CloudFormation would
 * replace the whole budget instead) and diff `ResourceTags`.
 */
export async function update(
  this: BudgetsBudgetProvider,
  logicalId: string,
  physicalId: string,
  resourceType: string,
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context?: UpdateContext
): Promise<ResourceUpdateResult> {
  // Issue #2178: same refusal, same bag, so the same sink (see `create`).
  const mask = maskerOrIdentity(context?.maskSecrets);

  this.logger.debug(`Updating budget ${logicalId}: ${physicalId}`);

  // go-to-k/cdkd#3989: a malformed desired list is refused before any call.
  const next = this.readDesiredLists(
    logicalId,
    resourceType,
    {
      NotificationsWithSubscribers: properties['NotificationsWithSubscribers'],
      ResourceTags: properties['ResourceTags'],
    },
    physicalId
  );
  const prevNotifications = readBudgetList(
    'NotificationsWithSubscribers',
    previousProperties['NotificationsWithSubscribers'],
    'recorded'
  );
  const prevTags = readBudgetList('ResourceTags', previousProperties['ResourceTags'], 'recorded');

  try {
    const accountId = await this.resolveAccountId();

    // The physical id is the budget name: a rename is classified as
    // replacement upstream (replacement-rules.ts), so `physicalId` is the
    // authoritative name here.
    await this.getClient().send(
      new UpdateBudgetCommand({
        AccountId: accountId,
        NewBudget: this.toSdkBudget(
          properties['Budget'],
          physicalId,
          logicalId,
          resourceType,
          mask
        ),
      })
    );

    const newNotifications = this.toSdkNotificationsWithSubscribers(
      next.NotificationsWithSubscribers
    );
    if (prevNotifications.kind === 'list') {
      await this.reconcileNotifications(
        accountId,
        physicalId,
        this.toSdkNotificationsWithSubscribers(
          removableRecorded('NotificationsWithSubscribers', prevNotifications.items)
        ),
        newNotifications
      );
    } else {
      try {
        await this.addNotificationsOnly(accountId, physicalId, newNotifications);
      } catch (error) {
        // Nothing was deleted first, so the budget's existing notifications
        // still count toward its limits (5 notifications, 10 email
        // subscribers each): name what was being added beside them.
        const cause = error instanceof Error ? error : undefined;
        throw this.wrapMaskedError(
          mask,
          error,
          (text) =>
            new ProvisioningError(
              `Failed to update budget ${logicalId}: adding ${newNotifications.length} desired ` +
                `notification(s) beside every notification the budget already holds (the recorded ` +
                `NotificationsWithSubscribers is not a list cdkd can read, so none was deleted; a ` +
                `budget allows at most 5 notifications and 10 email subscribers each): ${text}`,
              resourceType,
              logicalId,
              physicalId,
              cause
            )
        );
      }
      this.logger.warn(
        safeMsg`The recorded NotificationsWithSubscribers of budget ${logicalId} is not a list cdkd can read, so cdkd deleted no notification or subscriber and only added the desired ones. Delete any the template no longer names yourself.`
      );
    }

    const newTags = this.toSdkResourceTags(next.ResourceTags);
    if (prevTags.kind === 'list') {
      await this.reconcileResourceTags(
        accountId,
        physicalId,
        this.toSdkResourceTags(removableRecorded('ResourceTags', prevTags.items)),
        newTags
      );
    } else {
      if (newTags.length > 0) {
        await this.getClient().send(
          new TagResourceCommand({
            ResourceARN: await this.budgetArn(accountId, physicalId),
            ResourceTags: newTags,
          })
        );
      }
      this.logger.warn(
        safeMsg`The recorded ResourceTags of budget ${logicalId} is not a list cdkd can read, so cdkd removed no tag and only applied the desired ones. Untag any key the template no longer names yourself.`
      );
    }

    this.logger.debug(`Successfully updated budget ${logicalId}`);
    return {
      physicalId,
      wasReplaced: false,
      attributes: {
        Arn: await this.budgetArn(accountId, physicalId),
      },
    };
  } catch (error) {
    if (error instanceof ProvisioningError) throw error;
    throw this.wrapBudgetError(mask, error, 'update', logicalId, resourceType, physicalId);
  }
}

/**
 * Read the DESIRED lists of a create or update, refusing a malformed one
 * before any call (go-to-k/cdkd#3989). The caller passes its own literal read
 * of each property so the call site shows (and a grep finds) which property
 * feeds the calls. `physicalId` is set on the update path.
 */
export function readDesiredLists(
  this: BudgetsBudgetProvider,
  logicalId: string,
  resourceType: string,
  values: Record<BudgetListKind, unknown>,
  physicalId: string | undefined
): Record<BudgetListKind, Record<string, unknown>[]> {
  const kinds: BudgetListKind[] = ['NotificationsWithSubscribers', 'ResourceTags'];
  const out = {} as Record<BudgetListKind, Record<string, unknown>[]>;
  const bad: BudgetListKind[] = [];
  const secret: BudgetListKind[] = [];
  for (const kind of kinds) {
    const read = readBudgetList(kind, values[kind], 'desired');
    if (read.kind === 'list') {
      out[kind] = read.items;
    } else {
      bad.push(kind);
      if (read.onlySecret) secret.push(kind);
    }
  }
  if (bad.length === 0) return out;
  const updating = physicalId !== undefined;
  throw markNonRetryable(
    new ProvisioningError(
      `${updating ? 'desired ' : ''}${bad.join(' / ')} of budget ${logicalId} is not a list ` +
        `of ${bad.map((k) => BUDGET_LIST_WHAT[k]).join(' / ')}` +
        (secret.length > 0
          ? ` (${secret.join(' / ')} holds a dynamic reference or its mask where an ` +
            `identifying value belongs, which names nothing Budgets holds)`
          : '') +
        ` — the budget was not ${updating ? 'updated' : 'created'}`,
      resourceType,
      logicalId,
      physicalId
    )
  );
}

/**
 * The ADD-only arm for a recorded `NotificationsWithSubscribers` cdkd cannot
 * read (go-to-k/cdkd#3989): create every desired notification (see
 * {@link createNotificationOrSubscribers}). Nothing is deleted, so a
 * notification or subscriber the desired side omits stays in place.
 */
export async function addNotificationsOnly(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string,
  list: NotificationWithSubscribers[]
): Promise<void> {
  for (const nws of list) {
    await this.createNotificationOrSubscribers(accountId, budgetName, nws);
  }
}

/**
 * Create a notification with its subscribers; on one that already exists
 * (`DuplicateRecordException` — a retry, or a notification the old side did
 * not list) create each desired subscriber instead, so none is skipped.
 */
export async function createNotificationOrSubscribers(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string,
  nws: NotificationWithSubscribers
): Promise<void> {
  const key = this.notificationKey(nws.Notification as Notification);
  try {
    await this.getClient().send(
      new CreateNotificationCommand({
        AccountId: accountId,
        BudgetName: budgetName,
        Notification: nws.Notification,
        Subscribers: nws.Subscribers,
      })
    );
    return;
  } catch (error) {
    if (!(error instanceof DuplicateRecordException)) throw error;
    this.logger.debug(safeMsg`Notification ${key} already exists, creating its subscribers`);
  }
  for (const subscriber of nws.Subscribers ?? []) {
    await this.sendCreateIdempotent(
      new CreateSubscriberCommand({
        AccountId: accountId,
        BudgetName: budgetName,
        Notification: nws.Notification,
        Subscriber: subscriber,
      }),
      `Subscriber ${this.subscriberKey(subscriber)} on notification ${key}`
    );
  }
}

/**
 * Send a reconciler DELETE call, treating `NotFoundException` as success.
 * The reconciler must be idempotent: after a partial failure the deploy
 * engine retries the update forward (re-deleting an already-deleted
 * notification/subscriber) or rolls it back with the reversed diff
 * (deleting a notification the forward pass never created) — both land
 * here as NotFound and must not fail the recovery.
 */
export async function sendDeleteIdempotent(
  this: BudgetsBudgetProvider,
  command: DeleteNotificationCommand | DeleteSubscriberCommand,
  what: string
): Promise<void> {
  try {
    await this.getClient().send(command as DeleteNotificationCommand);
  } catch (error) {
    if (error instanceof NotFoundException) {
      this.logger.debug(`${what} already absent, skipping delete`);
      return;
    }
    throw error;
  }
}

/**
 * Send a reconciler CREATE call, treating `DuplicateRecordException` as
 * success — the retry/rollback twin of {@link sendDeleteIdempotent} for
 * re-creating a notification/subscriber a previous partial pass already
 * created.
 */
export async function sendCreateIdempotent(
  this: BudgetsBudgetProvider,
  command: CreateNotificationCommand | CreateSubscriberCommand,
  what: string
): Promise<void> {
  try {
    await this.getClient().send(command as CreateNotificationCommand);
  } catch (error) {
    if (error instanceof DuplicateRecordException) {
      this.logger.debug(`${what} already exists, skipping create`);
      return;
    }
    throw error;
  }
}

/**
 * Reconcile the notification set: delete removed notifications first
 * (frees the 10-notifications-per-budget cap before additions), create
 * added ones, then diff subscribers on retained notifications. Every
 * step is idempotent (NotFound on delete / DuplicateRecord on create are
 * success) so a partial failure can be retried forward or rolled back.
 */
export async function reconcileNotifications(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string,
  oldList: NotificationWithSubscribers[],
  newList: NotificationWithSubscribers[]
): Promise<void> {
  const buildKeyed = (
    list: NotificationWithSubscribers[],
    side: string
  ): Map<string, NotificationWithSubscribers> => {
    const byKey = new Map<string, NotificationWithSubscribers>();
    for (const nws of list) {
      if (!nws.Notification) continue;
      const key = this.notificationKey(nws.Notification);
      if (byKey.has(key)) {
        // Two notifications with identical (type, operator, threshold,
        // thresholdType) — the Budgets API itself rejects true duplicates
        // with DuplicateRecord, and Map aggregation keeps the LAST entry's
        // subscribers. Surface it so a silently-dropped subscriber list is
        // diagnosable.
        this.logger.warn(
          `Duplicate notification key ${key} in ${side} NotificationsWithSubscribers for budget ${budgetName}; the last entry's subscribers win`
        );
      }
      byKey.set(key, nws);
    }
    return byKey;
  };
  const oldByKey = buildKeyed(oldList, 'previous');
  const newByKey = buildKeyed(newList, 'desired');

  // Removed notifications (their subscribers are deleted with them).
  for (const [key, nws] of oldByKey) {
    if (newByKey.has(key)) continue;
    await this.sendDeleteIdempotent(
      new DeleteNotificationCommand({
        AccountId: accountId,
        BudgetName: budgetName,
        Notification: nws.Notification,
      }),
      `Notification ${key} on budget ${budgetName}`
    );
    this.logger.debug(`Deleted notification ${key} from budget ${budgetName}`);
  }

  // Added notifications (created with their full subscriber list; one that
  // already exists gets its desired subscribers instead).
  for (const [key, nws] of newByKey) {
    if (oldByKey.has(key)) continue;
    await this.createNotificationOrSubscribers(accountId, budgetName, nws);
    this.logger.debug(`Created notification ${key} on budget ${budgetName}`);
  }

  // Retained notifications: diff subscribers. Create additions BEFORE
  // deleting removals — a notification must keep at least one subscriber
  // at all times, so delete-first would fail on a full swap of a
  // single-subscriber notification. Known trade-off: a full swap of a
  // notification already AT the per-notification subscriber cap can
  // transiently exceed the cap and fail — the inverse of the delete-first
  // ordering used for whole notifications above; the at-cap full swap is
  // the rarer case.
  for (const [key, newNws] of newByKey) {
    const oldNws = oldByKey.get(key);
    if (!oldNws) continue;
    const oldSubs = new Map<string, Subscriber>();
    for (const s of oldNws.Subscribers ?? []) oldSubs.set(this.subscriberKey(s), s);
    const newSubs = new Map<string, Subscriber>();
    for (const s of newNws.Subscribers ?? []) newSubs.set(this.subscriberKey(s), s);

    for (const [subKey, subscriber] of newSubs) {
      if (oldSubs.has(subKey)) continue;
      await this.sendCreateIdempotent(
        new CreateSubscriberCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: newNws.Notification,
          Subscriber: subscriber,
        }),
        `Subscriber ${subKey} on notification ${key}`
      );
      this.logger.debug(`Created subscriber ${subKey} on notification ${key}`);
    }
    for (const [subKey, subscriber] of oldSubs) {
      if (newSubs.has(subKey)) continue;
      await this.sendDeleteIdempotent(
        new DeleteSubscriberCommand({
          AccountId: accountId,
          BudgetName: budgetName,
          Notification: newNws.Notification,
          Subscriber: subscriber,
        }),
        `Subscriber ${subKey} on notification ${key}`
      );
      this.logger.debug(`Deleted subscriber ${subKey} from notification ${key}`);
    }
  }
}

/** Diff `ResourceTags` via `UntagResource` (removed keys) + `TagResource` (upsert). */
export async function reconcileResourceTags(
  this: BudgetsBudgetProvider,
  accountId: string,
  budgetName: string,
  oldTags: ResourceTag[],
  newTags: ResourceTag[]
): Promise<void> {
  const sortedJson = (tags: ResourceTag[]): string =>
    JSON.stringify([...tags].sort((a, b) => (a.Key ?? '').localeCompare(b.Key ?? '')));
  if (sortedJson(oldTags) === sortedJson(newTags)) return;

  const arn = await this.budgetArn(accountId, budgetName);
  const newKeys = new Set(newTags.map((t) => t.Key));
  const removedKeys = oldTags
    .map((t) => t.Key)
    .filter((k): k is string => {
      return typeof k === 'string' && !newKeys.has(k);
    });
  if (removedKeys.length > 0) {
    await this.getClient().send(
      new UntagResourceCommand({ ResourceARN: arn, ResourceTagKeys: removedKeys })
    );
  }
  if (newTags.length > 0) {
    await this.getClient().send(
      new TagResourceCommand({ ResourceARN: arn, ResourceTags: newTags })
    );
  }
  this.logger.debug(`Updated resource tags for budget ${budgetName}`);
}
