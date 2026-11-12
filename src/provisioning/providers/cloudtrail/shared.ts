import type { AdvancedEventSelector, EventSelector } from '@aws-sdk/client-cloudtrail';
import { safeMsg } from '../../../utils/display-safe.js';
import { describeAwsFailure } from '../../../utils/aws-failure-text.js';
import { requireConfigArray } from '../../config-shape.js';
import type { UpdateContext } from '../../../types/resource.js';

/**
 * The selector set a trail carries when its template declares NO
 * `EventSelectors`, and therefore the RESET payload for a removal.
 *
 * Live CFn A/B (issue #1549, us-east-1, 2026-08-11): removing `EventSelectors`
 * from a deployed trail's template resets the live selectors to exactly this
 * shape — AWS echoes it back as `{ReadWriteType: 'All', IncludeManagementEvents:
 * true, DataResources: [], ExcludeManagementEventSources: []}`, the two empty
 * lists being response-side defaults that do NOT need sending.
 *
 * It is a VALUE, not an empty array, because `PutEventSelectors` rejects `[]`
 * with `InvalidEventSelectorsException: Specify a valid number of selectors
 * (1 to 5) for your trail` — the divergence from the `InsightSelectors` sibling,
 * where AWS documents `[]` as the removal shape.
 */
export const DEFAULT_EVENT_SELECTORS: readonly EventSelector[] = Object.freeze([
  Object.freeze({ ReadWriteType: 'All', IncludeManagementEvents: true }),
]) as readonly EventSelector[];

/**
 * `undefined` for an absent / null / EMPTY optional string field.
 *
 * Module-scoped since issue #1565 so `create()` can use it too: an always-emit
 * placeholder can reach `create()` — `drift --accept` before go-to-k/cdkd#6125
 * wrote readback values into `properties`, and the rollback executor
 * replays `previousState.properties` through `create()` on a reverse
 * replacement — and `CreateTrail` with `CloudWatchLogsLogGroupArn: ''` is an
 * UNPROBED shape that may 400 on ARN format. `''` there means "not
 * configured", which is exactly what omitting the field says.
 *
 * The update path is where the distinction between absent and `''` matters
 * (see {@link resolveCloudWatchLogsPair}); on create there is no previous
 * value to clear, so both collapse to "omit".
 */
export function emptyToUndefined(v: unknown): string | undefined {
  if (v === undefined || v === null || v === '') return undefined;
  return v as string;
}

/**
 * Resolve the `CloudWatchLogsLogGroupArn` / `CloudWatchLogsRoleArn` pair for an
 * `UpdateTrail`, distinguishing an ABSENT desired side from an explicit `''`.
 *
 * The pair is all-or-nothing on AWS, so the two fields are decided TOGETHER —
 * the caller cannot build the half-configured request AWS rejects.
 *
 * - ABSENT (`undefined` / `null`) on BOTH sides -> send neither. The template
 *   never declared them, and the live CFn A/B (2026-08-10) measured a template
 *   removal as RETAINED, so sending nothing IS the parity behavior. `null`
 *   counts as absent because a JSON state round-trip can produce one where the
 *   template had nothing.
 * - BOTH `''` -> send both. `''` is the clear, which is what makes a
 *   `drift --revert` of a console-side enable actually revert (issue #1565).
 *   On an already-unwired trail that re-asserts a null field, which AWS accepts
 *   as the no-op it is, and it rides an `UpdateTrail` this method issues
 *   anyway. Deliberately NOT gated on "differs from the previous side": that
 *   gate would also stop forwarding an UNCHANGED populated pair, which
 *   `cloudtrail-provider-roundtrip.test.ts` pins as a wire-layer guarantee.
 * - BOTH populated -> send both verbatim.
 * - Anything else — a non-string value, or exactly ONE half populated -> send
 *   NEITHER, and report it. Both shapes are unusable rather than meaningful:
 *   coercing them would send `''` next to a real ARN (the request AWS rejects)
 *   or, worse, read a malformed `null` as a CLEAR and silently disable a live
 *   trail's CloudWatch Logs delivery — the
 *   `malformed-value-must-not-read-as-removal` class this same file already
 *   guards for `EventSelectors`. Leaving the pair alone is the non-destructive
 *   reading, and the caller warns so the divergence is loud.
 *
 * Only the DESIRED side decides, which keeps the guard-the-desired-side-only
 * rule intact.
 */
