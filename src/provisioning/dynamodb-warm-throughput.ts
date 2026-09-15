/**
 * The two DynamoDB `WarmThroughput` rules that `AWS::DynamoDB::Table` and
 * `AWS::DynamoDB::GlobalTable` both need, in ONE spelling.
 *
 * `WarmThroughput` is the same CloudFormation block on both types, and both
 * providers have to answer the same two questions about it before an
 * `UpdateTable` / `CreateTable` goes out:
 *
 *  1. **Is this block SENDABLE, and as what numbers?** CloudFormation is
 *     stringly typed, so `{ReadUnitsPerSecond: '12000'}` — or anything that
 *     came back from an `Fn::Sub` — arrives as a STRING and must not be
 *     forwarded verbatim into a numeric `Long` field.
 *  2. **Would sending it LOWER what AWS already reports?** Warm throughput
 *     only ever rises with a table's traffic and AWS REJECTS a call that
 *     lowers it (`decreasing WarmThroughput is not supported`, measured live
 *     us-east-1 2026-08-13 for issue #1768).
 *
 * **Provenance, stated precisely because it is easy to over-claim.** Exactly
 * ONE of these rules ever shipped: `AWS::DynamoDB::Table` got them in PR #1808
 * (issues #1760 / #1768), and the `AWS::DynamoDB::GlobalTable` side never
 * existed outside the change that created this file (issue #1857). So this is
 * the Table rule LIFTED — not two shipped rules reconciled, and no deployed
 * behaviour changed for either type when it moved here.
 *
 * What WAS compared is the lifted rule against the GlobalTable spelling
 * drafted alongside it, over the shapes both had to answer (a quoted numeric
 * string, a partially usable block, a mixed decrease/increase, an absent live
 * value, a zero, a negative, a non-numeric string, a whitespace string, an
 * explicit `undefined` / `null`, a boolean, an empty block, a scalar, an
 * array). {@link isWarmThroughputDecrease} agreed on every one; the coercion
 * agreed on all but a whitespace-only string, where a bare `Number('   ')` is
 * `0` rather than `NaN`. This module keeps the REFUSING answer for that shape,
 * since `'   '` is not a capacity anyone declared and a warm throughput of 0
 * is not a request AWS can honour. That is a DRAFT reconciled against a
 * shipped rule, which is worth less than two shipped rules agreeing — the
 * reason to read the probe list as a design note rather than as field
 * evidence.
 *
 * Living here rather than in either provider is the point. A decrease guard is
 * three clauses that all FAIL OPEN for different reasons, and two files
 * spelling it independently is two chances for a later "fix" to change one of
 * them — at which point the sibling type silently keeps the old answer, and
 * nothing in the tree says which is intended. Same class as
 * `emr-configuration.ts`, and the same reason.
 *
 * Deliberately NOT here: everything only ONE provider has. The `Table` side's
 * `isSendableWarmThroughput` / `isRefusedWarmThroughput` /
 * `declaresWarmThroughput` / `warmThroughputAlreadyMatches` are its drift-side
 * and already-matches gates, which `GlobalTable` has no counterpart to (issue
 * #1742 strips the per-index `WarmThroughput` from BOTH of its drift
 * comparison sides unconditionally, so drift never asks the question there);
 * the `GlobalTable` side's `warmThroughputDiagnostic` builds a
 * `ThroughputDiagnostic` that only that provider's collector understands.
 * Moving a helper with one caller here would buy nothing and cost a hop.
 *
 * Issues: #1760 / #1768 (Table, PR #1808), #1857 (GlobalTable).
 */

// A `.ts` extension, deliberately, against this repo's ordinary `.js` rule —
// the same reason `stateful-types.ts` spells ITS import of this module that
// way: `scripts/audit-stateful-candidates.ts` runs under BARE `node`, whose
// resolution is literal, and this module is on that entrypoint's import
// closure. `config-shape.ts` is a LEAF (no imports of its own), so the closure
// ends here; `tests/unit/scripts/stateful-candidates.test.ts` is what goes red
// when it does not.
import { coerceCfnInteger } from './config-shape.ts';

