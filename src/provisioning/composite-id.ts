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