export function resolveCloudWatchLogsPair(properties: Record<string, unknown>): {
  logGroupArn: string | undefined;
  roleArn: string | undefined;
  unusable?: string;
} {
  const desiredGroup = properties['CloudWatchLogsLogGroupArn'];
  const desiredRole = properties['CloudWatchLogsRoleArn'];
  const groupAbsent = desiredGroup == null;
  const roleAbsent = desiredRole == null;
  if (groupAbsent && roleAbsent) return { logGroupArn: undefined, roleArn: undefined };

  if (typeof desiredGroup !== 'string' || typeof desiredRole !== 'string') {
    return {
      logGroupArn: undefined,
      roleArn: undefined,
      unusable:
        `CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn must both be strings ` +
        `(got ${describeValue(desiredGroup)} / ${describeValue(desiredRole)}) — check for ` +
        `an unresolved intrinsic or a half-written state record`,
    };
  }
  if ((desiredGroup === '') !== (desiredRole === '')) {
    return {
      logGroupArn: undefined,
      roleArn: undefined,
      unusable:
        `CloudWatchLogsLogGroupArn / CloudWatchLogsRoleArn are all-or-nothing on AWS, ` +
        `but only one of them carries a value — sending the pair would be rejected`,
    };
  }
  return { logGroupArn: desiredGroup, roleArn: desiredRole };
}

/**
 * An UPDATE-path read of a desired list block, with its three answers kept
 * apart: `absent` (a template removal), `list`, and `unusable` (a
 * present-but-non-array value, which must never read as a removal — the
 * `malformed-value-must-not-read-as-removal` class, issue #1493).
 */
export type ListBlockRead =
  | { kind: 'absent' }
  | { kind: 'list'; value: Array<Record<string, unknown>> }
  | { kind: 'unusable'; detail: string };

export function readListBlock(raw: unknown, path: string): ListBlockRead {
  if (raw == null) return { kind: 'absent' };
  try {
    return { kind: 'list', value: requireConfigArray(raw, path) };
  } catch (error) {
    return { kind: 'unusable', detail: describeAwsFailure(error).detail };
  }
}

/** The list a read carries, `undefined` for absent or unusable. */
export function listOf(read: ListBlockRead): Array<Record<string, unknown>> | undefined {
  return read.kind === 'list' ? read.value : undefined;
}

/**
 * `desired` with each of `keys` replaced by what AWS still holds for a list
 * block an update skipped (`.claude/rules/provider-replay-and-refusals.md`,
 * "Update-path downgrades"): the PREVIOUS value when it is a list; the LIVE
 * reading when the previous value is present but unusable; otherwise (an
 * absent previous value, or no live reading) the key is removed. Values are
 * copied, never aliased.
 */
export function retainPreviousLists(
  desired: Record<string, unknown>,
  previous: Record<string, unknown>,
  keys: readonly string[],
  live?: Record<string, unknown>
): Record<string, unknown> {
  const out: Record<string, unknown> = Object.fromEntries(
    Object.entries(desired).filter(([key]) => !keys.includes(key))
  );
  for (const key of keys) {
    const prev = previous[key];
    if (Array.isArray(prev)) out[key] = structuredClone(prev);
    else if (prev != null && Array.isArray(live?.[key])) out[key] = structuredClone(live[key]);
  }
  return out;
}

/**
 * The CloudTrail list blocks whose every list is a SET (issue #2762):
 * `AdvancedEventSelectors` (the selectors are OR-ed, each selector's
 * `FieldSelectors` AND-ed, and each operator's values OR-ed) and
 * `AggregationConfigurations` (one entry per category, `Templates` a set).
 * `GetEventSelectors` returns `FieldSelectors` sorted by `Field`, not in the
 * order they were put (measured on a live trail), so these are compared
 * without order: by `cdkd drift` through `getDriftUnorderedPaths`, and by
 * `update()` through {@link setKey}.
 */
export const UNORDERED_LIST_BLOCKS: readonly string[] = [
  'AdvancedEventSelectors',
  'AggregationConfigurations',
];

/**
 * An order-insensitive comparison key for a set-valued block: every array is
 * sorted by its elements' keys and every object's keys are sorted, so two
 * spellings of one set compare equal. Used only to decide whether a Put is
 * needed, never sent. `undefined` keeps its own key, distinct from `[]`.
 */
