import { getLogger } from '../../../utils/logger.js';
import { stringifyValue } from '../../../utils/stringify.js';
import { maskDeep } from '../../masked-retry-logger.js';
import type { SecretMasker } from '../../../types/resource.js';

/**
 * The value SNS enforces for a topic that never set `MaximumMessageSize`
 * (256 KiB, the standard maximum), and therefore what a template REMOVAL of
 * the member resets the attribute to — SNS refuses the `''` the other
 * `SetTopicAttributes` removals send (`MaximumMessageSize:  is not an integer
 * between 1024 and 1048576 bytes`, measured us-east-1 2026-09-18). A fresh
 * topic REPORTS no value at all, which `readCurrentState` folds to this value;
 * see there. Exported for the unit tests that pin both halves (issue #3413).
 */
export const SNS_MAXIMUM_MESSAGE_SIZE_DEFAULT = '262144';

/**
 * The attribute map `create()` records, from the topic ARN (the physical id).
 * `import()` returns it too (issue #3627).
 */
export function snsTopicAttributes(topicArn: string): Record<string, unknown> {
  return { TopicArn: topicArn, TopicName: topicArn.split(':').pop() };
}

// ─── DeliveryStatusLogging reverse-mapping ─────────────────────────────
//
// CFn input shape:
//   DeliveryStatusLogging: [
//     { Protocol: 'http/s'|'sqs'|'lambda'|'firehose'|'application',
//       SuccessFeedbackRoleArn?, SuccessFeedbackSampleRate?, FailureFeedbackRoleArn? }
//   ]
// AWS GetTopicAttributes flat attribute shape (one per protocol):
//   <Protocol>SuccessFeedbackRoleArn  (e.g. HTTPSuccessFeedbackRoleArn)
//   <Protocol>SuccessFeedbackSampleRate
//   <Protocol>FailureFeedbackRoleArn
// where <Protocol> is the canonical PascalCase prefix.
//
// Wire-format note: AWS's attribute prefix is always PascalCase
// (`Lambda`, `SQS`, `HTTP`, ...) regardless of how `Protocol` was
// spelled in the template. CDK emits lowercase (`'lambda'` / `'sqs'`
// / `'http/s'`) — passing those through directly to
// `${protocol}SuccessFeedbackRoleArn` produces invalid attribute names
// AWS rejects with `InvalidParameter: Invalid parameter:
// AttributeName`. `normalizeDeliveryStatusProtocol` is the single
// chokepoint mapping any-case input to the canonical PascalCase prefix.
//
// The template spelling set and the prefix set are NOT the same set, and
// conflating them was issue #1529: the canonical HTTP-family template
// value is `http/s` (`sns.LoggingProtocol.HTTP`), while the ONLY
// HTTP-family attribute prefix AWS accepts is `HTTP`. There is no `HTTPS`
// prefix — `SetTopicAttributes` rejects `HTTPSSuccessFeedbackRoleArn`
// outright (live-verified 2026-08-11).

// ─── Inline Subscription attribute mapping (issue #980) ────────────────
//
// The documented optional attributes of an inline `AWS::SNS::Topic`
// `Subscription` entry that are settable at `Subscribe` time. `Protocol`
// and `Endpoint` are the two required fields (handled separately); every
// other key here maps 1:1 to an SNS subscription attribute name. Object-
// valued policies are JSON-stringified; scalar values are stringified
// verbatim (AWS's Subscribe `Attributes` map is `Record<string,string>`).
const SNS_SUBSCRIPTION_ATTRIBUTE_KEYS = [
  'RawMessageDelivery',
  'FilterPolicy',
  'FilterPolicyScope',
  'RedrivePolicy',
  'DeliveryPolicy',
  'ReplayPolicy',
  'SubscriptionRoleArn',
] as const;

/**
 * Build the SNS `Subscribe` `Attributes` map from an inline `Subscription`
 * entry, skipping the required `Protocol` / `Endpoint` fields. Undefined /
 * null values are omitted; object values (policy documents) are
 * JSON-stringified; scalars are `String()`-coerced.
 */
