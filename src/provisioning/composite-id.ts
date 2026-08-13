import type { ResourceDeleteResult } from '../types/resource.js';
import { ProvisioningError } from '../utils/error-handler.js';

/**
 * Refuse a composite physicalId whose segments would make it ambiguous
 * (issue [#1672](https://github.com/go-to-k/cdkd/issues/1672)).
 *
 * ## Why a composite id exists at all
 *
 * `ResourceProvider` passes a SINGLE `physicalId: string` as a resource's
 * identity, while CloudFormation keeps the physical id and its containing
 * scope as separate values. So every provider whose type needs more than one
 * value to address the resource PACKS them into one string joined by
 * {@link COMPOSITE_ID_SEPARATOR} — `<databaseName>|<tableName>` for
 * `AWS::Glue::Table`, `<apiId>|<typeName>|<fieldName>` for
 * `AWS::AppSync::Resolver`, and so on.
 *
 * ## Why it has to be guarded
 *
 * The separator is NOT escaped, so a segment that itself contains a `|`
 * produces an id with the wrong arity. Every decode site splits the stored id
 * back apart and the extra segment shifts everything — for a Glue table named
 * `a|b` in database `mydb` the recorded id `mydb|a|b` decodes to database
 * `mydb`, table `a`. Both halves are non-empty, so every existing
 * "is this id well-formed?" guard passes and the deploy SUCCEEDS. What breaks
 * is everything afterwards: `cdkd destroy` deletes the WRONG resource if one
 * exists under the decoded pair (or warn-and-skips, reporting success while
 * the real resource stays alive and billing), and `cdkd drift` reads back
 * `undefined` forever.
 *
 * AWS itself accepts such a name — verified live us-east-1 2026-08-12,
 * `glue:CreateTable` with `TableInput.Name: 'a|b'` succeeds — and
 * CloudFormation manages the resource fine. The limitation is cdkd's own, so
 * the honest answer is to REFUSE at deploy time with a message that says so,
 * rather than to record an id that silently names something else. Escaping the
 * separator, or dropping the packing where the decode sites already receive
 * the properties bag, are the two real fixes and both remain open on #1672;
 * this guard is what closes the data-loss path in the meantime.
 *
 * ## Two entry points, mirroring `config-shape.ts`
 *
 * {@link packCompositeId} is the ACTION (throw, or warn-and-pack under the
 * replay downgrade) and {@link compositeIdSeparatorRefusal} is the bare
 * PREDICATE, for a caller whose response is neither — the `import()` paths
 * warn and return `null` (`skipped-not-found`), which is the idiom those
 * methods already use for every other unusable id. Both share one message
 * builder so the two can never drift.
 *
 * ## Where to place the call
 *
 * Prefer computing the id BEFORE the create call rather than after it. The
 * refusal is a pre-flight check, and a throw placed after the AWS mutation has
 * already committed would leave an orphan resource behind with no state
 * record. Only where a segment is derived from the create RESPONSE (an
 * AWS-generated id) does the call have to sit after it — and those segments
 * are structurally incapable of carrying a `|` anyway. A post-call site must
 * also sit OUTSIDE the `try` whose `catch` re-wraps as
 * `ProvisioningError('Failed to create …')`, or a refusal would be
 * mis-reported as an AWS creation failure.
 *
 * ## What this does NOT cover
 *
 * The claim is "every composite packer this change reaches", not "every `|`
 * join in the tree". One deliberate exclusion, recorded so the scope is not
 * read as wider than it is:
 *
 * - **`intrinsic-function-resolver.ts`'s `|` joins** (the WAFv2 and
 *   `AWS::Events::Rule` arms) are out of scope by KIND, not by ownership: they
 *   build a `Ref` VALUE for the template resolver, never a physicalId cdkd
 *   records and later splits. Nothing decodes them, so an ambiguous join has
 *   no decode site to go wrong at.
 *
 * ## Guarding the PACKERS is not the whole story
 *
 * A packer that refuses ambiguity does nothing about an id an EARLIER binary
 * already recorded, or one an `import` was handed — and a type whose decoder is
 * loose will mis-decode both. Issue #1711 is where that was learned:
 * `AWS::Route53::RecordSet`'s `parseRecordSetCompositeId` accepts any three
 * NON-EMPTY segments, so a record name carrying two pipes decoded to a
 * DIFFERENT hosted zone at three sites this helper never sees — an `import`
 * early accept, an identity-resolution short-circuit, and `delete`'s own parse,
 * where `cdkd destroy` then reported success over a live record. When adopting
 * this guard for a new type, audit its DECODE sites in the same change and make
 * each one cross-check the parsed segments against something it can verify them
 * with (Route 53 uses the template's own `Name` / `Type`).
 */