export function setKey(value: unknown): string {
  if (value === undefined) return 'undefined';
  if (Array.isArray(value)) return ['[', value.map(setKey).sort().join(','), ']'].join('');
  if (value !== null && typeof value === 'object') {
    const bag = value as Record<string, unknown>;
    const entries = Object.keys(bag)
      .filter((k) => bag[k] !== undefined)
      .sort()
      .map((k) => [JSON.stringify(k), setKey(bag[k])].join(':'));
    return ['{', entries.join(','), '}'].join('');
  }
  return JSON.stringify(value) ?? 'null';
}

/** The list a read carries when it has at least one entry. */
export function nonEmptyListOf(read: ListBlockRead): Array<Record<string, unknown>> | undefined {
  return read.kind === 'list' && read.value.length > 0 ? read.value : undefined;
}

/**
 * The `PutEventSelectors` members for a desired pair of selector lists.
 *
 * `EventSelectors` and `AdvancedEventSelectors` are two spellings of ONE
 * selector set: `PutEventSelectors` replaces the trail's whole set with
 * whichever it is sent, and AWS refuses a request carrying both. So the
 * request is built from both together:
 *
 * - a non-empty `AdvancedEventSelectors` is sent as given, with a non-empty
 *   `EventSelectors` beside it when the template declares both, so AWS
 *   refuses the combination loudly rather than cdkd quietly picking one;
 * - else a non-empty `EventSelectors` is sent as given;
 * - else neither is declared, and the trail is RESET to
 *   {@link DEFAULT_EVENT_SELECTORS}, the set a selector-less trail has (the
 *   measured `EventSelectors` removal, issue #1549). A removed
 *   `AdvancedEventSelectors` lands on the same default: with no selector
 *   declared at all, the trail is the selector-less trail CloudFormation
 *   creates (issue #2762).
 */
export function eventSelectorRequest(
  basic: Array<Record<string, unknown>> | undefined,
  advanced: Array<Record<string, unknown>> | undefined
): {
  members: { EventSelectors?: EventSelector[]; AdvancedEventSelectors?: AdvancedEventSelector[] };
  isReset: boolean;
} {
  const hasBasic = basic !== undefined && basic.length > 0;
  if (advanced !== undefined && advanced.length > 0) {
    return {
      members: {
        AdvancedEventSelectors: advanced as unknown as AdvancedEventSelector[],
        ...(hasBasic ? { EventSelectors: basic as unknown as EventSelector[] } : {}),
      },
      isReset: false,
    };
  }
  if (hasBasic) {
    return { members: { EventSelectors: basic as unknown as EventSelector[] }, isReset: false };
  }
  return { members: { EventSelectors: [...DEFAULT_EVENT_SELECTORS] }, isReset: true };
}

/**
 * `GetEventSelectors`' advanced selectors in the CFn shape: the same member
 * names, with every member AWS left unset dropped so the snapshot carries no
 * `undefined` keys.
 */
export function advancedSelectorsToCfn(
  selectors: readonly AdvancedEventSelector[]
): Array<Record<string, unknown>> {
  return selectors.map((s) => ({
    ...(s.Name !== undefined && { Name: s.Name }),
    FieldSelectors: (s.FieldSelectors ?? []).map((f) =>
      Object.fromEntries(Object.entries(f).filter(([, v]) => v !== undefined))
    ),
  }));
}

/** Human-readable type for a warning, without echoing user data. */
export function describeValue(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'nothing';
  if (Array.isArray(value)) return 'an array';
  if (typeof value === 'string') return value === '' ? "''" : 'a string';
  return `a ${typeof value}`;
}

/**
 * The wording of AWS's rejection that the EventSelectors reset tolerates: a
 * trail on AdvancedEventSelectors has no basic selectors to reset.
 */
export const ADVANCED_SELECTOR_PHRASE = /advanced[\s-]*event[\s-]*selector/i;

/**
 * An access-denial class, CloudTrail's `Insufficient*AccessPermissionException`
 * included: never the benign advanced-selector rejection, whatever its text
 * spells (go-to-k/cdkd#2319 review).
 */
export const ACCESS_DENIAL_CLASS = /AccessDenied|NotAuthorized|Unauthorized|AccessPermission/i;