export function buildSubscriptionAttributes(sub: Record<string, unknown>): Record<string, string> {
  const attributes: Record<string, string> = {};
  for (const key of SNS_SUBSCRIPTION_ATTRIBUTE_KEYS) {
    const value = sub[key];
    if (value === undefined || value === null) continue;
    attributes[key] = typeof value === 'object' ? JSON.stringify(value) : String(value);
  }
  return attributes;
}

// The canonical AWS attribute PREFIXES, NOT the template spellings. There is
// exactly one HTTP-family prefix (`HTTP`) — see the header note above and
// `SNS_DELIVERY_STATUS_PROTOCOL_SPELLINGS` for the accepted template values.
const SNS_DELIVERY_STATUS_PROTOCOLS = ['Application', 'Firehose', 'HTTP', 'Lambda', 'SQS'] as const;

type SnsDeliveryStatusProtocol = (typeof SNS_DELIVERY_STATUS_PROTOCOLS)[number];

/**
 * The template-side `Protocol` spellings `normalizeDeliveryStatusProtocol`
 * accepts, for the fail-fast error message. This is deliberately NOT
 * `SNS_DELIVERY_STATUS_PROTOCOLS` (the AWS attribute prefixes): the canonical
 * CFn / CDK spelling of the HTTP-family protocol is `http/s`, which is not a
 * prefix, and `https` is accepted only as a tolerated legacy alias. Listing
 * the prefixes would tell a user to write `HTTP`, which is not what the CFn
 * schema's allowed-value list nor `sns.LoggingProtocol` says.
 */
const SNS_DELIVERY_STATUS_PROTOCOL_SPELLINGS = [
  'application',
  'firehose',
  'http/s',
  'lambda',
  'sqs',
] as const;

/**
 * The per-protocol attribute suffixes an inline `DeliveryStatusLogging`
 * entry maps to (`<Protocol><Suffix>` flat attribute names on the topic).
 */
const SNS_DELIVERY_STATUS_ATTRIBUTE_SUFFIXES = [
  'SuccessFeedbackRoleArn',
  'SuccessFeedbackSampleRate',
  'FailureFeedbackRoleArn',
] as const;