/**
 * The two `WarmThroughput` members, in the ONE order every message, every
 * comparison and every emitted block uses. A shared order is what makes two
 * blocks carrying the same numbers compare equal by `deepEqual` and serialize
 * to the same wire bytes regardless of the order the template wrote them in.
 */
export const WARM_THROUGHPUT_MEMBERS = ['ReadUnitsPerSecond', 'WriteUnitsPerSecond'] as const;

/**
 * The coerced, ready-to-send `WarmThroughput` block. Numbers only.
 *
 * The members are `number | undefined` rather than plain optional so the type
 * stays assignable BOTH ways against the SDK's own `WarmThroughput` under
 * `exactOptionalPropertyTypes` — the live side is read out of a
 * `DescribeTable` response and the desired side is handed to an `UpdateTable`
 * input, so a one-way-only shape would need a cast at one end or the other,
 * and a cast is exactly what let the raw bag through unchecked before.
 * Coercion never WRITES an explicit `undefined`; only the SDK's own shape can
 * carry one, and every reader here tests `!== undefined`.
 */
export interface WarmThroughputSpec {
  ReadUnitsPerSecond?: number | undefined;
  WriteUnitsPerSecond?: number | undefined;
}

/** Outcome of {@link coerceWarmThroughput}. */
export interface WarmThroughputCoercion {
  /**
   * The block to SEND, or `undefined` when nothing usable survived.
   *
   * **This field's PRESENCE is the sendability predicate.** Anything asking
   * "should this be sent?" calls {@link coerceWarmThroughput} and tests
   * `spec`, rather than re-deriving a second opinion about the same bag —
   * a predicate written as a second opinion is what eventually disagrees with
   * the coercion that actually builds the request.
   *
   * `dynamodb-table-provider.ts` spells that test as a NAMED private
   * `isSendableWarmThroughput`, and since PR #1808 it is literally
   * `coerceWarmThroughput(value) !== undefined` — i.e. the same rule, not a
   * competing one. It earns its name there because the drift side asks the
   * question too (`declaresWarmThroughput`), so the two must provably answer
   * alike; `GlobalTable` has no drift-side asker and therefore no second
   * caller to align with.
   */
  readonly spec?: WarmThroughputSpec;
  /** DECLARED members that did not coerce to a finite number, in member order. */
  readonly droppedMembers: readonly string[];
}

/**
 * A CloudFormation-borne numeric property, or `undefined` when the value is
 * not a usable number.
 *
 * Plain `Number()` coercion is NOT good enough and the tree learned it three
 * separate times: `Number(null)`, `Number('')`, `Number([])`, `Number(false)`
 * and `Number('   ')` are all **0**, not `NaN` — so a live `0` would compare
 * EQUAL to a desired `null` / `''` / `[]` / `false`, and a whitespace-only
 * string would be forwarded as a request for zero units.
 *
 * A YAML-borne numeric STRING is still accepted, because that is a real
 * template shape and `'12000'` genuinely means 12000.
 *
 * The accepted STRING set is `Number()`'s, which is WIDER than a decimal
 * integer: `'0x1e'`, `'0o36'`, `'1e3'`, `'30.5'` and `' 30 '` all coerce.
 * CloudFormation accepts NONE of those on a DynamoDB capacity and only the
 * LAST on `AWS::Logs::LogGroup.RetentionInDays` (both measured — the tables
 * are on {@link toCfnInteger}), so this helper is for the GUARD callers only:
 * `stateful-types.ts`'s `has-retention`, the DynamoDB already-matches /
 * decrease / zero-capacity tests, the live-readback compares. A guard is safe
 * on the wider set — over-acceptance there can only produce MORE refusals or
 * skip fewer calls. A caller that FORWARDS the number to AWS reads through the
 * grammar CloudFormation measured for that handler instead:
 * `logs-loggroup-provider.ts` through {@link toCfnInteger} (issue
 * [#2698](https://github.com/go-to-k/cdkd/issues/2698)), every DynamoDB
 * capacity / throughput forwarder (`coerceWarmThroughput` below, the
 * `GlobalTable` provider's `ProvisionedThroughput` / `OnDemandThroughput`
 * readers AND the diagnostic / mirror predicates paired with them) through
 * `config-shape.ts`'s `coerceCfnInteger` (issue
 * [#3135](https://github.com/go-to-k/cdkd/issues/3135)). A forwarder left on
 * THIS helper sends `Number('0x9')` for a template CloudFormation refuses.
 *
 * EXPORTED, and not because warm throughput needs it exported. This exact rule
 * was hand-written three times — here, as `dynamodb-table-provider.ts`'s
 * `capacityNumber` (byte-identical), and as `dynamodb-globaltable-provider.ts`'s
 * `toFiniteNumber` (a different spelling of the same total function) — which is
 * precisely the divergence this module exists to stop: the next "fix" to one of
 * them would have left the other two answering differently, with nothing in the
 * tree saying which was intended. It reads `ReadCapacityUnits` /
 * `MaxReadRequestUnits` / `MinCapacity` as readily as it reads
 * `ReadUnitsPerSecond`; there is only ever one right answer for "is this
 * stringly-typed CFn value a number I can send?".
 */
