import { stringifyValue } from '../../../utils/stringify.js';

/**
 * The attribute half of an `AWS::SNS::Subscription` update: which
 * `SetSubscriptionAttributes` calls bring a subscription's attributes to the
 * template, or why the change must re-create the subscription instead.
 *
 * A LEAF with no SDK import, shared by the provider's `update()` (planned
 * against the attributes AWS holds) and the diff (planned against the state
 * record, go-to-k/cdkd#6509), so `cdkd diff` reports the replacement the deploy
 * makes. The analyzer imports this module, never the provider: providers load
 * lazily (#4521).
 */

/**
 * The attributes `SetSubscriptionAttributes` changes in place (go-to-k/cdkd#4853),
 * in the order an update applies them: `FilterPolicy` before
 * `FilterPolicyScope`, so a cleared policy is gone before its scope returns to
 * the default. `TopicArn` / `Protocol` / `Endpoint` are create-only.
 */
export const MUTABLE_ATTRIBUTES = [
  'RawMessageDelivery',
  'FilterPolicy',
  'FilterPolicyScope',
  'RedrivePolicy',
  'DeliveryPolicy',
  'ReplayPolicy',
  'SubscriptionRoleArn',
] as const;

/**
 * The value that clears an attribute dropped from the template, for the ones
 * where AWS documents one. An attribute missing here (`DeliveryPolicy`,
 * `ReplayPolicy`, `SubscriptionRoleArn`) is removed by re-creating the
 * subscription without it, as before go-to-k/cdkd#4853. `RedrivePolicy`'s `''`
 * is the plan's sentinel only: {@link wireAttributeValue} sends it as an
 * omitted value.
 */
const RESET_VALUES = {
  RawMessageDelivery: 'false',
  FilterPolicy: '',
  FilterPolicyScope: 'MessageAttributes',
  RedrivePolicy: '',
} as const satisfies Partial<Record<MutableAttribute, string>>;

/**
 * The `AttributeValue` that `SetSubscriptionAttributes` sends for a planned
 * call. SNS clears a `RedrivePolicy` only when the value is OMITTED: it refuses
 * `''` ("missing required value") and `'{}'` ("Missing deadLetterTargetArn
 * attribute"), measured on real AWS (go-to-k/cdkd#6835). `FilterPolicy: ''`
 * does clear, so it is sent as planned.
 */
export function wireAttributeValue(name: string, value: string): string | undefined {
  return name === 'RedrivePolicy' && value === RESET_VALUES.RedrivePolicy ? undefined : value;
}

type MutableAttribute = (typeof MUTABLE_ATTRIBUTES)[number];
/** The attributes with no reset: removing one re-creates the subscription. */
type UnresettableAttribute = Exclude<MutableAttribute, keyof typeof RESET_VALUES>;

const UNRESETTABLE_REASONS: Readonly<Record<UnresettableAttribute, SubscriptionReplaceReason>> = {
  DeliveryPolicy: 'DeliveryPolicy removed, which SNS cannot reset',
  ReplayPolicy: 'ReplayPolicy removed, which SNS cannot reset',
  SubscriptionRoleArn: 'SubscriptionRoleArn removed, which SNS cannot reset',
};

/**
 * A template value in the string form `Subscribe` / `SetSubscriptionAttributes`
 * take: policies as JSON, a boolean as `"true"` / `"false"`. `undefined` for an
 * absent value.
 */
export function toAttributeValue(key: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (
    key === 'FilterPolicy' ||
    key === 'RedrivePolicy' ||
    key === 'DeliveryPolicy' ||
    key === 'ReplayPolicy'
  ) {
    return typeof value === 'string' ? value : JSON.stringify(value);
  }
  return stringifyValue(value);
}

/**
 * Does AWS already hold `desired` for attribute `name`? A JSON policy compares
 * parsed, and an absent value equals the attribute's default (AWS omits
 * `RawMessageDelivery` on an email subscription, where setting it is refused).
 */
function resetValueOf(name: string): string | undefined {
  return Object.hasOwn(RESET_VALUES, name)
    ? RESET_VALUES[name as keyof typeof RESET_VALUES]
    : undefined;
}