/**
 * Flatten a CFn `DeliveryStatusLogging` array into the AWS flat attribute
 * map (`{LambdaSuccessFeedbackRoleArn: '...', ...}`) that
 * `SetTopicAttributes` consumes one entry at a time.
 *
 * Field presence is `!= null`, NOT truthiness, so
 * `SuccessFeedbackSampleRate: 0` is sent as `'0'` instead of being
 * silently skipped (the pre-#1160 truthiness gates dropped a 0 sample
 * rate on create and update alike).
 *
 * `onMalformed` picks the failure mode for a malformed container / entry
 * / unknown protocol, and encodes the create-vs-update distinction
 * (issue #1538):
 *
 * - `'throw'` — a TEMPLATE-borne desired side: an ordinary `create()`, where a
 *   template error must fail fast, naming the offending value.
 * - `'warn'` — a desired side that is NOT template-borne. That is every
 *   `update()`, and — since issue #1551 — a `create()` whose
 *   `CreateContext.replayingState` is set (the rollback executor's
 *   reverse-replacement arm, which revives the old topic from a state record).
 *   The wording below is therefore operation-neutral: on a create there is no
 *   previously-set attribute to reset, only one that is never applied. Same
 *   reason as before:
 *   the rollback executor's revert arm and `cdkd drift --revert` both call
 *   `update()` with a state-derived bag as the DESIRED properties, so a
 *   state record carrying an unsupported protocol / malformed shape (a
 *   hand-written imported template, or a record an older binary wrote)
 *   must warn-and-skip rather than fail the update permanently — there is
 *   no template-side remedy. Skip semantics are well-defined: an entry
 *   whose protocol cannot be canonicalized maps to no attribute names, a
 *   non-array container yields an empty map, and a non-object entry is
 *   skipped. Each warning names the logicalId and the offending value.
 * - `'skip'` — the PREVIOUS side (cdkd state): same tolerance, silently —
 *   warning on every update about a value the user cannot act on from the
 *   template would be pure noise (guard-the-desired-side-only rule).
 *
 * Two entries whose `Protocol` values canonicalize to the SAME prefix
 * (`http/s` + `https`, say) collapse onto one set of attribute names. The
 * collapse is a PER-FIELD merge, not a per-entry overwrite: a later entry
 * overwrites only the sub-fields it declares, because the loop below skips
 * an absent field (`value == null`) rather than clearing it. So
 * `[{http/s, RoleArn: A, SampleRate: 10}, {https, RoleArn: B}]` yields
 * `RoleArn: B` AND `SampleRate: 10`. The warning says exactly that.
 * The case became reachable only with issue #1529, which folded the whole
 * HTTP family onto the single `HTTP` prefix — before it, the `https` arm
 * produced `HTTPS*` names AWS rejected outright, so no such template ever
 * deployed.
 *
 * The collision WARNS rather than throws for the same reason `'warn'` mode
 * exists: the update desired side is also fed by the rollback executor's
 * `update()` replay of a cdkd STATE record, where the user has no
 * template-side remedy. The three malformed-value sites below (unsupported
 * protocol, non-array container, non-object entry) used to throw on that
 * side too, which made such a state record permanently unreplayable —
 * fixed by issue #1538, which moved `update()`'s desired side to `'warn'`
 * while `create()` kept `'throw'`; issue #1551 then extended the downgrade to
 * a create that DECLARES a state replay, leaving the template-path create
 * strict (#1529 / #1536 deliberately left that contract unchanged).
 *
 * `maskSecrets` is the caller's secret masker (issue #1932 item 3, adopted here
 * by issue #1997), threaded from `CreateContext` / `UpdateContext` — see
 * `SecretMaskingContext` in `src/types/resource.ts`. Every warning below names a
 * RESOLVED property value: `DeliveryStatusLogging` reaches this function already
 * resolved, so a `{{resolve:secretsmanager:...}}` scalar inside it is plaintext,
 * and cdkd's other masking boundaries (the deploy engine's error / reason text
 * and the resolver's debug line) do not cover a provider's own `logger.warn`.
 * It defaults to IDENTITY so every existing caller — the diff / import paths and
 * the unit tests — keeps working unchanged.
 *
 * The `'throw'` arm is masked too, and the reason is worth stating because the
 * first cut of this change got it backwards. It claimed a thrown message travels
 * to the deploy engine "which already runs it through `maskSecretsInText`" —
 * FALSE. The engine masks an error message on ONE path only, the events store
 * (`deploy-engine.ts`'s per-event masker); its CLI path logs `error.message`
 * RAW to `logger.error`. So an unmasked throw here printed the resolved bag
 * straight to the terminal at default verbosity, which is a worse exposure than
 * the warn arms this change was written for, not a covered one. Both throw sites
 * therefore run their interpolated value through the same `maskLeaf` walk.
 */