export function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) ? n : undefined;
  }
  return undefined;
}

/**
 * A CloudFormation-borne `Integer` property, read the way CloudFormation reads
 * it, or `undefined` when CloudFormation would REJECT the value.
 *
 * The sibling of {@link toFiniteNumber} for the callers that FORWARD the number
 * to AWS. That helper is `Number()`, which accepts hex, octal, binary,
 * exponent and decimal-point spellings; CloudFormation does not, and a
 * provider forwarding `Number('0x1e')` sends `30` for a template CloudFormation
 * would have refused outright. Measured live on
 * `AWS::Logs::LogGroup.RetentionInDays` (us-east-1, 2026-09-14, issue
 * [#2698](https://github.com/go-to-k/cdkd/issues/2698); a one-resource stack
 * updated per spelling, live value read back with `logs describe-log-groups`):
 *
 * ```
 * template spelling        CloudFormation                   live retention after
 * 30 (JSON number)         accepted                         30
 * "60"                     accepted                         60
 * "+30"                    accepted                         30
 * " 30 " (padded)          accepted                         30
 * "  " (whitespace only)   accepted, treated as ABSENT      none (policy REMOVED)
 * "" (empty string)        accepted, treated as ABSENT      none (policy REMOVED)
 * property absent          accepted                         none (policy REMOVED)
 * "0x1e"                   REJECTED (handler)               unchanged
 * "1e3"                    REJECTED (handler)               unchanged
 * "30.5"                   REJECTED (handler)               unchanged
 * "30.0"                   REJECTED (handler)               unchanged
 * "abc"                    REJECTED (handler)               unchanged
 * true / false             REJECTED (handler)               unchanged
 * 0 / "0"                  REJECTED (handler: enum)         unchanged
 * null                     REJECTED at update-stack         unchanged
 * ```
 *
 * So the accepted string grammar is `optional sign + decimal digits`, with
 * surrounding whitespace TRIMMED — `/^\s*[+-]?\d+\s*$/`, then `Number()`. The
 * digits grammar is `config-shape.ts`'s {@link coerceCfnInteger}, reused rather
 * than respelled so the two cannot drift on it; the ONE difference is the
 * trim, and it is a measured difference, not a relaxation: that helper's own
 * measurement (a NESTED `GenerateSecretString.PasswordLength`, 2026-09-13)
 * saw `" 12 "` REJECTED where this one saw `" 30 "` accepted. Per-handler
 * behaviour varies on padding, so each helper carries its own measurement and
 * a caller picks by the property it forwards.
 *
 * The DynamoDB measurement, read beside the Logs one so the two grammars sit
 * side by side (`AWS::DynamoDB::Table.ProvisionedThroughput.ReadCapacityUnits`
 * plus one `WriteCapacityUnits` row, us-east-1, 2026-09-14, issue
 * [#3135](https://github.com/go-to-k/cdkd/issues/3135); same protocol, live
 * value read back with `dynamodb describe-table`). "properties validation" is
 * CloudFormation's own template-property check, which fires BEFORE the
 * handler; "handler" is the DynamoDB resource handler's model validation:
 *
 * ```
 * template spelling        CloudFormation                          live RCU after
 * 5 (JSON number)          accepted                                5
 * "6"                      accepted                                6
 * "+8"                     accepted                                8
 * "010"                    accepted (decimal, not octal)           10
 * " 7 " (padded)           REJECTED (properties validation)        unchanged
 * "7 " (trailing space)    REJECTED (properties validation)        unchanged
 * "" (empty string)        REJECTED (properties validation)        unchanged
 * "0x9" (RCU or WCU)       REJECTED (handler)                      unchanged
 * "1e1"                    REJECTED (Validation failed)            unchanged
 * "6.0"                    REJECTED (same)                         unchanged
 * "6.5"                    REJECTED (same)                         unchanged
 * ```
 *
 * The two agree on the digits (`/^[+-]?\d+$/`, hex / exponent / decimal-point
 * rejected by both) and DISAGREE on padding: the Logs handler trims, DynamoDB
 * rejects `" 7 "` and `"7 "` before any handler runs. So the DynamoDB
 * forwarders read through {@link coerceCfnInteger} itself — the no-trim
 * grammar — and NOT through this helper, whose trim is licensed by the Logs
 * measurement alone. `""` is not portable as "absent" either: on a REQUIRED
 * Integer it is rejected outright, where `RetentionInDays` reads it as absent.
 *
 * What this helper does NOT decide: the empty / whitespace-only strings above
 * are CloudFormation's spelling of "property absent", which is a statement
 * about the PROPERTY, not about the number — they answer `undefined` here, and
 * the caller decides whether `undefined` means "absent" or "unusable" from the
 * raw value (`logs-loggroup-provider.ts`'s `assertUsableRetention` is the
 * reference). `0` / `'0'` parse to `0` here; whether zero is usable is again the
 * property's question (the log-group handler rejects it by enum).
 */