/**
 * AWS's text with every ARN cut out, and the trail's id and bare name cut out
 * as whole tokens when they themselves spell the phrase (go-to-k/cdkd#2319
 * review): the EventSelectors reset tolerance matches
 * {@link ADVANCED_SELECTOR_PHRASE} in AWS's text, and a denial quoting a trail,
 * role or session NAMED after it must not match. An identifier that does not
 * spell the phrase is left alone, so a trail named `advanced` or `selectors`
 * does not erase words of AWS's own wording. The ARN cut runs to whitespace or
 * a quote / bracket, so an IAM name carrying `,` is cut whole.
 */
export function withoutTrailIdentifiers(text: string, physicalId: string): string {
  const trailName = physicalId.slice(physicalId.lastIndexOf('/') + 1);
  let out = text.replace(/\barn:[^\s;()'"]+/g, '');
  for (const id of new Set([physicalId, trailName])) {
    if (id === '' || !ADVANCED_SELECTOR_PHRASE.test(id)) continue;
    const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`(^|[^A-Za-z0-9._-])${escaped}(?=$|[^A-Za-z0-9._-])`, 'g'), '$1');
  }
  return out;
}

/**
 * The Trail properties a template removal leaves at their live value while
 * CloudFormation's own behaviour is UNMEASURED, so `update()` names them in
 * its own warning rather than the shared caller's line, which would claim a
 * CloudFormation reset (issue #1160, `removalHandledInUpdate`).
 *
 * - `IsOrganizationTrail` (#5541): UpdateTrail keeps a field it is not sent.
 *   CFn behaviour unmeasured: the A/B needs an Organizations management or
 *   delegated-administrator account, and the integ account is in no
 *   organization. A removed `false` is not named: either answer leaves it
 *   false.
 * - `RecursiveLogging` (#6166): likewise kept, CFn behaviour unmeasured. A
 *   removed `true` is not named: it is AWS's default, so either answer leaves
 *   it true.
 * - `IncludeGlobalServiceEvents`, only when its reset is skipped because the
 *   trail is, or may be, multi-region (see `update()`); the measured reset
 *   covered a single-region trail only.
 */
export function removalsLeftInPlace(
  properties: Record<string, unknown>,
  previousProperties: Record<string, unknown>,
  context: UpdateContext | undefined,
  globalEventsResetSkipped: boolean
): string[] {
  if (context?.desiredFromAwsReadback) return [];
  const removed = context?.removedProperties;
  const wasRemoved = (key: string): boolean =>
    previousProperties[key] != null &&
    properties[key] == null &&
    (removed === undefined || removed.has(key));
  const org = previousProperties['IsOrganizationTrail'];
  // A previous `false` means a single-region trail (AWS rejects a multi-region
  // trail without global events), and CloudFormation's measured reset is
  // `false` too, so the live value already equals it.
  const globalEvents = previousProperties['IncludeGlobalServiceEvents'];
  const recursive = previousProperties['RecursiveLogging'];
  return [
    ...(wasRemoved('IsOrganizationTrail') && org !== false && org !== 'false'
      ? ['IsOrganizationTrail']
      : []),
    ...(wasRemoved('RecursiveLogging') && recursive !== true && recursive !== 'true'
      ? ['RecursiveLogging']
      : []),
    ...(globalEventsResetSkipped &&
    wasRemoved('IncludeGlobalServiceEvents') &&
    globalEvents !== false &&
    globalEvents !== 'false'
      ? ['IncludeGlobalServiceEvents']
      : []),
  ];
}

/**
 * The ONE warning line for {@link removalsLeftInPlace}. Names are
 * template-borne, so they go through `safeMsg`. A rollback revert restores an
 * earlier state record, so there the property is one the failed deploy ADDED.
 */
export function leftInPlaceWarning(
  logicalId: string,
  names: readonly string[],
  caller: 'deploy' | 'rollback'
): string {
  const one = names.length === 1;
  const subject = one ? 'property' : 'properties';
  return caller === 'rollback'
    ? safeMsg`${logicalId} (AWS::CloudTrail::Trail): ${subject} ${names.join(', ')} ${one ? 'is' : 'are'} absent from the state being restored; UpdateTrail keeps a field it is not sent, so the rollback leaves the value the failed deploy applied in place.`
    : safeMsg`${logicalId} (AWS::CloudTrail::Trail): ${subject} ${names.join(', ')} ${one ? 'was' : 'were'} removed from the template; cdkd leaves the current AWS value in place (whether CloudFormation resets it is unmeasured). Declare the intended value explicitly to change it.`;
}