function sameAttributeValue(name: string, desired: string, current: string | undefined): boolean {
  if (current === undefined) return desired === resetValueOf(name);
  if (desired === current) return true;
  try {
    return JSON.stringify(JSON.parse(desired)) === JSON.stringify(JSON.parse(current));
  } catch {
    return false;
  }
}

/**
 * Will the subscription hold no `FilterPolicy` once `plan` is applied? Either
 * the plan clears it, or the plan leaves it and AWS holds none (a desired
 * policy the plan does not set already equals what AWS holds).
 */
function filterPolicyCleared(
  plan: ReadonlyArray<readonly [string, string]>,
  current: Readonly<Record<string, string | undefined>>
): boolean {
  const planned = plan.find(([name]) => name === 'FilterPolicy');
  if (planned !== undefined) return planned[1] === '';
  return current['FilterPolicy'] === undefined || current['FilterPolicy'] === '';
}

/** Why an attribute change re-creates the subscription; fixed wording, shown by `cdkd diff`. */
export type SubscriptionReplaceReason =
  | 'FilterPolicy and FilterPolicyScope change together'
  | 'DeliveryPolicy removed, which SNS cannot reset'
  | 'ReplayPolicy removed, which SNS cannot reset'
  | 'SubscriptionRoleArn removed, which SNS cannot reset';

export type SubscriptionAttributePlan =
  | { kind: 'in-place'; calls: Array<[string, string]> }
  | { kind: 'replace'; reason: SubscriptionReplaceReason };

/**
 * The `SetSubscriptionAttributes` calls that bring `current` to `properties`,
 * in order, or the reason the change must re-create the subscription:
 *
 * - an attribute dropped from the template with no reset in `RESET_VALUES`;
 * - a new (non-empty) `FilterPolicy` and a `FilterPolicyScope` change in one
 *   plan, whether the template declares the scope or dropped it: `Subscribe`
 *   applies them together, two calls would apply one at a time against the
 *   other's old value. Either order has that gap (a scope set first is refused
 *   against the old policy's shape). An EMPTY policy is exempt: cleared first,
 *   the subscription filters nothing between the calls. A scope the template
 *   DECLARES is still sent onto a subscription left with no policy (only raw
 *   CloudFormation spells that; CDK pairs a scope with a policy).
 *
 * `current` holds attribute strings as `GetSubscriptionAttributes` returns
 * them; an absent key is the attribute's default.
 */
export function planSubscriptionAttributes(
  current: Readonly<Record<string, string | undefined>>,
  properties: Readonly<Record<string, unknown>>
): SubscriptionAttributePlan {
  const calls: Array<[string, string]> = [];
  for (const name of MUTABLE_ATTRIBUTES) {
    const desired = toAttributeValue(name, properties[name]);
    const now = current[name];
    if (desired !== undefined) {
      if (!sameAttributeValue(name, desired, now)) calls.push([name, desired]);
      continue;
    }
    // Dropped from the template: clear what AWS still holds.
    if (now === undefined || now === '') continue;
    // A scope without a policy filters nothing, and SNS may refuse to set
    // one on a subscription with no policy: leave it for the next policy.
    if (name === 'FilterPolicyScope' && filterPolicyCleared(calls, current)) continue;
    const reset = resetValueOf(name);
    if (reset === undefined) {
      return { kind: 'replace', reason: UNRESETTABLE_REASONS[name as UnresettableAttribute] };
    }
    if (now !== reset) calls.push([name, reset]);
  }
  const policy = calls.find(([name]) => name === 'FilterPolicy');
  if (
    policy !== undefined &&
    policy[1] !== '' &&
    calls.some(([name]) => name === 'FilterPolicyScope')
  ) {
    return { kind: 'replace', reason: 'FilterPolicy and FilterPolicyScope change together' };
  }
  return { kind: 'in-place', calls };
}

/**
 * The state record's `properties` in the attribute form
 * {@link planSubscriptionAttributes} reads as `current`: the diff's stand-in
 * for the `GetSubscriptionAttributes` readback the deploy plans against.
 */
export function recordedSubscriptionAttributes(
  recorded: Readonly<Record<string, unknown>>
): Record<string, string | undefined> {
  const attributes: Record<string, string | undefined> = {};
  for (const name of MUTABLE_ATTRIBUTES) {
    attributes[name] = toAttributeValue(name, recorded[name]);
  }
  return attributes;
}
