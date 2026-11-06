import { holdsSecretDerivedEntry } from '../../iam-policy-targets.js';
import { parseCfnTimestamp } from '../../../utils/cfn-timestamp.js';

// ─── List reads (go-to-k/cdkd#3989) ─────────────────────────────────
//
// `reconcileNotifications` / `reconcileResourceTags` derive their DELETES from
// the gap between the desired and the recorded list. Reading a present-but-
// malformed value (or dropping a malformed entry) as empty therefore deleted
// every notification (with its subscribers) / untagged every key the other
// side holds: on a rollback or `drift --revert`, where the desired side is a
// recorded bag, `NotificationsWithSubscribers: {}` stripped the budget of its
// alerts. So `undefined` / `null` is ABSENT (an empty list), and anything else
// that is not a list of well-formed entries is MALFORMED. A malformed DESIRED
// side is refused before any call; a malformed RECORDED side is applied
// ADD-only (see `update`).

export type BudgetListKind = 'NotificationsWithSubscribers' | 'ResourceTags';
type BudgetListSide = 'desired' | 'recorded';

type BudgetListRead =
  | { kind: 'list'; items: Record<string, unknown>[] }
  // `onlySecret`: well-shaped, and malformed ONLY because an identity member
  // holds a dynamic reference or its mask.
  | { kind: 'malformed'; onlySecret: boolean };

export const BUDGET_LIST_WHAT: Record<BudgetListKind, string> = {
  NotificationsWithSubscribers:
    'entries with a Notification (NotificationType, ComparisonOperator, numeric Threshold) ' +
    'and Subscribers (SubscriptionType, Address)',
  ResourceTags: 'tags with a string Key',
};

export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** A finite number, or a string holding one (CFn coerces scalars). */
function isThreshold(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
}

/**
 * `side` matters for identity members only. A DESIRED notification or
 * subscriber Address (or tag Key) holding a dynamic reference or its mask names
 * nothing Budgets holds, so it is malformed. A RECORDED one is what cdkd writes
 * for a value that came from a secret (cdkd keeps the reference in state): it
 * is read, and `removableRecorded` keeps it out of the delete set.
 */
function isWellFormedBudgetEntry(
  kind: BudgetListKind,
  entry: unknown,
  side: BudgetListSide,
  ignoreSecrets = false
): boolean {
  if (!isPlainRecord(entry)) return false;
  const checkSecret = side === 'desired' && !ignoreSecrets;
  if (kind === 'ResourceTags') {
    if (!isNonEmptyString(entry['Key'])) return false;
    // A `Value` keeps its existing coercion (a non-scalar sends `''`): only the
    // Key decides what is untagged.
    return !(checkSecret && holdsSecretDerivedEntry(entry['Key']));
  }
  const notification = entry['Notification'];
  if (
    !isPlainRecord(notification) ||
    !isNonEmptyString(notification['NotificationType']) ||
    !isNonEmptyString(notification['ComparisonOperator']) ||
    !isThreshold(notification['Threshold']) ||
    (notification['ThresholdType'] != null && !isNonEmptyString(notification['ThresholdType']))
  ) {
    return false;
  }
  if (checkSecret && holdsSecretDerivedEntry(notification)) return false;
  const subscribers = entry['Subscribers'];
  if (subscribers == null) return true;
  return (
    Array.isArray(subscribers) &&
    subscribers.every(
      (s) =>
        isPlainRecord(s) &&
        isNonEmptyString(s['SubscriptionType']) &&
        isNonEmptyString(s['Address']) &&
        !(checkSecret && holdsSecretDerivedEntry(s['Address']))
    )
  );
}

/** Read one list property; ABSENT (`undefined` / `null`) reads as the empty list. */
export function readBudgetList(
  kind: BudgetListKind,
  value: unknown,
  side: BudgetListSide
): BudgetListRead {
  if (value === undefined || value === null) return { kind: 'list', items: [] };
  if (Array.isArray(value) && value.every((e) => isWellFormedBudgetEntry(kind, e, side))) {
    return { kind: 'list', items: value as Record<string, unknown>[] };
  }
  return {
    kind: 'malformed',
    onlySecret:
      Array.isArray(value) && value.every((e) => isWellFormedBudgetEntry(kind, e, side, true)),
  };
}

/**
 * A recorded list minus every secret-derived identity: a notification whose
 * block holds one, a subscriber whose Address does, a tag whose Key does. The
 * reconciler would otherwise send a delete naming a literal `{{resolve:...}}`.
 * Dropping it only misses that one removal, the safe direction.
 */
export function removableRecorded(
  kind: BudgetListKind,
  items: Record<string, unknown>[]
): Record<string, unknown>[] {
  if (kind === 'ResourceTags') return items.filter((t) => !holdsSecretDerivedEntry(t['Key']));
  return items
    .filter((e) => !holdsSecretDerivedEntry(e['Notification']))
    .map((e) =>
      Array.isArray(e['Subscribers'])
        ? {
            ...e,
            Subscribers: (e['Subscribers'] as Record<string, unknown>[]).filter(
              (s) => !holdsSecretDerivedEntry(s['Address'])
            ),
          }
        : e
    );
}

// ─── Drift read-back (go-to-k/cdkd#5183) ────────────────────────────

/** A finite number from a number or a numeric string; anything else is `undefined`. */
export function finiteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * A CFn `TimePeriod.Start` / `.End` as an ISO string, by the rules `toSdkDate`
 * sends it with (a date string, or an epoch in seconds or milliseconds, as a
 * number or a digit string). `undefined` when it does not parse.
 */