export function buildDeliveryStatusAttributeMap(
  logging: unknown,
  logicalId: string,
  onMalformed: 'throw' | 'warn' | 'skip',
  maskSecrets: SecretMasker = (text) => text
): Map<string, string> {
  const map = new Map<string, string>();
  if (logging == null) return map;
  // ONE masked sink for every warning in this function (issue #1997), rather
  // than a `maskSecrets(...)` at each call: a warning added later is masked by
  // construction instead of by the author remembering. This is the OUTER of two
  // layers — a finished message is always longer than the value inside it, so it
  // can only reach `maskSecretsInText`'s SUBSTRING arm, which ignores needles
  // below `MIN_NEEDLE_LENGTH` (4). `maskLeaf` below is the inner layer: it hands
  // the masker each raw string leaf, which reaches the WHOLE-VALUE arm at any
  // length. The mask is idempotent, so applying both is free.
  const warn = (message: string): void => {
    getLogger().child('SNSTopicProvider').warn(maskSecrets(message));
  };
  // Mask every string leaf (and key) of a value before it is stringified into a
  // warning. `JSON.stringify` escapes `"` / `\` / newlines, so a secret carrying
  // any of them no longer OCCURS in the finished line and the outer sink alone
  // would miss it — which is every Secrets Manager JSON document.
  //
  // Issue #2176 hoisted the walk itself into `../masked-retry-logger.js`. This
  // file's private copy was the THIRD, which is the trigger `elbv2-provider.ts`
  // had recorded for converging them — and it had already DIVERGED: it carried
  // no depth cap, so a self-referential bag recursed until the stack overflowed
  // instead of being bounded at `MASK_WALK_MAX_DEPTH` like the other two.
  const maskLeaf = (value: unknown): unknown => maskDeep(value, maskSecrets);
  const seenProtocols = new Set<SnsDeliveryStatusProtocol>();
  if (!Array.isArray(logging)) {
    if (onMalformed === 'throw') {
      throw new Error(
        `SNS topic ${logicalId}: DeliveryStatusLogging must be an array of ` +
          `{Protocol, ...} objects, got ${JSON.stringify(maskLeaf(logging))}`
      );
    }
    if (onMalformed === 'warn') {
      warn(
        `SNS topic ${logicalId}: DeliveryStatusLogging must be an array of ` +
          `{Protocol, ...} objects, got ${JSON.stringify(maskLeaf(logging))} — treating it ` +
          `as empty, so no delivery-status attribute is applied (on an update, any ` +
          `previously set one is reset). The desired properties can come from a cdkd ` +
          `state record (rollback replay / drift --revert), so this does not fail the ` +
          `operation; fix the template (or the state record on a replay) to clear ` +
          `this warning.`
      );
    }
    return map;
  }
  for (const entry of logging) {
    if (entry == null || typeof entry !== 'object' || Array.isArray(entry)) {
      if (onMalformed === 'throw') {
        throw new Error(
          `SNS topic ${logicalId}: DeliveryStatusLogging entries must be ` +
            `{Protocol, ...} objects, got ${JSON.stringify(maskLeaf(entry))}`
        );
      }
      if (onMalformed === 'warn') {
        warn(
          `SNS topic ${logicalId}: skipping DeliveryStatusLogging entry ` +
            `${JSON.stringify(maskLeaf(entry))} — entries must be {Protocol, ...} objects. ` +
            `Attributes previously set for the skipped entry's protocol are reset, ` +
            `as if the entry had been removed.`
        );
      }
      continue;
    }
    const config = entry as Record<string, unknown>;
    let protocol: SnsDeliveryStatusProtocol;
    if (onMalformed === 'throw') {
      protocol = normalizeDeliveryStatusProtocolOrThrow(config['Protocol'], logicalId, maskLeaf);
    } else {
      const normalized = normalizeDeliveryStatusProtocol(config['Protocol']);
      if (normalized === undefined) {
        if (onMalformed === 'warn') {
          warn(
            `SNS topic ${logicalId}: skipping DeliveryStatusLogging entry with ` +
              `unsupported protocol ${JSON.stringify(maskLeaf(config['Protocol']))}. Expected ` +
              `one of ${SNS_DELIVERY_STATUS_PROTOCOL_SPELLINGS.join(', ')} ` +
              `(case-insensitive). Attributes previously set for the skipped ` +
              `entry's protocol are reset, as if the entry had been removed.`
          );
        }
        continue;
      }
      protocol = normalized;
    }
    // Desired side only ('throw' = create, 'warn' = update), per this
    // function's guard-the-desired-side rule: on the PREVIOUS side the
    // entries come from a cdkd state record, where "declare a single entry
    // per protocol" is advice the user cannot act on.
    if (onMalformed !== 'skip' && seenProtocols.has(protocol)) {
      warn(
        `SNS topic ${logicalId}: DeliveryStatusLogging declares more than one entry ` +
          `for the "${protocol}" attribute prefix (${JSON.stringify(maskLeaf(config['Protocol']))} ` +
          `canonicalizes to it). AWS has one attribute set per prefix, so these are ` +
          `merged per field — a later entry overwrites only the sub-fields it ` +
          `declares, and a field it omits keeps the earlier entry's value. ` +
          `Declare a single entry per protocol.`
      );
    }
    seenProtocols.add(protocol);
    for (const suffix of SNS_DELIVERY_STATUS_ATTRIBUTE_SUFFIXES) {
      const value = config[suffix];
      if (value == null) continue;
      map.set(`${protocol}${suffix}`, stringifyValue(value));
    }
  }
  return map;
}

/**
 * The `SetTopicAttributes` value that resets a REMOVED per-protocol
 * delivery status attribute to its CloudFormation-removal state.
 *
 * Live CFn A/B (2026-08-10, issue #1160): removing `DeliveryStatusLogging`
 * from a template clears both RoleArn attributes (AWS accepts `''` as the
 * clear sentinel — the attribute disappears from `GetTopicAttributes`) and
 * explicitly resets `SuccessFeedbackSampleRate` to `'0'`. The `''`
 * sentinel is REJECTED for the sample rate ("value provided is not an
 * integer between 0-100"), so the numeric reset is the only wire shape
 * that clears it — the `'0'` attribute itself remains visible on the
 * topic afterwards, exactly as it does after a CloudFormation removal.
 */