/** The character every composite physicalId in this codebase joins segments with. */
export const COMPOSITE_ID_SEPARATOR = '|';

/** The issue tracking the real fix (escaping, or not packing at all). */
const COMPOSITE_ID_ISSUE_URL = 'https://github.com/go-to-k/cdkd/issues/1672';

/**
 * One segment of a composite physicalId.
 *
 * `name` is the id-shape token — it renders BOTH the offending segment's
 * meaning in the message and the id shape (`<databaseName>|<tableName>`), so
 * the two cannot describe different things.
 */
export interface CompositeIdSegment {
  /** Id-shape token for this position, e.g. `databaseName` / `tableName`. */
  readonly name: string;
  /**
   * The segment's value, deliberately typed `unknown`.
   *
   * Every call site reads it off the property bag through an unvalidated cast
   * (`tableInput['Name'] as string | undefined`), so the declared type is a
   * claim about the TEMPLATE, not a guarantee about the value. A hand-written
   * template may put an ARRAY there — `Name: ['a|b']` is truthy, survives the
   * provider's own `!tableName` required-field gate, and reaches the pack as
   * an array whose `String(...)` is `'a|b'`, i.e. the exact ambiguous id this
   * guard exists to refuse. So the predicate below tests the STRINGIFIED form
   * rather than `typeof value === 'string'`; the two are identical for a real
   * string and differ on precisely the shapes that would otherwise slip
   * through. Numbers and booleans still cannot carry the separator, but that
   * is a property of the VALUE, not of the declared type.
   *
   * Known bound: a plain object (an unresolved intrinsic) stringifies to
   * `[object Object]`, which contains no `|` and is therefore not refused
   * here. That is a malformed-value problem the `config-shape.ts` guards own,
   * not an ambiguous-id one — the resulting id is wrong but it is not wrong in
   * a way that decodes to a DIFFERENT resource.
   */
  readonly value: unknown;
}

/** Options shared by {@link packCompositeId}. */
export interface CompositeIdOptions {
  /**
   * When supplied, an offending segment WARNS and the ambiguous id is packed
   * anyway (the pre-guard behavior) instead of throwing.
   *
   * Pass it from a create call that is replaying a cdkd STATE record
   * (`CreateContext.replayingState`, issue #1463) and from the re-create half
   * of a delete-then-create `update()`. In both cases the value is not
   * template-borne, so a refusal would leave the user with no remedy short of
   * hand-editing `state.json` — and on the update path the delete has already
   * committed, so it would strand a half-deleted resource. See
   * `.claude/rules/providers.md`.
   */
  readonly onRefusal?: (message: string) => void;
}

/** Render `<a>|<b>|<c>` from the segment names. */
function idShape(segments: readonly CompositeIdSegment[]): string {
  return segments.map((segment) => `<${segment.name}>`).join(COMPOSITE_ID_SEPARATOR);
}

/**
 * The refusal sentence for a composite id whose segments carry the separator,
 * or `undefined` when the id is unambiguous.
 *
 * Every offending segment is named, not just the first: a template that
 * mis-names one value frequently mis-names its sibling too, and reporting them
 * one deploy at a time is the shape of remedy nobody finishes.
 */