export function toCfnInteger(value: unknown): number | undefined {
  return coerceCfnInteger(typeof value === 'string' ? value.trim() : value);
}

/**
 * Coerce a CFn `WarmThroughput` block to the numeric shape the SDK's `Long`
 * fields accept, PER MEMBER.
 *
 * PER MEMBER, not whole-block, and that distinction is the point: a block
 * whose write half is an unresolved intrinsic still has a perfectly good read
 * half, and dropping both would silently discard a value the template really
 * did ask for. The dropped member is NAMED (`droppedMembers`) so the caller's
 * warning can say which half went missing instead of reporting the whole
 * property.
 *
 * A block with NO usable member yields `spec: undefined` — refused rather than
 * forwarded, because forwarding a malformed block surfaces as an opaque AWS
 * validation error naming neither cdkd nor the property. `droppedMembers` is
 * still populated in that case, so a REFUSAL message can name what it refused;
 * a block that is not an object at all (an unresolved `Fn::If`, a scalar, an
 * array) has no member to name and reports none, which is what lets a caller
 * word "one half went missing" differently from "the block is unusable".
 *
 * Pure: takes the raw bag, returns numbers, logs nothing. Each caller owns its
 * own message, so the wording stays consistent across that provider's send
 * sites without forcing one wording across both providers.
 *
 * A member is read through {@link coerceCfnInteger} — CloudFormation's
 * measured DynamoDB Integer grammar (issue #3135, table on
 * {@link toCfnInteger}) — because this block is FORWARDED. A spelling
 * CloudFormation rejects (`" 7 "`, `"0x9"`, `"1e1"`, `"6.5"`) is therefore a
 * DROPPED member, named in `droppedMembers` exactly like an unresolved
 * intrinsic: the caller's diagnostic reports it and the live AWS value is left
 * alone. It is never read as ABSENT (the `=== undefined` test above runs on
 * the RAW value), and it is never forwarded as `Number()`'s reading, which
 * sent `7` for a template CloudFormation refuses.
 */