export function isoDate(value: unknown): string | undefined {
  let date: Date;
  if (typeof value === 'number') date = new Date(value < 1e12 ? value * 1000 : value);
  else if (typeof value === 'string' && /^\d+$/.test(value)) {
    const n = Number(value);
    date = new Date(n < 1e12 ? n * 1000 : n);
  } else if (typeof value === 'string') date = parseCfnTimestamp(value);
  else if (value instanceof Date) date = value;
  else return undefined;
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/** A `Spend` with its `Amount` as a number; the input itself when nothing changes. */
function canonicalSpend(spend: unknown): unknown {
  if (!isPlainRecord(spend)) return spend;
  const amount = finiteNumber(spend['Amount']);
  return amount === undefined || amount === spend['Amount'] ? spend : { ...spend, Amount: amount };
}

/**
 * One side of a budget drift comparison in the canonical form: amounts and
 * thresholds as numbers, `TimePeriod` dates as ISO strings, and an absent
 * `ThresholdType` as Budgets' default `PERCENTAGE`. Applied to BOTH sides, so
 * a template that spelled a value one way and a readback that returns it
 * another compare equal. Returns the input by identity when nothing applies.
 *
 * `side` is a drift comparison bag (the baseline or the readback), never a
 * desired bag bound for AWS, so it is not named like one.
 */
export function canonicalizeBudgetDriftBag(side: Record<string, unknown>): Record<string, unknown> {
  let out = side;
  const budget = side['Budget'];
  if (isPlainRecord(budget)) {
    let nextBudget = budget;
    const set = (key: string, value: unknown): void => {
      if (value === nextBudget[key]) return;
      if (nextBudget === budget) nextBudget = { ...budget };
      nextBudget[key] = value;
    };
    set('BudgetLimit', canonicalSpend(budget['BudgetLimit']));
    const planned = budget['PlannedBudgetLimits'];
    if (isPlainRecord(planned)) {
      // The keys are period start times; `Object.fromEntries` keeps any key,
      // `__proto__` included, an own property.
      const entries = Object.entries(planned).map(([key, spend]) => [key, canonicalSpend(spend)]);
      if (entries.some(([key, spend]) => spend !== planned[key as string])) {
        set('PlannedBudgetLimits', Object.fromEntries(entries));
      }
    }
    const period = budget['TimePeriod'];
    if (isPlainRecord(period)) {
      let nextPeriod = period;
      for (const key of ['Start', 'End']) {
        if (period[key] === undefined) continue;
        const iso = isoDate(period[key]);
        if (iso === undefined || iso === period[key]) continue;
        if (nextPeriod === period) nextPeriod = { ...period };
        nextPeriod[key] = iso;
      }
      set('TimePeriod', nextPeriod);
    }
    if (nextBudget !== budget) out = { ...out, Budget: nextBudget };
  }
  const list = side['NotificationsWithSubscribers'];
  if (Array.isArray(list)) {
    let changed = false;
    const nextList = list.map((entry: unknown) => {
      if (!isPlainRecord(entry) || !isPlainRecord(entry['Notification'])) return entry;
      const notification = entry['Notification'];
      const threshold = finiteNumber(notification['Threshold']);
      const fillType = notification['ThresholdType'] == null;
      const fixThreshold = threshold !== undefined && threshold !== notification['Threshold'];
      if (!fillType && !fixThreshold) return entry;
      changed = true;
      return {
        ...entry,
        Notification: {
          ...notification,
          ...(fixThreshold && { Threshold: threshold }),
          ...(fillType && { ThresholdType: 'PERCENTAGE' }),
        },
      };
    });
    if (changed) out = { ...out, NotificationsWithSubscribers: nextList };
  }
  return out;
}

/**
 * Whether a recorded budget declares the legacy filter shape (`CostFilters` /
 * `CostTypes`) and none of the current one (`FilterExpression` / `Metrics`).
 * `DescribeBudget` returns exactly one of the two shapes, chosen by
 * `ShowFilterExpression`; absent properties read as the current shape.
 */
export function declaresLegacyFilterShape(
  properties: Record<string, unknown> | undefined
): boolean {
  const budget = properties?.['Budget'];
  if (!isPlainRecord(budget)) return false;
  const legacy = budget['CostFilters'] != null || budget['CostTypes'] != null;
  const current = budget['FilterExpression'] != null || budget['Metrics'] != null;
  return legacy && !current;
}

/**
 * The baseline minus each `Budget.PlannedBudgetLimits` key that the AWS side
 * lacks and whose period start (epoch seconds) is before `nowMs`; the input by
 * identity when nothing is dropped. See `canonicalizeDriftPair`.
 */
export function dropElapsedPlannedLimits(
  baseline: Record<string, unknown>,
  aws: Record<string, unknown>,
  nowMs: number
): Record<string, unknown> {
  const budget = baseline['Budget'];
  const awsBudget = aws['Budget'];
  if (!isPlainRecord(budget) || !isPlainRecord(awsBudget)) return baseline;
  const planned = budget['PlannedBudgetLimits'];
  if (!isPlainRecord(planned)) return baseline;
  const awsPlanned = isPlainRecord(awsBudget['PlannedBudgetLimits'])
    ? awsBudget['PlannedBudgetLimits']
    : {};
  const elapsed = (key: string): boolean =>
    !Object.hasOwn(awsPlanned, key) && /^\d+$/.test(key) && Number(key) * 1000 < nowMs;
  const kept = Object.entries(planned).filter(([key]) => !elapsed(key));
  if (kept.length === Object.keys(planned).length) return baseline;
  return { ...baseline, Budget: { ...budget, PlannedBudgetLimits: Object.fromEntries(kept) } };
}