export function compositeIdSeparatorRefusal(
  resourceType: string,
  logicalId: string,
  segments: readonly CompositeIdSegment[]
): string | undefined {
  // The STRINGIFIED form, not `typeof value === 'string'` — identical for a
  // real string, and the only spelling that catches the array / boxed shapes an
  // unvalidated `as string` cast lets through. See {@link CompositeIdSegment.value}.
  const offending = segments.filter((segment) =>
    String(segment.value).includes(COMPOSITE_ID_SEPARATOR)
  );
  if (offending.length === 0) return undefined;

  const named = offending
    .map((segment) => `${segment.name} '${String(segment.value)}'`)
    .join(' and ');

  return (
    `${resourceType} ${logicalId}: ${named} contains '${COMPOSITE_ID_SEPARATOR}', which cdkd uses ` +
    `as the separator in this type's physical id (${idShape(segments)}). Recording it would ` +
    `produce an id that decodes back to a DIFFERENT resource, so a later cdkd destroy / drift / ` +
    `update would target the wrong one — or silently skip it while the real resource stays ` +
    `alive. AWS accepts the name and CloudFormation manages such a resource fine; this is a ` +
    `cdkd limitation tracked in ${COMPOSITE_ID_ISSUE_URL}. Rename the resource so no segment ` +
    `contains '${COMPOSITE_ID_SEPARATOR}', or manage it outside cdkd.`
  );
}

/**
 * Join the segments into a composite physicalId, REFUSING one that would be
 * ambiguous.
 *
 * @throws ProvisioningError when a segment contains {@link COMPOSITE_ID_SEPARATOR},
 *   unless `options.onRefusal` is supplied — under which the message is handed
 *   to the callback and the ambiguous id is returned, keeping the pre-guard
 *   behavior.
 */
export function packCompositeId(
  resourceType: string,
  logicalId: string,
  segments: readonly CompositeIdSegment[],
  options?: CompositeIdOptions
): string {
  const refusal = compositeIdSeparatorRefusal(resourceType, logicalId, segments);
  if (refusal !== undefined) {
    if (options?.onRefusal) {
      options.onRefusal(
        `${refusal} Continuing with the ambiguous id because the value comes from a cdkd state ` +
          `record, which no template edit can repair; the same value is REFUSED on a ` +
          `template-path create.`
      );
    } else {
      throw new ProvisioningError(refusal, resourceType, logicalId);
    }
  }

  return segments.map((segment) => String(segment.value)).join(COMPOSITE_ID_SEPARATOR);
}

/**
 * The expected shape of a type's composite physicalId, for the DECODE sites.
 *
 * The sibling of {@link CompositeIdSegment}, which describes a pack. This one
 * carries no values — a decode site has only the malformed string.
 */
export interface CompositeIdFormat {
  /**
   * Human name of the resource, as it already reads in the four messages that
   * got this right before #1657 (`API Gateway Method`, `VPCGatewayAttachment`).
   * Deliberately NOT the CFn type: the type is already carried structurally on
   * `ProvisioningError`, and the prose reads better without it.
   */
  readonly label: string;
  /**
   * Segment names in order, each rendered `<name>`.
   *
   * Keep these in step with the type's `packCompositeId` segment names — the
   * pack side is what actually produces the id, so a message naming anything
   * else instructs the user to write a value no code path emits. An earlier
   * cut of this change rendered `AWS::EC2::VPCGatewayAttachment` as
   * `IGW|<vpcId>` on the belief that `IGW` was a fixed token cdkd packs; it is
   * not (the packer emits the real `internetGatewayId`), and a user repairing
   * state.json as instructed would have produced
   * `DetachInternetGateway(InternetGatewayId: "IGW")`.
   */
  readonly segments: readonly string[];
  /**
   * A second accepted form, appended as `or <text>`. Only `AWS::S3Tables::Table`
   * has one today (a bare table ARN alongside the composite).
   */
  readonly alsoAccepts?: string;
}

/** Render the expected id shape, e.g. `<databaseName>|<tableName>`. */
function formatShape(segments: readonly string[]): string {
  return segments.map((segment) => `<${segment}>`).join(COMPOSITE_ID_SEPARATOR);
}