export function coerceWarmThroughput(raw: unknown): WarmThroughputCoercion {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { droppedMembers: [] };
  const bag = raw as Record<string, unknown>;
  const spec: WarmThroughputSpec = {};
  const droppedMembers: string[] = [];
  for (const member of WARM_THROUGHPUT_MEMBERS) {
    // `=== undefined` rather than `in`: a JSON / YAML template cannot carry an
    // explicitly-undefined member, so the two agree on every reachable shape,
    // and this is the spelling `dynamodb-table-provider.ts` shipped and its
    // tests pin.
    if (bag[member] === undefined) continue;
    const coerced = coerceCfnInteger(bag[member]);
    if (coerced === undefined) {
      droppedMembers.push(member);
      continue;
    }
    spec[member] = coerced;
  }
  if (Object.keys(spec).length === 0) return { droppedMembers };
  return { spec, droppedMembers };
}

/**
 * Whether the COERCED desired `WarmThroughput` would LOWER what AWS already
 * reports.
 *
 * Measured live (us-east-1, 2026-08-13, issue #1768) against a table AWS
 * reports `{ReadUnitsPerSecond: 12000, WriteUnitsPerSecond: 4000}` for:
 *
 * ```
 * UpdateTable WarmThroughput={ReadUnitsPerSecond: 6000, WriteUnitsPerSecond: 2000}
 *   ValidationException: One or more parameter values were invalid: Requested
 *   ReadUnitsPerSecond for WarmThroughput for table is lower than current
 *   WarmThroughput, decreasing WarmThroughput is not supported
 * UpdateTable WarmThroughput={ReadUnitsPerSecond: 6000}      -> same rejection
 * UpdateTable WarmThroughput={WriteUnitsPerSecond: 2000}     -> same rejection, naming WriteUnitsPerSecond
 * UpdateTable WarmThroughput={12000, 4000}  (re-assert)      -> ACCEPTED
 * ```
 *
 * So the value is one AWS raises with the table's traffic and never lowers,
 * and a decrease is REJECTED rather than accepted-and-ignored — which is what
 * had to be measured before choosing, because the two produce different
 * correct answers. The caller SKIPS the call on a true here.
 *
 * Evaluated on the COERCED spec, never on the raw bag: analysing the raw bag
 * makes the verdict describe a request that is not the one being sent (a
 * dropped member is not part of the call and must not be part of the
 * comparison).
 *
 * Semantics, all three chosen to FAIL OPEN — i.e. to let the call through and
 * leave AWS as the authority — because a false positive here silently drops a
 * legitimate INCREASE, which is a real capacity change the user asked for,
 * while a false negative merely reproduces the pre-fix behaviour of an
 * AWS-side rejection that names the property:
 *  - DECLARED members only. An absent member is not a request to lower
 *    anything, so it takes no part in the verdict.
 *  - MIXED is not a decrease. One member below live and the other above means
 *    the call carries a genuine increase; AWS decides.
 *  - An absent or unusable LIVE counterpart is not a decrease. Without a
 *    number to compare against there is no evidence of one. Only the LIVE side
 *    can reach that arm: the desired side is a COERCED spec, so a malformed
 *    template value has already been dropped by {@link coerceWarmThroughput}.
 *
 * A decrease therefore requires every declared member to be at-or-below live
 * AND at least one to be strictly below.
 *
 * The skip this drives is right for EVERY `update()` caller — the deploy
 * engine, `cdkd drift --revert`, and the rollback executor's two revert arms —
 * because none of them can make AWS lower the value, so none loses anything a
 * doomed call would have achieved.
 */
export function isWarmThroughputDecrease(
  desired: Readonly<WarmThroughputSpec> | undefined,
  live: Readonly<WarmThroughputSpec> | undefined
): boolean {
  if (desired === undefined || live === undefined) return false;
  let sawDecrease = false;
  for (const member of WARM_THROUGHPUT_MEMBERS) {
    if (desired[member] === undefined) continue;
    const wanted = toFiniteNumber(desired[member]);
    const current = toFiniteNumber(live[member]);
    // Unusable on either side: fail open, and stop — a partial verdict on the
    // remaining member could still skip a call carrying an unreadable one.
    if (wanted === undefined || current === undefined) return false;
    if (wanted > current) return false;
    if (wanted < current) sawDecrease = true;
  }
  return sawDecrease;
}