export function deliveryStatusRemovalResetValue(attributeName: string): string {
  return attributeName.endsWith('SuccessFeedbackSampleRate') ? '0' : '';
}

/**
 * Map a (possibly-mixed-case) protocol string from a CFn template to the
 * canonical PascalCase prefix AWS expects on `${Protocol}<Suffix>`
 * attribute names.
 *
 * Returns `undefined` for unknown / unsupported protocols — callers must
 * handle this case explicitly. Accepting an arbitrary string would
 * defer the failure to AWS, which produces the unhelpful generic
 * `InvalidParameter: Invalid parameter: AttributeName` message; failing
 * fast in cdkd lets us name the offending value.
 *
 * The whole HTTP family collapses onto the single `HTTP` prefix, which is
 * the ONLY HTTP-family prefix AWS accepts (issue #1529, live-verified
 * 2026-08-11 against CloudFormation + `SetTopicAttributes`):
 *
 * - A CFn template carrying the canonical `Protocol: http/s` produces
 *   `HTTPSuccessFeedbackRoleArn` / `HTTPFailureFeedbackRoleArn` /
 *   `HTTPSuccessFeedbackSampleRate` on the live topic. `http/s` is what
 *   `sns.LoggingProtocol.HTTP` and the CFn schema's allowed-value list both
 *   spell, so it is the spelling most real templates carry — and it used to
 *   throw `unsupported DeliveryStatusLogging protocol "http/s"`.
 * - `HTTPS*` attribute names do NOT exist: `SetTopicAttributes` rejects
 *   `HTTPSSuccessFeedbackRoleArn` with `InvalidParameter: Invalid parameter:
 *   AttributeName`. Mapping `https` to a `HTTPS` prefix (the pre-#1529
 *   behavior) therefore produced a hard AWS failure on write and a
 *   permanently-absent attribute on read.
 *
 * Case map (lowercase input → PascalCase prefix):
 *   application → Application
 *   firehose    → Firehose
 *   http/s      → HTTP   (the canonical CFn / CDK L2 spelling)
 *   http        → HTTP   (tolerated alias)
 *   https       → HTTP   (tolerated alias; NOT a distinct prefix)
 *   lambda      → Lambda
 *   sqs         → SQS
 */
export function normalizeDeliveryStatusProtocol(
  input: unknown
): SnsDeliveryStatusProtocol | undefined {
  if (typeof input !== 'string') return undefined;
  const lower = input.toLowerCase();
  switch (lower) {
    case 'application':
      return 'Application';
    case 'firehose':
      return 'Firehose';
    case 'http/s':
    case 'http':
    case 'https':
      return 'HTTP';
    case 'lambda':
      return 'Lambda';
    case 'sqs':
      return 'SQS';
    default:
      return undefined;
  }
}

/**
 * Variant used by `create()` (the `'throw'` mode of
 * `buildDeliveryStatusAttributeMap`) to fail fast when a template carries
 * an unknown protocol. Throws a clear error naming the offending value so
 * the user sees what to fix instead of AWS's generic `InvalidParameter`
 * rejection. `update()`'s desired side warns-and-skips instead (issue
 * #1538) because its bag can be a cdkd state record on a rollback replay
 * or `drift --revert`.
 */
function normalizeDeliveryStatusProtocolOrThrow(
  input: unknown,
  logicalId: string,
  // The caller's secret masker (issue #1997), defaulting to IDENTITY so the
  // existing single caller's behavior is unchanged when none is supplied. This
  // is the THIRD throw site in this module that names a resolved property
  // value, and it is reached from the SAME `'throw'` arm as the other two — the
  // engine's CLI path logs `error.message` raw, so leaving it unmasked would
  // have re-opened the exposure the sibling fixes just closed.
  maskValue: (value: unknown) => unknown = (value) => value
): SnsDeliveryStatusProtocol {
  const normalized = normalizeDeliveryStatusProtocol(input);
  if (normalized === undefined) {
    throw new Error(
      `SNS topic ${logicalId}: unsupported DeliveryStatusLogging protocol ${JSON.stringify(
        maskValue(input)
      )}. Expected one of ${SNS_DELIVERY_STATUS_PROTOCOL_SPELLINGS.join(', ')} (case-insensitive).`
    );
  }
  return normalized;
}