/**
 * The message EVERY malformed-composite-id decode site emits (issue
 * [#1657](https://github.com/go-to-k/cdkd/issues/1657)).
 *
 * ## Why one builder
 *
 * Roughly half the decode sites stated the expected shape and half only echoed
 * the value back, and the format is documented nowhere else — so on the silent
 * half the message was the user's only possible route to the answer and it did
 * not carry it. Routing the sites that already got it right through the same
 * builder is what stops them drifting back.
 *
 * ## This is a WORDING fix, not an acceptance change
 *
 * Each caller keeps its own split-and-guard exactly as it was. The arities
 * genuinely differ (some sites accept AT LEAST N segments, some destructure the
 * first N and tolerate extras — the #1672 ambiguity, tracked separately), and
 * folding them into one predicate here would silently change which ids deploy.
 *
 * ## The `skipping` variant
 *
 * On the DELETE path the established policy is warn-and-continue, so a
 * malformed record leaves the AWS resource ALIVE. That policy is unchanged —
 * the warning says what the skip costs, because an orphan the user is never
 * told about is one they cannot go and delete.
 *
 * Since issue [#1752](https://github.com/go-to-k/cdkd/issues/1752) the ACCOUNTING
 * around it is no longer a lie: an arm emitting this message must also return
 * `{ outcome: 'skipped', reason: COMPOSITE_ID_SKIP_REASON }` so `cdkd destroy`
 * prints a `⚠ … skipped` line instead of `✓ … deleted`, reports
 * `N deleted, 1 skipped`, KEEPS the state record, and exits non-zero. The
 * wording here changed accordingly — it used to promise unconditionally that
 * cdkd "will report this delete as successful", which is no longer true on the
 * destroy path. It is STILL true for the deploy engine's replacement / rollback
 * deletes, which discard the return value (issue
 * [#1762](https://github.com/go-to-k/cdkd/issues/1762)), so the message names
 * both callers rather than describing only the fixed one — a remedy of
 * "drop the record with 'cdkd state orphan'" is impossible on a path that has
 * already dropped it.
 */
export function compositeIdFormatMessage(
  format: CompositeIdFormat,
  logicalId: string,
  physicalId: string,
  options?: { readonly skipping?: boolean }
): string {
  const accepted = format.alsoAccepts
    ? `"${formatShape(format.segments)}" or ${format.alsoAccepts}`
    : `"${formatShape(format.segments)}"`;

  const head =
    `Invalid physicalId format for ${format.label} ${logicalId}: ` +
    `expected ${accepted}, got "${physicalId}"`;

  if (!options?.skipping) return head;

  return (
    `${head}. Skipping the delete — no AWS call is issued, so the resource is LEFT ` +
    `IN PLACE. On 'cdkd destroy' / 'cdkd state destroy' the state record is KEPT ` +
    `and the run exits non-zero, so repair the id in state.json and re-run (or ` +
    `delete the resource by hand and drop the record with 'cdkd state orphan'). ` +
    `NOTE this arm is ALSO reached from the deploy engine's replacement / rollback ` +
    `deletes, which still DROP the record and report success ` +
    `(https://github.com/go-to-k/cdkd/issues/1762) — there, delete it by hand.`
  );
}

/**
 * The short `ResourceDeleteResult.reason` every malformed-composite-id DELETE
 * skip reports (issue [#1752](https://github.com/go-to-k/cdkd/issues/1752)).
 *
 * Deliberately short and IDENTICAL across the five arms: it is rendered inline
 * on the per-resource status line (`⚠ MyTable (AWS::Glue::Table) skipped
 * (malformed physicalId in state — no delete issued)`), where the full
 * remediation sentence built by {@link compositeIdFormatMessage} would not fit.
 * The full text is still emitted, as the `logger.warn` right beside it.
 *
 * A shared constant rather than five literals so the five arms cannot drift and
 * a grep for the wording finds all of them.
 */
export const COMPOSITE_ID_SKIP_REASON = 'malformed physicalId in state — no delete issued';

/**
 * The `ResourceDeleteResult` a malformed-composite-id DELETE arm returns.
 *
 * Pairs with the `{ skipping: true }` warning: emit the warning, return this.
 * Providers call it as `return compositeIdSkipResult();` so the arm reads as
 * the deliberate skip it is rather than as the bare `return;` that made issue
 * #1752's mis-accounting possible.
 */
export function compositeIdSkipResult(): ResourceDeleteResult {
  return { outcome: 'skipped', reason: COMPOSITE_ID_SKIP_REASON };
}