/**
 * Build a `{canonicalPascalCase: stateRecordedCase}` lookup from state's
 * recorded `DeliveryStatusLogging[]`. Used by `mapDeliveryStatusLogging`
 * to surface AWS-current entries in the same case the state holds, so
 * the positional comparator does not fire false drift on case alone.
 *
 * Unrecognized state-side protocols are silently dropped; the
 * comparator falls back to the canonical PascalCase prefix for those
 * (worst case: a one-time drift entry that disappears once the user
 * re-records the state).
 */
export function stateProtocolCaseMap(
  stateLogging: unknown
): Map<SnsDeliveryStatusProtocol, string> {
  const map = new Map<SnsDeliveryStatusProtocol, string>();
  if (!Array.isArray(stateLogging)) return map;
  for (const entry of stateLogging) {
    if (!entry || typeof entry !== 'object') continue;
    const raw = (entry as Record<string, unknown>)['Protocol'];
    if (typeof raw !== 'string') continue;
    const normalized = normalizeDeliveryStatusProtocol(raw);
    if (!normalized) continue;
    // First state entry per canonical protocol wins. Since issue #1529
    // folded the HTTP family onto one prefix, two entries CAN legitimately
    // normalize to the same key (`http/s` + `https`) — that template warns
    // but deploys, so state really can hold both. First-wins just picks
    // which spelling the reverse map echoes back; either choice matches one
    // of the recorded entries. Note the resulting array is shorter than the
    // recorded one (two entries in, one out), so a resource whose drift
    // baseline falls back to template `properties` rather than
    // `observedProperties` would see a positional length mismatch — an
    // argument for the "declare a single entry per protocol" warning, not a
    // reason to synthesize a duplicate entry here.
    if (!map.has(normalized)) map.set(normalized, raw);
  }
  return map;
}

/**
 * Reverse-map per-protocol flat attributes returned by GetTopicAttributes
 * back to the CFn `DeliveryStatusLogging` array shape. Always emits an
 * array (even `[]`) so the v3 `observedProperties` baseline catches a
 * console-side enable on a previously-default topic (PR #145 always-emit
 * pattern).
 *
 * Entries are sorted by canonical PascalCase `Protocol` (alphabetical) for
 * stable positional compare since AWS does not preserve template order.
 * State-driven order reconciliation is unnecessary here — every entry's
 * identity is fully determined by `Protocol` (no two entries share a
 * protocol).
 *
 * The `Protocol` value emitted in each entry uses the case the state
 * recorded for that protocol (when known via `stateCaseMap`); falls back
 * to the canonical PascalCase prefix otherwise. This keeps the comparator
 * from firing false drift when state holds CDK's `'lambda'` and AWS's
 * attribute prefix is `Lambda`.
 *
 * `SuccessFeedbackSampleRate` is surfaced as the AWS-returned string
 * (`'0'`-`'100'`) to match the CFn shape (`String` per the docs).
 */
export function mapDeliveryStatusLogging(
  attrs: Record<string, string>,
  stateCaseMap: Map<SnsDeliveryStatusProtocol, string> = new Map()
): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const protocol of SNS_DELIVERY_STATUS_PROTOCOLS) {
    const success = attrs[`${protocol}SuccessFeedbackRoleArn`];
    const sample = attrs[`${protocol}SuccessFeedbackSampleRate`];
    const failure = attrs[`${protocol}FailureFeedbackRoleArn`];
    if (success === undefined && sample === undefined && failure === undefined) continue;
    const entry: Record<string, unknown> = {
      Protocol: stateCaseMap.get(protocol) ?? protocol,
    };
    if (success !== undefined) entry['SuccessFeedbackRoleArn'] = success;
    if (sample !== undefined) entry['SuccessFeedbackSampleRate'] = sample;
    if (failure !== undefined) entry['FailureFeedbackRoleArn'] = failure;
    result.push(entry);
  }
  return result;
}
